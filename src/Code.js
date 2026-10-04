/*
 * Code.js: the Apps Script glue. Menu, sidebar, adapters, server functions.
 * Logic lives in the pure modules (LenzSerialize, LenzPlace, LenzApi,
 * LenzView); what is here only wires them to Apps Script.
 *
 * Both flavours ship this file (scripts/build.sh). The dev harness (Dev tools
 * menu, the pasted API key, the dump) is src/dev-tools.js, internal only: this
 * file reaches it through `typeof` checks, so it runs the same without it.
 * LENZ_FLAVOUR, LENZ_OAUTH_CLIENT_ID, LENZ_TRIAL_LOG, LENZ_PICKER_API_KEY and
 * LENZ_PICKER_APP_ID come from the generated config.js (config/flavours/<flavour>.json); they are read when a
 * function runs, never while the files load.
 *
 * The server functions the sidebar calls take ids, never text (plan:
 * ids-only boundary): nothing the sidebar sends becomes Doc text or a request
 * body. The API key is never returned to the sidebar.
 *
 * Helpers ending in `_` are private (google.script.run cannot call them).
 * The ones that touch no Apps Script global are tested in Node
 * (test/code.test.js loads this file into a vm context).
 */

var LENZ_BASE = 'https://lenz.io/api/v1';
var LENZ_USER_AGENT = 'lenz-gdocs/0.1';
// "Sign in with Lenz": a public OAuth client (PKCE, no secret) per flavour, LENZ_OAUTH_CLIENT_ID in
// config.js. Its one registered redirect is this script's usercallback; the callback function is
// lenzOAuthCallback.
var LENZ_OAUTH_CALLBACK = 'lenzOAuthCallback';
var LENZ_SIGN_IN_TTL_S = 600;
// The review's escalate block (plan, decision 2). LenzApi puts it in the body
// and in the idempotency key.
var LENZ_POLICY = {
  suggest_edits: true,
  max_citations: 20,
  max_assessments: 20,
  max_verifications: 5,
  depth: 'standard',
};
// Cache values are capped at 100 KB; a chunk of 20,000 UTF-16 units is at most
// 60 KB of UTF-8 (the contract's "≤ 90 KB/chunk").
var LENZ_CHUNK_UNITS = 20000;
var LENZ_CACHE_MAX_TTL_S = 21600;
var LENZ_LOCK_WAIT_MS = 10000;
// An edit made through the Docs API is not on the editor's undo stack.
// Check this Doc on unchanged text whose last review completed: the same results, no new charge.
var LENZ_NO_CHANGES = 'No changes since the last check.';
var LENZ_APPLIED_MESSAGE = 'Applied. Undo it here, or restore an earlier version from File → Version history.';
// The read cache (lenzRead_): a tab's Serialized map and REST paragraph index,
// kept per revision. LENZ_SERIALIZER_SHA is the first 16 hex of
// sha256(src/serialize.js), pinned by test/code.test.js: a serializer change
// changes every key, so a deploy never reuses a map an older serializer made.
var LENZ_READ_CACHE_V = 1;
var LENZ_SERIALIZER_SHA = 'e421c4d029e1816d';
var LENZ_READ_TTL_S = 21600;
var LENZ_READ_MAX_CHARS = 3000000;
// A replay refused for credits continues by itself once there are some.
// The add-on's name, as on the listing: the sidebar's title bar. The Extensions menu shows the
// add-on's name from the listing (or the script project's title on a test deployment).
var LENZ_ADDON_NAME = 'Lenz Fact-Checking';
var LENZ_REPLAY_CREDITS = 'Your account is out of credits. Add credits at lenz.io/plans and this check continues on its own.';

// ── menu and sidebar ─────────────────────────────────────────────────

function onOpen(e) {
  var ui = DocumentApp.getUi();
  var menu = ui.createAddonMenu().addItem('Check this Doc', 'lenzShowSidebar');
  // Dev tools (src/dev-tools.js), only when that file is in the project: the internal build.
  if (typeof lenzDevMenu_ === 'function') menu.addSeparator().addSubMenu(lenzDevMenu_(ui));
  menu.addToUi();
}

function onInstall(e) {
  onOpen(e);
}

function lenzShowSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('sidebar').setTitle(LENZ_ADDON_NAME);
  DocumentApp.getUi().showSidebar(html);
}

// ── server functions (called by the sidebar) ─────────────────────────
//
// Every reply to the sidebar is lenzReply_ (the state of the active tab's
// check) or lenzNote_ (the outcome of one click). The user lock is held around
// submit and every GET of the review (a late poll must not race a new check),
// never around a read of the Doc alone.

/** The active tab's check, as it stands (the same as one poll). */
function lenzState() {
  return lenzPoll();
}

/**
 * The state when the sidebar opens: lenzState, and when that reads nothing of the Doc (idle: no check
 * for this tab yet), one REST probe (`fields: revisionId`) of whether Lenz may read it, so a Doc not
 * allowed yet asks at once (needs_file_access) instead of on the first Check. Writes nothing.
 */
function lenzOpenState() {
  var r = lenzState();
  if (!r || r.phase !== 'idle') return r;
  return lenzCanRead_(lenzContext_()) ? r : lenzReply_('needs_file_access', { ok: false, message: null });
}

/**
 * After a grant asked for on opening (the menu's Check this Doc is the user's intent): a check for
 * this Doc already running is only refreshed; anything else is Check this Doc (lenzStart), which
 * shows a completed review of unchanged text again without a new review or a charge, and starts one
 * when there is none or the text changed.
 */
function lenzAutoStart() {
  var r = lenzState();
  if (!r || r.phase === 'running' || r.phase === 'signed_out' || r.phase === 'needs_file_access') return r;
  return lenzStart();
}

// Signing in and out write the pending sign-ins and the tokens in User properties, as a token
// rotation does: all of it under the user lock the API calls hold, so no two executions interleave.
var LENZ_BUSY = 'Lenz is busy. Try again in a moment.';

/** The Lenz sign-in page, for the sidebar to open in a new window: { url, message }. */
function lenzSignInUrl() {
  var u = lenzWithLock_(function () {
    return lenzOAuth_().authorizationUrl(function (nonce) {
      return ScriptApp.newStateToken()
        .withMethod(LENZ_OAUTH_CALLBACK)
        .withArgument('n', nonce)
        .withTimeout(LENZ_SIGN_IN_TTL_S)
        .createToken();
    });
  });
  if (u === null) return { url: null, message: LENZ_BUSY };
  return { url: u.url, message: u.message };
}

/** Signs out: the authorization is revoked at Lenz and the tokens are forgotten here. */
function lenzSignOut() {
  // The trial line first, outside the lock (it is telemetry: a busy sign-out below still logs it).
  // Writing it after the wipe would put the trial log's keys straight back.
  if (lenzOAuth_().signedIn()) lenzTrial_(null, null, 'signed_out', {});
  lenzTrialFlush_();
  // Revoke and wipe under one lock, so no check can write its record between them; busy means
  // nothing was done and the next sign-out does it all.
  var done = lenzWithLock_(function () {
    try {
      lenzOAuth_().signOut();
    } catch (err) {
      console.warn('lenz_signout_revoke_failed');
    }
    lenzForgetAll_();
    // A new session: a call that began before this one checks it before every write it makes after
    // its lock (lenzSessionOk_), so it puts nothing back.
    lenzUserProps_().setProperty(LENZ_GEN_KEY, String(Date.now()) + '-' + Math.random().toString(36).slice(2));
    return true;
  });
  if (done === null) return lenzReply_('error', { error: { code: 0, message: LENZ_BUSY, retryable: true, retryAfterS: null } });
  return lenzSignedOut_(null);
}

// Deletes every lenz: user property (tokens, pending sign-ins, check records, applied edits, the
// dev key and its marker, trial lines and the trial log's id, everything else) and the user-cache
// entries those properties name: each check's request body, snapshot, finished reply and open list.
// The read cache (lenz:read:<doc, tab, revision>) cannot be named from here; like every user-cache
// entry it expires within LENZ_CACHE_MAX_TTL_S (6 h).
function lenzForgetAll_() {
  var props = lenzUserProps_();
  var all = props.getProperties() || {};
  var keys = Object.keys(all).filter(function (k) { return k.indexOf('lenz:') === 0; });
  var cached = {};
  function review(id) {
    if (typeof id !== 'string' || !id) return;
    cached[LenzApi.snapshotKey(id)] = true;
    cached[lenzDoneKey_(id)] = true;
  }
  keys.forEach(function (k) {
    if (k.indexOf('lenz:rec:') === 0) {
      var rec = lenzParse_(all[k]);
      if (rec && typeof rec.key === 'string' && rec.key) cached[LenzApi.bodyKey(rec.key)] = true;
      if (rec) review(rec.reviewId);
      var docTab = k.slice('lenz:rec:'.length);
      cached['lenz:open:' + docTab] = true;
      cached['lenz:open:' + docTab.replace(/:null$/, ':')] = true;
    } else if (k.indexOf('lenz:applied:') === 0) {
      review(k.slice('lenz:applied:'.length));
    }
  });
  var cache = lenzCache_();
  Object.keys(cached).forEach(function (k) {
    try {
      cache.del(k);
    } catch (err) {
      console.warn('lenz_signout_cache_del_failed');
    }
  });
  keys.forEach(function (k) { props.deleteProperty(k); });
}

/** Where Lenz sends the browser back (the script's usercallback, routed by the state token). */
function lenzOAuthCallback(request) {
  var r = lenzWithLock_(function () { return lenzOAuth_().handleCallback((request && request.parameter) || {}); });
  // Busy: the sign-in is left waiting, so the same link works once the lock is free.
  if (r === null) r = { ok: false, reason: 'busy', message: LENZ_BUSY + ' Reload this page to finish signing in.' };
  if (r.ok) lenzTrial_(null, null, 'signed_in', {});
  lenzTrialFlush_();
  return HtmlService.createHtmlOutput(lenzCallbackPage_(r)).setTitle(LENZ_ADDON_NAME);
}

// The page the sign-in window ends on. It says what happened; after a sign-in it closes itself (the
// sidebar opened it, so it may) and the sidebar notices on its next look.
function lenzCallbackPage_(r) {
  var msg = String((r && r.message) || LenzOAuth.MESSAGES.failed)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + LENZ_ADDON_NAME + '</title>' +
    '<style>body{margin:0;padding:24px;background:#FFFDF7;color:#3D3935;font:14px/1.5 \'Helvetica Neue\',Arial,sans-serif}' +
    'h1{font:500 12px ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:#6F6A64;margin:0 0 12px}</style>' +
    '</head><body><h1>' + LENZ_ADDON_NAME + '</h1><p>' + msg + '</p>' +
    (r && r.ok ? '<script>setTimeout(function(){try{window.top.close();}catch(e){}},1500);</script>' : '') +
    '</body></html>';
}

/**
 * The one button, Check this Doc (there is no separate Run again):
 * - the text changed since the last check: a new review;
 * - unchanged, and the last review completed: its results again, no new
 *   review, no charge, with "No changes since the last check.";
 * - the last review failed, or can no longer be read (lost: 403/404/410;
 *   unknown: a request whose outcome was never confirmed): a NEW review
 *   (the attempt is bumped first), so a failed receipt is never replayed;
 * - a request whose answer was lost: replayed with its own key.
 */
function lenzStart() {
  return lenzSubmit_();
}

/** One GET of the review; the sidebar schedules the next. */
function lenzPoll() {
  return lenzScoped_(function () {
    try {
      return lenzFileAccess_(lenzPollNow_);
    } finally {
      lenzTrialFlush_();
    }
  });
}

function lenzPollNow_() {
  return lenzPollIn_(lenzContext_());
}

// One poll of `ctx`'s check: the sidebar's (the active tab) and the headless
// e2e's (a Doc by id, src/dev-e2e.js) share it.
function lenzPollIn_(ctx) {
  if (!lenzSignedIn_()) return lenzSignedOut_(null);
  var client = lenzClient_();
  var step = lenzWithLock_(function () {
    var rec = client.record(ctx.docId, ctx.tabId);
    // A request whose answer never arrived: submit replays its cached body
    // with its key, whatever the Doc says now.
    if (rec && !rec.reviewId && (rec.state === 'submitting' || rec.state === 'pending_conflict')) {
      return { reply: lenzReplayLocked_(ctx, client) };
    }
    if (!rec || !rec.reviewId) return { rec: rec, poll: null };
    return { rec: rec, poll: client.poll(ctx.docId, ctx.tabId) };
  });
  if (step === null) return lenzWithStart_(ctx, client, lenzReply_('running', { nextPollS: 5 }));
  if (step.reply) return lenzRemember_(ctx, lenzWithStart_(ctx, client, step.reply));
  return lenzRemember_(ctx, lenzWithStart_(ctx, client, lenzFromPoll_(ctx, step.rec, step.poll)));
}

