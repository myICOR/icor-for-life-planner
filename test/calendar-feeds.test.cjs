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
  assert.deepEqual(T.CALENDAR_SOURCES, ['calendar']);
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
  const adopted = T.adoptCacheDefs(legacy.defs, [HOME]);
  assert.deepEqual(adopted.map((d) => [d.feedId, d.feedName, d.feedColor]), [['cal-home', 'Home', 3]]);
  assert.deepEqual(T.adoptCacheDefs(legacy.defs, []), [], 'no feed, nowhere to belong');
  const renamed = T.adoptCacheDefs(parsed.defs, [Object.assign({}, WORK, { name: 'Office', color: 4 })]);
  assert.deepEqual(renamed.map((d) => [d.uid, d.feedName, d.feedColor]), [['w1@x', 'Office', 4]], 'the settings, not the cache, name and colour a feed');
  // Malformed shapes are ignored, never thrown.
  assert.equal(T.parseCalendarCache('no block here'), null);
  assert.equal(T.parseCalendarCache('```json\n{"version":2}\n```'), null);
  assert.equal(T.parseCalendarCache('```json\nnot json\n```'), null);
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
  assert.match(c, /calendarFetchDefs\(s, this\.calendarDefsByFeed\)/, 'the sync merges over the previous per-feed defs');
  assert.match(c, /if \(cal\.reason === 'no-token'\) \{\s*\n\s*this\.calendarDefs = null;/, 'no feeds means nothing to show');
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
  assert.match(css, /\.iplan-root, \.iplan-tray-root, \.iplan-settings \{/, 'the token block reaches the settings tab');
  for (let n = 1; n <= 4; n++) assert.match(css, new RegExp(`\\.iplan-settings-swatches button\\.iplan-swatch-${n} \\{ border-left-color: var\\(--iplan-cal-${n}\\); \\}`));
  const c = code();
  assert.match(c, /containerEl\.addClass\('iplan-settings'\)/);
  assert.match(c, /cls: 'iplan-seg iplan-settings-presets iplan-settings-swatches',\s*\n\s*attr: \{ role: 'radiogroup'/, 'the picker is a radio group on the segmented control');
  assert.match(c, /'aria-checked': on \? 'true' : 'false',\s*\n\s*'aria-label': CALENDAR_SWATCH_NAMES\[c - 1\]/, 'each swatch is checked and named for the screen reader');
});
