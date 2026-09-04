/* Unchecking a completed card after a sync must reopen the task.
 *
 * The reported bug: check a Todoist card, let a sync run, uncheck it. The
 * card stayed struck and Todoist stayed closed. Two facts made the dead end:
 * reconcile deleted the shadow of every task that left the open set, and the
 * push path returns without a shadow; and `status: done` from reconcile was
 * final source truth with no way back but the task reappearing, which the
 * reopen would cause, but the reopen never fired.
 *
 * Now the shadow survives reconcile (marked done, pruned by age or when the
 * note is gone), the uncheck sets reopen_pending and reopens optimistically,
 * the push path acts on the flag, and reconcile stands down while it is set.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const item = (o) => Object.assign({
  source: 'todoist', id: '1', status: 'open', doneLocal: false, reopenPending: false,
  due: '2026-09-01', priority: 5, plannedDay: null, plannedHalf: null, recurring: false,
}, o);

test('THE BUG (B1): reconcile keeps the shadow', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // The exact line that threw the memory away.
  assert.doesNotMatch(code, /delete s\._shadow\[`\$\{source\}:\$\{id\}`\]/, 'reconcile still deletes the shadow');
  // Pruning is a pure decision instead, and the sync calls it.
  assert.equal(typeof T.pruneShadows, 'function');
  assert.match(code, /pruneShadows\(s\._shadow, source/, 'upsertSource must prune through the pure function');
});

test('pruneShadows: a done shadow with a note is the memory that lets an uncheck reopen; it stays', () => {
  const now = Date.UTC(2026, 8, 4);
  const day = 86400000;
  const shadows = {
    'todoist:kept-open': { due: '2026-09-01', done: false },
    'todoist:kept-done': { due: '2026-09-01', done: true, doneAt: now - 10 * day },
    'todoist:no-note': { due: '2026-09-01', done: true, doneAt: now - day },
    'todoist:too-old': { due: '2026-09-01', done: true, doneAt: now - 91 * day },
    'todoist:old-but-open': { due: '2026-09-01', done: false, doneAt: now - 200 * day },
    'clickup:kept-done': { due: '2026-09-01', done: true, doneAt: now - 91 * day },
  };
  const existing = new Set(['kept-open', 'kept-done', 'too-old', 'old-but-open']);
  const open = new Set(['kept-open', 'old-but-open']);
  const dropped = T.pruneShadows(shadows, 'todoist', existing, open, now);
  assert.deepEqual(dropped.sort(), ['todoist:no-note', 'todoist:too-old']);
  assert.equal(T.DONE_SHADOW_MAX_AGE_MS, 90 * day);
  // A shadow whose id is in the open set but has no note yet (a create that
  // raced) is kept: the next sync settles it.
  assert.deepEqual(T.pruneShadows({ 'todoist:racing': { done: false } }, 'todoist', new Set(), new Set(['racing']), now), []);
});

test('reconcileStaleIds stands down while a reopen is pending', () => {
  const items = [
    item({ id: 'gone', status: 'open' }),
    item({ id: 'reopening', status: 'open', reopenPending: true }),
    item({ id: 'still-open' }),
  ];
  const out = T.reconcileStaleIds('todoist', items, new Set(['still-open']));
  assert.deepEqual(out.map((i) => i.id), ['gone'], 'the pending reopen must not be re-closed');
});

test('itemFromFrontmatter reads reopen_pending', () => {
  const base = { type: 'planner-item', source: 'todoist', external_id: '1', title: 'x' };
  assert.equal(T.itemFromFrontmatter(base, 'p', 'b').reopenPending, false);
  assert.equal(T.itemFromFrontmatter(Object.assign({ reopen_pending: true }, base), 'p', 'b').reopenPending, true);
  assert.equal(T.itemFromFrontmatter(Object.assign({ reopen_pending: 'yes' }, base), 'p', 'b').reopenPending, false, 'only a real true counts');
});

test('a reopen with the toggle off is refused, not silently dropped', () => {
  assert.equal(typeof T.reopenDecision, 'function');
  assert.equal(T.reopenDecision({ statusDone: true, completeOnSource: true, synced: true }), 'push');
  assert.equal(T.reopenDecision({ statusDone: true, completeOnSource: false, synced: true }), 'refuse-local');
  assert.equal(T.reopenDecision({ statusDone: false, completeOnSource: false, synced: true }), 'local-only');
  assert.equal(T.reopenDecision({ statusDone: false, completeOnSource: true, synced: true }), 'local-only');
  // A manual note has no source to refuse on behalf of.
  assert.equal(T.reopenDecision({ statusDone: true, completeOnSource: false, synced: false }), 'local-only');
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  assert.match(main, /reopenDecision\(\{[\s\S]{0,200}statusDone: item\.status === 'done'/, 'toggleDoneLocal must consult the decision');
  assert.match(main, /Turn on Complete on source to reopen it from here/, 'the refusal must say what to do');
});

test('the sync confirms a reopen: the task is back in the open set, nothing is pushed twice', () => {
  const plan = T.syncCompletionPlan({
    prior: item({ reopenPending: true, status: 'done' }),
    sourceItem: { due: '2026-09-01' },
    shadow: { due: '2026-09-01', done: true },
    completeOnSource: true,
    recurringAdvance: 'move',
  });
  assert.equal(plan.pushReopen, false, 'the fetch already proved it open');
  assert.equal(plan.pushClose, false);
  assert.equal(plan.nextShadowDone, false);
  assert.equal(plan.clearReopenPending, true);
  assert.equal(plan.advanced, false);
});

test('the ordinary close and reopen retries at sync time are unchanged', () => {
  const closeRetry = T.syncCompletionPlan({
    prior: item({ doneLocal: true }), sourceItem: { due: '2026-09-01' },
    shadow: { due: '2026-09-01', done: false }, completeOnSource: true, recurringAdvance: 'move',
  });
  assert.equal(closeRetry.pushClose, true);
  assert.equal(closeRetry.pushReopen, false);
  const reopenRetry = T.syncCompletionPlan({
    prior: item({ doneLocal: false }), sourceItem: { due: '2026-09-01' },
    shadow: { due: '2026-09-01', done: true }, completeOnSource: true, recurringAdvance: 'move',
  });
  assert.equal(reopenRetry.pushReopen, true);
  assert.equal(reopenRetry.pushClose, false);
  const off = T.syncCompletionPlan({
    prior: item({ doneLocal: true }), sourceItem: { due: '2026-09-01' },
    shadow: { due: '2026-09-01', done: false }, completeOnSource: false, recurringAdvance: 'move',
  });
  assert.equal(off.pushClose, false);
  assert.equal(off.pushReopen, false);
  assert.equal(off.nextShadowDone, false);
  const noShadow = T.syncCompletionPlan({
    prior: item({ doneLocal: true }), sourceItem: { due: '2026-09-01' },
    shadow: null, completeOnSource: true, recurringAdvance: 'move',
  });
  assert.equal(noShadow.pushClose, true, 'a first-sync check still closes');
});

test('the push path acts on reopen_pending even without a shadow', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.doesNotMatch(code, /if \(!sh\) return;/, 'the unconditional early return is the dead end');
  assert.match(code, /if \(!sh && item\.reopenPending !== true\) return;/);
  assert.match(code, /const wantReopen = item\.reopenPending === true && !item\.doneLocal;/);
});
