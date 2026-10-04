// The round-2 spike Doc (2026-09-30), with every case the spike asked for, hand-made ones included:
// suggestions (one in a table), RichLink, Date chip, table of contents, inline image. Scrubbed: the
// linked Doc's id and title, the image (a 1x1 PNG) and its signed URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/serialize.js');
const K = require('../src/spike.js');

const FIX = path.join(__dirname, 'fixtures');
const doc = JSON.parse(fs.readFileSync(path.join(FIX, 'docs', 'real-spike-2.json'), 'utf8'));
const tabs = doc.tabs.map((t) => t.tabProperties);
const exported = fs.readFileSync(path.join(FIX, 'parity', 'real-spike-2.txt'), 'utf8');
const ours = () => tabs.map((t) => t.title + '\n\n' + S.serialize(doc, t.tabId).text).join('\n\n');

// Lenz's .docx reader reads a paragraph's tab-stop definition (w:pPr/w:tabs/w:tab, same tag as a tab
// character) as "\t": the table of contents entry gains a leading tab. A Lenz bug, not copied here.
// When Lenz fixes it, regenerate real-spike-2.txt (scripts/spike-report.js --parity) and delete this.
const READPY_TAB_STOP = '\tLenz spike document: a plain paragraph.\t1';

test('real 2: invariants hold on every tab', () => {
  for (const t of tabs) assert.deepEqual(K.checkInvariants(doc, t.tabId, S.serialize(doc, t.tabId)), [], t.tabId);
});

test('real 2: the export is every tab under its title, apart from the reader\'s tab-stop bug', () => {
  assert.ok(exported.includes(READPY_TAB_STOP), 'reader fixed? regenerate real-spike-2.txt and drop READPY_TAB_STOP');
  assert.equal(ours(), exported.replace(READPY_TAB_STOP, READPY_TAB_STOP.slice(1)));
});

test('real 2: suggestions, chips, contents and image as Google returns them', () => {
  const out = S.serialize(doc, tabs[0].tabId);
  assert.ok(out.text.startsWith('Lenz spike document: a paragraph.')); // the suggested deletion of "plain" is out
  const extra = out.pieces.find((p) => S.cpSlice(out.text, p.rs, p.re).includes('extra'));
  assert.equal(extra.flags.suggested, true); // the suggested insertion inside the table
  assert.ok(out.text.includes('[A linked Doc](https://docs.google.com/document/d/EXAMPLE-DOC-ID/edit?tab=t.0)'));
  assert.ok(out.text.includes('Lenz spike document: a plain paragraph.\t1')); // the contents entry, not refreshed
  assert.deepEqual(out.notRead, { footnotes: 1, headers: 1, footers: 0, images: 1, equations: 0, otherChips: 0, otherTabs: 1 });
  const date = out.pieces.find((p) => p.flags.atomic && !p.flags.link && p.de - p.ds === 1 &&
    /\d/.test(S.cpSlice(out.text, p.rs, p.re)));
  assert.ok(date, 'the Date chip is an atomic piece');
});
