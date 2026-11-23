/* THE SOURCE IS THE WINNER (Tom's ruling, 2026-09-17).
 *
 * The defect (ClickUp PM-12518 and PM-12526, root-caused 2026-09-16): a task
 * published in ClickUp leaves the open fetch, reconcile writes `status: done`
 * onto the planner note and marks the shadow done, and Obsidian's
 * metadataCache `changed` event fires on that write. The push check could not
 * tell the plugin's own hand from a person's edit, read the note as
 * "unchecked while the shadow says done", and PUT the list's FIRST OPEN
 * status back to ClickUp 1.1 seconds later. A published episode became
 * `not started`, four times over two days.
 *
 * The rule now, in one line: a completion crosses from Obsidian to the
 * source, never the other way. "Complete on source" means checking a card
 * here closes the task there. It never reopens a task at the source and
 * never rewrites a source status to make it agree with a note. The single
 * exception is the person's own uncheck of a card, which carries the
 * explicit `reopen_pending` flag that only toggleDoneLocal writes.
 *
 * Three gates, driven end to end through the real upsertSource and
 * detectAndPush against a recording connector, so "zero source writes" means
 * zero calls to the thing that speaks HTTP:
 *   a. a task closed at the source: reconcile plus the push check, no writes
 *   b. a check here with the setting on: exactly one completion write
 *   c. the setting off: no source write at all
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const PluginClass = require(T.__mainPath);
const { TFile, TFolder } = T.__obsidian;

const code = () => fs.readFileSync(T.__mainPath, 'utf8');
const bare = () => code().split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const ROOT = '06 Planner';
// A real frontmatter block, because readBody strips one and an empty pair of
// fences is not a block Obsidian ever writes.
const HEAD = '---\ntype: planner-item\n---\n';
const FOLDER = `${ROOT}/ClickUp`;

// A planner note, backed by a mutable frontmatter object the fake
// processFrontMatter edits in place - the same thing Obsidian does.
function note(id, fm) {
  const f = new TFile();
  f.path = `${FOLDER}/Task (clickup-${id}).md`;
  f.basename = `Task (clickup-${id})`;
  f.extension = 'md';
  f.fm = Object.assign({
    type: 'planner-item', source: 'clickup', external_id: id, title: `Task ${id}`,
    status: 'open', due: null, priority: 5, url: null, tags: [], source_status: 'uploaded',
    list_id: '900601028885', planned_day: null, planned_half: null, planned_order: 0,
    weekly_goal: false, done_local: false, linked_note: null,
  }, fm || {});
  f.body = '';
  // The adapter reconciles the index before a write resolves, so `stat.mtime`
  // is the post-write mtime the moment the await returns. The fakes below
  // bump it on every write, which is the whole of the self-write signal.
  f.stat = { mtime: 1000, ctime: 1000, size: 0 };
  return f;
}

// Everything the plugin touches on a vault, and nothing else.
function vault(files) {
  const sub = new TFolder();
  sub.path = FOLDER;
  sub.children = files;
  const root = new TFolder();
  root.path = ROOT;
  root.children = [sub];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const events = [];
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === ROOT ? root : (byPath.get(p) || null)),
      cachedRead: async (f) => `${HEAD}${f.body || ''}`,
      process: async (f, fn) => { f.body = fn(`${HEAD}${f.body || ''}`).replace(/^---\n[\s\S]*?\n---\n?/, ''); f.stat.mtime += 1; events.push(f.path); },
      create: async () => { throw new Error('no create in these gates'); },
    },
    metadataCache: { getFileCache: (f) => ({ frontmatter: f.fm }) },
    fileManager: {
      processFrontMatter: async (f, fn) => { fn(f.fm); f.stat.mtime += 1; events.push(f.path); },
    },
  };
  return { app, root, events, byPath };
}

// The plugin, with a connector that records instead of calling ClickUp.
function plugin(settings, files) {
  const v = vault(files);
  const p = Object.create(PluginClass.prototype);
  p.settings = Object.assign({
    plannerFolder: ROOT, clickupToken: 'tok', clickupTeamId: '2608459',
    completeOnSource: true, pushEdits: true, _shadow: {},
  }, settings);
  p.secrets = null;
  p.app = v.app;
  p._pushTimers = new Map();
  p._syncWrites = new Map();
  p._goneProbed = new Set();
  // Pre-0.14.3 bytes have no self-write stamp. Standing in for it with "not
  // a sync write" is what lets every gate below run against the old main.js
  // through PLANNER_MAIN and be SEEN red, which is the whole point of them.
  if (typeof p.isSyncWrite !== 'function') {
    p.markSyncWrite = () => { };
    p.clearSyncWrite = () => { };
    p.isSyncWrite = () => false;
  }
  return { p, v };
}

// Swap the one method that speaks HTTP for a recorder, for the duration.
function recordConnector(fn) {
  const c = T.CONNECTORS.clickup;
  const realClosed = c.setClosed;
  const realPush = c.pushFields;
  const writes = [];
  c.setClosed = async (s, item, closed) => { writes.push({ id: item.id, closed }); };
  c.pushFields = async (s, item, pushes) => { writes.push({ id: item.id, pushes }); };
  // detectAndPush debounces its settings save through window.
  const hadWindow = 'window' in globalThis;
  if (!hadWindow) globalThis.window = { setTimeout: () => 0, clearTimeout: () => { } };
  return Promise.resolve(fn(writes)).finally(() => {
    c.setClosed = realClosed;
    c.pushFields = realPush;
    if (!hadWindow) delete globalThis.window;
  });
}

const openTask = (id) => ({
  id, title: `Task ${id}`, due: null, priority: 5, description: '',
  status: 'uploaded', listId: '900601028885', tags: [], url: null,
  parentId: null, recurring: null, dueString: null,
});

/* ---- a. the task the source closed -------------------------------------- */

