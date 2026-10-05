// Code.js in Node: every src file loaded into ONE vm context (Apps Script's single global scope),
// with fake Apps Script services. Pure helpers are tested directly; the flow is driven end to end
// with the real serialize.js / api.js / place.js / view.js over a generated Docs REST document and
// the draft-a responses captured from prod.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createFakeLenzOAuth } = require('./helpers/fake-lenz-oauth.js');
const { configSource, flavourConfig, flavourFile, INTERNAL_CLIENT_ID } = require('./helpers/flavour.js');

const SRC = path.join(__dirname, '..', 'src');
const FIX = path.join(__dirname, 'fixtures', 'reviews');
const TEXT = fs.readFileSync(path.join(FIX, 'draft-a.txt'), 'utf8').replace(/\n$/, '');
const ACCEPT = require('./fixtures/reviews/draft-a.accept.json');
const POLLS = require('./fixtures/reviews/draft-a.polls.json');
const KEY = 'lenz_' + 'a'.repeat(32);
const RID = ACCEPT.body.review_id;
const REDIRECT = 'https://script.google.com/macros/d/SCRIPT/usercallback';
const LINK = /\[([^\]\n]*)\]\(([^)\s]*)\)/g;

// Cross-realm objects: compare as JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));

// ── fakes ───────────────────────────────────────────────────────────

function fakeCache() {
  const m = new Map();
  return {
    m,
    get: (k) => (m.has(k) ? m.get(k) : null),
    put: (k, v) => void m.set(k, String(v)),
    getAll: (keys) => Object.fromEntries(keys.filter((k) => m.has(k)).map((k) => [k, m.get(k)])),
    putAll: (obj) => Object.keys(obj).forEach((k) => m.set(k, String(obj[k]))),
    removeAll: (keys) => keys.forEach((k) => m.delete(k)),
  };
}

// The REST paragraphs of a text: what fakeSerialized indexes (body from 1, one "\n" per paragraph).
function restParagraphTexts(text) {
  return text.split('\n\n').map((p) => p.replace(LINK, '$1'));
}

// What Apps Script's Docs service throws when the script may not open the file (drive.file, no grant).
function noAccessError(method) {
  const e = new Error('API call to docs.documents.' + method + ' failed with error: Requested entity was not found.');
  e.details = { code: 404, message: 'Requested entity was not found.' };
  return e;
}

function world(opts) {
  opts = opts || {};
  const state = {
    text: TEXT,
    rev: 'rev-1',
    polls: POLLS.slice(),
    fetches: [],
    gets: 0,
    batches: [],
    failBatch: 0,
    onBatch: null,
    selections: [],
    props: new Map(),
    lockFree: true,
    down: !!opts.transportDown,
    logDocs: [],
    appText: null,
    getReply: null,
    seenText: null,
    seenRev: null,
    heads: 0,
    logs: [],
    title: 'Lenz spike e2e',
    postReply: null,
    menus: [],
    alerts: [],
    oauth: opts.oauth ? createFakeLenzOAuth({ clientId: opts.clientId || INTERNAL_CLIENT_ID, redirectUri: REDIRECT }) : null,
    stateTokens: [],
    // drive.file before the user picked this Doc: every Docs REST call answers 404 (measured).
    noAccess: false,
    dialogs: [],
  };

  // A Docs REST document for the text: one paragraph per "\n\n" block, links as linked runs,
  // each paragraph ending in its own "\n", indexes in UTF-16 from 1 (as Docs has them).
  // Any change to the text is a new revision (as in Docs), unless the test set one itself.
  function currentRev() {
    if (state.seenText !== null && state.text !== state.seenText && state.rev === state.seenRev) {
      state.rev = state.rev + '+';
    }
    state.seenText = state.text;
    state.seenRev = state.rev;
    return state.rev;
  }

  function restDoc() {
    const content = [{ startIndex: 0, endIndex: 1, sectionBreak: {} }];
    let at = 1;
    for (const p of state.text.split('\n\n')) {
      const runs = [];
      let last = 0;
      let m;
      LINK.lastIndex = 0;
      while ((m = LINK.exec(p)) !== null) {
        if (m.index > last) runs.push({ t: p.slice(last, m.index) });
        runs.push({ t: m[1], url: m[2] });
        last = m.index + m[0].length;
      }
      if (last < p.length) runs.push({ t: p.slice(last) });
      runs.push({ t: '\n' });
      const start = at;
      const elements = runs.map((r) => {
        const e = { startIndex: at, endIndex: at + r.t.length,
          textRun: { content: r.t, textStyle: r.url ? { link: { url: r.url } } : {} } };
        at += r.t.length;
        return e;
      });
      content.push({ startIndex: start, endIndex: at, paragraph: { elements } });
    }
    return {
      documentId: 'doc-1',
      revisionId: currentRev(),
      tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content } } }],
    };
  }

  const T = { PARAGRAPH: 'PARAGRAPH', LIST_ITEM: 'LIST_ITEM', TABLE: 'TABLE', TABLE_OF_CONTENTS: 'TOC', TEXT: 'TEXT' };
  function appBody() {
    // `appText`: what DocumentApp sees when a collaborator typed after the REST read.
    const paras = restParagraphTexts(state.appText === null ? state.text : state.appText).map((s) => {
      const kid = { getType: () => T.TEXT, asText() { return this; }, getText: () => s };
      return { getType: () => T.PARAGRAPH, getNumChildren: () => 1, getChild: () => kid };
    });
    return { getNumChildren: () => paras.length, getChild: (i) => paras[i] };
  }
  const tab = { getId: () => 't.0', asDocumentTab: () => ({ getBody: appBody }) };
  const appDoc = {
    getId: () => 'doc-1',
    getName: () => state.title,
    getTabs: () => [tab],
    getActiveTab: () => tab,
    newRange() {
      const added = [];
      return {
        addElement(el, s, e) { added.push({ text: el.getText(), s, e }); return this; },
        build: () => added,
      };
    },
    setSelection(r) { state.selections.push(r); },
  };

  function response(code, headers, body) {
    return {
      getResponseCode: () => code,
      getAllHeaders: () => headers,
      getContentText: () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }

  const cache = fakeCache();
  function appDocFor(id) {
    const d = state.logDocs.find((x) => x.id === id);
    if (!d) throw noAccessError('get'); // not ours, never picked
    return d;
  }
  const fakes = {
    console: { log: (l) => void state.logs.push(String(l)), warn() {}, error() {} },
    Docs: {
      Documents: {
        get(id, o) {
          // A Doc the add-on created (trial log, dump, e2e spike Doc): drive.file covers it, no Picker.
          if (id !== 'doc-1') {
            const d = appDocFor(id);
            return { title: d.name, tabs: [{ tabProperties: { tabId: 't.0' } }] };
          }
          // `onDocsGet`: runs once, at the next read of the Doc (another execution, meanwhile).
          if (state.onDocsGet) { const f = state.onDocsGet; state.onDocsGet = null; f(); }
          if (state.noAccess) throw noAccessError('get');
          assert.equal(o.suggestionsViewMode, 'SUGGESTIONS_INLINE');
          if (o.fields === 'title,tabs(tabProperties(tabId))') {
            assert.equal(o.includeTabsContent, true);
            return { title: state.title, tabs: [{ tabProperties: { tabId: 't.0' } }] };
          }
          if (o.fields) {
            assert.equal(o.fields, 'revisionId');
            state.heads++;
            return { revisionId: currentRev() };
          }
          assert.equal(o.includeTabsContent, true);
          state.gets++;
          return restDoc();
        },
        // Docs the add-on makes itself: their paragraphs are what insertText appended (the trial
        // log's are its JSONL lines).
        create(resource) {
          state.docOpens = (state.docOpens || 0) + 1;
          if (state.logDocFails) throw new Error('Drive quota exceeded');
          const id = 'app-' + (state.logDocs.length + 1);
          state.logDocs.push({ name: resource.title, id, lines: [], getId: () => id });
          return { documentId: id, title: resource.title };
        },
        batchUpdate(req, id) {
          if (id !== 'doc-1') {
            state.docOpens = (state.docOpens || 0) + 1;
            if (state.logDocFails) throw new Error('Document is missing');
            const d = appDocFor(id);
            plain(req).requests.forEach((r) => {
              assert.deepEqual(Object.keys(r), ['insertText']);
              assert.deepEqual(r.insertText.endOfSegmentLocation, {});
              r.insertText.text.split('\n').filter(Boolean).forEach((l) => d.lines.push(l));
            });
            return {};
          }
          if (state.noAccess) throw noAccessError('batchUpdate');
          state.batches.push(plain({ req, id }));
          if (state.failBatch > 0) {
            state.failBatch--;
            throw new Error('Invalid requests: The required revision ID does not match the latest revision.');
          }
          if (state.onBatch) state.onBatch(req);
          return { writeControl: { requiredRevisionId: state.rev } };
        },
      },
    },
    DocumentApp: {
      getActiveDocument: () => appDoc,
      ElementType: T,
      // Neither build has the `documents` scope these need: any call fails the test.
      create() { throw new Error('DocumentApp.create needs the documents scope'); },
      openById() { throw new Error('DocumentApp.openById needs the documents scope'); },
      getUi: () => {
        function menu(title) {
          const m = { title, items: [], addItem(l, f) { m.items.push([l, f]); return m; }, addSeparator() { return m; },
            addSubMenu(sub) { m.items.push(sub); return m; }, addToUi() { state.menus.push(m); } };
          return m;
        }
        return { alert: (...a) => void state.alerts.push(a), ButtonSet: { OK: 'OK' }, createMenu: menu,
          createAddonMenu: () => menu('addon'),
          showModalDialog: (html, title) => void state.dialogs.push({ file: html.file, width: html.width, height: html.height, title }) };
      },
    },
    UrlFetchApp: {
      fetch(url, o) {
        state.fetches.push({ url, o: plain(o) });
        if (state.down) throw new Error('DNS error');
        if (state.oauth && url.indexOf('https://lenz.io/api/v1/oauth/') === 0) {
          const r = state.oauth.fetch({ method: o.method, url, headers: Object.assign({}, o.headers,
            o.contentType ? { 'Content-Type': o.contentType } : {}), payload: o.payload });
          return response(r.code, r.headers, r.text);
        }
        // Signed in with Lenz: the API takes only a live access token (or the dev key).
        if (state.oauth && o.headers.Authorization !== 'Bearer ' + KEY && !state.oauth.bearerOk(o.headers.Authorization)) {
          return response(401, {}, { detail: 'Invalid or expired token.' });
        }
        if (o.method === 'post') {
          if (state.postReply) return response(state.postReply.code, {}, state.postReply.body);
          return response(ACCEPT.status, { 'Retry-After': '20' }, ACCEPT.body);
        }
        if (state.getReply) return response(state.getReply.code, {}, state.getReply.body);
        const body = state.polls.length > 1 ? state.polls.shift() : state.polls[0];
        return response(200, {}, body);
      },
    },
    PropertiesService: {
      getUserProperties: () => ({
        getProperty: (k) => (state.props.has(k) ? state.props.get(k) : null),
        // Apps Script: a value over 9 KB is refused.
        setProperty: (k, v) => {
          if (Buffer.byteLength(String(v)) > 9 * 1024) throw new Error('Argument too large: value');
          state.props.set(k, String(v));
        },
        deleteProperty: (k) => void state.props.delete(k),
        // Apps Script's own semantics: a merge (deleteAllOthers not used by the glue).
        setProperties: (obj) => {
          Object.keys(obj).forEach((k) => {
            if (Buffer.byteLength(String(obj[k])) > 9 * 1024) throw new Error('Argument too large: value');
          });
          Object.keys(obj).forEach((k) => state.props.set(k, String(obj[k])));
        },
        getProperties: () => { state.propReads = (state.propReads || 0) + 1; return Object.fromEntries(state.props); },
      }),
    },
    CacheService: { getUserCache: () => cache },
    LockService: {
      getUserLock: () => ({
        // `beforeLock`: runs once, just before the next lock is taken (another execution got there first).
        tryLock: () => {
          const f = state.beforeLock;
          state.beforeLock = null;
          if (f) f();
          return state.lockFree;
        },
        releaseLock() {},
      }),
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => Array.from(crypto.createHash('sha256').update(s, 'utf8').digest()).map((b) => (b > 127 ? b - 256 : b)),
      // Apps Script's web-safe base64 keeps its padding.
      base64EncodeWebSafe: (bytes) => Buffer.from(bytes.map((b) => b & 0xff)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      getUuid: () => crypto.randomUUID(),
    },
    // The usercallback's state token: routes the redirect to `method` with `args` in e.parameter.
    ScriptApp: {
      getScriptId: () => 'SCRIPT',
      getOAuthToken: () => 'ya29.script-token',
      newStateToken() {
        const t = { method: null, args: {}, timeout: null };
        const b = {
          withMethod(m) { t.method = m; return b; },
          withArgument(k, v) { t.args[k] = v; return b; },
          withTimeout(s) { t.timeout = s; return b; },
          createToken() { state.stateTokens.push(t); return 'ST' + Buffer.from(JSON.stringify(t)).toString('base64url'); },
        };
        return b;
      },
    },
    HtmlService: {
      createHtmlOutputFromFile(file) {
        const out = { file, width: null, height: null, setWidth(w) { out.width = w; return out; }, setHeight(h) { out.height = h; return out; } };
        return out;
      },
      createHtmlOutput(html) { const out = { html, title: null, setTitle(x) { out.title = x; return out; } }; return out; },
    },
  };
  const ctx = vm.createContext(fakes);
  // src/ as the internal build has it (config.js first), or a built flavour's directory as is.
  if (!opts.dir) vm.runInContext(configSource('internal'), ctx, { filename: 'config.js' });
  const files = opts.files || ['serialize.js', 'view.js', 'place.js', 'api.js', 'oauth.js', 'Code.js', 'dev-tools.js', 'dev-e2e.js'];
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(opts.dir || SRC, f), 'utf8'), ctx, { filename: f });
  }
  return { ctx, state, cache };
}

function started() {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'running');
  return w;
}

function pollToEnd(w) {
  let r;
  for (let i = 0; i < 10; i++) {
    r = w.ctx.lenzPoll();
    if (r.phase !== 'running') break;
  }
  return r;
}

function entry(model, id) {
  for (const g of model.groups) for (const e of g.entries) if (e.id === id) return e;
  return null;
}

// ── loading ─────────────────────────────────────────────────────────

test('every src file loads into one global scope without touching Apps Script', () => {
  const w = world();
  for (const name of ['LenzSerialize', 'LenzView', 'LenzPlace', 'LenzApi', 'onOpen', 'lenzState', 'lenzSaveKey', 'lenzStart',
    'lenzPoll', 'lenzSelect', 'lenzApply', 'lenzDevDump']) {
    assert.equal(typeof w.ctx[name] === 'function' || typeof w.ctx[name] === 'object', true, name);
  }
  assert.equal(w.state.gets, 0);
  assert.equal(w.state.fetches.length, 0);
});

// ── pure helpers ────────────────────────────────────────────────────

test('chunked cache: round trip across chunks, never splitting a surrogate pair', () => {
  const w = world();
  const raw = fakeCache();
  const c = w.ctx.lenzChunkedCache_(raw);
  const big = 'x'.repeat(19999) + '🚀' + 'y'.repeat(45000);
  c.put('k', big, 100);
  assert.equal(c.get('k'), big);
  assert.equal(JSON.parse(raw.get('k')).n, 4);
  for (const [k, v] of raw.m) if (k !== 'k') assert.ok(v.length <= 20000, k);
  assert.equal(raw.get('k#0').length, 19999); // the pair went to the next chunk
  c.put('small', 'abc', 100);
  assert.equal(c.get('small'), 'abc');
  c.put('empty', '', 100);
  assert.equal(c.get('empty'), '');
  assert.equal(c.get('missing'), null);
});

