/* Weeks: the weekly priorities and the daily highlights of one
 * Saturday-anchored week.
 *
 * One note per week at <planner folder>/Weeks/YYYY-MM-DD.md, named by the
 * ISO date of the Saturday that starts it, `type: planner-week`, two
 * sentinel blocks in the body. Everything the plugin writes into that note
 * is a pure function of the bytes already there, so every rule is
 * assertable on a string: the two names ruled on 2026-09-15, the byte
 * preservation outside the one line a write touches, and the
 * Saturday-anchored arithmetic that decides which file is this week's.
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
  'week_start: 2026-09-19',
  'created_at: 2026-09-19T07:00:00Z',
  'tags: []',
  '---',
  '',
  '# 2026-09-19',
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
  '| 2026-09-20 | Record episode 3 | _ |',
  '| 2026-09-19 | Paco review call | Y |',
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
  const template = T.weekTemplate('2026-09-19', '2026-09-19T07:00:00Z');
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

/* ---- Saturday-anchored week arithmetic ----------------------------------- */

test('the week-start of a day, Saturday through Friday', () => {
  // 2026-09-19 is a Saturday; 2026-09-25 is the Friday that closes its week.
  assert.equal(T.weekStartOf('2026-09-19'), '2026-09-19', 'Saturday opens the week');
  assert.equal(T.weekStartOf('2026-09-20'), '2026-09-19', 'Sunday belongs to the Saturday before it');
  assert.equal(T.weekStartOf('2026-09-21'), '2026-09-19', 'Monday belongs to the same week');
  assert.equal(T.weekStartOf('2026-09-25'), '2026-09-19', 'Friday closes it');
  assert.equal(T.weekStartOf('2026-09-26'), '2026-09-26', 'the next Saturday opens the next week');
  assert.equal(T.weekOfDays('2026-09-19').length, 7);
  assert.deepEqual(T.weekOfDays('2026-09-19'), [
    '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22',
    '2026-09-23', '2026-09-24', '2026-09-25',
  ]);
});

test('the Sat->Sun->Mon boundary crossing does not drift the week', () => {
  // A run across the boundary: Friday still the old week, Saturday the new
  // one, and every day in between (Sun, Mon) the new week too.
  assert.equal(T.weekStartOf('2026-09-25'), '2026-09-19', 'Friday: old week');
  assert.equal(T.weekStartOf('2026-09-26'), '2026-09-26', 'Saturday: new week opens');
  assert.equal(T.weekStartOf('2026-09-27'), '2026-09-26', 'Sunday: still the new week');
  assert.equal(T.weekStartOf('2026-09-28'), '2026-09-26', 'Monday: still the new week');
  assert.notEqual(T.weekStartOf('2026-09-25'), T.weekStartOf('2026-09-26'),
    'the last day of one week and the first day of the next are different weeks');
});

test('a year boundary is just another Saturday, no special case', () => {
  // 2027-01-01 is a Friday; its week started Saturday 2026-12-26.
  assert.equal(T.weekStartOf('2027-01-01'), '2026-12-26');
  assert.equal(T.weekOfDays('2026-12-26')[6], '2027-01-01');
});

test('every calendar date has a week; only shape and weekday can fail', () => {
  // Every calendar date belongs to exactly one Saturday-anchored week, so
  // unlike an ISO week number there is no "week the year does not have".
  assert.equal(T.isValidWeekStart('2026-09-19'), '2026-09-19', 'a real Saturday is valid');
  assert.equal(T.isValidWeekStart('2026-09-20'), null, 'a Sunday is not a week-start');
  assert.equal(T.isValidWeekStart('not a date'), null);
  assert.equal(T.isValidWeekStart(null), null);
  assert.equal(T.weekStartOf('rubbish'), null);
  assert.deepEqual(T.weekOfDays('2026-09-20'), [], 'a non-Saturday week-start has no days');
});

/* ---- reading the note --------------------------------------------------- */

test('the note reads back as its two blocks', () => {
  const week = T.weekFromNote({ type: 'planner-week', week_start: '2026-09-19' }, NOTE, '02 Planner/Weeks/2026-09-19.md');
  assert.equal(week.week, '2026-09-19');
  assert.equal(week.weekStart, '2026-09-19');
  assert.deepEqual(week.priorities.map((p) => [p.index, p.done, p.text]), [
    [0, false, 'Ship the explainer video'],
    [1, true, 'Book the sleep lab follow-up'],
  ]);
  assert.equal(week.doneCount, 1);
  assert.deepEqual(week.highlights, [
    { date: '2026-09-20', text: 'Record episode 3', done: '_' },
    { date: '2026-09-19', text: 'Paco review call', done: 'Y' },
  ]);
  assert.equal(T.weekPriorityProgress(week), '1 of 2 done');
});

test('any other note is not a week', () => {
  assert.equal(T.weekFromNote({ type: 'planner-item' }, NOTE, 'x.md'), null);
  assert.equal(T.weekFromNote(null, NOTE, 'x.md'), null);
  // No usable week anywhere: the field is malformed and so is the file name.
  assert.equal(T.weekFromNote({ type: 'planner-week', week_start: 'soon' }, NOTE, 'Weeks/later.md'), null);
  // A malformed field falls back to the file name, which IS the week.
  const fallback = T.weekFromNote({ type: 'planner-week' }, NOTE, '02 Planner/Weeks/2026-09-19.md');
  assert.equal(fallback.week, '2026-09-19');
});

