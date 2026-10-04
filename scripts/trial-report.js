#!/usr/bin/env node
// Reads the trial's JSONL action log (docs/trial.md) and measures the phase 1 success
// criteria. `node scripts/trial-report.js trial.jsonl [--json]`; exit 0 only when every criterion
// is measured and passes.
'use strict';

const PLACEMENT = { placed: true, changed: true, unplaceable: true };
const CLICKS = { applied: true, apply_refused: true, apply_conflict: true };
const UNDOS = { undone: true, undo_refused: true };
const THRESHOLDS = { drafts: 10, coverage: 0.9, offered: 20, applicable: 0.8 };

function parse(text) {
  const events = [];
  let skipped = 0;
  String(text).split('\n').forEach((line) => {
    if (!line.trim()) return;
    let e;
    try { e = JSON.parse(line); } catch (err) { skipped += 1; return; }
    if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.event !== 'string') { skipped += 1; return; }
    events.push(e);
  });
  return { events, skipped };
}

const tally = (obj, k) => { obj[k] = (obj[k] || 0) + 1; };
const key = (e) => e.review + '|' + e.finding;

function report(input) {
  // Stable sort by time: lines may be appended out of order across executions.
  const events = input.map((e, i) => ({ e, i }))
    .sort((a, b) => (Date.parse(a.e.ts) || 0) - (Date.parse(b.e.ts) || 0) || a.i - b.i)
    .map((x) => x.e);

  const first = new Map(); // review|finding → first placement status
  const last = new Map();
  const edits = new Set();
  const reasons = {};
  let expected = 0;
  const firstClick = new Map();
  const applied = new Set(); // review|finding currently applied (an undo takes it out)
  const live = new Map(); // review|passage → the review|finding edits applied in it now
  const liveOthers = (passage, k) => Array.from(live.get(passage) || []).some((x) => x !== k);
  const undo = { undone: 0, refused: 0, refusedReasons: {}, sequentialTried: 0, sequentialSucceeded: 0 };
  const refusedReasons = {};
  const sequential = { tried: 0, succeeded: 0 };
  const wrong = { select: 0, apply: 0 };
  const docs = new Set();
  const reviewedDocs = new Set(); // docs with a completed review: the sample
  const reviews = new Set();

  events.forEach((e) => {
    if (e.doc) docs.add(e.doc);
    if (e.review) reviews.add(e.review);
    if (e.event === 'review_done') {
      expected += Number(e.findings) || 0;
      if (e.doc) reviewedDocs.add(e.doc);
      return;
    }
    if (PLACEMENT[e.event]) {
      const k = key(e);
      if (!first.has(k)) {
        first.set(k, e.event);
        if (e.event !== 'placed') tally(reasons, e.reason || e.event);
      }
      last.set(k, e.event);
      if (e.kind === 'edit') edits.add(k);
      return;
    }
    if (CLICKS[e.event]) {
      const k = key(e);
      const passage = e.review + '|' + e.passage;
      if (!firstClick.has(k)) {
        firstClick.set(k, e.event);
        if (e.event === 'apply_refused') tally(refusedReasons, e.reason || 'unknown');
      }
      // A later Apply in a passage where a sibling is applied right now.
      if (e.passage && liveOthers(passage, k) && !applied.has(k)) {
        sequential.tried += 1;
        if (e.event === 'applied') sequential.succeeded += 1;
      }
      if (e.event === 'applied') {
        applied.add(k);
        if (e.passage) {
          if (!live.has(passage)) live.set(passage, new Set());
          live.get(passage).add(k);
        }
      }
      return;
    }
    // Undo. It never changes an edit's first click (C4); it takes the edit out of
    // its passage, so a later Apply there is sequential only if another sibling is still applied.
    if (UNDOS[e.event]) {
      const k = key(e);
      const passage = e.review + '|' + e.passage;
      if (e.passage && liveOthers(passage, k)) {
        undo.sequentialTried += 1;
        if (e.event === 'undone') undo.sequentialSucceeded += 1;
      }
      if (e.event === 'undone') {
        undo.undone += 1;
        applied.delete(k);
        if (live.has(passage)) live.get(passage).delete(k);
      } else {
        undo.refused += 1;
        tally(undo.refusedReasons, e.reason || 'unknown');
      }
      return;
    }
    if (e.event === 'wrong' && (e.of === 'select' || e.of === 'apply')) wrong[e.of] += 1;
  });

  const values = (m) => Array.from(m.values());
  const coverage = {
    total: first.size,
    placed: values(first).filter((s) => s === 'placed').length,
    lastPlaced: values(last).filter((s) => s === 'placed').length,
    expected,
    reasons,
  };
  const clicks = values(firstClick);
  const editsOut = {
    offered: edits.size,
    clicked: clicks.length,
    applicable: clicks.filter((s) => s === 'applied').length,
    conflicts: clicks.filter((s) => s === 'apply_conflict').length,
    refusedReasons,
  };
  const ratio = (a, b) => (b ? a / b : null);
  const crit = (label, value, pass, shown) => ({ label, value, pass, shown });
  const cov = ratio(coverage.placed, coverage.total);
  const app = ratio(editsOut.applicable, editsOut.clicked);
  const pct = (v) => (v === null ? '-' : (100 * v).toFixed(1) + '%');
  const criteria = {
    C0: crit('drafts with a completed review (≥ 10)', reviewedDocs.size, reviewedDocs.size >= THRESHOLDS.drafts,
      String(reviewedDocs.size)),
    C1: crit('placement coverage (≥ 90%)', cov, cov === null ? null : cov >= THRESHOLDS.coverage,
      pct(cov) + ' (' + coverage.placed + '/' + coverage.total + ')'),
    C2: crit('selections on the wrong words (0)', wrong.select, wrong.select ? false : coverage.total ? true : null,
      String(wrong.select)),
    C3: crit('edits offered (≥ 20)', editsOut.offered, editsOut.offered >= THRESHOLDS.offered,
      String(editsOut.offered)),
    C4: crit('edits applicable when clicked (≥ 80%)', app, app === null ? null : app >= THRESHOLDS.applicable,
      pct(app) + ' (' + editsOut.applicable + '/' + editsOut.clicked + ')'),
    C5: crit('Applies on the wrong words (0)', wrong.apply, wrong.apply ? false : editsOut.clicked ? true : null,
      String(wrong.apply)),
    C6: crit('sequential Applies in one passage (all)', ratio(sequential.succeeded, sequential.tried),
      sequential.tried ? sequential.succeeded === sequential.tried : null,
      sequential.succeeded + '/' + sequential.tried),
  };
  const pass = Object.keys(criteria).every((k) => criteria[k].pass === true);
  return { docs: docs.size, reviewedDocs: reviewedDocs.size, reviews: reviews.size, coverage, edits: editsOut, sequential, undo, wrong, criteria, pass };
}

