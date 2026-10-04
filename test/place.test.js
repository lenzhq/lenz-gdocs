'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LenzSerialize = require('../src/serialize.js');
global.LenzSerialize = LenzSerialize; // as in Apps Script, where every src file shares one scope
const LenzPlace = require('../src/place.js');
const { createFakeDocs } = require('./helpers/fake-docs.js');
const { fakeSerialized } = require('./helpers/fake-serialized.js');
const { cpSlice, cpLength } = LenzSerialize;

const FIX = path.join(__dirname, 'fixtures', 'reviews');
// The text sent, as the add-on serializes it (a Doc's text never ends in a newline).
const SENT = fs.readFileSync(path.join(FIX, 'draft-a.txt'), 'utf8').replace(/\n+$/, '');
const REVIEW = JSON.parse(fs.readFileSync(path.join(FIX, 'draft-a.review.json'), 'utf8'));

// The review's claims by a word in their passage, so the tests read without indexes.
function claimWith(word) {
  const c = REVIEW.claims.find((x) => x.positions.some((p) => p.text.indexOf(word) !== -1));
  assert.ok(c, word);
  return c;
}
const ALDRIN = claimWith('Buzz Aldrin');
const EVEREST = claimWith('Mount Everest');
const EIFFEL = claimWith('Eiffel');

// The live Doc: a fake-docs document holding liveText, read by the real serialize(). A test that
// needs suggested or atomic characters (which fake-docs does not model) marks them on a
// hand-built Serialized instead (opts.flags).
function liveOf(liveText, opts) {
  if (opts && opts.flags) return fakeSerialized(liveText, opts);
  const docs = createFakeDocs();
  const id = docs.create({ text: liveText });
  const live = LenzSerialize.serialize(docs.Documents.get(id, { includeTabsContent: true,
    suggestionsViewMode: 'SUGGESTIONS_INLINE' }), null);
  assert.equal(live.text, liveText, 'fake Doc round-trips');
  return live;
}

// Same text as sent: hashes equal. Different: the glue would compute different hashes.
function ctxFor(liveText, opts) {
  opts = opts || {};
  const snapshot = opts.snapshot === undefined ? SENT : opts.snapshot;
  const live = liveOf(liveText, opts);
  return {
    snapshot: snapshot,
    live: live,
    snapshotHash: 'h:' + (snapshot === null ? SENT : snapshot),
    liveHash: 'h:' + live.text
  };
}
function liveSlice(ctx, p) { return cpSlice(ctx.live.text, p.rs, p.re); }
function restSlice(ctx, p) {
  // REST ranges back to text: every text piece's characters by REST index, then the ranges read out.
  const at = {};
  ctx.live.pieces.filter((x) => x.kind === 'text').forEach((x) => {
    const t = cpSlice(ctx.live.text, x.rs, x.re);
    for (let k = 0; k < t.length; k++) at[x.ds + k] = t[k];
  });
  return p.ranges.map((r) => {
    let out = '';
    for (let i = r.startIndex; i < r.endIndex; i++) out += at[i] === undefined ? '' : at[i];
    return out;
  }).join('');
}

test('fixture: the Aldrin edit sits after an emoji, so cp and u16 offsets differ', () => {
  const e = ALDRIN.suggested_edits.edits[0];
  assert.equal(cpSlice(SENT, e.start, e.end), 'Buzz Aldrin');
  assert.notEqual(SENT.slice(e.start, e.end), 'Buzz Aldrin');
});

test('unchanged hash: a claim is placed at its own offsets, REST ranges past an emoji', () => {
  const ctx = ctxFor(SENT);
  const p = LenzPlace.locate(LenzPlace.claimTarget(ALDRIN, 0), ctx);
  assert.equal(p.status, 'placed');
  assert.equal(liveSlice(ctx, p), ALDRIN.positions[0].text);
  assert.equal(p.ranges.length, 1);
  assert.equal(restSlice(ctx, p), ALDRIN.positions[0].text);
  assert.equal(p.applicable, false);
});

