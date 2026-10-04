// "Sign in with Lenz": OAuth 2.0 authorization code + PKCE (S256) for a public client, against
// Lenz's issuer (https://lenz.io/api/v1). Pure: the transport, User properties, clock, randomness
// and digest are injected (CONTRACT.md § oauth.js). Hand-rolled rather than apps-script-oauth2:
// that library carries the PKCE verifier inside the state token, i.e. through the browser next to
// the code, and draws it from Math.random; here the verifier never leaves User properties and the
// state carries only a nonce (which also keeps it under Lenz's 512-character state limit).
var LenzOAuth = (function () {
  'use strict';

  var LENZ = {
    issuer: 'https://lenz.io/api/v1',
    resource: 'https://lenz.io/api/v1',
    authorizeUrl: 'https://lenz.io/oauth2/authorize',
    tokenUrl: 'https://lenz.io/api/v1/oauth/token',
    revokeUrl: 'https://lenz.io/api/v1/oauth/revoke',
    // verify covers POST /review and GET /reviews/{id}; offline_access asks for a refresh token
    // (Lenz mints one only when it is granted).
    scope: 'verify offline_access'
  };

  var TOKENS_KEY = 'lenz:oauth:tokens';
  var PENDING_KEY = 'lenz:oauth:pending';
  var PENDING_MAX = 3;
  var PENDING_TTL_MS = 10 * 60 * 1000;
  var STATE_MAX = 512; // Lenz's limit on `state`
  var REFRESH_EARLY_MS = 60 * 1000;

  // Plain, short, say what to do.
  var MESSAGES = {
    signed_in: 'You are signed in to Lenz. You can close this window and go back to your Doc.',
    denied: 'Lenz was not given access. To check this Doc, choose Sign in with Lenz again and then Allow.',
    stale: 'This sign-in link has expired. Go back to your Doc and choose Sign in with Lenz again.',
    wrong_issuer: 'This sign-in did not come from Lenz. Go back to your Doc and choose Sign in with Lenz again.',
    failed: 'Signing in did not work. Go back to your Doc and choose Sign in with Lenz again.',
    state_too_long: 'Signing in cannot start from this Doc. Reload the Doc and choose Sign in with Lenz again.'
  };

  function parseJson(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
      var v = JSON.parse(text);
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch (e) {
      return null;
    }
  }

  function formEncode(params) {
    return Object.keys(params).map(function (k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
  }

  function create(deps) {
    // The registered redirect; a function is asked only when a sign-in needs it.
    function redirectUri() {
      return typeof deps.redirectUri === 'function' ? deps.redirectUri() : deps.redirectUri;
    }

    function readTokens() {
      var t = parseJson(deps.store.get(TOKENS_KEY));
      return t && typeof t.access === 'string' && typeof t.expiresAt === 'number' ? t : null;
    }

    function readPending() {
      var p = parseJson(deps.store.get(PENDING_KEY)) || {};
      var now = deps.now();
      var live = {};
      Object.keys(p).forEach(function (n) {
        var e = p[n];
        if (e && typeof e.verifier === 'string' && typeof e.at === 'number' && now - e.at <= PENDING_TTL_MS) live[n] = e;
      });
      return live;
    }

    function post(url, params) {
      var res;
      try {
        res = deps.fetch({
          method: 'post',
          url: url,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          payload: formEncode(params)
        });
      } catch (e) {
        res = null;
      }
      return res && typeof res.code === 'number' ? res : { code: 0, headers: {}, text: '' };
    }

    // A token answer we can use: Bearer, an access token, and the verify scope granted.
    function tokensFrom(res, previous) {
      if (res.code !== 200) return null;
      var b = parseJson(res.text);
      if (!b || typeof b.access_token !== 'string' || !b.access_token) return null;
      if (String(b.token_type || '').toLowerCase() !== 'bearer') return null;
      var scopes = String(b.scope || '').split(' ');
      if (scopes.indexOf('verify') < 0) return null;
      var expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : 3600;
      var refresh = typeof b.refresh_token === 'string' && b.refresh_token ? b.refresh_token : null;
      return {
        access: b.access_token,
        // A refresh answer may omit the refresh token: the old one stays (RFC 6749 §6).
        refresh: refresh || (previous && previous.refresh) || null,
        expiresAt: deps.now() + expiresIn * 1000,
        scope: b.scope
      };
    }

    function oauthError(res) {
      var b = parseJson(res.text);
      return b && typeof b.error === 'string' ? b.error : null;
    }

    /**
     * The URL to open for the user's consent. makeState(nonce) -> the state to send (the glue builds
     * an Apps Script state token carrying the nonce as argument `n`).
     */
    function authorizationUrl(makeState) {
      var nonce = deps.randomId();
      var verifier = deps.randomId() + deps.randomId() + deps.randomId();
      var state = makeState(nonce);
      if (typeof state !== 'string' || !state || state.length > STATE_MAX) {
        return { ok: false, url: null, message: MESSAGES.state_too_long };
      }
      var pending = readPending();
      pending[nonce] = { verifier: verifier, at: deps.now() };
      var keys = Object.keys(pending).sort(function (a, b) { return pending[a].at - pending[b].at; });
      while (keys.length > PENDING_MAX) delete pending[keys.shift()];
      deps.store.set(PENDING_KEY, JSON.stringify(pending));
      var params = {
        response_type: 'code',
        client_id: deps.clientId,
        redirect_uri: redirectUri(),
        scope: LENZ.scope,
        state: state,
        code_challenge: deps.s256(verifier),
        code_challenge_method: 'S256',
        resource: LENZ.resource
      };
      return { ok: true, url: LENZ.authorizeUrl + '?' + formEncode(params), message: null };
    }

    function refused(reason) {
      return { ok: false, reason: reason, message: MESSAGES[reason] };
    }

    /** The redirect's parameters (Apps Script's e.parameter: code|error, state, iss, and `n`). */
    function handleCallback(params) {
      var p = params || {};
      var pending = readPending();
      var nonce = typeof p.n === 'string' ? p.n : '';
      var entry = nonce && pending[nonce];
      if (!entry) return refused('stale');
      // Single use: gone before anything else, whatever happens next.
      delete pending[nonce];
      deps.store.set(PENDING_KEY, JSON.stringify(pending));
      // RFC 9207: Lenz names itself on every response; a missing or other issuer is a mix-up.
      if (p.iss !== LENZ.issuer) return refused('wrong_issuer');
      if (p.error) return refused(p.error === 'access_denied' ? 'denied' : 'failed');
      if (typeof p.code !== 'string' || !p.code) return refused('failed');
      var res = post(LENZ.tokenUrl, {
        grant_type: 'authorization_code',
        code: p.code,
        redirect_uri: redirectUri(),
        client_id: deps.clientId,
        code_verifier: entry.verifier
      });
      var tokens = tokensFrom(res, null);
      if (!tokens) return refused('failed');
      deps.store.set(TOKENS_KEY, JSON.stringify(tokens));
      return { ok: true, reason: null, message: MESSAGES.signed_in };
    }

    function refreshWith(current) {
      var res = post(LENZ.tokenUrl, {
        grant_type: 'refresh_token',
        refresh_token: current.refresh,
        client_id: deps.clientId
      });
      var tokens = tokensFrom(res, current);
      if (tokens) {
        deps.store.set(TOKENS_KEY, JSON.stringify(tokens));
        return { token: tokens.access, signedOut: false };
      }
      var err = oauthError(res);
      if (err === 'invalid_grant' || err === 'invalid_client' || res.code === 200) {
        // Another execution may have rotated this token while this request was in flight: its
        // successor is in the store, and a stale token's refusal must not sign the user out.
        var now = readTokens();
        if (now && now.refresh && now.refresh !== current.refresh && err === 'invalid_grant') {
          if (now.expiresAt - deps.now() > REFRESH_EARLY_MS) return { token: now.access, signedOut: false };
          return refreshWith(now);
        }
        forget();
        return { token: null, signedOut: true };
      }
      // Lenz unreachable, rate-limited or 5xx: still signed in, no usable token for now. A token
      // with time left is better than none.
      if (current.expiresAt > deps.now()) return { token: current.access, signedOut: false, stale: true };
      return { token: null, signedOut: false };
    }

    /**
     * { token, signedOut }: the access token, rotated when under a minute is left or when
     * `force` (the API answered 401). token null + signedOut false = Lenz unreachable for now.
     */
    function getToken(opts) {
      var force = !!(opts && opts.force);
      var t = readTokens();
      if (!t) return { token: null, signedOut: true };
      if (!force && t.expiresAt - deps.now() > REFRESH_EARLY_MS) return { token: t.access, signedOut: false };
      if (!t.refresh) {
        if (!force && t.expiresAt > deps.now()) return { token: t.access, signedOut: false };
        forget();
        return { token: null, signedOut: true };
      }
      var out = refreshWith(t);
      // After a 401, the old token is the one that failed: never hand it back.
      if (force && out.stale) return { token: null, signedOut: false };
      return { token: out.token, signedOut: out.signedOut };
    }

    function signedIn() {
      var t = readTokens();
      return !!(t && (t.refresh || t.expiresAt > deps.now()));
    }

    function forget() {
      deps.store.del(TOKENS_KEY);
    }

    /** Revokes the authorization at Lenz (best effort) and forgets the tokens. */
    function signOut() {
      var t = readTokens();
      if (t) {
        var params = t.refresh
          ? { token: t.refresh, token_type_hint: 'refresh_token', client_id: deps.clientId }
          : { token: t.access, token_type_hint: 'access_token', client_id: deps.clientId };
        post(LENZ.revokeUrl, params);
      }
      forget();
    }

    return {
      authorizationUrl: authorizationUrl,
      handleCallback: handleCallback,
      getToken: getToken,
      signedIn: signedIn,
      signOut: signOut,
      forget: forget
    };
  }

  return {
    create: create,
    LENZ: LENZ,
    MESSAGES: MESSAGES,
    TOKENS_KEY: TOKENS_KEY,
    PENDING_KEY: PENDING_KEY
  };
})();
if (typeof module !== 'undefined') { module.exports = LenzOAuth; }
