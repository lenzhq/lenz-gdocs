const test = require('node:test');
const assert = require('node:assert/strict');
const LenzView = require('../src/view.js');

const REVIEW = require('./fixtures/reviews/draft-a.review.json');
const POLLS = require('./fixtures/reviews/draft-a.polls.json');
// Deep checks that failed, as the API sends them: three that found too few public sources (rows 0 and 1
// in issues[], row 3 in failures[]), and one too-few-sources failure beside one where search was down.
const THIN = require('./fixtures/reviews/deep-failed-thin.review.json');
const MIXED = require('./fixtures/reviews/deep-failed-mixed.review.json');
// Review-level failures as the API sends them (failure_reason, failure_class and the integrator's hint),
// a review with one failed quick check, and a deep check that failed on Lenz's side.
const F = (name) => require('./fixtures/reviews/' + name + '.review.json');
const NO_CLAIM = F('failed-no-claim');
const NO_CREDITS = F('failed-insufficient-credits');
const UNAVAILABLE = F('failed-unavailable');
const ASSESSMENT_FAILED = F('failed-assessment');
const INTERNAL = F('failed-internal');
const QUICK_FAILED = F('quick-check-failed');
const DEEP_INTERNAL = F('deep-failed-internal');

function review(edit) {
  const body = JSON.parse(JSON.stringify(REVIEW));
  if (edit) edit(body);
  return body;
}
function ids(model, key) {
  const g = model.groups.find((x) => x.key === key);
  return g ? g.entries.map((e) => e.id) : [];
}
function entry(model, id) {
  for (const g of model.groups) for (const e of g.entries) if (e.id === id) return e;
  return null;
}
function citation(body, index) {
  return body.citations.find((c) => c.index === index);
}

test('draft-a: issues first, in the order of the Doc', () => {
  const m = LenzView.build(review());
  assert.deepEqual(m.groups.map((g) => g.key), ['issue', 'look', 'none', 'ok']);
  // Eiffel (34), Great Wall (242), Aldrin (522); not the order of issues[].
  assert.deepEqual(ids(m, 'issue'), ['claim:2', 'claim:0', 'claim:1']);
  assert.equal(m.headline, '3 issues to look at.');
  assert.equal(m.done, true);
  assert.equal(m.progress, null);
  assert.equal(m.charged, 'Charged 35 credits.');
});

test('draft-a: a deep check shows its score, rewrite and the Lenz page', () => {
  const e = entry(LenzView.build(review()), 'claim:1');
  assert.equal(e.label, 'False');
  assert.equal(e.token, 'false');
  assert.equal(e.state, 'bad');
  assert.equal(e.stateWords, "Doesn't check out");
  assert.equal(e.check, 'Deep check');
  assert.equal(e.score, 1);
  assert.equal(e.confidence, null);
  assert.equal(e.rewrite, 'Neil Armstrong was the first person to walk on the Moon in July 1969.');
  assert.deepEqual(e.link, { href: 'https://lenz.io/c/buzz-aldrin-first-moonwalk-july-1969-882428a4', words: 'See sources in Lenz' });
  const fp = LenzView.editFp(563, 574, 'Buzz Aldrin', 'Neil Armstrong');
  assert.deepEqual(e.edits, [
    { id: '1:' + fp, claimIndex: 1, editIndex: 0, fp, from: 'Buzz Aldrin', to: 'Neil Armstrong',
      mode: 'apply', applied: false, undo: null },
  ]);
  assert.equal(e.occurrences, 1);
});

test('draft-a: the unreadable citation is Not checked, the undecided one Needs a closer look', () => {
  const m = LenzView.build(review());
  assert.deepEqual(ids(m, 'look'), ['citation:1']);
  assert.deepEqual(ids(m, 'none'), ['citation:0']);
  const nasa = entry(m, 'citation:0');
  assert.equal(nasa.label, 'Not checked');
  assert.equal(nasa.lines[0].text, 'The link gave no text that could be read. Open it and check the passage by hand.');
  assert.deepEqual(nasa.source, { href: 'https://www.nasa.gov/image-article/great-wall-of-china/', words: 'nasa.gov' });
  assert.equal(entry(m, 'citation:1').stateWords, 'Needs a closer look');
});

test('draft-a: rows with no issue are collapsed behind their count', () => {
  const m = LenzView.build(review());
  const ok = m.groups.find((g) => g.key === 'ok');
  assert.equal(ok.collapsed, true);
  assert.equal(ok.count, 2);
  assert.equal(ok.title, 'Checks out');
  assert.deepEqual(ids(m, 'ok'), ['claim:4', 'claim:3']);
  assert.ok(m.groups.filter((g) => g.key !== 'ok').every((g) => !g.collapsed));
});

test('draft-a: coverage says the two citations could not be checked', () => {
  const m = LenzView.build(review());
  assert.deepEqual(m.coverage, ['2 citations could not be checked: the reason is under each one.']);
});

test('a citation issue sits among the claims, in the order of the Doc', () => {
  const body = review((b) => {
    const c = citation(b, 0);
    c.result = { finding: 'contradicted', source: 'support', is_issue: true };
    c.check.unchecked_reason = null;
    c.check.rationale = 'The page says the opposite.';
    c.check.snippet = 'not visible from the Moon';
    b.summary.citation_checks = { checked: 1, unchecked: 1, failed: 0 };
  });
  const m = LenzView.build(body);
  assert.deepEqual(ids(m, 'issue'), ['claim:2', 'claim:0', 'citation:0', 'claim:1']);
  const e = entry(m, 'citation:0');
  assert.equal(e.label, 'Contradicted');
  assert.equal(e.check, 'Citation check');
  assert.deepEqual(e.lines, [
    { lead: 'The source says: ', text: 'not visible from the Moon' },
    { lead: "Reviewer's note: ", text: 'The page says the opposite.' },
  ]);
  assert.equal(m.headline, '4 issues to look at.');
});

