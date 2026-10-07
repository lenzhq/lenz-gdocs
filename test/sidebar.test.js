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
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  removeChild(c) { c.parent = null; this.children = this.children.filter((x) => x !== c); return c; }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  click() { this.handlers.click(); }
  // <details>: opening or closing fires `toggle`, as the browser does.
  get open() { return !!this._open; }
  set open(v) { this._open = !!v; if (this.handlers.toggle) this.handlers.toggle(); }
  // The selectors the script uses on a node: `li.entry` up, `button, a` down.
  closest(sel) {
    for (let n = this; n; n = n.parent) if (sel === 'li.entry' && n.tag === 'li' && n.className === 'entry') return n;
    return null;
  }
  querySelectorAll(sel) {
    return sel === 'button, a' ? walk(this).filter((n) => n !== this && (n.tag === 'button' || n.tag === 'a')) : [];
  }
  focus() { Node.page.document.activeElement = this; }
  getBoundingClientRect() { return Node.page.box(this); }
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
    activeElement: null,
    querySelectorAll: (sel) => (sel === '#groups li.entry' ? entries() : []),
  };
  // A toy layout, enough to see a list move: the running block takes 100 px while shown, a heading or
  // a summary 20, an entry 10 per node it holds (it grows as its check fills in), and nothing inside a
  // closed group. The window is 600 px high; scrolling moves every box.
  const win = { addEventListener() {}, open: () => null, scrollY: 0, innerHeight: 600,
    scrollBy(x, y) { win.scrollY = Math.max(0, win.scrollY + y); } };
  function entries() { return walk(ids.groups).filter((n) => n.tag === 'li' && n.className === 'entry'); }
  function box(node) {
    let y = ids.running.hidden ? 0 : 100;
    let found = null;
    (function lay(n, shown) {
      if (n.tag === 'li' && n.className === 'entry') {
        const h = shown ? 10 * walk(n).length : 0;
        if (n === node) found = { top: y - win.scrollY, bottom: y + h - win.scrollY, height: h };
        y += h;
        return;
      }
      if (shown && (n.tag === 'h2' || n.tag === 'summary')) y += 20;
      n.children.forEach((c) => lay(c, shown && (n.tag !== 'details' || n.open || c.tag === 'summary')));
    })(ids.groups, true);
    return found || { top: 0, bottom: 0, height: 0 };
  }
  Node.page = { document, box };
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
    window: win,
    google: { script: { run: runner(function () {}) } },
    setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout: () => {},
    setInterval: () => 0,
    Date,
    Math,
    console,
  });
  vm.runInContext(SCRIPT, ctx, { filename: 'sidebar.html' });
  return { ids, calls, timeouts, document, window: win, entries, names: () => calls.map((c) => c.name) };
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
  // What to wait for is said once, under the first such claim, not under every one.
  const notes = nodes.filter((n) => n.className === 'deep-run-note');
  assert.equal(notes.length, 1, 'the note once, however many deep checks run');
  assert.match(notes[0].textContent, /corrections/);
  const first = nodes.find((n) => n.className === 'entry' && walk(n).includes(line));
  assert.ok(walk(first).includes(notes[0]), 'under the first claim whose deep check runs');
  // The meta line no longer carries it.
  assert.ok(!nodes.some((n) => n.className === 'meta' && /deep check running/.test(n.textContent)));
});

// Reading one claim while the others update (a user's report: the content jumped). Poll 3 of the
// captured review runs with deep checks still going on the claims above claim:1; poll 5 is done, so
// those claims grow with their results and the running lines above the list go.
function readingAcrossAPoll(setUp) {
  const s = sidebar({
    lenzOpen: reply('idle'),
    lenzOpenState: reply('running', { model: LenzView.build(POLLS[3]), nextPollS: 15 }),
    lenzPoll: reply('done', { model: LenzView.build(POLLS[5]) }),
    lenzLogOpen: null,
  });
  const entry = (id) => s.entries().find((n) => n.getAttribute('data-id') === id);
  setUp(s, entry);
  s.timeouts.filter((t) => t.ms === 15000).pop().fn(); // the poll
  return { s, entry };
}

test('the claim being read keeps its place on screen when a poll re-renders the list', () => {
  let before;
  const { entry } = readingAcrossAPoll((s, entry) => {
    s.window.scrollBy(0, entry('claim:1').getBoundingClientRect().top - 40);
    before = entry('claim:1').getBoundingClientRect().top;
  });
  assert.equal(before, 40);
  assert.equal(entry('claim:1').getBoundingClientRect().top, 40, 'still 40 px from the top');
});

test('the focused claim is the one held, and focus comes back to the same control', () => {
  const { s, entry } = readingAcrossAPoll((s, entry) => {
    s.window.scrollBy(0, entry('claim:0').getBoundingClientRect().top - 10); // claim:1 lower down, focused
    entry('claim:1').querySelectorAll('button, a')[0].focus();
    assert.ok(entry('claim:1').getBoundingClientRect().top > 10);
    s.held = entry('claim:1').getBoundingClientRect().top;
  });
  assert.equal(entry('claim:1').getBoundingClientRect().top, s.held);
  const focused = s.document.activeElement;
  assert.equal(focused, entry('claim:1').querySelectorAll('button, a')[0], 'the new title button has focus');
});

test('at the top of the panel nothing is held, so new results show', () => {
  const { s } = readingAcrossAPoll(() => {});
  assert.equal(s.window.scrollY, 0);
});

test('a folded group the reader opened stays open across polls', () => {
  const { s } = readingAcrossAPoll((s) => {
    const d = walk(s.ids.groups).find((n) => n.tag === 'details');
    assert.ok(d && !d.open, 'Checks out starts folded behind the issues');
    d.open = true;
  });
  const d = walk(s.ids.groups).find((n) => n.tag === 'details');
  assert.ok(d.open, 'still open after the poll');
});

// "Updating…" says a list kept from last time is shown while the real state loads. On opening a Doc
// with no kept list it said so over nothing, and the per-Doc access prompt never took it away.
test('opening with no kept list says nothing is updating', () => {
  const s = sidebar({ lenzOpen: reply('idle', { stale: true }), lenzOpenState: () => undefined, lenzLogOpen: null });
  assert.ok(s.ids.updating.hidden, 'no Updating… over an empty panel');
});

test('a kept list says Updating… until the real state arrives', () => {
  const model = LenzView.build(POLLS[5]);
  const s = sidebar({ lenzOpen: reply('done', { model, stale: true }), lenzOpenState: () => undefined, lenzLogOpen: null });
  assert.equal(s.ids.updating.textContent, 'Updating…');
  assert.ok(!s.ids.updating.hidden);
});

test('the access prompt takes Updating… away: the real state has answered', () => {
  const model = LenzView.build(POLLS[5]);
  for (const first of [reply('idle', { stale: true }), reply('done', { model, stale: true })]) {
    const s = sidebar({ lenzOpen: first, lenzOpenState: reply('needs_file_access', { ok: false, message: null }), lenzLogOpen: null });
    assert.ok(!s.ids.access.hidden, 'the prompt shows');
    assert.ok(s.ids.updating.hidden, 'and no Updating… under it');
  }
});
