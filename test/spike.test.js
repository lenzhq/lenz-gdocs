const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const S = require('../src/serialize.js');
const K = require('../src/spike.js');
const { parseRunOutput } = require('../scripts/spike-report.js');

const FIX = path.join(__dirname, 'fixtures', 'docs');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIX, name + '.json'), 'utf8'));
const HAND = fs.readdirSync(FIX).filter((f) => /^hand-.*\.json$/.test(f)).map((f) => f.slice(0, -5));

// Applies insertText / deleteContentRange to a body string at REST indexes (body[0] = index 0).
function simulate(body, requests) {
  for (const r of requests) {
    if (r.insertText) {
      const i = r.insertText.location.index;
      body = body.slice(0, i) + r.insertText.text + body.slice(i);
    } else if (r.deleteContentRange) {
      const { startIndex, endIndex } = r.deleteContentRange.range;
      body = body.slice(0, startIndex) + body.slice(endIndex);
    }
  }
  return body;
}

// A check output as dev.js would return it for a fixture, DocumentApp texts taken from REST.
function fakeCheck(doc, over = {}) {
  const tabId = K.findTab(doc, null).tabProperties.tabId;
  return Object.assign({
    kind: 'lenz-spike-check', tabId, dump: doc,
    documentApp: { paragraphTexts: K.paragraphs(doc, tabId).map((p) => p.text) },
    select: [{ want: 'x', rangeText: 'x' }],
    apply: K.APPLY_TARGETS.map((t) => ({ id: t.id, strategy: t.strategy, textOk: true, linkKept: t.strategy !== 'before',
      boldKept: true })),
    conflict: { error: 'The required revision ID does not match the latest revision.' },
  }, over);
}

// A Doc holding every case the spike requires (item 1), from the fixture builder.
function fullDoc() {
  const { doc, tab, para, run } = require('./fixtures/docs/build.js');
  const obj = (key, value, o = {}) => ({ type: 'obj', key, value, o });
  const d = doc('full', [
    tab('t.0', 'Tab 1', [
      para([run('Soft\u000bbreak and '), run('two ', { url: 'https://lenz.io/split' }), run('runs', { url: 'https://lenz.io/split' })]),
      para([run('Chip '), { type: 'person', name: 'Ana Novak', email: 'ana@example.org', o: {} }, run(' after the chip.')]),
      para([run('Rich '), { type: 'richLink', title: 'A file', uri: 'https://drive.google.com/x', o: {} }, run('.')]),
      para([run('Break'), obj('pageBreak', {})]),
      para([run('Note'), obj('footnoteReference', { footnoteId: 'f1' }), run(' after.')]),
      para([run('Revenue '), run('10%', { del: 's1' }), run('12%', { ins: 's1' })]),
      para([run('First item')]),
      { type: 'table', rows: [{ cells: [[para([run('Cell B1')])], [para([run('Cell B2')])]] }], o: {} },
    ]),
    tab('t.1', 'Second', [para([run('Second tab text.')])]),
  ]);
  const listPara = d.tabs[0].documentTab.body.content.find((se) => se.paragraph &&
    se.paragraph.elements[0].textRun && se.paragraph.elements[0].textRun.content.startsWith('First item'));
  listPara.paragraph.bullet = { listId: 'l1' };
  return d;
}

// ---- the plan ----

test('plan: every style covers the words it styles', () => {
  const plan = K.buildPlan();
  const at = (s, e) => plan.text.slice(s - 1, e - 1);
  const styled = plan.styles.map((s) => [at(s.start, s.end), s.fields]);
  assert.deepEqual(styled, [
    ['the website', 'link'], ['mail us', 'link'], ['call', 'link'], ['two ', 'link'], ['runs', 'bold,link'],
    ['quick brown fox', 'bold,link'], ['replace me', 'link'], ['second link', 'link'], ['lazy dog', 'bold,link'],
  ]);
  assert.equal(at(plan.bullets[0].start, plan.bullets[0].end), 'First item\nSecond item\nThird item');
});

test('plan: structural inserts sit where they belong, highest index first', () => {
  const plan = K.buildPlan();
  const before = (i) => plan.text.slice(0, i - 1);
  const byKind = Object.fromEntries(plan.structural.map((s) => [s.kind, s]));
  assert.ok(before(byKind.softBreak.index).endsWith('Soft'));
  assert.ok(before(byKind.table.index).endsWith('Before the table.'));
  assert.ok(before(byKind.person.index).endsWith('Person chip: '));
  assert.ok(before(byKind.pageBreak.index).endsWith('Page break follows:'));
  assert.ok(before(byKind.footnote.index).endsWith('Footnote here'));
  const idx = plan.structural.map((s) => s.index);
  assert.deepEqual(idx, [...idx].sort((a, b) => b - a));
  // Indexes are u16: the emoji before them count two each.
  assert.ok(plan.text.length > S.cpLength(plan.text));
});

