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
    if (sel === 'button, a') return walk(this).filter((n) => n !== this && (n.tag === 'button' || n.tag === 'a'));
    if (sel === 'button, a, summary') return walk(this).filter((n) => n !== this && (n.tag === 'button' || n.tag === 'a' || n.tag === 'summary'));
    return [];
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
    focused: true, // the sidebar's own document has focus (false: the reader is typing in the Doc)
    hasFocus: () => document.focused,
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
  assert.equal(s.ids['failure-note'].textContent, 'Lenz found no factual claim to check in this tab.');
  assert.equal(s.ids.error.textContent, '');
  assert.equal(s.ids['failure-link'].children.length, 0);
});

test('an unreadable page and a text with no claim show as a note, not the red error line; a failure of ours clears it', () => {
  const unreadable = LenzView.build(Object.assign({}, NO_CLAIM, { failure: { code: 'page_unreadable', failure_class: 'invalid_input', retryable: false } }));
  const ours = LenzView.build(Object.assign({}, NO_CLAIM, { failure: { code: 'internal', failure_class: 'internal', retryable: false } }));
  const s = sidebar({
    lenzOpen: reply('idle'),
    lenzOpenState: reply('done', { model: unreadable }),
    lenzLogOpen: null,
    lenzStart: reply('done', { model: ours }),
  });
  assert.equal(s.ids['failure-note'].textContent, "Lenz couldn't read that page. Paste its text instead.");
  assert.equal(s.ids['failure-note'].hidden, false);
  assert.equal(s.ids.error.textContent, '');
  s.ids.check.click();
  assert.equal(s.ids['failure-note'].textContent, '');
  assert.equal(s.ids['failure-note'].hidden, true);
  assert.equal(s.ids.error.textContent, 'Something went wrong on our side. Checks that did not finish were not charged.');
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
  assert.equal(s.ids.headline.textContent, doneReply.model.headline || ''); // a no-claim failure has no headline
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

test('a deep check still running is a badge on its card with moving dots, not a grey meta segment', () => {
  const model = LenzView.build(POLLS[0]);
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: reply('running', { model, nextPollS: 15 }), lenzLogOpen: null });
  const nodes = walk(s.ids.groups);
  const badges = nodes.filter((n) => n.className === 'deep-badge');
  const running = model.groups.flatMap((g) => g.entries).filter((e) => e.deepRunning).length;
  assert.ok(running > 0, 'the fixture has a deep check running');
  assert.equal(badges.length, running, 'one badge per claim whose deep check runs');
  const badge = badges[0];
  assert.match(badge.textContent, /^Deep check running/);
  assert.ok(walk(badge).some((n) => n.className === 'dots'), 'the badge carries the animated dots');
  // It sits in the card's head, beside the verdict, where it is seen without reading the card.
  assert.equal(badge.parent.className, 'head');
  // What to wait for is said once, under the first such claim, not under every one.
  const notes = nodes.filter((n) => n.className === 'deep-run-note');
  assert.equal(notes.length, 1, 'the note once, however many deep checks run');
  assert.match(notes[0].textContent, /corrections/);
  const first = nodes.find((n) => n.className === 'entry' && walk(n).includes(badge));
  assert.ok(walk(first).includes(notes[0]), 'under the first claim whose deep check runs');
  // The meta line no longer carries it.
  assert.ok(!nodes.some((n) => n.className === 'meta' && /deep check running/.test(n.textContent)));
  // A card whose deep check is not running has no badge.
  const idle = nodes.filter((n) => n.className === 'entry' && !walk(n).some((c) => c.className === 'deep-badge'));
  assert.equal(idle.length, nodes.filter((n) => n.className === 'entry').length - running);
});

test('the progress block stays at the top while the list scrolls under it', () => {
  const css = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  const rule = css.match(/\.running\s*\{([^}]*)\}/)[1];
  assert.match(rule, /position:\s*sticky/);
  assert.match(rule, /top:\s*0/);
  assert.match(rule, /background:/, 'opaque, so the cards do not show through');
});

