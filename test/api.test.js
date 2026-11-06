const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const LenzApi = require('../src/api.js');

const FIX = path.join(__dirname, 'fixtures', 'reviews');
const ACCEPT = JSON.parse(fs.readFileSync(path.join(FIX, 'draft-a.accept.json'), 'utf8'));
const POLLS = JSON.parse(fs.readFileSync(path.join(FIX, 'draft-a.polls.json'), 'utf8'));
const REVIEW = JSON.parse(fs.readFileSync(path.join(FIX, 'draft-a.review.json'), 'utf8'));
const DRAFT = fs.readFileSync(path.join(FIX, 'draft-a.txt'), 'utf8');

const BASE = 'https://lenz.io/api/v1';
const DOC = { docId: 'doc1', tabId: 't.0' };

// The policy JSON in the key has its keys sorted, so a caller's key order cannot change it.
function sortedJson(o) {
  return JSON.stringify(o, Object.keys(o).sort());
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// A fake world: the transport answers from a queue, the store and cache are maps.
function world(opts) {
  const o = opts || {};
  const calls = [];
  const replies = (o.replies || []).slice();
  const store = new Map();
  const cache = new Map();
  let clock = o.now || 1000000;
  const deps = {
    fetch: function (req) {
      calls.push({
        req: req,
        // What the store and cache held at the moment the request left.
        storeAtSend: new Map(store),
        cacheAtSend: new Map(cache),
      });
      const r = replies.shift();
      if (!r) throw new Error('unexpected request ' + req.method + ' ' + req.url);
      return r;
    },
    store: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => { assert.equal(typeof v, 'string'); store.set(k, v); },
      del: (k) => { store.delete(k); },
    },
    cache: {
      get: (k) => (cache.has(k) ? cache.get(k).v : null),
      put: (k, v, ttl) => { assert.equal(typeof v, 'string'); cache.set(k, { v: v, ttl: ttl }); },
      del: (k) => { cache.delete(k); },
    },
    sha256: sha256,
    now: () => clock,
    base: BASE,
    apiKey: 'lenz_' + 'a'.repeat(32),
    userAgent: 'lenz-gdocs/0.1',
  };
  return {
    deps, calls, store, cache, replies,
    client: LenzApi.create(deps),
    tick: (ms) => { clock += ms; },
  };
}

function json(code, body, headers) {
  return { code: code, headers: headers || {}, text: JSON.stringify(body) };
}
const accepted = (id) => json(202, { review_id: id || ACCEPT.body.review_id, status: 'queued' },
  { Location: '/api/v1/reviews/' + (id || ACCEPT.body.review_id), 'Retry-After': '20' });
const transportFail = () => ({ code: 0, headers: {}, text: '' });

function sub(w, text, extra) {
  return w.client.submit(Object.assign({ docId: DOC.docId, tabId: DOC.tabId, text: text }, extra || {}));
}
const keyOf = (call) => call.req.headers['Idempotency-Key'];

// ── the request ─────────────────────────────────────────────────────────

test('submit POSTs the contract body with the key, the bearer and the user agent', () => {
  const w = world({ replies: [accepted()] });
  const r = sub(w, DRAFT);
  assert.equal(r.ok, true);
  assert.equal(w.calls.length, 1);
  const req = w.calls[0].req;
  assert.equal(req.method, 'post');
  assert.equal(req.url, BASE + '/review');
  assert.equal(req.headers.Authorization, 'Bearer ' + w.deps.apiKey);
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.equal(req.headers['User-Agent'], 'lenz-gdocs/0.1');
  assert.equal(req.headers['X-Lenz-API-Version'], '2026-10-11');
  assert.match(keyOf(w.calls[0]), /^[0-9a-f]{64}$/);
  assert.deepEqual(JSON.parse(req.payload), {
    text: DRAFT,
    webhook_url: '',
    visibility: 'private',
    language: 'auto',
    escalate: {
      suggest_edits: true, max_citations: 20, max_assessments: 20, max_verifications: 5, depth: 'standard',
    },
  });
});

// The add-on names the version of the API it was written against on every request, so what it
// reads does not change under it. It reads only that version's answer shape.
test('every request names the API version: the POST, a replay, the poll, a cancel, a rotated retry', () => {
  assert.equal(LenzApi.API_VERSION, '2026-10-11');
  // The POST, then the poll.
  const w = world({ replies: [accepted('r1'), json(200, POLLS[0])] });
  sub(w, DRAFT);
  w.client.poll(DOC.docId, DOC.tabId);
  assert.deepEqual(w.calls.map((c) => c.req.headers['X-Lenz-API-Version']), ['2026-10-11', '2026-10-11']);
  // A cancel, then the GET that reads a review already ended.
  const stopped = JSON.parse(fs.readFileSync(path.join(FIX, 'cancelled-midway.review.json'), 'utf8'));
  const c = world({ replies: [accepted('r4'), json(200, stopped), json(200, stopped)] });
  sub(c, DRAFT);
  c.client.cancel(DOC.docId, DOC.tabId);
  c.client.cancel(DOC.docId, DOC.tabId);
  assert.deepEqual(c.calls.map((x) => x.req.method + ' ' + x.req.headers['X-Lenz-API-Version']),
    ['post 2026-10-11', 'post 2026-10-11', 'get 2026-10-11']);
  // A replay of a POST whose answer was lost.
  const r = world({ replies: [transportFail(), accepted('r2')] });
  sub(r, DRAFT);
  sub(r, DRAFT);
  assert.deepEqual(r.calls.map((c) => c.req.headers['X-Lenz-API-Version']), ['2026-10-11', '2026-10-11']);
  // A request sent again with a rotated token.
  const o = oauthWorld([json(401, { detail: 'Unauthorized' }), accepted('r3')], [tok('lat_old'), tok('lat_new')]);
  sub(o, DRAFT);
  assert.deepEqual(o.calls.map((c) => c.req.headers['X-Lenz-API-Version']), ['2026-10-11', '2026-10-11']);
});

// The review comes back in the Doc's language when every POST asks for it. The body is stored before
// the first send and replayed byte for byte, so a retry asks for the same thing and the key still binds.
test('every review POST carries language auto: a Doc, a selection, a replay, a rotated retry, Run again', () => {
  const languageOf = (c) => JSON.parse(c.req.payload).language;
  // The whole tab, then a selection (a slice of it).
  const w = world({ replies: [accepted('r1'), accepted('r2')] });
  sub(w, DRAFT);
  sub(w, DRAFT, { snapshot: 'An opening paragraph.\n\n' + DRAFT, offset: 23, scope: { paragraphs: 3 } });
  assert.equal(w.calls.length, 2);
  assert.deepEqual(w.calls.map(languageOf), ['auto', 'auto']);
  // Run again is a new review: still asks for it.
  w.client.runAgain({ docId: DOC.docId, tabId: DOC.tabId });
  w.replies.push(accepted('r3'));
  sub(w, DRAFT);
  assert.equal(w.calls.length, 3);
  assert.equal(languageOf(w.calls[2]), 'auto');
  // A lost reply: the replay sends the stored body, identical, with the same key.
  const r = world({ replies: [transportFail(), accepted('r4')] });
  sub(r, DRAFT);
  sub(r, DRAFT);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls.map(languageOf), ['auto', 'auto']);
  assert.equal(r.calls[1].req.payload, r.calls[0].req.payload);
  assert.equal(keyOf(r.calls[1]), keyOf(r.calls[0]));
  // A selection replay too.
  const s = world({ replies: [transportFail(), accepted('r5')] });
  sub(s, DRAFT, { snapshot: 'An opening paragraph.\n\n' + DRAFT, offset: 23, scope: { paragraphs: 3 } });
  sub(s, 'whatever the Doc says now');
  assert.deepEqual(s.calls.map(languageOf), ['auto', 'auto']);
  assert.equal(s.calls[1].req.payload, s.calls[0].req.payload);
  // The same request sent again with a rotated token.
  const o = oauthWorld([json(401, { detail: 'Unauthorized' }), accepted('r6')], [tok('lat_old'), tok('lat_new')]);
  sub(o, DRAFT);
  assert.deepEqual(o.calls.map(languageOf), ['auto', 'auto']);
  assert.equal(o.calls[1].req.payload, o.calls[0].req.payload);
});

