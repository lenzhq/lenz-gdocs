// The add-on reads the /review answer of the API version it names (2026-10-11) and no other.
// fixtures/api-shapes/canonical.<case>.json hold an answer ({status, body}); expected.<case>.json is
// what the add-on produced from it, frozen. It was written by the add-on code of commit
// b070a9ce7149299f3b7cc2120b6bcf590b9b2f52 (the last that also read the older shape), never by the
// code under test:
//   git worktree add --detach <dir> b070a9ce7149299f3b7cc2120b6bcf590b9b2f52
//   node test/helpers/api-shapes-oracle.js <dir>     (refuses a checkout at any other commit)
// The running cases (get_running_*) cover a review still in progress; `build` reads whether it is done
// from the answer's own `status`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const LenzView = require('../src/view.js');
const LenzApi = require('../src/api.js');

const DIR = path.join(__dirname, 'fixtures', 'api-shapes');
const read = (file) => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
const exists = (file) => fs.existsSync(path.join(DIR, file));
const CASES = fs.readdirSync(DIR)
  .filter((f) => f.startsWith('expected.'))
  .map((f) => f.slice('expected.'.length, -'.json'.length))
  .sort();

// What the oracle recorded for one answer, produced by the code under test.
const { produce: produceWith, ORACLE_COMMIT } = require('./helpers/api-shapes-oracle.js');
const produce = (name, r) => produceWith(LenzView, LenzApi, name, r);

// Serialized equality: what JSON keeps is exactly what the frozen oracle holds.
const same = (actual, expected) => assert.equal(JSON.stringify(actual, null, 2) + '\n', expected);

test('every case has a frozen expectation and an answer, and nothing else is in the folder', () => {
  assert.equal(ORACLE_COMMIT, 'b070a9ce7149299f3b7cc2120b6bcf590b9b2f52');
  assert.ok(CASES.length >= 17, CASES.join(','));
  assert.ok(CASES.filter((n) => n.startsWith('get_running_')).length >= 5);
  for (const name of CASES) assert.ok(exists('canonical.' + name + '.json'), name);
  const files = fs.readdirSync(DIR);
  assert.equal(files.length, CASES.length * 2, files.join(','));
});

for (const name of CASES) {
  const expected = fs.readFileSync(path.join(DIR, 'expected.' + name + '.json'), 'utf8');
  test('the answer gives what it gave before: ' + name, () => {
    same(produce(name, read('canonical.' + name + '.json')), expected);
  });
}

test('nothing checkable on a review (no_checkable_claim) gives the no-claim words', () => {
  const r = read('canonical.get_failed_no_claim.json');
  assert.equal(r.body.failure.code, 'no_checkable_claim');
  assert.match(LenzView.build(r.body).failure, /no factual claim/);
});

test('a quick check left unfinished shows its own hint, from its failure block', () => {
  const r = read('canonical.get_queued_row_failure_hint.json');
  const row = r.body.claims[1].assessment;
  assert.equal(row.status, 'queued');
  const e = LenzView.build(r.body).groups.flatMap((g) => g.entries).find((x) => x.id === 'claim:1');
  assert.equal(e.label, 'Not checked');
  assert.deepEqual(e.lines, [{ lead: null, text: 'This item was not processed in time; send it again.' }]);
});

test('a failed quick check (verdict null) is not checked, and never shows a hint', () => {
  const r = read('canonical.get_quick_check_error_verdict.json');
  const row = r.body.claims.find((c) => c.index === 1).assessment;
  assert.equal(row.verdict, null);
  assert.equal(row.status, 'failed');
  const e = LenzView.build(r.body).groups.flatMap((g) => g.entries).find((x) => x.id === 'claim:1');
  assert.equal(e.label, 'Not checked');
  assert.deepEqual(e.lines, [{ lead: null, text: 'Could not be checked this time. Nothing was charged for it.' }]);
});

test('a deep check stopped by a search outage is named so', () => {
  const r = read('canonical.get_deep_research_unavailable.json');
  const e = LenzView.build(r.body).groups.flatMap((g) => g.entries).find((x) => x.id === 'claim:2');
  assert.ok(e.lines.some((l) => /search was unavailable/.test(l.text)));
});

test('the wait on a 429 is the Retry-After header, then the body retry_after', () => {
  const d = (code, body) => LenzApi.describeError(code, {}, JSON.stringify(body)).retryAfterS;
  assert.equal(d(429, { code: 'review_in_flight', retry_after: 41 }), 41);
  assert.equal(d(429, { code: 'extract_daily_limit', retry_after: 43 }), 43);
  // Without one: the in-flight default, and no wait for the daily link limit.
  assert.equal(d(429, { code: 'review_in_flight' }), 60);
  assert.equal(d(429, { code: 'extract_daily_limit' }), null);
  // The header comes first.
  assert.equal(LenzApi.describeError(429, { 'Retry-After': '7' }, JSON.stringify({ code: 'review_in_flight', retry_after: 41 })).retryAfterS, 7);
});
