// The add-on reads the /review answer of the API version it names (2026-10-11) and no other.
// fixtures/api-shapes/canonical.<case>.json hold an answer ({status, body}); expected.<case>.json is
// what the add-on produces from it. A change to what the sidebar shows updates the expected file in
// the same change, on purpose. The running cases (get_running_*) cover a review still in progress;
// `build` reads whether it is done from the answer's own `status`.
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

// What the add-on produces for one answer.
function produce(name, r) {
  if (name.startsWith('get_')) return { build: LenzView.build(r.body) };
  return { describeError: LenzApi.describeError(r.status, {}, JSON.stringify(r.body)) };
}

// Serialized equality: what JSON keeps is exactly what the expected file holds.
const same = (actual, expected) => assert.equal(JSON.stringify(actual, null, 2) + '\n', expected);

test('every case has a frozen expectation and an answer, and nothing else is in the folder', () => {
  assert.ok(CASES.length >= 17, CASES.join(','));
  assert.ok(CASES.filter((n) => n.startsWith('get_running_')).length >= 5);
  for (const name of CASES) assert.ok(exists('canonical.' + name + '.json'), name);
  const files = fs.readdirSync(DIR);
  assert.equal(files.length, CASES.length * 2, files.join(','));
});

for (const name of CASES) {
  const expected = fs.readFileSync(path.join(DIR, 'expected.' + name + '.json'), 'utf8');
  test('the answer gives what the sidebar shows: ' + name, () => {
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

test('a deep check stopped by an outage says a service was unavailable', () => {
  const r = read('canonical.get_deep_research_unavailable.json');
  const e = LenzView.build(r.body).groups.flatMap((g) => g.entries).find((x) => x.id === 'claim:2');
  assert.ok(e.lines.some((l) => /a service Lenz relies on was unavailable/.test(l.text)));
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

test('the current answer names searched_pages on every quick check; an empty list changes nothing, a list shows', () => {
  const r = read('canonical.get_completed_issues_full.json');
  const claims = r.body.claims;
  assert.ok(claims.length > 0);
  for (const c of claims) assert.deepEqual(c.assessment.searched_pages, []);
  // A quick-checked row (its deep check is not a completed one) shows its pages; a completed deep check does not.
  const quick = claims.find((c) => !c.verification || c.verification.status !== 'completed');
  assert.ok(quick);
  const withPages = JSON.parse(JSON.stringify(r.body));
  for (const c of withPages.claims) c.assessment.searched_pages = [{ title: 'A page', url: 'https://example.org/a' }];
  const entries = LenzView.build(withPages).groups.flatMap((g) => g.entries);
  const e = entries.find((x) => x.id === 'claim:' + quick.index);
  assert.deepEqual(e.pages, { count: 1, first: [{ title: 'A page', url: 'https://example.org/a' }], rest: [] });
  const deep = claims.find((c) => c.verification && c.verification.status === 'completed');
  assert.ok(!('pages' in entries.find((x) => x.id === 'claim:' + deep.index)));
});