test('the version header is not part of the idempotency key or the body', () => {
  const w = world({ replies: [accepted()] });
  sub(w, DRAFT);
  assert.equal(JSON.parse(w.calls[0].req.payload).version, undefined);
  assert.equal(keyOf(w.calls[0]), sha256([DOC.docId, DOC.tabId, sha256(DRAFT), sortedJson(LenzApi.DEFAULT_POLICY), '0'].join('|')));
});

test('the key is sha256(docId|tabId|textHash|policyJSON|attempt)', () => {
  const w = world({ replies: [accepted()] });
  sub(w, DRAFT);
  const policy = sortedJson(LenzApi.DEFAULT_POLICY);
  const expected = sha256([DOC.docId, DOC.tabId, sha256(DRAFT), policy, '0'].join('|'));
  assert.equal(keyOf(w.calls[0]), expected);
});

test('the key does not depend on the order a caller wrote the policy keys in', () => {
  const a = world({ replies: [accepted()] });
  const b = world({ replies: [accepted()] });
  sub(a, DRAFT, { policy: { depth: 'standard', suggest_edits: true, max_citations: 20, max_assessments: 20, max_verifications: 3 } });
  sub(b, DRAFT, { policy: { max_verifications: 3, max_assessments: 20, max_citations: 20, suggest_edits: true, depth: 'standard' } });
  assert.equal(keyOf(a.calls[0]), keyOf(b.calls[0]));
});

test('a changed text, tab, doc or policy is a different key', () => {
  const keys = new Set();
  const variants = [
    [DOC.docId, DOC.tabId, DRAFT, undefined],
    [DOC.docId, DOC.tabId, DRAFT + ' more', undefined],
    [DOC.docId, 't.1', DRAFT, undefined],
    ['doc2', DOC.tabId, DRAFT, undefined],
    [DOC.docId, DOC.tabId, DRAFT, Object.assign({}, LenzApi.DEFAULT_POLICY, { depth: 'low' })],
  ];
  variants.forEach(function (v) {
    const w = world({ replies: [accepted()] });
    w.client.submit({ docId: v[0], tabId: v[1], text: v[2], policy: v[3] });
    keys.add(keyOf(w.calls[0]));
  });
  assert.equal(keys.size, variants.length);
});

test('the record and the exact body are written BEFORE the POST', () => {
  const w = world({ replies: [accepted()] });
  sub(w, DRAFT);
  const at = w.calls[0];
  const key = keyOf(at);
  const rec = JSON.parse(at.storeAtSend.get(LenzApi.recordKey(DOC.docId, DOC.tabId)));
  assert.equal(rec.key, key);
  assert.equal(rec.reviewId, null);
  assert.equal(rec.state, 'submitting');
  assert.equal(rec.tabId, DOC.tabId);
  assert.equal(rec.textHash, sha256(DRAFT));
  assert.equal(rec.attempt, 0);
  assert.equal(typeof rec.submittedAt, 'number');
  assert.equal(at.cacheAtSend.get(LenzApi.bodyKey(key)).v, at.req.payload);
  assert.equal(w.cache.get(LenzApi.bodyKey(key)).ttl, 21600);
});

// ── acceptance ──────────────────────────────────────────────────────────

test('202 stores the review id and the first poll waits Retry-After', () => {
  const w = world({ replies: [accepted('4881a880')] });
  const r = sub(w, DRAFT);
  assert.deepEqual(
    { ok: r.ok, reviewId: r.reviewId, state: r.state, nextPollS: r.nextPollS },
    { ok: true, reviewId: '4881a880', state: 'running', nextPollS: 20 });
  const rec = w.client.record(DOC.docId, DOC.tabId);
  assert.equal(rec.reviewId, '4881a880');
  assert.equal(rec.state, 'running');
});

test('202 keeps the sent text as the review snapshot', () => {
  const w = world({ replies: [accepted('4881a880')] });
  sub(w, DRAFT);
  assert.equal(w.client.snapshot('4881a880'), DRAFT);
  assert.equal(w.cache.get(LenzApi.snapshotKey('4881a880')).ttl, 21600);
});

test('the first poll wait falls back to 20 s without Retry-After, and never goes under 3 s', () => {
  const w1 = world({ replies: [json(202, { review_id: 'r1', status: 'queued' })] });
  assert.equal(sub(w1, DRAFT).nextPollS, 20);
  const w2 = world({ replies: [json(202, { review_id: 'r1', status: 'queued' }, { 'retry-after': '1' })] });
  assert.equal(sub(w2, DRAFT).nextPollS, 3);
});

test('a 202 with no review id is treated like a lost reply', () => {
  const w = world({ replies: [json(202, { status: 'queued' })] });
  const r = sub(w, DRAFT);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'submitting');
  assert.equal(r.error.retryable, true);
});

test('submitting the same unchanged text again returns the stored review without a POST', () => {
  const w = world({ replies: [accepted('r1')] });
  sub(w, DRAFT);
  const r = sub(w, DRAFT);
  assert.equal(w.calls.length, 1);
  assert.equal(r.reviewId, 'r1');
  assert.equal(r.ok, true);
});

test('an edited Doc after a finished review is a new key at the same attempt', () => {
  const w = world({ replies: [accepted('r1'), accepted('r2')] });
  sub(w, DRAFT);
  const r = sub(w, DRAFT + '\n\nNew paragraph.');
  assert.equal(r.reviewId, 'r2');
  assert.notEqual(keyOf(w.calls[0]), keyOf(w.calls[1]));
  assert.equal(w.client.record(DOC.docId, DOC.tabId).attempt, 0);
});

// ── lost replies (R1, O4) ───────────────────────────────────────────────

test('a lost reply replays the same key and the byte-identical body, even after the Doc changed', () => {
  const w = world({ replies: [transportFail(), accepted('r1')] });
  const first = sub(w, DRAFT);
  assert.equal(first.ok, false);
  assert.equal(first.state, 'submitting');
  assert.equal(first.error.retryable, true);
  const second = sub(w, DRAFT + ' edited since');
  assert.equal(second.reviewId, 'r1');
  assert.equal(keyOf(w.calls[1]), keyOf(w.calls[0]));
  assert.equal(w.calls[1].req.payload, w.calls[0].req.payload);
  assert.equal(second.replayed, true);
  // The snapshot is the text that was SENT, not today's.
  assert.equal(w.client.snapshot('r1'), DRAFT);
});

test('a 5xx with no JSON code is ambiguous: kept pending and replayed', () => {
  const w = world({ replies: [{ code: 502, headers: {}, text: '<html>Bad gateway</html>' }, accepted('r1')] });
  const first = sub(w, DRAFT);
  assert.equal(first.state, 'submitting');
  assert.equal(first.error.retryable, true);
  sub(w, 'other text');
  assert.equal(w.calls[1].req.payload, w.calls[0].req.payload);
});

