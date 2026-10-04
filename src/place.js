// Places a /review finding in the live Doc text, and keeps the snapshot in step after an Apply.
// Pure: no Apps Script globals. Units: cp = code points of the review text (the API's unit),
// u16 = UTF-16 code units (JS string indexes, Docs REST indexes).
var LenzPlace = (function () {
  'use strict';

  var CONTEXT_CP = 40;          // anchor = passage + this many cp either side (plan, rule 2)
  var NEWLINE = /[\n\r\u000b]/; // the .docx writer's rule: no line break in text or replacement

  // LenzSerialize is a global in Apps Script; in Node, a test may set it or it is required.
  function S() {
    if (typeof LenzSerialize !== 'undefined') return LenzSerialize;
    if (typeof require === 'function') return require('./serialize.js');
    throw new Error('LenzSerialize is not loaded');
  }

  // --- targets from the review body -------------------------------------------------------

  // A claim's i-th position ("1 of N"); null when there is none.
  function claimTarget(claim, i) {
    var p = claim && claim.positions && claim.positions[i];
    if (!p) return null;
    return { kind: 'claim', start: p.start, end: p.end, text: p.text };
  }

  // A claim's j-th suggested edit, with the claim position it belongs to as its passage.
  function editTarget(claim, j) {
    var se = claim && claim.suggested_edits;
    var e = se && se.edits && se.edits[j];
    if (!e) return null;
    var p = claim.positions && claim.positions[e.position || 0];
    if (!p) return null;
    return { kind: 'edit', start: e.start, end: e.end, text: e.text, replacement: e.replacement,
             passage: { start: p.start, end: p.end, text: p.text } };
  }

  // A citation use: its position's text is null, so the snapshot supplies the words.
  function citationTarget(citation) {
    var p = citation && citation.position;
    if (!p) return null;
    return { kind: 'citation', start: p.start, end: p.end, text: null };
  }

  // --- locate ------------------------------------------------------------------------------

  function result(status, reason) {
    return { status: status, reason: reason, rs: null, re: null, ranges: [], applicable: false };
  }

  // Every start (u16) of needle in hay, overlapping matches included; stops after two.
  function countUpToTwo(hay, needle) {
    var first = hay.indexOf(needle);
    if (first === -1) return { n: 0, at: -1 };
    return { n: hay.indexOf(needle, first + 1) === -1 ? 1 : 2, at: first };
  }

  function sameText(ctx) {
    if (ctx.liveHash && ctx.snapshotHash) return ctx.liveHash === ctx.snapshotHash;
    return typeof ctx.snapshot === 'string' && ctx.snapshot === ctx.live.text;
  }

  // Finds span [start, end) of the snapshot in the live text by passage + context.
  // Returns { rs } (cp in live.text) or a failed result.
  function relocate(snapshot, liveText, start, end, expected) {
    var s = S();
    var snapLen = s.cpLength(snapshot);
    if (start < 0 || end > snapLen || start > end) return result('unplaceable', 'out_of_range');
    var passage = s.cpSlice(snapshot, start, end);
    if (expected !== null && expected !== undefined && passage !== expected) {
      return result('unplaceable', 'snapshot_mismatch');
    }
    if (!passage) return result('unplaceable', 'empty');
    // A passage that appeared more than once in the checked text is never relocated.
    if (countUpToTwo(snapshot, passage).n !== 1) return result('changed', 'ambiguous_snapshot');
    var a = Math.max(0, start - CONTEXT_CP);
    var b = Math.min(snapLen, end + CONTEXT_CP);
    var anchor = s.cpSlice(snapshot, a, b);
    if (countUpToTwo(snapshot, anchor).n !== 1) return result('changed', 'ambiguous_snapshot');
    var live = countUpToTwo(liveText, anchor);
    if (live.n === 0) return result('changed', 'not_found');
    if (live.n > 1) return result('changed', 'ambiguous_live');
    return { rs: s.cpLength(liveText.slice(0, live.at)) + (start - a) };
  }

  function locate(target, ctx) {
    var s = S();
    var live = ctx.live;
    var liveText = live.text;
    var rs;
    var re;
    var width = target.end - target.start;
    if (!(width >= 0)) return result('unplaceable', 'out_of_range');

    if (sameText(ctx)) {
      rs = target.start;
      re = target.end;
      if (rs < 0 || re > s.cpLength(liveText)) return result('unplaceable', 'out_of_range');
    } else {
      if (typeof ctx.snapshot !== 'string' || !ctx.snapshot) return result('unplaceable', 'no_snapshot');
      if (target.kind === 'edit') {
        var p = target.passage || { start: target.start, end: target.end, text: target.text };
        if (target.start < p.start || target.end > p.end) return result('unplaceable', 'edit_outside_passage');
        var found = relocate(ctx.snapshot, liveText, p.start, p.end, p.text);
        if (found.status) return found;
        if (target.text !== null && target.text !== undefined &&
            s.cpSlice(ctx.snapshot, target.start, target.end) !== target.text) {
          return result('unplaceable', 'snapshot_mismatch');
        }
        rs = found.rs + (target.start - p.start);
      } else {
        var got = relocate(ctx.snapshot, liveText, target.start, target.end, target.text);
        if (got.status) return got;
        rs = got.rs;
      }
      re = rs + width;
    }

    if (target.text !== null && target.text !== undefined && s.cpSlice(liveText, rs, re) !== target.text) {
      return result('changed', 'text_differs');
    }
    var mapped = s.toRestRanges(live.pieces, rs, re, liveText);
    if (!mapped) return result('unplaceable', 'unmapped');
    return { status: 'placed', reason: null, rs: rs, re: re, ranges: mapped.ranges,
             applicable: isApplicable(target, live, rs, re, mapped) };
  }

  // One clean text piece, no line break in the words or the replacement (the .docx writer's rules).
  function isApplicable(target, live, rs, re, mapped) {
    if (target.kind !== 'edit' || re <= rs) return false;
    if (typeof target.replacement !== 'string' || typeof target.text !== 'string') return false;
    if (NEWLINE.test(target.text) || NEWLINE.test(target.replacement)) return false;
    if (!mapped.clean || mapped.ranges.length !== 1) return false;
    var inside = live.pieces.filter(function (p) { return p.rs < re && p.re > rs; });
    if (inside.length !== 1) return false;
    var piece = inside[0];
    return piece.kind === 'text' && !piece.flags.suggested && !piece.flags.atomic && !piece.flags.link;
  }

  // --- after an Apply ----------------------------------------------------------------------

  function shiftFor(edit, delta) {
    return function (cp) {
      if (cp <= edit.start) return cp;
      if (cp >= edit.end) return cp + delta;
      return null; // inside the replaced words: no longer a position in the snapshot
    };
  }

  // The snapshot with edit's replacement made. null when the snapshot does not hold edit.text there.
  function applyToSnapshot(snapshot, edit) {
    var s = S();
    if (typeof snapshot !== 'string' || typeof edit.replacement !== 'string') return null;
    if (edit.start < 0 || edit.end < edit.start || edit.end > s.cpLength(snapshot)) return null;
    if (typeof edit.text === 'string' && s.cpSlice(snapshot, edit.start, edit.end) !== edit.text) return null;
    var next = s.cpSlice(snapshot, 0, edit.start) + edit.replacement + s.cpSlice(snapshot, edit.end);
    var delta = s.cpLength(edit.replacement) - (edit.end - edit.start);
    return { snapshot: next, shift: shiftFor(edit, delta) };
  }

  // Maps one range {start, end, text?} through one applied edit; null when they partly overlap.
  function mapRange(r, a) {
    var s = S();
    var delta = s.cpLength(a.replacement) - (a.end - a.start);
    if (r.end <= a.start && !(a.start === a.end && r.start === a.start && r.end > r.start)) {
      return withRange(r, r.start, r.end, r.text);
    }
    if (r.start >= a.end && r.start > a.start) {
      return withRange(r, r.start + delta, r.end + delta, r.text);
    }
    if (r.start <= a.start && r.end >= a.end) {
      var text = typeof r.text === 'string'
        ? s.cpSlice(r.text, 0, a.start - r.start) + a.replacement + s.cpSlice(r.text, a.end - r.start)
        : r.text;
      return withRange(r, r.start, r.end + delta, text);
    }
    return null;
  }

  function withRange(r, start, end, text) {
    var out = {};
    for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k)) out[k] = r[k];
    out.start = start;
    out.end = end;
    if ('text' in r) out.text = text;
    return out;
  }

  // A stored target mapped through every applied edit, in the order they were applied (each edit
  // in the snapshot's coordinates at its time). null when an Apply rewrote part of its words.
  // Returns a new object; the stored target is never changed, so it can be rebased again.
  function rebase(target, applied) {
    var t = withRange(target, target.start, target.end, target.text);
    if (target.passage) t.passage = withRange(target.passage, target.passage.start, target.passage.end, target.passage.text);
    for (var i = 0; i < applied.length && t; i++) {
      var a = applied[i];
      var moved = mapRange(t, a);
      if (!moved) return null;
      if (t.passage) {
        var passage = mapRange(t.passage, a);
        if (!passage) return null;
        moved.passage = passage;
      }
      t = moved;
    }
    return t;
  }

  return {
    locate: locate,
    applyToSnapshot: applyToSnapshot,
    rebase: rebase,
    claimTarget: claimTarget,
    editTarget: editTarget,
    citationTarget: citationTarget,
    CONTEXT_CP: CONTEXT_CP
  };
})();
if (typeof module !== 'undefined') { module.exports = LenzPlace; }
