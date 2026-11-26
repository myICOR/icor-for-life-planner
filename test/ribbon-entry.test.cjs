/* The board's entry point is Obsidian's own ribbon (0.18.1), and the planner
 * folder opens like any folder.
 *
 * Tom, 2026-11-23: the row of icons under the sidebar logo goes, and every
 * plugin's launcher moves to the ribbon on the left, so a member can reorder
 * or hide it in Settings, Appearance, Ribbon menu like any other plugin's
 * icon. From 0.9.2 to 0.18.0 the planner also put a button into the file
 * explorer's own toolbar (`.nav-buttons-container`); that button is gone.
 *
 * A source scan, because the plugin is one hand-written main.js and the
 * thing to prove is an absence: no code path names the explorer's toolbar,
 * the ribbon icon is registered once with its tooltip and opens the board
 * through the same function as the Open weekly planner command, and the
 * member-facing words send nobody to a button under the logo.
 *
 * PLANNER_ROOT / PLANNER_MAIN point every check at another copy of the
 * plugin, which is how this file was run red against the 0.18.0 bytes.
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
/* Code only: a comment may tell the history of the toolbar button. */
const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('nothing is written into the file explorer\'s toolbar: no code names it', () => {
  assert.doesNotMatch(code, /nav-buttons-container/, 'main.js still reaches into .nav-buttons-container');
  assert.doesNotMatch(code, /nav-action-button/, 'main.js still builds a toolbar-shaped button');
  assert.doesNotMatch(code, /iplan-toolbar-open/, 'the toolbar button class is still created');
});

test('the ribbon icon is registered exactly once, with its tooltip, opening the board', () => {
  const calls = main.match(/this\.addRibbonIcon\(/g) || [];
  assert.equal(calls.length, 1, `addRibbonIcon is called ${calls.length} times`);
  assert.match(code, /this\.addRibbonIcon\(PLANNER_RIBBON_ICON, PLANNER_RIBBON_LABEL, \(\) => this\.openBoard\(\)\)/);
  assert.equal(T.PLANNER_RIBBON_LABEL, 'Open the Planner');
  assert.equal(T.PLANNER_RIBBON_ICON, 'calendar-days');
});

test('the command that is the ribbon icon\'s other route opens the same board', () => {
  assert.match(code, /this\.addCommand\(\{ id: 'open-board', name: 'Open weekly planner', callback: \(\) => this\.openBoard\(\) \}\)/);
});

test('no click hook on a folder row remains: the planner folder opens like any folder', () => {
  assert.doesNotMatch(code, /nav-folder-title\[data-path/, 'a folder-row click hook is still in main.js');
  assert.doesNotMatch(code, /registerDomEvent\(document, 'click'/, 'a document-wide click listener is still registered');
  assert.doesNotMatch(code, /\{ capture: true \}/, 'a capture-phase listener is still registered');
});

test('the README sends the member to the ribbon, never to a button under the logo or a file-tree entry', () => {
  assert.doesNotMatch(readme, /under\s+the\s+sidebar\s+logo/i, 'there is no button under the logo any more');
  assert.doesNotMatch(readme, /entry in the file tree/i, 'there is no file-tree entry to send anyone to');
  assert.doesNotMatch(readme, /"Planner" entry/);
  assert.match(readme, /ribbon on the left/, 'the README names the ribbon');
});
