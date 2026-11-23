/* The calendar cache is rewritten only when the calendar changed.
 *
 * Before this the cache note was rewritten on every healthy fetch. Its
 * updated_at (frontmatter, payload and each feed) moves on every fetch, so
 * every sync tick wrote a different file even when no event had changed:
 * with a sync service that keeps each version of a note, a large calendar
 * (thousands of events, several MB) at a 10-minute interval grows the
 * stored history by hundreds of MB a day per device.
 *
 * Gated here: two contents that differ only in the fetch times have the
 * same signature; a changed event, a changed feed or a new day in the
 * readable list does not; and writeCalendarCache leaves an unchanged file
 * alone, rewrites a changed one, and still creates a missing one.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

const PluginClass = require(T.__mainPath);
const { TFile } = T.__obsidian;

const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n') + '\r\n';
const vevent = (uid, title, day) => [
  'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`,
  `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${day}`, 'END:VEVENT',
];
const WORK = { id: 'cal-work', name: 'Work', url: 'https://example.invalid/work.ics', color: 2, enabled: true, kind: 'ics' };
const HOME = { id: 'cal-home', name: 'Home', url: 'https://example.invalid/home.ics', color: 3, enabled: true, kind: 'ics' };
const feedDefs = (feed, ...events) => T.tagCalendarDefs(T.parseIcs(ics(...events)), feed);
const defsOf = (title) => feedDefs(WORK, vevent('w1@x', title, '20260907'))
  .concat(feedDefs(HOME, vevent('h1@x', 'Dentist', '20260908')));

const nine = new Date(2026, 8, 4, 9, 0);
const ten = new Date(2026, 8, 4, 9, 10);

test('THE ASK: two fetches of the same calendar ten minutes apart are the same cache', () => {
  const a = T.buildCalendarCacheContent(defsOf('Standup'), nine, '02 Planner', { 'cal-home': nine.toISOString() });
  const b = T.buildCalendarCacheContent(defsOf('Standup'), ten, '02 Planner', { 'cal-home': ten.toISOString() });
  assert.notEqual(a, b, 'the bytes differ: updated_at moved');
  assert.equal(T.sameCalendarCache(a, b), true, 'only the fetch times moved');
});

test('a changed event, a changed feed or a new day is a change', () => {
  const base = T.buildCalendarCacheContent(defsOf('Standup'), nine, '02 Planner');
  const renamed = T.buildCalendarCacheContent(defsOf('Standup moved'), ten, '02 Planner');
  assert.equal(T.sameCalendarCache(base, renamed), false, 'an event title changed');
  const oneFeed = T.buildCalendarCacheContent(feedDefs(WORK, vevent('w1@x', 'Standup', '20260907')), ten, '02 Planner');
  assert.equal(T.sameCalendarCache(base, oneFeed), false, 'a feed dropped out');
  const tomorrow = T.buildCalendarCacheContent(defsOf('Standup'), new Date(2026, 8, 5, 9, 0), '02 Planner');
  assert.equal(T.sameCalendarCache(base, tomorrow), false, 'the readable 14-day list moved on a day');
});

test('a missing or malformed previous cache is never "the same"', () => {
  const next = T.buildCalendarCacheContent(defsOf('Standup'), nine, '02 Planner');
  assert.equal(T.sameCalendarCache('', next), false);
  assert.equal(T.sameCalendarCache('no block here', next), false);
  assert.equal(T.sameCalendarCache('```json\nnot json\n```', next), false);
  assert.equal(T.calendarCacheSignature('```json\n{"version":2}\n```'), null);
});

function cacheApp(existingText) {
  const calls = { process: [], create: [] };
  const app = {
    vault: {
      getAbstractFileByPath: () => (existingText == null ? null : new TFile()),
      read: async () => existingText,
      process: async (file, fn) => { calls.process.push(fn(existingText)); },
      create: async (path, content) => { calls.create.push({ path, content }); },
    },
  };
  return { app, calls };
}

function instance(app, title) {
  const p = Object.create(PluginClass.prototype);
  p.settings = { plannerFolder: '02 Planner' };
  p.app = app;
  p.calendarDefs = defsOf(title);
  p.calendarStale = false;
  p.calendarFeedSyncedAt = {};
  p.ensureFolders = async () => {};
  return p;
}

test('THE ASK: writeCalendarCache leaves an unchanged cache file alone', async (t) => {
  // writeCalendarCache stamps new Date(), so the earlier write is made
  // moments before it, on the same day (the readable list follows the day).
  const day = T.localDayStr(new Date());
  const earlier = T.buildCalendarCacheContent(defsOf('Standup'), new Date(Date.now() - 1000), '02 Planner');
  const { app, calls } = cacheApp(earlier);
  await instance(app, 'Standup').writeCalendarCache();
  if (T.localDayStr(new Date()) !== day) { t.skip('ran across midnight'); return; }
  assert.equal(calls.process.length, 0, 'no rewrite when only updated_at would move');
  assert.equal(calls.create.length, 0);
});

test('writeCalendarCache rewrites a changed cache and creates a missing one', async () => {
  const earlier = T.buildCalendarCacheContent(defsOf('Standup'), nine, '02 Planner');
  const changed = cacheApp(earlier);
  await instance(changed.app, 'Standup moved').writeCalendarCache();
  assert.equal(changed.calls.process.length, 1, 'a changed event is written');
  assert.match(changed.calls.process[0], /Standup moved/);
  const missing = cacheApp(null);
  await instance(missing.app, 'Standup').writeCalendarCache();
  assert.equal(missing.calls.create.length, 1, 'no cache yet: it is created');
  assert.match(missing.calls.create[0].path, /Calendar Events\.md$/);
});
