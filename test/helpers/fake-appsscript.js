// Test-only Apps Script runtime: loads src/*.js into one shared global scope (as Apps Script V8
// does) with fakes of the services the glue uses — Docs (fake-docs), UrlFetchApp (fake-lenz),
// PropertiesService, CacheService, LockService, Utilities, Session, DocumentApp, HtmlService.
// Behaviour follows Apps Script's documented contracts: computeDigest returns signed bytes, the
// cache refuses values over 100 KB and TTLs over 21600 s, UrlFetchApp throws on no response and on
// HTTP errors unless muteHttpExceptions is set.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SRC = path.join(__dirname, '..', '..', 'src');
const { configSource } = require('./flavour.js');
const LOAD_ORDER = ['serialize.js', 'place.js', 'api.js', 'oauth.js', 'view.js', 'Code.js', 'dev-tools.js'];

function mapStore() {
  const m = new Map();
  return {
    getProperty: (k) => (m.has(k) ? m.get(k) : null),
    setProperty(k, v) { m.set(k, String(v)); return this; },
    deleteProperty(k) { m.delete(k); return this; },
    getProperties: () => Object.fromEntries(m),
    setProperties(o) { Object.keys(o).forEach((k) => m.set(k, String(o[k]))); return this; },
    deleteAllProperties() { m.clear(); return this; },
    getKeys: () => Array.from(m.keys()),
    _map: m,
  };
}

function cacheStore(now) {
  const m = new Map();
  const live = (k) => {
    const e = m.get(k);
    if (!e) return null;
    if (e.exp <= now()) { m.delete(k); return null; }
    return e.v;
  };
  const put = (k, v, ttl) => {
    const s = String(v);
    if (Buffer.byteLength(s, 'utf8') > 100 * 1024) throw new Error('Argument too large: value');
    const t = ttl === undefined ? 600 : Math.min(ttl, 21600);
    m.set(k, { v: s, exp: now() + t * 1000 });
  };
  return {
    get: live,
    put,
    remove: (k) => { m.delete(k); },
    getAll: (ks) => { const o = {}; ks.forEach((k) => { const v = live(k); if (v !== null) o[k] = v; }); return o; },
    putAll: (o, ttl) => Object.keys(o).forEach((k) => put(k, o[k], ttl)),
    removeAll: (ks) => ks.forEach((k) => m.delete(k)),
    _map: m,
  };
}

function signedBytes(buf) { return Array.from(buf, (b) => (b > 127 ? b - 256 : b)); }

// A DocumentApp view over a fake-docs document: paragraphs in body order (table cells included),
// each with editAsText().getText(); newRange().addElement(el, start, endInclusive); setSelection.
function documentApp(docs, active) {
  function paragraphsOf(tabId) {
    const doc = docs.Documents.get(active.docId, { includeTabsContent: true });
    const tab = doc.tabs.filter((t) => t.tabProperties.tabId === tabId)[0] || doc.tabs[0];
    const out = [];
    (function walk(content) {
      content.forEach((el) => {
        if (el.paragraph) {
          const text = el.paragraph.elements.map((e) => e.textRun.content).join('').replace(/\n$/, '');
          const t = { getText: () => text, getType: () => 'TEXT', _para: out.length };
          out.push({ editAsText: () => t, getText: () => text, getType: () => 'PARAGRAPH', _index: out.length });
        } else if (el.table) {
          el.table.tableRows.forEach((r) => r.tableCells.forEach((c) => walk(c.content)));
        }
      });
    })(tab.documentTab.body.content);
    return out;
  }
  const selections = [];
  function tabObj(tabId) {
    return {
      getId: () => tabId,
      getTitle: () => tabId,
      asDocumentTab: () => ({ getBody: () => ({ getParagraphs: () => paragraphsOf(tabId) }) }),
    };
  }
  const document = {
    getId: () => active.docId,
    getName: () => active.docId,
    getActiveTab: () => tabObj(active.tabId),
    getTabs: () => docs.Documents.get(active.docId, { includeTabsContent: true }).tabs
      .map((t) => tabObj(t.tabProperties.tabId)),
    getBody: () => tabObj(active.tabId).asDocumentTab().getBody(),
    newRange() {
      const parts = [];
      const b = {
        addElement(el, start, endInclusive) { parts.push({ el, start, endInclusive }); return b; },
        build: () => ({ getRangeElements: () => parts, _parts: parts }),
      };
      return b;
    },
    setSelection(range) { selections.push(range); return document; },
    getSelection: () => selections[selections.length - 1] || null,
    getCursor: () => null,
  };
  const ui = {
    createAddonMenu() { const m = { addItem: () => m, addSeparator: () => m, addSubMenu: () => m, addToUi: () => {} }; return m; },
    createMenu() { return ui.createAddonMenu(); },
    showSidebar: (h) => { ui._sidebar = h; },
    showModalDialog: () => {},
    alert: () => {},
  };
  return { api: { getActiveDocument: () => document, getUi: () => ui }, selections, ui };
}