test('the progress block lists the deep checks with the others', () => {
  const model = LenzView.build(POLLS[0]);
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: reply('running', { model, nextPollS: 15 }), lenzLogOpen: null });
  const rows = s.ids.stages.children.map((li) => li.textContent);
  assert.deepEqual(rows, ['Quick checks\u2713 5 of 5', 'Deep checks0 of 3', 'Citation checks0 of 2']);
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

// A deep check that ends can change its claim's verdict, and with it the group the claim sorts into.
// While the check runs a claim stays where the reader first saw it; the lists settle once it ends.
function deepEnded(body, index, verdict = 'True') {
  const b = JSON.parse(JSON.stringify(body));
  for (const i of [index]) {
    const c = b.claims[i];
    c.result = { verdict, confidence: 'high', source: 'verification', is_issue: false };
    c.verification.status = 'completed';
    c.verification.lenz_score = 9;
  }
  return b;
}
// The group (heading text) each entry shows under, in the fake DOM.
function groupsShown(s) {
  const out = {};
  let heading = null;
  for (const n of s.ids.groups.children) {
    if (n.tag === 'h2') heading = n.textContent;
    const summary = n.tag === 'details' ? n.children.find((c) => c.tag === 'summary') : null;
    if (summary) heading = summary.textContent;
    for (const li of walk(n).filter((x) => x.tag === 'li' && x.className === 'entry')) out[li.getAttribute('data-id')] = heading;
  }
  return out;
}
function polling(bodies, final) {
  const queue = bodies.slice(1).map((b) => reply('running', { model: LenzView.build(b), nextPollS: 15 }));
  queue.push(reply('done', { model: LenzView.build(final) }));
  const s = sidebar({
    lenzOpen: reply('idle'),
    lenzOpenState: reply('running', { model: LenzView.build(bodies[0]), nextPollS: 15 }),
    lenzPoll: () => queue.shift(),
    lenzLogOpen: null,
  });
  s.poll = () => s.timeouts.filter((t) => t.ms === 15000).pop().fn();
  return s;
}

test('a claim whose deep check ends stays in its group while the check runs, and settles when it ends', () => {
  const running = POLLS[3];
  const changed = deepEnded(running, 1); // claim:1 was an issue; its deep check says True
  assert.equal(LenzView.build(changed).groups.find((g) => g.entries.some((e) => e.id === 'claim:1')).key, 'ok');
  const final = deepEnded(POLLS[5], 1);
  const s = polling([running, changed], final);
  const before = groupsShown(s);
  assert.match(before['claim:1'], /^Issues/);
  s.poll();
  assert.deepEqual(groupsShown(s), Object.assign({}, before, {}), 'nothing moved');
  // The card itself did change in place: its stamp now carries the deep verdict.
  const stamp = (id) => walk(s.entries().find((n) => n.getAttribute('data-id') === id)).find((n) => /stamp/.test(n.className)).textContent;
  assert.equal(stamp('claim:1'), 'True');
  s.poll(); // the check ended
  assert.match(groupsShown(s)['claim:1'], /^Checks out/);
});

test('stable order: a group is counted by what it shows, and a claim that arrives joins its group', () => {
  const running = POLLS[3];
  const changed = deepEnded(running, 1);
  const s = polling([running, changed], deepEnded(POLLS[5], 1));
  s.poll();
  const heads = s.ids.groups.children.filter((n) => n.tag === 'h2').map((n) => n.textContent);
  assert.equal(heads[0], 'Issues (3)', 'the claim that now says True is still counted under Issues');
  // With nothing changed the pinned lists are exactly the model's own order, group by group.
  const m = LenzView.build(running);
  const flat = m.groups.flatMap((g) => g.entries.map((e) => e.id));
  const shown = walk(s.ids.groups).filter((n) => n.tag === 'li' && n.className === 'entry').map((n) => n.getAttribute('data-id'));
  assert.deepEqual(shown, flat);
});

