// The one clasp sign-in in docs/deploy.md ("1. Sign clasp in"): it must work before .clasp.json
// exists and ask for every scope the manifest declares (clasp 3.4.1: --use-project-scopes needs a
// project).
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SETUP = fs.readFileSync(path.join(REPO, 'docs', 'deploy.md'), 'utf8');
const { flavourConfig } = require('./helpers/flavour.js');
// The manifest scopes (scripts/build.js writes them into dist/<flavour>/appsscript.json). The command
// reads the public flavour's, which is in git; the internal flavour's must be the same set.
const MANIFEST = flavourConfig('public').manifest;
const INTERNAL = flavourConfig('internal').manifest;

function loginCommand() {
  const step = SETUP.slice(SETUP.indexOf('## 1. Sign clasp in'), SETUP.indexOf('## 2.'));
  const block = step.match(/```\n([^\n]*clasp login[^\n]*)\n```/);
  assert.ok(block, 'step 1 has one fenced clasp login command');
  return block[1];
}

test('the sign-in does not depend on a project file', () => {
  const cmd = loginCommand();
  assert.ok(!cmd.includes('--use-project-scopes'), 'needs .clasp.json with a script id in clasp 3.4.1');
  assert.ok(!cmd.includes('--include-clasp-scopes'), 'only valid with --use-project-scopes');
  assert.match(cmd, /^clasp login --no-localhost --creds \.secrets\/client\.json --extra-scopes /);
});

test('the sign-in passes every manifest scope to clasp, read from the manifest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lenz-login-'));
  const log = path.join(dir, 'args.json');
  fs.writeFileSync(path.join(dir, 'clasp'),
    '#!/usr/bin/env node\nrequire("fs").writeFileSync(process.env.ARGS_LOG, JSON.stringify(process.argv.slice(2)));\n',
    { mode: 0o755 });
  const cmd = loginCommand();
  const res = childProcess.spawnSync('bash', ['-c', cmd], {
    cwd: REPO,
    encoding: 'utf8',
    env: Object.assign({}, process.env, { PATH: dir + path.delimiter + process.env.PATH, ARGS_LOG: log }),
  });
  assert.equal(res.status, 0, res.stderr);
  const args = JSON.parse(fs.readFileSync(log, 'utf8'));
  const scopes = args[args.indexOf('--extra-scopes') + 1].split(',');
  assert.ok(MANIFEST.oauthScopes.length > 0);
  assert.deepEqual(scopes, MANIFEST.oauthScopes);
  scopes.forEach((s) => assert.match(s, /^https:\/\/www\.googleapis\.com\/auth\/[a-z._]+$/));
});

test('the one sign-in also covers every scope of the internal build', () => {
  INTERNAL.oauthScopes.forEach((s) => assert.ok(MANIFEST.oauthScopes.includes(s), s));
});