test('a lost reply whose cached body expired says a check may have started', () => {
  const w = world({ replies: [transportFail()] });
  sub(w, DRAFT);
  w.cache.clear();
  const r = sub(w, DRAFT);
  assert.equal(w.calls.length, 1, 'no request is made without the exact body');
  assert.equal(r.ok, false);
  assert.equal(r.state, 'unknown');
  assert.equal(r.error.retryable, false);
  assert.match(r.error.message, /may have started/);
});

// ── Run again ──────────────────────────────────────────────────────

test('a failed review, then Run again, is a new key for the same text', () => {
  const w = world({ replies: [accepted('r1'), accepted('r2')] });
  sub(w, DRAFT);
  w.client.runAgain(DOC);
  const rec = w.client.record(DOC.docId, DOC.tabId);
  assert.equal(rec.attempt, 1);
  assert.equal(rec.reviewId, null);
  const r = sub(w, DRAFT);
  assert.equal(r.reviewId, 'r2');
  assert.notEqual(keyOf(w.calls[1]), keyOf(w.calls[0]));
  const policy = sortedJson(LenzApi.DEFAULT_POLICY);
  assert.equal(keyOf(w.calls[1]), sha256([DOC.docId, DOC.tabId, sha256(DRAFT), policy, '1'].join('|')));
});

test('Run again on an unknown outcome starts fresh from the current text', () => {
  const w = world({ replies: [transportFail(), accepted('r2')] });
  sub(w, DRAFT);
  w.cache.clear();
  w.client.runAgain(DOC);
  const r = sub(w, 'fresh text');
  assert.equal(r.reviewId, 'r2');
  assert.equal(JSON.parse(w.calls[1].req.payload).text, 'fresh text');
});

test('automatic retries never bump the attempt', () => {
  const w = world({ replies: [transportFail(), transportFail(), accepted('r1')] });
  sub(w, DRAFT); sub(w, DRAFT); sub(w, DRAFT);
  assert.equal(w.client.record(DOC.docId, DOC.tabId).attempt, 0);
  assert.equal(new Set(w.calls.map(keyOf)).size, 1);
});

test('Run again with no record is harmless', () => {
  const w = world();
  w.client.runAgain(DOC);
  assert.equal(w.client.record(DOC.docId, DOC.tabId).attempt, 1);
});

// ── 409 / 422 ───────────────────────────────────────────────────────────

test('409 idempotency_conflict with a review id takes that review', () => {
  const w = world({ replies: [json(409, { detail: 'A review with this Idempotency-Key is still being created. Retry shortly.', code: 'idempotency_conflict', review_id: 'r9' })] });
  const r = sub(w, DRAFT);
  assert.equal(r.ok, true);
  assert.equal(r.reviewId, 'r9');
  assert.equal(r.state, 'running');
  assert.equal(r.nextPollS, 20);
});

test('409 idempotency_conflict with review_id null waits and retries the same body', () => {
  const w = world({ replies: [json(409, { detail: '...', code: 'idempotency_conflict', review_id: null }), accepted('r1')] });
  const first = sub(w, DRAFT);
  assert.equal(first.ok, false);
  assert.equal(first.state, 'pending_conflict');
  assert.equal(first.error.retryable, true);
  assert.equal(first.error.retryAfterS, 5);
  const second = sub(w, 'changed meanwhile');
  assert.equal(second.reviewId, 'r1');
  assert.equal(w.calls[1].req.payload, w.calls[0].req.payload);
  assert.equal(keyOf(w.calls[1]), keyOf(w.calls[0]));
});

test('422 idempotency_body_mismatch is not retryable and asks for a new check', () => {
  const w = world({ replies: [json(422, { detail: 'Idempotency-Key reused with a different request body.', code: 'idempotency_body_mismatch', errors: [] })] });
  const r = sub(w, DRAFT);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'rejected');
  assert.equal(r.error.retryable, false);
  assert.equal(r.error.apiCode, 'idempotency_body_mismatch');
  assert.match(r.error.message, /Check this Doc/);
});

// ── rejections: nothing was created, so the next submit starts fresh ───

const REJECTIONS = [
  ['401', json(401, { detail: 'Unauthorized' })],
  ['402', json(402, { detail: 'No remaining credits to assess the draft.', code: 'no_credits' })],
  ['429 review_in_flight', json(429, { detail: 'x', code: 'review_in_flight', retry_after: 60 }, { 'Retry-After': '60' })],
  ['429 Cloud Armor', { code: 429, headers: {}, text: 'Too Many Requests' }],
  ['503 capacity', json(503, { detail: 'x', code: 'capacity', retry_after: 30 }, { 'Retry-After': '30' })],
];
REJECTIONS.forEach(function (row) {
  test('a ' + row[0] + ' on submit leaves no pending replay; the next submit sends today\'s text', () => {
    const w = world({ replies: [row[1], accepted('r1')] });
    const first = sub(w, DRAFT);
    assert.equal(first.ok, false);
    assert.equal(first.state, 'rejected');
    assert.equal(first.error.code, row[1].code);
    sub(w, 'today');
    assert.equal(JSON.parse(w.calls[1].req.payload).text, 'today');
  });
});

test('a replay refused before Lenz looked it up keeps the first request pending', () => {
  const w = world({ replies: [transportFail(), { code: 429, headers: {}, text: 'Too Many Requests' }, accepted('r1')] });
  sub(w, DRAFT);
  const second = sub(w, DRAFT + ' edited');
  assert.equal(second.ok, false);
  assert.equal(second.state, 'submitting');
  assert.equal(second.error.code, 429);
  const third = sub(w, DRAFT + ' edited again');
  assert.equal(third.reviewId, 'r1');
  assert.equal(new Set(w.calls.map(keyOf)).size, 1);
  assert.equal(w.calls[2].req.payload, w.calls[0].req.payload);
});

test('a refused replay of a 409 conflict stays a pending conflict', () => {
  const w = world({ replies: [json(409, { code: 'idempotency_conflict', review_id: null }), json(503, { code: 'capacity' })] });
  sub(w, DRAFT);
  assert.equal(sub(w, DRAFT).state, 'pending_conflict');
});

test('a pending submission backs off 5, 10, 20, 40, 60 s while its answer is missing', () => {
  const w = world({ replies: Array.from({ length: 6 }, transportFail) });
  const waits = [1, 2, 3, 4, 5, 6].map(() => sub(w, DRAFT).nextPollS);
  assert.deepEqual(waits, [5, 10, 20, 40, 60, 60]);
});

test('a stated Retry-After on a pending submission wins when it is longer', () => {
  const w = world({ replies: [transportFail(), { code: 429, headers: { 'Retry-After': '45' }, text: 'Too Many Requests' }] });
  sub(w, DRAFT);
  assert.equal(sub(w, DRAFT).nextPollS, 45);
});

test('a 409 with no review id retries after its 5 s', () => {
  const w = world({ replies: [json(409, { code: 'idempotency_conflict', review_id: null })] });
  assert.equal(sub(w, DRAFT).nextPollS, 5);
});

test('the backoff resets once the review is accepted', () => {
  const w = world({ replies: [transportFail(), transportFail(), accepted('r1'), accepted('r2'), transportFail()] });
  sub(w, DRAFT); sub(w, DRAFT); sub(w, DRAFT);
  w.client.runAgain(DOC);
  sub(w, DRAFT);
  w.client.runAgain(DOC);
  assert.equal(sub(w, DRAFT).nextPollS, 5);
});

