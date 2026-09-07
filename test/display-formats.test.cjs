/* Dates and times follow the person's format (0.11.0).
 *
 * A member asked for the board to adopt the Time format and Date format
 * from Obsidian's Templates settings (18:15 as 6:15 PM, 07-09 for the 7th
 * of September). The rule: a format the person set is used exactly; a
 * blank one keeps the compact shapes every earlier release drew, byte for
 * byte, so nobody who never touched the setting sees the board change.
 * The planner's own two settings win over the Templates value when filled.
 * One resolver decides; the three formatters consume it; the gate at the
 * end asserts no call site builds a date or time string by hand.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

// 18:15 on Monday 2026-09-07, as a local instant: the formatter reads
// local hours, so the ISO string is built from local time on purpose.
const AT_1815 = new Date(2026, 8, 7, 18, 15).toISOString();
const AT_0905 = new Date(2026, 8, 7, 9, 5).toISOString();
const DAY = '2026-09-07';

const withFormats = (date, time, fn) => {
  T.setDisplayFormatSource(() => ({ date, time }));
  try { fn(); } finally { T.setDisplayFormatSource(null); }
};

test('THE ASK: a blank format keeps the compact shapes byte-identical', () => {
  T.setDisplayFormatSource(null);
  assert.equal(T.fmtDayNum(DAY), '7.09.');
  assert.equal(T.fmtDayLabel(DAY), 'MON 7.09.2026');
  assert.equal(T.fmtTimeHM(AT_1815), '18:15');
  assert.equal(T.fmtTimeHM(AT_0905), '09:05');
  withFormats('', '', () => {
    assert.equal(T.fmtDayNum(DAY), '7.09.');
    assert.equal(T.fmtDayLabel(DAY), 'MON 7.09.2026');
    assert.equal(T.fmtTimeHM(AT_1815), '18:15');
  });
  withFormats('   ', undefined, () => {
    assert.equal(T.fmtDayNum(DAY), '7.09.', 'whitespace is blank');
    assert.equal(T.fmtTimeHM(AT_1815), '18:15');
  });
  assert.deepEqual(T.displayFormats(), { date: '', time: '' }, 'no source at all is blank');
});

test('THE ASK: "LT" gives "6:15 PM" for 18:15, and the other time shapes follow the tokens', () => {
  withFormats('', 'LT', () => {
    assert.equal(T.fmtTimeHM(AT_1815), '6:15 PM');
    assert.equal(T.fmtTimeHM(AT_0905), '9:05 AM');
    assert.equal(T.fmtDayNum(DAY), '7.09.', 'the date is untouched by a time format');
  });
  withFormats('', 'hh:mm A', () => assert.equal(T.fmtTimeHM(AT_1815), '06:15 PM'));
  withFormats('', 'H:mm', () => assert.equal(T.fmtTimeHM(AT_0905), '9:05'));
  withFormats('', 'HH:mm', () => assert.equal(T.fmtTimeHM(AT_1815), '18:15', 'the explicit compact format is the compact shape'));
});

test('THE ASK: "DD-MM" gives "07-09" for 2026-09-07; the day label keeps its weekday in front', () => {
  withFormats('DD-MM', '', () => {
    assert.equal(T.fmtDayNum(DAY), '07-09');
    assert.equal(T.fmtDayLabel(DAY), 'MON 07-09');
    assert.equal(T.fmtTimeHM(AT_1815), '18:15', 'the time is untouched by a date format');
  });
  withFormats('YYYY-MM-DD', '', () => assert.equal(T.fmtDayNum('2026-01-03'), '2026-01-03'));
  withFormats('MM/DD/YYYY', '', () => assert.equal(T.fmtDayLabel('2026-01-03'), 'SAT 01/03/2026'));
  withFormats('MMM D', '', () => assert.equal(T.fmtDayNum(DAY), 'Sep 7'));
  withFormats('D.MM.', '', () => assert.equal(T.fmtDayNum(DAY), '7.09.', 'the compact shape spelled as tokens is the compact shape'));
});

test('THE ASK: the planner setting beats the Templates value, and a blank setting follows it', () => {
  const app = (dateFormat, timeFormat) => ({ internalPlugins: { plugins: { templates: { instance: { options: { dateFormat, timeFormat } } } } } });
  assert.deepEqual(T.templatesFormats(app('YYYY-MM-DD', 'LT')), { date: 'YYYY-MM-DD', time: 'LT' });
  assert.deepEqual(T.templatesFormats(app('', '')), { date: '', time: '' }, 'blank until the person types one');
  assert.deepEqual(T.templatesFormats({}), { date: '', time: '' }, 'no Templates plugin at all');
  assert.deepEqual(T.templatesFormats(null), { date: '', time: '' });
  assert.deepEqual(T.templatesFormats({ internalPlugins: { plugins: { templates: { instance: { options: { dateFormat: 7 } } } } } }), { date: '', time: '' }, 'a non-string option is blank');
  // the override
  assert.deepEqual(T.resolveDisplayFormats({ dateFormat: 'DD-MM', timeFormat: '' }, app('YYYY-MM-DD', 'LT')), { date: 'DD-MM', time: 'LT' });
  assert.deepEqual(T.resolveDisplayFormats({ dateFormat: '', timeFormat: 'HH:mm' }, app('YYYY-MM-DD', 'LT')), { date: 'YYYY-MM-DD', time: 'HH:mm' });
  assert.deepEqual(T.resolveDisplayFormats({}, app('YYYY-MM-DD', 'LT')), { date: 'YYYY-MM-DD', time: 'LT' });
  assert.deepEqual(T.resolveDisplayFormats(T.DEFAULT_SETTINGS, {}), { date: '', time: '' }, 'fresh install, no Templates format: compact');
  assert.deepEqual(T.resolveDisplayFormats({ dateFormat: '  DD-MM  ' }, {}), { date: 'DD-MM', time: '' }, 'trimmed');
  // end to end through the source the plugin sets on load
  T.setDisplayFormatSource(() => T.resolveDisplayFormats({ dateFormat: 'DD-MM', timeFormat: '' }, app('YYYY-MM-DD', 'LT')));
  try {
    assert.equal(T.fmtDayNum(DAY), '07-09', 'the planner setting');
    assert.equal(T.fmtTimeHM(AT_1815), '6:15 PM', 'the Templates value where the planner setting is blank');
  } finally { T.setDisplayFormatSource(null); }
  assert.equal(T.DEFAULT_SETTINGS.dateFormat, '');
  assert.equal(T.DEFAULT_SETTINGS.timeFormat, '');
});

test('a format that formats to nothing, and a date that is not one, fall back to the compact shape', () => {
  withFormats('[]', '[]', () => {
    assert.equal(T.fmtDayNum(DAY), '7.09.');
    assert.equal(T.fmtDayLabel(DAY), 'MON 7.09.2026');
    assert.equal(T.fmtTimeHM(AT_1815), '18:15');
  });
  withFormats('DD-MM', 'LT', () => {
    assert.equal(T.fmtTimeHM('not a time'), 'NaN:NaN', 'an invalid instant formats as it always did (the compact shape of an invalid Date), never as "Invalid date"');
  });
  assert.equal(T.fmtWithMoment(null, 'LT', 'x'), 'x');
  assert.equal(T.fmtWithMoment({ isValid: () => false, format: () => 'Invalid date' }, 'LT', 'x'), 'x');
  assert.equal(T.fmtWithMoment({ isValid: () => true, format: () => '' }, 'LT', 'x'), 'x');
  assert.equal(T.fmtWithMoment({ isValid: () => true, format: () => 'ok' }, '', 'x'), 'x', 'a blank format never reaches moment');
  // a source that throws is a blank source, never a broken board
  T.setDisplayFormatSource(() => { throw new Error('boom'); });
  try { assert.equal(T.fmtDayNum(DAY), '7.09.'); } finally { T.setDisplayFormatSource(null); }
});

test('the format is read at render time: a change shows on the next call, nothing is cached', () => {
  let time = 'LT';
  T.setDisplayFormatSource(() => ({ date: '', time }));
  try {
    assert.equal(T.fmtTimeHM(AT_1815), '6:15 PM');
    time = '';
    assert.equal(T.fmtTimeHM(AT_1815), '18:15');
    time = 'HH[h]mm';
    assert.equal(T.fmtTimeHM(AT_1815), '18h15');
  } finally { T.setDisplayFormatSource(null); }
});

test('SOURCE: one resolver decides; no call site hand-builds a date or time string; the plugin wires it on load', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  const count = (re) => (code.match(re) || []).length;
  // the compact shapes live in exactly one place each
  assert.equal(count(/getHours\(\)\)\}:\$\{pad2\(/g), 1, 'the HH:mm shape is built once, in compactTimeText');
  assert.equal(count(/\.\$\{pad2\(m\)\}\./g), 1, 'the d.MM. shape is built once, in compactDayText');
  assert.equal(count(/\$\{pad2\(d\.getHours\(\)\)\}/g), 0, 'no second HH:mm string anywhere');
  // moment is reached only through the three formatters
  assert.equal(count(/\bmoment\(/g), 3, 'fmtDayNum, fmtTimeHM, fmtDayLabel');
  for (const fn of ['fmtDayNum', 'fmtTimeHM', 'fmtDayLabel']) {
    const body = code.slice(code.indexOf(`function ${fn}(`), code.indexOf('\n}\n', code.indexOf(`function ${fn}(`)));
    assert.ok(body.includes('displayFormats()'), `${fn} reads the resolver`);
    assert.ok(body.includes('fmtWithMoment('), `${fn} formats through the guard`);
  }
  // fmtWeekLabel is the range label with month names and stays as it is
  const week = code.slice(code.indexOf('function fmtWeekLabel('), code.indexOf('\n}\n', code.indexOf('function fmtWeekLabel(')));
  assert.ok(!week.includes('displayFormats'), 'the week range label does not follow the date format');
  // the plugin sets the source from the live settings and the Templates options, and clears it on unload
  assert.ok(/setDisplayFormatSource\(\(\) => resolveDisplayFormats\(this\.settings, this\.app\)\);/.test(code), 'set on load, read at render');
  const unload = code.slice(code.indexOf('  onunload() {'), code.indexOf('anySourceConfigured() {'));
  assert.ok(unload.includes('setDisplayFormatSource(null);'), 'cleared on unload');
  assert.ok(/templates && plugins\.templates\.instance/.test(code), 'the Templates plugin options are the source');
  assert.ok(!/displayFormatsCache|_displayFormats/.test(code), 'never cached');
  // the two settings exist, blank by default, described in plain words
  const settings = main.slice(main.indexOf('class IcorPlannerSettingTab'));
  assert.ok(/\.setName\('Date format'\)/.test(settings) && /\.setName\('Time format'\)/.test(settings));
  assert.ok(/Blank follows the Date format in Obsidian\\'s Templates settings/.test(settings));
  assert.ok(/Blank follows the Time format in Obsidian\\'s Templates settings/.test(settings));
  assert.ok(/this\.plugin\.settings\.dateFormat = String\(v \|\| ''\)\.trim\(\);/.test(settings));
  assert.ok(/this\.plugin\.settings\.timeFormat = String\(v \|\| ''\)\.trim\(\);/.test(settings));
  // the inputs stay HH:MM: the split, lunch and workday fields keep their 24h check
  assert.equal((settings.match(/\/\^\\d\{1,2\}:\\d\{2\}\$\/\.test\(v\.trim\(\)\)/g) || []).length, 5, 'five HH:MM fields, unchanged');
  // the module destructures moment from obsidian, next to the other exports
  assert.ok(/Menu, Modal, Platform, moment,\n\} = require\('obsidian'\);/.test(main));
});
