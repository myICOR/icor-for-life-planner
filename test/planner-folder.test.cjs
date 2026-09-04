/* The planner folder is a setting, and every path derives from it.
 *
 * The reported case: the room was renamed, and the plugin kept looking for
 * the literal it was born with. collectItems found nothing, the file-tree
 * click hook stopped firing, and the next sync recreated an empty default
 * folder beside the renamed one, all silently.
 *
 * Gated here: the default paths are byte-for-byte what earlier releases
 * wrote (an older data.json without the key behaves exactly as before); a
 * renamed room is adopted only when it is the only candidate; the folder
 * boundary is a boundary, not a prefix; the validation refuses what must
 * be refused; the .gitignore guard reads the manifest, never a literal.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const code = () => fs.readFileSync(T.__mainPath, 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('the default paths are exactly what earlier releases wrote', () => {
  assert.equal(typeof T.plannerPaths, 'function', 'plannerPaths must be a pure function');
  assert.equal(T.DEFAULT_SETTINGS.plannerFolder, '02 Planner');
  for (const settings of [T.DEFAULT_SETTINGS, {}, undefined, { plannerFolder: '' }, { plannerFolder: '.obsidian/x' }]) {
    const p = T.plannerPaths(settings);
    assert.equal(p.root, '02 Planner', JSON.stringify(settings));
    assert.equal(p.cache, '02 Planner/Calendar Events.md');
    assert.equal(p.sourceFolder('todoist'), '02 Planner/Todoist');
    assert.equal(p.sourceFolder('clickup'), '02 Planner/ClickUp');
    assert.equal(p.sourceFolder('email'), '02 Planner/Email');
    assert.equal(p.sourceFolder('manual'), '02 Planner/Manual');
    assert.equal(p.sourceFolder('calendar'), null, 'the calendar has no per-item folder');
    assert.equal(p.sourceFolder('nonsense'), null);
  }
  const custom = T.plannerPaths({ plannerFolder: ' /Planner/ ' });
  assert.equal(custom.root, 'Planner');
  assert.equal(custom.cache, 'Planner/Calendar Events.md');
  assert.equal(custom.sourceFolder('todoist'), 'Planner/Todoist');
});

test('a renamed room is adopted when it is the only candidate; two candidates ask; the configured one wins', () => {
  assert.equal(typeof T.detectPlannerFolder, 'function');
  assert.deepEqual(T.detectPlannerFolder(['01 Inbox', 'Planner', '03 WiP'], '02 Planner'), { action: 'adopt', folder: 'Planner', candidates: ['Planner'] });
  assert.equal(T.detectPlannerFolder(['2 Planner'], '02 Planner').folder, '2 Planner');
  assert.equal(T.detectPlannerFolder(['MY PLANNER'], '02 Planner').action, 'adopt', 'case does not matter');
  const ask = T.detectPlannerFolder(['2 Planner', 'My Planner'], '02 Planner');
  assert.equal(ask.action, 'ask');
  assert.equal(ask.folder, '02 Planner', 'asking leaves the setting alone');
  assert.deepEqual(ask.candidates, ['2 Planner', 'My Planner']);
  assert.deepEqual(T.detectPlannerFolder(['02 Planner', 'Planner'], '02 Planner'), { action: 'keep', folder: '02 Planner', candidates: [] }, 'an existing configured folder is never second-guessed');
  assert.equal(T.detectPlannerFolder([], '02 Planner').action, 'keep', 'a fresh vault keeps the default (ensureFolders creates it)');
  assert.equal(T.detectPlannerFolder(['Planners', 'Planner notes', 'planner.md'], '02 Planner').action, 'keep', 'only a name ENDING in planner is a candidate');
  assert.equal(T.detectPlannerFolder(null, '02 Planner').action, 'keep', 'a missing list never throws');
});

test('isInside is a folder boundary, not a prefix', () => {
  const p = T.plannerPaths({ plannerFolder: '02 Planner' });
  assert.equal(p.isInside('02 Planner/Todoist/x.md'), true);
  assert.equal(p.isInside('02 Planner/Calendar Events.md'), true);
  assert.equal(p.isInside('02 Planner2/x.md'), false);
  assert.equal(p.isInside('02 Planner'), false, 'the folder itself is not inside itself');
  assert.equal(p.isInside('Other/02 Planner/x.md'), false);
  assert.equal(p.isInside(null), false);
  assert.equal(p.isInside(undefined), false);
});

test('normalizePlannerFolder strips slashes and refuses .obsidian, empty and dot segments', () => {
  assert.equal(typeof T.normalizePlannerFolder, 'function');
  assert.deepEqual(T.normalizePlannerFolder(' /02 Planner/ '), { ok: true, folder: '02 Planner', error: null });
  assert.equal(T.normalizePlannerFolder('Life//Planner').folder, 'Life/Planner');
  assert.equal(T.normalizePlannerFolder('Life\\Planner').folder, 'Life/Planner');
  for (const bad of ['', '   ', '/', null, undefined, '.obsidian', '.obsidian/plugins', '.OBSIDIAN/x', '../Planner', 'a/../b', './x']) {
    const n = T.normalizePlannerFolder(bad);
    assert.equal(n.ok, false, JSON.stringify(bad));
    assert.equal(n.folder, null);
    assert.ok(n.error, 'a refusal carries its reason');
  }
  assert.equal(T.normalizePlannerFolder('.obsidian-notes').ok, true, 'a name that merely starts with .obsidian is fine');
});

test('the change plan moves, switches, refuses or does nothing, and says why', () => {
  assert.equal(typeof T.plannerFolderChangePlan, 'function');
  const plan = (current, next, currentExists, nextExists) => T.plannerFolderChangePlan({ current, next, currentExists, nextExists });
  assert.equal(plan('02 Planner', '02 Planner', true, true).action, 'noop');
  assert.equal(plan('02 Planner', 'Planner', true, false).action, 'move');
  assert.match(plan('02 Planner', 'Planner', true, false).reason, /keeping links/);
  assert.equal(plan('02 Planner', 'Planner', true, true).action, 'refuse');
  assert.match(plan('02 Planner', 'Planner', true, true).reason, /Both .* exist/);
  assert.equal(plan('02 Planner', 'Planner', false, true).action, 'switch');
  assert.equal(plan('02 Planner', 'Planner', false, false).action, 'switch');
  assert.match(plan('02 Planner', 'Planner', false, false).reason, /Creates/);
});

test('the .gitignore line is derived from the manifest, never a literal', () => {
  assert.equal(typeof T.gitignoreLineFor, 'function');
  assert.equal(T.gitignoreLineFor({ id: 'x', dir: '.obsidian/plugins/x' }), '.obsidian/plugins/x/');
  assert.equal(T.gitignoreLineFor({ id: 'x', dir: '.obsidian/plugins/x/' }), '.obsidian/plugins/x/', 'a trailing slash is not doubled');
  assert.equal(T.gitignoreLineFor({ id: 'x' }), '.obsidian/plugins/x/', 'the id is the fallback');
  assert.equal(T.gitignoreLineFor({ id: 'x', dir: '.obsidian\\plugins\\x' }), '.obsidian/plugins/x/');
  assert.equal(T.gitignoreLineFor({}), null);
  assert.equal(T.gitignoreLineFor(null), null);
  const c = code();
  assert.match(c, /const line = gitignoreLineFor\(this\.manifest\);/, 'the guard reads the manifest');
  assert.doesNotMatch(c, /'\.obsidian\/plugins\/icor-for-life-planner/, 'the literal plugin path is gone from the code');
  assert.doesNotMatch(c, /DATA_JSON_GITIGNORE_LINE/, 'the dead constant is gone');
});

test('the cache note names the planner folder, and still reads without it', () => {
  const now = new Date('2026-09-04T10:00:00Z');
  const withFolder = T.buildCalendarCacheContent([], now, 'My Planner');
  assert.match(withFolder, /^planner_folder: "My Planner"$/m);
  const without = T.buildCalendarCacheContent([], now);
  assert.doesNotMatch(without, /planner_folder/);
  assert.deepEqual(T.parseCalendarCacheContent(withFolder), []);
  assert.doesNotMatch(withFolder, /https?:\/\//, 'still secret-free');
});

test('the literal default appears exactly once in code, and no constant path survives', () => {
  const c = code();
  assert.equal((c.match(/'02 Planner'/g) || []).length, 1, 'the default lives in DEFAULT_SETTINGS and nowhere else');
  assert.doesNotMatch(c, /PLANNER_FOLDER\b/, 'the module constant is gone');
  assert.doesNotMatch(c, /CALENDAR_CACHE_FILE/, 'the cache path derives from the setting');
  assert.doesNotMatch(c, /startsWith\(PLANNER_FOLDER/, 'no prefix test against the constant');
  assert.equal((c.match(/collectItems\(this\.app, this\.paths\(\)\.root\)/g) || []).length, 1, 'the sync collects from the setting');
  assert.equal((c.match(/collectItems\(this\.plugin\.app, this\.plugin\.paths\(\)\.root\)/g) || []).length, 2, 'the board and the tray collect from the setting');
  assert.match(c, /data-path="\$\{this\.paths\(\)\.root\}"/, 'the file-tree click hook reads the setting at click time');
  assert.match(c, /this\.paths\(\)\.isInside\(/, 'the live-render guards ask the boundary helper');
  assert.match(c, /this\.adoptPlannerFolder\(\);\n\s*this\.ensureGitignore\(\);/, 'adoption runs first on layout ready');
  assert.match(c, /await this\.app\.fileManager\.renameFile\(fp\.current, fp\.folder\)/, 'the move is a link-safe rename');
  assert.match(c, /folderSetting\.descEl\.setAttribute\('aria-live', 'polite'\)/, 'the validation text is announced');
  // The folder is the third argument; later releases may pass more after it.
  assert.match(c, /buildCalendarCacheContent\(this\.calendarDefs, new Date\(\), this\.paths\(\)\.root[,)]/, 'the cache names the folder');
});