test('stable order: a new review, or a finished one, shows the model as it is', () => {
  const changed = deepEnded(POLLS[3], 1);
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: reply('done', { model: LenzView.build(deepEnded(POLLS[5], 1)) }), lenzLogOpen: null });
  assert.match(groupsShown(s)['claim:1'], /^Checks out/);
  const t = polling([POLLS[3], changed], changed);
  t.poll();
  assert.match(groupsShown(t)['claim:1'], /^Issues/, 'still held while it runs');
  t.poll();
  assert.match(groupsShown(t)['claim:1'], /^Checks out/, 'a check that ended is never held back');
});

test('when the lists settle, the reader keeps the claim that stayed put', () => {
  // claim:1 is the last issue and the one in view; its deep check ends as the check does, so it moves
  // to "Needs a closer look", which shows. The reader stays on the claim that did not move (citation:1,
  // below it), not carried down to wherever claim:1 went.
  const final = deepEnded(POLLS[5], 1, 'Mixed');
  const s = polling([POLLS[3]], final);
  const entry = (id) => s.entries().find((n) => n.getAttribute('data-id') === id);
  s.window.scrollBy(0, entry('claim:1').getBoundingClientRect().top - 40);
  const held = entry('citation:1').getBoundingClientRect().top;
  assert.ok(held > 40);
  s.poll();
  assert.match(groupsShown(s)['claim:1'], /^Needs a closer look/);
  assert.equal(entry('citation:1').getBoundingClientRect().top, held, 'citation:1 has not moved on screen');
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

// The three dots follow their word with no space, like a typed ellipsis ("Deep check running..."),
// as on every Lenz page that shows them (DESIGN.md § Motion). A flex gap on their line is a space.
test('the animated dots follow their words with no gap', () => {
  const css = HTML.match(/<style>([\s\S]*?)<\/style>/)[1];
  for (const cls of ['run-line', 'deep-badge']) {
    const rule = css.match(new RegExp('\\.' + cls + '\\s*\\{([^}]*)\\}'))[1];
    assert.doesNotMatch(rule, /(^|[;\s])gap\s*:/, '.' + cls + ' puts no gap before the dots');
  }
  assert.doesNotMatch(css.match(/\.dots\s*\{([^}]*)\}/)[1], /margin|padding/, 'nor does .dots itself');
});

// Focus follows the control, not its position: a poll that adds an edit above the focused Apply must
// not hand focus (and the next Enter) to a different correction.
test('focus stays on the same correction when a poll adds an edit above it', () => {
  const withEdits = (edits) => {
    const m = LenzView.build(POLLS[5]);
    const entry = m.groups.flatMap((g) => g.entries).find((e) => e.edits.length);
    entry.edits = edits(entry.edits[0]);
    return { m, entry };
  };
  const extra = (e) => Object.assign({}, e, { id: e.id + ':other', fp: 'other', from: 'first person', to: 'second person' });
  const before = withEdits((e) => [e]);
  const after = withEdits((e) => [extra(e), e]);
  const s = sidebar({
    lenzOpen: reply('idle'),
    lenzOpenState: reply('running', { model: before.m, nextPollS: 15 }),
    lenzPoll: reply('done', { model: after.m }),
    lenzLogOpen: null,
  });
  const applies = () => walk(s.ids.groups).filter((n) => n.tag === 'button' && n.textContent === 'Apply');
  applies()[0].focus();
  const want = applies()[0].getAttribute('data-focus');
  s.timeouts.filter((t) => t.ms === 15000).pop().fn();
  assert.equal(applies().length, 2);
  assert.equal(s.document.activeElement, applies()[1], 'the same edit, now second');
  assert.equal(s.document.activeElement.getAttribute('data-focus'), want);
});

test('a poll never takes the keyboard from the Doc: no focus restored when the sidebar lacks it', () => {
  let title;
  const { s } = readingAcrossAPoll((s, entry) => {
    title = entry('claim:1').querySelectorAll('button, a')[0];
    title.focus();
    s.document.focused = false; // the reader went back to editing; activeElement stays on the title
  });
  assert.equal(s.document.activeElement, title, 'focus() was not called on the new title button');
});

// ── Cancel ──────────────────────────────────────────────────

const CANCELLED = require('./fixtures/reviews/cancelled-midway.review.json');
const FINAL = POLLS[POLLS.length - 1];
const runningReply = () => reply('running', { model: LenzView.build(POLLS[0]), nextPollS: 15, startedAt: Date.now() - 60000 });

test('Cancel shows for the whole running state and is gone after it', () => {
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: runningReply(), lenzLogOpen: null });
  assert.equal(s.ids.cancel.hidden, false);
  assert.equal(s.ids['cancel-confirm'].hidden, true);
  for (const r of [reply('done', { model: LenzView.build(FINAL) }), stalledReply, reply('idle'),
    reply('error', { error: { code: 0, message: 'x', retryable: true } })]) {
    const t = sidebar({ lenzOpen: reply('idle'), lenzOpenState: r, lenzLogOpen: null });
    assert.equal(t.ids.cancel.hidden, true, r.phase);
    assert.equal(t.ids['cancel-confirm'].hidden, true, r.phase);
  }
});