// A running check's start (the record's submittedAt, ms), so the sidebar can
// show "Running for 1:42" and tick it itself between polls.
function lenzWithStart_(ctx, client, reply) {
  if (reply && reply.phase === 'running') {
    var rec = client.record(ctx.docId, ctx.tabId);
    reply.startedAt = rec && typeof rec.submittedAt === 'number' ? rec.submittedAt : null;
  }
  return reply;
}

/**
 * Selects an entry's words in the Doc. `reviewId`: the review the sidebar
 * shows (a click on a list left over from another tab or an older check is
 * refused). `occurrence`: "1 of N", from 0.
 */
function lenzSelect(reviewId, entryId, occurrence) {
  return lenzScoped_(function () {
    try {
      return lenzFileAccess_(function () { return lenzSelectNow_(reviewId, entryId, occurrence); });
    } finally {
      lenzTrialStash_();
    }
  });
}

function lenzSelectNow_(reviewId, entryId, occurrence) {
  if (typeof entryId !== 'string' || entryId.length > 40) return lenzNote_('That finding is not in this check.');
  var occ = lenzIndex_(occurrence);
  if (occ === null) return lenzNote_('That finding is not in this check.');
  var ctx = lenzContext_();
  var fresh = lenzWithLock_(function () { return lenzFreshBody_(ctx, reviewId); });
  if (fresh === null) return lenzNote_('Lenz is busy. Try again in a moment.');
  if (!fresh.body) return lenzNote_(fresh.message);
  var found = LenzView.row(fresh.body, entryId);
  var target = null;
  if (found && found.kind === 'claim') target = LenzPlace.claimTarget(found.row, occ);
  if (found && found.kind === 'citation' && occ === 0) target = LenzPlace.citationTarget(found.row);
  if (!target) return lenzNote_('That finding has no words to select.');
  // Twice at most: a collaborator typing between the two reads fails the check once.
  var selected = false;
  for (var attempt = 0; attempt < 2 && !selected; attempt++) {
    var read = lenzRead_(ctx);
    var placed = lenzLocate_(fresh.client, fresh.record, read, target);
    if (!placed || placed.status !== 'placed' || !placed.ranges || !placed.ranges.length) {
      return lenzNote_('The words changed since the check, so they cannot be selected.');
    }
    selected = lenzSetSelection_(ctx, read.paras, placed.ranges);
  }
  if (!selected) return lenzNote_('The Doc is changing. Try again in a moment.');
  var i = found.row.index;
  lenzSetLast_('select', reviewId, found.kind === 'claim' ? 'claim:' + i + '@' + occ : 'citation:' + i);
  return { ok: true, message: null };
}

/**
 * Restores the words an Apply replaced. An edit made through the Docs API is
 * not on the editor's undo stack (the spike: Cmd+Z does not revert it), so the
 * sidebar undoes it the way it applied it: guarded, one write.
 */
// `source`: 'assessment' (the quick check's edit) or 'verification' (the deep check's, the default).
function lenzUndo(reviewId, claimIndex, editIndex, fp) {
  return lenzUndoIn_(lenzContext_(), reviewId, claimIndex, editIndex, fp);
}

function lenzUndoIn_(ctx, reviewId, claimIndex, editIndex, fp) {
  return lenzScoped_(function () { return lenzUndoScoped_(ctx, reviewId, claimIndex, editIndex, fp); });
}

function lenzUndoScoped_(ctx, reviewId, claimIndex, editIndex, fp) {
  var ci = lenzIndex_(claimIndex);
  var f = lenzFp_(fp);
  // An applied edit the block no longer lists has no index (-1): its fingerprint names it.
  var ei = f && editIndex === -1 ? -1 : lenzIndex_(editIndex);
  if (ci === null || ei === null || f === false) return lenzNote_('That edit is not in this check.');
  try {
    var out = lenzFileAccess_(function () { return lenzWithLock_(function () { return lenzUndoLocked_(ctx, reviewId, ci, ei, f); }); });
    out = out === null ? lenzNote_('Lenz is busy. Try again in a moment.') : lenzRemember_(ctx, out);
    lenzClockMark_('keep');
    return out;
  } finally {
    // The trial lines wait for the next poll (lenzTrialStash_), and this call's own cache writes
    // (the moved map, the reply kept for the next open) go out as one putAll.
    lenzTrialStash_();
    lenzClockMark_('trial');
    lenzScopeFlush_();
    lenzClockMark_('keep');
    lenzClockLog_();
  }
}

/** Applies one suggested edit of the review the sidebar shows, taken from a fresh read of it. */
function lenzApply(reviewId, claimIndex, editIndex, fp) {
  return lenzApplyIn_(lenzContext_(), reviewId, claimIndex, editIndex, fp);
}

function lenzApplyIn_(ctx, reviewId, claimIndex, editIndex, fp) {
  return lenzScoped_(function () { return lenzApplyScoped_(ctx, reviewId, claimIndex, editIndex, fp); });
}

function lenzApplyScoped_(ctx, reviewId, claimIndex, editIndex, fp) {
  var ci = lenzIndex_(claimIndex);
  var ei = lenzIndex_(editIndex);
  var f = lenzFp_(fp);
  if (ci === null || ei === null || f === false) return lenzNote_('That edit is not in this check.');
  try {
    var out = lenzFileAccess_(function () { return lenzWithLock_(function () { return lenzApplyLocked_(ctx, reviewId, ci, ei, f); }); });
    out = out === null ? lenzNote_('Lenz is busy. Try again in a moment.') : lenzRemember_(ctx, out);
    lenzClockMark_('keep');
    return out;
  } finally {
    // The trial lines wait for the next poll (lenzTrialStash_), and this call's own cache writes
    // (the moved map, the reply kept for the next open) go out as one putAll.
    lenzTrialStash_();
    lenzClockMark_('trial');
    lenzScopeFlush_();
    lenzClockMark_('keep');
    lenzClockLog_();
  }
}

// ── per-Doc access (drive.file + documents.currentonly, the Google Picker) ──
//
// The add-on asks for no "all your Docs" scope. DocumentApp works on the open Doc
// (documents.currentonly: the selection), but the Docs REST API reads and writes a Doc only once
// the user has granted this script that file (drive.file); before that, Google answers
// "Requested entity was not found." Any such answer on a REST call becomes the reply
// `needs_file_access`, before anything is recorded: no record moved, no trial line, no reply kept
// for the next open. The sidebar then opens picker.html (lenzShowPicker), where the user picks this
// Doc in the Google Picker; lenzFileAccessGranted checks the pick, confirms with one REST read, and
// marks it (lenz:fileok:<docId> = ms) for the sidebar, which asks lenzFileAccessReady and then
// repeats what the user was doing. Google keeps the grant per user and Doc.

var LENZ_FILEOK = 'lenz:fileok:';
var LENZ_PICKER_TITLE = 'Allow Lenz to read this Doc';
var LENZ_PICKER_W = 760;
var LENZ_PICKER_H = 520;
var LENZ_ACCESS_OTHER_DOC = 'That is a different Doc. Choose the Doc you have open.';
var LENZ_ACCESS_NOT_YET = 'Google has not passed your permission on yet. Try again in a moment.';

// Google's answer when the script may not read or write this file: 404 "Requested entity was not
// found." under drive.file, 403 when permission is missing.
function lenzIsNoFileAccess_(err) {
  var code = err && err.details ? err.details.code : null;
  if (code === 404 || code === 403) return true;
  var m = String((err && err.message) || err || '');
  return /Requested entity was not found|does not have permission|PERMISSION_DENIED/i.test(m);
}

function lenzNoFileAccessError_() {
  var e = new Error('lenz_needs_file_access');
  e.lenzNeedsFileAccess = true;
  return e;
}

/** A Docs REST call; a refusal for want of file access throws the marked error. */
function lenzDocsCall_(fn) {
  try {
    return fn();
  } catch (err) {
    if (lenzIsNoFileAccess_(err)) throw lenzNoFileAccessError_();
    throw err;
  }
}

var LENZ_NO_EDIT = 'You can view this Doc but not edit it, so Lenz cannot change it. Ask its owner for edit access, or make the change by hand.';

// A write refused for permission: needs_file_access only when the Doc cannot be read either (no
// grant). Readable, the refusal is Google's sharing (view or comment only): picking the Doc again
// would not help, so the caller says so instead.
function lenzCanRead_(ctx) {
  try {
    lenzDocsCall_(function () {
      return Docs.Documents.get(ctx.docId, { fields: 'revisionId', suggestionsViewMode: 'SUGGESTIONS_INLINE' });
    });
    return true;
  } catch (err) {
    if (err && err.lenzNeedsFileAccess) return false;
    throw err;
  }
}

/** Runs one server call's body; the marked error becomes the needs_file_access reply, with no trial line. */
function lenzFileAccess_(fn) {
  try {
    return fn();
  } catch (err) {
    if (!err || !err.lenzNeedsFileAccess) throw err;
    LENZ_TRIAL_BUFFER.splice(0, LENZ_TRIAL_BUFFER.length);
    return lenzReply_('needs_file_access', { ok: false, message: null });
  }
}

/** Opens the Picker dialog (picker.html). `openedAt`: the server's clock, for lenzFileAccessReady. */
function lenzShowPicker() {
  var html = HtmlService.createHtmlOutputFromFile('picker').setWidth(LENZ_PICKER_W).setHeight(LENZ_PICKER_H);
  DocumentApp.getUi().showModalDialog(html, LENZ_PICKER_TITLE);
  return { openedAt: Date.now() };
}

/**
 * What picker.html needs: the script's own OAuth token (as in Google's Picker sample for Apps
 * Script), the flavour's browser key and Cloud project number, and the open Doc's id. Ids and
 * config only.
 */
function lenzPickerConfig() {
  return {
    token: ScriptApp.getOAuthToken(),
    apiKey: LENZ_PICKER_API_KEY,
    appId: LENZ_PICKER_APP_ID,
    docId: DocumentApp.getActiveDocument().getId(),
  };
}

/** picker.html after a pick: only the open Doc counts, and only once a REST read of it works. */
function lenzFileAccessGranted(docId) {
  var docIdNow = DocumentApp.getActiveDocument().getId();
  if (typeof docId !== 'string' || docId !== docIdNow) return { ok: false, message: LENZ_ACCESS_OTHER_DOC };
  try {
    lenzDocsCall_(function () {
      return Docs.Documents.get(docIdNow, { fields: 'revisionId', suggestionsViewMode: 'SUGGESTIONS_INLINE' });
    });
  } catch (err) {
    if (err && err.lenzNeedsFileAccess) return { ok: false, message: LENZ_ACCESS_NOT_YET };
    throw err;
  }
  lenzUserProps_().setProperty(LENZ_FILEOK + docIdNow, String(Date.now()));
  return { ok: true, message: null };
}

/** The sidebar, waiting: has the open Doc been granted since `since` (lenzShowPicker's openedAt)? */
function lenzFileAccessReady(since) {
  var at = Number(lenzUserProps_().getProperty(LENZ_FILEOK + DocumentApp.getActiveDocument().getId()));
  var from = typeof since === 'number' && isFinite(since) ? since : 0;
  return { ready: isFinite(at) && at > 0 && at >= from };
}

// ── flow ─────────────────────────────────────────────────────────────

// Whether this execution holds the user lock now (lenzSessionOk_: no sign-out can run meanwhile).
var LENZ_LOCK_DEPTH = 0;

function lenzWithLock_(fn) {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(LENZ_LOCK_WAIT_MS)) return null;
  LENZ_LOCK_DEPTH++;
  // Another call may have written while this one waited: read the properties again inside the lock
  // (api.js re-reads the record there to refuse a poll that raced a new check).
  if (LENZ_SCOPE) LENZ_SCOPE.props = null;
  // The session this call works in: the generation it first saw under the lock (lenzSessionOk_).
  if (LENZ_SCOPE && LENZ_SCOPE.gen === undefined) LENZ_SCOPE.gen = lenzGen_();
  try {
    return fn();
  } finally {
    LENZ_LOCK_DEPTH--;
    lock.releaseLock();
    // And after it: another call (another window) may write as soon as the lock is free. The last
    // copy stays for reads that tolerate being a moment old (the trial queue's size).
    if (LENZ_SCOPE) {
      if (LENZ_SCOPE.props) LENZ_SCOPE.stale = LENZ_SCOPE.props;
      LENZ_SCOPE.props = null;
    }
  }
}

function lenzSubmit_() {
  return lenzSubmitIn_(lenzContext_());
}

function lenzSubmitIn_(ctx) {
  return lenzScoped_(function () { return lenzSubmitScoped_(ctx); });
}

