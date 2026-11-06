// Test-only fake of Lenz's public review API, answering the `deps.fetch(req)` transport api.js uses
// (req = {method, url, headers, payload} → {code, headers, text}; never throws).
//
// Shapes follow Lenz's /review API as of 2026-09-30: POST /review → 202
// {review_id, status: 'queued'} + Location + Retry-After 20; an explicit Idempotency-Key replays that
// receipt for 24 h and a different body under it is 422 idempotency_body_mismatch; a key still being
// created is 409 idempotency_conflict with review_id (null when no Review row exists yet); an account
// at its in-flight cap is 429 review_in_flight + Retry-After 60; admission control is 503 capacity
// with retry_after in header and body. GET /reviews/{id} walks the captured poll bodies of the
// matching fixture (test/fixtures/reviews/<name>.polls.json) and ends on <name>.review.json.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FIX = path.join(__dirname, '..', 'fixtures', 'reviews');
const DAY_MS = 24 * 3600 * 1000;

function loadFixture(name) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(FIX, name + f), 'utf8'));
  return {
    name,
    text: fs.readFileSync(path.join(FIX, name + '.txt'), 'utf8'),
    polls: read('.polls.json'),
    final: read('.review.json'),
  };
}

const norm = (t) => String(t).replace(/\n+$/, '');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function json(code, body, headers) {
  return { code, headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), text: JSON.stringify(body) };
}
function error(code, detail, apiCode, extra, headers) {
  return json(code, Object.assign({ detail, code: apiCode }, extra || {}), headers);
}