test('a replay Lenz binds to another body can never succeed: the outcome is unknown', () => {
  const w = world({ replies: [transportFail(), json(422, { code: 'idempotency_body_mismatch', errors: [] })] });
  sub(w, DRAFT);
  const r = sub(w, DRAFT);
  assert.equal(r.state, 'unknown');
  assert.equal(r.nextPollS, null);
  assert.equal(w.client.record(DOC.docId, DOC.tabId).state, 'unknown');
  // Run again is the way out.
  w.replies.push(accepted('r2'));
  w.client.runAgain(DOC);
  assert.equal(sub(w, DRAFT).reviewId, 'r2');
});

test('a replay refused for the key stays pending, so a new key can finish it', () => {
  const w = world({ replies: [transportFail(), json(401, { detail: 'Unauthorized' }), accepted('r1')] });
  sub(w, DRAFT);
  const r = sub(w, DRAFT);
  assert.equal(r.state, 'submitting');
  assert.equal(r.error.code, 401);
  assert.equal(sub(w, DRAFT).reviewId, 'r1');
});

// ── signed in with Lenz (OAuth): the bearer comes from getToken ────

// getToken answers from `tokens` in order; each call is recorded with its force flag.
function oauthWorld(replies, tokens) {
  const w = world({ replies: replies });
  const answers = tokens.slice();
  w.tokenCalls = [];
  delete w.deps.apiKey;
  w.deps.getToken = (opts) => {
    w.tokenCalls.push(!!(opts && opts.force));
    return answers.length ? answers.shift() : { token: null, signedOut: true };
  };
  w.client = LenzApi.create(w.deps);
  return w;
}
const tok = (t) => ({ token: t, signedOut: false });

test('signed in: every request carries the access token as its bearer', () => {
  const w = oauthWorld([accepted('r1'), json(200, POLLS[0])], [tok('lat_one'), tok('lat_one')]);
  sub(w, DRAFT);
  w.client.poll(DOC.docId, DOC.tabId);
  assert.deepEqual(w.calls.map((c) => c.req.headers.Authorization), ['Bearer lat_one', 'Bearer lat_one']);
  assert.deepEqual(w.tokenCalls, [false, false]);
});

test('signed in: a 401 rotates the token once and retries the same request', () => {
  const w = oauthWorld([json(401, { detail: 'Unauthorized' }), accepted('r1')], [tok('lat_old'), tok('lat_new')]);
  const r = sub(w, DRAFT);
  assert.equal(r.ok, true);
  assert.equal(r.reviewId, 'r1');
  assert.deepEqual(w.tokenCalls, [false, true]);
  assert.equal(w.calls.length, 2);
  assert.equal(w.calls[1].req.headers.Authorization, 'Bearer lat_new');
  assert.equal(keyOf(w.calls[1]), keyOf(w.calls[0]));
  assert.equal(w.calls[1].req.payload, w.calls[0].req.payload);
});

test('signed in: a second 401 stops, and asks to sign in again', () => {
  const w = oauthWorld([json(401, { detail: 'Unauthorized' }), json(401, { detail: 'Unauthorized' })], [tok('a'), tok('b')]);
  const r = sub(w, DRAFT);
  assert.equal(r.ok, false);
  assert.equal(r.state, 'rejected');
  assert.equal(r.error.code, 401);
  assert.equal(r.error.message, LenzApi.MESSAGES.signed_out);
  assert.deepEqual(w.tokenCalls, [false, true]);
  assert.equal(w.calls.length, 2);
});

test('signed out: nothing is sent, and the answer is a 401 asking to sign in', () => {
  const w = oauthWorld([], [{ token: null, signedOut: true }]);
  const r = sub(w, DRAFT);
  assert.equal(w.calls.length, 0);
  assert.equal(r.state, 'rejected');
  assert.equal(r.error.code, 401);
  assert.equal(r.error.apiCode, 'signed_out');
  assert.equal(r.error.message, LenzApi.MESSAGES.signed_out);
});

test('signed in but Lenz unreachable for a refresh: nothing sent, retried later with the same body', () => {
  const w = oauthWorld([accepted('r1')], [{ token: null, signedOut: false }, tok('lat_back')]);
  const first = sub(w, DRAFT);
  assert.equal(w.calls.length, 0);
  assert.equal(first.state, 'submitting');
  assert.equal(first.error.retryable, true);
  const second = sub(w, DRAFT + ' changed');
  assert.equal(second.reviewId, 'r1');
  assert.equal(JSON.parse(w.calls[0].req.payload).text, DRAFT);
});

test('signed in: a 401 whose refresh finds the user signed out asks to sign in', () => {
  const w = oauthWorld([json(401, { detail: 'Unauthorized' })], [tok('a'), { token: null, signedOut: true }]);
  const r = sub(w, DRAFT);
  assert.equal(w.calls.length, 1);
  assert.equal(r.error.code, 401);
  assert.equal(r.error.message, LenzApi.MESSAGES.signed_out);
});

test('signed in: a 401 whose refresh cannot reach Lenz is retried later, not a sign-out', () => {
  const w = oauthWorld([json(401, {}), accepted('r1')], [tok('a'), { token: null, signedOut: false }, tok('b')]);
  const first = sub(w, DRAFT);
  assert.equal(first.state, 'submitting');
  assert.equal(first.error.code, 0);
  assert.equal(first.error.retryable, true);
  assert.equal(sub(w, DRAFT).reviewId, 'r1');
});

test('signed in: a poll answered 401 rotates and retries the GET', () => {
  const w = oauthWorld([accepted('r1'), json(401, {}), json(200, POLLS[0])], [tok('a'), tok('a'), tok('b')]);
  sub(w, DRAFT);
  const p = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(p.ok, true);
  assert.equal(w.calls[2].req.headers.Authorization, 'Bearer b');
});

test('signed in: a poll answered 401 twice is terminal and asks to sign in', () => {
  const w = oauthWorld([accepted('r1'), json(401, {}), json(401, {})], [tok('a'), tok('a'), tok('b')]);
  sub(w, DRAFT);
  const p = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(p.terminal, true);
  assert.equal(p.error.code, 401);
  assert.equal(p.error.message, LenzApi.MESSAGES.signed_out);
});

test('with an API key, a 401 is not retried', () => {
  const w = world({ replies: [json(401, { detail: 'Unauthorized' })] });
  const r = sub(w, DRAFT);
  assert.equal(w.calls.length, 1);
  assert.equal(r.error.message, LenzApi.MESSAGES.unauthorized);
});

// ── describeError ───────────────────────────────────────────────────────

function d(code, headers, body) {
  return LenzApi.describeError(code, headers || {}, typeof body === 'string' ? body : JSON.stringify(body || {}));
}

test('describeError: every message is short and plain', () => {
  const cases = [
    d(0, {}, ''), d(401), d(402, {}, { code: 'no_credits' }), d(403), d(404), d(409, {}, { code: 'idempotency_conflict' }),
    d(410, {}, { code: 'purged' }), d(422, {}, { code: 'idempotency_body_mismatch' }), d(422, {}, { code: 'validation_error' }),
    d(429, {}, { code: 'review_in_flight' }), d(429, {}, 'Too Many Requests'), d(429, {}, { code: 'extract_daily_limit' }),
    d(503, {}, { code: 'capacity' }), d(500), d(418),
  ];
  cases.forEach(function (e) {
    assert.equal(typeof e.message, 'string');
    assert.ok(e.message.length > 0 && e.message.length <= 140, e.message);
    assert.doesNotMatch(e.message, /\b(endpoint|HTTP|idempotency|JSON|instant|real-time)\b/i, e.message);
    assert.doesNotMatch(e.message, /!/, e.message);
  });
});

