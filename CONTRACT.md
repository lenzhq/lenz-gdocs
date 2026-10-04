# lenz-gdocs — module contract

The source of truth for how the modules fit together. Changing anything here means changing this
file in the same PR.

## Layout

```
config/
  appsscript.base.json   the manifest fields both builds share (runtime, Advanced Docs service)
  flavours/<f>.json      per build: script title, Lenz OAuth client id, trial log switch, files left
                         out, manifest scopes / urlFetchWhitelist / executionApi
scripts/build.sh    <internal|public> → dist/<f>/ (gitignored): src/*.js + *.html minus the
                    flavour's omitFiles, plus generated config.js (LENZ_FLAVOUR,
                    LENZ_OAUTH_CLIENT_ID, LENZ_TRIAL_LOG, LENZ_PICKER_API_KEY, LENZ_PICKER_APP_ID)
                    and appsscript.json. clasp pushes dist/<f>/. config/flavours/internal.json is
                    not in git (copy internal.example.json; docs/deploy.md).
src/
  serialize.js      pure: Docs REST Document → review text + interval map
  place.js          pure: finding → live range; snapshot update after Apply
  api.js            pure: Lenz API client with injected transport/storage
  oauth.js          pure: Sign in with Lenz (OAuth code + PKCE), injected transport
  view.js           pure: review body → ordered sidebar model + coverage lines
  Code.js           Apps Script glue: menu, server functions, adapters
  sidebar.html      sidebar UI (HtmlService), calls google.script.run
  dev-tools.js      internal build only: Dev tools menu, pasted API key, dump, trial flags
  dev.js, spike.js  internal build only: the spike kit
  dev-e2e.js        internal build only: headless e2e for `clasp run`
test/
  *.test.js         node --test; each pure module has its own file
  fixtures/docs/    Docs REST JSON (hand-built, plus two real spike dumps)
  fixtures/reviews/ real /review responses for this project's test texts (draft-a.*, draft-b.*)
  helpers/          fake-docs (Docs REST + batchUpdate), fake-lenz (the /review API), fake-appsscript
                    (src/*.js in one scope with fake Apps Script services), fake-serialized,
                    flavour (the internal config.js, for suites that load src/ directly, from
                    fixtures/flavours/internal.json)
  flow.test.js      end to end without Google: Doc → serialize → api → poll → place → Apply
```

