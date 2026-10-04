#!/usr/bin/env node
// Renders every sidebar state (300 px wide, the sidebar's width) and the picker dialog to PNGs, for
// visual QA. The REAL src/sidebar.html and src/picker.html, with google.script.run stubbed to answer
// each state's replies (models built by src/view.js from the captured draft-a review). No Google
// calls; the picker's external api.js is left out, so it shows its own chrome.
//
//   node scripts/render-sidebar-states.js <out dir> [src dir] [scale]
//
// `src dir` defaults to src/ (pass another checkout's src/ to render a "before"). Scale defaults to 2.
// Needs Google Chrome (CHROME=/path/to/chrome to override).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const LenzView = require('../src/view.js');

const ROOT = path.join(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tmp', 'visual-qa', 'after'));
const SRC = path.resolve(process.argv[3] || path.join(ROOT, 'src'));
const SCALE = Number(process.argv[4] || 2);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIX = path.join(ROOT, 'test', 'fixtures', 'reviews');

const review = JSON.parse(fs.readFileSync(path.join(FIX, 'draft-a.review.json'), 'utf8'));
const polls = JSON.parse(fs.readFileSync(path.join(FIX, 'draft-a.polls.json'), 'utf8'));
const AUTH = { mode: 'oauth', signedIn: true };
const reply = (phase, extra) => Object.assign({ phase, auth: AUTH, model: null, nextPollS: null, error: null }, extra || {});

// Results with every edit row: the claim's own edit to apply, one applied (Undo), one "Now suggested:".
function resultsModel() {
  const m = LenzView.build(review);
  const entry = m.groups.flatMap((g) => g.entries).find((e) => e.edits.length);
  const e = entry.edits[0];
  entry.edits = [
    e,
    Object.assign({}, e, { id: e.id + ':applied', from: 'in July 1969', to: 'on 20 July 1969', mode: 'applied', applied: true,
      undo: { claimIndex: e.claimIndex, editIndex: 1, fp: e.fp } }),
    Object.assign({}, e, { id: e.id + ':suggest', from: 'first person', to: 'second person', mode: 'suggest' }),
  ];
  return m;
}

// A clean Doc: only "Checks out", open.
function cleanModel() {
  const m = LenzView.build(review);
  const ok = m.groups.find((g) => g.key === 'ok');
  return Object.assign({}, m, { headline: 'No issues found.', coverage: [], groups: [Object.assign({}, ok, { collapsed: false })] });
}

const STATES = {
  'signed-out': { height: 560, replies: { lenzOpen: reply('signed_out'), lenzOpenState: reply('signed_out', { auth: { mode: 'oauth', signedIn: false } }),
    lenzSignInUrl: { url: 'https://lenz.io/oauth2/authorize', message: null } } },
  'needs-access': { height: 560, replies: { lenzOpen: reply('idle'), lenzOpenState: reply('needs_file_access', { ok: false, message: null }) } },
  running: { height: 1500, replies: { lenzOpen: reply('running'), lenzOpenState: reply('running', {
    model: LenzView.build(polls[0]), nextPollS: 600, startedAt: Date.now() - 102000 }) } },
  results: { height: 1900, replies: { lenzOpen: reply('done'), lenzOpenState: reply('done', { model: resultsModel() }) } },
  clean: { height: 900, replies: { lenzOpen: reply('done'), lenzOpenState: reply('done', { model: cleanModel() }) } },
  error: { height: 520, replies: { lenzOpen: reply('idle'), lenzOpenState: reply('error', {
    error: { code: 0, message: "Couldn't reach Lenz. Check your connection and try again.", retryable: true } }) } },
  footer: { height: 420, replies: { lenzOpen: reply('idle'), lenzOpenState: reply('idle') } },
};

// Injected ahead of the page's own script: each server function answers from `replies`.
function stub(replies) {
  return '<script>(function(){var replies=' + JSON.stringify(replies).replace(/</g, '\\u003c') + ';' +
    'function runner(ok){return new Proxy({},{get:function(_,name){' +
    'if(name==="withSuccessHandler")return function(f){return runner(f);};' +
    'if(name==="withFailureHandler")return function(){return runner(ok);};' +
    'return function(){var r=replies[name];setTimeout(function(){ok(r===undefined?null:r);},0);};}});}' +
    'window.google={script:{run:runner(function(){}),host:{origin:"https://docs.google.com",close:function(){}}}};})();</script>';
}

// Headless Chrome lays a narrow window out wider than asked (its minimum window width), so the page
// is framed: an iframe of exactly `width` px, as Docs frames the sidebar.
function shoot(name, html, width, height) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lenz-qa-'));
  const file = path.join(dir, name + '.html');
  fs.writeFileSync(file, '<!DOCTYPE html><html><body style="margin:0;background:#fff">' +
    '<iframe id="f" style="border:0;display:block;width:' + width + 'px;height:' + height + 'px"></iframe>' +
    '<script>document.getElementById("f").srcdoc = ' + JSON.stringify(html).replace(/</g, '\\u003c') + ';</script></body></html>');
  const out = path.join(OUT, name + '.png');
  execFileSync(CHROME, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=' + SCALE,
    '--window-size=' + width + ',' + height, '--virtual-time-budget=3000', '--screenshot=' + out, 'file://' + file,
  ], { stdio: 'ignore' });
  console.log(out);
}

fs.mkdirSync(OUT, { recursive: true });
const sidebar = fs.readFileSync(path.join(SRC, 'sidebar.html'), 'utf8');
for (const [name, s] of Object.entries(STATES)) {
  shoot(name, sidebar.replace('<head>', '<head>' + stub(s.replies)), 300, s.height);
}
const picker = fs.readFileSync(path.join(SRC, 'picker.html'), 'utf8').replace(/<script src="[^"]*"><\/script>/, '');
shoot('picker', picker.replace('<head>', '<head>' + stub({ lenzPickerConfig: null })), 760, 520);