test('plan: the requests are well formed; the manual list names what the API cannot make', () => {
  const plan = K.buildPlan();
  const reqs = K.textRequests(plan);
  assert.deepEqual(reqs[0], { insertText: { location: { index: 1 }, text: plan.text } });
  assert.equal(reqs.filter((r) => r.updateTextStyle).length, plan.styles.length);
  assert.equal(reqs.filter((r) => r.createParagraphBullets).length, 1);
  for (const item of plan.structural) {
    const r = K.structuralRequests(item);
    assert.equal(r.length, 1);
    assert.equal(Object.values(r[0])[0].location.index, item.index);
  }
  assert.throws(() => K.structuralRequests({ kind: 'nope', index: 1 }));
  const manual = plan.manual.join(' ');
  for (const w of ['suggest', 'RichLink', 'Date chip', 'table of contents', 'image']) assert.ok(manual.includes(w), w);
});

test('plan text inserted as is serializes to what the spike checks look for', () => {
  const plan = K.buildPlan();
  const { doc, tab, para, run } = require('./fixtures/docs/build.js');
  // One run per paragraph, links as their own runs: enough to check the Apply targets are found.
  const paras = plan.text.split('\n').map((t) => para(t ? [run(t)] : []));
  const out = S.serialize(doc('plan', [tab('t.0', 'T', paras)]), null);
  for (const t of K.APPLY_TARGETS) assert.ok(K.locate(out.text, t.find, t.within), t.id);
});

