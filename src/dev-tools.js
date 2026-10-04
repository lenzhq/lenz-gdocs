/*
 * dev-tools.js: the dev harness, in the internal build only (config/flavours/public.json omits it).
 * Extensions → Lenz Fact-Checking → Dev tools: dump the tab's JSON, the two "wrong words" flags,
 * open the trial log, and a pasted API key for `clasp run` e2e (which cannot sign in).
 *
 * Code.js reaches this file only through `typeof` checks (onOpen: lenzDevMenu_; lenzApiKey_:
 * lenzDevApiKey_), so the public build, without it, has no Dev tools menu and no way to run on a
 * pasted key: it signs in with Lenz.
 */

// A pasted API key: the dev path only (Dev tools → Use an API key…), for `clasp run` e2e, which
// cannot sign in. Everyone else signs in with Lenz (src/oauth.js).
var LENZ_KEY_PROP = 'lenz:apiKey';
// Set with the key by lenzSaveKey, the dev setter. Before the sign-in (v10) the first-run box saved
// users' keys without it: such a key is a pre-OAuth one and is dropped (lenzDevApiKey_), so its owner
// is offered Sign in with Lenz instead of running on it as a dev key.
var LENZ_KEY_SOURCE_PROP = 'lenz:apiKeySource';
var LENZ_DUMP_PART_CHARS = 400000;

function lenzDevMenu_(ui) {
  var dev = ui
    .createMenu('Dev tools')
    .addItem("Dump this tab's JSON", 'lenzDevDump')
    .addItem('The last selection hit the wrong words', 'lenzDevWrongSelect')
    .addItem('The last Apply hit the wrong words', 'lenzDevWrongApply')
    .addItem('Open the trial log', 'lenzDevTrialLog')
    .addItem('Use an API key…', 'lenzDevUseKey');
  // The spike kit (src/dev.js), only when that file is in the project.
  if (typeof lenzDev_menuSelect === 'function' && typeof lenzDev_menuCheck === 'function') {
    dev.addSubMenu(ui.createMenu('Spike').addItem('Select text…', 'lenzDev_menuSelect').addItem('Check this spike Doc', 'lenzDev_menuCheck'));
  }
  return dev;
}

// ── the pasted API key ───────────────────────────────────────────────

/**
 * Dev only: saves an API key (an empty string removes it), used instead of the sign-in while set.
 * Never returns the key.
 */
function lenzSaveKey(key) {
  var props = lenzUserProps_();
  var k = typeof key === 'string' ? key.trim() : '';
  if (!k) {
    props.deleteProperty(LENZ_KEY_PROP);
    props.deleteProperty(LENZ_KEY_SOURCE_PROP);
    return lenzPoll();
  }
  if (!lenzKeyLooksRight_(k)) {
    return lenzReply_('error', {
      error: { message: 'That does not look like a Lenz API key. A key starts with lenz_.', retryable: false },
    });
  }
  props.setProperty(LENZ_KEY_SOURCE_PROP, 'dev');
  props.setProperty(LENZ_KEY_PROP, k);
  return lenzPoll();
}

// The dev key, if one was saved through lenzSaveKey (Code.js lenzApiKey_ asks). A key without the dev
// marker was pasted into the pre-OAuth first-run box: it is deleted here, once, and logged
// (key_migrated).
function lenzDevApiKey_() {
  var props = lenzUserProps_();
  var key = props.getProperty(LENZ_KEY_PROP);
  if (!key) return null;
  if (props.getProperty(LENZ_KEY_SOURCE_PROP) === 'dev') return key;
  props.deleteProperty(LENZ_KEY_PROP);
  lenzTrial_(null, null, 'key_migrated', {});
  return null;
}

// A Lenz key starts with `lenz_` and has no spaces; Lenz itself says whether it works (401).
function lenzKeyLooksRight_(k) {
  return /^lenz_\S{4,200}$/.test(k);
}

