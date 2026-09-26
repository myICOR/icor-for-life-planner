/* THE NOTES ARE A MIRROR OF THE SOURCE (Tom, 2026-09-17).
 *
 * Two defects, one rule. A task DELETED in ClickUp or Todoist stayed in the
 * vault forever: absence from the open fetch meant "completed" and nothing
 * else, so the card survived, every write aimed at it answered 404, and the
 * retry said so in a toast on every sync ("Planner: reopen on ClickUp failed
 * (ClickUp HTTP 404). Will retry on sync."). And a title edited in the note
 * never reached the source, because `title` was pulled but never shared.
 *
 * The rule now: what the source has, the vault has. Deleted there, gone here.
 * Edited here, sent there. Edited there, pulled here, source wins.
 *
 * Deletion is decided on POSITIVE EVIDENCE ONLY: one bounded confirming GET
 * per absent task, and anything short of "no such task" keeps the old,
 * harmless completion path. A note is never trashed on a guess, and when it
 * is trashed it goes to Obsidian's trash, which is recoverable.
 *
 * Every gate here was watched red against the 0.14.3 bytes through
 * PLANNER_MAIN before it counted.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const PluginClass = require(T.__mainPath);
const { TFile, TFolder } = T.__obsidian;
const bare = () => fs.readFileSync(T.__mainPath, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const ROOT = '02 Planner';
const FOLDER = `${ROOT}/ClickUp`;
const HEAD = '---\ntype: planner-item\n---\n';
const res = (status, json) => ({ status, json, text: JSON.stringify(json || {}), headers: {} });

function note(id, fm) {
  const f = new TFile();
  f.path = `${FOLDER}/Task (clickup-${id}).md`;
  f.basename = `Task (clickup-${id})`;
  f.extension = 'md';
  f.fm = Object.assign({
    type: 'planner-item', source: 'clickup', external_id: id, title: `Task ${id}`,
    status: 'open', due: null, priority: 5, url: null, tags: [], source_status: 'uploaded',
    list_id: '900601028885', planned_day: '2026-09-17', planned_half: 'am', planned_order: 3,
    weekly_goal: true, done_local: false, linked_note: '[[chaser]]',
  }, fm || {});
  f.body = '';
  f.stat = { mtime: 1000, ctime: 1000, size: 0 };
  return f;
}

function plugin(settings, files) {
  const sub = new TFolder(); sub.path = FOLDER; sub.children = files;
  const root = new TFolder(); root.path = ROOT; root.children = [sub];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const trashed = [];
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === ROOT ? root : (byPath.get(p) || null)),
      cachedRead: async (f) => `${HEAD}${f.body || ''}`,
      process: async (f, fn) => { f.body = fn(`${HEAD}${f.body || ''}`).replace(/^---\n[\s\S]*?\n---\n?/, ''); f.stat.mtime += 1; },
      create: async () => { throw new Error('no create in these gates'); },
      trash: async (f, system) => {
        assert.equal(system, true, 'the note always goes to the system trash, never the member setting');
        trashed.push(f.path); sub.children = sub.children.filter((c) => c !== f); byPath.delete(f.path);
      },
    },
    metadataCache: { getFileCache: (f) => ({ frontmatter: f.fm }) },
    fileManager: {
      processFrontMatter: async (f, fn) => { fn(f.fm); f.stat.mtime += 1; },
      // Present and recording: a gate below proves it is never the one used.
      trashFile: async (f) => { trashed.push(`OBEYS-MEMBER-SETTING:${f.path}`); },
    },
  };
  const p = Object.create(PluginClass.prototype);
  p.settings = Object.assign({
    plannerFolder: ROOT, clickupToken: 'tok', clickupTeamId: '2608459',
    completeOnSource: true, pushEdits: true, _shadow: {},
  }, settings);
  p.secrets = null;
  p.app = app;
  p._pushTimers = new Map();
  p._syncWrites = new Map();
  p._goneProbed = new Set();
  if (typeof p.isSyncWrite !== 'function') {
    p.markSyncWrite = () => { }; p.clearSyncWrite = () => { }; p.isSyncWrite = () => false;
  }
  return { p, trashed, byPath };
}

// Records everything that would leave the machine, and answers the probe.
function recording(fn, probeAnswer) {
  const c = T.CONNECTORS.clickup;
  const real = { setClosed: c.setClosed, pushFields: c.pushFields, probeGone: c.probeGone };
  const writes = [];
  const notices = [];
  c.setClosed = async (s, item, closed) => { writes.push({ id: item.id, closed }); };
  c.pushFields = async (s, item, pushes) => { writes.push({ id: item.id, pushes }); };
  c.probeGone = async (s, item) => (typeof probeAnswer === 'function' ? probeAnswer(item) : probeAnswer);
  const RealNotice = T.__obsidian.Notice;
  T.__obsidian.Notice = function (msg) { notices.push(String(msg)); };
  const hadWindow = 'window' in globalThis;
  if (!hadWindow) globalThis.window = { setTimeout: () => 0, clearTimeout: () => { } };
  return Promise.resolve(fn(writes, notices)).finally(() => {
    Object.assign(c, real);
    T.__obsidian.Notice = RealNotice;
    if (!hadWindow) delete globalThis.window;
  });
}

const openTask = (id, over) => Object.assign({
  id, title: `Task ${id}`, due: null, priority: 5, description: '',
  status: 'uploaded', listId: '900601028885', tags: [], url: null,
  parentId: null, recurring: null, dueString: null,
}, over);

const shadowOf = (id, over) => Object.assign({ title: `Task ${id}`, due: null, priority: 5, description: '', done: false }, over);

/* ---- 1. deleted at the source means deleted here ------------------------ */

