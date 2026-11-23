/* Weeks: the weekly priorities and the daily highlights of one ISO week.
 *
 * One note per week at <planner folder>/Weeks/YYYY-Www.md, `type:
 * planner-week`, two sentinel blocks in the body. Everything the plugin
 * writes into that note is a pure function of the bytes already there, so
 * every rule is assertable on a string: the two names ruled on 2026-09-15,
 * the byte preservation outside the one line a write touches, and the ISO
 * week arithmetic that decides which file is this week's.
 *
 * What this cannot prove: that the view then paints them. The view mounts
 * the same functions, and a headless DOM is not in this suite.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./harness.cjs');

const root = process.env.PLANNER_ROOT ? path.resolve(process.env.PLANNER_ROOT) : path.join(__dirname, '..');

const NOTE = [
  '---',
  'type: planner-week',
  'week: 2026-W38',
  'created_at: 2026-09-14T07:00:00Z',
  'tags: []',
  '---',
  '',
  '# 2026-W38',
  '',
  '## Weekly priorities',
  '<!-- weekly-priorities: schema=checklist -->',
  '- [ ] Ship the explainer video',
  '- [x] Book the sleep lab follow-up',
  '',
  '## Daily highlights',
  '<!-- daily-highlights: schema=highlight -->',
  '| Date | Highlight | Done |',
  '| --- | --- | --- |',
  '| 2026-09-15 | Record episode 3 | _ |',
  '| 2026-09-14 | Paco review call | Y |',
  '',
].join('\n');

/* ---- the two names ------------------------------------------------------ */

test('THE RULING: the week says priorities, the day says daily highlight, and neither says goal', () => {
  assert.equal(T.WEEK_PRIORITIES_SENTINEL, 'weekly-priorities');
  assert.equal(T.WEEK_PRIORITIES_SECTION.heading, '## Weekly priorities');
  assert.equal(T.WEEK_HIGHLIGHTS_SENTINEL, 'daily-highlights');
  assert.equal(T.WEEK_HIGHLIGHTS_SECTION.heading, '## Daily highlights');
  assert.deepEqual(T.WEEK_HIGHLIGHTS_SECTION.header, ['Date', 'Highlight', 'Done']);
  assert.equal(T.WEEK_TYPE, 'planner-week');
  const template = T.weekTemplate('2026-W38', '2026-09-14T07:00:00Z');
  assert.ok(!/goal/i.test(template), 'the word goal never appears in a week note');
});

test('THE RULING: the starred item keeps its key and loses the word', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  // The key is untouched: renaming a field a plugin has already written is a
  // migration, and this release is not one.
  assert.match(main, /weeklyGoal: fm\.weekly_goal === true/, 'the frontmatter key is still weekly_goal');
  assert.match(main, /'weekly_goal: false'/, 'a new synced note still writes the key');
  // The labels are the ruling's.
  assert.equal(T.PINNED_SECTION_HEAD, 'PINNED THIS WEEK');
  assert.equal(T.trayTabLabel('goals'), 'PINNED');
  assert.match(main, /text: 'WEEK' \}\);/, 'the chip says WEEK');
  assert.match(main, /'Unpin from this week' : 'Pin to this week'/, 'the menu pins and unpins');
  assert.ok(!/'WEEKLY GOALS'/.test(main), 'no surface says WEEKLY GOALS any more');
  assert.ok(!/Mark as weekly goal/.test(main), 'no surface offers to mark a weekly goal');
});

/* ---- ISO week arithmetic ------------------------------------------------ */

test('the ISO week of a day, and the Monday back out of it', () => {
  assert.equal(T.isoWeekOf('2026-09-15'), '2026-W38');
  assert.equal(T.isoWeekOf('2026-09-14'), '2026-W38', 'Monday opens the week');
  assert.equal(T.isoWeekOf('2026-09-20'), '2026-W38', 'Sunday closes it');
  assert.equal(T.isoWeekOf('2026-09-21'), '2026-W39');
  assert.equal(T.mondayOfIsoWeek('2026-W38'), '2026-09-14');
  assert.equal(T.isoWeekDays('2026-W38').length, 7);
  assert.equal(T.isoWeekDays('2026-W38')[6], '2026-09-20');
});