test('chunked cache: an evicted chunk or a wrong length is a miss; del removes all', () => {
  const w = world();
  const raw = fakeCache();
  const c = w.ctx.lenzChunkedCache_(raw);
  c.put('k', 'z'.repeat(50000), 100);
  raw.m.delete('k#1');
  assert.equal(c.get('k'), null);
  c.put('k', 'z'.repeat(50000), 100);
  raw.m.set('k#2', 'short');
  assert.equal(c.get('k'), null);
  c.del('k');
  assert.equal(raw.m.size, 0);
  raw.m.set('bad', 'not json');
  assert.equal(c.get('bad'), null);
});

test('sha256 is lower-case hex of the UTF-8 digest', () => {
  const w = world();
  const s = 'Space notes 🚀';
  assert.equal(w.ctx.lenzSha256_(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
});

test('REST paragraphs walk tables and tables of contents in document order', () => {
  const w = world();
  const content = [
    { startIndex: 0, endIndex: 1, sectionBreak: {} },
    { startIndex: 1, endIndex: 5, paragraph: {} },
    {
      startIndex: 5,
      endIndex: 20,
      table: {
        tableRows: [
          { tableCells: [{ content: [{ startIndex: 7, endIndex: 10, paragraph: {} }] },
            { content: [{ startIndex: 11, endIndex: 14, paragraph: {} }, { startIndex: 14, endIndex: 17, paragraph: {} }] }] },
        ],
      },
    },
    { startIndex: 20, endIndex: 24, tableOfContents: { content: [{ startIndex: 21, endIndex: 23, paragraph: {} }] } },
    { startIndex: 24, endIndex: 30, paragraph: {} },
  ];
  const paras = plain(w.ctx.lenzRestParagraphs_(content));
  assert.deepEqual(paras.map((p) => p.start), [1, 7, 11, 14, 21, 24]);
  assert.deepEqual(plain(w.ctx.lenzParagraphSpans_(paras, [{ startIndex: 12, endIndex: 13 }, { startIndex: 24, endIndex: 29 }])), [
    { para: 2, start: 1, end: 2 },
    { para: 5, start: 0, end: 5 },
  ]);
  assert.equal(w.ctx.lenzParagraphSpans_(paras, [{ startIndex: 3, endIndex: 8 }]), null);
});

test('child segments: text by offset (inclusive end), inline objects whole', () => {
  const w = world();
  const kids = [{ text: true, length: 5 }, { text: false, length: 1 }, { text: true, length: 4 }];
  assert.deepEqual(plain(w.ctx.lenzChildSegments_(kids, 2, 8)), [
    { child: 0, from: 2, to: 4 },
    { child: 1, whole: true },
    { child: 2, from: 0, to: 1 },
  ]);
  assert.deepEqual(plain(w.ctx.lenzChildSegments_(kids, 6, 10)), [{ child: 2, from: 0, to: 3 }]);
});

test('apply requests: insert at the end of the old words, then delete them', () => {
  const w = world();
  assert.deepEqual(plain(w.ctx.lenzApplyRequests_({ startIndex: 10, endIndex: 21 }, 'Neil Armstrong', 't.0')), [
    { insertText: { text: 'Neil Armstrong', location: { index: 21, tabId: 't.0' } } },
    { deleteContentRange: { range: { startIndex: 10, endIndex: 21, tabId: 't.0' } } },
  ]);
  assert.deepEqual(plain(w.ctx.lenzApplyRequests_({ startIndex: 10, endIndex: 21 }, '', null)), [
    { deleteContentRange: { range: { startIndex: 10, endIndex: 21 } } },
  ]);
});

test('fetch adapter: never throws, lower-cases headers, sends Content-Type as contentType', () => {
  const w = world();
  const res = plain(w.ctx.lenzFetch_({ method: 'POST', url: 'https://lenz.io/api/v1/review',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer x' }, payload: '{}' }));
  assert.equal(res.code, 202);
  assert.equal(res.headers['retry-after'], '20');
  const sent = w.state.fetches[0].o;
  assert.equal(sent.muteHttpExceptions, true);
  assert.equal(sent.followRedirects, false);
  assert.equal(sent.contentType, 'application/json');
  assert.deepEqual(sent.headers, { Authorization: 'Bearer x' });
  const down = world({ transportDown: true });
  assert.deepEqual(plain(down.ctx.lenzFetch_({ method: 'GET', url: 'https://lenz.io/api/v1/reviews/x', headers: {} })), {
    code: 0, headers: {}, text: '',
  });
});

test('the dev key: checked for shape, stored, never returned', () => {
  const w = world();
  assert.equal(w.ctx.lenzState().phase, 'signed_out');
  const bad = w.ctx.lenzSaveKey('sk-123');
  assert.equal(bad.phase, 'error');
  assert.match(bad.error.message, /starts with lenz_/);
  const ok = w.ctx.lenzSaveKey('  ' + KEY + '\n');
  assert.equal(ok.phase, 'idle');
  assert.ok(!JSON.stringify(ok).includes(KEY));
  assert.equal(w.state.props.get('lenz:apiKey'), KEY);
  assert.deepEqual(plain(ok.auth), { mode: 'key', signedIn: true });
  assert.equal(w.ctx.lenzSaveKey('').phase, 'signed_out');
  assert.equal(w.state.props.has('lenz:apiKey'), false);
});

// ── signing in with Lenz ────────────────────────────────────────────

// The browser round trip: the sidebar's URL, Lenz's consent page (or a refusal), the callback.
function signIn(w, choice) {
  const u = w.ctx.lenzSignInUrl();
  assert.ok(u.url, u.message);
  const back = w.state.oauth.authorize(u.url, choice || 'allow');
  const token = w.state.stateTokens[w.state.stateTokens.length - 1];
  // Apps Script hands the state token's arguments over in e.parameter with the query.
  return w.ctx.lenzOAuthCallback({ parameter: Object.assign({}, token.args, back) });
}
const trialEvents = (w) => w.state.logs.filter((l) => l.startsWith('lenz_trial ')).map((l) => JSON.parse(l.slice(11)));

test('signed out: the sidebar is told to sign in, and nothing reaches Lenz', () => {
  const w = world({ oauth: true });
  const r = w.ctx.lenzState();
  assert.equal(r.phase, 'signed_out');
  assert.deepEqual(plain(r.auth), { mode: 'oauth', signedIn: false });
  assert.equal(w.ctx.lenzStart().phase, 'signed_out');
  assert.equal(w.ctx.lenzSelect('x', 'claim:0', 0).message, 'Sign in with Lenz first.');
  assert.equal(w.state.fetches.length, 0);
  assert.equal(w.state.stateTokens.length, 0, 'no ScriptApp call until a sign-in starts');
});

test('the sign-in URL: this script\'s usercallback, the registered client, a state token routed to the callback', () => {
  const w = world({ oauth: true });
  const u = w.ctx.lenzSignInUrl();
  const q = new URL(u.url).searchParams;
  assert.equal(q.get('client_id'), INTERNAL_CLIENT_ID);
  assert.equal(q.get('redirect_uri'), REDIRECT);
  assert.equal(q.get('scope'), 'verify offline_access');
  const t = w.state.stateTokens[0];
  assert.equal(t.method, 'lenzOAuthCallback');
  assert.deepEqual(Object.keys(t.args), ['n']);
  assert.equal(t.timeout, 600);
  assert.ok(q.get('state').length <= 512);
  assert.match(q.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
});

test('sign in, then check: the callback page closes itself, the check goes out with the access token', () => {
  const w = world({ oauth: true });
  const page = signIn(w);
  assert.match(page.html, /You are signed in to Lenz/);
  assert.match(page.html, /window\.top\.close/);
  assert.equal(page.title, 'Lenz Fact-Checking');
  const st = w.ctx.lenzState();
  assert.equal(st.phase, 'idle');
  assert.deepEqual(plain(st.auth), { mode: 'oauth', signedIn: true });
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'running');
  const post = w.state.fetches.find((f) => f.url === 'https://lenz.io/api/v1/review');
  assert.match(post.o.headers.Authorization, /^Bearer lat_/);
  assert.equal(pollToEnd(w).phase, 'done');
  const ev = trialEvents(w).filter((e) => e.event === 'signed_in');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].doc, null);
  assert.equal(ev[0].review, null);
});

test('no reply to the sidebar ever carries a token', () => {
  const w = world({ oauth: true });
  signIn(w);
  const replies = [w.ctx.lenzState(), w.ctx.lenzStart(), pollToEnd(w), w.ctx.lenzSignInUrl()];
  const tokens = JSON.parse(w.state.props.get('lenz:oauth:tokens') || '{}');
  for (const r of replies) {
    const j = JSON.stringify(r);
    assert.ok(!/lat_|lrt_/.test(j), j.slice(0, 200));
  }
  assert.ok(tokens.access && tokens.refresh);
});

test('a declined sign-in says how to try again and signs nothing in', () => {
  const w = world({ oauth: true });
  const page = signIn(w, 'deny');
  assert.match(page.html, /Allow/);
  assert.doesNotMatch(page.html, /window\.top\.close/);
  assert.equal(w.ctx.lenzState().phase, 'signed_out');
  assert.equal(trialEvents(w).filter((e) => e.event === 'signed_in').length, 0);
});

test('an expired access token is rotated before the request, without the user noticing', () => {
  const w = world({ oauth: true });
  signIn(w);
  const t = JSON.parse(w.state.props.get('lenz:oauth:tokens'));
  t.expiresAt = Date.now() - 1000;
  w.state.props.set('lenz:oauth:tokens', JSON.stringify(t));
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'running');
  const after = JSON.parse(w.state.props.get('lenz:oauth:tokens'));
  assert.notEqual(after.refresh, t.refresh);
  const post = w.state.fetches.find((f) => f.url === 'https://lenz.io/api/v1/review');
  assert.equal(post.o.headers.Authorization, 'Bearer ' + after.access);
});

test('an authorization revoked on lenz.io: the next look shows Sign in with Lenz, with a line saying why', () => {
  const w = world({ oauth: true });
  signIn(w);
  w.ctx.lenzStart();
  Object.values(w.state.oauth.grants).forEach((g) => { g.revoked = true; });
  const r = w.ctx.lenzPoll();
  assert.equal(r.phase, 'signed_out');
  assert.equal(r.error.message, 'Your Lenz sign-in has ended. Choose Sign in with Lenz to keep checking.');
  assert.equal(w.state.props.has('lenz:oauth:tokens'), false);
});

test('a lost reply, then the sign-in ended: signing in again finishes the same request', () => {
  const w = world({ oauth: true, transportDown: true });
  w.state.down = false;
  signIn(w);
  w.state.down = true;
  w.ctx.lenzStart(); // the POST's answer is lost: pending
  w.state.down = false;
  Object.values(w.state.oauth.grants).forEach((g) => { g.revoked = true; });
  assert.equal(w.ctx.lenzPoll().phase, 'signed_out');
  signIn(w);
  const r = w.ctx.lenzState();
  assert.equal(r.phase, 'running');
  const posts = w.state.fetches.filter((f) => f.url === 'https://lenz.io/api/v1/review');
  assert.equal(new Set(posts.map((f) => f.o.headers['Idempotency-Key'])).size, 1);
  assert.equal(pollToEnd(w).phase, 'done');
});

test('sign out: revoked at Lenz, forgotten here, logged, and the sidebar shows Sign in', () => {
  const w = world({ oauth: true });
  signIn(w);
  const access = JSON.parse(w.state.props.get('lenz:oauth:tokens')).access;
  const r = w.ctx.lenzSignOut();
  assert.equal(r.phase, 'signed_out');
  assert.equal(r.error, null);
  assert.equal(w.state.props.has('lenz:oauth:tokens'), false);
  assert.equal(w.state.oauth.bearerOk('Bearer ' + access), false);
  assert.ok(w.state.fetches.some((f) => f.url === 'https://lenz.io/api/v1/oauth/revoke'));
  assert.equal(trialEvents(w).filter((e) => e.event === 'signed_out').length, 1);
  // Signing out twice logs once.
  w.ctx.lenzSignOut();
  assert.equal(trialEvents(w).filter((e) => e.event === 'signed_out').length, 1);
});

test('the dev key wins over a sign-in while it is saved', () => {
  const w = world({ oauth: true });
  signIn(w);
  w.ctx.lenzSaveKey(KEY);
  assert.deepEqual(plain(w.ctx.lenzState().auth), { mode: 'key', signedIn: true });
  w.ctx.lenzStart();
  const post = w.state.fetches.find((f) => f.url === 'https://lenz.io/api/v1/review');
  assert.equal(post.o.headers.Authorization, 'Bearer ' + KEY);
});

test('signing in and out run under the user lock: busy means no link, no redemption, no sign-out', () => {
  const w = world({ oauth: true });
  const u = w.ctx.lenzSignInUrl();
  const back = w.state.oauth.authorize(u.url, 'allow');
  const args = w.state.stateTokens[0].args;
  w.state.lockFree = false;
  const busy = w.ctx.lenzSignInUrl();
  assert.equal(busy.url, null);
  assert.match(busy.message, /busy/);
  const page = w.ctx.lenzOAuthCallback({ parameter: Object.assign({}, args, back) });
  assert.doesNotMatch(page.html, /signed in/);
  assert.equal(w.state.props.has('lenz:oauth:tokens'), false);
  assert.equal(Object.keys(JSON.parse(w.state.props.get('lenz:oauth:pending'))).length, 1, 'the link stays usable');
  w.state.lockFree = true;
  assert.match(w.ctx.lenzOAuthCallback({ parameter: Object.assign({}, args, back) }).html, /signed in/);
  w.state.lockFree = false;
  assert.equal(w.ctx.lenzSignOut().phase, 'error');
  assert.equal(w.state.props.has('lenz:oauth:tokens'), true);
});

test('a key pasted before the sign-in existed is dropped once, and the sidebar offers Sign in with Lenz', () => {
  const w = world({ oauth: true });
  w.state.props.set('lenz:apiKey', KEY); // saved by the pre-OAuth first-run box: no dev marker
  const r = w.ctx.lenzState();
  assert.equal(r.phase, 'signed_out');
  assert.deepEqual(plain(r.auth), { mode: 'oauth', signedIn: false });
  assert.equal(w.state.props.has('lenz:apiKey'), false);
  assert.equal(w.state.fetches.length, 0);
  assert.equal(trialEvents(w).filter((e) => e.event === 'key_migrated').length, 1);
  w.ctx.lenzState();
  assert.equal(trialEvents(w).filter((e) => e.event === 'key_migrated').length, 1, 'once');
});

test('a key saved through the dev path keeps working and is never migrated', () => {
  const w = world({ oauth: true });
  w.ctx.lenzSaveKey(KEY);
  assert.equal(w.state.props.get('lenz:apiKeySource'), 'dev');
  for (let i = 0; i < 2; i++) assert.deepEqual(plain(w.ctx.lenzState().auth), { mode: 'key', signedIn: true });
  assert.equal(w.state.props.get('lenz:apiKey'), KEY);
  assert.equal(trialEvents(w).filter((e) => e.event === 'key_migrated').length, 0);
  w.ctx.lenzSaveKey('');
  assert.equal(w.state.props.has('lenz:apiKey'), false);
  assert.equal(w.state.props.has('lenz:apiKeySource'), false);
});

test('a pre-OAuth key next to a Lenz sign-in: the key goes, the sign-in carries the check', () => {
  const w = world({ oauth: true });
  signIn(w);
  w.state.props.set('lenz:apiKey', KEY);
  assert.deepEqual(plain(w.ctx.lenzState().auth), { mode: 'oauth', signedIn: true });
  w.ctx.lenzStart();
  const post = w.state.fetches.find((f) => f.url === 'https://lenz.io/api/v1/review');
  assert.match(post.o.headers.Authorization, /^Bearer lat_/);
});

test('a dev marker with no key is harmless: signed out, nothing migrated', () => {
  const w = world({ oauth: true });
  w.state.props.set('lenz:apiKeySource', 'dev');
  assert.equal(w.ctx.lenzState().phase, 'signed_out');
  assert.equal(trialEvents(w).filter((e) => e.event === 'key_migrated').length, 0);
});

test('Dev tools has "Use an API key…"', () => {
  const w = world();
  w.ctx.onOpen({});
  const dev = w.state.menus[0].items.find((i) => i && i.title === 'Dev tools');
  assert.ok(dev.items.some((i) => Array.isArray(i) && i[1] === 'lenzDevUseKey'));
});

// ── the flow ────────────────────────────────────────────────────────

test('start: the tab text goes out once, with a key and the policy', () => {
  const w = started();
  assert.equal(w.state.fetches.length, 1);
  const f = w.state.fetches[0];
  assert.equal(f.url, 'https://lenz.io/api/v1/review');
  const body = JSON.parse(f.o.payload);
  assert.equal(body.text, TEXT);
  assert.equal(body.visibility, 'private');
  assert.equal(body.webhook_url, '');
  assert.deepEqual(body.escalate, { depth: 'standard', max_assessments: 20, max_citations: 20, max_verifications: 5, suggest_edits: true });
  assert.match(f.o.headers['Idempotency-Key'], /^[0-9a-f]{64}$/);
  assert.equal(f.o.headers.Authorization, 'Bearer ' + KEY);
});

test('start on unchanged text returns the same review, no second POST', () => {
  const w = started();
  const r = pollToEnd(w);
  assert.equal(r.phase, 'done');
  const again = w.ctx.lenzStart();
  assert.equal(again.phase, 'done');
  assert.equal(w.state.fetches.filter((f) => f.o.method === 'post').length, 1);
});

test('poll until done: progress, then the model, placed on the unchanged Doc', () => {
  const w = started();
  const first = w.ctx.lenzPoll();
  assert.equal(first.phase, 'running');
  assert.equal(first.model.progress, 'Running 3 deep checks (0 done)');
  assert.equal(first.nextPollS, 15);
  const r = pollToEnd(w);
  assert.equal(r.phase, 'done');
  assert.equal(r.model.headline, '3 issues to look at.');
  assert.deepEqual(plain(r.model.coverage), ['2 citations could not be checked: the reason is under each one.']);
  assert.equal(r.model.groups.flatMap((g) => g.entries).every((e) => e.placed), true);
  // Reopening the sidebar reads the same state.
  assert.equal(w.ctx.lenzState().phase, 'done');
});

test('the lock: a busy poll waits, a busy start says so', () => {
  const w = started();
  w.state.lockFree = false;
  const p = w.ctx.lenzPoll();
  assert.equal(p.phase, 'running');
  assert.equal(p.nextPollS, 5);
  assert.equal(w.ctx.lenzStart().phase, 'error');
});

test('select: a claim becomes its paragraph\'s words; ids only', () => {
  const w = started();
  pollToEnd(w);
  const r = w.ctx.lenzSelect(RID, 'claim:1', 0);
  assert.equal(r.ok, true);
  const aldrin = 'The first person to walk on the Moon was Buzz Aldrin, in July 1969.';
  assert.deepEqual(plain(w.state.selections.pop()), [{ text: aldrin, s: 0, e: aldrin.length - 1 }]);
  // A citation across its link: three pieces, one paragraph, contiguous.
  assert.equal(w.ctx.lenzSelect(RID, 'citation:0', 0).ok, true);
  const sel = plain(w.state.selections.pop());
  assert.equal(sel[0].s, 0);
  assert.equal(sel[sel.length - 1].e, sel[0].text.length - 1);
  for (let i = 1; i < sel.length; i++) assert.equal(sel[i].s, sel[i - 1].e + 1);
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', 1).ok, false);
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1; x', 0).ok, false);
  assert.equal(w.ctx.lenzSelect(RID, { toString: () => 'claim:1' }, 0).ok, false);
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', '0').ok, false);
});

test('apply: one batchUpdate, pinned to the revision read, then marked applied', () => {
  const w = started();
  pollToEnd(w);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  const r = w.ctx.lenzApply(RID, 1, 0);
  assert.equal(r.ok, true, r.message);
  assert.equal(w.state.batches.length, 1);
  const b = w.state.batches[0];
  assert.equal(b.id, 'doc-1');
  assert.equal(b.req.writeControl.requiredRevisionId, 'rev-1');
  // "Buzz Aldrin" in the REST body: its paragraph's startIndex + its UTF-16 offset.
  const para = restParagraphTexts(TEXT)[5];
  const paraStart = 1 + restParagraphTexts(TEXT).slice(0, 5).reduce((n, t) => n + t.length + 1, 0);
  const at = paraStart + para.indexOf('Buzz Aldrin');
  const want = { startIndex: at, endIndex: at + 'Buzz Aldrin'.length };
  assert.deepEqual(b.req.requests, [
    { insertText: { text: 'Neil Armstrong', location: { index: want.endIndex, tabId: 't.0' } } },
    { deleteContentRange: { range: { startIndex: want.startIndex, endIndex: want.endIndex, tabId: 't.0' } } },
  ]);
  assert.equal(entry(r.model, 'claim:1').edits[0].applied, true);
  // Every finding still places on the edited Doc (the snapshot took the same edit).
  assert.equal(r.model.groups.flatMap((g) => g.entries).every((e) => e.placed), true);
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', 0).ok, true);
  assert.equal(plain(w.state.selections.pop())[0].text, 'The first person to walk on the Moon was Neil Armstrong, in July 1969.');
  // Twice is refused.
  const again = w.ctx.lenzApply(RID, 1, 0);
  assert.equal(again.ok, false);
  assert.equal(again.message, 'This edit is already in the Doc.');
  assert.equal(w.state.batches.length, 1);
});

test('apply: a revision conflict re-reads and retries once, then gives up', () => {
  const w = started();
  pollToEnd(w);
  w.state.failBatch = 1;
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, true);
  assert.equal(w.state.batches.length, 2);

  const v = started();
  pollToEnd(v);
  v.state.failBatch = 2;
  const r = v.ctx.lenzApply(RID, 1, 0);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'The Doc changed while applying. Try again.');
  assert.equal(v.state.batches.length, 2);
  assert.equal(v.state.props.has('lenz:applied:4881a880'), false);
});