test('Cancel asks first: Keep checking sends nothing and keeps polling', () => {
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: runningReply(), lenzLogOpen: null });
  const before = s.calls.length;
  s.ids.cancel.click();
  assert.equal(s.ids.cancel.hidden, true);
  assert.equal(s.ids['cancel-confirm'].hidden, false);
  assert.match(HTML, /Stop this check\? Findings already shown stay\./);
  s.ids['cancel-keep'].click();
  assert.equal(s.ids.cancel.hidden, false);
  assert.equal(s.ids['cancel-confirm'].hidden, true);
  assert.equal(s.calls.length, before, 'no server call');
  assert.equal(s.timeouts.length, 1, 'the poll is still scheduled');
});

test('Stop the check: one lenzCancel even when clicked again while it runs; the cancelled review shows', () => {
  let s;
  let during = null;
  s = sidebar({
    lenzOpen: reply('idle'), lenzOpenState: runningReply(), lenzLogOpen: null,
    lenzCancel: () => {
      during = { disabled: s.ids['cancel-go'].disabled, words: s.ids['cancel-go'].textContent };
      s.ids['cancel-go'].click(); // a second click while the first is in flight
      return reply('done', { model: LenzView.build(CANCELLED) });
    },
  });
  s.ids.cancel.click();
  s.ids['cancel-go'].click();
  assert.equal(s.names().filter((n) => n === 'lenzCancel').length, 1);
  assert.deepEqual(s.calls.find((c) => c.name === 'lenzCancel').args, [POLLS[0].review_id], 'the review on screen');
  assert.deepEqual(during, { disabled: true, words: 'Stopping…' });
  assert.equal(s.ids.headline.textContent, 'Check cancelled.');
  assert.equal(s.ids['stopped-line'].textContent, 'What it found before you stopped it stays below. Charged 25 credits.');
  assert.equal(s.ids.cancel.hidden, true);
  assert.equal(s.ids['cancel-confirm'].hidden, true);
  assert.equal(s.ids.running.hidden, true);
  assert.equal(s.ids.check.disabled, false);
  assert.equal(s.ids['check-selection'].disabled, false);
  assert.equal(s.ids['resume-row'].hidden, true);
  assert.ok(s.entries().length > 0, 'the findings stay');
});

test('cancel vs complete: a check that finished first shows its results, nothing says cancelled', () => {
  const s = sidebar({
    lenzOpen: reply('idle'), lenzOpenState: runningReply(), lenzLogOpen: null,
    lenzCancel: reply('done', { model: LenzView.build(FINAL) }),
  });
  s.ids.cancel.click();
  s.ids['cancel-go'].click();
  assert.equal(s.ids.headline.textContent, '3 issues to look at.');
  assert.equal(s.ids['stopped-line'].hidden, true);
  assert.equal(s.ids.check.disabled, false);
});

test('a check that ends while the confirmation is open closes it', () => {
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: runningReply(), lenzLogOpen: null,
    lenzPoll: reply('done', { model: LenzView.build(FINAL) }) });
  s.ids.cancel.click();
  s.timeouts.pop().fn(); // the scheduled poll
  assert.equal(s.ids['cancel-confirm'].hidden, true);
  assert.equal(s.ids.cancel.hidden, true);
  assert.equal(s.ids.headline.textContent, '3 issues to look at.');
});

