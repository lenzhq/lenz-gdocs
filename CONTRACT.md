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

`serialize(doc, tabId, opts?) -> Serialized`

- `opts.cap`: the code points kept (default `CAP`, 50,000). `Infinity` reads the whole tab, never
  `truncated` (a selection check slices it, and places its findings in it). The default is unchanged.

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
                                                   // (every request also carries X-Lenz-API-Version)
  getToken({force}) -> {token|null, signedOut}     // signed in with Lenz (src/oauth.js), or:
  apiKey: string                                   // the dev key
}
client.submit({ docId, tabId, text, policy, snapshot?, offset?, scope? }) -> SubmitResult
                                                   // policy = the escalate block; default below.
                                                   // A selection check: `text` is the slice,
                                                   // `snapshot` the whole tab's text, `offset` (cp)
                                                   // where the slice starts in it, `scope` kept as is
client.runAgain({ docId, tabId }) -> void          // bumps attempt
client.resume(docId, tabId) -> bool                 // a fresh window of failed polls; the same review id, no request
client.poll(docId, tabId) -> PollResult             // one GET; caller schedules the next
client.cancel(docId, tabId) -> PollResult           // POST /reviews/{id}/cancel; the review as it stands
client.record(docId, tabId) -> Record|null
client.snapshot(reviewId) -> string|null            // the text that review was run on (user cache, 6 h);
                                                    // a selection check's: the whole tab at submit
LenzApi.shiftBody(body, offset) -> body             // every draft position moved by offset, in place
LenzApi.readCancelled(body) -> body                 // the older cancelled shape read as `cancelled`, in place
LenzApi.TERMINAL = { completed, failed, cancelled } // the review states after which nothing more happens
client.edit(reviewBody, claimIndex, editIndex) -> Edit|null   // server-side source of truth for Apply
describeError(code, headers, body) -> ApiError

SubmitResult = { ok, reviewId|null, state, replayed: bool, nextPollS|null, error: ApiError|null }
PollResult   = { ok, status|null, body|null, terminal: bool, nextPollS|null, error: ApiError|null,
                 gaveUp: bool }       // failed polls for 5 minutes with no success: poll no more until resume
ApiError     = { code,            // HTTP status; 0 = no response
                 apiCode|null,    // the body's `code` when it is JSON
                 message, retryable, retryAfterS|null }
Record       = { reviewId|null, key|null, tabId, textHash, attempt, submittedAt, state, pollFailures,
                 pollFailingSince|null, submitFailures,
                 offset?, snapshotHash?, scope? }   // a selection check only (absent otherwise)
Edit         = { claimIndex, editIndex, start, end, text, replacement, position,   // cp, as sent
                 passage: {start, end, text}|null }   // claims[i].positions[position]; null on view=issues
