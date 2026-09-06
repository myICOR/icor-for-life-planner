/* Outlook through Microsoft Graph (2026-09-06): flagged mail as planner
 * items, the Outlook calendar as a feed of kind 'graph'.
 *
 * Gated here, pure and scripted (no live network):
 *   - the flagged-mail query (no $orderby: Graph refuses it unless the
 *     property leads the filter) and the item mapper, due always null;
 *   - the request wrapper: a 401 refreshes once and retries once, never
 *     twice; a 429 or 503 waits Retry-After and retries once; any other
 *     non-2xx is the mapped error without a retry;
 *   - the one write, refused before any call without the write permission;
 *   - the calendar window, the calendarView query, the missing-Z trap, the
 *     event mapper (online meeting url present or absent, never null-with-
 *     a-crash), one row per occurrence and never a second expansion;
 *   - the feed layer: a graph feed is ready by sign-in, not by address;
 *     the cache round trip keeps the expanded flag and carries no token.
 *
 * Every test here was run red against the 0.8.0-plus-vault bytes through
 * PLANNER_MAIN before it counted.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const code = () => fs.readFileSync(T.__mainPath, 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

function wire(steps) {
  const calls = [];
  const requestUrl = async (req) => {
    calls.push(req);
    const step = steps.shift();
    if (!step) throw new Error(`unscripted call: ${req.method} ${req.url}`);
    return typeof step === 'function' ? step(req) : step;
  };
  return { calls, requestUrl };
}
const json = (status, body, headers) => ({ status, json: body, text: JSON.stringify(body), headers: headers || {} });
const CLIENT = '11111111-2222-3333-4444-555555555555';
// Signed in with a live access token: the wrapper never needs a refresh
// unless a test makes it.
const SIGNED = {
  outlookClientId: CLIENT, outlookTenant: 'common', outlookRefreshToken: 'rt-1', outlookAccessToken: 'at-1',
  outlookExpiresAt: String(Date.now() + 3600000), outlookAccount: 'me@example.com', outlookScopes: 'Mail.Read Calendars.Read',
};
const resolved = (extra) => T.withSecrets(Object.assign({}, T.DEFAULT_SETTINGS, SIGNED, extra || {}), new T.SecretVault(null));
const GRAPH_ID = 'AAMkAGI2TG93AAA=AAMkAGI2TG93AAA=AAMkAGI2TG93AAA=AAMkAGI2TG93AAA=AAMkAGI2TG93AAA=AAMkAGI2TG93AAA=AAMkAGI2TG93AAA=AAMkAGI2TG93AAA=AAAAA1=';

const MESSAGE = {
  id: GRAPH_ID,
  subject: 'Invoice 2026-09 from the printer',
  bodyPreview: 'Hi Tom, attached is the invoice.  \n',
  from: { emailAddress: { name: 'Printer', address: 'billing@printer.example' } },
  receivedDateTime: '2026-09-05T08:00:00Z',
  importance: 'high',
  webLink: 'https://outlook.office365.com/owa/?ItemID=AAMk&exvsurl=1&viewmodel=ReadMessageItem',
  flag: { flagStatus: 'flagged' },
  parentFolderId: 'AQMkAGI2TG93AAAAAAAA',
  conversationId: 'AAQkAGI2TG93AAAQ',
};

test('the flagged-mail query is exactly the documented one, without $orderby', () => {
  assert.equal(typeof T.outlookMessagesQuery, 'function', 'the query builder must exist');
  const q = T.outlookMessagesQuery();
  assert.equal(q, "$filter=flag%2FflagStatus%20eq%20'flagged'&$select=id,subject,bodyPreview,from,receivedDateTime,importance,webLink,flag,parentFolderId,conversationId&$top=50");
  assert.doesNotMatch(q, /\$orderby/, 'Graph refuses an $orderby whose property does not lead the $filter (InefficientFilter); sorting is client-side');
});

test('a Graph message maps to the planner item shape: due null, importance onto the priority rungs, folder as list id', () => {
  const it = T.outlookItemFromMessage(MESSAGE);
  assert.deepEqual(it, {
    source: 'outlook', id: GRAPH_ID, title: 'Invoice 2026-09 from the printer',
    description: 'Hi Tom, attached is the invoice.', due: null, priority: 1,
    url: 'https://outlook.office365.com/owa/?ItemID=AAMk&exvsurl=1&viewmodel=ReadMessageItem',
    tags: [], status: 'flagged', listId: 'AQMkAGI2TG93AAAAAAAA', recurring: false, dueString: null, parentId: null,
  });
  assert.equal(T.outlookPriorityRank('high'), 1);
  assert.equal(T.outlookPriorityRank('normal'), 3);
  assert.equal(T.outlookPriorityRank('low'), 4);
  assert.equal(T.outlookPriorityRank(undefined), 3, 'unstated is normal');
  assert.equal(T.outlookPriorityRank('High'), 1, 'case does not matter');
  assert.equal(T.outlookItemFromMessage({ id: 'x' }).title, '(no subject)');
  assert.equal(T.outlookItemFromMessage({ id: 'x', receivedDateTime: '2026-09-05T08:00:00Z' }).due, null, 'the received time is never a due date');
  // The item passes the frontmatter reader unchanged in what matters.
  const fm = T.itemFromFrontmatter({ type: 'planner-item', source: 'outlook', external_id: GRAPH_ID, title: it.title, priority: 1, list_id: it.listId, source_status: 'flagged' }, 'p', 'b');
  assert.equal(fm.listId, 'AQMkAGI2TG93AAAAAAAA', 'list_id is the folder id');
  assert.equal(fm.id, GRAPH_ID);
});

test('outlookFetchOpen: not connected without a client id or a sign-in; pages through @odata.nextLink verbatim', async () => {
  assert.equal(typeof T.outlookFetchOpen, 'function');
  const cold = await T.outlookFetchOpen({});
  assert.equal(cold.ok, false);
  assert.equal(cold.reason, 'no-token');
  const half = await T.outlookFetchOpen({ outlookClientId: CLIENT });
  assert.equal(half.reason, 'no-token');
  assert.match(half.message, /not signed in/);
  const next = 'https://graph.microsoft.com/v1.0/me/messages?$skip=50&$skiptoken=abc';
  const w = wire([
    json(200, { value: [MESSAGE, Object.assign({}, MESSAGE, { id: 'id-2', importance: 'low', subject: 'Two' })], '@odata.nextLink': next }),
    json(200, { value: [Object.assign({}, MESSAGE, { id: 'id-3', importance: 'normal', subject: 'Three' })] }),
  ]);
  const r = await T.outlookFetchOpen(resolved(), { requestUrl: w.requestUrl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => [i.id, i.priority]), [[GRAPH_ID, 1], ['id-2', 4], ['id-3', 3]]);
  assert.equal(w.calls.length, 2);
  assert.equal(w.calls[0].url, `https://graph.microsoft.com/v1.0/me/messages?${T.outlookMessagesQuery()}`);
  assert.equal(w.calls[0].headers.Authorization, 'Bearer at-1');
  assert.equal(w.calls[0].throw, false);
  assert.equal(w.calls[1].url, next, 'the next page is the link Graph gave, never hand-built');
  // A failing fetch is a degraded result carrying the mapped reason and hint.
  const down = wire([json(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } })]);
  const d = await T.outlookFetchOpen(resolved(), { requestUrl: down.requestUrl });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'misconfigured');
  assert.match(d.message, /ErrorAccessDenied/);
  assert.match(d.hint, /approve every permission/);
  const gone = wire([{ status: 0, text: '' }]);
  assert.equal((await T.outlookFetchOpen(resolved(), { requestUrl: gone.requestUrl })).reason, 'unreachable');
});

test('the request wrapper: 401 refreshes once and retries once, never twice', async () => {
  const s = resolved();
  const w = wire([
    json(401, { error: { code: 'InvalidAuthenticationToken' } }),
    json(200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 }),
    json(200, { value: [] }),
  ]);
  const data = await T.graphRequest(s, { requestUrl: w.requestUrl }, { url: 'https://graph.microsoft.com/v1.0/me/messages' });
  assert.deepEqual(data, { value: [] });
  assert.equal(w.calls.length, 3, 'GET, the refresh POST, the GET again');
  assert.equal(w.calls[1].method, 'POST');
  assert.match(w.calls[1].url, /oauth2\/v2\.0\/token$/);
  assert.equal(w.calls[2].headers.Authorization, 'Bearer at-2', 'the retry carries the fresh token');
  assert.equal(s.outlookRefreshToken, 'rt-2', 'the rotation reached the copy');
  // Still 401 after the refresh: the answer, no third GET.
  const w2 = wire([json(401, {}), json(200, { access_token: 'at-3', expires_in: 3600 }), json(401, {})]);
  await assert.rejects(() => T.graphRequest(s, { requestUrl: w2.requestUrl }, { url: 'u' }), (e) => e.reason === 'no-token' && /rejected the token/.test(e.message));
  assert.equal(w2.calls.length, 3);
  assert.equal(w2.calls.filter((c) => c.method === 'POST').length, 1, 'one refresh, never two');
});

test('the request wrapper: 429 and 503 wait Retry-After and retry once; any other non-2xx surfaces without a retry', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const s = resolved();
  const w = wire([json(429, {}, { 'retry-after': '2' }), json(200, { value: [1] })]);
  assert.deepEqual(await T.graphRequest(s, { requestUrl: w.requestUrl, sleep }, { url: 'u' }), { value: [1] });
  assert.equal(w.calls.length, 2);
  assert.deepEqual(waits, [2000]);
  const w2 = wire([{ status: 503, text: '', headers: {} }, json(503, {}, { 'retry-after': '1' })]);
  await assert.rejects(() => T.graphRequest(s, { requestUrl: w2.requestUrl, sleep }, { url: 'u' }), (e) => e.reason === 'unreachable' && /HTTP 503/.test(e.message));
  assert.equal(w2.calls.length, 2, 'one retry, then the answer');
  assert.deepEqual(waits, [2000, 2000], 'no header: a two second step');
  const w3 = wire([json(500, { error: { code: 'InternalServerError' } })]);
  await assert.rejects(() => T.graphRequest(s, { requestUrl: w3.requestUrl, sleep }, { url: 'u' }), (e) => e.reason === 'unreachable' && /HTTP 500 \(InternalServerError\)/.test(e.message));
  assert.equal(w3.calls.length, 1, 'no retry on a 500');
  assert.deepEqual(waits, [2000, 2000]);
  const w4 = wire([json(403, { error: { code: 'ErrorAccessDenied' } })]);
  await assert.rejects(() => T.graphRequest(s, { requestUrl: w4.requestUrl, sleep }, { url: 'u' }), (e) => e.reason === 'misconfigured');
  assert.equal(w4.calls.length, 1);
  // An empty 2xx is an empty object, and a JSON body rides through.
  const w5 = wire([{ status: 204, text: '', headers: {} }]);
  assert.deepEqual(await T.graphRequest(s, { requestUrl: w5.requestUrl }, { url: 'u', method: 'PATCH', body: { a: 1 } }), {});
  assert.equal(w5.calls[0].headers['Content-Type'], 'application/json');
  assert.equal(w5.calls[0].body, '{"a":1}');
});

test('the one write: the flag status, refused before any call without Mail.ReadWrite', async () => {
  const w = wire([]);
  await assert.rejects(() => T.outlookSetClosed(resolved(), { id: 'm1' }, true, { requestUrl: w.requestUrl }), /Mail\.ReadWrite/);
  assert.equal(w.calls.length, 0, 'nothing reaches the wire');
  await assert.rejects(() => T.outlookSetClosed({ outlookClientId: CLIENT }, { id: 'm1' }, true, { requestUrl: w.requestUrl }), /not signed in/);
  const s = resolved({ outlookScopes: 'Mail.Read Mail.ReadWrite Calendars.Read' });
  const w2 = wire([json(200, { id: 'm1' }), json(200, { id: 'm1' })]);
  await T.outlookSetClosed(s, { id: 'm/1' }, true, { requestUrl: w2.requestUrl });
  await T.outlookSetClosed(s, { id: 'm/1' }, false, { requestUrl: w2.requestUrl });
  assert.equal(w2.calls[0].method, 'PATCH');
  assert.equal(w2.calls[0].url, 'https://graph.microsoft.com/v1.0/me/messages/m%2F1', 'the id is encoded, never spliced');
  assert.equal(w2.calls[0].body, '{"flag":{"flagStatus":"complete"}}');
  assert.equal(w2.calls[1].body, '{"flag":{"flagStatus":"flagged"}}');
  // Through the registry, with the resolved settings, like every source.
  const w3 = wire([json(200, {})]);
  await T.CONNECTORS.outlook.setClosed(s, { id: 'x' }, true, { requestUrl: w3.requestUrl });
  assert.equal(w3.calls.length, 1);
});

test('the calendar window: a week before the earliest week shown to two weeks past the latest', () => {
  assert.deepEqual(T.graphCalendarWindow('2026-09-09'), { startDay: '2026-08-31', endDay: '2026-09-28' });
  assert.deepEqual(T.graphCalendarWindow('2026-09-09', ['2026-09-21']), { startDay: '2026-08-31', endDay: '2026-10-12' });
  assert.deepEqual(T.graphCalendarWindow('2026-09-09', ['2026-08-26', 'nonsense']), { startDay: '2026-08-17', endDay: '2026-09-28' });
  const q = T.graphCalendarQuery({ startDay: '2026-08-31', endDay: '2026-09-28' });
  const p = new URLSearchParams(q);
  assert.match(p.get('startDateTime'), /^2026-08-3[01]T\d\d:\d\d:\d\d\.\d{3}Z$/, 'an instant with a zone: Graph reads the bound by its stated offset');
  assert.match(p.get('endDateTime'), /Z$/);
  assert.equal(p.get('$select'), 'id,subject,bodyPreview,start,end,isAllDay,location,onlineMeeting,isOnlineMeeting,webLink,importance');
  assert.doesNotMatch(q, /createdDateTime|lastModifiedDateTime/, 'neither supports $select');
  assert.equal(p.get('$top'), '200');
});

test('the missing-Z trap: a UTC dateTime without a zone suffix is read as UTC, never as local time', () => {
  const a = T.graphInstant({ dateTime: '2026-09-07T09:00:00.0000000', timeZone: 'UTC' });
  assert.equal(a.instant.getTime(), Date.UTC(2026, 8, 7, 9, 0, 0));
  assert.equal(a.tzUnresolved, null);
  assert.equal(T.graphInstant({ dateTime: '2026-09-07T09:00:00Z' }).instant.getTime(), Date.UTC(2026, 8, 7, 9));
  assert.equal(T.graphInstant({ dateTime: '2026-09-07T09:00:00+02:00' }).instant.getTime(), Date.UTC(2026, 8, 7, 7));
  // A Windows zone name goes through the ICS resolver.
  const b = T.graphInstant({ dateTime: '2026-09-07T09:00:00.0000000', timeZone: 'W. Europe Standard Time' });
  assert.equal(b.instant.getTime(), Date.UTC(2026, 8, 7, 7), 'Berlin 09:00 in September is 07:00Z');
  assert.equal(b.tzUnresolved, null);
  const c = T.graphInstant({ dateTime: '2026-09-07T09:00:00', timeZone: 'Europe/Berlin' });
  assert.equal(c.instant.getTime(), Date.UTC(2026, 8, 7, 7));
  // Unknown: read as UTC and flagged, never guessed with confidence.
  const d = T.graphInstant({ dateTime: '2026-09-07T09:00:00', timeZone: 'Mars/Olympus' });
  assert.equal(d.instant.getTime(), Date.UTC(2026, 8, 7, 9));
  assert.equal(d.tzUnresolved, 'Mars/Olympus');
  assert.equal(T.graphInstant({ dateTime: 'yesterday' }), null);
  assert.equal(T.graphInstant(null), null);
  assert.deepEqual(T.graphAllDay({ dateTime: '2026-09-07T00:00:00.0000000', timeZone: 'UTC' }).day, '2026-09-07');
});

test('a calendarView row is one expanded def: the meeting link stated or absent, one occurrence, never a second expansion', () => {
  const ev = {
    id: 'evt-1', subject: 'Standup', bodyPreview: 'Daily', isAllDay: false,
    start: { dateTime: '2026-09-07T09:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-07T09:30:00.0000000', timeZone: 'UTC' },
    location: { displayName: 'Room 4' }, isOnlineMeeting: true,
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=x' },
    webLink: 'https://outlook.office365.com/calendar/item/evt-1', importance: 'normal',
  };
  const def = T.graphEventDef(ev);
  assert.equal(def.uid, 'evt-1');
  assert.equal(def.title, 'Standup');
  assert.equal(def.location, 'Room 4');
  assert.equal(def.url, 'https://outlook.office365.com/calendar/item/evt-1');
  assert.equal(def.conferenceUrl, ev.onlineMeeting.joinUrl);
  assert.equal(def.rrule, null);
  assert.equal(def.recurrenceDay, null);
  assert.ok(def.exdates instanceof Set && def.exdates.size === 0);
  assert.equal(def.expanded, true);
  assert.equal(def.start.instant.getTime(), Date.UTC(2026, 8, 7, 9));
  assert.equal(def.end.instant.getTime(), Date.UTC(2026, 8, 7, 9, 30));
  // Not an online meeting: the key is absent, not null; nothing crashes.
  const plain = T.graphEventDef(Object.assign({}, ev, { id: 'evt-2', isOnlineMeeting: false, onlineMeeting: null }));
  assert.equal('conferenceUrl' in plain, false);
  assert.equal(T.detectConferenceUrl(plain), null);
  assert.equal(T.detectConferenceUrl(def), ev.onlineMeeting.joinUrl, 'the stated link wins over any scan');
  assert.equal(T.detectConferenceUrl({ conferenceUrl: 'https://x.example/j', description: 'https://meet.google.com/abc' }), 'https://x.example/j');
  assert.equal(T.detectConferenceUrl({ description: 'https://meet.google.com/abc' }), 'https://meet.google.com/abc', 'the scan still runs without one');
  // On the board: one event, the half from the local hour, the meeting link carried.
  const events = T.icsEventsForWeek([def, plain], '2026-09-07', 13);
  assert.equal(events.length, 2);
  const stand = events.find((e) => e.masterUid === 'evt-1');
  assert.equal(stand.start, '2026-09-07T09:00:00.000Z');
  assert.equal(stand.recurring, false);
  assert.equal(stand.conferenceUrl, ev.onlineMeeting.joinUrl);
  assert.equal(events.find((e) => e.masterUid === 'evt-2').conferenceUrl, null);
  // Never a second expansion: an expanded def is one occurrence even if a
  // rrule somehow rode along.
  const rogue = Object.assign({}, def, { rrule: { FREQ: 'DAILY' } });
  const win = new Date(2026, 8, 7);
  assert.equal(T.expandOccurrences(rogue, win, new Date(2026, 8, 14)).length, 1);
  assert.equal(T.expandOccurrences(Object.assign({}, def, { expanded: false }), win, new Date(2026, 8, 14)).length, 1, 'a plain single def is one occurrence too');
  assert.equal(T.icsEventsForWeek([rogue], '2026-09-07', 13).length, 1);
  // Malformed rows are dropped, never thrown on.
  assert.equal(T.graphEventDef({ id: 'x' }), null);
  assert.equal(T.graphEventDef({ id: 'x', start: { dateTime: 'nope' } }), null);
  assert.equal(T.graphEventDef(null), null);
});

test('an all-day event spans its days like an ICS one (DTEND exclusive), and the TZ flag rides through', () => {
  const two = T.graphEventDef({
    id: 'evt-3', subject: 'Offsite', isAllDay: true,
    start: { dateTime: '2026-09-08T00:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-10T00:00:00.0000000', timeZone: 'UTC' },
  });
  assert.equal(two.start.allDay, true);
  assert.equal(two.start.day, '2026-09-08');
  assert.equal(two.end.day, '2026-09-10');
  const cards = T.icsEventsForWeek([two], '2026-09-07', 13);
  assert.deepEqual(cards.map((c) => [c.day, c.allDay, c.continues]), [['2026-09-08', true, false], ['2026-09-09', true, true]]);
  const flagged = T.graphEventDef({ id: 'evt-4', subject: 'Odd zone', start: { dateTime: '2026-09-08T10:00:00', timeZone: 'Mars/Olympus' }, end: { dateTime: '2026-09-08T11:00:00', timeZone: 'Mars/Olympus' } });
  assert.equal(flagged.tzUnresolved, 'Mars/Olympus');
  assert.match(T.calendarTzWarning([flagged]) || '', /Mars\/Olympus/);
});

test('the cache round trip keeps the expanded flag and the stated meeting link; an iCal row is unchanged', () => {
  const feed = { id: 'outlook-graph', name: 'Outlook calendar', color: 2, enabled: true, kind: 'graph' };
  const def = T.graphEventDef({
    id: 'evt-1', subject: 'Standup', isAllDay: false, isOnlineMeeting: true,
    start: { dateTime: '2026-09-07T09:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-09-07T09:30:00.0000000', timeZone: 'UTC' },
    onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
  });
  T.tagCalendarDefs([def], feed);
  const rows = T.serializeCalendarDefs([def]);
  assert.equal(rows[0].expanded, true);
  assert.equal(rows[0].conferenceUrl, 'https://teams.microsoft.com/l/meetup-join/abc');
  const back = T.reviveCalendarDefs(rows);
  assert.equal(back[0].expanded, true);
  assert.equal(back[0].rrule, null);
  assert.equal(back[0].conferenceUrl, 'https://teams.microsoft.com/l/meetup-join/abc');
  // An iCal def's row carries no expanded key, so an older cache reads back byte-identical.
  const ics = T.parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:i@x\nSUMMARY:S\nDTSTART;VALUE=DATE:20260907\nDTEND;VALUE=DATE:20260908\nEND:VEVENT\nEND:VCALENDAR\n');
  assert.equal('expanded' in T.serializeCalendarDefs(ics)[0], false);
  assert.equal('expanded' in T.reviveCalendarDefs(T.serializeCalendarDefs(ics))[0], false);
  // The cache note names the feed, never a token, and reads back tagged.
  const content = T.buildCalendarCacheContent([def], new Date(2026, 8, 4, 9, 0), '02 Planner');
  for (const needle of ['at-1', 'rt-1', 'Bearer', CLIENT]) assert.ok(!content.includes(needle), `the cache carries: ${needle}`);
  assert.match(content, /- \d\d:\d\d-\d\d:\d\d Standup \[Outlook calendar\]/);
  assert.match(content, /conference: https:\/\/teams\.microsoft\.com/);
  const parsed = T.parseCalendarCache(content);
  assert.deepEqual(parsed.defs.map((d) => [d.uid, d.feedId, d.expanded]), [['evt-1', 'outlook-graph', true]]);
  assert.equal(T.icsEventsForWeek(parsed.defs, '2026-09-07', 13).length, 1);
});

test('the feed layer: a graph feed is ready by sign-in, not by address; the row says so; the connector fetches it', async () => {
  const graph = { id: 'outlook-graph', name: 'Outlook calendar', url: '', color: 2, enabled: true, kind: 'graph' };
  const ics = { id: 'cal-1', name: 'Work', url: 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics', color: 1, enabled: true, kind: 'ics' };
  const cold = T.withSecrets({ calendars: [ics, graph], outlookClientId: CLIENT }, new T.SecretVault(null));
  assert.deepEqual(T.enabledCalendarFeeds(cold).map((f) => f.id), ['cal-1'], 'not signed in: the graph feed is not ready');
  assert.equal(T.sourceConfigured(cold, 'outlook-calendar'), false);
  assert.equal(T.sourceConfigured(cold, 'calendar'), true);
  const warm = resolved({ calendars: [ics, graph] });
  assert.deepEqual(T.enabledCalendarFeeds(warm).map((f) => f.id), ['cal-1', 'outlook-graph']);
  assert.equal(T.sourceConfigured(warm, 'outlook-calendar'), true);
  assert.equal(T.sourceConfigured(resolved({ calendars: [ics] }), 'outlook-calendar'), false, 'signed in but no graph feed in the list');
  assert.equal(T.sourceConfigured(resolved({ calendars: [graph] }), 'calendar'), false, 'the iCal calendar counts its own kind only');
  assert.equal(T.calendarFeedReady(graph, warm), true);
  assert.equal(T.calendarFeedReady(graph, cold), false);
  assert.equal(T.calendarFeedReady({ id: 'x', url: '', kind: 'ics' }, warm), false, 'an iCal feed still needs its address');
  assert.equal(T.calendarFeedConnector('graph').id, 'outlook-calendar');
  assert.equal(T.calendarFeedConnector('ics').id, 'calendar');
  assert.equal(T.calendarFeedConnector('caldav').id, 'calendar', 'an unknown kind is read as iCal');
  assert.deepEqual(T.CONNECTORS['outlook-calendar'].feeds(warm).map((f) => f.id), ['outlook-graph']);
  // The status row.
  assert.equal(T.calendarFeedStatusText(graph, null, null, cold), 'Sign in to your Microsoft account under Outlook to connect this calendar.');
  assert.equal(T.calendarFeedStatusText(graph, null, null, warm), 'Not synced yet this session.');
  assert.match(T.calendarFeedStatusText(graph, { ok: true, count: 4, at: '2026-09-04T10:00:00Z' }, null, warm), /^4 events, synced/);
  assert.equal(T.calendarFeedStatusText(ics, null), 'Not synced yet this session.', 'an iCal row is what it was');
  // The entry on sign-in: once, on the least-used lens, removable, re-added.
  const settings = { calendars: [ics] };
  assert.equal(T.ensureGraphCalendarFeed(settings), true);
  assert.deepEqual(settings.calendars[1], { id: 'outlook-graph', name: 'Outlook calendar', url: '', color: 2, enabled: true, kind: 'graph' });
  assert.equal(T.ensureGraphCalendarFeed(settings), false, 'idempotent');
  assert.equal(settings.calendars.length, 2);
  assert.equal(T.GRAPH_FEED_ID, 'outlook-graph');
  assert.equal(T.calendarFeedFor(warm, { feedId: 'outlook-graph' }).name, 'Outlook calendar');
  // The fetch: not signed in is no-token; signed in calls calendarView with
  // the UTC preference, pages, and tags the defs with the feed.
  const off = await T.outlookCalendarFetchFeed(graph, cold);
  assert.equal(off.ok, false);
  assert.equal(off.reason, 'no-token');
  const row = (id, hh) => ({ id, subject: `E${id}`, isAllDay: false, start: { dateTime: `2026-09-08T${hh}:00:00.0000000`, timeZone: 'UTC' }, end: { dateTime: `2026-09-08T${hh}:30:00.0000000`, timeZone: 'UTC' } });
  const next = 'https://graph.microsoft.com/v1.0/me/calendarView?$skip=200&x=y';
  const w = wire([json(200, { value: [row('a', '08'), row('b', '09')], '@odata.nextLink': next }), json(200, { value: [row('c', '10')] })]);
  const r = await T.outlookCalendarFetchFeed(graph, warm, { requestUrl: w.requestUrl, visibleWeekStarts: ['2026-09-07'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((d) => [d.uid, d.feedId, d.feedName, d.feedColor, d.expanded]), [['a', 'outlook-graph', 'Outlook calendar', 2, true], ['b', 'outlook-graph', 'Outlook calendar', 2, true], ['c', 'outlook-graph', 'Outlook calendar', 2, true]]);
  assert.equal(w.calls.length, 2);
  assert.match(w.calls[0].url, /^https:\/\/graph\.microsoft\.com\/v1\.0\/me\/calendarView\?startDateTime=/);
  assert.equal(w.calls[0].headers.Prefer, 'outlook.timezone="UTC"');
  assert.equal(w.calls[1].url, next);
  // Through calendarFetchAll: the graph connector takes its feed, the iCal
  // connector its own, one failure isolated from the other.
  const all = wire([json(200, { value: [row('g', '11')] })]);
  const icsStub = T.CONNECTORS.calendar.fetchFeed;
  T.CONNECTORS.calendar.fetchFeed = async () => T.degraded('calendar', 'unreachable', 'Calendar feed returned HTTP 404.');
  try {
    const out = await T.calendarFetchDefs(warm, {}, { requestUrl: all.requestUrl });
    assert.deepEqual(out.feeds.map((f) => f.id), ['cal-1', 'outlook-graph']);
    assert.equal(out.perFeed['outlook-graph'].ok, true);
    assert.equal(out.perFeed['outlook-graph'].count, 1);
    assert.equal(out.perFeed['cal-1'].ok, false);
    assert.equal(out.ok, true, 'one live feed keeps the calendar live');
    assert.match(out.warning, /^Work: Calendar feed returned HTTP 404\./);
    assert.deepEqual(out.items.map((d) => d.uid), ['g']);
  } finally { T.CONNECTORS.calendar.fetchFeed = icsStub; }
});

test('source scan: the settings row for the graph feed, the sync window, the tray and board pick the source up from the registry', () => {
  const c = code();
  assert.match(c, /if \(feed\.kind === 'graph'\) \{[\s\S]{0,400}text: 'Microsoft account'/, 'the row shows the account instead of an address field');
  assert.match(c, /calendarFeedStatusText\(feed, perFeed\[feed\.id\], secrets, resolved\)/, 'the status line sees the sign-in');
  assert.match(c, /connectorDeps\(\) \{[\s\S]*?visibleWeekStarts: weeks/, 'the calendar fetch learns which weeks the board shows');
  assert.match(c, /headers: \{ Prefer: 'outlook\.timezone="UTC"' \}/);
  assert.match(c, /ensureGraphCalendarFeed\(this\.settings\);/, 'sign-in adds the calendar row');
  assert.doesNotMatch(c, /'outlook'\s*\]/, 'no hand-kept list names the source; the registry does');
  assert.ok(T.SOURCES.outlook && T.SOURCES.outlook.svg, 'the tray head and the card meta have a mark to draw');
  assert.ok(T.SOURCES['outlook-calendar'], 'the presentation view carries the calendar connector too');
  assert.equal(T.trayEmptyState('outlook', false, undefined, 0).text, 'Not connected.');
  assert.deepEqual(T.trayConnectionState(resolved()).configured, ['outlook']);
});