test('apply: an edit that is not offered, or whose words changed, is refused without writing', () => {
  const w = started();
  pollToEnd(w);
  assert.equal(w.ctx.lenzApply(RID, 0, 0).message, 'This edit is no longer offered.');
  assert.equal(w.ctx.lenzApply(RID, 1, -1).message, 'That edit is not in this check.');
  w.state.text = w.state.text.replace('Buzz Aldrin', 'Buzz  Aldrin');
  assert.equal(w.ctx.lenzApply(RID, 1, 0).message, 'The words changed since the check, so this edit cannot be applied.');
  assert.equal(w.state.batches.length, 0);
});

test('drift: typing elsewhere keeps findings placed; a deleted passage is not in the Doc', () => {
  const w = started();
  pollToEnd(w);
  w.state.text = 'Draft. ' + w.state.text;
  let r = w.ctx.lenzState();
  assert.equal(r.model.groups.flatMap((g) => g.entries).every((e) => e.placed), true);
  w.state.text = w.state.text.replace('\n\nThe first person to walk on the Moon was Buzz Aldrin, in July 1969.', '');
  r = w.ctx.lenzState();
  assert.equal(entry(r.model, 'claim:1').placed, false);
  // The paragraph before it lost its right-hand context (40 cp), so its two findings go too.
  const unplaced = plain(r.model.groups.flatMap((g) => g.entries).filter((e) => !e.placed).map((e) => e.id)).sort();
  assert.deepEqual(unplaced, ['citation:1', 'claim:1', 'claim:3']);
  assert.ok(r.model.coverage.includes('3 findings are not in the Doc as it is now, so they cannot be selected.'));
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', 0).ok, false);
});

// ── one button, Check this Doc (v13) ────────────────────────────────

const posts = (w) => w.state.fetches.filter((f) => f.o.method === 'post');
const keyOf = (f) => f.o.headers['Idempotency-Key'];

test('Check this Doc: the text changed since the last check starts a new review', () => {
  const w = started();
  pollToEnd(w);
  w.state.text = w.state.text + '\n\nThe Moon is made of rock.';
  w.state.polls = POLLS.slice();
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'running');
  assert.equal(posts(w).length, 2);
  assert.notEqual(keyOf(posts(w)[0]), keyOf(posts(w)[1]));
  assert.equal(r.notice, undefined);
});

test('Check this Doc: unchanged text and a completed review show its results, no new review, said so', () => {
  const w = started();
  pollToEnd(w);
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'done');
  assert.equal(r.notice, 'No changes since the last check.');
  assert.equal(r.model.headline, '3 issues to look at.');
  assert.equal(posts(w).length, 1);
});

test('Check this Doc: after a failed review the click starts a new one (the failed receipt is never replayed)', () => {
  const w = started();
  const failed = JSON.parse(JSON.stringify(POLLS[POLLS.length - 1]));
  failed.status = 'failed';
  failed.outcome = 'unchecked';
  failed.failure = { failure_reason: 'upstream_unavailable', failure_class: 'upstream_unavailable', retryable: true, hint: null };
  w.state.polls = [failed];
  assert.equal(w.ctx.lenzPoll().phase, 'done');
  w.state.polls = POLLS.slice();
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'running');
  assert.equal(r.notice, undefined);
  assert.equal(posts(w).length, 2);
  assert.notEqual(keyOf(posts(w)[0]), keyOf(posts(w)[1]));
  assert.equal(posts(w)[0].o.payload, posts(w)[1].o.payload);
});

for (const code of [403, 404, 410]) {
  test('Check this Doc: a review Lenz can no longer give back (' + code + ') is checked anew', () => {
    const w = started();
    w.state.getReply = { code, body: { detail: 'gone', code: code === 410 ? 'purged' : 'not_found' } };
    const p = w.ctx.lenzPoll();
    assert.equal(p.phase, 'error');
    assert.match(p.error.message, /Check this Doc/);
    w.state.getReply = null;
    const r = w.ctx.lenzStart();
    assert.equal(r.phase, 'running');
    assert.equal(posts(w).length, 2);
    assert.notEqual(keyOf(posts(w)[0]), keyOf(posts(w)[1]));
  });
}

test('Check this Doc: an unconfirmed request (unknown) starts a new review on the click', () => {
  const w = world({ transportDown: true });
  w.ctx.lenzSaveKey(KEY);
  w.ctx.lenzStart(); // the answer is lost: pending, body cached
  for (const k of [...w.cache.m.keys()]) if (k.startsWith('lenz:body:')) w.cache.m.delete(k);
  w.state.down = false;
  const u = w.ctx.lenzPoll(); // the replay finds no body: unknown
  assert.equal(u.phase, 'error');
  assert.match(u.error.message, /Check this Doc/);
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'running');
  const ps = posts(w);
  assert.equal(ps.length, 2);
  assert.notEqual(keyOf(ps[0]), keyOf(ps[1]));
});

test('Check this Doc: a lost reply is still replayed with the same key, not started over', () => {
  const w = world({ transportDown: true });
  w.ctx.lenzSaveKey(KEY);
  w.ctx.lenzStart();
  w.state.down = false;
  w.state.text = 'Changed meanwhile.';
  assert.equal(w.ctx.lenzStart().phase, 'running');
  assert.equal(posts(w).length, 2);
  assert.equal(keyOf(posts(w)[0]), keyOf(posts(w)[1]));
  assert.equal(posts(w)[0].o.payload, posts(w)[1].o.payload);
});

test('an empty tab is not sent', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  w.state.text = '   ';
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'error');
  assert.equal(r.error.message, 'This tab has no text to check.');
  assert.equal(w.state.fetches.length, 0);
});

test('no response to the POST: the next poll replays the same request, same key', () => {
  const w = world({ transportDown: true });
  w.ctx.lenzSaveKey(KEY);
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'running');
  assert.equal(r.error.message, "Couldn't reach Lenz. Check your connection and try again.");
  w.state.down = false;
  w.state.text = 'The Doc changed meanwhile.';
  const p = w.ctx.lenzPoll();
  assert.equal(p.phase, 'running');
  assert.equal(p.error, null);
  const posts = w.state.fetches.filter((f) => f.o.method === 'post');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].o.headers['Idempotency-Key'], posts[1].o.headers['Idempotency-Key']);
  assert.equal(posts[1].o.payload, posts[0].o.payload);
  assert.equal(JSON.parse(posts[1].o.payload).text, TEXT);
});

// ── review fixes, round 1 ───────────────────────────────────────────

test('Select and Apply name the review shown; a list from another check is refused', () => {
  const w = started();
  pollToEnd(w);
  const sel = w.ctx.lenzSelect('ffffffff', 'claim:1', 0);
  assert.equal(sel.ok, false);
  assert.match(sel.message, /another tab or an earlier check/);
  assert.equal(w.ctx.lenzSelect(undefined, 'claim:1', 0).ok, false);
  const app = w.ctx.lenzApply('ffffffff', 1, 0);
  assert.equal(app.ok, false);
  assert.match(app.message, /another tab or an earlier check/);
  assert.equal(w.state.batches.length, 0);
  assert.equal(w.state.selections.length, 0);
});

test('a pending request is replayed without reading the Doc, even an emptied one', () => {
  const w = world({ transportDown: true });
  w.ctx.lenzSaveKey(KEY);
  w.state.text = TEXT + '\n\n[a](https://example.com/x)'; // coverage metadata for THIS text
  w.ctx.lenzStart();
  const meta = w.state.props.get('lenz:meta:doc-1:t.0');
  const reads = w.state.gets;
  w.state.down = false;
  w.state.text = '   ';
  const p = w.ctx.lenzPoll();
  assert.equal(p.phase, 'running');
  assert.equal(w.state.gets, reads);
  assert.equal(w.state.props.get('lenz:meta:doc-1:t.0'), meta);
  const posts = w.state.fetches.filter((f) => f.o.method === 'post');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].o.headers['Idempotency-Key'], posts[1].o.headers['Idempotency-Key']);
});

test('a Check click while a request is pending settles it without reading the Doc', () => {
  const w = world({ transportDown: true });
  w.ctx.lenzSaveKey(KEY);
  w.ctx.lenzStart();
  const reads = w.state.gets;
  w.state.down = false;
  w.state.text = '   ';
  const s = w.ctx.lenzStart();
  assert.equal(s.phase, 'running');
  assert.equal(s.error, null);
  assert.equal(w.state.gets, reads);
  const posts = w.state.fetches.filter((f) => f.o.method === 'post');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].o.payload, posts[1].o.payload);
});

