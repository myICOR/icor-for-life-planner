/* One device's empty fetch never blanks the calendar cache note.
 *
 * The cache note is one file in the vault, so a sync service carries it to
 * every device. Before this, an iCal address that answered HTTP 200 with
 * something that is not a calendar (a sign-in page, an HTML error page, an
 * empty body) parsed to zero events and counted as a HEALTHY fetch: the
 * device wrote a cache with no feeds and no events over the good one, and
 * every other device received the blank note.
 *
 * Gated here, two lines of defence:
 * - a 2xx reply that is not an iCalendar is a failed fetch: the feed keeps
 *   its previous events and the status says why;
 * - writeCalendarCache never replaces a cache that holds events with one
 *   that holds none, whatever the cause (a real calendar that came back
 *   empty, an Outlook reply with no rows). It still creates a missing cache,
 *   and still writes events over an empty one.
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
const workDefs = () => T.tagCalendarDefs(T.parseIcs(ics(vevent('w1@x', 'Standup', '20260907'))), WORK);

const SIGN_IN_PAGE = '<!DOCTYPE html><html><head><title>Sign in</title></head><body><form action="/signin">Sign in to continue</form></body></html>';

test('a reply is a calendar only when it is an iCalendar', () => {
  assert.equal(T.isIcalendarText(ics(vevent('a@x', 'A', '20260907'))), true);
  assert.equal(T.isIcalendarText(ics()), true, 'a real calendar with no events is still a calendar');
  assert.equal(T.isIcalendarText('﻿' + ics()), true, 'a byte order mark in front is fine');
  assert.equal(T.isIcalendarText('\r\n' + ics()), true, 'a blank line in front is fine');
  assert.equal(T.isIcalendarText(SIGN_IN_PAGE), false, 'a sign-in page is not a calendar');
  assert.equal(T.isIcalendarText(''), false, 'an empty body is not a calendar');
  assert.equal(T.isIcalendarText(undefined), false);
  assert.equal(T.isIcalendarText('<p>BEGIN:VCALENDAR</p>'), false, 'the words inside a web page are not a calendar');
});

test('THE ASK: a 200 reply that is not a calendar is a failed fetch, not an empty calendar', async () => {
  // The harness's requestUrl answers every request with HTTP 200 and an
  // empty body: exactly a reply that is not a calendar.
  const r = await T.calendarFetchFeed(WORK);
  assert.equal(r.ok, false, 'not a healthy fetch');
  assert.equal(r.reason, 'misconfigured');
  assert.match(r.message, /did not return a calendar/);
  assert.equal(r.items.length, 0);
});

test('THE ASK: a feed whose reply is not a calendar keeps its previous events', async () => {
  const prev = { [WORK.id]: workDefs() };
  const out = await T.calendarFetchDefs({ calendars: [WORK] }, prev, {});
  assert.equal(out.ok, false, 'no live feed: nothing healthy to write');
  assert.deepEqual(out.items.map((d) => d.uid), ['w1@x'], 'the board keeps the last events');
  assert.equal(out.perFeed[WORK.id].ok, false);
  assert.match(out.perFeed[WORK.id].message, /did not return a calendar/);
});

function cacheApp(existingText) {
  const calls = { process: [], create: [] };
  const app = {
    vault: {
      getAbstractFileByPath: () => (existingText == null ? null : new TFile()),
      read: async () => existingText,
      cachedRead: async () => existingText,
      process: async (file, fn) => { calls.process.push(fn(existingText)); },
      create: async (path, content) => { calls.create.push({ path, content }); },
    },
  };
  return { app, calls };
}

function instance(app, defs) {
  const p = Object.create(PluginClass.prototype);
  p.settings = { plannerFolder: '02 Planner' };
  p.app = app;
  p.calendarDefs = defs;
  p.calendarStale = false;
  p.calendarFeedSyncedAt = {};
  p.ensureFolders = async () => {};
  return p;
}

const nine = new Date(2026, 8, 4, 9, 0);

test('THE ASK: writeCalendarCache never writes an empty calendar over one with events', async () => {
  const full = T.buildCalendarCacheContent(workDefs(), nine, '02 Planner');
  const { app, calls } = cacheApp(full);
  await instance(app, []).writeCalendarCache();
  assert.equal(calls.process.length, 0, 'the cache with events stays');
  assert.equal(calls.create.length, 0);
});

test('writeCalendarCache still writes events over an empty cache, and creates a missing one', async () => {
  const empty = T.buildCalendarCacheContent([], nine, '02 Planner');
  const filled = cacheApp(empty);
  await instance(filled.app, workDefs()).writeCalendarCache();
  assert.equal(filled.calls.process.length, 1, 'events replace an empty cache');
  assert.match(filled.calls.process[0], /Standup/);

  const missing = cacheApp(null);
  await instance(missing.app, []).writeCalendarCache();
  assert.equal(missing.calls.create.length, 1, 'no cache yet: an empty calendar is still written once');

  const unreadable = cacheApp('no block here');
  await instance(unreadable.app, []).writeCalendarCache();
  assert.equal(unreadable.calls.process.length, 1, 'a cache with no readable events is not protected');
});
