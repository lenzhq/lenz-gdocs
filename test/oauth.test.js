// LenzOAuth: "Sign in with Lenz" (authorization code + PKCE S256, public client) against a fake
// Lenz issuer that keeps Lenz's rules (test/helpers/fake-lenz-oauth.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LenzOAuth = require('../src/oauth.js');
const { createFakeLenzOAuth, s256 } = require('./helpers/fake-lenz-oauth.js');

const REDIRECT = 'https://script.google.com/macros/d/SCRIPT/usercallback';
const CLIENT = 'lenz-gdocs-test';

function mapStore(shared) {
  const m = shared || new Map();
  return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { assert.equal(typeof v, 'string'); m.set(k, v); },
    del: (k) => { m.delete(k); } };
}

function world(opts) {
  const o = opts || {};
  let clock = 1000000;
  const now = () => clock;
  const lenz = o.lenz || createFakeLenzOAuth({ clientId: CLIENT, redirectUri: REDIRECT, now });
  const store = o.store || mapStore();
  const calls = [];
  const fetch = (req) => { calls.push(req); return (o.fetch || lenz.fetch)(req); };
  const client = LenzOAuth.create({
    fetch, store, now, randomId: () => crypto.randomBytes(16).toString('hex'),
    s256: (v) => s256(v), clientId: CLIENT, redirectUri: REDIRECT,
  });
  return {
    lenz, store, calls, client, now,
    tick: (ms) => { clock += ms; },
    set: (ms) => { clock = ms; },
    // The whole browser round trip: the URL, the consent (or not), the callback's parameters.
    signIn(choice, tamper) {
      const u = client.authorizationUrl((nonce) => 'state-token.' + nonce);
      assert.equal(u.ok, true);
      const back = lenz.authorize(u.url, choice);
      const params = Object.assign({ n: new URL(u.url).searchParams.get('state').split('.')[1] }, back);
      if (tamper) tamper(params);
      return client.handleCallback(params);
    },
  };
}

// ── the authorization URL ───────────────────────────────────────────

test('the URL asks for the code with PKCE S256, verify + offline_access, the resource and the state', () => {
  const w = world();
  const u = w.client.authorizationUrl((nonce) => 'st-' + nonce);
  const url = new URL(u.url);
  assert.equal(url.origin + url.pathname, 'https://lenz.io/oauth2/authorize');
  const q = Object.fromEntries(url.searchParams.entries());
  assert.equal(q.response_type, 'code');
  assert.equal(q.client_id, CLIENT);
  assert.equal(q.redirect_uri, REDIRECT);
  assert.equal(q.scope, 'verify offline_access');
  assert.equal(q.resource, 'https://lenz.io/api/v1');
  assert.equal(q.code_challenge_method, 'S256');
  assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.match(q.state, /^st-[0-9a-f]{32}$/);
  // The verifier stays on the server, keyed by the state's nonce; the URL carries only its hash.
  const pending = JSON.parse(w.store.get(LenzOAuth.PENDING_KEY));
  const nonce = q.state.slice(3);
  const verifier = pending[nonce].verifier;
  assert.match(verifier, /^[A-Za-z0-9._~-]{43,128}$/);
  assert.equal(s256(verifier), q.code_challenge);
  assert.ok(!u.url.includes(verifier));
});

test('a state over Lenz\'s 512 characters is refused before the browser opens', () => {
  const w = world();
  const u = w.client.authorizationUrl(() => 'x'.repeat(513));
  assert.equal(u.ok, false);
  assert.equal(u.url, null);
  assert.match(u.message, /Sign in/);
});

test('at most three sign-ins wait at once, and each for ten minutes', () => {
  const w = world();
  const nonces = [];
  for (let i = 0; i < 4; i++) {
    nonces.push(new URL(w.client.authorizationUrl((n) => n).url).searchParams.get('state'));
  }
  const pending = JSON.parse(w.store.get(LenzOAuth.PENDING_KEY));
  assert.deepEqual(Object.keys(pending).sort(), nonces.slice(1).sort());
  w.tick(10 * 60 * 1000 + 1);
  w.client.authorizationUrl((n) => n);
  assert.equal(Object.keys(JSON.parse(w.store.get(LenzOAuth.PENDING_KEY))).length, 1);
});

