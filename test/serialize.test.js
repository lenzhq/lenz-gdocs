const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../src/serialize.js');
const { doc, tab, para, run } = require('./fixtures/docs/build.js');

const FIX = path.join(__dirname, 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, 'docs', name + '.json'), 'utf8'));
const HAND = fs.readdirSync(path.join(FIX, 'docs')).filter((f) => /^hand-.*\.json$/.test(f)).map((f) => f.slice(0, -5));

// The tab body as one UTF-16 string at REST indexes (text runs only; everything else is '\0').
function bodyString(document, tabId) {
  const all = [];
  (function flat(tabs) { (tabs || []).forEach((t) => { all.push(t); flat(t.childTabs); }); })(document.tabs);
  const t = tabId ? all.find((x) => x.tabProperties.tabId === tabId) : all[0];
  const chars = [];
  (function walk(content) {
    for (const se of content) {
      if (se.paragraph) {
        for (const el of se.paragraph.elements) {
          const c = el.textRun ? el.textRun.content : '\0';
          for (let i = 0; i < c.length; i++) chars[el.startIndex + i] = c[i];
        }
      } else if (se.table) se.table.tableRows.forEach((r) => r.tableCells.forEach((c) => walk(c.content)));
      else if (se.tableOfContents) walk(se.tableOfContents.content);
    }
  })(t.documentTab.body.content);
  return Array.from(chars, (c) => (c === undefined ? '\0' : c)).join('');
}

const at = (out, s) => {
  const rs = S.cpLength(out.text.slice(0, out.text.indexOf(s)));
  return [rs, rs + S.cpLength(s)];
};

// ---- invariants on every fixture ----

for (const name of HAND) {
  test(`${name}: pieces are ordered, contiguous and cover the text`, () => {
    const out = S.serialize(load(name), null);
    let pos = 0;
    for (const p of out.pieces) {
      assert.equal(p.rs, pos);
      assert.ok(p.re > p.rs);
      pos = p.re;
    }
    assert.equal(pos, S.cpLength(out.text));
  });

  test(`${name}: every plain text piece reads the same text in the Doc`, () => {
    const d = load(name);
    const out = S.serialize(d, null);
    const body = bodyString(d, null);
    for (const p of out.pieces) {
      if (p.kind !== 'text' || p.flags.atomic) continue;
      assert.equal(body.slice(p.ds, p.de).replace(/\u000b/g, '\n'), S.cpSlice(out.text, p.rs, p.re));
    }
  });
}

// ---- rules ----

test('paragraphs: joined by a blank line; empty and tab-only paragraphs add nothing', () => {
  const out = S.serialize(load('hand-paragraphs'), null);
  assert.equal(out.text,
    'The first paragraph.\n\n   \n\nSecond, in two runs.\n\nLine one\nline two\n\nCol\tafter tab');
  assert.equal(out.truncated, false);
  assert.equal(out.textHash, null);
  assert.equal(out.tabId, 't.0');
  assert.equal(out.revisionId, 'rev-paragraphs');
  const sep = out.pieces[1];
  assert.deepEqual([sep.kind, sep.ds, sep.de, sep.rs, sep.re], ['synthetic', null, null, 20, 22]);
});

test('paragraphs: para is the ordinal of every paragraph in the body, skipped ones counted', () => {
  const out = S.serialize(load('hand-paragraphs'), null);
  const paraOf = (s) => out.pieces.find((p) => p.rs === at(out, s)[0]).para;
  assert.equal(paraOf('The first'), 0);
  assert.equal(paraOf('   '), 2);
  assert.equal(paraOf('Second'), 4);
  assert.equal(paraOf('Col'), 6);
});

test('soft break is \\n and keeps its one REST index', () => {
  const out = S.serialize(load('hand-paragraphs'), null);
  const [rs, re] = at(out, 'one\nline');
  const r = S.toRestRanges(out.pieces, rs, re, out.text);
  assert.deepEqual(r.ranges, [{ startIndex: 55, endIndex: 63 }]);
  assert.equal(r.clean, true);
});

