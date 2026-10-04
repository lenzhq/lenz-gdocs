// Builds the hand-*.json Docs REST fixtures with consistent UTF-16 indexes.
// `node test/fixtures/docs/build.js` rewrites them; real dumps replace them after the spike.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Paragraph elements. Chips, breaks and objects take 1 index; a text run its UTF-16 length.
const run = (content, o = {}) => ({ type: 'run', content, o });
const rich = (title, uri, o = {}) => ({ type: 'richLink', title, uri, o });
const person = (name, email, o = {}) => ({ type: 'person', name, email, o });
const date = (displayText, o = {}) => ({ type: 'date', displayText, o });
const obj = (key, value, o = {}) => ({ type: 'obj', key, value, o });
const para = (elements, o = {}) => ({ type: 'para', elements, o });
const table = (rows, o = {}) => ({ type: 'table', rows, o }); // rows: [{cells: [[...content]], o, cellOpts}]
const toc = (content) => ({ type: 'toc', content });

function suggestions(o) {
  const out = {};
  if (o.ins) out.suggestedInsertionIds = [o.ins];
  if (o.del) out.suggestedDeletionIds = [o.del];
  return out;
}

function buildParagraph(p, at) {
  const elements = [];
  const els = p.elements.slice();
  const last = els[els.length - 1];
  if (!last || last.type !== 'run') els.push(run(''));
  els.forEach((e, i) => {
    const isLast = i === els.length - 1;
    const base = { startIndex: at };
    if (e.type === 'run') {
      const content = e.content + (isLast ? '\n' : '');
      const textStyle = e.o.url ? { link: { url: e.o.url } } : e.o.link ? { link: e.o.link } : {};
      at += content.length;
      base.endIndex = at;
      base.textRun = Object.assign({ content, textStyle }, suggestions(e.o));
      elements.push(base);
      return;
    }
    at += 1;
    base.endIndex = at;
    if (e.type === 'richLink') {
      base.richLink = Object.assign(
        { richLinkId: 'rl' + at, richLinkProperties: { title: e.title, uri: e.uri, mimeType: '' } },
        suggestions(e.o),
      );
    } else if (e.type === 'person') {
      base.person = Object.assign(
        { personId: 'pp' + at, personProperties: { name: e.name, email: e.email } },
        suggestions(e.o),
      );
    } else if (e.type === 'date') {
      base.dateElement = Object.assign(
        { dateId: 'dd' + at, dateElementProperties: { displayText: e.displayText, timestamp: '2026-09-30T00:00:00Z' } },
        suggestions(e.o),
      );
    } else {
      base[e.key] = Object.assign({}, e.value, suggestions(e.o));
    }
    elements.push(base);
  });
  const paragraph = { elements, paragraphStyle: { namedStyleType: 'NORMAL_TEXT' } };
  if (p.o.positionedObjectIds) paragraph.positionedObjectIds = p.o.positionedObjectIds;
  return { startIndex: elements[0].startIndex, endIndex: at, paragraph };
}

function buildContent(items, at) {
  const out = [];
  for (const item of items) {
    const built = buildElement(item, at);
    out.push(built);
    at = built.endIndex;
  }
  return out;
}

function buildElement(item, at) {
  if (item.type === 'para') return buildParagraph(item, at);
  if (item.type === 'toc') {
    const content = buildContent(item.content, at + 1);
    return { startIndex: at, endIndex: content[content.length - 1].endIndex + 1, tableOfContents: { content } };
  }
  // A table: 1 index opens it, 1 opens each row and each cell, 1 closes it.
  const start = at;
  at += 1;
  const tableRows = item.rows.map((row) => {
    const rowStart = at;
    at += 1;
    const tableCells = row.cells.map((cell, ci) => {
      const cellStart = at;
      const content = buildContent(cell, at + 1);
      at = content[content.length - 1].endIndex;
      const co = (row.cellOpts && row.cellOpts[ci]) || {};
      return Object.assign({ startIndex: cellStart, endIndex: at, content, tableCellStyle: {} }, suggestions(co));
    });
    return Object.assign({ startIndex: rowStart, endIndex: at, tableCells }, suggestions(row.o || {}));
  });
  at += 1;
  const t = Object.assign(
    { rows: item.rows.length, columns: item.rows[0].cells.length, tableRows },
    suggestions(item.o),
  );
  return { startIndex: start, endIndex: at, table: t };
}

function body(items) {
  return { content: [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }].concat(buildContent(items, 1)) };
}

function tab(tabId, title, items, extra = {}) {
  const documentTab = Object.assign({ body: body(items) }, extra.documentTab || {});
  const t = { tabProperties: { tabId, title, index: 0 }, documentTab };
  if (extra.childTabs) t.childTabs = extra.childTabs;
  return t;
}