test('describeError: transport failure is retryable', () => {
  const e = d(0, {}, '');
  assert.equal(e.code, 0);
  assert.equal(e.retryable, true);
  assert.match(e.message, /reach Lenz/);
});

test('describeError: 401 asks for a new key', () => {
  const e = d(401, {}, { detail: 'Unauthorized' });
  assert.equal(e.retryable, false);
  assert.match(e.message, /key/);
});

test('describeError: 402 points at credits and is not retryable', () => {
  const e = d(402, {}, { detail: 'No remaining credits', code: 'no_credits' });
  assert.equal(e.retryable, false);
  assert.equal(e.apiCode, 'no_credits');
  assert.match(e.message, /credits/);
});

test('describeError: 403 / 404 / 410 on a read are final and say to run the check again', () => {
  [d(403), d(404, {}, { code: 'not_found' }), d(410, {}, { code: 'purged', purged_at: '2026-09-01T00:00:00Z' })].forEach(function (e) {
    assert.equal(e.retryable, false);
    assert.match(e.message, /Check this Doc/);
  });
  assert.notEqual(d(403).message, d(410).message);
});

test('describeError: 429 review_in_flight honours Retry-After (header, then body, then 60)', () => {
  assert.equal(d(429, { 'Retry-After': '45' }, { code: 'review_in_flight', retry_after: 60 }).retryAfterS, 45);
  assert.equal(d(429, {}, { code: 'review_in_flight', retry_after: 50 }).retryAfterS, 50);
  const e = d(429, {}, { code: 'review_in_flight' });
  assert.equal(e.retryAfterS, 60);
  assert.equal(e.retryable, true);
  assert.equal(e.apiCode, 'review_in_flight');
});

test('describeError: Cloud Armor 429 (not JSON) is retryable after 60 s', () => {
  const e = d(429, {}, '<!doctype html><title>429 Too Many Requests</title>');
  assert.equal(e.retryable, true);
  assert.equal(e.retryAfterS, 60);
  assert.equal(e.apiCode, null);
  assert.notEqual(e.message, d(429, {}, { code: 'review_in_flight' }).message);
});

test('describeError: 503 capacity reads Retry-After, then body retry_after, then 90', () => {
  assert.equal(d(503, { 'retry-after': '30' }, { code: 'capacity', retry_after: 90 }).retryAfterS, 30);
  assert.equal(d(503, {}, { code: 'capacity', retry_after: 40 }).retryAfterS, 40);
  const e = d(503, {}, { code: 'capacity' });
  assert.equal(e.retryAfterS, 90);
  assert.equal(e.retryable, true);
  assert.match(e.message, /Nothing was charged/);
});

test('describeError: other 5xx are retryable, other 4xx are not', () => {
  assert.equal(d(500).retryable, true);
  assert.equal(d(504, {}, 'gateway').retryable, true);
  assert.equal(d(418).retryable, false);
});

test('describeError: a 409 with no id says it is still starting', () => {
  const e = d(409, {}, { code: 'idempotency_conflict', review_id: null });
  assert.equal(e.retryable, true);
  assert.equal(e.retryAfterS, 5);
});

test('describeError: a bad Retry-After value falls back to the default', () => {
  assert.equal(d(503, { 'Retry-After': 'soon' }, { code: 'capacity' }).retryAfterS, 90);
  assert.equal(d(503, { 'Retry-After': '-4' }, { code: 'capacity' }).retryAfterS, 90);
});

// ── polling ─────────────────────────────────────────────────────────────

function accepted_world(replies) {
  const w = world({ replies: [accepted('4881a880')].concat(replies) });
  sub(w, DRAFT);
  return w;
}

test('poll GETs the review with the bearer and reads poll_after_seconds', () => {
  const w = accepted_world([json(200, POLLS[0])]);
  const p = w.client.poll(DOC.docId, DOC.tabId);
  const req = w.calls[1].req;
  assert.equal(req.method, 'get');
  assert.equal(req.url, BASE + '/reviews/4881a880');
  assert.equal(req.headers.Authorization, 'Bearer ' + w.deps.apiKey);
  assert.equal(req.headers['Idempotency-Key'], undefined);
  assert.equal(p.ok, true);
  assert.equal(p.status, 'verifying');
  assert.equal(p.terminal, false);
  assert.equal(p.nextPollS, 15);
  assert.equal(p.body.review_id, '4881a880');
});

test('poll walks the captured states to completed', () => {
  const w = accepted_world(POLLS.map((b) => json(200, b)));
  const statuses = POLLS.map(() => w.client.poll(DOC.docId, DOC.tabId));
  assert.deepEqual(statuses.map((p) => p.status), POLLS.map((b) => b.status));
  const last = statuses[statuses.length - 1];
  assert.equal(last.terminal, true);
  assert.equal(last.nextPollS, null);
  assert.equal(w.client.record(DOC.docId, DOC.tabId).state, 'completed');
});

test('poll: a failed review is terminal and recorded as failed', () => {
  const body = Object.assign({}, REVIEW, { status: 'failed', outcome: null, poll_after_seconds: null, failure: { code: 'x', failure_class: 'upstream_unavailable', retryable: true, docs_url: 'u' } });
  const w = accepted_world([json(200, body)]);
  const p = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(p.terminal, true);
  assert.equal(p.status, 'failed');
  assert.equal(w.client.record(DOC.docId, DOC.tabId).state, 'failed');
});

test('poll: poll_after_seconds under 3 is raised to 3; missing while running is 15', () => {
  const w = accepted_world([
    json(200, Object.assign({}, POLLS[0], { poll_after_seconds: 1 })),
    json(200, Object.assign({}, POLLS[0], { poll_after_seconds: null })),
  ]);
  assert.equal(w.client.poll(DOC.docId, DOC.tabId).nextPollS, 3);
  assert.equal(w.client.poll(DOC.docId, DOC.tabId).nextPollS, 15);
});

test('poll: a transport failure or 5xx retries with backoff, and a success resets it', () => {
  const w = accepted_world([transportFail(), { code: 502, headers: {}, text: 'x' }, transportFail(), json(200, POLLS[0]), transportFail()]);
  const waits = [1, 2, 3, 4, 5].map(() => w.client.poll(DOC.docId, DOC.tabId));
  assert.deepEqual(waits.map((p) => p.ok), [false, false, false, true, false]);
  assert.deepEqual(waits.map((p) => p.terminal), [false, false, false, false, false]);
  assert.deepEqual(waits.map((p) => p.nextPollS), [5, 10, 20, 15, 5]);
  assert.equal(waits[0].error.retryable, true);
});

test('poll: backoff is capped at 60 s', () => {
  const w = accepted_world(Array.from({ length: 8 }, transportFail));
  let last;
  for (let i = 0; i < 8; i++) last = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(last.nextPollS, 60);
});

// ── a poll that keeps failing gives up after five minutes, and Resume polls the same review again ──

const FIVE_MIN = 5 * 60 * 1000;
const capacity503 = () => json(503, { code: 'capacity' }, { 'Retry-After': '90' });
const throttled429 = () => ({ code: 429, headers: {}, text: 'Too Many Requests' });

