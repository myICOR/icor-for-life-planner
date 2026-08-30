/* Two copy defects surfaced by the 2026-08-30 live pass in a real Obsidian.
 * Both are claims a surface makes that the state does not back:
 *   - "1 OPEN ITEMS" is a grammar error the first time anyone has one task,
 *     which is the first session, which is the worst possible session for it.
 *   - MANUAL's "NOTHING ADDED YET." after the only manual task is dragged
 *     onto the board denies a task that exists. The list under a source head
 *     is the UNSCHEDULED list; its empty copy must say that state, not claim
 *     nothing was ever added.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

test('one open item is an ITEM, not an ITEMS', () => {
  assert.equal(typeof T.fmtOpenItems, 'function', 'the count must go through one pure helper');
  assert.equal(T.fmtOpenItems(1), '1 OPEN ITEM');
  assert.equal(T.fmtOpenItems(0), '0 OPEN ITEMS');
  assert.equal(T.fmtOpenItems(2), '2 OPEN ITEMS');
  assert.equal(T.fmtOpenItems(41), '41 OPEN ITEMS');
});

test('the footer renders through the helper, not a second hand-built string', () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  // If 'OPEN ITEM' is ever assembled outside fmtOpenItems, the plural fix
  // silently stops covering that call site. Count CODE only: the helper's own
  // comment quotes the bug it fixes, and a gate that counts its explanation is
  // not counting the code (same defect this suite already hit twice today).
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  const hits = code.match(/OPEN ITEM/g) || [];
  const inHelper = /function fmtOpenItems\([^)]*\)[^}]*OPEN ITEM/.test(code);
  assert.ok(inHelper, 'fmtOpenItems must own the string');
  assert.equal(hits.length, 2, `the two literals inside the helper and nowhere else (found ${hits.length})`);
});

test('MANUAL with every task scheduled says "nothing unscheduled", never "nothing added"', () => {
  // total = manual items that exist at all; count = unscheduled ones.
  const st = T.trayEmptyState(T.MANUAL_SOURCE, true, undefined, 0, 3);
  assert.equal(st.kind, 'empty');
  assert.notEqual(st.text, T.TRAY_COPY.manualEmpty,
    'a task was added; the empty list must not deny it exists');
  assert.equal(st.text, T.TRAY_COPY.empty,
    'the truthful state is "nothing unscheduled", same vocabulary as the synced sections');
});

test('MANUAL with no items ever still reads "nothing added yet"', () => {
  // The renderer drops the whole section in this state (a zero-count
  // fact says nothing), but the resolver stays honest for whoever calls it next.
  const st = T.trayEmptyState(T.MANUAL_SOURCE, true, undefined, 0, 0);
  assert.equal(st.text, T.TRAY_COPY.manualEmpty);
  // and an omitted total behaves as zero, so old call sites cannot lie
  assert.equal(T.trayEmptyState(T.MANUAL_SOURCE, true, undefined, 0).text, T.TRAY_COPY.manualEmpty);
});

test('"everything is on the board" would be a lie in two reachable states', () => {
  // Documented as an assertion because it was the suggested copy: a manual
  // item can be done-but-unscheduled, or pinned as a weekly goal. In both the
  // unscheduled list is empty and the board does NOT hold the item. The copy
  // must be true in every state that renders it, so it says what the LIST is,
  // not where the items went.
  const st = T.trayEmptyState(T.MANUAL_SOURCE, true, undefined, 0, 2);
  assert.ok(!/board/i.test(st.text), 'the empty copy must not claim a location it cannot know');
});
