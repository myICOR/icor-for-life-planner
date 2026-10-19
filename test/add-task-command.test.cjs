/* "ADD A TASK" WORKS FROM ANY PAGE, NOT ONLY FROM THE BOARD.
 *
 * The command (add-manual-task) is registered unconditionally, so it is in
 * the palette on every page. It revealed the tray and asked for the
 * composer, but the composer lives on TASKS, and TASKS exists only while
 * the board is the active main-area page (trayVisibleTabs). From a note,
 * render() collapsed the tab to AGENDA and the field was never drawn: the
 * command did nothing, silently. Two more ways to the same silence: beside
 * the board after a manual pick of AGENDA or PINNED (openComposer never
 * asked for TASKS), and a tray leaf still deferred in the background
 * (1.7.2+), whose view is not a PlannerTrayView until it is loaded.
 *
 * The fix keeps Tom's rule (TASKS only beside the board) and satisfies it:
 * the command brings the board forward first and says so, and the composer
 * asks for TASKS. The guard in render() is untouched.
 *
 * Watched red against the 0.16.2 bytes.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

const PluginClass = require(T.__mainPath);

// A tray view without the DOM: render() is the one method that needs a
// document, so it records what it would have drawn, after the same guard
// the real render() applies first.
function tray({ contextIsBoard, activeTab }) {
  const v = Object.create(T.PlannerTrayView.prototype);
  v.contextIsBoard = contextIsBoard;
  v.activeTab = activeTab;
  v.rendered = [];
  v.render = function () {
    this.activeTab = T.trayEffectiveTab(this.contextIsBoard, this.activeTab);
    this.rendered.push({ tab: this.activeTab, composerOpen: !!this.composerOpen });
  };
  return v;
}

// A plugin whose openBoard / openTray record the order they ran in.
function plugin(leaf, calls) {
  const p = Object.create(PluginClass.prototype);
  p.openBoard = async () => { calls.push('board'); };
  p.openTray = async (reveal) => { calls.push(`tray:${reveal}`); return leaf; };
  return p;
}

test('THE DEFECT: from a note, the command brings the board forward and the field draws', async () => {
  const calls = [];
  const v = tray({ contextIsBoard: false, activeTab: 'agenda' });   // the tray as a note leaves it
  await plugin({ view: v }, calls).focusAddTask();
  assert.deepEqual(calls, ['board', 'tray:true'],
    'TASKS exists only beside the board, so the board has to come first');
  assert.equal(v.contextIsBoard, true, 'told outright, not left waiting on active-leaf-change');
  assert.deepEqual(v.rendered.at(-1), { tab: 'sync', composerOpen: true });
  assert.equal(v._composerWantsFocus, true, 'and the caret is asked for');
});

test('THE DEFECT: beside the board, a manual pick of AGENDA, PINNED or HABITS gives way to TASKS', async () => {
  for (const tab of ['agenda', 'goals', 'habits']) {
    const v = tray({ contextIsBoard: true, activeTab: tab });
    await plugin({ view: v }, []).focusAddTask();
    assert.deepEqual(v.rendered.at(-1), { tab: 'sync', composerOpen: true }, tab);
  }
});

test('THE DEFECT: a tray leaf deferred in the background is loaded before its view is checked', async () => {
  const v = tray({ contextIsBoard: false, activeTab: 'agenda' });
  const leaf = { view: { deferred: true } };
  leaf.loadIfDeferred = async () => { leaf.view = v; };
  await plugin(leaf, []).focusAddTask();
  assert.deepEqual(v.rendered.at(-1), { tab: 'sync', composerOpen: true });
});

test('an Obsidian before 1.7.2 (no loadIfDeferred) still works', async () => {
  const v = tray({ contextIsBoard: false, activeTab: 'agenda' });
  await plugin({ view: v }, []).focusAddTask();
  assert.equal(v.rendered.at(-1).tab, 'sync');
});

test('no tray leaf (no right sidebar to put it in): quiet, nothing thrown', async () => {
  await assert.doesNotReject(plugin(null, []).focusAddTask());
});

test('the ADD TASK button on TASKS behaves exactly as before', () => {
  const v = tray({ contextIsBoard: true, activeTab: 'sync' });
  v.openComposer();
  assert.deepEqual(v.rendered, [{ tab: 'sync', composerOpen: true }]);
  assert.equal(v._composerWantsFocus, true);
});

test('THE RULE still holds: without the board in front, TASKS is never drawn', () => {
  // Only the command, which has just brought the board forward, claims the
  // board. Any other call keeps the tray's own reading, and render()'s guard
  // keeps TASKS off every other page.
  const v = tray({ contextIsBoard: false, activeTab: 'agenda' });
  v.openComposer();
  assert.equal(v.contextIsBoard, false);
  assert.equal(v.rendered.at(-1).tab, 'agenda');
});

/* ---------------------------------------------- on a phone, the drawer */

