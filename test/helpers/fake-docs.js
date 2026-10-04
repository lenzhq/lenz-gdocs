// Test-only in-memory Google Docs: the REST Document shape serialize.js reads, and batchUpdate with
// insertText / deleteContentRange + writeControl.requiredRevisionId, shaped like the Apps Script
// Advanced Docs service (`Docs.Documents.get` / `.batchUpdate`). Indexes are UTF-16 code units.
//
// Model: a doc has tabs; a tab has blocks; a block is a paragraph ({runs: [{text, url?}]}, text
// without its closing "\n") or a table ({table: [[cellBlocks]]}). Layout follows
// test/fixtures/docs/build.js (feat/serialize): the body opens with a sectionBreak ending at 1, a
// table takes 1 index to open, 1 per row, 1 per cell, 1 to close.
//
// Edits work on a "segment": the consecutive paragraphs of one container (the body or one cell)
// between tables. An edit must stay inside one segment and may not remove its last "\n" (Google
// refuses deleting a cell's or the body's final newline, and the newline before a table). Inserted
// text takes the style (link) of the character before it, as the Docs editor does. ⚑ The error
// messages and the stale-revision status are our best reading of Google's; confirm in the spike.
'use strict';

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function para(runs) { return { runs: runs.filter(function (r) { return r.text; }) }; }

// Plain review-style text → blocks: paragraphs split on "\n\n", `[words](url)` → a linked run, a
// single "\n" inside a paragraph → a soft break (Docs' "\u000b", which serialize reads back as "\n").
function blocksFromText(text) {
  return text.replace(/\n+$/, '').split('\n\n').map(function (p) {
    p = p.replace(/\n/g, '\u000b');
    var runs = [];
    var re = /\[([^\]\n]*)\]\(([^)\s]*)\)/g;
    var at = 0;
    var m;
    while ((m = re.exec(p)) !== null) {
      runs.push({ text: p.slice(at, m.index) });
      runs.push({ text: m[1], url: m[2] });
      at = m.index + m[0].length;
    }
    runs.push({ text: p.slice(at) });
    return para(runs);
  });
}

function paraText(b) { return b.runs.map(function (r) { return r.text; }).join(''); }

// ── layout: model → REST JSON, plus the list of editable segments ─────────────────────────────

function layoutParagraph(b, at) {
  var elements = [];
  var runs = b.runs.length ? b.runs : [{ text: '' }];
  runs.forEach(function (r, i) {
    var content = r.text + (i === runs.length - 1 ? '\n' : '');
    var textStyle = r.url ? { link: { url: r.url } } : {};
    elements.push({ startIndex: at, endIndex: at + content.length, textRun: { content: content, textStyle: textStyle } });
    at += content.length;
  });
  return {
    json: { startIndex: elements[0].startIndex, endIndex: at,
            paragraph: { elements: elements, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } } },
    end: at
  };
}

// Lays out one container; pushes each run of consecutive paragraphs as a segment.
function layoutContainer(blocks, at, segments) {
  var content = [];
  var seg = null;
  blocks.forEach(function (b, i) {
    if (b.table) {
      seg = null;
      var start = at;
      at += 1;
      var tableRows = b.table.map(function (row) {
        var rowStart = at;
        at += 1;
        var tableCells = row.map(function (cell) {
          var cellStart = at;
          var inner = layoutContainer(cell, at + 1, segments);
          at = inner.end;
          return { startIndex: cellStart, endIndex: at, content: inner.content, tableCellStyle: {} };
        });
        return { startIndex: rowStart, endIndex: at, tableCells: tableCells };
      });
      at += 1;
      content.push({ startIndex: start, endIndex: at,
                     table: { rows: b.table.length, columns: b.table[0].length, tableRows: tableRows } });
      return;
    }
    if (!seg) { seg = { container: blocks, first: i, count: 0, start: at }; segments.push(seg); }
    var laid = layoutParagraph(b, at);
    content.push(laid.json);
    seg.count += 1;
    at = laid.end;
    seg.end = at;
  });
  return { content: content, end: at };
}