[['no response', transportFail], ['a 5xx', () => ({ code: 502, headers: {}, text: 'x' })], ['a 503 with a code', capacity503], ['a 429', throttled429]].forEach(function (row) {
  test('poll: ' + row[0] + ' for five minutes in a row ends polling (gaveUp), and the record keeps its review id', () => {
    const w = accepted_world([row[1](), row[1](), row[1]()]);
    const first = w.client.poll(DOC.docId, DOC.tabId);
    assert.equal(first.gaveUp, false);
    assert.equal(first.terminal, false);
    w.tick(FIVE_MIN - 1000);
    const near = w.client.poll(DOC.docId, DOC.tabId);
    assert.equal(near.gaveUp, false);
    assert.notEqual(near.nextPollS, null);
    w.tick(1000);
    const last = w.client.poll(DOC.docId, DOC.tabId);
    assert.equal(last.gaveUp, true);
    assert.equal(last.ok, false);
    assert.equal(last.terminal, false);
    assert.equal(last.nextPollS, null);
    assert.equal(last.error.retryable, true);
    const rec = w.client.record(DOC.docId, DOC.tabId);
    assert.equal(rec.reviewId, '4881a880');
    assert.equal(rec.state, 'running');
  });
});

test('poll: one answer in between starts the five minutes over', () => {
  const w = accepted_world([transportFail(), json(200, POLLS[0]), transportFail()]);
  w.client.poll(DOC.docId, DOC.tabId);
  w.tick(FIVE_MIN - 1000);
  assert.equal(w.client.poll(DOC.docId, DOC.tabId).ok, true);
  w.tick(FIVE_MIN - 1000);
  const p = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(p.gaveUp, false);
  assert.equal(p.nextPollS, 5);
  assert.equal(w.client.record(DOC.docId, DOC.tabId).pollFailingSince, w.deps.now());
});

test('poll: a failed poll that is terminal (403/404/410) is not a give-up', () => {
  const w = accepted_world([json(404, { code: 'not_found' })]);
  const p = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(p.gaveUp, false);
  assert.equal(p.terminal, true);
});

test('resume: the same review id is polled again with a fresh window, and nothing else is sent', () => {
  const w = accepted_world([transportFail(), transportFail(), json(200, POLLS[0]), transportFail(), transportFail()]);
  w.client.poll(DOC.docId, DOC.tabId);
  w.tick(FIVE_MIN);
  assert.equal(w.client.poll(DOC.docId, DOC.tabId).gaveUp, true);
  // A later poll that fails still counts the old streak; only resume clears it.
  const before = w.calls.length;
  assert.equal(w.client.resume(DOC.docId, DOC.tabId), true);
  const rec = w.client.record(DOC.docId, DOC.tabId);
  assert.equal(rec.reviewId, '4881a880');
  assert.equal(rec.pollFailingSince, null);
  assert.equal(w.calls.length, before, 'resume itself makes no request');
  const p = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(p.ok, true);
  const get = w.calls[w.calls.length - 1].req;
  assert.equal(get.method, 'get');
  assert.equal(get.url, BASE + '/reviews/4881a880');
  assert.equal(w.calls.filter((c) => c.req.method === 'post').length, 1, 'the only POST is the first submission');
  // A new window: failing again does not give up at once.
  const again = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(again.gaveUp, false);
  assert.equal(again.nextPollS, 5);
});

test('resume with no saved review does nothing', () => {
  const w = world();
  assert.equal(w.client.resume(DOC.docId, DOC.tabId), false);
  assert.equal(w.client.record(DOC.docId, DOC.tabId), null);
});

test('Run again clears the failed-poll streak with the review', () => {
  const w = accepted_world([transportFail()]);
  w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(typeof w.client.record(DOC.docId, DOC.tabId).pollFailingSince, 'number');
  w.client.runAgain(DOC);
  assert.equal(w.client.record(DOC.docId, DOC.tabId).pollFailingSince, null);
});

test('poll: 429 waits the stated time', () => {
  const w = accepted_world([{ code: 429, headers: { 'Retry-After': '30' }, text: 'Too Many Requests' }]);
  const p = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(p.terminal, false);
  assert.equal(p.nextPollS, 30);
});

[[403, { code: 'forbidden' }], [404, { code: 'not_found' }], [410, { code: 'purged' }], [401, { detail: 'Unauthorized' }]].forEach(function (row) {
  test('poll: ' + row[0] + ' stops polling', () => {
    const w = accepted_world([json(row[0], row[1])]);
    const p = w.client.poll(DOC.docId, DOC.tabId);
    assert.equal(p.ok, false);
    assert.equal(p.terminal, true);
    assert.equal(p.nextPollS, null);
    assert.equal(p.error.code, row[0]);
  });
});

test('poll: 403/404/410 mark the record lost, so the next submit starts a new review', () => {
  const w = accepted_world([json(410, { code: 'purged' }), accepted('r2')]);
  w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(w.client.record(DOC.docId, DOC.tabId).state, 'lost');
  const r = sub(w, DRAFT);
  assert.equal(r.reviewId, 'r2');
});

test('poll: a 200 that is not JSON is a retryable failure', () => {
  const w = accepted_world([{ code: 200, headers: {}, text: '<html>' }]);
  const p = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(p.ok, false);
  assert.equal(p.terminal, false);
  assert.equal(p.error.retryable, true);
});

test('poll: an answer about a review the record no longer holds is dropped', () => {
  const w = accepted_world([]);
  const deps = w.deps;
  const realFetch = deps.fetch;
  // During the GET, the user chooses Run again and a new review starts.
  w.replies.push(json(200, POLLS[POLLS.length - 1]));
  const client = LenzApi.create(Object.assign({}, deps, {
    fetch: function (req) {
      const res = realFetch(req);
      w.client.runAgain(DOC);
      w.store.set(LenzApi.recordKey(DOC.docId, DOC.tabId), JSON.stringify(Object.assign(
        w.client.record(DOC.docId, DOC.tabId), { key: 'k2', reviewId: 'r2', state: 'running' })));
      return res;
    },
  }));
  const p = client.poll(DOC.docId, DOC.tabId);
  assert.equal(p.ok, false);
  assert.equal(p.terminal, true);
  assert.equal(p.error, null);
  const rec = w.client.record(DOC.docId, DOC.tabId);
  assert.equal(rec.reviewId, 'r2');
  assert.equal(rec.state, 'running');
  assert.equal(rec.attempt, 1);
});

test('poll with no review id makes no request', () => {
  const w = world();
  const p = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(w.calls.length, 0);
  assert.equal(p.ok, false);
  assert.equal(p.terminal, true);
});

test('record is null for an unknown doc and tab', () => {
  assert.equal(world().client.record('nope', 't.0'), null);
});

test('a corrupt stored record reads as none', () => {
  const w = world();
  w.store.set(LenzApi.recordKey(DOC.docId, DOC.tabId), '{not json');
  assert.equal(w.client.record(DOC.docId, DOC.tabId), null);
});

// ── edit: the server body is the source of truth ───────────────────────

test('edit returns the edit from the review body, with its claim passage', () => {
  const e = world().client.edit(REVIEW, 1, 0);
  const claim = REVIEW.claims.find((c) => c.index === 1);
  assert.deepEqual(e, {
    claimIndex: 1,
    editIndex: 0,
    start: 563,
    end: 574,
    text: 'Buzz Aldrin',
    replacement: 'Neil Armstrong',
    position: 0,
    passage: { start: claim.positions[0].start, end: claim.positions[0].end, text: claim.positions[0].text },
  });
});

test('edit finds the claim by its index field, not its array position', () => {
  const shuffled = Object.assign({}, REVIEW, { claims: REVIEW.claims.slice().reverse() });
  assert.equal(world().client.edit(shuffled, 1, 0).replacement, 'Neil Armstrong');
});

