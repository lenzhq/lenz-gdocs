#!/usr/bin/env node
// Renders the Marketplace listing screenshot (1280x800 PNG) from the REAL sidebar:
// src/sidebar.html with google.script.run stubbed to return the completed draft-b review, built
// through src/view.js, next to a Doc-like page holding test/fixtures/reviews/draft-b.txt with
// "20 July 1972" selected (the finding the list selects). No Google calls.
//
//   node scripts/render-listing-screenshot.js [out.png]
//
// Needs Google Chrome (CHROME=/path/to/chrome to override).
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const LenzView = require('../src/view.js');

const ROOT = path.join(__dirname, '..');
// Optional second argument: device scale (2 gives the 2560x1600 upload, sharp on Retina screens).
const SCALE = Number(process.argv[3] || 1);
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'listing', 'screenshot-1280x800.png'));
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SELECTED = '20 July 1972';
// The sidebar's title bar, as Code.js sets it.
const ADDON_NAME = /var LENZ_ADDON_NAME = '([^']+)'/.exec(fs.readFileSync(path.join(ROOT, 'src/Code.js'), 'utf8'))[1];

const text = fs.readFileSync(path.join(ROOT, 'test/fixtures/reviews/draft-b.txt'), 'utf8').replace(/\n+$/, '');
const body = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/reviews/draft-b.review.json'), 'utf8'));
const reply = {
  phase: 'done', auth: { mode: 'oauth', signedIn: true }, model: LenzView.build(body), nextPollS: null,
  error: null,
};

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The Doc as a reader sees it: links as linked words, the selected finding highlighted.
function docHtml() {
  const paras = text.split('\n\n');
  return paras.map((p, i) => {
    let h = esc(p).replace(/\[([^\]]*)\]\(([^)]*)\)/g, '<a>$1</a>');
    h = h.replace(esc(SELECTED), '<span class="sel">' + esc(SELECTED) + '</span>');
    return i === 0 ? '<h1>' + h + '</h1>' : '<p>' + h + '</p>';
  }).join('\n');
}

// Injected ahead of the sidebar's own script: every server function answers from `reply`.
const stub = '<script>(function(){var reply=' + JSON.stringify(reply) + ';' +
  'function runner(ok){return new Proxy({},{get:function(_,name){' +
  'if(name==="withSuccessHandler")return function(f){return runner(f);};' +
  'if(name==="withFailureHandler")return function(){return runner(ok);};' +
  'return function(){setTimeout(function(){ok(name==="lenzSelect"?{ok:true,message:null}:reply);},0);};}});}' +
  'window.google={script:{run:runner(function(){})}};})();</script>';
const sidebar = fs.readFileSync(path.join(ROOT, 'src/sidebar.html'), 'utf8').replace('<head>', '<head>' + stub);

const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; overflow: hidden; font-family: Arial, 'Helvetica Neue', sans-serif; }
  .app { display: grid; grid-template-rows: 56px 40px 1fr; height: 800px; width: 1280px; background: #f9fbfd; }
  .title { display: flex; align-items: center; gap: 12px; padding: 0 16px; background: #f9fbfd; }
  .doc-icon { width: 24px; height: 32px; border-radius: 3px; background: #4285f4; position: relative; }
  .doc-icon::after { content: ''; position: absolute; left: 5px; right: 5px; top: 12px; height: 2px; background: #fff;
    box-shadow: 0 5px 0 #fff, 0 10px 0 #fff; }
  .name { font-size: 18px; color: #1f1f1f; }
  .menus { font-size: 14px; color: #444746; margin-top: 2px; }
  .menus span { margin-right: 14px; }
  .toolbar { margin: 0 12px; background: #edf2fa; border-radius: 24px; display: flex; align-items: center; padding: 0 16px;
    gap: 18px; color: #444746; font-size: 13px; }
  .main { display: grid; grid-template-columns: 1fr 300px; min-height: 0; }
  .canvas { overflow: hidden; padding: 16px 0 0; display: flex; justify-content: center; }
  .page { width: 720px; height: 1000px; background: #fff; box-shadow: 0 1px 3px rgba(60,64,67,.3);
    padding: 72px 80px; color: #000; font-size: 15px; line-height: 1.6; }
  .page h1 { font-size: 26px; font-weight: 400; margin: 0 0 18px; }
  .page p { margin: 0 0 14px; }
  .page a { color: #1155cc; text-decoration: underline; }
  .sel { background: #c6dafc; }
  .side { border-left: 1px solid #dadce0; background: #fff; display: grid; grid-template-rows: 48px 1fr; min-height: 0; }
  .side-head { display: flex; align-items: center; justify-content: space-between; padding: 0 16px;
    font-size: 16px; color: #1f1f1f; border-bottom: 1px solid #dadce0; }
  .side-head .x { color: #444746; font-size: 20px; }
  iframe { border: 0; width: 300px; height: 100%; display: block; }
</style></head><body><div class="app">
  <div class="title"><div class="doc-icon"></div><div><div class="name">Quarterly science brief</div>
    <div class="menus"><span>File</span><span>Edit</span><span>View</span><span>Insert</span><span>Format</span>
    <span>Tools</span><span>Extensions</span><span>Help</span></div></div></div>
  <div class="toolbar"><span>100%</span><span>Normal text</span><span>Arial</span><span>11</span><span><b>B</b></span>
    <span><i>I</i></span><span><u>U</u></span></div>
  <div class="main">
    <div class="canvas"><div class="page">${docHtml()}</div></div>
    <div class="side"><div class="side-head"><span>${ADDON_NAME}</span><span class="x">&times;</span></div>
      <iframe id="sb"></iframe></div>
  </div>
</div>
<script>document.getElementById('sb').srcdoc = ${JSON.stringify(sidebar).replace(/</g, '\\u003c')};</script>
</body></html>`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lenz-listing-'));
const html = path.join(dir, 'listing.html');
fs.writeFileSync(html, page);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync(CHROME, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=' + SCALE,
  '--window-size=1280,800', '--virtual-time-budget=3000', '--screenshot=' + OUT, 'file://' + html,
], { stdio: 'ignore' });
console.log(OUT);