/* On a phone the right sidebar is a drawer, and three things Obsidian does
 * there meet inside one call of the command:
 *  - revealLeaf on a leaf in the drawer expands it;
 *  - setActiveLeaf(leaf, { focus: true }) on a main-area leaf goes through
 *    focusLeaf, which on mobile collapses both drawers;
 *  - the drawer animates expand and collapse through one helper that, before
 *    it starts an animation, finishes the pending one and runs its
 *    completion. Collapse's completion hides the drawer.
 * The first call of a session reveals the tray from openBoard (the one auto
 * reveal), then focused the board, then revealed the tray again: expand,
 * collapse, expand. The pending collapse finished inside the second expand
 * and hid the drawer, so the tray rendered with its field in a drawer the
 * member could not see. A desktop sidebar is not a drawer and never showed
 * it. The model below is that behaviour, with the animation settled by hand
 * instead of by a clock. */

const BOARD = 'icor-for-life-planner-board';
const TRAY = 'icor-for-life-planner-tray';

function drawer(phone) {
  const d = { collapsed: true, shown: false, pending: null };
  const animate = (complete) => {
    if (d.pending) { const p = d.pending; d.pending = null; p(); }   // finish the one in flight first
    d.pending = complete || (() => { });
  };
  d.settle = () => { const p = d.pending; d.pending = null; if (p) p(); };
  d.expand = () => {
    if (!d.collapsed) return;
    d.collapsed = false; d.shown = true;
    if (phone) animate(null);
  };
  d.collapse = () => {
    if (d.collapsed) return;
    d.collapsed = true;
    if (phone) animate(() => { d.shown = false; }); else d.shown = false;
  };
  return d;
}

function workspace({ phone, trayExists = true, deferred = false, boardExists = false }) {
  const rootSplit = { name: 'root' };
  const rightSplit = drawer(phone);
  const leaves = [];
  const trays = [];
  let active = null;
  let plugin = null;
  const mountTray = (leaf) => {
    const v = tray({ contextIsBoard: false, activeTab: 'agenda' });
    v.app = app; leaf.view = v; trays.push(v);
  };
  const leaf = (root) => {
    const l = {
      root, view: null, getRoot: () => root,
      async setViewState(s) {
        await null;
        if (s.type === TRAY) mountTray(l); else l.view = { getViewType: () => s.type };
        if (s.active) app.workspace.setActiveLeaf(l, { focus: true });
      },
      async loadIfDeferred() { if (l.deferred) { l.deferred = false; mountTray(l); } },
    };
    leaves.push(l);
    return l;
  };
  const viewType = (l) => (l.view && l.view.getViewType ? l.view.getViewType() : null);
  const app = {
    workspace: {
      rootSplit, rightSplit,
      getLeavesOfType: (t) => leaves.filter((l) => (l.deferred ? t === TRAY : viewType(l) === t)),
      getLeaf: () => leaf(rootSplit),
      getRightLeaf: () => leaf(rightSplit),
      revealLeaf: (l) => { if (l.root === rightSplit) rightSplit.expand(); },
      setActiveLeaf: (l, opts) => {
        active = l;
        trays.forEach((v) => v.onActiveLeafChange(l));
        if (phone && opts && opts.focus && l.root === rootSplit) rightSplit.collapse();
      },
    },
  };
  const note = leaf(rootSplit);
  note.view = { getViewType: () => 'markdown' };
  active = note;
  if (trayExists) {
    const t = leaf(rightSplit);
    if (deferred) t.deferred = true; else mountTray(t);
  }
  if (boardExists) leaf(rootSplit).view = { getViewType: () => BOARD };
  plugin = Object.create(PluginClass.prototype);
  plugin.app = app;
  plugin._trayAutoRevealed = false;
  return {
    plugin, rightSplit, trays,
    boards: () => leaves.filter((l) => viewType(l) === BOARD).length,
    backToNote: () => app.workspace.setActiveLeaf(note),
  };
}

