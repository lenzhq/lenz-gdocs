// sidebar.html's script against a minimal fake DOM: what a stalled check, Resume and a failed review
// show and call. The server functions are stubbed; every call is recorded.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LenzView = require('../src/view.js');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'src', 'sidebar.html'), 'utf8');
const SCRIPT = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[0];
const NO_CREDITS = require('./fixtures/reviews/failed-insufficient-credits.review.json');
const NO_CLAIM = require('./fixtures/reviews/failed-no-claim.review.json');
const POLLS = require('./fixtures/reviews/draft-a.polls.json');

const STALLED = 'Lenz is not answering. Your check is kept; choose Resume to look again.';
const AUTH = { mode: 'oauth', signedIn: true };
const reply = (phase, extra) => Object.assign({ phase, auth: AUTH, model: null, nextPollS: null, error: null }, extra || {});

class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.handlers = {};
    this.hidden = false;
    this.disabled = false;
    this.className = '';
    this._text = '';
    this.attrs = {};
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._text;
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  setAttribute(k, v) { this.attrs[k] = v; }
  click() { this.handlers.click(); }
}

// Loads the sidebar's script. `replies`: server function name -> reply (a function gets the arguments).
function sidebar(replies) {
  const ids = {};
  for (const m of HTML.matchAll(/\sid="([^"]+)"/g)) ids[m[1]] = new Node('el');
  // The markup's own `hidden` attributes.
  for (const m of HTML.matchAll(/<[a-z0-9]+[^>]*\sid="([^"]+)"[^>]*>/g)) if (/\shidden[\s>]/.test(m[0])) ids[m[1]].hidden = true;
  const calls = [];
  const timeouts = [];
  const document = {
    getElementById: (id) => ids[id],
    createElement: (tag) => new Node(tag),
    createTextNode: (text) => { const n = new Node('#text'); n.textContent = text; return n; },
    querySelectorAll: () => [],
  };
  function runner(ok) {
    return new Proxy({}, {
      get(_, name) {
        if (name === 'withSuccessHandler') return (f) => runner(f);
        if (name === 'withFailureHandler') return () => runner(ok);
        return function () {
          const args = Array.from(arguments);
          calls.push({ name, args });
          const r = replies[name];
          ok(typeof r === 'function' ? r.apply(null, args) : r === undefined ? null : r);
        };
      },
    });
  }
  const ctx = vm.createContext({
    document,
    window: { addEventListener() {}, open: () => null },
    google: { script: { run: runner(function () {}) } },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    Date,
    Math,
    console,
  });
  vm.runInContext(SCRIPT, ctx, { filename: 'sidebar.html' });
  return { ids, calls, timeouts, names: () => calls.map((c) => c.name) };
}

const stalledReply = reply('stalled', {
  error: { code: 500, message: 'Lenz ran into a problem on its side. Try again in a minute.', retryable: true, retryAfterS: null },
  reviewId: '4881a880',
});

test('a stalled check: the line, Resume, Check off, and no poll scheduled', () => {
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: stalledReply, lenzLogOpen: null });
  assert.equal(s.ids.stalled.hidden, false);
  assert.equal(s.ids.stalled.textContent, STALLED);
  assert.equal(s.ids['resume-row'].hidden, false);
  assert.match(HTML, />Resume<\/button>/);
  assert.equal(s.ids.resume.disabled, false);
  assert.equal(s.ids.check.disabled, true, 'Check this Doc would read the Doc and may send a new review');
  assert.equal(s.ids.error.textContent, stalledReply.error.message);
  assert.equal(s.ids.running.hidden, true);
  assert.deepEqual(s.timeouts, [], 'nothing polls');
});

test('Resume asks the server to poll the saved check, and nothing else', () => {
  const s = sidebar({
    lenzOpen: reply('idle'),
    lenzOpenState: stalledReply,
    lenzLogOpen: null,
    lenzResume: reply('running', { model: { reviewId: '4881a880', headline: null, failure: null, groups: [], coverage: [], footnote: null, stages: [] }, nextPollS: 15 }),
  });
  const before = s.calls.length;
  s.ids.resume.click();
  const made = s.calls.slice(before);
  assert.deepEqual(made.map((c) => c.name), ['lenzResume']);
  assert.deepEqual(made[0].args, []);
  assert.ok(!s.names().includes('lenzStart') && !s.names().includes('lenzAutoStart'));
  // The reply is a running check: Resume goes, Check stays off, the poll is scheduled again.
  assert.equal(s.ids['resume-row'].hidden, true);
  assert.equal(s.ids.stalled.hidden, true);
  assert.equal(s.ids.stalled.textContent, '');
  assert.equal(s.ids.check.disabled, true);
  assert.equal(s.timeouts.length, 1);
  assert.equal(s.timeouts[0].ms, 15000);
});

test('Resume that finds Lenz still not answering, polling stops again', () => {
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: stalledReply, lenzLogOpen: null, lenzResume: stalledReply });
  s.ids.resume.click();
  assert.equal(s.ids.stalled.textContent, STALLED);
  assert.equal(s.ids['resume-row'].hidden, false);
  assert.equal(s.ids.resume.disabled, false);
  assert.deepEqual(s.timeouts, []);
});

