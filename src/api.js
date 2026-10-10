// The Lenz API client: submit a review, poll it, read an edit from it.
// Pure: the transport, User properties, User cache, digest and clock are injected (CONTRACT.md).
var LenzApi = (function () {
  'use strict';

  var DEFAULT_POLICY = {
    suggest_edits: true,
    max_citations: 20,
    max_assessments: 20,
    max_verifications: 5,
    depth: 'standard'
  };

  var CACHE_TTL_S = 21600; // 6 h, the longest the user cache keeps a value
  var FIRST_POLL_S = 20; // the POST's Retry-After when it carries none
  var POLL_S = 15; // poll_after_seconds when a running review carries none
  var MIN_POLL_S = 3;
  var MAX_BACKOFF_S = 60;
  // A poll that has failed this long without one success stops: the sidebar offers Resume.
  var GIVE_UP_MS = 5 * 60 * 1000;
  var CONFLICT_RETRY_S = 5;
  var RATE_RETRY_S = 60;
  var CAPACITY_RETRY_S = 90;

  // Every string the add-on shows about a request lives here (plain, short, what to do).
  var MESSAGES = {
    transport: "Couldn't reach Lenz. Check your connection and try again.",
    unauthorized: 'Lenz did not accept your key. Paste a current one from the API credentials page on lenz.io.',
    signed_out: 'Your Lenz sign-in has ended. Choose Sign in with Lenz to keep checking.',
    credits: 'Your account is out of credits. Add credits at lenz.io/plans, then run the check again.',
    forbidden: 'Your key cannot open this check. Choose Check this Doc to check it again.',
    not_found: 'Lenz cannot find this check. Choose Check this Doc to check it again.',
    purged: 'This check was removed under your account\'s retention setting. Choose Check this Doc to check it again.',
    starting: 'Your check is still starting. Lenz will pick it up in a few seconds.',
    body_mismatch: 'This check does not match the one already sent. Choose Check this Doc to start a new one.',
    invalid: 'Lenz could not read this document. Make sure the tab has text, then try again.',
    in_flight: 'Your account already has the most checks running at once. Try again in a minute.',
    rate_limited: 'Too many requests from this network. Try again in a minute.',
    link_limit: 'Your account reached today\'s limit for reading links. Try again tomorrow.',
    capacity: 'Lenz is at capacity. Nothing was charged. Try again in a minute.',
    server: 'Lenz ran into a problem on its side. Try again in a minute.',
    unknown_outcome: 'A check may have started, but Lenz did not confirm it. Choose Check this Doc to start a new one.',
    cancel_not_started: 'Lenz has not confirmed this check started yet, so it cannot be stopped. Try again in a moment.',
    other: 'Something went wrong. Try again.'
  };

  // ── helpers ───────────────────────────────────────────────────────────

  function recordKey(docId, tabId) { return 'lenz:rec:' + docId + ':' + tabId; }
  function bodyKey(key) { return 'lenz:body:' + key; }
  function snapshotKey(reviewId) { return 'lenz:snap:' + reviewId; }
  // A selection check's whole-tab text, kept from before the POST until accept names the review.
  function scopeSnapshotKey(key) { return 'lenz:scopesnap:' + key; }

  // A selection check sends a slice of the tab that starts at `offset`; Lenz answers in the
  // slice's coordinates. Every draft position in the body moves by `offset` once, as it arrives,
  // so the rest of the add-on works in the whole tab's coordinates. The fields, as /review has
  // them: only objects with integer start and end move.
  var POSITION_LISTS = [
    ['claims', 'positions'], ['more_claim_locations', 'positions']
  ];
  var POSITION_ONES = ['citations', 'citation_issues', 'citation_failures', 'more_citations'];
  var EDIT_ROWS = ['claims', 'issues'];

  function shiftSpan(span, offset) {
    if (span && typeof span === 'object' && isInt(span.start) && isInt(span.end)) {
      span.start += offset;
      span.end += offset;
    }
  }

  function rowsOf(body, field) { return Array.isArray(body[field]) ? body[field] : []; }

  function shiftBody(body, offset) {
    if (!body || typeof body !== 'object' || !isInt(offset) || offset === 0) return body;
    POSITION_LISTS.forEach(function (f) {
      rowsOf(body, f[0]).forEach(function (row) {
        if (row && Array.isArray(row[f[1]])) row[f[1]].forEach(function (sp) { shiftSpan(sp, offset); });
      });
    });
    POSITION_ONES.forEach(function (f) {
      rowsOf(body, f).forEach(function (row) { if (row) shiftSpan(row.position, offset); });
    });
    EDIT_ROWS.forEach(function (f) {
      rowsOf(body, f).forEach(function (row) {
        var se = row && row.suggested_edits;
        if (se && Array.isArray(se.edits)) se.edits.forEach(function (e) { shiftSpan(e, offset); });
      });
    });
    return body;
  }

  function stableStringify(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) {
      return JSON.stringify(k) + ':' + stableStringify(v[k]);
    }).join(',') + '}';
  }

  function parseJson(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
      var v = JSON.parse(text);
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch (e) {
      return null;
    }
  }

  function header(headers, name) {
    if (!headers) return null;
    var want = name.toLowerCase();
    var keys = Object.keys(headers);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].toLowerCase() === want) return headers[keys[i]];
    }
    return null;
  }

  function seconds(v) {
    var n = typeof v === 'number' ? v : (typeof v === 'string' && /^\s*\d+\s*$/.test(v) ? parseInt(v, 10) : NaN);
    return isFinite(n) && n >= 0 ? n : null;
  }

  function firstSeconds() {
    for (var i = 0; i < arguments.length; i++) {
      var s = seconds(arguments[i]);
      if (s !== null) return s;
    }
    return null;
  }

  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

  // The review states after which nothing more happens to it.
  var TERMINAL = { completed: true, failed: true, cancelled: true };

  // A review the user stopped (POST /reviews/{id}/cancel). The current shape says `status: cancelled`;
  // the older one says `failed` with a `cancelled` failure (failure_class, or failure_reason). The older
  // answer is read as the current one as it arrives, so the rest of the add-on knows one word.
  function readCancelled(body) {
    if (!body || typeof body !== 'object' || body.status !== 'failed') return body;
    var f = body.failure && typeof body.failure === 'object' ? body.failure : {};
    if (f.failure_class === 'cancelled' || f.failure_reason === 'cancelled' || f.code === 'cancelled') {
      body.status = 'cancelled';
    }
    return body;
  }

  // ── describeError ─────────────────────────────────────────────────────

  function err(code, apiCode, message, retryable, retryAfterS) {
    return { code: code, apiCode: apiCode, message: message, retryable: retryable, retryAfterS: retryAfterS };
  }

  // code: HTTP status (0 = no response); body: the response text.
  function describeError(code, headers, body) {
    var json = parseJson(body);
    var apiCode = json && typeof json.code === 'string' ? json.code : null;
    var ra = header(headers, 'Retry-After');
    if (!code) return err(0, null, MESSAGES.transport, true, null);
    if (code === 401) return err(code, apiCode, MESSAGES.unauthorized, false, null);
    if (code === 402) return err(code, apiCode, MESSAGES.credits, false, null);
    if (code === 403) return err(code, apiCode, MESSAGES.forbidden, false, null);
    if (code === 404) return err(code, apiCode, MESSAGES.not_found, false, null);
    if (code === 410) return err(code, apiCode, MESSAGES.purged, false, null);
    if (code === 409) return err(code, apiCode, MESSAGES.starting, true, firstSeconds(ra) || CONFLICT_RETRY_S);
    if (code === 422) {
      return err(code, apiCode, apiCode === 'idempotency_body_mismatch' ? MESSAGES.body_mismatch : MESSAGES.invalid,
        false, null);
    }
    // The wait in the body: `retry_after` (current), else the older names this endpoint used
    // (`retry_after_seconds`, `reset_in_seconds`). The Retry-After header comes first.
    if (code === 429) {
      if (apiCode === 'review_in_flight') {
        return err(code, apiCode, MESSAGES.in_flight, true,
          firstSeconds(ra, json.retry_after, json.retry_after_seconds, RATE_RETRY_S));
      }
      if (apiCode === 'extract_daily_limit') {
        return err(code, apiCode, MESSAGES.link_limit, false, firstSeconds(ra, json.retry_after, json.reset_in_seconds));
      }
      // Cloud Armor's per-IP throttle answers before the app, with no JSON.
      return err(code, apiCode, MESSAGES.rate_limited, true, firstSeconds(ra, RATE_RETRY_S));
    }
    if (code === 503 && apiCode) {
      return err(code, apiCode, MESSAGES.capacity, true, firstSeconds(ra, json.retry_after, CAPACITY_RETRY_S));
    }
    if (code >= 500) return err(code, apiCode, MESSAGES.server, true, firstSeconds(ra));
    return err(code, apiCode, MESSAGES.other, false, null);
  }

  // ── the client ────────────────────────────────────────────────────────

  function create(deps) {
    function readRecord(docId, tabId) {
      return parseJson(deps.store.get(recordKey(docId, tabId)));
    }

    function writeRecord(docId, rec) {
      deps.store.set(recordKey(docId, rec.tabId), JSON.stringify(rec));
    }

    // Signed in with Lenz: the bearer is an access token from deps.getToken({force}) -> {token,
    // signedOut}. With an API key (the dev path): deps.apiKey.
    var SIGNED_OUT = { code: 401, headers: {}, text: '{"code":"signed_out"}' };
    var NO_ANSWER = { code: 0, headers: {}, text: '' };

    function bearer(force) {
      if (typeof deps.getToken !== 'function') return { header: 'Bearer ' + deps.apiKey, refusal: null };
      var t = deps.getToken({ force: !!force }) || {};
      if (typeof t.token === 'string' && t.token) return { header: 'Bearer ' + t.token, refusal: null };
      // Signed out: nothing is sent. Unreachable for a refresh: nothing sent, try again later.
      return { header: null, refusal: t.signedOut ? SIGNED_OUT : NO_ANSWER };
    }

    function transport(req) {
      var res;
      try {
        res = deps.fetch(req);
      } catch (e) {
        res = null; // deps.fetch never throws by contract; a broken adapter is a transport failure
      }
      return res && typeof res.code === 'number' ? res : NO_ANSWER;
    }

    function send(method, path, payload, key) {
      var auth = bearer(false);
      if (auth.refusal) return auth.refusal;
      var headers = {
        Authorization: auth.header,
        Accept: 'application/json',
        'User-Agent': deps.userAgent
      };
      if (payload !== undefined) headers['Content-Type'] = 'application/json';
      if (key) headers['Idempotency-Key'] = key;
      var req = { method: method, url: deps.base + path, headers: headers };
      if (payload !== undefined) req.payload = payload;
      var res = transport(req);
      if (res.code !== 401 || typeof deps.getToken !== 'function') return res;
      // A 401 comes before Lenz does anything, so the same request may go again: once, with a
      // freshly rotated token. A second 401 is the answer.
      var again = bearer(true);
      // Signed out now: say so. Lenz unreachable for the refresh: no answer, so it is tried again.
      if (again.refusal) return again.refusal;
      headers.Authorization = again.header;
      return transport(req);
    }

    function describe(code, headers, text) {
      var e = describeError(code, headers, text);
      if (code === 401 && typeof deps.getToken === 'function') e.message = MESSAGES.signed_out;
      return e;
    }

    function accept(docId, rec, reviewId, firstPollS, replayed) {
      rec.reviewId = reviewId;
      rec.state = 'running';
      rec.pollFailures = 0;
      rec.pollFailingSince = null;
      rec.submitFailures = 0;
      writeRecord(docId, rec);
      if (isInt(rec.offset)) {
        // A selection check: the whole tab as it was, never the slice (whose offsets are not the
        // body's once shifted). Lost meanwhile: no snapshot, placement then needs the same text.
        var whole = deps.cache.get(scopeSnapshotKey(rec.key));
        if (typeof whole === 'string') {
          deps.cache.put(snapshotKey(reviewId), whole, CACHE_TTL_S);
          // Kept only while the request is pending: the review's snapshot holds it now.
          if (typeof deps.cache.del === 'function') deps.cache.del(scopeSnapshotKey(rec.key));
        }
      } else {
        var sent = parseJson(deps.cache.get(bodyKey(rec.key)));
        if (sent && typeof sent.text === 'string') deps.cache.put(snapshotKey(reviewId), sent.text, CACHE_TTL_S);
      }
      return {
        ok: true, reviewId: reviewId, state: 'running', replayed: replayed,
        nextPollS: Math.max(MIN_POLL_S, firstPollS), error: null
      };
    }

    // A pending submission (its answer not known) is retried by the caller after nextPollS:
    // 5, 10, 20, 40, then every 60 s, or the stated Retry-After when that is longer.
    function failed(docId, rec, state, error) {
      rec.state = state;
      var wait = null;
      if (state === 'submitting' || state === 'pending_conflict') {
        rec.submitFailures = (isInt(rec.submitFailures) ? rec.submitFailures : 0) + 1;
        wait = Math.min(MAX_BACKOFF_S, 5 * Math.pow(2, rec.submitFailures - 1));
        if (error && error.retryAfterS !== null) wait = Math.max(wait, error.retryAfterS);
      }
      writeRecord(docId, rec);
      return { ok: false, reviewId: null, state: state, replayed: false, nextPollS: wait, error: error };
    }

    // POST the body already cached under rec.key and settle the record from the answer.
    function post(docId, rec, payload, replayed) {
      var res = send('post', '/review', payload, rec.key);
      var json = parseJson(res.text);
      var reviewId = json && typeof json.review_id === 'string' && json.review_id ? json.review_id : null;
      if (res.code === 202 || res.code === 200) {
        if (reviewId) {
          return accept(docId, rec, reviewId,
            firstSeconds(header(res.headers, 'Retry-After'), FIRST_POLL_S), replayed);
        }
        // Accepted but unreadable: the review exists; the next submit replays the key.
        return failed(docId, rec, 'submitting', describeError(0, {}, ''));
      }
      var error = describe(res.code, res.headers, res.text);
      if (res.code === 409 && json && json.code === 'idempotency_conflict') {
        if (reviewId) return accept(docId, rec, reviewId, FIRST_POLL_S, replayed);
        return failed(docId, rec, 'pending_conflict', error);
      }
      // A JSON 4xx, or a 503 with a code, is Lenz saying no before a review existed:
      // the next submit starts from the Doc as it is then.
      if ((res.code >= 400 && res.code < 500) || (res.code === 503 && error.apiCode)) {
        // A replay refused (Cloud Armor, a key change, credits) says nothing about the first
        // request: that one may still have created a review, so its key and body stay pending.
        // Except a body mismatch: Lenz holds this key for another body, so the replay can never
        // be accepted; only Run again (a new key) gets out.
        if (replayed && error.apiCode === 'idempotency_body_mismatch') return failed(docId, rec, 'unknown', error);
        if (replayed) return failed(docId, rec, rec.state, error);
        return failed(docId, rec, 'rejected', error);
      }
      // No answer, or a 5xx from somewhere in between: the review may exist. Keep the key and body.
      return failed(docId, rec, 'submitting', error);
    }

    function submit(args) {
      var docId = args.docId;
      var tabId = args.tabId;
      var rec = readRecord(docId, tabId);

      // A request whose outcome we never learned is settled first, with its own key and body.
      if (rec && !rec.reviewId && (rec.state === 'submitting' || rec.state === 'pending_conflict')) {
        var cached = deps.cache.get(bodyKey(rec.key));
        if (cached === null) {
          return failed(docId, rec, 'unknown', err(0, null, MESSAGES.unknown_outcome, false, null));
        }
        return post(docId, rec, cached, true);
      }
      if (rec && rec.state === 'unknown') {
        return { ok: false, reviewId: null, state: 'unknown', replayed: false, nextPollS: null,
          error: err(0, null, MESSAGES.unknown_outcome, false, null) };
      }

      var policy = args.policy || DEFAULT_POLICY;
      var policyJson = stableStringify(policy);
      var textHash = deps.sha256(args.text);
      var attempt = rec && isInt(rec.attempt) ? rec.attempt : 0;
      // A selection: `snapshot` (the whole tab's text) and `offset` (where the slice starts in it).
      var scoped = typeof args.snapshot === 'string' && isInt(args.offset) && args.offset >= 0;
      var snapshotHash = scoped ? deps.sha256(args.snapshot) : null;
      var parts = [docId, tabId, textHash, policyJson, String(attempt)];
      // The same words at another place, or in a tab that changed, are another review: a review id
      // whose done body, snapshot and applied edits were made at one offset is never reused at
      // another. A whole-tab key is as it always was.
      if (scoped) parts.push('sel:' + args.offset + ':' + snapshotHash);
      var key = deps.sha256(parts.join('|'));

      if (rec && rec.key === key && rec.reviewId) {
        var terminal = TERMINAL[rec.state] === true;
        return { ok: true, reviewId: rec.reviewId, state: rec.state, replayed: false,
          nextPollS: terminal ? null : MIN_POLL_S, error: null };
      }

      var payload = JSON.stringify({
        text: args.text,
        // Sent on purpose: on /review an empty webhook_url means "no webhook" for this review.
        // Leaving it out would send the key's default webhook, if the account has one.
        webhook_url: '',
        visibility: 'private',
        escalate: JSON.parse(policyJson)
      });
      var next = {
        reviewId: null, key: key, tabId: tabId, textHash: textHash, attempt: attempt,
        submittedAt: deps.now(), state: 'submitting', pollFailures: 0, submitFailures: 0
      };
      if (scoped) {
        next.offset = args.offset;
        next.snapshotHash = snapshotHash;
        next.scope = args.scope && typeof args.scope === 'object' ? args.scope : {};
        deps.cache.put(scopeSnapshotKey(key), args.snapshot, CACHE_TTL_S);
      }
      // Both written before the POST, so a lost reply can be replayed byte for byte (R1, O4).
      deps.cache.put(bodyKey(key), payload, CACHE_TTL_S);
      writeRecord(docId, next);
      return post(docId, next, payload, false);
    }

    // An explicit "Run again": the next submit is a new review, even for unchanged text.
    function runAgain(args) {
      var rec = readRecord(args.docId, args.tabId) || {
        reviewId: null, key: null, tabId: args.tabId, textHash: null, attempt: 0, submittedAt: null
      };
      rec.attempt = (isInt(rec.attempt) ? rec.attempt : 0) + 1;
      rec.reviewId = null;
      rec.key = null;
      rec.state = 'idle';
      delete rec.offset;
      delete rec.snapshotHash;
      delete rec.scope;
      rec.pollFailures = 0;
      rec.pollFailingSince = null;
      writeRecord(args.docId, rec);
    }

    // Polling again after a give-up: the same review id, a fresh window. Nothing is sent and the
    // Doc is not read; the next poll is the GET.
    function resume(docId, tabId) {
      var rec = readRecord(docId, tabId);
      if (!rec || !rec.reviewId) return false;
      rec.pollFailures = 0;
      rec.pollFailingSince = null;
      writeRecord(docId, rec);
      return true;
    }

    function pollResult(ok, status, body, terminal, nextPollS, error, gaveUp) {
      return { ok: ok, status: status, body: body, terminal: terminal, nextPollS: nextPollS, error: error, gaveUp: !!gaveUp };
    }

    // A failed poll that goes on being retried: its start is kept, so a streak lasting GIVE_UP_MS ends
    // (gaveUp: the record keeps its review id; a later poll that fails again is still past the window).
    function failedPoll(docId, rec, error, wait) {
      rec.pollFailures = (isInt(rec.pollFailures) ? rec.pollFailures : 0) + 1;
      var now = deps.now();
      if (typeof rec.pollFailingSince !== 'number') rec.pollFailingSince = now;
      writeRecord(docId, rec);
      if (now - rec.pollFailingSince >= GIVE_UP_MS) return pollResult(false, null, null, false, null, error, true);
      return pollResult(false, null, null, false, wait(rec.pollFailures), error);
    }

    function backoff(docId, rec, error) {
      return failedPoll(docId, rec, error, function (failures) {
        var wait = Math.min(MAX_BACKOFF_S, 5 * Math.pow(2, failures - 1));
        if (error.retryAfterS !== null) wait = Math.max(wait, Math.min(MAX_BACKOFF_S, error.retryAfterS));
        return wait;
      });
    }

    // A review body as it arrives (GET or cancel): shifted, read in one shape, and the record's state
    // set from it.
    function settle(docId, rec, body) {
      if (isInt(rec.offset)) shiftBody(body, rec.offset);
      readCancelled(body);
      var terminal = TERMINAL[body.status] === true;
      rec.state = terminal ? body.status : 'running';
      rec.pollFailures = 0;
      rec.pollFailingSince = null;
      writeRecord(docId, rec);
      var after = seconds(body.poll_after_seconds);
      return pollResult(true, body.status, body, terminal,
        terminal ? null : Math.max(MIN_POLL_S, after === null ? POLL_S : after), null);
    }

    // The review is out of reach for good; the next submit is a new review.
    function lost(docId, rec, error) {
      rec.state = 'lost';
      rec.attempt = (isInt(rec.attempt) ? rec.attempt : 0) + 1;
      writeRecord(docId, rec);
      return pollResult(false, null, null, true, null, error);
    }

    // Stop the record's review: POST /reviews/{id}/cancel, which answers with the review as it stands
    // afterwards (`cancelled`, or `completed` / `failed` when it ended first: that answer is shown, never
    // called cancelled). Cancelling again is safe on Lenz's side; a review this record already knows has
    // ended is not sent again. Anything but a 200 leaves the record running (polling goes on) with the
    // error, so a retry after a lost answer is the same request. Same result shape as poll().
    function cancel(docId, tabId) {
      var rec = readRecord(docId, tabId);
      if (!rec || !rec.reviewId) {
        return pollResult(false, null, null, false, null, err(0, null, MESSAGES.cancel_not_started, true, null));
      }
      if (TERMINAL[rec.state]) return poll(docId, tabId);
      var res = send('post', '/reviews/' + encodeURIComponent(rec.reviewId) + '/cancel');
      var now = readRecord(docId, tabId);
      if (!now || now.key !== rec.key || now.reviewId !== rec.reviewId) {
        return pollResult(false, null, null, true, null, null);
      }
      rec = now;
      if (res.code === 200) {
        var body = parseJson(res.text);
        if (body && typeof body.status === 'string') return settle(docId, rec, body);
        return pollResult(false, null, null, false, null, describeError(0, {}, ''));
      }
      var error = describe(res.code, res.headers, res.text);
      if (res.code === 403 || res.code === 404 || res.code === 410) return lost(docId, rec, error);
      return pollResult(false, null, null, false, null, error);
    }

    // One GET of the review; the caller schedules the next after nextPollS.
    function poll(docId, tabId) {
      var rec = readRecord(docId, tabId);
      if (!rec || !rec.reviewId) {
        return pollResult(false, null, null, true, null, err(0, null, MESSAGES.not_found, false, null));
      }
      var res = send('get', '/reviews/' + encodeURIComponent(rec.reviewId));
      // A Run again or a new submit may have replaced the record during the GET: an answer about
      // the old review must not overwrite it.
      var now = readRecord(docId, tabId);
      if (!now || now.key !== rec.key || now.reviewId !== rec.reviewId) {
        return pollResult(false, null, null, true, null, null);
      }
      rec = now;
      if (res.code === 200) {
        var body = parseJson(res.text);
        if (!body || typeof body.status !== 'string') return backoff(docId, rec, describeError(0, {}, ''));
        return settle(docId, rec, body);
      }
      var error = describe(res.code, res.headers, res.text);
      if (res.code === 403 || res.code === 404 || res.code === 410) return lost(docId, rec, error);
      if (res.code === 429) {
        return failedPoll(docId, rec, error, function () { return Math.max(MIN_POLL_S, error.retryAfterS || RATE_RETRY_S); });
      }
      if (error.retryable) return backoff(docId, rec, error);
      return pollResult(false, null, null, true, null, error);
    }

    function record(docId, tabId) {
      return readRecord(docId, tabId);
    }

    // The text the review was run on, for placing its findings after the Doc changed.
    function snapshot(reviewId) {
      return deps.cache.get(snapshotKey(reviewId));
    }

    return {
      submit: submit, runAgain: runAgain, resume: resume, poll: poll, cancel: cancel, record: record,
      snapshot: snapshot, edit: edit
    };
  }

  // ── edit: read from a review body the server just returned ─────────────

  function findRow(rows, field, index) {
    if (!Array.isArray(rows)) return null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i][field] === index) return rows[i];
    }
    return null;
  }

  function edit(reviewBody, claimIndex, editIndex) {
    if (!reviewBody || !isInt(claimIndex) || claimIndex < 0 || !isInt(editIndex) || editIndex < 0) return null;
    var claim = findRow(reviewBody.claims, 'index', claimIndex);
    var issue = findRow(reviewBody.issues, 'claim_index', claimIndex);
    var suggested = (claim && claim.suggested_edits) || (issue && issue.suggested_edits) || null;
    if (!suggested || suggested.status !== 'completed' || !Array.isArray(suggested.edits)) return null;
    var e = suggested.edits[editIndex];
    if (!e || !isInt(e.start) || !isInt(e.end) || e.start < 0 || e.end < e.start) return null;
    if (typeof e.text !== 'string' || typeof e.replacement !== 'string' || !isInt(e.position)) return null;
    var pos = claim && Array.isArray(claim.positions) ? claim.positions[e.position] : null;
    var passage = pos && isInt(pos.start) && isInt(pos.end) && typeof pos.text === 'string'
      ? { start: pos.start, end: pos.end, text: pos.text }
      : null;
    return {
      claimIndex: claimIndex,
      editIndex: editIndex,
      start: e.start,
      end: e.end,
      text: e.text,
      replacement: e.replacement,
      position: e.position,
      passage: passage
    };
  }

  return {
    create: create,
    describeError: describeError,
    DEFAULT_POLICY: DEFAULT_POLICY,
    MESSAGES: MESSAGES,
    recordKey: recordKey,
    bodyKey: bodyKey,
    snapshotKey: snapshotKey,
    scopeSnapshotKey: scopeSnapshotKey,
    shiftBody: shiftBody,
    readCancelled: readCancelled,
    TERMINAL: TERMINAL
  };
})();
if (typeof module !== 'undefined') { module.exports = LenzApi; }
