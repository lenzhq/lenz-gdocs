'use strict';
// End to end without Google: a fake Doc (fake-docs) → serialize.js → api.js against a fake Lenz
// (fake-lenz) → poll to completion → place.js on every finding → Apply through the fake
// batchUpdate. The glue (Code.js) and view.js are not merged yet: the Apply here is a stand-in
// written from CONTRACT.md ("Apply: one batchUpdate with insertText + deleteContentRange and
// writeControl.requiredRevisionId; conflict → re-read, retry once"), and the tests that need the
// real modules skip until src/view.js / src/Code.js exist, then run in a fake Apps Script runtime.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const LenzSerialize = require('../src/serialize.js');
global.LenzSerialize = LenzSerialize;
const LenzPlace = require('../src/place.js');
const LenzApi = require('../src/api.js');
const { createFakeDocs } = require('./helpers/fake-docs.js');
const { createFakeLenz } = require('./helpers/fake-lenz.js');
const { createRuntime, hasSrc } = require('./helpers/fake-appsscript.js');

const LenzView = hasSrc('view.js') ? require('../src/view.js') : null;
const GLUE = hasSrc('Code.js');
const NEEDS_VIEW = !LenzView && 'needs src/view.js';
const NEEDS_GLUE = !GLUE && 'needs src/Code.js';

const GET = { includeTabsContent: true, suggestionsViewMode: 'SUGGESTIONS_INLINE' };
const TAB = 't.0';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const stripLinks = (s) => s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

// ── a world: one Doc, one fake Lenz, one api client ─────────────────────────────────────────────

function memStore() {
  const m = new Map();
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); }, del: (k) => { m.delete(k); } };
}
function memCache(now) {
  const m = new Map();
  return {
    get: (k) => { const e = m.get(k); return e && e.exp > now() ? e.v : null; },
    put: (k, v, ttl) => { m.set(k, { v, exp: now() + ttl * 1000 }); },
    del: (k) => { m.delete(k); },
  };
}

function world(fixture, opts) {
  opts = opts || {};
  let clock = 1.9e12;
  const now = () => clock;
  const docs = createFakeDocs();
  const lenz = createFakeLenz(Object.assign({ apiKey: 'lenz_test_key', now }, opts.lenz || {}));
  const docId = docs.create({ documentId: 'doc-' + fixture, text: lenz.fixture(fixture).text });
  const client = LenzApi.create({
    fetch: lenz.fetch, store: memStore(), cache: memCache(now), sha256: sha, now,
    base: 'https://lenz.io/api/v1', apiKey: 'lenz_test_key', userAgent: 'lenz-gdocs-test',
  });
  const w = { docs, lenz, docId, client, now, tick: (s) => { clock += s * 1000; } };
  w.read = () => {
    const live = LenzSerialize.serialize(docs.Documents.get(docId, GET), TAB);
    live.textHash = sha(live.text);
    return live;
  };
  w.submit = () => client.submit({ docId, tabId: TAB, text: w.read().text });
  // Polls until terminal, honouring nextPollS on the fake clock. `during(i)` runs before poll i.
  w.pollToEnd = (during) => {
    for (let i = 0; i < 30; i++) {
      if (during) during(i);
      const r = client.poll(docId, TAB);
      if (r.terminal) return r;
      w.tick(r.nextPollS || 0);
    }
    throw new Error('review never finished');
  };
  w.review = (during) => {
    const s = w.submit();
    assert.equal(s.ok, true, JSON.stringify(s.error));
    const done = w.pollToEnd(during);
    const snapshot = client.snapshot(s.reviewId);
    return { submit: s, poll: done, body: done.body, state: { snapshot, snapshotHash: snapshot === null ? null : sha(snapshot), applied: [] } };
  };
  w.place = (target, state) => {
    const t = LenzPlace.rebase(target, state.applied);
    if (!t) return { status: 'unplaceable', reason: 'overlaps_applied_edit' };
    const live = w.read();
    return LenzPlace.locate(t, { snapshot: state.snapshot, live, liveHash: live.textHash, snapshotHash: state.snapshotHash });
  };
  w.text = () => w.read().text;
  w.batchCalls = () => docs.log.filter((l) => l.op === 'batchUpdate' && l.resource.writeControl);
  return w;
}