test('a cancel Lenz did not answer: still running with the error, and Cancel can be chosen again', () => {
  const s = sidebar({
    lenzOpen: reply('idle'), lenzOpenState: runningReply(), lenzLogOpen: null,
    lenzCancel: reply('running', { model: LenzView.build(POLLS[0]), nextPollS: 15,
      error: { code: 0, message: "Couldn't reach Lenz. Check your connection and try again.", retryable: true } }),
  });
  s.ids.cancel.click();
  s.ids['cancel-go'].click();
  assert.equal(s.ids.error.textContent, "Couldn't reach Lenz. Check your connection and try again.");
  assert.equal(s.ids.cancel.hidden, false);
  assert.equal(s.ids['cancel-confirm'].hidden, true);
  assert.equal(s.ids['cancel-go'].disabled, false);
});

// ── Pages the reviewers looked at ───────────────────────────

const pg = (n) => Array.from({ length: n }, (_, i) => ({ title: 'Page ' + (i + 1), url: 'https://example.org/p' + (i + 1) }));
// A poll of the captured review whose claim 3 (quick-checked only) carries `pages`.
const withPages = (poll, pages, id) => {
  const body = JSON.parse(JSON.stringify(poll));
  body.claims.find((c) => c.index === 3).assessment.searched_pages = pages;
  if (id) body.review_id = id;
  return LenzView.build(body);
};
const pagesBoxes = (s) => walk(s.ids.groups).filter((n) => n.tag === 'details' && n.className === 'pages');
const pageLinks = (box) => walk(box).filter((n) => n.tag === 'a');
const showAll = (box) => walk(box).find((n) => n.tag === 'button' && /^Show all/.test(n.textContent));
function pagesSidebar(pages, extra) {
  return sidebar(Object.assign({
    lenzOpen: reply('idle'),
    lenzOpenState: reply('running', { model: withPages(POLLS[3], pages), nextPollS: 15 }),
    lenzPoll: reply('done', { model: withPages(POLLS[5], pages) }),
    lenzLogOpen: null,
  }, extra || {}));
}
const poll = (s) => s.timeouts.filter((t) => t.ms === 15000).pop().fn();

test('pages: a closed disclosure under the row, its summary exact, the first five as links in a new tab', () => {
  const s = pagesSidebar(pg(7));
  const boxes = pagesBoxes(s);
  assert.equal(boxes.length, 1, 'only the row that has pages');
  const box = boxes[0];
  assert.equal(box.open, false, 'closed by default');
  const summary = box.children[0];
  assert.equal(summary.tag, 'summary');
  assert.equal(summary.textContent, 'Pages the reviewers looked at (7)');
  const links = pageLinks(box);
  assert.deepEqual(links.map((a) => a.textContent), ['Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5']);
  assert.equal(links[0].href, 'https://example.org/p1');
  for (const a of links) {
    assert.equal(a.target, '_blank');
    assert.equal(a.rel, 'noopener noreferrer nofollow ugc');
  }
  assert.equal(showAll(box).textContent, 'Show all 7');
  // It sits inside the claim's entry.
  assert.equal(box.closest('li.entry').getAttribute('data-id'), 'claim:3');
});

test('pages: five or fewer show no Show all; none shows nothing at all', () => {
  assert.equal(showAll(pagesBoxes(pagesSidebar(pg(5)))[0]), undefined);
  assert.equal(pageLinks(pagesBoxes(pagesSidebar(pg(5)))[0]).length, 5);
  assert.equal(pagesBoxes(pagesSidebar(pg(1)))[0].children[0].textContent, 'Pages the reviewers looked at (1)');
  assert.equal(pagesBoxes(pagesSidebar([])).length, 0);
  assert.equal(pagesBoxes(pagesSidebar([{ title: 'Bad', url: 'javascript:alert(1)' }])).length, 0, 'N is counted after the filter');
});

test('pages: a title is a text node, never markup', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const box = pagesBoxes(pagesSidebar([{ title: evil, url: 'https://example.org/x' }]))[0];
  const a = pageLinks(box)[0];
  assert.equal(a.textContent, evil);
  assert.equal(a.children.length, 0, 'set with textContent: no child elements');
  assert.ok(!/innerHTML/.test(HTML.slice(HTML.indexOf('function pagesBox'), HTML.indexOf('function pagesBox') + 2500)));
});