// opts: { apiKey, now() -> ms, fixtures: ['draft-a', 'draft-b'], pollsBeforeDone }
function createFakeLenz(opts) {
  opts = opts || {};
  const apiKey = opts.apiKey || 'lenz_test_key';
  const now = opts.now || (() => Date.now());
  const fixtures = (opts.fixtures || ['draft-a', 'draft-b']).map(loadFixture);
  const reviews = {}; // id → { fixture, step, fail, body }
  const keys = {}; // idempotency key → { bodyHash, reviewId, at, creating }
  const queue = []; // scripted answers, consumed in order: { match(req) -> bool, answer }
  const requests = [];
  const failNextReview = []; // texts (normalised) whose next review ends failed
  let counter = 0;

  function newId() {
    counter += 1;
    return ('0000000' + (0xfa000000 + counter).toString(16)).slice(-8);
  }

  function fixtureFor(text) {
    const t = norm(text);
    return fixtures.find((f) => norm(f.text) === t) || null;
  }

  // A review with no findings, for text that matches no fixture (e.g. a Doc edited before the check).
  function emptyBody(id) {
    const base = JSON.parse(JSON.stringify(fixtures[0].final));
    return Object.assign(base, {
      review_id: id, status: 'completed', outcome: 'no_issues', issues: [], failures: [],
      citation_issues: [], citation_failures: [], claims: [], citations: [], more_claims: null,
      more_claim_locations: [], more_citations: null,
    });
  }

  function failed(body) {
    return Object.assign(body, {
      status: 'failed', outcome: null, poll_after_seconds: null,
      failure: {
        code: 'pipeline_error', failure_class: 'upstream_unavailable', retryable: true,
        hint: null, docs_url: 'https://lenz.io/docs/errors#upstream_unavailable',
      },
    });
  }

  function bodyAt(review) {
    const f = review.fixture;
    if (!f) {
      review.step += 1;
      return review.fail ? failed(emptyBody(review.id)) : emptyBody(review.id);
    }
    const polls = f.polls.slice(0, -1).filter((p) => p.status !== 'completed');
    const steps = opts.pollsBeforeDone === undefined ? polls.length : Math.min(opts.pollsBeforeDone, polls.length);
    let body;
    if (review.step < steps) {
      body = JSON.parse(JSON.stringify(polls[review.step]));
    } else if (review.fail) {
      body = failed(JSON.parse(JSON.stringify(polls[polls.length - 1] || f.final)));
    } else {
      body = JSON.parse(JSON.stringify(f.final));
    }
    body.review_id = review.id;
    review.step += 1;
    return body;
  }

  function receipt(id) {
    return json(202, { review_id: id, status: 'queued' },
      { Location: '/api/v1/reviews/' + id, 'Retry-After': '20' });
  }

  function createReview(text) {
    const id = newId();
    const t = norm(text);
    const i = failNextReview.indexOf(t);
    let fail = false;
    if (i !== -1) { failNextReview.splice(i, 1); fail = true; }
    reviews[id] = { id, fixture: fixtureFor(text), step: 0, fail, text };
    return id;
  }

  function header(h, name) {
    const k = Object.keys(h || {}).find((x) => x.toLowerCase() === name.toLowerCase());
    return k ? h[k] : null;
  }

  function routeOf(req) {
    const url = String(req.url || '');
    const at = url.indexOf('/api/v1');
    return { route: at === -1 ? url : url.slice(at + '/api/v1'.length), method: String(req.method || 'get').toUpperCase() };
  }

  // Scripted answers first, then the service.
  function handle(req) {
    const { method, route } = routeOf(req);
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].match(method, route, req)) {
        const scripted = queue.splice(i, 1)[0];
        return scripted.answer(method, route, req);
      }
    }
    return serve(req);
  }

  // The service itself, never the scripted queue.
  function serve(req) {
    const { method, route } = routeOf(req);

    if (header(req.headers, 'Authorization') !== 'Bearer ' + apiKey) {
      return error(401, 'Invalid or missing API key.', 'unauthorized');
    }

    if (method === 'POST' && route === '/review') {
      let payload;
      try { payload = JSON.parse(req.payload); } catch (e) { payload = null; }
      if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) {
        return json(422, { detail: 'text is required.', code: 'invalid_input',
                           errors: [{ loc: ['body', 'text'], msg: 'text is required.' }] });
      }
      const key = header(req.headers, 'Idempotency-Key');
      if (!key) return receipt(createReview(payload.text));
      const bodyHash = sha(req.payload);
      const seen = keys[key];
      if (seen && now() - seen.at < DAY_MS) {
        if (seen.bodyHash !== bodyHash) {
          return json(422, { detail: 'Idempotency-Key reused with a different request body.',
                             code: 'idempotency_body_mismatch',
                             errors: [{ loc: ['header'], msg: 'Idempotency-Key reused with a different request body.' }] });
        }
        return receipt(seen.reviewId);
      }
      const id = createReview(payload.text);
      keys[key] = { bodyHash, reviewId: id, at: now() };
      return receipt(id);
    }

    const m = /^\/reviews\/([^/?]+)$/.exec(route);
    if (method === 'GET' && m) {
      const review = reviews[decodeURIComponent(m[1])];
      if (!review) return error(404, 'Review not found.', 'not_found', null, { 'Cache-Control': 'no-store' });
      return json(200, bodyAt(review), { 'Cache-Control': 'no-store' });
    }
    return error(404, 'Not found.', 'not_found');
  }

  function fetch(req) {
    requests.push({ method: String(req.method || 'get').toUpperCase(), url: req.url, headers: req.headers,
                    payload: req.payload });
    try {
      return handle(req);
    } catch (e) {
      return { code: 0, headers: {}, text: '' };
    }
  }

  // ── scripted failures (each applies once, to the next matching request) ─────────────────────
  const isPost = (method, route) => method === 'POST' && route === '/review';
  const isGet = (method, route) => method === 'GET' && route.indexOf('/reviews/') === 0;
  const on = (which) => (which === 'get' ? isGet : isPost);

  const fail = {
    // No answer reaches the add-on. With `processed`, the server did the work first (a lost reply).
    transport(which, o) {
      queue.push({ match: on(which), answer: (method, route, req) => {
        if (o && o.processed) serve(req);
        return { code: 0, headers: {}, text: '' };
      } });
    },
    // The key is still being created elsewhere: 409 with review_id null (no Review row yet).
    conflict() {
      queue.push({ match: isPost, answer: () => error(409,
        'A review with this Idempotency-Key is still being created. Retry shortly.',
        'idempotency_conflict', { review_id: null }) });
    },
    inFlight() {
      queue.push({ match: isPost, answer: () => error(429,
        'This account already has 3 reviews running. Retry when one completes.', 'review_in_flight',
        { retry_after: 60 }, { 'Retry-After': '60' }) });
    },
    // Cloud Armor answers before the app: an HTML body, no JSON.
    armor(which) {
      queue.push({ match: on(which), answer: () => ({ code: 429, headers: { 'Content-Type': 'text/html' },
        text: '<html><body>Too many requests</body></html>' }) });
    },
    capacity() {
      queue.push({ match: isPost, answer: () => error(503,
        'Lenz is at capacity right now — please resubmit after the stated wait. Nothing was charged.',
        'capacity', { retry_after: 90, doc_url: 'https://lenz.io/docs/errors#unavailable' },
        { 'Retry-After': '90' }) });
    },
    status(which, code, body, headers) {
      queue.push({ match: on(which), answer: () => ({ code, headers: headers || {}, text: body || '' }) });
    },
    // The next review created for this text ends `failed` instead of `completed`.
    review(text) { failNextReview.push(norm(text)); },
  };

  return {
    fetch,
    fail,
    requests,
    reviews,
    fixture: (name) => fixtures.find((f) => f.name === name),
    // A finished body without the polling walk (for tests that do not exercise api.js).
    completedBody(name) {
      const f = fixtures.find((x) => x.name === name);
      return JSON.parse(JSON.stringify(f.final));
    },
  };
}

module.exports = { createFakeLenz, loadFixture };
