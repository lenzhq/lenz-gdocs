// scripts/build.js: the two flavours clasp pushes. Internal is today's add-on (dev harness, its
// manifest byte for byte); public has no dev file, no pasted key, no trial log, three scopes, one
// fetch prefix, and refuses to build on the placeholder client id. The built code's behaviour is
// tested in test/code.test.js ("the two builds").
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { build: buildRaw, loadFlavour, PLACEHOLDER, EXAMPLE_VALUES, BuildError } = require('../scripts/build.js');
const { flavourFile, INTERNAL_FIXTURE } = require('./helpers/flavour.js');

const REPO = path.join(__dirname, '..');
const SRC = path.join(REPO, 'src');
const scratch = (name) => fs.mkdtempSync(path.join(os.tmpdir(), 'lenz-build-' + name + '-'));
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
// config/flavours/internal.json is not in git: the internal flavour builds from the test fixture.
const cfg = (f) => readJson(flavourFile(f) || path.join(REPO, 'config', 'flavours', f + '.json'));
const build = (flavour, opts) => buildRaw(flavour, Object.assign(
  opts && opts.root ? {} : { flavourFile: flavourFile(flavour) }, opts || {}));

// The internal build's manifest, exactly: per-Doc access (drive.file + documents.currentonly, no
// `documents`), the spike kit's Drive URL, and executionApi for `clasp run`.
const INTERNAL_MANIFEST = `{
  "timeZone": "Etc/UTC",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "oauthScopes": [
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/documents.currentonly",
    "https://www.googleapis.com/auth/script.container.ui",
    "https://www.googleapis.com/auth/script.external_request"
  ],
  "dependencies": {
    "enabledAdvancedServices": [
      {
        "userSymbol": "Docs",
        "serviceId": "docs",
        "version": "v1"
      }
    ]
  },
  "urlFetchWhitelist": [
    "https://lenz.io/",
    "https://www.googleapis.com/drive/v3/files/"
  ],
  "executionApi": {
    "access": "MYSELF"
  }
}
`;

const PUBLIC_FILES = ['Code.js', 'api.js', 'appsscript.json', 'config.js', 'oauth.js', 'picker.html', 'place.js',
  'serialize.js', 'sidebar.html', 'view.js'];

// Comments and string contents out (as test/syntax.test.js), so prose never trips a check.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
}

function configVars(out) {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(out, 'config.js'), 'utf8'), ctx);
  return { flavour: ctx.LENZ_FLAVOUR, clientId: ctx.LENZ_OAUTH_CLIENT_ID, trialLog: ctx.LENZ_TRIAL_LOG,
    pickerApiKey: ctx.LENZ_PICKER_API_KEY, pickerAppId: ctx.LENZ_PICKER_APP_ID };
}

// A repo-shaped scratch copy (src/, config/, scripts/build.*) whose flavour configs a test may change.
function scratchRepo(edit) {
  const root = scratch('repo');
  fs.cpSync(SRC, path.join(root, 'src'), { recursive: true });
  fs.cpSync(path.join(REPO, 'config'), path.join(root, 'config'), { recursive: true });
  fs.copyFileSync(INTERNAL_FIXTURE, path.join(root, 'config', 'flavours', 'internal.json'));
  fs.mkdirSync(path.join(root, 'scripts'));
  for (const f of ['build.js', 'build.sh']) fs.copyFileSync(path.join(REPO, 'scripts', f), path.join(root, 'scripts', f));
  if (edit) edit(root);
  return root;
}
function setFlavour(root, flavour, patch) {
  const file = path.join(root, 'config', 'flavours', flavour + '.json');
  fs.writeFileSync(file, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(file, 'utf8')), patch), null, 2));
}

// ── internal ────────────────────────────────────────────────────────

test('internal: the manifest, byte for byte', () => {
  const { out } = build('internal', { out: scratch('internal') });
  assert.equal(fs.readFileSync(path.join(out, 'appsscript.json'), 'utf8'), INTERNAL_MANIFEST);
});

test('internal: every src .js and .html as is, plus config.js and the manifest', () => {
  const { out, files } = build('internal', { out: scratch('internal') });
  const src = fs.readdirSync(SRC).filter((f) => /\.(js|html)$/.test(f));
  assert.deepEqual(files, src.concat(['appsscript.json', 'config.js']).sort());
  for (const f of src) assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(SRC, f))), f);
  for (const f of ['dev.js', 'spike.js', 'dev-e2e.js', 'dev-tools.js']) assert.ok(files.includes(f), f);
});

test('internal: config.js carries the internal client id and the trial log on', () => {
  const { out } = build('internal', { out: scratch('internal') });
  assert.deepEqual(configVars(out), { flavour: 'internal', clientId: cfg('internal').oauthClientId, trialLog: true,
    pickerApiKey: cfg('internal').pickerApiKey, pickerAppId: cfg('internal').pickerAppId });
  assert.match(cfg('internal').oauthClientId, /^lzc_[0-9a-f]+$/);
});

