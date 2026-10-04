'use strict';
// The fake Apps Script runtime the glue tests run in (once src/Code.js exists).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRuntime } = require('./helpers/fake-appsscript.js');
const { createFakeDocs } = require('./helpers/fake-docs.js');
const { createFakeLenz } = require('./helpers/fake-lenz.js');

function rt(opts) {
  const docs = createFakeDocs();
  const lenz = createFakeLenz({ apiKey: 'lenz_test_key', pollsBeforeDone: 0 });
  const docId = docs.create({ documentId: 'doc-b', text: lenz.fixture('draft-b').text });
  let t = 1.9e12;
  const r = createRuntime(Object.assign({ docs, lenz, docId, now: () => t }, opts || {}));
  return Object.assign(r, { docs, lenz, docId, tick: (s) => { t += s * 1000; } });
}
const run = (r, code) => vm.runInContext(code, r.ctx);

test('the merged src files load into one global scope, as in Apps Script', () => {
  const r = rt();
  for (const f of ['serialize.js', 'place.js', 'api.js']) assert.ok(r.loaded.includes(f), f);
  assert.equal(run(r, 'typeof LenzSerialize.serialize'), 'function');
  assert.equal(run(r, 'typeof LenzPlace.locate'), 'function');
  assert.equal(run(r, 'typeof LenzApi.create'), 'function');
  assert.equal(run(r, 'typeof module'), 'undefined');
});

test('Utilities.computeDigest returns signed bytes of the UTF-8 sha256', () => {
  const r = rt();
  const bytes = run(r, "Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'Café 🚀', Utilities.Charset.UTF_8)");
  assert.ok(bytes.some((b) => b < 0));
  const hex = bytes.map((b) => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
  assert.equal(hex, crypto.createHash('sha256').update('Café 🚀', 'utf8').digest('hex'));
});

test('UrlFetchApp: throws with no answer; throws on an HTTP error unless muteHttpExceptions', () => {
  const r = rt();
  r.lenz.fail.transport('get');
  assert.throws(() => run(r, "UrlFetchApp.fetch('https://lenz.io/api/v1/reviews/x', {muteHttpExceptions: true})"), /Address unavailable/);
  assert.throws(() => run(r, "UrlFetchApp.fetch('https://lenz.io/api/v1/reviews/x')"), /returned code 401/);
  const code = run(r, "UrlFetchApp.fetch('https://lenz.io/api/v1/reviews/x', {muteHttpExceptions: true}).getResponseCode()");
  assert.equal(code, 401);
});

test('CacheService: refuses values over 100 KB, caps TTL at 6 h, expires on the clock', () => {
  const r = rt();
  assert.throws(() => run(r, "CacheService.getUserCache().put('k', 'x'.repeat(100 * 1024 + 1), 60)"), /too large/);
  run(r, "CacheService.getUserCache().put('k', 'v', 99999)");
  r.tick(21600 - 1);
  assert.equal(run(r, "CacheService.getUserCache().get('k')"), 'v');
  r.tick(2);
  assert.equal(run(r, "CacheService.getUserCache().get('k')"), null);
});

test('DocumentApp: the active doc and tab; paragraphs in body order; setSelection is recorded', () => {
  const r = rt();
  assert.equal(run(r, 'DocumentApp.getActiveDocument().getId()'), 'doc-b');
  assert.equal(run(r, 'DocumentApp.getActiveDocument().getActiveTab().getId()'), 't.0');
  const texts = run(r, 'DocumentApp.getActiveDocument().getActiveTab().asDocumentTab().getBody().getParagraphs().map(function (p) { return p.getText(); })');
  assert.equal(texts[0], 'Quarterly science brief');
  run(r, `var d = DocumentApp.getActiveDocument();
          var p = d.getActiveTab().asDocumentTab().getBody().getParagraphs()[1];
          d.setSelection(d.newRange().addElement(p.editAsText(), 4, 9).build());`);
  assert.equal(r.selections.length, 1);
  assert.deepEqual([r.selections[0]._parts[0].start, r.selections[0]._parts[0].endInclusive], [4, 9]);
});

test('api.js runs in the runtime over Apps Script-shaped adapters, end to end', () => {
  const r = rt();
  const out = run(r, `
    (function () {
      var props = PropertiesService.getUserProperties();
      var cache = CacheService.getUserCache();
      function hex(s) {
        return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
          .map(function (b) { return ((b + 256) % 256).toString(16).padStart(2, '0'); }).join('');
      }
      var client = LenzApi.create({
        fetch: function (req) {
          try {
            var res = UrlFetchApp.fetch(req.url, { method: req.method, headers: req.headers,
              payload: req.payload, muteHttpExceptions: true });
            return { code: res.getResponseCode(), headers: res.getAllHeaders(), text: res.getContentText() };
          } catch (e) { return { code: 0, headers: {}, text: '' }; }
        },
        store: { get: function (k) { return props.getProperty(k); }, set: function (k, v) { props.setProperty(k, v); },
                 del: function (k) { props.deleteProperty(k); } },
        cache: { get: function (k) { return cache.get(k); }, put: function (k, v, t) { cache.put(k, v, t); },
                 del: function (k) { cache.remove(k); } },
        sha256: hex, now: function () { return Date.now(); },
        base: 'https://lenz.io/api/v1', apiKey: 'lenz_test_key', userAgent: 'lenz-gdocs-test'
      });
      var doc = Docs.Documents.get('doc-b', { includeTabsContent: true, suggestionsViewMode: 'SUGGESTIONS_INLINE' });
      var live = LenzSerialize.serialize(doc, null);
      var s = client.submit({ docId: 'doc-b', tabId: live.tabId, text: live.text });
      var p = client.poll('doc-b', live.tabId);
      return JSON.stringify({ ok: s.ok, status: p.status, claims: p.body.claims.length,
                              snap: client.snapshot(s.reviewId) === live.text });
    })()`);
  assert.deepEqual(JSON.parse(out), { ok: true, status: 'completed', claims: 5, snap: true });
});