function htmlOutput() {
  const h = { setTitle: () => h, setWidth: () => h, setHeight: () => h, setSandboxMode: () => h,
              append: () => h, getContent: () => '', evaluate: () => h };
  return h;
}

// opts: { docs, lenz, docId, tabId, now(), files (override LOAD_ORDER) }
function createRuntime(opts) {
  const now = opts.now || (() => Date.now());
  const active = { docId: opts.docId, tabId: opts.tabId || 't.0' };
  const userProps = mapStore();
  const docProps = mapStore();
  const scriptProps = mapStore();
  const userCache = cacheStore(now);
  const docCache = cacheStore(now);
  const scriptCache = cacheStore(now);
  const fetches = [];
  const locks = { held: 0, waits: 0 };
  const da = documentApp(opts.docs, active);

  const UrlFetchApp = {
    fetch(url, params) {
      params = params || {};
      const headers = Object.assign({}, params.headers || {});
      if (params.contentType) headers['Content-Type'] = params.contentType;
      const req = { method: (params.method || 'get').toLowerCase(), url, headers, payload: params.payload };
      fetches.push(req);
      const res = opts.lenz.fetch(req);
      if (!res || !res.code) throw new Error('Exception: Address unavailable: ' + url);
      if (res.code >= 400 && !params.muteHttpExceptions) {
        throw new Error('Exception: Request failed for ' + url + ' returned code ' + res.code);
      }
      return {
        getResponseCode: () => res.code,
        getAllHeaders: () => Object.assign({}, res.headers),
        getHeaders: () => Object.assign({}, res.headers),
        getContentText: () => res.text,
      };
    },
  };

  const Utilities = {
    DigestAlgorithm: { SHA_256: 'sha256', SHA_1: 'sha1', MD5: 'md5' },
    Charset: { UTF_8: 'utf8', US_ASCII: 'ascii' },
    computeDigest(alg, value, charset) {
      const buf = Array.isArray(value) ? Buffer.from(value.map((b) => b & 0xff)) : Buffer.from(String(value), charset || 'utf8');
      return signedBytes(crypto.createHash(alg).update(buf).digest());
    },
    base64Encode: (v) => Buffer.from(Array.isArray(v) ? v.map((b) => b & 0xff) : String(v), 'utf8').toString('base64'),
    getUuid: () => crypto.randomUUID(),
    sleep: () => {},
    formatString: (f, ...a) => f.replace(/%s/g, () => String(a.shift())),
  };

  function lock() {
    let held = false;
    return {
      waitLock() { locks.waits += 1; held = true; locks.held += 1; },
      tryLock() { held = true; locks.held += 1; return true; },
      releaseLock() { if (held) { held = false; locks.held -= 1; } },
      hasLock: () => held,
    };
  }

  const globals = {
    Docs: opts.docs,
    UrlFetchApp,
    Utilities,
    PropertiesService: {
      getUserProperties: () => userProps,
      getDocumentProperties: () => docProps,
      getScriptProperties: () => scriptProps,
    },
    CacheService: {
      getUserCache: () => userCache,
      getDocumentCache: () => docCache,
      getScriptCache: () => scriptCache,
    },
    LockService: { getUserLock: lock, getDocumentLock: lock, getScriptLock: lock },
    Session: {
      getActiveUser: () => ({ getEmail: () => 'tester@example.com' }),
      getEffectiveUser: () => ({ getEmail: () => 'tester@example.com' }),
      getTemporaryActiveUserKey: () => 'temp-user-key',
      getScriptTimeZone: () => 'Etc/UTC',
    },
    DocumentApp: da.api,
    HtmlService: {
      createHtmlOutputFromFile: () => htmlOutput(),
      createTemplateFromFile: () => htmlOutput(),
      createHtmlOutput: () => htmlOutput(),
      SandboxMode: { IFRAME: 'IFRAME' },
    },
    Logger: { log: () => {} },
    console: { log: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    Date: class extends Date {
      constructor(...a) { if (a.length) super(...a); else super(now()); }
      static now() { return now(); }
    },
  };
  const ctx = vm.createContext(globals);
  const loaded = [];
  // The internal build's generated config.js (dist/internal/config.js), which src/ does not hold.
  vm.runInContext(configSource('internal'), ctx, { filename: 'config.js' });
  (opts.files || LOAD_ORDER).forEach((f) => {
    const file = path.join(SRC, f);
    if (!fs.existsSync(file)) return;
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
    loaded.push(f);
  });
  return {
    ctx, loaded, fetches, locks, active,
    userProps, userCache, selections: da.selections, ui: da.ui,
    setActive(docId, tabId) { active.docId = docId; if (tabId) active.tabId = tabId; },
  };
}

const hasSrc = (f) => fs.existsSync(path.join(SRC, f));

module.exports = { createRuntime, hasSrc };