function doc(name, tabs) {
  return { documentId: 'doc-' + name, title: name, revisionId: 'rev-' + name, tabs };
}

function segment(items) {
  return { content: buildContent(items, 0) };
}

const FIXTURES = {
  'hand-paragraphs': doc('paragraphs', [tab('t.0', 'Tab 1', [
    para([run('The first paragraph.')]),
    para([]),
    para([run('   ')]),
    para([run('\t')]),
    para([run('Second, '), run('in two runs.')]),
    para([run('Line one\u000bline two')]),
    para([run('Col\tafter tab')]),
  ])]),
  'hand-links': doc('links', [tab('t.0', 'Tab 1', [
    para([run('See '), run('the report', { url: 'https://example.org/r?a=1&b=2' }), run(' and '),
      run('mail us', { url: 'mailto:info@example.org' }), run('.')]),
    para([run('Split ', { url: 'https://example.org/split' }), run('link', { url: 'https://example.org/split' }),
      run(' end.')]),
    para([run('Heading link', { link: { headingId: 'h.abc' } }), run(' stays plain.')]),
    para([run('Chip: '), rich('Quarterly report', 'https://docs.google.com/document/d/abc'), run(' done.')]),
    para([run('By '), person('Ana Novak', 'ana@example.org'), run(' on '), date('Sep 30, 2026'), run('.')]),
  ])]),
  'hand-suggestions': doc('suggestions', [tab('t.0', 'Tab 1', [
    para([run('Revenue grew '), run('10%', { del: 'sug.1' }), run('12%', { ins: 'sug.1' }), run(' last year.')]),
    para([run('Deleted paragraph.', { del: 'sug.2' })]),
    para([run('Kept.')]),
    table([
      { cells: [[para([run('Keep A')])], [para([run('Keep B')])]] },
      { cells: [[para([run('Gone A')])], [para([run('Gone B')])]], o: { del: 'sug.3' } },
      { cells: [[para([run('Row C')])], [para([run('New cell')])]], cellOpts: [{}, { ins: 'sug.4' }] },
    ]),
    para([run('After table.')]),
  ])]),
  'hand-astral': doc('astral', [tab('t.0', 'Tab 1', [
    para([run('Party 🎉 time, café ☕ and 𝒜𝒷𝒸.')]),
    para([run('👍🏽', { url: 'https://example.org/thumb' }), run(' ok')]),
  ])]),
  'hand-tabs': doc('tabs', [
    tab('t.0', 'First', [para([run('First tab text.')])], {
      childTabs: [tab('t.child', 'Child', [para([run('Child tab text.')])])],
    }),
    tab('t.1', 'Second', [para([run('Second tab text.')])]),
  ]),
  'hand-not-read': doc('not-read', [tab('t.0', 'Tab 1', [
    para([run('Footnoted'), obj('footnoteReference', { footnoteId: 'fn.1', footnoteNumber: '1' }), run(' claim.')]),
    para([run('Picture '), obj('inlineObjectElement', { inlineObjectId: 'kix.img1' }), run(' here.')],
      { positionedObjectIds: ['kix.pos1'] }),
    para([obj('equation', {}), run('Equation above.')]),
    para([run('Page '), obj('autoText', { type: 'PAGE_NUMBER' }), run('.')]),
    para([run('Before break'), obj('pageBreak', {}), run('after break')]),
    para([obj('horizontalRule', {})]),
    para([run('Deleted image '), obj('inlineObjectElement', { inlineObjectId: 'kix.img2' }, { del: 'sug.9' }),
      run('gone.')]),
    toc([para([run('Contents entry', { link: { headingId: 'h.1' } })])]),
  ], {
    documentTab: {
      headers: { 'kix.h1': segment([para([run('Header text')])]), 'kix.h2': segment([para([])]) },
      footers: { 'kix.f1': segment([para([run('Footer text')])]) },
      footnotes: { 'fn.1': segment([para([run('The note.')])]) },
    },
  })]),
  // The same document as test/fixtures/parity/basic.docx (scripts/build-parity-docx.py).
  'hand-parity-basic': doc('parity-basic', [tab('t.0', 'Tab 1', [
    para([run('Alpha beta.')]),
    para([]),
    para([run('Tab\there and a soft break:\u000bsecond line.')]),
    para([run('See '), run('the report', { url: 'https://example.org/report?a=1&b=2' }), run(', then '),
      run('write', { url: 'mailto:info@example.org' }), run('.')]),
    table([{ cells: [[para([run('Cell A')])], [para([run('Cell B')]), para([run('Cell B2')])]] }]),
    para([run('\t')]),
    para([run('End with émoji 🎉')]),
  ])]),
};

if (require.main === module) {
  for (const [name, value] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(__dirname, name + '.json'), JSON.stringify(value, null, 2) + '\n');
  }
}

module.exports = { FIXTURES, doc, tab, para, run };
