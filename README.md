<p align="center">
  <img src="assets/logo.png" alt="Lenz" width="96" height="96">
</p>

<h1 align="center">Lenz Fact-Checking for Google Docs</h1>

<p align="center">
  Check the factual claims and citations in a Google Doc against independent sources, from a sidebar.
</p>

<p align="center">
  <a href="https://lenz.io">Website</a> ·
  <a href="https://lenz.io/privacy#google-docs">Privacy</a> ·
  <a href="https://lenz.io/contact">Support</a>
</p>

---

[Lenz](https://lenz.io) checks factual claims against evidence from multiple independent sources.
This repository is the source of its Google Docs add-on: an Apps Script sidebar that sends the open
tab to Lenz and shows the findings next to the words they are about.

## Install

The add-on will be listed on the Google Workspace Marketplace; the listing is coming. Until then you
can build and deploy your own copy (below). Either way you need a Lenz account
([create one](https://lenz.io/auth)); checks use credits from it.

## What it does

1. **Extensions → Lenz Fact-Checking → Check this Doc.** The sidebar reads the current tab and starts
   a check. A check takes two to four minutes; closing and reopening the sidebar resumes it.
   **Cancel**, next to the running time, stops it: findings already shown stay, and checks that had
   not finished are not charged.
2. **Findings in the Doc's order:** claims Lenz found false or doubtful (verdict, confidence, the
   reviewers' reasoning), citations whose source does not say what the Doc attributes to it, and
   what was not covered (claims past the limit, sources that could not be read, parts of the Doc
   not read).
   Lenz writes its findings in the language of the Doc (it detects the language from the text it is
   sent; a very short text is answered in English). The sidebar's own labels stay English.
3. **Check only the selected text.** Select part of the tab and choose Check only the selected text
   under Check this Doc: Lenz checks the whole paragraphs the selection touches, wherever they are in
   the tab, including past the first 50,000 characters a full check reads.
4. **Click a finding** to select its words.
5. **Apply a suggested edit.** Lenz shows the old and new wording; one click replaces exactly those
   words, and only if the Doc still says what was checked. Nothing changes without that click. The
   Doc's own undo does not reach an edit made this way, so the sidebar has an Undo for each one, and
   File → Version history keeps every earlier version.

**Privacy.** The add-on asks for access to one Doc at a time: the first time you check a Doc, Google's
file picker asks you to allow Lenz to read that Doc, and nothing is sent before you do. Lenz receives
the tab's text to check it and keeps the check in your Lenz account; deleting your account deletes
it. Details: [lenz.io/privacy#google-docs](https://lenz.io/privacy#google-docs).

## How it works

```
Docs REST API ──► serialize.js ──► review text + map ──► api.js ──► POST /api/v1/review
 (active tab)      (the Doc as text, every piece         (idempotent submit,  GET /api/v1/reviews/{id}
                    mapped to its Doc index)               polling, errors)          │
                                                                                       ▼
 Docs batchUpdate ◄── Code.js ◄── place.js ◄──────────── view.js ◄──────── the review body
 (Apply, guarded by   (glue)      (finds each finding's   (sidebar model:
  requiredRevisionId)              words again, even        order, coverage)
                                   after co-authors typed)
```

- **Per-Doc permission.** The add-on asks for `documents.currentonly` (the open Doc, for the
  selection) and `drive.file` (files you allow it, one by one), not for all your Docs. Until you
  pick the Doc in Google's file picker, the Docs REST API answers "not found" and the add-on sends
  nothing to Lenz. Google keeps the permission, so each Doc is asked about once.
- **Offsets.** Lenz reports positions in Unicode code points of the text it was sent; Google Docs
  indexes in UTF-16 code units. `serialize.js` keeps an interval map between the two, including the
  characters it adds itself (paragraph breaks, `[words](url)` for links).
- **Drift.** A check takes minutes and the author keeps typing. `place.js` finds each passage again
  by its words and their surroundings, and refuses when the passage was not unique in the checked
  text or is not unique now, so an edit never lands on another copy of the same sentence.
- **Apply** is one `documents.batchUpdate` (insert the new words after the old ones, then delete the
  old ones, so the replacement keeps their formatting) with `writeControl.requiredRevisionId`: any
  change in between makes Google refuse the write, and the add-on re-reads and retries once.
- **Retries never charge twice.** Each submission's `Idempotency-Key` and exact request body are
  stored before the request goes out; a lost reply is replayed byte for byte and returns the same
  review. Check this Doc on an unchanged Doc shows the last results again.

[`CONTRACT.md`](CONTRACT.md) describes the modules and their interfaces. The pure modules use no
Apps Script globals, so the same files run in Node for tests and in Apps Script unchanged.

## Build your own

Requirements: Node 20+ and [`clasp`](https://github.com/google/clasp) 3.x, a Google Cloud project
and a Lenz account.

```sh
npm test                                                                  # all suites, no network
cp config/flavours/internal.example.json config/flavours/internal.json    # then fill in your own values
bash scripts/build.sh internal                                            # dist/internal
bash scripts/clasp-create.sh                                              # once: create the Apps Script project
bash scripts/deploy.sh                                                    # test, build, push, version, deploy
```

[`docs/deploy.md`](docs/deploy.md) covers the two builds (`internal` for your own copy and testing,
`public` for Lenz's Marketplace listing), the Google Cloud setup, signing clasp in, test deployments
and a listing.

```
src/      the Apps Script code (scripts/build.sh assembles what clasp pushes)
config/   per-build settings and the shared manifest base
test/     node --test suites; fakes for Google Docs, Apps Script and the Lenz API
scripts/  build, clasp create/deploy, live smoke, spike and trial reports
docs/     deployment, live smoke, trial log and the store listing
```

## Support and security

Questions and problems: [lenz.io/contact](https://lenz.io/contact). Vulnerabilities: see
[`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE), Copyright Lenz IO.