test('pages: Show all lists every page and takes the control away', () => {
  const s = pagesSidebar(pg(8));
  const box = pagesBoxes(s)[0];
  showAll(box).click();
  assert.equal(pageLinks(box).length, 8);
  assert.equal(showAll(box), undefined);
});

test('pages: a disclosure the reader opened, and Show all, stay as they were across polls', () => {
  const s = pagesSidebar(pg(8));
  const box = pagesBoxes(s)[0];
  box.open = true;
  showAll(box).click();
  poll(s);
  const after = pagesBoxes(s)[0];
  assert.notEqual(after, box, 'the list was rebuilt');
  assert.equal(after.open, true);
  assert.equal(pageLinks(after).length, 8);
  assert.equal(showAll(after), undefined);
  // Closing it is kept too.
  after.open = false;
  assert.equal(pagesBoxes(s)[0].open, false);
});

test('pages: a closed disclosure stays closed, and the state is per entry', () => {
  const s = pagesSidebar(pg(8));
  poll(s);
  const after = pagesBoxes(s)[0];
  assert.equal(after.open, false);
  assert.equal(pageLinks(after).length, 5);
});

test('pages: a different review starts closed again', () => {
  const s = sidebar({
    lenzOpen: reply('idle'),
    lenzOpenState: reply('running', { model: withPages(POLLS[3], pg(8), 'aaaa0001'), nextPollS: 15 }),
    lenzPoll: reply('done', { model: withPages(POLLS[5], pg(8), 'bbbb0002') }),
    lenzLogOpen: null,
  });
  pagesBoxes(s)[0].open = true;
  poll(s);
  assert.equal(pagesBoxes(s)[0].open, false, 'entry ids repeat across reviews; the state does not');
});

test('pages: focus on the summary comes back to the summary after a poll', () => {
  const s = pagesSidebar(pg(8));
  const summary = pagesBoxes(s)[0].children[0];
  summary.focus();
  poll(s);
  const now = pagesBoxes(s)[0].children[0];
  assert.equal(now.tag, 'summary');
  assert.equal(s.document.activeElement, now);
});

test('pages: focus on a page link comes back to the same link after a poll', () => {
  const s = pagesSidebar(pg(8));
  pagesBoxes(s)[0].open = true;
  pageLinks(pagesBoxes(s)[0])[2].focus();
  poll(s);
  assert.equal(s.document.activeElement, pageLinks(pagesBoxes(s)[0])[2]);
  assert.equal(s.document.activeElement.textContent, 'Page 3');
});

// ── Check again: a quiet link beside "No changes since the last check." ──────────────

const NO_CHANGES = 'No changes since the last check.';
const COMPLETED = require('./fixtures/reviews/draft-a.review.json'); // a completed review (id 4881a880)
const unchanged = (model) => reply('done', { model, notice: NO_CHANGES, checkAgain: true });

test('check again: not shown until an unchanged, completed Doc says so', () => {
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: reply('done', { model: LenzView.build(NO_CLAIM) }), lenzLogOpen: null });
  assert.match(HTML, />Check again<\/button>/);
  assert.equal(s.ids['check-again'].hidden, true);
});

test('check again: shown with the notice, and the link names no cost', () => {
  const s = sidebar({ lenzOpen: reply('idle'), lenzOpenState: unchanged(LenzView.build(COMPLETED)), lenzLogOpen: null });
  assert.equal(s.ids.note.textContent, NO_CHANGES);
  assert.equal(s.ids['check-again'].hidden, false);
  // The link says only what it does: no cost wording (a re-run is mostly answered from what Lenz knows).
  assert.match(HTML, /<button id="check-again"[^>]*>Check again<\/button>/);
});

