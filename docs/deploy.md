# Building and deploying the add-on

How to build the add-on and deploy it to an Apps Script project of your own with
[clasp](https://github.com/google/clasp). Built against **clasp 3.4.1** (`clasp --version`). Every
flag below was checked against `clasp <command> --help`, and every JSON field against clasp's own
source (`@google/clasp/build/src/commands/*.js`). The scripts are tested against a fake clasp
(`test/deploy-tooling.test.js`).

## Two builds

The add-on ships in two flavours, each its own Apps Script project. clasp never pushes `src/`: it
pushes `dist/<flavour>/`, which `scripts/build.sh <flavour>` assembles (and `deploy.sh` runs).

| | internal (default) | public |
|---|---|---|
| For | testing (`clasp run`, the dev tools) | the Marketplace listing |
| Files | every `src/*.js` and `src/*.html` | the same minus `dev.js`, `spike.js`, `dev-e2e.js`, `dev-tools.js` |
| Menu | Check this Doc, Dev tools (and its Spike kit) | Check this Doc |
| Sign-in | Lenz OAuth, or a pasted API key (Dev tools) | Lenz OAuth only |
| Trial log | on (a "lenz-gdocs trial log" Doc in the user's Drive) | off: no trial Doc, no trial properties |
| Scopes | `drive.file`, `documents.currentonly`, `script.container.ui`, `script.external_request` (per-Doc access) | the same |
| Settings | `config/flavours/internal.json`: your own, not in git (copy `internal.example.json`) | `config/flavours/public.json`: Lenz's listing |
| Fetch prefixes | `https://lenz.io/`, `https://www.googleapis.com/drive/v3/files/` | `https://lenz.io/` |
| `executionApi` | `{access: MYSELF}` | none |
| Project file, deploy id | `.clasp.json`, `.deploy-id` | `.clasp.public.json`, `.deploy-id.public` |
| Script title | Lenz Fact-Checking (dev) | Lenz Fact-Checking |

A flavour's settings live in one file, `config/flavours/<flavour>.json`: the script title, the Lenz
OAuth client id, the Google Picker key and Cloud project number (per-Doc access), the trial log
switch, the files it leaves out, and its manifest fields (scopes, fetch prefixes, `executionApi`).
The rest of the manifest is `config/appsscript.base.json`. The build writes two files into
`dist/<flavour>/`:

- `appsscript.json`: the base plus the flavour's fields (`test/build.test.js` pins both).
- `config.js`: `LENZ_FLAVOUR`, `LENZ_OAUTH_CLIENT_ID`, `LENZ_TRIAL_LOG`, `LENZ_PICKER_API_KEY`,
  `LENZ_PICKER_APP_ID`. No `src/` file names a client id; `Code.js` reads these when a function
  runs, never while the files load (Apps Script may load `Code.js` first).

The public flavour's client id and Picker key are not secrets: the OAuth client is a public PKCE
client (no secret) whose one redirect is the public script, and the browser key is restricted to
the Picker API and Google's referrers. They only work for Lenz's own listing, so a copy of your own
uses the internal flavour with your own values.

The dev harness (the Dev tools menu, the pasted API key, the dump, the "wrong words" flags) is
`src/dev-tools.js`. `Code.js` reaches it only through `typeof` checks, so without it there is no Dev
tools menu and no way to run on a key: a key left in User properties is never read.

```bash
cp config/flavours/internal.example.json config/flavours/internal.json   # once, then fill it in
bash scripts/build.sh internal                      # dist/internal/
bash scripts/build.sh public                        # Lenz's listing build
bash scripts/build.sh internal --allow-placeholder  # local checks on the example's values only; deploy.sh never passes it
```

The build refuses a missing `config/flavours/internal.json`, and the example's placeholder values
unless `--allow-placeholder` is given.

## Files

| File | In git | What |
|---|---|---|
| `config/flavours/public.json` | yes | the public flavour's settings (above) |
| `config/flavours/internal.example.json` | yes | the internal flavour's shape, with placeholder values |
| `config/flavours/internal.json` | no | your internal flavour's settings |
| `dist/<flavour>/` | no | the build, what clasp pushes; replaced on every build |
| `.clasp.json` / `.clasp.public.json` | no | `{scriptId, rootDir: "dist/<flavour>", …}`, written by `clasp-create.sh` |
| `.deploy-id` / `.deploy-id.public` | no | the flavour's one versioned deployment, written by its first `deploy.sh` |
| `.claspignore` | yes | only the build's top-level `.js`, `.html` and `appsscript.json` ship (found beside the project file; patterns relative to rootDir) |
| `.secrets/` | no | the clasp sign-in's OAuth client (below) |
| `~/.clasprc.json` | no | clasp's token from `clasp login` (clasp's default place, shared by every worktree) |

The project files and deploy ids live in the checkout they were made in. A worktree that deploys
copies them from there first. A `.clasp.json` made before the flavours has `rootDir: "src"`; the next
`deploy.sh` rewrites it to `dist/internal` once and says so.

## 0. What a copy of your own needs

- A Google Cloud project with the Google Docs, Google Drive, Apps Script and Google Picker APIs
  enabled (and the Google Workspace Marketplace SDK for a listing).
- The Apps Script API turned on for your account: https://script.google.com/home/usersettings.
- In that project, an OAuth consent screen with the manifest's scopes plus `script.projects` and
  `script.deployments` (for clasp), and a **Desktop app** OAuth client for clasp. Save its JSON as
  `.secrets/client.json` (gitignored).
- A browser API key restricted to the Picker API (`pickerApiKey`) and the project's number
  (`pickerAppId`) in `config/flavours/internal.json`.
- A Lenz OAuth client whose one redirect is your script's
  `https://script.google.com/macros/d/<script id>/usercallback` (`oauthClientId`). Ask Lenz for one
  at https://lenz.io/contact. Until then the internal build can run on a Lenz API key pasted through
  Dev tools → Use an API key….

## 1. Sign clasp in

```
clasp login --no-localhost --creds .secrets/client.json --extra-scopes "$(node -p "require('./config/flavours/public.json').manifest.oauthScopes.join(',')")"
```

Run it from the repository root. Open the printed link, approve, then paste the whole redirected URL
back (the page itself will not load: that is expected). One sign-in covers clasp's own scopes
(create, push, version, deploy, logs) plus every scope of the manifest, which `clasp run` needs (the
two flavours ask for the same scopes; `test/login-command.test.js` checks it).

`--use-project-scopes` would not work here: clasp 3.4.1 reads the manifest only once a `.clasp.json`
with a script id exists ("Project settings not found."), and that file is written by creating the
script, which needs this sign-in. `--extra-scopes` reads the scopes straight from the flavour config
instead. If a flavour later gains a scope, sign in again.

## 2. Create the script (once per flavour)

```bash
bash scripts/clasp-create.sh            # internal: .clasp.json
bash scripts/clasp-create.sh public     # public:   .clasp.public.json
```

This runs `clasp --json -P . create-script --type standalone --title "<the flavour's title>"` in an
empty scratch directory, then writes the flavour's project file in the repo from the one clasp made,
with `rootDir` set to `dist/<flavour>`. The project is standalone, not bound to a Doc: that is what a
test deployment and the Marketplace listing both use.

- It refuses if the flavour's project file exists. `LENZ_SCRIPT_TITLE` overrides the title.
- It prints the script ID and `https://script.google.com/d/<id>/edit`.
- Why the scratch directory: clasp 3.4.1 writes `.clasp.json` in its project root and pulls the new
  project's default files (manifest, `Code.gs`) into it, and `-P <file>` refuses a project file that
  does not exist yet. With no project file found, clasp does not check whether one is there, so run
  in the repo it would overwrite `.clasp.json`. `-P .` in the scratch directory stops it finding the
  repo's file upwards; nothing clasp pulls reaches the repo.

## 3. Link the Cloud project (once per script)

Open the script URL → Project Settings → Google Cloud Platform Project → Change project → your
project's number. `clasp run`, the Picker grant and the Marketplace listing all need this.

## 4. Deploy

From `main`, level with `origin/main`, with a clean tree:

```bash
bash scripts/deploy.sh            # internal
bash scripts/deploy.sh public     # public
```

1. It refuses without the flavour's project file or `config/flavours/<flavour>.json`, with a dirty
   tree, off `main`, when `main` is not `origin/main` (after a fetch), or when the project file's
   `rootDir` is not `dist/<flavour>`.
2. It runs `npm test`, which must pass, then `scripts/build.sh <flavour>` (never
   `--allow-placeholder`: a flavour without its own client id does not deploy).
3. `clasp --json -P <project file> show-file-status`: every file to push must be
   `dist/<flavour>/<name>.js`, `dist/<flavour>/<name>.html` or `dist/<flavour>/appsscript.json`,
   `appsscript.json` and `config.js` must be among them, and none of the files the flavour leaves
   out may be. Anything else stops the deploy.
4. `clasp -P <project file> push --force` replaces the remote files, manifest included. This also
   updates `@HEAD`, which is what a test deployment runs.
5. `clasp --json -P <project file> create-version "<short sha> <commit subject>"` cuts an immutable
   version.
6. On the first run, `clasp --json -P <project file> create-deployment --versionNumber N
   --description ...` creates the deployment and its id goes to the flavour's deploy id file. After
   that, `clasp --json -P <project file> update-deployment <id> --versionNumber N --description ...`
   moves the same deployment to the new version.
7. It prints the flavour, the script ID, the version and the deployment ID. The Marketplace SDK's
   App Configuration takes the script ID and the version or deployment.

A version is permanent and Apps Script caps a project at 200, so deploy what's merged, not every
commit. For code in progress, build and push without a version: `bash scripts/build.sh internal &&
clasp -P .clasp.json push --force` (test deployments run `@HEAD`).

## 5. Test deployment (try it in a Doc)

In the script editor: **Deploy → Test deployments → Select type: Editor add-on → Docs**. Then
**Add test** → Version **Latest code** (`@HEAD`, what `clasp push` updates) or a numbered version →
Config **Installed and enabled** → pick a Doc → Save → **Execute**. The Doc opens with the add-on's
menu. Latest code picks up every later `clasp push` on reload. Test deployments only serve the
account that made them.

## 6. A Marketplace listing

Google Workspace Marketplace SDK → App configuration: app integration **Editor add-on → Docs**, the
script ID and the version or deployment ID from step 4, then the store listing (texts and images in
`docs/listing/`). A new version reaches installed users once the App Configuration names it. A
private listing cannot later be made public: a public listing needs its own Cloud project, OAuth
verification for the manifest's four scopes, and privacy and terms links.

## `clasp run` (dev functions)

```bash
clasp -P .clasp.json run-function lenzDevDump                  # dev mode: runs @HEAD
clasp -P .clasp.json run-function someFn --params '["arg1", 2]'
```

It calls the Apps Script API's `scripts.run`, and clasp's own error text for a missing function
says "make sure script is deployed as API executable". Before it can work:

- the script is linked to the Cloud project of the OAuth client clasp signed in with (step 3);
- the manifest declares `"executionApi": {"access": "MYSELF"}` (the internal flavour's; the public
  build has none and no dev functions, so `clasp run` is internal only);
- a deployment exists (step 4), since the API executable entry point comes from the manifest.

The token's scopes must cover what the function touches; the sign-in (step 1) passes the manifest's
`oauthScopes` as `--extra-scopes`. The headless e2e works on a Doc the script makes itself
(`clasp run lenzDev_e2eCreateDoc --params '["Lenz spike e2e", "<text>"]'`, then `lenzDev_e2eStart`
/ `lenzDev_e2eStep` on its id), through REST only. The spike kit's DocumentApp check
(`lenzDev_checkSpikeDoc`) compares against the open Doc, so its DocumentApp half runs from Dev tools →
Spike → Check this spike Doc, not from `clasp run`.

Logs: `clasp tail-logs` once `clasp setup-logs` has run.

## Per-Doc access and the Google Picker

Neither build asks for `documents` (all the user's Docs). With `drive.file`, a Docs REST call on a
Doc the user has not granted answers "Requested entity was not found."; the sidebar then offers
"Allow Lenz to read this Doc", which opens `picker.html`: the Google Picker, showing only the open
Doc, on the flavour's browser key (`pickerApiKey`, restricted to the Picker API and Google's
referrers) and Cloud project number (`pickerAppId`, the project the script is linked to). Picking
the Doc grants this script that file; Google keeps the grant. Both need, in the flavour's Cloud
project: the Google Picker API enabled, the key restricted to it, and the script linked to that
project (step 3), since the grant is made to the project number named by `setAppId`. The picker
loads in the browser from `apis.google.com`, so `urlFetchWhitelist` does not change.

The internal build keeps the same scopes, so testing sees the real grant flow. Its dev tools work
on Docs the add-on creates itself, which `drive.file` covers without the Picker: the trial log, the
dump and the e2e's spike Docs are made with `Docs.Documents.create` and written with one
`insertText` at the end of the body. Nothing calls `DocumentApp.create` / `openById`, which would need
`documents`.

The public build has no `executionApi`, no dev functions and no pasted key, so `clasp run` and the
headless e2e (`src/dev-e2e.js`) are internal only. Everything the public build ships is also in the
internal one, so testing on the internal flavour covers the public code paths except the ones its
settings change (no Dev tools, OAuth only, no trial log), which `test/code.test.js` ("the two
builds") and `test/build.test.js` cover.