test('after Apply, an unchanged Doc still places when the snapshot left the cache', () => {
  const w = started();
  pollToEnd(w);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, true);
  const stored = JSON.parse(w.state.props.get('lenz:applied:' + RID));
  assert.equal(stored.snapshotHash, crypto.createHash('sha256').update(w.state.text, 'utf8').digest('hex'));
  for (const k of [...w.cache.m.keys()]) if (k.startsWith('lenz:snap:')) w.cache.m.delete(k);
  const r = w.ctx.lenzState();
  assert.equal(r.model.groups.flatMap((g) => g.entries).every((e) => e.placed), true);
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', 0).ok, true);
});

test('the first Apply after the snapshot expired still records the hash (placed by hash)', () => {
  const w = started();
  pollToEnd(w);
  for (const k of [...w.cache.m.keys()]) if (k.startsWith('lenz:snap:')) w.cache.m.delete(k);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, true);
  const r = w.ctx.lenzState();
  assert.equal(r.model.groups.flatMap((g) => g.entries).every((e) => e.placed), true);
});

// ── the trial log (docs/trial.md) ───────────────────────────────────

// The trial lines written so far, after what a click left pending goes out (as the next poll does).
function trialLines(w) {
  w.ctx.lenzScoped_(() => w.ctx.lenzTrialFlush_());
  return w.state.logDocs.flatMap((d) => d.lines).map((l) => JSON.parse(l));
}

test('trial log: review_done once, every finding placed, the Apply, ids only', () => {
  const w = started();
  pollToEnd(w);
  w.ctx.lenzState(); // a reopen places again, no second review_done
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, true);
  w.ctx.lenzApply(RID, 1, 0);
  const lines = trialLines(w);
  assert.equal(w.state.logDocs.length, 1);
  const done = lines.filter((e) => e.event === 'review_done');
  assert.equal(done.length, 1);
  assert.deepEqual([done[0].findings, done[0].edits], [8, 1]);
  assert.equal(done[0].charged, 35);
  assert.equal(done[0].doc, crypto.createHash('sha256').update('doc-1').digest('hex').slice(0, 12));
  assert.equal(done[0].review, RID);
  assert.equal(done[0].v, 1);
  const firstPass = lines.slice(lines.indexOf(lines.find((e) => e.event === 'review_done')) + 1, lines.indexOf(lines.find((e) => e.event === 'review_done')) + 9);
  assert.deepEqual(firstPass.map((e) => e.finding).sort(), [
    'citation:0', 'citation:1', 'claim:0@0', 'claim:1@0', 'claim:2@0', 'claim:3@0', 'claim:4@0', 'edit:1.0',
  ]);
  assert.ok(firstPass.every((e) => e.event === 'placed'));
  assert.equal(firstPass.find((e) => e.kind === 'edit').passage, 'claim:1@0');
  assert.deepEqual(lines.filter((e) => e.event === 'applied').map((e) => [e.finding, e.passage]), [['edit:1.0', 'claim:1@0']]);
  const refused = lines.filter((e) => e.event === 'apply_refused');
  assert.deepEqual(refused.map((e) => e.reason), ['already_applied']);
  const raw = w.state.logDocs[0].lines.join('\n');
  for (const word of ['Aldrin', 'Armstrong', 'Eiffel', 'doc-1', KEY]) assert.ok(!raw.includes(word), word);
});

test('trial log: a wrong-words flag names the last selection', () => {
  const w = started();
  pollToEnd(w);
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', 0).ok, true);
  w.ctx.lenzDevWrongSelect();
  const wrong = trialLines(w).filter((e) => e.event === 'wrong');
  assert.deepEqual(wrong.map((e) => [e.finding, e.of, e.review]), [['claim:1@0', 'select', RID]]);
  w.ctx.lenzDevWrongApply(); // no Apply yet
  assert.equal(trialLines(w).filter((e) => e.event === 'wrong').length, 1);
});

test('Apply is refused before writing when the applied state would outgrow a property', () => {
  const w = started();
  pollToEnd(w);
  const big = Array.from({ length: 40 }, (_, i) => ({ id: '9:' + i, start: 0, end: 0, text: '', replacement: 'x'.repeat(200) }));
  w.state.props.set('lenz:applied:' + RID, JSON.stringify({ edits: big, snapshotHash: null }));
  const r = w.ctx.lenzApply(RID, 1, 0);
  assert.equal(r.ok, false);
  assert.match(r.message, /cannot keep track/);
  assert.equal(w.state.batches.length, 0);
  assert.deepEqual(trialLines(w).filter((e) => e.event === 'apply_refused').map((e) => e.reason), ['state_full']);
});

// ── review fixes, round 3 ───────────────────────────────────────────

test('select refuses, never mis-selects, when the paragraph changed between the two reads', () => {
  const w = started();
  pollToEnd(w);
  w.state.appText = w.state.text.replace('The first person', 'Surely the first person');
  const r = w.ctx.lenzSelect(RID, 'claim:1', 0);
  assert.equal(r.ok, false);
  assert.equal(r.message, 'The Doc is changing. Try again in a moment.');
  assert.equal(w.state.selections.length, 0);
});

test('REST paragraph text: runs as they are, other elements as U+FFFC, breaks as \\n', () => {
  const w = world();
  const text = w.ctx.lenzRestParagraphText_({ elements: [
    { startIndex: 1, endIndex: 4, textRun: { content: 'ab\u000b' } },
    { startIndex: 4, endIndex: 5, inlineObjectElement: {} },
    { startIndex: 5, endIndex: 8, textRun: { content: 'cd\n' } },
  ] });
  assert.equal(text, 'ab\n\ufffccd');
});

test('a capped tab: after Apply the findings place from the cached snapshot', () => {
  const w = world();
  w.state.text = TEXT + '\n\n' + 'word '.repeat(12000);
  w.ctx.lenzSaveKey(KEY);
  w.ctx.lenzStart();
  pollToEnd(w);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, true);
  // The cap moves with the edit, so the Doc is never the snapshot again: placement goes by the
  // cached snapshot (6 h), never by a hash of a re-read (which would also hold earlier typing).
  const r = w.ctx.lenzState();
  assert.equal(r.model.groups.flatMap((g) => g.entries).every((e) => e.placed), true);
});

test('the Spike submenu appears only when src/dev.js is loaded', () => {
  const w = world();
  w.ctx.onOpen({});
  const titles = (m) => m.items.map((i) => (Array.isArray(i) ? i[0] : i.title));
  let dev = w.state.menus[0].items.find((i) => i.title === 'Dev tools');
  assert.ok(!titles(dev).includes('Spike'));
  vm.runInContext('function lenzDev_menuSelect() {} function lenzDev_menuCheck() {}', w.ctx);
  w.ctx.onOpen({});
  dev = w.state.menus[1].items.find((i) => i.title === 'Dev tools');
  assert.ok(titles(dev).includes('Spike'));
});

test('the trial log feeds scripts/trial-report.js as-is', () => {
  const { parse, report } = require('../scripts/trial-report.js');
  const w = started();
  pollToEnd(w);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  w.ctx.lenzApply(RID, 1, 0);
  w.ctx.lenzPoll(); // the next poll writes what the Apply left pending
  const jsonl = w.state.logDocs.flatMap((d) => d.lines).join('\n');
  const parsed = parse(jsonl);
  assert.equal(parsed.skipped, 0);
  const r = report(parsed.events);
  const s = JSON.stringify(r);
  assert.ok(r && typeof r === 'object', s);
  // Every finding review_done promised got a placement (no gap), all placed; the one edit applied.
  assert.match(s, /"expected":8/);
  assert.match(s, /"total":8/);
  assert.match(s, /"placed":8/);
  assert.match(s, /"applicable":1/);
});

// ── a replay Lenz refuses (cross-module review) ─────────────────────

test('a lost reply, then a revoked dev key: still pending, and a new key finishes the replay', () => {
  const w = world({ transportDown: true });
  w.ctx.lenzSaveKey(KEY);
  w.ctx.lenzStart(); // the POST's answer is lost: pending
  w.state.down = false;
  w.state.postReply = { code: 401, body: { detail: 'Invalid API key.', code: 'unauthorized' } };
  const p = w.ctx.lenzPoll();
  assert.equal(p.phase, 'running');
  assert.equal(p.error.code, 401);
  w.state.postReply = null;
  const NEW = 'lenz_' + 'b'.repeat(32);
  const r = w.ctx.lenzSaveKey(NEW);
  assert.equal(r.phase, 'running');
  assert.equal(r.error, null);
  const posts = w.state.fetches.filter((f) => f.o.method === 'post');
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map((f) => f.o.headers['Idempotency-Key'])).size, 1);
  assert.equal(posts[2].o.headers.Authorization, 'Bearer ' + NEW);
  assert.equal(pollToEnd(w).phase, 'done');
});

test('a lost reply, then no credits: the line says the check continues once credits are added', () => {
  const w = world({ transportDown: true });
  w.ctx.lenzSaveKey(KEY);
  w.ctx.lenzStart();
  w.state.down = false;
  w.state.postReply = { code: 402, body: { detail: 'Out of credits.', code: 'insufficient_credits' } };
  const p = w.ctx.lenzPoll();
  assert.equal(p.phase, 'running');
  assert.equal(p.error.message, 'Your account is out of credits. Add credits at lenz.io/plans and this check continues on its own.');
  assert.ok(p.nextPollS > 0);
  w.state.postReply = null;
  assert.equal(w.ctx.lenzPoll().error, null);
});

// ── headless e2e (src/dev-e2e.js, clasp run) ────────────────────────

test('e2e: start, step until done, then every finding placed and every edit applied', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  const start = plain(w.ctx.lenzDev_e2eStart('doc-1'));
  assert.equal(start.phase, 'running');
  assert.equal(start.tabId, 't.0');
  assert.equal(start.textChars, TEXT.length);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  let step;
  for (let i = 0; i < 10; i++) {
    step = plain(w.ctx.lenzDev_e2eStep('doc-1'));
    if (step.done) break;
    assert.equal(step.placements, undefined);
    assert.equal(w.state.batches.length, 0);
  }
  assert.equal(step.phase, 'done');
  assert.equal(step.reviewId, RID);
  assert.equal(step.headline, '3 issues to look at.');
  assert.equal(step.placements.length, 8);
  assert.ok(step.placements.every((p) => p.status === 'placed'), JSON.stringify(step.placements));
  assert.equal(step.placements.find((p) => p.finding === 'edit:1.0').applicable, true);
  assert.deepEqual(step.applies, [{ finding: 'edit:1.0', passage: 'claim:1@0', ok: true, message: 'Applied. Undo it here, or restore an earlier version from File \u2192 Version history.' }]);
  assert.equal(step.before, TEXT);
  assert.equal(step.after, TEXT.replace('Buzz Aldrin', 'Neil Armstrong'));
  // A second step refuses the same edit, and the Doc is unchanged.
  const again = plain(w.ctx.lenzDev_e2eStep('doc-1'));
  assert.equal(again.applies[0].ok, false);
  assert.equal(again.applies[0].message, 'This edit is already in the Doc.');
  assert.equal(w.state.batches.length, 1);
  // The same code path as the sidebar: the trial log saw it all.
  assert.ok(trialLines(w).some((e) => e.event === 'applied'));
});

test('e2e: refuses a Doc whose title is not "Lenz spike …", and runs without a key only to refuse', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  w.state.title = 'Quarterly report';
  assert.throws(() => w.ctx.lenzDev_e2eStart('doc-1'), /not a spike Doc/);
  assert.throws(() => w.ctx.lenzDev_e2eStep('doc-1'), /not a spike Doc/);
  assert.equal(w.state.fetches.length, 0);
  assert.equal(w.state.batches.length, 0);
  w.state.title = 'Lenz spike e2e';
  w.ctx.lenzSaveKey('');
  assert.throws(() => w.ctx.lenzDev_e2eStart('doc-1'), /not signed in and no Lenz API key/);
  assert.throws(() => w.ctx.lenzDev_e2eStart(''), /spike Doc id/);
});

test('e2e: with the completed body evicted, a miss on the finishing GET is not done; the next step finishes', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  w.ctx.lenzDev_e2eStart('doc-1');
  w.state.polls = [POLLS[POLLS.length - 1]];
  // The poll sees it done; the second GET gets no answer.
  const real = w.ctx.UrlFetchApp.fetch;
  let gets = 0;
  w.ctx.UrlFetchApp.fetch = (url, o) => {
    if (o.method === 'get' && ++gets === 2) throw new Error('timeout');
    return real(url, o);
  };
  // The poll keeps the completed body; evict it so the finish must GET.
  const realGet = w.cache.get;
  w.cache.get = (k) => (k.startsWith('lenz:done:') ? null : realGet(k));
  const miss = plain(w.ctx.lenzDev_e2eStep('doc-1'));
  assert.equal(miss.done, false);
  assert.equal(miss.error.retryable, true);
  assert.equal(miss.applies, undefined);
  assert.equal(w.state.batches.length, 0);
  const ok = plain(w.ctx.lenzDev_e2eStep('doc-1'));
  assert.equal(ok.done, true);
  assert.equal(ok.applies.length, 1);
});

test('e2e: finishes only the review the poll found done', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  w.ctx.lenzDev_e2eStart('doc-1');
  w.state.polls = [POLLS[POLLS.length - 1]];
  // Another execution starts a new review between the poll and the finishing GET.
  const realPoll = w.ctx.lenzPollIn_;
  w.ctx.lenzPollIn_ = (ctx) => {
    const r = realPoll(ctx);
    w.ctx.PropertiesService.getUserProperties().setProperty('lenz:rec:doc-1:t.0',
      JSON.stringify({ reviewId: 'feedf00d', key: 'k2', tabId: 't.0', textHash: 'x', attempt: 1, state: 'running' }));
    return r;
  };
  const step = plain(w.ctx.lenzDev_e2eStep('doc-1'));
  assert.equal(step.done, false);
  assert.match(step.error.message, /another tab or an earlier check/);
  assert.equal(w.state.batches.length, 0);
});

// ── the read cache (lenzRead_) ──────────────────────────────────────

test('read cache: a click on an unchanged Doc reads only the revision', () => {
  const w = started();
  pollToEnd(w);
  const gets = w.state.gets;
  const heads = w.state.heads;
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', 0).ok, true);
  assert.equal(w.state.gets, gets);
  assert.equal(w.state.heads, heads + 1);
  assert.match(w.state.logs.filter((l) => l.startsWith('lenz_read')).pop(), /^lenz_read mode=cached ms=\d+ rev_ms=\d+ pieces=\d+$/);
});

test('read cache: a changed Doc is read in full, then cached at its new revision', () => {
  const w = started();
  pollToEnd(w);
  w.state.text = 'Draft. ' + w.state.text;
  const gets = w.state.gets;
  w.ctx.lenzSelect(RID, 'claim:1', 0);
  assert.equal(w.state.gets, gets + 1);
  assert.match(w.state.logs.filter((l) => l.startsWith('lenz_read')).pop(), /^lenz_read mode=full /);
  w.ctx.lenzSelect(RID, 'claim:1', 0);
  assert.equal(w.state.gets, gets + 1);
});

test('read cache: Apply then the list: the write is pinned, and no full read follows it', () => {
  const w = started();
  pollToEnd(w);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  const gets = w.state.gets;
  const r = w.ctx.lenzApply(RID, 1, 0);
  assert.equal(r.ok, true);
  assert.equal(w.state.batches[0].req.writeControl.requiredRevisionId, 'rev-1');
  // The click read rev-1 from the cache; after the write the map moves in place (no full read).
  assert.equal(w.state.gets, gets);
  assert.equal(r.model.groups.flatMap((g) => g.entries).every((e) => e.placed), true);
});