function layoutTab(tab) {
  var segments = [];
  var laid = layoutContainer(tab.blocks, 1, segments);
  return {
    body: { content: [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }].concat(laid.content) },
    segments: segments
  };
}

// ── editing a segment as a flat string of u16 units, each with its link ───────────────────────

function flatten(seg) {
  var s = '';
  var urls = [];
  for (var i = seg.first; i < seg.first + seg.count; i++) {
    seg.container[i].runs.forEach(function (r) {
      s += r.text;
      for (var k = 0; k < r.text.length; k++) urls.push(r.url || null);
    });
    s += '\n';
    urls.push(null);
  }
  return { s: s, urls: urls };
}

function rebuild(seg, flat) {
  var paras = [];
  var runs = [];
  var cur = null;
  for (var i = 0; i < flat.s.length; i++) {
    var ch = flat.s[i];
    if (ch === '\n') {
      paras.push(para(runs));
      runs = [];
      cur = null;
      continue;
    }
    var url = flat.urls[i];
    if (!cur || (cur.url || null) !== url) {
      cur = url ? { text: '', url: url } : { text: '' };
      runs.push(cur);
    }
    cur.text += ch;
  }
  var args = [seg.first, seg.count].concat(paras);
  Array.prototype.splice.apply(seg.container, args);
}

function isHigh(c) { return c >= 0xd800 && c <= 0xdbff; }
function isLow(c) { return c >= 0xdc00 && c <= 0xdfff; }
function splitsPair(s, off) {
  return off > 0 && off < s.length && isHigh(s.charCodeAt(off - 1)) && isLow(s.charCodeAt(off));
}

function DocsError(status, message) {
  var e = new Error('API call to docs.documents.batchUpdate failed with error: ' + message);
  e.details = { code: 400, status: status, message: message };
  e.body = { error: { code: 400, message: message, status: status } };
  return e;
}

function findSegment(segments, start, end) {
  for (var i = 0; i < segments.length; i++) {
    var g = segments[i];
    if (start >= g.start && end <= g.end) return g;
  }
  return null;
}

function insertText(tab, req) {
  var index = req.location && req.location.index;
  var text = req.text;
  if (typeof text !== 'string' || typeof index !== 'number') throw DocsError('INVALID_ARGUMENT', 'Invalid requests[0].insertText');
  var seg = findSegment(layoutTab(tab).segments, index, index + 1);
  if (!seg) throw DocsError('INVALID_ARGUMENT', 'The insertion index must be inside the bounds of an existing paragraph.');
  var flat = flatten(seg);
  var off = index - seg.start;
  if (splitsPair(flat.s, off)) throw DocsError('INVALID_ARGUMENT', 'The insertion index cannot be within a surrogate pair.');
  var url = off > 0 && flat.s[off - 1] !== '\n' ? flat.urls[off - 1] : null;
  var add = [];
  for (var k = 0; k < text.length; k++) add.push(text[k] === '\n' ? null : url);
  flat.s = flat.s.slice(0, off) + text + flat.s.slice(off);
  Array.prototype.splice.apply(flat.urls, [off, 0].concat(add));
  rebuild(seg, flat);
}

function deleteContentRange(tab, req) {
  var r = req.range || {};
  if (typeof r.startIndex !== 'number' || typeof r.endIndex !== 'number' || r.endIndex <= r.startIndex) {
    throw DocsError('INVALID_ARGUMENT', 'Invalid deletion range.');
  }
  var seg = findSegment(layoutTab(tab).segments, r.startIndex, r.endIndex);
  if (!seg || r.endIndex >= seg.end) {
    throw DocsError('INVALID_ARGUMENT', 'Invalid deletion range. Cannot delete the requested range.');
  }
  var flat = flatten(seg);
  var a = r.startIndex - seg.start;
  var b = r.endIndex - seg.start;
  if (splitsPair(flat.s, a) || splitsPair(flat.s, b)) {
    throw DocsError('INVALID_ARGUMENT', 'The deletion range cannot split a surrogate pair.');
  }
  flat.s = flat.s.slice(0, a) + flat.s.slice(b);
  flat.urls.splice(a, b - a);
  rebuild(seg, flat);
}