// Every finding of a review body as a target, labelled.
function findings(body) {
  const out = [];
  (body.claims || []).forEach((c) => {
    (c.positions || []).forEach((p, i) => out.push({ label: 'claim ' + c.index + ' @' + i, target: LenzPlace.claimTarget(c, i) }));
    const edits = (c.suggested_edits && c.suggested_edits.edits) || [];
    edits.forEach((e, j) => out.push({ label: 'edit ' + c.index + '.' + j, target: LenzPlace.editTarget(c, j) }));
  });
  (body.citations || []).forEach((c) => out.push({ label: 'citation ' + c.index, target: LenzPlace.citationTarget(c) }));
  return out;
}

// Stand-in for Code.js lenzApply, from CONTRACT.md. The replacement is inserted at the END of the
// old words, then the old words are deleted: Docs gives inserted text the style of the character
// before it, so inserting at the start would take the style of the text before the edit (see the
// link test below). Returns { ok, reason, attempts }.
// The glue must remember which edits it applied: rebase maps an applied edit onto its own
// replacement (text === replacement), which would "apply" again as a no-op write.
function applyEdit(w, target, state) {
  const key = JSON.stringify([target.start, target.end, target.text, target.replacement]);
  state.done = state.done || {};
  if (state.done[key]) return { ok: false, reason: 'already_applied', attempts: 0 };
  const t = LenzPlace.rebase(target, state.applied);
  if (!t) return { ok: false, reason: 'overlaps_applied_edit', attempts: 0 };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const doc = w.docs.Documents.get(w.docId, GET);
    const live = LenzSerialize.serialize(doc, TAB);
    const p = LenzPlace.locate(t, { snapshot: state.snapshot, live, liveHash: sha(live.text), snapshotHash: state.snapshotHash });
    if (p.status !== 'placed' || !p.applicable) return { ok: false, reason: p.reason || 'not_applicable', placement: p, attempts: attempt - 1 };
    const r = p.ranges[0];
    try {
      w.docs.Documents.batchUpdate({
        requests: [
          { insertText: { text: t.replacement, location: { index: r.endIndex, tabId: TAB } } },
          { deleteContentRange: { range: { startIndex: r.startIndex, endIndex: r.endIndex, tabId: TAB } } },
        ],
        writeControl: { requiredRevisionId: doc.revisionId },
      }, w.docId);
    } catch (e) {
      if (e.body && e.body.error.status === 'FAILED_PRECONDITION' && attempt === 1) continue;
      return { ok: false, reason: 'revision_conflict', error: e, attempts: attempt };
    }
    const next = LenzPlace.applyToSnapshot(state.snapshot, t);
    assert.ok(next, 'the snapshot holds the applied words');
    state.snapshot = next.snapshot;
    state.snapshotHash = sha(state.snapshot);
    state.applied.push(t);
    state.done[key] = true;
    return { ok: true, attempts: attempt };
  }
  return { ok: false, reason: 'revision_conflict', attempts: 2 };
}

const byText = (body, word) => body.claims.find((c) => c.positions.some((p) => p.text.indexOf(word) !== -1));
const APOLLO_FIXED = 'The Apollo 11 mission landed on the Moon on 20 July 1969 with a crew of three astronauts.';

// ── the happy path ──────────────────────────────────────────────────────────────────────────────

for (const name of ['draft-a', 'draft-b']) {
  test(name + ': submit, poll to completed, then every finding places on the unchanged Doc', () => {
    const w = world(name);
    const { body, state, submit } = w.review();
    assert.equal(body.status, 'completed');
    assert.equal(body.review_id, submit.reviewId);
    assert.equal(state.snapshot, w.text(), 'the snapshot is the text sent');
    assert.equal(w.lenz.requests.filter((r) => r.method === 'POST').length, 1);
    const all = findings(body);
    assert.ok(all.length >= 6);
    for (const f of all) {
      const p = w.place(f.target, state);
      assert.equal(p.status, 'placed', f.label);
      const words = f.target.text === null ? LenzSerialize.cpSlice(state.snapshot, f.target.start, f.target.end) : f.target.text;
      const rest = p.ranges.map((r) => w.docs.rangeText(w.docId, TAB, r.startIndex, r.endIndex)).join('');
      assert.equal(rest, stripLinks(words), f.label + ': the REST ranges hold the words');
      assert.equal(p.applicable, f.target.kind === 'edit', f.label);
    }
  });
}