test('the redirect may be given as a function, asked only when signing in', () => {
  let asked = 0;
  const w = world();
  const client = LenzOAuth.create({ fetch: w.lenz.fetch, store: w.store, now: w.now, randomId: () => crypto.randomBytes(16).toString('hex'),
    s256, clientId: CLIENT, redirectUri: () => { asked++; return REDIRECT; } });
  client.signedIn();
  client.getToken();
  assert.equal(asked, 0);
  const u = client.authorizationUrl((n) => n);
  assert.equal(new URL(u.url).searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(asked, 1);
});

// ── the callback ────────────────────────────────────────────────────

test('a consented sign-in stores the tokens and the user is signed in', () => {
  const w = world();
  const r = w.signIn('allow');
  assert.equal(r.ok, true);
  assert.equal(w.client.signedIn(), true);
  const t = w.client.getToken();
  assert.match(t.token, /^lat_/);
  assert.equal(t.signedOut, false);
  assert.ok(w.lenz.bearerOk('Bearer ' + t.token));
  // The redemption: a public client names itself in the body, with the verifier and the redirect.
  const redeem = w.lenz.requests.find((q) => q.params.grant_type === 'authorization_code');
  assert.equal(redeem.params.client_id, CLIENT);
  assert.equal(redeem.params.redirect_uri, REDIRECT);
  assert.ok(redeem.params.code_verifier);
  assert.equal(redeem.headers.Authorization, undefined);
  assert.equal(redeem.headers['Content-Type'], 'application/x-www-form-urlencoded');
  // Nothing about the sign-in is left waiting.
  assert.deepEqual(JSON.parse(w.store.get(LenzOAuth.PENDING_KEY)), {});
});

test('a declined sign-in makes no token request and says how to try again', () => {
  const w = world();
  const r = w.signIn('deny');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'denied');
  assert.match(r.message, /Allow/);
  assert.equal(w.client.signedIn(), false);
  assert.equal(w.lenz.requests.length, 0);
});

test('a callback from another issuer, or with none, is refused before any token request (RFC 9207)', () => {
  for (const tamper of [(p) => { p.iss = 'https://evil.example/api/v1'; }, (p) => { delete p.iss; }]) {
    const w = world();
    const r = w.signIn('allow', tamper);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'wrong_issuer');
    assert.equal(w.lenz.requests.length, 0);
  }
});

test('a callback whose sign-in is unknown or used is refused (a replayed callback redeems nothing)', () => {
  const w = world();
  const u = w.client.authorizationUrl((n) => 's.' + n);
  const back = w.lenz.authorize(u.url, 'allow');
  const params = Object.assign({ n: new URL(u.url).searchParams.get('state').slice(2) }, back);
  assert.equal(w.client.handleCallback(params).ok, true);
  const again = w.client.handleCallback(params);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'stale');
  assert.match(again.message, /Sign in with Lenz again/);
  assert.equal(w.lenz.requests.filter((q) => q.params.grant_type === 'authorization_code').length, 1);
  assert.equal(w.client.handleCallback({ code: 'x', iss: w.lenz.ISSUER }).reason, 'stale');
});

test('a sign-in older than ten minutes is stale', () => {
  const w = world();
  const u = w.client.authorizationUrl((n) => 's.' + n);
  const back = w.lenz.authorize(u.url, 'allow');
  w.tick(10 * 60 * 1000 + 1);
  const r = w.client.handleCallback(Object.assign({ n: new URL(u.url).searchParams.get('state').slice(2) }, back));
  assert.equal(r.reason, 'stale');
});