```

- Key = `sha256(docId|tabId|sha256(text)|policyJSON|attempt)`, policyJSON with its keys sorted. A
  selection check appends `|sel:<offset>:<sha256(snapshot)>`: the same words at another place, or in
  a tab that changed around them, are another review, so a review id (with its done body, snapshot
  and applied edits, all in whole-tab coordinates at one offset) is never reused at another offset.
  A whole-tab key is unchanged.
  The Record and the exact request body (cache `lenz:body:<key>`, 6 h) are written **before** the POST.
  Store key `lenz:rec:<docId>:<tabId>`.
- Record `state`: `submitting` (sent, answer not known) · `pending_conflict` (409 with `review_id: null`)
  · `running` · `completed` · `failed` · `cancelled` (the user stopped it) · `rejected` (Lenz said no before a review existed: any JSON
  4xx, a 503 with a code, Cloud Armor's 429) · `lost` (403/404/410 on a poll; attempt already bumped)
  · `unknown` (pending, but its cached body expired) · `idle` (after Run again).
- `submit` settles a `submitting` / `pending_conflict` record first by replaying its cached body with
  its key, whatever the Doc says now; `unknown` refuses until Run again (the rare double-charge case,
  stated to the user). A replay Lenz refuses (Cloud Armor, 401, 402, 503) keeps the record pending:
  the first request may still have created a review; a replay answered `idempotency_body_mismatch`
  can never be accepted and becomes `unknown` (Run again). While pending, `nextPollS` is when to
  submit again: 5, 10, 20, 40, then 60 s, or a longer Retry-After. Same key with a `reviewId` → that review, no request. A 202 or a 409 carrying
  `review_id` stores it and copies the sent text to `lenz:snap:<reviewId>`; for a selection check,
  the whole tab's text, cached before the POST under `lenz:scopesnap:<key>` (6 h; deleted once
  copied, and by sign-out while pending). Evicted by then: no snapshot (never the slice). `runAgain` drops `offset`, `snapshotHash` and `scope`.
- Selection check: a poll moves every draft position of a 200 body by the record's `offset`
  (`shiftBody`, once, as the body arrives), so the glue, the kept done body, the applied records
  and the fingerprints all work in the whole tab's coordinates. The fields: `claims[].positions[]`,
  `claims[].suggested_edits.edits[]`, `issues[].suggested_edits.edits[]`, `citations[].position`,
  `citation_issues[].position`, `citation_failures[].position`, `more_claim_locations[].positions[]`,
  `more_citations[].position`; only objects with integer `start` and `end`.
- Poll reads `poll_after_seconds` (15 when a running body has none); the first poll waits the POST's
  `Retry-After` (20 without one); every wait ≥ 3 s. No response, a non-JSON 200 or a 5xx backs off
  5, 10, 20, 40, 60 s; a 429 waits its Retry-After (60). A streak of such failures that lasts 5
  minutes (`pollFailingSince`, cleared by any answer) ends with `gaveUp: true` and no `nextPollS`; the
  record keeps its review id and state `running`. `resume` clears the streak so the next poll is a
  fresh window. Terminal: `status` `completed` | `failed` | `cancelled`,
  and 401/403/404/410. A poll whose record changed during the GET (Run again, a new submit) writes
  nothing and returns `{ok: false, terminal: true, error: null}`: the caller stops that loop. The glue
  holds the user lock around submit, runAgain and poll.
- `cancel`: `POST /reviews/{reviewId}/cancel`, no body, no Idempotency-Key (Lenz takes a
  repeat as a no-op and answers with the review either way). A 200 is settled like a poll's: shifted,
  `readCancelled`, the record's state from its `status` — `cancelled`, or `completed` / `failed` when
  the review ended before the cancel reached it (that answer is the result; nothing calls it
  cancelled). A record already terminal sends no cancel: it is a poll. No review id yet → no request,
  `MESSAGES.cancel_not_started`. 403/404/410 → `lost`, as on a poll. Anything else (no answer, a 5xx, a
  non-JSON 200) leaves the record `running` with the error and `terminal: false`: polling goes on and the
  same request may be sent again. A record that changed during the POST writes nothing (as on a poll).
- `describeError` covers 401, 402, 403, 404, 409, 410, 422 (`idempotency_body_mismatch` and the rest),
  429 (`review_in_flight`, `extract_daily_limit`, the Cloud Armor non-JSON body), 503 `capacity`,
  other 5xx, transport failure. Messages live in `LenzApi.MESSAGES`: plain, short, no blame, say
  what to do. The wait: the `Retry-After` header first, then the body's `retry_after`, then the older
  names (`retry_after_seconds` on `review_in_flight`, `reset_in_seconds` on `extract_daily_limit`).
- Every request to `/review` (the POST and each poll) sends `X-Lenz-API-Version: 2026-10-11`
  (`LenzApi.API_VERSION`), also when sent again with a rotated token or as a replay of a lost POST.
  The header is not part of the Idempotency-Key or the body, so a replay across an add-on update is
  still the same request. The sign-in calls (`src/oauth.js`) are the OAuth endpoints and carry none.
- Both answer shapes of the API are read, whichever the header selects. Of the fields read,
  these differ: what failed is `failure.code` (current) or `failure.failure_reason` (older), on the
  review and on a deep check; the current `no_checkable_claim` reads as the older word for that place
  (`no_claim` on a review, `not_a_claim` on a deep check); a quick check with no verdict has `verdict`
  null (current) or `"Error"` (older); an unfinished quick check's own hint is the row's `hint` (older)
  or its `failure.hint` (current), shown only where the older answer's was; a 429's wait is named as above. `more_claims` on the review body
  is the same in both. A cancelled review is `status: cancelled` (current) or `failed` with a `cancelled`
  failure (`failure_class`, or `failure_reason` / `code`; older): `readCancelled` turns the older one
  into the current one as the body arrives (poll and cancel), so the glue and the view know one word.
  `test/api-shapes.test.js` runs both shapes of each answer in
  `test/fixtures/api-shapes/` against `expected.*.json`, what the add-on produced from the older answer
  before it read the current one (written by `test/helpers/api-shapes-oracle.js` from commit
  cea222bcc01170a5abfec085584bd62d6897f957 only).
- `edit` finds the claim by its `index` field (`issues[].claim_index` on `view=issues`), and returns
  null for anything not a settled, well-formed edit; it never trusts client text.
- Body sent: `{text, webhook_url: '', visibility: 'private', language: 'auto', escalate:
  {suggest_edits: true, max_citations: 20, max_assessments: 20, max_verifications: 5, depth:
  'standard'}}`. The empty `webhook_url` is deliberate: on /review it means no webhook for this review;
  leaving it out would use the key's default webhook.
- `language: 'auto'` is in every `/review` POST (the whole tab and a selection both go through
  `submit`, the one place the body is built): Lenz detects the language once, from the text it
  receives, and writes the review (claims, reasoning, rewrites, suggested edits) in it; a short or
  undetectable text comes back in English. The body is stored before the first send and a replay sends
  those stored bytes, so a retry, a rotated-token resend and a replay after a lost reply carry it
  too and the `Idempotency-Key` still binds the same body. The add-on needs a Lenz API that accepts
  `auto` on `/review`; one that does not refuses the request. The answer's `language` (the
  resolved code, or `auto` while a page is still being read) is not read: positions, `suggested_edits`
  and the replay contract are as before, and nothing in the add-on depends on the review's language.
  The add-on's own text (buttons, headings, the messages in `MESSAGES`) stays English.

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
unplaced: {'<entryId>': reason}, scope: {paragraphs, gap}|null }` (all optional; the glue supplies them). Every string the sidebar
shows comes from here or from `LenzApi.MESSAGES`; the sidebar sets each as a text node.