test('partly supported is Needs a closer look, not an issue', () => {
  const m = LenzView.build(
    review((b) => {
      const c = citation(b, 1);
      c.result = { finding: 'partly_supported', source: 'support', is_issue: false };
      c.check.snippet = 'boils at 100 °C at sea level';
    })
  );
  const e = entry(m, 'citation:1');
  assert.equal(e.group, 'look');
  assert.equal(e.label, 'Needs a closer look');
  assert.equal(e.token, 'mostly-true');
  assert.deepEqual(e.lines, [{ lead: 'The source says: ', text: 'boils at 100 °C at sea level' }]);
});

test('quote not in the source and page not found carry their fixed lines', () => {
  const m = LenzView.build(
    review((b) => {
      citation(b, 0).result = { finding: 'page_not_found', source: null, is_issue: true };
      const c = citation(b, 1);
      c.result = { finding: 'quote_not_in_source', source: null, is_issue: true };
      c.check.missing_quote = '100 degrees';
    })
  );
  assert.equal(entry(m, 'citation:0').lines[0].text, 'The link returned page not found.');
  assert.deepEqual(entry(m, 'citation:1').lines[0], {
    lead: 'These quoted words were not found in the source: ',
    text: '100 degrees',
  });
});

test('a quick check shows confidence, the reviewers\' note, never a dissent', () => {
  const m = LenzView.build(
    review((b) => {
      const r = b.claims.find((c) => c.index === 4);
      r.result = { verdict: 'Mixed', confidence: 'medium', source: 'assessment', is_issue: true };
      r.assessment.dissent = 'One reviewer read it as true.';
    })
  );
  const e = entry(m, 'claim:4');
  assert.equal(e.group, 'issue');
  assert.equal(e.state, 'look');
  assert.equal(e.check, 'Quick check');
  assert.equal(e.confidence, 'medium');
  assert.equal(e.score, null);
  assert.equal(e.link, null);
  assert.equal(e.lines[0].lead, "Reviewers' note: ");
  // The API deprecated `dissent` (always null now); a stray value is never shown.
  assert.equal(e.lines.length, 1);
  assert.ok(!e.lines.some((l) => /disagreed|One reviewer read it as true/.test(`${l.lead || ''}${l.text}`)));
  assert.equal(m.footnote, 'A quick verdict is a first read. A deep check shows the sources and can change it.');
});

test('no footnote when every quick verdict shown is collapsed', () => {
  assert.equal(LenzView.build(review()).footnote, null);
});

test('a low-confidence True is drawn Needs a closer look (the Workbench rule)', () => {
  const m = LenzView.build(
    review((b) => {
      b.claims.find((c) => c.index === 3).result.confidence = 'low';
    })
  );
  assert.equal(entry(m, 'claim:3').group, 'look');
  assert.deepEqual(ids(m, 'ok'), ['claim:4']);
});

test('coverage: caps, more_claims, more_citations, failures, skipped, truncated, incomplete', () => {
  const m = LenzView.build(
    review((b) => {
      b.outcome = 'incomplete';
      b.summary.input_truncated = true;
      b.summary.claim_limit_reached = true;
      b.more_claims = ['A.', 'B.', 'C.'];
      b.more_citations = [{ index: 2 }];
      b.summary.assessments.failed = 1;
      b.summary.verifications.failed = 2;
      b.summary.citation_checks = { checked: 0, unchecked: 1, failed: 1 };
      b.summary.citations_skipped = 'insufficient_credits';
    }),
    { notRead: { footnotes: 2, headers: 1, footers: 0, images: 0, equations: 0, otherChips: 3, otherTabs: 1 } }
  );
  assert.deepEqual(m.coverage, [
    'Only the first part of this tab was checked: it is longer than Lenz reads in one check.',
    '3 more claims were found and not checked (the limit is 20 per check).',
    '1 more citation was found and not checked (the limit is 20 per check).',
    '1 claim could not be checked this time.',
    '2 deep checks did not finish; those claims show their quick verdict.',
    '1 citation could not be checked: the reason is under each one.',
    '1 citation check failed this time.',
    'Citations were not checked: not enough credits.',
    'Not read: 2 footnotes, 1 header, 3 smart chips, 1 other tab.',
    'Choose Check this Doc to check it again; the new check is charged.',
  ]);
  assert.equal(m.headline, '3 issues to look at.');
});

test('the serializer\'s own cut also says only the first part was checked', () => {
  const m = LenzView.build(review(), { truncated: true });
  assert.equal(m.coverage[0], 'Only the first part of this tab was checked: it is longer than Lenz reads in one check.');
});

test('a clean review says so only when nothing was left out', () => {
  const clean = review((b) => {
    b.outcome = 'clean';
    b.claims = b.claims.filter((c) => !c.result.is_issue);
    b.citations = [];
    b.summary.citation_checks = { checked: 0, unchecked: 0, failed: 0 };
  });
  assert.equal(LenzView.build(clean).headline, 'No issues found.');
  clean.more_claims = ['X.'];
  assert.equal(LenzView.build(clean).headline, 'No issues among what was checked.');
});

