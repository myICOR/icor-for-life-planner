/* Add a task: Enter creates the task and opens it, Shift+Enter keeps the field.
 *
 * Enter opens the new task's note the way a click on its card does (a tab, via
 * getLeaf('tab').openFile). Shift+Enter is the burst entry that was always
 * there: create, keep the field open and focused for the next one.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

function fakeView(path, file) {
  const opened = [];
  const plugin = {
    addManualItem: async () => path,
    app: {
      vault: { getAbstractFileByPath: (p) => (p === path ? file : null) },
      workspace: { getLeaf: (kind) => ({ openFile: (f) => opened.push([kind, f]) }) },
    },
  };
  const view = {
    plugin, composerOpen: true, composerDraft: 'x', _composerWantsFocus: false,
    closed: 0, closeComposer() { this.closed++; this.composerOpen = false; this._composerWantsFocus = false; this.render(); },
    // like the real render: an input that still holds the caret re-arms the flag
    render() { this._composerWantsFocus = true; },
  };
  return { view, opened };
}

test('Enter: the new task opens in a tab, the same route as its card', async () => {
  const file = new T.__obsidian.TFile();
  const { view, opened } = fakeView('02 Planner/Manual/a.md', file);
  const ok = await T.PlannerTrayView.prototype.commitComposer.call(view, 'a', { open: true });
  assert.equal(ok, true);
  assert.deepEqual(opened, [['tab', file]]);
  assert.equal(view._composerWantsFocus, false, 'focus must not be pulled back from the opened note');
  assert.equal(view.composerOpen, false, 'the field closes once the task is open');
});

test('Shift+Enter: today\'s behaviour, nothing opens and the field stays focused', async () => {
  const file = new T.__obsidian.TFile();
  const { view, opened } = fakeView('02 Planner/Manual/a.md', file);
  const ok = await T.PlannerTrayView.prototype.commitComposer.call(view, 'a');
  assert.equal(ok, true);
  assert.equal(opened.length, 0);
  assert.equal(view._composerWantsFocus, true);
  assert.equal(view.composerOpen, true);
});

test('an empty title creates and opens nothing', async () => {
  const { view, opened } = fakeView(null, null);
  const ok = await T.PlannerTrayView.prototype.commitComposer.call(view, '', { open: true });
  assert.equal(ok, false);
  assert.equal(opened.length, 0);
});

test('SOURCE: the field sends Enter to open and Shift+Enter to stay, and says so', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const i = main.indexOf('renderComposer(el) {');
  const comp = main.slice(i, main.indexOf('/* ---- SYNC: the classic tray', i));
  assert.ok(/this\.commitComposer\(value, \{ open: !e\.shiftKey && !Platform\.isMobile \}\);/.test(comp));
  assert.ok(/Shift\+Enter/.test(comp), 'a short hint about Shift+Enter');
});

// Drive the real keydown handler through a fake field.
function typeInto(mobile, ev) {
  const P = T.__obsidian.Platform;
  const was = P.isMobile;
  P.isMobile = mobile;
  try {
    const calls = [];
    let handler; let attr;
    const input = { value: 'buy oil', addEventListener: (n, f) => { if (n === 'keydown') handler = f; }, focus() {}, setSelectionRange() {} };
    const wrap = { createEl: (_t, o) => { attr = o.attr; return input; } };
    const el = { createDiv: () => wrap };
    const view = {
      composerOpen: true, composerDraft: 'buy oil', _composerWantsFocus: false,
      commitComposer: (v, o) => calls.push([v, o]), closeComposer: () => calls.push('close'),
    };
    T.PlannerTrayView.prototype.renderComposer.call(view, el);
    handler(Object.assign({ preventDefault() {}, key: 'Enter', shiftKey: false }, ev));
    return { calls, attr };
  } finally { P.isMobile = was; }
}

test('desktop: Enter opens, Shift+Enter keeps adding, with the hint', () => {
  assert.deepEqual(typeInto(false, {}).calls, [['buy oil', { open: true }]]);
  assert.deepEqual(typeInto(false, { shiftKey: true }).calls, [['buy oil', { open: false }]]);
  assert.match(typeInto(false, {}).attr.placeholder, /Shift\+Enter/);
});

test('phone: Enter keeps the field open and opens nothing, plain placeholder', () => {
  const r = typeInto(true, {});
  assert.deepEqual(r.calls, [['buy oil', { open: false }]]);
  assert.equal(r.attr.placeholder, 'What needs doing?');
  assert.ok(!/Shift/.test(r.attr['aria-label']));
});

test('Enter while an IME is composing commits nothing', () => {
  assert.deepEqual(typeInto(false, { isComposing: true }).calls, []);
  assert.deepEqual(typeInto(false, { keyCode: 229 }).calls, []);
  assert.deepEqual(typeInto(false, { isComposing: true, key: 'Escape' }).calls, []);
});