test('unchanged hash: the Aldrin edit is placed and applicable', () => {
  const ctx = ctxFor(SENT);
  const p = LenzPlace.locate(LenzPlace.editTarget(ALDRIN, 0), ctx);
  assert.equal(p.status, 'placed');
  assert.equal(liveSlice(ctx, p), 'Buzz Aldrin');
  assert.equal(restSlice(ctx, p), 'Buzz Aldrin');
  assert.equal(p.applicable, true);
});

test('unchanged hash still works without a snapshot', () => {
  const ctx = ctxFor(SENT, { snapshot: null });
  const p = LenzPlace.locate(LenzPlace.editTarget(ALDRIN, 0), ctx);
  assert.equal(p.status, 'placed');
  assert.equal(liveSlice(ctx, p), 'Buzz Aldrin');
});

test('drift: a passage unique in snapshot and live is placed at its new offsets', () => {
  const live = SENT.replace('Space notes', 'Space notes, second draft,');
  const ctx = ctxFor(live);
  const p = LenzPlace.locate(LenzPlace.claimTarget(ALDRIN, 0), ctx);
  assert.equal(p.status, 'placed');
  assert.equal(liveSlice(ctx, p), ALDRIN.positions[0].text);
  const e = LenzPlace.locate(LenzPlace.editTarget(ALDRIN, 0), ctx);
  assert.equal(e.status, 'placed');
  assert.equal(liveSlice(ctx, e), 'Buzz Aldrin');
  assert.equal(e.applicable, true);
});

test('drift: the Everest passage spans a repeated sentence but is itself unique, so it places', () => {
  const live = SENT.replace('Space notes', 'Notes');
  const ctx = ctxFor(live);
  const p = LenzPlace.locate(LenzPlace.claimTarget(EVEREST, 0), ctx);
  assert.equal(p.status, 'placed');
  assert.equal(liveSlice(ctx, p), EVEREST.positions[0].text);
});

test('drift: a passage that appeared twice in the snapshot is refused, even when unique live', () => {
  const para = 'The Moon is 384,400 km from Earth.';
  const snapshot = 'Intro.\n\n' + para + '\n\n' + para;
  const second = cpLength('Intro.\n\n' + para + '\n\n');
  const target = { kind: 'claim', start: second, end: second + cpLength(para), text: para };
  // The author deletes the checked (second) copy; the first is now the only one live.
  const ctx = ctxFor('Intro.\n\n' + para, { snapshot: snapshot });
  const p = LenzPlace.locate(target, ctx);
  assert.equal(p.status, 'changed');
  assert.equal(p.reason, 'ambiguous_snapshot');
});

test('drift: a passage found twice live (with its context) is refused', () => {
  const snapshot = 'A.\n\nThe Moon is 384,400 km away.\n\nB.';
  const target = { kind: 'claim', start: 4, end: 4 + cpLength('The Moon is 384,400 km away.'),
                   text: 'The Moon is 384,400 km away.' };
  const ctx = ctxFor(snapshot + '\n\n' + snapshot, { snapshot: snapshot });
  const p = LenzPlace.locate(target, ctx);
  assert.equal(p.status, 'changed');
  assert.equal(p.reason, 'ambiguous_live');
});

test('drift: a passage whose words changed is reported changed', () => {
  const live = SENT.replace('Buzz Aldrin, in July', 'Buzz Aldrin in July');
  const ctx = ctxFor(live);
  const p = LenzPlace.locate(LenzPlace.claimTarget(ALDRIN, 0), ctx);
  assert.equal(p.status, 'changed');
  assert.equal(p.reason, 'not_found');
  const e = LenzPlace.locate(LenzPlace.editTarget(ALDRIN, 0), ctx);
  assert.equal(e.status, 'changed');
});

test('drift: a typo fixed inside the 40-cp context window is changed; outside it, placed', () => {
  const inWindow = SENT.replace('boiling-point)', 'boiling-points)');
  assert.equal(LenzPlace.locate(LenzPlace.claimTarget(ALDRIN, 0), ctxFor(inWindow)).status, 'changed');
  const outside = SENT.replace('Eiffel Tower', 'Eiffel tower');
  assert.equal(LenzPlace.locate(LenzPlace.claimTarget(ALDRIN, 0), ctxFor(outside)).status, 'placed');
});

