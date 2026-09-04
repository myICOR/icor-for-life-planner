/* Subtasks: a parent id through fetch and frontmatter, an index built once
 * per render, the kicker on a child card, the counter and the inline list on
 * the parent card, and the rule that a recurring parent's advance unchecks
 * its children here.
 *
 * The vault stays a flat list of notes; the hierarchy is the index. The
 * two rules that matter are gated here: resolution is same-source only (a
 * ClickUp id equal to a Todoist parent id must never resolve), and dragging
 * a parent carries the parent alone. ClickUp subtasks are requested only
 * when the setting asks, because an existing board must not fill up on
 * upgrade.
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

const item = (o) => Object.assign({
  path: `02 Planner/Todoist/${o.id}.md`, source: 'todoist', id: '1', title: `Task ${o.id}`,
  status: 'open', doneLocal: false, due: null, priority: 5, plannedDay: null, plannedHalf: null,
  plannedOrder: 0, weeklyGoal: false, recurring: false, dueString: null, reopenPending: false,
  parentId: null, occurrences: [],
}, o);

const fm = (o) => Object.assign({
  type: 'planner-item', source: 'todoist', external_id: '1', title: 'x', status: 'open',
}, o);

test('a Todoist subtask keeps its parent id through frontmatter', () => {
  assert.equal(T.itemFromFrontmatter(fm({ parent_id: '42' }), 'p.md', 'p').parentId, '42');
  assert.equal(T.itemFromFrontmatter(fm({ parent_id: 42 }), 'p.md', 'p').parentId, '42', 'a number reads as the same id');
  assert.equal(T.itemFromFrontmatter(fm({ parent_id: null }), 'p.md', 'p').parentId, null);
  assert.equal(T.itemFromFrontmatter(fm({}), 'p.md', 'p').parentId, null, 'a note from before the field existed');
  assert.equal(T.itemFromFrontmatter(fm({ parent_id: '' }), 'p.md', 'p').parentId, null);
  // The fetch mappers carry it from the source's own field name.
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  assert.ok(/parentId: t\.parent_id \? String\(t\.parent_id\) : null/.test(main), 'the Todoist mapper reads parent_id');
  assert.ok(/parentId: t\.parent \? String\(t\.parent\) : null/.test(main), 'the ClickUp mapper reads parent');
  // and both writers put it in the note
  assert.ok(/`parent_id: \$\{t\.parentId \? JSON\.stringify\(String\(t\.parentId\)\) : null\}`/.test(main), 'createItemFile writes parent_id');
  assert.ok(/fm\.parent_id = wantParent;/.test(main), 'updateItemFile writes parent_id');
  assert.ok(/prior\.parentId !== wantParent \|\|/.test(main), 'a changed parent is a changed note');
});

test('the index resolves children within one source only', () => {
  const tp = item({ id: 'p1', title: 'Todoist parent' });
  const tc = item({ id: 'c1', parentId: 'p1' });
  const cp = item({ id: 'p1', source: 'clickup', path: '02 Planner/ClickUp/p1.md', title: 'ClickUp parent' });
  const cc = item({ id: 'c9', source: 'clickup', path: '02 Planner/ClickUp/c9.md', parentId: 'p1' });
  const stray = item({ id: 'c2', parentId: 'zzz' });
  const index = T.buildItemIndex([tp, tc, cp, cc, stray]);
  assert.equal(T.parentTitleFor(tc, index), 'Todoist parent');
  assert.equal(T.parentTitleFor(cc, index), 'ClickUp parent');
  assert.deepEqual(index.childrenOf.get('todoist:p1').map((c) => c.id), ['c1']);
  assert.deepEqual(index.childrenOf.get('clickup:p1').map((c) => c.id), ['c9']);
  assert.equal(T.parentOf(tc, index), tp, 'the parent passes through by reference');
  // a Todoist child whose parent id happens to equal a ClickUp id resolves to nothing
  const cross = item({ id: 'c3', parentId: 'p1', source: 'todoist' });
  const only = T.buildItemIndex([cp, cross]);
  assert.equal(T.parentTitleFor(cross, only), null);
  assert.equal(T.subtaskCounter(cp, only), null, 'and the ClickUp parent counts no Todoist child');
});

test('THE ASK: a parent with two children, one done, counts 1 of 2', () => {
  const p = item({ id: 'p', title: 'Parent' });
  const a = item({ id: 'a', parentId: 'p', doneLocal: true, title: 'B first by title' });
  const b = item({ id: 'b', parentId: 'p', title: 'A second by order', plannedOrder: 5 });
  const index = T.buildItemIndex([p, a, b]);
  assert.deepEqual(T.subtaskCounter(p, index), { done: 1, total: 2 });
  assert.equal(T.subtaskCounterText({ done: 1, total: 2 }), '1 of 2 subtasks');
  assert.equal(T.subtaskCounterText({ done: 0, total: 1 }), '0 of 1 subtask');
  // open first, then the lane order, then the title
  assert.deepEqual(T.childrenOfItem(p, index).map((c) => c.id), ['b', 'a']);
  const c = item({ id: 'c', parentId: 'p', title: 'AAA', plannedOrder: 9 });
  const d = item({ id: 'd', parentId: 'p', title: 'ZZZ', plannedOrder: 9 });
  assert.deepEqual(T.childrenOfItem(p, T.buildItemIndex([p, d, c])).map((x) => x.id), ['c', 'd']);
  // the source's closed status counts as done, like everywhere else
  const closed = item({ id: 'e', parentId: 'p', status: 'done' });
  assert.deepEqual(T.subtaskCounter(p, T.buildItemIndex([p, closed])), { done: 1, total: 1 });
});

test('a child planned elsewhere is still listed under its parent, with its day', () => {
  const p = item({ id: 'p', plannedDay: '2026-09-08', plannedHalf: 'am' });
  const same = item({ id: 'a', parentId: 'p', plannedDay: '2026-09-08', plannedHalf: 'pm' });
  const other = item({ id: 'b', parentId: 'p', plannedDay: '2026-09-10', plannedHalf: 'am' });
  const tray = item({ id: 'c', parentId: 'p' });
  const index = T.buildItemIndex([p, same, other, tray]);
  assert.equal(T.subtaskCounter(p, index).total, 3, 'every child is listed, wherever it sits');
  assert.equal(T.subtaskRowMeta(same, p), null, 'same day: no chip');
  assert.equal(T.subtaskRowMeta(other, p), T.fmtDayNum('2026-09-10'));
  assert.equal(T.subtaskRowMeta(tray, p), 'TRAY');
  // an unplanned parent: an unplanned child is where the parent is
  const loose = item({ id: 'q' });
  assert.equal(T.subtaskRowMeta(tray, loose), null);
  assert.equal(T.subtaskRowMeta(other, loose), T.fmtDayNum('2026-09-10'));
});

test('a missing parent yields no kicker and no counter, never a crash', () => {
  const orphan = item({ id: 'o', parentId: 'gone' });
  const index = T.buildItemIndex([orphan]);
  assert.equal(T.parentTitleFor(orphan, index), null);
  assert.equal(T.parentOf(orphan, index), null);
  assert.equal(T.subtaskCounter(orphan, index), null);
  assert.equal(T.parentTitleFor(orphan, null), null);
  assert.equal(T.parentTitleFor(null, index), null);
  assert.deepEqual(T.childrenOfItem(orphan, null), []);
  const empty = T.buildItemIndex(null);
  assert.equal(empty.byKey.size, 0);
  assert.equal(empty.childrenOf.size, 0);
  // a ghost never enters the index: it shares its live card's id
  const live = item({ id: 'p' });
  const ghost = Object.assign({}, live, { ghost: true, path: `${live.path}#occurrence-0` });
  assert.equal(T.buildItemIndex([ghost, live]).byKey.get('todoist:p'), live);
});

test('dragging a parent never carries a child path', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const card = main.slice(main.indexOf('function renderCard('), main.indexOf('function renderSubtaskRow('));
  const sets = card.match(/setData\('text\/plain'/g) || [];
  assert.equal(sets.length, 1, 'exactly one drag payload in renderCard');
  assert.ok(/e\.dataTransfer\.setData\('text\/plain', item\.path\);/.test(card), 'and it is the card\'s own path');
  // the subtask list is never a drag source of its own
  const sub = main.slice(main.indexOf('function renderSubtaskRow('), main.indexOf('function wireLongPress('));
  assert.ok(!/dragstart|setData\(/.test(sub), 'no drag handler on the subtask list');
  // the drop handler moves the dropped path and nothing else
  assert.ok(/this\.plugin\.assignItem\(path, day, half, order\);/.test(main), 'the lane drop assigns the one dropped path');
});

test('an advanced recurring parent asks for its children\'s local check to reset', () => {
  const prior = { source: 'todoist', id: 'p', doneLocal: true, status: 'open', recurring: true, plannedDay: '2026-09-01', plannedHalf: 'am', reopenPending: false };
  const advanced = T.syncCompletionPlan({
    prior, sourceItem: { due: '2026-09-08' }, shadow: { due: '2026-09-01', done: true },
    completeOnSource: true, recurringAdvance: 'move',
  });
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.resetChildrenDoneLocal, true);
  const still = T.syncCompletionPlan({
    prior: Object.assign({}, prior, { doneLocal: false }), sourceItem: { due: '2026-09-01' },
    shadow: { due: '2026-09-01', done: false }, completeOnSource: true, recurringAdvance: 'move',
  });
  assert.equal(still.advanced, false);
  assert.equal(still.resetChildrenDoneLocal, false);
  // and the sync applies it to the children of that parent, in the same pass
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const sync = main.slice(main.indexOf('async upsertSource('), main.indexOf('async readBody('));
  assert.ok(/const index = buildItemIndex\(allItems\);/.test(sync), 'the index is built once per sync');
  assert.ok(/if \(plan\.resetChildrenDoneLocal\) advancedParents\.push\(key\);/.test(sync), 'the advance is remembered');
  assert.ok(/for \(const child of index\.childrenOf\.get\(key\) \|\| \[\]\)/.test(sync), 'and the children are walked');
  assert.ok(/processFrontMatter\(child\.file, \(fm\) => \{ fm\.done_local = false; \}\)/.test(sync), 'each open, checked child is unchecked');
});

test('a task the source reopened comes back unchecked and pushes nothing', () => {
  // The child of a recurring parent: closed here, reconciled done, then
  // reopened by the source when the parent recurred. The stale local check
  // must not close it a second time.
  const plan = T.syncCompletionPlan({
    prior: { source: 'todoist', id: 'c', doneLocal: true, status: 'done', recurring: false, plannedDay: null, plannedHalf: null, reopenPending: false },
    sourceItem: { due: null }, shadow: { due: null, done: true },
    completeOnSource: true, recurringAdvance: 'move',
  });
  assert.equal(plan.pushClose, false, 'the source reopened it; a close now would be a double close');
  assert.equal(plan.pushReopen, false);
  assert.equal(plan.resetDoneLocal, true);
  assert.equal(plan.nextShadowDone, false);
  assert.equal(plan.advanced, false);
  // the frontmatter rule says the same thing on the note
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  assert.ok(/if \(fm\.status === 'done'\) \{ fm\.status = 'open'; delete fm\.done_at; fm\.done_local = false; \}/.test(main), 'a reopen at the source is a reopen here');
});

test('ClickUp subtasks are requested only when the setting is on', () => {
  assert.equal(typeof T.clickupQuery, 'function');
  assert.equal(T.DEFAULT_SETTINGS.clickupIncludeSubtasks, false, 'off by default: an existing board must not flood');
  const off = T.clickupQuery({}, 'u1', 0);
  assert.ok(off.includes('subtasks=false'), off);
  assert.ok(off.includes('include_closed=false'));
  assert.ok(off.includes('assignees%5B%5D=u1'), 'the assignee filter stays');
  assert.ok(off.includes('page=0'));
  const on = T.clickupQuery({ clickupIncludeSubtasks: true }, 'u1', 3);
  assert.ok(on.includes('subtasks=true'), on);
  assert.ok(on.includes('page=3'));
  assert.ok(T.clickupQuery({ clickupIncludeSubtasks: 'true' }, 'u1', 0).includes('subtasks=false'), 'a string is not the switch');
  // the fetch goes through the helper and no literal remains beside it
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const fetch = main.slice(main.indexOf('async function clickupFetchOpen('), main.indexOf('/* ====', main.indexOf('async function clickupFetchOpen(')));
  assert.ok(/\$\{clickupQuery\(settings, myId, page\)\}/.test(fetch), 'the fetch builds its query through clickupQuery');
  assert.ok(!/subtasks: 'false'/.test(fetch), 'no hand-built subtasks parameter beside the helper');
});

test('a recurring item renders the repeat chip', () => {
  const today = '2026-09-04';
  const chips = T.cardChips(item({ id: 'r', recurring: true, dueString: 'every monday', due: '2026-09-07', priority: 1, weeklyGoal: true }), today);
  assert.deepEqual(chips.map((c) => c.kind), ['due', 'priority', 'goal', 'repeat'], 'due, priority, goal, then repeat');
  const repeat = chips[3];
  assert.equal(repeat.icon, 'repeat');
  assert.equal(repeat.label, 'Repeats, every monday');
  assert.equal(repeat.cls, 'iplan-chip iplan-repeat-chip');
  assert.equal(T.cardChips(item({ id: 'r', recurring: true }), today)[0].label, 'Repeats', 'no phrase: the word alone');
  // unknown recurrence (ClickUp, an old note) shows no chip; false neither
  assert.deepEqual(T.cardChips(item({ id: 'u', recurring: null }), today), []);
  assert.deepEqual(T.cardChips(item({ id: 'f', recurring: false }), today), []);
  // a ghost's due is the date, neutrally, and it can still say it repeats
  const ghost = T.cardChips(item({ id: 'g', recurring: true, due: '2026-08-31' }), today, true);
  assert.deepEqual(ghost.map((c) => [c.kind, c.cls, c.text]), [['due', 'iplan-chip', T.fmtDayNum('2026-08-31')], ['repeat', 'iplan-chip iplan-repeat-chip', '']]);
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const card = main.slice(main.indexOf('function renderCard('), main.indexOf('function renderSubtaskRow('));
  assert.ok(/for \(const c of cardChips\(item, today, ghost\)\)/.test(card), 'the card draws the chips it is given');
  assert.ok(/chip\.setAttribute\('role', 'img'\);\s*\n\s*chip\.setAttribute\('aria-label', c\.label\);/.test(card), 'a glyph chip is spoken');
});

test('SOURCE: the kicker and the counter come from the index; a ghost gets no counter; the list is the shared checklist', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const card = main.slice(main.indexOf('function renderCard('), main.indexOf('function renderSubtaskRow('));
  assert.ok(/const index = view && view\.index \? view\.index : null;/.test(card), 'the index rides the view');
  assert.ok(/const parent = parentOf\(item, index\);/.test(card));
  assert.ok(/kicker\.className = 'iplan-card-parent';/.test(card), 'the kicker element');
  assert.ok(/said\.textContent = 'Part of ';/.test(card), 'spoken as "Part of"');
  assert.ok(/const counter = !ghost && plugin\.settings\.subtaskChecklist !== false \? subtaskCounter\(item, index\) : null;/.test(card), 'no counter on a ghost or with the setting off');
  const sub = main.slice(main.indexOf('function renderSubtaskRow('), main.indexOf('function wireLongPress('));
  assert.ok(/btn\.setAttribute\('aria-controls', listId\);/.test(sub));
  assert.ok(/btn\.setAttribute\('aria-expanded', open \? 'true' : 'false'\);/.test(sub));
  assert.ok(/setIcon\(chevron, 'chevron-right'\);/.test(sub));
  assert.ok(/expanded\.add\(item\.path\); else expanded\.delete\(item\.path\);/.test(sub), 'the open state is per parent path on the view');
  assert.ok(/renderChecklist\(list, model, \{/.test(sub), 'the children are the shared checklist');
  assert.ok(/onToggle: \(id\) => plugin\.toggleDoneLocal\(String\(id\)\),/.test(sub), 'a child check is the child\'s own check');
  assert.ok(/meta: subtaskRowMeta\(k, item\)/.test(sub), 'the day chip or TRAY');
  // both views seed the index and the expanded set
  assert.equal((main.match(/this\.index = buildItemIndex\(items\);/g) || []).length, 2, 'board and tray build the index once per render');
  assert.equal((main.match(/this\.expanded = new Set\(\);/g) || []).length, 2);
  // the menu offers the parent
  const menu = main.slice(main.indexOf('function showCardMenu('), main.indexOf('function showPlanMenu('));
  assert.ok(/setTitle\('Open parent note'\)/.test(menu));
  assert.ok(/const parent = parentOf\(item, view && view\.index\);/.test(menu));
  // a refused flip (the reopen the source will not take) reverts the row quietly
  const list = main.slice(main.indexOf('function renderChecklist('), main.indexOf('const LOG_DATE_RE'));
  assert.ok(/result\.then\(\(v\) => \{ if \(v === false\) revert\(\); \}/.test(list), 'a resolved false reverts');
  const toggle = main.slice(main.indexOf('async toggleDoneLocal('), main.indexOf('async toggleWeeklyGoal('));
  assert.ok(/return false;\s*\n\s*\}\s*\n\s*await this\.app\.fileManager\.processFrontMatter/.test(toggle), 'the refusal returns false');
  assert.ok(/return true;\s*\n\s*\}/.test(toggle), 'a write returns true');
});

test('SOURCE: the subtask rows keep the plugin\'s ink and its touch target', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const start = css.indexOf('/* ======================================================== 2026-09-04 b ===');
  assert.ok(start > 0, 'the run 3b block must be findable');
  const block = css.slice(start);
  assert.match(block, /\.iplan-card-parent \{[^}]*color: var\(--iplan-faint\)/, 'the kicker is the quiet ink');
  assert.match(block, /button\.iplan-card-sub-toggle \{[^}]*color: var\(--iplan-dim\)/);
  assert.match(block, /button\.iplan-card-sub-toggle:focus-visible \{[^}]*var\(--iplan-marker\)/, 'focus is the marker stroke');
  assert.match(block, /\.iplan-sr-only \{/, 'the spoken prefix has its rule');
  assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.iplan-card-sub-chevron \{ transition: none; \}/, 'the chevron turn respects reduced motion');
  const coarse = block.slice(block.indexOf('@media (any-pointer: coarse)'));
  assert.match(coarse, /button\.iplan-card-sub-toggle \{ min-height: 44px; \}/, 'the toggle is a 44px target on touch');
});
