#!/usr/bin/env node
// Live smoke of src/api.js against Lenz's live /review. PAID: two reviews of draft-b (~36 credits each).
// Run by hand, never from npm test:  node scripts/live-smoke.js [--env FILE] [--out DIR]
// docs/live-smoke.md says how. The API key (LENZ_API_KEY) is read from the env file (default: .env at the
// repository root, gitignored) and never printed or saved.
'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LenzApi = require('../src/api.js');

const BASE = 'https://lenz.io/api/v1';
const USER_AGENT = 'lenz-gdocs-smoke/0.1';
const MAX_REVIEWS = 3; // the authorised budget; the scenario creates two
const MAX_POLLS = 60;
const MAX_WAIT_S = 600; // per review
const MISSING_ID = '00000000';

// ── adapters ────────────────────────────────────────────────────────────

// api.js wants a synchronous fetch (UrlFetchApp). Node's fetch is async, so each request runs in a
// child Node process; the request (key included) goes over stdin, never argv.
const CHILD = `
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', async () => {
  const req = JSON.parse(raw);
  try {
    const res = await fetch(req.url, {
      method: req.method.toUpperCase(), headers: req.headers, body: req.payload,
      redirect: 'manual', signal: AbortSignal.timeout(60000),
    });
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    process.stdout.write(JSON.stringify({ code: res.status, headers, text: await res.text() }));
  } catch (e) {
    process.stdout.write(JSON.stringify({ code: 0, headers: {}, text: '' }));
  }
});`;

function childFetch(req) {
  try {
    const out = childProcess.execFileSync(process.execPath, ['-e', CHILD], {
      input: JSON.stringify(req), maxBuffer: 64 * 1024 * 1024, timeout: 90000,
    });
    return JSON.parse(out.toString('utf8'));
  } catch (e) {
    return { code: 0, headers: {}, text: '' };
  }
}

function memoryStore() {
  const m = new Map();
  return {
    map: m,
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)); },
    del: (k) => { m.delete(k); },
  };
}

function memoryCache() {
  const m = new Map();
  return {
    map: m,
    get: (k) => (m.has(k) ? m.get(k) : null),
    put: (k, v) => { m.set(k, String(v)); },
    del: (k) => { m.delete(k); },
  };
}

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function sleepS(s) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, s) * 1000);
}

function readApiKey(envFile) {
  const text = fs.readFileSync(envFile, 'utf8');
  const line = text.split(/\r?\n/).find((l) => /^\s*(export\s+)?LENZ_API_KEY\s*=/.test(l));
  if (!line) throw new Error('LENZ_API_KEY not found in ' + envFile);
  const value = line.replace(/^\s*(export\s+)?LENZ_API_KEY\s*=\s*/, '').trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!/^lenz_[A-Za-z0-9]+$/.test(value)) throw new Error('LENZ_API_KEY in ' + envFile + ' is not a lenz_ key');
  return value;
}

// ── recording ───────────────────────────────────────────────────────────

// Wraps a transport: every exchange is saved (Authorization dropped, the key redacted anywhere),
// and `loseNextReply()` makes the next request go out for real but reach api.js as no answer.
function recorder(transport, outDir, secrets) {
  let n = 0;
  let lose = false;
  const log = [];
  fs.mkdirSync(outDir, { recursive: true });
  function scrub(s) {
    let out = s;
    secrets.forEach((k) => { if (k) out = out.split(k).join('[redacted]'); });
    return out;
  }
  function fetch(req, label) {
    const res = transport(req);
    n += 1;
    const headers = Object.assign({}, req.headers);
    delete headers.Authorization;
    const entry = {
      n, label: label || null, at: new Date().toISOString(),
      request: { method: req.method, url: req.url, headers, body: req.payload ? JSON.parse(req.payload) : null },
      response: { code: res.code, headers: res.headers, body: parseOr(res.text) },
      lostOnPurpose: lose,
    };
    const name = String(n).padStart(2, '0') + '-' + req.method + (label ? '-' + label : '') + '.json';
    fs.writeFileSync(path.join(outDir, name), scrub(JSON.stringify(entry, null, 1)) + '\n');
    log.push(entry);
    if (lose) {
      lose = false;
      return { code: 0, headers: {}, text: '' };
    }
    return res;
  }
  return { fetch, log, loseNextReply: () => { lose = true; } };
}

function parseOr(text) {
  try { return JSON.parse(text); } catch (e) { return text; }
}

// Code points, as the API counts them.
function cpSlice(s, start, end) {
  return Array.from(s).slice(start, end).join('');
}

