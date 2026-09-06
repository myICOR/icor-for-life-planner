/* The board's entry points (0.9.2): a toolbar button and a ribbon icon,
 * and the planner folder opens like any folder.
 *
 * Up to 0.9.1 a capture-phase click listener on the planner folder's row
 * opened the board instead of unfolding the folder. Three things are gated
 * here. The mount rule for the toolbar button is pure over a querySelector
 * root and is tested with a fake tree, including the idempotence it has to
 * offer the observer that re-runs it. The rest is a source scan: no click
 * hook on a folder row remains, the ribbon icon is registered once with
 * its label, the runtime mounts through the rule, re-mounts on layout
 * change and removes on unload, and the member-facing words match. What a
 * scan cannot prove is the paint; that still needs an Obsidian and an eye.
 *
 * PLANNER_ROOT / PLANNER_MAIN point every check at another copy of the
 * plugin, which is how this file was run red against the 0.9.1 bytes.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./harness.cjs');

const root = process.env.PLANNER_ROOT
  ? path.resolve(process.env.PLANNER_ROOT)
  : path.join(__dirname, '..');
const main = fs.readFileSync(T.__mainPath, 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

/* A fake tree: querySelector over a map of selector -> node. */
const node = (map, extra) => Object.assign({ querySelector: (sel) => map[sel] || null }, extra || {});

/* ---------------------------------------------------------- the mount rule */

test('the rule names the file explorer\'s own toolbar, the container the Connect plugin also fills', () => {
  assert.equal(T.PLANNER_TOOLBAR_HOST, '.workspace-leaf-content[data-type="file-explorer"] .nav-buttons-container');
});

test('with a toolbar and no button yet: mount into the toolbar, nothing to replace', () => {
  const bar = node({});
  const at = T.plannerToolbarMountPoint(node({ [T.PLANNER_TOOLBAR_HOST]: bar }));
  assert.equal(at.parent, bar);
  assert.equal(at.existing, null);
});

test('idempotent: with the button already there the rule hands it back rather than asking for a second one', () => {
  const mine = { id: 'the button' };
  const bar = node({ ['.' + T.PLANNER_TOOLBAR_CLASS]: mine });
  const at = T.plannerToolbarMountPoint(node({ [T.PLANNER_TOOLBAR_HOST]: bar }));
  assert.equal(at.parent, bar);
  assert.equal(at.existing, mine, 'the runtime must see its own button and return without touching the DOM');
});

test('without a file explorer there is nowhere to mount, and that is a null, not a throw', () => {
  assert.equal(T.plannerToolbarMountPoint(node({})), null);
  assert.equal(T.plannerToolbarMountPoint(null), null);
  assert.equal(T.plannerToolbarMountPoint(undefined), null);
});

test('the button carries the label Tom asked for and the days glyph', () => {
  assert.equal(T.PLANNER_TOOLBAR_LABEL, 'Open the Planner');
  assert.equal(T.PLANNER_TOOLBAR_ICON, 'calendar-days');
  assert.equal(T.PLANNER_TOOLBAR_CLASS, 'iplan-toolbar-open');
});

/* ------------------------------------------------------ the source scan */

test('no click hook on a folder row remains: the planner folder opens like any folder', () => {
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /nav-folder-title\[data-path/, 'a folder-row click hook is still in main.js');
  assert.doesNotMatch(code, /registerDomEvent\(document, 'click'/, 'a document-wide click listener is still registered');
  assert.doesNotMatch(code, /\{ capture: true \}/, 'a capture-phase listener is still registered');
});

test('the ribbon icon is registered exactly once, with the label, opening the board', () => {
  const calls = main.match(/this\.addRibbonIcon\(/g) || [];
  assert.equal(calls.length, 1, `addRibbonIcon is called ${calls.length} times`);
  assert.match(main, /this\.addRibbonIcon\(PLANNER_TOOLBAR_ICON, PLANNER_TOOLBAR_LABEL, \(\) => this\.openBoard\(\)\)/);
});

test('the toolbar button is mounted through the rule, re-mounted on layout change and removed on unload', () => {
  assert.match(main, /plannerToolbarMountPoint\(document\)/, 'the runtime must use the same rule the test checked');
  assert.match(main, /workspace\.on\('layout-change', \(\) => this\.mountPlannerToolbarButton\(\)\)/);
  assert.match(main, /this\.mountPlannerToolbarButton\(\);\n\s+\}\);/, 'the strip observer must also re-mount the button');
  const unload = main.slice(main.indexOf('  onunload() {'), main.indexOf('  // Any source with a connector'));
  assert.match(unload, /this\.removePlannerToolbarButton\(\)/);
});

test('the runtime is idempotent under its own button and replaces a stale one', () => {
  const s = main.indexOf('  mountPlannerToolbarButton() {');
  const e = main.indexOf('  removePlannerToolbarButton() {', s);
  assert.ok(s > 0 && e > s, 'the mount method must be findable');
  const block = main.slice(s, e);
  assert.match(block, /if \(at\.existing === this\._toolbarEl\) return;/, 'its own button must be left alone');
  assert.match(block, /at\.existing\.remove\(\);/, 'a button from an earlier instance keeps its old handler and must go');
  assert.match(block, /at\.parent\.appendChild\(btn\)/, 'appended, never inserted at the front of the row');
});

test('the button has the same class shape as its siblings, so the theme styles it, and a reading contract', () => {
  assert.match(main, /btn\.className = `clickable-icon nav-action-button \$\{PLANNER_TOOLBAR_CLASS\}`/);
  assert.match(main, /btn\.setAttribute\('aria-label', PLANNER_TOOLBAR_LABEL\)/);
  assert.match(main, /btn\.setAttribute\('role', 'button'\)/);
  assert.match(main, /btn\.tabIndex = 0/);
  assert.match(main, /e\.key !== 'Enter' && e\.key !== ' '/, 'a div that acts as a button must take Enter and Space');
});

test('the member-facing words match: the README names the toolbar button and the ribbon, not a file-tree entry', () => {
  assert.doesNotMatch(readme, /"Planner" entry in the file tree/);
  assert.match(readme, /A Planner button on the file-tree toolbar under the sidebar logo, and\n\s+one in the left ribbon, open the weekly board/);
  assert.match(readme, /The planner folder itself opens like any folder\./);
  assert.match(readme, /Click the Planner button on the file-tree toolbar or in the left\n\s+ribbon/);
});
