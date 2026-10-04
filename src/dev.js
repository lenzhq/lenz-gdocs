// Spike tooling (the phase 0 checks against real Docs), run with `clasp run` or from the dev menu. Apps Script only:
// the logic it checks with lives in spike.js (pure, tested in Node). Every entry point returns a
// JSON string, which `clasp run` prints and scripts/spike-report.js reads.

var LENZ_DEV_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function lenzDev_json_(value) {
  var s = JSON.stringify(value);
  Logger.log(s.length > 90000 ? s.slice(0, 90000) + '…' : s);
  return s;
}

function lenzDev_batch_(docId, body) {
  return Docs.Documents.batchUpdate(body, docId);
}

// Tries one batchUpdate; records what happened instead of stopping the build.
function lenzDev_try_(log, name, docId, body) {
  try {
    var reply = lenzDev_batch_(docId, body);
    log.push({ step: name, ok: true });
    return reply;
  } catch (e) {
    log.push({ step: name, ok: false, error: String(e && e.message || e) });
    return null;
  }
}

function lenzDev_get_(docId) {
  // A plain object, as the Node tests see it.
  return JSON.parse(JSON.stringify(Docs.Documents.get(docId,
    { includeTabsContent: true, suggestionsViewMode: 'SUGGESTIONS_INLINE' })));
}

// 1. The spike Doc: every case the Docs API can create. Returns { url, docId, steps, manual }.
function lenzDev_buildSpikeDoc() {
  var plan = LenzSpike.buildPlan();
  var created = Docs.Documents.create({ title: plan.title + ' ' + new Date().toISOString().slice(0, 16) });
  var docId = created.documentId;
  var steps = [];
  lenzDev_try_(steps, 'text, links, styles, list', docId, { requests: LenzSpike.textRequests(plan) });
  plan.structural.forEach(function (item) {
    var reply = lenzDev_try_(steps, item.kind, docId, { requests: LenzSpike.structuralRequests(item) });
    if (item.kind === 'footnote' && reply) {
      var footnoteId = reply.replies[0].createFootnote.footnoteId;
      lenzDev_try_(steps, 'footnote text', docId, { requests: [{ insertText: {
        endOfSegmentLocation: { segmentId: footnoteId }, text: item.text } }] });
    }
  });
  var doc = lenzDev_get_(docId);
  var tabId = LenzSpike.findTab(doc, null).tabProperties.tabId;
  var table = plan.structural.filter(function (s) { return s.kind === 'table'; })[0];
  var fill = LenzSpike.tableFillRequests(doc, tabId, table.cells);
  if (fill.length) lenzDev_try_(steps, 'table cells', docId, { requests: fill });

  var header = lenzDev_try_(steps, 'header', docId, { requests: [{ createHeader: { type: 'DEFAULT' } }] });
  if (header) {
    lenzDev_try_(steps, 'header text', docId, { requests: [{ insertText: {
      location: { segmentId: header.replies[0].createHeader.headerId, index: 0 }, text: plan.header } }] });
  }
  var tab = lenzDev_try_(steps, 'second tab (addDocumentTab)', docId, { requests: [{ addDocumentTab: {
    tabProperties: { title: plan.secondTab.title } } }] });
  if (tab) {
    var newTab = tab.replies[0].addDocumentTab.tabProperties.tabId;
    lenzDev_try_(steps, 'second tab text', docId, { requests: [{ insertText: {
      location: { tabId: newTab, index: 1 }, text: plan.secondTab.text } }] });
  }
  return lenzDev_json_({ kind: 'lenz-spike-build', docId: docId,
    url: 'https://docs.google.com/document/d/' + docId + '/edit', steps: steps,
    manual: plan.manual.concat(steps.filter(function (s) { return !s.ok; }).map(function (s) {
      return 'by hand, the API refused it: ' + s.step;
    })) });
}

// The Doc as .docx (the export Lenz's .docx reader reads), base64; drive.file covers a Doc this script made.
function lenzDev_exportDocx_(docId) {
  var url = 'https://www.googleapis.com/drive/v3/files/' + docId + '/export?mimeType=' + encodeURIComponent(LENZ_DEV_DOCX);
  var r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) throw new Error('export ' + r.getResponseCode() + ': ' + r.getContentText().slice(0, 300));
  return Utilities.base64Encode(r.getContent());
}