test('drift: a short edit slice is located inside its passage, never elsewhere', () => {
  const passage = 'The tower opened in 1998 to the public.';
  const snapshot = 'In 1998 we moved.\n\n' + passage + '\n\nSee 1998 notes.';
  const pStart = cpLength('In 1998 we moved.\n\n');
  const eStart = pStart + cpLength('The tower opened in ');
  const target = { kind: 'edit', start: eStart, end: eStart + 4, text: '1998', replacement: '1889',
                   passage: { start: pStart, end: pStart + cpLength(passage), text: passage } };
  const live = 'Draft.\n\n' + snapshot;
  const ctx = ctxFor(live, { snapshot: snapshot });
  const p = LenzPlace.locate(target, ctx);
  assert.equal(p.status, 'placed');
  assert.equal(liveSlice(ctx, p), '1998');
  assert.equal(p.rs, cpLength('Draft.\n\n') + eStart);
  assert.equal(p.applicable, true);
  // The passage gone: the slice is NOT found at another "1998".
  const gone = ctxFor('In 1998 we moved.\n\nSee 1998 notes.', { snapshot: snapshot });
  assert.equal(LenzPlace.locate(target, gone).status, 'changed');
});

test('citation: placed from snapshot offsets plus context (its text is null)', () => {
  const cit = REVIEW.citations.find((c) => c.reference === 'NASA');
  const target = LenzPlace.citationTarget(cit);
  assert.equal(target.text, null);
  const same = ctxFor(SENT);
  const a = LenzPlace.locate(target, same);
  assert.equal(a.status, 'placed');
  assert.equal(liveSlice(same, a), cpSlice(SENT, cit.position.start, cit.position.end));
  const drift = ctxFor('Title first.\n\n' + SENT);
  const b = LenzPlace.locate(target, drift);
  assert.equal(b.status, 'placed');
  assert.equal(liveSlice(drift, b), cpSlice(SENT, cit.position.start, cit.position.end));
  assert.equal(b.applicable, false);
  // A citation spans link syntax: its REST ranges hold the words without the brackets and URL.
  assert.equal(restSlice(drift, b),
    cpSlice(SENT, cit.position.start, cit.position.end).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
});

test('snapshot missing: unplaceable after drift', () => {
  const ctx = ctxFor('Edited.\n\n' + SENT, { snapshot: null });
  const p = LenzPlace.locate(LenzPlace.claimTarget(ALDRIN, 0), ctx);
  assert.equal(p.status, 'unplaceable');
  assert.equal(p.reason, 'no_snapshot');
});

test('a target that does not match its own snapshot is unplaceable', () => {
  const t = Object.assign(LenzPlace.claimTarget(ALDRIN, 0), { text: 'Something else entirely.' });
  const p = LenzPlace.locate(t, ctxFor('X.\n\n' + SENT));
  assert.equal(p.status, 'unplaceable');
  assert.equal(p.reason, 'snapshot_mismatch');
});

test('unchanged hash but the live slice differs from the target: changed, not placed', () => {
  const t = Object.assign(LenzPlace.editTarget(ALDRIN, 0), { text: 'Neil Armstrong' });
  const p = LenzPlace.locate(t, ctxFor(SENT));
  assert.notEqual(p.status, 'placed');
});

test('applicable: false for a newline in text or replacement', () => {
  const ctx = ctxFor(SENT);
  const e = LenzPlace.editTarget(ALDRIN, 0);
  assert.equal(LenzPlace.locate(Object.assign({}, e, { replacement: 'Neil\nArmstrong' }), ctx).applicable, false);
  const snap = 'Line one.\n\nLine two.';
  const t = { kind: 'edit', start: 5, end: 13, text: 'one.\n\nLi', replacement: 'x',
              passage: { start: 0, end: cpLength(snap), text: snap } };
  const p = LenzPlace.locate(t, ctxFor(snap, { snapshot: snap }));
  assert.equal(p.status, 'placed');
  assert.equal(p.applicable, false);
});

test('applicable: false on link syntax, a link run, a suggested or an atomic span', () => {
  const nasa = SENT.indexOf('[NASA]');
  const nasaCp = cpLength(SENT.slice(0, nasa));
  const claim = LenzPlace.claimTarget(claimWith('Great Wall'), 0);
  const base = { kind: 'edit', replacement: 'X', passage: claim };
  const ctx = ctxFor(SENT);
  const onBracket = Object.assign({}, base, { start: nasaCp, end: nasaCp + 5, text: '[NASA' });
  assert.equal(LenzPlace.locate(onBracket, ctx).applicable, false);
  const onLinkWords = Object.assign({}, base, { start: nasaCp + 1, end: nasaCp + 5, text: 'NASA' });
  const linkP = LenzPlace.locate(onLinkWords, ctx);
  assert.equal(linkP.status, 'placed');
  assert.equal(linkP.applicable, false);

  const e = LenzPlace.editTarget(ALDRIN, 0);
  for (const flag of ['suggested', 'atomic']) {
    const flagged = ctxFor(SENT, { flags: [{ start: e.start + 2, end: e.start + 6, flag: flag }] });
    const p = LenzPlace.locate(e, flagged);
    assert.equal(p.status, 'placed', flag);
    assert.equal(p.applicable, false, flag);
  }
  // A flag elsewhere in the paragraph splits the piece but leaves the edit applicable.
  const elsewhere = ctxFor(SENT, { flags: [{ start: e.end + 2, end: e.end + 6, flag: 'suggested' }] });
  assert.equal(LenzPlace.locate(e, elsewhere).applicable, true);
});

test('applicable: false for a claim or a citation, and for an empty span', () => {
  const ctx = ctxFor(SENT);
  assert.equal(LenzPlace.locate(LenzPlace.claimTarget(ALDRIN, 0), ctx).applicable, false);
  const e = Object.assign(LenzPlace.editTarget(ALDRIN, 0), {});
  e.end = e.start; e.text = '';
  assert.equal(LenzPlace.locate(e, ctx).applicable, false);
});

test('offsets outside the text are unplaceable', () => {
  const t = { kind: 'claim', start: 10000, end: 10010, text: 'nothing' };
  assert.equal(LenzPlace.locate(t, ctxFor(SENT)).status, 'unplaceable');
  assert.equal(LenzPlace.locate(t, ctxFor('x' + SENT)).status, 'unplaceable');
});

test('multi-position claim: each occurrence places on its own, identical ones refuse after drift', () => {
  const s1 = 'Mars has two moons.';
  const snapshot = 'Intro.\n\n' + s1 + '\n\nMiddle part.\n\n' + s1 + ' End.';
  const a = cpLength('Intro.\n\n');
  const b = cpLength('Intro.\n\n' + s1 + '\n\nMiddle part.\n\n');
  const claim = { positions: [{ start: a, end: a + cpLength(s1), text: s1 },
                              { start: b, end: b + cpLength(s1), text: s1 }],
                  suggested_edits: null };
  const same = ctxFor(snapshot, { snapshot: snapshot });
  const p0 = LenzPlace.locate(LenzPlace.claimTarget(claim, 0), same);
  const p1 = LenzPlace.locate(LenzPlace.claimTarget(claim, 1), same);
  assert.deepEqual([p0.rs, p1.rs], [a, b]);
  const drift = ctxFor('New.\n\n' + snapshot, { snapshot: snapshot });
  assert.equal(LenzPlace.locate(LenzPlace.claimTarget(claim, 1), drift).reason, 'ambiguous_snapshot');
  assert.equal(LenzPlace.claimTarget(claim, 2), null);
});

test('multi-position claim with distinct passages: occurrence i places after drift', () => {
  const s1 = 'Mars has two moons.';
  const s2 = 'Jupiter has ninety-five moons.';
  const snapshot = s1 + '\n\n' + s2;
  const b = cpLength(s1 + '\n\n');
  const claim = { positions: [{ start: 0, end: cpLength(s1), text: s1 },
                              { start: b, end: b + cpLength(s2), text: s2 }] };
  const ctx = ctxFor('Top.\n\n' + snapshot, { snapshot: snapshot });
  const p = LenzPlace.locate(LenzPlace.claimTarget(claim, 1), ctx);
  assert.equal(p.status, 'placed');
  assert.equal(liveSlice(ctx, p), s2);
});

test('editTarget carries its claim passage by the edit\'s position index', () => {
  const t = LenzPlace.editTarget(ALDRIN, 0);
  assert.equal(t.kind, 'edit');
  assert.equal(t.text, 'Buzz Aldrin');
  assert.equal(t.replacement, 'Neil Armstrong');
  assert.deepEqual(t.passage, ALDRIN.positions[0]);
  assert.equal(LenzPlace.editTarget(ALDRIN, 1), null);
  assert.equal(LenzPlace.editTarget(EIFFEL, 0), null);
  assert.equal(LenzPlace.editTarget(EVEREST, 0), null); // suggested_edits: null
});

test('applyToSnapshot: makes the replacement and shifts later offsets', () => {
  const e = LenzPlace.editTarget(ALDRIN, 0);
  const r = LenzPlace.applyToSnapshot(SENT, e);
  assert.equal(r.snapshot, SENT.replace('Buzz Aldrin', 'Neil Armstrong'));
  assert.equal(r.shift(10), 10);
  assert.equal(r.shift(e.start), e.start);
  assert.equal(r.shift(e.end), e.end + 3);
  assert.equal(r.shift(e.end + 5), e.end + 8);
  assert.equal(r.shift(e.start + 2), null);
  // An edit whose text is not in the snapshot is not applied.
  assert.equal(LenzPlace.applyToSnapshot(SENT, Object.assign({}, e, { text: 'Neil' })), null);
});

test('rebase: earlier findings unchanged, containing ones grow, overlapping ones drop', () => {
  const e = LenzPlace.editTarget(ALDRIN, 0);
  const applied = [e];
  const eiffel = LenzPlace.claimTarget(EIFFEL, 0);
  assert.deepEqual(LenzPlace.rebase(eiffel, applied), eiffel);
  assert.notEqual(LenzPlace.rebase(eiffel, applied), eiffel);
  const claim = LenzPlace.rebase(LenzPlace.claimTarget(ALDRIN, 0), applied);
  assert.equal(claim.text, 'The first person to walk on the Moon was Neil Armstrong, in July 1969.');
  assert.equal(claim.end - claim.start, cpLength(claim.text));
  const overlap = { kind: 'edit', start: e.start + 5, end: e.end + 2, text: cpSlice(SENT, e.start + 5, e.end + 2),
                    replacement: 'x', passage: ALDRIN.positions[0] };
  assert.equal(LenzPlace.rebase(overlap, applied), null);
});

function twoEditSetup() {
  const passage = 'In 1998 the tower stood 500 metres tall in Rome.';
  const snapshot = 'Notes 🚀 first.\n\n' + passage + '\n\nEnd.';
  const ps = cpLength('Notes 🚀 first.\n\n');
  const P = { start: ps, end: ps + cpLength(passage), text: passage };
  function edit(word, repl) {
    const at = ps + cpLength(passage.slice(0, passage.indexOf(word)));
    return { kind: 'edit', start: at, end: at + cpLength(word), text: word, replacement: repl, passage: P };
  }
  return { snapshot, edits: [edit('1998', '1889'), edit('500', '330'), edit('Rome', 'Paris')] };
}

for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0]]) {
  test('R3: edits in one passage applied in order ' + order.join(',') + ' all place and apply', () => {
    const { snapshot: start, edits } = twoEditSetup();
    let snapshot = start;
    const applied = [];
    for (const i of order) {
      const target = LenzPlace.rebase(edits[i], applied);
      assert.ok(target, 'rebased ' + i);
      // The live Doc equals the snapshot (hashes equal) ...
      const same = ctxFor(snapshot, { snapshot: snapshot });
      const p = LenzPlace.locate(target, same);
      assert.equal(p.status, 'placed', 'same ' + i);
      assert.equal(p.applicable, true);
      // ... and also after the author typed elsewhere (drift path, rebased passage text).
      const drift = ctxFor('Typed.\n\n' + snapshot, { snapshot: snapshot });
      const q = LenzPlace.locate(target, drift);
      assert.equal(q.status, 'placed', 'drift ' + i);
      assert.equal(liveSlice(drift, q), edits[i].text);
      const r = LenzPlace.applyToSnapshot(snapshot, target);
      assert.ok(r);
      snapshot = r.snapshot;
      applied.push(target);
    }
    assert.equal(snapshot, 'Notes 🚀 first.\n\nIn 1889 the tower stood 330 metres tall in Paris.\n\nEnd.');
  });
}