function lenzSubmitScoped_(ctx) {
  if (!lenzSignedIn_()) return lenzSignedOut_(null);
  var client = null;
  var out;
  try {
    out = lenzFileAccess_(function () {
      return lenzWithLock_(function () {
        // Again under the lock, and the client built from what is there now: a sign-out between the
        // check above and this lock leaves no token and no dev key, and nothing may be written.
        if (!lenzSignedIn_()) return lenzSignedOut_(null);
        client = lenzClient_();
        return lenzSubmitLocked_(ctx, client);
      });
    });
  } finally {
    lenzTrialStash_();
  }
  if (out && out.phase === 'needs_file_access') return out;
  if (out === null) {
    return lenzReply_('error', { error: { message: 'A check is already starting. Try again in a moment.', retryable: true } });
  }
  if (!client) return out;
  return lenzRemember_(ctx, lenzWithStart_(ctx, client, out));
}

// Record states after which a click starts a new review: the review failed,
// or Lenz can no longer give it back (lost), or it may never have existed (unknown).
var LENZ_START_OVER = { failed: true, lost: true, unknown: true };

function lenzSubmitLocked_(ctx, client) {
  var rec = client.record(ctx.docId, ctx.tabId);
  if (rec && !rec.reviewId && (rec.state === 'submitting' || rec.state === 'pending_conflict')) {
    return lenzReplayLocked_(ctx, client);
  }
  // A completed review in which a check failed on Lenz's side starts over too: the click retries those checks.
  var incomplete = rec && rec.state === 'completed' && rec.reviewId && lenzIncomplete_(rec.reviewId);
  // The Doc is read before the record moves: a Doc Lenz may not read yet (needs_file_access) leaves
  // the record as it was.
  var read = lenzRead_(ctx);
  if (!read.live.text || !read.live.text.trim()) {
    return lenzReply_('error', { error: { message: 'This tab has no text to check.', retryable: false } });
  }
  if (rec && (LENZ_START_OVER[rec.state] || incomplete)) client.runAgain({ docId: ctx.docId, tabId: ctx.tabId });
  lenzSaveMeta_(ctx, read.live);
  return lenzSubmitted_(ctx, client, client.submit({ docId: ctx.docId, tabId: ctx.tabId, text: read.live.text, policy: LENZ_POLICY }));
}

// A request whose answer never arrived: LenzApi replays its cached body with
// its key before it looks at `text`, so the Doc is not read and the metadata
// saved for that text stays.
function lenzReplayLocked_(ctx, client) {
  return lenzSubmitted_(ctx, client, client.submit({ docId: ctx.docId, tabId: ctx.tabId, text: '', policy: LENZ_POLICY }));
}

function lenzSubmitted_(ctx, client, res) {
  res = res || {};
  if (res.ok) {
    // A review this key already has (unchanged text): read it now, and say so
    // when it is complete (no new review, nothing charged).
    if (res.state === 'completed' || res.state === 'failed') {
      var again = lenzFromPoll_(ctx, client.record(ctx.docId, ctx.tabId), client.poll(ctx.docId, ctx.tabId));
      if (res.state === 'completed' && again.phase === 'done') again.notice = LENZ_NO_CHANGES;
      return again;
    }
    return lenzReply_('running', { nextPollS: lenzPollDelay_(res.nextPollS) });
  }
  var err = lenzError_(res.error);
  if (res.state === 'submitting' || res.state === 'pending_conflict') {
    // The review may exist: the next poll replays the same request. A replay
    // Lenz refused keeps it pending, so the words say what unblocks it: signing
    // in again (the sign-in shows; once signed in, the next poll replays) or credits.
    if (err.code === 401) return lenzUnauthorized_(err, true, res.nextPollS || err.retryAfterS || 5);
    if (err.code === 402) err.message = LENZ_REPLAY_CREDITS;
    return lenzReply_('running', {
      error: err,
      nextPollS: lenzPollDelay_(res.nextPollS || err.retryAfterS || 5),
    });
  }
  if (err.code === 401) return lenzUnauthorized_(err);
  return lenzReply_('error', { error: err });
}

function lenzFromPoll_(ctx, rec, poll) {
  if (!rec || rec.state === 'idle' || rec.state === 'rejected') return lenzReply_('idle');
  if (rec.state === 'unknown') {
    return lenzReply_('error', { error: lenzError_({ message: LenzApi.MESSAGES.unknown_outcome }) });
  }
  if (!poll) return lenzReply_('idle');
  if (poll.ok && poll.body) return lenzReplyFromBody_(ctx, rec, poll, poll.body);
  // The record changed during the GET (a new check elsewhere): read it again.
  if (poll.terminal && !poll.error) return lenzReply_('running', { nextPollS: 3 });
  var err = lenzError_(poll.error);
  if (!poll.terminal) return lenzReply_('running', { error: err, nextPollS: lenzPollDelay_(poll.nextPollS) });
  if (err.code === 401) return lenzUnauthorized_(err);
  return lenzReply_('error', { error: err });
}

function lenzReplyFromBody_(ctx, rec, poll, body, known) {
  var meta = lenzMeta_(ctx, rec);
  var done = body.status === 'completed' || body.status === 'failed';
  if (body.status === 'completed' && body.outcome === 'incomplete') lenzMarkIncomplete_(ctx, rec.reviewId);
  if (body.status === 'completed' && !(poll && poll.cached)) lenzKeepDoneBody_(rec.reviewId, body);
  var records = lenzApplied_(rec.reviewId);
  var model = LenzView.build(body, {
    notRead: meta ? meta.notRead : null,
    truncated: meta ? meta.truncated : false,
    appliedEdits: records,
    unplaced: done ? lenzClockMark_('place', lenzPlaceAll_(ctx, rec, body, known)) : {},
  });
  lenzClockMark_('view');
  return lenzReply_(done ? 'done' : 'running', {
    model: model,
    nextPollS: done ? null : lenzPollDelay_(poll && poll.nextPollS),
    reviewId: rec.reviewId,
  });
}

// Which findings do not place on the Doc as it is now: one read, every
// position of every claim, every citation and every suggested edit. Each one
// is a trial event; the view only needs each entry's first position.
// `known`: the map as it is now when the caller has it (after its own write), so no read.
function lenzPlaceAll_(ctx, rec, body, known) {
  var out = {};
  try {
    var client = lenzClient_();
    var read = known || lenzRead_(ctx);
    var targets = lenzPlaceTargets_(body);
    var prep = lenzPrepared_(client, rec);
    if (lenzTrialFirst_(ctx, rec.reviewId)) {
      lenzTrial_(ctx, rec.reviewId, 'review_done', {
        // Credits the review charged, for the report's cost (the sidebar does not show a charge).
        charged: body.credits && typeof body.credits.charged === 'number' ? body.credits.charged : null,
        findings: targets.length,
        edits: targets.filter(function (t) { return t.kind === 'edit'; }).length,
      });
    }
    targets.forEach(function (t) {
      var p = lenzLocate_(client, rec, read, t.target, prep);
      var status = p && p.status ? p.status : 'unplaceable';
      lenzTrial_(ctx, rec.reviewId, status, {
        finding: t.finding,
        kind: t.kind,
        passage: t.passage,
        reason: status === 'placed' ? null : (p && p.reason) || null,
      });
      if (t.entry && status !== 'placed') out[t.entry] = (p && p.reason) || status;
    });
  } catch (err) {
    // A Doc Lenz may not read: the whole reply becomes needs_file_access (lenzFileAccess_).
    if (err && err.lenzNeedsFileAccess) throw err;
    console.error('lenz_place_all_failed');
  }
  return out;
}

/**
 * Every finding of a body that carries a source position, with its trial id
 * (docs/trial.md): claim:<i>@<position>, citation:<i>, edit:<i>.<j> (passage
 * claim:<i>@<edit.position>). `entry` is the sidebar entry it stands for.
 */
function lenzPlaceTargets_(body) {
  var out = [];
  LenzView.rows(body).forEach(function (r) {
    var i = r.row.index;
    if (r.kind === 'citation') {
      var c = LenzPlace.citationTarget(r.row);
      if (c) out.push({ finding: 'citation:' + i, kind: 'citation', passage: null, entry: r.id, target: c });
      return;
    }
    var positions = Array.isArray(r.row.positions) ? r.row.positions : [];
    for (var n = 0; n < positions.length; n++) {
      var t = LenzPlace.claimTarget(r.row, n);
      if (t) out.push({ finding: 'claim:' + i + '@' + n, kind: 'claim', passage: null, entry: n === 0 ? r.id : null, target: t });
    }
    var se = r.row.suggested_edits;
    var edits = se && se.status === 'completed' && Array.isArray(se.edits) ? se.edits : [];
    for (var j = 0; j < edits.length; j++) {
      var e = LenzPlace.editTarget(r.row, j);
      if (e) {
        out.push({ finding: 'edit:' + i + '.' + j, kind: 'edit', passage: 'claim:' + i + '@' + (edits[j].position || 0), entry: null, target: e });
      }
    }
  });
  return out;
}

/**
 * A target (offsets in the text sent) on the Doc as it is now. The snapshot
 * is the text sent with every Apply made so far; its hash is the sent
 * text's until the first Apply, then the updated snapshot's.
 */
// `prep` (lenzPrepared_): the applied state and snapshot, read once for many
// targets (the placement pass); without it, read here.
function lenzLocate_(client, rec, read, target, prep) {
  prep = prep || lenzPrepared_(client, rec);
  var t = LenzPlace.rebase(target, prep.state.edits);
  if (!t) return { status: 'changed', reason: 'overlaps_applied', rs: null, re: null, ranges: [], applicable: false };
  return lenzLocateRebased_(client, rec, prep.state, read, t, prep);
}

// The applied edits (one property read) and the snapshot with them made (one cache read).
function lenzPrepared_(client, rec, state) {
  state = state || lenzAppliedState_(rec.reviewId);
  return { state: state, snapshot: lenzSnapshotNow_(client, rec, state.edits), snapshotHash: lenzSnapshotHash_(rec, state) };
}

// A target already in the current snapshot's coordinates (every applied edit made).
function lenzLocateRebased_(client, rec, state, read, t, prep) {
  prep = prep || lenzPrepared_(client, rec, state);
  return LenzPlace.locate(t, {
    snapshot: prep.snapshot,
    live: read.live,
    liveHash: read.live.textHash,
    snapshotHash: prep.snapshotHash,
  });
}

// The text sent with every applied edit made; null once the cache lost it.
function lenzSnapshotNow_(client, rec, applied) {
  var sc = LENZ_SCOPE;
  var snapshot;
  if (sc && Object.prototype.hasOwnProperty.call(sc.snaps, rec.reviewId)) {
    snapshot = sc.snaps[rec.reviewId];
  } else {
    snapshot = client.snapshot(rec.reviewId);
    if (sc) sc.snaps[rec.reviewId] = snapshot;
  }
  for (var i = 0; i < applied.length && snapshot !== null; i++) {
    var next = LenzPlace.applyToSnapshot(snapshot, applied[i]);
    snapshot = next ? next.snapshot : null;
  }
  return snapshot;
}

// The hash is kept with the applied edits, so an unchanged Doc still places
// after the snapshot left the cache (6 h).
function lenzSnapshotHash_(rec, state) {
  return state.edits.length ? state.snapshotHash : rec.textHash;
}

// ── suggested edits known by their content ───────────────────────────
//
// A claim's block is replaced without saying by what (the quick check's
// edits first, then the deep check's: new edits, other indexes; Lenz #1141).
// So an edit is known by its content: LenzView.editFp (span + a hash of its
// words and replacement). The sidebar sends the fingerprint it showed with a
// click; Apply refuses when the edit at that index is no longer that one. An
// applied record keeps the edit as offered (`orig` span, `origText`,
// replacement, passage span), so a replacing block's identical edit reads
// applied and an Undo finds its record whatever the block now says. An older
// add-on's record ("claim:edit", no `orig`) is found by its index.

// null (no fingerprint: an older sidebar), the fingerprint, or false (malformed).
function lenzFp_(fp) {
  if (fp === undefined || fp === null) return null;
  return typeof fp === 'string' && fp.length <= 64 && /^\d+:\d+:[0-9a-z]+$/.test(fp) ? fp : false;
}

function lenzEditFp_(e) {
  return e ? LenzView.editFp(e.start, e.end, e.text, e.replacement) : null;
}

function lenzRecordFp_(a) {
  return a && a.orig ? LenzView.editFp(a.orig.start, a.orig.end, a.origText, a.replacement) : null;
}