Test harness (`test/helpers/`, test-only):
- `fake-docs`: `createFakeDocs()` → `{Documents: {get, batchUpdate}, create, textOf, rangeText,
  revision, coauthorReplace, onBeforeNextBatch, log}`. Layout as `fixtures/docs/build.js`; edits stay
  inside one run of paragraphs (Google's refusals: surrogate pair, a container's last newline, across
  a table); a batch is all or nothing; a stale `requiredRevisionId` throws Apps Script's "API call to
  docs.documents.batchUpdate failed with error: …" with `body.error = {code: 400, status:
  'FAILED_PRECONDITION'}`. Spike (2026-09-30): the message is "API call to docs.documents.batchUpdate
  failed with error: The required revision ID '<id>' does not match the latest revision.", and
  `e.details` = `{code: 400, message}` (no `status` seen); inserted text takes the style of the
  character before it (confirmed: inserted before a whole link, the new words lost the link).
- `fake-lenz`: `createFakeLenz({apiKey, now, pollsBeforeDone})` → `{fetch, fail, requests, reviews}`;
  wire shapes from Lenz's public `/review` API. `fail.transport(which, {processed})`, `conflict`,
  `inFlight`, `armor`, `capacity`, `status`, `review(text)` each script one answer.
- `fake-appsscript`: `createRuntime({docs, lenz, docId, tabId, now})` loads the internal build's
  `config.js`, then `src/` (serialize, place, api, view, Code, dev-tools) into one vm context with Docs, UrlFetchApp, PropertiesService, CacheService,
  LockService, Utilities, Session, DocumentApp, HtmlService. The `glue:` tests in `flow.test.js`
  call the server functions there and skip until `src/Code.js` exists (view tests: `src/view.js`).

## Module shape (every pure file)

Apps Script V8 has one global scope and no `require`. Each pure file is:

```js
var LenzSerialize = (function () {
  'use strict';
  // ...
  return { serialize: serialize, /* ... */ };
})();
if (typeof module !== 'undefined') { module.exports = LenzSerialize; }
```

No Apps Script globals (`DocumentApp`, `Docs`, `UrlFetchApp`, `PropertiesService`, `CacheService`,
`Utilities`, `LockService`, `Session`) in pure files. A pure file may use another pure file's global
(`LenzSerialize` inside `place.js`); in Node, tests `require` both. Stay at ES2019 (Apps Script
V8): no optional chaining, no `??`, no modules. No npm dependencies at runtime.

Units: **cp** = Unicode code points of the review text (the API's unit); **u16** = UTF-16 code units
(Docs REST indexes, JS string indexes). Always name which.

## serialize.js — `LenzSerialize`

`serialize(doc, tabId) -> Serialized`

- `doc`: a Docs REST `Document` fetched with `includeTabsContent: true`,
  `suggestionsViewMode: 'SUGGESTIONS_INLINE'`. `tabId` = the active tab (`null` → first tab).
- Rules: exactly those of Lenz's own .docx reader (paragraphs joined by `\n\n`, an empty paragraph adds
  nothing, soft break `\u000b` → `\n`, tab `\t`, every linked run → `[words](url)`), plus:
  suggested-deletion content out, suggested-insertion content in, both flagged `suggested`;
  suggestion ids on tables/rows/cells propagate to everything inside; RichLink → `[title](url)`;
  Person/Date chips → display text flagged `atomic`; everything else not read is counted in `notRead`.
- 50,000 cp cap, never cut inside a `[..](..)`; `truncated: true` then.

```
Serialized = {
  text: string,                 // the review text
  textHash: string|null,        // left null here; the glue fills sha256 (pure code has no digest)
  tabId: string,
  revisionId: string,
  truncated: boolean,
  notRead: { footnotes, headers, footers, images, equations, otherChips, otherTabs },  // counts
  pieces: Piece[]               // ordered, contiguous, covering [0, cpLength(text))
}
Piece = {
  rs: number, re: number,       // cp range in text, half-open
  ds: number|null, de: number|null,  // u16 REST index range in the tab body; null = synthetic
  kind: 'text'|'synthetic',
  flags: { suggested: bool, atomic: bool, link: bool },
  para: number                  // ordinal of the source paragraph (for DocumentApp selection)
}
```

Helpers (exported, tested): `cpLength(s)`, `cpSlice(s, start, end)`, `cpToU16(s, cp)`,
`toRestRanges(pieces, rs, re, text) -> { ranges: [{startIndex, endIndex}], clean: bool } | null`
(`text` = the Serialized text the pieces index: a piece holding an astral character has
`re - rs != de - ds`, so the u16 offset inside a piece is computed from the text, never linearly)
(`null` when [rs,re) is not inside `pieces`; `clean` false when it touches a synthetic, atomic,
suggested or link-syntax piece or crosses a paragraph).

Details settled by `serialize.js` (⚑ = still to check against a real Doc; the spike of
2026-09-30 settled the rest, `test/real-spike.test.js`):
- "A paragraph with no text" is the .docx reader's: no character other than tab / soft break (spaces count).
  A page or column break is `\n`, an `atomic` text piece on its one index (the .docx export writes
  `<w:br w:type="page"/>`, read as a line break).
- Every linked run is its own `[words](url)`, even beside a run with the same url: the export writes
  one hyperlink per run (`[two ](u)[runs](u)`); links to a heading, bookmark
  or tab are plain words (the .docx export writes them as anchors, which the reader does not bracket).
- A table of contents is read, as the reader reads the export's contents paragraphs ⚑; its suggestion
  ids propagate like a table's. U+E907 (the API's stand-in for non-text content) is not read, is
  counted in `otherChips`, and stays a gap in the map.
- A Person chip is `[name](mailto:email)` (the export's form; the name atomic, flagged `link`); with
  no email, the name alone, atomic.
- The export of a Doc with several tabs holds every tab, each under a paragraph with its title; the
  add-on reads the active tab only (a known difference from the Doc-link route).
- `para` = ordinal of the paragraph among every Paragraph in the tab body in document order (table
  cells and contents included, empty and deleted ones counted): the spike's 23 REST paragraphs were
  DocumentApp's 23. `Paragraph.getText()` leaves chips, page breaks and footnote marks out, so an
  offset is counted over the paragraph's children (a non-text child = 1), as the glue does ⚑ (the
  children walk runs in the next spike check).
  A `\n\n` break carries the ordinal of the paragraph before it.
- `notRead`: `headers` / `footers` count only segments holding text; `footnotes` = footnote
  references in the body; `images` = inline + positioned objects; `otherChips` = autoText and any
  element this reader does not know; suggested-deleted elements (positioned objects included) and
  deleted header/footer text are not counted.
- The cap backs out of a link (a Doc link or `[..](..)` typed as text), a chip, and a trailing
  `\n\n` (whole or half), so `text` never ends in a paragraph break.
- `toRestRanges`: `clean` is also false when the range skips Doc content between two pieces (a
  suggested deletion, a footnote reference, an image); an atomic piece maps to its whole element;
  an empty range `[x, x)` is a caret inside the piece holding `x`. An unknown `tabId` throws.
- Parity: `test/fixtures/parity/basic.{docx,txt}` + `hand-parity-basic.json` are one document through
  both doors (`scripts/build-parity-docx.py`, `test/fixtures/docs/build.js` rebuild them); each
  `.txt` is the text Lenz's .docx reader gives for its `.docx`.

## place.js — `LenzPlace`

```
locate(target, ctx) -> Placement
target = { kind: 'claim'|'citation'|'edit', start: cp, end: cp,
           text?: string,                       // claim passage / edit slice; null for citation
           passage?: {start, end, text},        // edit only: its claim position
           replacement?: string }               // edit only
ctx = { snapshot: string,                        // the text sent (after local Apply updates)
        live: Serialized,                        // freshly serialized now
        liveHash: string, snapshotHash: string }
Placement = { status: 'placed'|'changed'|'unplaceable', reason?: string,
              rs, re,                            // cp in live.text
              ranges: [{startIndex, endIndex}],  // u16 REST
              applicable: boolean }              // edit only: clean one-piece span, no newline