for (const order of [[0, 1], [1, 0]]) {
  test('draft-b: the Apollo edits applied in order ' + order.join(',') + ' through batchUpdate; siblings still place', () => {
    const w = world('draft-b');
    const { body, state } = w.review();
    const apollo = byText(body, 'Apollo');
    const heart = byText(body, 'heart');
    for (const j of order) {
      const r = applyEdit(w, LenzPlace.editTarget(apollo, j), state);
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.attempts, 1);
    }
    assert.ok(w.text().indexOf(APOLLO_FIXED) !== -1, w.text());
    // The claim now reads corrected, and still places; another claim's edit still applies.
    const claim = w.place(LenzPlace.claimTarget(apollo, 0), state);
    assert.equal(claim.status, 'placed');
    assert.equal(LenzSerialize.cpSlice(w.text(), claim.rs, claim.re), APOLLO_FIXED);
    assert.equal(applyEdit(w, LenzPlace.editTarget(heart, 0), state).ok, true);
    assert.ok(w.text().indexOf('The human heart has four chambers') !== -1);
    // Every other finding still places after three Applies.
    for (const f of findings(body)) {
      const p = w.place(f.target, state);
      if (f.target.kind === 'edit' && (f.target.text === '20 July 1972' || f.target.text === 'four astronauts' || f.target.text === 'three')) continue;
      assert.equal(p.status, 'placed', f.label);
    }
    // An applied edit, rebased, is its own replacement; the glue refuses to apply it twice.
    const self = LenzPlace.rebase(LenzPlace.editTarget(apollo, order[0]), state.applied);
    assert.equal(self.text, self.replacement);
    const writes = w.batchCalls().length;
    assert.equal(applyEdit(w, LenzPlace.editTarget(apollo, order[0]), state).reason, 'already_applied');
    assert.equal(w.batchCalls().length, writes);
  });
}

test('draft-a: the Aldrin edit after an emoji applies at the right REST index', () => {
  const w = world('draft-a');
  const { body, state } = w.review();
  const aldrin = byText(body, 'Buzz Aldrin');
  assert.equal(applyEdit(w, LenzPlace.editTarget(aldrin, 0), state).ok, true);
  assert.ok(w.text().indexOf('The first person to walk on the Moon was Neil Armstrong, in July 1969.') !== -1);
  assert.ok(w.text().indexOf('Space notes 🚀 for the newsletter') === 0);
});

// ── the Doc changes while the review runs (drift) ───────────────────────────────────────────────

test('co-authors edit during the review: untouched findings place and apply, touched ones say changed', () => {
  const w = world('draft-b');
  const { body, state } = w.review((i) => {
    if (i === 1) {
      w.docs.Documents.batchUpdate({ requests: [{ insertText: { text: 'Draft 2, for review.\n', location: { index: 1 } } }] }, w.docId);
      w.docs.coauthorReplace(w.docId, 'largest ocean on Earth', 'biggest ocean on Earth');
    }
  });
  assert.notEqual(state.snapshot, w.text());
  const pacific = byText(body, 'Pacific');
  assert.equal(w.place(LenzPlace.claimTarget(pacific, 0), state).status, 'changed');
  const apollo = byText(body, 'Apollo');
  const p = w.place(LenzPlace.editTarget(apollo, 1), state);
  assert.equal(p.status, 'placed');
  assert.equal(p.applicable, true);
  assert.equal(applyEdit(w, LenzPlace.editTarget(apollo, 1), state).ok, true);
  assert.equal(applyEdit(w, LenzPlace.editTarget(apollo, 0), state).ok, true);
  assert.ok(w.text().indexOf(APOLLO_FIXED) !== -1);
  assert.ok(w.text().indexOf('Draft 2, for review.') === 0);
  assert.ok(w.text().indexOf('biggest ocean on Earth') !== -1);
});

