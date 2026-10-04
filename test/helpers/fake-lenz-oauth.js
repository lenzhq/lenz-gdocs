// Test-only fake of Lenz's OAuth issuer for a PUBLIC client, answering the same `fetch(req)`
// transport as fake-lenz.js. Behaviour follows Lenz's issuer as of 2026-09-30:
// the consent page (S256 only, challenge exactly 43 chars, state required ≤ 512,
// `resource` optional but must be the API, redirect exact, errors back with error + state + iss) and
// the token endpoint (public client names itself in the body; 60 s single-use
// codes, a replayed code revokes the grant; refresh only with offline_access; rotation with a 60 s
// reuse grace answering the SAME successor; outside it a replay revokes the grant; one message,
// invalid_grant, for every failure; revoke is always 200, a refresh token takes its grant).
'use strict';
const crypto = require('node:crypto');

const ISSUER = 'https://lenz.io/api/v1';
const TOKEN_URL = 'https://lenz.io/api/v1/oauth/token';
const REVOKE_URL = 'https://lenz.io/api/v1/oauth/revoke';
const CODE_TTL_MS = 60 * 1000;
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_MS = 90 * 24 * 3600 * 1000;
const GRACE_MS = 60 * 1000;

const s256 = (v) => crypto.createHash('sha256').update(v).digest('base64url');
const rand = (p) => p + crypto.randomBytes(16).toString('hex');

function form(text) {
  const out = {};
  new URLSearchParams(text || '').forEach((v, k) => { out[k] = v; });
  return out;
}