test('edit reads an issues-only body through the issue row', () => {
  const issuesOnly = Object.assign({}, REVIEW);
  delete issuesOnly.claims;
  const e = world().client.edit(issuesOnly, 1, 0);
  assert.equal(e.replacement, 'Neil Armstrong');
  assert.equal(e.passage, null);
});

test('edit is null for a missing claim, edit, pending or absent suggested_edits', () => {
  const c = world().client;
  assert.equal(c.edit(REVIEW, 99, 0), null);
  assert.equal(c.edit(REVIEW, 1, 1), null);
  assert.equal(c.edit(REVIEW, 0, 0), null); // edits: []
  assert.equal(c.edit(REVIEW, 3, 0), null); // suggested_edits: null
  assert.equal(c.edit(REVIEW, -1, 0), null);
  assert.equal(c.edit(REVIEW, 1, '0'), null);
  assert.equal(c.edit(null, 1, 0), null);
  const pending = JSON.parse(JSON.stringify(REVIEW));
  pending.claims.find((x) => x.index === 1).suggested_edits = { status: 'pending', edits: null };
  pending.issues.forEach((i) => { i.suggested_edits = null; });
  assert.equal(c.edit(pending, 1, 0), null);
});

test('edit refuses a malformed edit rather than guessing', () => {
  const c = world().client;
  const bad = [
    { start: 10, end: 5, text: 'x', replacement: 'y', position: 0 },
    { start: '1', end: 5, text: 'x', replacement: 'y', position: 0 },
    { start: 1, end: 5, text: null, replacement: 'y', position: 0 },
    { start: 1, end: 5, text: 'x', replacement: 7, position: 0 },
    { start: 1.5, end: 5, text: 'x', replacement: 'y', position: 0 },
  ];
  bad.forEach(function (edit) {
    const body = JSON.parse(JSON.stringify(REVIEW));
    body.claims.find((x) => x.index === 1).suggested_edits.edits = [edit];
    assert.equal(c.edit(body, 1, 0), null, JSON.stringify(edit));
  });
});

test('edit accepts an empty replacement (a deletion)', () => {
  const body = JSON.parse(JSON.stringify(REVIEW));
  body.claims.find((x) => x.index === 1).suggested_edits.edits[0].replacement = '';
  assert.equal(world().client.edit(body, 1, 0).replacement, '');
});

// ── purity ──────────────────────────────────────────────────────────────

test('api.js uses no Apps Script globals and no syntax past ES2019', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'api.js'), 'utf8');
  ['DocumentApp', 'Docs.', 'UrlFetchApp', 'PropertiesService', 'CacheService', 'Utilities', 'LockService', 'Session.']
    .forEach((g) => assert.ok(!src.includes(g), g));
  assert.ok(!/\?\./.test(src.replace(/'[^']*'/g, '')), 'optional chaining');
  assert.ok(!/\?\?/.test(src), 'nullish coalescing');
  assert.ok(!/^\s*(import|export)\s/m.test(src), 'modules');
});

// ── a selection check: a slice of the tab, its offset and the whole tab ──

const WHOLE = 'An opening paragraph.\n\n' + DRAFT;
// Offsets in code points, as /review counts them.
const AT = Array.from('An opening paragraph.\n\n').length;
const cpSlice = (t, a, b) => Array.from(t).slice(a, b).join('');
const selection = (extra) => Object.assign({ snapshot: WHOLE, offset: AT, scope: { paragraphs: 3 } }, extra || {});

test('selection: the slice is the body, the whole tab is the snapshot, the record keeps the offset', () => {
  const w = world({ replies: [accepted('r1')] });
  const r = sub(w, DRAFT, selection());
  assert.equal(r.ok, true);
  assert.equal(JSON.parse(w.calls[0].req.payload).text, DRAFT);
  assert.equal(w.client.snapshot('r1'), WHOLE);
  const rec = w.client.record(DOC.docId, DOC.tabId);
  assert.equal(rec.offset, AT);
  assert.equal(rec.snapshotHash, sha256(WHOLE));
  assert.deepEqual(rec.scope, { paragraphs: 3 });
  assert.equal(rec.textHash, sha256(DRAFT));
});

test('selection: the key is the whole-tab key plus the offset and the whole tab, so it never meets another', () => {
  const policy = sortedJson(LenzApi.DEFAULT_POLICY);
  const plainKey = sha256([DOC.docId, DOC.tabId, sha256(DRAFT), policy, '0'].join('|'));
  const w = world({ replies: [accepted('r1'), accepted('r2'), accepted('r3'), accepted('r4')] });
  sub(w, DRAFT);
  assert.equal(keyOf(w.calls[0]), plainKey);
  sub(w, DRAFT, selection());
  assert.equal(keyOf(w.calls[1]), sha256([DOC.docId, DOC.tabId, sha256(DRAFT), policy, '0',
    'sel:' + AT + ':' + sha256(WHOLE)].join('|')));
  // The same words moved, or the tab changed around them: a new review, not the old id.
  sub(w, DRAFT, selection({ snapshot: 'Moved.\n\n' + WHOLE, offset: AT + 8 }));
  sub(w, DRAFT, selection({ snapshot: WHOLE + '\n\nAnd more.' }));
  assert.equal(new Set(w.calls.map(keyOf)).size, 4);
  // The same selection of the same tab again: the stored review, no POST.
  const again = sub(w, DRAFT, selection({ snapshot: WHOLE + '\n\nAnd more.' }));
  assert.equal(again.reviewId, 'r4');
  assert.equal(w.calls.length, 4);
});

test('selection: a lost reply replays the body and lands the whole-tab snapshot', () => {
  const w = world({ replies: [transportFail(), accepted('r1')] });
  assert.equal(sub(w, DRAFT, selection()).state, 'submitting');
  const r = sub(w, 'whatever the Doc says now');
  assert.equal(r.reviewId, 'r1');
  assert.equal(w.calls[1].req.payload, w.calls[0].req.payload);
  assert.equal(w.client.snapshot('r1'), WHOLE);
  assert.equal(w.client.record(DOC.docId, DOC.tabId).offset, AT);
});

test('selection: a whole-tab snapshot evicted before accept leaves no snapshot, never the slice', () => {
  const w = world({ replies: [transportFail(), accepted('r1')] });
  sub(w, DRAFT, selection());
  w.cache.delete(LenzApi.scopeSnapshotKey(w.client.record(DOC.docId, DOC.tabId).key));
  sub(w, DRAFT);
  assert.equal(w.client.snapshot('r1'), null);
});

test('selection: Run again forgets the offset, and the next whole-tab check has none', () => {
  const w = world({ replies: [accepted('r1'), accepted('r2')] });
  sub(w, DRAFT, selection());
  w.client.runAgain(DOC);
  const idle = w.client.record(DOC.docId, DOC.tabId);
  assert.equal('offset' in idle || 'snapshotHash' in idle || 'scope' in idle, false);
  sub(w, WHOLE);
  const rec = w.client.record(DOC.docId, DOC.tabId);
  assert.equal(rec.offset, undefined);
  assert.equal(w.client.snapshot('r2'), WHOLE);
});