test('a running check shows no Resume; Check comes back with a finished one', () => {
  const running = sidebar({ lenzOpen: reply('idle'), lenzOpenState: reply('running', { nextPollS: 15 }), lenzLogOpen: null });
  assert.equal(running.ids['resume-row'].hidden, true);
  assert.equal(running.ids.stalled.hidden, true);
  const done = sidebar({ lenzOpen: reply('idle'), lenzOpenState: reply('done', { model: LenzView.build(NO_CLAIM) }), lenzLogOpen: null });
  assert.equal(done.ids['resume-row'].hidden, true);
  assert.equal(done.ids.check.disabled, false);
});

test('a review that failed for credits shows its words and an Add credits link on lenz.io', () => {
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: reply('done', { model: LenzView.build(NO_CREDITS) }), lenzLogOpen: null });
  assert.equal(s.ids.headline.textContent, 'The check did not finish.');
  assert.equal(s.ids.error.textContent, 'Not enough credits to check this tab. Nothing was charged.');
  const a = s.ids['failure-link'].children[0].children[0];
  assert.equal(a.textContent, 'Add credits');
  assert.equal(a.href, 'https://lenz.io/billing');
  assert.equal(a.target, '_blank');
  assert.equal(a.rel, 'noopener noreferrer');
  assert.equal(s.ids['failure-link'].children.length, 1);
});

test('a failure without a link leaves the link area empty, and a later reply clears an earlier link', () => {
  const s = sidebar({
    lenzOpen: reply('idle'),
    lenzOpenState: reply('done', { model: LenzView.build(NO_CREDITS) }),
    lenzLogOpen: null,
    lenzStart: reply('done', { model: LenzView.build(NO_CLAIM) }),
  });
  assert.equal(s.ids['failure-link'].children.length, 1);
  s.ids.check.click();
  assert.equal(s.ids.error.textContent, 'Lenz found no factual claim to check in this tab.');
  assert.equal(s.ids['failure-link'].children.length, 0);
});

test('Check only the selected text: on and off with Check this Doc, and a note keeps the shown check', () => {
  const doneReply = reply('done', { model: LenzView.build(NO_CLAIM) });
  const note = { ok: false, message: 'Select the text to check first, then choose Check only the selected text.' };
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: doneReply, lenzLogOpen: null, lenzStartSelection: note });
  assert.match(HTML, />Check only the selected text<\/button>/);
  assert.equal(s.ids['check-selection'].disabled, false);
  s.ids['check-selection'].click();
  assert.equal(s.names().filter((n) => n === 'lenzStartSelection').length, 1);
  assert.equal(s.ids.note.textContent, note.message);
  assert.equal(s.ids.headline.textContent, doneReply.model.headline);
  assert.equal(s.ids['check-selection'].disabled, false);
  assert.equal(s.ids.check.disabled, false);
});

test('a selection check running says so, and both checks are off', () => {
  const s = sidebar({ lenzOpen: reply('idle'), lenzLogOpen: null, lenzOpenState: reply('idle'),
    lenzStartSelection: reply('running', { nextPollS: 15, selection: true, startedAt: Date.now() }) });
  s.ids['check-selection'].click();
  assert.match(s.ids.status.textContent, /checks the text you selected/);
  assert.equal(s.ids.check.disabled, true);
  assert.equal(s.ids['check-selection'].disabled, true);
});

test('a finished selection check shows what it covered', () => {
  const model = LenzView.build(NO_CLAIM, { scope: { paragraphs: 2 } });
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: reply('done', { model }), lenzLogOpen: null });
  assert.equal(s.ids.scope.textContent, model.scope);
  assert.equal(s.ids.scope.hidden, false);
});

// Every node under `n`, depth first.
function walk(n, out) {
  out = out || [];
  out.push(n);
  n.children.forEach((c) => walk(c, out));
  return out;
}

test('a deep check still running is a line of its own with moving dots, not a grey meta segment', () => {
  const model = LenzView.build(POLLS[0]);
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: reply('running', { model, nextPollS: 15 }), lenzLogOpen: null });
  const nodes = walk(s.ids.groups);
  const lines = nodes.filter((n) => n.className === 'deep-run');
  const running = model.groups.flatMap((g) => g.entries).filter((e) => e.deepRunning).length;
  assert.ok(running > 0, 'the fixture has a deep check running');
  assert.equal(lines.length, running, 'one line per claim whose deep check runs');
  const line = lines[0];
  assert.match(line.textContent, /^Deep check running/);
  assert.ok(walk(line).some((n) => n.className === 'dots'), 'the line carries the animated dots');
  assert.ok(nodes.some((n) => n.className === 'deep-run-note' && /corrections/.test(n.textContent)), 'says what to wait for');
  // The meta line no longer carries it.
  assert.ok(!nodes.some((n) => n.className === 'meta' && /deep check running/.test(n.textContent)));
});