test('the year boundary is the ISO one, not the calendar one', () => {
  // 2027-01-01 is a Friday, so it belongs to the week that began 2026-12-28.
  assert.equal(T.isoWeekOf('2027-01-01'), '2026-W53');
  assert.equal(T.mondayOfIsoWeek('2026-W53'), '2026-12-28');
  // 2025-12-29 is a Monday and opens the first week of 2026.
  assert.equal(T.isoWeekOf('2025-12-29'), '2026-W01');
  assert.equal(T.mondayOfIsoWeek('2026-W01'), '2025-12-29');
});

test('a week a year does not have is null, never a silent roll into January', () => {
  // 2025 has 52 ISO weeks. Asking for its 53rd must not answer with 2026-W01.
  assert.equal(T.mondayOfIsoWeek('2025-W53'), null);
  assert.equal(T.mondayOfIsoWeek('2026-W54'), null);
  assert.equal(T.mondayOfIsoWeek('not a week'), null);
  assert.equal(T.mondayOfIsoWeek(null), null);
  assert.equal(T.isoWeekOf('rubbish'), null);
});

/* ---- reading the note --------------------------------------------------- */

test('the note reads back as its two blocks', () => {
  const week = T.weekFromNote({ type: 'planner-week', week: '2026-W38' }, NOTE, '02 Planner/Weeks/2026-W38.md');
  assert.equal(week.week, '2026-W38');
  assert.equal(week.monday, '2026-09-14');
  assert.deepEqual(week.priorities.map((p) => [p.index, p.done, p.text]), [
    [0, false, 'Ship the explainer video'],
    [1, true, 'Book the sleep lab follow-up'],
  ]);
  assert.equal(week.doneCount, 1);
  assert.deepEqual(week.highlights, [
    { date: '2026-09-15', text: 'Record episode 3', done: '_' },
    { date: '2026-09-14', text: 'Paco review call', done: 'Y' },
  ]);
  assert.equal(T.weekPriorityProgress(week), '1 of 2 done');
});

test('any other note is not a week', () => {
  assert.equal(T.weekFromNote({ type: 'planner-item' }, NOTE, 'x.md'), null);
  assert.equal(T.weekFromNote(null, NOTE, 'x.md'), null);
  // No usable week anywhere: the field is malformed and so is the file name.
  assert.equal(T.weekFromNote({ type: 'planner-week', week: 'soon' }, NOTE, 'Weeks/later.md'), null);
  // A malformed field falls back to the file name, which IS the week.
  const fallback = T.weekFromNote({ type: 'planner-week' }, NOTE, '02 Planner/Weeks/2026-W38.md');
  assert.equal(fallback.week, '2026-W38');
});

test('an empty week is an empty week', () => {
  const empty = T.weekTemplate('2026-W38', '2026-09-14T07:00:00Z');
  const week = T.weekFromNote({ type: 'planner-week', week: '2026-W38' }, empty, '02 Planner/Weeks/2026-W38.md');
  assert.deepEqual(week.priorities, []);
  assert.deepEqual(week.highlights, []);
  assert.equal(T.weekPriorityProgress(week), 'No priorities yet.');
});

/* ---- the priorities checklist ------------------------------------------- */

test('a toggle flips ONE box and leaves every other byte alone', () => {
  const next = T.toggleChecklistItem(NOTE, T.WEEK_PRIORITIES_SENTINEL, 0);
  assert.notEqual(next, NOTE);
  assert.match(next, /- \[x\] Ship the explainer video/);
  const a = NOTE.split('\n');
  const b = next.split('\n');
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    if (a[i].includes('Ship the explainer video')) continue;
    assert.equal(b[i], a[i], `line ${i} changed and should not have`);
  }
  // And back again: two toggles are the identity.
  assert.equal(T.toggleChecklistItem(next, T.WEEK_PRIORITIES_SENTINEL, 0), NOTE);
});