// The edit an applied record was made from. The record keeps its passage's span only (a user
// property holds 9 KB): its words are the original text's, cut from the review's snapshot. null
// without a snapshot (the review then gives the edit, when it still lists it).
function lenzEditFromRecord_(fresh, rec) {
  if (!rec || !rec.orig || !rec.passage) return null;
  var snap = fresh.client.snapshot(fresh.record.reviewId);
  if (typeof snap !== 'string') return null;
  var text = LenzSerialize.cpSlice(snap, rec.passage.start, rec.passage.end);
  return { start: rec.orig.start, end: rec.orig.end, text: rec.origText, replacement: rec.replacement,
    position: rec.position || 0, passage: { start: rec.passage.start, end: rec.passage.end, text: text } };
}

// Overlap in the original text's offsets (an empty span touching counts), as view.js's overlaps().
function lenzOverlapsApplied_(a, e) {
  if (!a || !a.orig || !e) return false;
  var a0 = a.orig.start, a1 = a.orig.end;
  if (e.start === e.end || a0 === a1) return e.start <= a1 && a0 <= e.end;
  return e.start < a1 && a0 < e.end;
}

// An applied record is this edit: the same content in the same claim, or (an older add-on's
// record) the same index.
function lenzSameApplied_(a, ci, ei, edit) {
  if (a.orig) return a.claimIndex === ci && lenzRecordFp_(a) === lenzEditFp_(edit);
  return a.id === ci + ':' + ei;
}

/**
 * Undo, the Apply's mirror: the edit (from a fresh GET) rebased through every
 * applied edit lands on its own replacement; that span must still read the
 * replacement in the Doc (placed, clean, one run), then one batchUpdate puts
 * the old words back (inserted at the end of the replacement, the
 * replacement deleted) with requiredRevisionId; a conflict re-reads once.
 * An edit applied later that touches these words must be undone first.
 */
function lenzUndoLocked_(ctx, reviewId, ci, ei, fp) {
  var clock = lenzClock_('undo');
  var fresh = lenzFreshBody_(ctx, reviewId);
  clock.mark('review', fresh.poll && fresh.poll.cached ? 'cached' : 'get');
  if (!fresh.body) return lenzNote_(fresh.message);
  var state = lenzAppliedState_(reviewId);
  // No fingerprint (an older sidebar): the edit at that index in the review now names it.
  var want = fp || (ei >= 0 ? lenzEditFp_(fresh.client.edit(fresh.body, ci, ei)) : null);
  var k = -1;
  for (var n = 0; n < state.edits.length; n++) {
    var r0 = state.edits[n];
    if (r0.orig ? r0.claimIndex === ci && want && lenzRecordFp_(r0) === want : r0.id === ci + ':' + ei) k = n;
  }
  var finding = k >= 0 && state.edits[k].finding ? state.edits[k].finding : 'edit:' + ci + '.' + ei;
  // The edit as it was applied (its record keeps it, so a quick edit a deep block replaced can be
  // undone); an older record without it: from the review, as before.
  var rec0 = k >= 0 ? state.edits[k] : null;
  var edit = lenzEditFromRecord_(fresh, rec0);
  if (!edit) {
    // No snapshot: the review's edit at that index, only if it is this record's edit (an index can
    // name another occurrence once a deep block replaced the quick one).
    var fromBody = ei >= 0 ? fresh.client.edit(fresh.body, ci, ei) : null;
    var same = fromBody && (!rec0 || !rec0.orig ||
      (fromBody.start === rec0.orig.start && fromBody.end === rec0.orig.end && fromBody.text === rec0.origText && fromBody.replacement === rec0.replacement));
    edit = same ? fromBody : null;
  }
  var passage = edit ? 'claim:' + ci + '@' + edit.position : null;
  function refuse(reason, message) {
    lenzTrial_(ctx, reviewId, 'undo_refused', { finding: finding, passage: passage, reason: reason });
    return lenzNote_(message);
  }
  if (k < 0) return refuse('not_applied', 'This edit is not applied, so there is nothing to undo.');
  if (!edit || !edit.passage) return refuse('not_offered', 'This edit is no longer in the check, so restore the words by hand.');
  var mine = state.edits[k];
  var rest = lenzWithoutApplied_(state.edits, k);
  var here = LenzPlace.rebase({ kind: 'edit', start: edit.start, end: edit.end, text: edit.text,
    replacement: edit.replacement, passage: edit.passage }, state.edits);
  if (!rest || !here || here.text !== mine.replacement) {
    return refuse('overlaps_applied', 'A later edit changed these words. Undo that one first.');
  }
  if (!mine.replacement.length) return refuse('empty', 'This edit removed words; put them back by hand.');
  var target = { kind: 'edit', start: here.start, end: here.end, text: mine.replacement, replacement: mine.text, passage: here.passage };
  for (var attempt = 0; attempt < 2; attempt++) {
    var read = lenzRead_(ctx);
    clock.read(read);
    var placed = lenzLocateRebased_(fresh.client, fresh.record, state, read, target);
    if (!placed || placed.status !== 'placed') {
      return refuse((placed && placed.reason) || 'not_placed', 'These words changed since the edit, so it cannot be undone here. Restore an earlier version from File → Version history.');
    }
    if (!placed.applicable || placed.ranges.length !== 1) {
      return refuse('not_applicable', 'These words now cross formatting, a link, a chip or a suggestion, so restore them by hand.');
    }
    var written;
    try {
      written = Docs.Documents.batchUpdate(
        {
          requests: lenzApplyRequests_(placed.ranges[0], mine.text, ctx.tabId),
          writeControl: { requiredRevisionId: read.live.revisionId },
        },
        ctx.docId
      );
      clock.mark('write');
      clock.succeeded();
    } catch (err) {
      clock.mark('write');
      if (lenzIsNoFileAccess_(err)) {
        if (!lenzCanRead_(ctx)) throw lenzNoFileAccessError_();
        return refuse('no_edit_permission', LENZ_NO_EDIT);
      }
      if (lenzIsRevisionConflict_(err)) {
        if (attempt === 0) continue;
        lenzTrial_(ctx, reviewId, 'undo_refused', { finding: finding, passage: passage, reason: 'conflict' });
        return lenzNote_('The Doc changed while undoing. Try again.');
      }
      console.error('lenz_undo_failed');
      return refuse('write_failed', 'The edit could not be undone. Try again.');
    }
    var undo = { start: target.start, end: target.end, text: target.text, replacement: target.replacement };
    lenzSaveApplied_(reviewId, rest, lenzHashAfterApply_(ctx, fresh.client, fresh.record, state, placed, read.live, undo, written));
    clock.mark('state');
    lenzTrial_(ctx, reviewId, 'undone', { finding: finding, passage: passage });
    var known = lenzAfterWrite_(ctx, read, placed, mine.text, written);
    clock.mark('map');
    var reply = lenzReplyFromBody_(ctx, fresh.record, fresh.poll, fresh.body, known);
    reply.ok = true;
    reply.message = 'Undone: the earlier words are back.';
    return reply;
  }
  lenzTrial_(ctx, reviewId, 'undo_refused', { finding: finding, passage: passage, reason: 'conflict' });
  return lenzNote_('The Doc changed while undoing. Try again.');
}

/**
 * The applied list without its k-th edit: every later edit, each recorded in
 * the snapshot's coordinates after the k-th, shifted back past it. null when a
 * later edit touches the k-th's replacement (the two do not commute).
 */
function lenzWithoutApplied_(edits, k) {
  var cp = LenzSerialize.cpLength;
  var a = edits[k];
  var len = cp(a.replacement);
  var delta = len - (a.end - a.start);
  // Where the k-th's replacement sits in each later edit's coordinates: an
  // edit applied before it (in the text) moves it.
  var at = a.start;
  var out = edits.slice(0, k);
  for (var j = k + 1; j < edits.length; j++) {
    var e = edits[j];
    // Every field kept (the edit as offered, for matching and Undo); only its offsets move.
    var copy = {};
    Object.keys(e).forEach(function (key) { copy[key] = e[key]; });
    if (e.start >= at + len && !(e.start === at + len && len === 0)) {
      copy.start -= delta;
      copy.end -= delta;
    } else if (e.end <= at && !(e.end === at && e.start === e.end)) {
      at += cp(e.replacement) - (e.end - e.start);
    } else {
      return null;
    }
    out.push(copy);
  }
  return out;
}

/**
 * The snapshot's hash once `made` is applied: from the cached snapshot with
 * the edit made; else, only when the Doc WAS the snapshot (same hash) and not
 * capped, from the live text with the same edit. Else null (placement then
 * needs the cached snapshot). Never from a re-read of the Doc: that holds
 * whatever the author typed before the Apply too, and a hash that matches the
 * live text makes placement use the review's offsets as they are (a citation,
 * whose target carries no text to check, then selected shifted words).
 */
function lenzHashAfterApply_(ctx, client, rec, state, placed, live, made, written) {
  var snap = lenzSnapshotNow_(client, rec, state.edits);
  var after = null;
  if (snap !== null) {
    after = LenzPlace.applyToSnapshot(snap, made);
  } else if (!live.truncated && live.textHash === lenzSnapshotHash_(rec, state) && placed.rs !== null) {
    after = LenzPlace.applyToSnapshot(live.text, { start: placed.rs, end: placed.re, text: made.text, replacement: made.replacement });
  }
  return after ? lenzSha256_(after.snapshot) : null;
}

// A completed review does not change: its body is kept in the user cache
// (6 h) by the poll that saw it complete, and a click takes it from there, not
// from a GET. A miss GETs as before.
function lenzDoneKey_(reviewId) {
  return 'lenz:done:' + reviewId;
}

function lenzKeepDoneBody_(reviewId, body) {
  try {
    // A whole, readable value (a head whose chunks were evicted reads as a miss, and is written again).
    if (!lenzDoneBody_(reviewId)) lenzCachePut_(lenzDoneKey_(reviewId), JSON.stringify(body), LENZ_CACHE_MAX_TTL_S);
  } catch (err) {
    console.warn('lenz_done_body_put_failed');
  }
}

function lenzDoneBody_(reviewId) {
  var b = lenzParse_(lenzCacheGet_(lenzDoneKey_(reviewId)));
  return b && b.review_id === reviewId && b.status === 'completed' ? b : null;
}

// The review as Lenz has it now (caller holds the lock). It must be the one
// the sidebar shows: the active tab's current review.
function lenzFreshBody_(ctx, reviewId) {
  if (!lenzSignedIn_()) return { body: null, message: 'Sign in with Lenz first.' };
  var client = lenzClient_();
  var rec = client.record(ctx.docId, ctx.tabId);
  if (!rec || !rec.reviewId) return { body: null, message: 'There is no check of this tab yet.' };
  if (typeof reviewId !== 'string' || rec.reviewId !== reviewId) {
    return { body: null, message: 'This list is from another tab or an earlier check. Choose Check this Doc to see this tab\u2019s findings.' };
  }
  var kept = rec.state === 'completed' ? lenzDoneBody_(reviewId) : null;
  if (kept) return { body: kept, record: rec, poll: { ok: true, body: kept, nextPollS: null, cached: true }, client: client };
  var poll = client.poll(ctx.docId, ctx.tabId) || {};
  if (!poll.ok || !poll.body) {
    return { body: null, message: poll.error ? lenzError_(poll.error).message : 'The check changed. Try again.' };
  }
  return { body: poll.body, record: client.record(ctx.docId, ctx.tabId) || rec, poll: poll, client: client };
}