test('findings that could not be placed are marked and counted', () => {
  const m = LenzView.build(
    review((b) => {
      b.claims.find((c) => c.index === 0).positions = [];
    }),
    { unplaced: { 'claim:2': 'changed' } }
  );
  assert.equal(entry(m, 'claim:0').placed, false);
  assert.equal(entry(m, 'claim:2').placed, false);
  assert.equal(entry(m, 'claim:2').placeNote, 'The words changed since the check.');
  assert.ok(m.coverage.includes('2 findings are not in the Doc as it is now, so they cannot be selected.'));
});

test('applied edits are marked', () => {
  const e = entry(LenzView.build(review(), { applied: { '1:0': true } }), 'claim:1');
  assert.equal(e.edits[0].applied, true);
});

test('pending suggested edits say they are coming', () => {
  const e = entry(
    LenzView.build(
      review((b) => {
        b.status = 'verifying'; // a completed review has no pending edits (it completes once they settle)
        b.claims.find((c) => c.index === 1).suggested_edits = { status: 'pending', edits: null };
      })
    ),
    'claim:1'
  );
  assert.deepEqual(e.edits, []);
  assert.equal(e.editsNote, null); // no line while edits are worked out (v23)
});

test('entry ids are stable across polls and builds', () => {
  const running = LenzView.build(POLLS[0]);
  const done = LenzView.build(POLLS[POLLS.length - 1]);
  const all = (m) => m.groups.flatMap((g) => g.entries.map((e) => e.id)).sort();
  assert.deepEqual(all(running), all(done));
  assert.deepEqual(all(done), all(LenzView.build(POLLS[POLLS.length - 1])));
  assert.deepEqual(all(done), ['citation:0', 'citation:1', 'claim:0', 'claim:1', 'claim:2', 'claim:3', 'claim:4']);
});

test('while running: progress, no headline, citations checking', () => {
  const m = LenzView.build(POLLS[0]);
  assert.equal(m.done, false);
  assert.equal(m.headline, null);
  assert.equal(m.progress, 'Running 3 deep checks (0 done)');
  assert.equal(entry(m, 'claim:1').check, 'Quick check');
  assert.equal(entry(m, 'citation:0').lines[0].text, 'Checking.');
});


test('only lenz.io claim pages become links; sources only over http(s)', () => {
  const m = LenzView.build(
    review((b) => {
      b.claims.find((c) => c.index === 1).verification.url = 'javascript:alert(1)';
      citation(b, 0).cited_url = 'javascript:alert(1)';
    })
  );
  assert.equal(entry(m, 'claim:1').link, null);
  assert.equal(entry(m, 'citation:0').source, null);
});

test('the compact view (issues only) still lists the issues', () => {
  const m = LenzView.build(
    review((b) => {
      delete b.claims;
      delete b.citations;
    })
  );
  assert.deepEqual(ids(m, 'issue').sort(), ['claim:0', 'claim:1', 'claim:2']);
});

test('row(): an entry id finds its row again; anything else is null', () => {
  const b = review();
  assert.equal(LenzView.row(b, 'claim:1').row.claim, 'Buzz Aldrin was the first person to walk on the Moon in July 1969.');
  assert.equal(LenzView.row(b, 'claim:1').kind, 'claim');
  assert.equal(LenzView.row(b, 'citation:1').row.reference, 'Britannica explains');
  assert.equal(LenzView.row(b, 'claim:9'), null);
  assert.equal(LenzView.row(b, 'claim:1; drop'), null);
  assert.equal(LenzView.row(b, 'claims:1'), null);
  assert.equal(LenzView.row(null, 'claim:1'), null);
});

test('rows(): every claim and citation row, by id', () => {
  assert.deepEqual(
    LenzView.rows(review()).map((t) => t.id),
    ['claim:0', 'claim:1', 'claim:2', 'claim:3', 'claim:4', 'citation:0', 'citation:1']
  );
});

test('the fixture passages sit at their offsets in the text sent (cp)', () => {
  const fs = require('node:fs');
  const text = fs.readFileSync(require.resolve('./fixtures/reviews/draft-a.txt'), 'utf8');
  const cps = Array.from(text);
  for (const row of REVIEW.claims) {
    for (const p of row.positions) assert.equal(cps.slice(p.start, p.end).join(''), p.text);
  }
});

test('"Checks out" is expanded when nothing is an issue or needs a closer look', () => {
  const clean = review((b) => {
    b.claims = b.claims.filter((c) => !c.result.is_issue);
    b.citations = [];
    b.outcome = 'clean';
  });
  const m = LenzView.build(clean);
  assert.deepEqual(m.groups.map((g) => [g.key, g.collapsed]), [['ok', false]]);
  // A citation only needing a closer look folds it again.
  const look = review((b) => {
    b.claims = b.claims.filter((c) => !c.result.is_issue);
    b.citations = b.citations.filter((c) => c.index === 1); // inconclusive: "Needs a closer look"
  });
  assert.equal(LenzView.build(look).groups.find((g) => g.key === 'ok').collapsed, true);
  // Only "Not checked" beside it: still expanded (nothing to look at first).
  const none = review((b) => {
    b.claims = b.claims.filter((c) => !c.result.is_issue);
    b.citations = b.citations.filter((c) => c.index === 0); // no text: "Not checked"
  });
  assert.equal(LenzView.build(none).groups.find((g) => g.key === 'ok').collapsed, false);
});