function format(r, skipped) {
  const lines = [];
  lines.push('Trial: ' + r.docs + ' docs, ' + r.reviews + ' reviews' + (skipped ? ', ' + skipped + ' lines skipped' : ''));
  Object.keys(r.criteria).forEach((k) => {
    const c = r.criteria[k];
    const verdict = c.pass === null ? 'not measured' : c.pass ? 'PASS' : 'MISS';
    lines.push(k + '  ' + c.label.padEnd(42) + ' ' + c.shown.padEnd(18) + ' ' + verdict);
  });
  const c = r.coverage;
  if (c.total) lines.push('Coverage last seen: ' + c.lastPlaced + '/' + c.total + ' placed');
  if (c.expected && c.expected !== c.total) {
    lines.push('Gap: review_done announced ' + c.expected + ' findings, ' + c.total + ' were placed or refused');
  }
  if (Object.keys(c.reasons).length) lines.push('Not placed, by reason: ' + JSON.stringify(c.reasons));
  if (r.edits.conflicts) lines.push('Apply conflicts (gave up after one retry): ' + r.edits.conflicts);
  if (Object.keys(r.edits.refusedReasons).length) lines.push('Apply refused, by reason: ' + JSON.stringify(r.edits.refusedReasons));
  const u = r.undo;
  if (u.undone || u.refused) {
    lines.push('Undo: ' + u.undone + ' undone, ' + u.refused + ' refused' +
      (u.sequentialTried ? '; next to a live sibling ' + u.sequentialSucceeded + '/' + u.sequentialTried : '') +
      (Object.keys(u.refusedReasons).length ? '; refused by reason ' + JSON.stringify(u.refusedReasons) : ''));
  }
  lines.push('C7 (reached for over the .docx route) is a judgment: write it down.');
  lines.push(r.pass ? 'Result: every measured criterion passes.' : 'Result: a criterion missed or was not measured.');
  return lines.join('\n');
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = args.find((a) => a !== '--json');
  if (!file) {
    process.stderr.write('usage: node scripts/trial-report.js <log.jsonl> [--json]\n');
    process.exit(2);
  }
  const { events, skipped } = parse(require('node:fs').readFileSync(file, 'utf8'));
  const r = report(events);
  process.stdout.write((args.includes('--json') ? JSON.stringify(Object.assign({ skipped }, r), null, 2) : format(r, skipped)) + '\n');
  process.exit(r.pass ? 0 : 1);
}

module.exports = { parse, report, format, THRESHOLDS };