// ── the scenario ────────────────────────────────────────────────────────

// ctx: { transport(req) -> res (sync), apiKey, text, outDir, sleep(s), log(msg) }
function runScenario(ctx) {
  const results = [];
  const log = ctx.log || (() => {});
  const sleep = ctx.sleep || sleepS;
  const rec = recorder(ctx.transport, ctx.outDir, [ctx.apiKey]);
  let label = null;
  let reviewsStarted = 0;
  const seenReviews = new Set();

  function check(name, ok, detail) {
    results.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
    log((ok ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' ' + JSON.stringify(detail) : ''));
    return !!ok;
  }

  // free: a client whose POSTs cannot start a review (a refused key), outside the budget count.
  function makeClient(apiKey, store, cache, free) {
    return LenzApi.create({
      fetch: (req) => {
        if (req.method === 'post' && !free) {
          const key = req.headers['Idempotency-Key'];
          if (!seenReviews.has(key)) {
            if (reviewsStarted >= MAX_REVIEWS) throw new Error('budget: refusing a review past ' + MAX_REVIEWS);
            seenReviews.add(key);
            reviewsStarted += 1;
          }
        }
        return rec.fetch(req, label);
      },
      store: store || memoryStore(),
      cache: cache || memoryCache(),
      sha256,
      now: () => Date.now(),
      base: BASE,
      apiKey,
      userAgent: USER_AGENT,
    });
  }

  function pollToEnd(client, docId, tabId, firstWaitS, name) {
    let wait = firstWaitS;
    const waits = [];
    let last = null;
    let elapsed = 0;
    for (let i = 0; i < MAX_POLLS && elapsed <= MAX_WAIT_S; i++) {
      waits.push(wait);
      sleep(wait);
      elapsed += wait;
      label = name + '-poll';
      last = client.poll(docId, tabId);
      log('  poll ' + (i + 1) + ': ' + (last.status || (last.error && last.error.code)) + ', next ' + last.nextPollS);
      if (last.terminal) break;
      wait = last.nextPollS;
    }
    return { last, waits };
  }

  // 1. Free: the real key reads a review that does not exist (404), and a bad key is refused (401).
  //    Run first, so a wrong key or an outage costs nothing.
  const probeStore = memoryStore();
  probeStore.set(LenzApi.recordKey('smoke-404', 't.0'), JSON.stringify({
    reviewId: MISSING_ID, key: 'probe', tabId: 't.0', textHash: null, attempt: 0, submittedAt: 0,
    state: 'running', pollFailures: 0,
  }));
  label = 'missing-review';
  const missing = makeClient(ctx.apiKey, probeStore).poll('smoke-404', 't.0');
  const keyWorks = check('GET of an unknown review is 404, terminal, recorded lost',
    missing.error && missing.error.code === 404 && missing.terminal &&
    JSON.parse(probeStore.get(LenzApi.recordKey('smoke-404', 't.0'))).state === 'lost',
    missing.error && { code: missing.error.code, apiCode: missing.error.apiCode, message: missing.error.message });
  if (!keyWorks) {
    check('stopped before any paid call: the key or the API is not answering as expected', false);
    return finish();
  }

  label = 'bad-key';
  const bad = makeClient('lenz_' + '0'.repeat(32), null, null, true)
    .submit({ docId: 'smoke-401', tabId: 't.0', text: 'x' });
  check('a bad key is 401, rejected, not retryable',
    !bad.ok && bad.state === 'rejected' && bad.error.code === 401 && bad.error.retryable === false,
    { code: bad.error && bad.error.code, message: bad.error && bad.error.message });

  // 2. Paid: submit, lose the reply, submit again -> the same review.
  const store = memoryStore();
  const cache = memoryCache();
  const client = makeClient(ctx.apiKey, store, cache);
  const doc = { docId: 'smoke-' + Date.now(), tabId: 't.0' };

  label = 'submit-lost';
  rec.loseNextReply();
  const lost = client.submit(Object.assign({ text: ctx.text }, doc));
  const sent = rec.log[rec.log.length - 1];
  const realId = sent.response.body && sent.response.body.review_id;
  check('the first POST was accepted (202) behind the lost reply', sent.response.code === 202 && !!realId,
    { code: sent.response.code, retryAfter: header(sent.response.headers, 'retry-after') });
  check('api.js saw no answer and kept the submission pending', !lost.ok && lost.state === 'submitting');

  label = 'submit-replay';
  const replay = client.submit(Object.assign({ text: ctx.text + '\n\nEdited after the lost reply.' }, doc));
  const replayEntry = rec.log[rec.log.length - 1];
  check('the replay returned the same review id', replay.ok && replay.reviewId === realId,
    { first: realId, replay: replay.reviewId, code: replayEntry.response.code });
  check('the replay sent the same key and the byte-identical body',
    replayEntry.request.headers['Idempotency-Key'] === sent.request.headers['Idempotency-Key'] &&
    JSON.stringify(replayEntry.request.body) === JSON.stringify(sent.request.body));
  check('the replay kept the first text as the snapshot', client.snapshot(realId) === ctx.text);

  // 3. Poll A to the end on the real waits.
  const a = pollToEnd(client, doc.docId, doc.tabId, replay.nextPollS || 20, 'a');
  check('review A completed', a.last && a.last.status === 'completed',
    { status: a.last && a.last.status, waits: a.waits });
  const bodyA = a.last && a.last.body;
  if (!bodyA || bodyA.status !== 'completed') return finish();

  // 4. The Apollo edits come from the body, and each one's text is the sent slice.
  const apollo = (bodyA.claims || []).filter((c) => /Apollo/.test(c.claim || ''));
  const edits = [];
  apollo.forEach((c) => {
    for (let i = 0; ; i++) {
      const e = client.edit(bodyA, c.index, i);
      if (!e) break;
      edits.push(e);
    }
  });
  check('edit() returns the Apollo edits', edits.length > 0,
    edits.map((e) => ({ text: e.text, replacement: e.replacement, start: e.start, end: e.end })));
  check('every edit\'s text is exactly the sent slice (code points)',
    edits.length > 0 && edits.every((e) => cpSlice(ctx.text, e.start, e.end) === e.text));
  check('every edit lies inside its claim passage',
    edits.length > 0 && edits.every((e) => e.passage && e.passage.start <= e.start && e.end <= e.passage.end &&
      cpSlice(ctx.text, e.passage.start, e.passage.end) === e.passage.text));

  // 5. Run again: a new review of the unchanged text.
  client.runAgain(doc);
  label = 'submit-again';
  const again = client.submit(Object.assign({ text: ctx.text }, doc));
  check('Run again started a NEW review', again.ok && again.reviewId && again.reviewId !== realId,
    { a: realId, b: again.reviewId });
  if (!again.ok) return finish();
  const b = pollToEnd(client, doc.docId, doc.tabId, again.nextPollS || 20, 'b');
  check('review B completed', b.last && b.last.status === 'completed',
    { status: b.last && b.last.status, waits: b.waits });

  // 6. One review behind A: it charged what one review of the same text (B) charged.
  const chargedA = bodyA.credits && bodyA.credits.charged;
  const chargedB = b.last && b.last.body && b.last.body.credits && b.last.body.credits.charged;
  check('review A charged no more than review B (one review behind the lost reply)',
    typeof chargedA === 'number' && typeof chargedB === 'number' && chargedA <= chargedB,
    { chargedA, chargedB });

  return finish();

  function finish() {
    const summary = {
      at: new Date().toISOString(),
      passed: results.every((r) => r.ok),
      reviewsStarted,
      results,
      requests: rec.log.length,
    };
    fs.writeFileSync(path.join(ctx.outDir, 'summary.json'),
      JSON.stringify(summary, null, 1).split(ctx.apiKey).join('[redacted]') + '\n');
    return summary;
  }
}