test('a co-author rewrites words inside the passage: its edits say changed and nothing is written', () => {
  const w = world('draft-b');
  const { body, state } = w.review((i) => {
    if (i === 2) w.docs.coauthorReplace(w.docId, 'landed on the Moon', 'touched down on the Moon');
  });
  const apollo = byText(body, 'Apollo');
  const before = w.docs.revision(w.docId);
  const r = applyEdit(w, LenzPlace.editTarget(apollo, 0), state);
  assert.equal(r.ok, false);
  assert.equal(r.placement.status, 'changed');
  assert.equal(w.docs.revision(w.docId), before);
  assert.equal(w.batchCalls().length, 0);
});

test('the checked copy of a repeated passage deleted: the survivor is never edited', () => {
  const w = world('draft-b');
  const para = 'The Apollo 11 mission landed on the Moon on 20 July 1972 with a crew of four astronauts.';
  // Before the check the Doc holds the Apollo paragraph twice, so the sent text does too.
  w.docs.coauthorReplace(w.docId, 'The Pacific Ocean is the largest ocean on Earth.', para);
  const { body, state } = w.review();
  // The fake has no fixture for this text: build the review's Apollo edit on the second copy.
  assert.equal(body.claims.length, 0);
  const second = LenzSerialize.cpLength(state.snapshot) - LenzSerialize.cpLength(para);
  const off = LenzSerialize.cpLength('The Apollo 11 mission landed on the Moon on ');
  const target = { kind: 'edit', start: second + off, end: second + off + 12, text: '20 July 1972', replacement: '20 July 1969',
                   passage: { start: second, end: second + LenzSerialize.cpLength(para), text: para } };
  // Unchanged: it applies to the second copy.
  const p = w.place(target, state);
  assert.equal(p.status, 'placed');
  // A co-author deletes the second (checked) copy: the first is now the only one.
  const before = w.text();
  assert.equal(before.slice(-para.length - 2), '\n\n' + para);
  assert.equal(w.docs.coauthorReplace(w.docId, '\n' + para, '', undefined, { last: true }), true);
  assert.equal(w.text(), before.slice(0, -para.length - 2), 'the second copy is the one deleted');
  const r = applyEdit(w, target, state);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ambiguous_snapshot');
  assert.ok(w.text().indexOf('20 July 1972') !== -1, 'the surviving first copy is untouched');
});

// ── Apply against a moving Doc ──────────────────────────────────────────────────────────────────

test('a revision conflict on Apply: re-read and retry once, then it applies', () => {
  const w = world('draft-b');
  const { body, state } = w.review();
  w.docs.onBeforeNextBatch((id) => w.docs.coauthorReplace(id, 'Pacific Ocean', 'Pacific ocean'));
  const r = applyEdit(w, LenzPlace.editTarget(byText(body, 'Apollo'), 0), state);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  assert.equal(w.batchCalls().length, 2);
  assert.ok(w.text().indexOf('The Pacific ocean is') !== -1);
  assert.ok(w.text().indexOf('20 July 1969') !== -1);
});

test('two revision conflicts in a row: gives up, the Doc keeps only the co-authors\' edits', () => {
  const w = world('draft-b');
  const { body, state } = w.review();
  w.docs.onBeforeNextBatch((id) => w.docs.coauthorReplace(id, 'Pacific Ocean', 'Pacific ocean'));
  w.docs.onBeforeNextBatch((id) => w.docs.coauthorReplace(id, 'Pacific ocean', 'Pacific Ocean!'));
  const r = applyEdit(w, LenzPlace.editTarget(byText(body, 'Apollo'), 0), state);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'revision_conflict');
  assert.equal(w.batchCalls().length, 2);
  assert.ok(w.text().indexOf('20 July 1972') !== -1);
  assert.equal(state.applied.length, 0, 'the snapshot is not advanced');
});