```

- Same hash (`liveHash === snapshotHash`, both set; without hashes, `snapshot === live.text`) → the
  target's offsets apply directly to `live`; no snapshot needed.
- Otherwise anchor = passage + 40 cp either side from the snapshot. The passage must occur exactly
  once in the snapshot, the anchor exactly once in the snapshot AND exactly once in the live text.
  Edits are located inside their located passage (never searched for on their own). A citation's
  passage is the snapshot's `[start, end)`.
- Whatever the path, the live slice must equal `target.text` (when not null) to be placed.
- Reasons. `changed` (the words changed since the check): `not_found`, `ambiguous_live`,
  `ambiguous_snapshot` (passage or anchor twice in the snapshot), `text_differs`.
  `unplaceable`: `no_snapshot` (drift and no snapshot), `snapshot_mismatch` (the snapshot does not
  hold the target's text), `out_of_range`, `edit_outside_passage`, `empty`, `unmapped`
  (`toRestRanges` null). Non-placed results carry `rs`/`re` null and `ranges: []`.
- `applicable` = placed edit, non-empty, exactly one REST range inside exactly one `text` piece with no
  suggested/atomic/link flag and `clean`, and no line break (`\n`, `\r`, `\u000b`) in `text` or
  `replacement` (the .docx writer's rules).
- Target builders from the review body: `claimTarget(claim, i)` (the i-th of `positions`, "1 of N"),
  `editTarget(claim, j)` (the j-th of `suggested_edits.edits`, its passage = `positions[edit.position]`),
  `citationTarget(citation)` (`text: null`). Each returns `null` when the index does not exist.

`applyToSnapshot(snapshot, edit) -> { snapshot, shift } | null`: the snapshot with the
replacement made and `shift(cp) -> cp|null` (unchanged at or before `edit.start`, moved by the length
change at or after `edit.end`, `null` strictly inside). `null` when the snapshot does not hold
`edit.text` at `[start, end)`. The glue then sets `snapshotHash` to the new snapshot's hash.

`rebase(target, applied) -> target | null`: `applied` = the edits applied so far, in order, each as it
was applied (i.e. itself rebased). A target before an edit is unchanged, after it is shifted, around
it grows and its `text` (and an edit's `passage.text`) takes the replacement; a target that partly
overlaps an applied edit is `null` (drop it). Store the review's targets once; rebase at use.

## api.js — `LenzApi`

`create(deps) -> client`

```
deps = {
  fetch(req) -> { code, headers, text }           // req = {method, url, headers, payload}; never throws
  store: { get(k) -> string|null, set(k, v), del(k) }      // User properties (small values)
  cache: { get(k) -> string|null, put(k, v, ttlS), del(k) } // User cache; chunking is the glue's job
  sha256(s) -> hex, now() -> ms, base: 'https://lenz.io/api/v1', userAgent: string,
  getToken({force}) -> {token|null, signedOut}     // signed in with Lenz (src/oauth.js), or:
  apiKey: string                                   // the dev key
}
client.submit({ docId, tabId, text, policy }) -> SubmitResult   // policy = the escalate block; default below
client.runAgain({ docId, tabId }) -> void          // bumps attempt
client.poll(docId, tabId) -> PollResult             // one GET; caller schedules the next
client.record(docId, tabId) -> Record|null
client.snapshot(reviewId) -> string|null            // the text that review was run on (user cache, 6 h)
client.edit(reviewBody, claimIndex, editIndex) -> Edit|null   // server-side source of truth for Apply
describeError(code, headers, body) -> ApiError

SubmitResult = { ok, reviewId|null, state, replayed: bool, nextPollS|null, error: ApiError|null }
PollResult   = { ok, status|null, body|null, terminal: bool, nextPollS|null, error: ApiError|null }
ApiError     = { code,            // HTTP status; 0 = no response
                 apiCode|null,    // the body's `code` when it is JSON
                 message, retryable, retryAfterS|null }
Record       = { reviewId|null, key|null, tabId, textHash, attempt, submittedAt, state, pollFailures,
                 submitFailures }
Edit         = { claimIndex, editIndex, start, end, text, replacement, position,   // cp, as sent
                 passage: {start, end, text}|null }   // claims[i].positions[position]; null on view=issues