test('a toggle on an index that is not there changes nothing', () => {
  assert.equal(T.toggleChecklistItem(NOTE, T.WEEK_PRIORITIES_SENTINEL, 9), NOTE);
  assert.equal(T.toggleChecklistItem('no sentinel here', T.WEEK_PRIORITIES_SENTINEL, 0), 'no sentinel here');
});

test('the checklist keeps the bullet, the indent and the wording it found', () => {
  const odd = [
    '<!-- weekly-priorities: schema=checklist -->',
    '  * [ ]   spaced out',
    '+ [X] upper case box',
  ].join('\n');
  const parsed = T.parseChecklistBlock(odd, T.WEEK_PRIORITIES_SENTINEL);
  assert.deepEqual(parsed.items.map((i) => [i.done, i.text]), [[false, 'spaced out'], [true, 'upper case box']]);
  const next = T.toggleChecklistItem(odd, T.WEEK_PRIORITIES_SENTINEL, 0);
  assert.match(next, /^ {2}\* \[x] {3}spaced out$/m);
});

test('a line inside the block that is not a checkbox is ignored and left alone', () => {
  const mixed = [
    '## Weekly priorities',
    '<!-- weekly-priorities: schema=checklist -->',
    '- [ ] first',
    'a note I typed here',
    '- [ ] second',
    '',
    '## Daily highlights',
    '<!-- daily-highlights: schema=highlight -->',
    '- [ ] not a priority, different block',
  ].join('\n');
  const parsed = T.parseChecklistBlock(mixed, T.WEEK_PRIORITIES_SENTINEL);
  assert.deepEqual(parsed.items.map((i) => i.text), ['first', 'second']);
  assert.ok(T.toggleChecklistItem(mixed, T.WEEK_PRIORITIES_SENTINEL, 1).includes('a note I typed here'));
});

test('a new priority lands at the end of the block, never in the next section', () => {
  const next = T.addChecklistItem(NOTE, T.WEEK_PRIORITIES_SENTINEL, '  Call the  lab  ', T.WEEK_PRIORITIES_SECTION);
  const lines = next.split('\n');
  const at = lines.indexOf('- [ ] Call the lab');
  assert.ok(at > lines.indexOf('- [x] Book the sleep lab follow-up'), 'after the last priority');
  assert.ok(at < lines.indexOf('## Daily highlights'), 'and before the next heading');
  assert.equal(T.addChecklistItem(NOTE, T.WEEK_PRIORITIES_SENTINEL, '   ', T.WEEK_PRIORITIES_SECTION), NOTE,
    'a blank priority is a row nobody can act on');
});

