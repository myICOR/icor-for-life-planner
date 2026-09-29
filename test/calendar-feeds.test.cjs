/* Several calendars (0.8.0).
 *
 * Before this the calendar was one anonymous URL: nothing carried a feed
 * identity, so there was nothing to colour, label, isolate or dedupe by, and
 * a second calendar was impossible. Now a calendar is a LIST of feeds, each
 * with an id, a name and a colour index into four lenses styles.css declares.
 *
 * Gated here: the migration from the single URL, what "configured" means,
 * the per-feed colour and name on expanded events, one event shown once
 * across feeds, a failing feed keeping its last events, the cache reading
 * both layouts and never carrying a URL, the swatch index clamped to the
 * four lenses, and the design contract (no new hex; time and TZ mark in the
 * dim ink; colour on the edge only).
 *
 * Every test here was run red against the 0.7.3-plus-run-1 bytes through
 * PLANNER_MAIN / PLANNER_ROOT before it counted.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./harness.cjs');

const root = process.env.PLANNER_ROOT
  ? path.resolve(process.env.PLANNER_ROOT)
  : path.join(__dirname, '..');
const mainSrc = () => fs.readFileSync(T.__mainPath, 'utf8');
const cssSrc = () => fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const code = () => mainSrc().split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const GOOGLE = 'https://calendar.google.com/calendar/ical/tom%40example.com/private-0123456789abcdef/basic.ics';
const ICLOUD = 'webcal://p42-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1NmFiY2RlZg';

const ics = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events.flat(), 'END:VCALENDAR'].join('\r\n') + '\r\n';
const vevent = (uid, title, day) => [
  'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`,
  `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${day}`, 'END:VEVENT',
];
const feedDefs = (feed, ...events) => T.tagCalendarDefs(T.parseIcs(ics(...events)), feed);
const WORK = { id: 'cal-work', name: 'Work', url: GOOGLE, color: 2, enabled: true, kind: 'ics' };
const HOME = { id: 'cal-home', name: 'Home', url: ICLOUD, color: 3, enabled: true, kind: 'ics' };

test('migration turns one icsUrl into one enabled feed and leaves an empty setting empty', () => {
  assert.equal(typeof T.migrateCalendarSettings, 'function', 'migrateCalendarSettings must exist');
  const migrated = T.migrateCalendarSettings({ icsUrl: ` ${GOOGLE} `, todoistToken: 'x' });
  assert.deepEqual(migrated.calendars, [
    { id: 'cal-1', name: 'Google Calendar', url: GOOGLE, color: 1, enabled: true, kind: 'ics' },
  ]);
  assert.equal(migrated.todoistToken, 'x', 'every other key survives');
  assert.equal(migrated.icsUrl, ` ${GOOGLE} `, 'icsUrl stays for one release, read nowhere else');
  // The migrated feed is named by its address's shape.
  assert.equal(T.migrateCalendarSettings({ icsUrl: ICLOUD }).calendars[0].name, 'iCloud Calendar');
  assert.deepEqual(T.migrateCalendarSettings({ icsUrl: '   ' }).calendars, []);
  assert.deepEqual(T.migrateCalendarSettings({}).calendars, []);
  assert.deepEqual(T.migrateCalendarSettings(null).calendars, []);
});

test('a second migration run is a no-op', () => {
  const once = T.migrateCalendarSettings({ icsUrl: GOOGLE });
  const twice = T.migrateCalendarSettings(once);
  assert.equal(twice, once, 'calendars present means the same object comes back, untouched');
  // An empty list is still "present": the user deleting every calendar must
  // not resurrect the old URL on the next launch.
  const emptied = { icsUrl: GOOGLE, calendars: [] };
  assert.equal(T.migrateCalendarSettings(emptied), emptied);
  assert.deepEqual(emptied.calendars, []);
});

test('sourceConfigured("calendar") is true only with an enabled feed carrying a URL', () => {
  const on = (calendars) => T.sourceConfigured({ calendars }, 'calendar');
  assert.equal(on([WORK]), true);
  assert.equal(on([Object.assign({}, WORK, { enabled: false })]), false, 'a feed that is off does not count');
  assert.equal(on([Object.assign({}, WORK, { url: '   ' })]), false, 'a feed without an address does not count');
  assert.equal(on([Object.assign({}, WORK, { enabled: false }), HOME]), true, 'one live feed is enough');
  assert.equal(on([]), false);
  // The old shape still counts, through the same migration.
  assert.equal(T.sourceConfigured({ icsUrl: GOOGLE }, 'calendar'), true);
  assert.equal(T.sourceConfigured({ icsUrl: GOOGLE, calendars: [] }, 'calendar'), false, 'an emptied list beats the old key');
  // The registry entry is what a later Graph or CalDAV kind copies.
  const c = T.CONNECTORS.calendar;
  assert.equal(c.kind, 'calendar');
  assert.equal(typeof c.feeds, 'function');
  assert.equal(typeof c.fetchFeed, 'function');
  assert.deepEqual(c.feeds({ calendars: [HOME, WORK] }).map((f) => f.id), ['cal-home', 'cal-work'], 'settings order');
  assert.deepEqual(T.CALENDAR_SOURCES, ['calendar', 'outlook-calendar'], 'the iCal feeds and the Outlook calendar, each its own connector');
  assert.equal(c.feedKind, 'ics');
  assert.equal(typeof c.ready, 'function');
  assert.deepEqual(c.feeds({ calendars: [HOME, { id: 'g', kind: 'graph' }] }).map((f) => f.id), ['cal-home'], 'the iCal connector lists its own kind only');
});

test('THE ASK: two feeds render with their own colour and name', () => {
  const defs = feedDefs(WORK, vevent('w1@x', 'Standup', '20260907'))
    .concat(feedDefs(HOME, vevent('h1@x', 'Dentist', '20260908')));
  const events = T.icsEventsForWeek(defs, '2026-09-07', 13);
  assert.equal(events.length, 2);
  const byTitle = Object.fromEntries(events.map((e) => [e.title, e]));
  assert.equal(byTitle.Standup.feedId, 'cal-work');
  assert.equal(byTitle.Standup.feedName, 'Work');
  assert.equal(byTitle.Standup.feedColor, 2);
  assert.equal(byTitle.Dentist.feedId, 'cal-home');
  assert.equal(byTitle.Dentist.feedName, 'Home');
  assert.equal(byTitle.Dentist.feedColor, 3);
  assert.notEqual(byTitle.Standup.feedColor, byTitle.Dentist.feedColor);
  // No URL rides an event object: the modal looks the feed up by id.
  for (const ev of events) assert.ok(!JSON.stringify(ev).includes('icloud.com') && !JSON.stringify(ev).includes('private-'), 'an event carries no feed address');
  assert.equal(T.calendarFeedFor({ calendars: [WORK, HOME] }, byTitle.Dentist).name, 'Home');
  assert.equal(T.calendarFeedFor({ calendars: [WORK] }, byTitle.Dentist), null, 'a feed no longer in the settings resolves to nothing');
});

test('the same UID in two feeds shows once, first feed wins', () => {
  const work = feedDefs(WORK, vevent('shared@x', 'Team offsite (work copy)', '20260909'));
  const home = feedDefs(HOME, vevent('shared@x', 'Team offsite (home copy)', '20260909'), vevent('h2@x', 'Piano', '20260910'));
  const { defs, duplicates } = T.dedupeCalendarDefs(work.concat(home));
  assert.equal(duplicates, 1);
  assert.equal(defs.length, 2);
  assert.equal(defs[0].feedId, 'cal-work', 'the first feed in settings order keeps the event');
  assert.equal(defs[0].title, 'Team offsite (work copy)');
  // A RECURRENCE-ID override is a different key from its master, so one
  // feed's edit of one occurrence is never mistaken for a duplicate.
  const master = { uid: 'r@x', recurrenceDay: null };
  const override = { uid: 'r@x', recurrenceDay: '2026-09-11' };
  assert.equal(T.dedupeCalendarDefs([master, override]).duplicates, 0);
});

test('a failing feed keeps its previous defs while the healthy feed refreshes', () => {
  const prev = {
    'cal-work': feedDefs(WORK, vevent('w-old@x', 'Old standup', '20260907')),
    'cal-home': feedDefs(HOME, vevent('h-old@x', 'Old dentist', '20260908')),
  };
  const results = {
    'cal-work': T.okResult('calendar', feedDefs(WORK, vevent('w-new@x', 'New standup', '20260907'))),
    'cal-home': T.degraded('calendar', 'unreachable', 'Calendar feed returned HTTP 404.'),
  };
  const merged = T.mergeCalendarFeeds(prev, results);
  assert.deepEqual(merged.live, ['cal-work']);
  assert.deepEqual(merged.failed, ['cal-home']);
  assert.deepEqual(merged.byFeed['cal-work'].map((d) => d.uid), ['w-new@x'], 'the healthy feed replaced its own entry');
  assert.deepEqual(merged.byFeed['cal-home'].map((d) => d.uid), ['h-old@x'], 'the failing feed kept its last entry');
  assert.deepEqual(merged.defs.map((d) => d.uid), ['w-new@x', 'h-old@x']);
  // A feed absent from the results (switched off or removed) drops out.
  const dropped = T.mergeCalendarFeeds(prev, { 'cal-work': results['cal-work'] });
  assert.ok(!('cal-home' in dropped.byFeed));
  // The one status line names the failing feed and keeps the result ok.
  const status = T.calendarAggregateStatus([WORK, HOME], results, merged, new Date('2026-09-04T10:00:00Z'));
  assert.equal(status.ok, true, 'one live feed keeps the calendar live');
  assert.match(status.warning, /^Home: Calendar feed returned HTTP 404\./);
  assert.equal(status.perFeed['cal-home'].ok, false);
  assert.equal(status.perFeed['cal-home'].count, 1, 'the kept events are what the row reports');
  assert.equal(status.perFeed['cal-work'].count, 1);
  // Every feed failing is a failure carrying the first feed's reason.
  const allDown = T.mergeCalendarFeeds(prev, { 'cal-work': results['cal-home'], 'cal-home': results['cal-home'] });
  const down = T.calendarAggregateStatus([WORK, HOME], { 'cal-work': results['cal-home'], 'cal-home': results['cal-home'] }, allDown);
  assert.equal(down.ok, false);
  assert.equal(down.reason, 'unreachable');
  assert.match(down.message, /^Work: .* Home: /);
  assert.deepEqual(allDown.defs.map((d) => d.uid), ['w-old@x', 'h-old@x'], 'nothing pruned on a blip');
  // No feeds at all is "not connected", the no-token reason the tray knows.
  assert.equal(T.calendarAggregateStatus([], {}, T.mergeCalendarFeeds({}, {})).reason, 'no-token');
  // Duplicates are reported in the same line.
  const dup = T.mergeCalendarFeeds({}, {
    'cal-work': T.okResult('calendar', feedDefs(WORK, vevent('s@x', 'Shared', '20260907'))),
    'cal-home': T.okResult('calendar', feedDefs(HOME, vevent('s@x', 'Shared', '20260907'))),
  });
  assert.match(T.calendarAggregateStatus([WORK, HOME], {
    'cal-work': T.okResult('calendar', []), 'cal-home': T.okResult('calendar', []),
  }, dup).warning, /1 event appears in more than one feed; shown once\./);
});

test('mergeCalendarFeeds carries a cache-only feed through a LIVE sync of a different, settings-registered feed', () => {
  // calendarDefsByFeed starts with a settings feed (cal-work) AND a
  // cache-only feed (jeffjr@x - our Google sync script's write, adopted
  // with no settings.calendars row, same shape adoptCacheDefs produces:
  // tagCalendarDefs with a synthesized feed carrying its own `source`). A
  // live sync's results name cal-work only (the only settings row) -
  // calendarFetchAll can never enumerate a cache-only feed, so results
  // never mentions jeffjr@x either way.
  const GOOGLE_FEED = { id: 'jeffjr@x', name: 'Jeff', color: 2, source: 'google-calendar' };
  const prev = {
    'cal-work': feedDefs(WORK, vevent('w-old@x', 'Old standup', '20260907')),
    'jeffjr@x': T.tagCalendarDefs(T.parseIcs(ics(vevent('g1@x', 'Shop meeting', '20260930'))), GOOGLE_FEED),
  };
  const results = { 'cal-work': T.okResult('calendar', feedDefs(WORK, vevent('w-new@x', 'New standup', '20260907'))) };
  // Before this fix mergeCalendarFeeds took two arguments and read
  // Object.keys(results) alone: jeffjr@x, absent from results because it
  // was never a settings row to be fetched under, dropped out exactly like
  // a feed the member removed - worse than the original display bug,
  // because it fires on every real live sync.
  const merged = T.mergeCalendarFeeds(prev, results, new Set(['jeffjr@x']));
  assert.deepEqual(merged.byFeed['cal-work'].map((d) => d.uid), ['w-new@x'], 'the settings feed still refreshes normally');
  assert.deepEqual(merged.byFeed['jeffjr@x'].map((d) => d.uid), ['g1@x'], 'the cache-only feed is carried forward, unfetched, never dropped');
  assert.deepEqual(merged.carried, ['jeffjr@x']);
  assert.deepEqual(merged.defs.map((d) => d.uid).sort(), ['g1@x', 'w-new@x']);
  // A cache-only id the sync ACTUALLY has a settings row for now (the
  // member added it under Settings) is fetched normally, never carried
  // twice or duplicated.
  const promoted = T.mergeCalendarFeeds(prev, {
    'cal-work': results['cal-work'],
    'jeffjr@x': T.okResult('calendar', T.tagCalendarDefs(T.parseIcs(ics(vevent('g2@x', 'Real settings row now', '20260930'))), Object.assign({}, GOOGLE_FEED, { source: undefined }))),
  }, new Set(['jeffjr@x']));
  assert.deepEqual(promoted.byFeed['jeffjr@x'].map((d) => d.uid), ['g2@x'], 'once it has a real settings row, the live result wins, not the carried-forward one');
  assert.deepEqual(promoted.carried, []);
  // A cache-only id with nothing actually held (pruned elsewhere, or never
  // adopted) is not conjured back into existence.
  assert.deepEqual(T.mergeCalendarFeeds({}, results, new Set(['jeffjr@x'])).carried, []);
});

test('a live sync writes the cache-only feed back to disk under ITS OWN source, so reloading the cache never re-drops it ("the write" half of the same bug)', async () => {
  // The same shape a live "Sync now" actually produces end to end:
  // calendarFetchDefs, not a hand-assembled merge result.
  const GOOGLE_FEED = { id: 'jeffjr@x', name: 'Jeff', color: 2, source: 'google-calendar' };
  const prevByFeed = {
    'jeffjr@x': T.tagCalendarDefs(T.parseIcs(ics(vevent('g1@x', 'Shop meeting', '20260930'))), GOOGLE_FEED),
  };
  const cal = await T.calendarFetchDefs({ calendars: [WORK] }, prevByFeed, {}, new Set(['jeffjr@x']));
  assert.equal(cal.ok, true, 'the one settings feed synced live and healthy');
  assert.ok(Array.isArray(cal.byFeed['jeffjr@x']) && cal.byFeed['jeffjr@x'].length === 1, 'calendarDefsByFeed keeps the cache-only feed after this live sync');
  assert.ok(cal.items.some((d) => d.uid === 'g1@x'), 'the merged defs the board renders still carry the Google event');
  // What actually gets written to the ONE cache file this sync would
  // schedule (writeCalendarCache -> buildCalendarCacheContent(this.calendarDefs, ...)):
  const now = new Date(2026, 8, 30, 9, 0);
  const content = T.buildCalendarCacheContent(cal.items, now, '02 Planner', {});
  assert.match(content, /^source: ics$/m, 'the file-level line still says this plugin wrote the file');
  const parsed = T.parseCalendarCache(content);
  const googleFeedOut = parsed.feeds.find((f) => f.id === 'jeffjr@x');
  assert.ok(googleFeedOut, 'the Google feed entry survived being written back by the plugin');
  const googleDefOut = parsed.defs.find((d) => d.uid === 'g1@x');
  assert.ok(googleDefOut, 'the Google event itself survived the write - not silently deleted from disk');
  assert.equal(googleDefOut.feedSource, 'google-calendar', 'and its OWN source rides inside the per-feed json entry, not just the file-level line');
  // The part that was actually irreversible before this fix: RELOADING that
  // written file (the next plugin launch, loadCalendarCache) with NO
  // settings row for jeffjr@x must still adopt it as foreign and keep it -
  // not read the file-level `source: ics` and conclude it is this plugin's
  // own untracked feed, which is exactly what a hardcoded `source: ics`
  // caused: the events would vanish again on the very next load.
  const reloaded = T.adoptCacheDefs(parsed.defs, [WORK], parsed.source);
  assert.deepEqual(reloaded.filter((d) => d.feedId === 'jeffjr@x').map((d) => d.uid), ['g1@x'], 'the Google feed survives a reload of the file THIS plugin itself just wrote');
});

test('the status row says what one feed is doing', () => {
  assert.equal(T.calendarFeedStatusText({ url: '' }, null), 'Paste the iCal address to connect this calendar.');
  assert.equal(T.calendarFeedStatusText(Object.assign({}, WORK, { enabled: false }), null), 'Off: its events are hidden until it is switched on.');
  assert.equal(T.calendarFeedStatusText(WORK, null), 'Not synced yet this session.');
  assert.equal(T.calendarFeedStatusText(WORK, { ok: false, message: 'Calendar feed returned HTTP 404.' }), 'Failed: Calendar feed returned HTTP 404.');
  assert.match(T.calendarFeedStatusText(WORK, { ok: true, count: 1, at: '2026-09-04T10:00:00Z' }), /^1 event, synced \d\d:\d\d\.$/);
  assert.match(T.calendarFeedStatusText(WORK, { ok: true, count: 3, at: null, warning: 'w' }), /^3 events\. w$/);
});

test('the cache round-trips per feed and still reads a v1 array', () => {
  const now = new Date(2026, 8, 4, 9, 0);
  const defs = feedDefs(WORK, vevent('w1@x', 'Standup', '20260907'))
    .concat(feedDefs(HOME, vevent('h1@x', 'Dentist', '20260908')));
  const content = T.buildCalendarCacheContent(defs, now, '02 Planner', { 'cal-home': '2026-09-03T08:00:00.000Z' });
  assert.match(content, /^source: ics$/m, 'no longer named after one provider');
  assert.match(content, /^feeds: 2$/m);
  assert.match(content, /^events: 2$/m);
  assert.match(content, /- ALL DAY Standup \[Work\]/, 'the readable row names the calendar');
  const parsed = T.parseCalendarCache(content);
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.feeds.map((f) => [f.id, f.name, f.color, f.updatedAt]), [
    ['cal-work', 'Work', 2, now.toISOString()],
    ['cal-home', 'Home', 3, '2026-09-03T08:00:00.000Z'],
  ], 'a feed kept from an earlier sync keeps its own, older, updated_at');
  assert.deepEqual(parsed.defs.map((d) => [d.uid, d.feedId, d.feedName, d.feedColor]), [
    ['w1@x', 'cal-work', 'Work', 2], ['h1@x', 'cal-home', 'Home', 3],
  ]);
  // The board's expansion is byte-identical after the round trip.
  const again = T.icsEventsForWeek(parsed.defs, '2026-09-07', 13);
  assert.deepEqual(JSON.stringify(again), JSON.stringify(T.icsEventsForWeek(defs, '2026-09-07', 13)));
  // Legacy: a bare defs array (0.7.x) still loads, untagged, and the compat
  // reader hands the defs straight back.
  const v1 = '---\ntype: calendar-cache\n---\n\n```json\n' + JSON.stringify(T.serializeCalendarDefs(defs.slice(0, 1))) + '\n```\n';
  const legacy = T.parseCalendarCache(v1);
  assert.equal(legacy.version, 1);
  assert.equal(legacy.defs.length, 1);
  assert.equal(legacy.defs[0].feedId, undefined);
  assert.deepEqual(T.parseCalendarCacheContent(v1).map((d) => d.uid), ['w1@x']);
  // Adopting the cache onto the settings: v1 defs join the first enabled
  // feed; a feed that is gone is dropped; names and colours follow settings.
  // adoptCacheDefs tags its input defs in place (tagCalendarDefs), so the
  // "no feed, nowhere to belong" case below re-parses a fresh, still-
  // untagged copy rather than reusing `legacy.defs` after this line has
  // already stamped it with cal-home's identity.
  const adopted = T.adoptCacheDefs(legacy.defs, [HOME]);
  assert.deepEqual(adopted.map((d) => [d.feedId, d.feedName, d.feedColor]), [['cal-home', 'Home', 3]]);
  assert.deepEqual(T.adoptCacheDefs(T.parseCalendarCache(v1).defs, []), [], 'no feed, nowhere to belong');
  const renamed = T.adoptCacheDefs(parsed.defs, [Object.assign({}, WORK, { name: 'Office', color: 4 })]);
  assert.deepEqual(renamed.map((d) => [d.uid, d.feedName, d.feedColor]), [['w1@x', 'Office', 4]], 'the settings, not the cache, name and colour a feed');
  // Malformed shapes are ignored, never thrown.
  assert.equal(T.parseCalendarCache('no block here'), null);
  assert.equal(T.parseCalendarCache('```json\n{"version":2}\n```'), null);
  assert.equal(T.parseCalendarCache('```json\nnot json\n```'), null);
});

test('THE ASK: a cache-declared feed with no settings.calendars row still renders, read-only, through the board pipeline', () => {
  // Shaped like the sync-google-calendar.py script's own write: `source:
  // google-calendar` in the frontmatter, a feed id that is a real calendar
  // address (never a settings cal-N id), no settings row for it anywhere.
  const foreignContent = [
    '---', 'type: calendar-cache', 'source: google-calendar', 'updated_at: 2026-09-29T18:00:00Z',
    'events: 1', 'feeds: 1', '---', '', '# Calendar Events', '',
    '```json',
    JSON.stringify({
      version: 1,
      updated_at: '2026-09-29T18:00:00Z',
      feeds: [{
        id: 'jeffjr@jandsautomotive.com', name: 'Jeff', color: 2, updated_at: '2026-09-29T18:00:00Z',
        defs: T.serializeCalendarDefs(feedDefs({ id: 'jeffjr@jandsautomotive.com', name: 'Jeff', color: 2 }, vevent('g1@x', 'Shop meeting', '20260930'))),
      }],
    }),
    '```', '',
  ].join('\n');
  const parsed = T.parseCalendarCache(foreignContent);
  assert.equal(parsed.source, 'google-calendar');
  assert.equal(parsed.defs.length, 1);
  // No settings feeds at all (Jeff never added anything under Settings):
  // adoptCacheDefs keeps the def under its own cache-declared identity.
  const adopted = T.adoptCacheDefs(parsed.defs, [], parsed.source);
  assert.deepEqual(adopted.map((d) => [d.feedId, d.feedName, d.feedColor]), [['jeffjr@jandsautomotive.com', 'Jeff', 2]]);
  // The board's own expansion renders it exactly like a settings feed's def.
  const events = T.icsEventsForWeek(adopted, '2026-09-28', 13);
  assert.equal(events.length, 1);
  assert.equal(events[0].feedName, 'Jeff');
  // A settings feed with a DIFFERENT id still wins for its own def; only the
  // unmatched one falls back to its own identity.
  const mixed = T.adoptCacheDefs(parsed.defs.concat(feedDefs(WORK, vevent('w1@x', 'Standup', '20260930'))), [WORK], 'google-calendar');
  assert.deepEqual(mixed.map((d) => d.feedId).sort(), ['cal-work', 'jeffjr@jandsautomotive.com']);
  // Contrast: for THIS plugin's OWN cache (source: ics, what buildCalendarCacheContent
  // always writes) the same shape is dropped when it has no settings row —
  // that is a feed the member removed on purpose, and settings stays the
  // one authority over its own cache.
  const ownContent = T.buildCalendarCacheContent(feedDefs({ id: 'jeffjr@jandsautomotive.com', name: 'Jeff', color: 2 }, vevent('g1@x', 'Shop meeting', '20260930')), new Date(2026, 8, 29, 9, 0), '02 Planner');
  const ownParsed = T.parseCalendarCache(ownContent);
  assert.equal(ownParsed.source, 'ics');
  assert.deepEqual(T.adoptCacheDefs(ownParsed.defs, [], ownParsed.source), [], 'this plugin\'s own cache still treats settings as the one authority');
});

test('a cache-only feed id can never be polled by calendarFetchAll: the job list comes only from settings.calendars, never from a cache or calendarDefsByFeed', () => {
  // calendarFetchAll takes settings and nothing else; a def carrying a
  // feedId with no settings.calendars entry has no connector, no kind and
  // no url to be fetched with, so it cannot appear as a job however many
  // events it contributes to calendarDefsByFeed via the cache.
  const c = code();
  assert.match(c, /async function calendarFetchAll\(settings, deps\) \{/, 'calendarFetchAll takes settings only, no cache or byFeed argument');
  assert.match(c, /for \(const feed of c\.feeds\(settings\)\)/, 'every job comes from a connector reading settings, never the cache');
  assert.ok(!/calendarFetchAll\([^)]*calendarDefsByFeed/.test(c), 'calendarFetchAll is never called with the cache-derived per-feed map');
});

test('activeCalendarFeedIds never crashes on an id with no settings row and no cache entry (settings-tab toggling an unknown feed)', () => {
  assert.equal(typeof T.activeCalendarFeedIds, 'function');
  // A settings-backed id and a cache-only id (its defs still held) both render.
  assert.deepEqual(
    T.activeCalendarFeedIds(['cal-work'], { 'cal-work': [{ uid: 'w' }], 'jeffjr@x': [{ uid: 'g' }] }, new Set(['jeffjr@x'])),
    ['cal-work', 'jeffjr@x'],
  );
  // An id in the cache-only set whose defs were already pruned elsewhere is
  // simply left out, not thrown on.
  assert.deepEqual(T.activeCalendarFeedIds(['cal-work'], { 'cal-work': [{ uid: 'w' }] }, new Set(['gone-feed'])), ['cal-work']);
  // Every input can be empty, undefined or missing without throwing.
  assert.deepEqual(T.activeCalendarFeedIds([], {}, new Set()), []);
  assert.deepEqual(T.activeCalendarFeedIds(undefined, undefined, undefined), []);
  assert.deepEqual(T.activeCalendarFeedIds(['cal-work'], null, null), ['cal-work']);
});

test('the cache never contains a feed URL', () => {
  const defs = feedDefs(WORK, vevent('w1@x', 'Standup', '20260907'))
    .concat(feedDefs(HOME, vevent('h1@x', 'Dentist', '20260908')));
  const content = T.buildCalendarCacheContent(defs, new Date(2026, 8, 4, 9, 0), '02 Planner');
  for (const needle of [GOOGLE, ICLOUD, 'private-0123456789abcdef', 'icloud.com', 'calendar.google.com', '"url":"http']) {
    assert.ok(!content.includes(needle), `the cache carries a feed address: ${needle}`);
  }
  // Structurally too: the tag a fetch stamps on a def is id, name, colour
  // and nothing else, so a URL cannot reach the cache through a def.
  const tagged = T.tagCalendarDefs([{ uid: 'x' }], WORK)[0];
  assert.deepEqual(Object.keys(tagged).sort(), ['feedColor', 'feedId', 'feedName', 'uid']);
});

test('the swatch index is clamped to 1..4', () => {
  assert.equal(T.CALENDAR_SWATCHES, 4, 'four lenses, by the subtraction on this surface');
  assert.equal(T.CALENDAR_SWATCH_NAMES.length, 4);
  for (const [raw, want] of [[1, 1], [4, 4], ['3', 3], [0, 1], [5, 1], [-2, 1], [2.4, 2], [NaN, 1], [undefined, 1], ['plum', 1], [null, 1]]) {
    assert.equal(T.clampSwatch(raw), want, `clampSwatch(${raw})`);
  }
  assert.equal(T.normalizeCalendarFeed({ color: 9 }, 0).color, 1);
  assert.equal(T.normalizeCalendarFeed({ color: 4 }, 0).color, 4);
  // The migrated feed takes lens 1; a new feed takes the least-used lens.
  assert.equal(T.migrateCalendarSettings({ icsUrl: GOOGLE }).calendars[0].color, 1);
  assert.equal(T.leastUsedSwatch([]), 1);
  assert.equal(T.leastUsedSwatch([{ color: 1 }]), 2);
  assert.equal(T.leastUsedSwatch([{ color: 1 }, { color: 2 }, { color: 3 }]), 4);
  assert.equal(T.leastUsedSwatch([{ color: 1 }, { color: 2 }, { color: 3 }, { color: 4 }]), 1, 'a fifth feed shares the least-used lens');
  assert.equal(T.leastUsedSwatch([{ color: 1 }, { color: 1 }, { color: 2 }, { color: 3 }, { color: 4 }]), 2);
  // An event's colour on the chip is clamped again at expansion time.
  const def = Object.assign(T.parseIcs(ics(vevent('c@x', 'Clamp', '20260907')))[0], { feedId: 'f', feedName: 'F', feedColor: 7 });
  assert.equal(T.icsEventsForWeek([def], '2026-09-07', 13)[0].feedColor, 1);
});

test('the modal links to Google only for a Google-shaped address', () => {
  const ev = { masterUid: 'abc123@google.com', recurring: false, day: '2026-09-07' };
  assert.match(T.googleCalendarEventUrl(ev, GOOGLE), /^https:\/\/calendar\.google\.com\/calendar\/u\/0\/r\/eventedit\//);
  assert.equal(T.googleCalendarEventUrl(ev, ICLOUD), null, 'an iCloud feed has no Google edit URL');
  assert.equal(T.googleCalendarEventUrl(ev, 'https://calendar.proton.me/api/calendar/v1/url/x/calendar.ics?CacheKey=y'), null);
  assert.equal(T.googleCalendarEventUrl(ev, ''), null);
  const c = code();
  // The modal takes the feed, not a URL; the kicker names it; no Google
  // day-view fallback is invented for a feed that is not Google's.
  assert.match(c, /class EventDetailModal extends Modal \{[\s\S]*?constructor\(app, ev, feed, inkPluginId\)/);
  assert.ok(!/text: ' GOOGLE CALENDAR' \}\)/.test(c), 'the kicker is no longer a Google literal');
  assert.ok(!/\/r\/day\//.test(c), 'no Google day-view fallback for a non-Google feed');
  assert.match(c, /text: 'OPEN EVENT LINK'/, 'the event URL is the fallback link');
  assert.match(c, /new EventDetailModal\(plugin\.app, ev, calendarFeedFor\(plugin\.withSecrets\(\), ev\)/, 'the chip resolves the feed from the resolved settings by id (the address may live in the secret store)');
  assert.match(c, /chip\.addClass\(`iplan-cal-\$\{clampSwatch\(ev\.feedColor\)\}`\)/, 'the chip wears its lens class');
  assert.match(c, /\$\{ev\.feedName \? ', ' \+ ev\.feedName : ''\}/, 'the aria label speaks the feed name');
});

test('the sync fetches every feed on its own and never prunes on a blip', () => {
  const c = code();
  assert.match(c, /Promise\.allSettled\(jobs\.map/, 'feeds are fetched together, failures isolated');
  assert.match(c, /calendarFetchDefs\(s, this\.calendarDefsByFeed, this\.connectorDeps\(\), this\.calendarCacheOnlyIds\)/, 'the sync merges over the previous per-feed defs, telling it which held feeds were never its own to fetch');
  assert.match(c, /if \(cal\.reason === 'no-token'\) \{\s*\n\s*this\.calendarDefsByFeed = cal\.byFeed \|\| \{\};\s*\n\s*this\.calendarDefs = \(cal\.items && cal\.items\.length\) \? cal\.items : null;/, 'no settings-declared feed means nothing of this plugin\'s own to show, but cal.byFeed/cal.items (already carrying any held cache-only feed through the merge) are read, never replaced with an unconditional wipe');
  assert.ok(!/settings\.icsUrl/.test(c.replace(/trimmed\(s\.icsUrl\)/, '')), 'icsUrl is read by the migration only');
  assert.match(c, /calendars: \[\]/, 'the default settings declare the list');
});

test('design contract: no new hex, colour on the edge only, time and TZ mark in the dim ink', () => {
  const css = cssSrc();
  // The four lenses ride theme tokens with stock Obsidian fallbacks. Pasted
  // verbatim from the ruling; a drift here is a drift from the design system.
  for (const line of [
    '--iplan-cal-1: var(--ink-hue-indigo, var(--color-purple));',
    '--iplan-cal-2: var(--ink-hue-cyan, var(--color-cyan));',
    '--iplan-cal-3: var(--ink-hue-burgundy, var(--color-pink));',
    '--iplan-cal-4: var(--ink-paper-faint, var(--text-faint));',
    '--iplan-event: var(--iplan-cal-1);',
    '--iplan-event-soft: var(--iplan-wash);',
  ]) assert.ok(css.includes(line), `missing token line: ${line}`);
  assert.ok(!/--iplan-cal-[0-9]+-soft/.test(css), 'no per-feed wash: one shared wash for every chip');
  assert.ok(!/--iplan-cal-[5-9]/.test(css), 'four lenses, not more');
  // No new hex: the file carried exactly these five values before this
  // change (two --ink-marker fallbacks left with the old event tokens).
  const hex = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((h) => h.toLowerCase());
  assert.deepEqual(Array.from(new Set(hex)).sort(), ['#7d9a7f', '#888', '#b5654f', '#c2a35c', '#ff5a2d'], 'a hex value this file never had');
  assert.ok(hex.length <= 26, `hex literal count grew to ${hex.length}`);
  // The lens is the edge: one border-left-color rule per lens on the chip,
  // and no lens named as a text colour or a background anywhere.
  for (let n = 1; n <= 4; n++) {
    assert.match(css, new RegExp(`\\.iplan-event\\.iplan-cal-${n} \\{ border-left-color: var\\(--iplan-cal-${n}\\); \\}`));
  }
  assert.ok(!/(^|[^-])color: var\(--iplan-cal-/m.test(css), 'a lens is never a text ink');
  assert.ok(!/background[^;]*--iplan-cal-/.test(css), 'a lens is never a tint');
  assert.ok(!/color-mix\([^)]*--iplan-cal-/.test(css), 'a lens is never mixed into anything');
  // The time and the TZ? mark sit in the dim ink; the marker is gone from the chip.
  assert.match(css, /\.iplan-event-time \{ font-size: 9px; color: var\(--iplan-dim\);/);
  const tz = css.slice(css.indexOf('.iplan-event.is-tz-unresolved::after'), css.indexOf('.iplan-event.is-tz-unresolved::after') + 260);
  assert.match(tz, /color: var\(--iplan-dim\);/, 'the TZ? mark is text, so dim ink');
  assert.match(css, /\.iplan-event\.is-tz-unresolved \{ border-left-style: dashed; \}/, 'the dashed edge stays');
  const eventBlock = css.slice(css.indexOf('.iplan-event {'), css.indexOf('/* stale events'));
  assert.ok(!/--iplan-marker/.test(eventBlock), 'the marker has left the event chip');
  // The picker is the run-1 segmented control with the lens as an edge, and
  // the settings tab can resolve the tokens it names.
  // Read as a SET, not as a fixed list: the block gains a root whenever the
  // plugin gains a surface (the week view did, in 0.14.0), and a gate that
  // pins the whole selector goes red on the addition rather than on the
  // omission it exists to catch.
  const aliasBlock = css.slice(0, css.indexOf('{', css.indexOf('--iplan-marker:') - 400) + 1);
  for (const root of ['.iplan-root', '.iplan-tray-root', '.iplan-settings']) {
    assert.ok(aliasBlock.includes(root), `the token block must reach ${root}`);
  }
  for (let n = 1; n <= 4; n++) assert.match(css, new RegExp(`\\.iplan-settings-swatches button\\.iplan-swatch-${n} \\{ border-left-color: var\\(--iplan-cal-${n}\\); \\}`));
  const c = code();
  assert.match(c, /containerEl\.addClass\('iplan-settings'\)/);
  assert.match(c, /cls: 'iplan-seg iplan-settings-presets iplan-settings-swatches',\s*\n\s*attr: \{ role: 'radiogroup'/, 'the picker is a radio group on the segmented control');
  assert.match(c, /'aria-checked': on \? 'true' : 'false',\s*\n\s*'aria-label': CALENDAR_SWATCH_NAMES\[c - 1\]/, 'each swatch is checked and named for the screen reader');
});