test('selection: a poll moves every draft position by the offset, once', () => {
  const w = world({ replies: [accepted('r1'), json(200, REVIEW)] });
  sub(w, DRAFT, selection());
  const body = w.client.poll(DOC.docId, DOC.tabId).body;
  const claim = REVIEW.claims.find((c) => c.positions && c.positions.length);
  const got = body.claims.find((c) => c.index === claim.index);
  assert.equal(got.positions[0].start, claim.positions[0].start + AT);
  assert.equal(cpSlice(WHOLE, got.positions[0].start, got.positions[0].end), claim.positions[0].text);
  const cit = REVIEW.citations.find((c) => c.position);
  assert.equal(body.citations.find((c) => c.index === cit.index).position.start, cit.position.start + AT);
  const edited = REVIEW.claims.find((c) => c.suggested_edits && (c.suggested_edits.edits || []).length);
  const e0 = edited.suggested_edits.edits[0];
  const g0 = body.claims.find((c) => c.index === edited.index).suggested_edits.edits[0];
  assert.deepEqual([g0.start, g0.end, g0.position], [e0.start + AT, e0.end + AT, e0.position]);
  assert.equal(cpSlice(WHOLE, g0.start, g0.end), e0.text);
});

test('shiftBody: every listed field moves; nulls, indexes and other numbers do not', () => {
  const body = {
    claims: [{ index: 0, positions: [{ start: 1, end: 2, text: 'a' }, { start: null, end: null, text: 'b' }],
      suggested_edits: { edits: [{ start: 3, end: 3, text: '', replacement: 'x', position: 0 }] } }],
    issues: [{ claim_index: 0, suggested_edits: { edits: [{ start: 4, end: 5, text: 'c', replacement: 'd', position: 1 }] } }],
    citations: [{ index: 0, position: { start: 6, end: 7, text: null } }, { index: 1, position: null }],
    citation_issues: [{ citation_index: 0, position: { start: 8, end: 9, text: null } }],
    citation_failures: [{ citation_index: 1, position: { start: 10, end: 11, text: null } }],
    more_claim_locations: [{ claim: 'q', positions: [{ start: 12, end: 13, text: 'e' }] }, { claim: 'r', positions: null }],
    more_citations: [{ index: 2, sentence: 's', position: { start: 14, end: 15, text: null } }],
    summary: { start: 1, end: 2 },
    credits: { charged: 3 },
  };
  LenzApi.shiftBody(body, 100);
  assert.deepEqual(body.claims[0].positions, [{ start: 101, end: 102, text: 'a' }, { start: null, end: null, text: 'b' }]);
  assert.deepEqual([body.claims[0].suggested_edits.edits[0].start, body.claims[0].suggested_edits.edits[0].position], [103, 0]);
  assert.equal(body.issues[0].suggested_edits.edits[0].start, 104);
  assert.equal(body.citations[0].position.start, 106);
  assert.equal(body.citations[1].position, null);
  assert.equal(body.citation_issues[0].position.end, 109);
  assert.equal(body.citation_failures[0].position.start, 110);
  assert.equal(body.more_claim_locations[0].positions[0].start, 112);
  assert.equal(body.more_citations[0].position.start, 114);
  assert.deepEqual(body.summary, { start: 1, end: 2 });
  assert.equal(body.credits.charged, 3);
  assert.equal(body.claims[0].index, 0);
});

test('a whole-tab check: polls never move a position', () => {
  const w = world({ replies: [accepted('r1'), json(200, REVIEW)] });
  sub(w, DRAFT);
  assert.deepEqual(w.client.poll(DOC.docId, DOC.tabId).body, REVIEW);
});

test('selection: once accepted, the whole tab is the review snapshot and the pending copy is gone', () => {
  const w = world({ replies: [accepted('r1')] });
  sub(w, DRAFT, selection());
  const key = w.client.record(DOC.docId, DOC.tabId).key;
  assert.equal(w.cache.has(LenzApi.scopeSnapshotKey(key)), false);
  assert.equal(w.client.snapshot('r1'), WHOLE);
});

// ── cancel ──────────────────────────────────────────────────

const CANCELLED = JSON.parse(fs.readFileSync(path.join(FIX, 'cancelled-midway.review.json'), 'utf8'));

function runningReview(replies) {
  const w = world({ replies: [accepted()].concat(replies || []) });
  sub(w, DRAFT);
  return w;
}
const rec = (w) => JSON.parse(w.store.get(LenzApi.recordKey(DOC.docId, DOC.tabId)));

test('cancel: POST /reviews/{id}/cancel with no body, the record settles cancelled', () => {
  const w = runningReview([json(200, CANCELLED)]);
  const r = w.client.cancel(DOC.docId, DOC.tabId);
  const c = w.calls[1].req;
  assert.equal(c.method, 'post');
  assert.equal(c.url, BASE + '/reviews/' + ACCEPT.body.review_id + '/cancel');
  assert.equal(c.payload, undefined);
  assert.equal(c.headers['Idempotency-Key'], undefined);
  assert.equal(r.ok, true);
  assert.equal(r.terminal, true);
  assert.equal(r.status, 'cancelled');
  assert.equal(rec(w).state, 'cancelled');
  assert.equal(rec(w).reviewId, ACCEPT.body.review_id);
});

test('cancel vs complete: a review that ended first is recorded as it ended', () => {
  const w = runningReview([json(200, REVIEW)]);
  const r = w.client.cancel(DOC.docId, DOC.tabId);
  assert.equal(r.status, 'completed');
  assert.equal(rec(w).state, 'completed');
});

test('cancel twice: a record already ended sends no second cancel (a GET reads it)', () => {
  const w = runningReview([json(200, CANCELLED), json(200, CANCELLED)]);
  w.client.cancel(DOC.docId, DOC.tabId);
  const r = w.client.cancel(DOC.docId, DOC.tabId);
  assert.equal(w.calls.length, 3);
  assert.equal(w.calls[2].req.method, 'get');
  assert.equal(r.status, 'cancelled');
});

test('cancel with no answer or a 5xx: the record stays running, the same request may go again', () => {
  const w = runningReview([transportFail(), json(502, {}), json(200, CANCELLED)]);
  const a = w.client.cancel(DOC.docId, DOC.tabId);
  assert.equal(a.ok, false);
  assert.equal(a.terminal, false);
  assert.equal(a.error.message, LenzApi.MESSAGES.transport);
  assert.equal(rec(w).state, 'running');
  const b = w.client.cancel(DOC.docId, DOC.tabId);
  assert.equal(b.terminal, false);
  assert.equal(rec(w).state, 'running');
  const c = w.client.cancel(DOC.docId, DOC.tabId);
  assert.equal(c.status, 'cancelled');
  assert.deepEqual(w.calls.slice(1).map((x) => x.req.url), Array(3).fill(BASE + '/reviews/' + ACCEPT.body.review_id + '/cancel'));
});

test('cancel: a review out of reach (404) is lost, and the next submit is a new review', () => {
  const w = runningReview([json(404, { code: 'not_found' })]);
  const r = w.client.cancel(DOC.docId, DOC.tabId);
  assert.equal(r.terminal, true);
  assert.equal(rec(w).state, 'lost');
});

test('cancel with no review yet sends nothing', () => {
  const w = world();
  const r = w.client.cancel(DOC.docId, DOC.tabId);
  assert.equal(w.calls.length, 0);
  assert.equal(r.ok, false);
  assert.equal(r.error.message, LenzApi.MESSAGES.cancel_not_started);
});

test('a poll that reads a cancelled review ends polling', () => {
  const w = runningReview([json(200, CANCELLED)]);
  const r = w.client.poll(DOC.docId, DOC.tabId);
  assert.equal(r.terminal, true);
  assert.equal(r.nextPollS, null);
  assert.equal(rec(w).state, 'cancelled');
});