test('read cache: the key carries the serializer, so a new serializer never reuses a map', () => {
  const w = started();
  pollToEnd(w);
  const gets = w.state.gets;
  vm.runInContext("LENZ_SERIALIZER_SHA = 'another-serializer'", w.ctx);
  w.ctx.lenzSelect(RID, 'claim:1', 0);
  assert.equal(w.state.gets, gets + 1);
});

test('read cache: LENZ_SERIALIZER_SHA is sha256(src/serialize.js) (update it with serialize.js)', () => {
  const w = world();
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(SRC, 'serialize.js'))).digest('hex').slice(0, 16);
  assert.equal(w.ctx.LENZ_SERIALIZER_SHA, sha,
    'serialize.js changed: set LENZ_SERIALIZER_SHA in src/Code.js to ' + sha + ' so cached maps from the old serializer are not reused');
});

// ── Undo: the applied list without one edit ─────────────────────────

test('lenzWithoutApplied_: later disjoint edits shift back; a later edit touching it refuses', () => {
  const w = world();
  const a = { id: '0:0', start: 10, end: 14, text: '1972', replacement: '19690' }; // +1
  const b = { id: '0:1', start: 30, end: 34, text: 'four', replacement: 'three' }; // after a
  const c = { id: '1:0', start: 2, end: 5, text: 'abc', replacement: 'x' }; // before a
  assert.deepEqual(plain(w.ctx.lenzWithoutApplied_([a, b, c], 0)), [
    { id: '0:1', start: 29, end: 33, text: 'four', replacement: 'three' },
    { id: '1:0', start: 2, end: 5, text: 'abc', replacement: 'x' },
  ]);
  assert.deepEqual(plain(w.ctx.lenzWithoutApplied_([a, b], 1)), [a]);
  const inside = { id: '0:2', start: 11, end: 13, text: '96', replacement: '97' };
  assert.equal(w.ctx.lenzWithoutApplied_([a, inside], 0), null);
});

test('undo: the trial log records undone and undo_refused; the Apply message is true', () => {
  const w = started();
  pollToEnd(w);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  const r = w.ctx.lenzApply(RID, 1, 0);
  assert.equal(r.message, 'Applied. Undo it here, or restore an earlier version from File \u2192 Version history.');
  assert.equal(entry(r.model, 'claim:1').edits[0].applied, true);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Neil Armstrong', 'Buzz Aldrin');
    w.state.rev = 'rev-3';
  };
  const u = w.ctx.lenzUndo(RID, 1, 0);
  assert.equal(u.ok, true, u.message);
  const last = w.state.batches[w.state.batches.length - 1].req;
  assert.equal(last.writeControl.requiredRevisionId, 'rev-2');
  assert.equal(last.requests[0].insertText.text, 'Buzz Aldrin');
  assert.equal(last.requests[1].deleteContentRange.range.endIndex - last.requests[1].deleteContentRange.range.startIndex, 'Neil Armstrong'.length);
  assert.equal(entry(u.model, 'claim:1').edits[0].applied, false);
  assert.equal(u.model.groups.flatMap((g) => g.entries).every((e) => e.placed), true);
  assert.equal(w.ctx.lenzUndo(RID, 1, 0).ok, false);
  const ev = trialLines(w).filter((e) => e.event === 'undone' || e.event === 'undo_refused');
  assert.deepEqual(ev.map((e) => [e.event, e.finding, e.passage, e.reason || null]), [
    ['undone', 'edit:1.0', 'claim:1@0', null],
    ['undo_refused', 'edit:1.0', 'claim:1@0', 'not_applied'],
  ]);
});

test('lenzWithoutApplied_: tracks the undone edit past later edits applied before it (review repro)', () => {
  const w = world();
  const first = { id: '0:0', start: 10, end: 14, text: 'klmn', replacement: 'X' }; // -3
  const grow = { id: '0:1', start: 0, end: 1, text: 'a', replacement: 'a'.repeat(20) }; // +19, before it
  const third = { id: '0:2', start: 24, end: 25, text: 'f', replacement: 'F' }; // current 24-25: before X (now at 29)
  assert.deepEqual(plain(w.ctx.lenzWithoutApplied_([first, grow, third], 0)), [grow, third]);
  // After it: shifted back by the undone edit's delta (+3).
  const after = { id: '0:3', start: 31, end: 32, text: 'q', replacement: 'Q' };
  assert.deepEqual(plain(w.ctx.lenzWithoutApplied_([first, grow, after], 0)), [grow, { id: '0:3', start: 34, end: 35, text: 'q', replacement: 'Q' }]);
  // Touching its (moved) replacement: refused.
  const touch = { id: '0:4', start: 29, end: 30, text: 'X', replacement: 'Y' };
  assert.equal(w.ctx.lenzWithoutApplied_([first, grow, touch], 0), null);
});

test('the sidebar shows no charge line; the trial log keeps it', () => {
  const html = fs.readFileSync(path.join(SRC, 'sidebar.html'), 'utf8');
  assert.ok(!/id="charged"|\.charged/.test(html));
});

test('running replies carry the check\'s start time; done ones do not', () => {
  const w = started();
  const rec = JSON.parse(w.state.props.get('lenz:rec:doc-1:t.0'));
  assert.equal(typeof rec.submittedAt, 'number');
  const p = w.ctx.lenzPoll();
  assert.equal(p.phase, 'running');
  assert.equal(p.startedAt, rec.submittedAt);
  assert.equal(w.ctx.lenzStart().startedAt, rec.submittedAt);
  assert.equal(pollToEnd(w).startedAt, null);
});

function completedWith(outcome) {
  const b = JSON.parse(JSON.stringify(POLLS[POLLS.length - 1]));
  b.outcome = outcome;
  return b;
}

test('Check this Doc: a completed but incomplete review starts over (a new review), and says so', () => {
  const w = started();
  w.state.polls = [completedWith('incomplete')];
  const done = w.ctx.lenzPoll();
  assert.equal(done.phase, 'done');
  assert.ok(done.model.coverage.includes('Some checks did not finish. Choose Check this Doc to try them again.'));
  w.state.polls = POLLS.slice();
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'running');
  assert.equal(r.notice, undefined);
  assert.equal(posts(w).length, 2);
  assert.notEqual(keyOf(posts(w)[0]), keyOf(posts(w)[1]));
  assert.equal(posts(w)[0].o.payload, posts(w)[1].o.payload);
});

test('Check this Doc: an incomplete review whose deep checks all found too few sources shows its results, no charge', () => {
  const w = started();
  const body = JSON.parse(JSON.stringify(POLLS[POLLS.length - 1]));
  Object.assign(body, JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reviews', 'deep-failed-thin.review.json'), 'utf8')), { review_id: body.review_id });
  w.state.polls = [body];
  const done = w.ctx.lenzPoll();
  assert.equal(done.phase, 'done');
  assert.ok(!done.model.coverage.includes('Some checks did not finish. Choose Check this Doc to try them again.'));
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'done');
  assert.equal(r.notice, 'No changes since the last check.');
  assert.equal(posts(w).length, 1);
});

test('Check this Doc: a marker an older add-on left on a too-few-sources review is cleared, no charge', () => {
  const w = started();
  const body = JSON.parse(JSON.stringify(POLLS[POLLS.length - 1]));
  Object.assign(body, JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'reviews', 'deep-failed-thin.review.json'), 'utf8')), { review_id: body.review_id });
  w.state.props.set('lenz:incomplete:' + body.review_id, '1');
  w.state.polls = [body];
  assert.equal(w.ctx.lenzPoll().phase, 'done');
  assert.equal(w.state.props.has('lenz:incomplete:' + body.review_id), false);
  const r = w.ctx.lenzStart();
  assert.equal(r.notice, 'No changes since the last check.');
  assert.equal(posts(w).length, 1);
});

for (const outcome of ['issues_found', 'clean']) {
  test('Check this Doc: a completed ' + outcome + ' review on unchanged text shows its results, no charge', () => {
    const w = started();
    w.state.polls = [completedWith(outcome)];
    assert.equal(w.ctx.lenzPoll().phase, 'done');
    const r = w.ctx.lenzStart();
    assert.equal(r.phase, 'done');
    assert.equal(r.notice, 'No changes since the last check.');
    assert.equal(posts(w).length, 1);
  });
}

test('the privacy line is one wording, in the sidebar and the listing', () => {
  const line = "Lenz receives this tab's text to check it and keeps the check in your Lenz account. Deleting your account deletes it.";
  assert.ok(fs.readFileSync(path.join(SRC, 'sidebar.html'), 'utf8').includes(line));
  const listing = fs.readFileSync(path.join(__dirname, '..', 'docs', 'listing', 'listing.md'), 'utf8').replace(/\s+/g, ' ');
  assert.ok(listing.includes(line));
});

test('after an Apply on a drifted Doc, a citation still selects its own words (not offsets from the drift)', () => {
  const w = started();
  pollToEnd(w);
  w.state.text = 'Draft. ' + w.state.text; // the author typed before applying
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-9';
  };
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, true);
  w.state.selections.length = 0;
  const r = w.ctx.lenzSelect(RID, 'citation:0', 0);
  if (r.ok) {
    const sel = plain(w.state.selections.pop());
    const words = sel.map((s) => s.text.slice(s.s, s.e + 1)).join('');
    assert.ok(words.startsWith('The Great Wall of China'), 'selected: ' + words);
  }
});

test('a completed review: Select, Apply and Undo take the kept body (no GET)', () => {
  const w = started();
  pollToEnd(w);
  const gets = () => w.state.fetches.filter((f) => f.o.method === 'get').length;
  const before = gets();
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', 0).ok, true);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, true);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Neil Armstrong', 'Buzz Aldrin');
    w.state.rev = 'rev-3';
  };
  assert.equal(w.ctx.lenzUndo(RID, 1, 0).ok, true);
  assert.equal(gets(), before);
  // Evicted: a click GETs again.
  for (const k of [...w.cache.m.keys()]) if (k.startsWith('lenz:done:')) w.cache.m.delete(k);
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', 0).ok, true);
  assert.equal(gets(), before + 1);
});

test('lenz_apply: one timing line per Apply and Undo that wrote, numbers only', () => {
  const w = started();
  pollToEnd(w);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  w.ctx.lenzApply(RID, 1, 0);
  const lines = w.state.logs.filter((l) => l.startsWith('lenz_apply'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^lenz_apply op=apply ms_total=\d+ ms_review=\d+ review=cached ms_rev=\d+ ms_read=\d+ mode=cached ms_write=\d+ ms_after=\d+ ms_state=\d+ ms_map=\d+ ms_place=\d+ ms_view=\d+ ms_keep=\d+ ms_trial=\d+$/);
  // ms_after is the sum of its four parts.
  const n = (k) => Number(new RegExp(' ' + k + '=(\\d+)').exec(lines[0])[1]);
  assert.equal(n('ms_after'), n('ms_state') + n('ms_map') + n('ms_place') + n('ms_view'));
  // A refused click writes nothing and logs no line.
  w.ctx.lenzApply(RID, 1, 0);
  assert.equal(w.state.logs.filter((l) => l.startsWith('lenz_apply')).length, 1);
});

// ── opening fast (lenzOpen) ─────────────────────────────────────────

test('open: the last reply for this tab, marked stale, with no Lenz call and no Doc read', () => {
  const w = started();
  const done = pollToEnd(w);
  assert.equal(done.phase, 'done');
  const fetches = w.state.fetches.length;
  const gets = w.state.gets;
  const heads = w.state.heads;
  const r = plain(w.ctx.lenzOpen());
  assert.equal(r.stale, true);
  assert.equal(r.phase, 'done');
  assert.equal(r.model.reviewId, RID);
  assert.equal(r.model.headline, '3 issues to look at.');
  assert.equal(w.state.fetches.length, fetches);
  assert.equal(w.state.gets, gets);
  assert.equal(w.state.heads, heads);
});

test('open: nothing kept is idle at once; signed out is the sign-in, both with no network', () => {
  const w = world();
  const signedOut = plain(w.ctx.lenzOpen());
  assert.equal(signedOut.phase, 'signed_out');
  w.ctx.lenzSaveKey(KEY);
  const fetches = w.state.fetches.length;
  const idle = plain(w.ctx.lenzOpen());
  assert.equal(idle.phase, 'idle');
  assert.equal(idle.stale, true);
  assert.equal(w.state.fetches.length, fetches);
  assert.equal(w.state.gets + w.state.heads, 0);
});

test('open: a busy placeholder never replaces the kept list', () => {
  const w = started();
  pollToEnd(w);
  w.state.lockFree = false;
  assert.equal(w.ctx.lenzPoll().phase, 'running');
  w.state.lockFree = true;
  assert.equal(plain(w.ctx.lenzOpen()).phase, 'done');
});

test('lenz_open: the sidebar\'s timings, numbers only', () => {
  const w = world();
  w.ctx.lenzLogOpen(42.4, 1310, 'ignored');
  w.ctx.lenzLogOpen('x', null);
  assert.deepEqual(w.state.logs.filter((l) => l.startsWith('lenz_open')), ['lenz_open ms_first=42 ms_full=1310', 'lenz_open ms_first=-1 ms_full=-1']);
});

test('map after a write: an edit that pushes the tab past the cap is left to a full read', () => {
  const w = world();
  const cap = w.ctx.LenzSerialize.CAP;
  const text = 'x'.repeat(cap - 5) + 'abcde';
  const live = { text, textHash: 'h', revisionId: 'r1', truncated: false, notRead: {}, tabId: 't.0',
    pieces: [{ rs: 0, re: cap, ds: 1, de: 1 + cap, kind: 'text', flags: { suggested: false, atomic: false, link: false }, para: 0 }] };
  const paras = [{ start: 1, end: cap + 2, text }];
  const placed = { rs: cap - 1, re: cap, ranges: [{ startIndex: cap, endIndex: cap + 1 }] };
  assert.equal(w.ctx.lenzMapAfterWrite_({ live, paras }, placed, 'EEE', 'r2'), null);
  const ok = plain(w.ctx.lenzMapAfterWrite_({ live, paras }, placed, 'E', 'r2'));
  assert.equal(ok.live.text.length, cap);
  assert.equal(ok.live.revisionId, 'r2');
});

test('the kept completed body is written again when its chunks were evicted', () => {
  const w = started();
  pollToEnd(w);
  const chunk = [...w.cache.m.keys()].find((k) => k.startsWith('lenz:done:') && k.includes('#'));
  assert.ok(chunk);
  w.cache.m.delete(chunk); // the head stays
  w.state.polls = [POLLS[POLLS.length - 1]];
  w.ctx.lenzState(); // the review is read again: the body is written whole
  const gets = w.state.fetches.filter((f) => f.o.method === 'get').length;
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', 0).ok, true);
  assert.equal(w.state.fetches.filter((f) => f.o.method === 'get').length, gets);
});

test('scope: properties read before the lock are read again inside it (another call may have written)', () => {
  const w = started();
  w.ctx.lenzScoped_(() => {
    const props = w.ctx.lenzUserProps_();
    assert.ok(props.getProperty('lenz:rec:doc-1:t.0')); // loaded before the lock
    w.state.props.set('lenz:rec:doc-1:t.0', '{"changed":true}'); // written by another call meanwhile
    assert.notEqual(w.ctx.lenzUserProps_().getProperty('lenz:rec:doc-1:t.0'), '{"changed":true}');
    w.ctx.lenzWithLock_(() => {
      assert.equal(w.ctx.lenzUserProps_().getProperty('lenz:rec:doc-1:t.0'), '{"changed":true}');
    });
  });
});

test('scope: nothing outlives the call', () => {
  const w = started();
  w.ctx.lenzPoll();
  assert.equal(w.ctx.LENZ_SCOPE, null);
  w.state.props.set('lenz:apiKey', 'lenz_' + 'z'.repeat(32));
  assert.equal(w.ctx.lenzApiKey_(), 'lenz_' + 'z'.repeat(32));
});

test('scope: a store made before the lock reads the service again inside it (review repro)', () => {
  const w = started();
  w.ctx.lenzScoped_(() => {
    const store = w.ctx.lenzStore_(); // as a client built before the lock
    const before = store.get('lenz:rec:doc-1:t.0');
    assert.ok(before);
    w.state.props.set('lenz:rec:doc-1:t.0', '{"changed":true}'); // another call, while this one waits
    w.ctx.lenzWithLock_(() => {
      assert.equal(store.get('lenz:rec:doc-1:t.0'), '{"changed":true}');
    });
  });
});

test('lenz_apply: a write that failed logs no line', () => {
  const w = started();
  pollToEnd(w);
  w.state.failBatch = 2; // conflict twice: gives up
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, false);
  assert.equal(w.state.logs.filter((l) => l.startsWith('lenz_apply')).length, 0);
});