test('links: every url link is [words](url), any scheme; every linked run is its own link, as the export writes it', () => {
  const out = S.serialize(load('hand-links'), null);
  assert.equal(out.text, [
    'See [the report](https://example.org/r?a=1&b=2) and [mail us](mailto:info@example.org).',
    '[Split ](https://example.org/split)[link](https://example.org/split) end.',
    'Heading link stays plain.',
    'Chip: [Quarterly report](https://docs.google.com/document/d/abc) done.',
    'By [Ana Novak](mailto:ana@example.org) on Sep 30, 2026.',
  ].join('\n\n'));
});

test('links: words are link text pieces, brackets and url are synthetic', () => {
  const out = S.serialize(load('hand-links'), null);
  const words = out.pieces.find((p) => p.rs === at(out, 'the report')[0]);
  assert.deepEqual([words.kind, words.flags.link], ['text', true]);
  const open = out.pieces.find((p) => p.re === words.rs);
  assert.deepEqual([open.kind, open.ds, open.flags.link], ['synthetic', null, true]);
  const [rs, re] = at(out, 'the report');
  assert.equal(S.toRestRanges(out.pieces, rs, re, out.text).clean, true);
  assert.equal(S.toRestRanges(out.pieces, rs - 1, re, out.text).clean, false);
});

test('RichLink is [title](url); its title is atomic and maps to the chip', () => {
  const d = load('hand-links');
  const out = S.serialize(d, null);
  const [rs, re] = at(out, 'Quarterly report');
  const p = out.pieces.find((x) => x.rs === rs);
  assert.deepEqual([p.re, p.flags.atomic, p.flags.link, p.de - p.ds], [re, true, true, 1]);
  const r = S.toRestRanges(out.pieces, rs + 2, rs + 4, out.text);
  assert.deepEqual(r, { ranges: [{ startIndex: p.ds, endIndex: p.de }], clean: false });
});

test('a Person chip is [name](mailto:email), a Date chip its display text; both atomic', () => {
  const out = S.serialize(load('hand-links'), null);
  for (const [s, link] of [['Ana Novak', true], ['Sep 30, 2026', false]]) {
    const p = out.pieces.find((x) => x.rs === at(out, s)[0]);
    assert.deepEqual([p.re - p.rs, p.de - p.ds, p.flags.atomic, p.flags.link], [s.length, 1, true, link]);
  }
  const d = load('hand-links');
  const person = d.tabs[0].documentTab.body.content[5].paragraph.elements[1].person;
  delete person.personProperties.email;
  assert.ok(S.serialize(d, null).text.endsWith('By Ana Novak on Sep 30, 2026.'));
});

test('suggestions read as accepted: deletions out, insertions in and flagged', () => {
  const out = S.serialize(load('hand-suggestions'), null);
  assert.equal(out.text,
    'Revenue grew 12% last year.\n\nKept.\n\nKeep A\n\nKeep B\n\nRow C\n\nNew cell\n\nAfter table.');
  const ins = out.pieces.find((p) => p.rs === at(out, '12%')[0]);
  assert.equal(ins.flags.suggested, true);
  assert.equal(S.toRestRanges(out.pieces, ...at(out, '12%'), out.text).clean, false);
});

test('a range across a suggested deletion is not clean (the Doc has text between)', () => {
  const out = S.serialize(load('hand-suggestions'), null);
  const [rs] = at(out, 'grew');
  const r = S.toRestRanges(out.pieces, rs, rs + 'grew 12'.length, out.text);
  assert.equal(r.clean, false);
  assert.equal(r.ranges.length, 2);
});