test('inserting at the start of the old words would take the style of the text before them ⚑', () => {
  // The reason the stand-in inserts at the end: with a link right before the edit, an insert at the
  // start joins the link (fake-docs follows Docs: inserted text takes the preceding character's style).
  const docs = createFakeDocs();
  const id = docs.create({ text: 'See [NASA](https://nasa.gov)1998 data.' });
  const s = LenzSerialize.serialize(docs.Documents.get(id, GET), null);
  const target = { kind: 'edit', start: s.text.indexOf('1998'), end: s.text.indexOf('1998') + 4, text: '1998', replacement: '1969',
                   passage: { start: 0, end: LenzSerialize.cpLength(s.text), text: s.text } };
  const p = LenzPlace.locate(target, { snapshot: s.text, live: s, liveHash: 'h', snapshotHash: 'h' });
  assert.equal(p.applicable, true);
  const r = p.ranges[0];
  const atStart = createFakeDocs();
  const id2 = atStart.create({ text: 'See [NASA](https://nasa.gov)1998 data.' });
  atStart.Documents.batchUpdate({ requests: [
    { insertText: { text: '1969', location: { index: r.startIndex } } },
    { deleteContentRange: { range: { startIndex: r.startIndex + 4, endIndex: r.endIndex + 4 } } },
  ] }, id2);
  assert.equal(LenzSerialize.serialize(atStart.Documents.get(id2, GET), null).text, 'See [NASA1969](https://nasa.gov) data.');
  docs.Documents.batchUpdate({ requests: [
    { insertText: { text: '1969', location: { index: r.endIndex } } },
    { deleteContentRange: { range: { startIndex: r.startIndex, endIndex: r.endIndex } } },
  ] }, id);
  assert.equal(LenzSerialize.serialize(docs.Documents.get(id, GET), null).text, 'See [NASA](https://nasa.gov)1969 data.');
});

// ── submitting against a flaky API ──────────────────────────────────────────────────────────────

test('Run again after a failed review: a new key, a new review, and it completes', () => {
  const w = world('draft-b', { lenz: { pollsBeforeDone: 1 } });
  w.lenz.fail.review(w.lenz.fixture('draft-b').text);
  const first = w.submit();
  const failed = w.pollToEnd();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.body.failure.failure_class, 'upstream_unavailable');
  // Same text, no Run again: the add-on keeps pointing at the failed review.
  const again = w.submit();
  assert.equal(again.reviewId, first.reviewId);
  assert.equal(again.state, 'failed');
  w.client.runAgain({ docId: w.docId, tabId: TAB });
  const second = w.submit();
  assert.equal(second.ok, true);
  assert.notEqual(second.reviewId, first.reviewId);
  const posts = w.lenz.requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key']);
  assert.equal(w.pollToEnd().status, 'completed');
});

test('a lost reply to the POST: the next submit replays the same key and finds the same review', () => {
  const w = world('draft-a');
  w.lenz.fail.transport('post', { processed: true });
  const lost = w.submit();
  assert.equal(lost.ok, false);
  assert.equal(lost.state, 'submitting');
  const replay = w.submit();
  assert.equal(replay.ok, true);
  assert.equal(replay.replayed, true);
  assert.equal(Object.keys(w.lenz.reviews).length, 1, 'no second review, no second charge');
  const posts = w.lenz.requests.filter((r) => r.method === 'POST');
  assert.equal(posts[0].payload, posts[1].payload, 'the body is replayed byte for byte');
  assert.equal(w.pollToEnd().status, 'completed');
});

test('a lost reply, then the Doc changes: the pending request is still settled first, with its own body', () => {
  const w = world('draft-a');
  w.lenz.fail.transport('post', { processed: true });
  const sentText = w.text();
  w.submit();
  w.docs.coauthorReplace(w.docId, 'Space notes', 'Space notes v2');
  const replay = w.submit();
  assert.equal(replay.ok, true);
  assert.equal(JSON.parse(w.lenz.requests[1].payload).text, sentText);
  assert.equal(w.client.snapshot(replay.reviewId), sentText);
});

