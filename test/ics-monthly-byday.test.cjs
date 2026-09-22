/* ICS monthly rules: BYDAY names a weekday of the month, not a date.
 *
 * The reported bug: a series on the third Sunday of every month
 * (FREQ=MONTHLY;BYDAY=3SU) that starts on a third Sunday falling on the 15th
 * showed on the 15th every month after the first. The monthly expansion read
 * only the start's day-of-month and never read BYDAY, so every nth-weekday
 * rule drifted onto a date, and a moved occurrence (RECURRENCE-ID keyed on
 * the correct day) never matched: the moved card vanished and a ghost sat
 * on the 15th. An EXDATE on the correct day cancelled nothing, for the same
 * reason.
 *
 * All-day fixtures, so the machine zone cannot move a card across midnight.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const days = (defs, weekStart) => T.icsEventsForWeek(defs, weekStart, 12).map((e) => e.day);

// 2026-02-15 is the third Sunday of February. In April the third Sunday is
// the 19th, and the 15th is a Wednesday: the week of 2026-04-13 tells them apart.
const thirdSunday = [
  'BEGIN:VEVENT', 'UID:byday-1@example.com', 'SUMMARY:Book club',
  'DTSTART;VALUE=DATE:20260215', 'DTEND;VALUE=DATE:20260216',
  'RRULE:FREQ=MONTHLY;BYDAY=3SU', 'END:VEVENT',
];

test('THE BUG: BYDAY=3SU lands on the third Sunday, never on the start\'s day-of-month', () => {
  const defs = T.parseIcs(ics(...thirdSunday));
  assert.deepEqual(days(defs, '2026-04-13'), ['2026-04-19']);
});

test('a negative ordinal counts from the end: BYDAY=-1FR is the last Friday', () => {
  // 2026-04-24 is the last Friday of April; May's last Friday is the 29th.
  const defs = T.parseIcs(ics(
    'BEGIN:VEVENT', 'UID:byday-2@example.com', 'SUMMARY:Month close',
    'DTSTART;VALUE=DATE:20260424', 'DTEND;VALUE=DATE:20260425',
    'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'END:VEVENT',
  ));
  assert.deepEqual(days(defs, '2026-05-18'), [], 'nothing on the 24th');
  assert.deepEqual(days(defs, '2026-05-25'), ['2026-05-29']);
});

test('THE BUG, second effect: a moved occurrence renders on its moved day, with no ghost left behind', () => {
  // April's third Sunday (the 19th) moved to Saturday the 18th.
  const defs = T.parseIcs(ics(
    ...thirdSunday,
    'BEGIN:VEVENT', 'UID:byday-1@example.com', 'SUMMARY:Book club (moved)',
    'RECURRENCE-ID;VALUE=DATE:20260419',
    'DTSTART;VALUE=DATE:20260418', 'DTEND;VALUE=DATE:20260419', 'END:VEVENT',
  ));
  const week = T.icsEventsForWeek(defs, '2026-04-13', 12);
  assert.deepEqual(week.map((e) => e.day), ['2026-04-18']);
  assert.equal(week[0].title, 'Book club (moved)');
});

test('an EXDATE on the correct day cancels that occurrence, with no ghost left behind', () => {
  const [begin, uid, summary, dtstart, dtend, rrule, end] = thirdSunday;
  const defs = T.parseIcs(ics(begin, uid, summary, dtstart, dtend, rrule, 'EXDATE;VALUE=DATE:20260419', end));
  assert.deepEqual(days(defs, '2026-04-13'), []);
});
