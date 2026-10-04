# Trial log and report (phase 1 success criteria)

The prototype's success criteria, measured on 10 real drafts with the author editing during the
review as usual:

| # | Criterion | Pass |
|---|---|---|
| C0 | the sample: drafts (`doc`) with a `review_done` | ≥ 10 |
| C1 | placement coverage over findings that carry a source position | ≥ 90% placed |
| C2 | every placed finding selects the right words | 0 `wrong` flags with `of: select` |
| C3 | edits offered across the drafts | ≥ 20 |
| C4 | offered edits applicable when clicked | ≥ 80% of clicked edits apply on the first click |
| C5 | Applies on the wrong words | 0 `wrong` flags with `of: apply` |
| C6 | sequential Applies within one passage | every later Apply in an already-edited passage succeeds |

Whether people reach for it over uploading a .docx to Lenz is a judgment, not a log line.

## The log

One JSON object per line (JSONL), appended by the glue (`Code.js`) per action. Where it goes (a
Drive file or the Apps Script log) is the glue's choice; the report reads the lines.

```
{ "v": 1,
  "ts": "2026-10-01T09:12:03.120Z",   // ISO time of the action
  "doc": "3f9a0c1b2d4e",              // sha256(docId), first 12 hex: never the id itself
  "review": "9f9cafea",               // reviewId
  "event": "...",                     // below
  "finding": "edit:0.1",              // claim:<claimIndex>@<position> | citation:<index> | edit:<claimIndex>.<editIndex>
  "kind": "claim|citation|edit",
  "passage": "claim:0@0",             // edits only: the claim position the edit sits in
  "reason": "not_found",              // place.js reason, or the Apply refusal's reason
  "of": "apply|select",               // `wrong` only
  "findings": 12, "edits": 3 }        // `review_done` only
```

No text from the Doc or the review goes in the log (ids, kinds and reasons only).

Events:

| event | when | fields |
|---|---|---|
| `review_done` | a review completed and its findings were first placed | `findings` (with a source position), `edits` |
| `placed` / `changed` / `unplaceable` | each finding's placement, every time the list is (re)placed | `finding`, `kind`, `passage` (edit), `reason` (not placed) |
| `applied` | an Apply click that wrote the edit | `finding`, `passage` |
| `apply_refused` | an Apply click that wrote nothing (not placed, not applicable, already applied) | `finding`, `passage`, `reason` |
| `apply_conflict` | an Apply click that hit a revision conflict twice and gave up | `finding`, `passage` |
| `undone` | an Undo click that restored the old words | `finding`, `passage` |
| `undo_refused` | an Undo click that wrote nothing | `finding`, `passage`, `reason` |
| `wrong` | flagged by hand (dev menu): the selection or the Apply hit the wrong words | `finding`, `of` |
| `key_migrated` | a key saved by the pre-OAuth first-run box was dropped, so its owner is offered Sign in with Lenz (once per user); `doc` and `review` are null | none |
| `signed_in` / `signed_out` | a sign-in with Lenz completed (the callback) / a Sign out click that had a sign-in to end; `doc` and `review` are null | none |

## How the report counts

- **C1**: per (review, finding), the first placement event after `review_done`, i.e. what the author
  saw when the list opened. The later placements are counted too, as "last seen", to show drift
  during the review. The denominator is the findings with a placement event; if it differs from
  `review_done.findings`, the report prints the gap (a finding the glue never placed).
- **C3**: distinct (review, edit finding) with a placement event.
- **C4**: per (review, edit finding), its first click (`applied` / `apply_refused` /
  `apply_conflict`); applicable = `applied`. Conflicts are listed separately.
- **C6**: Apply clicks on an edit (not itself applied) whose passage, in that review, has another
  edit applied at that moment; each must be `applied`. An `undone` edit leaves its passage, so a
  passage whose only Apply was undone is back to its checked words and does not count.
- **Undo** is reported apart, not as a criterion: undone / refused (by reason), and Undos made while
  a sibling was applied. An undone edit still counts as applicable for C4 (its first click decided).
- Lines that are not JSON or have no `event` are counted and skipped.

## Running it

```
node scripts/trial-report.js trial.jsonl          # the table, PASS / MISS per criterion
node scripts/trial-report.js trial.jsonl --json   # the numbers, for the write-up
```

Exit code 0 when every measured criterion passes, 1 when any misses (miss any: stop at phase 1 and
write down why).
