/* ICS moved occurrences: a RECURRENCE-ID override shows on its new day,
 * even when that day sits in a different week from the day it moved from.
 *
 * The reported bug: a monthly series on the first Friday
 * (FREQ=MONTHLY;BYDAY=1FR) had its November occurrence moved from Friday
 * the 6th to Friday the 13th. The board and the upcoming list showed it on
 * neither day. The week was expanded one window at a time and an override
 * was only looked up when the master produced its ORIGINAL day inside that
 * window: in the week of the 2nd the original day matched but the moved day
 * fell outside the week, and in the week of the 9th the original day was
 * never produced, so the override was never looked at.
 *
 * Timed fixtures are floating times (no Z, no TZID), which read as the
 * machine's own wall clock, so no zone can move a card across midnight;
 * the all-day fixture cannot move at all.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const week = (defs, weekStart) => T.icsEventsForWeek(defs, weekStart, 12);

// 2026-07-03 is the first Friday of July. August's first Friday (the 7th)
// is cancelled; November's (the 6th) moves one week on, to the 13th.
const firstFriday = [
  'BEGIN:VEVENT', 'UID:moved-1@example.com', 'SUMMARY:Office meeting',
  'DTSTART:20260703T130000', 'DTEND:20260703T140000',
  'RRULE:FREQ=MONTHLY;BYDAY=1FR;UNTIL=20270604T110000Z',
  'EXDATE:20260807T130000', 'END:VEVENT',
];
const movedToNextWeek = [
  'BEGIN:VEVENT', 'UID:moved-1@example.com', 'SUMMARY:Office meeting (moved)',
  'RECURRENCE-ID:20261106T130000',
  'DTSTART:20261113T130000', 'DTEND:20261113T140000', 'END:VEVENT',
];

test('THE BUG: an occurrence moved into the next week shows on its new day', () => {
  const defs = T.parseIcs(ics(...firstFriday, ...movedToNextWeek));
  const cards = week(defs, '2026-11-09');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].day, '2026-11-13');
  assert.equal(cards[0].title, 'Office meeting (moved)');
  assert.equal(cards[0].start, new Date(2026, 10, 13, 13, 0).toISOString());
  assert.equal(cards[0].end, new Date(2026, 10, 13, 14, 0).toISOString());
});

test('the week it moved out of shows nothing: no ghost on the original day', () => {
  const defs = T.parseIcs(ics(...firstFriday, ...movedToNextWeek));
  assert.deepEqual(week(defs, '2026-11-02'), []);
});

test('the upcoming span (three weeks back to back) shows the moved occurrence exactly once', () => {
  const defs = T.parseIcs(ics(...firstFriday, ...movedToNextWeek));
  const cards = ['2026-11-02', '2026-11-09', '2026-11-16'].flatMap((w) => week(defs, w));
  assert.deepEqual(cards.map((e) => e.day), ['2026-11-13']);
});

test('the master EXDATE still cancels its occurrence, and other months are untouched', () => {
  const defs = T.parseIcs(ics(...firstFriday, ...movedToNextWeek));
  assert.deepEqual(week(defs, '2026-08-03'), [], 'the 7th of August stays cancelled');
  assert.deepEqual(week(defs, '2026-09-28').map((e) => e.day), ['2026-10-02']);
  assert.deepEqual(week(defs, '2026-11-30').map((e) => e.day), ['2026-12-04']);
});

test('an occurrence moved back into the previous week shows there, and not in its own week', () => {
  // A weekly Monday series; the Monday of 2026-04-20 moves back to Friday the 17th.
  const defs = T.parseIcs(ics(
    'BEGIN:VEVENT', 'UID:moved-2@example.com', 'SUMMARY:Planning',
    'DTSTART;VALUE=DATE:20260406', 'DTEND;VALUE=DATE:20260407',
    'RRULE:FREQ=WEEKLY', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:moved-2@example.com', 'SUMMARY:Planning (moved)',
    'RECURRENCE-ID;VALUE=DATE:20260420',
    'DTSTART;VALUE=DATE:20260417', 'DTEND;VALUE=DATE:20260418', 'END:VEVENT',
  ));
  assert.deepEqual(week(defs, '2026-04-13').map((e) => [e.day, e.title]),
    [['2026-04-13', 'Planning'], ['2026-04-17', 'Planning (moved)']]);
  assert.deepEqual(week(defs, '2026-04-20'), []);
});

test('a moved occurrence whose original day is EXDATEd stays cancelled', () => {
  const defs = T.parseIcs(ics(
    ...firstFriday.slice(0, -2), 'EXDATE:20260807T130000,20261106T130000', 'END:VEVENT',
    ...movedToNextWeek,
  ));
  assert.deepEqual(week(defs, '2026-11-09'), []);
});