test('table suggestions propagate: a deleted row is out, an inserted cell is in and flagged', () => {
  const out = S.serialize(load('hand-suggestions'), null);
  assert.ok(!out.text.includes('Gone'));
  const cell = out.pieces.find((p) => p.rs === at(out, 'New cell')[0]);
  assert.equal(cell.flags.suggested, true);
  const rowC = out.pieces.find((p) => p.rs === at(out, 'Row C')[0]);
  assert.equal(rowC.flags.suggested, false);
});

test('astral characters: cp in the text, u16 in the Doc', () => {
  const out = S.serialize(load('hand-astral'), null);
  assert.equal(out.text, 'Party 🎉 time, café ☕ and 𝒜𝒷𝒸.\n\n[👍🏽](https://example.org/thumb) ok');
  const p = out.pieces[0];
  assert.equal(p.re - p.rs, S.cpLength('Party 🎉 time, café ☕ and 𝒜𝒷𝒸.'));
  assert.equal(p.de - p.ds, 'Party 🎉 time, café ☕ and 𝒜𝒷𝒸.'.length);
});

test('toRestRanges: a range starting and ending mid-piece around an emoji', () => {
  const d = load('hand-astral');
  const out = S.serialize(d, null);
  const body = bodyString(d, null);
  for (const s of ['time', '🎉 time', 'y 🎉 t', '𝒷', '𝒜𝒷𝒸.', 'café ☕ and 𝒜']) {
    const [rs, re] = at(out, s);
    const r = S.toRestRanges(out.pieces, rs, re, out.text);
    assert.equal(r.clean, true, s);
    assert.equal(r.ranges.length, 1, s);
    assert.equal(body.slice(r.ranges[0].startIndex, r.ranges[0].endIndex), s);
  }
  const [rs, re] = at(out, 'time');
  assert.deepEqual(S.toRestRanges(out.pieces, rs, re, out.text).ranges, [{ startIndex: 10, endIndex: 14 }]);
});

test('toRestRanges: crossing a paragraph is not clean; outside the pieces is null', () => {
  const out = S.serialize(load('hand-paragraphs'), null);
  const [rs] = at(out, 'paragraph.');
  const [, re] = at(out, 'Second');
  assert.equal(S.toRestRanges(out.pieces, rs, re, out.text).clean, false);
  assert.equal(S.toRestRanges(out.pieces, 0, S.cpLength(out.text) + 1, out.text), null);
  assert.equal(S.toRestRanges(out.pieces, -1, 2, out.text), null);
  assert.equal(S.toRestRanges(out.pieces, 5, 3, out.text), null);
  assert.equal(S.toRestRanges([], 0, 0, ''), null);
});

test('toRestRanges: an empty range is a caret inside its piece', () => {
  const out = S.serialize(load('hand-paragraphs'), null);
  assert.deepEqual(S.toRestRanges(out.pieces, 4, 4, out.text), { ranges: [{ startIndex: 5, endIndex: 5 }], clean: true });
});

test('tabs: null is the first tab; a tabId picks any tab, child tabs included', () => {
  const d = load('hand-tabs');
  assert.equal(S.serialize(d, null).text, 'First tab text.');
  assert.equal(S.serialize(d, 't.child').text, 'Child tab text.');
  const second = S.serialize(d, 't.1');
  assert.deepEqual([second.text, second.tabId, second.notRead.otherTabs], ['Second tab text.', 't.1', 2]);
  assert.throws(() => S.serialize(d, 't.missing'));
  assert.throws(() => S.serialize({ revisionId: 'r', body: { content: [] } }, null));
});

test('not read: footnotes, headers, footers, images, equations, other chips are counted', () => {
  const out = S.serialize(load('hand-not-read'), null);
  assert.equal(out.text, [
    'Footnoted claim.', 'Picture  here.', 'Equation above.', 'Page .', 'Before break\nafter break',
    'Deleted image gone.', 'Contents entry',
  ].join('\n\n'));
  assert.deepEqual(out.notRead,
    { footnotes: 1, headers: 1, footers: 1, images: 2, equations: 1, otherChips: 1, otherTabs: 0 });
});