test('an empty week is an empty week', () => {
  const empty = T.weekTemplate('2026-09-19', '2026-09-19T07:00:00Z');
  const week = T.weekFromNote({ type: 'planner-week', week_start: '2026-09-19' }, empty, '02 Planner/Weeks/2026-09-19.md');
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
  const bare = '---\ntype: planner-week\nweek_start: 2026-09-19\n---\n';
  const next = T.addChecklistItem(bare, T.WEEK_PRIORITIES_SENTINEL, 'First one', T.WEEK_PRIORITIES_SECTION);
  assert.match(next, /## Weekly priorities\n<!-- weekly-priorities: schema=checklist -->\n- \[ ] First one/);
  assert.ok(next.startsWith(bare), 'what was there is still there, byte for byte');
});

/* ---- the highlights table ----------------------------------------------- */

test('setting the sentence keeps the marker; marking keeps the sentence', () => {
  const said = T.weekHighlightAfterSet(NOTE, '2026-09-19', 'Paco review call, part two');
  assert.match(said, /\| 2026-09-19 \| Paco review call, part two \| Y \|/, 'the Y survived the words');
  const marked = T.weekHighlightAfterMark(NOTE, '2026-09-20', 'Y');
  assert.match(marked, /\| 2026-09-20 \| Record episode 3 \| Y \|/, 'the words survived the mark');
});

test('a day with no row yet gains one, in place, newest on top', () => {
  const next = T.weekHighlightAfterSet(NOTE, '2026-09-21', 'Ship it');
  const rows = T.weekHighlights(next);
  assert.deepEqual(rows[0], { date: '2026-09-21', text: 'Ship it', done: '_' });
  assert.equal(rows.length, 3, 'one row per date, and the other two are untouched');
});

test('an unknown marker reads as pending, and the marker set is the habit log\'s', () => {
  assert.deepEqual(T.WEEK_HIGHLIGHT_MARKERS, ['Y', 'N', '_']);
  const next = T.weekHighlightAfterMark(NOTE, '2026-09-20', 'maybe');
  assert.match(next, /\| 2026-09-20 \| Record episode 3 \| _ \|/);
  assert.equal(T.markerState('Y'), 'done');
  assert.equal(T.markerState('N'), 'missed');
  assert.equal(T.markerState('_'), 'pending');
});

test('a pipe or a newline in the sentence cannot break the row', () => {
  assert.equal(T.highlightCellText('a | b\nc'), 'a b c');
  const next = T.weekHighlightAfterSet(NOTE, '2026-09-20', 'call | email\nthen ship');
  const row = T.weekHighlights(next).find((r) => r.date === '2026-09-20');
  assert.equal(row.text, 'call email then ship');
  assert.equal(row.done, '_', 'and the marker is still the marker');
});

test('CRLF survives every write', () => {
  const crlf = NOTE.replace(/\n/g, '\r\n');
  for (const next of [
    T.toggleChecklistItem(crlf, T.WEEK_PRIORITIES_SENTINEL, 0),
    T.addChecklistItem(crlf, T.WEEK_PRIORITIES_SENTINEL, 'Another', T.WEEK_PRIORITIES_SECTION),
    T.weekHighlightAfterSet(crlf, '2026-09-21', 'Ship it'),
    T.weekHighlightAfterMark(crlf, '2026-09-20', 'Y'),
  ]) {
    assert.ok(!/[^\r]\n/.test(next), 'a write must not leave a bare LF in a CRLF file');
  }
});

/* ---- the note on disk --------------------------------------------------- */

test('the template is the frontmatter of record and nothing else', () => {
  const t = T.weekTemplate('2026-09-19', '2026-09-19T07:00:00Z');
  assert.match(t, /^---\ntype: planner-week\nweek_start: 2026-09-19\ncreated_at: 2026-09-19T07:00:00Z\ntags: \[]\n---\n/);
  // No week_end: it derives from week_start, and a derivable fact is not a
  // field.
  assert.ok(!/week_end/.test(t));
  // No seeded rows: an empty week leaves no row nobody wrote.
  const week = T.weekFromNote({ type: 'planner-week', week_start: '2026-09-19' }, t, 'Weeks/2026-09-19.md');
  assert.deepEqual(week.highlights, []);
});

test('THE ASK: the week writes refuse a path outside the planner Weeks folder', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const guard = main.slice(main.indexOf('  weekFile(iso) {'), main.indexOf('  async ensureWeekNote('));
  assert.match(guard, /if \(!WEEK_ISO_RE\.test/, 'the ISO shape is checked first');
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
  assert.equal(p.weekNote('2026-09-19'), '02 Planner/Weeks/2026-09-19.md');
  assert.equal(p.isWeek('02 Planner/Weeks/2026-09-19.md'), true);
  assert.equal(p.isWeek('02 Planner/Habits/x.md'), false);
});

test('the week note is documented where the member reads', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /Weekly priorities/, 'the README names the week note');
  assert.match(readme, /Daily highlights/);
});
