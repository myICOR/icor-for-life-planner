/* Recurring tasks: a completed occurrence must not take the card with it.
 *
 * Two reported bugs, one cause. A recurring Todoist task keeps its id and only
 * moves its due date forward when an occurrence is completed. The plugin had
 * no notion of an occurrence, so (a) a card checked here stayed struck for
 * ever once the source had moved on, and (b) a task completed inside Todoist
 * kept its card on the old planned day, open, with a future due chip.
 *
 * The decision now lives in one pure function, syncCompletionPlan, and the
 * hazard that makes the extraction worth having is gated below: an advance
 * must NEVER push a close (that would complete the next occurrence too) and
 * never a reopen (that reverts the due date at the source).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const prior = (o) => Object.assign({
  source: 'todoist', id: '1', doneLocal: false, status: 'open', recurring: true,
  plannedDay: null, plannedHalf: null, reopenPending: false,
}, o);

test('THE BUG (B2): a recurring task whose due moved forward drops its local check', () => {
  assert.equal(typeof T.syncCompletionPlan, 'function', 'the decision must be a pure function');
  const plan = T.syncCompletionPlan({
    prior: prior({ doneLocal: true, plannedDay: '2026-09-01', plannedHalf: 'am' }),
    sourceItem: { due: '2026-09-08' },
    shadow: { due: '2026-09-01', done: true },
    completeOnSource: true,
    recurringAdvance: 'move',
  });
  assert.equal(plan.advanced, true);
  assert.equal(plan.resetDoneLocal, true);
  assert.equal(plan.pushClose, false);
  assert.equal(plan.pushReopen, false);
  assert.equal(plan.nextShadowDone, false);
  // default mode: the card moves to the new due day, same half
  assert.deepEqual(plan.movePlan, { day: '2026-09-08', half: 'am' });
  assert.equal(plan.clearPlan, false);
  // and the finished occurrence is recorded where it was planned
  assert.deepEqual(plan.occurrence, { due: '2026-09-01', plannedDay: '2026-09-01', plannedHalf: 'am' });
  assert.equal(plan.lastCompletedDue, '2026-09-01');
});

test('THE BUG (B3): a recurrence advanced at the source moves the card off the past day', () => {
  const plan = T.syncCompletionPlan({
    prior: prior({ doneLocal: false, plannedDay: '2026-09-01', plannedHalf: 'pm' }),
    sourceItem: { due: '2026-09-08' },
    shadow: { due: '2026-09-01', done: false },
    completeOnSource: true,
    recurringAdvance: 'move',
  });
  assert.equal(plan.advanced, true);
  assert.deepEqual(plan.movePlan, { day: '2026-09-08', half: 'pm' });
  assert.equal(plan.pushClose, false);
  assert.equal(plan.pushReopen, false);
});

test('the drop setting sends the card back to the tray instead, history still recorded', () => {
  const plan = T.syncCompletionPlan({
    prior: prior({ doneLocal: true, plannedDay: '2026-09-01', plannedHalf: 'am' }),
    sourceItem: { due: '2026-09-08' },
    shadow: { due: '2026-09-01', done: true },
    completeOnSource: true,
    recurringAdvance: 'drop',
  });
  assert.equal(plan.advanced, true);
  assert.equal(plan.clearPlan, true);
  assert.equal(plan.movePlan, null);
  assert.equal(plan.resetDoneLocal, true);
  assert.deepEqual(plan.occurrence, { due: '2026-09-01', plannedDay: '2026-09-01', plannedHalf: 'am' });
  assert.equal(T.DEFAULT_SETTINGS.recurringAdvance, 'move', 'move is the default');
});

test('a plan on or after the new due survives the advance in both modes', () => {
  for (const recurringAdvance of ['move', 'drop']) {
    const plan = T.syncCompletionPlan({
      prior: prior({ doneLocal: true, plannedDay: '2026-09-10', plannedHalf: 'am' }),
      sourceItem: { due: '2026-09-08' },
      shadow: { due: '2026-09-01', done: true },
      completeOnSource: true,
      recurringAdvance,
    });
    assert.equal(plan.advanced, true, recurringAdvance);
    assert.equal(plan.clearPlan, false, `${recurringAdvance}: the user planned the next occurrence ahead`);
    assert.equal(plan.movePlan, null, `${recurringAdvance}: nothing to move, the plan already stands`);
    assert.equal(plan.resetDoneLocal, true);
    // The occurrence was not done on that future day: history, no ghost.
    assert.deepEqual(plan.occurrence, { due: '2026-09-01', plannedDay: null, plannedHalf: null });
  }
});

test('an unplanned recurring task stays in the tray after an advance', () => {
  const plan = T.syncCompletionPlan({
    prior: prior({ doneLocal: true }),
    sourceItem: { due: '2026-09-08' },
    shadow: { due: '2026-09-01', done: true },
    completeOnSource: true,
    recurringAdvance: 'move',
  });
  assert.equal(plan.advanced, true);
  assert.equal(plan.movePlan, null, 'the sync never plans a card the user did not plan');
  assert.equal(plan.clearPlan, false);
  assert.deepEqual(plan.occurrence, { due: '2026-09-01', plannedDay: null, plannedHalf: null });
});

test('THE HAZARD: an advance never sends a second close, and never a reopen', () => {
  // The naive comparison (doneLocal true vs a reset shadow false) would post
  // /close again and complete the NEXT occurrence too.
  const closeCase = T.syncCompletionPlan({
    prior: prior({ doneLocal: true }),
    sourceItem: { due: '2026-09-08' },
    shadow: { due: '2026-09-01', done: true },
    completeOnSource: true,
    recurringAdvance: 'move',
  });
  assert.equal(closeCase.pushClose, false);
  assert.equal(closeCase.pushReopen, false);
  // The other direction: reset shadow done false vs an already-reset local
  // false must not read as "reopen".
  const reopenCase = T.syncCompletionPlan({
    prior: prior({ doneLocal: false }),
    sourceItem: { due: '2026-09-08' },
    shadow: { due: '2026-09-01', done: true },
    completeOnSource: true,
    recurringAdvance: 'move',
  });
  assert.equal(reopenCase.pushReopen, false);
  assert.equal(reopenCase.pushClose, false);
});

test('a non-recurring due change is a plain pull, never an advance', () => {
  const plan = T.syncCompletionPlan({
    prior: prior({ recurring: false, doneLocal: true, plannedDay: '2026-09-01', plannedHalf: 'am' }),
    sourceItem: { due: '2026-09-08' },
    shadow: { due: '2026-09-01', done: false },
    completeOnSource: true,
    recurringAdvance: 'move',
  });
  assert.equal(plan.advanced, false);
  assert.equal(plan.resetDoneLocal, false);
  assert.equal(plan.clearPlan, false);
  assert.equal(plan.movePlan, null);
  assert.equal(plan.occurrence, null);
  // and the ordinary completion logic still runs: checked here, not yet closed there
  assert.equal(plan.pushClose, true);
});

test('unknown recurrence (older note, ClickUp) follows the occurrence rule; a due moving BACK is not an advance', () => {
  assert.equal(T.occurrenceAdvanced(prior({ recurring: null }), { due: '2026-09-08' }, { due: '2026-09-01' }), true);
  assert.equal(T.occurrenceAdvanced(prior({ recurring: true }), { due: '2026-08-25' }, { due: '2026-09-01' }), false);
  assert.equal(T.occurrenceAdvanced(prior({ recurring: true }), { due: '2026-09-08' }, null), false, 'no baseline, no advance');
  assert.equal(T.occurrenceAdvanced(prior({ recurring: true }), { due: '2026-09-08' }, { due: null }), false);
  assert.equal(T.occurrenceAdvanced(prior({ recurring: true }), { due: null }, { due: '2026-09-01' }), false);
});

test('occurrence history is capped at 30, oldest dropped', () => {
  let list = [];
  for (let i = 1; i <= 35; i++) list = T.appendOccurrence(list, { due: `2026-01-${String(i).padStart(2, '0')}` });
  assert.equal(list.length, T.OCCURRENCE_CAP);
  assert.equal(T.OCCURRENCE_CAP, 30);
  assert.equal(list[0].due, '2026-01-06');
  assert.equal(list[29].due, '2026-01-35');
  assert.deepEqual(T.appendOccurrence(null, { due: 'x' }), [{ due: 'x' }]);
});

test('ghost entries: one per planned occurrence, read-only, distinct from the live card', () => {
  const item = {
    path: '02 Planner/Todoist/Water plants (todoist-1).md', source: 'todoist', id: '1', title: 'Water plants',
    due: '2026-09-08', plannedDay: '2026-09-08', plannedHalf: 'am', doneLocal: false, status: 'open', weeklyGoal: true,
    occurrences: [
      { due: '2026-08-25', plannedDay: '2026-08-25', plannedHalf: 'pm', doneAt: 'x' },
      { due: '2026-09-01', plannedDay: null, plannedHalf: null, doneAt: 'y' },   // history only
      { due: '2026-09-01', plannedDay: '2026-09-01', plannedHalf: 'am', doneAt: 'z' },
    ],
  };
  const ghosts = T.ghostItemsFor([item]);
  assert.equal(ghosts.length, 2, 'an occurrence without a plan renders nothing');
  for (const g of ghosts) {
    assert.equal(g.ghost, true);
    assert.equal(g.doneLocal, true);
    assert.equal(g.status, 'done');
    assert.equal(g.weeklyGoal, false, 'a ghost never pins itself as a goal');
    assert.equal(g.notePath, item.path, 'the ghost opens the live note');
    assert.notEqual(g.path, item.path, 'but never shares its path with the live card');
    assert.deepEqual(g.occurrences, []);
  }
  assert.equal(ghosts[0].plannedDay, '2026-08-25');
  assert.equal(ghosts[0].plannedHalf, 'pm');
  assert.equal(ghosts[0].due, '2026-08-25');
  assert.equal(ghosts[1].plannedDay, '2026-09-01');
  assert.notEqual(ghosts[0].path, ghosts[1].path);
  assert.deepEqual(T.ghostItemsFor([{ path: 'a', occurrences: [] }]), []);
  assert.deepEqual(T.ghostItemsFor([{ path: 'a' }]), []);
});

test('itemFromFrontmatter reads recurring (three-valued), due_string and occurrences', () => {
  const base = { type: 'planner-item', source: 'todoist', external_id: '1', title: 'x' };
  assert.equal(T.itemFromFrontmatter(Object.assign({ recurring: true }, base), 'p', 'b').recurring, true);
  assert.equal(T.itemFromFrontmatter(Object.assign({ recurring: false }, base), 'p', 'b').recurring, false);
  assert.equal(T.itemFromFrontmatter(base, 'p', 'b').recurring, null, 'an older note is unknown, not false');
  assert.equal(T.itemFromFrontmatter(Object.assign({ recurring: null }, base), 'p', 'b').recurring, null);
  assert.equal(T.itemFromFrontmatter(Object.assign({ due_string: 'every monday' }, base), 'p', 'b').dueString, 'every monday');
  assert.equal(T.itemFromFrontmatter(base, 'p', 'b').dueString, null);
  assert.equal(T.itemFromFrontmatter(Object.assign({ last_completed_due: '2026-09-01T00:00' }, base), 'p', 'b').lastCompletedDue, '2026-09-01');
  const it = T.itemFromFrontmatter(Object.assign({
    occurrences: [{ due: '2026-09-01', planned_day: '2026-09-01', planned_half: 'am', done_at: 'z' }, 'junk', { planned_half: 'noon' }],
  }, base), 'p', 'b');
  assert.deepEqual(it.occurrences, [
    { due: '2026-09-01', plannedDay: '2026-09-01', plannedHalf: 'am', doneAt: 'z' },
    { due: null, plannedDay: null, plannedHalf: null, doneAt: null },
  ]);
  assert.deepEqual(T.itemFromFrontmatter(base, 'p', 'b').occurrences, []);
});

test('the sync loop decides completion through syncCompletionPlan, nowhere else', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(code, /syncCompletionPlan\(\{\s*\n?\s*prior/, 'upsertSource must call the pure decision');
  // The old inline comparison is the double-close hazard; it must be gone.
  assert.doesNotMatch(code, /prior\.doneLocal !== nextShadow\.done/, 'the inline completion comparison is back');
  // And the fetch reads both spellings of the Todoist recurrence flag.
  assert.match(code, /t\.due\.is_recurring \|\| t\.due\.recurring/, 'both api/v1 field names must be read');
});