test('not read: a range across a skipped element is not clean', () => {
  const out = S.serialize(load('hand-not-read'), null);
  assert.equal(S.toRestRanges(out.pieces, ...at(out, 'Footnoted claim'), out.text).clean, false);
  assert.equal(S.toRestRanges(out.pieces, ...at(out, 'Footnoted'), out.text).clean, true);
});

test('a page break is \\n, atomic, on its one index', () => {
  const out = S.serialize(load('hand-not-read'), null);
  const [rs] = at(out, '\nafter break');
  const p = out.pieces.find((x) => x.rs === rs);
  assert.deepEqual([p.re - p.rs, p.de - p.ds, p.flags.atomic], [1, 1, true]);
});

// ---- the cap ----

function bigDoc(items) {
  return doc('big', [tab('t.0', 'Tab 1', items)]);
}

test('cap: 50,000 code points, the cut backs out of a link', () => {
  const filler = 'a'.repeat(S.CAP - 10) + ' ';
  const out = S.serialize(bigDoc([para([run(filler), run('the words', { url: 'https://example.org/x' }), run(' tail')])]), null);
  assert.equal(out.truncated, true);
  assert.ok(out.text === filler, 'cut at the link start');
  assert.equal(out.pieces[out.pieces.length - 1].re, S.cpLength(filler));
});

test('cap: the cut never keeps a paragraph break at the end, whole or half', () => {
  for (const n of [S.CAP - 1, S.CAP - 2]) {
    const first = 'b'.repeat(n);
    const out = S.serialize(bigDoc([para([run(first)]), para([run('next paragraph')])]), null);
    assert.equal(out.truncated, true);
    assert.equal(out.text.length, n);
    assert.equal(out.pieces.length, 1);
  }
});

test('cap: the cut backs out of an atomic chip', () => {
  const first = 'd'.repeat(S.CAP - 4) + ' ';
  const out = S.serialize(bigDoc([para([run(first), { type: 'person', name: 'Ana Novak', email: 'a@x.org', o: {} }])]), null);
  assert.equal(out.text.length, first.length);
  assert.equal(out.pieces[out.pieces.length - 1].flags.atomic, false);
});

test('cap: a text piece cut mid-way keeps a u16 end that fits its astral characters', () => {
  const out = S.serialize(bigDoc([para([run('🎉'.repeat(S.CAP + 5))])]), null);
  assert.equal(S.cpLength(out.text), S.CAP);
  const p = out.pieces[0];
  assert.deepEqual([p.rs, p.re, p.de - p.ds], [0, S.CAP, S.CAP * 2]);
});

test('cap: exactly 50,000 is not truncated', () => {
  const out = S.serialize(bigDoc([para([run('c'.repeat(S.CAP))])]), null);
  assert.equal(out.truncated, false);
  assert.equal(S.cpLength(out.text), S.CAP);
});

// ---- helpers ----

test('cp helpers', () => {
  const s = 'a🎉b𝒜';
  assert.equal(S.cpLength(s), 4);
  assert.equal(S.cpLength(''), 0);
  assert.equal(S.cpToU16(s, 0), 0);
  assert.equal(S.cpToU16(s, 2), 3);
  assert.equal(S.cpToU16(s, 4), 6);
  assert.throws(() => S.cpToU16(s, 5), RangeError);
  assert.throws(() => S.cpToU16(s, -1), RangeError);
  assert.equal(S.cpSlice(s, 1, 3), '🎉b');
  assert.equal(S.cpSlice(s, 3), '𝒜');
  assert.equal(S.cpLength('\ud800x'), 2); // a lone surrogate is one code point
});

// ---- parity with Lenz's .docx reader ----

test('parity: the same document gives the text Lenz\'s .docx reader gives its .docx export', () => {
  assert.ok(fs.existsSync(path.join(FIX, 'parity', 'basic.docx')));
  const expected = fs.readFileSync(path.join(FIX, 'parity', 'basic.txt'), 'utf8');
  assert.equal(S.serialize(load('hand-parity-basic'), null).text, expected);
});

