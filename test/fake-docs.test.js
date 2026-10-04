'use strict';
// The fake Google Doc the flow tests edit. If it drifted from the Docs REST shape, every flow test
// would pass against the wrong thing, so its layout and its edit rules are pinned here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeDocs, blocksFromText } = require('./helpers/fake-docs.js');
const LenzSerialize = require('../src/serialize.js');

const GET = { includeTabsContent: true, suggestionsViewMode: 'SUGGESTIONS_INLINE' };
const run = (text, url) => (url ? { text, url } : { text });
const p = (...runs) => ({ runs });

function body(docs, id, tabId) {
  const doc = docs.Documents.get(id, GET);
  return doc.tabs.filter((t) => !tabId || t.tabProperties.tabId === tabId)[0].documentTab.body.content;
}

test('layout: sectionBreak to 1, paragraphs end in their newline, links in textStyle, u16 indexes', () => {
  const docs = createFakeDocs();
  const id = docs.create({ text: 'Hi 🚀 there.\n\nSee [NASA](https://nasa.gov) now.' });
  const c = body(docs, id);
  assert.deepEqual(c[0], { endIndex: 1, sectionBreak: { sectionStyle: {} } });
  assert.equal(c[1].startIndex, 1);
  assert.equal(c[1].paragraph.elements[0].textRun.content, 'Hi 🚀 there.\n');
  assert.equal(c[1].endIndex, 1 + 'Hi 🚀 there.\n'.length); // the emoji is 2 u16 units
  const els = c[2].paragraph.elements;
  assert.deepEqual(els.map((e) => e.textRun.content), ['See ', 'NASA', ' now.\n']);
  assert.deepEqual(els[1].textRun.textStyle, { link: { url: 'https://nasa.gov' } });
  assert.equal(els[1].startIndex, c[2].startIndex + 4);
});

test('layout: a table takes 1 index to open, 1 per row and cell, 1 to close (build.js convention)', () => {
  const docs = createFakeDocs();
  const id = docs.create({ tabs: [{ tabId: 't.0', blocks: [
    p(run('Before.')),
    { table: [[[p(run('A1'))], [p(run('B1'))]]] },
    p(run('After.')),
  ] }] });
  const c = body(docs, id);
  const t = c[2];
  assert.equal(t.startIndex, 9); // "Before.\n" is 1..9
  const row = t.table.tableRows[0];
  assert.equal(row.startIndex, 10);
  assert.equal(row.tableCells[0].startIndex, 11);
  assert.equal(row.tableCells[0].content[0].startIndex, 12); // "A1\n" 12..15
  assert.equal(row.tableCells[1].startIndex, 15);
  assert.equal(row.tableCells[1].content[0].startIndex, 16); // "B1\n" 16..19
  assert.equal(t.endIndex, 20);
  assert.equal(c[3].startIndex, 20);
  assert.equal(docs.textOf(id), 'Before.\nA1\nB1\nAfter.');
  // The real serializer reads it, cells included.
  assert.equal(LenzSerialize.serialize(docs.Documents.get(id, GET), null).text, 'Before.\n\nA1\n\nB1\n\nAfter.');
});

test('get without includeTabsContent returns the first tab as body; tabs are separate', () => {
  const docs = createFakeDocs();
  const id = docs.create({ tabs: [
    { tabId: 't.0', blocks: blocksFromText('One.') },
    { tabId: 't.1', blocks: blocksFromText('Two.') },
  ] });
  const legacy = docs.Documents.get(id);
  assert.equal(legacy.body.content[1].paragraph.elements[0].textRun.content, 'One.\n');
  assert.equal(legacy.tabs, undefined);
  assert.equal(LenzSerialize.serialize(docs.Documents.get(id, GET), 't.1').text, 'Two.');
});

test('insertText + deleteContentRange replace words; revisionId bumps; indexes are recomputed', () => {
  const docs = createFakeDocs();
  const id = docs.create({ text: 'Intro 🚀.\n\nLanded in 1972 with four.' });
  const rev = docs.revision(id);
  const all = docs.rangeText(id, null, 0, 1000);
  const at = 1 + all.indexOf('1972');
  const res = docs.Documents.batchUpdate({
    requests: [
      { insertText: { text: '1969', location: { index: at + 4 } } },
      { deleteContentRange: { range: { startIndex: at, endIndex: at + 4 } } },
    ],
    writeControl: { requiredRevisionId: rev },
  }, id);
  assert.notEqual(docs.revision(id), rev);
  assert.equal(res.writeControl.requiredRevisionId, docs.revision(id));
  assert.equal(docs.textOf(id), 'Intro 🚀.\nLanded in 1969 with four.');
  // An edit leaves one run per style, not one per character.
  assert.deepEqual(body(docs, id)[2].paragraph.elements.map((e) => e.textRun.content), ['Landed in 1969 with four.\n']);
});

test('a stale requiredRevisionId is refused with 400 FAILED_PRECONDITION and changes nothing', () => {
  const docs = createFakeDocs();
  const id = docs.create({ text: 'Alpha beta.' });
  const stale = docs.revision(id);
  docs.coauthorReplace(id, 'beta', 'gamma');
  assert.throws(() => docs.Documents.batchUpdate({
    requests: [{ insertText: { text: 'X', location: { index: 1 } } }],
    writeControl: { requiredRevisionId: stale },
  }, id), (e) => {
    assert.match(e.message, /^API call to docs\.documents\.batchUpdate failed with error: /);
    assert.deepEqual(e.body.error.code, 400);
    assert.equal(e.body.error.status, 'FAILED_PRECONDITION');
    return true;
  });
  assert.equal(docs.textOf(id), 'Alpha gamma.');
});