test('THE BUG (a): a task closed at the source produces ZERO source writes across reconcile and the push check', async () => {
  const closed = note('869f0abuc');          // published in ClickUp: gone from the open set
  const survives = note('869f2zpjg');        // still open, so the fetch is evidence
  const { p, v } = plugin({
    _shadow: {
      'clickup:869f0abuc': { due: null, priority: 5, description: '', done: false },
      'clickup:869f2zpjg': { due: null, priority: 5, description: '', done: false },
    },
  }, [closed, survives]);

  await recordConnector(async (writes) => {
    await p.upsertSource('clickup', { items: [openTask('869f2zpjg')] });
    assert.deepEqual(writes, [], 'the reconcile itself must write nothing to ClickUp');

    // THE RED: this is the metadataCache `changed` event firing on the
    // reconcile's own write. Against the 0.14.2 bytes it records
    // { id: '869f0abuc', closed: false } - the PUT that set a published
    // episode back to `not started`.
    await p.detectAndPush(closed.path);
    assert.deepEqual(writes, [], 'the push check must not read the plugin own write as an uncheck');

    // Belt AND braces. The suppression above is one half; the other is that
    // there is no difference left to misread, because the reconcile writes
    // both completion flags. With the stamp cleared, still nothing goes out.
    p.clearSyncWrite(closed.path);
    await p.detectAndPush(closed.path);
    assert.deepEqual(writes, [], 'no difference exists to push, suppression or not');

    // The note mirrors the source, and the two completion flags agree.
    assert.equal(closed.fm.status, 'done');
    assert.equal(closed.fm.done_local, true, 'a source-closed card is CHECKED here, not merely struck');
    assert.ok(closed.fm.done_at);
    assert.equal(p.settings._shadow['clickup:869f0abuc'].done, true);
  });
});

test('(a2) a stale shadow never reopens anything: the shadow heals, the source is untouched', async () => {
  // The shadow says done while the source returns the task OPEN. Until
  // 0.14.3 both the sync plan and the push check "corrected" the source.
  const n = note('stale');
  const { p } = plugin({
    _shadow: { 'clickup:stale': { due: null, priority: 5, description: '', done: true } },
  }, [n]);
  await recordConnector(async (writes) => {
    await p.upsertSource('clickup', { items: [openTask('stale')] });
    assert.deepEqual(writes, [], 'the source already says open; nothing may be written to it');
    assert.equal(p.settings._shadow['clickup:stale'].done, false, 'the shadow follows the source');
    p.clearSyncWrite(n.path);
    await p.detectAndPush(n.path);
    assert.deepEqual(writes, []);
  });
});

