// The spike Doc as Google returned it (2026-09-30; the Person chip's name and email replaced).
// Its .docx export went through Lenz's .docx reader: test/fixtures/parity/real-spike.{docx,txt}.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/serialize.js');
const K = require('../src/spike.js');

const FIX = path.join(__dirname, 'fixtures');
const doc = JSON.parse(fs.readFileSync(path.join(FIX, 'docs', 'real-spike.json'), 'utf8'));
const tabs = doc.tabs.map((t) => t.tabProperties);

test('real: invariants hold on every tab', () => {
  for (const t of tabs) assert.deepEqual(K.checkInvariants(doc, t.tabId, S.serialize(doc, t.tabId)), [], t.tabId);
});

test('real: the .docx export is every tab under its title, each tab the text serialize() reads', () => {
  const expected = fs.readFileSync(path.join(FIX, 'parity', 'real-spike.txt'), 'utf8');
  const joined = tabs.map((t) => t.title + '\n\n' + S.serialize(doc, t.tabId).text).join('\n\n');
  assert.equal(joined, expected);
});

test('real: the shapes the spike Doc showed', () => {
  const out = S.serialize(doc, tabs[0].tabId);
  assert.ok(out.text.includes('Soft\nbreak, and a tab:\there.'));
  assert.ok(out.text.includes('[two ](https://lenz.io/split)[runs](https://lenz.io/split)'));
  assert.ok(out.text.includes('Person chip: [Ana Novak](mailto:ana@example.org) after the chip.'));
  assert.ok(out.text.includes('Page break follows:\n'));
  assert.deepEqual([out.notRead.footnotes, out.notRead.headers, out.notRead.otherTabs], [1, 1, 1]);
  const paras = K.paragraphs(doc, tabs[0].tabId);
  assert.ok(paras.some((p) => p.bullet));
  assert.ok(paras.some((p) => p.elements.indexOf('person') >= 0));
});

test('real: ranges map to the words in a link, after the chip and in a table cell', () => {
  const out = S.serialize(doc, tabs[0].tabId);
  const paras = K.paragraphs(doc, tabs[0].tabId);
  for (const [find, within] of [['brown', 'quick brown fox'], ['after the chip', 'after the chip'], ['Cell B1', 'Cell B1']]) {
    const loc = K.locate(out.text, find, within);
    const r = S.toRestRanges(out.pieces, loc.rs, loc.re, out.text);
    assert.equal(r.clean, true, find);
    const piece = out.pieces.find((p) => p.rs <= loc.rs && loc.rs < p.re);
    const para = paras[piece.para];
    assert.equal(para.text.slice(r.ranges[0].startIndex - para.startIndex, r.ranges[0].endIndex - para.startIndex), find);
  }
});