test('an expired code or a wrong verifier fails the sign-in without storing anything', () => {
  const w1 = world();
  const u = w1.client.authorizationUrl((n) => 's.' + n);
  const back = w1.lenz.authorize(u.url, 'allow');
  w1.lenz.expireCodes();
  const r1 = w1.client.handleCallback(Object.assign({ n: new URL(u.url).searchParams.get('state').slice(2) }, back));
  assert.equal(r1.reason, 'failed');
  assert.equal(w1.client.signedIn(), false);

  const w2 = world();
  const u2 = w2.client.authorizationUrl((n) => 's.' + n);
  const back2 = w2.lenz.authorize(u2.url, 'allow');
  const nonce = new URL(u2.url).searchParams.get('state').slice(2);
  const pending = JSON.parse(w2.store.get(LenzOAuth.PENDING_KEY));
  pending[nonce].verifier = 'a'.repeat(43);
  w2.store.set(LenzOAuth.PENDING_KEY, JSON.stringify(pending));
  assert.equal(w2.client.handleCallback(Object.assign({ n: nonce }, back2)).reason, 'failed');
  assert.equal(w2.client.signedIn(), false);
});

test('an error sent back by Lenz is a failed sign-in, not a crash', () => {
  const w = world();
  const r = w.signIn('allow', (p) => { delete p.code; p.error = 'invalid_scope'; });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'failed');
});

test('a token answer without verify, or not Bearer, is refused', () => {
  for (const body of [
    { access_token: 'lat_x', token_type: 'Bearer', expires_in: 3600, scope: 'offline_access', refresh_token: 'lrt_x' },
    { access_token: 'lat_x', token_type: 'mac', expires_in: 3600, scope: 'verify', refresh_token: 'lrt_x' },
    { token_type: 'Bearer', expires_in: 3600, scope: 'verify' },
  ]) {
    const w = world();
    w.lenz.queue.push({ match: (req, p) => p.grant_type === 'authorization_code',
      answer: { code: 200, headers: {}, text: JSON.stringify(body) } });
    assert.equal(w.signIn('allow').reason, 'failed', JSON.stringify(body));
    assert.equal(w.client.signedIn(), false);
  }
});

test('a transport failure on the redemption fails the sign-in', () => {
  const w = world();
  w.lenz.queue.push({ match: (req, p) => p.grant_type === 'authorization_code', answer: { code: 0, headers: {}, text: '' } });
  assert.equal(w.signIn('allow').reason, 'failed');
});

// ── the token ───────────────────────────────────────────────────────

test('getToken returns the access token until a minute before it expires, then rotates', () => {
  const w = world();
  w.signIn('allow');
  const first = JSON.parse(w.store.get(LenzOAuth.TOKENS_KEY));
  assert.equal(w.client.getToken().token, first.access);
  w.tick(3600 * 1000 - 61 * 1000);
  assert.equal(w.client.getToken().token, first.access);
  assert.equal(w.lenz.requests.filter((q) => q.params.grant_type === 'refresh_token').length, 0);
  w.tick(2000);
  const t = w.client.getToken();
  const next = JSON.parse(w.store.get(LenzOAuth.TOKENS_KEY));
  assert.notEqual(next.access, first.access);
  assert.notEqual(next.refresh, first.refresh);
  assert.equal(t.token, next.access);
  assert.ok(w.lenz.bearerOk('Bearer ' + t.token));
  const rot = w.lenz.requests.find((q) => q.params.grant_type === 'refresh_token');
  assert.deepEqual(Object.keys(rot.params).sort(), ['client_id', 'grant_type', 'refresh_token']);
});

test('force: rotates even with time left (the API said 401)', () => {
  const w = world();
  w.signIn('allow');
  const before = w.client.getToken().token;
  const after = w.client.getToken({ force: true }).token;
  assert.notEqual(after, before);
  assert.ok(w.lenz.bearerOk('Bearer ' + after));
  assert.equal(w.lenz.bearerOk('Bearer ' + before), false, 'a rotation retires the family\'s access token');
});