// DocumentApp reaches only the open Doc (documents.currentonly; openById would need `documents`), so
// the DocumentApp half of the check runs from the menu in the spike Doc itself.
function lenzDev_documentAppBody_(docId, tabId) {
  var d = DocumentApp.getActiveDocument();
  if (!d || d.getId() !== docId) {
    throw new Error('open the spike Doc and use Dev tools → Spike → Check this spike Doc (DocumentApp reaches only the open Doc)');
  }
  var tab = d.getTab(tabId).asDocumentTab();
  return { doc: d, tab: tab, body: tab.getBody() };
}

// A paragraph's DocumentApp children as the glue reads them (Code.js): a Text element's
// characters, any other element (chip, page break, footnote mark) one U+FFFC.
function lenzDev_kids_(para) {
  var kids = [];
  for (var i = 0; i < para.getNumChildren(); i++) {
    var k = para.getChild(i);
    var isText = k.getType() === DocumentApp.ElementType.TEXT;
    var t = isText ? k.asText().getText() : '\ufffc';
    kids.push({ el: k, text: isText, length: t.length, shown: t });
  }
  return kids;
}

// DocumentApp paragraphs in the glue's order (Code.js lenzAppParagraphs_ when present).
function lenzDev_appParagraphs_(body) {
  return typeof lenzAppParagraphs_ === 'function' ? lenzAppParagraphs_(body) : body.getParagraphs();
}

// A DocumentApp range from a REST range, the glue's way: paragraph by ordinal, then its children
// (Code.js lenzChildSegments_ when present). rangeText = the text the range covers.
function lenzDev_range_(tab, body, paras, piece, restRange) {
  var p = lenzDev_appParagraphs_(body)[piece.para];
  var start = restRange.startIndex - paras[piece.para].startIndex;
  var end = restRange.endIndex - paras[piece.para].startIndex;
  var kids = lenzDev_kids_(p);
  var segs = typeof lenzChildSegments_ === 'function' ? lenzChildSegments_(kids, start, end) : null;
  if (!segs) throw new Error('Code.js lenzChildSegments_ is not loaded');
  var builder = tab.newRange();
  var shown = '';
  segs.forEach(function (seg) {
    var k = kids[seg.child];
    if (seg.whole) { builder.addElement(k.el); shown += '\ufffc'; }
    else { builder.addElement(k.el.asText(), seg.from, seg.to); shown += k.shown.slice(seg.from, seg.to + 1); }
  });
  return { range: builder.build(), rangeText: shown };
}