function lenzApplyLocked_(ctx, reviewId, ci, ei, fp) {
  var clock = lenzClock_('apply');
  var fresh = lenzFreshBody_(ctx, reviewId);
  clock.mark('review', fresh.poll && fresh.poll.cached ? 'cached' : 'get');
  if (!fresh.body) return lenzNote_(fresh.message);
  var finding = 'edit:' + ci + '.' + ei;
  var edit = fresh.client.edit(fresh.body, ci, ei);
  var passage = edit ? 'claim:' + ci + '@' + edit.position : null;
  function refuse(reason, message) {
    lenzTrial_(ctx, reviewId, 'apply_refused', { finding: finding, passage: passage, reason: reason });
    return lenzNote_(message);
  }
  if (!edit || !edit.passage) return refuse('not_offered', 'This edit is no longer offered.');
  // The edit the user saw, not whatever sits at that index now (the block may have been replaced).
  if (fp && lenzEditFp_(edit) !== fp) return refuse('changed', 'This suggestion changed. Use the one shown now.');
  var target = {
    kind: 'edit',
    start: edit.start,
    end: edit.end,
    text: edit.text,
    replacement: edit.replacement,
    passage: edit.passage,
  };
  var id = ci + ':' + lenzEditFp_(edit);
  var state = lenzAppliedState_(reviewId);
  var applied = state.edits;
  if (applied.some(function (a) { return lenzSameApplied_(a, ci, ei, edit); })) return refuse('already_applied', 'This edit is already in the Doc.');
  // Never over an applied edit's words (a deep edit where the quick one went in): the sidebar shows
  // it without Apply; Undo the applied one first. The same check as the view's `suggest`.
  if (applied.some(function (a) { return lenzOverlapsApplied_(a, edit); })) {
    return refuse('overlaps_applied', 'An edit already applied changed these words. Undo it first to apply this one.');
  }
  var rebased = LenzPlace.rebase(target, applied);
  if (!rebased) return refuse('overlaps_applied', 'An edit already applied changed these words, so make this one by hand.');
  // As applied (rebased: the snapshot's coordinates now), and as offered (the original text's), so
  // a deep block can recognise it and an Undo can find it after the block changed.
  var made = { id: id, start: rebased.start, end: rebased.end, text: rebased.text, replacement: rebased.replacement,
    claimIndex: ci, finding: finding, orig: { start: edit.start, end: edit.end }, origText: edit.text,
    position: edit.position || 0, passage: { start: edit.passage.start, end: edit.passage.end } };
  // Refused before the Doc is written, so the applied state is never lost
  // to the 9 KB property limit after an edit went in.
  if (!lenzAppliedFits_(applied.concat([made]))) {
    return refuse('state_full', 'Lenz cannot keep track of more applied edits in this check. Make this one by hand.');
  }
  for (var attempt = 0; attempt < 2; attempt++) {
    var read = lenzRead_(ctx);
    clock.read(read);
    var placed = lenzLocate_(fresh.client, fresh.record, read, target);
    if (!placed || placed.status !== 'placed') {
      return refuse((placed && placed.reason) || 'not_placed', 'The words changed since the check, so this edit cannot be applied.');
    }
    if (!placed.applicable || placed.ranges.length !== 1) {
      return refuse('not_applicable', 'This edit crosses formatting, a link, a chip or a suggestion, so make it by hand.');
    }
    var written;
    try {
      written = Docs.Documents.batchUpdate(
        {
          requests: lenzApplyRequests_(placed.ranges[0], target.replacement, ctx.tabId),
          writeControl: { requiredRevisionId: read.live.revisionId },
        },
        ctx.docId
      );
      clock.mark('write');
      clock.succeeded();
    } catch (err) {
      clock.mark('write');
      if (lenzIsNoFileAccess_(err)) {
        if (!lenzCanRead_(ctx)) throw lenzNoFileAccessError_();
        return refuse('no_edit_permission', LENZ_NO_EDIT);
      }
      if (lenzIsRevisionConflict_(err)) {
        if (attempt === 0) continue;
        lenzTrial_(ctx, reviewId, 'apply_conflict', { finding: finding, passage: passage });
        return lenzNote_('The Doc changed while applying. Try again.');
      }
      console.error('lenz_apply_failed');
      return refuse('write_failed', 'The edit could not be applied. Try again.');
    }
    lenzSaveApplied_(reviewId, applied.concat([made]), lenzHashAfterApply_(ctx, fresh.client, fresh.record, state, placed, read.live, made, written),
      lenzLastProp_('apply', reviewId, finding));
    clock.mark('state');
    lenzTrial_(ctx, reviewId, 'applied', { finding: finding, passage: passage });
    var known = lenzAfterWrite_(ctx, read, placed, target.replacement, written);
    clock.mark('map');
    var reply = lenzReplyFromBody_(ctx, fresh.record, fresh.poll, fresh.body, known);
    reply.ok = true;
    reply.message = LENZ_APPLIED_MESSAGE;
    return reply;
  }
  lenzTrial_(ctx, reviewId, 'apply_conflict', { finding: finding, passage: passage });
  return lenzNote_('The Doc changed while applying. Try again.');
}

// ── reading the Doc ──────────────────────────────────────────────────

// The Doc and tab a call works on: the active ones, or (`docId` given, the
// headless e2e) that Doc's first tab.
function lenzContext_(docId) {
  if (docId) return lenzRestContext_(docId);
  var doc = DocumentApp.getActiveDocument();
  var tab = doc.getActiveTab ? doc.getActiveTab() : null;
  if (!tab && doc.getTabs) tab = doc.getTabs()[0];
  return { docId: doc.getId(), tabId: tab ? tab.getId() : null, app: doc, tab: tab };
}

// A Doc by id (the headless e2e, src/dev-e2e.js): its first tab, through REST only.
// DocumentApp.openById needs the `documents` scope, which neither build has; the e2e makes no
// selection, so it needs no DocumentApp. `title` is for the e2e's "Lenz spike" check.
function lenzRestContext_(docId) {
  var d = lenzDocsCall_(function () {
    return Docs.Documents.get(docId, {
      includeTabsContent: true, suggestionsViewMode: 'SUGGESTIONS_INLINE', fields: 'title,tabs(tabProperties(tabId))',
    });
  });
  var tabs = d && d.tabs ? d.tabs : [];
  var first = tabs.length && tabs[0].tabProperties ? tabs[0].tabProperties.tabId : null;
  return { docId: docId, tabId: first, app: null, tab: null, title: d && d.title ? String(d.title) : '' };
}

// ── Docs the add-on creates (the trial log, the dump, the e2e's spike Docs) ──
//
// drive.file covers a file this script created, without the Picker. DocumentApp.create and
// DocumentApp.openById would need the `documents` scope (all the user's Docs), which neither build
// asks for: these go through the Docs REST API only.

/** A new Google Doc titled `title`, created by this script; its id. */
function lenzRestCreateDoc_(title) {
  var d = Docs.Documents.create({ title: String(title) });
  if (!d || !d.documentId) throw new Error('lenz_doc_create_failed');
  return d.documentId;
}

/** Appends `text` at the end of the Doc's body (one insertText; each "\n" ends a paragraph). */
function lenzRestAppend_(docId, text) {
  if (!text) return;
  Docs.Documents.batchUpdate({ requests: [{ insertText: { endOfSegmentLocation: {}, text: String(text) } }] }, docId);
}

function lenzDocUrl_(docId) {
  return 'https://docs.google.com/document/d/' + docId + '/edit';
}

/**
 * The tab as the review text and its map: { live: Serialized, paras }.
 * A REST read of a long tab takes seconds, so the map is cached per
 * (doc, tab, revision, serializer): one `fields: revisionId` get decides
 * whether the cached map is the Doc as it is now. The revision identifies the
 * content, and Apply writes with requiredRevisionId, so a cached map can never
 * write to words it no longer describes. `paras` is the REST paragraph index
 * Select aligns with DocumentApp.
 */
function lenzRead_(ctx) {
  var t0 = Date.now();
  var head = lenzDocsCall_(function () {
    return Docs.Documents.get(ctx.docId, { fields: 'revisionId', suggestionsViewMode: 'SUGGESTIONS_INLINE' });
  });
  var revMs = Date.now() - t0;
  var rev = head && head.revisionId ? head.revisionId : null;
  var cache = lenzCache_();
  if (rev) {
    var hit = lenzParse_(lenzCacheGet_(lenzReadKey_(ctx, rev)));
    if (hit && hit.v === LENZ_READ_CACHE_V && hit.live && hit.live.revisionId === rev && Array.isArray(hit.paras)) {
      // Numbers only; never text.
      console.log('lenz_read mode=cached ms=' + (Date.now() - t0) + ' rev_ms=' + revMs + ' pieces=' + hit.live.pieces.length);
      return { live: hit.live, paras: hit.paras, mode: 'cached', msRev: revMs, ms: Date.now() - t0 };
    }
  }
  var doc = lenzDocsCall_(function () {
    return Docs.Documents.get(ctx.docId, { includeTabsContent: true, suggestionsViewMode: 'SUGGESTIONS_INLINE' });
  });
  var live = LenzSerialize.serialize(doc, ctx.tabId);
  live.textHash = lenzSha256_(live.text);
  var tab = lenzFindTab_(doc.tabs, ctx.tabId);
  var paras = lenzRestParagraphs_(tab && tab.documentTab && tab.documentTab.body ? tab.documentTab.body.content : []);
  // Keyed by the revision the full read returned (the Doc may have moved on since the head).
  lenzReadStore_(ctx, live, paras);
  console.log('lenz_read mode=full ms=' + (Date.now() - t0) + ' rev_ms=' + revMs + ' pieces=' + live.pieces.length);
  return { live: live, paras: paras, mode: 'full', msRev: revMs, ms: Date.now() - t0 };
}

function lenzReadStore_(ctx, live, paras) {
  try {
    var json = JSON.stringify({ v: LENZ_READ_CACHE_V, live: live, paras: paras });
    if (live.revisionId && json.length <= LENZ_READ_MAX_CHARS) lenzCachePut_(lenzReadKey_(ctx, live.revisionId), json, LENZ_READ_TTL_S);
  } catch (err) {
    console.warn('lenz_read_cache_put_failed');
  }
}

/**
 * The map after our own write, without reading the Doc again: the one text
 * piece the edit sat in (Apply and Undo only write a placed, `applicable`
 * span: one clean text piece, one REST range, no line break) grows or shrinks
 * by the replacement, every later piece and REST paragraph shifts, and the
 * edited paragraph's text changes. Stored under the revision the batchUpdate
 * returned. null (the next read is a full one) when that revision is missing,
 * the tab is capped (the cap moves with the edit), or the edit would empty its
 * piece (a fresh read would drop the piece, even the paragraph).
 */
function lenzMapAfterWrite_(read, placed, replacement, revisionId) {
  var live = read.live;
  if (!revisionId || live.truncated || !placed || placed.rs === null || !placed.ranges || placed.ranges.length !== 1) return null;
  var cp = LenzSerialize.cpLength;
  var slice = LenzSerialize.cpSlice;
  var r0 = placed.ranges[0];
  var oldU = r0.endIndex - r0.startIndex;
  var dCp = cp(replacement) - (placed.re - placed.rs);
  var dU = replacement.length - oldU;
  var hit = -1;
  for (var i = 0; i < live.pieces.length; i++) {
    var p = live.pieces[i];
    if (p.kind === 'text' && p.ds !== null && p.rs <= placed.rs && placed.re <= p.re && p.ds <= r0.startIndex && r0.endIndex <= p.de) hit = i;
  }
  if (hit < 0) return null;
  if (live.pieces[hit].re + dCp <= live.pieces[hit].rs) return null;
  var pieces = live.pieces.map(function (p, j) {
    var q = { rs: p.rs, re: p.re, ds: p.ds, de: p.de, kind: p.kind,
      flags: { suggested: p.flags.suggested, atomic: p.flags.atomic, link: p.flags.link }, para: p.para };
    if (j === hit) {
      q.re += dCp;
      q.de += dU;
    } else if (j > hit) {
      q.rs += dCp;
      q.re += dCp;
      if (q.ds !== null) {
        q.ds += dU;
        q.de += dU;
      }
    }
    return q;
  });
  var text = slice(live.text, 0, placed.rs) + replacement + slice(live.text, placed.re);
  // Past the cap a fresh read would cut the text (and mark it truncated): read it then.
  if (cp(text) > LenzSerialize.CAP) return null;
  var paras = [];
  var found = false;
  for (var k = 0; k < read.paras.length; k++) {
    var pa = read.paras[k];
    var q2 = { start: pa.start, end: pa.end, text: pa.text };
    if (!found && pa.start <= r0.startIndex && r0.endIndex <= pa.end) {
      var o = r0.startIndex - pa.start;
      q2.text = pa.text.slice(0, o) + replacement + pa.text.slice(o + oldU);
      q2.end += dU;
      found = true;
    } else if (pa.start >= r0.endIndex) {
      q2.start += dU;
      q2.end += dU;
    }
    paras.push(q2);
  }
  if (!found) return null;
  var next = {};
  Object.keys(live).forEach(function (key) { next[key] = live[key]; });
  next.text = text;
  next.textHash = lenzSha256_(text);
  next.revisionId = revisionId;
  next.pieces = pieces;
  return { live: next, paras: paras, mode: 'written', msRev: 0, ms: 0 };
}

// After our own write: the map moved in place and cached at the new revision, or null.
function lenzAfterWrite_(ctx, read, placed, replacement, written) {
  var rev = written && written.writeControl ? written.writeControl.requiredRevisionId : null;
  try {
    var next = lenzMapAfterWrite_(read, placed, replacement, rev);
    if (next) lenzReadStore_(ctx, next.live, next.paras);
    return next;
  } catch (err) {
    console.warn('lenz_map_after_write_failed');
    return null;
  }
}

function lenzReadKey_(ctx, revisionId) {
  return 'lenz:read:' + lenzSha256_([ctx.docId, ctx.tabId || '', revisionId, LENZ_SERIALIZER_SHA, LENZ_READ_CACHE_V].join('|'));
}