test('the client id lives only in config/flavours: no src file names one', () => {
  for (const f of fs.readdirSync(SRC)) {
    assert.doesNotMatch(fs.readFileSync(path.join(SRC, f), 'utf8'), /lzc_[0-9a-f]{6,}/, f);
  }
});

// ── public ──────────────────────────────────────────────────────────

// The placeholder is set in a scratch copy, so these hold once public.json has its real client id.
const onPlaceholder = () => scratchRepo((r) => setFlavour(r, 'public', { oauthClientId: PLACEHOLDER }));

test('the committed public client id is the placeholder or a Lenz client id, never the internal one', () => {
  const id = cfg('public').oauthClientId;
  assert.ok(id === PLACEHOLDER || /^lzc_[0-9a-z]+$/.test(id), id);
  assert.notEqual(id, cfg('internal').oauthClientId);
});

test('public: refuses to build on the placeholder client id, and writes nothing', () => {
  const root = onPlaceholder();
  const out = path.join(root, 'dist', 'public');
  assert.throws(() => build('public', { root, out }), (e) => e instanceof BuildError && /placeholder/.test(e.message));
  assert.ok(!fs.existsSync(out));
  const r = spawnSync('bash', [path.join(root, 'scripts', 'build.sh'), 'public'], { encoding: 'utf8', cwd: root });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /placeholder client id REPLACE_WITH_PUBLIC_CLIENT_ID/);
  assert.ok(!fs.existsSync(out));
});

test('public: --allow-placeholder builds (local checks only); scripts/deploy.sh never passes it', () => {
  const root = onPlaceholder();
  const out = path.join(root, 'dist', 'public');
  const r = spawnSync('bash', [path.join(root, 'scripts', 'build.sh'), 'public', '--allow-placeholder'], { encoding: 'utf8', cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(configVars(out).clientId, PLACEHOLDER);
  const commands = fs.readFileSync(path.join(REPO, 'scripts', 'deploy.sh'), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l));
  assert.ok(commands.every((l) => !l.includes('allow-placeholder')));
});

test('public: exactly the add-on files, no dev file', () => {
  const { files } = build('public', { out: scratch('public'), allowPlaceholder: true });
  assert.deepEqual(files, PUBLIC_FILES);
});

test('public: the manifest asks for per-Doc access (drive.file + documents.currentonly), fetches only lenz.io, no executionApi', () => {
  const { out } = build('public', { out: scratch('public'), allowPlaceholder: true });
  const m = JSON.parse(fs.readFileSync(path.join(out, 'appsscript.json'), 'utf8'));
  assert.deepEqual(m, {
    timeZone: 'Etc/UTC',
    runtimeVersion: 'V8',
    exceptionLogging: 'STACKDRIVER',
    oauthScopes: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/documents.currentonly',
      'https://www.googleapis.com/auth/script.container.ui',
      'https://www.googleapis.com/auth/script.external_request',
    ],
    dependencies: { enabledAdvancedServices: [{ userSymbol: 'Docs', serviceId: 'docs', version: 'v1' }] },
    urlFetchWhitelist: ['https://lenz.io/'],
  });
  assert.ok(!('executionApi' in m));
});

test('public: no dev function, no pasted-key path, no Dev tools menu, no Drive call in the shipped code', () => {
  const { out } = build('public', { out: scratch('public'), allowPlaceholder: true });
  for (const f of PUBLIC_FILES.filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(out, f), 'utf8');
    const code = codeOnly(src);
    assert.doesNotMatch(code, /function\s+lenzDev/, f + ': a lenzDev function');
    assert.doesNotMatch(code, /\blenzSaveKey\b|\blenzKeyLooksRight_\b|\blenzDevUseKey\b|\bLENZ_KEY_/, f + ': the pasted-key path');
    assert.doesNotMatch(src, /'lenz:apiKey|Dev tools'|Use an API key|lenzDev_menu/, f + ': a dev string');
    assert.doesNotMatch(code, /DriveApp|Drive\.|googleapis\.com\/drive/, f + ': Drive');
  }
});

test('public: config.js carries the client id it was built with and the trial log off', () => {
  const root = scratchRepo((r) => setFlavour(r, 'public', { oauthClientId: 'lzc_0123456789abcdef01234567' }));
  const { out } = build('public', { root, out: path.join(root, 'dist', 'public') });
  assert.deepEqual(configVars(out), { flavour: 'public', clientId: 'lzc_0123456789abcdef01234567', trialLog: false,
    pickerApiKey: 'AIzaSyD_OTaf-O5azXegvQtV2V_fi0x6pifGBy0', pickerAppId: '465409082149' });
  for (const f of fs.readdirSync(out)) assert.ok(!fs.readFileSync(path.join(out, f), 'utf8').includes(PLACEHOLDER), f);
});

// ── both ────────────────────────────────────────────────────────────