test('a note with no priorities block gains one, header and all', () => {
  const bare = '---\ntype: planner-week\nweek: 2026-W38\n---\n';
  const next = T.addChecklistItem(bare, T.WEEK_PRIORITIES_SENTINEL, 'First one', T.WEEK_PRIORITIES_SECTION);
  assert.match(next, /## Weekly priorities\n<!-- weekly-priorities: schema=checklist -->\n- \[ ] First one/);
  assert.ok(next.startsWith(bare), 'what was there is still there, byte for byte');
});

/* ---- the highlights table ----------------------------------------------- */

test('setting the sentence keeps the marker; marking keeps the sentence', () => {
  const said = T.weekHighlightAfterSet(NOTE, '2026-09-14', 'Paco review call, part two');
  assert.match(said, /\| 2026-09-14 \| Paco review call, part two \| Y \|/, 'the Y survived the words');
  const marked = T.weekHighlightAfterMark(NOTE, '2026-09-15', 'Y');
  assert.match(marked, /\| 2026-09-15 \| Record episode 3 \| Y \|/, 'the words survived the mark');
});

test('a day with no row yet gains one, in place, newest on top', () => {
  const next = T.weekHighlightAfterSet(NOTE, '2026-09-16', 'Ship it');
  const rows = T.weekHighlights(next);
  assert.deepEqual(rows[0], { date: '2026-09-16', text: 'Ship it', done: '_' });
  assert.equal(rows.length, 3, 'one row per date, and the other two are untouched');
});

test('an unknown marker reads as pending, and the marker set is the habit log\'s', () => {
  assert.deepEqual(T.WEEK_HIGHLIGHT_MARKERS, ['Y', 'N', '_']);
  const next = T.weekHighlightAfterMark(NOTE, '2026-09-15', 'maybe');
  assert.match(next, /\| 2026-09-15 \| Record episode 3 \| _ \|/);
  assert.equal(T.markerState('Y'), 'done');
  assert.equal(T.markerState('N'), 'missed');
  assert.equal(T.markerState('_'), 'pending');
});

test('a pipe or a newline in the sentence cannot break the row', () => {
  assert.equal(T.highlightCellText('a | b\nc'), 'a b c');
  const next = T.weekHighlightAfterSet(NOTE, '2026-09-15', 'call | email\nthen ship');
  const row = T.weekHighlights(next).find((r) => r.date === '2026-09-15');
  assert.equal(row.text, 'call email then ship');
  assert.equal(row.done, '_', 'and the marker is still the marker');
});

test('CRLF survives every write', () => {
  const crlf = NOTE.replace(/\n/g, '\r\n');
  for (const next of [
    T.toggleChecklistItem(crlf, T.WEEK_PRIORITIES_SENTINEL, 0),
    T.addChecklistItem(crlf, T.WEEK_PRIORITIES_SENTINEL, 'Another', T.WEEK_PRIORITIES_SECTION),
    T.weekHighlightAfterSet(crlf, '2026-09-16', 'Ship it'),
    T.weekHighlightAfterMark(crlf, '2026-09-15', 'Y'),
  ]) {
    assert.ok(!/[^\r]\n/.test(next), 'a write must not leave a bare LF in a CRLF file');
  }
});

/* ---- the note on disk --------------------------------------------------- */

test('the template is the frontmatter of record and nothing else', () => {
  const t = T.weekTemplate('2026-W38', '2026-09-14T07:00:00Z');
  assert.match(t, /^---\ntype: planner-week\nweek: 2026-W38\ncreated_at: 2026-09-14T07:00:00Z\ntags: \[]\n---\n/);
  // No week_start and no week_end: both derive from `week`, and a derivable
  // fact is not a field.
  assert.ok(!/week_start|week_end/.test(t));
  // No seeded rows: an empty week leaves no row nobody wrote.
  const week = T.weekFromNote({ type: 'planner-week', week: '2026-W38' }, t, 'Weeks/2026-W38.md');
  assert.deepEqual(week.highlights, []);
});

test('THE ASK: the week writes refuse a path outside the planner Weeks folder', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const guard = main.slice(main.indexOf('  weekFile(iso) {'), main.indexOf('  async ensureWeekNote('));
  assert.match(guard, /if \(!isWeekKey\(iso\)\)/, 'the week-key shape is checked first');
  assert.match(guard, /if \(!this\.paths\(\)\.isWeek\(path\)\) throw new Error/, 'then the folder boundary');
  assert.ok(guard.indexOf('isWeek') < guard.indexOf('getAbstractFileByPath'),
    'the boundary is checked before any file is looked up');
  // Every write goes through the one body writer, which goes through the one
  // file getter: nothing writes a week note by another road.
  for (const name of ['togglePriority', 'addPriority', 'setHighlight', 'markHighlight']) {
    const body = main.slice(main.indexOf(`  async ${name}(`), main.indexOf(`  async ${name}(`) + 400);
    assert.match(body, /this\.writeWeekBody\(/, `${name} goes through writeWeekBody`);
  }
  assert.match(main, /await this\.app\.vault\.process\(file, \(data\) => fn\(data\)\);/,
    'every week body write runs inside vault.process');
  // Creation never overwrites.
  const ensure = main.slice(main.indexOf('  async ensureWeekNote('), main.indexOf('  async readWeek('));
  assert.match(ensure, /const existing = this\.weekFile\(iso\);\n {4}if \(existing\) return existing;/);
});

test('the room is created with the others, and the view is registered', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  assert.match(main, /await mk\(p\.weeks\);/, 'ensureFolders creates Weeks/');
  assert.match(main, /this\.registerView\(WEEK_VIEW_TYPE/, 'the week view is registered');
  assert.match(main, /id: 'open-week'/, 'and reachable from the command palette');
  assert.equal(T.WEEK_VIEW_TYPE, 'icor-for-life-planner-week');
  const p = T.plannerPaths({ plannerFolder: '02 Planner' });
  assert.equal(p.weeks, '02 Planner/Weeks');
  assert.equal(p.weekNote('2026-W38'), '02 Planner/Weeks/2026-W38.md');
  assert.equal(p.isWeek('02 Planner/Weeks/2026-W38.md'), true);
  assert.equal(p.isWeek('02 Planner/Habits/x.md'), false);
});

test('the week note is documented where the member reads', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /Weekly priorities/, 'the README names the week note');
  assert.match(readme, /Daily highlights/);
});