test('THE RULE: only positive evidence deletes a note', () => {
  assert.equal(T.absenceVerdict(true), 'gone');
  assert.equal(T.absenceVerdict(false), 'done', 'still there and not open = completed, as before');
  assert.equal(T.absenceVerdict(null), 'done', 'could not tell = the harmless path, never the trash');
  assert.equal(T.absenceVerdict(undefined), 'done');
});

test('the confirming GET is bounded per sync', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: String(i) }));
  assert.equal(T.goneProbeBatch(many, T.GONE_PROBE_MAX_PER_SYNC).length, T.GONE_PROBE_MAX_PER_SYNC);
  assert.ok(T.GONE_PROBE_MAX_PER_SYNC > 0 && T.GONE_PROBE_MAX_PER_SYNC <= 50, 'a budget a rate limit survives');
  assert.deepEqual(T.goneProbeBatch(many, 3).map((i) => i.id), ['0', '1', '2'], 'in the order given');
  assert.deepEqual(T.goneProbeBatch(null, 5), []);
  // Only the connectors that can answer are ever asked.
  assert.equal(T.canProbeGone('clickup'), true);
  assert.equal(T.canProbeGone('todoist'), true);
  assert.equal(T.canProbeGone('email'), true);
  assert.equal(T.canProbeGone('outlook'), true);
  assert.equal(T.canProbeGone('manual'), false, 'a manual note has no source to ask');
  assert.equal(T.canProbeGone('calendar'), false);
});

test('"that task is not there any more" is a FLAG, never a message (Flint, finding 1)', () => {
  // The writers that read a status code set it; nothing else counts.
  assert.equal(T.isGoneError(T.goneError('ClickUp')), true);
  assert.equal(T.isGoneError(Object.assign(new Error('x'), { gone: true })), true);
  assert.equal(T.isGoneError(new Error('ClickUp HTTP 500')), false);
  assert.equal(T.isGoneError(new Error('auth')), false);
  assert.equal(T.isGoneError(null), false);
  // THE HAZARD: clickupSetClosed resolves the LIST before it writes the
  // task, and that lookup throws a plain Error('ClickUp HTTP 404') of its
  // own for a stale list_id or a list the token can no longer see. Reading
  // that as "the task is gone" would trash a note whose task is alive.
  assert.equal(T.isGoneError(new Error('ClickUp HTTP 404')), false, 'a 404 on the LIST is not the TASK being gone');
  assert.equal(T.isGoneError(new Error('Microsoft Graph returned HTTP 404.')), false, 'the Graph path carries the flag instead');
  const b = bare();
  assert.match(b, /function isGoneError\(e\) \{\s*return !!e && e\.gone === true;\s*\}/, 'no message is ever parsed');
  // Every writer that CAN tell sets the flag, so nothing is lost by it.
  for (const writer of [/res\.status === 404\) throw goneError\('Todoist'\)/, /res\.status === 404\) throw goneError\('ClickUp'\)/]) {
    assert.match(b, writer);
  }
  assert.equal((b.match(/throw goneError\('ClickUp'\)/g) || []).length, 2, 'clickupWrite and clickupApi both flag it');
  assert.match(b, /if \(status === 404\) \{\s*return Object\.assign\(outlookError\('unreachable', 'Microsoft Graph returned HTTP 404\.'\), \{ gone: true \}\);/, 'and Graph sets it at the one place that knows the status');
});