test('two executions refreshing the same token inside the 60 s grace get the same successor', () => {
  const lenzWorld = world();
  lenzWorld.signIn('allow');
  const tokens = lenzWorld.store.get(LenzOAuth.TOKENS_KEY);
  // Two executions that each read the token before either rotated it.
  const a = world({ lenz: lenzWorld.lenz, store: mapStore(new Map([[LenzOAuth.TOKENS_KEY, tokens]])) });
  const b = world({ lenz: lenzWorld.lenz, store: mapStore(new Map([[LenzOAuth.TOKENS_KEY, tokens]])) });
  const tb = b.client.getToken({ force: true });
  const ta = a.client.getToken({ force: true });
  assert.equal(ta.token, tb.token);
  assert.equal(JSON.parse(a.store.get(LenzOAuth.TOKENS_KEY)).refresh, JSON.parse(b.store.get(LenzOAuth.TOKENS_KEY)).refresh);
  assert.ok(lenzWorld.lenz.bearerOk('Bearer ' + ta.token));
});

test('an invalid_grant after another execution already rotated takes the stored successor, not a sign-out', () => {
  const shared = new Map();
  const w = world({ store: mapStore(shared) });
  w.signIn('allow');
  const r1 = JSON.parse(shared.get(LenzOAuth.TOKENS_KEY)).refresh;
  // While this execution's refresh is in flight, another one rotates R1 and stores R2; Lenz answers
  // this one invalid_grant (inside the grace with nothing remembered: refused, grant left alone).
  const other = world({ lenz: w.lenz, store: mapStore(new Map([[LenzOAuth.TOKENS_KEY, shared.get(LenzOAuth.TOKENS_KEY)]])) });
  w.lenz.queue.push({
    match: (req, p) => p.grant_type === 'refresh_token' && p.refresh_token === r1 && !other.done,
    get answer() {
      other.done = true;
      other.client.getToken({ force: true });
      shared.set(LenzOAuth.TOKENS_KEY, other.store.get(LenzOAuth.TOKENS_KEY));
      return { code: 400, headers: {}, text: JSON.stringify({ error: 'invalid_grant' }) };
    },
  });
  const t = w.client.getToken({ force: true });
  assert.equal(t.signedOut, false);
  assert.equal(t.token, JSON.parse(shared.get(LenzOAuth.TOKENS_KEY)).access);
  assert.ok(w.lenz.bearerOk('Bearer ' + t.token));
});

test('a refresh token revoked on lenz.io (invalid_grant) signs the user out', () => {
  const w = world();
  w.signIn('allow');
  Object.keys(w.lenz.grants).forEach((g) => { w.lenz.grants[g].revoked = true; });
  const t = w.client.getToken({ force: true });
  assert.deepEqual({ token: t.token, signedOut: t.signedOut }, { token: null, signedOut: true });
  assert.equal(w.client.signedIn(), false);
  assert.equal(w.store.get(LenzOAuth.TOKENS_KEY), null);
});

test('a refresh token past 90 days signs the user out', () => {
  const w = world();
  w.signIn('allow');
  w.tick(91 * 24 * 3600 * 1000);
  assert.equal(w.client.getToken().signedOut, true);
});

test('an unknown client (invalid_client) signs the user out', () => {
  const w = world();
  w.signIn('allow');
  w.lenz.queue.push({ match: (req, p) => p.grant_type === 'refresh_token',
    answer: { code: 401, headers: {}, text: JSON.stringify({ error: 'invalid_client' }) } });
  assert.equal(w.client.getToken({ force: true }).signedOut, true);
});

test('a refresh that cannot reach Lenz keeps the sign-in and returns no token for now', () => {
  for (const answer of [{ code: 0, headers: {}, text: '' }, { code: 503, headers: { 'retry-after': '30' }, text: '{}' },
    { code: 429, headers: {}, text: JSON.stringify({ error: 'slow_down' }) }]) {
    const w = world();
    w.signIn('allow');
    w.lenz.queue.push({ match: (req, p) => p.grant_type === 'refresh_token', answer });
    const t = w.client.getToken({ force: true });
    assert.deepEqual({ token: t.token, signedOut: t.signedOut }, { token: null, signedOut: false });
    assert.equal(w.client.signedIn(), true);
    assert.equal(w.client.getToken({ force: true }).signedOut, false);
  }
});