/* ---- the week-start setting: Monday, Saturday, Sunday --------------------- */

test('THE SETTING: Monday is the default and both surfaces read the one value', () => {
  assert.equal(T.DEFAULT_SETTINGS.weekStart, 'monday');
  assert.equal(T.normalizeWeekStart('friday'), 'monday', 'an unknown value falls back to Monday');
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  assert.match(main, /\.setName\('Week starts on'\)/, 'the settings tab offers it');
  assert.match(main, /weekKeyFor\(day\) \{ return weekKeyOf\(day, this\.settings\.weekStart\); \}/);
  const board = main.slice(main.indexOf('class PlannerBoardView'), main.indexOf('class PlannerWeekView'));
  assert.ok(!/weekStart = mondayOf\(|setWeek\(mondayOf\(|=== mondayOf\(/.test(board), 'the board no longer hardcodes Monday');
});

test('Monday keeps the ISO name, so no existing week note moves', () => {
  assert.equal(T.weekKeyOf('2026-09-15', 'monday'), '2026-W38');
  assert.equal(T.weekKeyOf('2026-09-20', 'monday'), '2026-W38');
  assert.equal(T.weekStartOf('2026-09-20', 'monday'), '2026-09-14');
  assert.deepEqual(T.weekKeyDays('2026-W38'), T.isoWeekDays('2026-W38'));
  const t = T.weekTemplate('2026-W38', '2026-09-14T07:00:00Z');
  assert.match(t, /\nweek: 2026-W38\n/);
  assert.ok(!/week_start/.test(t));
  const week = T.weekFromNote({ type: 'planner-week', week: '2026-W38' }, t, 'Weeks/2026-W38.md');
  assert.equal(week.week, '2026-W38');
  assert.equal(week.monday, '2026-09-14');
});

test('Saturday and Sunday weeks are named by the date that starts them', () => {
  assert.equal(T.weekStartOf('2026-09-19', 'saturday'), '2026-09-19');
  assert.equal(T.weekStartOf('2026-09-25', 'saturday'), '2026-09-19', 'Friday closes it');
  assert.equal(T.weekStartOf('2026-09-26', 'saturday'), '2026-09-26');
  assert.equal(T.weekStartOf('2026-09-20', 'sunday'), '2026-09-20');
  assert.equal(T.weekStartOf('2026-09-26', 'sunday'), '2026-09-20', 'Saturday closes it');
  assert.equal(T.weekKeyOf('2026-09-23', 'saturday'), '2026-09-19');
  assert.equal(T.weekKeyOf('2026-09-23', 'sunday'), '2026-09-20');
  const t = T.weekTemplate('2026-09-19', '2026-09-19T07:00:00Z');
  assert.match(t, /\nweek_start: 2026-09-19\n/);
  assert.ok(!/\nweek: /.test(t));
  const week = T.weekFromNote({ type: 'planner-week', week_start: '2026-09-19' }, t, 'Weeks/2026-09-19.md');
  assert.equal(week.week, '2026-09-19');
  assert.equal(week.weekStart, '2026-09-19');
  const byName = T.weekFromNote({ type: 'planner-week' }, t, 'Weeks/2026-09-19.md');
  assert.equal(byName.week, '2026-09-19', 'a missing field falls back to the file name');
});

test('a 7-day grid in every setting, and the Sat->Sun->Mon boundary does not drift', () => {
  for (const [start, first] of [['monday', '2026-09-14'], ['saturday', '2026-09-19'], ['sunday', '2026-09-20']]) {
    const key = T.weekKeyOf(first, start);
    const days = T.weekKeyDays(key);
    assert.equal(days.length, 7, `${start}: seven days`);
    assert.equal(days[0], first, `${start}: opens on the start day`);
    assert.equal(T.weekKeyOf(days[6], start), key, `${start}: the last day is the same week`);
    assert.notEqual(T.weekKeyOf(T.addDays(days[6], 1), start), key, `${start}: the next day is the next week`);
  }
  const sat = ['2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28'].map((d) => T.weekKeyOf(d, 'saturday'));
  assert.deepEqual(sat, ['2026-09-19', '2026-09-26', '2026-09-26', '2026-09-26']);
  assert.equal(T.weekKeyOf('2027-01-01', 'saturday'), '2026-12-26', 'a year boundary is just another Saturday');
});

test('the weekend hides by the calendar, not by column position', () => {
  assert.equal(T.isWeekendDay('2026-09-19'), true, 'Saturday');
  assert.equal(T.isWeekendDay('2026-09-20'), true, 'Sunday');
  assert.equal(T.isWeekendDay('2026-09-21'), false);
  const shown = T.weekDays('2026-09-19').filter((d) => !T.isWeekendDay(d));
  assert.deepEqual(shown, ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25'],
    'a Saturday week without the weekend is Monday to Friday, five days, not Saturday to Wednesday');
});

test('an existing note is found under either name and never duplicated', () => {
  assert.deepEqual(T.weekKeyAliases('2026-W38'), ['2026-W38', '2026-09-14']);
  assert.deepEqual(T.weekKeyAliases('2026-09-14'), ['2026-09-14', '2026-W38']);
  assert.deepEqual(T.weekKeyAliases('2026-09-19'), ['2026-09-19'], 'a Saturday week has one name');
  assert.deepEqual(T.weekKeyAliases('nonsense'), []);
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const body = main.slice(main.indexOf('  weekFile(iso) {'), main.indexOf('  weekKeyFor(day)'));
  assert.match(body, /for \(const key of weekKeyAliases\(iso\)\)/, 'every alias is looked up');
  assert.ok(!/rename/i.test(main.slice(main.indexOf('  weekFile(iso) {'), main.indexOf('  async readWeek('))),
    'no week note is renamed');
});

test('a malformed or impossible key is refused', () => {
  assert.equal(T.isWeekKey('2025-W53'), false, 'a year without a week 53');
  assert.equal(T.isWeekKey('2026-02-30'), false, 'a date that does not exist');
  assert.equal(T.isWeekKey('2026-W38'), true);
  assert.equal(T.isWeekKey('2026-09-19'), true);
  assert.equal(T.weekKeyStart('2026-W38'), '2026-09-14');
  assert.equal(T.weekKeyStart('x'), null);
});
