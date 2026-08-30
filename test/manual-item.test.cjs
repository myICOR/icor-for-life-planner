/* Manual items: a task typed into the tray, with no API key in front of it.
 *
 * The two rules that keep this from making a mess:
 *   a sync run must never delete, close or overwrite a manual item
 *   two-way sync must never try to push one anywhere
 * plus the rule that makes it worth having: a manual item must be
 * indistinguishable from a synced one to the board, the tray and the drag
 * logic.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

test('manual is a source, and it is not a synced source', () => {
  assert.equal(T.MANUAL_SOURCE, 'manual');
  assert.ok(T.SOURCES.manual, 'manual must be a first-class entry in SOURCES');
  assert.ok(T.SOURCES.manual.svg, 'manual needs its own mark, or cards borrow Todoist\'s');
  assert.equal(T.SOURCES.manual.folder, 'Manual');
  assert.equal(T.isSyncedSource('manual'), false);
  assert.deepEqual(T.SYNCED_SOURCES, ['todoist', 'clickup', 'email']);
  assert.ok(T.TASK_SOURCES.includes('manual'));
});

test('a manual id can never collide with a synced id', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const id = T.manualExternalId();
    assert.match(id, /^manual-[0-9a-z]+-[0-9a-z]{6}$/);
    seen.add(id);
  }
  assert.equal(seen.size, 5000, 'ids must be unique across a burst');

  // Real id shapes from the three connectors. None can start with 'manual-'.
  const synced = ['6X4Vw2Hfmg73Q2XR', '2995104339', '86b1k2xyz', '9012', '12345678'];
  for (const s of synced) assert.ok(!s.startsWith('manual-'), s);
  assert.ok(T.manualExternalId().startsWith('manual-'));

  // deterministic when the clock and rng are injected
  assert.equal(T.manualExternalId(0, () => 0), 'manual-0-000000');
});

test('a sync run cannot touch a manual item, even on an id collision', () => {
  // The nastiest shape: a manual item whose external_id is byte-identical to a
  // Todoist task that just vanished from the open set.
  const shared = '2995104339';
  const items = [
    { source: 'todoist', id: shared, status: 'open' },
    { source: 'manual', id: shared, status: 'open' },
    { source: 'manual', id: T.manualExternalId(), status: 'open' },
    { source: 'todoist', id: 'still-open', status: 'open' },
    { source: 'clickup', id: 'other-source', status: 'open' },
  ];
  const stale = T.reconcileStaleIds('todoist', items, new Set(['still-open']));
  assert.equal(stale.length, 1, 'exactly one item is genuinely done');
  assert.equal(stale[0].source, 'todoist');
  assert.ok(!stale.some((i) => i.source === 'manual'), 'a manual item must never be reconciled');
  assert.ok(!stale.some((i) => i.source === 'clickup'), 'a source only reconciles its own items');
});

test('manual is never itself a reconcile target', () => {
  const items = [{ source: 'manual', id: 'manual-x-aaaaaa', status: 'open' }];
  assert.deepEqual(T.reconcileStaleIds('manual', items, new Set()), []);
  assert.deepEqual(T.reconcileStaleIds('calendar', items, new Set()), []);
  assert.deepEqual(T.reconcileStaleIds('nonsense', items, new Set()), []);
});

test('an already-done item is not reconciled twice', () => {
  const items = [{ source: 'todoist', id: 'gone', status: 'done' }];
  assert.deepEqual(T.reconcileStaleIds('todoist', items, new Set()), []);
});

test('two-way sync has nowhere to push a manual item', () => {
  assert.equal(T.canPushToSource('manual'), false);
  assert.equal(T.canCompleteOnSource('manual'), false);
  assert.equal(T.canPushToSource('todoist'), true);
  assert.equal(T.canPushToSource('clickup'), true);
  assert.equal(T.canPushToSource('email'), false, 'email takes the star flag, not field writes');
  for (const s of T.SYNCED_SOURCES) assert.equal(T.canCompleteOnSource(s), true, s);
});

test('a manual item is indistinguishable from a synced one downstream', () => {
  const id = T.manualExternalId();
  const fm = T.manualItemFrontmatter('  Buy milk  ', id, '2026-08-30T10:00:00.000Z');
  const item = T.itemFromFrontmatter(fm, '02 Planner/Manual/x.md', 'x');
  assert.ok(item, 'a manual note must parse as a planner item');
  assert.equal(item.source, 'manual');
  assert.equal(item.id, id);
  assert.equal(item.status, 'open');
  assert.equal(item.plannedDay, null);
  assert.equal(item.plannedHalf, null);
  assert.equal(item.plannedOrder, 0);
  assert.equal(item.doneLocal, false);
  assert.equal(item.weeklyGoal, false);
  assert.equal(item.priority, 5, 'no priority is rank 5, never rank 1');

  // Same key set as a synced item: the board, the tray and the drag logic all
  // read this shape and nothing else.
  const syncedFm = {
    type: 'planner-item', source: 'todoist', external_id: '2995104339',
    title: 'Ship it', status: 'open', due: '2026-09-01', priority: 1,
    url: 'https://todoist.com/x', tags: [], source_status: null, list_id: null,
    planned_day: null, planned_half: null, planned_order: 0,
    weekly_goal: false, done_local: false,
  };
  const syncedItem = T.itemFromFrontmatter(syncedFm, '02 Planner/Todoist/y.md', 'y');
  assert.deepEqual(Object.keys(item).sort(), Object.keys(syncedItem).sort());
});

test('the frontmatter contract is written in full, never half', () => {
  const fm = T.manualItemFrontmatter('t', 'manual-a-bbbbbb', '2026-08-30T10:00:00.000Z');
  const required = ['type', 'source', 'external_id', 'title', 'status', 'due',
    'priority', 'url', 'tags', 'source_status', 'planned_day', 'planned_half',
    'planned_order', 'done_local', 'weekly_goal'];
  for (const k of required) assert.ok(k in fm, `missing contract field: ${k}`);
  assert.equal(fm.type, 'planner-item');
  assert.equal(fm.source, 'manual');
  assert.equal(fm.created_at, '2026-08-30T10:00:00.000Z');
  assert.ok(!('synced_at' in fm), 'nothing synced it, so synced_at would be a lie');
});

test('an absent priority is rank 5, not rank 1', () => {
  // Number(null) and Number('') are both 0, which clamps UP to 1, the top
  // rank. A hand-cleared priority on a manual note is the way in.
  for (const raw of [null, undefined, '']) {
    const item = T.itemFromFrontmatter(
      { type: 'planner-item', source: 'manual', external_id: 'manual-a-bbbbbb', priority: raw },
      'p.md', 'p');
    assert.equal(item.priority, 5, `priority ${JSON.stringify(raw)} must be 5`);
  }
  const p1 = T.itemFromFrontmatter(
    { type: 'planner-item', source: 'todoist', external_id: '1', priority: 1 }, 'p.md', 'p');
  assert.equal(p1.priority, 1, 'a real P1 still reads as P1');
});

test('a manual title survives the filename sanitiser', () => {
  assert.equal(T.safeBasename('Call Anna re: the Q3/Q4 plan?'), 'Call Anna re the Q3 Q4 plan');
  assert.equal(T.safeBasename('   '), 'untitled');
  assert.ok(T.safeBasename('x'.repeat(200)).length <= 70);
});
