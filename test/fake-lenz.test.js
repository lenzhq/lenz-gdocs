'use strict';
// The fake Lenz API the flow tests poll. Pins the wire shapes it answers with (Lenz's public /review API).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeLenz } = require('./helpers/fake-lenz.js');

const BASE = 'https://lenz.io/api/v1';
const KEY = 'lenz_test_key';

function setup(o) {
  let t = 1e12;
  const lenz = createFakeLenz(Object.assign({ apiKey: KEY, now: () => t }, o || {}));
  return { lenz, tick: (ms) => { t += ms; } };
}
function post(lenz, text, key, extra) {
  const headers = { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  return lenz.fetch({ method: 'post', url: BASE + '/review', headers,
                      payload: JSON.stringify(Object.assign({ text }, extra || {})) });
}
function get(lenz, id) {
  return lenz.fetch({ method: 'get', url: BASE + '/reviews/' + id, headers: { Authorization: 'Bearer ' + KEY } });
}
const body = (res) => JSON.parse(res.text);

test('POST /review: 202 receipt with Location and Retry-After 20', () => {
  const { lenz } = setup();
  const res = post(lenz, lenz.fixture('draft-a').text, 'k1');
  assert.equal(res.code, 202);
  const b = body(res);
  assert.equal(b.status, 'queued');
  assert.match(b.review_id, /^[0-9a-f]{8}$/);
  assert.equal(res.headers.Location, '/api/v1/reviews/' + b.review_id);
  assert.equal(res.headers['Retry-After'], '20');
});

test('GET walks the captured polls to the completed fixture body, under the fake review id', () => {
  const { lenz } = setup();
  const id = body(post(lenz, lenz.fixture('draft-b').text, 'k1')).review_id;
  const seen = [];
  for (let i = 0; i < 10; i++) {
    const r = body(get(lenz, id));
    assert.equal(r.review_id, id);
    seen.push(r.status);
    if (r.status === 'completed') break;
  }
  assert.deepEqual(seen, ['verifying', 'verifying', 'verifying', 'verifying', 'verifying', 'completed']);
  const done = body(get(lenz, id));
  const expected = lenz.completedBody('draft-b');
  expected.review_id = id;
  assert.deepEqual(done, expected);
});

test('pollsBeforeDone shortens the walk; the text matches ignoring a trailing newline', () => {
  const { lenz } = setup({ pollsBeforeDone: 1 });
  const id = body(post(lenz, lenz.fixture('draft-a').text.replace(/\n+$/, ''), 'k')).review_id;
  assert.equal(body(get(lenz, id)).status, 'verifying');
  assert.equal(body(get(lenz, id)).status, 'completed');
});

test('a text that matches no fixture completes with no findings', () => {
  const { lenz } = setup({ pollsBeforeDone: 0 });
  const id = body(post(lenz, 'Something else entirely.', 'k')).review_id;
  const r = body(get(lenz, id));
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.claims, []);
});

test('idempotency: same key and body replays the receipt; a new key is a new review', () => {
  const { lenz } = setup();
  const text = lenz.fixture('draft-a').text;
  const a = body(post(lenz, text, 'k1')).review_id;
  assert.equal(body(post(lenz, text, 'k1')).review_id, a);
  assert.notEqual(body(post(lenz, text, 'k2')).review_id, a);
  assert.notEqual(body(post(lenz, text)).review_id, a); // no key: always new
  assert.equal(Object.keys(lenz.reviews).length, 3);
});

test('idempotency: a different body under the key is 422 idempotency_body_mismatch', () => {
  const { lenz } = setup();
  post(lenz, 'One.', 'k1');
  const res = post(lenz, 'Two.', 'k1');
  assert.equal(res.code, 422);
  assert.equal(body(res).code, 'idempotency_body_mismatch');
});

test('idempotency: the replay window is 24 h', () => {
  const { lenz, tick } = setup();
  const a = body(post(lenz, 'One.', 'k1')).review_id;
  tick(24 * 3600 * 1000 - 1);
  assert.equal(body(post(lenz, 'One.', 'k1')).review_id, a);
  tick(2);
  assert.notEqual(body(post(lenz, 'One.', 'k1')).review_id, a);
});