/** Dev tools → Use an API key…: for `clasp run` e2e, which cannot sign in. Empty removes it. */
function lenzDevUseKey() {
  var ui = DocumentApp.getUi();
  var r = ui.prompt(LENZ_ADDON_NAME + ' (dev)',
    'Paste a Lenz API key to use instead of signing in (dev tests only). Leave it empty to remove the key.',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return null;
  var out = lenzSaveKey(r.getResponseText());
  ui.alert(LENZ_ADDON_NAME + ' (dev)', out.error ? out.error.message : (lenzApiKey_() ? 'The key is saved.' : 'The key is removed.'),
    ui.ButtonSet.OK);
  return out.phase;
}

// ── the dump (spike + fixtures) ──────────────────────────────────────

/**
 * Writes the active tab's REST JSON (includeTabsContent, SUGGESTIONS_INLINE)
 * into new Google Docs and logs their URLs. The Docs are created and written
 * through REST (Code.js lenzRestCreateDoc_ / lenzRestAppend_): add-on-made
 * files, which drive.file covers (DocumentApp.create would need `documents`).
 */
function lenzDevDump() {
  var ctx = lenzContext_();
  var doc = Docs.Documents.get(ctx.docId, { includeTabsContent: true, suggestionsViewMode: 'SUGGESTIONS_INLINE' });
  var tab = lenzFindTab_(doc.tabs, ctx.tabId);
  var out = {
    documentId: doc.documentId,
    revisionId: doc.revisionId,
    title: doc.title,
    suggestionsViewMode: doc.suggestionsViewMode,
    activeTabId: ctx.tabId,
    tabs: tab ? [tab] : doc.tabs,
  };
  var parts = lenzSplit_(JSON.stringify(out, null, 1), LENZ_DUMP_PART_CHARS);
  var stamp = Utilities.formatDate(new Date(), 'Etc/UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  var urls = parts.map(function (part, i) {
    var name = 'lenz-gdocs dump ' + stamp + (parts.length > 1 ? ' part ' + (i + 1) + ' of ' + parts.length : '');
    var id = lenzRestCreateDoc_(name);
    lenzRestAppend_(id, part);
    return lenzDocUrl_(id);
  });
  urls.forEach(function (u) { Logger.log(u); });
  var ui = DocumentApp.getUi();
  ui.alert(LENZ_ADDON_NAME + ' (dev)', 'Wrote ' + urls.length + ' Doc(s):\n' + urls.join('\n'), ui.ButtonSet.OK);
  return urls;
}

// ── the trial flags and the trial log ────────────────────────────────

function lenzDevWrong_(of) {
  var ctx = lenzContext_();
  var last = lenzParse_(lenzUserProps_().getProperty('lenz:last:' + of));
  var ui = DocumentApp.getUi();
  if (!last) {
    ui.alert(LENZ_ADDON_NAME + ' (dev)', 'Nothing to flag yet.', ui.ButtonSet.OK);
    return null;
  }
  lenzTrial_(ctx, last.review, 'wrong', { finding: last.finding, of: of });
  lenzTrialFlush_();
  ui.alert(LENZ_ADDON_NAME + ' (dev)', 'Flagged ' + last.finding + ' (' + of + ').', ui.ButtonSet.OK);
  return last;
}

function lenzDevWrongSelect() {
  return lenzDevWrong_('select');
}

function lenzDevWrongApply() {
  return lenzDevWrong_('apply');
}

function lenzDevTrialLog() {
  // What clicks left waiting goes in first, so the log is complete when it opens.
  lenzScoped_(lenzTrialFlush_);
  var url = lenzDocUrl_(lenzTrialLogDocId_());
  var ui = DocumentApp.getUi();
  ui.alert(LENZ_ADDON_NAME + ' (dev)', 'The trial log: ' + url, ui.ButtonSet.OK);
  return url;
}