// Flint, 2026-09-17, finding 1. The reconcile writes `done_local: true`, and
// the push check reads `done_local` as the person's intent to close. If the
// shadow has meanwhile lost its done flag - Obsidian quit before the
// debounced data.json save, or a second device took the note through Sync
// before the settings - the note reads "status done, done_local true"
// against a shadow reading open, and the plugin closes a task the source
// already closed. A no-op on Todoist, IMAP and Outlook; on a ClickUp list
// with more than one closed-type status it rewrites the status, which is a
// write to the source born from a source completion. `status: done` has one
// writer, the reconcile, so it MEANS "the source closed it": a close against
// it is never needed.
test('(a3) a shadow that lost its done flag never closes a task the source already closed', async () => {
  const n = note('869f0abuc', { status: 'done', done_local: true, done_at: '2026-09-17T09:00:00Z' });
  const { p } = plugin({
    _shadow: { 'clickup:869f0abuc': { due: null, priority: 5, description: '', done: false } },
  }, [n]);
  await recordConnector(async (writes) => {
    await p.detectAndPush(n.path);
    assert.deepEqual(writes, [], 'the source closed it; nothing may be written back, not even a close');
  });
});

/* ---- b. the check made here --------------------------------------------- */

test('(b) a check in Obsidian with the setting on produces EXACTLY ONE completion write', async () => {
  const n = note('check-me');
  const { p } = plugin({
    _shadow: { 'clickup:check-me': { due: null, priority: 5, description: '', done: false } },
  }, [n]);
  await recordConnector(async (writes) => {
    assert.equal(await p.toggleDoneLocal(n.path), true);
    assert.equal(n.fm.done_local, true);
    await p.detectAndPush(n.path);
    assert.equal(writes.length, 1, 'one write, and one only');
    assert.deepEqual(writes[0], { id: 'check-me', closed: true }, 'a close, never a status rewrite');
    // A second event on the same note (Obsidian fires more than one) is not
    // a second close: the shadow now agrees with the card.
    await p.detectAndPush(n.path);
    assert.equal(writes.length, 1);
    // And the sync that follows does not close it a second time either.
    await p.upsertSource('clickup', { items: [openTask('check-me')] });
    assert.equal(writes.length, 1, 'the close already reached the source');
  });
});

test('(b2) the one reopen that reaches a source is the person unchecking a card', async () => {
  const n = note('uncheck-me', { status: 'done', done_local: true, done_at: '2026-09-17T09:00:00Z' });
  const { p } = plugin({
    _shadow: { 'clickup:uncheck-me': { due: null, priority: 5, description: '', done: true, doneAt: Date.now() } },
  }, [n]);
  await recordConnector(async (writes) => {
    assert.equal(await p.toggleDoneLocal(n.path), true);
    assert.equal(n.fm.reopen_pending, true, 'the uncheck is flagged explicitly, and only here');
    assert.equal(n.fm.done_local, false);
    await p.detectAndPush(n.path);
    assert.deepEqual(writes, [{ id: 'uncheck-me', closed: false }], 'the explicit uncheck reopens, once');
    assert.equal(n.fm.reopen_pending, undefined, 'the flag is cleared once the source took it');
  });
});

/* ---- c. the setting off -------------------------------------------------- */

test('(c) with Complete on source off there is NO source write at all', async () => {
  const closed = note('869f0abuc');
  const survives = note('869f2zpjg');
  const checked = note('check-me');
  const { p } = plugin({
    completeOnSource: false,
    _shadow: {
      'clickup:869f0abuc': { due: null, priority: 5, description: '', done: false },
      'clickup:869f2zpjg': { due: null, priority: 5, description: '', done: false },
      'clickup:check-me': { due: null, priority: 5, description: '', done: false },
    },
  }, [closed, survives, checked]);
  await recordConnector(async (writes) => {
    await p.upsertSource('clickup', { items: [openTask('869f2zpjg'), openTask('check-me')] });
    assert.equal(closed.fm.status, 'done', 'the note still follows the source');
    assert.deepEqual(writes, []);
    p.clearSyncWrite(closed.path);
    await p.detectAndPush(closed.path);
    assert.deepEqual(writes, []);

    assert.equal(await p.toggleDoneLocal(checked.path), true);
    await p.detectAndPush(checked.path);
    assert.deepEqual(writes, [], 'a check stays in the vault while the switch is off');

    // And unchecking a source-closed card is refused rather than silently local.
    assert.equal(await p.toggleDoneLocal(closed.path), false);
    assert.deepEqual(writes, []);
  });
});

/* ---- the shape of the code, so no adapter grows its own path ------------- */

