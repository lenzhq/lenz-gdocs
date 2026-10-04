'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { report, parse, format } = require('../scripts/trial-report.js');

let t = Date.parse('2026-10-01T09:00:00Z');
function ev(event, fields) {
  t += 1000;
  return Object.assign({ v: 1, ts: new Date(t).toISOString(), doc: 'd1', review: 'r1', event }, fields || {});
}
const place = (status, finding, extra) => ev(status, Object.assign({ finding, kind: finding.split(':')[0] }, extra || {}));
const click = (event, finding, passage, reason) => ev(event, { finding, kind: 'edit', passage, reason });

test('C1 coverage: first placement per finding; later drift is "last seen"; the review_done gap is shown', () => {
  const r = report([
    ev('review_done', { findings: 5, edits: 1 }),
    place('placed', 'claim:0@0'),
    place('placed', 'claim:1@0'),
    place('changed', 'claim:2@0', { reason: 'not_found' }),
    place('placed', 'edit:0.0', { passage: 'claim:0@0' }),
    // a later pass: claim 1 drifted away, claim 2 still gone
    place('changed', 'claim:1@0', { reason: 'not_found' }),
    place('changed', 'claim:2@0', { reason: 'not_found' }),
  ]);
  assert.equal(r.coverage.total, 4);
  assert.equal(r.coverage.placed, 3);
  assert.equal(r.coverage.lastPlaced, 2);
  assert.equal(r.coverage.expected, 5);
  assert.deepEqual(r.coverage.reasons, { not_found: 1 });
  assert.equal(r.criteria.C1.value, 0.75);
  assert.equal(r.criteria.C1.pass, false);
});

test('findings are per review: the same finding id in two reviews counts twice', () => {
  const r = report([
    place('placed', 'claim:0@0'),
    Object.assign(place('placed', 'claim:0@0'), { review: 'r2' }),
  ]);
  assert.equal(r.coverage.total, 2);
});

test('C3 / C4: edits offered, first click decides applicability, conflicts listed apart', () => {
  const r = report([
    place('placed', 'edit:0.0', { passage: 'claim:0@0' }),
    place('placed', 'edit:0.1', { passage: 'claim:0@0' }),
    place('placed', 'edit:1.0', { passage: 'claim:1@0' }),
    place('changed', 'edit:2.0', { passage: 'claim:2@0', reason: 'not_found' }),
    click('apply_refused', 'edit:1.0', 'claim:1@0', 'not_applicable'),
    click('applied', 'edit:1.0', 'claim:1@0'), // a second click does not rescue the first
    click('applied', 'edit:0.0', 'claim:0@0'),
    click('apply_conflict', 'edit:0.1', 'claim:0@0'),
  ]);
  assert.equal(r.edits.offered, 4);
  assert.equal(r.edits.clicked, 3);
  assert.equal(r.edits.applicable, 1);
  assert.equal(r.edits.conflicts, 1);
  assert.deepEqual(r.edits.refusedReasons, { not_applicable: 1 });
  assert.equal(r.criteria.C3.value, 4);
  assert.equal(r.criteria.C3.pass, false);
  assert.equal(r.criteria.C4.value, 1 / 3);
  assert.equal(r.criteria.C4.pass, false);
});

test('C6: later Applies in an already-edited passage must all succeed', () => {
  const ok = report([
    click('applied', 'edit:0.1', 'claim:0@0'),
    click('applied', 'edit:0.0', 'claim:0@0'),
    click('applied', 'edit:1.0', 'claim:1@0'),
  ]);
  assert.deepEqual([ok.sequential.tried, ok.sequential.succeeded], [1, 1]);
  assert.equal(ok.criteria.C6.pass, true);
  const miss = report([
    click('applied', 'edit:0.0', 'claim:0@0'),
    click('apply_refused', 'edit:0.1', 'claim:0@0', 'changed'),
    click('apply_refused', 'edit:1.1', 'claim:1@0', 'changed'), // no earlier Apply in claim 1
  ]);
  assert.deepEqual([miss.sequential.tried, miss.sequential.succeeded], [1, 0]);
  assert.equal(miss.criteria.C6.pass, false);
});

test('C6 is per review: an Apply in another review does not make a passage "edited"', () => {
  const r = report([
    click('applied', 'edit:0.0', 'claim:0@0'),
    Object.assign(click('applied', 'edit:0.1', 'claim:0@0'), { review: 'r2' }),
  ]);
  assert.equal(r.sequential.tried, 0);
  assert.equal(r.criteria.C6.pass, null); // not measured
});

test('C2 / C5: wrong flags by kind', () => {
  const r = report([
    ev('wrong', { finding: 'claim:0@0', of: 'select' }),
    ev('wrong', { finding: 'edit:0.0', of: 'apply' }),
    ev('wrong', { finding: 'edit:0.1', of: 'apply' }),
  ]);
  assert.equal(r.criteria.C2.value, 1);
  assert.equal(r.criteria.C2.pass, false);
  assert.equal(r.criteria.C5.value, 2);
  assert.equal(r.criteria.C5.pass, false);
});

