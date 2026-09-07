/* Habits managed in the HABITS tab (0.10.0).
 *
 * The pure half: the template writes every contract field; a cadence
 * switch keeps the field the new cadence reads and removes the one it does
 * not; the dialog's checks speak in sentences. The plugin half, exercised
 * without Obsidian through a recording app: every write starts at the
 * boundary, delete goes to the trash, rename goes through Obsidian's own
 * rename so links follow, and the tab's DOM is wired the way the ruling
 * says (a visible menu button, right-click and long-press to the same
 * menu, a two-press delete in place, no browser dialog).
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
const PluginClass = require(T.__mainPath);
const { TFile } = T.__obsidian;

const NOW = '2026-09-06T10:00:00.000Z';

function instance(settings, app) {
  const p = Object.create(PluginClass.prototype);
  p.settings = settings;
  p.app = app;
  p.habits = [];
  p._habitCache = new Map();
  p.emitModelChanged = () => { };
  return p;
}

// A vault of files: path -> { text, fm }. processFrontMatter edits fm in
// place; vault.process edits text; renameFile and trashFile record.
function fakeApp(files) {
  const calls = { process: [], frontmatter: [], create: [], rename: [], trash: [], folders: [] };
  const fileOf = (p) => { const f = new TFile(); f.path = p; f.basename = p.split('/').pop().replace(/\.md$/, ''); f.extension = 'md'; f.stat = { mtime: 1 }; return f; };
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (files[p] ? fileOf(p) : null),
      read: async (f) => files[f.path].text,
      cachedRead: async (f) => files[f.path].text,
      process: async (f, fn) => { calls.process.push(f.path); files[f.path].text = fn(files[f.path].text); },
      create: async (p, content) => { calls.create.push({ path: p, content }); files[p] = { text: content, fm: {} }; return fileOf(p); },
      createFolder: async (p) => { calls.folders.push(p); },
    },
    fileManager: {
      processFrontMatter: async (f, fn) => { calls.frontmatter.push(f.path); fn(files[f.path].fm); },
      renameFile: async (f, to) => { calls.rename.push([f.path, to]); files[to] = files[f.path]; delete files[f.path]; },
      trashFile: async (f) => { calls.trash.push(f.path); delete files[f.path]; },
    },
    metadataCache: { getFileCache: (f) => ({ frontmatter: files[f.path] && files[f.path].fm }) },
  };
  return { app, calls, files };
}

test('THE ASK: the template writes every contract field, and only the field the cadence reads', () => {
  const daily = T.habitTemplate({ name: 'Morning pages', cadence: 'daily', startedOn: '2026-08-27', linkedNote: '[[Morning pages]]' }, { nowIso: NOW });
  assert.equal(daily, [
    '---',
    'type: planner-habit',
    'name: "Morning pages"',
    'cadence: daily',
    'status: active',
    'started_on: 2026-08-27',
    'linked_note: "[[Morning pages]]"',
    `created_at: ${NOW}`,
    '---',
    '',
    '# Morning pages',
    '',
    '## Log',
    '<!-- habit-log: schema=streak -->',
    '| Date | Y/N | Note |',
    '| --- | --- | --- |',
    '',
  ].join('\n'));
  // the frontmatter as an object, in the written order
  assert.deepEqual(Object.keys(T.habitFrontmatterOf({ name: 'x', cadence: 'weekly', cadenceDays: ['mon'], linkedNote: 'x' }, { nowIso: NOW })),
    ['type', 'name', 'cadence', 'status', 'cadence_days', 'started_on', 'linked_note', 'created_at']);
  assert.deepEqual(Object.keys(T.habitFrontmatterOf({ name: 'x', cadence: 'monthly', monthDay: 9 }, { nowIso: NOW })),
    ['type', 'name', 'cadence', 'status', 'month_day', 'started_on', 'created_at']);
  // weekly carries the days; monthly the day; daily and weekdays neither
  assert.match(T.habitTemplate({ name: 'Walk', cadence: 'weekly', cadenceDays: ['fri', 'mon'] }, { nowIso: NOW }), /^cadence_days: \[mon, fri\]$/m);
  assert.match(T.habitTemplate({ name: 'Walk', cadence: 'monthly', monthDay: '15' }, { nowIso: NOW }), /^month_day: 15$/m);
  for (const c of ['daily', 'weekdays']) {
    const t = T.habitTemplate({ name: 'Walk', cadence: c, cadenceDays: ['mon'], monthDay: 3 }, { nowIso: NOW });
    assert.doesNotMatch(t, /cadence_days|month_day/, c);
  }
  // no start date: today, the LOCAL calendar date, pinned by opts.today;
  // no link: no field
  const bare = T.habitTemplate({ name: 'Walk', cadence: 'daily' }, { nowIso: NOW, today: '2026-09-06' });
  assert.match(bare, /^started_on: 2026-09-06$/m);
  assert.doesNotMatch(bare, /linked_note/);
  // THE ASK (2026-09-07): a member importing at 19:20 Pacific got
  // started_on one day in the future, the UTC day of the instant. The
  // start date is a calendar date and takes the local day; created_at
  // stays the UTC instant.
  const late = T.habitFrontmatterOf({ name: 'Walk', cadence: 'daily' }, { nowIso: '2026-09-07T02:20:24Z', today: '2026-09-06' });
  assert.equal(late.started_on, '2026-09-06', 'the local day, not the UTC one');
  assert.equal(late.created_at, '2026-09-07T02:20:24Z', 'the instant is untouched');
  assert.equal(T.habitFrontmatterOf({ name: 'Walk', cadence: 'daily', startedOn: '2026-08-01' }, { nowIso: '2026-09-07T02:20:24Z', today: '2026-09-06' }).started_on, '2026-08-01', 'a given start date wins');
  const unpinned = T.habitFrontmatterOf({ name: 'Walk', cadence: 'daily' }, { nowIso: '2026-09-07T02:20:24Z' });
  assert.equal(unpinned.started_on, T.todayStr(), 'no today given: the local clock, never the instant');
  assert.equal(T.habitFrontmatterOf({ name: 'Walk', cadence: 'daily' }, { nowIso: NOW, today: 'yesterday' }).started_on, T.todayStr(), 'a today that is not a date is ignored');
  // the link is written as a wikilink whatever came in
  assert.match(T.habitTemplate({ name: 'Walk', cadence: 'daily', linkedNote: 'Long walk' }, { nowIso: NOW }), /^linked_note: "\[\[Long walk\]\]"$/m);
  // a status carried in (the import) is written; the dialog never sends one
  assert.match(T.habitTemplate({ name: 'Walk', cadence: 'daily', status: 'paused' }, { nowIso: NOW }), /^status: paused$/m);
  // and what the template writes, the reader reads back as the same habit
  const fm = T.habitFrontmatterOf({ name: 'Morning pages', cadence: 'weekly', cadenceDays: ['mon', 'fri'], startedOn: '2026-08-27', linkedNote: '[[Morning pages]]' }, { nowIso: NOW });
  const h = T.habitFromFrontmatter(fm, '02 Planner/Habits/Morning pages.md', daily);
  assert.equal(h.cadence, 'weekly');
  assert.deepEqual(h.cadenceDays, ['mon', 'fri']);
  assert.equal(h.startedOn, '2026-08-27');
  assert.equal(h.linkedBasename, 'Morning pages');
  assert.equal(h.logSchema, 'streak');
  assert.deepEqual(T.HABIT_SCHEDULE_FIELDS, ['cadence', 'cadence_days', 'month_day']);
});

test('THE ASK: a cadence switch clears the fields that no longer apply and seeds the one that does', () => {
  const sw = (fm, c) => T.applyHabitCadence({ ...fm }, c);
  const base = { type: 'planner-habit', name: 'Walk', status: 'active', started_on: '2026-08-27' };
  // weekly -> daily: the days go
  assert.deepEqual(sw({ ...base, cadence: 'weekly', cadence_days: ['mon'] }, 'daily'), { ...base, cadence: 'daily' });
  // weekly -> weekdays: the days go
  assert.deepEqual(sw({ ...base, cadence: 'weekly', cadence_days: ['mon'] }, 'weekdays'), { ...base, cadence: 'weekdays' });
  // weekly -> monthly: the days go, the day is seeded as the 1st
  assert.deepEqual(sw({ ...base, cadence: 'weekly', cadence_days: ['mon'] }, 'monthly'), { ...base, cadence: 'monthly', month_day: 1 });
  // monthly -> weekly: the day goes, the days are seeded empty
  assert.deepEqual(sw({ ...base, cadence: 'monthly', month_day: 9 }, 'weekly'), { ...base, cadence: 'weekly', cadence_days: [] });
  // monthly -> daily: the day goes
  assert.deepEqual(sw({ ...base, cadence: 'monthly', month_day: 9 }, 'daily'), { ...base, cadence: 'daily' });
  // daily -> weekly: the days are seeded empty; a stale list is kept as days
  assert.deepEqual(sw({ ...base, cadence: 'daily' }, 'weekly'), { ...base, cadence: 'weekly', cadence_days: [] });
  assert.deepEqual(sw({ ...base, cadence: 'daily', cadence_days: 'sat, sun' }, 'weekly'), { ...base, cadence: 'weekly', cadence_days: ['sat', 'sun'] });
  // monthly keeps a valid day, clamps a large one
  assert.deepEqual(sw({ ...base, cadence: 'monthly', month_day: 31 }, 'monthly'), { ...base, cadence: 'monthly', month_day: 28 });
  // the alias and the unknown
  assert.equal(sw({ ...base, cadence: 'daily' }, 'weekday').cadence, 'weekdays');
  assert.equal(sw({ ...base, cadence: 'daily' }, 'never').cadence, 'weekly');
  // nothing else is touched, ever
  const extra = { ...base, cadence: 'weekly', cadence_days: ['mon'], linked_note: '[[Walk]]', tags: ['x'], created_at: NOW };
  const out = sw(extra, 'monthly');
  assert.deepEqual(out, { ...base, cadence: 'monthly', month_day: 1, linked_note: '[[Walk]]', tags: ['x'], created_at: NOW });
});

test('the dialog\'s checks speak in sentences; the import runs them lenient', () => {
  const v = (i, o) => T.validateHabitInput(i, o);
  assert.deepEqual(v({ name: '', cadence: 'daily' }), { ok: false, error: 'Give the habit a name.' });
  assert.deepEqual(v({ name: 'x', cadence: 'adhoc' }), { ok: false, error: 'Pick a cadence: daily, weekdays, weekly or monthly.' });
  assert.deepEqual(v({ name: 'x', cadence: 'weekly', cadenceDays: [] }), { ok: false, error: 'Pick at least one weekday.' });
  assert.deepEqual(v({ name: 'x', cadence: 'weekly', cadenceDays: [] }, { lenient: true }), { ok: true, error: null }, 'an imported adhoc habit');
  assert.deepEqual(v({ name: 'x', cadence: 'monthly', monthDay: '' }), { ok: false, error: 'The day of the month is 1 to 28.' });
  assert.deepEqual(v({ name: 'x', cadence: 'monthly', monthDay: 29 }), { ok: false, error: 'The day of the month is 1 to 28.' });
  assert.deepEqual(v({ name: 'x', cadence: 'monthly', monthDay: 28 }), { ok: true, error: null });
  assert.deepEqual(v({ name: 'x', cadence: 'daily', startedOn: 'soon' }), { ok: false, error: 'The start date is YYYY-MM-DD.' });
  assert.deepEqual(v({ name: 'x', cadence: 'daily', startedOn: '' }), { ok: true, error: null }, 'no date is today');
  assert.deepEqual(v({ name: 'x', cadence: 'weekdays' }), { ok: true, error: null });
  assert.deepEqual(v({ name: 'x', cadence: 'weekly', cadenceDays: ['sat'], startedOn: '2026-09-06' }), { ok: true, error: null });
});

test('THE ASK: every write refuses a path outside the planner Habits folder before any file is looked up', async () => {
  const { app, calls } = fakeApp({ '02 Planner/Habits/Walk.md': { text: '| Date | Y/N | Note |\n|---|---|---|\n', fm: { cadence: 'weekly', cadence_days: ['mon'] } } });
  let lookups = 0;
  const inner = app.vault.getAbstractFileByPath;
  app.vault.getAbstractFileByPath = (p) => { lookups += 1; return inner(p); };
  const p = instance({ plannerFolder: '02 Planner' }, app);
  const outside = ['04 Inner World/My Life/Habits/Walk.md', '02 Planner/Habits2/Walk.md', '02 Planner/Habits', '02 Planner/Todoist/Walk.md', '', null];
  for (const path of outside) {
    await assert.rejects(p.toggleHabit(path, '2026-09-04', true), /outside the planner Habits folder/, String(path));
    await assert.rejects(p.setHabitDays(path, ['mon']), /outside the planner Habits folder/, String(path));
    await assert.rejects(p.setHabitCadence(path, 'daily'), /outside the planner Habits folder/, String(path));
    await assert.rejects(p.setHabitMonthDay(path, 3), /outside the planner Habits folder/, String(path));
    await assert.rejects(p.setHabitStatus(path, 'paused'), /outside the planner Habits folder/, String(path));
    await assert.rejects(p.renameHabit(path, 'Run'), /outside the planner Habits folder/, String(path));
    await assert.rejects(p.deleteHabit(path), /outside the planner Habits folder/, String(path));
  }
  assert.equal(lookups, 0, 'a refused path is never looked up');
  assert.deepEqual(calls.process, []);
  assert.deepEqual(calls.frontmatter, []);
  assert.deepEqual(calls.trash, []);
  assert.deepEqual(calls.rename, []);
  // inside the folder each write goes through, and touches its field only
  const inside = '02 Planner/Habits/Walk.md';
  await p.toggleHabit(inside, '2026-09-04', true);
  assert.deepEqual(calls.process, [inside]);
  // a renamed planner folder moves the boundary with it
  const moved = instance({ plannerFolder: 'Week' }, app);
  await assert.rejects(moved.toggleHabit(inside, '2026-09-04', true), /outside the planner Habits folder/);
});

test('each write method starts at the boundary, and the boundary is checked before the lookup', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const first = (name) => {
    const i = main.indexOf(name);
    assert.ok(i >= 0, `${name} must exist`);
    const body = main.slice(main.indexOf('{', i) + 1);
    return body.split('\n').map((l) => l.trim()).filter(Boolean)[0];
  };
  for (const m of ['async toggleHabit(', 'async setHabitDays(', 'async setHabitCadence(', 'async setHabitMonthDay(', 'async setHabitStatus(', 'async renameHabit(', 'async deleteHabit(']) {
    assert.equal(first(m), 'const file = this.habitFile(path);', m);
  }
  assert.equal(first('habitFile(path) {'), "if (!habitPathInside(this.settings, path)) throw new Error('habit note outside the planner Habits folder');");
  // the import's one write outside the room is confined to the import folder
  const imp = main.slice(main.indexOf('async importHabits('), main.indexOf('/* ---- manual items'));
  assert.ok(/!importPathInside\(this\.settings, c\.path\)\) \{ result\.skipped\+\+; continue; \}/.test(imp), 'a candidate outside the import folder is skipped, not written');
});

test('THE ASK: the writes touch their own field only; the days need weekly, the day needs monthly', async () => {
  const files = {
    '02 Planner/Habits/Walk.md': { text: '', fm: { type: 'planner-habit', name: 'Walk', cadence: 'weekly', cadence_days: ['mon'], status: 'active', tags: ['x'] } },
    '02 Planner/Habits/Bills.md': { text: '', fm: { type: 'planner-habit', name: 'Bills', cadence: 'monthly', month_day: 1, status: 'active' } },
  };
  const { app } = fakeApp(files);
  const p = instance({ plannerFolder: '02 Planner' }, app);
  const walk = '02 Planner/Habits/Walk.md';
  const bills = '02 Planner/Habits/Bills.md';
  await p.setHabitDays(walk, ['fri', 'mon']);
  assert.deepEqual(files[walk].fm, { type: 'planner-habit', name: 'Walk', cadence: 'weekly', cadence_days: ['mon', 'fri'], status: 'active', tags: ['x'] });
  await assert.rejects(p.setHabitDays(bills, ['mon']), /only a weekly habit takes weekdays/);
  await p.setHabitMonthDay(bills, '31');
  assert.equal(files[bills].fm.month_day, 28, 'clamped');
  await assert.rejects(p.setHabitMonthDay(bills, 'x'), /1 to 28/);
  await assert.rejects(p.setHabitMonthDay(walk, 3), /only a monthly habit takes a day of the month/);
  await p.setHabitCadence(walk, 'monthly');
  assert.deepEqual(files[walk].fm, { type: 'planner-habit', name: 'Walk', cadence: 'monthly', month_day: 1, status: 'active', tags: ['x'] });
  await p.setHabitStatus(walk, 'paused');
  assert.equal(files[walk].fm.status, 'paused');
  await p.setHabitStatus(walk, 'archived');
  assert.equal(files[walk].fm.status, 'archived');
  await p.setHabitStatus(walk, 'active');
  assert.equal(files[walk].fm.status, 'active');
  await assert.rejects(p.setHabitStatus(walk, 'abandoned'), /unknown habit status/);
  assert.deepEqual(files[walk].fm.tags, ['x'], 'the other fields never move');
});

test('THE ASK: delete goes to the trash, rename goes through Obsidian\'s rename so links follow', async () => {
  const files = {
    '02 Planner/Habits/Walk.md': { text: '', fm: { type: 'planner-habit', name: 'Walk', cadence: 'daily', status: 'active' } },
    '02 Planner/Habits/Run.md': { text: '', fm: { type: 'planner-habit', name: 'Run', cadence: 'daily', status: 'active' } },
  };
  const { app, calls } = fakeApp(files);
  const p = instance({ plannerFolder: '02 Planner' }, app);
  // rename: the name field, then the file; a taken name gets -2
  assert.equal(await p.renameHabit('02 Planner/Habits/Walk.md', 'Long walk'), '02 Planner/Habits/Long walk.md');
  assert.deepEqual(calls.rename, [['02 Planner/Habits/Walk.md', '02 Planner/Habits/Long walk.md']]);
  assert.equal(files['02 Planner/Habits/Long walk.md'].fm.name, 'Long walk');
  assert.equal(await p.renameHabit('02 Planner/Habits/Long walk.md', 'Run'), '02 Planner/Habits/Run-2.md');
  // a name whose safe form is the file name renames nothing
  assert.equal(await p.renameHabit('02 Planner/Habits/Run.md', 'Run'), '02 Planner/Habits/Run.md');
  assert.equal(calls.rename.length, 2);
  await assert.rejects(p.renameHabit('02 Planner/Habits/Run.md', '  '), /Give the habit a name/);
  // delete: trashFile, never vault.delete
  await p.deleteHabit('02 Planner/Habits/Run.md');
  assert.deepEqual(calls.trash, ['02 Planner/Habits/Run.md']);
  assert.equal(files['02 Planner/Habits/Run.md'], undefined);
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const del = main.slice(main.indexOf('async deleteHabit('), main.indexOf('freeHabitPath(base) {'));
  assert.ok(/await this\.app\.fileManager\.trashFile\(file\);/.test(del));
  assert.ok(!/vault\.delete|adapter\.remove/.test(del), 'never a hard delete');
  const ren = main.slice(main.indexOf('async renameHabit('), main.indexOf('async deleteHabit('));
  assert.ok(/await this\.app\.fileManager\.renameFile\(file, next\);/.test(ren));
  assert.ok(!/vault\.rename\(/.test(ren), 'the link-aware rename, not the raw one');
});

test('create: the note lands under the folder with a safe name, is parsed at once, and a taken name gets -2', async () => {
  const files = { '02 Planner/Habits/Walk.md': { text: '', fm: { type: 'planner-habit', name: 'Walk', cadence: 'daily', status: 'active' } } };
  const { app, calls } = fakeApp(files);
  const p = instance({ plannerFolder: '02 Planner' }, app);
  const path = await p.createHabit({ name: 'Walk: the long/one?', cadence: 'weekly', cadenceDays: ['sat'], startedOn: '2026-09-01' });
  assert.equal(path, '02 Planner/Habits/Walk the long one.md');
  assert.equal(calls.create[0].path, path);
  assert.match(calls.create[0].content, /^name: "Walk: the long\/one\?"$/m, 'the name keeps its characters; the file does not');
  assert.equal(p.habits.length, 1, 'in the cache before the metadata cache has seen it');
  assert.equal(p.habits[0].name, 'Walk: the long/one?');
  assert.deepEqual(p.habits[0].cadenceDays, ['sat']);
  assert.equal(await p.createHabit({ name: 'Walk', cadence: 'daily' }), '02 Planner/Habits/Walk-2.md');
  await assert.rejects(p.createHabit({ name: '', cadence: 'daily' }), /Give the habit a name/);
  await assert.rejects(p.createHabit({ name: 'x', cadence: 'weekly', cadenceDays: [] }), /Pick at least one weekday/);
  assert.ok(calls.folders.includes('02 Planner/Habits'), 'the folder is made first');
});

test('SOURCE: the tab is management, wired for keyboard, touch and mouse, with no browser dialog', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const tray = main.slice(main.indexOf('class PlannerTrayView'), main.indexOf('class IcorPlannerSettingTab'));
  const tab = tray.slice(tray.indexOf('renderHabits(el) {'), tray.indexOf('/* ---- AGENDA'));
  // the head: New, and Import only while there is something to import
  assert.ok(/'aria-label': 'New habit'/.test(tab));
  assert.ok(/newBtn\.addEventListener\('click', \(\) => this\.plugin\.openNewHabit\(\)\);/.test(tab));
  assert.ok(/if \(candidates\.length\) \{[\s\S]*?importBtn\.addEventListener\('click', \(\) => this\.plugin\.openImportHabits\(candidates\)\);/.test(tab), 'the import button exists only with candidates');
  // the row: the name opens the note; a status chip; the menu button with a
  // popup role; right-click and long-press to the same menu
  assert.ok(/'aria-label': `Open \$\{h\.name\}`/.test(tab));
  assert.ok(/top\.createSpan\(\{ cls: 'iplan-chip', text: m\.statusLabel \}\);/.test(tab), 'the status chip');
  assert.ok(/'aria-label': `Menu for \$\{h\.name\}`, 'aria-haspopup': 'menu'/.test(tab), 'the visible menu button');
  assert.ok(/row\.addEventListener\('contextmenu', \(e\) => \{\s*\n\s*e\.preventDefault\(\);\s*\n\s*this\.habitMenu\(h, row\)/.test(tab), 'right-click');
  assert.ok(/wireLongPress\(row, \(pos\) => this\.habitMenu\(h, row\)\.showAtPosition\(pos\)\);/.test(tab), 'long-press');
  // the cadence dropdown writes the cadence; the toggles are inert unless weekly; monthly shows the day field
  assert.ok(/'aria-label': `Cadence for \$\{h\.name\}`/.test(tab));
  assert.ok(/this\.plugin\.setHabitCadence\(h\.path, select\.value\)/.test(tab));
  assert.ok(/\{ disabled: !m\.weekdaysEditable \}\);/.test(tab), 'the toggles take an edit for weekly only');
  assert.ok(/if \(m\.monthDay !== null\) \{[\s\S]*?type: 'number', min: '1', max: String\(HABIT_MONTH_DAY_MAX\)/.test(tab), 'the day field');
  assert.ok(/this\.plugin\.setHabitMonthDay\(h\.path, n\)/.test(tab));
  // the menu: rename, pause or resume, archive or restore, open, open linked, delete
  for (const item of ["setTitle('Rename')", "paused ? 'Resume' : 'Pause'", "setTitle('Archive')", "setTitle('Restore')", "setTitle('Open habit note')", "setTitle('Open linked note')", "setTitle('Delete')"]) {
    assert.ok(tab.includes(item), item);
  }
  assert.ok(/if \(h\.linkedBasename\) menu\.addItem/.test(tab), 'Open linked note only with a link');
  // delete is two presses in place, no window.confirm anywhere in the file
  assert.ok(/armHabitDelete\(h, row\) \{[\s\S]*?'aria-label': `Confirm: delete \$\{h\.name\}`[\s\S]*?await this\.plugin\.deleteHabit\(h\.path\);/.test(tab), 'the in-place confirm');
  assert.ok(!/window\.confirm|confirm\(/.test(main), 'no browser dialog');
  // archived: a collapsed section with a button head that says its state
  assert.ok(/cls: 'iplan-habits-archived-head',\s*\n\s*attr: \{ type: 'button', 'aria-expanded'/.test(tab));
  // the focus hand-back names the control, not only a weekday
  assert.ok(/const \{ path, selector \} = this\._habitFocus;/.test(tray));
  assert.ok(/selector: 'select\.iplan-habit-select'/.test(tab));
  // the modals: validation in a live region, the hidden rows by class
  const modals = main.slice(main.indexOf('class NewHabitModal'), main.indexOf('class PlannerBoardView'));
  assert.ok((modals.match(/'aria-live': 'polite'/g) || []).length >= 3, 'every modal has a live region');
  assert.ok(/classList\.toggle\('is-hidden', c !== 'weekly'\)/.test(modals));
  assert.ok(/classList\.toggle\('is-hidden', c !== 'monthly'\)/.test(modals));
  assert.ok(/t\.inputEl\.type = 'date';/.test(modals), 'the start date is a date field');
  assert.ok(/d\.addOption\('', 'None'\);/.test(modals), 'the link picker has a None');
  // the settings: the import folder validated and announced, the import button
  const settings = main.slice(main.indexOf('class IcorPlannerSettingTab'));
  assert.ok(/importFolderSetting\.descEl\.setAttribute\('aria-live', 'polite'\);/.test(settings));
  assert.ok(/if \(!n\.ok\) \{ renderImportFolder\(v\); return; \}/.test(settings), 'an invalid folder is refused, not saved');
  assert.ok(/setName\('Import from My Life'\)/.test(settings));
  assert.ok(/setName\('My Life Habits folder'\)/.test(settings));
  // the stylesheet: the new block rides tokens only, with 44px targets
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const start = css.indexOf('0.10.0 ===');
  assert.ok(start > 0, 'the 0.10.0 block must be findable');
  const block = css.slice(start);
  assert.equal((block.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length, 0, 'no colour literal');
  assert.match(block, /select\.iplan-habit-select:focus-visible,[\s\S]*?border-bottom-color: var\(--iplan-marker\);\s*\n\s*box-shadow: 0 1px 0 0 var\(--iplan-marker\);/, 'two channels on focus');
  assert.match(block, /\.iplan-habit-modal \.setting-item\.is-hidden \{ display: none; \}/);
  const coarse = block.slice(block.indexOf('@media (any-pointer: coarse)'));
  assert.match(coarse, /button\.iplan-habits-archived-head \{ min-height: 44px; \}/);
  assert.ok(!/\.iplan-habit-row[^{]*\{[^}]*opacity/.test(block), 'never an opacity dial');
});

test('SOURCE: created_at is the instant, started_on the local day; createHabit pins one today for the note and its cache', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const fn = main.slice(main.indexOf('function habitFrontmatterOf('), main.indexOf('function habitTemplate('));
  assert.ok(!/started_on = .*nowIso\.slice\(0, 10\)/.test(fn), 'the start date is never the UTC slice of the instant');
  assert.ok(/fm\.started_on = ISO_DAY_RE\.test\(started\) \? started : today;/.test(fn));
  assert.ok(/const today = ISO_DAY_RE\.test\(String\(o\.today == null \? '' : o\.today\)\) \? String\(o\.today\) : todayStr\(\);/.test(fn), 'opts.today, else the local clock');
  assert.ok(/fm\.created_at = nowIso;/.test(fn), 'the instant stays');
  const create = main.slice(main.indexOf('  async createHabit('), main.indexOf('  freeHabitPath(') > 0 && main.indexOf('  freeHabitPath(') > main.indexOf('  async createHabit(') ? main.indexOf('  freeHabitPath(') : main.indexOf('  async importHabits('));
  assert.ok(/const today = todayStr\(\);\s*\n\s*const text = habitTemplate\(input, \{ nowIso, today, logBlock: o\.logBlock \}\);/.test(create), 'the template takes the pinned day');
  assert.ok(/habitFrontmatterOf\(input, \{ nowIso, today \}\)/.test(create), 'and so does the cache entry');
  // the calendar-date fields across the writers: due comes from the source or
  // the note, planned_day from the board; no writer derives one from an instant
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/(started_on|planned_day|due)\s*[=:]\s*[^\n]*toISOString\(\)\.slice\(0, 10\)/.test(code), 'no calendar-date field is the UTC slice of an instant');
  assert.ok(!/(started_on|planned_day|due)\s*[=:]\s*[^\n]*nowIso\.slice\(0, 10\)/.test(code));
});
