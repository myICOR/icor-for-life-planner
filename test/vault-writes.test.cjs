/* The vault writes assert their own boundaries.
 *
 * Two hygiene findings from the security gate, both defense in depth. A
 * synced note's file name is built from two strings the source chose, the
 * title and the id; the id now passes safeBasename too, so the note is
 * confined to its folder whatever an API returns. And the habit and routine
 * write methods check their folder at the write itself, not only in the
 * caller: a path outside the habits room or the Routines folder is refused
 * before a file is looked up, so no vault.process or processFrontMatter
 * ever runs on it.
 *
 * The plugin class is exercised without Obsidian: an instance is made from
 * the prototype with the settings and a recording app stub.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const PluginClass = require(T.__mainPath);
const { TFile } = T.__obsidian;

function instance(settings, app) {
  const p = Object.create(PluginClass.prototype);
  p.settings = settings;
  p.app = app;
  return p;
}

function recordingApp() {
  const calls = { process: [], frontmatter: [], create: [] };
  const app = {
    vault: {
      getAbstractFileByPath: () => new TFile(),
      process: async (file, fn) => { calls.process.push(file); return fn('| Date | Y/N | Note |\n|---|---|---|\n'); },
      create: async (path, content) => { calls.create.push({ path, content }); },
    },
    fileManager: {
      processFrontMatter: async (file, fn) => { calls.frontmatter.push(file); fn({}); },
    },
  };
  return { app, calls };
}

test('THE ASK: a synced note name passes the id through safeBasename, and a plain id names the same file as before', async () => {
  const { app, calls } = recordingApp();
  app.vault.getAbstractFileByPath = () => null;
  const p = instance({ _shadow: {} }, app);
  const folder = '02 Planner/Todoist';
  await p.createItemFile(folder, 'todoist', { id: '8123456789', title: 'Buy milk', priority: 4 });
  assert.equal(calls.create[0].path, '02 Planner/Todoist/Buy milk (todoist-8123456789).md', 'an ordinary id names the file exactly as it did');
  await p.createItemFile(folder, 'clickup', { id: '../../evil#[x]|y', title: 'Slash/title', priority: 4 });
  const path = calls.create[1].path;
  assert.ok(path.startsWith(`${folder}/`), path);
  assert.equal(path.slice(folder.length + 1).includes('/'), false, 'no separator survives from either string');
  assert.doesNotMatch(path, /[\\:*?"<>|#^[\]{}]/, 'no illegal or Obsidian-hot character survives');
  assert.equal(path, '02 Planner/Todoist/Slash title (clickup-.. .. evil x y).md');
  // the frontmatter still carries the id the source uses, unchanged
  assert.match(calls.create[1].content, /^external_id: "\.\.\/\.\.\/evil#\[x\]\|y"$/m);
  // and the source line is the exact shape, so the name has no second path
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  assert.ok(main.includes('let base = `${safeBasename(t.title)} (${source}-${noteIdPart(t.id)})`;'), 'the name is built through safeBasename and noteIdPart');
  // noteIdPart is safeBasename for every id a task app issues, and a tail
  // plus a hash for a Graph message id (150 characters, a shared prefix per
  // mailbox), so two long ids never collide on their first 70 characters.
  assert.equal(T.noteIdPart('../../evil#[x]|y'), T.safeBasename('../../evil#[x]|y'));
  assert.equal(T.noteIdPart('123456789'), '123456789');
  const prefix = 'AAMkAGI2TG93AAA='.repeat(8);
  const a = T.noteIdPart(prefix + 'AAAAA1=');
  const b = T.noteIdPart(prefix + 'AAAAA2=');
  assert.notEqual(a, b, 'two Graph ids differing at the tail get different names');
  assert.ok(a.length < 40, a);
  assert.doesNotMatch(a, /[\\/:*?"<>|#^[\]{}]/);
});

test('THE ASK: the habit writes refuse a path outside the habits folder before any file is looked up', async () => {
  const { app, calls } = recordingApp();
  let lookups = 0;
  const inner = app.vault.getAbstractFileByPath;
  app.vault.getAbstractFileByPath = (path) => { lookups += 1; return inner(path); };
  const p = instance({ habitsFolder: T.DEFAULT_SETTINGS.habitsFolder }, app);
  const outside = ['02 Planner/Habits/Walk.md', '04 Inner World/My Life/Habits2/Walk.md', '04 Inner World/My Life/Habits', '', null];
  for (const path of outside) {
    await assert.rejects(p.toggleHabit(path, '2026-09-04', true), /outside the configured folder/, String(path));
    await assert.rejects(p.setHabitDays(path, ['mon']), /outside the configured folder/, String(path));
  }
  assert.equal(lookups, 0, 'a refused path is never looked up');
  assert.deepEqual(calls.process, []);
  assert.deepEqual(calls.frontmatter, []);
  // inside the folder both writes go through, once each
  const inside = `${T.DEFAULT_SETTINGS.habitsFolder}/Walk.md`;
  await p.toggleHabit(inside, '2026-09-04', true);
  await p.setHabitDays(inside, ['mon', 'wed']);
  assert.equal(calls.process.length, 1);
  assert.equal(calls.frontmatter.length, 1);
  // a renamed habits folder moves the boundary with it
  const moved = instance({ habitsFolder: 'Habits' }, app);
  await assert.rejects(moved.toggleHabit(inside, '2026-09-04', true), /outside the configured folder/);
  await moved.toggleHabit('Habits/Walk.md', '2026-09-04', true);
  assert.equal(calls.process.length, 2);
});

test('THE ASK: the routine writes refuse a path outside the Routines folder before any file is looked up', async () => {
  const { app, calls } = recordingApp();
  let lookups = 0;
  const inner = app.vault.getAbstractFileByPath;
  app.vault.getAbstractFileByPath = (path) => { lookups += 1; return inner(path); };
  const p = instance({ plannerFolder: '02 Planner' }, app);
  const outside = ['02 Planner/Todoist/Task.md', '02 Planner/Routines', '02 Planner/Routines2/Morning.md', 'Other/Routines/Morning.md', '', null];
  for (const path of outside) {
    await assert.rejects(p.processRoutine(path, (d) => d), /outside the planner folder/, String(path));
    await assert.rejects(p.toggleRoutineStep(path, '2026-09-04', 1, true, 3), /outside the planner folder/, String(path));
    await assert.rejects(p.skipRoutine(path, '2026-09-04'), /outside the planner folder/, String(path));
    await assert.rejects(p.setRoutineActive(path, false), /outside the planner folder/, String(path));
  }
  assert.equal(lookups, 0, 'a refused path is never looked up');
  assert.deepEqual(calls.process, []);
  assert.deepEqual(calls.frontmatter, []);
  await p.skipRoutine('02 Planner/Routines/Morning launch.md', '2026-09-04');
  await p.setRoutineActive('02 Planner/Routines/Morning launch.md', false);
  assert.equal(calls.process.length, 1);
  assert.equal(calls.frontmatter.length, 1);
  // a renamed planner folder moves the boundary with it
  const moved = instance({ plannerFolder: 'Week' }, app);
  await assert.rejects(moved.skipRoutine('02 Planner/Routines/Morning launch.md', '2026-09-04'), /outside the planner folder/);
  await moved.skipRoutine('Week/Routines/Morning launch.md', '2026-09-04');
  assert.equal(calls.process.length, 2);
});

test('each of the four write methods checks its folder as its first statement', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const first = (name) => {
    const i = main.indexOf(name);
    assert.ok(i >= 0, `${name} must exist`);
    const body = main.slice(main.indexOf('{', i) + 1);
    return body.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  };
  assert.equal(first('async toggleHabit('), "if (!habitPathInside(this.settings, path)) throw new Error('habit note outside the configured folder');");
  assert.equal(first('async setHabitDays('), "if (!habitPathInside(this.settings, path)) throw new Error('habit note outside the configured folder');");
  assert.equal(first('async processRoutine('), "if (!this.paths().isRoutine(path)) throw new Error('routine note outside the planner folder');");
  assert.equal(first('async setRoutineActive('), "if (!this.paths().isRoutine(path)) throw new Error('routine note outside the planner folder');");
});