async function tap(w) {
  await w.plugin.focusAddTask();
  w.rightSplit.settle();
}

function assertFieldOnScreen(w, label) {
  assert.equal(w.rightSplit.collapsed, false, `${label}: the drawer is open`);
  assert.equal(w.rightSplit.shown, true, `${label}: and shown, not hidden behind the slid-aside page`);
  const v = w.trays.at(-1);
  assert.ok(v, `${label}: a tray view exists`);
  assert.deepEqual(v.rendered.at(-1), { tab: 'sync', composerOpen: true }, `${label}: TASKS with the field`);
  assert.equal(v._composerWantsFocus, true, `${label}: and the caret is asked for`);
  assert.equal(w.boards(), 1, `${label}: one board, never two`);
}

for (const phone of [true, false]) {
  const where = phone ? 'phone' : 'desktop';

  test(`${phone ? 'THE DEFECT, ' : ''}${where}: the first tap of a session shows the field, tray already in the sidebar`, async () => {
    const w = workspace({ phone });
    await tap(w);
    assertFieldOnScreen(w, where);
  });

  test(`${where}: the first tap of a session with no tray yet`, async () => {
    const w = workspace({ phone, trayExists: false });
    await tap(w);
    assertFieldOnScreen(w, where);
  });

  test(`${where}: the first tap of a session with the tray leaf deferred`, async () => {
    const w = workspace({ phone, deferred: true });
    await tap(w);
    assertFieldOnScreen(w, where);
  });

  test(`${where}: the first tap with the board already open in a tab`, async () => {
    const w = workspace({ phone, boardExists: true });
    await tap(w);
    assertFieldOnScreen(w, where);
  });

  test(`${where}: a second tap after the member closed the sidebar and went back to a note`, async () => {
    const w = workspace({ phone });
    await tap(w);
    w.rightSplit.collapse(); w.rightSplit.settle(); w.backToNote();
    await tap(w);
    assertFieldOnScreen(w, where);
  });

  test(`${where}: a second tap with the sidebar still open`, async () => {
    const w = workspace({ phone });
    await tap(w);
    await tap(w);
    assertFieldOnScreen(w, where);
  });
}

test('every other way to the board still focuses it: only the command opts out', async () => {
  const seen = [];
  const p = Object.create(PluginClass.prototype);
  const board = { view: { getViewType: () => BOARD } };
  p.autoRevealTray = async () => { };
  p.app = { workspace: {
    getLeavesOfType: (t) => (t === BOARD ? [board] : []),
    revealLeaf: () => { },
    setActiveLeaf: (l, opts) => seen.push(opts),
  } };
  await p.openBoard();
  await p.openBoard({ focus: false });
  assert.deepEqual(seen, [{ focus: true }, { focus: false }]);
});