function lenzFindTab_(tabs, tabId) {
  var list = tabs || [];
  for (var i = 0; i < list.length; i++) {
    var t = list[i];
    if (!tabId || (t.tabProperties && t.tabProperties.tabId === tabId)) return t;
    var inner = lenzFindTab_(t.childTabs, tabId);
    if (inner) return inner;
  }
  return null;
}

// ── selecting ────────────────────────────────────────────────────────
//
// A REST range becomes a DocumentApp range by paragraph: both sides walk the
// tab's paragraphs in the same structural order (body, then table rows and
// cells, then table-of-contents entries), so the Nth REST paragraph is the Nth
// DocumentApp paragraph, and the offset inside it is the u16 distance from the
// paragraph's startIndex. Inside a paragraph, a Text element counts its
// characters and any other inline element (image, chip) counts 1, as REST
// indexes do. SPIKE ITEM 3 MUST CONFIRM THIS ALIGNMENT (tables, chips, inline
// images, a range across two paragraphs); it is the one guess in the glue.

/** REST: every paragraph of a content list, in order, as u16 [start, end). */
function lenzRestParagraphs_(content, out) {
  out = out || [];
  (content || []).forEach(function (el) {
    if (el.paragraph) {
      out.push({ start: el.startIndex, end: el.endIndex, text: lenzRestParagraphText_(el.paragraph) });
    } else if (el.table) {
      (el.table.tableRows || []).forEach(function (row) {
        (row.tableCells || []).forEach(function (cell) { lenzRestParagraphs_(cell.content, out); });
      });
    } else if (el.tableOfContents) {
      lenzRestParagraphs_(el.tableOfContents.content, out);
    }
  });
  return out;
}

/**
 * A paragraph's text as both APIs can show it: text runs as they are, any
 * other element as U+FFFC per index it takes, line breaks as \n, the
 * paragraph's own closing newline dropped. Used to check that the DocumentApp
 * paragraph is still the one read over REST before selecting in it.
 */
function lenzRestParagraphText_(paragraph) {
  var parts = (paragraph.elements || []).map(function (e) {
    if (e.textRun) return e.textRun.content || '';
    return new Array(Math.max(1, (e.endIndex || 0) - (e.startIndex || 0)) + 1).join('￼');
  });
  return lenzParaNorm_(parts.join('').replace(/\n$/, ''));
}

function lenzParaNorm_(s) {
  return String(s).replace(/[\u000b\r]/g, '\n');
}

/** REST ranges -> [{ para, start, end }]: paragraph ordinal, u16 offsets in it. */
function lenzParagraphSpans_(paras, ranges) {
  var out = [];
  for (var r = 0; r < ranges.length; r++) {
    var range = ranges[r];
    var found = false;
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];
      if (range.startIndex >= p.start && range.endIndex <= p.end) {
        out.push({ para: i, start: range.startIndex - p.start, end: range.endIndex - p.start });
        found = true;
        break;
      }
    }
    if (!found) return null;
  }
  return out;
}

/**
 * A paragraph's children as lengths (a Text element's characters, 1 for any
 * other inline element) + a [start, end) span -> the pieces to add to a range:
 * { child, from, to } (inclusive `to`, as RangeBuilder.addElement takes it) for
 * text, { child, whole: true } for anything else.
 */
function lenzChildSegments_(children, start, end) {
  var out = [];
  var cursor = 0;
  for (var i = 0; i < children.length; i++) {
    var c = children[i];
    var from = cursor;
    var to = cursor + c.length;
    cursor = to;
    if (to <= start || from >= end || c.length === 0) continue;
    if (c.text) out.push({ child: i, from: Math.max(start, from) - from, to: Math.min(end, to) - from - 1 });
    else out.push({ child: i, whole: true });
  }
  return out;
}

/** DocumentApp: the same paragraph walk as lenzRestParagraphs_. */
function lenzAppParagraphs_(container, out) {
  out = out || [];
  var T = DocumentApp.ElementType;
  for (var i = 0; i < container.getNumChildren(); i++) {
    var child = container.getChild(i);
    var type = child.getType();
    if (type === T.PARAGRAPH || type === T.LIST_ITEM) {
      out.push(child);
    } else if (type === T.TABLE) {
      var table = child.asTable();
      for (var r = 0; r < table.getNumRows(); r++) {
        var row = table.getRow(r);
        for (var c = 0; c < row.getNumCells(); c++) lenzAppParagraphs_(row.getCell(c), out);
      }
    } else if (type === T.TABLE_OF_CONTENTS) {
      lenzAppParagraphs_(child.asTableOfContents(), out);
    }
  }
  return out;
}

/**
 * Selects REST ranges through DocumentApp. False when the paragraphs no longer
 * say what the REST read said (a collaborator typed in between): nothing is
 * selected then, since offsets into a changed paragraph pick other words.
 */
function lenzSetSelection_(ctx, restParas, ranges) {
  var spans = lenzParagraphSpans_(restParas, ranges);
  if (!spans) return false;
  var body = ctx.tab ? ctx.tab.asDocumentTab().getBody() : ctx.app.getBody();
  var appParas = lenzAppParagraphs_(body);
  var T = DocumentApp.ElementType;
  var pieces = [];
  for (var n = 0; n < spans.length; n++) {
    var sp = spans[n];
    var para = appParas[sp.para];
    if (!para) return false;
    var kids = [];
    var shown = '';
    for (var i = 0; i < para.getNumChildren(); i++) {
      var k = para.getChild(i);
      var isText = k.getType() === T.TEXT;
      var t = isText ? k.asText().getText() : '￼';
      shown += t;
      kids.push({ el: k, text: isText, length: t.length });
    }
    if (lenzParaNorm_(shown) !== restParas[sp.para].text) return false;
    lenzChildSegments_(kids, sp.start, sp.end).forEach(function (seg) { pieces.push({ el: kids[seg.child].el, seg: seg }); });
  }
  var builder = ctx.app.newRange();
  pieces.forEach(function (p) {
    if (p.seg.whole) builder.addElement(p.el);
    else builder.addElement(p.el.asText(), p.seg.from, p.seg.to);
  });
  ctx.app.setSelection(builder.build());
  return true;
}

// ── applying ─────────────────────────────────────────────────────────

/**
 * One edit as a batchUpdate: the replacement inserted at the END of the old
 * words, then the old words deleted. Inserting at the end makes the new text
 * take the style of the character before it, the last of the replaced run
 * (inserted at the start it would take the previous run's). Spike item 4
 * checked the style. Cmd+Z does not undo an API edit (spike): lenzUndo does.
 */
function lenzApplyRequests_(range, replacement, tabId) {
  var requests = [];
  if (replacement) {
    var location = { index: range.endIndex };
    if (tabId) location.tabId = tabId;
    requests.push({ insertText: { text: replacement, location: location } });
  }
  if (range.endIndex > range.startIndex) {
    var r = { startIndex: range.startIndex, endIndex: range.endIndex };
    if (tabId) r.tabId = tabId;
    requests.push({ deleteContentRange: { range: r } });
  }
  return requests;
}

function lenzIsRevisionConflict_(err) {
  var m = String((err && err.message) || err || '');
  return /revision/i.test(m);
}

// ── storage ──────────────────────────────────────────────────────────
//
// User properties only (never Document properties: every editor reads
// those). LenzApi owns lenz:rec:*, lenz:body:*, lenz:snap:*; the glue owns
// the dev key (src/dev-tools.js, internal build only), lenz:meta:<docId>:<tabId> (what the serializer did not read,
// for the text last read) and lenz:applied:<reviewId>.

// The dev key (src/dev-tools.js, internal build only), or null: the public build signs in with Lenz
// and has no other way in.
function lenzApiKey_() {
  return typeof lenzDevApiKey_ === 'function' ? lenzDevApiKey_() : null;
}

function lenzSaveMeta_(ctx, live) {
  lenzUserProps_().setProperty(
    'lenz:meta:' + ctx.docId + ':' + ctx.tabId,
    JSON.stringify({ textHash: live.textHash, notRead: live.notRead || null, truncated: !!live.truncated })
  );
}

// Only for the text the review ran on (a replayed request may be older).
function lenzMeta_(ctx, rec) {
  var meta = lenzParse_(lenzUserProps_().getProperty('lenz:meta:' + ctx.docId + ':' + ctx.tabId));
  return meta && meta.textHash === rec.textHash ? meta : null;
}

// { edits: [...], snapshotHash }: the edits applied, each as it was applied,
// and the hash of the snapshot with all of them made.
// A completed review whose outcome is `incomplete` (the record does not carry
// the outcome): the next Check this Doc starts a new review.
function lenzMarkIncomplete_(ctx, reviewId) {
  if (lenzSessionOk_() && lenzIsCurrent_(ctx, reviewId)) lenzUserProps_().setProperty('lenz:incomplete:' + reviewId, '1');
}

// The session generation: a new value at every sign-out. Not user data (a time and a random tag).
var LENZ_GEN_KEY = 'lenz:gen';

function lenzGen_() {
  return lenzUserProps_().getProperty(LENZ_GEN_KEY) || '';
}

// Whether this call is still in the session it began in: no sign-out since it first took the lock.
// Every write a call makes after its lock asks first. A call that has taken no lock wrote nothing
// under a session, and is let through.
function lenzSessionOk_() {
  var sc = LENZ_SCOPE;
  if (!sc || sc.gen === undefined) return true;
  // Under the lock no sign-out can run, and the call's copy was read when the lock was taken.
  // Outside it, the copy may predate a sign-out made by another execution: read the property itself.
  if (LENZ_LOCK_DEPTH > 0) return lenzGen_() === sc.gen;
  return (PropertiesService.getUserProperties().getProperty(LENZ_GEN_KEY) || '') === sc.gen;
}

// The same, against the copy of the properties last read under a lock, with no read of its own: for
// the writes at the very end of a call (its trial lines, its cache), where a read would cost every
// click. A sign-out in the few milliseconds since that lock is not seen here; what it lets through
// is the call's own trial lines (internal build only) and cache that expires within 6 h.
function lenzSessionSeenOk_() {
  var sc = LENZ_SCOPE;
  if (!sc || sc.gen === undefined) return true;
  var seen = sc.props || sc.stale;
  return !seen || (seen[LENZ_GEN_KEY] || '') === sc.gen;
}

// Whether `reviewId` is still this tab's check. A write made after the lock, by a call that began
// before a sign-out or a new check, asks first, so it cannot put back what the sign-out deleted.
// lenzUserProps_ reads the properties again once the lock is released (lenzWithLock_), so this
// sees a sign-out that ran since, without a read of its own when the call has read them already.
function lenzIsCurrent_(ctx, reviewId) {
  var rec = lenzParse_(lenzUserProps_().getProperty(LenzApi.recordKey(ctx.docId, ctx.tabId)));
  return !!(rec && reviewId && rec.reviewId === reviewId);
}

function lenzIncomplete_(reviewId) {
  return lenzUserProps_().getProperty('lenz:incomplete:' + reviewId) === '1';
}

function lenzAppliedState_(reviewId) {
  var v = lenzParse_(lenzUserProps_().getProperty('lenz:applied:' + reviewId));
  if (!v || !Array.isArray(v.edits)) return { edits: [], snapshotHash: null };
  return { edits: v.edits, snapshotHash: typeof v.snapshotHash === 'string' ? v.snapshotHash : null };
}

function lenzApplied_(reviewId) {
  return lenzAppliedState_(reviewId).edits;
}

// User properties hold at most 9 KB per value.
var LENZ_PROP_MAX_BYTES = 8500;

function lenzAppliedFits_(edits) {
  var json = JSON.stringify({ edits: edits, snapshotHash: new Array(65).join('0') });
  return unescape(encodeURIComponent(json)).length <= LENZ_PROP_MAX_BYTES;
}

// `also`: more user properties written in the same call (one round trip).
function lenzSaveApplied_(reviewId, edits, snapshotHash, also) {
  var out = {};
  Object.keys(also || {}).forEach(function (k) { out[k] = also[k]; });
  out['lenz:applied:' + reviewId] = JSON.stringify({ edits: edits, snapshotHash: snapshotHash });
  lenzUserProps_().setProperties(out);
}