// 2. Reads, checks, selects, applies, provokes a conflict; returns the report + the REST dump + .docx.
function lenzDev_checkSpikeDoc(docId, tabId) {
  var out = { kind: 'lenz-spike-check', version: 1, docId: docId, at: new Date().toISOString() };
  var t0 = Date.now();
  var doc = lenzDev_get_(docId);
  var t1 = Date.now();
  // It edits the Doc (Applies, a conflict write): only ever a Doc lenzDev_buildSpikeDoc made.
  if (String(doc.title).indexOf('Lenz spike') !== 0) throw new Error('not a spike Doc (title must start "Lenz spike")');
  tabId = tabId || LenzSpike.findTab(doc, null).tabProperties.tabId;
  var ser = LenzSerialize.serialize(doc, tabId);
  out.timings = { restGetMs: t1 - t0, serializeMs: Date.now() - t1 };
  out.tabId = tabId;
  out.dump = doc;
  try { out.docx = lenzDev_exportDocx_(docId); } catch (e) { out.docxError = String(e.message || e); }

  var paras = LenzSpike.paragraphs(doc, tabId);
  var d = null;
  var dtab = null;
  var body = null;
  try {
    var opened = lenzDev_documentAppBody_(docId, tabId);
    d = opened.doc;
    dtab = opened.tab;
    body = opened.body;
    var appParas = lenzDev_appParagraphs_(body);
    out.documentApp = {
      // What the glue sees: children, non-text ones as U+FFFC (compared with REST).
      paragraphTexts: appParas.map(function (p) { return lenzDev_kids_(p).map(function (k) { return k.shown; }).join(''); }),
      // Paragraph.getText(), for the record: it leaves chips, page breaks and footnote marks out.
      getText: appParas.map(function (p) { return p.getText(); }),
    };
  } catch (e) {
    out.documentApp = { error: String(e.message || e) };
  }

  // Select: the first Apply target, the text after the Person chip, a table cell.
  out.select = [];
  if (body) {
    [['brown', 'quick brown fox'], ['after the chip', 'after the chip'], ['Cell B1', 'Cell B1']].forEach(function (w) {
      var loc = LenzSpike.locate(ser.text, w[0], w[1]);
      if (!loc) { out.select.push({ want: w[0], error: 'not in the text' }); return; }
      var map = LenzSerialize.toRestRanges(ser.pieces, loc.rs, loc.re, ser.text);
      var piece = ser.pieces.filter(function (p) { return p.rs <= loc.rs && loc.rs < p.re; })[0];
      var entry = { want: w[0], ranges: map && map.ranges, clean: map && map.clean };
      try {
        var r = lenzDev_range_(dtab, body, paras, piece, map.ranges[0]);
        entry.rangeText = r.rangeText;
        try { d.setSelection(r.range); entry.setSelection = 'ok'; } catch (e) { entry.setSelection = String(e.message || e); }
      } catch (e) {
        entry.error = String(e.message || e);
      }
      out.select.push(entry);
    });
  }

  // Apply each target on the current revision, then read it back.
  out.apply = [];
  var firstRevision = doc.revisionId;
  LenzSpike.APPLY_TARGETS.forEach(function (target) {
    var now = lenzDev_get_(docId);
    var s = LenzSerialize.serialize(now, tabId);
    var loc = LenzSpike.locate(s.text, target.find, target.within);
    var entry = { id: target.id, strategy: target.strategy, find: target.find, replacement: target.replacement };
    if (!loc) { entry.skipped = 'target not in the text (already applied?)'; out.apply.push(entry); return; }
    var map = LenzSerialize.toRestRanges(s.pieces, loc.rs, loc.re, s.text);
    entry.clean = map.clean;
    var range = map.ranges[0];
    var before = LenzSpike.runAt(now, tabId, range.startIndex);
    entry.before = { url: LenzSpike.linkUrl(before.textStyle), bold: !!before.textStyle.bold };
    try {
      var body2 = LenzSpike.applyBody(range, target.replacement, tabId, now.revisionId, target.strategy);
      if (target.strategy === 'end' && typeof lenzApplyRequests_ === 'function') {
        body2.requests = lenzApplyRequests_(range, target.replacement, tabId); // the add-on's own requests
        entry.via = 'Code.js lenzApplyRequests_';
      }
      lenzDev_batch_(docId, body2);
      var after = lenzDev_get_(docId);
      var sa = LenzSerialize.serialize(after, tabId);
      var run = LenzSpike.runAt(after, tabId, range.startIndex);
      entry.after = { url: LenzSpike.linkUrl(run.textStyle), bold: !!run.textStyle.bold, run: run.content };
      entry.textOk = sa.text.indexOf(target.within.replace(target.find, target.replacement)) >= 0;
      entry.linkKept = entry.after.url === entry.before.url;
      entry.boldKept = entry.after.bold === entry.before.bold;
    } catch (e) {
      entry.error = String(e.message || e);
    }
    out.apply.push(entry);
  });

  // A write on the revision read before the Applies: Google's conflict error, verbatim.
  try {
    lenzDev_batch_(docId, { requests: [{ insertText: { location: { index: 1, tabId: tabId }, text: 'X' } }],
      writeControl: { requiredRevisionId: firstRevision } });
    out.conflict = { error: null, note: 'the stale write was ACCEPTED (an X was inserted at index 1)' };
  } catch (e) {
    out.conflict = { error: String(e.message || e), details: e.details || null };
  }

  out.verdict = LenzSpike.evaluate(out, {}).items.map(function (i) { return i.id + ' ' + i.status; });
  return lenzDev_json_(out);
}

// Item 2: Google's egress to lenz.io, no key (no charge): what answers, and with which headers.
function lenzDev_probeEgress() {
  var ua = 'lenz-gdocs/0.1-spike';
  var calls = [
    { method: 'get', url: 'https://lenz.io/api/health/', expect: 200 },
    { method: 'get', url: 'https://lenz.io/api/v1/me/usage', expect: 401 },
    { method: 'post', url: 'https://lenz.io/api/v1/review', payload: JSON.stringify({ text: 'spike probe' }), expect: 401 },
  ];
  var results = calls.map(function (c) {
    var t = Date.now();
    try {
      var r = UrlFetchApp.fetch(c.url, { method: c.method, payload: c.payload, contentType: 'application/json',
        headers: { 'User-Agent': ua }, muteHttpExceptions: true, followRedirects: false });
      var h = r.getHeaders();
      return { url: c.url, method: c.method, expect: c.expect, code: r.getResponseCode(), ms: Date.now() - t,
        headers: { 'content-type': h['Content-Type'] || h['content-type'], 'retry-after': h['Retry-After'] || h['retry-after'],
          server: h['Server'] || h['server'], via: h['Via'] || h['via'] },
        body: r.getContentText().slice(0, 300) };
    } catch (e) {
      return { url: c.url, method: c.method, expect: c.expect, error: String(e.message || e) };
    }
  });
  return lenzDev_json_({ kind: 'lenz-spike-egress', userAgent: ua, at: new Date().toISOString(), results: results });
}