```
Model = { reviewId, status, done, progress|null, headline|null, failure|null, failureLink|null,
          groups: [{ key, title, collapsed, count, entries }],   // non-empty groups only
          coverage: string[], scope|null, footnote|null, charged|null,
          cancelled?, stopped? }  // a cancelled review only (absent otherwise, so every other
                                  // model is unchanged): `stopped` = what stays + Lenz's charge
          // scope: a selection check's line ("This check covered the text you selected (N
          // paragraphs). Check this Doc checks the whole tab."; with `gap`, "the paragraphs from the
          // first to the last you selected"); null for Check this Doc. Not a coverage line, so a
          // clean selection still reads "No issues found."
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
- A cancelled review (`status: cancelled`): `done`, headline "Check cancelled.", no `failure`, no
  progress or stages. `stopped`: "What it found before you stopped it stays below." (or "It stopped
  before any results came in.") then the charge as Lenz states `credits.charged` ("Nothing was
  charged." for 0; omitted when absent); the add-on computes nothing. Delivered findings keep their
  groups, edits, Apply and Undo. What did not finish says it was stopped, never that it failed: a row
  "Not checked: you stopped the check.", a stopped deep check "You stopped the check before the deep
  check finished, so this is the quick verdict.", coverage "N claims were not checked: you stopped the
  check." (no "Check this Doc to check it again" line). Nothing delivered: no groups, no coverage, no
  footnote — the panel reads as reset. Only the review's own status makes these words: a stopped row in
  a review that otherwise finished keeps the plain line.
- A link only to `https://lenz.io/c/` (the claim page, "See sources in Lenz"); a source only over http(s);
  and `failureLink` (`https://lenz.io/billing`, "Add credits") on a review that failed for credits.
- A failed review's `failure` is Docs words chosen by what failed (`failure.code`, or `failure.failure_reason` in the older shape) / `failure_class`, never
  the API's `hint` (written for integrators): no claim, not enough credits, Lenz could not check
  just now (an outage, or every quick check failed), else "on our side". A failed deep check's row says
  too few sources, search unavailable, a service unavailable, or stopped on our side, by the same
  fields; a failed quick check's row says nothing was charged for it.
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
lenzStartSelection() -> Reply | Note                  // Check only the selected text (below)
lenzResume() -> Reply                                 // after `stalled`: polls the saved review again
lenzCancel(reviewId) -> Reply                         // Cancel: stops the running review shown (below)
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
Reply = { phase: 'signed_out'|'needs_file_access'|'idle'|'running'|'stalled'|'done'|'error', auth: { mode: 'oauth'|'key', signedIn },
          model: Model|null, nextPollS|null, error: {code, message, retryable, retryAfterS}|null,
          startedAt|null, selection?, notice? }  // selection (running): a selection check;  // notice: "No changes since the last check."   // running only: the record's submittedAt (ms); the sidebar ticks the elapsed time