// ── per-stage progress while running ────────────────────────────────

test('stages: the running snapshots of draft-a, stage by stage', () => {
  const at = (i) => LenzView.build(POLLS[i]).stages;
  assert.deepEqual(at(0), [
    { key: 'quick', label: 'Quick checks', done: 5, total: 5, complete: true },
    { key: 'deep', label: 'Deep checks', done: 0, total: 3, complete: false },
    { key: 'citations', label: 'Citation checks', done: 0, total: 2, complete: false },
  ]);
  assert.deepEqual(at(1)[2], { key: 'citations', label: 'Citation checks', done: 2, total: 2, complete: true });
  assert.deepEqual(at(4)[1], { key: 'deep', label: 'Deep checks', done: 2, total: 3, complete: false });
  assert.equal(LenzView.build(POLLS[POLLS.length - 1]).stages, null);
});

test('stages: only the stages that apply; failures count as done; before the claims are read', () => {
  const b = JSON.parse(JSON.stringify(POLLS[0]));
  b.summary.verifications = { planned: 0, completed: 0, failed: 0 };
  b.summary.citations_selected = 0;
  b.summary.assessments = { completed: 3, failed: 1 };
  assert.deepEqual(LenzView.build(b).stages, [{ key: 'quick', label: 'Quick checks', done: 4, total: 5, complete: false }]);
  b.summary.verifications = null; // not planned yet
  b.summary.citations_selected = null; // citations not read yet
  assert.deepEqual(LenzView.build(b).stages.map((s) => s.key), ['quick']);
  const q = JSON.parse(JSON.stringify(POLLS[0]));
  q.status = 'queued';
  q.summary = { claims_selected: null, assessments: null, verifications: null, citations_selected: null, citation_checks: null };
  assert.deepEqual(LenzView.build(q).stages, [{ key: 'reading', label: 'Finding the claims', done: null, total: null, complete: false }]);
});

test('a quick verdict whose deep check is still running is marked as such', () => {
  const running = LenzView.build(POLLS[0]);
  const e = entry(running, 'claim:1'); // deep check processing
  assert.equal(e.check, 'Quick check');
  assert.equal(e.deepRunning, true);
  assert.equal(entry(running, 'claim:3').deepRunning, false); // no deep check planned
  const done = LenzView.build(REVIEW);
  assert.equal(entry(done, 'claim:1').check, 'Deep check');
  assert.equal(entry(done, 'claim:1').deepRunning, false);
  // A deep check that failed leaves the quick verdict, not running.
  const failed = review((b) => {
    const r = b.claims.find((c) => c.index === 1);
    r.result.source = 'assessment';
    r.verification.status = 'failed';
  });
  assert.equal(entry(LenzView.build(failed), 'claim:1').deepRunning, false);
});

// ── rows still being checked, and edits being worked out (as a real review showed them) ──

function running(edit) {
  const b = JSON.parse(JSON.stringify(POLLS[0]));
  if (edit) edit(b);
  return b;
}

test('a claim whose quick check is still pending or running says Checking, never "could not be checked"', () => {
  for (const status of ['pending', 'running']) {
    const m = LenzView.build(running((b) => {
      const r = b.claims.find((c) => c.index === 3);
      r.assessment = { status, verdict: null, confidence: null, rationale: null, dissent: null, hint: null };
      r.result = null;
    }));
    const e = entry(m, 'claim:3');
    assert.equal(e.group, 'pending', status);
    assert.equal(e.label, 'Checking');
    assert.deepEqual(e.lines, [{ lead: null, text: 'Checking.' }]);
    assert.ok(!JSON.stringify(m).includes('Could not be checked this time.'), status);
    assert.equal(m.groups.find((g) => g.key === 'pending').title, 'Checking');
  }
});

test('a claim says "could not be checked" only when its check failed, or the review ended without it', () => {
  const failed = LenzView.build(running((b) => {
    const r = b.claims.find((c) => c.index === 3);
    r.assessment = { status: 'failed', hint: null };
    r.result = null;
  }));
  assert.equal(entry(failed, 'claim:3').lines[0].text, 'Could not be checked this time. Nothing was charged for it.');
  const ended = LenzView.build(review((b) => {
    const r = b.claims.find((c) => c.index === 3);
    r.assessment = { status: 'running', hint: null };
    r.result = null;
  }));
  assert.equal(entry(ended, 'claim:3').lines[0].text, 'Could not be checked this time.');
  assert.equal(entry(ended, 'claim:3').group, 'none');
});

test('a citation still being checked (pending, running or no status yet) is in Checking, not Not checked', () => {
  for (const status of ['pending', 'running', null]) {
    const m = LenzView.build(running((b) => {
      const c = b.citations.find((x) => x.index === 0);
      c.result = null;
      c.check.status = status;
    }));
    const e = entry(m, 'citation:0');
    assert.equal(e.group, 'pending', String(status));
    assert.deepEqual(e.lines, [{ lead: null, text: 'Checking.' }]);
    // Its verdict label too: Checking, neutral (no verdict token), never "Not checked" before it ends.
    assert.equal(e.label, 'Checking', String(status));
    assert.equal(e.token, null);
  }
  const ended = LenzView.build(review((b) => {
    const c = b.citations.find((x) => x.index === 0);
    c.result = null;
    c.check.status = 'running';
  }));
  assert.equal(entry(ended, 'citation:0').lines[0].text, 'Could not be checked this time.');
  assert.equal(entry(ended, 'citation:0').label, 'Not checked', 'a check the finished review left unchecked');
});