test('the module uses no Apps Script globals and no post-ES2019 syntax', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'serialize.js'), 'utf8');
  for (const g of ['DocumentApp', 'Docs.', 'UrlFetchApp', 'PropertiesService', 'CacheService', 'Utilities', 'LockService', 'Session']) {
    assert.ok(!src.includes(g), g);
  }
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\?\.|\?\?|\brequire\(|\bimport\b|\bexport\b/.test(code));
});

test('the file loads as Apps Script does: one global scope, no module', () => {
  const vm = require('node:vm');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'serialize.js'), 'utf8');
  const ctx = vm.createContext({});
  vm.runInContext(src, ctx);
  assert.equal(vm.runInContext('LenzSerialize.serialize(' + JSON.stringify(load('hand-tabs')) + ', null).text', ctx),
    'First tab text.');
});

// ---- review fixes ----

function withBody(items, documentTab) {
  return doc('x', [tab('t.0', 'Tab 1', items, { documentTab })]);
}

test('a suggested-deleted table of contents is out; a suggested-inserted one is flagged', () => {
  const d = load('hand-not-read');
  const content = d.tabs[0].documentTab.body.content;
  const toc = content.find((se) => se.tableOfContents);
  toc.tableOfContents.suggestedDeletionIds = ['s1'];
  assert.ok(!S.serialize(d, null).text.includes('Contents entry'));
  delete toc.tableOfContents.suggestedDeletionIds;
  toc.tableOfContents.suggestedInsertionIds = ['s2'];
  const out = S.serialize(d, null);
  const r = S.toRestRanges(out.pieces, ...at(out, 'Contents entry'), out.text);
  assert.equal(r.clean, false);
});

test('U+E907 placeholders are not read, counted, and leave a gap in the map', () => {
  const d = withBody([para([run('AB')])]);
  const out = S.serialize(d, null);
  assert.equal(out.text, 'AB');
  assert.equal(out.notRead.otherChips, 1);
  assert.deepEqual(S.toRestRanges(out.pieces, 1, 2, out.text), { ranges: [{ startIndex: 3, endIndex: 4 }], clean: true });
  assert.equal(S.toRestRanges(out.pieces, 0, 2, out.text).clean, false);
  assert.equal(S.serialize(withBody([para([run('')])]), null).text, '');
});

test('cap: link syntax typed as plain text is not cut either', () => {
  const lead = 'a'.repeat(S.CAP - 2);
  const out = S.serialize(withBody([para([run(lead + '[x](https://example.org) more')])]), null);
  assert.equal(out.truncated, true);
  assert.equal(out.text.length, lead.length);
});

test('a suggested-deleted positioned image is not counted', () => {
  const d = withBody([para([run('Text')], { positionedObjectIds: ['img1', 'img2'] })],
    { positionedObjects: { img1: { objectId: 'img1', suggestedDeletionIds: ['s1'] }, img2: { objectId: 'img2' } } });
  assert.equal(S.serialize(d, null).notRead.images, 1);
});

test('headers and footers holding only deleted or blank text are not counted', () => {
  const d = withBody([para([run('Body')])]);
  const seg = (content) => ({ content: [{ startIndex: 0, endIndex: content.length, paragraph: { elements: [
    { startIndex: 0, endIndex: content.length, textRun: Object.assign({ content, textStyle: {} }, content === 'deleted\n' ? { suggestedDeletionIds: ['s1'] } : {}) },
  ] } }] });
  d.tabs[0].documentTab.headers = { h1: seg('deleted\n'), h2: seg('  \n'), h3: seg('kept\n') };
  d.tabs[0].documentTab.footers = { f1: seg('deleted\n') };
  const nr = S.serialize(d, null).notRead;
  assert.deepEqual([nr.headers, nr.footers], [1, 0]);
});