Note  = { ok, message|null }
```

- `reviewId` in Select and Apply is the review the sidebar shows (`Model.reviewId`); the server
  refuses unless it is the active tab's current record, so a list left over from another tab or an
  earlier check never acts on the current one.
- `stalled`: polls kept failing for 5 minutes, so the sidebar stops polling, says "Lenz is not
  answering. Your check is kept; choose Resume to look again." and shows Resume (Check this Doc stays
  off: it reads the Doc and may send a new review). Resume is `lenzResume`: it polls the SAVED review id;
  it sends no review and starts no check. A reply of this phase is not kept for open.
- **Cancel** (`lenzCancel`, the public `POST /reviews/{id}/cancel`, no new scope): the sidebar
  shows Cancel at the end of the "Running for" line for the whole `running` phase and nowhere else.
  It asks inline first ("Stop this check? Findings already shown stay. Checks that have not finished
  are not charged." · Stop the check · Keep checking; no browser dialog), then calls `lenzCancel` once
  ("Stopping…", both buttons off; a second click does nothing) with the review id it shows
  (`Model.reviewId`, null while the request is unconfirmed). Under the user lock that id must be the
  active tab's record's, else nothing is sent but a read of the current check, with "This panel was
  showing another check, so nothing was stopped." (a panel left over from another tab, or a check
  another sidebar replaced). Then: a pending request
  is replayed first to learn its review id (still unconfirmed → `running` with
  `cancel_not_started`, nothing stopped); then `client.cancel`. The reply is `lenzFromPoll_` of the
  answer: `done` with the cancelled model, or the results of a review that ended first, or `running` +
  `error` when Lenz did not answer (polling goes on; Cancel shows again). A `cancelled` record is in
  `LENZ_START_OVER`: Check this Doc and Check only the selected text start a NEW review even on
  unchanged text, and a cancelled review is never offered for Resume (it is terminal, so never
  `stalled`). Kept for open like any `done` reply.
- `running` + `error` is a passing problem: polling goes on. A poll or a Check click on a
  `submitting` / `pending_conflict` record replays the cached request with its key WITHOUT reading
  the Doc (submit is called with empty text; LenzApi settles the pending request first), so an
  emptied or changed tab never blocks the replay or overwrites the metadata of the text sent.
- One button, **Check this Doc** (`lenzStart`; there is no Run again): a pending request
  is replayed with its key; a record `failed`, `cancelled`, `lost` (403/404/410) or `unknown` gets
  `client.runAgain()` first, so the click is a NEW review and a failed receipt is never replayed;
  so does a `completed` review whose outcome was `incomplete` (`lenz:incomplete:<reviewId>`, set when
  the glue reads that body; the record does not carry the outcome);
  otherwise the text decides: changed → a new review, unchanged → the same review, and when it is
  complete the reply carries `notice: "No changes since the last check."` (no request, no charge).
- **Check only the selected text** (`lenzStartSelection`): the whole paragraphs from the first to the
  last the selection in the active tab's body touches (`lenzSelectionParas_`: each range element's
  child-index path from the BODY_SECTION, matched by prefix against the paths of the walk Select
  aligns with REST; a whole table or cell touches every paragraph in it). Read uncapped, so a
  selection past the 50,000th character works. The slice runs from the first piece of the first
  paragraph to the last piece of the last (a link's `[..](..)` whole), the `\n\n` between paragraphs
  kept, none after the last. The selected paragraphs' text must match the REST read (else read and
  map again, once). Then `client.submit` with the slice, the whole tab as `snapshot` and its
  `offset`, `scope = {paragraphs, gap}` (`gap`: a paragraph in the range the selection did not touch,
  a table column). Lock, file access, sign-in, the pending replay and the start-over states are
  Check this Doc's. A Note, nothing sent, nothing recorded: no selection ("Select the text to check
  first..."), only outside the body ("Select text in the body of this tab..."), no text, over 50,000
  characters ("The selection is longer than Lenz reads in one check..."), the Doc changing twice.
  `lenz:meta` gets no not-read counts (they are the tab's). Every read a selection check's findings
  are placed on (`lenzReadFor_`: the placement pass, Select, Apply, Undo) is uncapped.
  Known limit, as for a whole-tab check: after the tab changed, a passage the whole tab holds twice
  does not place.
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
  applied edits replayed through `applyToSnapshot`; `snapshotHash` = the record's `snapshotHash` (a
  selection check) or `textHash` until the first Apply, then the stored one.
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
  LENZ_SERIALIZER_SHA|v)>` (an uncapped read: `...|v|uncapped`, its own entries; the map after a
  write is stored under its read's mode) (chunked user cache, 6 h) is used when its revision matches, else a full
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