test('table fill: one insert per cell, highest index first', () => {
  const d = load('hand-suggestions');
  const reqs = K.tableFillRequests(d, 't.0', ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(reqs.length, 6);
  const idx = reqs.map((r) => r.insertText.location.index);
  assert.deepEqual(idx, [...idx].sort((a, b) => b - a));
  assert.equal(reqs[5].insertText.text, 'a');
  assert.deepEqual(K.tableFillRequests(load('hand-paragraphs'), 't.0', ['a']), []);
});

// ---- reading ----

test('paragraphs: ordinals as serialize numbers them, chips as one index', () => {
  const d = load('hand-links');
  const paras = K.paragraphs(d, 't.0');
  assert.equal(paras.length, 5);
  assert.equal(paras[4].text, 'By ￼ on ￼.');
  assert.deepEqual(paras[4].elements, ['person', 'dateElement']);
  const out = S.serialize(d, null);
  for (const p of out.pieces) if (p.kind === 'text') assert.ok(p.para < paras.length);
});

test('runAt and linkUrl read the run holding an index', () => {
  const d = load('hand-links');
  const out = S.serialize(d, null);
  const loc = K.locate(out.text, 'report', 'the report');
  const r = S.toRestRanges(out.pieces, loc.rs, loc.re, out.text).ranges[0];
  const run = K.runAt(d, 't.0', r.startIndex);
  assert.equal(run.content, 'the report');
  assert.equal(K.linkUrl(run.textStyle), 'https://example.org/r?a=1&b=2');
  assert.equal(K.runAt(d, 't.0', 100000), null);
  assert.equal(K.linkUrl({}), null);
});

// ---- checks ----

for (const name of HAND) {
  test(`${name}: invariants hold and DocumentApp texts taken from REST agree`, () => {
    const d = load(name);
    const tabId = K.findTab(d, null).tabProperties.tabId;
    const out = S.serialize(d, tabId);
    assert.deepEqual(K.checkInvariants(d, tabId, out), []);
    const cmp = K.checkDocumentApp(d, tabId, out, K.paragraphs(d, tabId).map((p) => p.text));
    assert.deepEqual(cmp.pieces, []);
    assert.deepEqual(cmp.paragraphs, []);
  });
}

test('checkDocumentApp: chips missing from DocumentApp text shift the pieces after them', () => {
  const d = load('hand-links');
  const out = S.serialize(d, null);
  const texts = K.paragraphs(d, 't.0').map((p) => p.text.replace(/￼/g, ''));
  const cmp = K.checkDocumentApp(d, 't.0', out, texts);
  assert.equal(cmp.paragraphs.find((p) => p.ordinal === 4).status, 'equal-without-chips');
  assert.ok(cmp.pieces.some((p) => p.want === ' on '));
});

test('checkDocumentApp: a soft break as \\r still agrees; a missing paragraph does not', () => {
  const d = load('hand-paragraphs');
  const out = S.serialize(d, null);
  const texts = K.paragraphs(d, 't.0').map((p) => p.text.replace(/\u000b/g, '\r'));
  const cmp = K.checkDocumentApp(d, 't.0', out, texts);
  assert.deepEqual(cmp.pieces, []);
  assert.equal(cmp.paragraphs[0].status, 'equal-normalized');
  const short = K.checkDocumentApp(d, 't.0', out, texts.slice(0, 3));
  assert.ok(short.pieces.length > 0);
  assert.equal(short.documentAppCount, 3);
});

test('checkInvariants catches a piece whose REST text differs', () => {
  const d = load('hand-paragraphs');
  const out = S.serialize(d, null);
  out.pieces[0] = Object.assign({}, out.pieces[0], { ds: out.pieces[0].ds + 1, de: out.pieces[0].de + 1 });
  assert.equal(K.checkInvariants(d, 't.0', out)[0].problem, 'REST text differs');
});

// ---- Apply ----

test('applyBody: both strategies leave the replacement in place of the old text', () => {
  const body = '\0Apply target: the quick brown fox jumps.\n';
  const s = body.indexOf('brown');
  for (const strategy of ['inside', 'before', 'end']) {
    const b = K.applyBody({ startIndex: s, endIndex: s + 5 }, 'red 🎉', 't.0', 'rev1', strategy);
    assert.equal(simulate(body, b.requests), '\0Apply target: the quick red 🎉 fox jumps.\n', strategy);
    assert.deepEqual(b.writeControl, { requiredRevisionId: 'rev1' });
  }
  const one = K.applyBody({ startIndex: s, endIndex: s + 1 }, 'B', 't.0', 'r', 'inside');
  assert.equal(simulate(body, one.requests), '\0Apply target: the quick Brown fox jumps.\n');
  const inside = K.applyBody({ startIndex: s, endIndex: s + 5 }, 'red', 't.0', 'r', 'inside').requests[0];
  assert.equal(inside.insertText.location.index, s + 1); // after the old text's first character
});

test('applyBody end: the add-on\'s own order, insert at the end then delete the old words', () => {
  const b = K.applyBody({ startIndex: 5, endIndex: 9 }, 'new', 't.0', 'r', 'end');
  assert.deepEqual(b.requests, [
    { insertText: { location: { index: 9, tabId: 't.0' }, text: 'new' } },
    { deleteContentRange: { range: { startIndex: 5, endIndex: 9, tabId: 't.0' } } },
  ]);
});

test('evaluate: the end strategy must keep link and bold too', () => {
  const ok = (id) => ({ id, textOk: true, linkKept: true, boldKept: true });
  const four = (v) => v.items.find((i) => i.id === '4').status;
  assert.equal(four(K.evaluate(fakeCheck(fullDoc(), { apply: [ok('partial'), ok('whole-link-inside'),
    Object.assign(ok('glue-end'), { linkKept: false })] }))), 'FAIL');
  // An older report without the end target cannot pass.
  assert.equal(four(K.evaluate(fakeCheck(fullDoc(), { apply: [ok('partial'), ok('whole-link-inside')] }))), 'FAIL');
  assert.equal(four(K.evaluate(fakeCheck(fullDoc(), { apply: [ok('partial'), ok('whole-link-inside'), ok('glue-end')] }))), 'PASS');
});

test('evaluate: an export with every tab under its title passes parity and says so', () => {
  const d = fullDoc();
  const titled = d.tabs.map((t) => t.tabProperties.title + '\n\n' + S.serialize(d, t.tabProperties.tabId).text).join('\n\n');
  const p = K.evaluate(fakeCheck(d), { parityText: titled }).items.find((i) => i.id === '5');
  assert.equal(p.status, 'PASS');
  assert.match(p.detail.scope, /under its title/);
});

test('locate finds the word inside its context; null once replaced', () => {
  const text = 'the [quick brown fox](https://x) and brown';
  const loc = K.locate(text, 'brown', 'quick brown fox');
  assert.equal(text.slice(loc.rs, loc.re), 'brown');
  assert.equal(K.locate('the quick red fox', 'brown', 'quick brown fox'), null);
  const astral = K.locate('🎉 quick brown fox', 'brown', 'quick brown fox');
  assert.deepEqual(astral, { rs: 8, re: 13 });
});

// ---- verdicts ----

test('evaluate: a clean run passes items 1, 3, 4; the rest wait for their inputs', () => {
  const v = K.evaluate(fakeCheck(fullDoc()));
  const st = Object.fromEntries(v.items.map((i) => [i.id, i.status]));
  assert.deepEqual(st, { 1: 'PASS', 2: 'PENDING', 3: 'PASS', 4: 'PASS', 5: 'PENDING', 6: 'PENDING', 7: 'MANUAL',
    8: 'MANUAL', '⚑1': 'PENDING', '⚑2': 'MANUAL', '⚑3': 'PENDING', '⚑4': 'PASS' });
});

test('evaluate: a case missing from the Doc fails item 1 and is named', () => {
  const v = K.evaluate(fakeCheck(load('hand-links')));
  const one = v.items.find((i) => i.id === '1');
  assert.equal(one.status, 'FAIL');
  assert.deepEqual(one.detail.missingFromTheDoc,
    ['pageBreak', 'footnote', 'table', 'softBreak', 'list', 'twoTabs', 'suggestedInsertion', 'suggestedDeletion']);
});

test('evaluate: only the revision refusal proves the conflict; a failed export fails parity', () => {
  const d = fullDoc();
  const quota = K.evaluate(fakeCheck(d, { conflict: { error: 'Service invoked too many times for one day: docs.' } }));
  assert.equal(quota.items.find((i) => i.id === '4').status, 'FAIL');
  const noDocx = K.evaluate(fakeCheck(d, { docxError: 'export 403' }), {});
  const st = Object.fromEntries(noDocx.items.map((i) => [i.id, i.status]));
  assert.deepEqual([st[5], st['⚑1'], st['⚑3']], ['FAIL', 'FAIL', 'FAIL']);
});

test('evaluate: an export holding every tab passes parity and says so', () => {
  const d = fullDoc();
  const all = ['t.0', 't.1'].map((t) => S.serialize(d, t).text).join('\n\n');
  const p = K.evaluate(fakeCheck(d), { parityText: all }).items.find((i) => i.id === '5');
  assert.equal(p.status, 'PASS');
  assert.match(p.detail.scope, /every tab/);
});

test('evaluate: parity, egress and latency fill items 2, 5, 6 and the ⚑ items', () => {
  const d = fullDoc();
  const text = S.serialize(d, null).text;
  const ok = K.evaluate(fakeCheck(d), { parityText: text, egress: { results: [{ code: 401, expect: 401 }, { code: 200, expect: 200 }] },
    latency: { chars: 50000, runs: [{ restGetMs: 900, serializeMs: 40 }] } });
  const st = Object.fromEntries(ok.items.map((i) => [i.id, i.status]));
  assert.deepEqual([st[2], st[5], st[6], st['⚑3']], ['PASS', 'PASS', 'MEASURED', 'PASS']);
  assert.equal(ok.items.find((i) => i.id === '6').detail.worstMs, 940);
  assert.deepEqual([st['⚑1'], st['⚑2']], ['PASS', 'MANUAL']);
  const bad = K.evaluate(fakeCheck(d), { parityText: text + 'x', egress: { results: [{ code: 429, expect: 200 }] } });
  const bs = Object.fromEntries(bad.items.map((i) => [i.id, i.status]));
  assert.deepEqual([bs[2], bs[5], bs['⚑3']], ['FAIL', 'FAIL', 'FAIL']);
  assert.equal(bad.items.find((i) => i.id === '5').detail.thisTab.at, text.length);
  for (const codes of [[302, 200], [200, 404], [500, 500]]) {
    const r = K.evaluate(fakeCheck(d), { egress: { results: [{ code: codes[0], expect: 200 }, { code: codes[1], expect: 401 }] } });
    assert.equal(r.items.find((i) => i.id === '2').status, 'FAIL', String(codes));
  }
});

test('evaluate: a failed Apply, a missing conflict or a DocumentApp error fail their items', () => {
  const d = load('hand-links');
  const v = K.evaluate(fakeCheck(d, { apply: [{ id: 'partial', strategy: 'inside', textOk: true, linkKept: false, boldKept: true }],
    documentApp: { error: 'boom' } }));
  const st = Object.fromEntries(v.items.map((i) => [i.id, i.status]));
  assert.deepEqual([st[3], st[4], st['⚑4']], ['FAIL', 'FAIL', 'FAIL']);
  const noConflict = K.evaluate(fakeCheck(d, { conflict: { error: null } }));
  assert.equal(noConflict.items.find((i) => i.id === '4').status, 'FAIL');
});

test('firstDiff', () => {
  assert.equal(K.firstDiff('abc', 'abc'), null);
  assert.equal(K.firstDiff('abc', 'abd').at, 2);
});

// ---- scripts/spike-report.js ----

test('parseRunOutput reads raw, quoted and wrapped clasp output', () => {
  const v = { kind: 'lenz-spike-egress', results: [] };
  const s = JSON.stringify(v);
  assert.deepEqual(parseRunOutput(s), v);
  assert.deepEqual(parseRunOutput(JSON.stringify(s)), v);
  assert.deepEqual(parseRunOutput('Running in dev mode.\n' + s + '\n'), v);
  assert.deepEqual(parseRunOutput('Running in dev mode.\n' + JSON.stringify(s) + '\n'), v);
  assert.throws(() => parseRunOutput('Script function not found'));
  assert.deepEqual(parseRunOutput(JSON.stringify({ response: s }, null, 2)), v);
  assert.throws(() => parseRunOutput(JSON.stringify({ error: { code: 3, message: 'Script error', details: [] } }, null, 2)),
    /the function failed: .*Script error/);
  assert.throws(() => parseRunOutput(JSON.stringify({ response: null, error: { message: 'boom' } })), /failed/);
});

test('spike-report.js prints the verdict and fails on a FAIL', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spike-'));
  const file = path.join(dir, 'check.txt');
  fs.writeFileSync(file, JSON.stringify(JSON.stringify(fakeCheck(load('hand-links'))))); // missing cases: item 1 FAILs
  let out;
  let code = 0;
  try {
    out = execFileSync('node', [path.join(__dirname, '..', 'scripts', 'spike-report.js'), file], { encoding: 'utf8' });
  } catch (e) {
    code = e.status;
    out = e.stdout;
  }
  assert.equal(code, 1);
  assert.match(out, /\[FAIL\] 1 {2}REST read/);
  assert.match(out, /\[PASS\] 3 {2}REST index/);
  assert.match(out, /\[FAIL\] ⚑1/);
});