test('409 with review_id null: pending, then the same body again is accepted', () => {
  const w = world('draft-a');
  w.lenz.fail.conflict();
  const c = w.submit();
  assert.equal(c.ok, false);
  assert.equal(c.state, 'pending_conflict');
  const ok = w.submit();
  assert.equal(ok.ok, true);
  const posts = w.lenz.requests.filter((r) => r.method === 'POST');
  assert.equal(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key']);
});

for (const kind of ['inFlight', 'capacity', 'armor']) {
  test('POST refused (' + kind + '): retryable, nothing started, the next submit starts fresh', () => {
    const w = world('draft-a');
    if (kind === 'armor') w.lenz.fail.armor('post'); else w.lenz.fail[kind]();
    const r = w.submit();
    assert.equal(r.ok, false);
    assert.equal(r.state, 'rejected');
    assert.equal(r.error.retryable, true);
    assert.ok(r.error.retryAfterS > 0);
    const next = w.submit();
    assert.equal(next.ok, true);
    assert.equal(w.pollToEnd().status, 'completed');
  });
}

test('a poll that gets no answer backs off and the review still completes', () => {
  const w = world('draft-a', { lenz: { pollsBeforeDone: 2 } });
  w.submit();
  w.lenz.fail.transport('get');
  const miss = w.client.poll(w.docId, TAB);
  assert.equal(miss.ok, false);
  assert.equal(miss.terminal, false);
  assert.ok(miss.nextPollS >= 5);
  assert.equal(w.pollToEnd().status, 'completed');
});

test('the text changed after a completed review: submit starts a new review of the new text', () => {
  const w = world('draft-a');
  const first = w.review();
  w.docs.coauthorReplace(w.docId, 'Buzz Aldrin', 'Neil Armstrong');
  const s = w.submit();
  assert.notEqual(s.reviewId, first.submit.reviewId);
  assert.equal(w.pollToEnd().body.claims.length, 0); // the fake has no fixture for the edited text
});

// ── modules not merged yet ──────────────────────────────────────────────────────────────────────

test('view.build models every fixture body', { skip: NEEDS_VIEW }, () => {
  for (const name of ['draft-a', 'draft-b']) {
    const w = world(name);
    const model = LenzView.build(w.review().body);
    assert.ok(model && typeof model === 'object', name);
  }
});

function glueWorld(name, opts) {
  const w = world(name, opts);
  const rt = createRuntime({ docs: w.docs, lenz: w.lenz, docId: w.docId, tabId: TAB, now: w.now });
  rt.ctx.lenzSaveKey('lenz_test_key');
  return Object.assign(w, { rt, g: rt.ctx });
}
function gluePollToEnd(w) {
  for (let i = 0; i < 30; i++) {
    w.g.lenzPoll();
    const review = Object.values(w.lenz.reviews).slice(-1)[0];
    if (review && review.step > 6) return;
    w.tick(20);
  }
}

test('glue: lenzStart → lenzPoll → lenzApply both Apollo edits, one POST', { skip: NEEDS_GLUE }, () => {
  const w = glueWorld('draft-b', { lenz: { pollsBeforeDone: 1 } });
  w.g.lenzStart();
  gluePollToEnd(w);
  const apollo = byText(w.lenz.completedBody('draft-b'), 'Apollo');
  const rid = w.g.lenzState().model.reviewId; // the review the sidebar shows
  w.g.lenzApply(rid, apollo.index, 1);
  w.g.lenzApply(rid, apollo.index, 0);
  assert.ok(w.text().indexOf(APOLLO_FIXED) !== -1, w.text());
  assert.equal(w.lenz.requests.filter((r) => r.method === 'POST').length, 1);
});

test('glue: a revision conflict on Apply retries once', { skip: NEEDS_GLUE }, () => {
  const w = glueWorld('draft-b', { lenz: { pollsBeforeDone: 1 } });
  w.g.lenzStart();
  gluePollToEnd(w);
  const apollo = byText(w.lenz.completedBody('draft-b'), 'Apollo');
  const rid = w.g.lenzState().model.reviewId;
  w.docs.onBeforeNextBatch((id) => w.docs.coauthorReplace(id, 'Pacific Ocean', 'Pacific ocean'));
  w.g.lenzApply(rid, apollo.index, 0);
  assert.ok(w.text().indexOf('20 July 1969') !== -1);
  assert.equal(w.batchCalls().length, 2);
});

test('glue: Check this Doc after a failed review starts a new one', { skip: NEEDS_GLUE }, () => {
  const w = glueWorld('draft-b', { lenz: { pollsBeforeDone: 1 } });
  w.lenz.fail.review(w.lenz.fixture('draft-b').text);
  w.g.lenzStart();
  gluePollToEnd(w);
  w.g.lenzStart();
  const posts = w.lenz.requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 2);
  assert.notEqual(posts[0].headers['Idempotency-Key'], posts[1].headers['Idempotency-Key']);
});

test('glue: lenzState never returns the API key', { skip: NEEDS_GLUE }, () => {
  const w = glueWorld('draft-a');
  w.g.lenzStart();
  assert.equal(JSON.stringify(w.g.lenzState()).indexOf('lenz_test_key'), -1);
});

