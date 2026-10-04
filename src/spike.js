// The spike's pure half: the test Doc's build plan, the checks run on what the Doc gives back, and
// the verdict per spike item. dev.js (Apps Script) and scripts/spike-report.js (Node) share it, so
// the in-script report and the report on the Mac are the same code.
// Pure: no Apps Script globals. Units: cp = code points of the review text; u16 = UTF-16 code
// units (Docs REST indexes, JS string indexes).
var LenzSpike = (function () {
  'use strict';

  // LenzSerialize is a global in Apps Script; in Node it is required.
  function S() {
    if (typeof LenzSerialize !== 'undefined') return LenzSerialize;
    if (typeof require === 'function') return require('./serialize.js');
    throw new Error('LenzSerialize is not loaded');
  }

 // What the spike's test Doc must hold (API-made, or added by hand: see buildPlan().manual).
  var REQUIRED = ['person', 'pageBreak', 'footnote', 'table', 'richLink', 'softBreak', 'list', 'twoTabs',
    'suggestedInsertion', 'suggestedDeletion'];
  var CONFLICT = /revision/i; // Google's refusal of a write on a stale requiredRevisionId

  var BOLD_LINK = { bold: true, link: { url: 'https://lenz.io/fox' } };

  // Apply targets: the text as it stands before, what replaces it, and how the requests insert it.
  // 'inside' inserts after the old text's first character (so the new text takes that character's
  // style), 'before' inserts in front of it (it takes the style of the character before).
  var APPLY_TARGETS = [
    { id: 'partial', find: 'brown', within: 'quick brown fox', replacement: 'red', strategy: 'inside' },
    { id: 'whole-link-inside', find: 'replace me', within: 'replace me', replacement: 'swapped in', strategy: 'inside' },
    { id: 'whole-link-before', find: 'second link', within: 'second link', replacement: 'other words', strategy: 'before' },
    // The add-on's own strategy (Code.js lenzApplyRequests_): insert at the end, delete the old.
    { id: 'glue-end', find: 'lazy', within: 'lazy dog', replacement: 'sleepy', strategy: 'end' },
  ];

  // ---- the test Doc ----

  // Everything the Docs API can make, as one text insert at index 1, styles on it, and the inserts
  // that are not text (done afterwards, highest index first, so every index is one of this text's).
  function buildPlan() {
    var text = '';
    var styles = [];   // { start, end, textStyle, fields }
    var bullets = [];  // { start, end }
    var marks = {};    // name -> u16 REST index in the text as inserted
    function at() { return 1 + text.length; }
    function add(s, style) {
      var start = at();
      text += s;
      if (style) {
        var fields = Object.keys(style).join(',');
        styles.push({ start: start, end: at(), textStyle: style, fields: fields });
      }
    }
    function mark(name) { marks[name] = at(); }
    function para() { text += '\n'; }

    add('Lenz spike document: a plain paragraph.'); para();
    para(); // an empty paragraph
    add('Emoji 🎉, astral 𝒜𝒷𝒸 and a skin tone 👍🏽 before the end.'); para();
    add('Soft'); mark('softBreak'); add('break, and a tab:\there.'); para();
    add('Links: '); add('the website', { link: { url: 'https://lenz.io/' } }); add(', ');
    add('mail us', { link: { url: 'mailto:info@lenz.io' } }); add(' and ');
    add('call', { link: { url: 'tel:+10000000000' } }); add('.'); para();
    add('Split link: '); add('two ', { link: { url: 'https://lenz.io/split' } });
    add('runs', { bold: true, link: { url: 'https://lenz.io/split' } }); add(' end.'); para();
    var listStart = at();
    add('First item'); para(); add('Second item'); para(); add('Third item'); para();
    bullets.push({ start: listStart, end: at() - 1 });
    add('Before the table.'); mark('table'); para();
    add('Person chip: '); mark('person'); add(' after the chip.'); para();
    add('Page break follows:'); mark('pageBreak'); para();
    add('Footnote here'); mark('footnote'); add(' and after.'); para();
    add('Apply target: the '); add('quick brown fox', BOLD_LINK); add(' jumps.'); para();
    add('Whole link: '); add('replace me', { link: { url: 'https://lenz.io/whole' } }); add(' now.'); para();
    add('Second whole link: '); add('second link', { link: { url: 'https://lenz.io/second' } }); add(' too.'); para();
    add('Glue target: the '); add('lazy dog', { bold: true, link: { url: 'https://lenz.io/dog' } }); add(' sleeps.'); para();
    add('Last paragraph.');

    var structural = [
      { kind: 'softBreak', index: marks.softBreak },
      { kind: 'table', index: marks.table, rows: 2, columns: 2, cells: ['Cell A1', 'Cell B1', 'Cell A2', 'Cell B2 🎉'] },
      { kind: 'person', index: marks.person, email: 'info@lenz.io' },
      { kind: 'pageBreak', index: marks.pageBreak },
      { kind: 'footnote', index: marks.footnote, text: 'The footnote text.' },
    ].sort(function (a, b) { return b.index - a.index; });

    return {
      title: 'Lenz spike',
      text: text,
      styles: styles,
      bullets: bullets,
      structural: structural,
      header: 'Header text',
      secondTab: { title: 'Second tab', text: 'Second tab text.' },
      manual: [
        'a pending suggested insertion and a suggested deletion (Suggesting mode), one inside the table',
        'a RichLink chip (paste a Google Drive file link, choose "Chip")',
        'a Date chip (@today)',
        'a table of contents (Insert > Table of contents)',
        'an inline image in a paragraph with text after it',
        'a second tab by hand if buildSpikeDoc reports that addDocumentTab failed',
      ],
    };
  }

  // The first batchUpdate: the text, then its styles and the list.
  function textRequests(plan) {
    var reqs = [{ insertText: { location: { index: 1 }, text: plan.text } }];
    plan.styles.forEach(function (s) {
      reqs.push({ updateTextStyle: { range: { startIndex: s.start, endIndex: s.end }, textStyle: s.textStyle, fields: s.fields } });
    });
    plan.bullets.forEach(function (b) {
      reqs.push({ createParagraphBullets: { range: { startIndex: b.start, endIndex: b.end }, bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE' } });
    });
    return reqs;
  }

  // One non-text insert as its own request list (each is tried alone: one refusal is a finding,
  // not the end of the build).
  function structuralRequests(item) {
    var loc = { index: item.index };
    if (item.kind === 'softBreak') return [{ insertText: { location: loc, text: '\u000b' } }];
    if (item.kind === 'table') return [{ insertTable: { rows: item.rows, columns: item.columns, location: loc } }];
    if (item.kind === 'person') return [{ insertPerson: { personProperties: { email: item.email }, location: loc } }];
    if (item.kind === 'pageBreak') return [{ insertPageBreak: { location: loc } }];
    if (item.kind === 'footnote') return [{ createFootnote: { location: loc } }];
    throw new Error('unknown structural kind');
  }

  // Cell texts for the first table of a tab, highest index first.
  function tableFillRequests(doc, tabId, cells) {
    var body = tabBody(doc, tabId);
    var table = null;
    walk(body.content || [], function (se) { if (!table && se.table) table = se.table; });
    if (!table) return [];
    var starts = [];
    (table.tableRows || []).forEach(function (row) {
      (row.tableCells || []).forEach(function (cell) { starts.push(cell.content[0].startIndex); });
    });
    var reqs = [];
    for (var i = Math.min(starts.length, cells.length) - 1; i >= 0; i--) {
      reqs.push({ insertText: { location: { index: starts[i], tabId: tabId }, text: cells[i] } });
    }
    return reqs;
  }

  // ---- reading a REST Document ----

  function flattenTabs(tabs, out) {
    for (var i = 0; i < (tabs || []).length; i++) {
      out.push(tabs[i]);
      flattenTabs(tabs[i].childTabs, out);
    }
    return out;
  }

  function findTab(doc, tabId) {
    var tabs = flattenTabs(doc.tabs, []);
    if (tabId === null || tabId === undefined) return tabs[0] || null;
    for (var i = 0; i < tabs.length; i++) if (tabs[i].tabProperties.tabId === tabId) return tabs[i];
    return null;
  }

  function tabBody(doc, tabId) {
    var t = findTab(doc, tabId);
    return (t && t.documentTab && t.documentTab.body) || { content: [] };
  }

  // Structural elements in serialize.js's order (paragraphs, table cells, contents).
  function walk(content, fn) {
    for (var i = 0; i < content.length; i++) {
      var se = content[i];
      fn(se);
      if (se.table) {
        (se.table.tableRows || []).forEach(function (row) {
          (row.tableCells || []).forEach(function (cell) { walk(cell.content || [], fn); });
        });
      } else if (se.tableOfContents) walk(se.tableOfContents.content || [], fn);
    }
  }

  // Every paragraph of a tab by ordinal (serialize.js's `para`), with its REST start and text.
  // `text` is the paragraph as u16 at REST indexes: text runs as they are, any other element as
  // U+FFFC (one index), without the closing "\n".
  function paragraphs(doc, tabId) {
    var out = [];
    walk(tabBody(doc, tabId).content || [], function (se) {
      if (!se.paragraph) return;
      var t = '';
      var kinds = [];
      (se.paragraph.elements || []).forEach(function (el) {
        if (el.textRun) t += el.textRun.content || '';
        else {
          var k = Object.keys(el).filter(function (x) { return x !== 'startIndex' && x !== 'endIndex'; })[0];
          kinds.push(k);
          t += '￼';
        }
      });
      if (t.charAt(t.length - 1) === '\n') t = t.slice(0, -1);
      out.push({ ordinal: out.length, startIndex: se.startIndex, endIndex: se.endIndex, text: t, elements: kinds,
        bullet: !!se.paragraph.bullet });
    });
    return out;
  }

  // The text run holding a REST index, with its style; null when none does.
  function runAt(doc, tabId, index) {
    var found = null;
    walk(tabBody(doc, tabId).content || [], function (se) {
      if (!se.paragraph || found) return;
      (se.paragraph.elements || []).forEach(function (el) {
        if (!found && el.textRun && el.startIndex <= index && index < el.endIndex) {
          found = { startIndex: el.startIndex, endIndex: el.endIndex, content: el.textRun.content,
            textStyle: el.textRun.textStyle || {} };
        }
      });
    });
    return found;
  }

  function linkUrl(style) { return style && style.link && style.link.url ? style.link.url : null; }

  // ---- checks ----

  function norm(s) { return s.replace(/[\u000b\r]/g, '\n'); }

  // serialize.js's invariants on a real Doc: pieces contiguous and covering the text, and every
  // plain text piece reading the same text at its REST indexes.
  function checkInvariants(doc, tabId, ser) {
    var fails = [];
    var pos = 0;
    ser.pieces.forEach(function (p, i) {
      if (p.rs !== pos || p.re <= p.rs) fails.push({ piece: i, problem: 'not contiguous', rs: p.rs, re: p.re });
      pos = p.re;
    });
    if (pos !== S().cpLength(ser.text)) fails.push({ problem: 'pieces end at ' + pos });
    var paras = paragraphs(doc, tabId);
    ser.pieces.forEach(function (p, i) {
      if (p.kind !== 'text' || p.flags.atomic) return;
      var para = paras[p.para];
      if (!para) { fails.push({ piece: i, problem: 'no paragraph ' + p.para }); return; }
      var got = para.text.slice(p.ds - para.startIndex, p.de - para.startIndex);
      var want = S().cpSlice(ser.text, p.rs, p.re);
      if (norm(got) !== want) fails.push({ piece: i, problem: 'REST text differs', want: want, got: got });
    });
    return fails;
  }

  // DocumentApp's paragraphs (body.getParagraphs() texts) against the REST ordinals, and every
  // plain piece read through them at (ds - paragraph start): the select path's assumption.
  function checkDocumentApp(doc, tabId, ser, dTexts) {
    var paras = paragraphs(doc, tabId);
    var out = { restCount: paras.length, documentAppCount: dTexts.length, paragraphs: [], pieces: [] };
    paras.forEach(function (p, i) {
      var d = dTexts[i];
      var status = d === undefined ? 'missing' : d === p.text ? 'equal'
        : norm(d) === norm(p.text) ? 'equal-normalized'
          : norm(d) === norm(p.text.replace(/￼/g, '')) ? 'equal-without-chips' : 'differs';
      if (status !== 'equal') out.paragraphs.push({ ordinal: i, status: status, rest: p.text, documentApp: d, elements: p.elements });
    });
    ser.pieces.forEach(function (p, i) {
      if (p.kind !== 'text' || p.flags.atomic) return;
      var d = dTexts[p.para];
      var start = p.ds - paras[p.para].startIndex;
      var got = d === undefined ? undefined : d.slice(start, start + (p.de - p.ds));
      var want = S().cpSlice(ser.text, p.rs, p.re);
      if (got === undefined || norm(got) !== want) out.pieces.push({ piece: i, para: p.para, want: want, got: got });
    });
    return out;
  }

  // cp range of `find` inside `within` in the review text; null when absent (already applied).
  function locate(text, find, within) {
    var w = text.indexOf(within);
    if (w < 0) return null;
    var u = text.indexOf(find, w);
    var S_ = S();
    var rs = S_.cpLength(text.slice(0, u));
    return { rs: rs, re: rs + S_.cpLength(find) };
  }

  // The batchUpdate body replacing REST [start, end) with `replacement`.
  function applyBody(range, replacement, tabId, revisionId, strategy) {
    var s = range.startIndex;
    var e = range.endIndex;
    var n = replacement.length; // u16
    var reqs;
    if (strategy === 'end') {
      reqs = [
        { insertText: { location: { index: e, tabId: tabId }, text: replacement } },
        { deleteContentRange: { range: { startIndex: s, endIndex: e, tabId: tabId } } },
      ];
    } else if (strategy === 'inside' && e - s > 1) {
      reqs = [
        { insertText: { location: { index: s + 1, tabId: tabId }, text: replacement } },
        { deleteContentRange: { range: { startIndex: s + 1 + n, endIndex: e + n, tabId: tabId } } },
        { deleteContentRange: { range: { startIndex: s, endIndex: s + 1, tabId: tabId } } },
      ];
    } else {
      reqs = [
        { insertText: { location: { index: s, tabId: tabId }, text: replacement } },
        { deleteContentRange: { range: { startIndex: s + n, endIndex: e + n, tabId: tabId } } },
      ];
    }
    return { requests: reqs, writeControl: { requiredRevisionId: revisionId } };
  }

  // ---- verdicts ----

  function item(id, title, status, detail) { return { id: id, title: title, status: status, detail: detail }; }

  function hasElement(doc, tabId, key) {
    var yes = false;
    walk(tabBody(doc, tabId).content || [], function (se) {
      if (se.paragraph) (se.paragraph.elements || []).forEach(function (el) { if (el[key]) yes = true; });
      if (key === 'table' && se.table) yes = true;
      if (key === 'tableOfContents' && se.tableOfContents) yes = true;
    });
    return yes;
  }

  // First difference between two texts, with context; null when equal.
  function firstDiff(a, b) {
    if (a === b) return null;
    var i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return { at: i, ours: JSON.stringify(a.slice(Math.max(0, i - 40), i + 40)),
      docx: JSON.stringify(b.slice(Math.max(0, i - 40), i + 40)) };
  }

  // The verdict per spike item and per ⚑ item of CONTRACT.md.
  // check: dev.js lenzDev_checkSpikeDoc's result; extras: { parityText, egress, latency } (each optional).
  function evaluate(check, extras) {
    extras = extras || {};
    var doc = check.dump;
    var tabId = check.tabId;
    var ser = S().serialize(doc, tabId);
    var items = [];
    var inv = checkInvariants(doc, tabId, ser);
    var tabs = flattenTabs(doc.tabs, []).length;
    var present = ['person', 'pageBreak', 'footnoteReference', 'table', 'richLink', 'dateElement', 'tableOfContents',
      'inlineObjectElement'].filter(function (k) { return hasElement(doc, tabId, k); });
    var bodyJson = JSON.stringify(tabBody(doc, tabId));
    var have = {
      person: present.indexOf('person') >= 0, pageBreak: present.indexOf('pageBreak') >= 0,
      footnote: present.indexOf('footnoteReference') >= 0, table: present.indexOf('table') >= 0,
      richLink: present.indexOf('richLink') >= 0, softBreak: bodyJson.indexOf('\\u000b') >= 0,
      list: paragraphs(doc, tabId).some(function (p) { return p.bullet; }), twoTabs: tabs >= 2,
      suggestedInsertion: bodyJson.indexOf('suggestedInsertionIds') >= 0,
      suggestedDeletion: bodyJson.indexOf('suggestedDeletionIds') >= 0,
    };
    // The spike's test Doc: a case missing from it is untested, not passed.
    var missing = REQUIRED.filter(function (k) { return !have[k]; });
    items.push(item('1', 'REST read: indexes, chips, suggestions, soft breaks, tabs',
      inv.length || missing.length ? 'FAIL' : 'PASS',
      { invariantFailures: inv, missingFromTheDoc: missing, tabs: tabs, present: present, have: have }));

    items.push(extras.egress ? egressItem(extras.egress) : item('2', 'UrlFetchApp to lenz.io from Google egress', 'PENDING',
      'run lenzDev_probeEgress'));

    var da = check.documentApp || {};
    if (da.error || !da.paragraphTexts) {
      items.push(item('3', 'REST index to DocumentApp selection', 'FAIL', da.error || 'no DocumentApp read'));
    } else {
      var cmp = checkDocumentApp(doc, tabId, ser, da.paragraphTexts);
      var sel = check.select || [];
      var selOk = sel.length > 0 && sel.every(function (s) { return s.rangeText === s.want; });
      var ok = cmp.restCount === cmp.documentAppCount && !cmp.pieces.length && selOk;
      items.push(item('3', 'REST index to DocumentApp selection', ok ? 'PASS' : 'FAIL',
        { counts: [cmp.restCount, cmp.documentAppCount], paragraphDifferences: cmp.paragraphs, pieceMismatches: cmp.pieces,
          ranges: sel, setSelectionByEye: 'MANUAL: open the Doc, run the dev menu select, look at the cursor' }));
    }

    var applies = check.apply || [];
    // Every target meant to keep its style must have run and kept it ('before' is the comparison).
    var mustKeep = APPLY_TARGETS.filter(function (t) { return t.strategy !== 'before'; });
    var applyOk = mustKeep.every(function (t) {
      var a = applies.filter(function (x) { return x.id === t.id; })[0];
      return !!(a && a.textOk && a.linkKept && a.boldKept);
    });
    var conflictOk = !!(check.conflict && check.conflict.error && CONFLICT.test(check.conflict.error));
    items.push(item('4', 'Apply keeps style and link; conflict on a stale revision; Cmd+Z',
      applyOk && conflictOk ? 'PASS' : 'FAIL',
      { applies: applies, conflict: check.conflict, undoByEye: 'MANUAL: Cmd+Z once undoes one Apply' }));

    var par = parity(doc, tabId, ser, extras.parityText);
    if (check.docxError) {
      items.push(item('5', 'Serializer parity with the Lenz .docx reader on the .docx export', 'FAIL', 'no .docx: ' + check.docxError));
    } else if (par) {
      items.push(item('5', 'Serializer parity with the Lenz .docx reader on the .docx export', par.status, par));
    } else {
      items.push(item('5', 'Serializer parity with the Lenz .docx reader on the .docx export', 'PENDING',
        'run scripts/spike-report.js with --parity <command>'));
    }

    items.push(extras.latency ? latencyItem(extras.latency) : item('6', 'Latency of REST read + map on 50,000 characters',
      'PENDING', 'run lenzDev_buildLargeDoc then lenzDev_timeRead'));
    items.push(item('7', 'Workspace Developer Preview enrollment', 'MANUAL', 'the account owner: check the enrollment status'));
    items.push(item('8', 'Prototype API-key accounts are internal (is_staff / profile type)', 'MANUAL',
      'Lenz side: prod-read.sh on the keys\' users'));

    // ⚑ items: the .docx export is the arbiter; a feature missing from the Doc is MANUAL.
    var parityStatus = check.docxError ? 'FAIL' : par ? par.status : 'PENDING';
    var splitLink = ser.text.indexOf('[two ](https://lenz.io/split)[runs](https://lenz.io/split)') >= 0;
    items.push(item('⚑1', 'Every linked run is its own [words](url), as the export writes it', splitLink ? parityStatus : 'FAIL',
      { serialized: splitLink }));
    items.push(item('⚑2', 'A table of contents is read', present.indexOf('tableOfContents') >= 0 ? parityStatus : 'MANUAL',
      'add a table of contents by hand'));
    items.push(item('⚑3', 'Person chip = [name](mailto:email)', present.indexOf('person') >= 0 ? parityStatus : 'MANUAL',
      personText(doc, tabId)));
    var da3 = items[2];
    items.push(item('⚑4', 'para = DocumentApp getParagraphs() index', da3.status, 'see item 3'));
    return { ser: { chars: S().cpLength(ser.text), pieces: ser.pieces.length, truncated: ser.truncated, notRead: ser.notRead },
      items: items };
  }

  // The export holds every tab (it has no tab selector); the add-on reads one. PASS when the export
  // equals this tab's text, or every tab's text joined as paragraphs (said in `scope`).
  function parity(doc, tabId, ser, parityText) {
    if (typeof parityText !== 'string') return null;
    var d = firstDiff(ser.text, parityText);
    if (!d) return { status: 'PASS', scope: 'this tab' };
    var all = flattenTabs(doc.tabs, []).map(function (t) {
      return S().serialize(doc, t.tabProperties.tabId).text;
    }).filter(function (t) { return t; }).join('\n\n');
    if (all === parityText) return { status: 'PASS', scope: 'every tab (the export holds all tabs; the add-on reads one)' };
    // A Doc with several tabs exports each under a paragraph holding its title (spike, 2026-09-30).
    var titled = flattenTabs(doc.tabs, []).map(function (t) {
      var text = S().serialize(doc, t.tabProperties.tabId).text;
      return [t.tabProperties.title, text].filter(function (x) { return x; }).join('\n\n');
    }).join('\n\n');
    if (titled === parityText) {
      return { status: 'PASS', scope: 'every tab, each under its title (the export holds all tabs; the add-on reads one)' };
    }
    return { status: 'FAIL', thisTab: d, everyTab: firstDiff(all, parityText) };
  }

  function personText(doc, tabId) {
    var out = [];
    walk(tabBody(doc, tabId).content || [], function (se) {
      if (se.paragraph) (se.paragraph.elements || []).forEach(function (el) { if (el.person) out.push(el.person.personProperties); });
    });
    return out;
  }

  function egressItem(egress) {
    var results = egress.results || [];
    var reached = results.length > 0 && results.every(function (r) {
      return typeof r.expect === 'number' ? r.code === r.expect
        : typeof r.code === 'number' && r.code < 300 && r.code >= 200;
    });
    return item('2', 'UrlFetchApp to lenz.io from Google egress', reached ? 'PASS' : 'FAIL',
      { results: results, lenzSide: 'MANUAL: APICallLog client_source and User-Agent for these calls' });
  }

  function latencyItem(latency) {
    var runs = latency.runs || [];
    var worst = runs.reduce(function (m, r) { return Math.max(m, r.restGetMs + r.serializeMs); }, 0);
    return item('6', 'Latency of REST read + map on 50,000 characters', runs.length ? 'MEASURED' : 'FAIL',
      { chars: latency.chars, worstMs: worst, runs: runs });
  }

  return {
    APPLY_TARGETS: APPLY_TARGETS,
    buildPlan: buildPlan,
    textRequests: textRequests,
    structuralRequests: structuralRequests,
    tableFillRequests: tableFillRequests,
    findTab: findTab,
    paragraphs: paragraphs,
    runAt: runAt,
    linkUrl: linkUrl,
    checkInvariants: checkInvariants,
    checkDocumentApp: checkDocumentApp,
    locate: locate,
    applyBody: applyBody,
    firstDiff: firstDiff,
    evaluate: evaluate,
  };
})();
if (typeof module !== 'undefined') { module.exports = LenzSpike; }