// ---- the Apps Script files ----

// Source without comments and string literals, for syntax guards.
function codeOnly(src) {
  return src.replace(/^\s*\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/.*$/gm, '');
}

test('spike.js: no Apps Script globals, ES2019, loads in a bare context beside serialize.js', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'spike.js'), 'utf8');
  const code = codeOnly(src);
  for (const g of ['DocumentApp.', 'Docs.', 'UrlFetchApp.', 'PropertiesService.', 'CacheService.', 'Utilities.',
    'LockService.', 'ScriptApp.', 'Logger.']) assert.ok(!code.includes(g), g);
  assert.ok(!/\?\.|\?\?|\bimport\b|\bexport\b/.test(code));
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'serialize.js'), 'utf8'), ctx);
  vm.runInContext(src, ctx);
  assert.equal(vm.runInContext('LenzSpike.buildPlan().title', ctx), 'Lenz spike');
});

test('dev.js: every entry point is lenzDev_-prefixed, ES2019, and compiles', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dev.js'), 'utf8');
  new vm.Script(src);
  const code = codeOnly(src);
  assert.ok(!/\?\.|\?\?|\bimport\b|\bexport\b/.test(code));
  const fns = [...code.matchAll(/^function (\w+)/gm)].map((m) => m[1]);
  assert.ok(fns.length >= 8);
  for (const f of fns) assert.match(f, /^lenzDev_/);
  for (const f of ['lenzDev_buildSpikeDoc', 'lenzDev_checkSpikeDoc', 'lenzDev_probeEgress', 'lenzDev_buildLargeDoc',
    'lenzDev_timeRead', 'lenzDev_menuSelect', 'lenzDev_menuCheck']) assert.ok(fns.includes(f), f);
});

test('dev.js: checkSpikeDoc refuses a Doc it did not build', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'dev.js'), 'utf8');
  const d = load('hand-links');
  d.title = 'My real draft';
  const ctx = vm.createContext({
    Docs: { Documents: { get: () => d } },
    Logger: { log() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'serialize.js'), 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'spike.js'), 'utf8'), ctx);
  vm.runInContext(src, ctx);
  assert.throws(() => vm.runInContext('lenzDev_checkSpikeDoc("id")', ctx), /not a spike Doc/);
});