```

- Key = `sha256(docId|tabId|sha256(text)|policyJSON|attempt)`, policyJSON with its keys sorted.
  The Record and the exact request body (cache `lenz:body:<key>`, 6 h) are written **before** the POST.
  Store key `lenz:rec:<docId>:<tabId>`.
- Record `state`: `submitting` (sent, answer not known) · `pending_conflict` (409 with `review_id: null`)
  · `running` · `completed` · `failed` · `rejected` (Lenz said no before a review existed: any JSON
  4xx, a 503 with a code, Cloud Armor's 429) · `lost` (403/404/410 on a poll; attempt already bumped)
  · `unknown` (pending, but its cached body expired) · `idle` (after Run again).
- `submit` settles a `submitting` / `pending_conflict` record first by replaying its cached body with
  its key, whatever the Doc says now; `unknown` refuses until Run again (the rare double-charge case,
  stated to the user). A replay Lenz refuses (Cloud Armor, 401, 402, 503) keeps the record pending:
  the first request may still have created a review; a replay answered `idempotency_body_mismatch`
  can never be accepted and becomes `unknown` (Run again). While pending, `nextPollS` is when to
  submit again: 5, 10, 20, 40, then 60 s, or a longer Retry-After. Same key with a `reviewId` → that review, no request. A 202 or a 409 carrying
  `review_id` stores it and copies the sent text to `lenz:snap:<reviewId>`.
- Poll reads `poll_after_seconds` (15 when a running body has none); the first poll waits the POST's
  `Retry-After` (20 without one); every wait ≥ 3 s. No response, a non-JSON 200 or a 5xx backs off
  5, 10, 20, 40, 60 s; a 429 waits its Retry-After (60). Terminal: `status` `completed` | `failed`,
  and 401/403/404/410. A poll whose record changed during the GET (Run again, a new submit) writes
  nothing and returns `{ok: false, terminal: true, error: null}`: the caller stops that loop. The glue
  holds the user lock around submit, runAgain and poll.
- `describeError` covers 401, 402, 403, 404, 409, 410, 422 (`idempotency_body_mismatch` and the rest),
  429 (`review_in_flight`, `extract_daily_limit`, the Cloud Armor non-JSON body), 503 `capacity`,
  other 5xx, transport failure. Messages live in `LenzApi.MESSAGES`: plain, short, no blame, say
  what to do.
- `edit` finds the claim by its `index` field (`issues[].claim_index` on `view=issues`), and returns
  null for anything not a settled, well-formed edit; it never trusts client text.
- Body sent: `{text, webhook_url: '', visibility: 'private', escalate: {suggest_edits: true,
  max_citations: 20, max_assessments: 20, max_verifications: 5, depth: 'standard'}}`.

- Signed in (`getToken`): each request's bearer is `getToken({force: false})`. A 401 is answered by
  ONE `getToken({force: true})` and the same request again (a 401 comes before Lenz does anything);
  a second 401 is the answer, with `MESSAGES.signed_out`. `getToken` signed out → nothing is sent,
  a 401 `{code: 'signed_out'}`; no token for now (Lenz unreachable for a refresh) → nothing sent,
  code 0 (retryable; a submit stays pending and replays). With `apiKey`, a 401 is not retried.

## oauth.js — `LenzOAuth`

"Sign in with Lenz": authorization code + PKCE S256 for a public client, against
`https://lenz.io/api/v1`. Hand-rolled, not apps-script-oauth2: that library carries the PKCE verifier inside
the state token (through the browser, next to the code) and draws it from `Math.random`.

```
create(deps) -> client
deps = { fetch, store (User properties), now() -> ms, randomId() -> hex (Utilities.getUuid),
         s256(verifier) -> base64url no padding, clientId, redirectUri: string | () -> string }
client.authorizationUrl(makeState) -> { ok, url|null, message|null }  // makeState(nonce) -> state
client.handleCallback(e.parameter) -> { ok, reason|null, message }
client.getToken({force}) -> { token|null, signedOut }
client.signedIn() -> bool;  client.signOut() -> void (revoke + forget);  client.forget() -> void
```

- URL: `response_type=code`, `client_id`, `redirect_uri`, `scope=verify offline_access` (a refresh
  token is minted only with `offline_access`), `state` (≤ 512, Lenz's limit; the glue's Apps Script
  state token carries only the nonce, as argument `n`), `code_challenge` (43 chars),
  `code_challenge_method=S256`, `resource=https://lenz.io/api/v1` (optional at Lenz, checked when
  sent; the token endpoint ignores it for these grants, so it is not sent there).
- The verifier (three UUIDs, 96 hex) stays in User properties under `lenz:oauth:pending`, keyed by the
  nonce: at most 3 waiting, 10 minutes each, single use (removed before anything else happens).
- Callback: unknown or used nonce → `stale`; `iss` must be `https://lenz.io/api/v1` (RFC 9207, Lenz
  sends it on every response) → else `wrong_issuer`; `error=access_denied` → `denied`; then the code
  is redeemed (form body: `grant_type`, `code`, `redirect_uri`, `client_id`, `code_verifier`; no
  Basic). A usable answer is Bearer, has `access_token` and grants `verify`.
- Tokens: `lenz:oauth:tokens` = `{access, refresh, expiresAt, scope}`. `getToken` rotates when under
  60 s is left or `force`; a refresh answer without a refresh token keeps the old one. `invalid_grant`
  when the stored refresh token has changed meanwhile (another execution rotated it) → the stored
  successor, never a sign-out; otherwise `invalid_grant` / `invalid_client` → forgotten, signed out.
  Unreachable / 429 / 5xx → still signed in, `{token: null}` (or the old token while it lasts, except
  after a 401). Lenz's 60 s reuse grace answers two executions' concurrent refreshes with the same
  successor; the glue's API calls run under the user lock anyway.
- Sign out: RFC 7009 revoke of the refresh token (it takes its whole authorization at Lenz), best
  effort, then forgotten.

## view.js — `LenzView`

`build(reviewBody, opts) -> Model`. `opts = { notRead, truncated, applied: {'<ci>:<ei>': true},
unplaced: {'<entryId>': reason} }` (all optional; the glue supplies them). Every string the sidebar
shows comes from here or from `LenzApi.MESSAGES`; the sidebar sets each as a text node.

```
Model = { reviewId, status, done, progress|null, headline|null, failure|null,
          groups: [{ key, title, collapsed, count, entries }],   // non-empty groups only
          coverage: string[], footnote|null, charged|null }
Entry = { id,                         // 'claim:<index>' | 'citation:<index>' (the body's indexes; stable across polls)
          kind, group, state, stateWords, title, label, token,   // token = verdict colour class or null
          check,                      // 'Quick check' | 'Deep check' | 'Citation check' | null
          confidence|null, score|null, rewrite|null,
          deepRunning,                // a quick verdict whose deep check is still running (shown as such)
          lines: [{ lead|null, text }], link: {href, words}|null, source: {href, words}|null,
          edits: [{ id: '<ci>:<ei>', claimIndex, editIndex, from, to, applied }], editsNote|null,
          start|null, occurrences, placed, placeNote|null }
```