test('401 without the key; 404 for an unknown review', () => {
  const { lenz } = setup();
  const res = lenz.fetch({ method: 'post', url: BASE + '/review', headers: {}, payload: '{"text":"x"}' });
  assert.equal(res.code, 401);
  const nf = get(lenz, 'deadbeef');
  assert.equal(nf.code, 404);
  assert.equal(body(nf).code, 'not_found');
});

test('scripted failures answer once each, in order, then normal service resumes', () => {
  const { lenz } = setup();
  lenz.fail.conflict();
  lenz.fail.inFlight();
  lenz.fail.armor('post');
  lenz.fail.capacity();
  lenz.fail.transport('post');
  const c = post(lenz, 'x', 'k');
  assert.equal(c.code, 409);
  assert.deepEqual(body(c), { detail: 'A review with this Idempotency-Key is still being created. Retry shortly.',
                              code: 'idempotency_conflict', review_id: null });
  const f = post(lenz, 'x', 'k');
  assert.equal(f.code, 429);
  assert.equal(body(f).code, 'review_in_flight');
  assert.equal(f.headers['Retry-After'], '60');
  const a = post(lenz, 'x', 'k');
  assert.equal(a.code, 429);
  assert.throws(() => JSON.parse(a.text));
  const cap = post(lenz, 'x', 'k');
  assert.equal(cap.code, 503);
  assert.equal(body(cap).code, 'capacity');
  assert.equal(body(cap).retry_after, 90);
  assert.equal(cap.headers['Retry-After'], '90');
  assert.deepEqual(post(lenz, 'x', 'k'), { code: 0, headers: {}, text: '' });
  assert.equal(post(lenz, 'x', 'k').code, 202);
  assert.equal(Object.keys(lenz.reviews).length, 1);
});

test('a lost reply: the server created the review, the add-on heard nothing; the replay finds it', () => {
  const { lenz } = setup();
  lenz.fail.transport('post', { processed: true });
  assert.equal(post(lenz, 'x', 'k').code, 0);
  assert.equal(Object.keys(lenz.reviews).length, 1);
  const id = Object.keys(lenz.reviews)[0];
  assert.equal(body(post(lenz, 'x', 'k')).review_id, id);
});

test('fail.review: the next review of that text ends failed with a failure block', () => {
  const { lenz } = setup({ pollsBeforeDone: 1 });
  const text = lenz.fixture('draft-b').text;
  lenz.fail.review(text);
  const id = body(post(lenz, text, 'k1')).review_id;
  assert.equal(body(get(lenz, id)).status, 'verifying');
  const r = body(get(lenz, id));
  assert.equal(r.status, 'failed');
  assert.equal(r.failure.failure_class, 'upstream_unavailable');
  assert.equal(r.failure.retryable, true);
  // Only that one: the next review of the same text completes.
  const id2 = body(post(lenz, text, 'k2')).review_id;
  get(lenz, id2);
  assert.equal(body(get(lenz, id2)).status, 'completed');
});

test('a lost reply followed by a scripted refusal: the lost request creates the review, the replay is refused', () => {
  const { lenz } = setup();
  lenz.fail.transport('post', { processed: true });
  lenz.fail.capacity();
  assert.equal(post(lenz, 'x', 'k').code, 0);
  assert.equal(Object.keys(lenz.reviews).length, 1, 'the lost request did the work');
  assert.equal(post(lenz, 'x', 'k').code, 503, 'the queued refusal is still there');
  assert.equal(post(lenz, 'x', 'k').code, 202);
});

test('fail.review applies to a text that matches no fixture too', () => {
  const { lenz } = setup();
  lenz.fail.review('Some new text.');
  const id = body(post(lenz, 'Some new text.', 'k')).review_id;
  const r = body(get(lenz, id));
  assert.equal(r.status, 'failed');
  assert.equal(r.failure.failure_class, 'upstream_unavailable');
});
