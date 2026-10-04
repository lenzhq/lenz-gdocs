// What Apps Script will run: every src/*.js parses, stays at ES2019 (Apps Script V8: no optional
// chaining, no nullish coalescing), the sidebar builds no HTML from strings, and the glue calls
// no service the manifest has no scope for.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'src');
const JS = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// Comments and string contents out, so prose like "why?." never trips the guard.
function codeOnly(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
}

test('there are source files to check', () => {
  for (const f of ['view.js', 'Code.js', 'api.js', 'place.js', 'oauth.js']) assert.ok(JS.includes(f), f);
});

for (const f of JS) {
  test(f + ' parses (node --check)', () => {
    const r = spawnSync(process.execPath, ['--check', path.join(SRC, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  test(f + ' stays at ES2019: no ?. and no ??', () => {
    const code = codeOnly(read(f));
    assert.doesNotMatch(code, /\?\.(?!\d)/, 'optional chaining');
    assert.doesNotMatch(code, /\?\?/, 'nullish coalescing');
  });
}

test('the guard itself catches both', () => {
  assert.match(codeOnly('var a = b?.c;'), /\?\.(?!\d)/);
  assert.match(codeOnly('var a = b ?? c;'), /\?\?/);
  assert.doesNotMatch(codeOnly("var a = x ? .5 : 1; // why?. \n var s = 'a?.b';"), /\?\.(?!\d)/);
});

test('sidebar.html: its script parses and builds no HTML from strings', () => {
  const html = read('sidebar.html');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(scripts.length, 1);
  new vm.Script(scripts[0], { filename: 'sidebar.html' });
  const code = codeOnly(scripts[0]);
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.doesNotMatch(code, /\?\.(?!\d)|\?\?/);
});

// The manifests are built per flavour (scripts/build.js); test/build.test.js pins both.

test('Code.js calls no Apps Script service it has no scope for', () => {
  const code = codeOnly(read('Code.js'));
  assert.doesNotMatch(code, /DriveApp|Drive\.|GmailApp|SpreadsheetApp|Session\./);
  // ScriptApp for the sign-in's usercallback (the state token that routes it, the script id in the
  // registered redirect) and the script's own token for the Google Picker (lenzPickerConfig, as in
  // Google's Picker sample). No trigger.
  const uses = (code.match(/ScriptApp\.\w+/g) || []).filter((u, i, a) => a.indexOf(u) === i).sort();
  assert.deepEqual(uses, ['ScriptApp.getOAuthToken', 'ScriptApp.getScriptId', 'ScriptApp.newStateToken']);
});

test('no src file calls DocumentApp.create or DocumentApp.openById (they need the documents scope)', () => {
  // Per-Doc access: drive.file + documents.currentonly. Docs the add-on makes go through REST
  // (Code.js lenzRestCreateDoc_ / lenzRestAppend_); DocumentApp reaches only the open Doc.
  for (const f of JS) {
    assert.doesNotMatch(codeOnly(read(f)), /DocumentApp\.(create|openById|openByUrl)\b/, f);
  }
});

test('picker.html: its script parses, builds no HTML from strings, and loads only Google\'s api.js', () => {
  const html = read('picker.html');
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(inline.length, 1);
  new vm.Script(inline[0], { filename: 'picker.html' });
  const code = codeOnly(inline[0]);
  assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
  assert.doesNotMatch(code, /\?\.(?!\d)|\?\?/);
  const external = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(external, ['https://apis.google.com/js/api.js?onload=onApiLoad']);
  // The view shows only the open Doc, and the pick is checked against it before the server hears of it.
  assert.match(code, /new google\.picker\.DocsView\(google\.picker\.ViewId\.DOCUMENTS\)\.setFileIds\(config\.docId\)/);
  assert.match(code, /if \(id !== config\.docId\)/);
  for (const call of ['setOAuthToken(config.token)', 'setDeveloperKey(config.apiKey)', 'setAppId(config.appId)', 'setOrigin(google.script.host.origin)']) {
    assert.ok(code.includes(call), call);
  }
});