test('a clean trial passes every criterion', () => {
  const events = [];
  for (let d = 0; d < 10; d++) {
    const review = 'r' + d;
    const push = (e) => events.push(Object.assign(e, { review, doc: 'd' + d }));
    push(ev('review_done', { findings: 10, edits: 3 }));
    for (let c = 0; c < 7; c++) push(place('placed', 'claim:' + c + '@0'));
    for (let j = 0; j < 3; j++) push(place('placed', 'edit:0.' + j, { passage: 'claim:0@0' }));
    for (let j = 0; j < 3; j++) push(click('applied', 'edit:0.' + j, 'claim:0@0'));
  }
  const r = report(events);
  assert.equal(r.criteria.C1.value, 1);
  for (const k of ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6']) assert.equal(r.criteria[k].pass, true, k);
  assert.equal(r.pass, true);
  assert.equal(r.docs, 10);
  assert.equal(r.reviews, 10);
  assert.equal(r.sequential.tried, 20);
});

test('events are ordered by ts, whatever the line order', () => {
  const a = click('applied', 'edit:0.0', 'claim:0@0');
  const b = click('apply_refused', 'edit:0.0', 'claim:0@0', 'already_applied');
  const r = report([b, a]);
  assert.equal(r.edits.applicable, 1);
});

test('parse skips blank, non-JSON and event-less lines, and counts them', () => {
  const { events, skipped } = parse('{"event":"placed","finding":"claim:0@0","review":"r"}\n\nnot json\n{"x":1}\n[]\n');
  assert.equal(events.length, 1);
  assert.equal(skipped, 3);
});

test('an empty log measures nothing and does not pass', () => {
  const r = report([]);
  assert.equal(r.criteria.C1.pass, null);
  assert.equal(r.pass, false);
  assert.match(format(r), /not measured/);
});

test('the CLI prints the table and exits 1 on a miss, 0 on a pass; --json prints numbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-'));
  const file = path.join(dir, 'log.jsonl');
  const script = path.join(__dirname, '..', 'scripts', 'trial-report.js');
  fs.writeFileSync(file, [place('placed', 'claim:0@0'), place('changed', 'claim:1@0', { reason: 'not_found' })]
    .map((e) => JSON.stringify(e)).join('\n'));
  const cli = (...args) => {
    try { return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' }) }; }
    catch (e) { return { code: e.status, out: e.stdout }; }
  };
  const table = cli(file);
  assert.equal(table.code, 1);
  assert.match(table.out, /C1 .*50\.0%.*MISS/);
  const json = cli(file, '--json');
  assert.equal(json.code, 1);
  assert.equal(JSON.parse(json.out).coverage.total, 2);
  fs.writeFileSync(file, '');
  assert.equal(cli(file).code, 1, 'nothing measured is not a pass');
});

test('C0: fewer than ten reviewed drafts is a miss, however good the numbers', () => {
  const events = [ev('review_done', { findings: 21, edits: 21 })];
  for (let j = 0; j < 21; j++) events.push(place('placed', 'edit:0.' + j, { passage: 'claim:0@0' }));
  for (let j = 0; j < 3; j++) events.push(click('applied', 'edit:0.' + j, 'claim:0@0'));
  const r = report(events);
  for (const k of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']) assert.equal(r.criteria[k].pass, true, k);
  assert.equal(r.criteria.C0.value, 1);
  assert.equal(r.criteria.C0.pass, false);
  assert.equal(r.pass, false);
});

// Undo: `undone` restored the old words, `undo_refused` wrote nothing.
const undo = (event, finding, passage, reason) => ev(event, { finding, kind: 'edit', passage, reason });

test('undo: an undone edit still counts as applicable for C4 (the first click decided)', () => {
  const r = report([
    click('applied', 'edit:0.0', 'claim:0@0'),
    undo('undone', 'edit:0.0', 'claim:0@0'),
  ]);
  assert.equal(r.edits.clicked, 1);
  assert.equal(r.edits.applicable, 1);
  assert.deepEqual([r.undo.undone, r.undo.refused], [1, 0]);
});

test('undo: undo events are not Apply clicks (they never start an edit\'s first click)', () => {
  const r = report([undo('undo_refused', 'edit:0.0', 'claim:0@0', 'not_applied')]);
  assert.equal(r.edits.clicked, 0);
  assert.deepEqual(r.undo.refusedReasons, { not_applied: 1 });
});

test('C6 after an undo: a passage whose only Apply was undone is no longer "edited"', () => {
  const r = report([
    click('applied', 'edit:0.0', 'claim:0@0'),
    undo('undone', 'edit:0.0', 'claim:0@0'),
    click('applied', 'edit:0.1', 'claim:0@0'), // the passage is back to its checked words
  ]);
  assert.equal(r.sequential.tried, 0);
});

test('C6 after an undo: re-applying next to a live sibling is a sequential Apply', () => {
  const r = report([
    click('applied', 'edit:0.0', 'claim:0@0'),
    click('applied', 'edit:0.1', 'claim:0@0'), // sequential 1
    undo('undone', 'edit:0.1', 'claim:0@0'),
    click('applied', 'edit:0.1', 'claim:0@0'), // sequential 2: 0.0 is still applied
    click('apply_refused', 'edit:0.0', 'claim:0@0', 'already_applied'), // still applied: not a try
  ]);
  assert.deepEqual([r.sequential.tried, r.sequential.succeeded], [2, 2]);
  assert.equal(r.criteria.C6.pass, true);
});

test('undo in a passage with another live edit is counted apart (not a criterion)', () => {
  const r = report([
    click('applied', 'edit:0.0', 'claim:0@0'),
    click('applied', 'edit:0.1', 'claim:0@0'),
    undo('undone', 'edit:0.0', 'claim:0@0'),
    undo('undo_refused', 'edit:0.1', 'claim:0@0', 'conflict'),
  ]);
  assert.deepEqual([r.undo.sequentialTried, r.undo.sequentialSucceeded], [1, 1]);
  assert.deepEqual(r.undo.refusedReasons, { conflict: 1 });
  assert.match(format(r), /Undo: 1 undone, 1 refused/);
});