test('a note is trashed recoverably, never by the member deletion setting (Larry, 2026-09-17)', async () => {
  const n = note('trash-me');
  const { p, trashed } = plugin({ _shadow: { 'clickup:trash-me': shadowOf('trash-me'), 'clickup:alive': shadowOf('alive') } }, [n, note('alive')]);
  await recording(async () => {
    await p.upsertSource('clickup', { items: [openTask('alive')] });
    // The fake vault asserts the `system` argument; here we prove the other
    // path was not taken at all. fileManager.trashFile obeys the member's
    // "Deleted files" setting, one value of which is "permanently delete",
    // and this deletion is a remote signal the member never asked for.
    assert.deepEqual(trashed, [n.path]);
    assert.equal(trashed.some((x) => /OBEYS-MEMBER-SETTING/.test(x)), false, 'trashFile must not be the path');
    assert.match(bare(), /await this\.app\.vault\.trash\(item\.file, true\);/);
  }, (item) => item.id === 'trash-me');
});

test('the probes read their own API: 404 and the ClickUp trash flag', async () => {
  const answer = (r) => async () => r;
  assert.equal(await T.clickupProbeGone('tok', '1', { requestUrl: answer(res(404, {})) }), true);
  assert.equal(await T.clickupProbeGone('tok', '1', { requestUrl: answer(res(200, { deleted: true })) }), true, 'a task in the ClickUp trash is gone too');
  assert.equal(await T.clickupProbeGone('tok', '1', { requestUrl: answer(res(200, { id: '1' })) }), false);
  assert.equal(await T.clickupProbeGone('tok', '1', { requestUrl: answer(res(500, {})) }), null, 'a server error is never evidence');
  assert.equal(await T.clickupProbeGone('tok', '1', { requestUrl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await T.todoistProbeGone('tok', '1', { requestUrl: answer(res(404, {})) }), true);
  assert.equal(await T.todoistProbeGone('tok', '1', { requestUrl: answer(res(200, { id: '1', is_completed: true })) }), false, 'completed but present is not deleted');
  assert.equal(await T.todoistProbeGone('tok', '1', { requestUrl: answer(res(503, {})) }), null);
});

test('THE BUG: a task deleted at the source loses its note, writes nothing, and says so once', async () => {
  const deleted = note('869f0abuc');
  const alive = note('alive');
  const { p, trashed } = plugin({
    _shadow: { 'clickup:869f0abuc': shadowOf('869f0abuc'), 'clickup:alive': shadowOf('alive') },
  }, [deleted, alive]);
  await recording(async (writes, notices) => {
    await p.upsertSource('clickup', { items: [openTask('alive')] });
    assert.deepEqual(trashed, [deleted.path], 'the note is gone from the vault');
    assert.deepEqual(writes, [], 'a deleted task is never written to');
    assert.equal(deleted.fm.status, 'open', 'and it was never marked done on the way out');
    assert.equal(p.settings._shadow['clickup:869f0abuc'], undefined, 'the shadow goes with it');
    assert.ok(p.settings._shadow['clickup:alive'], 'the task that still exists is untouched');
    // What the member is told, and how often: the wording is a pure
    // function and the sync raises it once per pass, never once per task.
    assert.equal(T.goneNotice('ClickUp', 1), 'Planner: a task was deleted in ClickUp, so its note moved to the trash.');
    assert.equal(T.goneNotice('ClickUp', 3), 'Planner: 3 tasks were deleted in ClickUp, so their notes moved to the trash.');
    assert.equal(T.goneNotice('ClickUp', 0), null, 'a sync that trashed nothing says nothing');
    const b = bare();
    assert.equal((b.match(/goneNotice\(SOURCES\[source\]\.label, trashed\)/g) || []).length, 1, 'one notice per sync pass');
    assert.match(b, /if \(gnote\) new Notice\(gnote, 8000\);/);
  }, true);
});

test('a probe that cannot answer never trashes anything: the old completion path stands', async () => {
  const absent = note('unsure');
  const alive = note('alive');
  const { p, trashed } = plugin({
    _shadow: { 'clickup:unsure': shadowOf('unsure'), 'clickup:alive': shadowOf('alive') },
  }, [absent, alive]);
  await recording(async (writes) => {
    await p.upsertSource('clickup', { items: [openTask('alive')] });
    assert.deepEqual(trashed, [], 'no evidence, no trash');
    assert.equal(absent.fm.status, 'done', 'it is treated as completed, exactly as before');
    assert.equal(absent.fm.done_local, true);
    assert.deepEqual(writes, []);
  }, null);
});

test('a ClickUp task that left the query but is still OPEN there is left alone, never marked done', async () => {
  // Unassigned, or a subtask whose parent closed: it drops out of the
  // assignee query while ClickUp still shows it open. Absence is the filter
  // talking; only a done or closed status is the source saying "finished".
  const task = (type) => async () => res(200, { id: 'x', status: { status: 'whatever', type } });
  const openThere = await T.clickupProbeGone('tok', 'x', { requestUrl: task('custom') });
  assert.notEqual(T.absenceVerdict(openThere), 'done', 'a custom (in progress) status is open');
  assert.notEqual(T.absenceVerdict(await T.clickupProbeGone('tok', 'x', { requestUrl: task('open') })), 'done');
  assert.equal(T.absenceVerdict(await T.clickupProbeGone('tok', 'x', { requestUrl: task('done') })), 'done');
  assert.equal(T.absenceVerdict(await T.clickupProbeGone('tok', 'x', { requestUrl: task('closed') })), 'done');

  const left = note('left-query');
  const alive = note('alive');
  const { p, trashed } = plugin({
    _shadow: { 'clickup:left-query': shadowOf('left-query'), 'clickup:alive': shadowOf('alive') },
  }, [left, alive]);
  await recording(async (writes) => {
    await p.upsertSource('clickup', { items: [openTask('alive')] });
    assert.equal(left.fm.status, 'open', 'still open in ClickUp, so still open here');
    assert.equal(left.fm.done_local, false);
    assert.deepEqual(trashed, []);
    assert.deepEqual(writes, []);
    assert.equal(p.settings._shadow['clickup:left-query'].done, false);
  }, openThere);
});

test("THE SCREENSHOT: a pending reopen against a deleted task is dropped, not retried", async () => {
  // Tom's toast: "Planner: reopen on ClickUp failed (ClickUp HTTP 404). Will
  // retry on sync." - forever, every five minutes.
  const n = note('869f0abuc', { status: 'done', done_local: false, reopen_pending: true });
  const { p, trashed } = plugin({
    _shadow: { 'clickup:869f0abuc': shadowOf('869f0abuc', { done: true, doneAt: Date.now() }), 'clickup:alive': shadowOf('alive') },
  }, [n, note('alive')]);
  await recording(async (writes, notices) => {
    await p.upsertSource('clickup', { items: [openTask('alive')] });
    assert.deepEqual(writes, [], 'nothing is retried against a task that is not there');
    assert.deepEqual(trashed, [n.path]);
    assert.equal(notices.some((x) => /Will retry/.test(x)), false, 'the repeating toast is gone');
  }, (item) => item.id === '869f0abuc');
});

test('a write that answers 404 is the same discovery: the note goes, the retry does not', async () => {
  const n = note('gone-mid-write', { done_local: true });
  const { p, trashed } = plugin({ _shadow: { 'clickup:gone-mid-write': shadowOf('gone-mid-write') } }, [n]);
  await recording(async (writes, notices) => {
    T.CONNECTORS.clickup.setClosed = async () => { throw T.goneError('ClickUp'); };
    await p.detectAndPush(n.path);
    assert.deepEqual(trashed, [n.path], 'the source answered "no such task" mid-write');
    assert.equal(notices.some((x) => /Will retry/.test(x)), false);
    assert.equal(p.settings._shadow['clickup:gone-mid-write'], undefined);
    assert.equal(writes.length, 0);
  }, false);
});

/* ---- 1b. the done notes from before 0.15.0 are asked about once -------- */

// Until 0.15.0 absence meant "completed" and nothing else, so a task deleted
// at the source before then left its note marked done. A done note is never
// absent-and-open, so the probe above never reached it: the member trashed
// them by hand (member report, item G).
test('THE BACKLOG: a done note whose task was deleted before 0.15.0 is asked about once', async () => {
  const deleted = note('old-deleted', { status: 'done', done_local: true });
  const closed = note('old-closed', { status: 'done', done_local: true });
  const reopenedOffQuery = note('old-open', { status: 'done', done_local: true });
  const alive = note('alive');
  const { p, trashed } = plugin({ _shadow: { 'clickup:alive': shadowOf('alive') } }, [deleted, closed, reopenedOffQuery, alive]);
  const asked = [];
  const answer = (item) => {
    asked.push(item.id);
    return item.id === 'old-deleted' ? true : item.id === 'old-open' ? 'open' : false;
  };
  await recording(async (writes) => {
    await p.upsertSource('clickup', { items: [openTask('alive')] });
    assert.deepEqual(trashed, [deleted.path], 'deleted there, gone here');
    assert.equal(closed.fm.status, 'done', 'closed there, still done here');
    assert.equal(reopenedOffQuery.fm.status, 'done', 'anything short of "no such task" leaves the note as it is');
    assert.deepEqual(writes, [], 'the look back writes nothing to the source');
    assert.equal(p.settings.goneSweep.clickup, true, 'the look back is finished for this source');
    asked.length = 0;
    p._goneProbed = new Set(); // a new sync pass
    await p.upsertSource('clickup', { items: [openTask('alive')] });
    assert.deepEqual(asked, [], 'and it is never repeated: a done note is not asked about every sync');
  }, answer);
});

test('the look back spends the same per-sync budget, and picks up where it stopped', async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `d${String(i).padStart(2, '0')}`);
  const files = ids.map((id) => note(id, { status: 'done', done_local: true }));
  const absentOpen = note('absent-open');
  const { p } = plugin({ _shadow: { 'clickup:alive': shadowOf('alive'), 'clickup:absent-open': shadowOf('absent-open') } }, [...files, absentOpen, note('alive')]);
  const asked = [];
  await recording(async () => {
    await p.upsertSource('clickup', { items: [openTask('alive')] });
    assert.equal(asked.length, T.GONE_PROBE_MAX_PER_SYNC, 'the absent open task and the look back share one budget');
    assert.equal(asked[0], 'absent-open', 'the ordinary probe goes first');
    assert.equal(p.settings.goneSweep.clickup, ids[T.GONE_PROBE_MAX_PER_SYNC - 2], 'where this pass stopped');
    asked.length = 0;
    p._goneProbed = new Set();
    await p.upsertSource('clickup', { items: [openTask('alive')] });
    assert.deepEqual(asked, ids.slice(T.GONE_PROBE_MAX_PER_SYNC - 1), 'the rest, and none twice');
    assert.equal(p.settings.goneSweep.clickup, true);
  }, (item) => { asked.push(item.id); return false; });
});