function lenzParse_(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

// ── trial log (docs/trial.md) ────────────────────────────────────────
//
// One JSON line per action, ids only (never Doc or review text), for
// scripts/trial-report.js. Each server call buffers its lines and flushes them
// at the end: to the Apps Script log (`lenz_trial <json>`) and appended to the
// user's "lenz-gdocs trial log" Google Doc (created on first use through the
// Docs REST API: an add-on-made file, which drive.file covers), whose text is the JSONL. A failed write never
// fails the action.

// LENZ_TRIAL_LOG (config.js): on in the internal build, off in the public one.
var LENZ_TRIAL_BUFFER = [];

// sha256(docId), first 12 hex, once per Doc (a placement pass logs a line per finding).
var LENZ_DOC_TAGS = {};
function lenzDocTag_(docId) {
  if (!LENZ_DOC_TAGS[docId]) LENZ_DOC_TAGS[docId] = lenzSha256_(docId).slice(0, 12);
  return LENZ_DOC_TAGS[docId];
}

function lenzTrial_(ctx, reviewId, event, fields) {
  if (!LENZ_TRIAL_LOG) return;
  // Signing in and out belong to no Doc and no review: doc and review are null.
  var e = { v: 1, ts: new Date().toISOString(), doc: ctx && ctx.docId ? lenzDocTag_(ctx.docId) : null,
    review: reviewId || null, event: event };
  Object.keys(fields || {}).forEach(function (k) {
    if (fields[k] !== null && fields[k] !== undefined) e[k] = fields[k];
  });
  LENZ_TRIAL_BUFFER.push(JSON.stringify(e));
}

// review_done once per review. Nothing written with the trial log off, or for a check that is no
// longer this tab's (a late poll after a sign-out or a new check).
function lenzTrialFirst_(ctx, reviewId) {
  if (!LENZ_TRIAL_LOG) return false;
  if (!lenzSessionOk_() || !lenzIsCurrent_(ctx, reviewId)) return false;
  var props = lenzUserProps_();
  var k = 'lenz:trialDone:' + reviewId;
  if (props.getProperty(k)) return false;
  props.setProperty(k, '1');
  return true;
}

// Lines a click logged wait for the next poll, each click's under its own user
// property (`lenz:trialPending:<ms>-<rand>`): one write, no read, and two
// windows never overwrite each other's lines. Only trial lines live there:
// losing them loses trial lines, never the user's state.
var LENZ_TRIAL_PENDING = 'lenz:trialPending:';
var LENZ_TRIAL_FLUSH_KEYS = 8; // a click drains the queue itself past this many waiting clicks
var LENZ_TRIAL_PENDING_MAX = 40000; // bytes kept waiting in all (user properties hold 500 KB)

// `roughly`: a copy a moment old will do (a click deciding whether to drain), so no read.
function lenzTrialPendingKeys_(roughly) {
  var sc = LENZ_SCOPE;
  var all = roughly && sc && (sc.props || sc.stale) ? sc.props || sc.stale : lenzUserProps_().getProperties();
  return Object.keys(all || {})
    .filter(function (k) { return k.indexOf(LENZ_TRIAL_PENDING) === 0; })
    .sort();
}

/** On a click (Check, Select, Apply, Undo): this call's lines wait for the next poll; no Doc opened. */
function lenzTrialStash_() {
  if (!LENZ_TRIAL_LOG || !LENZ_TRIAL_BUFFER.length) return;
  var lines = LENZ_TRIAL_BUFFER.splice(0, LENZ_TRIAL_BUFFER.length);
  lines.forEach(function (l) { console.log('lenz_trial ' + l); });
  if (!lenzSessionSeenOk_()) return; // signed out since: the lines stay in the Apps Script log only
  try {
    var waiting = lenzTrialPendingKeys_(true).length;
    var added = lenzTrialStore_(lines);
    if (waiting + added >= LENZ_TRIAL_FLUSH_KEYS) lenzTrialDrain_([]);
  } catch (err) {
    console.warn('lenz_trial_stash_failed');
  }
}

// The lines as waiting batches, each under 8,000 bytes (a user property holds 9 KB), in order,
// all in one setProperties. Returns how many keys it wrote.
var LENZ_TRIAL_BATCH_MAX = 8000;
function lenzTrialStore_(lines) {
  var bytes = function (x) { return unescape(encodeURIComponent(x)).length; };
  var out = {};
  var n = 0;
  var batch = [];
  var size = 2;
  lines.forEach(function (l) {
    var b = bytes(JSON.stringify(l)) + 1;
    if (batch.length && size + b > LENZ_TRIAL_BATCH_MAX) {
      out[lenzTrialKey_()] = JSON.stringify(batch);
      n++;
      batch = [];
      size = 2;
    }
    if (b + 2 > LENZ_TRIAL_BATCH_MAX) return; // one line past the limit (never, in practice): dropped
    batch.push(l);
    size += b;
  });
  if (batch.length) {
    out[lenzTrialKey_()] = JSON.stringify(batch);
    n++;
  }
  if (n) lenzUserProps_().setProperties(out);
  return n;
}

// Keys sort in time order: the millisecond, then this execution's own sequence (two keys in one
// millisecond keep their order), then a random part (two executions never share a key).
var LENZ_TRIAL_SEQ = 0;
function lenzTrialKey_() {
  var pad = function (x, k) { x = String(x); while (x.length < k) x = '0' + x; return x; };
  LENZ_TRIAL_SEQ += 1;
  return LENZ_TRIAL_PENDING + pad(Date.now(), 15) + '-' + pad(LENZ_TRIAL_SEQ, 6) + '-' + Math.floor(Math.random() * 1e9);
}

/** On a poll, a state call or opening the log (no click waiting): every waiting line, then this call's, to the Doc. */
function lenzTrialFlush_() {
  // The trial log off (the public build): no lock, no property read, no Doc.
  if (!LENZ_TRIAL_LOG) return;
  var lines = LENZ_TRIAL_BUFFER.splice(0, LENZ_TRIAL_BUFFER.length);
  lines.forEach(function (l) { console.log('lenz_trial ' + l); });
  lenzTrialDrain_(lines);
}

// Under the user lock (a busy lock: the next poll drains), with the properties read fresh: every
// waiting key in time order into the Doc, then exactly those keys deleted. A failed Doc write leaves
// them waiting; past LENZ_TRIAL_PENDING_MAX the oldest go.
// `extra`: this call's own lines, after the waiting ones (stored as waiting if the Doc or the lock
// is not to be had).
function lenzTrialDrain_(extra) {
  if (!LENZ_TRIAL_LOG) return;
  extra = extra || [];
  var done = lenzWithLock_(function () {
    // Signed out since this call began: its lines stay in the Apps Script log only, and the trial
    // log's Doc is not opened or made again.
    if (!lenzSessionOk_()) return true;
    var props = lenzUserProps_();
    var keys = lenzTrialPendingKeys_();
    if (!keys.length && !extra.length) return true;
    var all = [];
    keys.forEach(function (k) {
      var v = lenzParse_(props.getProperty(k));
      if (Array.isArray(v)) all = all.concat(v);
    });
    all = all.concat(extra);
    try {
      lenzTrialAppend_(all.join('\n') + '\n');
      keys.forEach(function (k) { props.deleteProperty(k); });
      return true;
    } catch (err) {
      console.warn('lenz_trial_log_write_failed');
      var size = 0;
      for (var i = keys.length - 1; i >= 0; i--) {
        size += (props.getProperty(keys[i]) || '').length;
        if (size > LENZ_TRIAL_PENDING_MAX) props.deleteProperty(keys[i]);
      }
      return false;
    }
  });
  if (done !== true && extra.length) {
    try {
      lenzTrialStore_(extra);
    } catch (err) {
      console.warn('lenz_trial_stash_failed');
    }
  }
}

// The trial log Doc's id (lenz:trialLogDoc), created through REST on first use (an add-on-made file:
// drive.file covers it).
function lenzTrialLogDocId_() {
  var props = lenzUserProps_();
  var id = props.getProperty('lenz:trialLogDoc');
  if (id) return id;
  id = lenzRestCreateDoc_('lenz-gdocs trial log');
  props.setProperty('lenz:trialLogDoc', id);
  return id;
}

// The lines, one paragraph each, at the end of the trial log. A log that no longer takes them (gone,
// or made by DocumentApp before per-Doc access, which drive.file may not cover) is replaced once.
function lenzTrialAppend_(text) {
  var props = lenzUserProps_();
  var id = props.getProperty('lenz:trialLogDoc');
  if (id) {
    try {
      lenzRestAppend_(id, text);
      return id;
    } catch (err) {
      // Only a log the script may not open is replaced; any other failure (quota, an outage) keeps
      // the lines waiting for the same log (lenzTrialDrain_).
      if (!lenzIsNoFileAccess_(err)) throw err;
      console.warn('lenz_trial_log_reopen_failed');
    }
  }
  id = lenzRestCreateDoc_('lenz-gdocs trial log');
  props.setProperty('lenz:trialLogDoc', id);
  lenzRestAppend_(id, text);
  return id;
}

// The last selection and the last Apply, for the "wrong words" flags (src/dev-tools.js). Trial
// bookkeeping: nothing is kept with the trial log off.
function lenzSetLast_(of, reviewId, finding) {
  if (!LENZ_TRIAL_LOG) return;
  lenzUserProps_().setProperties(lenzLastProp_(of, reviewId, finding));
}

function lenzLastProp_(of, reviewId, finding) {
  var o = {};
  if (!LENZ_TRIAL_LOG) return o;
  o['lenz:last:' + of] = JSON.stringify({ review: reviewId, finding: finding });
  return o;
}

// ── one call's scope: user properties read once, the snapshot once ─────
//
// A property or cache read is a round trip (tens of ms on Apps Script), and an
// Apply read the same few properties and the same snapshot a dozen times. Inside
// a scope (one server call), the first property read loads every user property
// with one getProperties(); writes go through to the service and update that
// copy; the snapshot of a review is read once. The scope ends with the call, so
// nothing outlives it (another execution's writes are seen by the next call).

var LENZ_SCOPE = null;

function lenzScoped_(fn) {
  if (LENZ_SCOPE) return fn();
  LENZ_SCOPE = { props: null, snaps: {}, puts: {}, putTtl: {}, values: {} };
  try {
    return fn();
  } finally {
    try {
      lenzScopeFlush_();
    } finally {
      LENZ_SCOPE = null;
    }
  }
}

/**
 * The glue's own cache writes in a scope (the map moved after a write, the reply
 * kept for the next open, a completed body) wait and go out together as one
 * putAll per TTL at the end of the call; reads in the same call see them.
 * LenzApi's writes (the request body before its POST) never wait: lenzCache_().
 */
function lenzCachePut_(k, v, ttlS) {
  var sc = LENZ_SCOPE;
  var cache = lenzCache_();
  if (!sc) {
    cache.put(k, v, ttlS);
    return;
  }
  var ttl = cache.ttl(ttlS);
  var pieces = cache.pieces(k, v);
  sc.putTtl[ttl] = sc.putTtl[ttl] || {};
  Object.keys(pieces).forEach(function (key) { sc.putTtl[ttl][key] = pieces[key]; });
  sc.values[k] = String(v);
}

function lenzCacheGet_(k) {
  var sc = LENZ_SCOPE;
  if (sc && Object.prototype.hasOwnProperty.call(sc.values, k)) return sc.values[k];
  return lenzCache_().get(k);
}

function lenzScopeFlush_() {
  var sc = LENZ_SCOPE;
  if (!sc) return;
  var raw = CacheService.getUserCache();
  var groups = sc.putTtl;
  sc.putTtl = {};
  sc.values = {};
  // A sign-out seen under a lock since this call began: its cache writes are for a session that has
  // ended (lenzSessionSeenOk_, no read of its own).
  if (!lenzSessionSeenOk_()) return;
  Object.keys(groups).forEach(function (ttl) {
    try {
      raw.putAll(groups[ttl], Number(ttl));
    } catch (err) {
      console.warn('lenz_cache_put_failed');
    }
  });
}

function lenzUserProps_() {
  var real = PropertiesService.getUserProperties();
  var sc = LENZ_SCOPE;
  if (!sc) return real;
  // The copy is looked up on every operation, never held: when the lock drops it
  // (lenzWithLock_), a store made before the lock reads the service again.
  function all() {
    if (!sc.props) sc.props = real.getProperties() || {};
    return sc.props;
  }
  return {
    getProperty: function (k) {
      var a = all();
      return Object.prototype.hasOwnProperty.call(a, k) ? a[k] : null;
    },
    getProperties: function () { return all(); },
    setProperty: function (k, v) {
      real.setProperty(k, v);
      if (sc.props) sc.props[k] = String(v);
      return this;
    },
    setProperties: function (o) {
      real.setProperties(o);
      if (sc.props) Object.keys(o).forEach(function (k) { sc.props[k] = String(o[k]); });
      return this;
    },
    deleteProperty: function (k) {
      real.deleteProperty(k);
      if (sc.props) delete sc.props[k];
      return this;
    },
  };
}

// ── timing (numbers only; never text) ─────────────────────────────────

/**
 * One line per Apply / Undo that wrote (numbers only):
 * lenz_apply op= ms_total= ms_review= review=cached|get ms_rev= ms_read= mode=cached|full ms_write=
 *   ms_after= (ms_state + ms_map + ms_place + ms_view: from the write to the reply)
 *   ms_state= (applied edits, snapshot hash, last action: one property write)
 *   ms_map= (the map moved in place and cached) ms_place= (every finding placed)
 *   ms_view= (the list built) ms_keep= (the reply kept for the next open) ms_trial= (trial log written)
 * ms_total runs to the end of the call, the trial log included.
 */
var LENZ_CLOCK = null;

function lenzClock_(op) {
  var t0 = Date.now();
  var last = t0;
  var parts = {};
  var how = { review: '', mode: '', rev: 0, read: 0 };
  var clock = {
    wrote: false, // set only when a batchUpdate succeeded: only those calls log a line
    succeeded: function () { clock.wrote = true; },
    mark: function (name, detail) {
      var now = Date.now();
      parts[name] = (parts[name] || 0) + (now - last);
      if (name === 'review') how.review = detail;
      last = now;
    },
    read: function (r) {
      how.mode = r.mode;
      how.rev = r.msRev;
      how.read = r.ms;
      last = Date.now();
    },
    line: function () {
      var g = function (k) { return parts[k] || 0; };
      var after = g('state') + g('map') + g('place') + g('view');
      return 'lenz_apply op=' + op + ' ms_total=' + (Date.now() - t0) + ' ms_review=' + g('review') + ' review=' + how.review +
        ' ms_rev=' + how.rev + ' ms_read=' + how.read + ' mode=' + how.mode + ' ms_write=' + g('write') + ' ms_after=' + after +
        ' ms_state=' + g('state') + ' ms_map=' + g('map') + ' ms_place=' + g('place') + ' ms_view=' + g('view') +
        ' ms_keep=' + g('keep') + ' ms_trial=' + g('trial');
    },
  };
  LENZ_CLOCK = clock;
  return clock;
}

// Marks a step on the running Apply / Undo clock, if any; returns `value` (so it can wrap a call).
function lenzClockMark_(name, value) {
  if (LENZ_CLOCK) LENZ_CLOCK.mark(name);
  return value;
}

// Logs the line once, only for a call that wrote, and ends the clock.
function lenzClockLog_() {
  var c = LENZ_CLOCK;
  LENZ_CLOCK = null;
  if (c && c.wrote) console.log(c.line());
}

// ── opening fast ──────────────────────────────────────────────────────
//
// The last reply rendered for a doc + tab is kept in the user cache; on open
// the sidebar asks lenzOpen first, which answers from that (stale: true) with
// no Lenz call and no Doc read, then asks lenzState and replaces it.

function lenzOpenKey_(ctx) {
  return 'lenz:open:' + ctx.docId + ':' + (ctx.tabId || '');
}

function lenzRemember_(ctx, reply) {
  if (!reply || !reply.phase || reply.phase === 'signed_out' || reply.phase === 'needs_file_access') return reply;
  // A running placeholder (busy lock, a record changing) would hide the list kept before it.
  if (reply.phase === 'running' && !reply.model) return reply;
  try {
    var keep = {};
    Object.keys(reply).forEach(function (k) {
      if (k !== 'ok' && k !== 'message' && k !== 'notice' && k !== 'stale') keep[k] = reply[k];
    });
    lenzCachePut_(lenzOpenKey_(ctx), JSON.stringify(keep), LENZ_CACHE_MAX_TTL_S);
  } catch (err) {
    console.warn('lenz_open_put_failed');
  }
  return reply;
}

/** The first call on open: the last reply for this tab, or idle / sign-in, with no network. */
function lenzOpen() {
  return lenzScoped_(lenzOpenNow_);
}

function lenzOpenNow_() {
  var ctx = lenzContext_();
  if (!lenzSignedIn_()) return lenzSignedOut_(null);
  var kept = lenzParse_(lenzCacheGet_(lenzOpenKey_(ctx)));
  // Only a reply about this tab's current check: one written back after a sign-out or a new check
  // (by a call that was in flight; the cache write itself is deferred to the call's end, so it is
  // checked here, where it is read) must not reappear.
  if (kept && kept.model && !(kept.reviewId && lenzIsCurrent_(ctx, kept.reviewId))) kept = null;
  var out = kept && kept.phase ? kept : lenzReply_('idle');
  out.auth = lenzAuth_();
  out.stale = true;
  return out;
}

/** The sidebar's own open timings (ms, numbers only). */
function lenzLogOpen(msFirst, msFull) {
  var a = typeof msFirst === 'number' && isFinite(msFirst) ? Math.round(msFirst) : -1;
  var b = typeof msFull === 'number' && isFinite(msFull) ? Math.round(msFull) : -1;
  console.log('lenz_open ms_first=' + a + ' ms_full=' + b);
  return null;
}

// ── adapters for LenzApi ─────────────────────────────────────────────

function lenzClient_() {
  var deps = {
    fetch: lenzFetch_,
    store: lenzStore_(),
    cache: lenzCache_(),
    sha256: lenzSha256_,
    now: function () { return Date.now(); },
    base: LENZ_BASE,
    userAgent: LENZ_USER_AGENT,
  };
  var key = lenzApiKey_();
  if (key) {
    deps.apiKey = key;
  } else {
    // Read and rotated on every call, under the user lock the API calls run in (a rotation from
    // another execution is picked up from User properties).
    deps.getToken = function (opts) { return lenzOAuth_().getToken(opts); };
  }
  return LenzApi.create(deps);
}

// ── signing in (src/oauth.js) ────────────────────────────────────────

function lenzOAuth_() {
  return LenzOAuth.create({
    fetch: lenzFetch_,
    store: lenzStore_(),
    now: function () { return Date.now(); },
    randomId: function () { return Utilities.getUuid().replace(/-/g, ''); },
    s256: lenzS256_,
    clientId: LENZ_OAUTH_CLIENT_ID,
    redirectUri: lenzRedirectUri_, // asked only when signing in
  });
}

// The script's own usercallback, exactly as registered with Lenz.
function lenzRedirectUri_() {
  return 'https://script.google.com/macros/d/' + ScriptApp.getScriptId() + '/usercallback';
}

/** PKCE S256: base64url of the verifier's SHA-256, no padding (43 characters). */
function lenzS256_(s) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '');
}