function header(headers, name) {
  const k = Object.keys(headers || {}).find((h) => h.toLowerCase() === name);
  return k ? headers[k] : null;
}

// ── main ────────────────────────────────────────────────────────────────

function main(argv) {
  const arg = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const root = path.join(__dirname, '..');
  const envFile = arg('--env', path.join(root, '.env'));
  const date = new Date().toISOString().slice(0, 10);
  const outDir = arg('--out', path.join(root, 'test', 'fixtures', 'reviews', 'smoke-' + date));
  const text = fs.readFileSync(path.join(root, 'test', 'fixtures', 'reviews', 'draft-b.txt'), 'utf8');
  const apiKey = readApiKey(envFile);
  console.log('live smoke: ' + BASE + ', recording to ' + path.relative(root, outDir));
  const summary = runScenario({ transport: childFetch, apiKey, text, outDir, log: (m) => console.log(m) });
  console.log((summary.passed ? 'PASSED' : 'FAILED') + ': ' + summary.results.filter((r) => r.ok).length + '/' +
    summary.results.length + ' checks, ' + summary.reviewsStarted + ' paid review(s) started');
  return summary.passed ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { runScenario, readApiKey, childFetch, recorder, memoryStore, memoryCache, cpSlice, MAX_REVIEWS };
