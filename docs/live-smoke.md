# Live smoke: `api.js` against the live `/review`

`scripts/live-smoke.js` runs `LenzApi` against `https://lenz.io/api/v1` with a real API key. It is
**paid** (two reviews of `draft-b`, about 36 credits each; the script refuses a third new key and the
authorised budget is three) and runs by hand only, never from `npm test`.

```bash
node scripts/live-smoke.js                       # key from .env (LENZ_API_KEY=lenz_…; gitignored)
node scripts/live-smoke.js --env PATH --out DIR  # another env file / recording directory
```

The key is read from the env file, handed to each request over a child process's stdin (never argv),
and never printed or saved: every recorded exchange drops `Authorization` and redacts the key
anywhere it appears. Exit code 0 = every check passed.

## Adapters

| `api.js` dep | smoke adapter |
|---|---|
| `fetch(req)` (sync) | one child `node` per request running global `fetch` (60 s timeout); any failure → `{code: 0}` |
| `store`, `cache` | in-memory maps (no TTL, no chunking) |
| `sha256` | `node:crypto` |
| `now` | `Date.now` |
| sleep | `Atomics.wait`, for the real `Retry-After` / `poll_after_seconds` |

## Scenario (on `test/fixtures/reviews/draft-b.txt`)

Free probes first, so a wrong key or an outage costs nothing:

1. **404**: a record pointing at review `00000000`, polled with the real key → 404, terminal, record
   `lost`. Anything else stops the run before a paid call.
2. **401**: `submit` with a made-up `lenz_` key → 401, `rejected`, not retryable.

Paid:

3. **Lost reply**: the first POST goes out for real, but `api.js` is told there was no answer. It must
   hold the submission as `submitting`.
4. **Replay**: `submit` again with the Doc text changed. It must send the same key and the
   byte-identical body, get the **same review id**, and keep the first text as the snapshot.
5. **Poll A** to `completed`, sleeping what the API says.
6. **Edits**: `edit()` for every Apollo edit. Each `text` must be the sent slice at `start..end`
   (code points) and lie inside its claim passage.
7. **Run again** → `submit` on unchanged text gives a **new review id**. **Poll B** to `completed`.
8. **One review behind the lost reply**: there is no list endpoint, so this is shown by the replay returning A's id and by A's `credits.charged` ≤ B's (same text).

Every exchange goes to `test/fixtures/reviews/smoke-<date>/NN-<method>-<step>.json`, with
`summary.json` listing each check.

`test/live-smoke.test.js` runs the same scenario against a fake `/review` that keeps Lenz's
idempotency rule. It checks that a correct server passes, that the waits are the served ones, that the
replay is one key and one body, and that nothing saved carries the key. It also checks that a double
review, an over-charge and a bad key each fail the run, the last before any paid call.

## Findings

**Run 2026-09-30: PASSED 14/14, 2 paid reviews, 12 credits.** Recordings in
`test/fixtures/reviews/smoke-2026-09-30/`. The live API matched `CONTRACT.md` and `api.js` everywhere; no
code change needed.

| Check | Result |
|---|---|
| 404 on an unknown review | PASS (`not_found`, terminal, recorded lost) |
| 401 on a bad key | PASS (rejected, not retryable) |
| lost reply → same review id, same key and body | PASS (`aeb9cb33` both times, 202 on the replay) |
| A completes on served waits | PASS (first wait = `Retry-After: 20`; completed on the first poll) |
| Apollo edits match the sent text | PASS (both edits exact code-point slices, inside their passage) |
| Run again → a new review | PASS (`e9660817`) |
| one review behind the lost reply | PASS (A charged 6, B charged 6) |

Note: both reviews completed on the first poll and charged 6 credits because the claims' deep checks
were served from Lenz's claim cache (draft-b had been reviewed earlier the same night). The polling
path through running states is covered by `draft-a.polls.json` and the unit tests.
