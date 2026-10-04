#!/usr/bin/env node
// Assembles one flavour of the add-on into dist/<flavour>/ (gitignored), which is what clasp pushes.
//
//   node scripts/build.js <internal|public> [--allow-placeholder] [--out <dir>]
//   (scripts/build.sh is the same command)
//
// From src/: every top-level .js and .html, minus the flavour's omitFiles. Then two generated files,
// both from config/flavours/<flavour>.json (the one place a flavour's settings live):
//   config.js        LENZ_FLAVOUR, LENZ_OAUTH_CLIENT_ID, LENZ_TRIAL_LOG, LENZ_PICKER_API_KEY,
//                    LENZ_PICKER_APP_ID (Code.js reads them)
//   appsscript.json  config/appsscript.base.json plus the flavour's scopes, fetch prefixes and
//                    executionApi
// A flavour whose client id is still the placeholder refuses to build without --allow-placeholder.
//
// config/flavours/internal.json is not in git (it names Lenz's own internal project). Copy
// config/flavours/internal.example.json to it and fill in your own values; the example's
// placeholders refuse to build without --allow-placeholder too.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FLAVOURS = ['internal', 'public'];
const PLACEHOLDER = 'REPLACE_WITH_PUBLIC_CLIENT_ID';
// The values in config/flavours/internal.example.json: shaped like real ones, so the example passes
// the checks below, but never built without --allow-placeholder.
const EXAMPLE_VALUES = {
  oauthClientId: 'lzc_000000000000000000000000',
  pickerApiKey: 'AIza00000000000000000000000000000000000',
  pickerAppId: '000000000000',
};
const CONFIG_KEYS = ['scriptTitle', 'oauthClientId', 'pickerApiKey', 'pickerAppId', 'trialLog', 'omitFiles', 'manifest'];
const MANIFEST_KEYS = ['oauthScopes', 'urlFetchWhitelist', 'executionApi'];

class BuildError extends Error {}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * The flavour's config, checked. `root` is the repo (tests pass a scratch copy); `file` replaces
 * config/flavours/<flavour>.json (tests pass a fixture).
 */
function loadFlavour(flavour, root, file) {
  root = root || ROOT;
  if (!FLAVOURS.includes(flavour)) throw new BuildError('unknown flavour "' + flavour + '" (internal or public)');
  file = file || path.join(root, 'config', 'flavours', flavour + '.json');
  if (!fs.existsSync(file)) {
    const example = 'config/flavours/' + flavour + '.example.json';
    throw new BuildError(fs.existsSync(path.join(root, example))
      ? 'config/flavours/' + flavour + '.json is missing. It is not in git: copy ' + example + ' to it and fill in ' +
        'your own Lenz OAuth client id, Picker key and Cloud project number (docs/deploy.md).'
      : 'config/flavours/' + flavour + '.json is missing.');
  }
  const cfg = readJson(file);
  const extra = Object.keys(cfg).filter((k) => !CONFIG_KEYS.includes(k));
  if (extra.length) throw new BuildError(flavour + '.json: unknown key(s) ' + extra.join(', '));
  if (typeof cfg.oauthClientId !== 'string' || !cfg.oauthClientId) throw new BuildError(flavour + '.json: no oauthClientId');
  // The Google Picker (per-Doc access): a browser key restricted to the Picker API and Google's
  // referrers, and the Cloud project number of the flavour's script. Neither is a secret.
  if (typeof cfg.pickerApiKey !== 'string' || !/^AIza[0-9A-Za-z_-]{35}$/.test(cfg.pickerApiKey)) {
    throw new BuildError(flavour + '.json: pickerApiKey must be a Google API key (AIza…)');
  }
  if (typeof cfg.pickerAppId !== 'string' || !/^[0-9]{6,20}$/.test(cfg.pickerAppId)) {
    throw new BuildError(flavour + '.json: pickerAppId must be the Cloud project number');
  }
  if (typeof cfg.trialLog !== 'boolean') throw new BuildError(flavour + '.json: trialLog must be true or false');
  if (!Array.isArray(cfg.omitFiles)) throw new BuildError(flavour + '.json: omitFiles must be a list');
  const m = cfg.manifest || {};
  const extraM = Object.keys(m).filter((k) => !MANIFEST_KEYS.includes(k));
  if (extraM.length) throw new BuildError(flavour + '.json: unknown manifest key(s) ' + extraM.join(', '));
  if (!Array.isArray(m.oauthScopes) || !m.oauthScopes.length) throw new BuildError(flavour + '.json: no oauthScopes');
  if (!Array.isArray(m.urlFetchWhitelist) || !m.urlFetchWhitelist.length) throw new BuildError(flavour + '.json: no urlFetchWhitelist');
  return cfg;
}