test('a near-expiry token is still used when the refresh cannot reach Lenz', () => {
  const w = world();
  w.signIn('allow');
  const first = w.client.getToken().token;
  w.tick(3600 * 1000 - 30 * 1000);
  w.lenz.queue.push({ match: (req, p) => p.grant_type === 'refresh_token', answer: { code: 0, headers: {}, text: '' } });
  assert.equal(w.client.getToken().token, first);
});

test('with no refresh token, an expired access token means signed out', () => {
  const w = world();
  w.signIn('allow');
  const t = JSON.parse(w.store.get(LenzOAuth.TOKENS_KEY));
  delete t.refresh;
  w.store.set(LenzOAuth.TOKENS_KEY, JSON.stringify(t));
  w.tick(3600 * 1000);
  assert.equal(w.client.getToken().signedOut, true);
});

test('a refresh answer without a new refresh token keeps the old one (RFC 6749 §6)', () => {
  const w = world();
  w.signIn('allow');
  const old = JSON.parse(w.store.get(LenzOAuth.TOKENS_KEY)).refresh;
  w.lenz.queue.push({ match: (req, p) => p.grant_type === 'refresh_token',
    answer: { code: 200, headers: {}, text: JSON.stringify({ access_token: 'lat_new', token_type: 'Bearer', expires_in: 3600, scope: 'verify' }) } });
  assert.equal(w.client.getToken({ force: true }).token, 'lat_new');
  assert.equal(JSON.parse(w.store.get(LenzOAuth.TOKENS_KEY)).refresh, old);
});

test('a corrupt stored token reads as signed out', () => {
  const w = world();
  w.store.set(LenzOAuth.TOKENS_KEY, '{nope');
  assert.equal(w.client.signedIn(), false);
  assert.equal(w.client.getToken().signedOut, true);
});

// ── signing out ─────────────────────────────────────────────────────

test('sign out revokes the refresh token (its whole authorization) and forgets the tokens', () => {
  const w = world();
  w.signIn('allow');
  const access = w.client.getToken().token;
  const refresh = JSON.parse(w.store.get(LenzOAuth.TOKENS_KEY)).refresh;
  w.client.signOut();
  const rev = w.lenz.requests.find((q) => q.url === w.lenz.REVOKE_URL);
  assert.deepEqual(rev.params, { token: refresh, token_type_hint: 'refresh_token', client_id: CLIENT });
  assert.equal(w.lenz.bearerOk('Bearer ' + access), false);
  assert.equal(w.client.signedIn(), false);
  assert.equal(w.store.get(LenzOAuth.TOKENS_KEY), null);
});

test('sign out forgets the tokens even when Lenz cannot be reached', () => {
  const w = world({ fetch: () => ({ code: 0, headers: {}, text: '' }) });
  w.store.set(LenzOAuth.TOKENS_KEY, JSON.stringify({ access: 'lat_a', refresh: 'lrt_r', expiresAt: 9e15, scope: 'verify' }));
  w.client.signOut();
  assert.equal(w.client.signedIn(), false);
});

test('forget drops the tokens without a request', () => {
  const w = world();
  w.signIn('allow');
  const n = w.lenz.requests.length;
  w.client.forget();
  assert.equal(w.client.signedIn(), false);
  assert.equal(w.lenz.requests.length, n);
});

// ── purity ──────────────────────────────────────────────────────────

test('oauth.js uses no Apps Script globals and no syntax past ES2019', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'oauth.js'), 'utf8');
  ['DocumentApp', 'UrlFetchApp', 'PropertiesService', 'CacheService', 'Utilities', 'LockService', 'ScriptApp', 'HtmlService']
    .forEach((g) => assert.ok(!src.includes(g), g));
  assert.ok(!/\?\./.test(src.replace(/'[^']*'/g, '')), 'optional chaining');
  assert.ok(!/\?\?/.test(src), 'nullish coalescing');
  assert.ok(!/^\s*(import|export)\s/m.test(src), 'modules');
});