// Signed in with Lenz, or a dev API key saved.
function lenzSignedIn_() {
  return !!lenzApiKey_() || lenzOAuth_().signedIn();
}

function lenzAuth_() {
  if (lenzApiKey_()) return { mode: 'key', signedIn: true };
  return { mode: 'oauth', signedIn: lenzOAuth_().signedIn() };
}

// A 401 that a rotated token did not cure: signed in with Lenz, the sign-in has ended (forgotten
// here, so the sidebar offers it again); with a dev key, the key is wrong. A pending request stays
// pending either way: once signed in again (or a new key saved), the next poll replays it.
function lenzUnauthorized_(err, pending, nextPollS) {
  if (lenzApiKey_()) {
    return pending
      ? lenzReply_('running', { error: err, nextPollS: lenzPollDelay_(nextPollS) })
      : lenzReply_('error', { error: err });
  }
  lenzOAuth_().forget();
  return lenzSignedOut_(LenzApi.MESSAGES.signed_out);
}

/** UrlFetchApp, never throwing: a transport failure is code 0. Header names lower-cased. */
function lenzFetch_(req) {
  var headers = {};
  var contentType = null;
  Object.keys(req.headers || {}).forEach(function (k) {
    if (k.toLowerCase() === 'content-type') contentType = req.headers[k];
    else headers[k] = req.headers[k];
  });
  var options = { method: String(req.method || 'get').toLowerCase(), headers: headers, muteHttpExceptions: true, followRedirects: false };
  if (req.payload !== undefined && req.payload !== null) {
    options.payload = req.payload;
    options.contentType = contentType || 'application/json';
  }
  try {
    var res = UrlFetchApp.fetch(req.url, options);
    return { code: res.getResponseCode(), headers: lenzLowerKeys_(res.getAllHeaders()), text: res.getContentText() };
  } catch (err) {
    console.warn('lenz_fetch_transport_failure');
    return { code: 0, headers: {}, text: '' };
  }
}

function lenzLowerKeys_(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function (k) {
    var v = obj[k];
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  });
  return out;
}

function lenzStore_() {
  var props = lenzUserProps_();
  return {
    get: function (k) { return props.getProperty(k); },
    set: function (k, v) { props.setProperty(k, v); },
    del: function (k) { props.deleteProperty(k); },
  };
}

function lenzCache_() {
  return lenzChunkedCache_(CacheService.getUserCache());
}

/**
 * A CacheService cache that takes values of any length: chunks under
 * `<key>#<n>`, then a small head `{n, len}` under the key itself, written
 * last, so a reader never sees a head without its chunks. A missing chunk or a
 * wrong length reads as a miss (chunks can be evicted one by one).
 */
function lenzChunkedCache_(raw) {
  function chunkKeys(k, n) {
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(k + '#' + i);
    return keys;
  }
  function head(k) {
    var h = lenzParse_(raw.get(k));
    return h && typeof h.n === 'number' && typeof h.len === 'number' ? h : null;
  }
  return {
    get: function (k) {
      var h = head(k);
      if (!h) return null;
      var keys = chunkKeys(k, h.n);
      var got = h.n ? raw.getAll(keys) : {};
      var parts = [];
      for (var i = 0; i < keys.length; i++) {
        if (typeof got[keys[i]] !== 'string') return null;
        parts.push(got[keys[i]]);
      }
      var s = parts.join('');
      return s.length === h.len ? s : null;
    },
    ttl: function (ttlS) {
      return Math.max(1, Math.min(LENZ_CACHE_MAX_TTL_S, Math.floor(ttlS || LENZ_CACHE_MAX_TTL_S)));
    },
    // The raw entries of one value: its chunks and its head. One putAll writes them; a reader checks
    // every chunk and the length, so a head seen before its chunks (or after one is evicted) reads as
    // a miss, never as wrong text.
    pieces: function (k, v) {
      var parts = lenzSplit_(String(v), LENZ_CHUNK_UNITS);
      var keys = chunkKeys(k, parts.length);
      var all = {};
      keys.forEach(function (key, i) { all[key] = parts[i]; });
      all[k] = JSON.stringify({ n: parts.length, len: String(v).length });
      return all;
    },
    put: function (k, v, ttlS) {
      raw.putAll(this.pieces(k, v), this.ttl(ttlS));
    },
    del: function (k) {
      var h = head(k);
      raw.removeAll([k].concat(h ? chunkKeys(k, h.n) : []));
    },
  };
}

/** Splits into pieces of at most `size` UTF-16 units, never inside a surrogate pair. */
function lenzSplit_(s, size) {
  var out = [];
  var i = 0;
  while (i < s.length) {
    var end = Math.min(s.length, i + size);
    if (end < s.length) {
      var c = s.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1;
    }
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

function lenzSha256_(s) {
  return lenzHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}

/** Apps Script digests are signed bytes. */
function lenzHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

// ── replies to the sidebar ───────────────────────────────────────────

/**
 * The state of the active tab's check:
 * { phase, auth, model, nextPollS, error, startedAt, notice? }
 * phase: signed_out | idle | running | done | error. auth: { mode: 'oauth' | 'key', signedIn }.
 * `error` is shown as text; with phase `running` it is a passing problem and polling goes on.
 */
function lenzReply_(phase, extra) {
  var out = {
    phase: phase,
    auth: phase === 'signed_out' ? { mode: 'oauth', signedIn: false } : lenzAuth_(),
    model: null,
    nextPollS: null,
    error: null,
    startedAt: null,
  };
  Object.keys(extra || {}).forEach(function (k) { out[k] = extra[k]; });
  return out;
}

// Not signed in: the sidebar shows Sign in with Lenz, with `message` above it when there is one.
function lenzSignedOut_(message) {
  return lenzReply_('signed_out', { error: message ? { code: 401, message: message, retryable: false, retryAfterS: null } : null });
}

/** The outcome of one click: { ok, message }. */
function lenzNote_(message) {
  return { ok: false, message: message };
}

/** An ApiError, as the sidebar shows it. */
function lenzError_(e) {
  var fallback = 'Something went wrong. Try again.';
  if (!e || typeof e !== 'object') return { code: 0, message: fallback, retryable: true, retryAfterS: null };
  return {
    code: typeof e.code === 'number' ? e.code : 0,
    message: typeof e.message === 'string' && e.message ? e.message : fallback,
    retryable: !!e.retryable,
    retryAfterS: typeof e.retryAfterS === 'number' ? e.retryAfterS : null,
  };
}

// Waits come from LenzApi (Retry-After, poll_after_seconds, backoff); never under 3 s.
function lenzPollDelay_(s) {
  return typeof s === 'number' && s > 0 ? Math.max(3, s) : 15;
}

function lenzIndex_(n) {
  return typeof n === 'number' && n >= 0 && n < 1000 && Math.floor(n) === n ? n : null;
}