test('scope: properties read inside the lock are read again after it (another window may write)', () => {
  const w = started();
  w.ctx.lenzScoped_(() => {
    w.ctx.lenzWithLock_(() => {
      assert.ok(w.ctx.lenzUserProps_().getProperty('lenz:rec:doc-1:t.0'));
    });
    w.state.props.set('lenz:applied:x', '{"edits":[]}'); // another window applies after the lock is free
    assert.equal(w.ctx.lenzUserProps_().getProperty('lenz:applied:x'), '{"edits":[]}');
  });
});

// ── the trial log leaves the click (v19) ────────────────────────────

function applyAldrin(w) {
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  return w.ctx.lenzApply(RID, 1, 0);
}

test('trial: a click opens no Doc; its lines wait, and the next poll writes them in order', () => {
  const w = started();
  pollToEnd(w); // review_done and the first placement: written by that poll
  const opens = w.state.docOpens || 0;
  const written = w.state.logDocs.flatMap((d) => d.lines).length;
  assert.equal(applyAldrin(w).ok, true);
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', 0).ok, true);
  assert.equal(w.state.docOpens || 0, opens);
  assert.equal(w.state.logDocs.flatMap((d) => d.lines).length, written);
  const keys = [...w.state.props.keys()].filter((k) => k.startsWith('lenz:trialPending:')).sort();
  assert.equal(keys.length, 1); // the Apply's lines (a Select logs none)
  const pending = keys.flatMap((k) => JSON.parse(w.state.props.get(k)));
  assert.ok(pending.some((l) => JSON.parse(l).event === 'applied'));
  w.ctx.lenzPoll();
  assert.equal([...w.state.props.keys()].filter((k) => k.startsWith('lenz:trialPending:')).length, 0);
  const lines = w.state.logDocs.flatMap((d) => d.lines).slice(written).map((l) => JSON.parse(l).event);
  assert.ok(lines.indexOf('applied') >= 0);
  assert.deepEqual(lines.slice(0, pending.length), pending.map((l) => JSON.parse(l).event)); // in click order
});

test('trial: past 8 waiting clicks the click writes them itself', () => {
  const w = started();
  pollToEnd(w);
  for (let i = 0; i < 7; i++) w.state.props.set('lenz:trialPending:00000000000000' + i + '-1', JSON.stringify([JSON.stringify({ v: 1, event: 'placed', finding: 'x' + i })]));
  assert.equal(applyAldrin(w).ok, true);
  assert.equal([...w.state.props.keys()].filter((k) => k.startsWith('lenz:trialPending:')).length, 0);
  assert.ok(w.state.logDocs.flatMap((d) => d.lines).some((l) => JSON.parse(l).event === 'applied'));
});

test('trial: a Doc that cannot be written keeps the lines waiting (bounded), and never fails the call', () => {
  const w = started();
  pollToEnd(w);
  assert.equal(applyAldrin(w).ok, true);
  w.state.logDocFails = true;
  const p = w.ctx.lenzPoll();
  assert.equal(p.phase, 'done');
  const keys = [...w.state.props.keys()].filter((k) => k.startsWith('lenz:trialPending:'));
  const kept = keys.flatMap((k) => JSON.parse(w.state.props.get(k)));
  assert.ok(kept.some((l) => JSON.parse(l).event === 'applied'));
  w.state.logDocFails = false;
  w.ctx.lenzPoll();
  assert.equal([...w.state.props.keys()].filter((k) => k.startsWith('lenz:trialPending:')).length, 0);
});

test('scope: a value written in a call is read back in it before the putAll', () => {
  const w = world();
  w.ctx.lenzScoped_(() => {
    w.ctx.lenzCachePut_('lenz:open:x', '{"phase":"done"}', 100);
    assert.equal(w.cache.m.has('lenz:open:x'), false); // not yet written
    assert.equal(w.ctx.lenzCacheGet_('lenz:open:x'), '{"phase":"done"}');
  });
  assert.equal(w.ctx.lenzChunkedCache_(w.cache).get('lenz:open:x'), '{"phase":"done"}');
});

test('trial: two windows: a click during a drain keeps its lines (each under its own key)', () => {
  const w = started();
  pollToEnd(w);
  assert.equal(applyAldrin(w).ok, true); // window A leaves lines waiting
  // Window B clicks while A's poll is writing the Doc: its key is not among those the drain read.
  const realBatch = w.ctx.Docs.Documents.batchUpdate;
  let injected = false;
  w.ctx.Docs.Documents.batchUpdate = function (req, id) {
    if (!injected && id !== 'doc-1') {
      injected = true;
      w.state.props.set('lenz:trialPending:999999999999999-2', JSON.stringify([JSON.stringify({ v: 1, event: 'undone', finding: 'edit:1.0' })]));
    }
    return realBatch.call(this, req, id);
  };
  w.ctx.lenzPoll();
  assert.ok(w.state.props.has('lenz:trialPending:999999999999999-2'));
  w.ctx.lenzPoll();
  assert.ok(w.state.logDocs.flatMap((d) => d.lines).some((l) => JSON.parse(l).event === 'undone'));
});

test('trial: opening the log writes what clicks left waiting first', () => {
  const w = started();
  pollToEnd(w);
  assert.equal(applyAldrin(w).ok, true);
  w.ctx.lenzDevTrialLog();
  assert.ok(w.state.logDocs.flatMap((d) => d.lines).some((l) => JSON.parse(l).event === 'applied'));
  assert.equal([...w.state.props.keys()].filter((k) => k.startsWith('lenz:trialPending:')).length, 0);
});

test('trial: a big batch is split under the 9 KB a property holds, in order, and nothing is lost', () => {
  const w = started();
  pollToEnd(w);
  const lines = Array.from({ length: 80 }, (_, i) => JSON.stringify({ v: 1, ts: '2026-10-01T00:00:00.000Z', doc: 'abcdefabcdef', review: RID, event: 'placed', finding: 'claim:' + i + '@0', kind: 'claim', n: 'x'.repeat(60) }));
  w.ctx.lenzScoped_(() => {
    w.ctx.LENZ_TRIAL_BUFFER.push(...lines);
    w.ctx.lenzTrialStash_();
  });
  const keys = [...w.state.props.keys()].filter((k) => k.startsWith('lenz:trialPending:')).sort();
  assert.ok(keys.length >= 2, 'split into ' + keys.length);
  keys.forEach((k) => assert.ok(Buffer.byteLength(w.state.props.get(k)) <= 8000));
  assert.deepEqual(keys.flatMap((k) => JSON.parse(w.state.props.get(k))), lines);
  w.ctx.lenzPoll();
  const written = w.state.logDocs.flatMap((d) => d.lines);
  const at = written.indexOf(lines[0]);
  assert.ok(at >= 0);
  assert.deepEqual(written.slice(at, at + 80), lines); // all of them, in order (the poll's own lines follow)
});

// ── quick-first suggested edits: the glue (content identity) ────────

const Q_EDIT = { position: 0, start: 563, end: 574, text: 'Buzz Aldrin', replacement: 'Neil Armstrong' };
const REVIEW = POLLS[POLLS.length - 1]; // the completed body
const FP = (e) => w0fp(e);
function w0fp(e) { return world().ctx.LenzView.editFp(e.start, e.end, e.text, e.replacement); }

// The row's block: quick edits first (deep check running: POLLS[0]), then the deep result (REVIEW).
function bodyWith(block, base, running) {
  const b = JSON.parse(JSON.stringify(base || POLLS[0]));
  if (running) b.status = 'verifying';
  b.claims.find((c) => c.index === 1).suggested_edits = block;
  return b;
}
function show(w, body) {
  w.state.polls = [body];
  return w.ctx.lenzPoll();
}
function swapTo(w, from, to) {
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace(from, to);
    w.state.rev = w.state.rev + '+w';
  };
}

test('quick first: apply the quick edit; the deep block\'s identical edit reads applied; Undo through it', () => {
  const w = started();
  show(w, bodyWith({ status: 'completed', edits: [Q_EDIT] }));
  swapTo(w, 'Buzz Aldrin', 'Neil Armstrong');
  let r = w.ctx.lenzApply(RID, 1, 0, FP(Q_EDIT));
  assert.equal(r.ok, true, r.message);
  // Deep check ended, quick edits still shown (no gap), then the deep result with the same edit at index 1.
  const july = { position: 0, start: 580, end: 589, text: 'July 1969', replacement: '20 July 1969' };
  show(w, bodyWith({ status: 'completed', edits: [Q_EDIT] }, REVIEW, true));
  r = show(w, bodyWith({ status: 'completed', edits: [july, Q_EDIT] }, REVIEW));
  const e = entry(r.model, 'claim:1');
  assert.deepEqual(plain(e.edits.map((x) => [x.editIndex, x.mode])), [[0, 'apply'], [1, 'applied']]);
  assert.equal(w.ctx.lenzApply(RID, 1, 1, FP(Q_EDIT)).message, 'This edit is already in the Doc.');
  swapTo(w, 'Neil Armstrong', 'Buzz Aldrin');
  const u = e.edits[1].undo;
  const undone = w.ctx.lenzUndo(RID, u.claimIndex, u.editIndex, u.fp);
  assert.equal(undone.ok, true, undone.message);
  assert.ok(w.state.text.includes('Buzz Aldrin'));
});

test('quick first: a click on an edit the block has since replaced applies nothing', () => {
  const w = started();
  show(w, bodyWith({ status: 'completed', edits: [Q_EDIT] })); // the user sees this one...
  const deep = Object.assign({}, Q_EDIT, { replacement: 'Neil A. Armstrong' });
  w.state.polls = [bodyWith({ status: 'completed', edits: [deep] }, REVIEW)]; // ...the review now says this
  const batches = w.state.batches.length;
  const r = w.ctx.lenzApply(RID, 1, 0, FP(Q_EDIT));
  assert.equal(r.ok, false);
  assert.equal(r.message, 'This suggestion changed. Use the one shown now.');
  assert.equal(w.state.batches.length, batches);
});

test('quick first: a different deep edit on words the quick Apply changed is never applied blind; Undo, then Apply', () => {
  const w = started();
  show(w, bodyWith({ status: 'completed', edits: [Q_EDIT] }));
  swapTo(w, 'Buzz Aldrin', 'Neil Armstrong');
  assert.equal(w.ctx.lenzApply(RID, 1, 0, FP(Q_EDIT)).ok, true);
  const deep = Object.assign({}, Q_EDIT, { replacement: 'Neil A. Armstrong' });
  const r = show(w, bodyWith({ status: 'completed', edits: [deep] }, REVIEW));
  const e = entry(r.model, 'claim:1');
  assert.deepEqual(plain(e.edits.map((x) => [x.mode, !!x.earlier])), [['suggest', false], ['applied', true]]);
  const batches = w.state.batches.length;
  assert.equal(w.ctx.lenzApply(RID, 1, 0, FP(deep)).ok, false);
  assert.equal(w.state.batches.length, batches);
  swapTo(w, 'Neil Armstrong', 'Buzz Aldrin');
  const u = e.edits[1].undo;
  assert.equal(w.ctx.lenzUndo(RID, u.claimIndex, u.editIndex, u.fp).ok, true);
  swapTo(w, 'Buzz Aldrin', 'Neil A. Armstrong');
  assert.equal(w.ctx.lenzApply(RID, 1, 0, FP(deep)).ok, true);
  assert.ok(w.state.text.includes('Neil A. Armstrong'));
});

test('quick first: the deep check withdrew the edit (null): the applied one is still undone by its fingerprint', () => {
  const w = started();
  show(w, bodyWith({ status: 'completed', edits: [Q_EDIT] }));
  swapTo(w, 'Buzz Aldrin', 'Neil Armstrong');
  assert.equal(w.ctx.lenzApply(RID, 1, 0, FP(Q_EDIT)).ok, true);
  const r = show(w, bodyWith(null, REVIEW));
  const x = entry(r.model, 'claim:1').edits[0];
  assert.equal(x.earlier, true);
  swapTo(w, 'Neil Armstrong', 'Buzz Aldrin');
  assert.equal(w.ctx.lenzUndo(RID, 1, -1, x.undo.fp).ok, true);
  assert.equal(w.ctx.lenzUndo(RID, 1, -1, 'nonsense').ok, false);
});

test('quick first: Undo without a snapshot refuses rather than use another edit at the index', () => {
  const w = started();
  show(w, bodyWith({ status: 'completed', edits: [Q_EDIT] }));
  swapTo(w, 'Buzz Aldrin', 'Neil Armstrong');
  assert.equal(w.ctx.lenzApply(RID, 1, 0, FP(Q_EDIT)).ok, true);
  const other = { position: 0, start: 580, end: 589, text: 'July 1969', replacement: '20 July 1969' };
  show(w, bodyWith({ status: 'completed', edits: [other] }, REVIEW));
  for (const k of [...w.cache.m.keys()]) if (k.startsWith('lenz:snap:')) w.cache.m.delete(k);
  const batches = w.state.batches.length;
  assert.equal(w.ctx.lenzUndo(RID, 1, 0, FP(Q_EDIT)).ok, false);
  assert.equal(w.state.batches.length, batches);
});

test('quick first: undoing an earlier edit keeps the later records whole', () => {
  const w = world();
  const a = { id: '1:a', claimIndex: 1, orig: { start: 10, end: 14 }, origText: 'abcd', replacement: 'x', position: 0, passage: { start: 0, end: 40 }, start: 10, end: 14, text: 'abcd' };
  const b = { id: '1:b', claimIndex: 1, orig: { start: 30, end: 34 }, origText: 'wxyz', replacement: 'q', position: 0, passage: { start: 0, end: 40 }, start: 27, end: 31, text: 'wxyz' };
  assert.deepEqual(plain(w.ctx.lenzWithoutApplied_([a, b], 0)), [Object.assign({}, b, { start: 30, end: 34 })]);
});

test('an older sidebar (no fingerprint) still applies and undoes by index', () => {
  const w = started();
  pollToEnd(w);
  swapTo(w, 'Buzz Aldrin', 'Neil Armstrong');
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, true);
  swapTo(w, 'Neil Armstrong', 'Buzz Aldrin');
  assert.equal(w.ctx.lenzUndo(RID, 1, 0, FP(Q_EDIT)).ok, true);
});

// ── the two builds (scripts/build.sh) ───────────────────────────────

const { build } = require('../scripts/build.js');
const loadFlavour = flavourConfig;
// Whatever config/flavours/public.json holds: the placeholder today, the real client id later.
const PUBLIC_CLIENT_ID = loadFlavour('public').oauthClientId;
const os = require('node:os');

