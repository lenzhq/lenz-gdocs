// Docs REST Document → the text a Lenz review reads, plus the map back into the Doc.
// Rules mirror Lenz's own .docx reader (a Doc uploaded as .docx), so one Doc gives one text either way.
var LenzSerialize = (function () {
  'use strict';

  var CAP = 50000; // code points, the /review text limit

  // ---- code point helpers (cp = code points, u16 = UTF-16 code units) ----

  function isHigh(c) { return c >= 0xd800 && c <= 0xdbff; }
  function isLow(c) { return c >= 0xdc00 && c <= 0xdfff; }

  function cpLength(s) {
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      if (isHigh(s.charCodeAt(i)) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) i++;
      n++;
    }
    return n;
  }

  // The u16 index of code point `cp` in `s`; cp may equal cpLength(s).
  function cpToU16(s, cp) {
    if (cp < 0) throw new RangeError('cp out of range');
    var i = 0;
    for (var n = 0; n < cp; n++) {
      if (i >= s.length) throw new RangeError('cp out of range');
      if (isHigh(s.charCodeAt(i)) && i + 1 < s.length && isLow(s.charCodeAt(i + 1))) i += 2;
      else i += 1;
    }
    return i;
  }

  function cpSlice(s, start, end) {
    var a = cpToU16(s, start);
    if (end === undefined || end === null) return s.slice(a);
    // Walk on from `a` rather than from 0.
    return s.slice(a, a + cpToU16(s.slice(a), end - start));
  }

  // ---- reading the Doc ----

  function flattenTabs(tabs, out) {
    for (var i = 0; i < (tabs || []).length; i++) {
      out.push(tabs[i]);
      flattenTabs(tabs[i].childTabs, out);
    }
    return out;
  }

  function has(list) { return !!(list && list.length); }

  // A header or footer holds text when this reader would read some (suggested deletions out).
  function segmentHasText(segment, positioned) {
    var state = newState(positioned);
    readContent((segment && segment.content) || [], { del: false, ins: false }, state);
    return state.paragraphs.some(function (p) {
      return p.hasText && p.segs.some(function (s) { return s.kind === 'text' && /\S/.test(s.text); });
    });
  }

  function newState(positioned) {
    return { ordinal: 0, paragraphs: [], positioned: positioned || {},
      notRead: { footnotes: 0, headers: 0, footers: 0, images: 0, equations: 0, otherChips: 0, otherTabs: 0 } };
  }

  // A read paragraph: its segments before joining. Segment = one future piece.
  function readParagraph(p, endIndex, ordinal, ctx, state) {
    var notRead = state.notRead;
    var segs = [];
    var hasText = false;
    var elements = p.elements || [];
    var openLink = null; // the url of the run being read: every linked run is its own [words](url),
                         // as the .docx export writes one hyperlink per run (spike, 2026-09-30)

    function closeLink() {
      if (openLink) {
        segs.push({ kind: 'synthetic', text: '](' + openLink + ')', ds: null, de: null,
          flags: { suggested: false, atomic: false, link: true }, groupEnd: true });
        openLink = null;
      }
    }

    function deleted(x) { return ctx.del || has(x.suggestedDeletionIds); }
    function inserted(x) { return ctx.ins || has(x.suggestedInsertionIds); }

    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      var run = el.textRun;
      if (run) {
        if (deleted(run)) continue; // out, as a w:del run; the gap shows in the u16 map
        var content = run.content || '';
        if (content.charAt(content.length - 1) === '\n' && el.endIndex === endIndex) {
          content = content.slice(0, -1);
        }
        if (!content) continue;
        var link = run.textStyle && run.textStyle.link;
        var url = link && typeof link.url === 'string' && link.url ? link.url : null;
        closeLink();
        if (url) {
          segs.push({ kind: 'synthetic', text: '[', ds: null, de: null,
            flags: { suggested: false, atomic: false, link: true }, groupStart: true });
          openLink = url;
        }
        if (/[^\t\u000b\ue907]/.test(content)) hasText = true;
        // U+E907 stands in for content the API does not return as text: not read, and its
        // index stays a gap in the map, so a range across it is not clean.
        var parts = content.split('\ue907');
        var offset = 0;
        for (var j = 0; j < parts.length; j++) {
          if (j > 0) { notRead.otherChips++; offset += 1; }
          if (parts[j]) {
            segs.push({ kind: 'text', text: parts[j].replace(/\u000b/g, '\n'), ds: el.startIndex + offset,
              de: el.startIndex + offset + parts[j].length,
              flags: { suggested: inserted(run), atomic: false, link: !!url } });
          }
          offset += parts[j].length;
        }
        closeLink();
        continue;
      }
      closeLink();
      var chip = el.richLink || el.person || el.dateElement || el.pageBreak || el.columnBreak ||
        el.footnoteReference || el.inlineObjectElement || el.equation || el.autoText || el.horizontalRule;
      if (chip && deleted(chip)) continue;
      var sug = !!chip && inserted(chip);
      if (el.richLink) {
        var props = el.richLink.richLinkProperties || {};
        var title = props.title || props.uri || '';
        hasText = hasText || !!title;
        segs.push({ kind: 'synthetic', text: '[', ds: null, de: null,
          flags: { suggested: false, atomic: false, link: true }, groupStart: true });
        segs.push({ kind: 'text', text: title, ds: el.startIndex, de: el.endIndex,
          flags: { suggested: sug, atomic: true, link: true } });
        segs.push({ kind: 'synthetic', text: '](' + (props.uri || '') + ')', ds: null, de: null,
          flags: { suggested: false, atomic: false, link: true }, groupEnd: true });
      } else if (el.person && (el.person.personProperties || {}).email) {
        // The .docx export writes a Person chip as a mailto link on the name (spike, 2026-09-30).
        var pp = el.person.personProperties;
        hasText = true;
        segs.push({ kind: 'synthetic', text: '[', ds: null, de: null,
          flags: { suggested: false, atomic: false, link: true }, groupStart: true });
        segs.push({ kind: 'text', text: pp.name || pp.email, ds: el.startIndex, de: el.endIndex,
          flags: { suggested: sug, atomic: true, link: true } });
        segs.push({ kind: 'synthetic', text: '](mailto:' + pp.email + ')', ds: null, de: null,
          flags: { suggested: false, atomic: false, link: true }, groupEnd: true });
      } else if (el.person || el.dateElement) {
        var shown = el.person
          ? (el.person.personProperties || {}).name || ''
          : (el.dateElement.dateElementProperties || {}).displayText || '';
        if (!shown) continue;
        hasText = true;
        segs.push({ kind: 'text', text: shown, ds: el.startIndex, de: el.endIndex,
          flags: { suggested: sug, atomic: true, link: false }, group: true });
      } else if (el.pageBreak || el.columnBreak) {
        // The .docx export writes <w:br w:type="page"/>, which Lenz's .docx reader reads as a line break.
        segs.push({ kind: 'text', text: '\n', ds: el.startIndex, de: el.endIndex,
          flags: { suggested: sug, atomic: true, link: false } });
      } else if (el.footnoteReference) notRead.footnotes++;
      else if (el.inlineObjectElement) notRead.images++;
      else if (el.equation) notRead.equations++;
      else if (el.horizontalRule) { /* a line, not text */ }
      else notRead.otherChips++; // autoText and any element this reader does not know
    }
    closeLink();
    (p.positionedObjectIds || []).forEach(function (id) {
      var po = state.positioned[id];
      if (!ctx.del && !(po && has(po.suggestedDeletionIds))) notRead.images++;
    });
    return { ordinal: ordinal, segs: segs, hasText: hasText };
  }

  function readContent(content, ctx, state) {
    for (var i = 0; i < content.length; i++) {
      var se = content[i];
      if (se.paragraph) {
        state.paragraphs.push(readParagraph(se.paragraph, se.endIndex, state.ordinal++, ctx, state));
      } else if (se.table) {
        var tctx = mergeCtx(ctx, se.table);
        (se.table.tableRows || []).forEach(function (row) {
          var rctx = mergeCtx(tctx, row);
          (row.tableCells || []).forEach(function (cell) {
            readContent(cell.content || [], mergeCtx(rctx, cell), state);
          });
        });
      } else if (se.tableOfContents) {
        readContent(se.tableOfContents.content || [], mergeCtx(ctx, se.tableOfContents), state);
      }
      // sectionBreak: nothing to read
    }
  }

  function mergeCtx(ctx, node) {
    return { del: ctx.del || has(node.suggestedDeletionIds), ins: ctx.ins || has(node.suggestedInsertionIds) };
  }

  function serialize(doc, tabId) {
    var tabs = flattenTabs(doc.tabs, []);
    if (!tabs.length) throw new Error('document has no tabs (fetch with includeTabsContent: true)');
    var tab = tabs[0];
    if (tabId !== null && tabId !== undefined) {
      tab = null;
      for (var i = 0; i < tabs.length; i++) {
        if (tabs[i].tabProperties && tabs[i].tabProperties.tabId === tabId) tab = tabs[i];
      }
      if (!tab) throw new Error('no tab with this id');
    }
    var dt = tab.documentTab || {};
    var state = newState(dt.positionedObjects);
    var notRead = state.notRead;
    notRead.otherTabs = tabs.length - 1;
    Object.keys(dt.headers || {}).forEach(function (k) {
      if (segmentHasText(dt.headers[k], dt.positionedObjects)) notRead.headers++;
    });
    Object.keys(dt.footers || {}).forEach(function (k) {
      if (segmentHasText(dt.footers[k], dt.positionedObjects)) notRead.footers++;
    });
    readContent((dt.body && dt.body.content) || [], { del: false, ins: false }, state);

    // Join: paragraphs with text, one blank line between (as Lenz's .docx reader).
    var pieces = [];
    var groups = []; // cp ranges the cap never cuts inside: [..](..), chips, paragraph breaks
    var chunks = [];
    var pos = 0;
    var prev = null;
    state.paragraphs.forEach(function (para) {
      if (!para.hasText) return;
      if (prev !== null) {
        pieces.push({ rs: pos, re: pos + 2, ds: null, de: null, kind: 'synthetic',
          flags: { suggested: false, atomic: false, link: false }, para: prev });
        groups.push([pos, pos + 2, true]);
        chunks.push('\n\n');
        pos += 2;
      }
      var groupStart = null;
      para.segs.forEach(function (s) {
        var n = cpLength(s.text);
        if (s.groupStart) groupStart = pos;
        if (s.group) groups.push([pos, pos + n, false]);
        if (n) {
          pieces.push({ rs: pos, re: pos + n, ds: s.ds, de: s.de, kind: s.kind, flags: s.flags, para: para.ordinal });
        }
        chunks.push(s.text);
        pos += n;
        if (s.groupEnd) { groups.push([groupStart, pos, false]); groupStart = null; }
      });
      prev = para.ordinal;
    });
    var text = chunks.join('');
    var truncated = false;

    if (pos > CAP) {
      truncated = true;
      var cut = CAP;
      // Link syntax typed in the Doc is protected too: find [..](..) around the cut.
      var ws = Math.max(0, CAP - 4000);
      var windowText = cpSlice(text, ws, Math.min(pos, CAP + 4000));
      var literal = /\[[^\[\]\n]*\]\([^()\s]*\)/g;
      var m;
      while ((m = literal.exec(windowText)) !== null) {
        var ls = ws + cpLength(windowText.slice(0, m.index));
        groups.push([ls, ls + cpLength(m[0]), false]);
      }
      var moved = true;
      while (moved) {
        moved = false;
        for (var g = 0; g < groups.length; g++) {
          var gs = groups[g][0], ge = groups[g][1], isBreak = groups[g][2];
          // Inside a group, or right after a trailing paragraph break: back to its start.
          if ((gs < cut && cut < ge) || (isBreak && ge === cut && gs < cut)) { cut = gs; moved = true; }
        }
      }
      text = cpSlice(text, 0, cut);
      var kept = [];
      for (var k = 0; k < pieces.length; k++) {
        var pc = pieces[k];
        if (pc.rs >= cut) break;
        if (pc.re > cut) {
          // Only a plain text piece can straddle the cut (groups never do).
          var within = cpSlice(text, pc.rs, cut).length;
          pc = { rs: pc.rs, re: cut, ds: pc.ds, de: pc.ds + within, kind: pc.kind, flags: pc.flags, para: pc.para };
        }
        kept.push(pc);
      }
      pieces = kept;
    }

    return {
      text: text,
      textHash: null,
      tabId: (tab.tabProperties && tab.tabProperties.tabId) || '',
      revisionId: doc.revisionId || '',
      truncated: truncated,
      notRead: notRead,
      pieces: pieces,
    };
  }

  // ---- the map, cp → REST ----

  function toRestRanges(pieces, rs, re, text) {
    if (!pieces.length || rs < 0 || re < rs || rs < pieces[0].rs || re > pieces[pieces.length - 1].re) return null;
    var ranges = [];
    var clean = true;
    var para = null;
    var lastEnd = null; // u16 end of the previous doc-backed piece in the range
    var touched = false;
    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      var overlaps = rs === re ? (p.rs <= rs && rs < p.re) : (p.re > rs && p.rs < re);
      if (!overlaps) continue;
      touched = true;
      if (para === null) para = p.para;
      else if (p.para !== para) clean = false;
      if (p.kind === 'synthetic' || p.ds === null) { clean = false; lastEnd = null; continue; }
      if (p.flags.atomic || p.flags.suggested) clean = false;
      var s, e;
      if (p.flags.atomic) { s = p.ds; e = p.de; }
      else {
        var pieceText = cpSlice(text, p.rs, p.re);
        s = p.ds + cpToU16(pieceText, Math.max(rs, p.rs) - p.rs);
        e = p.ds + cpToU16(pieceText, Math.min(re, p.re) - p.rs);
      }
      if (lastEnd !== null && s !== lastEnd) clean = false; // doc content skipped (a deletion, a footnote)
      var last = ranges[ranges.length - 1];
      if (last && last.endIndex === s) last.endIndex = e;
      else ranges.push({ startIndex: s, endIndex: e });
      lastEnd = e;
    }
    if (!touched) return null;
    return { ranges: ranges, clean: clean };
  }

  return {
    CAP: CAP,
    serialize: serialize,
    cpLength: cpLength,
    cpSlice: cpSlice,
    cpToU16: cpToU16,
    toRestRanges: toRestRanges,
  };
})();
if (typeof module !== 'undefined') { module.exports = LenzSerialize; }