test('no line while edits are worked out; the verdict says the deep check is running', () => {
  const m = LenzView.build(POLLS[0]); // deep checks processing, edits not settled
  const e = entry(m, 'claim:1');
  assert.equal(e.editsNote, null);
  assert.equal(e.deepRunning, true);
  assert.deepEqual(e.edits, []);
  const pend = LenzView.build(running((b) => {
    b.claims.find((c) => c.index === 3).suggested_edits = { status: 'pending', edits: null };
  }));
  assert.equal(entry(pend, 'claim:3').editsNote, null);
  assert.ok(!JSON.stringify(m).includes('Working out'));
});

test('once edits settle the line goes: an edit shows its Apply row, none shows nothing (claims 3 and 2 of that review)', () => {
  const m = LenzView.build(running((b) => {
    const yellow = b.claims.find((c) => c.index === 1);
    yellow.suggested_edits = { status: 'completed', edits: [{ position: 0, start: 330, end: 336, text: 'yellow', replacement: 'generally blue during the day' }] };
    const declined = b.claims.find((c) => c.index === 2);
    declined.suggested_edits = { status: 'completed', edits: [] };
  }));
  const y = entry(m, 'claim:1');
  assert.equal(y.editsNote, null);
  assert.deepEqual(y.edits.map((x) => [x.from, x.to]), [['yellow', 'generally blue during the day']]);
  const d = entry(m, 'claim:2');
  assert.equal(d.editsNote, null);
  assert.deepEqual(d.edits, []);
  // Settled on the completed review: nothing is being worked out.
  assert.ok(LenzView.build(REVIEW).groups.flatMap((g) => g.entries).every((x) => x.editsNote === null));
});

test('no edit line when the review did not ask for suggested edits', () => {
  const m = LenzView.build(running((b) => { b.policy.suggest_edits = false; }));
  assert.equal(entry(m, 'claim:1').editsNote, null);
});

// ── quick-first suggested edits: known by content (Lenz #1141: no source on the block) ───────

const ALDRIN_EDIT = { position: 0, start: 563, end: 574, text: 'Buzz Aldrin', replacement: 'Neil Armstrong' };
const JULY = (() => {
  const passage = 'The first person to walk on the Moon was Buzz Aldrin, in July 1969.';
  const at = 522 + passage.indexOf('July 1969');
  return { position: 0, start: at, end: at + 9, text: 'July 1969', replacement: '20 July 1969' };
})();
const fpOf = (e) => LenzView.editFp(e.start, e.end, e.text, e.replacement);
const APPLIED = { id: '1:' + fpOf(ALDRIN_EDIT), claimIndex: 1, orig: { start: 563, end: 574 },
  origText: 'Buzz Aldrin', replacement: 'Neil Armstrong', start: 563, end: 574, text: 'Buzz Aldrin' };

function withBlock(block, done) {
  const b = JSON.parse(JSON.stringify(done ? REVIEW : POLLS[0]));
  b.claims.find((c) => c.index === 1).suggested_edits = block;
  return b;
}

test('an edit is known by its content: fingerprint = span + a hash of words and replacement', () => {
  assert.equal(fpOf(ALDRIN_EDIT), fpOf(Object.assign({}, ALDRIN_EDIT)));
  assert.notEqual(fpOf(ALDRIN_EDIT), fpOf(Object.assign({}, ALDRIN_EDIT, { replacement: 'Neil A. Armstrong' })));
  assert.notEqual(fpOf(ALDRIN_EDIT), fpOf(Object.assign({}, ALDRIN_EDIT, { start: 562 })));
  assert.match(fpOf(ALDRIN_EDIT), /^563:574:[0-9a-z]+$/);
});

test('quick edits while the deep check runs: shown as edits, with no label naming the method', () => {
  const m = LenzView.build(withBlock({ status: 'completed', edits: [ALDRIN_EDIT] }));
  const e = entry(m, 'claim:1');
  assert.equal(e.deepRunning, true); // the verdict's mark says a deep check runs
  assert.deepEqual(e.edits.map((x) => [x.fp, x.mode]), [[fpOf(ALDRIN_EDIT), 'apply']]);
  assert.ok(!JSON.stringify(m).includes('quick check ·') && !JSON.stringify(m).includes('From the quick'));
});

test('a replacing block\'s identical edit reads applied; its Undo names the record by fingerprint', () => {
  const m = LenzView.build(withBlock({ status: 'completed', edits: [JULY, ALDRIN_EDIT] }, true), { appliedEdits: [APPLIED] });
  const e = entry(m, 'claim:1');
  assert.deepEqual(e.edits.map((x) => [x.editIndex, x.mode]), [[0, 'apply'], [1, 'applied']]); // index moved: still matched
  assert.deepEqual(e.edits[1].undo, { claimIndex: 1, editIndex: 1, fp: fpOf(ALDRIN_EDIT) });
});

test('a different edit on words an applied one changed: no Apply; the applied one stays with its Undo', () => {
  const other = Object.assign({}, ALDRIN_EDIT, { replacement: 'Neil A. Armstrong' });
  const m = LenzView.build(withBlock({ status: 'completed', edits: [other] }, true), { appliedEdits: [APPLIED] });
  const e = entry(m, 'claim:1');
  assert.deepEqual(e.edits.map((x) => [x.to, x.mode, !!x.earlier]), [
    ['Neil A. Armstrong', 'suggest', false],
    ['Neil Armstrong', 'applied', true],
  ]);
  assert.deepEqual(e.edits[1].undo, { claimIndex: 1, editIndex: -1, fp: fpOf(ALDRIN_EDIT) });
});

