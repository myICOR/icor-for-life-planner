/* Habits: planner-owned notes on the board, read and written.
 *
 * Since 0.10.0 a habit is a note under <planner folder>/Habits/ with
 * `type: planner-habit`; the My Life Habits room is read for the import
 * only, never for the board (that is habits-import.test.cjs). On the read
 * side one shape: name, cadence (daily, weekdays, weekly, monthly),
 * cadence_days for weekly, month_day for monthly, status (active, paused,
 * archived), started_on, linked_note. On the write side the check-in is a
 * row in the habit-log table in the note body, newest on top, streaks
 * computed and never stored. The check-in is the same row an agent writes
 * in chat, so it is gated to the byte.
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

const HABITS = '02 Planner/Habits';
const STREAK_BODY = [
  '---',
  'type: planner-habit',
  'name: Morning pages',
  'cadence: weekdays',
  '---',
  '',
  '# Morning pages',
  '',
  '## Log',
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

// A planner habit from a partial frontmatter: the type is implied.
const habit = (fm, body, p) => T.habitFromFrontmatter(
  { type: 'planner-habit', ...fm }, p || `${HABITS}/Morning pages.md`, body == null ? STREAK_BODY : body);

test('THE ASK: a habit scheduled sun and wed lands on Wednesday\'s column and not Thursday\'s', () => {
  const h = habit({ name: 'Long walk', cadence: 'weekly', cadence_days: ['sun', 'wed'] }, '');
  assert.deepEqual(T.habitDays(h), ['wed', 'sun']);
  assert.equal(T.dayCode('2026-09-09'), 'wed');
  assert.equal(T.dayCode('2026-09-10'), 'thu');
  assert.equal(T.habitOccurrences([h], '2026-09-09', '2026-09-09').length, 1, 'Wednesday');
  assert.equal(T.habitOccurrences([h], '2026-09-10', '2026-09-09').length, 0, 'Thursday');
  assert.equal(T.habitOccurrences([h], '2026-09-13', '2026-09-09').length, 1, 'Sunday');
  // the rows come by name
  const b = habit({ name: 'B habit', cadence: 'daily' }, '', `${HABITS}/B.md`);
  const a = habit({ name: 'A habit', cadence: 'daily' }, '', `${HABITS}/A.md`);
  assert.deepEqual(T.habitOccurrences([b, a], '2026-09-09', '2026-09-09').map((o) => o.habit.name), ['A habit', 'B habit']);
});

test('THE ASK: a monthly habit lands on its day of the month, the 1st without one, and 29 to 31 read as 28', () => {
  const on15 = habit({ name: 'Invoices', cadence: 'monthly', month_day: 15 }, '');
  assert.equal(on15.monthDay, 15);
  assert.equal(T.habitLandsOn(on15, '2026-09-15'), true);
  assert.equal(T.habitLandsOn(on15, '2026-10-15'), true);
  assert.equal(T.habitLandsOn(on15, '2026-09-14'), false);
  assert.equal(T.habitOccurrences([on15], '2026-09-15', '2026-09-09').length, 1);
  assert.equal(T.habitOccurrences([on15], '2026-09-16', '2026-09-09').length, 0);
  // no day: the first of the month
  const first = habit({ cadence: 'monthly' }, '');
  assert.equal(first.monthDay, null);
  assert.equal(T.habitLandsOn(first, '2026-10-01'), true);
  assert.equal(T.habitLandsOn(first, '2026-10-02'), false);
  // the clamp: a day every month has
  assert.equal(T.HABIT_MONTH_DAY_MAX, 28);
  for (const d of [29, 30, 31, '31', 99]) assert.equal(T.monthDayOf(d), 28, String(d));
  assert.equal(T.monthDayOf(28), 28);
  assert.equal(T.monthDayOf(1), 1);
  for (const d of [0, -3, 'x', '', null, undefined]) assert.equal(T.monthDayOf(d), null, String(d));
  const on31 = habit({ cadence: 'monthly', month_day: 31 }, '');
  assert.equal(on31.monthDay, 28);
  assert.equal(T.habitLandsOn(on31, '2026-02-28'), true, 'February still gets its day');
  assert.equal(T.habitLandsOn(on31, '2026-03-31'), false);
  // a monthly habit is never a weekday habit
  assert.deepEqual(T.habitDays(on15), []);
  assert.deepEqual(T.daysFromCadence('monthly', ['mon']), []);
  assert.equal(T.dayOfMonth('2026-09-07'), 7);
});

test('paused and archived habits never render, whatever the cadence', () => {
  for (const status of ['paused', 'archived']) {
    for (const fm of [
      { cadence: 'daily' }, { cadence: 'weekdays' }, { cadence: 'weekly', cadence_days: ['wed'] }, { cadence: 'monthly', month_day: 9 },
    ]) {
      const h = habit({ ...fm, status }, '');
      assert.equal(h.status, status);
      assert.equal(T.habitLandsOn(h, '2026-09-09'), false, `${status} ${fm.cadence}`);
      assert.equal(T.habitOccurrences([h], '2026-09-09', '2026-09-09').length, 0, `${status} ${fm.cadence}`);
    }
  }
  assert.equal(T.habitOccurrences([habit({ cadence: 'daily', status: 'active' }, '')], '2026-09-09', '2026-09-09').length, 1);
  // the tab still lists them, quiet
  assert.equal(T.habitRowModel(habit({ cadence: 'daily', status: 'paused' }, '')).quiet, true);
  assert.equal(T.habitRowModel(habit({ cadence: 'daily' }, '')).quiet, false);
});

test('the planner shape parses; the My Life shape and a planner item do not collect', () => {
  const p = `${HABITS}/Daily Scratchpad writing.md`;
  const full = T.habitFromFrontmatter({
    type: 'planner-habit', name: 'Daily Scratchpad writing', cadence: 'daily', status: 'active',
    started_on: '2026-08-27', linked_note: '[[Daily Scratchpad writing]]', created_at: '2026-09-06T10:00:00.000Z',
  }, p, '');
  assert.deepEqual(full, {
    path: p, slug: 'Daily Scratchpad writing', name: 'Daily Scratchpad writing',
    cadence: 'daily', cadenceDays: null, monthDay: null, status: 'active', startedOn: '2026-08-27',
    linkedNote: '[[Daily Scratchpad writing]]', linkedBasename: 'Daily Scratchpad writing',
    logSchema: null, log: T.parseLogTable('', 'habit-log'),
  });
  assert.deepEqual(T.habitDays(full), T.WEEKDAY_CODES, 'daily shows every day');
  // the name falls back to the file name; the link resolves to a basename
  assert.equal(habit({ cadence: 'daily' }, '', `${HABITS}/Walk.md`).name, 'Walk');
  assert.equal(habit({ cadence: 'daily', linked_note: '[[04 Inner World/My Life/Habits/Walk|the walk]]' }, '').linkedBasename, 'Walk');
  assert.equal(habit({ cadence: 'daily', linked_note: '[[Walk#Log]]' }, '').linkedBasename, 'Walk');
  assert.equal(habit({ cadence: 'daily' }, '').linkedNote, null);
  assert.equal(T.wikilinkBasename('Walk'), 'Walk');
  assert.equal(T.wikilinkBasename(''), null);
  // cadence_days is read for weekly only; month_day for monthly only
  assert.deepEqual(habit({ cadence: 'weekly', cadence_days: 'fri, mon' }, '').cadenceDays, ['mon', 'fri']);
  assert.equal(habit({ cadence: 'daily', cadence_days: ['mon'] }, '').cadenceDays, null);
  assert.equal(habit({ cadence: 'weekly', month_day: 5 }, '').monthDay, null);
  // a date that is not a date is no date
  assert.equal(habit({ cadence: 'daily', started_on: 'soon' }, '').startedOn, null);
  // the body's sentinel names the schema
  assert.equal(habit({ cadence: 'weekdays' }).logSchema, 'streak');
  assert.equal(habit({ cadence: 'daily' }, PROCESS_BODY).logSchema, 'process');
  assert.equal(habit({ cadence: 'daily' }, '<!-- habit-log: -->\n').logSchema, 'streak', 'a sentinel without a schema is the streak schema');
  // NOT a planner habit: the My Life shapes (the scaffold's and the lived
  // one), a planner item, a routine, nothing
  assert.equal(T.habitFromFrontmatter({ type: 'habit', cadence: 'daily', since: '2026-08-27' }, `${HABITS}/x.md`, ''), null, 'the scaffold shape only imports');
  assert.equal(T.habitFromFrontmatter({ name: 'Walk', cadence: 'daily', status: 'active' }, `${HABITS}/x.md`, ''), null, 'the lived shape only imports');
  assert.equal(T.habitFromFrontmatter({ type: 'planner-item', source: 'todoist' }, `${HABITS}/x.md`, ''), null);
  assert.equal(T.habitFromFrontmatter({ type: 'planner-routine' }, `${HABITS}/x.md`, ''), null);
  assert.equal(T.habitFromFrontmatter(null, `${HABITS}/x.md`, ''), null);
  assert.equal(T.isPlannerHabitFrontmatter({ type: 'planner-habit' }), true);
  assert.equal(T.isPlannerHabitFrontmatter({ type: 'habit' }), false);
  assert.equal(T.isPlannerHabitFrontmatter({ cadence: 'daily' }), false);
  assert.equal(T.HABIT_TYPE, 'planner-habit');
  for (const p2 of [`${HABITS}/INDEX.md`, `${HABITS}/README.md`, `${HABITS}/readme.md`, `${HABITS}/_template.md`]) {
    assert.equal(T.habitFromFrontmatter({ type: 'planner-habit', cadence: 'daily' }, p2, ''), null, p2);
  }
  assert.equal(T.habitBasenameOk('Morning pages'), true);
});

test('cadence: weekday is read as weekdays; unknown and adhoc are weekly; abandoned is archived', () => {
  assert.equal(T.normalizeCadence('weekday'), 'weekdays');
  assert.equal(T.normalizeCadence('Weekdays'), 'weekdays');
  assert.equal(T.normalizeCadence('fortnightly'), 'weekly');
  assert.equal(T.normalizeCadence('adhoc'), 'weekly');
  assert.equal(T.normalizeCadence(undefined), 'weekly');
  assert.deepEqual(T.HABIT_CADENCES, ['daily', 'weekdays', 'weekly', 'monthly']);
  assert.deepEqual(T.HABIT_STATUSES, ['active', 'paused', 'archived']);
  assert.deepEqual(T.HABIT_CADENCE_NAMES, { daily: 'Daily', weekdays: 'Weekdays', weekly: 'Weekly', monthly: 'Monthly' });
  assert.equal(habit({ cadence: 'weekday' }, '').cadence, 'weekdays');
  assert.deepEqual(T.habitDays(habit({ cadence: 'weekday' }, '')), ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.equal(habit({}, '').cadence, 'weekly', 'no cadence is weekly');
  assert.deepEqual(T.habitDays(habit({}, '')), [], 'and lands nowhere');
  assert.equal(habit({ status: 'Paused', cadence: 'daily' }, '').status, 'paused');
  assert.equal(habit({ status: 'abandoned', cadence: 'daily' }, '').status, 'archived');
  assert.equal(habit({ status: 'gone', cadence: 'daily' }, '').status, 'active', 'an unknown status reads as active');
  assert.deepEqual(T.daysFromCadence('adhoc', ['sat']), ['sat'], 'weekly with a list is that list');
  assert.deepEqual(T.daysFromCadence('weekly', null), []);
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
  assert.deepEqual(after.slice(0, 12), before.slice(0, 12));
  assert.deepEqual(after.slice(13), before.slice(12));
  // re-checking a row that carries a note keeps the note
  const again = T.habitLogAfterCheck(STREAK_BODY, '2026-09-02', true);
  const row = T.logRowFor(T.parseLogTable(again, 'habit-log'), '2026-09-02');
  assert.deepEqual([row.marker, row.rest], ['Y', ['sick']]);
  // absent: the exact section the template writes
  const bare = '---\ntype: planner-habit\ncadence: daily\n---\n\n# Daily Scratchpad writing\n';
  const made = T.habitLogAfterCheck(bare, '2026-09-09', true);
  assert.equal(made, bare + '\n## Log\n<!-- habit-log: schema=streak -->\n| Date | Y/N | Note |\n| --- | --- | --- |\n| 2026-09-09 | Y |  |\n');
  assert.deepEqual(T.HABIT_LOG_SECTION, { heading: '## Log', schema: 'streak', header: ['Date', 'Y/N', 'Note'] });
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

test('a process-schema habit never shows a streak; a weekday streak survives the weekend; months join', () => {
  const weekday = habit({ cadence: 'weekdays' });
  // Tue 2026-09-08 pending: the streak ends yesterday (Mon) and joins Fri
  // and Thu across the weekend; Wed 09-02 is N and stops it.
  const tue = T.habitOccurrences([weekday], '2026-09-08', '2026-09-08')[0];
  assert.equal(tue.streak, 3);
  assert.equal(T.streakOf(weekday.log, T.habitDays(weekday), '2026-09-08'), 3, 'a list of codes is a schedule');
  assert.equal(T.streakOf(weekday.log, T.habitScheduleOf(weekday), '2026-09-08'), 3, 'so is the habit\'s predicate');
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
  // monthly: the months join across everything between them
  const monthly = habit({ cadence: 'monthly', month_day: 1 }, [
    '<!-- habit-log: schema=streak -->', '| Date | Y/N | Note |', '|---|---|---|',
    '| 2026-09-01 | Y |  |', '| 2026-08-01 | Y |  |', '| 2026-07-01 | N |  |',
  ].join('\n'));
  assert.equal(T.habitOccurrences([monthly], '2026-09-01', '2026-09-09')[0].streak, 2);
  assert.equal(T.habitOccurrences([monthly], '2026-10-01', '2026-09-09')[0].streak, 2, 'a future day shows the streak as of today');
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

test('the settings: the planner Habits folder off the room, the import folder validated, the old key migrated', () => {
  const s = T.DEFAULT_SETTINGS;
  assert.equal(s.habitsEnabled, true);
  assert.equal(s.habitsImportFolder, '04 Inner World/My Life/Habits');
  assert.equal(s.habitStreaks, true);
  assert.equal('habitsFolder' in s, false, 'the old key is not declared');
  // the planner habits live under the room, wherever the room is
  assert.equal(T.plannerPaths({}).habits, '02 Planner/Habits');
  assert.equal(T.plannerPaths({ plannerFolder: 'Week' }).habits, 'Week/Habits');
  assert.equal(T.plannerPaths({}).isHabit('02 Planner/Habits/x.md'), true);
  assert.equal(T.plannerPaths({}).isHabit('02 Planner/Habits2/x.md'), false, 'a boundary, not a prefix');
  assert.equal(T.plannerPaths({}).isHabit('02 Planner/Habits'), false);
  assert.equal(T.habitPathInside({}, '02 Planner/Habits/x.md'), true);
  assert.equal(T.habitPathInside({ plannerFolder: 'Week' }, '02 Planner/Habits/x.md'), false);
  assert.equal(T.habitPathInside({ plannerFolder: 'Week' }, 'Week/Habits/x.md'), true);
  assert.equal(T.habitPathInside({}, '04 Inner World/My Life/Habits/x.md'), false, 'the My Life room is never a write target of the tab');
  // the import folder, validated like the planner folder
  assert.deepEqual(T.normalizeHabitsFolder(' /My Habits/ '), { ok: true, folder: 'My Habits', error: null });
  assert.equal(T.normalizeHabitsFolder('').error, 'The My Life Habits folder cannot be empty.');
  assert.equal(T.normalizeHabitsFolder('.obsidian/plugins').error, 'The My Life Habits folder cannot live inside .obsidian.');
  assert.equal(T.normalizeHabitsFolder('a/../b').ok, false);
  assert.equal(T.normalizePlannerFolder('').error, 'The planner folder cannot be empty.', 'the planner folder\'s sentences are unchanged');
  assert.equal(T.habitsImportFolderOf({ habitsImportFolder: '.obsidian/x' }), s.habitsImportFolder, 'an invalid setting is the default');
  assert.equal(T.habitsImportFolderOf({ habitsImportFolder: 'Habits' }), 'Habits');
  assert.equal(T.habitsImportFolderOf({}), s.habitsImportFolder);
  assert.equal(T.importPathInside({ habitsImportFolder: 'Habits' }, 'Habits/x.md'), true);
  assert.equal(T.importPathInside({ habitsImportFolder: 'Habits' }, 'Habits2/x.md'), false, 'a boundary, not a prefix');
  assert.equal(T.importPathInside({}, '02 Planner/Habits/x.md'), false);
  // the migration: habitsFolder becomes habitsImportFolder, once, silently
  const old = { plannerFolder: '02 Planner', habitsFolder: 'My Habits', habitStreaks: false };
  const m = T.migrateHabitSettings(old);
  assert.deepEqual(m, { plannerFolder: '02 Planner', habitsImportFolder: 'My Habits', habitStreaks: false });
  assert.notEqual(m, old, 'a migrated object is a new object, so the load knows to write back');
  const fresh = { plannerFolder: '02 Planner', habitsImportFolder: 'X' };
  assert.equal(T.migrateHabitSettings(fresh), fresh, 'nothing to do: the same object back');
  assert.deepEqual(T.migrateHabitSettings({ habitsFolder: 'Old', habitsImportFolder: 'New' }), { habitsImportFolder: 'New' }, 'the new key wins when both exist');
  const adopted = T.adoptSettings({ habitsFolder: 'My Habits' }, null);
  assert.equal(adopted.settings.habitsImportFolder, 'My Habits');
  assert.equal('habitsFolder' in adopted.settings, false);
  assert.equal(adopted.changed, true, 'and data.json is written back once');
  // the count line
  const a = { status: 'active' };
  assert.equal(T.habitsCountText([], 'Week/Habits'), 'No habits in Week/Habits yet.');
  assert.equal(T.habitsCountText([a], 'Week/Habits'), '1 active habit in Week/Habits.');
  assert.equal(T.habitsCountText([a, a, { status: 'paused' }, { status: 'archived' }], 'H'), '2 active habits, 1 paused, 1 archived in H.');
});

test('the HABITS tab: a fourth tab beside the board only; the row model', () => {
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
  // the row: the toggles are live for weekly only, implied and inert for
  // daily and weekdays, gone for monthly (a day field instead)
  const row = (fm) => T.habitRowModel(habit(fm, ''));
  assert.deepEqual(row({ cadence: 'weekly', cadence_days: ['mon', 'fri'] }), { weekdays: ['mon', 'fri'], weekdaysEditable: true, monthDayField: false, monthDay: null, quiet: false, statusLabel: 'ACTIVE' });
  assert.deepEqual(row({ cadence: 'daily' }), { weekdays: T.WEEKDAY_CODES, weekdaysEditable: false, monthDayField: false, monthDay: null, quiet: false, statusLabel: 'ACTIVE' });
  assert.deepEqual(row({ cadence: 'weekdays', status: 'paused' }), { weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'], weekdaysEditable: false, monthDayField: false, monthDay: null, quiet: true, statusLabel: 'PAUSED' });
  assert.deepEqual(row({ cadence: 'monthly', month_day: 12, status: 'archived' }), { weekdays: [], weekdaysEditable: false, monthDayField: true, monthDay: 12, quiet: true, statusLabel: 'ARCHIVED' });
  // no day in the note (2026-09-07): the field is drawn and shows EMPTY,
  // never a 1 the note did not say; the board still reads the 1st
  assert.deepEqual(row({ cadence: 'monthly' }), { weekdays: [], weekdaysEditable: false, monthDayField: true, monthDay: null, quiet: false, statusLabel: 'ACTIVE' }, 'no day shows the field empty');
  assert.equal(T.habitLandsOn(habit({ cadence: 'monthly' }, ''), '2026-11-01'), true, 'and is read as the 1st');
});

test('SOURCE: the habit notes ride the room\'s one boundary; the check-in is body only; the tab is wired', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const boot = main.slice(main.indexOf('async onload()'), main.indexOf('paths() { return plannerPaths'));
  assert.ok(/const watched = \(file\) => inside\(file\);/.test(boot), 'the room is the one watched boundary');
  assert.ok(/if \(this\.paths\(\)\.isHabit\(path\)\) return this\.refreshHabits\(\);/.test(boot), 'a change under Habits/ re-reads the cache before the paint');
  assert.ok(!/habitPathInside\(this\.settings/.test(boot), 'no second boundary for the old room');
  assert.ok(/Promise\.all\(\[this\.refreshRoutines\(\), this\.refreshHabits\(\)\]\)\.then\(\(\) => this\.emitModelChanged\(\)\);/.test(boot), 'boot reads both before the first paint');
  assert.ok(/this\.addCommand\(\{ id: 'new-habit', name: 'New habit', callback: \(\) => this\.openNewHabit\(\) \}\);/.test(boot), 'the command');
  // ensureFolders makes the folder
  const ensure = main.slice(main.indexOf('async ensureFolders()'), main.indexOf('async syncNow('));
  assert.ok(/await mk\(p\.habits\);/.test(ensure));
  // the check-in: vault.process on the habit note, never processFrontMatter
  const toggle = main.slice(main.indexOf('async toggleHabit('), main.indexOf('async setHabitDays('));
  assert.ok(/await this\.app\.vault\.process\(file, \(data\) => habitLogAfterCheck\(data, day, next\)\);/.test(toggle));
  assert.ok(!/processFrontMatter/.test(toggle), 'a check-in never writes frontmatter');
  // the folder is read flat: no walk into subfolders, cached by mtime, planner shape only
  const refresh = main.slice(main.indexOf('async refreshHabits('), main.indexOf('habitsFor(day, today)'));
  assert.ok(/getAbstractFileByPath\(this\.habitsFolder\(\)\)/.test(refresh), 'the planner folder');
  assert.ok(/\(folder\.children \|\| \[\]\)\.filter\(\(c\) => c instanceof TFile && c\.extension === 'md'\)/.test(refresh), 'flat');
  assert.ok(/hit\.mtime === mtime/.test(refresh), 'mtime keyed');
  assert.ok(/if \(!isPlannerHabitFrontmatter\(fm\) \|\| !habitBasenameOk\(file\.basename\)\) continue;/.test(refresh), 'the planner shape only');
  assert.ok(!/isHabitFrontmatter\(fm\)/.test(refresh), 'the My Life shape never collects');
  // the block sits under the lanes on the board and under AFTERNOON in the agenda, never as a drop lane
  assert.ok(/const habitOccs = this\.plugin\.habitsFor\(day, today\);\s*\n\s*if \(habitOccs\.length\) col\.appendChild\(renderHabitsBlock\(this\.plugin, habitOccs, day, today, this\)\);/.test(main), 'the board block');
  assert.ok(/const habitOccs = this\.plugin\.habitsFor\(today, today\);\s*\n\s*if \(habitOccs\.length\) \{\s*\n\s*const sec = el\.createDiv\(\{ cls: 'iplan-tray-section' \}\);\s*\n\s*sec\.appendChild\(renderHabitsBlock\(/.test(main), 'the agenda block');
  const block = main.slice(main.indexOf('function renderHabitsBlock('), main.indexOf('function renderRoutineCard('));
  assert.ok(!/wireDropLane|dragstart|draggable = true/.test(block), 'not a drop target, nothing drags');
  assert.ok(/renderChecklist\(block, model, \{/.test(block), 'the rows are the shared checklist');
  assert.ok(/progress: false,/.test(block), 'the head carries the count, not a second footer');
  assert.ok(/onToggle: \(id, next\) => plugin\.toggleHabit\(String\(id\), day, next\),/.test(block));
  assert.ok(/meta: o\.streak > 0 \? `STREAK \$\{o\.streak\}` : null,/.test(block), 'the streak chip');
  // the tab: aria-label, the collapsible glyph, the tab wired
  const tray = main.slice(main.indexOf('class PlannerTrayView'), main.indexOf('class IcorPlannerSettingTab'));
  assert.ok(/'aria-label': trayTabName\(tab\)/.test(tray), 'every tab is named for the reader');
  assert.ok(/if \(tab === 'habits'\) \{\s*\n\s*b\.addClass\('is-collapsible'\);/.test(tray));
  assert.ok(/setIcon\(glyph, 'calendar-check'\);/.test(tray));
  assert.ok(/else if \(this\.activeTab === 'habits'\) this\.renderHabits\(el\);/.test(tray));
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
  // no hex anywhere from the run 3b additions to the end of the file
  const b = css.slice(css.indexOf('2026-09-04 b ==='));
  assert.equal((b.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length, 0, 'no colour literal from the run 3b block on');
});
