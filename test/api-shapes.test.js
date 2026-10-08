// Lenz answers /review in two shapes: the older one (failure_reason, retry_after_seconds,
// reset_in_seconds, identified_claims, *_limit_reached) and the current one (failure.code with
// failure.detail, retry_after everywhere, more_claims on rows, *_limit_exceeded). The add-on reads
// both, so the same Doc and the same answer give the same sidebar whichever shape arrives.
// fixtures/api-shapes/<shape>.<case>.json hold the same answer in each shape ({status, body}).
const test = require('node:test');
const assert = require('node:assert/strict');
const LenzView = require('../src/view.js');
const LenzApi = require('../src/api.js');

const SHAPES = ['legacy', 'canonical'];
const load = (shape, name) => JSON.parse(JSON.stringify(require('./fixtures/api-shapes/' + shape + '.' + name + '.json')));
const both = (name) => SHAPES.map((s) => load(s, name));

const REVIEWS = [
  'get_failed_no_claim',
  'get_failed_every_assessment_failed',
  'get_completed_issues_full',
  'get_citations_limit_reached',
  'get_more_claims',
];

for (const name of REVIEWS) {
  test('both shapes: ' + name + ' builds the same sidebar', () => {
    const [legacy, canonical] = both(name);
    const opts = { done: true };
    assert.deepEqual(LenzView.build(canonical.body, opts), LenzView.build(legacy.body, opts));
  });
}

test('both shapes: nothing checkable reads as no claim, whichever word the failure uses', () => {
  const [legacy, canonical] = both('get_failed_no_claim');
  assert.equal(legacy.body.failure.failure_reason, 'no_claim');
  assert.equal(canonical.body.failure.code, 'no_checkable_claim');
  const words = LenzView.build(legacy.body).failure;
  assert.match(words, /no factual claim/);
  assert.equal(LenzView.build(canonical.body).failure, words);
  // The other spelling of the same idea, and a body carrying both names (the code wins).
  const other = load('canonical', 'get_failed_no_claim');
  other.body.failure = { code: 'not_a_claim', failure_class: 'invalid_input', retryable: false };
  assert.equal(LenzView.build(other.body).failure, words);
  other.body.failure = { code: 'no_checkable_claim', failure_reason: 'something_else', failure_class: 'invalid_input' };
  assert.equal(LenzView.build(other.body).failure, words);
});

test('both shapes: every quick check failing says it could not check just now', () => {
  const [legacy, canonical] = both('get_failed_every_assessment_failed');
  assert.equal(canonical.body.failure.code, 'assessment_failed');
  assert.match(LenzView.build(legacy.body).failure, /could not check this tab just now/);
  assert.equal(LenzView.build(canonical.body).failure, LenzView.build(legacy.body).failure);
});

test('both shapes: a failed quick check row (verdict null, status failed) is not checked and not charged', () => {
  for (const r of both('get_completed_issues_full')) {
    const m = LenzView.build(r.body, { done: true });
    const e = m.groups.flatMap((g) => g.entries).find((x) => x.id === 'claim:1');
    assert.equal(e.state, 'none');
    assert.equal(e.label, 'Not checked');
    assert.ok(e.lines.some((l) => /Nothing was charged/.test(l.text)));
  }
  // The older shape's "Error" verdict on the same row reads the same as null.
  const [, canonical] = both('get_completed_issues_full');
  const withError = load('canonical', 'get_completed_issues_full');
  withError.body.claims[1].result = Object.assign({}, withError.body.claims[1].result || {}, { verdict: 'Error' });
  assert.deepEqual(LenzView.build(withError.body, { done: true }), LenzView.build(canonical.body, { done: true }));
});

test('both shapes: a deep check that found no sources reads its code from failure.code or failure_reason', () => {
  for (const r of both('get_completed_issues_full')) {
    const row = r.body.claims[2];
    row.verification.failure.failure_class = 'upstream_unavailable';
    const m = LenzView.build(r.body, { done: true });
    const e = m.groups.flatMap((g) => g.entries).find((x) => x.id === 'claim:2');
    assert.ok(e.lines.some((l) => /search was unavailable/.test(l.text)), JSON.stringify(e.lines));
  }
});

test('both shapes: unchecked claims and citations beyond the limit are counted the same', () => {
  for (const name of ['get_more_claims', 'get_citations_limit_reached']) {
    const [legacy, canonical] = both(name);
    const a = LenzView.build(legacy.body, { done: true }).coverage;
    assert.ok(a.length > 0, name);
    assert.deepEqual(LenzView.build(canonical.body, { done: true }).coverage, a);
  }
});

const ERRORS = [
  ['429_review_in_flight', 60],
  ['429_extract_daily_limit', 60],
  ['503_capacity', null],
  ['402_no_credits', null],
];

for (const [name, wait] of ERRORS) {
  test('both shapes: ' + name + ' gives the same error and wait', () => {
    const [legacy, canonical] = both(name).map((r) => LenzApi.describeError(r.status, {}, JSON.stringify(r.body)));
    assert.deepEqual(canonical, legacy);
    if (wait !== null) assert.equal(canonical.retryAfterS, wait);
  });
}

test('both shapes: the body wait is read under every name when no Retry-After header came', () => {
  const d = (code, body) => LenzApi.describeError(code, {}, JSON.stringify(body)).retryAfterS;
  assert.equal(d(429, { code: 'review_in_flight', retry_after: 41 }), 41);
  assert.equal(d(429, { code: 'review_in_flight', retry_after_seconds: 42 }), 42);
  assert.equal(d(429, { code: 'extract_daily_limit', retry_after: 43 }), 43);
  assert.equal(d(429, { code: 'extract_daily_limit', reset_in_seconds: 44 }), 44);
  assert.equal(d(503, { code: 'capacity', retry_after: 45 }), 45);
  // The header still comes first.
  assert.equal(LenzApi.describeError(429, { 'Retry-After': '7' }, JSON.stringify({ code: 'review_in_flight', retry_after: 41 })).retryAfterS, 7);
});