test('an edit elsewhere in the sentence stays applicable next to an applied one', () => {
  const m = LenzView.build(withBlock({ status: 'completed', edits: [JULY] }, true), { appliedEdits: [APPLIED] });
  assert.deepEqual(entry(m, 'claim:1').edits.map((x) => [x.to, x.mode]), [['20 July 1969', 'apply'], ['Neil Armstrong', 'applied']]);
});

test('the block withdrawn (null) or emptied ([]): an applied edit stays listed, with its Undo', () => {
  for (const block of [null, { status: 'completed', edits: [] }]) {
    const m = LenzView.build(withBlock(block, true), { appliedEdits: [APPLIED] });
    assert.deepEqual(entry(m, 'claim:1').edits.map((x) => [x.mode, !!x.earlier]), [['applied', true]]);
  }
});

test('an older add-on\'s record ("1:0") marks the edit at that index applied', () => {
  const m = LenzView.build(REVIEW, { appliedEdits: [{ id: '1:0', start: 563, end: 574, text: 'Buzz Aldrin', replacement: 'Neil Armstrong' }] });
  assert.deepEqual(entry(m, 'claim:1').edits.map((x) => x.mode), ['applied']);
  assert.deepEqual(entry(m, 'claim:1').edits[0].undo, { claimIndex: 1, editIndex: 0, fp: null });
});

test('two applied occurrences of the same correction both keep their Undo', () => {
  const second = { id: '1:x', claimIndex: 1, orig: { start: 600, end: 611 }, origText: 'Buzz Aldrin', replacement: 'Neil Armstrong' };
  const m = LenzView.build(withBlock({ status: 'completed', edits: [ALDRIN_EDIT] }, true), { appliedEdits: [APPLIED, second] });
  assert.deepEqual(entry(m, 'claim:1').edits.map((x) => [x.mode, !!x.earlier]), [['applied', false], ['applied', true]]);
});

// ── a deep check that failed says why, and offers a retry only when one can help ──

const TOO_FEW_ROW = 'The deep check found too few public sources to give a verdict, so this is the quick verdict.';
const UNAVAILABLE_ROW = 'The deep check could not run because search was unavailable, so this is the quick verdict.';
const PLAIN_ROW = 'The deep check did not finish, so this is the quick verdict.';
const OUR_SIDE_ROW = 'The deep check stopped on our side, so this is the quick verdict.';
const SERVICE_ROW = 'The deep check could not run because a service Lenz relies on was unavailable, so this is the quick verdict.';
const RETRY = 'Choose Check this Doc to check it again; the new check is charged.';

function rowLines(m, id) {
  return entry(m, id).lines.map((l) => l.text);
}

test('failed deep checks: each row says why, by the failure class', () => {
  const thin = LenzView.build(THIN);
  ['claim:0', 'claim:1', 'claim:3'].forEach((id) => {
    assert.ok(rowLines(thin, id).includes(TOO_FEW_ROW), id);
    assert.equal(entry(thin, id).check, 'Quick check');
    assert.equal(entry(thin, id).deepRunning, false);
  });
  const mixed = LenzView.build(MIXED);
  assert.ok(rowLines(mixed, 'claim:0').includes(TOO_FEW_ROW));
  assert.ok(rowLines(mixed, 'claim:1').includes(UNAVAILABLE_ROW));
});

test('failed deep checks: a failure with no class, an input problem or a stop keeps the plain line', () => {
  ['invalid_input', 'cancelled'].forEach((cls) => {
    const other = JSON.parse(JSON.stringify(MIXED));
    other.claims.find((c) => c.index === 1).verification.failure.failure_class = cls;
    assert.ok(rowLines(LenzView.build(other), 'claim:1').includes(PLAIN_ROW), cls);
  });
  const none = JSON.parse(JSON.stringify(MIXED));
  none.claims.find((c) => c.index === 1).verification.failure = null;
  assert.ok(rowLines(LenzView.build(none), 'claim:1').includes(PLAIN_ROW));
});

test('failed deep checks: an outage outside the search for sources does not name search', () => {
  const later = JSON.parse(JSON.stringify(MIXED));
  const row = later.claims.find((c) => c.verification && c.verification.failure && c.verification.failure.failure_class === 'upstream_unavailable');
  row.verification.failure.failure_reason = 'conclusion_failed';
  const lines = rowLines(LenzView.build(later), 'claim:' + row.index);
  assert.ok(lines.includes(SERVICE_ROW));
  assert.ok(!lines.includes(UNAVAILABLE_ROW));
});

test('failed deep checks: one that stopped on our side says so (the API sends class internal)', () => {
  const m = LenzView.build(DEEP_INTERNAL);
  assert.equal(DEEP_INTERNAL.claims.find((c) => c.index === 1).verification.failure.failure_class, 'internal');
  assert.ok(rowLines(m, 'claim:1').includes(OUR_SIDE_ROW));
  // A class this add-on does not know is not claimed as search or as an input problem.
  const odd = JSON.parse(JSON.stringify(MIXED));
  odd.claims.find((c) => c.index === 1).verification.failure.failure_class = 'something_new';
  assert.ok(rowLines(LenzView.build(odd), 'claim:1').includes(OUR_SIDE_ROW));
  // A class named like an Object property is just unknown too.
  odd.claims.find((c) => c.index === 1).verification.failure.failure_class = 'constructor';
  assert.ok(rowLines(LenzView.build(odd), 'claim:1').includes(OUR_SIDE_ROW));
});