const SENT_B = fs.readFileSync(path.join(FIX, 'draft-b.txt'), 'utf8').replace(/\n+$/, '');
const REVIEW_B = JSON.parse(fs.readFileSync(path.join(FIX, 'draft-b.review.json'), 'utf8'));
const APOLLO = REVIEW_B.claims.find((c) => c.positions[0].text.indexOf('Apollo') !== -1);

for (const order of [[0, 1], [1, 0]]) {
  test('R3 on draft-b: the Apollo claim\'s two edits applied in order ' + order.join(',') + ' both place', () => {
    let snapshot = SENT_B;
    const applied = [];
    for (const i of order) {
      const target = LenzPlace.rebase(LenzPlace.editTarget(APOLLO, i), applied);
      const drift = ctxFor('Draft 2.\n\n' + snapshot, { snapshot: snapshot });
      const p = LenzPlace.locate(target, drift);
      assert.equal(p.status, 'placed');
      assert.equal(p.applicable, true);
      assert.equal(liveSlice(drift, p), APOLLO.suggested_edits.edits[i].text);
      snapshot = LenzPlace.applyToSnapshot(snapshot, target).snapshot;
      applied.push(target);
    }
    assert.ok(snapshot.indexOf('on 20 July 1969 with a crew of three astronauts.') !== -1);
    // The claim itself still places after both Applies, with its rebased (corrected) text.
    const claim = LenzPlace.rebase(LenzPlace.claimTarget(APOLLO, 0), applied);
    assert.equal(claim.text, 'The Apollo 11 mission landed on the Moon on 20 July 1969 with a crew of three astronauts.');
    assert.equal(LenzPlace.locate(claim, ctxFor(snapshot, { snapshot: snapshot })).status, 'placed');
  });
}