// ── the service ───────────────────────────────────────────────────────────────────────────────

function createFakeDocs() {
  var docs = {};
  var counter = 0;
  var log = [];
  var beforeBatch = []; // one-shot hooks: a co-author's edit landing between a read and a write

  // spec: { title, tabs: [{ tabId, title, blocks }] } or { title, text } (one tab from review text).
  function create(spec) {
    counter += 1;
    var id = spec.documentId || 'doc-' + counter;
    var tabs = spec.tabs || [{ tabId: 't.0', title: 'Tab 1', blocks: blocksFromText(spec.text || '') }];
    docs[id] = { documentId: id, title: spec.title || id, rev: 1,
                 tabs: tabs.map(function (t) { return { tabId: t.tabId, title: t.title || t.tabId, blocks: clone(t.blocks) }; }) };
    return id;
  }

  function need(id) {
    if (!docs[id]) {
      var e = new Error('API call to docs.documents.get failed with error: Requested entity was not found.');
      e.details = { code: 404, status: 'NOT_FOUND' };
      throw e;
    }
    return docs[id];
  }

  function revisionId(d) { return 'rev-' + d.documentId + '-' + d.rev; }

  function tabOf(d, tabId) {
    if (!tabId) return d.tabs[0];
    for (var i = 0; i < d.tabs.length; i++) if (d.tabs[i].tabId === tabId) return d.tabs[i];
    throw DocsError('INVALID_ARGUMENT', 'Invalid tab id: ' + tabId);
  }

  function get(id, opts) {
    var d = need(id);
    opts = opts || {};
    log.push({ op: 'get', id: id, opts: clone(opts) });
    // `fields`: a partial response (top-level names only, which is all the glue asks for).
    if (opts.fields) {
      var full = get(id, { includeTabsContent: true, suggestionsViewMode: opts.suggestionsViewMode });
      log.pop();
      var part = {};
      String(opts.fields).split(',').forEach(function (f) { f = f.trim(); if (f in full) part[f] = full[f]; });
      return part;
    }
    var out = { documentId: d.documentId, title: d.title, revisionId: revisionId(d),
                suggestionsViewMode: opts.suggestionsViewMode || 'DEFAULT_FOR_CURRENT_ACCESS' };
    if (opts.includeTabsContent) {
      out.tabs = d.tabs.map(function (t, i) {
        return { tabProperties: { tabId: t.tabId, title: t.title, index: i },
                 documentTab: { body: layoutTab(t).body } };
      });
    } else {
      out.body = layoutTab(d.tabs[0]).body;
    }
    return out;
  }

  function batchUpdate(resource, id) {
    var d = need(id);
    var hook = beforeBatch.shift();
    if (hook) hook(id);
    log.push({ op: 'batchUpdate', id: id, resource: clone(resource) });
    var wc = resource.writeControl || {};
    if (wc.requiredRevisionId && wc.requiredRevisionId !== revisionId(d)) {
      throw DocsError('FAILED_PRECONDITION',
        'The required revision ID ' + wc.requiredRevisionId + ' does not match the latest revision.');
    }
    // All or nothing: work on a copy, commit at the end.
    var work = clone(d.tabs);
    (resource.requests || []).forEach(function (req) {
      if (req.insertText) {
        insertText(tabOfList(work, req.insertText.location && req.insertText.location.tabId), req.insertText);
      } else if (req.deleteContentRange) {
        deleteContentRange(tabOfList(work, req.deleteContentRange.range && req.deleteContentRange.range.tabId),
          req.deleteContentRange);
      } else {
        throw DocsError('INVALID_ARGUMENT', 'fake-docs supports insertText and deleteContentRange only');
      }
    });
    d.tabs = work;
    d.rev += 1;
    return { documentId: id, replies: (resource.requests || []).map(function () { return {}; }),
             writeControl: { requiredRevisionId: revisionId(d) } };
  }

  function tabOfList(tabs, tabId) {
    if (!tabId) return tabs[0];
    for (var i = 0; i < tabs.length; i++) if (tabs[i].tabId === tabId) return tabs[i];
    throw DocsError('INVALID_ARGUMENT', 'Invalid tab id: ' + tabId);
  }

  // Test conveniences (not part of the Docs API).
  function textOf(id, tabId) { // paragraphs joined by "\n", tables' cells in order, no link syntax
    var out = [];
    (function walk(blocks) {
      blocks.forEach(function (b) {
        if (b.table) b.table.forEach(function (row) { row.forEach(walk); });
        else out.push(paraText(b));
      });
    })(tabOf(need(id), tabId).blocks);
    return out.join('\n');
  }
  // Every text character of the tab (u16) with its REST index, in document order.
  function restChars(id, tabId) {
    var body = get(id, { includeTabsContent: true }).tabs.filter(function (t) {
      return !tabId || t.tabProperties.tabId === tabId;
    })[0].documentTab.body;
    var s = '';
    var idx = [];
    (function walk(content) {
      content.forEach(function (el) {
        if (el.paragraph) {
          el.paragraph.elements.forEach(function (e) {
            var c = e.textRun.content;
            for (var k = 0; k < c.length; k++) { s += c[k]; idx.push(e.startIndex + k); }
          });
        } else if (el.table) {
          el.table.tableRows.forEach(function (r) { r.tableCells.forEach(function (c) { walk(c.content); }); });
        }
      });
    })(body.content);
    return { s: s, idx: idx };
  }
  function rangeText(id, tabId, startIndex, endIndex) { // the text at REST indexes [start, end)
    var rc = restChars(id, tabId);
    var out = '';
    for (var i = 0; i < rc.s.length; i++) if (rc.idx[i] >= startIndex && rc.idx[i] < endIndex) out += rc.s[i];
    return out;
  }
  function revision(id) { return revisionId(need(id)); }
  // Runs fn(docId) at the start of the next batchUpdate, before its revision check.
  function onBeforeNextBatch(fn) { beforeBatch.push(fn); }
  // A co-author's edit: replace the first (or last) occurrence of `from` in the tab (u16 search over the REST
  // text) with `to`, as one unconditioned batchUpdate. Returns false when `from` is not there.
  // opts.last: the last occurrence instead of the first.
  function coauthorReplace(id, from, to, tabId, opts) {
    var rc = restChars(id, tabId);
    var at = opts && opts.last ? rc.s.lastIndexOf(from) : rc.s.indexOf(from);
    if (at === -1) return false;
    var start = rc.idx[at];
    var reqs = [];
    if (to) reqs.push({ insertText: { text: to, location: { index: start + from.length, tabId: tabId } } });
    reqs.push({ deleteContentRange: { range: { startIndex: start, endIndex: start + from.length, tabId: tabId } } });
    batchUpdateRaw(reqs, id);
    return true;
  }
  function batchUpdateRaw(requests, id) {
    var hooks = beforeBatch.splice(0);
    try { return batchUpdate({ requests: requests }, id); } finally { Array.prototype.push.apply(beforeBatch, hooks); }
  }

  return {
    Documents: { get: get, batchUpdate: batchUpdate },
    create: create,
    textOf: textOf,
    rangeText: rangeText,
    revision: revision,
    onBeforeNextBatch: onBeforeNextBatch,
    coauthorReplace: coauthorReplace,
    log: log
  };
}

module.exports = { createFakeDocs: createFakeDocs, blocksFromText: blocksFromText };