test('failed deep checks: a stuck run (task_stuck, unavailable) names a service, not search', () => {
  const stuck = JSON.parse(JSON.stringify(MIXED));
  const f = stuck.claims.find((c) => c.index === 1).verification.failure;
  f.failure_reason = 'task_stuck';
  f.failure_class = 'upstream_unavailable';
  assert.ok(rowLines(LenzView.build(stuck), 'claim:1').includes(SERVICE_ROW));
});

test('failed deep checks: coverage counts the too-few-sources ones apart from the rest', () => {
  assert.deepEqual(LenzView.build(THIN).coverage.slice(0, 1), ['3 claims had too few public sources for a deep check; they show the quick verdict.']);
  assert.deepEqual(LenzView.build(MIXED).coverage.slice(0, 2), [
    '1 claim had too few public sources for a deep check; it shows the quick verdict.',
    '1 deep check did not finish; that claim shows its quick verdict.',
  ]);
  // Counts with no failure blocks behind them keep today's line.
  const bare = LenzView.build(review((b) => {
    b.summary.verifications.failed = 2;
  }));
  assert.ok(bare.coverage.includes('2 deep checks did not finish; those claims show their quick verdict.'));
});

test('failed deep checks: no retry advice when every one found too few sources, advice when any can be retried', () => {
  const thin = LenzView.build(THIN);
  assert.equal(THIN.outcome, 'incomplete');
  assert.ok(!thin.coverage.includes(RETRY));
  assert.equal(LenzView.retryHelps(THIN), false);
  const mixed = LenzView.build(MIXED);
  assert.ok(mixed.coverage.includes(RETRY));
  assert.equal(LenzView.retryHelps(MIXED), true);
});

test('failed deep checks: a failed claim or citation check, or an unmarked failure, still advises a retry', () => {
  const claim = JSON.parse(JSON.stringify(THIN));
  claim.summary.assessments.failed = 1;
  assert.ok(LenzView.build(claim).coverage.includes(RETRY));
  const cit = JSON.parse(JSON.stringify(THIN));
  cit.summary.citation_checks.failed = 1;
  assert.ok(LenzView.build(cit).coverage.includes(RETRY));
  const marked = JSON.parse(JSON.stringify(THIN));
  marked.claims.find((c) => c.index === 0).verification.failure.retryable = true;
  assert.ok(LenzView.build(marked).coverage.includes(RETRY));
  const unmarked = JSON.parse(JSON.stringify(THIN));
  unmarked.claims.find((c) => c.index === 0).verification.failure = null;
  assert.ok(LenzView.build(unmarked).coverage.includes(RETRY));
  // Not incomplete: never advice.
  assert.equal(LenzView.retryHelps(REVIEW), false);
});

// ── a failed review says why in Docs words, never in the API's hint ──

const WORDS = {
  noClaim: 'Lenz found no factual claim to check in this tab.',
  credits: 'Not enough credits to check this tab. Nothing was charged.',
  unavailable: 'Lenz could not check this tab just now. Nothing was charged. Try again in a minute.',
  ours: 'Something went wrong on our side. Checks that did not finish were not charged.',
};
const BILLING = { href: 'https://lenz.io/billing', words: 'Add credits' };

test('failed review: no claim says so, and never quotes the API hint', () => {
  const m = LenzView.build(NO_CLAIM);
  assert.equal(m.headline, 'The check did not finish.');
  assert.equal(m.failure, WORDS.noClaim);
  assert.equal(m.failureLink, null);
  assert.ok(NO_CLAIM.failure.hint.includes('/extract'), 'the fixture carries the integrator hint');
  assert.ok(!JSON.stringify(m).includes('/extract'));
});

test('failed review: not enough credits says nothing was charged and offers the billing page', () => {
  const m = LenzView.build(NO_CREDITS);
  assert.equal(NO_CREDITS.failure.failure_reason, 'insufficient_credits');
  assert.equal(m.failure, WORDS.credits);
  assert.deepEqual(m.failureLink, BILLING);
  assert.ok(!JSON.stringify(m).includes('5 credits to assess'));
  // Only this failure links; no other model carries a link.
  [NO_CLAIM, UNAVAILABLE, ASSESSMENT_FAILED, INTERNAL].forEach((b) => assert.equal(LenzView.build(b).failureLink, null));
});

test('failed review: an outage and every quick check failing say it could not check just now', () => {
  assert.equal(LenzView.build(UNAVAILABLE).failure, WORDS.unavailable);
  const m = LenzView.build(ASSESSMENT_FAILED);
  assert.equal(ASSESSMENT_FAILED.failure.failure_reason, 'assessment_failed');
  assert.equal(m.failure, WORDS.unavailable);
  assert.ok(!JSON.stringify(m).includes('Idempotency-Key'));
  // The same reason with class internal (a non-retryable failure of every row) reads the same.
  const internal = JSON.parse(JSON.stringify(ASSESSMENT_FAILED));
  internal.failure.failure_class = 'internal';
  internal.failure.retryable = false;
  assert.equal(LenzView.build(internal).failure, WORDS.unavailable);
});