// ── Undo (an API edit is not on the editor's undo stack; the sidebar undoes it) ──────────

function applyBoth(w) {
  w.g.lenzStart();
  gluePollToEnd(w);
  const apollo = byText(w.lenz.completedBody('draft-b'), 'Apollo');
  const rid = w.g.lenzState().model.reviewId;
  const before = w.text();
  assert.equal(w.g.lenzApply(rid, apollo.index, 0).ok, true);
  assert.equal(w.g.lenzApply(rid, apollo.index, 1).ok, true);
  assert.ok(w.text().indexOf(APOLLO_FIXED) !== -1);
  return { apollo, rid, before };
}

test('glue: Undo restores the words, in either order, and the Doc ends as it began', { skip: NEEDS_GLUE }, () => {
  for (const order of [[0, 1], [1, 0]]) {
    const w = glueWorld('draft-b', { lenz: { pollsBeforeDone: 1 } });
    const { apollo, rid, before } = applyBoth(w);
    const first = w.g.lenzUndo(rid, apollo.index, order[0]);
    assert.equal(first.ok, true, first.message);
    assert.equal(first.message, 'Undone: the earlier words are back.');
    assert.ok(w.text().indexOf(APOLLO_FIXED) === -1);
    const second = w.g.lenzUndo(rid, apollo.index, order[1]);
    assert.equal(second.ok, true, second.message);
    assert.equal(w.text(), before);
    // Nothing left to undo; both can be applied again.
    assert.equal(w.g.lenzUndo(rid, apollo.index, 0).ok, false);
    assert.equal(w.g.lenzApply(rid, apollo.index, 0).ok, true);
    assert.equal(w.g.lenzApply(rid, apollo.index, 1).ok, true);
    assert.ok(w.text().indexOf(APOLLO_FIXED) !== -1, order.join());
  }
});

test('glue: Undo refuses when the replacement was edited since, and writes nothing', { skip: NEEDS_GLUE }, () => {
  const w = glueWorld('draft-b', { lenz: { pollsBeforeDone: 1 } });
  const { apollo, rid } = applyBoth(w);
  const writes = w.batchCalls().length;
  w.docs.coauthorReplace(w.docId, 'three astronauts', 'three brave astronauts');
  const r = w.g.lenzUndo(rid, apollo.index, 1);
  assert.equal(r.ok, false);
  assert.match(r.message, /Version history/);
  assert.equal(w.batchCalls().length, writes);
});

test('glue: Undo retries once on a revision conflict', { skip: NEEDS_GLUE }, () => {
  const w = glueWorld('draft-b', { lenz: { pollsBeforeDone: 1 } });
  const { apollo, rid } = applyBoth(w);
  const writes = w.batchCalls().length;
  w.docs.onBeforeNextBatch((id) => w.docs.coauthorReplace(id, 'Pacific Ocean', 'Pacific ocean'));
  const r = w.g.lenzUndo(rid, apollo.index, 0);
  assert.equal(r.ok, true, r.message);
  assert.ok(w.text().indexOf('20 July 1972') !== -1);
  assert.equal(w.batchCalls().length, writes + 2);
});

test('glue: Undo of a list from another check is refused', { skip: NEEDS_GLUE }, () => {
  const w = glueWorld('draft-b', { lenz: { pollsBeforeDone: 1 } });
  const { apollo } = applyBoth(w);
  const r = w.g.lenzUndo('ffffffff', apollo.index, 0);
  assert.equal(r.ok, false);
  assert.match(r.message, /another tab or an earlier check/);
});

// ── v17: the map after our own write, and the kept completed body ─────────────────────

// The map the glue holds now (read through its cache) and a fresh serialize of the Doc as it is.
function mapsNow(w) {
  const ctx = w.g.lenzContext_();
  const held = JSON.parse(JSON.stringify(w.g.lenzRead_(ctx)));
  const doc = w.docs.Documents.get(w.docId, GET);
  const live = LenzSerialize.serialize(doc, TAB);
  live.textHash = sha(live.text);
  const tab = doc.tabs.find((t) => t.tabProperties.tabId === TAB);
  const paras = JSON.parse(JSON.stringify(w.g.lenzRestParagraphs_(tab.documentTab.body.content)));
  return { held, fresh: { live: JSON.parse(JSON.stringify(live)), paras } };
}