// A build in a scratch directory, loaded the way Apps Script may order it: by name (Code.js before
// config.js), so nothing in Code.js may read the flavour's settings while the files load.
function built(flavour, opts) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'lenz-build-' + flavour + '-'));
  build(flavour, { out, allowPlaceholder: flavour === 'public', flavourFile: flavourFile(flavour) });
  const files = fs.readdirSync(out).filter((f) => f.endsWith('.js')).sort();
  return world(Object.assign({ dir: out, files }, opts || {}));
}
const pub = (opts) => built('public', Object.assign({ oauth: true, clientId: PUBLIC_CLIENT_ID }, opts || {}));

test('internal build: the menu is today\'s, Dev tools with its five items and the Spike kit', () => {
  const w = built('internal');
  w.ctx.onOpen({});
  assert.deepEqual(plain(w.state.menus[0].items), [
    ['Check this Doc', 'lenzShowSidebar'],
    { title: 'Dev tools', items: [
      ["Dump this tab's JSON", 'lenzDevDump'],
      ['The last selection hit the wrong words', 'lenzDevWrongSelect'],
      ['The last Apply hit the wrong words', 'lenzDevWrongApply'],
      ['Open the trial log', 'lenzDevTrialLog'],
      ['Use an API key…', 'lenzDevUseKey'],
      { title: 'Spike', items: [['Select text…', 'lenzDev_menuSelect'], ['Check this spike Doc', 'lenzDev_menuCheck']] },
    ] },
  ]);
  assert.equal(typeof w.ctx.lenzSaveKey, 'function');
  assert.equal(w.ctx.LENZ_TRIAL_LOG, true);
});

test('public build: one menu item, no Dev tools, no dev function anywhere in the global scope', () => {
  const w = pub();
  w.ctx.onOpen({});
  assert.deepEqual(plain(w.state.menus[0].items), [['Check this Doc', 'lenzShowSidebar']]);
  const dev = Object.keys(w.ctx).filter((k) => /^lenzDev|^lenzSaveKey$|^lenzKeyLooksRight_$|^LENZ_KEY/.test(k));
  assert.deepEqual(dev, []);
  assert.equal(typeof w.ctx.LenzSpike, 'undefined');
  assert.equal(w.ctx.LENZ_FLAVOUR, 'public');
  assert.equal(w.ctx.LENZ_TRIAL_LOG, false);
});

test('public build: a key left in User properties is never used; only the Lenz sign-in works', () => {
  const w = pub();
  w.state.props.set('lenz:apiKey', KEY);
  w.state.props.set('lenz:apiKeySource', 'dev');
  const st = w.ctx.lenzState();
  assert.equal(st.phase, 'signed_out');
  assert.deepEqual(plain(st.auth), { mode: 'oauth', signedIn: false });
  assert.equal(w.ctx.lenzStart().phase, 'signed_out');
  assert.equal(w.state.fetches.length, 0);
  signIn(w);
  assert.equal(w.ctx.lenzStart().phase, 'running');
  const posts = w.state.fetches.filter((f) => f.url === 'https://lenz.io/api/v1/review');
  assert.equal(posts.length, 1);
  assert.match(posts[0].o.headers.Authorization, /^Bearer lat_/);
});

test('public build: the sign-in names the client id from config/flavours/public.json', () => {
  const w = pub();
  const q = new URL(w.ctx.lenzSignInUrl().url).searchParams;
  assert.equal(q.get('client_id'), PUBLIC_CLIENT_ID);
  assert.notEqual(PUBLIC_CLIENT_ID, loadFlavour('internal').oauthClientId, 'each flavour has its own client');
  assert.equal(q.get('redirect_uri'), REDIRECT);
});

test('public build: no trial log; Check, poll, Select, Apply and Undo open no Doc and keep no trial state', () => {
  const w = pub();
  signIn(w);
  assert.equal(w.ctx.lenzStart().phase, 'running');
  assert.equal(pollToEnd(w).phase, 'done');
  assert.equal(w.ctx.lenzSelect(RID, 'claim:1', 0).ok, true);
  swapTo(w, 'Buzz Aldrin', 'Neil Armstrong');
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, true);
  swapTo(w, 'Neil Armstrong', 'Buzz Aldrin');
  assert.equal(w.ctx.lenzUndo(RID, 1, 0, FP(Q_EDIT)).ok, true);
  w.ctx.lenzState();
  assert.equal(w.state.logDocs.length, 0, 'no trial log Doc created');
  assert.equal(w.state.docOpens || 0, 0, 'no Doc created or opened by id');
  const trialKeys = [...w.state.props.keys()].filter((k) => /^lenz:(trialPending|trialDone|trialLogDoc|last)/.test(k));
  assert.deepEqual(trialKeys, []);
  assert.equal(w.state.logs.filter((l) => l.startsWith('lenz_trial ')).length, 0);
});

test('internal build: the same session writes the trial log (the switch is the flavour, not the code)', () => {
  const w = built('internal');
  w.ctx.lenzSaveKey(KEY);
  w.ctx.lenzStart();
  pollToEnd(w);
  assert.ok(w.state.logDocs.length > 0);
  assert.ok([...w.state.props.keys()].some((k) => k.startsWith('lenz:trialDone:')));
});

// ── signing out removes everything the add-on stored (privacy policy, /privacy#google-docs) ──

// Every lenz: key but the session generation, which sign-out writes on purpose (a time and a random
// tag, no user data): calls that began before the sign-out compare it before writing.
const lenzProps = (w) => [...w.state.props.keys()].filter((k) => k.startsWith('lenz:') && k !== 'lenz:gen');
const cacheKeys = (w, prefix) => [...w.cache.m.keys()].filter((k) => k.startsWith(prefix));

function signedInWithAnApply() {
  const w = world({ oauth: true });
  signIn(w);
  assert.equal(w.ctx.lenzStart().phase, 'running');
  pollToEnd(w);
  w.state.onBatch = () => {
    w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
    w.state.rev = 'rev-2';
  };
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, true);
  return w;
}

test('sign-out deletes every lenz: user property: tokens, applied edits, records, trial lines', () => {
  const w = signedInWithAnApply();
  const before = lenzProps(w);
  for (const p of ['lenz:oauth:tokens', 'lenz:applied:' + RID]) assert.ok(before.includes(p), p);
  assert.ok(before.some((k) => k.startsWith('lenz:rec:')), 'a check record');
  w.state.props.set('lenz:trialPending:1', '["x"]'); // trial lines still waiting
  const r = w.ctx.lenzSignOut();
  assert.equal(r.phase, 'signed_out');
  assert.deepEqual(lenzProps(w), []);
  assert.equal(trialEvents(w).filter((e) => e.event === 'signed_out').length, 1, 'logged before the wipe');
});

test('sign-out removes the cached text and results it can name; the rest expires within 6 h', () => {
  const w = signedInWithAnApply();
  for (const p of ['lenz:body:', 'lenz:snap:', 'lenz:done:', 'lenz:open:']) {
    assert.ok(cacheKeys(w, p).length, 'cached before: ' + p);
  }
  w.ctx.lenzSignOut();
  for (const p of ['lenz:body:', 'lenz:snap:', 'lenz:done:', 'lenz:open:']) assert.deepEqual(cacheKeys(w, p), [], p);
});

test('a sign-in after a sign-out starts clean: no earlier check, no applied edits', () => {
  const w = signedInWithAnApply();
  w.ctx.lenzSignOut();
  signIn(w);
  // The new sign-in's own keys, and (dev builds only: the public build has no trial log) the trial
  // log's id, written when the sign-in is logged.
  assert.deepEqual(lenzProps(w).filter((k) => !k.startsWith('lenz:oauth:') && k !== 'lenz:trialLogDoc'), []);
  const r = w.ctx.lenzState();
  assert.notEqual(r.phase, 'done');
  assert.equal(r.model, null);
});

test('sign-out deletes locally even when Lenz cannot be reached to revoke', () => {
  const w = signedInWithAnApply();
  w.state.down = true;
  const r = w.ctx.lenzSignOut();
  assert.equal(r.phase, 'signed_out');
  assert.deepEqual(lenzProps(w), []);
});

test('sign-out deletes the dev key and its marker too', () => {
  const w = started();
  assert.ok(lenzProps(w).includes('lenz:apiKey'));
  w.ctx.lenzSignOut();
  assert.deepEqual(lenzProps(w), []);
});

test('a busy sign-out deletes nothing (the next one does)', () => {
  const w = signedInWithAnApply();
  const noTrial = (keys) => keys.filter((k) => !k.startsWith('lenz:trialPending:'));
  const before = lenzProps(w);
  w.state.lockFree = false;
  assert.equal(w.ctx.lenzSignOut().phase, 'error');
  // Only the trial line it logged waits (the drain needs the lock too); nothing else changed.
  assert.deepEqual(noTrial(lenzProps(w)), noTrial(before));
  for (const k of before) assert.ok(w.state.props.has(k), 'kept: ' + k);
  w.state.lockFree = true;
  w.ctx.lenzSignOut();
  assert.deepEqual(lenzProps(w), []);
});

test('a throwing revoke still signs out and deletes locally', () => {
  const w = signedInWithAnApply();
  w.ctx.lenzOAuth_ = () => ({ signedIn: () => true, signOut() { throw new Error('boom'); } });
  assert.equal(w.ctx.lenzSignOut().phase, 'signed_out');
  assert.deepEqual(lenzProps(w), []);
});

test('a poll in flight at sign-out cannot bring the old check back on the next sign-in', () => {
  const w = signedInWithAnApply();
  const late = w.ctx.lenzState(); // what a poll that started before the sign-out will remember
  assert.equal(late.phase, 'done');
  w.ctx.lenzSignOut();
  w.ctx.lenzRemember_(w.ctx.lenzContext_(), late); // ...written after the wipe
  signIn(w);
  const open = w.ctx.lenzOpen();
  assert.equal(open.phase, 'idle');
  assert.equal(open.model, null);
});

test('...nor after a new check has started, and a late poll puts no property back', () => {
  const w = signedInWithAnApply();
  const late = w.ctx.lenzState();
  w.ctx.lenzSignOut();
  signIn(w);
  w.state.polls = POLLS.slice();
  assert.equal(w.ctx.lenzStart().phase, 'running');
  // The fake Lenz gives every check the fixture's id: make the new check's id its own.
  const recKey = [...w.state.props.keys()].find((k) => k.startsWith('lenz:rec:'));
  w.state.props.set(recKey, JSON.stringify(Object.assign(JSON.parse(w.state.props.get(recKey)), { reviewId: 'feedface' })));
  w.ctx.lenzRemember_(w.ctx.lenzContext_(), late); // the old reply, written after the new start
  const open = w.ctx.lenzOpen();
  assert.notEqual(open.reviewId, late.reviewId);
  assert.equal(open.model, null);
  // The late poll's own property writes ask first.
  w.ctx.lenzMarkIncomplete_(w.ctx.lenzContext_(), late.reviewId);
  assert.equal(w.ctx.lenzTrialFirst_(w.ctx.lenzContext_(), late.reviewId), false);
  assert.equal(w.state.props.has('lenz:incomplete:' + late.reviewId), false);
  assert.equal(w.state.props.has('lenz:trialDone:' + late.reviewId), false);
});

// ── a call that began before a sign-out writes nothing after it ──

// Runs fn as another Apps Script execution: its own per-execution state (scope, trial buffer, lock
// depth), the same properties, cache and Docs.
function asOtherExecution(w, fn) {
  const saved = { LENZ_SCOPE: w.ctx.LENZ_SCOPE, LENZ_TRIAL_BUFFER: w.ctx.LENZ_TRIAL_BUFFER, LENZ_LOCK_DEPTH: w.ctx.LENZ_LOCK_DEPTH };
  w.ctx.LENZ_SCOPE = null;
  w.ctx.LENZ_TRIAL_BUFFER = [];
  w.ctx.LENZ_LOCK_DEPTH = 0;
  try {
    return fn();
  } finally {
    Object.assign(w.ctx, saved);
  }
}

test('a Check queued behind a sign-out writes nothing: no record, no meta, no cached text, no POST', () => {
  const w = world({ oauth: true });
  signIn(w);
  w.state.beforeLock = () => asOtherExecution(w, () => w.ctx.lenzSignOut()); // after the Check's first look, before its lock
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'signed_out');
  assert.equal(w.state.fetches.filter((f) => f.url === 'https://lenz.io/api/v1/review').length, 0);
  assert.deepEqual(lenzProps(w), []);
  assert.deepEqual(cacheKeys(w, 'lenz:'), []);
});

test('...with the dev key too: the key deleted by the sign-out is not used to submit', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  w.state.beforeLock = () => asOtherExecution(w, () => w.ctx.lenzSignOut());
  assert.equal(w.ctx.lenzStart().phase, 'signed_out');
  assert.equal(w.state.fetches.filter((f) => f.url === 'https://lenz.io/api/v1/review').length, 0);
  assert.deepEqual(lenzProps(w), []);
});

test('a poll past its lock when the user signs out puts nothing back (internal build, trial log on)', () => {
  const w = built('internal', { oauth: true });
  signIn(w);
  assert.equal(w.ctx.lenzStart().phase, 'running');
  for (let i = 0; i < 10; i++) {
    if (w.state.polls.length === 1) break; // the next poll completes, and places the findings
    w.ctx.lenzPoll();
  }
  assert.equal(w.state.polls.length, 1);
  // The completing poll has its GET under the lock; the sign-out lands while it reads the Doc after it.
  w.state.onDocsGet = () => asOtherExecution(w, () => w.ctx.lenzSignOut());
  w.ctx.lenzPoll();
  const left = [...w.state.props.keys()].filter((k) => k.startsWith('lenz:') && k !== 'lenz:gen');
  assert.deepEqual(left, [], 'no trialDone, trial log id, trial lines or record put back');
  assert.deepEqual(cacheKeys(w, 'lenz:open:'), []);
});

// ── per-Doc access (drive.file + documents.currentonly, the Google Picker) ──

const propsSnapshot = (w) => JSON.stringify([...w.state.props.entries()].sort());
const openSnapshot = (w) => JSON.stringify(cacheKeys(w, 'lenz:open:').sort().map((k) => [k, w.cache.m.get(k)]));
const trialLogLines = (w) => w.state.logs.filter((l) => l.startsWith('lenz_trial '));

test('access: Check on a Doc Lenz may not read yet asks for access, and nothing happens', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  w.state.noAccess = true;
  const before = propsSnapshot(w);
  const opens = openSnapshot(w);
  const r = w.ctx.lenzStart();
  assert.equal(r.phase, 'needs_file_access');
  assert.equal(w.state.fetches.length, 0, 'nothing sent to Lenz');
  assert.equal(propsSnapshot(w), before, 'no record, no trial line, no metadata');
  assert.equal(openSnapshot(w), opens, 'not kept for the next open');
  assert.deepEqual(trialLogLines(w), []);
  assert.equal(w.state.logDocs.length, 0);
});

test('access: a failed check left as it was until the Doc can be read (the record moves only after the read)', () => {
  const w = started();
  pollToEnd(w);
  const recKey = [...w.state.props.keys()].find((k) => k.startsWith('lenz:rec:'));
  w.state.props.set(recKey, JSON.stringify(Object.assign(JSON.parse(w.state.props.get(recKey)), { state: 'failed' })));
  w.state.noAccess = true;
  const before = w.state.props.get(recKey);
  assert.equal(w.ctx.lenzStart().phase, 'needs_file_access');
  assert.equal(w.state.props.get(recKey), before);
});