/** The manifest: the shared base, the flavour's three fields, in the order the file has always had. */
function manifestFor(cfg, root) {
  const base = readJson(path.join(root || ROOT, 'config', 'appsscript.base.json'));
  const out = {
    timeZone: base.timeZone,
    runtimeVersion: base.runtimeVersion,
    exceptionLogging: base.exceptionLogging,
    oauthScopes: cfg.manifest.oauthScopes,
    dependencies: base.dependencies,
    urlFetchWhitelist: cfg.manifest.urlFetchWhitelist,
  };
  if (cfg.manifest.executionApi) out.executionApi = cfg.manifest.executionApi;
  return JSON.stringify(out, null, 2) + '\n';
}

/** dist/<flavour>/config.js. Top-level vars only: Code.js reads them when called, never on load. */
function configJs(flavour, cfg) {
  return [
    '// Generated by scripts/build.sh from config/flavours/' + flavour + '.json. Do not edit; not in git.',
    'var LENZ_FLAVOUR = ' + JSON.stringify(flavour) + ';',
    // "Sign in with Lenz": a public OAuth client (PKCE, no secret), so its id is not a secret. Its one
    // registered redirect is this flavour's script's usercallback.
    'var LENZ_OAUTH_CLIENT_ID = ' + JSON.stringify(cfg.oauthClientId) + ';',
    // The trial log (Code.js lenzTrial_): a "lenz-gdocs trial log" Doc in the user's Drive.
    'var LENZ_TRIAL_LOG = ' + JSON.stringify(cfg.trialLog) + ';',
    // The Google Picker (Code.js lenzPickerConfig): the flavour's browser key and Cloud project number.
    'var LENZ_PICKER_API_KEY = ' + JSON.stringify(cfg.pickerApiKey) + ';',
    'var LENZ_PICKER_APP_ID = ' + JSON.stringify(cfg.pickerAppId) + ';',
    '',
  ].join('\n');
}

/**
 * Builds `flavour` into `out` (default dist/<flavour>), replacing whatever was there.
 * Returns {out, files} (file names, sorted).
 */
function build(flavour, opts) {
  opts = opts || {};
  const root = opts.root || ROOT;
  const cfg = loadFlavour(flavour, root, opts.flavourFile);
  if (cfg.oauthClientId === PLACEHOLDER && !opts.allowPlaceholder) {
    throw new BuildError('config/flavours/' + flavour + '.json still has the placeholder client id ' + PLACEHOLDER +
      '; set the Lenz OAuth client registered for this flavour\'s script (or pass --allow-placeholder for a local build).');
  }
  const examples = Object.keys(EXAMPLE_VALUES).filter((k) => cfg[k] === EXAMPLE_VALUES[k]);
  if (examples.length && !opts.allowPlaceholder) {
    throw new BuildError('config/flavours/' + flavour + '.json still has the example\'s placeholder ' + examples.join(', ') +
      '; set your own (or pass --allow-placeholder for a local build).');
  }
  if (cfg.oauthClientId !== PLACEHOLDER && !/^lzc_[0-9a-z]+$/.test(cfg.oauthClientId)) {
    throw new BuildError(flavour + '.json: oauthClientId "' + cfg.oauthClientId + '" does not look like a Lenz client id (lzc_…)');
  }
  const src = path.join(root, 'src');
  const all = fs.readdirSync(src).filter((f) => fs.statSync(path.join(src, f)).isFile());
  const missing = cfg.omitFiles.filter((f) => !all.includes(f));
  if (missing.length) throw new BuildError(flavour + '.json omits ' + missing.join(', ') + ', not in src/ (renamed?)');
  if (all.includes('config.js')) throw new BuildError('src/config.js would be overwritten by the generated one');
  if (all.includes('appsscript.json')) throw new BuildError('src/appsscript.json: the manifest is generated from config/ now');
  const ship = all.filter((f) => /\.(js|html)$/.test(f) && !cfg.omitFiles.includes(f));

  const out = path.resolve(opts.out || path.join(root, 'dist', flavour));
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  ship.forEach((f) => fs.copyFileSync(path.join(src, f), path.join(out, f)));
  fs.writeFileSync(path.join(out, 'config.js'), configJs(flavour, cfg));
  fs.writeFileSync(path.join(out, 'appsscript.json'), manifestFor(cfg, root));
  return { out, files: fs.readdirSync(out).sort() };
}

function main(argv) {
  const args = argv.slice();
  let allowPlaceholder = false;
  let out = null;
  const rest = [];
  while (args.length) {
    const a = args.shift();
    if (a === '--allow-placeholder') allowPlaceholder = true;
    else if (a === '--out') out = args.shift();
    else rest.push(a);
  }
  if (rest.length !== 1) throw new BuildError('usage: scripts/build.sh <internal|public> [--allow-placeholder] [--out <dir>]');
  const r = build(rest[0], { allowPlaceholder, out });
  console.log('build: ' + rest[0] + ' → ' + path.relative(process.cwd(), r.out) + '/ (' + r.files.join(', ') + ')');
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof BuildError)) throw e;
    console.error('build: ' + e.message);
    process.exit(1);
  }
}

module.exports = { build, loadFlavour, manifestFor, configJs, FLAVOURS, PLACEHOLDER, EXAMPLE_VALUES, BuildError };