// opts: { clientId, redirectUri, now() -> ms, scopes: allowed API scopes }
function createFakeLenzOAuth(opts) {
  const o = opts || {};
  const clientId = o.clientId || 'lenz-gdocs';
  const redirectUri = o.redirectUri;
  const now = o.now || (() => Date.now());
  const allowed = new Set((o.scopes || ['verify']).concat(['offline_access']));
  const codes = {}; // raw code -> { challenge, redirectUri, scopes, expires, consumed, grant }
  const access = {}; // raw -> { grant, expires, revoked, scopes }
  const refresh = {}; // raw -> { grant, expires, revoked, rotatedTo, rotatedAt, memo }
  const grants = {}; // id -> { revoked }
  const requests = [];
  const queue = []; // scripted answers for the token endpoint: { match(params) -> bool, answer }
  let grantN = 0;

  const json = (code, body) => ({ code, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    text: JSON.stringify(body) });
  const invalidGrant = () => json(400, { error: 'invalid_grant', error_description: 'The authorization is invalid or has expired.' });

  function revokeGrant(g) {
    grants[g].revoked = true;
    Object.values(access).forEach((a) => { if (a.grant === g) a.revoked = true; });
    Object.values(refresh).forEach((r) => { if (r.grant === g) r.revoked = true; });
  }

  function mint(g, scopes, withRefresh) {
    const at = rand('lat_');
    access[at] = { grant: g, expires: now() + ACCESS_TTL_S * 1000, revoked: false, scopes };
    const body = { access_token: at, token_type: 'Bearer', expires_in: ACCESS_TTL_S, scope: scopes.join(' ') };
    if (withRefresh) {
      const rt = rand('lrt_');
      refresh[rt] = { grant: g, expires: now() + REFRESH_TTL_MS, revoked: false, rotatedTo: null, rotatedAt: null,
        memo: null, scopes };
      body.refresh_token = rt;
    }
    return body;
  }

  // The browser half: what /oauth2/authorize sends back to the redirect after the user consents
  // (or declines). Returns the callback's query parameters, as Apps Script hands them over.
  function authorize(url, choice) {
    const u = new URL(url);
    const q = Object.fromEntries(u.searchParams.entries());
    if (q.client_id !== clientId || q.redirect_uri !== redirectUri) return { rendered: 'unprovable client or redirect' };
    const back = (fields) => Object.assign({ iss: ISSUER }, q.state ? { state: q.state } : {}, fields);
    if (q.response_type !== 'code') return back({ error: 'unsupported_response_type' });
    if (!q.state || q.state.length > 512) return back({ error: 'invalid_request' });
    if (q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge || '')) {
      return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required.' });
    }
    if (q.resource && q.resource !== ISSUER) return back({ error: 'invalid_target' });
    const asked = (q.scope || '').split(' ').filter(Boolean);
    if (!asked.length || asked.some((s) => !allowed.has(s))) return back({ error: 'invalid_scope' });
    if (choice === 'deny') return back({ error: 'access_denied', error_description: 'The account holder declined.' });
    grantN += 1;
    const g = 'g' + grantN;
    grants[g] = { revoked: false };
    const code = rand('code_');
    codes[code] = { challenge: q.code_challenge, redirectUri: q.redirect_uri, scopes: asked.sort(), expires: now() + CODE_TTL_MS,
      consumed: false, grant: g };
    return back({ code });
  }

  function token(p) {
    if (p.client_id !== clientId) return json(401, { error: 'invalid_client', error_description: 'Client authentication failed.' });
    if (p.grant_type === 'authorization_code') {
      const c = codes[p.code];
      if (!c || !p.code_verifier || !p.redirect_uri) return invalidGrant();
      if (p.redirect_uri !== c.redirectUri) return invalidGrant();
      if (s256(p.code_verifier) !== c.challenge) return invalidGrant();
      if (c.consumed) { revokeGrant(c.grant); return invalidGrant(); }
      if (c.expires <= now() || grants[c.grant].revoked) return invalidGrant();
      c.consumed = true;
      return json(200, mint(c.grant, c.scopes, c.scopes.includes('offline_access')));
    }
    if (p.grant_type === 'refresh_token') {
      const r = refresh[p.refresh_token];
      if (!r) return invalidGrant();
      if (r.rotatedTo || r.revoked) {
        if (r.rotatedAt !== null && now() - r.rotatedAt <= GRACE_MS && r.memo && !grants[r.grant].revoked) {
          const successor = refresh[r.rotatedTo];
          const live = successor && !successor.revoked && !successor.rotatedTo && access[r.memo.access_token] &&
            !access[r.memo.access_token].revoked;
          if (live) return json(200, r.memo);
          return invalidGrant(); // inside the grace, nothing usable: refused, grant left alone
        }
        revokeGrant(r.grant);
        return invalidGrant();
      }
      if (r.expires <= now() || grants[r.grant].revoked) return invalidGrant();
      Object.values(access).forEach((a) => { if (a.grant === r.grant) a.revoked = true; });
      const body = mint(r.grant, r.scopes, true);
      r.rotatedTo = body.refresh_token;
      r.rotatedAt = now();
      r.revoked = true;
      r.memo = body;
      return json(200, body);
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  function fetch(req) {
    const p = form(req.payload);
    requests.push({ method: req.method, url: req.url, headers: req.headers, params: p });
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].match(req, p)) return queue.splice(i, 1)[0].answer;
    }
    if (req.url === TOKEN_URL && String(req.method).toLowerCase() === 'post') return token(p);
    if (req.url === REVOKE_URL && String(req.method).toLowerCase() === 'post') {
      if (p.client_id !== clientId) return json(401, { error: 'invalid_client' });
      if (refresh[p.token]) revokeGrant(refresh[p.token].grant);
      else if (access[p.token]) access[p.token].revoked = true;
      return json(200, {});
    }
    return { code: 404, headers: {}, text: 'not found' };
  }

  // Is this bearer good for the API right now (what Lenz checks)?
  function bearerOk(auth) {
    const t = String(auth || '').replace(/^Bearer /, '');
    const a = access[t];
    return !!(a && !a.revoked && a.expires > now() && !grants[a.grant].revoked && a.scopes.includes('verify'));
  }

  return {
    authorize, fetch, bearerOk, requests, queue, codes, refresh, access, grants,
    expireCodes() { Object.values(codes).forEach((c) => { c.expires = 0; }); },
    ISSUER, TOKEN_URL, REVOKE_URL,
  };
}

module.exports = { createFakeLenzOAuth, s256 };
