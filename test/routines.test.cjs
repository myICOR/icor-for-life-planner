/* Routines: a recurring block of steps at a time of day.
 *
 * The contract has three parts and each is gated here: the note (frontmatter
 * plus "## Steps" plus the routine-log table), the day's materialisation
 * (which routines occur, in which lane half, with which steps done), and the
 * placement in the lane sequence and the agenda beside events and tasks. The
 * write path is pure (a body in, a body out) so the day's row can be checked
 * to the byte. Nothing in sync may ever see a routine; that is asserted too.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./harness.cjs');

const FM = {
  type: 'planner-routine', name: 'Morning launch', routine_type: 'morning',
  start: '06:30', end: '07:30', weekdays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  active: true, created_at: '2026-09-04T09:00:00Z',
};

const BODY = [
  '---',
  'type: planner-routine',
  'name: Morning launch',
  '---',
  '',
  '# Morning launch',
  '',
  '## Steps',
  '- [ ] Water, 500 ml',
  '- [x] One journal page',
  '- [ ] Plan the day on the board',
  '',
  '## Log',
  '<!-- routine-log: schema=steps -->',
  '| Date | Done | Steps |',
  '|---|---|---|',
  '| 2026-09-04 | 3/3 | 1,2,3 |',
  '| 2026-09-03 | 1/3 | 2 |',
  '| 2026-09-02 | S |  |',
  '',
].join('\n');

const routine = (fm, body, p) => T.parseRoutineNote(Object.assign({}, FM, fm || {}), body == null ? BODY : body, p || '02 Planner/Routines/Morning launch.md');

test('a routine note parses to steps and a per-day log', () => {
  const r = routine();
  assert.equal(r.name, 'Morning launch');
  assert.equal(r.routineType, 'morning');
  assert.equal(r.start, '06:30');
  assert.equal(r.end, '07:30');
  assert.deepEqual(r.weekdays, ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.equal(r.active, true);
  assert.equal(r.createdAt, '2026-09-04T09:00:00Z');
  assert.deepEqual(r.steps, [
    { index: 1, label: 'Water, 500 ml' },
    { index: 2, label: 'One journal page' },
    { index: 3, label: 'Plan the day on the board' },
  ]);
  assert.equal(r.log.found, true);
  assert.equal(r.log.schema, 'steps');
  assert.equal(r.log.rows.length, 3);
  assert.equal(r.log.direction, 'desc');
});

test('any other note is null, and nothing in sync can see a routine', () => {
  assert.equal(T.parseRoutineNote({ type: 'planner-item', source: 'todoist', external_id: '1' }, BODY), null);
  assert.equal(T.parseRoutineNote(null, BODY), null);
  // The item reader refuses the type, which is what keeps collectItems,
  // reconcile and the push path blind to routine notes.
  assert.equal(T.itemFromFrontmatter(Object.assign({}, FM), '02 Planner/Routines/x.md', 'x'), null);
});

test('a step box in the definition is never treated as state', () => {
  // Step 2 is "- [x]" in the Steps list; a day with no row still has it unchecked.
  const r = routine();
  const occ = T.routineOccurrence(r, '2026-09-01', '13:00');
  assert.deepEqual(occ.steps.map((s) => s.done), [false, false, false]);
  assert.equal(occ.done, 0);
  assert.equal(occ.total, 3);
  assert.equal(occ.skipped, false);
});

test('the day\'s row supplies the checked steps, the count is derived from the indices', () => {
  const r = routine();
  const three = T.routineOccurrence(r, '2026-09-03', '13:00');
  assert.deepEqual(three.steps.map((s) => s.done), [false, true, false]);
  assert.equal(three.done, 1);
  const full = T.routineOccurrence(r, '2026-09-04', '13:00');
  assert.equal(full.done, 3);
  // A habit-style Y with no indices means every step; a fraction at total does too.
  assert.deepEqual(T.routineRowState({ marker: 'Y', rest: [''] }, 3).done, [1, 2, 3]);
  assert.deepEqual(T.routineRowState({ marker: '3/3', rest: [] }, 3).done, [1, 2, 3]);
  assert.deepEqual(T.routineRowState({ marker: '1/3', rest: [] }, 3).done, [], 'a partial count with no indices cannot be mapped');
  assert.deepEqual(T.routineRowState({ marker: '2/3', rest: ['9,2,1'] }, 3).done, [1, 2], 'out-of-range indices drop');
});

test('THE ASK: a Mon-Fri morning routine occurs on Monday and not on Sunday', () => {
  assert.equal(T.dayCode('2026-09-07'), 'mon');
  assert.equal(T.dayCode('2026-09-06'), 'sun');
  const r = routine();
  assert.equal(T.routineOccurrences([r], '2026-09-07', '13:00').length, 1);
  assert.equal(T.routineOccurrences([r], '2026-09-06', '13:00').length, 0);
  // an inactive routine never occurs; a routine with no weekdays never occurs
  assert.equal(T.routineOccurrences([routine({ active: false })], '2026-09-07', '13:00').length, 0);
  assert.equal(T.routineOccurrences([routine({ weekdays: [] })], '2026-09-07', '13:00').length, 0);
});

test('start before the split lands in AM, at or after it in PM', () => {
  assert.equal(T.routineHalf('06:30', '13:00'), 'am');
  assert.equal(T.routineHalf('13:00', '13:00'), 'pm');
  assert.equal(T.routineHalf('12:59', '13:00'), 'am');
  assert.equal(T.routineHalf('21:00', '13:00'), 'pm');
  const am = T.routineOccurrence(routine(), '2026-09-07', '13:00');
  assert.equal(am.half, 'am');
  assert.equal(am.startMin, 390);
  assert.equal(am.endMin, 450);
  const pm = T.routineOccurrence(routine({ routine_type: 'afternoon', start: '13:00', end: '13:30' }), '2026-09-07', '13:00');
  assert.equal(pm.half, 'pm');
  // the lunch start moves the split: 12:30 lunch puts a 12:45 routine in PM
  assert.equal(T.routineHalf('12:45', '12:30'), 'pm');
});

test('a missing or malformed time falls back to the type default, never to a crash', () => {
  const r = routine({ start: 'soon', end: null });
  assert.equal(r.start, null);
  const occ = T.routineOccurrence(r, '2026-09-07', '13:00', T.DEFAULT_SETTINGS.routineDefaults);
  assert.equal(occ.startMin, 390, 'the morning default');
  assert.equal(occ.endMin, 450);
  // an unquoted 06:30 read as sexagesimal minutes by a YAML dialect
  assert.equal(T.normalizeHM(390), '06:30');
  assert.equal(T.normalizeHM('6:05'), '06:05');
  assert.equal(T.normalizeHM('24:00'), null);
  assert.equal(T.normalizeHM('07:60'), null);
});

test('laneSequence orders event, routine, task on a tie', () => {
  const ev = { start: '2026-09-07T09:00:00', title: 'Standup' };
  const task = { path: 't.md', plannedOrder: 540 };
  const occ = T.routineOccurrence(routine({ start: '09:00', end: '09:30' }), '2026-09-07', '13:00');
  assert.equal(occ.startMin, 540);
  const seq = T.laneSequence([ev], [task], [occ]);
  assert.deepEqual(seq.map((e) => e.kind), ['event', 'routine', 'task']);
  assert.equal(seq[1].occ, occ, 'the occurrence passes through by reference');
  assert.equal(seq[1].path, occ.routine.path);
  assert.equal(seq[1].plannedOrder, 540);
  assert.deepEqual(T.LANE_KIND_RANK, { event: 0, routine: 1, task: 2 });
  // the two-argument form still works for every existing caller
  assert.deepEqual(T.laneSequence([ev], [task]).map((e) => e.kind), ['event', 'task']);
  // earlier start wins over kind
  const late = T.routineOccurrence(routine({ start: '10:00', end: '10:30' }), '2026-09-07', '13:00');
  assert.deepEqual(T.laneSequence([ev], [task], [late]).map((e) => e.kind), ['event', 'task', 'routine']);
});

test('agendaSections carries routines into the right half', () => {
  const today = '2026-09-07';
  const am = T.routineOccurrence(routine(), today, '13:00');
  const pm = T.routineOccurrence(routine({ routine_type: 'evening', start: '21:00', end: '21:45' }), today, '13:00');
  const other = T.routineOccurrence(routine(), '2026-09-08', '13:00');
  const model = T.agendaSections([], [], today, [am, pm, other]);
  assert.deepEqual(model.am.map((e) => e.kind), ['routine']);
  assert.equal(model.am[0].occ, am);
  assert.deepEqual(model.pm.map((e) => e.kind), ['routine']);
  assert.equal(model.pm[0].occ, pm);
  // the three-argument form still works
  assert.deepEqual(T.agendaSections([], [], today).am, []);
});

test('a skipped day is a ghost, a full day is done, an empty routine is neither', () => {
  const r = routine();
  assert.deepEqual(T.routineCardState(T.routineOccurrence(r, '2026-09-02', '13:00')), { ghost: true, done: false });
  assert.deepEqual(T.routineCardState(T.routineOccurrence(r, '2026-09-04', '13:00')), { ghost: false, done: true });
  assert.deepEqual(T.routineCardState(T.routineOccurrence(r, '2026-09-03', '13:00')), { ghost: false, done: false });
  const none = routine({}, BODY.replace(/- \[[ x]\] .*\n/g, ''));
  assert.equal(none.steps.length, 0);
  assert.deepEqual(T.routineCardState(T.routineOccurrence(none, '2026-09-07', '13:00')), { ghost: false, done: false });
});

test('the kicker names the type and the time, never a colour', () => {
  const occ = T.routineOccurrence(routine(), '2026-09-07', '13:00');
  assert.equal(T.routineKicker(occ), 'MORNING ROUTINE');
  assert.equal(T.routineTimeLabel(occ), '06:30 - 07:30');
});

test('checking a step writes the day\'s row with the indices and the recomputed count', () => {
  // no row for the day: a new one lands on top (newest-on-top table)
  const one = T.routineLogAfterStep(BODY, '2026-09-05', 2, true, 3);
  const rows = T.parseLogTable(one, 'routine-log').rows;
  assert.deepEqual([rows[0].date, rows[0].marker, rows[0].rest], ['2026-09-05', '1/3', ['2']]);
  assert.equal(rows.length, 4);
  // a second step on the same day extends the same row, in index order
  const two = T.routineLogAfterStep(one, '2026-09-05', 1, true, 3);
  const row2 = T.logRowFor(T.parseLogTable(two, 'routine-log'), '2026-09-05');
  assert.deepEqual([row2.marker, row2.rest], ['2/3', ['1,2']]);
  // unchecking removes the index, the row stays as the record of the day
  const back = T.routineLogAfterStep(two, '2026-09-05', 1, false, 3);
  const row3 = T.logRowFor(T.parseLogTable(back, 'routine-log'), '2026-09-05');
  assert.deepEqual([row3.marker, row3.rest], ['1/3', ['2']]);
  // untouched lines keep their bytes
  const before = BODY.split('\n');
  const after = back.split('\n');
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, 16), before.slice(0, 16));
  assert.deepEqual(after.slice(17), before.slice(16));
});

test('skip writes S, reset and unskip delete the row', () => {
  const skipped = T.routineLogSkipped(BODY, '2026-09-05');
  const row = T.logRowFor(T.parseLogTable(skipped, 'routine-log'), '2026-09-05');
  assert.equal(row.marker, 'S');
  assert.equal(T.routineRowState(row, 3).skipped, true);
  const reset = T.routineLogReset(skipped, '2026-09-05');
  assert.equal(reset, BODY, 'reset returns the body to its prior bytes');
  assert.equal(T.routineLogReset(BODY, '2026-09-02').includes('| 2026-09-02 |'), false);
});

test('a note without a log section gets one on the first check, in the contract shape', () => {
  const bare = BODY.split('\n## Log')[0] + '\n';
  const out = T.routineLogAfterStep(bare, '2026-09-05', 3, true, 3);
  assert.ok(out.includes('\n## Log\n<!-- routine-log: schema=steps -->\n| Date | Done | Steps |\n| --- | --- | --- |\n| 2026-09-05 | 1/3 | 3 |\n'));
  assert.deepEqual(T.ROUTINE_LOG_SECTION, { heading: '## Log', schema: 'steps', header: ['Date', 'Done', 'Steps'] });
  assert.equal(T.ROUTINE_LOG_SENTINEL, 'routine-log');
});

test('the template writes every contract field', () => {
  const text = T.routineTemplate('Morning launch', 'morning', ['mon', 'tue', 'wed', 'thu', 'fri'],
    T.DEFAULT_SETTINGS.routineDefaults, { steps: ['Water, 500 ml', 'One journal page', 'Plan the day on the board'], nowIso: '2026-09-04T09:00:00Z' });
  const fmBlock = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(fmBlock, 'a frontmatter block');
  const fmLines = fmBlock[1].split('\n');
  assert.deepEqual(fmLines, [
    'type: planner-routine',
    'name: "Morning launch"',
    'routine_type: morning',
    'start: "06:30"',
    'end: "07:30"',
    'weekdays: [mon, tue, wed, thu, fri]',
    'active: true',
    'created_at: 2026-09-04T09:00:00Z',
  ]);
  assert.ok(text.includes('\n# Morning launch\n'));
  assert.ok(text.includes('\n## Steps\n- [ ] Water, 500 ml\n- [ ] One journal page\n- [ ] Plan the day on the board\n'));
  assert.ok(text.includes('\n## Log\n<!-- routine-log: schema=steps -->\n| Date | Done | Steps |\n| --- | --- | --- |\n'));
  // and the template parses back through the reader it is written for
  const fm = {};
  for (const l of fmLines) { const m = /^([a-z_]+): (.*)$/.exec(l); fm[m[1]] = m[2]; }
  fm.weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'];
  fm.active = true;
  const r = T.parseRoutineNote(fm, text, '02 Planner/Routines/Morning launch.md');
  assert.equal(r.steps.length, 3);
  assert.equal(r.log.found, true);
  assert.equal(r.log.rows.length, 0);
  // the pair form for the times, an evening type, a placeholder step
  const ev = T.routineTemplate('Wind down', 'evening', 'sat, sun', { start: '21:00', end: '21:45' }, { nowIso: 'x' });
  assert.ok(ev.includes('routine_type: evening\nstart: "21:00"\nend: "21:45"\nweekdays: [sat, sun]\n'));
  assert.ok(ev.includes('- [ ] First step\n'));
});

test('the New routine checks speak in sentences', () => {
  assert.deepEqual(T.validateRoutineInput({ name: ' ', start: '06:30', end: '07:30', weekdays: ['mon'] }), { ok: false, error: 'Give the routine a name.' });
  assert.equal(T.validateRoutineInput({ name: 'x', start: '6', end: '07:30', weekdays: ['mon'] }).error, 'Times are HH:MM, for example 06:30.');
  assert.equal(T.validateRoutineInput({ name: 'x', start: '07:30', end: '07:30', weekdays: ['mon'] }).error, 'The end must be after the start.');
  assert.equal(T.validateRoutineInput({ name: 'x', start: '06:30', end: '07:30', weekdays: [] }).error, 'Pick at least one weekday.');
  assert.deepEqual(T.validateRoutineInput({ name: 'x', start: '06:30', end: '07:30', weekdays: ['mon'] }), { ok: true, error: null });
});

test('weekday codes normalise to the canonical seven, in order, once', () => {
  assert.deepEqual(T.WEEKDAY_CODES, ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
  assert.deepEqual(T.normalizeWeekdays(['Sunday', 'MON', 'mon', 'x']), ['mon', 'sun']);
  assert.deepEqual(T.normalizeWeekdays('fri, wed'), ['wed', 'fri']);
  assert.deepEqual(T.normalizeWeekdays(null), []);
});

test('the settings: defaults, a partial routineDefaults merges, an empty weekday list is honoured', () => {
  const s = T.DEFAULT_SETTINGS;
  assert.equal(s.routinesEnabled, true);
  assert.deepEqual(s.routineDefaults, {
    morning: { start: '06:30', end: '07:30' },
    afternoon: { start: '13:00', end: '13:30' },
    evening: { start: '21:00', end: '21:45' },
  });
  assert.deepEqual(s.routineWeekdaysDefault, ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.deepEqual(T.routineDefaultsOf({ routineDefaults: { evening: { start: '22:00' }, morning: { end: 'nope' } } }), {
    morning: { start: '06:30', end: '07:30' },
    afternoon: { start: '13:00', end: '13:30' },
    evening: { start: '22:00', end: '21:45' },
  });
  assert.deepEqual(T.routineWeekdaysDefaultOf({}), ['mon', 'tue', 'wed', 'thu', 'fri']);
  assert.deepEqual(T.routineWeekdaysDefaultOf({ routineWeekdaysDefault: [] }), [], 'cleared stays cleared');
  assert.deepEqual(T.routineWeekdaysDefaultOf({ routineWeekdaysDefault: ['sat'] }), ['sat']);
  assert.deepEqual(T.ROUTINE_TYPES, ['morning', 'afternoon', 'evening']);
});

test('the routines folder derives from the planner folder and is created with the rest', () => {
  const p = T.plannerPaths({ plannerFolder: 'Planner' });
  assert.equal(p.routines, 'Planner/Routines');
  assert.equal(p.isRoutine('Planner/Routines/x.md'), true);
  assert.equal(p.isRoutine('Planner/Routines2/x.md'), false);
  assert.equal(p.isRoutine('Planner/Todoist/x.md'), false);
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  assert.ok(/await mk\(p\.routines\);/.test(main), 'ensureFolders creates Routines/');
});

test('SOURCE: the card is not draggable, the drop line counts it as a position, sync never pushes for it', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const card = main.slice(main.indexOf('function renderRoutineCard('), main.indexOf('function showRoutineMenu('));
  assert.ok(/card\.draggable = false;/.test(card), 'card must match /card\.draggable = false;/');
  assert.ok(!/dragstart/.test(card), 'no drag handler on a routine card');
  assert.ok(/renderChecklist\(card, model/.test(card), 'the steps are the shared checklist');
  // the drop-line selector treats a routine block as a position, ghost or not
  assert.ok(/querySelectorAll\('\.iplan-event, \.iplan-card\.iplan-routine, \.iplan-card:not\(\.is-dragging\):not\(\.is-ghost\)'\)/.test(main), 'main must match /querySelectorAll\(\'\.iplan-event, \.iplan-card\.iplan-routine, \.iplan-card:not\(\.is-dragging\):not\(\.is-ghost\)\'\)/');
  // the push check is never scheduled for a routine note
  assert.ok(/if \(inside\(file\) && !this\.paths\(\)\.isRoutine\(file\.path\)\) this\.schedulePushCheck\(file\.path\);/.test(main), 'main must match /if \(inside\(file\) && !this\.paths\(\)\.isRoutine\(file\.path\)\) this\.schedulePushCheck\(file\.path\);/');
  // every log write runs inside vault.process
  assert.ok(/await this\.app\.vault\.process\(file, fn\);/.test(main), 'main must match /await this\.app\.vault\.process\(file, fn\);/');
  for (const name of ['toggleRoutineStep', 'skipRoutine', 'unskipRoutine', 'resetRoutineDay']) {
    assert.ok(new RegExp(`${name}\\([^)]*\\) \\{\\s*return this\\.processRoutine\\(`).test(main), `${name} goes through processRoutine`);
  }
  // the menu offers exactly the four actions
  const menu = main.slice(main.indexOf('function showRoutineMenu('), main.indexOf('function wireDropLane('));
  for (const title of ['Skip today', 'Unskip today', 'Reset today', 'Open routine note']) {
    assert.ok(menu.includes(`setTitle('${title}')`), `menu carries ${title}`);
  }
  // the command exists
  assert.ok(/addCommand\(\{ id: 'new-routine', name: 'New routine'/.test(main), 'main must match /addCommand\(\{ id: \'new-routine\', name: \'New routine\'/');
});

test('SOURCE: rows are buttons with role=checkbox, disabled rows keep their tab stop', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const block = main.slice(main.indexOf('function renderChecklist('), main.indexOf('const LOG_DATE_RE'));
  assert.ok(/document\.createElement\('button'\)/.test(block), 'block must match /document\.createElement\(\'button\'\)/');
  assert.ok(/row\.setAttribute\('role', 'checkbox'\)/.test(block), 'block must match /row\.setAttribute\(\'role\', \'checkbox\'\)/');
  assert.ok(/'aria-checked'/.test(block), 'block must match /\'aria-checked\'/');
  assert.ok(/row\.setAttribute\('aria-disabled', 'true'\)/.test(block), 'block must match /row\.setAttribute\(\'aria-disabled\', \'true\'\)/');
  assert.ok(!/row\.disabled = true/.test(block), 'aria-disabled, not the disabled attribute: the row stays reachable');
  assert.ok(/check\.className = 'iplan-check'/.test(block), 'the check control is the task card\'s');
  assert.ok(/new Notice\(`Planner: could not save the check/.test(block), 'a failed write says so once');
});
