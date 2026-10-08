// Lenz answers /review in two shapes. Of the fields this add-on reads, these differ:
//   - what failed: `failure.code` (current) or `failure.failure_reason` (older), on the review and on a
//     claim's deep check; "nothing checkable" is `no_checkable_claim` (current) where the older answer
//     said `no_claim` on a review and `not_a_claim` on a deep check;
//   - a quick check with no verdict: `verdict` null (current) or "Error" (older);
//   - the wait on a 429: `retry_after` (current) or `retry_after_seconds` / `reset_in_seconds` (older).
// fixtures/api-shapes/<shape>.<case>.json hold the same answer in each shape ({status, body}).
// expected.<case>.json is what the add-on produced from the older answer BEFORE it read the current
// shape, frozen. Both shapes must still produce exactly that. It was written by the add-on code of
// commit cea222bcc01170a5abfec085584bd62d6897f957, never by the code under test:
//   git worktree add --detach <dir> cea222bcc01170a5abfec085584bd62d6897f957
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

test('every case has a frozen expectation and a legacy answer', () => {
  assert.equal(ORACLE_COMMIT, 'cea222bcc01170a5abfec085584bd62d6897f957');
  assert.ok(CASES.length >= 18, CASES.join(','));
  assert.ok(CASES.filter((n) => n.startsWith('get_running_')).length >= 5);
  for (const name of CASES) assert.ok(exists('legacy.' + name + '.json'), name);
});

for (const name of CASES) {
  const expected = fs.readFileSync(path.join(DIR, 'expected.' + name + '.json'), 'utf8');
  test('older answer gives what it gave before: ' + name, () => {
    same(produce(name, read('legacy.' + name + '.json')), expected);
  });
  if (exists('canonical.' + name + '.json')) {
    test('current answer gives what the older one gave: ' + name, () => {
      same(produce(name, read('canonical.' + name + '.json')), expected);
    });
  }
}

test('nothing checkable on a review: the current word reads as the older review word', () => {
  const canonical = read('canonical.get_failed_no_claim.json');
  assert.equal(canonical.body.failure.code, 'no_checkable_claim');
  assert.match(LenzView.build(canonical.body).failure, /no factual claim/);
  // The older answer's `not_a_claim` on a review was never the no-claim words; it still is not.
  const older = read('legacy.get_failed_not_a_claim.json');
  assert.match(LenzView.build(older.body).failure, /on our side/);
});

test('a quick check left unfinished shows its own hint in both shapes, from the row or its failure block', () => {
  for (const shape of ['legacy', 'canonical']) {
    const r = read(shape + '.get_queued_row_failure_hint.json');
    const row = r.body.claims[1].assessment;
    assert.equal(row.status, 'queued');
    const e = LenzView.build(r.body).groups.flatMap((g) => g.entries).find((x) => x.id === 'claim:1');
    assert.equal(e.label, 'Not checked', shape);
    assert.deepEqual(e.lines, [{ lead: null, text: 'This item was not processed in time; send it again.' }], shape);
  }
});

test('a failed quick check reads the same with verdict "Error" or null, and never shows a hint', () => {
  const legacy = read('legacy.get_quick_check_error_verdict.json');
  assert.equal(legacy.body.claims[1].assessment.verdict, 'Error');
  for (const shape of ['legacy', 'canonical']) {
    const r = read(shape + '.get_quick_check_error_verdict.json');
    const e = LenzView.build(r.body).groups.flatMap((g) => g.entries).find((x) => x.id === 'claim:1');
    assert.equal(e.label, 'Not checked', shape);
    assert.deepEqual(e.lines, [{ lead: null, text: 'Could not be checked this time. Nothing was charged for it.' }], shape);
  }
});

test('a deep check stopped by a search outage is named so in both shapes', () => {
  for (const shape of ['legacy', 'canonical']) {
    const r = read(shape + '.get_deep_research_unavailable.json');
    const e = LenzView.build(r.body).groups.flatMap((g) => g.entries).find((x) => x.id === 'claim:2');
    assert.ok(e.lines.some((l) => /search was unavailable/.test(l.text)), shape);
  }
});

test('the body wait is read under every name when no Retry-After header came', () => {
  const d = (code, body) => LenzApi.describeError(code, {}, JSON.stringify(body)).retryAfterS;
  assert.equal(d(429, { code: 'review_in_flight', retry_after: 41 }), 41);
  assert.equal(d(429, { code: 'review_in_flight', retry_after_seconds: 42 }), 42);
  assert.equal(d(429, { code: 'extract_daily_limit', retry_after: 43 }), 43);
  assert.equal(d(429, { code: 'extract_daily_limit', reset_in_seconds: 44 }), 44);
  // The header still comes first.
  assert.equal(LenzApi.describeError(429, { 'Retry-After': '7' }, JSON.stringify({ code: 'review_in_flight', retry_after: 41 })).retryAfterS, 7);
});