test('THE PROPERTY: every source completes through the one crossing, and no diff can reopen', () => {
  const c = code();
  const b = bare();
  // The reopen-from-a-mismatch is gone, by name and by shape.
  assert.doesNotMatch(b, /doneDiffers/, 'the two-way mismatch test is what reopened published tasks');
  assert.match(b, /const wantClose = sh \? \(item\.doneLocal && item\.status !== 'done' && !sh\.done\) : false;/,
    'a mismatch may close, never reopen, and never against a task the source already closed');
  assert.match(b, /const wantReopen = item\.reopenPending === true && !item\.doneLocal;/);
  // Exactly one place speaks to a connector about completion, so the rule is
  // the same for Todoist, ClickUp, IMAP email and Outlook by construction.
  assert.equal((b.match(/\.setClosed\(/g) || []).length, 1, 'setClosed is called in applyDoneOnSource and nowhere else');
  assert.match(b, /await c\.setClosed\(this\.withSecrets\(\), item, closed\);/);
  // Three callers of that crossing, and every one of them is accounted for:
  // the sync close retry, the push check, and the pending-uncheck retry.
  const calls = b.match(/applyDoneOnSource\(([^)]*)\)/g) || [];
  assert.deepEqual(calls.sort(), [
    'applyDoneOnSource(it, false)',            // the pending uncheck, gated on reopen_pending
    'applyDoneOnSource(item, closed)',         // the method's own signature
    'applyDoneOnSource(item, item.doneLocal)', // the push check: close, or the flagged reopen
    'applyDoneOnSource(prior, true)',          // the sync retry of a close, never a reopen
  ]);
  assert.match(b, /if \(it\.source !== source \|\| openIds\.has\(it\.id\) \|\| it\.reopenPending !== true\) continue;/,
    'the absent-item reopen retry stays gated on the explicit flag');
  // A sync plan cannot carry a reopen at all.
  assert.match(b, /pushClose: !!completeOnSource && wantDone && !sourceDone,/);
  // The reconcile write makes the two completion flags agree.
  assert.match(b, /fm\.status = 'done';\s*fm\.done_local = true;\s*fm\.done_at/);
  // And it announces itself, so the changed event is not read back as an edit.
  assert.match(b, /if \(this\.isSyncWrite\(path\)\) return;/);
  assert.match(b, /&& !this\.isSyncWrite\(file\.path\)\) \{\s*this\.schedulePushCheck\(file\.path\);/);
  // The setting says what it does and what it never does.
  assert.match(c, /it never changes a status at the source to make it match this vault\. The source always wins\./);
});

test('THE SIGNAL: the file mtime, not a clock window', () => {
  const now = 1_000_000;
  assert.equal(T.syncWriteIsOwn(now, now), true, 'the file is byte for byte as the sync left it');
  assert.equal(T.syncWriteIsOwn(now, now + 1), false, 'someone has written since: not ours');
  assert.equal(T.syncWriteIsOwn(now, now - 1), false, 'a clock that went backwards proves nothing');
  assert.equal(T.syncWriteIsOwn(undefined, now), false, 'an unstamped path is never suppressed');
  assert.equal(T.syncWriteIsOwn(now, NaN), false, 'a file with no stat is never suppressed');
  assert.equal(T.SYNC_WRITE_WINDOW_MS, undefined, 'the window is gone, not merely unused');
  assert.equal(T.syncWriteSuppressed, undefined);
});

test('the stamp is the mtime of the file the sync just wrote, and a hand edit spends it', async () => {
  const n = note('a1');
  const { p, v } = plugin({}, [n]);
  await v.app.fileManager.processFrontMatter(n, (fm) => { fm.status = 'done'; });
  p.markSyncWrite(n);
  assert.equal(p.isSyncWrite(n.path), true, 'the push check declines the event this write causes');
  assert.equal(p.isSyncWrite(n.path), true, 'and again: no window to lapse, however late the event arrives');
  // Anyone else writing the note moves the mtime, and the stamp is spent.
  await v.app.fileManager.processFrontMatter(n, (fm) => { fm.done_local = false; });
  assert.equal(p.isSyncWrite(n.path), false, 'a hand edit is read as what it is, at once');
  assert.equal(p._syncWrites.has(n.path), false, 'a spent stamp is dropped rather than left to rot');
  // A stamp a card action clears is gone whatever the mtime says.
  p.markSyncWrite(n);
  p.clearSyncWrite(n.path);
  assert.equal(p.isSyncWrite(n.path), false);
  // An unknown path was never stamped.
  assert.equal(p.isSyncWrite(`${FOLDER}/nothing.md`), false);
});
