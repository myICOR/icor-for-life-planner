/* `linked_note` on a planner item: the note a task is FOR.
 *
 * Plan-owned, the same field name and the same meaning `planner-habit`
 * already carries. The one property that matters is negative: no sync run
 * writes it, clears it or reads it. That is a property of updateItemFile
 * naming its fields, so it is gated by reading the source rather than by
 * running a sync, which is what every other plan-owned field is gated by too.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const main = fs.readFileSync(T.__mainPath, 'utf8');

function item(fm) {
  return T.itemFromFrontmatter(
    { type: 'planner-item', source: 'todoist', external_id: '1', title: 'x', ...fm },
    '06 Planner/Todoist/x.md', 'x',
  );
}

test('the field reads back as the note it names, whatever shape it was written in', () => {
  assert.equal(item({ linked_note: '[[myicor-product]]' }).linkedNote, 'myicor-product');
  assert.equal(item({ linked_note: 'myicor-product' }).linkedNote, 'myicor-product');
  assert.equal(item({ linked_note: '[[My Life/Projects/chaser|Chaser]]' }).linkedNote, 'chaser');
  assert.equal(item({ linked_note: '[[My Life/Projects/chaser|Chaser]]' }).linkedNoteTarget, 'My Life/Projects/chaser', 'the name is for the menu, the target for the resolver');
  assert.equal(item({ linked_note: '[[chaser#Scope]]' }).linkedNote, 'chaser');
  assert.equal(item({ linked_note: null }).linkedNote, null);
  assert.equal(item({}).linkedNote, null, 'an absent field is no link, not an empty string');
});

test('the stored shape is always a wikilink, or nothing at all', () => {
  assert.equal(T.normalizeLinkedNote('myicor-product'), '[[myicor-product]]');
  assert.equal(T.normalizeLinkedNote('[[myicor-product]]'), '[[myicor-product]]');
  // a folder the person typed is kept: it is how they say WHICH note, when
  // two of them share a name (0.14.1). The alias and the heading still go.
  assert.equal(T.normalizeLinkedNote('[[a/b|c]]'), '[[a/b]]');
  assert.equal(T.normalizeLinkedNote('[[a/b#Log]]'), '[[a/b]]');
  assert.equal(T.normalizeLinkedNote(''), null);
  assert.equal(T.normalizeLinkedNote('   '), null);
  assert.equal(T.normalizeLinkedNote(null), null);
});

test('it is the same field name planner-habit already uses', () => {
  const habit = T.habitFromFrontmatter(
    { type: 'planner-habit', name: 'Morning pages', linked_note: '[[morning-pages]]' },
    '06 Planner/Habits/morning-pages.md', '',
  );
  assert.equal(habit.linkedNote, '[[morning-pages]]');
  assert.ok(T.PLAN_OWNED_ITEM_FIELDS.includes('linked_note'));
});

test('THE PROPERTY: a sync run never writes, clears or reads a plan-owned field', () => {
  const update = main.slice(main.indexOf('  async updateItemFile('), main.indexOf('  /* ---- plan writes'));
  for (const field of T.PLAN_OWNED_ITEM_FIELDS) {
    // The ops block is the plan acting on itself (a finished occurrence
    // clearing its own placement), never the source reaching in, so the
    // placement fields are read inside `if (ops...)` branches only.
    const assignments = update.match(new RegExp(`fm\\.${field}\\s*=`, 'g')) || [];
    const inOps = (update.match(new RegExp(`ops\\.[A-Za-z]+\\)[^;]*fm\\.${field}\\s*=`, 'g')) || []).length;
    if (field === 'linked_note' || field === 'weekly_goal') {
      assert.equal(assignments.length, 0, `updateItemFile must never assign ${field}`);
    } else {
      assert.ok(assignments.length === 0 || inOps >= 0, `${field} is only touched by the plan's own ops`);
    }
  }
  // And the merge never sends it anywhere: the two-way fields are a closed set.
  assert.ok(!T.TWO_WAY_FIELDS.includes('linked_note'));
});

test('a new note carries the field explicitly, synced and manual alike', () => {
  const manual = T.manualItemFrontmatter('Write the brief', 'manual-1', '2026-09-15T10:00:00Z');
  assert.ok('linked_note' in manual, 'an absent field is a different thing from a null one');
  assert.equal(manual.linked_note, null);
  const create = main.slice(main.indexOf('  async createItemFile('), main.indexOf('  // Applies the merge result'));
  assert.match(create, /'linked_note: null',/, 'a synced note is created with the field too');
});

test('the card is where it is edited, and the only place', () => {
  const menu = main.slice(main.indexOf('function showCardMenu('), main.indexOf('// Tap-to-plan'));
  assert.match(menu, /'Change the linked note' : 'Link a note'/);
  assert.match(menu, /new LinkNoteModal\(plugin\.app, plugin, item\)/);
  assert.match(menu, /Open \$\{item\.linkedNote\}/, 'and opened from the same menu when it is set');
  const setter = main.slice(main.indexOf('  async setItemLinkedNote('), main.indexOf('  /* ---- weeks'));
  assert.match(setter, /const value = normalizeLinkedNote\(raw\);/);
  assert.match(setter, /else delete fm\.linked_note;/, 'clearing removes the field rather than writing an empty one');
  assert.match(setter, /processFrontMatter/, 'and it touches that one field only');
});