- Groups, in order, each in the Doc's order (then claim before citation): `issue` (`result.is_issue`,
  claims and citations interleaved), `look` ("Needs a closer look": `partly_supported`, a citation
  whose check could not decide, a claim the Workbench draws amber), `none` ("Not checked"), `ok`
  ("Checks out", collapsed only when an issue or a "look" entry is shown: a clean Doc shows what was
  checked). The state of a row is the one Lenz's Workbench gives it; an issue stays in `issue`
  whatever its colour. Words: the ones Lenz uses for findings elsewhere.
- While the review runs, a row with no result yet whose check has not failed is in `pending`
  ("Checking", between `look` and `none`), with "Checking."; "Could not be checked this time." only
  for a terminal `failed` status or a finished review with no result for the row. While edits are
  worked out there is no line: the verdict's "deep check running" says enough.
- Coverage lines: truncated (the API's `input_truncated` or the serializer's), `more_claims`,
  `more_citations`, failed quick checks, failed deep checks, unchecked and failed citation checks,
  `citations_skipped`, findings not in the Doc as it is now, `notRead`, `outcome: incomplete`.
- A link only to `https://lenz.io/c/` (the claim page, "See sources in Lenz"); a source only over http(s).
- `stages` (running only, else null): `[{key, label, done, total, complete}]`: `reading` ("Finding the
  claims", before the claims are read), `quick` (assessments completed+failed of `claims_selected`),
  `deep` (verifications completed+failed of `planned`, once planned > 0), `citations`
  (checked+unchecked+failed of `citations_selected`, once > 0). No percentage.
- `row(body, entryId) -> { kind, row } | null` finds an entry's row again in a fresh body;
  `rows(body)` lists every claim and citation row by id. Targets come from `LenzPlace`'s builders.

## Code.js — glue

Server functions the sidebar may call — **ids only, never text** (the dev
key in `lenzSaveKey`, reached from Dev tools → Use an API key…, is the one exception; it is in
`src/dev-tools.js`, which the public build leaves out):

```
lenzState() / lenzPoll() / lenzStart() / lenzSignOut() / lenzSaveKey(key) -> Reply
lenzSignInUrl() -> { url|null, message|null }        // opened by the sidebar in a new window
lenzShowPicker() -> { openedAt }                      // opens picker.html (modal); server ms
lenzPickerConfig() -> { token, apiKey, appId, docId } // picker.html: the script's own token, the
                                                      // flavour's Picker key + project number
lenzFileAccessGranted(docId) -> { ok, message|null }  // picker.html after a pick: the open Doc only
lenzFileAccessReady(since) -> { ready }               // the sidebar, waiting for the grant
lenzOpenState() -> Reply                              // on opening: lenzState, and on idle one
                                                      // revision probe (needs_file_access at once)
lenzAutoStart() -> Reply                              // after a grant asked for on opening
lenzOAuthCallback(e) -> HtmlOutput                    // the usercallback (state token → this function)
lenzSelect(reviewId, entryId, occurrence) -> Note
lenzApply(reviewId, claimIndex, editIndex) -> Note | Reply & { ok: true, message }
lenzUndo(reviewId, claimIndex, editIndex)  -> Note | Reply & { ok: true, message }
Reply = { phase: 'signed_out'|'needs_file_access'|'idle'|'running'|'done'|'error', auth: { mode: 'oauth'|'key', signedIn },
          model: Model|null, nextPollS|null, error: {code, message, retryable, retryAfterS}|null,
          startedAt|null, notice? }  // notice: "No changes since the last check."   // running only: the record's submittedAt (ms); the sidebar ticks the elapsed time
Note  = { ok, message|null }
```

- `reviewId` in Select and Apply is the review the sidebar shows (`Model.reviewId`); the server
  refuses unless it is the active tab's current record, so a list left over from another tab or an
  earlier check never acts on the current one.
- `running` + `error` is a passing problem: polling goes on. A poll or a Check click on a
  `submitting` / `pending_conflict` record replays the cached request with its key WITHOUT reading
  the Doc (submit is called with empty text; LenzApi settles the pending request first), so an
  emptied or changed tab never blocks the replay or overwrites the metadata of the text sent.
- One button, **Check this Doc** (`lenzStart`; there is no Run again): a pending request
  is replayed with its key; a record `failed`, `lost` (403/404/410) or `unknown` gets
  `client.runAgain()` first, so the click is a NEW review and a failed receipt is never replayed;
  so does a `completed` review whose outcome was `incomplete` (`lenz:incomplete:<reviewId>`, set when
  the glue reads that body; the record does not carry the outcome);
  otherwise the text decides: changed → a new review, unchanged → the same review, and when it is
  complete the reply carries `notice: "No changes since the last check."` (no request, no charge).
- The user lock (`LockService.getUserLock`, 10 s) is held around submit and every GET of
  the review (poll, and the fresh read behind Select and Apply), never around a Doc read alone.
- Signing in: `LENZ_OAUTH_CLIENT_ID` (public; per build, from `config/flavours/<f>.json` through
  the generated `config.js`), redirect `https://script.google.com/macros/d/<script
  id>/usercallback` (the one registered at Lenz), state token → `lenzOAuthCallback` with argument
  `n`, 600 s. A saved dev key wins over a sign-in (internal build: `lenzApiKey_` asks
  `lenzDevApiKey_` in dev-tools.js; the public build has no such function, so no key is ever read). A 401 that a rotated token did not cure forgets the
  sign-in and answers `signed_out` with `LenzApi.MESSAGES.signed_out`; a pending request stays
  pending and replays once signed in again. With a dev key, the 401 is an error (pending: still
  running). Trial events `signed_in` / `signed_out` (doc and review null).
- Per-Doc access (`drive.file` + `documents.currentonly`): DocumentApp works on
  the open Doc (Select's selection), but a Docs REST call on a Doc the user has not granted this
  script answers 404 "Requested entity was not found." (measured; 403 "does not have permission" is
  treated the same, `lenzIsNoFileAccess_`). Every REST call goes through `lenzDocsCall_`, which turns
  that answer into a marked error; `lenzFileAccess_` around each server call's body turns it into
  `needs_file_access` (Select / Apply / Undo: the same reply, `ok: false`). Nothing happens first:
  the Doc is read before a record moves (`runAgain` comes after the read), the call's trial lines are
  dropped, the reply is not kept for open, a poll that must place a finished review answers
  `needs_file_access` instead of listing everything unplaced. A write refused for permission on a
  Doc that still reads (view or comment sharing) is a refusal saying so (`no_edit_permission`), not
  `needs_file_access`: picking the Doc again would not help (`lenzCanRead_`). The sidebar shows one line and "Allow
  Lenz to read this Doc"; `lenzShowPicker` opens `picker.html` (Google's Picker pattern for Apps
  Script: `DocsView(ViewId.DOCUMENTS).setFileIds(docId)`, `setOAuthToken`, `setDeveloperKey`,
  `setAppId`, `setOrigin(google.script.host.origin)`). On PICKED the dialog checks the id is the open
  Doc, then `lenzFileAccessGranted(docId)` checks it again, confirms with one REST read and writes
  `lenz:fileok:<docId>` = ms; the sidebar asks `lenzFileAccessReady(openedAt)` every 2 s (10 min at
  most) and then repeats what the user was doing (Check, the poll, Select, Apply, Undo). While it
  waits, Check this Doc is disabled; only the allow button acts. Asked on opening (`lenzOpenState`:
  an idle tab gets one `fields: revisionId` probe), the grant runs `lenzAutoStart`: a check already
  running is only refreshed, anything else is `lenzStart` (a completed review of unchanged text shows
  again with no new review or charge; no check or changed text starts one). Google keeps
  the grant per user and Doc. `LENZ_PICKER_API_KEY` / `LENZ_PICKER_APP_ID` come from the flavour
  (`pickerApiKey`, `pickerAppId`: a browser key restricted to the Picker API and Google's referrers,
  and the script's Cloud project number).
- Storage (User properties): `lenz:apiKey` + `lenz:apiKeySource = 'dev'` (internal build only: the
  dev key, set only by `lenzSaveKey`; a key without the marker was saved by the pre-OAuth first-run box and is deleted on
  the next read, logged `key_migrated`); `lenz:oauth:tokens`, `lenz:oauth:pending` (oauth.js); `lenz:meta:<docId>:<tabId>` = `{textHash, notRead,
  truncated}` of the text last read (used only when it matches the record's `textHash`);
  `lenz:applied:<reviewId>` = `{edits, snapshotHash}`: the applied edits, each as it was applied
 , and the hash of the snapshot with all of them made, computed at Apply (from the cached
  snapshot, else from the live text when it was the snapshot) and stored, so an unchanged Doc still
  places after the 6 h cache drops the snapshot. The snapshot is `client.snapshot(reviewId)` with the
  applied edits replayed through `applyToSnapshot`; `snapshotHash` = the record's `textHash` until
  the first Apply, then the stored one.
- The key is checked only for a `lenz_` prefix and no spaces; Lenz answers the rest (401).
- Adapters: UrlFetchApp (`muteHttpExceptions`, `followRedirects: false`, `Content-Type` passed as
  `contentType`, response header names lower-cased, a thrown fetch = `{code: 0}`); User properties;
  User cache with chunking (`<key>#<n>` chunks of ≤ 20,000 UTF-16 units, never splitting a surrogate
  pair, then a `{n, len}` head under the key, written last; a missing chunk or wrong length is a miss);
  `Utilities.computeDigest` sha256 → lower-case hex.
- Apply: the edit from `client.edit` on a fresh GET; placed and `applicable`; one
  `Docs.Documents.batchUpdate` = `insertText` of the replacement at the END of the old words (so it
  takes the replaced run's style) + `deleteContentRange` of the old words, with
  `writeControl.requiredRevisionId` = the revision just read; a revision conflict → re-read, retry
  once. Inserting at the start would take the style of whatever precedes the edit ("See
  [NASA](url)1998" became "[NASA1969](url)") (spike: inserting before a whole link lost the link;
  inserting after the first character kept link and bold; the END order runs in the next check ⚑).
- Undo (the spike: Cmd+Z does not reach an API edit, so the sidebar has an Undo per applied edit):
  the edit from a fresh GET, rebased through every applied edit, lands on its own replacement; that
  span must still read the replacement (placed, `applicable`), then one batchUpdate inserts the old
  words at the end of the replacement and deletes the replacement, with `requiredRevisionId`; a
  conflict re-reads once. The applied list drops the edit and shifts the later ones back
  (`lenzWithoutApplied_`); a later edit touching its words refuses ("undo that one first"). No
  inverse helper in place.js is needed. The Apply message says "Undo it here, or restore an earlier
  version from File → Version history."
- Quick-first edits (the block stays `{status, edits}`, with no source): a claim's block shows its quick check's edits first; when the deep check ends they stay
  while its edits compute, then the deep result replaces the block (new edits and indexes, `[]`, or
  null; a failed deep check keeps the quick ones). The sidebar re-renders on every change and names
  no method (the verdict's "deep check running" is the only mark). An edit is known by its content,
  `LenzView.editFp(start, end, text, replacement)` (span + a hash of words and replacement), never by
  its index: `lenzApply` / `lenzUndo` take `(reviewId, claimIndex, editIndex, fp)`; Apply refuses
  when the edit at that index is no longer the one shown ("This suggestion changed"), and when it
  overlaps an applied edit's original span (`suggest` in the view: "Now suggested", no Apply; Undo
  that one first). An applied record keeps the edit as offered (`claimIndex`, `orig` span,
  `origText`, replacement, `position`, the passage span; its words are cut from the snapshot, and
  without one the review's edit is used only if it is the same content), so a replacing block's
  identical edit reads applied and an applied edit the block no longer lists stays ("Applied
  earlier", with its Undo by fingerprint, index -1). Records are `claim:fp`; an older add-on's
  `claim:edit` record, and a click without a fingerprint, go by index.
- Keep the applied edits (`claimIndex`, `editIndex`) per review and refuse a second Apply of one:
  `rebase` maps an applied edit onto its own replacement, which would place and "apply" again.
- Select: both sides walk the tab's paragraphs in the same order (body, table cells, table of
  contents); a REST range falls in the Nth REST paragraph → the Nth DocumentApp paragraph, offset =
  u16 distance from the paragraph's `startIndex`; inside it a Text element counts its characters and
  any other inline element 1. Spike item 3 confirms the alignment.
- Placement pass: when a review is terminal, one Doc read places every row; the misses go to
  `build` as `unplaced`.
- Dev (internal build, `src/dev-tools.js`): Extensions → Lenz Fact-Checking → Dev tools → "Dump this tab's JSON" writes the active tab's REST JSON into
  new Google Docs it creates and writes through REST (`lenzRestCreateDoc_` = `Docs.Documents.create`,
  `lenzRestAppend_` = one `insertText` at `endOfSegmentLocation`), 400,000 characters per Doc, and
  logs their URLs.
- Docs the add-on creates (the trial log, the dump, the e2e's spike Docs) go through the Docs REST
  API only: an add-on-made file is covered by `drive.file` without the Picker. No src file calls
  `DocumentApp.create` / `openById` (they need `documents`; a test bans them). DocumentApp is used
  on the open Doc only (`getActiveDocument`, the selection, the menu, dialogs). The trial log's REST
  create and append run inside the drain's lock after its `lenzSessionOk_` check, so a call that
  began before a sign-out makes and writes no log Doc.
- Apply is refused before the Doc is written when the applied state would pass 8,500 bytes (User
  properties hold 9 KB a value), so a written edit is always recorded.
- Trial log (`docs/trial.md`): every server call buffers its events and flushes them at the end, to
  the Apps Script log (`lenz_trial <json>`) and as paragraphs of the user's "lenz-gdocs trial log"
  Google Doc (created on first use through REST, id in `lenz:trialLogDoc`; each flush is one
  `insertText` at the end; a stored log the script cannot write, e.g. one DocumentApp made before
  per-Doc access, is replaced once by a new one). Ids
  only. `review_done` once per review (`lenz:trialDone:<reviewId>`), `charged` (credits; the sidebar shows no charge), `findings` = every placement
  target (claim positions, citations, edits), `edits` = the edits among them; the placement pass logs
  `placed` / `changed` / `unplaceable` for each, on every re-placement. `undone` / `undo_refused`
  (`finding`, `passage`, `reason`) for Undo clicks. `wrong` comes from the dev menu
  and names the last selection / Apply (`lenz:last:select`, `lenz:last:apply`). Switch:
  `LENZ_TRIAL_LOG` (`config.js`, the flavour's `trialLog`): on in the internal build, off in the
  public one. Off, nothing of it happens: no trial Doc opened or created, no `lenz:trialPending:*`,
  `lenz:trialDone:*`, `lenz:last:*` or `lenz:trialLogDoc` written, no `lenz_trial` log line.
- Read cache (`lenzRead_`): every read first gets `fields: 'revisionId'`; a cached `{live
  (Serialized), paras (REST paragraph index)}` under `lenz:read:<sha(docId|tabId|revisionId|
  LENZ_SERIALIZER_SHA|v)>` (chunked user cache, 6 h) is used when its revision matches, else a full
  read is cached under the revision it returned. `LENZ_SERIALIZER_SHA` = first 16 hex of
  sha256(`src/serialize.js`), pinned by a test: **a serialize.js change must update it** (the test
  prints the value). Apply keeps `requiredRevisionId`, so a map can never write to words it no
  longer describes. Log: `lenz_read mode=cached|full ms= rev_ms= pieces=` (numbers only).
- After our own write (Apply, Undo): no re-read. `lenzMapAfterWrite_` moves the map in place (the
  one text piece grows or shrinks, later pieces and REST paragraphs shift, the edited paragraph's
  text changes) and caches it under the revision the batchUpdate returned; null (a full read next
  time) when that revision is missing, the tab is capped, or the piece would empty. Tested equal to
  a fresh serialize after each Apply and Undo, both orders.
- A completed review's body is kept in the user cache (`lenz:done:<reviewId>`, 6 h) by the poll that
  saw it complete; Select, Apply and Undo take it from there (no GET); a miss GETs.
- `lenz_apply op= ms_total= ms_review= review=cached|get ms_rev= ms_read= mode=cached|full ms_write=
  ms_after= ms_state= ms_map= ms_place= ms_view= ms_keep= ms_trial=`: one line per Apply / Undo that
  wrote; `ms_after` = state + map + place + view (from the write to the reply); keep and trial follow
  it; `ms_total` runs to the end of the call.
- The trial log leaves the click: Check, Select, Apply and Undo write their lines under their own
  user property, `lenz:trialPending:<ms>-<seq>-<rand>` (one write, no read; two windows never
  overwrite each other), instead of opening the log Doc. The next poll, state call or "Open the
  trial log" drains under the user lock (a busy lock: the next poll does), with the properties read
  fresh: every waiting key in time order into the Doc, then exactly those keys deleted. A click
  drains itself past 8 waiting keys (counted on the copy read inside its lock). A Doc that cannot be
  written leaves the keys waiting (oldest dropped past ~40 KB) and never fails the call. Only trial
  lines live there.
- The glue's own cache writes in a scope (the map moved after a write, the reply kept for open, a
  completed body) are deferred and go out as one `putAll` per TTL at the end of the call
  (`lenzCachePut_` / `lenzCacheGet_`: reads in the same call see them). `api.js`'s writes never
  wait (its request body must be cached before the POST). An Apply's writes after the Doc write:
  one `setProperties`, one `setProperty` (trial), one `putAll`; no Doc opened.
- One call's scope (`lenzScoped_`: poll, Select, Apply, Undo, open): the first user-property read
  loads every property with one `getProperties()`; writes go through and update that copy; the copy
  is dropped whenever the user lock is acquired or released (reads see other calls' writes; a store
  made before the lock looks the copy up on every operation, never holds it); the
  snapshot is read once per review. Nothing outlives the call. The placement pass prepares the
  applied state and the snapshot once for every finding. The applied state and the last action are
  one `setProperties`; a chunked cache value is one `putAll` (head included; readers check every
  chunk and the length). An Apply: ≤ 2 property reads, 1 property write, ≤ 8 cache calls (was 26
  reads, 2 writes, 34 cache calls; a test pins it).
- Opening: `lenzOpen()` answers first with the last reply kept for the doc + tab
  (`lenz:open:<docId>:<tabId>`, written at every poll / submit / Apply / Undo reply that carries
  state; a running placeholder never replaces it) and `stale: true`, or idle / signed out, with no
  Lenz call and no Doc read; the sidebar shows it with "Updating…", then calls `lenzState`.
  `lenzLogOpen(msFirst, msFull)` logs `lenz_open ms_first= ms_full=` (numbers only).
- One implementation per action, taking a context: `lenzSubmitIn_(ctx, again)`, `lenzPollIn_(ctx)`,
  `lenzApplyIn_(ctx, reviewId, ci, ei)`. The sidebar's functions pass `lenzContext_()` (the active
  Doc and tab); `lenzContext_(docId)` is that Doc's first tab.
- Headless e2e (`src/dev-e2e.js`, `clasp run`): `lenzDev_e2eCreateDoc(title, text)` makes the spike
  Doc through REST (title "Lenz spike…"; an add-on-made file, so `drive.file` covers it) and returns
  `{docId, url}`; `lenzContext_(docId)` opens a Doc by id through REST only (first tab, `title`, no
  DocumentApp). `lenzDev_e2eStart(docId)` submits with the saved key;
  `lenzDev_e2eStep(docId)` polls once and, when the review is done, places every finding and applies
  every edit through `lenzApplyIn_`, returning `{phase, reviewId, headline, coverage, charged,
  placements[], applies[], before, after, done}`. Only a Doc titled "Lenz spike…". Select is not
  covered (it needs the Doc open).
- Dev menu (Extensions → Lenz Fact-Checking → Dev tools; `lenzDevMenu_` in `src/dev-tools.js`,
  added by `onOpen` only when that function exists): dump, the two "wrong words" flags, "Open the
  trial log", "Use an API key…", and the spike kit's submenu (`lenzDev_menuSelect`,
  `lenzDev_menuCheck`, in `src/dev.js`). The public build's menu is "Check this Doc" alone.
- Manifest scopes (`config/flavours/<f>.json`): both builds `drive.file`, `documents.currentonly`,
  `script.container.ui`, `script.external_request`: no `documents` (all the user's Docs). The internal
  build keeps the spike kit's Drive URL (its .docx export; `urlFetchWhitelist` adds `https://www.googleapis.com/drive/v3/files/` for it) and
  `executionApi: {access: MYSELF}` for `clasp run` of dev functions (the owner only, no scope). The
  public build fetches `https://lenz.io/` only and has no `executionApi`. An Editor add-on
  needs no `addOns` section (that is for card-based Workspace add-ons); its menu is
  `createAddonMenu`.

## Working rules

- Tests first for every pure module; `npm test` green before a PR.
- One branch + PR per change; never push to `main` directly. Conventional commit subjects.
- `bash scripts/check-public.sh` must stay clean (CI runs it): no personal names, local paths or
  internal project ids in the tree.
- Real `/review` calls cost credits: the captured responses in `test/fixtures/reviews/` are what the
  tests use (`docs/live-smoke.md`).