test('access: granted, the same Check goes out', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  w.state.noAccess = true;
  assert.equal(w.ctx.lenzStart().phase, 'needs_file_access');
  w.state.noAccess = false; // the user picked this Doc in the Picker
  assert.equal(w.ctx.lenzStart().phase, 'running');
  assert.equal(pollToEnd(w).phase, 'done');
});

test('access: a poll that must place a finished review asks for access, with no trial line; granted, it places', () => {
  const w = started();
  w.state.polls = [POLLS[POLLS.length - 1]]; // the next poll finds the review finished
  w.state.noAccess = true;
  const opens = openSnapshot(w);
  const r = w.ctx.lenzPoll();
  assert.equal(r.phase, 'needs_file_access');
  assert.deepEqual(trialLogLines(w).filter((l) => /review_done|"placed"/.test(l)), []);
  assert.equal(openSnapshot(w), opens, 'the reply kept for the next open is the one before');
  w.state.noAccess = false;
  const done = w.ctx.lenzState();
  assert.equal(done.phase, 'done');
  assert.ok(done.model.groups.flatMap((g) => g.entries).every((e) => e.placed));
});

test('access: Select, Apply and Undo ask for access and write nothing', () => {
  const w = started();
  pollToEnd(w);
  swapTo(w, 'Buzz Aldrin', 'Neil Armstrong');
  assert.equal(w.ctx.lenzApply(RID, 1, 0).ok, true);
  w.state.onBatch = null;
  const batches = w.state.batches.length;
  w.state.noAccess = true;
  const before = propsSnapshot(w);
  const logs = trialLogLines(w).length;
  const sel = w.ctx.lenzSelect(RID, 'claim:1', 0);
  assert.equal(sel.phase, 'needs_file_access');
  assert.equal(sel.ok, false);
  assert.equal(w.ctx.lenzUndo(RID, 1, 0, FP(Q_EDIT)).phase, 'needs_file_access');
  assert.equal(w.state.batches.length, batches);
  assert.equal(w.state.selections.length, 0);
  assert.equal(propsSnapshot(w), before);
  assert.equal(trialLogLines(w).length, logs);
});

test('access: a refused write with the grant gone (no read either) asks for access too', () => {
  const w = started();
  pollToEnd(w);
  w.ctx.Docs.Documents.batchUpdate = () => { w.state.noAccess = true; throw noAccessError('batchUpdate'); };
  const r = w.ctx.lenzApply(RID, 1, 0);
  assert.equal(r.phase, 'needs_file_access');
});

test('access: a write refused on a Doc Lenz can read (view-only sharing) says so, never asks to pick it again', () => {
  const w = started();
  pollToEnd(w);
  w.ctx.Docs.Documents.batchUpdate = () => {
    const e = new Error('API call to docs.documents.batchUpdate failed with error: The caller does not have permission');
    e.details = { code: 403 };
    throw e;
  };
  const r = w.ctx.lenzApply(RID, 1, 0);
  assert.notEqual(r.phase, 'needs_file_access');
  assert.equal(r.ok, false);
  assert.match(r.message, /view this Doc but not edit it/);
});

test('access: other Docs API failures are not mistaken for a missing permission', () => {
  const w = world();
  assert.equal(w.ctx.lenzIsNoFileAccess_(noAccessError('get')), true);
  const denied = new Error('API call to docs.documents.get failed with error: The caller does not have permission');
  denied.details = { code: 403 };
  assert.equal(w.ctx.lenzIsNoFileAccess_(denied), true);
  assert.equal(w.ctx.lenzIsNoFileAccess_(new Error('Invalid requests: The required revision ID does not match the latest revision.')), false);
  assert.equal(w.ctx.lenzIsNoFileAccess_(new Error('Service unavailable')), false);
});

test('access: lenzPickerConfig gives the script\'s token, the flavour\'s Picker key and project number, and the open Doc', () => {
  const internal = plain(world().ctx.lenzPickerConfig());
  assert.deepEqual(internal, { token: 'ya29.script-token', apiKey: loadFlavour('internal').pickerApiKey,
    appId: loadFlavour('internal').pickerAppId, docId: 'doc-1' });
  assert.equal(internal.appId, '123456789012');
  const p = plain(pub().ctx.lenzPickerConfig());
  assert.deepEqual(p, { token: 'ya29.script-token', apiKey: 'AIzaSyD_OTaf-O5azXegvQtV2V_fi0x6pifGBy0', appId: '465409082149', docId: 'doc-1' });
});

test('access: lenzShowPicker opens picker.html as a modal dialog and returns the server\'s clock', () => {
  const w = world();
  const o = w.ctx.lenzShowPicker();
  assert.equal(typeof o.openedAt, 'number');
  assert.deepEqual(w.state.dialogs, [{ file: 'picker', width: 760, height: 520, title: 'Allow Lenz to read this Doc' }]);
});

test('access: a pick of another Doc is refused; a pick Google has not passed on yet is not marked; then ready', () => {
  const w = world();
  const { openedAt } = w.ctx.lenzShowPicker();
  let r = plain(w.ctx.lenzFileAccessGranted('some-other-doc'));
  assert.deepEqual(r, { ok: false, message: 'That is a different Doc. Choose the Doc you have open.' });
  assert.equal(plain(w.ctx.lenzFileAccessGranted({ id: 'doc-1' })).ok, false);
  w.state.noAccess = true;
  r = plain(w.ctx.lenzFileAccessGranted('doc-1'));
  assert.equal(r.ok, false);
  assert.match(r.message, /not passed your permission on yet/);
  assert.equal(w.state.props.has('lenz:fileok:doc-1'), false);
  assert.equal(w.ctx.lenzFileAccessReady(openedAt).ready, false);
  w.state.noAccess = false;
  assert.deepEqual(plain(w.ctx.lenzFileAccessGranted('doc-1')), { ok: true, message: null });
  assert.equal(w.ctx.lenzFileAccessReady(openedAt).ready, true);
  assert.equal(w.ctx.lenzFileAccessReady(Date.now() + 60000).ready, false, 'an earlier grant does not end a later wait');
});

test('access: the public build asks for access the same way and signs in with OAuth only', () => {
  const w = pub();
  signIn(w);
  w.state.noAccess = true;
  assert.equal(w.ctx.lenzStart().phase, 'needs_file_access');
  assert.equal(w.state.fetches.filter((f) => f.url === 'https://lenz.io/api/v1/review').length, 0);
  w.state.noAccess = false;
  assert.equal(w.ctx.lenzStart().phase, 'running');
});

test('access: sign-out also forgets the access marks (Google keeps the grants)', () => {
  const w = world();
  w.ctx.lenzFileAccessGranted('doc-1');
  assert.ok(w.state.props.has('lenz:fileok:doc-1'));
  w.ctx.lenzSignOut();
  assert.equal(w.state.props.has('lenz:fileok:doc-1'), false);
});

// ── Docs the add-on creates (drive.file covers them, no Picker) ─────

test('app Docs: the trial log is created and written through REST, never DocumentApp', () => {
  const w = started();
  pollToEnd(w);
  assert.equal(w.state.logDocs.length, 1);
  assert.equal(w.state.logDocs[0].name, 'lenz-gdocs trial log');
  assert.equal(w.state.props.get('lenz:trialLogDoc'), w.state.logDocs[0].id);
  assert.ok(w.state.logDocs[0].lines.some((l) => JSON.parse(l).event === 'review_done'));
  // Written by insertText at the end of the body: never a batch on the user's Doc.
  assert.equal(w.state.batches.length, 0);
});

test('app Docs: a trial log the script cannot open (made before per-Doc access) is replaced once', () => {
  const w = started();
  w.state.props.set('lenz:trialLogDoc', 'old-documentapp-log');
  pollToEnd(w);
  assert.equal(w.state.logDocs.length, 1);
  assert.equal(w.state.props.get('lenz:trialLogDoc'), w.state.logDocs[0].id);
  assert.ok(w.state.logDocs[0].lines.length > 0);
});

test('app Docs: the trial log and its Dev tools link work while the open Doc is not allowed yet', () => {
  const w = started();
  w.state.noAccess = true;
  const url = w.ctx.lenzDevTrialLog();
  assert.match(url, /^https:\/\/docs\.google\.com\/document\/d\/app-\d+\/edit$/);
});

test('app Docs: Dev tools → Dump writes the tab\'s JSON into new Docs it creates through REST', () => {
  const w = world();
  w.ctx.Utilities.formatDate = () => '2026-10-04T00:00:00Z';
  w.ctx.Logger = { log() {} };
  const urls = plain(w.ctx.lenzDevDump());
  assert.equal(urls.length, 1);
  const d = w.state.logDocs[0];
  assert.match(d.name, /^lenz-gdocs dump \d{4}-\d\d-\d\dT/);
  assert.equal(urls[0], 'https://docs.google.com/document/d/' + d.id + '/edit');
  assert.equal(JSON.parse(d.lines.join('\n')).documentId, 'doc-1');
});

test('app Docs: lenzDev_e2eCreateDoc makes a spike Doc the script owns; the e2e opens it through REST', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  assert.throws(() => w.ctx.lenzDev_e2eCreateDoc('Quarterly report', 'x'), /must start "Lenz spike"/);
  assert.throws(() => w.ctx.lenzDev_e2eCreateDoc('Lenz spike e2e', '  '), /text to check/);
  const made = plain(w.ctx.lenzDev_e2eCreateDoc('Lenz spike e2e', 'Buzz Aldrin was first.\nWater boils at 100 C.'));
  assert.equal(made.url, 'https://docs.google.com/document/d/' + made.docId + '/edit');
  assert.deepEqual(w.state.logDocs[0].lines, ['Buzz Aldrin was first.', 'Water boils at 100 C.']);
  w.state.noAccess = true; // the open Doc's grant does not matter: the script made this one
  const ctx = w.ctx.lenzDev_e2eContext_(made.docId);
  assert.deepEqual([ctx.docId, ctx.tabId, ctx.title, ctx.app], [made.docId, 't.0', 'Lenz spike e2e', null]);
  assert.throws(() => w.ctx.lenzDev_e2eContext_('someone-elses-doc'), /lenz_needs_file_access/);
});

test('app Docs: a transient failure writing the trial log keeps the same log and the lines waiting', () => {
  const w = started();
  pollToEnd(w);
  const id = w.state.props.get('lenz:trialLogDoc');
  assert.equal(applyAldrin(w).ok, true);
  const real = w.ctx.Docs.Documents.batchUpdate;
  w.ctx.Docs.Documents.batchUpdate = (req, docId) => {
    if (docId !== 'doc-1') throw new Error('Service unavailable: quota exceeded');
    return real(req, docId);
  };
  w.ctx.lenzPoll();
  assert.equal(w.state.props.get('lenz:trialLogDoc'), id, 'not replaced');
  assert.equal(w.state.logDocs.length, 1);
  assert.ok([...w.state.props.keys()].some((k) => k.startsWith('lenz:trialPending:')));
  w.ctx.Docs.Documents.batchUpdate = real;
  w.ctx.lenzPoll();
  assert.equal([...w.state.props.keys()].filter((k) => k.startsWith('lenz:trialPending:')).length, 0);
  assert.ok(w.state.logDocs[0].lines.some((l) => JSON.parse(l).event === 'applied'));
});

test('sessions and app Docs: a poll the user signs out during creates and writes no trial log Doc', () => {
  const w = built('internal', { oauth: true });
  signIn(w);
  assert.equal(w.ctx.lenzStart().phase, 'running');
  // No log Doc yet: the first flush after the sign-in would create it.
  for (const k of [...w.state.props.keys()]) if (k === 'lenz:trialLogDoc') w.state.props.delete(k);
  w.state.polls = [POLLS[POLLS.length - 1]];
  // The sign-out flushes its own line first (it may make the log Doc then); the poll, after it, may not.
  let docs = null;
  w.state.onDocsGet = () => asOtherExecution(w, () => { w.ctx.lenzSignOut(); docs = w.state.logDocs.length; });
  w.ctx.lenzPoll();
  assert.equal(w.state.logDocs.length, docs, 'no trial log Doc made after the sign-out');
  assert.equal(w.state.props.has('lenz:trialLogDoc'), false);
});

test('sessions and access: a Check that cannot read the Doc writes nothing, whatever the session', () => {
  const w = world({ oauth: true });
  signIn(w);
  w.state.noAccess = true;
  const before = JSON.stringify([...w.state.props.entries()].sort());
  assert.equal(w.ctx.lenzStart().phase, 'needs_file_access');
  assert.equal(JSON.stringify([...w.state.props.entries()].sort()), before);
});

// ── opening on a Doc not allowed yet, and the check after the grant ──

const reviewPosts = (w) => w.state.fetches.filter((f) => f.url === 'https://lenz.io/api/v1/review' && f.o.method === 'post').length;

test('open: on a Doc Lenz may not read yet, the opening state asks for access at once and writes nothing', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  w.state.noAccess = true;
  const before = JSON.stringify([...w.state.props.entries()].sort());
  const r = w.ctx.lenzOpenState();
  assert.equal(r.phase, 'needs_file_access');
  assert.equal(w.state.fetches.length, 0);
  assert.equal(JSON.stringify([...w.state.props.entries()].sort()), before);
});

test('open: on an allowed Doc with no check yet, idle after one revision probe and no full read', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  const heads = w.state.heads;
  const r = w.ctx.lenzOpenState();
  assert.equal(r.phase, 'idle');
  assert.equal(w.state.heads, heads + 1);
  assert.equal(w.state.gets, 0);
});

test('open: signed out, no Doc probe at all', () => {
  const w = world({ oauth: true });
  w.state.noAccess = true;
  assert.equal(w.ctx.lenzOpenState().phase, 'signed_out');
  assert.equal(w.state.heads + w.state.gets, 0);
});

test('open: a check already running is shown as is', () => {
  const w = started();
  assert.equal(w.ctx.lenzOpenState().phase, 'running');
});

test('auto-start: with no check yet, the grant starts one', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  assert.equal(w.ctx.lenzAutoStart().phase, 'running');
  assert.equal(reviewPosts(w), 1);
});

test('auto-start: a check already running is only refreshed, never started again', () => {
  const w = started();
  const posts = reviewPosts(w);
  const r = w.ctx.lenzAutoStart();
  assert.ok(r.phase === 'running' || r.phase === 'done', r.phase);
  assert.equal(reviewPosts(w), posts);
});

test('auto-start: a completed check of unchanged text shows its results again, no new review, no charge', () => {
  const w = started();
  assert.equal(pollToEnd(w).phase, 'done');
  const posts = reviewPosts(w);
  const r = w.ctx.lenzAutoStart();
  assert.equal(r.phase, 'done');
  assert.equal(r.notice, 'No changes since the last check.');
  assert.equal(reviewPosts(w), posts);
});

test('auto-start: a completed check of text since changed starts a new one (as Check this Doc would)', () => {
  const w = started();
  pollToEnd(w);
  const posts = reviewPosts(w);
  w.state.text = w.state.text.replace('Buzz Aldrin', 'Neil Armstrong');
  w.state.rev = 'rev-2';
  w.state.polls = [POLLS[POLLS.length - 1]]; // the old review, as Lenz still has it: completed
  assert.equal(w.ctx.lenzAutoStart().phase, 'running');
  assert.equal(reviewPosts(w), posts + 1);
});

test('auto-start: on a Doc still not allowed it asks again and sends nothing', () => {
  const w = world();
  w.ctx.lenzSaveKey(KEY);
  w.state.noAccess = true;
  assert.equal(w.ctx.lenzAutoStart().phase, 'needs_file_access');
  assert.equal(reviewPosts(w), 0);
});