test('failed review: an internal failure, an unknown reason and no failure block say it is on our side', () => {
  assert.equal(LenzView.build(INTERNAL).failure, WORDS.ours);
  const unknown = JSON.parse(JSON.stringify(INTERNAL));
  unknown.failure.failure_reason = 'something_new';
  assert.equal(LenzView.build(unknown).failure, WORDS.ours);
  const bare = JSON.parse(JSON.stringify(INTERNAL));
  bare.failure = null;
  assert.equal(LenzView.build(bare).failure, WORDS.ours);
  // A reason named like an Object property is unknown, not a lookup.
  unknown.failure.failure_reason = 'constructor';
  assert.equal(LenzView.build(unknown).failure, WORDS.ours);
});

test('failed review: an unclassified reason in an outage class says it could not check just now', () => {
  const stuck = JSON.parse(JSON.stringify(INTERNAL));
  stuck.failure.failure_reason = 'task_stuck';
  stuck.failure.failure_class = 'upstream_unavailable';
  assert.equal(LenzView.build(stuck).failure, WORDS.unavailable);
});

test('failed review: the failure words never come from the hint, whatever it says', () => {
  [NO_CLAIM, NO_CREDITS, UNAVAILABLE, ASSESSMENT_FAILED, INTERNAL].forEach((b) => {
    const withHint = JSON.parse(JSON.stringify(b));
    withHint.failure.hint = 'PRIVATE_HINT_TEXT';
    const m = LenzView.build(withHint);
    assert.ok(!JSON.stringify(m).includes('PRIVATE_HINT_TEXT'), b.failure.failure_reason);
    assert.equal(m.failure, LenzView.build(b).failure);
  });
});

test('a review that did not fail has no failure words or link', () => {
  const m = LenzView.build(REVIEW);
  assert.equal(m.failure, null);
  assert.equal(m.failureLink, null);
});

test('failed review: the claims left unchecked by a credit shortfall are not called charged or failed', () => {
  const m = LenzView.build(NO_CREDITS);
  assert.deepEqual(m.groups.map((g) => g.key), ['none']);
  m.groups[0].entries.forEach((e) => assert.ok(!e.lines.some((l) => /charged/.test(l.text)), e.id));
});

// ── a failed quick check says nothing was charged for it ──

test('failed quick check: the row says it could not be checked and nothing was charged for it', () => {
  const m = LenzView.build(QUICK_FAILED);
  const e = entry(m, 'claim:3');
  assert.equal(QUICK_FAILED.claims.find((c) => c.index === 3).assessment.error_code, 'internal');
  assert.equal(e.group, 'none');
  assert.equal(e.label, 'Not checked');
  assert.deepEqual(e.lines, [{ lead: null, text: 'Could not be checked this time. Nothing was charged for it.' }]);
  assert.ok(m.coverage.includes('1 claim could not be checked this time.'));
  // The other rows are untouched.
  assert.ok(!entry(m, 'claim:4').lines.some((l) => /charged/.test(l.text)));
});

test('failed quick check: every error code reads the same, and the row never shows a hint', () => {
  ['timeout', 'upstream_unavailable', 'internal'].forEach((code) => {
    const b = JSON.parse(JSON.stringify(QUICK_FAILED));
    const r = b.claims.find((c) => c.index === 3);
    r.assessment.error_code = code;
    r.assessment.hint = 'PRIVATE_HINT_TEXT';
    r.assessment.failure.hint = 'PRIVATE_HINT_TEXT';
    const m = LenzView.build(b);
    assert.deepEqual(entry(m, 'claim:3').lines, [{ lead: null, text: 'Could not be checked this time. Nothing was charged for it.' }], code);
    assert.ok(!JSON.stringify(m).includes('PRIVATE_HINT_TEXT'), code);
  });
});

test('failed quick check: the review advises running again, and says the new check is charged', () => {
  const m = LenzView.build(QUICK_FAILED);
  assert.equal(QUICK_FAILED.outcome, 'incomplete');
  assert.equal(LenzView.retryHelps(QUICK_FAILED), true);
  assert.equal(m.coverage[m.coverage.length - 1], 'Choose Check this Doc to check it again; the new check is charged.');
});

test('failed deep check on our side: the row and the run-again advice', () => {
  const m = LenzView.build(DEEP_INTERNAL);
  assert.ok(m.coverage.includes('1 deep check did not finish; that claim shows its quick verdict.'));
  assert.equal(LenzView.retryHelps(DEEP_INTERNAL), true);
});

test('a selection check says what it covered; Check this Doc says nothing', () => {
  assert.equal(LenzView.build(REVIEW, { scope: { paragraphs: 3, gap: false } }).scope,
    'This check covered the text you selected (3 paragraphs). Check this Doc checks the whole tab.');
  assert.equal(LenzView.build(REVIEW, { scope: { paragraphs: 1 } }).scope,
    'This check covered the text you selected (1 paragraph). Check this Doc checks the whole tab.');
  assert.equal(LenzView.build(REVIEW, { scope: { paragraphs: 5, gap: true } }).scope,
    'This check covered the paragraphs from the first to the last you selected (5 paragraphs). Check this Doc checks the whole tab.');
  assert.equal(LenzView.build(REVIEW, { scope: {} }).scope, 'This check covered the text you selected. Check this Doc checks the whole tab.');
  assert.equal(LenzView.build(REVIEW).scope, null);
  // The line is not a coverage gap: a clean selection still reads "No issues found." when it is.
  assert.deepEqual(LenzView.build(REVIEW, { scope: { paragraphs: 3 } }).coverage, LenzView.build(REVIEW).coverage);
});
