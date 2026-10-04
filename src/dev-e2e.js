/*
 * dev-e2e.js: a headless end-to-end run of the glue, for `clasp run`.
 *
 * The sidebar's path needs an active Doc and a UI; these two take a Doc id
 * and work on its first tab through the SAME implementations
 * (lenzSubmitIn_, lenzPollIn_, lenzApplyIn_ in Code.js), with the API key saved in
 * User properties (Dev tools → Use an API key…) or the user's Lenz sign-in.
 * Only a Doc whose title starts with
 * "Lenz spike" is touched: lenzDev_e2eStep applies edits to it.
 *
 * Per-Doc access (drive.file): the Doc must be one this script may open, so
 * make it with lenzDev_e2eCreateDoc (an add-on-made file needs no Picker).
 * Everything here goes through REST (lenzContext_(docId)); DocumentApp.openById
 * would need the `documents` scope.
 *
 *   clasp run lenzDev_e2eCreateDoc --params '["Lenz spike e2e", "<text>"]'   // → docId
 *   clasp run lenzDev_e2eStart --params '["<docId>"]'   // a paid review
 *   clasp run lenzDev_e2eStep  --params '["<docId>"]'   // repeat until done: true
 *
 * Select is not covered (it needs the Doc open in a browser).
 */

/** Creates a spike Doc through REST (so this script may open it) holding `text`: { docId, url }. */
function lenzDev_e2eCreateDoc(title, text) {
  if (typeof title !== 'string' || title.indexOf('Lenz spike') !== 0) {
    throw new Error('a spike Doc title must start "Lenz spike"');
  }
  if (typeof text !== 'string' || !text.trim()) throw new Error('pass the text to check');
  var docId = lenzRestCreateDoc_(title);
  lenzRestAppend_(docId, text);
  return { docId: docId, url: lenzDocUrl_(docId) };
}

function lenzDev_e2eContext_(docId) {
  if (typeof docId !== 'string' || !docId) throw new Error('pass the spike Doc id');
  var ctx = lenzContext_(docId);
  if (String(ctx.title).indexOf('Lenz spike') !== 0) {
    throw new Error('not a spike Doc (title must start "Lenz spike")');
  }
  if (!lenzSignedIn_()) throw new Error('not signed in and no Lenz API key saved for this user (Dev tools → Use an API key…)');
  return ctx;
}

// What a reply says, without the model's prose.
function lenzDev_e2eReply_(r) {
  var m = r && r.model;
  return {
    phase: r ? r.phase : null,
    reviewId: m ? m.reviewId : null,
    progress: m ? m.progress : null,
    headline: m ? m.headline : null,
    coverage: m ? m.coverage : [],
    charged: m ? m.charged : null,
    nextPollS: r ? r.nextPollS : null,
    error: r && r.error ? r.error : null,
    signedOut: !!(r && r.phase === 'signed_out'),
  };
}

/** Submits the spike Doc's first tab for review. */
function lenzDev_e2eStart(docId) {
  var ctx = lenzDev_e2eContext_(docId);
  var before = lenzRead_(ctx).live;
  var out = lenzDev_e2eReply_(lenzSubmitIn_(ctx));
  out.docId = docId;
  out.tabId = ctx.tabId;
  out.textChars = before.text.length;
  out.truncated = !!before.truncated;
  lenzTrialFlush_();
  return out;
}

/**
 * One poll. Once the review is complete: every finding placed (as the list
 * would place it), then every suggested edit applied in the review's order
 * through lenzApplyIn_, and the tab's text before and after.
 */
function lenzDev_e2eStep(docId) {
  var ctx = lenzDev_e2eContext_(docId);
  var out = lenzDev_e2eReply_(lenzPollIn_(ctx));
  out.done = out.phase === 'done' || out.phase === 'error';
  try {
    return out.phase === 'done' ? lenzDev_e2eFinish_(ctx, out) : out;
  } finally {
    lenzTrialFlush_();
  }
}

function lenzDev_e2eFinish_(ctx, out) {
  // The review the poll found done, and no other (a new check in between is refused).
  var fresh = lenzWithLock_(function () { return lenzFreshBody_(ctx, out.reviewId); });
  if (!fresh || !fresh.body || fresh.body.status !== 'completed') {
    // Not finished here (busy, a network miss, a changed record): step again.
    out.done = false;
    out.error = { message: fresh ? fresh.message || 'The review changed. Step again.' : 'Lenz is busy. Step again.', retryable: true };
    return out;
  }
  var read = lenzRead_(ctx);
  out.before = read.live.text;
  var targets = lenzPlaceTargets_(fresh.body);
  out.placements = targets.map(function (t) {
    var p = lenzLocate_(fresh.client, fresh.record, read, t.target);
    return {
      finding: t.finding,
      kind: t.kind,
      status: p && p.status ? p.status : 'unplaceable',
      reason: p && p.status !== 'placed' ? p.reason || null : null,
      applicable: t.kind === 'edit' ? !!(p && p.applicable) : null,
      ranges: p && p.ranges ? p.ranges : [],
    };
  });
  out.applies = targets
    .filter(function (t) { return t.kind === 'edit'; })
    .map(function (t) {
      var m = /^edit:(\d+)\.(\d+)$/.exec(t.finding);
      var r = lenzApplyIn_(ctx, fresh.record.reviewId, Number(m[1]), Number(m[2]));
      return { finding: t.finding, passage: t.passage, ok: !!(r && r.ok), message: r ? r.message : null };
    });
  out.after = lenzRead_(ctx).live.text;
  return out;
}