test('every built .js parses and stays at ES2019, config.js included', () => {
  for (const [flavour, opts] of [['internal', {}], ['public', { allowPlaceholder: true }]]) {
    const { out, files } = build(flavour, Object.assign({ out: scratch(flavour) }, opts));
    for (const f of files.filter((x) => x.endsWith('.js'))) {
      const r = spawnSync(process.execPath, ['--check', path.join(out, f)], { encoding: 'utf8' });
      assert.equal(r.status, 0, flavour + '/' + f + ': ' + r.stderr);
      assert.doesNotMatch(codeOnly(fs.readFileSync(path.join(out, f), 'utf8')), /\?\.(?!\d)|\?\?/, flavour + '/' + f);
    }
  }
});

test('a rebuild replaces the directory: nothing from an earlier build is left', () => {
  const out = scratch('stale');
  fs.writeFileSync(path.join(out, 'dev-tools.js'), 'function lenzSaveKey() {}');
  const { files } = build('public', { out, allowPlaceholder: true });
  assert.deepEqual(files, PUBLIC_FILES);
});

test('refuses: an unknown flavour, a malformed client id, an omitted file not in src/, a src manifest, an unknown key', () => {
  const refuses = (fn, re) => assert.throws(fn, (e) => e instanceof BuildError && re.test(e.message));
  refuses(() => build('staging', { out: scratch('x') }), /unknown flavour/);
  let root = scratchRepo((r) => setFlavour(r, 'public', { oauthClientId: 'not-a-client' }));
  refuses(() => build('public', { root, out: scratch('x') }), /does not look like a Lenz client id/);
  root = scratchRepo((r) => setFlavour(r, 'public', { omitFiles: ['dev.js', 'gone.js'] }));
  refuses(() => build('public', { root, out: scratch('x'), allowPlaceholder: true }), /gone\.js, not in src/);
  root = scratchRepo((r) => fs.writeFileSync(path.join(r, 'src', 'appsscript.json'), '{}'));
  refuses(() => build('internal', { root, out: scratch('x') }), /generated from config/);
  root = scratchRepo((r) => setFlavour(r, 'internal', { scopes: [] }));
  refuses(() => build('internal', { root, out: scratch('x') }), /unknown key\(s\) scopes/);
});

test('dist/, the clasp files and the internal flavour\'s config are gitignored', () => {
  const ignored = fs.readFileSync(path.join(REPO, '.gitignore'), 'utf8').split('\n');
  for (const f of ['dist/', '.clasp.json', '.deploy-id', '.clasp.public.json', '.deploy-id.public', 'config/flavours/internal.json']) {
    assert.ok(ignored.includes(f), f);
  }
});

// ── the internal flavour's config (not in git) ──────────────────────

const EXAMPLE = path.join(REPO, 'config', 'flavours', 'internal.example.json');

test('internal: without config/flavours/internal.json the build says to copy the example, and writes nothing', () => {
  const root = scratchRepo((r) => fs.rmSync(path.join(r, 'config', 'flavours', 'internal.json')));
  const out = path.join(root, 'dist', 'internal');
  assert.throws(() => buildRaw('internal', { root, out }),
    (e) => e instanceof BuildError && /internal\.json is missing.*copy config\/flavours\/internal\.example\.json/.test(e.message));
  const r = spawnSync('bash', [path.join(root, 'scripts', 'build.sh'), 'internal'], { encoding: 'utf8', cwd: root });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /internal\.json is missing/);
  assert.ok(!fs.existsSync(out));
});

test('internal: the example\'s placeholders refuse to build, unless --allow-placeholder', () => {
  const root = scratchRepo((r) => fs.copyFileSync(EXAMPLE, path.join(r, 'config', 'flavours', 'internal.json')));
  assert.throws(() => buildRaw('internal', { root, out: scratch('x') }),
    (e) => e instanceof BuildError && /example's placeholder oauthClientId, pickerApiKey, pickerAppId/.test(e.message));
  const { out } = buildRaw('internal', { root, out: scratch('x'), allowPlaceholder: true });
  assert.equal(configVars(out).clientId, EXAMPLE_VALUES.oauthClientId);
});

test('internal: the example, the test fixture and (when present) the real config have one shape and one manifest', () => {
  const example = readJson(EXAMPLE);
  const fixture = readJson(INTERNAL_FIXTURE);
  assert.deepEqual(Object.keys(example), Object.keys(fixture));
  for (const k of Object.keys(EXAMPLE_VALUES)) {
    assert.equal(example[k], EXAMPLE_VALUES[k], k);
    assert.notEqual(fixture[k], EXAMPLE_VALUES[k], k);
  }
  const rest = (c) => { const o = Object.assign({}, c); Object.keys(EXAMPLE_VALUES).forEach((k) => delete o[k]); return o; };
  assert.deepEqual(rest(example), rest(fixture));
  loadFlavour('internal', REPO, EXAMPLE);
  const real = path.join(REPO, 'config', 'flavours', 'internal.json');
  if (fs.existsSync(real)) {
    const r = readJson(real);
    assert.deepEqual(Object.keys(r), Object.keys(example), 'config/flavours/internal.json: keys differ from the example');
    assert.deepEqual(rest(r), rest(example), 'config/flavours/internal.json: update internal.example.json and the fixture with it');
  }
});
