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
