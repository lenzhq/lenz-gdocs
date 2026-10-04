// scripts/deploy.sh and scripts/clasp-create.sh, per flavour, against a fake clasp in a throwaway
// git repo that carries the real src/, config/ and scripts/build.*.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const { INTERNAL_FIXTURE } = require('./helpers/flavour.js');
const PUBLIC_ID = 'lzc_0123456789abcdef01234567';

// The fake answers the way clasp 3.4.1 does with --json (build/src/commands/*.js), logging each call
// (and its working directory). `-P <file>` is the project file; show-file-status lists what clasp
// would push from its rootDir, relative to the working directory, as clasp does (core/files.js).
const FAKE_CLASP = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CLASP_LOG, JSON.stringify(args) + '\\n');
fs.appendFileSync(process.env.FAKE_CLASP_LOG + '.cwd', process.cwd() + '\\n');
const rest = [];
let project = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--json') continue;
  if (args[i] === '-P') { project = args[++i]; continue; }
  rest.push(args[i]);
}
const cmd = rest[0];
const env = process.env;
if (env.FAKE_FAIL === cmd) process.exit(1);
switch (cmd) {
  case 'show-file-status': {
    let files;
    if (env.FAKE_FILES) files = JSON.parse(env.FAKE_FILES);
    else {
      const root = JSON.parse(fs.readFileSync(project, 'utf8')).rootDir;
      files = fs.readdirSync(root).filter((f) => /\\.(js|html)$|^appsscript\\.json$/.test(f)).map((f) => path.join(root, f));
    }
    console.log(JSON.stringify({ filesToPush: files, untrackedFiles: [] }));
    break;
  }
  case 'push':
    console.log('Pushed 2 files.');
    break;
  case 'create-version':
    console.log(env.FAKE_VERSION_JSON || JSON.stringify({ versionNumber: 7 }, null, 2));
    break;
  case 'create-deployment':
    console.log(JSON.stringify({ deploymentId: env.FAKE_DEPLOYMENT_ID || 'AKfycbFAKE123', versionNumber: 7, description: 'x' }, null, 2));
    break;
  case 'update-deployment':
    console.log(JSON.stringify({ deploymentId: rest[1], versionNumber: 7 }));
    break;
  case 'create-script': {
    // No project file at -P: clasp writes .clasp.json in the working directory and pulls into it.
    if (project && fs.existsSync(project) && fs.statSync(project).isFile()) { console.error('Project file already exists.'); process.exit(1); }
    const conf = { scriptId: 'SCRIPT123', rootDir: env.FAKE_ROOTDIR || '', scriptExtensions: ['.js', '.gs'] };
    if (env.FAKE_NO_SCRIPTID) delete conf.scriptId;
    fs.writeFileSync('.clasp.json', JSON.stringify(conf, null, 2));
    fs.writeFileSync('appsscript.json', '{"timeZone":"America/New_York"}');
    fs.writeFileSync('Code.js', 'function myFunction() {}');
    console.log(JSON.stringify({ scriptId: 'SCRIPT123', files: ['appsscript.json', 'Code.js'] }, null, 2));
    break;
  }
  default:
    console.error('fake clasp: unknown ' + cmd);
    process.exit(2);
}
`;

function sh(cmd, args, opts) {
  return childProcess.spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts));
}

function git(cwd, args) {
  const r = sh('git', args, { cwd });
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr);
  return r.stdout.trim();
}

const INTERNAL_CLASP = '{"scriptId":"SCRIPT123","rootDir":"dist/internal"}';
const PUBLIC_CLASP = '{"scriptId":"PUBSCRIPT9","rootDir":"dist/public"}';

// A repo like lenz-gdocs, on main, level with a bare origin. opts: claspJson (string | false),
// publicClasp (string), publicId (the committed public client id), noConfig (drop internal.json).
function repo(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lenz-deploy-'));
  const work = path.join(dir, 'work');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(work, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  ['scripts/deploy.sh', 'scripts/clasp-create.sh', 'scripts/build.sh', 'scripts/build.js', '.gitignore', '.claspignore'].forEach((f) => {
    fs.copyFileSync(path.join(REPO, f), path.join(work, f));
  });
  fs.cpSync(path.join(REPO, 'src'), path.join(work, 'src'), { recursive: true });
  fs.cpSync(path.join(REPO, 'config'), path.join(work, 'config'), { recursive: true });
  // config/flavours/internal.json is gitignored; the test's stands in for it.
  fs.copyFileSync(INTERNAL_FIXTURE, path.join(work, 'config', 'flavours', 'internal.json'));
  if (o.publicId) {
    const f = path.join(work, 'config', 'flavours', 'public.json');
    fs.writeFileSync(f, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(f, 'utf8')), { oauthClientId: o.publicId }), null, 2));
  }
  if (o.noConfig) fs.rmSync(path.join(work, 'config', 'flavours', 'internal.json'));
  fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({
    name: 'x', private: true, scripts: { test: 'node -e "process.exit(process.env.FAKE_TESTS_FAIL ? 1 : 0)"' },
  }));
  fs.writeFileSync(path.join(bin, 'clasp'), FAKE_CLASP, { mode: 0o755 });
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.email', 't@example.com']);
  git(work, ['config', 'user.name', 't']);
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '-m', 'feat: first']);
  git(dir, ['init', '-q', '--bare', 'origin.git']);
  git(work, ['remote', 'add', 'origin', path.join(dir, 'origin.git')]);
  git(work, ['push', '-q', 'origin', 'main']);
  if (o.claspJson !== false) fs.writeFileSync(path.join(work, '.clasp.json'), o.claspJson || INTERNAL_CLASP);
  if (o.publicClasp) fs.writeFileSync(path.join(work, '.clasp.public.json'), o.publicClasp);
  const log = path.join(dir, 'clasp.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(log + '.cwd', '');
  return {
    work,
    run(script, args, env) {
      return sh('bash', [path.join(work, 'scripts', script)].concat(args || []), {
        cwd: work,
        env: Object.assign({}, process.env, { PATH: bin + path.delimiter + process.env.PATH, FAKE_CLASP_LOG: log }, env || {}),
      });
    },
    calls() {
      return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    cwds() {
      return fs.readFileSync(log + '.cwd', 'utf8').split('\n').filter(Boolean);
    },
    read: (f) => fs.readFileSync(path.join(work, f), 'utf8'),
    has: (f) => fs.existsSync(path.join(work, f)),
    git: (args) => git(work, args),
  };
}

const deploy = (r, args, env) => r.run('deploy.sh', args, env);
const create = (r, args, env) => r.run('clasp-create.sh', args, env);
const pushed = (res) => res.stdout.split('\n').filter((l) => /^ {2}\S/.test(l)).map((l) => l.trim());

// ── deploy.sh, internal (the default) ───────────────────────────────────

test('deploy: the first run builds, pushes dist/internal, versions "<sha> <subject>", creates the deployment', () => {
  const r = repo();
  const res = deploy(r);
  assert.equal(res.status, 0, res.stderr);
  const desc = r.git(['rev-parse', '--short', 'HEAD']) + ' feat: first';
  assert.deepEqual(r.calls(), [
    ['--json', '-P', '.clasp.json', 'show-file-status'],
    ['-P', '.clasp.json', 'push', '--force'],
    ['--json', '-P', '.clasp.json', 'create-version', desc],
    ['--json', '-P', '.clasp.json', 'create-deployment', '--versionNumber', '7', '--description', desc],
  ]);
  assert.equal(r.read('.deploy-id'), 'AKfycbFAKE123\n');
  assert.match(res.stdout, /Flavour: +internal/);
  assert.match(res.stdout, /Script ID: +SCRIPT123/);
  assert.match(res.stdout, /Version: +7 \(/);
  assert.match(res.stdout, /Deployment ID: +AKfycbFAKE123/);
  const files = pushed(res);
  for (const f of ['Code.js', 'config.js', 'appsscript.json', 'dev-tools.js', 'dev.js', 'spike.js', 'dev-e2e.js']) {
    assert.ok(files.includes('dist/internal/' + f), f);
  }
  assert.match(r.read('dist/internal/config.js'), /LENZ_OAUTH_CLIENT_ID = "lzc_/);
});

test('deploy: "internal" named explicitly is the same deploy', () => {
  const r = repo();
  const res = deploy(r, ['internal']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(r.read('.deploy-id'), 'AKfycbFAKE123\n');
});

test('deploy: .deploy-id and dist/ are gitignored, so the tree stays clean for the next run', () => {
  const r = repo();
  deploy(r);
  assert.equal(r.git(['status', '--porcelain']), '');
});

test('deploy: later runs update the one deployment', () => {
  const r = repo();
  deploy(r);
  fs.appendFileSync(path.join(r.work, 'src', 'api.js'), '\n// v2\n');
  r.git(['commit', '-qam', 'fix: second']);
  r.git(['push', '-q', 'origin', 'main']);
  const res = deploy(r);
  assert.equal(res.status, 0, res.stderr);
  const last = r.calls().slice(-1)[0];
  const desc = r.git(['rev-parse', '--short', 'HEAD']) + ' fix: second';
  assert.deepEqual(last, ['--json', '-P', '.clasp.json', 'update-deployment', 'AKfycbFAKE123', '--versionNumber', '7', '--description', desc]);
  assert.equal(r.calls().filter((c) => c.includes('create-deployment')).length, 1);
});

test('deploy: a .clasp.json from before the flavours (rootDir src) is moved to dist/internal once', () => {
  const r = repo({ claspJson: '{"scriptId":"SCRIPT123","rootDir":"src","scriptExtensions":[".js"]}' });
  const res = deploy(r);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /rootDir src -> dist\/internal/);
  assert.deepEqual(JSON.parse(r.read('.clasp.json')), { scriptId: 'SCRIPT123', rootDir: 'dist/internal', scriptExtensions: ['.js'] });
  assert.ok(pushed(res).every((f) => f.startsWith('dist/internal/')));
});

function refuses(name, setup, pattern, env, args) {
  test('deploy: refuses ' + name + ', before any push', () => {
    const r = repo(setup && setup.repo);
    if (setup && setup.before) setup.before(r);
    const res = deploy(r, args, env);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, pattern);
    assert.ok(!r.calls().some((c) => c.includes('push')), JSON.stringify(r.calls()));
    assert.ok(!r.has('.deploy-id'));
    assert.ok(!r.has('.deploy-id.public'));
  });
}

refuses('a dirty tree', { before: (r) => fs.writeFileSync(path.join(r.work, 'stray.txt'), 'x') }, /working tree has changes/);
refuses('an uncommitted edit', { before: (r) => fs.appendFileSync(path.join(r.work, 'src', 'api.js'), '// x\n') }, /working tree has changes/);
refuses('a branch other than main', { before: (r) => r.git(['checkout', '-qb', 'feat/x']) }, /on 'feat\/x'/);
refuses('a main ahead of origin/main', {
  before: (r) => {
    fs.appendFileSync(path.join(r.work, 'src', 'api.js'), '// v3\n');
    r.git(['commit', '-qam', 'feat: unpushed']);
  },
}, /not origin\/main/);
refuses('without .clasp.json', { repo: { claspJson: false } }, /no \.clasp\.json; run scripts\/clasp-create\.sh internal/);
refuses('without the flavour config', { repo: { noConfig: true } }, /no config\/flavours\/internal\.json.*copy config\/flavours\/internal\.example\.json/);
refuses('a project file pointing elsewhere', { repo: { claspJson: '{"scriptId":"S","rootDir":"lib"}' } }, /rootDir 'lib', expected dist\/internal/);
refuses('an unknown flavour', null, /unknown flavour 'staging'/, null, ['staging']);
refuses('two flavours', null, /usage/, null, ['internal', 'public']);
refuses('when npm test fails', null, /npm test failed/, { FAKE_TESTS_FAIL: '1' });
refuses('a test file in the push', null, /must not ship:\s+test\/api\.test\.js/,
  { FAKE_FILES: '["dist/internal/api.js","dist/internal/appsscript.json","dist/internal/config.js","test/api.test.js"]' });
refuses('a src file in the push', null, /must not ship:\s+src\/api\.js/,
  { FAKE_FILES: '["src/api.js","dist/internal/appsscript.json","dist/internal/config.js"]' });
refuses('a nested file in the push', null, /must not ship:\s+dist\/internal\/sub\/x\.js/,
  { FAKE_FILES: '["dist/internal/api.js","dist/internal/appsscript.json","dist/internal/config.js","dist/internal/sub/x.js"]' });
refuses('a node file in the push', null, /must not ship/,
  { FAKE_FILES: '["dist/internal/api.js","dist/internal/appsscript.json","dist/internal/config.js","package.json"]' });
refuses('a push without the manifest', null, /would not push dist\/internal\/appsscript\.json/,
  { FAKE_FILES: '["dist/internal/api.js","dist/internal/config.js"]' });
refuses('a push without config.js', null, /would not push dist\/internal\/config\.js/,
  { FAKE_FILES: '["dist/internal/api.js","dist/internal/appsscript.json"]' });
refuses('an empty push', null, /no files/, { FAKE_FILES: '[]' });
refuses('when clasp status fails', null, /show-file-status failed/, { FAKE_FAIL: 'show-file-status' });

test('deploy: an unreadable version number stops before any deployment', () => {
  const r = repo();
  const res = deploy(r, [], { FAKE_VERSION_JSON: '{"versionNumber": null}' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /version number/);
  assert.ok(!r.calls().some((c) => c.includes('create-deployment') || c.includes('update-deployment')));
});

test('deploy: a failed create-deployment leaves no .deploy-id', () => {
  const r = repo();
  const res = deploy(r, [], { FAKE_FAIL: 'create-deployment' });
  assert.notEqual(res.status, 0);
  assert.ok(!r.has('.deploy-id'));
});

// ── deploy.sh public ────────────────────────────────────────────────────

test('deploy public: its own project file and deploy id; only the public build is pushed', () => {
  const r = repo({ publicClasp: PUBLIC_CLASP, publicId: PUBLIC_ID });
  fs.writeFileSync(path.join(r.work, '.deploy-id'), 'AKfycbINTERNAL\n');
  const res = deploy(r, ['public'], { FAKE_DEPLOYMENT_ID: 'AKfycbPUBLIC1' });
  assert.equal(res.status, 0, res.stderr);
  const desc = r.git(['rev-parse', '--short', 'HEAD']) + ' feat: first';
  assert.deepEqual(r.calls(), [
    ['--json', '-P', '.clasp.public.json', 'show-file-status'],
    ['-P', '.clasp.public.json', 'push', '--force'],
    ['--json', '-P', '.clasp.public.json', 'create-version', desc],
    ['--json', '-P', '.clasp.public.json', 'create-deployment', '--versionNumber', '7', '--description', desc],
  ]);
  assert.equal(r.read('.deploy-id.public'), 'AKfycbPUBLIC1\n');
  assert.equal(r.read('.deploy-id'), 'AKfycbINTERNAL\n', 'the internal deployment is untouched');
  assert.match(res.stdout, /Flavour: +public/);
  assert.match(res.stdout, /Script ID: +PUBSCRIPT9/);
  assert.deepEqual(pushed(res).sort(), ['Code.js', 'api.js', 'appsscript.json', 'config.js', 'oauth.js', 'picker.html', 'place.js',
    'serialize.js', 'sidebar.html', 'view.js'].map((f) => 'dist/public/' + f).sort());
  assert.ok(r.read('dist/public/config.js').includes(PUBLIC_ID));
  assert.equal(r.git(['status', '--porcelain']), '');
});

test('deploy public: later runs update the public deployment, never the internal one', () => {
  const r = repo({ publicClasp: PUBLIC_CLASP, publicId: PUBLIC_ID });
  fs.writeFileSync(path.join(r.work, '.deploy-id.public'), 'AKfycbPUBLIC1\n');
  const res = deploy(r, ['public']);
  assert.equal(res.status, 0, res.stderr);
  const last = r.calls().slice(-1)[0];
  assert.deepEqual(last.slice(0, 5), ['--json', '-P', '.clasp.public.json', 'update-deployment', 'AKfycbPUBLIC1']);
  assert.ok(!r.has('.deploy-id'));
});

// The placeholder is set explicitly, so this holds once config/flavours/public.json has the real id.
refuses('public on the placeholder client id', { repo: { publicClasp: PUBLIC_CLASP, publicId: 'REPLACE_WITH_PUBLIC_CLIENT_ID' } },
  /public build failed/, null, ['public']);
refuses('public without .clasp.public.json', { repo: { publicId: PUBLIC_ID } }, /no \.clasp\.public\.json; run scripts\/clasp-create\.sh public/, null, ['public']);
refuses('public off main', { repo: { publicClasp: PUBLIC_CLASP, publicId: PUBLIC_ID }, before: (r) => r.git(['checkout', '-qb', 'feat/x']) },
  /on 'feat\/x'/, null, ['public']);
refuses('public on a dirty tree', { repo: { publicClasp: PUBLIC_CLASP, publicId: PUBLIC_ID }, before: (r) => fs.writeFileSync(path.join(r.work, 'x.txt'), 'x') },
  /working tree has changes/, null, ['public']);
refuses('public ahead of origin/main', {
  repo: { publicClasp: PUBLIC_CLASP, publicId: PUBLIC_ID },
  before: (r) => {
    fs.appendFileSync(path.join(r.work, 'src', 'api.js'), '// v3\n');
    r.git(['commit', '-qam', 'feat: unpushed']);
  },
}, /not origin\/main/, null, ['public']);
refuses('public pointing at the internal build', { repo: { publicClasp: '{"scriptId":"P","rootDir":"dist/internal"}', publicId: PUBLIC_ID } },
  /rootDir 'dist\/internal', expected dist\/public/, null, ['public']);
refuses('public with a dev file in the push', { repo: { publicClasp: PUBLIC_CLASP, publicId: PUBLIC_ID } }, /dist\/public\/dev-tools\.js, which the public flavour leaves out/,
  { FAKE_FILES: '["dist/public/Code.js","dist/public/appsscript.json","dist/public/config.js","dist/public/dev-tools.js"]' }, ['public']);
refuses('public pushing internal files', { repo: { publicClasp: PUBLIC_CLASP, publicId: PUBLIC_ID } }, /must not ship:\s+dist\/internal\/Code\.js/,
  { FAKE_FILES: '["dist/internal/Code.js","dist/public/appsscript.json","dist/public/config.js"]' }, ['public']);

// ── clasp-create.sh ─────────────────────────────────────────────────────

test('create: makes the internal project in a scratch directory and writes .clasp.json on dist/internal', () => {
  const r = repo({ claspJson: false });
  const res = create(r);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(r.calls(), [
    ['--json', '-P', '.', 'create-script', '--type', 'standalone', '--title', 'Lenz Fact-Checking (dev)'],
  ]);
  const cwd = r.cwds()[0];
  assert.ok(!cwd.startsWith(fs.realpathSync(r.work)) && !cwd.startsWith(r.work), 'clasp ran outside the repo: ' + cwd);
  const conf = JSON.parse(r.read('.clasp.json'));
  assert.equal(conf.scriptId, 'SCRIPT123');
  assert.equal(conf.rootDir, 'dist/internal');
  assert.deepEqual(conf.scriptExtensions, ['.js', '.gs'], 'the rest of clasp\'s file is kept');
  assert.match(res.stdout, /Script ID: +SCRIPT123/);
  assert.match(res.stdout, /https:\/\/script\.google\.com\/d\/SCRIPT123\/edit/);
});

test('create: what clasp pulls stays in the scratch directory; the repo only gains the project file', () => {
  const r = repo({ claspJson: false });
  create(r);
  assert.ok(!r.has('Code.js') && !r.has('appsscript.json') && !r.has('src/appsscript.json'));
  assert.ok(!fs.existsSync(r.cwds()[0]), 'the scratch directory is removed');
  assert.equal(r.git(['status', '--porcelain']), '', '.clasp.json is gitignored and nothing else changed');
});

test('create public: "Lenz Fact-Checking", .clasp.public.json on dist/public, the internal project untouched', () => {
  const r = repo();
  const before = r.read('.clasp.json');
  const res = create(r, ['public']);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(r.calls(), [
    ['--json', '-P', '.', 'create-script', '--type', 'standalone', '--title', 'Lenz Fact-Checking'],
  ]);
  assert.equal(JSON.parse(r.read('.clasp.public.json')).rootDir, 'dist/public');
  assert.equal(r.read('.clasp.json'), before);
  assert.match(res.stdout, /Flavour: +public \(\.clasp\.public\.json, rootDir dist\/public\)/);
  assert.equal(r.git(['status', '--porcelain']), '');
});

test('create: LENZ_SCRIPT_TITLE overrides the flavour\'s title', () => {
  const r = repo({ claspJson: false });
  create(r, [], { LENZ_SCRIPT_TITLE: 'Lenz scratch' });
  assert.equal(r.calls()[0][7], 'Lenz scratch');
});

test('create: refuses when the flavour\'s project file exists, without calling clasp', () => {
  const r = repo({ publicClasp: PUBLIC_CLASP });
  let res = create(r);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /\.clasp\.json already exists \(script SCRIPT123\)/);
  res = create(r, ['public']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /\.clasp\.public\.json already exists \(script PUBSCRIPT9\)/);
  assert.deepEqual(r.calls(), []);
});

test('create: refuses an unknown flavour, without calling clasp', () => {
  const r = repo({ claspJson: false });
  const res = create(r, ['staging']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown flavour 'staging'/);
  assert.deepEqual(r.calls(), []);
});

test('create: a failed clasp, or a project file without a script id, writes no project file', () => {
  let r = repo({ claspJson: false });
  let res = create(r, [], { FAKE_FAIL: 'create-script' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /create-script failed/);
  assert.ok(!r.has('.clasp.json'));
  r = repo({ claspJson: false });
  res = create(r, ['public'], { FAKE_NO_SCRIPTID: '1' });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /no scriptId/);
  assert.ok(!r.has('.clasp.public.json'));
});

// ── .claspignore ────────────────────────────────────────────────────────

test('.claspignore keeps only top-level .js, .html and appsscript.json of rootDir', () => {
  const lines = fs.readFileSync(path.join(REPO, '.claspignore'), 'utf8').split('\n')
    .filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, ['**/**', '!*.js', '!*.html', '!appsscript.json']);
});