test('check again: a click runs a new check of the Doc and the link goes away', () => {
  const s = sidebar({
    lenzOpen: reply('idle'), lenzOpenState: unchanged(LenzView.build(COMPLETED)), lenzLogOpen: null,
    lenzCheckAgain: reply('running', { nextPollS: 15 }),
  });
  s.ids['check-again'].click();
  assert.equal(s.names().filter((n) => n === 'lenzCheckAgain').length, 1);
  assert.ok(!s.names().includes('lenzStart'));
  // The click names the check on screen, so a stale panel starts nothing (the server compares it).
  assert.deepEqual(s.calls.find((c) => c.name === 'lenzCheckAgain').args, ['4881a880']);
  assert.equal(s.ids['check-again'].hidden, true);
  assert.equal(s.ids.note.textContent, '');
});

test('check again: not offered while a check runs, whatever the reply carries', () => {
  const s = sidebar({
    lenzOpen: reply('idle'), lenzLogOpen: null,
    lenzOpenState: reply('running', { nextPollS: 15, notice: NO_CHANGES, checkAgain: true, model: LenzView.build(COMPLETED) }),
  });
  assert.equal(s.ids['check-again'].hidden, true);
});

test('check again: an answer that is only a note takes the link away with the notice it belonged to', () => {
  const model = LenzView.build(COMPLETED, { scope: { paragraphs: 1 } });
  const s = sidebar({
    lenzOpen: reply('idle'), lenzOpenState: unchanged(model), lenzLogOpen: null,
    lenzCheckAgainSelection: { ok: false, message: 'Select the text to check first, then choose Check only the selected text.' },
  });
  s.ids['check-again'].click();
  assert.match(s.ids.note.textContent, /^Select the text to check first/);
  assert.equal(s.ids['check-again'].hidden, true);
});

test('check again: after a selection check it runs the selection again', () => {
  const model = LenzView.build(COMPLETED, { scope: { paragraphs: 1 } });
  const s = sidebar({
    lenzOpen: reply('idle'), lenzOpenState: unchanged(model), lenzLogOpen: null,
    lenzCheckAgainSelection: reply('running', { nextPollS: 15 }),
  });
  s.ids['check-again'].click();
  assert.equal(s.names().filter((n) => n === 'lenzCheckAgainSelection').length, 1);
  assert.ok(!s.names().includes('lenzCheckAgain'));
});

test('check again: a Doc that needs the file approval asks for it, then runs again', () => {
  const s = sidebar({
    lenzOpen: reply('idle'), lenzOpenState: unchanged(LenzView.build(COMPLETED)), lenzLogOpen: null,
    lenzCheckAgain: reply('needs_file_access', { ok: false, message: null }),
  });
  s.ids['check-again'].click();
  assert.equal(s.ids.access.hidden, false);
  // The grant: the picker opens, the file becomes readable, and the same Check again runs once more.
  s.ids['access-go'].click();
  assert.ok(s.names().includes('lenzShowPicker'));
});

test('check again: after the file approval it runs again, with the same check named', () => {
  let ready = false;
  const s = sidebar({
    lenzOpen: reply('idle'), lenzOpenState: unchanged(LenzView.build(COMPLETED)), lenzLogOpen: null,
    lenzCheckAgain: () => (ready ? reply('running', { nextPollS: 15 }) : reply('needs_file_access', { ok: false, message: null })),
    lenzShowPicker: { openedAt: 1 },
    lenzFileAccessReady: () => ({ ready: true }),
  });
  s.ids['check-again'].click();
  s.ids['access-go'].click();
  ready = true;
  s.timeouts[s.timeouts.length - 1].fn(); // the sidebar's wait for the grant looks again
  const again = s.calls.filter((c) => c.name === 'lenzCheckAgain');
  assert.equal(again.length, 2);
  assert.deepEqual(again[1].args, ['4881a880']);
  assert.equal(s.ids.access.hidden, true);
});

test('check again: gone when the panel moves on (a plain Check this Doc)', () => {
  const s = sidebar({
    lenzOpen: reply('idle'), lenzOpenState: unchanged(LenzView.build(COMPLETED)), lenzLogOpen: null,
    lenzStart: reply('running', { nextPollS: 15 }),
  });
  s.ids.check.click();
  assert.equal(s.ids['check-again'].hidden, true);
});