test('a batch is all or nothing', () => {
  const docs = createFakeDocs();
  const id = docs.create({ text: 'Alpha beta.' });
  const rev = docs.revision(id);
  assert.throws(() => docs.Documents.batchUpdate({ requests: [
    { insertText: { text: 'X', location: { index: 1 } } },
    { deleteContentRange: { range: { startIndex: 5, endIndex: 500 } } },
  ] }, id));
  assert.equal(docs.textOf(id), 'Alpha beta.');
  assert.equal(docs.revision(id), rev);
});

test('edits that Google refuses: inside a surrogate pair, the last newline, across a table', () => {
  const docs = createFakeDocs();
  const id = docs.create({ tabs: [{ tabId: 't.0', blocks: [p(run('A🚀B')), { table: [[[p(run('C'))]]] }, p(run('D'))] }] });
  // "A🚀B\n" is 1..6: the emoji is at 2..4.
  assert.throws(() => docs.Documents.batchUpdate({ requests: [{ insertText: { text: 'x', location: { index: 3 } } }] }, id));
  assert.throws(() => docs.Documents.batchUpdate({ requests: [{ deleteContentRange: { range: { startIndex: 3, endIndex: 4 } } }] }, id));
  assert.throws(() => docs.Documents.batchUpdate({ requests: [{ deleteContentRange: { range: { startIndex: 5, endIndex: 6 } } }] }, id));
  assert.throws(() => docs.Documents.batchUpdate({ requests: [{ deleteContentRange: { range: { startIndex: 4, endIndex: 10 } } }] }, id));
  assert.equal(docs.textOf(id), 'A🚀B\nC\nD');
});

test('a newline insert splits a paragraph; deleting a newline joins two', () => {
  const docs = createFakeDocs();
  const id = docs.create({ text: 'One two.\n\nThree.' });
  docs.Documents.batchUpdate({ requests: [{ insertText: { text: '\n', location: { index: 4 } } }] }, id);
  assert.equal(docs.textOf(id), 'One\n two.\nThree.');
  // "One\n" 1..5, " two.\n" 5..11: delete the newline at 10.
  docs.Documents.batchUpdate({ requests: [{ deleteContentRange: { range: { startIndex: 10, endIndex: 11 } } }] }, id);
  assert.equal(docs.textOf(id), 'One\n two.Three.');
});

test('inserted text takes the link of the character before it, as the Docs editor does ⚑', () => {
  const docs = createFakeDocs();
  const id = docs.create({ text: 'See [NASA](https://nasa.gov)1998 data.' });
  const all = docs.rangeText(id, null, 0, 1000);
  const at = 1 + all.indexOf('1998');
  docs.Documents.batchUpdate({ requests: [{ insertText: { text: 'X', location: { index: at } } }] }, id);
  const s = LenzSerialize.serialize(docs.Documents.get(id, GET), null).text;
  assert.equal(s, 'See [NASAX](https://nasa.gov)1998 data.');
});

test('coauthorReplace edits by text, inside a table too, with no writeControl', () => {
  const docs = createFakeDocs();
  const id = docs.create({ tabs: [{ tabId: 't.0', blocks: [p(run('Top.')), { table: [[[p(run('cell one'))]]] }, p(run('End.'))] }] });
  assert.equal(docs.coauthorReplace(id, 'one', 'two'), true);
  assert.equal(docs.coauthorReplace(id, 'End', ''), true);
  assert.equal(docs.coauthorReplace(id, 'missing', 'x'), false);
  assert.equal(docs.textOf(id), 'Top.\ncell two\n.');
});

test('onBeforeNextBatch runs once, before the revision check', () => {
  const docs = createFakeDocs();
  const id = docs.create({ text: 'Alpha beta.' });
  let calls = 0;
  docs.onBeforeNextBatch((docId) => { calls += 1; docs.coauthorReplace(docId, 'Alpha', 'Omega'); });
  const rev = docs.revision(id);
  assert.throws(() => docs.Documents.batchUpdate({ requests: [], writeControl: { requiredRevisionId: rev } }, id),
    /does not match/);
  docs.Documents.batchUpdate({ requests: [], writeControl: { requiredRevisionId: docs.revision(id) } }, id);
  assert.equal(calls, 1);
  assert.equal(docs.textOf(id), 'Omega beta.');
});

test('a single newline in review text is a soft break, and survives an edit elsewhere', () => {
  const docs = createFakeDocs();
  const id = docs.create({ text: 'Line one\nline two.\n\nOther paragraph.' });
  const read = () => LenzSerialize.serialize(docs.Documents.get(id, GET), null).text;
  assert.equal(read(), 'Line one\nline two.\n\nOther paragraph.');
  assert.equal(docs.coauthorReplace(id, 'Other', 'Another'), true);
  assert.equal(read(), 'Line one\nline two.\n\nAnother paragraph.');
});

test('coauthorReplace with { last: true } edits the last occurrence', () => {
  const docs = createFakeDocs();
  const id = docs.create({ text: 'Same.\n\nSame.' });
  docs.coauthorReplace(id, 'Same', 'Last', undefined, { last: true });
  assert.equal(docs.textOf(id), 'Same.\nLast.');
});
