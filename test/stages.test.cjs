/* ICOR for Life 3.0's Workbench layout moves the folders: the planner from
 * 02 Planner (2.x) and 06 Planner (early 3.0) to 07 Planner, and the My
 * Life Habits folder the import reads from 04 Inner World/My Life (2.x) and
 * 02 Inner World/My Life (early 3.0) to 02 My Life.
 *
 * Gated here: the defaults are the current names; a setting that still
 * holds an old default (data.json carries every default once anything is saved)
 * keeps its folder while the vault still has it, follows the vault once
 * it has moved, and is saved only then; a folder the member chose never
 * moves; 06 AI Team (a 2.x folder with the same number) is never taken
 * for the planner; and nothing a member reads calls a folder a room.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./harness.cjs');

const PluginClass = require(T.__mainPath);
const { TFolder } = T.__obsidian;

const V3 = ['00 Daily Notes', '01 Inbox', '02 My Life', '03 Journal', '04 Notes', '05 Contacts', '06 Sources', '07 Planner',
  '08 Workbench', '09 AI', '10 Files', '11 Databases'];
const EARLY = ['00 Daily Notes', '01 Inbox', '02 Inner World', '03 Outer World', '04 Assets', '05 Databases', '06 Planner'];
const V2 = ['00 Daily Scratchpad', '01 Inbox', '02 Planner', '04 Inner World', '05 Assets', '06 AI Team', '06 Outer World', '07 Databases'];

// A plugin over a vault of folders (top-level names and any nested paths).
function boot(settings, folders) {
  const have = new Set(folders);
  const folderOf = (p) => { const f = new TFolder(); f.path = p; f.name = p.split('/').pop(); return f; };
  const p = Object.create(PluginClass.prototype);
  p.settings = Object.assign({}, T.DEFAULT_SETTINGS, settings);
  p.saves = 0;
  p.persistSettings = async () => { p.saves++; };
  p.app = {
    vault: {
      getRoot: () => ({ children: folders.filter((f) => !f.includes('/')).map(folderOf) }),
      getAbstractFileByPath: (q) => (have.has(q) ? folderOf(q) : null),
    },
  };
  return p;
}

test('the defaults are the Workbench layout folders', () => {
  assert.equal(T.DEFAULT_SETTINGS.plannerFolder, '07 Planner');
  assert.equal(T.DEFAULT_SETTINGS.habitsImportFolder, '02 My Life/Habits');
  const p = T.plannerPaths({});
  assert.equal(p.root, '07 Planner');
  assert.equal(p.cache, '07 Planner/Calendar Events.md');
  assert.equal(p.sourceFolder('todoist'), '07 Planner/Todoist');
  assert.equal(p.habits, '07 Planner/Habits');
  assert.equal(p.weekNote('2026-W48'), '07 Planner/Weeks/2026-W48.md');
});

test('the planner folder: a current vault is used as it is, an older vault keeps its folder, 06 AI Team is never the planner', async () => {
  // A new install in a current vault: nothing to adopt, nothing saved.
  let p = boot({}, V3);
  await p.adoptPlannerFolder();
  assert.equal(p.settings.plannerFolder, '07 Planner');
  assert.equal(p.saves, 0);
  for (const [old, vault] of [['02 Planner', V2], ['06 Planner', EARLY]]) {
    // An old default saved, the vault moved: the setting follows and is saved.
    p = boot({ plannerFolder: old }, V3);
    await p.adoptPlannerFolder();
    assert.equal(p.settings.plannerFolder, '07 Planner', old);
    assert.equal(p.saves, 1);
    // An old default saved, the vault not moved yet: kept.
    p = boot({ plannerFolder: old }, vault);
    await p.adoptPlannerFolder();
    assert.equal(p.settings.plannerFolder, old);
    assert.equal(p.saves, 0);
    // Both folders (a vault part way through the move): the saved one is kept.
    p = boot({ plannerFolder: old }, vault.concat('07 Planner'));
    await p.adoptPlannerFolder();
    assert.equal(p.settings.plannerFolder, old);
    // An old default saved, neither folder yet: the current default, not saved.
    assert.deepEqual(T.detectPlannerFolder(['01 Inbox', '06 AI Team'], old), { action: 'default', folder: '07 Planner', candidates: [] });
    p = boot({ plannerFolder: old }, ['01 Inbox', '06 AI Team']);
    await p.adoptPlannerFolder();
    assert.equal(p.settings.plannerFolder, '07 Planner');
    assert.equal(p.saves, 0);
  }
  // A folder the member chose and the vault lacks: kept (ensureFolders makes it).
  assert.equal(T.detectPlannerFolder(V3, 'Week').action, 'adopt', 'a single planner folder is still adopted for a missing chosen one');
  assert.deepEqual(T.detectPlannerFolder(['01 Inbox'], 'Week'), { action: 'keep', folder: 'Week', candidates: [] });
  assert.ok(!T.detectPlannerFolder(['06 AI Team'], '07 Planner').candidates.includes('06 AI Team'), 'matched by full name, never by number');
  assert.ok(!T.detectPlannerFolder(['06 Sources'], '07 Planner').candidates.includes('06 Sources'), 'matched by full name, never by number');
});

test('the My Life Habits folder: an old default stays in a vault that has its folder and follows a moved one', async () => {
  const NEW = '02 My Life/Habits';
  const exists = (list) => (q) => list.includes(q);
  for (const [OLD, vault] of [['04 Inner World/My Life/Habits', V2], ['02 Inner World/My Life/Habits', EARLY]]) {
    assert.deepEqual(T.followHabitsImportFolder(OLD, exists(vault)), { folder: OLD, save: false });
    assert.deepEqual(T.followHabitsImportFolder(OLD, exists(V3)), { folder: NEW, save: true });
    assert.deepEqual(T.followHabitsImportFolder(OLD, exists([])), { folder: NEW, save: false }, 'neither yet: the new default, not saved');
    let p = boot({ habitsImportFolder: OLD }, V3);
    await p.adoptHabitsImportFolder();
    assert.equal(p.settings.habitsImportFolder, NEW);
    assert.equal(p.saves, 1);
    p = boot({ habitsImportFolder: OLD }, vault);
    await p.adoptHabitsImportFolder();
    assert.equal(p.settings.habitsImportFolder, OLD);
    assert.equal(p.saves, 0);
  }
  for (const chosen of ['Habits', '04 Inner World/Habits', '02 Inner World/Habits', NEW]) assert.deepEqual(T.followHabitsImportFolder(chosen, exists(V3)), { folder: chosen, save: false });
});

test('the code names an older folder only to recognise an old default or read a 2.x file', () => {
  const code = fs.readFileSync(T.__mainPath, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const old = /\b(00 Daily Scratchpad|02 Planner|06 Planner|04 Inner World|02 Inner World|06 Outer World|03 Outer World|05 Assets|04 Assets|07 Databases|05 Databases|06 AI Team|03 WiP)\b/;
  const hits = code.filter((l) => old.test(l));
  assert.deepEqual(hits.map((l) => l.trim().split(' = ')[0]), [
    'const LEGACY_ENV_FILE_PATH',
    'const PLANNER_FOLDERS_OLD',
    'const HABITS_IMPORT_FOLDERS_OLD',
  ]);
});

test('nothing a member reads calls a folder a room', () => {
  const root = path.dirname(T.__mainPath);
  // Every string in main.js outside comments: notices, settings, labels.
  const code = fs.readFileSync(T.__mainPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const strings = code.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) || [];
  assert.deepEqual(strings.filter((s) => /\brooms?\b/i.test(s)), []);
  for (const f of ['README.md', 'SECURITY.md', 'manifest.json']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /\brooms?\b/i, f);
  }
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /07 Planner\/Weeks\//);
  assert.deepEqual(readme.match(/.{0,12}02 Planner/g), ['2.x folder `02 Planner'], 'named once, as the 2.x folder a vault may still have');
});
