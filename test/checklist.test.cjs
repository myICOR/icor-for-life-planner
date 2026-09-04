/* The shared checklist model and the sentinel log table.
 *
 * Three consumers will check things off inside a card (routine steps, habit
 * check-ins, subtasks) and all of them write a row into a markdown table in
 * the note body, under an HTML-comment sentinel. The table is also written
 * by hand and by agents in chat, so the two rules that matter are: the
 * parser reads whatever a person wrote, and the writer never touches a
 * line it was not asked to touch. Byte preservation is asserted, not
 * assumed: every fixture below is compared line by line after a write.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

// A streak-style table exactly as the vault's habit convention writes it,
// newest on top, with a note column that carries prose.
const STREAK = [
  '---',
  'name: Daily Scratchpad writing',
  'cadence: daily',
  '---',
  '',
  '# Daily Scratchpad writing',
  '',
  'Notes about the habit, kept as written.',
  '',
  '## Daily log',
  '<!-- habit-log: schema=streak -->',
  '| Date | Y/N | Note |',
  '|---|---|---|',
  '| 2026-09-03 | Y | evening, short |',
  '| 2026-09-02 | N |  |',
  '| 2026-09-01 | Y | long one |',
  '',
  'Trailing prose after the table.',
  '',
].join('\n');

// A process-style table: the third column is the trigger, oldest on top.
const PROCESS = [
  '## Log',
  '<!-- habit-log: schema=process -->',
  '| Date | Done | Trigger |',
  '| --- | --- | --- |',
  '| 2026-08-30 | Y | after coffee |',
  '| 2026-08-31 | _ |  |',
  '| 2026-09-01 | Y | after coffee |',
].join('\n');

// Hand-written markers, including the check mark and the G / R pair.
const MARKS = [
  '<!-- habit-log: schema=streak -->',
  '| Date | Y/N | Note |',
  '|---|---|---|',
  '| 2026-09-04 | ✓ | |',
  '| 2026-09-03 | G | |',
  '| 2026-09-02 | R | |',
  '| 2026-09-01 | \u2013 | dash day |',
].join('\n');

const lines = (s) => s.split('\n');

// Every line except `touched` must be byte-identical between a and b.
function assertUntouchedExcept(a, b, touched) {
  const la = lines(a);
  const lb = lines(b);
  assert.equal(lb.length, la.length + (touched.inserted ? 1 : 0), 'the line count moves by the insertion only');
  let j = 0;
  for (let i = 0; i < la.length; i++, j++) {
    if (touched.inserted && j === touched.inserted) j++;
    if (touched.replaced === i) continue;
    assert.equal(lb[j], la[i], `line ${i} changed and was not the touched line`);
  }
}

test('checklistModel normalises rows and states the progress as "n of m"', () => {
  assert.equal(typeof T.checklistModel, 'function');
  const m = T.checklistModel({ rows: [
    { id: 1, label: 'Water', checked: true },
    { id: 2, label: 'Journal' },
    { id: 3, label: 'Plan', checked: false, disabled: true, meta: 'TRAY' },
  ] });
  assert.equal(m.done, 1);
  assert.equal(m.total, 3);
  assert.equal(m.progressText, '1 of 3');
  assert.deepEqual(m.rows[0], { id: '1', label: 'Water', checked: true, disabled: false, missed: false, meta: null });
  assert.equal(m.rows[2].disabled, true);
  assert.equal(m.rows[2].meta, 'TRAY');
  assert.equal(T.checklistModel({}).progressText, '0 of 0');
  assert.equal(T.checklistProgressText(3, 5), '3 of 5');
});

test('the streak fixture parses: schema, header, three rows, newest on top', () => {
  const p = T.parseLogTable(STREAK, 'habit-log');
  assert.equal(p.found, true);
  assert.equal(p.schema, 'streak');
  assert.deepEqual(p.header, ['Date', 'Y/N', 'Note']);
  assert.equal(p.rows.length, 3);
  assert.deepEqual(p.rows[0], { line: 13, date: '2026-09-03', marker: 'Y', rest: ['evening, short'] });
  assert.deepEqual(p.rows[1].rest, ['']);
  assert.equal(p.direction, 'desc');
  assert.equal(p.start, 10);
  assert.equal(p.end, 16, 'the table ends at the blank line after the last row');
  assert.equal(T.logRowFor(p, '2026-09-01').rest[0], 'long one');
  assert.equal(T.logRowFor(p, '2026-09-09'), null);
});

test('the process fixture parses with a spaced separator, oldest on top', () => {
  const p = T.parseLogTable(PROCESS, 'habit-log');
  assert.equal(p.schema, 'process');
  assert.equal(p.rows.length, 3);
  assert.equal(p.direction, 'asc');
  assert.deepEqual(T.logRowFor(p, '2026-08-30').rest, ['after coffee']);
  assert.equal(T.logRowFor(p, '2026-08-31').marker, '_');
});

test('hand-written markers are carried as written and read by markerState', () => {
  const p = T.parseLogTable(MARKS, 'habit-log');
  assert.deepEqual(p.rows.map((r) => r.marker), ['✓', 'G', 'R', '\u2013']);
  assert.equal(T.markerState('✓'), 'done');
  assert.equal(T.markerState('G'), 'done');
  assert.equal(T.markerState('Y'), 'done');
  assert.equal(T.markerState('R'), 'missed');
  assert.equal(T.markerState('N'), 'missed');
  assert.equal(T.markerState('\u2013'), 'missed');
  assert.equal(T.markerState('_'), 'pending');
  assert.equal(T.markerState(''), 'pending');
  assert.equal(T.markerState('S'), 'skipped');
  assert.equal(T.markerState('3/5'), 'unknown');
});

test('a note without the sentinel is not found; a wrong sentinel name is not found either', () => {
  assert.equal(T.parseLogTable('# Nothing here\n', 'habit-log').found, false);
  assert.equal(T.parseLogTable(STREAK, 'routine-log').found, false);
});

test('ROUND TRIP: writing the cells a row already holds returns the body unchanged', () => {
  for (const [body, name, date, marker, rest] of [
    [STREAK, 'habit-log', '2026-09-03', 'Y', ['evening, short']],
    [PROCESS, 'habit-log', '2026-08-31', '_', ['']],
    [MARKS, 'habit-log', '2026-09-01', '\u2013', ['dash day']],
  ]) {
    assert.equal(T.upsertLogRow(body, name, { date, marker, rest }), body);
    // `rest` omitted keeps the existing trailing cells: still an identity.
    assert.equal(T.upsertLogRow(body, name, { date, marker }), body);
  }
});

test('replacing a row touches exactly that line', () => {
  const out = T.upsertLogRow(STREAK, 'habit-log', { date: '2026-09-02', marker: 'Y' });
  assertUntouchedExcept(STREAK, out, { replaced: 14 });
  assert.equal(lines(out)[14], '| 2026-09-02 | Y |  |');
  const p = T.parseLogTable(out, 'habit-log');
  assert.equal(T.logRowFor(p, '2026-09-02').marker, 'Y');
  assert.equal(p.rows.length, 3, 'a replace never adds a row');
});

test('a new row lands on top of a newest-on-top table and at the end of an oldest-on-top one', () => {
  const top = T.upsertLogRow(STREAK, 'habit-log', { date: '2026-09-04', marker: 'Y', rest: ['board'] });
  assertUntouchedExcept(STREAK, top, { inserted: 13 });
  assert.equal(lines(top)[13], '| 2026-09-04 | Y | board |');
  assert.equal(lines(top)[12], '|---|---|---|', 'right under the separator');

  const end = T.upsertLogRow(PROCESS, 'habit-log', { date: '2026-09-02', marker: 'Y', rest: ['after coffee'] });
  assertUntouchedExcept(PROCESS, end, { inserted: 7 });
  assert.equal(lines(end)[7], '| 2026-09-02 | Y | after coffee |');
});

test('a one-row table has no direction and is treated as newest on top', () => {
  const one = MARKS.split('\n').slice(0, 4).join('\n');
  assert.equal(T.parseLogTable(one, 'habit-log').direction, 'unknown');
  const out = T.upsertLogRow(one, 'habit-log', { date: '2026-09-05', marker: 'Y' });
  assert.equal(lines(out)[3], '| 2026-09-05 | Y |  |');
  assert.equal(lines(out)[4], '| 2026-09-04 | ✓ | |');
});

test('the writer pads the row to the header width', () => {
  const out = T.upsertLogRow(PROCESS, 'habit-log', { date: '2026-09-02', marker: 'Y' });
  assert.equal(lines(out)[7], '| 2026-09-02 | Y |  |');
});

test('a missing section is created with the exact sentinel and header asked for', () => {
  const body = '---\ntype: habit\ncadence: daily\n---\n\n# Walk\n';
  const out = T.upsertLogRow(body, 'habit-log', {
    date: '2026-09-04', marker: 'Y',
    createWith: { heading: '## Daily log', schema: 'streak', header: ['Date', 'Y/N', 'Note'] },
  });
  assert.ok(out.startsWith(body), 'the existing body is untouched');
  assert.equal(out.slice(body.length), [
    '',
    '## Daily log',
    '<!-- habit-log: schema=streak -->',
    '| Date | Y/N | Note |',
    '| --- | --- | --- |',
    '| 2026-09-04 | Y |  |',
    '',
  ].join('\n'));
  const p = T.parseLogTable(out, 'habit-log');
  assert.equal(p.found, true);
  assert.equal(p.schema, 'streak');
  assert.equal(T.logRowFor(p, '2026-09-04').marker, 'Y');
});

test('a missing section with nothing to create it from is an error, never a silent no-op', () => {
  assert.throws(() => T.upsertLogRow('# Walk\n', 'habit-log', { date: '2026-09-04', marker: 'Y' }), /habit-log/);
});

test('a sentinel with no table under it gets the table built right there', () => {
  const body = '## Log\n<!-- routine-log: schema=steps -->\n\nProse below.\n';
  const out = T.upsertLogRow(body, 'routine-log', {
    date: '2026-09-04', marker: '1/3', rest: ['2'],
    createWith: { heading: '## Log', schema: 'steps', header: ['Date', 'Done', 'Steps'] },
  });
  assert.equal(out, '## Log\n<!-- routine-log: schema=steps -->\n| Date | Done | Steps |\n| --- | --- | --- |\n| 2026-09-04 | 1/3 | 2 |\n\nProse below.\n');
});

test('CRLF bodies keep their line endings on every line, the new one included', () => {
  const crlf = STREAK.replace(/\n/g, '\r\n');
  const out = T.upsertLogRow(crlf, 'habit-log', { date: '2026-09-04', marker: 'Y' });
  assert.ok(!/[^\r]\n/.test(out), 'no bare LF appeared');
  assert.equal(out.split('\r\n')[13], '| 2026-09-04 | Y |  |');
  const rep = T.upsertLogRow(crlf, 'habit-log', { date: '2026-09-02', marker: 'Y' });
  assert.equal(rep.split('\r\n').length, crlf.split('\r\n').length);
  assert.equal(rep.split('\r\n')[14], '| 2026-09-02 | Y |  |');
  const made = T.upsertLogRow('# Walk\r\n', 'habit-log', {
    date: '2026-09-04', marker: 'Y', createWith: { heading: '## Log', schema: 'streak', header: ['Date', 'Y/N', 'Note'] },
  });
  assert.ok(!/[^\r]\n/.test(made), 'a created section follows the file\'s CRLF');
});

test('a duplicated date reads as its last row, and removal takes both', () => {
  const dup = MARKS + '\n| 2026-09-03 | N | corrected |';
  const p = T.parseLogTable(dup, 'habit-log');
  assert.equal(T.logRowFor(p, '2026-09-03').marker, 'N');
  const out = T.removeLogRow(dup, 'habit-log', '2026-09-03');
  assert.equal(T.parseLogTable(out, 'habit-log').rows.length, 3);
  assert.ok(!out.includes('2026-09-03'));
  assert.equal(T.removeLogRow(dup, 'habit-log', '2030-01-01'), dup, 'nothing to remove: unchanged');
});

test('a table that ends the file without a trailing newline still takes a row', () => {
  const out = T.upsertLogRow(PROCESS, 'habit-log', { date: '2026-09-03', marker: 'Y', rest: ['x'] });
  assert.ok(out.endsWith('| 2026-09-03 | Y | x |'));
});