function assertMapIsFresh(w, label) {
  const { held, fresh } = mapsNow(w);
  assert.equal(held.mode, 'cached', label + ': the map was not kept after the write');
  assert.deepEqual(held.live, fresh.live, label + ': Serialized');
  assert.deepEqual(held.paras, fresh.paras, label + ': paragraph index');
}

test('glue: after each Apply and Undo the map moved in place equals a fresh serialize', { skip: NEEDS_GLUE }, () => {
  for (const order of [[0, 1], [1, 0]]) {
    const w = glueWorld('draft-b', { lenz: { pollsBeforeDone: 1 } });
    w.g.lenzStart();
    gluePollToEnd(w);
    const apollo = byText(w.lenz.completedBody('draft-b'), 'Apollo');
    const rid = w.g.lenzState().model.reviewId;
    assert.equal(w.g.lenzApply(rid, apollo.index, order[0]).ok, true);
    assertMapIsFresh(w, 'apply ' + order[0]);
    assert.equal(w.g.lenzApply(rid, apollo.index, order[1]).ok, true);
    assertMapIsFresh(w, 'apply ' + order[1]);
    assert.ok(w.text().indexOf(APOLLO_FIXED) !== -1);
    assert.equal(w.g.lenzUndo(rid, apollo.index, order[0]).ok, true);
    assertMapIsFresh(w, 'undo ' + order[0]);
    assert.equal(w.g.lenzUndo(rid, apollo.index, order[1]).ok, true);
    assertMapIsFresh(w, 'undo ' + order[1]);
  }
});

test('glue: Apply and Undo on a completed review make no GET of the review', { skip: NEEDS_GLUE }, () => {
  const w = glueWorld('draft-b', { lenz: { pollsBeforeDone: 1 } });
  w.g.lenzStart();
  gluePollToEnd(w);
  const apollo = byText(w.lenz.completedBody('draft-b'), 'Apollo');
  const rid = w.g.lenzState().model.reviewId;
  const gets = () => w.lenz.requests.filter((r) => r.method === 'GET').length;
  const before = gets();
  assert.equal(w.g.lenzApply(rid, apollo.index, 0).ok, true);
  assert.equal(w.g.lenzUndo(rid, apollo.index, 0).ok, true);
  assert.equal(gets(), before);
});

test('glue: one Apply makes one property read, one property write and a handful of cache calls', { skip: NEEDS_GLUE }, () => {
  const w = glueWorld('draft-b', { lenz: { pollsBeforeDone: 1 } });
  w.g.lenzStart();
  gluePollToEnd(w);
  const apollo = byText(w.lenz.completedBody('draft-b'), 'Apollo');
  const rid = w.g.lenzState().model.reviewId;
  const counts = {};
  function wrap(obj, label) {
    Object.keys(obj).forEach((k) => {
      if (typeof obj[k] !== 'function' || k.startsWith('_')) return;
      const f = obj[k];
      obj[k] = function () { counts[label + '.' + k] = (counts[label + '.' + k] || 0) + 1; return f.apply(this, arguments); };
    });
  }
  wrap(w.g.PropertiesService.getUserProperties(), 'props');
  wrap(w.g.CacheService.getUserCache(), 'cache');
  assert.equal(w.g.lenzApply(rid, apollo.index, 0).ok, true);
  // Was 26 property reads, 2 writes and 34 cache calls (the placement pass read the applied state
  // and the snapshot again for every finding).
  assert.equal(counts['props.getProperty'] || 0, 0);
  // One inside the lock (the Apply and its reply), at most one after it (the trial log's Doc id).
  assert.ok(counts['props.getProperties'] <= 2, JSON.stringify(counts));
  // The applied state (one setProperties) and the trial lines left for the next poll (one setProperty).
  assert.ok((counts['props.setProperty'] || 0) + (counts['props.setProperties'] || 0) <= 2, JSON.stringify(counts));
  const cacheCalls = Object.keys(counts).filter((k) => k.startsWith('cache.')).reduce((n, k) => n + counts[k], 0);
  assert.ok(cacheCalls <= 8, JSON.stringify(counts));
  // The glue's own writes (the moved map, the reply kept for the next open) go out as one putAll.
  assert.equal(counts['cache.putAll'], 1, JSON.stringify(counts));
});
