/* The import from My Life (0.10.0).
 *
 * A My Life habit note is imported once: a planner note is created with
 * the schedule mapped, the sentinel block (the log table) moves over byte
 * for byte, one pointer line takes its place, and the schedule fields
 * leave the My Life frontmatter. The plan lists only notes no planner note
 * links to yet, so a second run is a no-op. The pure half is gated on the
 * bytes; the plugin half runs through a recording app.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const PluginClass = require(T.__mainPath);
const { TFile, TFolder } = T.__obsidian;

const MY = '04 Inner World/My Life/Habits';
const LOG_BLOCK = [
  '<!-- habit-log: schema=streak -->',
  '| Date | Y/N | Note |',
  '|---|---|---|',
  '| 2026-09-05 | Y |  |',
  '| 2026-09-04 | N | sick |',
  '| 2026-09-03 | ✓ | by hand |',
].join('\n');
const MY_NOTE = [
  '---',
  'name: Morning pages',
  'cadence: weekly',
  'cadence_days: [mon, wed, fri]',
  'status: active',
  'started_on: 2026-08-27',
  'key_element: "[[Writing]]"',
  '---',
  '',
  '# Morning pages',
  '',
  'Three pages, longhand, before anything else. See [[Writing]].',
  '',
  '## Daily log',
  LOG_BLOCK,
  '',
  '## Notes',
  '',
  'Why this matters.',
  '',
].join('\n');

test('THE ASK: the plan lists only the habit notes no planner note links to yet', () => {
  const notes = [
    { path: `${MY}/Morning pages.md`, basename: 'Morning pages', fm: { name: 'Morning pages', cadence: 'weekly', cadence_days: ['mon', 'wed', 'fri'], started_on: '2026-08-27' } },
    { path: `${MY}/Walk.md`, basename: 'Walk', fm: { type: 'habit', cadence: 'daily', since: '2026-08-01' } },
    { path: `${MY}/Bills.md`, basename: 'Bills', fm: { cadence: 'monthly', month_day: 3, status: 'paused' } },
    { path: `${MY}/Old.md`, basename: 'Old', fm: { cadence: 'adhoc', cadence_days: ['sat'], status: 'abandoned' } },
    { path: `${MY}/Weekday.md`, basename: 'Weekday', fm: { cadence: 'weekday' } },
    { path: `${MY}/Odd.md`, basename: 'Odd', fm: { cadence: 'fortnightly', cadence_days: ['sun'] } },
    { path: `${MY}/INDEX.md`, basename: 'INDEX', fm: { cadence: 'daily' } },
    { path: `${MY}/_template.md`, basename: '_template', fm: { type: 'habit' } },
    { path: `${MY}/Essay.md`, basename: 'Essay', fm: { tags: ['x'] } },
    { path: `${MY}/Stray.md`, basename: 'Stray', fm: { type: 'planner-habit', cadence: 'daily' } },
    { path: `${MY}/Nothing.md`, basename: 'Nothing', fm: null },
    { path: `${MY}/Done.md`, basename: 'Done', fm: { type: 'habit', planner_habit: '[[Done]]' } },
  ];
  const planner = [T.habitFromFrontmatter({ type: 'planner-habit', name: 'Walk', cadence: 'daily', linked_note: '[[Walk]]' }, '02 Planner/Habits/Walk.md', '')];
  const plan = T.importPlan(notes, planner);
  assert.deepEqual(plan.map((c) => c.basename), ['Bills', 'Morning pages', 'Odd', 'Old', 'Walk', 'Weekday'], 'Done carries the back-link; the furniture, the essay and a stray planner note are not habits; Walk is listed although a planner note links to it, because its own frontmatter does not say so yet');
  const by = Object.fromEntries(plan.map((c) => [c.basename, c]));
  assert.deepEqual(by['Morning pages'], {
    path: `${MY}/Morning pages.md`, basename: 'Morning pages', name: 'Morning pages',
    cadence: 'weekly', cadenceDays: ['mon', 'wed', 'fri'], monthDay: null, startedOn: '2026-08-27', status: 'active', linkedNote: '[[Morning pages]]',
    existingPlanner: null,
  });
  assert.equal(by.Walk.existingPlanner, '02 Planner/Habits/Walk.md', 'the half-done note resumes into the planner note that links back');
  assert.equal(T.importDone({ planner_habit: '[[x]]' }), true);
  assert.equal(T.importDone({ planner_habit: '' }), false);
  assert.equal(T.importDone({ type: 'habit' }), false);
  assert.equal(T.importDone(null), false);
  assert.deepEqual([by.Bills.cadence, by.Bills.monthDay, by.Bills.status, by.Bills.startedOn], ['monthly', 3, 'paused', null]);
  assert.deepEqual([by.Old.cadence, by.Old.cadenceDays, by.Old.status], ['weekly', [], 'archived'], 'adhoc is weekly with no days; abandoned is archived');
  assert.deepEqual([by.Weekday.cadence, by.Weekday.cadenceDays], ['weekdays', []]);
  assert.deepEqual([by.Odd.cadence, by.Odd.cadenceDays], ['weekly', []], 'unknown is weekly with no days');
  // the scaffold example maps by since; the name falls back to the file name
  const walk = T.importMapping({ type: 'habit', cadence: 'daily', since: '2026-08-01' }, 'Walk');
  assert.deepEqual([walk.name, walk.cadence, walk.startedOn, walk.linkedNote], ['Walk', 'daily', '2026-08-01', '[[Walk]]']);
  // with nothing linked everything lists; with nothing to list, nothing
  assert.equal(T.importPlan(notes, []).length, 6);
  assert.equal(T.importPlan(notes, []).find((c) => c.basename === 'Walk').existingPlanner, null);
  assert.deepEqual(T.importPlan([], planner), []);
  assert.deepEqual(T.importPlan(null, null), []);
});

test('THE ASK: the log block moves byte-exact, the pointer line takes its place, the rest of the note stays', () => {
  const block = T.habitLogBlockOf(MY_NOTE);
  assert.equal(block, LOG_BLOCK, 'the sentinel line through the last row, nothing more');
  const after = T.moveHabitLog(MY_NOTE, 'Morning pages');
  assert.equal(after, MY_NOTE.replace(LOG_BLOCK, 'Schedule and check-ins: [[Morning pages]]'), 'one line in place of the block; every other byte stays');
  assert.equal(T.habitPointerLine('Morning pages'), 'Schedule and check-ins: [[Morning pages]]');
  assert.equal(T.habitLogBlockOf(after), null, 'the block is gone from the source');
  // the planner note carries the block verbatim in its own log section
  const planner = T.habitTemplate({ name: 'Morning pages', cadence: 'weekly', cadenceDays: ['mon', 'wed', 'fri'], startedOn: '2026-08-27', linkedNote: '[[Morning pages]]' },
    { nowIso: '2026-09-06T10:00:00.000Z', logBlock: block });
  assert.ok(planner.includes(`\n## Log\n${LOG_BLOCK}\n`), 'byte-exact under the planner heading');
  assert.equal(T.habitLogBlockOf(planner), LOG_BLOCK);
  const rows = T.parseLogTable(planner, 'habit-log').rows;
  assert.equal(rows.length, 3);
  assert.equal(T.logRowFor(T.parseLogTable(planner, 'habit-log'), '2026-09-03').marker, '✓', 'a hand-written marker survives the move');
  // CRLF: the block keeps its endings and the pointer takes the block's
  const crlf = MY_NOTE.replace(/\n/g, '\r\n');
  const crlfAfter = T.moveHabitLog(crlf, 'Morning pages');
  assert.ok(crlfAfter.includes('Schedule and check-ins: [[Morning pages]]\r\n'));
  assert.equal(T.habitLogBlockOf(crlf), `${LOG_BLOCK.replace(/\n/g, '\r\n')}\r`, 'the last line keeps its return too');
  assert.ok(T.habitTemplate({ name: 'x', cadence: 'daily' }, { nowIso: 'x', logBlock: T.habitLogBlockOf(crlf) }).includes(`${LOG_BLOCK.replace(/\n/g, '\r\n')}\r\n`), 'and the planner note carries the endings as they were');
  // no block: the pointer is appended; already there: nothing changes
  const bare = '---\ncadence: daily\n---\n\n# Walk\n';
  const appended = T.moveHabitLog(bare, 'Walk');
  assert.equal(appended, `${bare}\nSchedule and check-ins: [[Walk]]\n`);
  assert.equal(T.moveHabitLog(appended, 'Walk'), appended, 'idempotent');
  assert.equal(T.moveHabitLog('', 'Walk'), 'Schedule and check-ins: [[Walk]]\n');
  // a sentinel with no table yet moves as one line
  assert.equal(T.habitLogBlockOf('## Log\n<!-- habit-log: -->\n\n# tail\n'), '<!-- habit-log: -->');
});

test('THE ASK: the schedule fields and the start date leave the My Life frontmatter under either name; the rest stays', () => {
  const fm = { name: 'Morning pages', cadence: 'weekly', cadence_days: ['mon'], status: 'active', started_on: '2026-08-27', key_element: '[[Writing]]', tags: ['x'] };
  assert.deepEqual(T.stripHabitScheduleFields(fm), { name: 'Morning pages', status: 'active', key_element: '[[Writing]]', tags: ['x'] });
  assert.deepEqual(T.HABIT_IMPORT_REMOVED_FIELDS, ['cadence', 'cadence_days', 'started_on', 'since']);
  assert.deepEqual(T.stripHabitScheduleFields({ type: 'habit', since: '2026-08-01' }), { type: 'habit' }, 'since goes too: the date lives once, as started_on in the planner note');
  assert.deepEqual(T.stripHabitScheduleFields({ since: '2026-08-01', started_on: '2026-08-02' }), {}, 'both names');
});

test('THE ASK: the My Life note stays identifiable and linked: type: habit when it had none, and the back-link', () => {
  // a lived-vault note: no type, the cadence was its only mark
  const lived = { name: 'Morning pages', cadence: 'weekly', cadence_days: ['mon'], status: 'active', started_on: '2026-08-27', key_element: '[[Writing]]' };
  assert.deepEqual(T.importSourceFrontmatter(lived, 'Morning pages'), { name: 'Morning pages', status: 'active', key_element: '[[Writing]]', type: 'habit', planner_habit: '[[Morning pages]]' });
  assert.equal(T.isHabitFrontmatter(lived), true, 'still a habit note after its cadence left');
  // the scaffold shape keeps its type; an empty type is treated as none; another type is kept as it is
  assert.deepEqual(T.importSourceFrontmatter({ type: 'habit', cadence: 'daily', since: '2026-08-01' }, 'Walk'), { type: 'habit', planner_habit: '[[Walk]]' });
  assert.deepEqual(T.importSourceFrontmatter({ type: '', cadence: 'daily' }, 'Walk'), { type: 'habit', planner_habit: '[[Walk]]' });
  assert.deepEqual(T.importSourceFrontmatter({ type: 'ritual', cadence: 'daily' }, 'Walk'), { type: 'ritual', planner_habit: '[[Walk]]' });
  // the back-link names the planner note as created, so a -2 slug is the -2 slug
  assert.equal(T.importSourceFrontmatter({ cadence: 'daily' }, 'Walk-2').planner_habit, '[[Walk-2]]');
});

// The plugin half: a vault with two My Life notes and an empty planner.
function importApp() {
  const files = {
    [`${MY}/Morning pages.md`]: { text: MY_NOTE, fm: { name: 'Morning pages', cadence: 'weekly', cadence_days: ['mon', 'wed', 'fri'], status: 'active', started_on: '2026-08-27', key_element: '[[Writing]]' } },
    [`${MY}/Walk.md`]: { text: '---\ntype: habit\ncadence: daily\nsince: 2026-08-01\n---\n\n# Walk\n', fm: { type: 'habit', cadence: 'daily', since: '2026-08-01' } },
    [`${MY}/INDEX.md`]: { text: '', fm: { cadence: 'daily' } },
  };
  const folders = new Set([MY, '02 Planner', '02 Planner/Habits']);
  const calls = { process: [], frontmatter: [], create: [], notices: [] };
  const fileOf = (p) => { const f = new TFile(); f.path = p; f.basename = p.split('/').pop().replace(/\.md$/, ''); f.extension = 'md'; f.stat = { mtime: 1 }; return f; };
  const folderOf = (p) => { const f = new TFolder(); f.path = p; f.children = Object.keys(files).filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes('/')).map(fileOf); return f; };
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (files[p] ? fileOf(p) : (folders.has(p) ? folderOf(p) : null)),
      read: async (f) => files[f.path].text,
      cachedRead: async (f) => files[f.path].text,
      process: async (f, fn) => { calls.process.push(f.path); files[f.path].text = fn(files[f.path].text); },
      create: async (p, content) => { calls.create.push({ path: p, content }); files[p] = { text: content, fm: null }; return fileOf(p); },
      createFolder: async (p) => { folders.add(p); },
    },
    fileManager: { processFrontMatter: async (f, fn) => { calls.frontmatter.push(f.path); fn(files[f.path].fm); } },
    metadataCache: { getFileCache: (f) => ({ frontmatter: files[f.path] && files[f.path].fm }) },
  };
  const p = Object.create(PluginClass.prototype);
  p.settings = { plannerFolder: '02 Planner', habitsImportFolder: MY };
  p.app = app;
  p.habits = [];
  p._habitCache = new Map();
  p.emitModelChanged = () => { };
  return { p, files, calls };
}

test('THE ASK: the import creates the planner note first, then edits the My Life note; a second run is a no-op', async () => {
  const { p, files, calls } = importApp();
  const before = p.importCandidates();
  assert.deepEqual(before.map((c) => c.basename), ['Morning pages', 'Walk'], 'INDEX is furniture');
  const r = await p.importHabits(before);
  assert.deepEqual(r, { done: 2, skipped: 0, failed: [] });
  // the planner notes
  assert.deepEqual(calls.create.map((c) => c.path), ['02 Planner/Habits/Morning pages.md', '02 Planner/Habits/Walk.md']);
  const planner = calls.create[0].content;
  assert.match(planner, /^type: planner-habit$/m);
  assert.match(planner, /^cadence: weekly$/m);
  assert.match(planner, /^cadence_days: \[mon, wed, fri\]$/m);
  assert.match(planner, /^started_on: 2026-08-27$/m);
  assert.match(planner, /^linked_note: "\[\[Morning pages\]\]"$/m);
  assert.ok(planner.includes(`\n## Log\n${LOG_BLOCK}\n`), 'the block moved byte-exact');
  assert.match(calls.create[1].content, /^cadence: daily$/m);
  assert.match(calls.create[1].content, /^started_on: 2026-08-01$/m, 'since becomes started_on');
  assert.match(calls.create[1].content, /<!-- habit-log: schema=streak -->\n\| Date \| Y\/N \| Note \|\n\| --- \| --- \| --- \|\n$/, 'no log in the source: the empty section');
  // the My Life notes: the pointer in place of the block, the fields gone
  assert.equal(files[`${MY}/Morning pages.md`].text, MY_NOTE.replace(LOG_BLOCK, 'Schedule and check-ins: [[Morning pages]]'));
  assert.deepEqual(files[`${MY}/Morning pages.md`].fm, { name: 'Morning pages', status: 'active', key_element: '[[Writing]]', type: 'habit', planner_habit: '[[Morning pages]]' }, 'a lived-vault note gains its type and the back-link');
  assert.equal(files[`${MY}/Walk.md`].text, '---\ntype: habit\ncadence: daily\nsince: 2026-08-01\n---\n\n# Walk\n\nSchedule and check-ins: [[Walk]]\n');
  assert.deepEqual(files[`${MY}/Walk.md`].fm, { type: 'habit', planner_habit: '[[Walk]]' }, 'since is gone: the date lives once, in the planner note');
  // the order per note: create, then process, then frontmatter, and only
  // the My Life note is processed
  assert.deepEqual(calls.process, [`${MY}/Morning pages.md`, `${MY}/Walk.md`]);
  assert.deepEqual(calls.frontmatter, [`${MY}/Morning pages.md`, `${MY}/Walk.md`]);
  // the summary
  assert.equal(T.importSummaryText(r), 'Planner: imported 2 habits from My Life.');
  assert.equal(T.importSummaryText({ done: 1, skipped: 2, failed: ['x: boom'] }), 'Planner: imported 1 habit from My Life, 2 skipped (linked already), 1 failed: x: boom.');
  // the second run: both are linked now, nothing to plan, nothing written;
  // the My Life notes are still habit notes (type: habit), just linked ones
  assert.equal(T.isHabitFrontmatter(files[`${MY}/Morning pages.md`].fm), true);
  assert.equal(p.habits.length, 2);
  assert.deepEqual(p.habits.map((h) => h.linkedBasename).sort(), ['Morning pages', 'Walk']);
  assert.deepEqual(p.importCandidates(), []);
  const again = await p.importHabits(before);
  assert.deepEqual(again, { done: 0, skipped: 2, failed: [] });
  assert.equal(calls.create.length, 2);
  assert.equal(calls.process.length, 2);
  assert.equal(calls.frontmatter.length, 2);
});

test('the import refuses a candidate outside the import folder and reports a failure without stopping', async () => {
  const { p, calls } = importApp();
  const list = p.importCandidates();
  const stray = { ...list[1], path: '02 Planner/Todoist/Walk.md' };
  const r = await p.importHabits([stray, list[0]]);
  assert.deepEqual(r, { done: 1, skipped: 1, failed: [] });
  assert.deepEqual(calls.process, [`${MY}/Morning pages.md`], 'the stray path is never processed');
  // a source that is gone fails that note only
  const { p: p2, files: f2 } = importApp();
  const l2 = p2.importCandidates();
  delete f2[`${MY}/Walk.md`];
  const r2 = await p2.importHabits(l2);
  assert.deepEqual(r2, { done: 1, skipped: 1, failed: [] });
});

test('SOURCE: the candidate line, the settings line, and the import runs lenient', () => {
  assert.equal(T.importCandidateText({ basename: 'Walk', cadence: 'daily', status: 'active', startedOn: '2026-08-01' }), 'Daily; since 2026-08-01; from Walk.md.');
  assert.equal(T.importCandidateText({ basename: 'Pages', cadence: 'weekly', cadenceDays: ['mon', 'fri'], status: 'paused' }), 'Weekly on Mon, Fri; paused; from Pages.md.');
  assert.equal(T.importCandidateText({ basename: 'Old', cadence: 'weekly', cadenceDays: [], status: 'archived' }), 'Weekly, no weekdays yet; archived; from Old.md.');
  assert.equal(T.importCandidateText({ basename: 'Bills', cadence: 'monthly', monthDay: 3, status: 'active' }), 'Monthly on day 3; from Bills.md.');
  assert.equal(T.importButtonText(3), 'Import 3');
  assert.equal(T.importFolderText('X', 0), 'Read for the import and the link picker only; the planner never writes here except during an import. Every habit note here is imported or linked.');
  assert.match(T.importFolderText('X', 2), /2 habit notes not imported yet\.$/);
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const imp = main.slice(main.indexOf('async importHabits('), main.indexOf('/* ---- manual items'));
  assert.ok(/const body = await this\.app\.vault\.read\(src\);\s*\n\s*const logBlock = habitLogBlockOf\(body\);/.test(imp), 'the block is read before the planner note is made');
  assert.ok(/path = await this\.createHabit\(c, \{ logBlock, quiet: true, lenient: true \}\);/.test(imp), 'created first, lenient');
  assert.ok(/await this\.app\.vault\.process\(src, \(data\) => moveHabitLog\(data, slug\)\);/.test(imp), 'then the body, through vault.process');
  assert.ok(/await this\.app\.fileManager\.processFrontMatter\(src, \(fm\) => \{ importSourceFrontmatter\(fm, slug\); \}\);/.test(imp), 'then the frontmatter, one call for the strip, the type and the back-link');
  assert.ok(imp.indexOf('createHabit(') < imp.indexOf('moveHabitLog(data, slug)') && imp.indexOf('moveHabitLog(data, slug)') < imp.indexOf('processFrontMatter('), 'in that order');
  assert.ok(/if \(importDone\(cache && cache\.frontmatter\)\) \{ result\.skipped\+\+; continue; \}/.test(imp), 'done is read on the source');
  assert.ok(!/linkedBasename/.test(imp), 'never inferred from the planner side');
  // the consent copy: one constant, both surfaces
  assert.equal(T.IMPORT_EDITS_TEXT, 'In each My Life note the import: removes cadence, cadence_days, started_on, since from the frontmatter; adds type: habit when missing and planner_habit; moves the log table into the planner note and leaves a pointer line.');
  const modal = main.slice(main.indexOf('class ImportHabitsModal'), main.indexOf('class PlannerBoardView'));
  assert.ok(/contentEl\.createDiv\(\{ cls: 'iplan-settings-note', text: IMPORT_EDITS_TEXT \}\);/.test(modal), 'the sentence above the checkboxes');
  assert.ok(modal.indexOf('IMPORT_EDITS_TEXT') < modal.indexOf('addToggle('), 'above, not below');
  const settings = main.slice(main.indexOf('class IcorPlannerSettingTab'));
  assert.ok(/\.setName\('Import from My Life'\)\s*\n\s*\.setDesc\(`\$\{IMPORT_EDITS_TEXT\} A note that already carries planner_habit is skipped\.`\)/.test(settings), 'the same sentence under the button');
  // the floor: trashFile is an API of 1.6.6
  const manifest = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.minAppVersion, '1.6.6');
});

test('THE ASK: a run that stops after the body write resumes with the frontmatter step only, and makes no second planner note', async () => {
  const { p, files, calls } = importApp();
  const first = p.importCandidates().filter((c) => c.basename === 'Morning pages');
  // the frontmatter write fails once, after the planner note and the body are written
  const fm = p.app.fileManager.processFrontMatter;
  let blow = true;
  p.app.fileManager.processFrontMatter = async (f, fn) => { if (blow) { blow = false; throw new Error('disk full'); } return fm(f, fn); };
  const r1 = await p.importHabits(first);
  assert.deepEqual(r1, { done: 0, skipped: 0, failed: ['Morning pages: disk full'] });
  assert.equal(calls.create.length, 1, 'the planner note exists');
  assert.equal(T.habitLogBlockOf(files[`${MY}/Morning pages.md`].text), null, 'the body was written: the block is out');
  assert.ok(files[`${MY}/Morning pages.md`].text.includes('Schedule and check-ins: [[Morning pages]]'));
  assert.equal(files[`${MY}/Morning pages.md`].fm.cadence, 'weekly', 'the frontmatter was not');
  // the note is listed again, with the planner note that links back
  const again = p.importCandidates();
  assert.deepEqual(again.map((c) => [c.basename, c.existingPlanner]), [['Morning pages', '02 Planner/Habits/Morning pages.md'], ['Walk', null]]);
  const r2 = await p.importHabits(again.filter((c) => c.basename === 'Morning pages'));
  assert.deepEqual(r2, { done: 1, skipped: 0, failed: [] });
  assert.equal(calls.create.length, 1, 'no duplicate planner note');
  assert.deepEqual(calls.process, [`${MY}/Morning pages.md`], 'the body was not rewritten: nothing to move, the pointer is there');
  assert.deepEqual(files[`${MY}/Morning pages.md`].fm, { name: 'Morning pages', status: 'active', key_element: '[[Writing]]', type: 'habit', planner_habit: '[[Morning pages]]' }, 'typed and linked');
  assert.ok(calls.create[0].content.includes(LOG_BLOCK), 'the planner note holds the log');
  assert.deepEqual(p.importCandidates().map((c) => c.basename), ['Walk'], 'and it is done');
});

test('THE ASK: a run that stops right after creating the planner note resumes with the body and the frontmatter, the block moving once', async () => {
  const { p, files, calls } = importApp();
  const first = p.importCandidates().filter((c) => c.basename === 'Morning pages');
  // the body write fails once, after the planner note is created with the block copied in
  const proc = p.app.vault.process;
  let blow = true;
  p.app.vault.process = async (f, fn) => { if (blow && f.path.startsWith(MY)) { blow = false; throw new Error('locked'); } return proc(f, fn); };
  const r1 = await p.importHabits(first);
  assert.deepEqual(r1, { done: 0, skipped: 0, failed: ['Morning pages: locked'] });
  assert.equal(T.habitLogBlockOf(files[`${MY}/Morning pages.md`].text), LOG_BLOCK, 'the block is still in the source');
  assert.ok(calls.create[0].content.includes(LOG_BLOCK), 'and already in the planner note');
  const r2 = await p.importHabits(p.importCandidates().filter((c) => c.basename === 'Morning pages'));
  assert.deepEqual(r2, { done: 1, skipped: 0, failed: [] });
  assert.equal(calls.create.length, 1, 'no duplicate planner note');
  assert.equal(files[`${MY}/Morning pages.md`].text, MY_NOTE.replace(LOG_BLOCK, 'Schedule and check-ins: [[Morning pages]]'));
  assert.equal(files['02 Planner/Habits/Morning pages.md'].text.split(LOG_BLOCK).length, 2, 'the planner note holds the block exactly once');
  assert.equal(files[`${MY}/Morning pages.md`].fm.planner_habit, '[[Morning pages]]');
});

test('adoptLogBlock: a planner note without a sentinel takes the block under its Log heading, one with a sentinel is left alone', () => {
  const empty = '---\ntype: planner-habit\n---\n\n# Walk\n\n## Log\n<!-- habit-log: schema=streak -->\n| Date | Y/N | Note |\n| --- | --- | --- |\n';
  assert.equal(T.adoptLogBlock(empty, LOG_BLOCK), empty, 'it has a sentinel: the copy it took at creation');
  const bare = '---\ntype: planner-habit\n---\n\n# Walk\n\n## Log\n';
  assert.equal(T.adoptLogBlock(bare, LOG_BLOCK), `${bare}${LOG_BLOCK}\n`);
  const noHeading = '# Walk\n';
  assert.equal(T.adoptLogBlock(noHeading, LOG_BLOCK), `# Walk\n\n## Log\n${LOG_BLOCK}\n`);
  assert.equal(T.adoptLogBlock(bare, null), bare);
});