// Item 6: a Doc of about 50,000 characters (paragraphs with a link each).
function lenzDev_buildLargeDoc() {
  var created = Docs.Documents.create({ title: 'Lenz spike 50k ' + new Date().toISOString().slice(0, 16) });
  var line = 'Paragraph NNNN of the latency Doc, with a link to the website and some ordinary words 🎉.\n';
  var text = '';
  var links = [];
  for (var i = 0; text.length < 50000; i++) {
    var l = line.replace('NNNN', String(i));
    var at = 1 + text.length + l.indexOf('the website');
    links.push({ updateTextStyle: { range: { startIndex: at, endIndex: at + 11 },
      textStyle: { link: { url: 'https://lenz.io/' + i } }, fields: 'link' } });
    text += l;
  }
  Docs.Documents.batchUpdate({ requests: [{ insertText: { location: { index: 1 }, text: text } }].concat(links) },
    created.documentId);
  return lenzDev_json_({ kind: 'lenz-spike-large', docId: created.documentId, chars: text.length,
    url: 'https://docs.google.com/document/d/' + created.documentId + '/edit' });
}

function lenzDev_timeRead(docId, times) {
  var runs = [];
  var chars = 0;
  for (var i = 0; i < (times || 3); i++) {
    var t0 = Date.now();
    var doc = lenzDev_get_(docId);
    var t1 = Date.now();
    var ser = LenzSerialize.serialize(doc, null);
    runs.push({ restGetMs: t1 - t0, serializeMs: Date.now() - t1 });
    chars = LenzSerialize.cpLength(ser.text);
  }
  return lenzDev_json_({ kind: 'lenz-spike-latency', docId: docId, chars: chars, runs: runs });
}

// ---- dev menu (bound to the open Doc; Code.js adds the menu items) ----

function lenzDev_activeTabId_(d) {
  try { return d.getActiveTab().getId(); } catch (e) { return null; }
}

// Selects a text you type, through the same map the add-on uses, so the cursor can be judged by eye.
function lenzDev_menuSelect() {
  var ui = DocumentApp.getUi();
  var answer = ui.prompt('Select text (spike)', 'Text to select (its first occurrence):', ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  var needle = answer.getResponseText();
  var d = DocumentApp.getActiveDocument();
  var docId = d.getId();
  var rest = lenzDev_get_(docId);
  var tabId = lenzDev_activeTabId_(d) || LenzSpike.findTab(rest, null).tabProperties.tabId;
  var ser = LenzSerialize.serialize(rest, tabId);
  var loc = LenzSpike.locate(ser.text, needle, needle);
  if (!loc) { ui.alert('Not in the review text: ' + needle); return; }
  var map = LenzSerialize.toRestRanges(ser.pieces, loc.rs, loc.re, ser.text);
  var piece = ser.pieces.filter(function (p) { return p.rs <= loc.rs && loc.rs < p.re; })[0];
  var tab = d.getTab(tabId).asDocumentTab();
  var r = lenzDev_range_(tab, tab.getBody(), LenzSpike.paragraphs(rest, tabId), piece, map.ranges[0]);
  d.setSelection(r.range);
  ui.alert('Selected "' + r.rangeText + '" (clean: ' + map.clean + ', ranges: ' + JSON.stringify(map.ranges) + ')');
}

// Runs the full check on the open Doc and shows the verdict per item.
function lenzDev_menuCheck() {
  var d = DocumentApp.getActiveDocument();
  var result = JSON.parse(lenzDev_checkSpikeDoc(d.getId(), lenzDev_activeTabId_(d)));
  DocumentApp.getUi().alert('Spike check', result.verdict.join('\n') +
    '\n\nFull report: Executions log, or `clasp run lenzDev_checkSpikeDoc`.', DocumentApp.getUi().ButtonSet.OK);
}
