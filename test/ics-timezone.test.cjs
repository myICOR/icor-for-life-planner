/* ICS time zones: a Windows TZID must never become a local wall clock.
 *
 * The reported bug: an Outlook feed subscribed inside Google Calendar carries
 * TZID=W. Australia Standard Time. Intl rejects the name, the parser caught
 * the rejection and reinterpreted 08:30 Perth as 08:30 in the machine's own
 * zone, two hours early on a Sydney machine, with no marker anywhere.
 *
 * Three claims are gated here: the CLDR table resolves Windows names; a zone
 * that still cannot be resolved is FLAGGED rather than silently local; the
 * flag survives every hop (def, expanded event, cache round trip, warning).
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

const ics = (...lines) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...lines, 'END:VCALENDAR'].join('\r\n') + '\r\n';
const event = (dtstartLine, extra) => [
  'BEGIN:VEVENT', 'UID:tz-1@example.com', 'SUMMARY:Perth standup',
  dtstartLine, 'DTEND;TZID=W. Australia Standard Time:20260901T090000',
  ...(extra || []), 'END:VEVENT',
];
const PERTH_0830_UTC = Date.UTC(2026, 8, 1, 0, 30); // 08:30 AWST (+08:00) on 2026-09-01

test('a Windows zone name resolves through the CLDR map', () => {
  assert.equal(typeof T.resolveTzid, 'function', 'resolveTzid must exist');
  assert.deepEqual(T.resolveTzid('W. Australia Standard Time', {}),
    { tz: 'Australia/Perth', fixedOffsetMin: null, unresolved: null });
  assert.equal(T.resolveTzid('AUS Eastern Standard Time', {}).tz, 'Australia/Sydney');
  assert.equal(T.resolveTzid('W. Europe Standard Time', {}).tz, 'Europe/Berlin');
  assert.equal(T.resolveTzid('Pacific Standard Time', {}).tz, 'America/Los_Angeles');
  assert.equal(T.resolveTzid('GMT Standard Time', {}).tz, 'Europe/London');
  // The whole territory-001 set ships, and every target is a zone Intl knows:
  // a typo in the table would resolve a name to a rejection.
  const keys = Object.keys(T.WINDOWS_TZ_TO_IANA);
  assert.ok(keys.length >= 100, `expected the full CLDR set, got ${keys.length} rows`);
  for (const k of keys) {
    assert.ok(T.isIanaZone(T.WINDOWS_TZ_TO_IANA[k]), `${k} maps to an id Intl rejects: ${T.WINDOWS_TZ_TO_IANA[k]}`);
  }
});

test('THE BUG: an Outlook DTSTART lands on the right instant regardless of the machine zone', () => {
  const defs = T.parseIcs(ics(...event('DTSTART;TZID=W. Australia Standard Time:20260901T083000')));
  assert.equal(defs.length, 1);
  assert.equal(defs[0].start.instant.getTime(), PERTH_0830_UTC);
  assert.equal(defs[0].tzUnresolved, null, 'a resolved zone carries no flag');
});

test('THE BUG, on the reporter\'s machine: Sydney renders the Perth 08:30 as 10:30', () => {
  // Node re-reads TZ from the environment on the next Date call, so the
  // machine zone can be switched for the length of one test.
  const before = process.env.TZ;
  process.env.TZ = 'Australia/Sydney';
  try {
    const defs = T.parseIcs(ics(...event('DTSTART;TZID=W. Australia Standard Time:20260901T083000')));
    assert.equal(defs[0].start.instant.getTime(), PERTH_0830_UTC, 'the instant is machine-zone independent');
    assert.equal(defs[0].start.instant.getHours(), 10, 'and it is 10:30 in Sydney, not 08:30');
    assert.equal(defs[0].start.instant.getMinutes(), 30);
  } finally {
    if (before === undefined) delete process.env.TZ; else process.env.TZ = before;
  }
});

test('an unknown zone is flagged, never silently local', () => {
  const defs = T.parseIcs(ics(...event('DTSTART;TZID=Nowhere Standard Time:20260901T083000')));
  assert.equal(defs[0].tzUnresolved, 'Nowhere Standard Time', 'the def must name the zone it could not resolve');
  // Behaviour is unchanged (the floating fallback), but it is now visible.
  assert.equal(defs[0].start.instant.getTime(), new Date(2026, 8, 1, 8, 30).getTime());
  assert.equal(defs[0].start.tzUnresolved, 'Nowhere Standard Time');
});

test('a VTIMEZONE block resolves a free-form TZID', () => {
  const feed = ics(
    'BEGIN:VTIMEZONE', 'TZID:Custom Perth',
    'BEGIN:STANDARD', 'DTSTART:16010101T000000', 'TZOFFSETFROM:+0800', 'TZOFFSETTO:+0800', 'END:STANDARD',
    'END:VTIMEZONE',
    ...event('DTSTART;TZID=Custom Perth:20260901T083000'),
  );
  const defs = T.parseIcs(feed);
  assert.equal(defs[0].start.instant.getTime(), PERTH_0830_UTC, 'STANDARD-only block is a fixed offset');
  assert.equal(defs[0].tzUnresolved, null);
  // A STANDARD + DAYLIGHT pair names a zone by behaviour: some IANA zone with
  // those two offsets is chosen, and it must really have them.
  const r = T.resolveTzid('Custom Berlin', { vtimezones: { 'Custom Berlin': { standardOffset: 60, daylightOffset: 120 } } });
  assert.ok(r.tz, 'a +0100/+0200 pair must resolve to a zone');
  const year = new Date().getFullYear();
  const offs = [T.tzOffsetMinutes(new Date(Date.UTC(year, 0, 15, 12)), r.tz), T.tzOffsetMinutes(new Date(Date.UTC(year, 6, 15, 12)), r.tz)].sort((a, b) => a - b);
  assert.deepEqual(offs, [60, 120]);
});

test('X-WR-TIMEZONE fills a missing TZID on a floating DTSTART, and only a missing one', () => {
  const filled = T.parseIcs(ics('X-WR-TIMEZONE:Australia/Perth', ...event('DTSTART:20260901T083000')));
  assert.equal(filled[0].start.instant.getTime(), PERTH_0830_UTC);
  assert.equal(filled[0].tzUnresolved, null, 'the calendar default is not a fallback, it is the answer');
  // A Windows name as the calendar default goes through the same chain.
  const winDefault = T.parseIcs(ics('X-WR-TIMEZONE:W. Australia Standard Time', ...event('DTSTART:20260901T083000')));
  assert.equal(winDefault[0].start.instant.getTime(), PERTH_0830_UTC);
  // An id the feed DID write and the plugin cannot read stays flagged: the
  // calendar default must not turn a wrong zone into a confident one.
  const explicit = T.parseIcs(ics('X-WR-TIMEZONE:Australia/Perth', ...event('DTSTART;TZID=Nowhere Standard Time:20260901T083000')));
  assert.equal(explicit[0].tzUnresolved, 'Nowhere Standard Time');
});

test('normalizeTzid strips quotes and registry prefixes; a (UTC+HH:MM) prefix is a fixed offset', () => {
  assert.equal(T.normalizeTzid('"W. Australia Standard Time"'), 'W. Australia Standard Time');
  assert.equal(T.normalizeTzid('/mozilla.org/20070129_1/Europe/Berlin'), 'Europe/Berlin');
  assert.equal(T.normalizeTzid('/freeassociation.sourceforge.net/Europe/Berlin'), 'Europe/Berlin');
  assert.equal(T.normalizeTzid('  W.  Australia   Standard Time '), 'W. Australia Standard Time');
  assert.equal(T.resolveTzid('/mozilla.org/20070129_1/Europe/Berlin', {}).tz, 'Europe/Berlin');
  assert.equal(T.tzidUtcPrefixOffset('(UTC+08:00) Perth'), 480);
  assert.equal(T.tzidUtcPrefixOffset('(UTC-03:30) Newfoundland'), -210);
  assert.equal(T.tzidUtcPrefixOffset('(UTC) Coordinated Universal Time'), 0);
  assert.equal(T.tzidUtcPrefixOffset('Europe/Berlin'), null);
  assert.deepEqual(T.resolveTzid('(UTC+08:00) Perth', {}), { tz: null, fixedOffsetMin: 480, unresolved: null });
  assert.equal(T.icsUtcOffsetToMinutes('+0800'), 480);
  assert.equal(T.icsUtcOffsetToMinutes('-0330'), -210);
  assert.equal(T.icsUtcOffsetToMinutes('+053000'), 330);
  assert.equal(T.icsUtcOffsetToMinutes('nope'), null);
});

test('no behaviour change for Z timestamps, all-day dates and IANA TZIDs', () => {
  const z = T.icsParseDate('20260901T003000Z', {}, null);
  assert.equal(z.instant.getTime(), PERTH_0830_UTC);
  assert.equal(z.tzUnresolved, null);
  const d = T.icsParseDate('20260901', { VALUE: 'DATE' }, null);
  assert.equal(d.allDay, true);
  assert.equal(d.day, '2026-09-01');
  assert.equal(d.tzUnresolved, null);
  const iana = T.icsParseDate('20260901T083000', { TZID: 'Australia/Perth' }, null);
  assert.equal(iana.instant.getTime(), PERTH_0830_UTC);
  assert.equal(iana.tzUnresolved, null);
  // A floating time with no calendar default is a local time by definition,
  // so it is NOT flagged: the flag means "a zone was named and not read".
  const floating = T.icsParseDate('20260901T083000', {}, null);
  assert.equal(floating.tzUnresolved, null);
});

test('the flag survives the cache round trip', () => {
  const defs = T.parseIcs(ics(...event('DTSTART;TZID=Nowhere Standard Time:20260901T083000')));
  const content = T.buildCalendarCacheContent(defs, new Date(2026, 7, 31, 9, 0));
  const revived = T.parseCalendarCacheContent(content);
  assert.equal(revived[0].tzUnresolved, 'Nowhere Standard Time');
  // The readable list marks the row for whoever reads the note.
  assert.match(content, /Perth standup \[tz\?\]/);
  const clean = T.serializeCalendarDefs(T.parseIcs(ics(...event('DTSTART;TZID=W. Australia Standard Time:20260901T083000'))));
  assert.equal(clean[0].tzUnresolved, null);
});

test('the expansion carries the flag onto events', () => {
  const defs = T.parseIcs(ics(...event('DTSTART;TZID=Nowhere Standard Time:20260901T083000')));
  const events = T.icsEventsForWeek(defs, '2026-08-31', 13);
  assert.equal(events.length, 1);
  assert.equal(events[0].tzUnresolved, 'Nowhere Standard Time');
  const ok = T.icsEventsForWeek(T.parseIcs(ics(...event('DTSTART;TZID=W. Australia Standard Time:20260901T083000'))), '2026-08-31', 13);
  assert.equal(ok[0].tzUnresolved, null);
});

test('one warning line per feed, never one per event', () => {
  assert.equal(T.calendarTzWarning([]), null);
  assert.equal(T.calendarTzWarning([{ tzUnresolved: null }]), null);
  assert.equal(T.calendarTzWarning([{ tzUnresolved: 'Nowhere Standard Time' }]),
    '1 event uses an unknown time zone (Nowhere Standard Time); times are shown as written.');
  assert.equal(T.calendarTzWarning([{ tzUnresolved: 'X' }, { tzUnresolved: 'Y' }, { tzUnresolved: null }]),
    '2 events use an unknown time zone (X); times are shown as written.');
  const r = T.okResult('calendar', [], 'w');
  assert.equal(r.ok, true);
  assert.equal(r.warning, 'w');
  assert.equal('warning' in T.okResult('calendar', []), false, 'a clean result carries no warning key');
});