test('draft-b: an edit after non-ASCII text (é, —, curly quotes) places by cp', () => {
  const cafe = REVIEW_B.claims.find((c) => c.positions[0].text.indexOf('Vienna') !== -1);
  const ctx = { snapshot: SENT_B, live: liveOf('Top.\n\n' + SENT_B), snapshotHash: 'a', liveHash: 'b' };
  const p = LenzPlace.locate(LenzPlace.editTarget(cafe, 0), ctx);
  assert.equal(p.status, 'placed');
  assert.equal(liveSlice(ctx, p), "UNESCO's intangible heritage list");
});

test('rebase never changes the stored target: rebasing twice gives the same result', () => {
  const { snapshot, edits } = twoEditSetup();
  const applied = [edits[2]]; // 'Rome' -> 'Paris', after '1998' in the same passage
  const stored = JSON.parse(JSON.stringify(edits[0]));
  const once = LenzPlace.rebase(edits[0], applied);
  const twice = LenzPlace.rebase(edits[0], applied);
  assert.deepEqual(edits[0], stored);
  assert.deepEqual(twice, once);
  assert.ok(once.passage.text.endsWith('in Paris.'));
  const next = LenzPlace.applyToSnapshot(snapshot, edits[2]).snapshot;
  const p = LenzPlace.locate(twice, ctxFor('Typed.\n\n' + next, { snapshot: next }));
  assert.equal(p.status, 'placed');
});
