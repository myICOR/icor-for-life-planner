/* Habits: the vault's Habits room on the board, read and written.
 *
 * The contract has two note shapes on the read side (the scaffold's example
 * with `type: habit`, the lived vault's with name / cadence / cadence_days /
 * status / started_on) and one on the write side: a row in the habit-log
 * table in the note body, newest on top, streaks computed and never stored.
 * The check-in is the same row an agent writes in chat, so it is gated to
 * the byte. The weekday mapping and its inverse are gated as a round trip
 * over every subset, because the HABITS tab writes what the board reads.
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

// The scaffold's example, verbatim.
const SCAFFOLD_FM = { type: 'habit', cadence: 'daily', status: 'active', since: '2026-08-27', tags: ['example'] };
// A lived note: no type, the folder is the identity.
const PRIVATE_FM = { name: 'Daily Scratchpad writing', cadence: 'daily', status: 'active', started_on: '2026-08-27', key_element: '[[Writing]]' };

const STREAK_BODY = [
  '---',
  'name: Morning pages',
  'cadence: weekdays',
  '---',
  '',
  '# Morning pages',
  '',
  '## Daily log',
  '<!-- habit-log: schema=streak -->',
  '| Date | Y/N | Note |',
  '|---|---|---|',
  '| 2026-09-08 | _ |  |',
  '| 2026-09-07 | Y | short |',
  '| 2026-09-04 | Y |  |',
  '| 2026-09-03 | Y |  |',
  '| 2026-09-02 | N | sick |',
  '',
].join('\n');

const PROCESS_BODY = [
  '## Log',
  '<!-- habit-log: schema=process -->',
  '| Date | Done | Trigger |',
  '| --- | --- | --- |',
  '| 2026-09-04 | Y | after coffee |',
  '| 2026-09-03 | Y | after coffee |',
  '',
].join('\n');

const habit = (fm, body, p) => T.habitFromFrontmatter(fm, p || '04 Inner World/My Life/Habits/Morning pages.md', body == null ? STREAK_BODY : body);

test('THE ASK: a habit scheduled sun and wed lands on Wednesday\'s column and not Thursday\'s', () => {
  const h = habit({ name: 'Long walk', cadence: 'weekly', cadence_days: ['sun', 'wed'] }, '');
  assert.deepEqual(T.habitDays(h), ['wed', 'sun']);
  assert.equal(T.dayCode('2026-09-09'), 'wed');
  assert.equal(T.dayCode('2026-09-10'), 'thu');
  assert.equal(T.habitOccurrences([h], '2026-09-09', '2026-09-09').length, 1, 'Wednesday');
  assert.equal(T.habitOccurrences([h], '2026-09-10', '2026-09-09').length, 0, 'Thursday');
  assert.equal(T.habitOccurrences([h], '2026-09-13', '2026-09-09').length, 1, 'Sunday');
  // a paused habit never lands; a monthly habit never lands
  assert.equal(T.habitOccurrences([habit({ cadence: 'weekly', cadence_days: ['wed'], status: 'paused' }, '')], '2026-09-09', '2026-09-09').length, 0);
  assert.equal(T.habitOccurrences([habit({ cadence: 'monthly' }, '')], '2026-09-09', '2026-09-09').length, 0);
  // the rows come by name
  const b = habit({ name: 'B habit', cadence: 'daily' }, '', 'x/B.md');
  const a = habit({ name: 'A habit', cadence: 'daily' }, '', 'x/A.md');
  assert.deepEqual(T.habitOccurrences([b, a], '2026-09-09', '2026-09-09').map((o) => o.habit.name), ['A habit', 'B habit']);
});

test('the scaffold example (type: habit, cadence: daily, since) and a private note parse to the same shape', () => {
  const p = '04 Inner World/My Life/Habits/Daily Scratchpad writing.md';
  const scaffold = T.habitFromFrontmatter(SCAFFOLD_FM, p, '');
  const lived = T.habitFromFrontmatter(PRIVATE_FM, p, '');
  assert.deepEqual(scaffold, lived);
  assert.deepEqual(scaffold, {
    path: p, slug: 'Daily Scratchpad writing', name: 'Daily Scratchpad writing',
    cadence: 'daily', cadenceDays: null, status: 'active', since: '2026-08-27', logSchema: null,
    log: T.parseLogTable('', 'habit-log'),
  });
  assert.deepEqual(T.habitDays(scaffold), T.WEEKDAY_CODES, 'the scaffold example shows every day');
  // the body's sentinel names the schema
  assert.equal(habit({ cadence: 'weekdays' }).logSchema, 'streak');
  assert.equal(habit({ cadence: 'daily' }, PROCESS_BODY).logSchema, 'process');
  assert.equal(habit({ cadence: 'daily' }, '<!-- habit-log: -->\n').logSchema, 'streak', 'a sentinel without a schema is the streak schema');
});

test('cadence: weekday is read as weekdays; unknown is adhoc; the room furniture is not a habit', () => {
  assert.equal(T.normalizeCadence('weekday'), 'weekdays');
  assert.equal(T.normalizeCadence('Weekdays'), 'weekdays');
  assert.equal(T.normalizeCadence('fortnightly'), 'adhoc');
  assert.equal(T.normalizeCadence(undefined), 'adhoc');
  assert.deepEqual(T.HABIT_CADENCES, ['daily', 'weekdays', 'weekly', 'monthly', 'adhoc']);
  assert.deepEqual(T.HABIT_STATUSES, ['active', 'paused', 'abandoned']);
  assert.equal(habit({ cadence: 'weekday' }, '').cadence, 'weekdays');
  assert.deepEqual(T.habitDays(habit({ cadence: 'weekday' }, '')), ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.equal(habit({ type: 'habit' }, '').cadence, 'adhoc', 'a type with no cadence is adhoc');
  assert.equal(habit({ status: 'Paused', cadence: 'daily' }, '').status, 'paused');
  assert.equal(habit({ status: 'gone', cadence: 'daily' }, '').status, 'active', 'an unknown status reads as active');
  // not a habit: no mark; a planner item; room furniture
  assert.equal(T.habitFromFrontmatter({ tags: ['x'] }, 'h/x.md', ''), null);
  assert.equal(T.habitFromFrontmatter({ type: 'planner-item', source: 'todoist' }, 'h/x.md', ''), null);
  assert.equal(T.habitFromFrontmatter(null, 'h/x.md', ''), null);
  for (const p of ['h/INDEX.md', 'h/README.md', 'h/readme.md', 'h/_template.md']) {
    assert.equal(T.habitFromFrontmatter({ cadence: 'daily' }, p, ''), null, p);
  }
  assert.equal(T.habitBasenameOk('Morning pages'), true);
  assert.equal(T.isHabitFrontmatter({ type: 'Habit' }), true);
  assert.equal(T.isHabitFrontmatter({ cadence: 'daily' }), true);
  assert.equal(T.isHabitFrontmatter({}), false);
});

test('checking writes a Y row under the existing sentinel and creates the section when absent', () => {
  // present: the row lands on top (newest on top) and nothing else moves
  const out = T.habitLogAfterCheck(STREAK_BODY, '2026-09-09', true);
  const rows = T.parseLogTable(out, 'habit-log').rows;
  assert.deepEqual([rows[0].date, rows[0].marker, rows[0].rest], ['2026-09-09', 'Y', ['']]);
  assert.equal(rows.length, 6);
  const before = STREAK_BODY.split('\n');
  const after = out.split('\n');
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, 11), before.slice(0, 11));
  assert.deepEqual(after.slice(12), before.slice(11));
  // re-checking a row that carries a note keeps the note
  const again = T.habitLogAfterCheck(STREAK_BODY, '2026-09-02', true);
  const row = T.logRowFor(T.parseLogTable(again, 'habit-log'), '2026-09-02');
  assert.deepEqual([row.marker, row.rest], ['Y', ['sick']]);
  // absent: the exact section from the vault's convention
  const bare = '---\ntype: habit\ncadence: daily\n---\n\n# Daily Scratchpad writing\n';
  const made = T.habitLogAfterCheck(bare, '2026-09-09', true);
  assert.equal(made, bare + '\n## Daily log\n<!-- habit-log: schema=streak -->\n| Date | Y/N | Note |\n| --- | --- | --- |\n| 2026-09-09 | Y |  |\n');
  assert.deepEqual(T.HABIT_LOG_SECTION, { heading: '## Daily log', schema: 'streak', header: ['Date', 'Y/N', 'Note'] });
  assert.equal(T.HABIT_LOG_SENTINEL, 'habit-log');
  // a process-schema note: the trigger column is left for the check-in
  const proc = T.habitLogAfterCheck(PROCESS_BODY, '2026-09-05', true);
  const prow = T.logRowFor(T.parseLogTable(proc, 'habit-log'), '2026-09-05');
  assert.deepEqual([prow.marker, prow.rest], ['Y', ['']]);
  // and the write is an identity when the row already says Y
  assert.equal(T.habitLogAfterCheck(STREAK_BODY, '2026-09-07', true), STREAK_BODY);
});

test('unchecking a fresh row writes _, unchecking a row with a note writes N', () => {
  const checked = T.habitLogAfterCheck(STREAK_BODY, '2026-09-09', true);
  const fresh = T.habitLogAfterCheck(checked, '2026-09-09', false);
  assert.equal(T.logRowFor(T.parseLogTable(fresh, 'habit-log'), '2026-09-09').marker, '_');
  const noted = T.habitLogAfterCheck(STREAK_BODY, '2026-09-07', false);
  const row = T.logRowFor(T.parseLogTable(noted, 'habit-log'), '2026-09-07');
  assert.deepEqual([row.marker, row.rest], ['N', ['short']], 'the note survives, the marker says not done');
  // a process row's trigger counts as text
  const proc = T.habitLogAfterCheck(PROCESS_BODY, '2026-09-04', false);
  assert.equal(T.logRowFor(T.parseLogTable(proc, 'habit-log'), '2026-09-04').marker, 'N');
  // no row to uncheck: the body comes back as it was
  assert.equal(T.habitLogAfterCheck(STREAK_BODY, '2026-09-20', false), STREAK_BODY);
  assert.equal(T.habitLogAfterCheck('# Nothing\n', '2026-09-20', false), '# Nothing\n');
});

test('a row Larry wrote by hand renders checked', () => {
  const hand = [
    '<!-- habit-log: schema=streak -->',
    '| Date | Y/N | Note |',
    '|---|---|---|',
    '| 2026-09-09 | ✓ | |',
    '| 2026-09-08 | G | |',
    '| 2026-09-07 | R | |',
    '| 2026-09-04 | \u2013 | dash day |',  // the vault's not-done dash, escaped on purpose
  ].join('\n');
  const h = habit({ cadence: 'daily' }, hand);
  const on = (day) => T.habitOccurrences([h], day, '2026-09-10')[0];
  assert.equal(on('2026-09-09').checked, true, 'the check mark');
  assert.equal(on('2026-09-08').checked, true, 'G');
  assert.equal(on('2026-09-07').checked, false);
  assert.equal(on('2026-09-07').missed, true, 'R');
  assert.equal(on('2026-09-04').missed, true, 'the dash, escaped on purpose');
  assert.equal(on('2026-09-05').checked, false);
  assert.equal(on('2026-09-05').missed, false, 'no row is pending, not missed');
  assert.equal(on('2026-09-09').marker, '✓', 'the marker is carried as written');
});

test('cadenceFromDays and daysFromCadence round-trip for all 128 subsets', () => {
  let seen = 0;
  for (let mask = 0; mask < 128; mask++) {
    const days = T.WEEKDAY_CODES.filter((_, i) => mask & (1 << i));
    const c = T.cadenceFromDays(days);
    assert.deepEqual(T.daysFromCadence(c.cadence, c.cadenceDays), days, `mask ${mask}`);
    if (c.cadenceDays === null) assert.ok(c.cadence === 'daily' || c.cadence === 'weekdays', 'only the two named cadences drop the field');
    seen++;
  }
  assert.equal(seen, 128);
  assert.deepEqual(T.cadenceFromDays(T.WEEKDAY_CODES), { cadence: 'daily', cadenceDays: null });
  assert.deepEqual(T.cadenceFromDays(['mon', 'tue', 'wed', 'thu', 'fri']), { cadence: 'weekdays', cadenceDays: null });
  assert.deepEqual(T.cadenceFromDays(['fri', 'mon']), { cadence: 'weekly', cadenceDays: ['mon', 'fri'] });
  assert.deepEqual(T.cadenceFromDays([]), { cadence: 'weekly', cadenceDays: [] });
  // the read side: monthly is never a weekday habit; adhoc with days is those days
  assert.deepEqual(T.daysFromCadence('monthly', ['mon']), []);
  assert.deepEqual(T.daysFromCadence('adhoc', ['sat']), ['sat']);
  assert.deepEqual(T.daysFromCadence('weekly', null), []);
});

test('a process-schema habit never shows a streak, a weekday streak survives the weekend', () => {
  const weekday = habit({ cadence: 'weekdays' });
  // Tue 2026-09-08 pending: the streak ends yesterday (Mon) and joins Fri
  // and Thu across the weekend; Wed 09-02 is N and stops it.
  const tue = T.habitOccurrences([weekday], '2026-09-08', '2026-09-08')[0];
  assert.equal(tue.streak, 3);
  assert.equal(T.streakOf(weekday.log, T.habitDays(weekday), '2026-09-08'), 3);
  // the same day, checked, counts itself
  const checked = habit({ cadence: 'weekdays' }, T.habitLogAfterCheck(STREAK_BODY, '2026-09-08', true));
  assert.equal(T.habitOccurrences([checked], '2026-09-08', '2026-09-08')[0].streak, 4);
  // as of Monday the 7th the streak is 3 (Mon, Fri, Thu); the 4th alone is 2
  assert.equal(T.streakOf(weekday.log, T.habitDays(weekday), '2026-09-07'), 3);
  assert.equal(T.streakOf(weekday.log, T.habitDays(weekday), '2026-09-04'), 2);
  // a daily habit does not skip the weekend: the gap breaks it
  const daily = habit({ cadence: 'daily' });
  assert.equal(T.streakOf(daily.log, T.habitDays(daily), '2026-09-08'), 1, 'Mon only; Sun has no row');
  // a missed today is a streak of nothing; no scheduled days is nothing
  assert.equal(T.streakOf(daily.log, T.habitDays(daily), '2026-09-02'), 0);
  assert.equal(T.streakOf(daily.log, [], '2026-09-08'), 0);
  // process schema: never a streak, whatever the rows say
  const proc = habit({ cadence: 'daily' }, PROCESS_BODY);
  assert.equal(T.habitOccurrences([proc], '2026-09-04', '2026-09-04')[0].streak, null);
  // the setting turns it off; a note with no log yet has none
  assert.equal(T.habitOccurrences([weekday], '2026-09-08', '2026-09-08', { streaks: false })[0].streak, null);
  assert.equal(T.habitOccurrences([habit({ cadence: 'daily' }, '')], '2026-09-08', '2026-09-08')[0].streak, null);
  // a future day shows the streak as of today, not a guess
  assert.equal(T.habitOccurrences([weekday], '2026-09-10', '2026-09-08')[0].streak, 3);
});

test('a future day is disabled', () => {
  assert.deepEqual(T.habitRowState('2026-09-10', '2026-09-09', ''), { checked: false, missed: false, disabled: true });
  assert.deepEqual(T.habitRowState('2026-09-09', '2026-09-09', ''), { checked: false, missed: false, disabled: false });
  assert.deepEqual(T.habitRowState('2026-09-01', '2026-09-09', 'Y'), { checked: true, missed: false, disabled: false }, 'a past day stays checkable');
  assert.deepEqual(T.habitRowState('2026-09-01', '2026-09-09', 'N'), { checked: false, missed: true, disabled: false });
  const h = habit({ cadence: 'daily' });
  assert.equal(T.habitOccurrences([h], '2026-09-12', '2026-09-09')[0].disabled, true);
  assert.equal(T.habitOccurrences([h], '2026-09-09', '2026-09-09')[0].disabled, false);
});

test('the settings: defaults, the folder validated like the planner folder, the count line', () => {
  const s = T.DEFAULT_SETTINGS;
  assert.equal(s.habitsEnabled, true);
  assert.equal(s.habitsFolder, '04 Inner World/My Life/Habits');
  assert.equal(s.habitStreaks, true);
  assert.deepEqual(T.normalizeHabitsFolder(' /My Habits/ '), { ok: true, folder: 'My Habits', error: null });
  assert.equal(T.normalizeHabitsFolder('').error, 'The habits folder cannot be empty.');
  assert.equal(T.normalizeHabitsFolder('.obsidian/plugins').error, 'The habits folder cannot live inside .obsidian.');
  assert.equal(T.normalizeHabitsFolder('a/../b').ok, false);
  // the planner folder's sentences are unchanged
  assert.equal(T.normalizePlannerFolder('').error, 'The planner folder cannot be empty.');
  assert.equal(T.habitsFolderOf({ habitsFolder: '.obsidian/x' }), s.habitsFolder, 'an invalid setting is the default');
  assert.equal(T.habitsFolderOf({ habitsFolder: 'Habits' }), 'Habits');
  assert.equal(T.habitsFolderOf({}), s.habitsFolder);
  assert.equal(T.habitPathInside({ habitsFolder: 'Habits' }, 'Habits/x.md'), true);
  assert.equal(T.habitPathInside({ habitsFolder: 'Habits' }, 'Habits2/x.md'), false, 'a boundary, not a prefix');
  assert.equal(T.habitPathInside({ habitsFolder: 'Habits' }, '02 Planner/x.md'), false);
  const a = { status: 'active' };
  assert.equal(T.habitsCountText([], 'Habits'), 'No habits found in Habits.');
  assert.equal(T.habitsCountText([a], 'Habits'), '1 active habit found.');
  assert.equal(T.habitsCountText([a, a, { status: 'paused' }], 'Habits'), '2 active habits found, 1 paused.');
});

test('the HABITS tab: a fourth tab beside the board only, greyed rows say why', () => {
  assert.deepEqual(T.TRAY_TABS, ['sync', 'habits', 'agenda', 'goals']);
  assert.deepEqual(T.BOARD_ONLY_TABS, ['sync', 'habits']);
  assert.deepEqual(T.trayVisibleTabs(true), ['sync', 'habits', 'agenda', 'goals']);
  assert.deepEqual(T.trayVisibleTabs(false), ['agenda', 'goals'], 'unchanged elsewhere');
  assert.equal(T.trayEffectiveTab(false, 'habits'), 'agenda', 'a habits pick collapses off the board');
  assert.equal(T.trayEffectiveTab(true, 'habits'), 'habits');
  assert.equal(T.trayDefaultTab(true), 'sync', 'HABITS is never a default');
  assert.equal(T.trayTabLabel('habits'), 'HABITS');
  assert.equal(T.trayTabName('habits'), 'Habits');
  assert.equal(T.trayTabName('sync'), 'Tasks');
  assert.deepEqual(T.habitTabState({ status: 'paused', cadence: 'daily' }), { editable: false, reason: 'PAUSED' });
  assert.deepEqual(T.habitTabState({ status: 'active', cadence: 'monthly' }), { editable: false, reason: 'MONTHLY' });
  assert.deepEqual(T.habitTabState({ status: 'active', cadence: 'weekly' }), { editable: true, reason: null });
  assert.equal(T.habitCadenceLabel({ cadence: 'adhoc' }), 'AD HOC');
  assert.equal(T.habitCadenceLabel({ cadence: 'weekdays' }), 'WEEKDAYS');
});

test('SOURCE: the habits room feeds the re-render and never the push check; every write is body or cadence only', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const boot = main.slice(main.indexOf('async onload()'), main.indexOf('paths() { return plannerPaths'));
  assert.ok(/const habit = \(path\) => habitPathInside\(this\.settings, path\);/.test(boot), 'the room is a watched boundary');
  assert.ok(/if \(habit\(path\)\) return this\.refreshHabits\(\);/.test(boot), 'a change there re-reads the cache before the paint');
  assert.ok(/if \(inside\(file\) && !this\.paths\(\)\.isRoutine\(file\.path\)\) this\.schedulePushCheck\(file\.path\);/.test(boot), 'the push check is the planner folder\'s alone');
  assert.ok(/Promise\.all\(\[this\.refreshRoutines\(\), this\.refreshHabits\(\)\]\)\.then\(\(\) => this\.emitModelChanged\(\)\);/.test(boot), 'boot reads both before the first paint');
  // the check-in: vault.process on the habit note, never processFrontMatter
  const toggle = main.slice(main.indexOf('async toggleHabit('), main.indexOf('async setHabitDays('));
  assert.ok(/await this\.app\.vault\.process\(file, \(data\) => habitLogAfterCheck\(data, day, next\)\);/.test(toggle));
  assert.ok(!/processFrontMatter/.test(toggle), 'a check-in never writes frontmatter');
  // the tab's one frontmatter write: cadence and cadence_days, the field deleted when null
  const days = main.slice(main.indexOf('async setHabitDays('), main.indexOf('/* ---- manual items'));
  assert.ok(/fm\.cadence = c\.cadence;/.test(days));
  assert.ok(/if \(c\.cadenceDays === null\) delete fm\.cadence_days;/.test(days));
  assert.ok(!/fm\.(status|name|started_on|since)\s*=/.test(days), 'nothing else is touched');
  // the room is read flat: no walk into subfolders, cached by mtime
  const refresh = main.slice(main.indexOf('async refreshHabits('), main.indexOf('habitsFor(day, today)'));
  assert.ok(/\(folder\.children \|\| \[\]\)\.filter\(\(c\) => c instanceof TFile && c\.extension === 'md'\)/.test(refresh), 'flat');
  assert.ok(/hit\.mtime === mtime/.test(refresh), 'mtime keyed');
  // the block sits under the lanes on the board and under AFTERNOON in the agenda, never as a drop lane
  assert.ok(/const habitOccs = this\.plugin\.habitsFor\(day, today\);\s*\n\s*if \(habitOccs\.length\) col\.appendChild\(renderHabitsBlock\(this\.plugin, habitOccs, day, today, this\)\);/.test(main), 'the board block');
  assert.ok(/const habitOccs = this\.plugin\.habitsFor\(today, today\);\s*\n\s*if \(habitOccs\.length\) \{\s*\n\s*const sec = el\.createDiv\(\{ cls: 'iplan-tray-section' \}\);\s*\n\s*sec\.appendChild\(renderHabitsBlock\(/.test(main), 'the agenda block');
  const block = main.slice(main.indexOf('function renderHabitsBlock('), main.indexOf('function renderRoutineCard('));
  assert.ok(!/wireDropLane|dragstart|draggable = true/.test(block), 'not a drop target, nothing drags');
  assert.ok(/renderChecklist\(block, model, \{/.test(block), 'the rows are the shared checklist');
  assert.ok(/progress: false,/.test(block), 'the head carries the count, not a second footer');
  assert.ok(/onToggle: \(id, next\) => plugin\.toggleHabit\(String\(id\), day, next\),/.test(block));
  assert.ok(/meta: o\.streak > 0 \? `STREAK \$\{o\.streak\}` : null,/.test(block), 'the streak chip');
  // the tab: aria-label, the collapsible glyph, arrow keys in the weekday row
  const tray = main.slice(main.indexOf('class PlannerTrayView'), main.indexOf('class IcorPlannerSettingTab'));
  assert.ok(/'aria-label': trayTabName\(tab\)/.test(tray), 'every tab is named for the reader');
  assert.ok(/if \(tab === 'habits'\) \{\s*\n\s*b\.addClass\('is-collapsible'\);/.test(tray));
  assert.ok(/setIcon\(glyph, 'calendar-check'\);/.test(tray));
  assert.ok(/else if \(this\.activeTab === 'habits'\) this\.renderHabits\(el\);/.test(tray));
  assert.ok(/weekdayToggleRow\(row, \(\) => current, async \(codes\) => \{/.test(tray), 'the row paints from its own copy');
  assert.ok(/\{ disabled: !st\.editable \}\);/.test(tray), 'a greyed row takes no edit');
  const wd = main.slice(main.indexOf('function weekdayToggleRow('), main.indexOf('class NewRoutineModal'));
  assert.ok(/if \(e\.key !== 'ArrowRight' && e\.key !== 'ArrowLeft' && e\.key !== 'Home' && e\.key !== 'End'\) return;/.test(wd), 'arrow keys move within the row');
  assert.ok(/'aria-pressed': 'false'/.test(wd));
  assert.ok(/if \(o\.disabled\) b\.setAttribute\('aria-disabled', 'true'\);/.test(wd));
  assert.ok(/if \(o\.disabled\) return;/.test(wd), 'inert, not just dim');
  // the settings heading, after Routines and before Two-way sync
  const settings = main.slice(main.indexOf('class IcorPlannerSettingTab'));
  const at = (s) => settings.indexOf(s);
  assert.ok(at("setName('Routines').setHeading()") < at("setName('Habits').setHeading()"), 'Habits after Routines');
  assert.ok(at("setName('Habits').setHeading()") < at("setName('Two-way sync').setHeading()"));
  assert.ok(/habitsFolderSetting\.descEl\.setAttribute\('aria-live', 'polite'\);/.test(settings), 'the folder validation is announced');
  assert.ok(/habitsCountText\(this\.plugin\.habits, n\.folder\)/.test(settings), 'the count line');
  assert.ok(/if \(!n\.ok\) \{ renderHabitsFolder\(v\); return; \}/.test(settings), 'an invalid folder is refused, not saved');
});

test('SOURCE: the stylesheet says what the rulings require', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const start = css.indexOf('/* ----------------------------------------------------------- habits ---- */');
  assert.ok(start > 0, 'the habits block must be findable');
  const block = css.slice(start);
  assert.match(block, /\.iplan-habits \{[^}]*border-top: 1px solid var\(--iplan-hairline\)/);
  assert.match(block, /\.iplan-habits-head \{[^}]*color: var\(--iplan-dim\)/, 'the head is the day-head voice');
  assert.match(block, /\.iplan-habit-row\.is-quiet button\.iplan-habit-name \{ color: var\(--iplan-dim\); \}/, 'a greyed row is the dim ink');
  assert.match(block, /\.iplan-weekdays\[aria-disabled="true"\] button\.iplan-seg-btn \{[^}]*color: var\(--iplan-dim\)/);
  assert.ok(!/\.iplan-habit-row[^{]*\{[^}]*opacity/.test(block), 'never an opacity dial on the greyed row');
  // the checked mark is the success ink through the shared checklist rule
  assert.match(css, /\.iplan-checklist-row\[aria-checked="true"\] \.iplan-check \{[^}]*var\(--iplan-success\)/);
  // the tab collapses to its glyph under 300px of tray width, on a container query
  assert.match(block, /\.iplan-tray-root \{\s*\n\s*container-type: inline-size;\s*\n\s*container-name: iplan-tray;/);
  assert.match(block, /@container iplan-tray \(max-width: 299px\) \{[\s\S]*?\.is-collapsible \.iplan-tab-text \{ display: none; \}[\s\S]*?\.is-collapsible \.iplan-tab-icon \{ display: inline-flex; \}/);
  // 44px targets for the weekday toggles and the name button on touch
  const coarse = block.slice(block.indexOf('@media (any-pointer: coarse)'));
  assert.match(coarse, /\.iplan-weekdays button\.iplan-seg-btn \{ min-height: 44px; \}/);
  assert.match(coarse, /button\.iplan-habit-name \{ min-height: 44px; \}/);
  // no hex anywhere in the run 3b additions
  const b = css.slice(css.indexOf('2026-09-04 b ==='));
  assert.equal((b.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length, 0, 'no colour literal in the run 3b block');
});