test('the look back is pure: task sources only, id order, open and pending notes left out', () => {
  const items = [
    { source: 'clickup', id: 'b', status: 'done' },
    { source: 'clickup', id: 'a', status: 'done' },
    { source: 'clickup', id: 'c', status: 'open' },
    { source: 'clickup', id: 'd', status: 'done', reopenPending: true },
    { source: 'clickup', id: 'e', status: 'done' },
    { source: 'todoist', id: 'a', status: 'done' },
  ];
  const r = T.doneSweepBatch('clickup', items, new Set(['e']), undefined, 25);
  assert.deepEqual(r.batch.map((i) => i.id), ['a', 'b'], 'done, not in the open set, not pending, sorted');
  assert.equal(r.next, true);
  assert.deepEqual(T.doneSweepBatch('clickup', items, new Set(), undefined, 1), { batch: [items[1]], next: 'a' });
  assert.deepEqual(T.doneSweepBatch('clickup', items, new Set(), 'a', 25).batch.map((i) => i.id), ['b', 'e']);
  assert.deepEqual(T.doneSweepBatch('clickup', items, new Set(), true, 25), { batch: [], next: true }, 'finished stays finished');
  assert.deepEqual(T.doneSweepBatch('clickup', items, new Set(), 'a', 0), { batch: [], next: 'a' }, 'no budget left, no progress lost');
  // A mail id is not a stable name: without the mailbox generation a UID
  // that is not found is not evidence the mail was deleted.
  const mail = [{ source: 'email', id: '7', status: 'done' }, { source: 'outlook', id: 'AAk=', status: 'done' }];
  assert.deepEqual(T.doneSweepBatch('email', mail, new Set(), undefined, 25), { batch: [], next: true });
  assert.deepEqual(T.doneSweepBatch('outlook', mail, new Set(), undefined, 25), { batch: [], next: true });
  assert.deepEqual(T.doneSweepBatch('manual', items, new Set(), undefined, 25), { batch: [], next: true });
});

