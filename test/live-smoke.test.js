// The live smoke's logic against a fake /review (no network, no key, no credits).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const smoke = require('../scripts/live-smoke.js');

const FIX = path.join(__dirname, 'fixtures', 'reviews');
const TEXT = fs.readFileSync(path.join(FIX, 'draft-b.txt'), 'utf8');
const REVIEW_B = JSON.parse(fs.readFileSync(path.join(FIX, 'draft-b.review.json'), 'utf8'));
const KEY = 'lenz_' + 'k'.repeat(32);

// A fake /review that keeps Lenz's idempotency rule: a key replays its receipt.
function fakeServer(opts) {
  const o = opts || {};
  const byKey = new Map();
  const reviews = new Map();
  let next = 0;
  const posts = [];
  function transport(req) {
    if (req.headers.Authorization !== 'Bearer ' + KEY) {
      return { code: 401, headers: { 'content-type': 'application/json' }, text: '{"detail":"Unauthorized"}' };
    }
    if (req.method === 'post') {
      posts.push(req);
      const key = req.headers['Idempotency-Key'];
      if (byKey.has(key)) {
        const known = byKey.get(key);
        if (known.payload !== req.payload) return { code: 422, headers: {}, text: '{"code":"idempotency_body_mismatch"}' };
        return receipt(known.id);
      }
      const id = 'r' + String(++next).padStart(7, '0');
      byKey.set(key, { id, payload: req.payload });
      reviews.set(id, { polls: 0 });
      return receipt(id);
    }
    const id = req.url.split('/reviews/')[1];
    const r = reviews.get(id);
    if (!r) return { code: 404, headers: {}, text: '{"detail":"Review not found.","code":"not_found"}' };
    r.polls += 1;
    const done = r.polls >= (o.pollsToFinish || 2);
    const body = Object.assign({}, REVIEW_B, {
      review_id: id,
      status: done ? 'completed' : 'verifying',
      poll_after_seconds: done ? null : 15,
      credits: { charged: o.charge ? o.charge(id) : 36 },
    });
    return { code: 200, headers: {}, text: JSON.stringify(body) };
  }
  function receipt(id) {
    return {
      code: 202,
      headers: { location: '/api/v1/reviews/' + id, 'retry-after': '20' },
      text: JSON.stringify({ review_id: id, status: 'queued' }),
    };
  }
  return { transport, posts, reviews };
}

function run(server, extra) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lenz-smoke-'));
  const sleeps = [];
  const summary = smoke.runScenario(Object.assign({
    transport: server.transport, apiKey: KEY, text: TEXT, outDir, sleep: (s) => sleeps.push(s), log: () => {},
  }, extra || {}));
  return { summary, outDir, sleeps };
}

test('the scenario passes against a server that keeps the contract', () => {
  const server = fakeServer();
  const { summary } = run(server);
  const failed = summary.results.filter((r) => !r.ok);
  assert.deepEqual(failed, []);
  assert.equal(summary.passed, true);
  assert.equal(summary.reviewsStarted, 2);
  assert.equal(server.reviews.size, 2);
});

test('it waits the real Retry-After, then poll_after_seconds', () => {
  const { sleeps } = run(fakeServer({ pollsToFinish: 3 }));
  assert.deepEqual(sleeps, [20, 15, 15, 20, 15, 15]);
});

test('the lost reply and its replay are one review, one key, one body', () => {
  const server = fakeServer();
  run(server);
  const [first, replay, again] = server.posts;
  assert.equal(server.posts.length, 3);
  assert.equal(first.headers['Idempotency-Key'], replay.headers['Idempotency-Key']);
  assert.equal(first.payload, replay.payload);
  assert.notEqual(again.headers['Idempotency-Key'], first.headers['Idempotency-Key']);
});

test('nothing saved carries the key or an Authorization header', () => {
  const { outDir } = run(fakeServer());
  const files = fs.readdirSync(outDir);
  assert.ok(files.includes('summary.json'));
  assert.ok(files.length >= 8);
  files.forEach((f) => {
    const s = fs.readFileSync(path.join(outDir, f), 'utf8');
    assert.ok(!s.includes(KEY), f);
    assert.ok(!/authorization/i.test(s), f);
  });
});

test('a server that makes a second review for the replayed key fails the run', () => {
  const server = fakeServer();
  const real = server.transport;
  let count = 0;
  server.transport = (req) => {
    if (req.method === 'post' && ++count === 2) {
      return { code: 202, headers: { 'retry-after': '20' }, text: '{"review_id":"rdouble1","status":"queued"}' };
    }
    return real(req);
  };
  const { summary } = run(server);
  assert.equal(summary.passed, false);
  assert.ok(summary.results.find((r) => r.name === 'the replay returned the same review id' && !r.ok));
});

test('a charge on A above B fails the run', () => {
  const { summary } = run(fakeServer({ charge: (id) => (id === 'r0000001' ? 72 : 36) }));
  assert.equal(summary.passed, false);
});

test('a key that does not answer 404 on the probe stops before any paid call', () => {
  const server = fakeServer();
  const { summary } = run(server, { apiKey: 'lenz_' + 'x'.repeat(32) });
  assert.equal(summary.passed, false);
  assert.equal(server.posts.length, 0);
  assert.equal(summary.reviewsStarted, 0);
});

test('the bad-key call does not count against the budget', () => {
  const { summary } = run(fakeServer());
  assert.equal(summary.reviewsStarted, 2);
  assert.ok(summary.results.find((r) => r.name.startsWith('a bad key is 401') && r.ok));
});

test('readApiKey reads the line, strips quotes and export, and refuses a non-lenz value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lenz-env-'));
  const f = path.join(dir, '.env');
  fs.writeFileSync(f, 'OTHER=1\nexport LENZ_API_KEY="' + KEY + '"\n');
  assert.equal(smoke.readApiKey(f), KEY);
  fs.writeFileSync(f, 'LENZ_API_KEY=' + KEY + '\n');
  assert.equal(smoke.readApiKey(f), KEY);
  fs.writeFileSync(f, 'LENZ_API_KEY=sk-nope\n');
  assert.throws(() => smoke.readApiKey(f), (e) => !e.message.includes('sk-nope'));
  fs.writeFileSync(f, 'NOTHING=1\n');
  assert.throws(() => smoke.readApiKey(f), /not found/);
});

test('childFetch answers code 0 when nothing is listening', () => {
  const res = smoke.childFetch({ method: 'get', url: 'http://127.0.0.1:1/', headers: {} });
  assert.deepEqual(res, { code: 0, headers: {}, text: '' });
});

test('cpSlice counts code points', () => {
  assert.equal(smoke.cpSlice('a😀bc', 1, 3), '😀b');
});
