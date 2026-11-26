/* A MEMBER'S WORDS ARE NEVER LOST (2026-11-21, plugin review).
 *
 * The note body is the task's description, and the source wins a conflict:
 * the note is a mirror. Before 0.17.1 that meant a member who wrote in a
 * task note lost those words, without a copy, the moment the description
 * changed at the source. The source still wins the note; the member's words
 * now go to a note beside it first ("your words, <day>", type planner-kept,
 * never read as a task), and if that copy cannot be written the note is not
 * touched at all and the item waits for the next sync.
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
  const created = [];
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === ROOT ? root : (byPath.get(p) || null)),
      cachedRead: async (f) => `${HEAD}${f.body || ''}`,
      process: async (f, fn) => { f.body = fn(`${HEAD}${f.body || ''}`).replace(/^---\n[\s\S]*?\n---\n?/, ''); f.stat.mtime += 1; },
      create: async (path, data) => {
        if (app._createFails) throw new Error('disk full');
        created.push({ path, data }); byPath.set(path, { path }); return { path };
      },
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
  return { p, trashed, byPath, created, app };
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


test('the merge says which of the member\'s words the source is replacing', () => {
  const base = { title: 't', due: null, priority: 5, description: 'agreed' };
  const m = T.threeWayMerge(
    { title: 't', due: null, priority: 5, description: 'changed at the source' },
    { title: 't', due: null, priority: 5, description: 'my own words' },
    base, true,
  );
  assert.equal(m.finals.description, 'changed at the source', 'the source still wins the note');
  assert.equal(m.kept.description, 'my own words', 'and the member\'s words are handed back');
  assert.deepEqual(m.pushes, {}, 'nothing is pushed in a conflict');
  const untouched = T.threeWayMerge(
    { title: 't', due: null, priority: 5, description: 'changed at the source' },
    { title: 't', due: null, priority: 5, description: 'agreed' },
    base, true,
  );
  assert.deepEqual(untouched.kept, {}, 'no edit here, nothing to keep');
  const same = T.threeWayMerge(
    { title: 't', due: null, priority: 5, description: 'both wrote this' },
    { title: 't', due: null, priority: 5, description: 'both wrote this' },
    base, true,
  );
  assert.deepEqual(same.kept, {}, 'the same words on both sides are not a conflict');
});

test('the kept note sits beside the task, is never a task, and never overwrites a file', () => {
  const taken = new Set(['Task x (your words, 2026-11-21).md']);
  assert.equal(T.keptNoteName('Task x', '2026-11-21', (n) => taken.has(n)), 'Task x (your words, 2026-11-21) 2.md');
  const text = T.keptNoteText('Task "x"', '2026-11-21T10:00:00.000Z', '  my words\n');
  assert.match(text, /^---\ntype: planner-kept\nkept_from: "\[\[Task 'x'\]\]"\nkept_at: 2026-11-21T10:00:00.000Z\n---\n\nmy words\n$/);
});

test('a sync that replaces the body keeps the member\'s words in a note beside it first', async () => {
  const n = note('mine');
  n.body = 'my own words';
  const { p, created } = plugin({
    _shadow: { 'clickup:mine': shadowOf('mine', { description: 'agreed' }) },
  }, [n]);
  await recording(async (writes, notices) => {
    await p.upsertSource('clickup', { items: [openTask('mine', { description: 'changed in ClickUp' })] });
    assert.equal(created.length, 1, 'one kept note');
    assert.match(created[0].path, /^02 Planner\/ClickUp\/Task \(clickup-mine\) \(your words, \d{4}-\d{2}-\d{2}\)\.md$/);
    assert.match(created[0].data, /\n\nmy own words\n$/);
    assert.equal((n.body || '').trim(), 'changed in ClickUp', 'the note follows the source');
    assert.deepEqual(writes, [], 'nothing is pushed');
  });
});

test('if the words cannot be kept, the note is not overwritten', async () => {
  const n = note('stuck');
  n.body = 'my own words';
  const { p, created, app } = plugin({
    _shadow: { 'clickup:stuck': shadowOf('stuck', { description: 'agreed' }) },
  }, [n]);
  app._createFails = true;
  await recording(async (writes, notices) => {
    await p.upsertSource('clickup', { items: [openTask('stuck', { description: 'changed in ClickUp' })] });
    assert.equal(created.length, 0);
    assert.equal((n.body || '').trim(), 'my own words', 'the member\'s words stay in the note');
    assert.equal(p.settings._shadow['clickup:stuck'].description, 'agreed', 'the baseline waits for the next sync');
  });
});