/* ---- 2. edits round-trip, and the source wins --------------------------- */

test('title joined the shared fields; the local worksheet did not', () => {
  assert.deepEqual(T.TWO_WAY_FIELDS, ['title', 'due', 'priority', 'description']);
  for (const local of T.PLAN_OWNED_ITEM_FIELDS) {
    assert.equal(T.TWO_WAY_FIELDS.includes(local), false, `${local} is the plan's own and never leaves the vault`);
  }
});

test('an empty title is never pushed: a note cannot blank a task name', () => {
  assert.equal(T.pushableTitle('Ship the fix'), 'Ship the fix');
  assert.equal(T.pushableTitle('   '), null);
  assert.equal(T.pushableTitle(''), null);
  assert.equal(T.pushableTitle(null), null);
  assert.equal(T.pushableTitle(undefined), null);
  const b = bare();
  assert.match(b, /if \('title' in pushes\) \{\s*const name = pushableTitle\(pushes\.title\);\s*if \(name\) payload\.content = name;/, 'Todoist takes the title as `content`');
  assert.match(b, /if \('title' in pushes\) \{\s*const name = pushableTitle\(pushes\.title\);\s*if \(name\) payload\.name = name;/, 'ClickUp takes it as `name`');
});

test('THE MIGRATION HAZARD: a shadow with no title baseline pushes nothing', () => {
  // Every install carries shadows written before `title` was shared. Without
  // a baseline a value cannot be told from an edit, and the first sync after
  // the upgrade would push every task title back to its source.
  const old = { due: '2026-09-01', priority: 5, description: '', done: false };
  const merged = T.threeWayMerge(
    { title: 'Source name', due: '2026-09-01', priority: 5, description: '' },
    { title: 'Source name', due: '2026-09-01', priority: 5, description: '' },
    old, true,
  );
  assert.deepEqual(merged.pushes, {}, 'nothing is pushed on the seeding sync');
  assert.equal(merged.nextShadow.title, 'Source name', 'the source seeds the baseline');
  assert.equal(merged.finals.title, 'Source name');
  assert.match(bare(), /if \(!shadow \|\| !\(f in shadow\)\) \{ finals\[f\] = src; nextShadow\[f\] = src; continue; \}/);
  assert.match(bare(), /if \(!\(f in sh\)\) continue;/, 'the push check follows the same rule');
});

test('an edit here goes there; an edit there wins and the plan is untouched', async () => {
  const n = note('edit-me');
  n.body = 'my own notes';
  const { p } = plugin({
    _shadow: { 'clickup:edit-me': shadowOf('edit-me', { title: 'Task edit-me', description: 'my own notes' }) },
  }, [n]);
  await recording(async (writes) => {
    // Obsidian to source: the title was edited in the note.
    n.fm.title = 'Task edit-me, renamed here';
    await p.upsertSource('clickup', { items: [openTask('edit-me')] });
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].pushes, { title: 'Task edit-me, renamed here' }, 'the rename reaches the source');
    assert.equal(n.fm.title, 'Task edit-me, renamed here');

    // Source to Obsidian, in the same interval: the source wins.
    writes.length = 0;
    n.fm.title = 'renamed here again';
    await p.upsertSource('clickup', { items: [openTask('edit-me', { title: 'renamed in ClickUp', description: 'their notes' })] });
    assert.equal(n.fm.title, 'renamed in ClickUp', 'source wins a conflict inside one interval');
    assert.equal((n.body || '').trim(), 'their notes');
    assert.deepEqual(writes, [], 'and the pull is never echoed back out');

    // The plan-owned half of the note is never touched by any of it.
    assert.equal(n.fm.planned_day, '2026-09-17');
    assert.equal(n.fm.planned_half, 'am');
    assert.equal(n.fm.planned_order, 3);
    assert.equal(n.fm.weekly_goal, true);
    assert.equal(n.fm.linked_note, '[[chaser]]');
  }, false);
});

test('a source-to-Obsidian update stamps itself, so it can never bounce back out', async () => {
  const n = note('stamp-me');
  const { p } = plugin({ _shadow: { 'clickup:stamp-me': shadowOf('stamp-me') } }, [n]);
  await recording(async (writes) => {
    await p.upsertSource('clickup', { items: [openTask('stamp-me', { title: 'changed at the source' })] });
    assert.equal(n.fm.title, 'changed at the source');
    assert.equal(p.isSyncWrite(n.path), true, 'the push check declines the event this write causes');
    await p.detectAndPush(n.path);
    assert.deepEqual(writes, []);
  }, false);
});
