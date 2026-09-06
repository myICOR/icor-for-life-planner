/* The secret vault: credentials leave data.json when Obsidian offers a store.
 *
 * Obsidian 1.11.4 added `app.secretStorage` (setSecret / getSecret /
 * listSecrets, synchronous, ids in [a-z0-9-], one global namespace). The
 * plugin feature-detects it. When it is there, every secret data.json still
 * holds (the two API tokens, the app password, every calendar feed address,
 * the stale icsUrl) is moved out once on load and its field blanked; every
 * consumer of a credential then receives `withSecrets(settings)`, a shallow
 * copy with the values filled back in. When it is not there, today's
 * behaviour holds and the settings tab says so in one line.
 *
 * Gated here, against a fake store that enforces the typings' id rule:
 *   - feature detection, both ways, and the mode it yields;
 *   - every key the layer produces is in the alphabet the API accepts;
 *   - the migration moves each secret once, blanks its field, drops icsUrl,
 *     sets the flag, and a second run is a no-op with no extra store write;
 *   - a store that refuses a write leaves the secret where it was;
 *   - withSecrets fills every field and every feed address, shares _shadow;
 *   - the field and feed accessors read and write through the store;
 *   - the settings on disk and the cache note carry no secret after the
 *     migration (the secret-free gate, extended to data.json);
 *   - source scan: no connector, fetcher, probe or configured check is ever
 *     handed the raw settings, and no feed address is read except through
 *     feedUrl.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const code = () => fs.readFileSync(T.__mainPath, 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

// The store as the typings describe it: three synchronous methods, ids in
// lowercase alphanumerics and dashes, a throw on anything else. Counts its
// writes so an idempotence claim is measured, not assumed.
class FakeSecretStorage {
  constructor() { this.m = new Map(); this.writes = 0; }
  setSecret(id, secret) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid secret id: ${id}`);
    this.writes += 1;
    this.m.set(id, String(secret));
  }
  getSecret(id) { return this.m.has(id) ? this.m.get(id) : null; }
  listSecrets() { return [...this.m.keys()]; }
}

const GOOGLE = 'https://calendar.google.com/calendar/ical/tom%40example.com/private-0123456789abcdef/basic.ics';
const ICLOUD = 'webcal://p12-caldav.icloud.com/published/2/abcdefghijklmnop';
const NEEDLES = ['tok-todoist-1', 'pk_clickup_2', 'app-pass-3', GOOGLE, ICLOUD, 'private-0123456789abcdef', 'icloud.com', 'calendar.google.com'];

function loaded() {
  return {
    todoistToken: ' tok-todoist-1 ',
    clickupToken: 'pk_clickup_2',
    imapHost: 'imap.gmail.com', imapUser: 'a@b.c', imapPassword: 'app-pass-3',
    icsUrl: GOOGLE,
    calendars: [
      { id: 'cal-work', name: 'Work', url: GOOGLE, color: 2, enabled: true, kind: 'ics' },
      { name: 'Home', url: ICLOUD, color: 3, enabled: true, kind: 'ics' }, // no id: the migration gives it one
      { id: 'cal-off', name: 'Off', url: '', color: 1, enabled: true, kind: 'ics' },
    ],
    plannerFolder: '02 Planner',
    _shadow: { 'todoist:1': { due: null } },
  };
}

const keychain = () => { const storage = new FakeSecretStorage(); return { storage, vault: new T.SecretVault(storage) }; };

test('feature detection: the two methods the layer calls, and the mode they yield', () => {
  assert.equal(T.secretStorageUsable(undefined), false);
  assert.equal(T.secretStorageUsable({}), false);
  assert.equal(T.secretStorageUsable({ getSecret() { } }), false, 'a store without setSecret is not usable');
  assert.equal(T.secretStorageUsable({ setSecret() { } }), false, 'a store without getSecret is not usable');
  assert.equal(T.secretStorageUsable(new FakeSecretStorage()), true);
  assert.equal(new T.SecretVault(undefined).mode, 'data-json');
  assert.equal(new T.SecretVault(undefined).available(), false);
  assert.equal(new T.SecretVault({}).mode, 'data-json', 'an app without secretStorage falls back');
  const { vault } = keychain();
  assert.equal(vault.mode, 'keychain');
  assert.equal(vault.available(), true);
  // Off the store nothing is read or written and nothing throws.
  const none = new T.SecretVault(null);
  assert.equal(none.get('x'), '');
  assert.equal(none.set('x', 'y'), false);
  assert.equal(none.delete('x'), false);
});

test('every key is prefixed and inside the alphabet the API accepts', () => {
  const ok = /^icor-for-life-planner-[a-z0-9-]+$/;
  assert.equal(T.SECRET_KEY_PREFIX, 'icor-for-life-planner-', 'a dash, not a colon: the id rule forbids the colon');
  for (const field of Object.keys(T.SECRET_FIELDS)) assert.match(T.fieldSecretKey(field), ok, field);
  assert.equal(T.fieldSecretKey('todoistToken'), 'icor-for-life-planner-todoist-token');
  assert.equal(T.fieldSecretKey('imapPassword'), 'icor-for-life-planner-imap-password');
  assert.ok('outlookRefreshToken' in T.SECRET_FIELDS, 'the Outlook refresh token has its slot reserved');
  assert.throws(() => T.fieldSecretKey('imapUser'), /not a secret field/, 'a non-secret field has no key');
  assert.equal(T.calendarSecretKey('cal-work'), 'icor-for-life-planner-calendar-cal-work');
  // A hand-edited id in any shape still lands in the alphabet.
  for (const raw of ['Cal_1 X', 'cal:1', '  ', 'ÄÖ', 'a--b', '-lead-']) assert.match(T.calendarSecretKey(raw), ok, JSON.stringify(raw));
  assert.equal(T.secretKey('Cal_1 X'), 'icor-for-life-planner-cal-1-x');
  // The fake store enforces the rule, so a key outside it would have thrown here.
  const { storage, vault } = keychain();
  assert.equal(vault.set(T.calendarSecretKey('Cal:1'), 'v'), true);
  assert.deepEqual(storage.listSecrets(), ['icor-for-life-planner-calendar-cal-1']);
});

test('the migration moves each secret once, blanks its field, drops icsUrl, sets the flag', () => {
  const { storage, vault } = keychain();
  const s = loaded();
  const r = T.migrateSecrets(s, vault);
  assert.equal(r.changed, true);
  assert.deepEqual(r.moved, ['todoistToken', 'clickupToken', 'imapPassword', 'calendar:cal-work', 'calendar:cal-2']);
  assert.equal(s.todoistToken, '');
  assert.equal(s.clickupToken, '');
  assert.equal(s.imapPassword, '');
  assert.equal(s.imapUser, 'a@b.c', 'the address is not a secret and stays');
  assert.equal(s.imapHost, 'imap.gmail.com');
  assert.equal('icsUrl' in s, false, 'the stale single-URL key is gone');
  assert.equal(s.secretsInKeychain, true);
  assert.deepEqual(s.calendars.map((f) => [f.id, f.url]), [['cal-work', ''], ['cal-2', ''], ['cal-off', '']]);
  assert.equal(storage.getSecret('icor-for-life-planner-todoist-token'), 'tok-todoist-1', 'trimmed on the way in');
  assert.equal(storage.getSecret('icor-for-life-planner-clickup-token'), 'pk_clickup_2');
  assert.equal(storage.getSecret('icor-for-life-planner-imap-password'), 'app-pass-3');
  assert.equal(storage.getSecret('icor-for-life-planner-calendar-cal-work'), GOOGLE);
  assert.equal(storage.getSecret('icor-for-life-planner-calendar-cal-2'), ICLOUD);
  assert.equal(storage.writes, 5, 'five secrets, five writes');
  // The second run is a no-op: nothing changed, nothing written.
  const again = T.migrateSecrets(s, vault);
  assert.deepEqual(again, { changed: false, moved: [] });
  assert.equal(storage.writes, 5);
  // The disk shape after migration carries none of the values.
  const json = JSON.stringify(s);
  for (const n of NEEDLES) assert.ok(!json.includes(n), `data.json still carries: ${n}`);
});

test('in data-json mode the migration touches nothing but the stale icsUrl', () => {
  const vault = new T.SecretVault(null);
  const s = loaded();
  const r = T.migrateSecrets(s, vault);
  assert.deepEqual(r, { changed: true, moved: [] }, 'icsUrl is dropped in both modes');
  assert.equal('icsUrl' in s, false);
  assert.equal(s.todoistToken, ' tok-todoist-1 ', 'the field is left exactly as it was');
  assert.equal(s.calendars[0].url, GOOGLE);
  assert.equal(s.secretsInKeychain, undefined, 'the flag is never set without a store');
  assert.deepEqual(T.migrateSecrets(s, vault), { changed: false, moved: [] }, 'a second run is a no-op');
});

test('a store that refuses a write leaves that secret where it was', () => {
  const storage = new FakeSecretStorage();
  storage.setSecret = (id) => { if (/clickup/.test(id)) throw new Error('keychain locked'); storage.m.set(id, 'x'); };
  const vault = new T.SecretVault(storage);
  const s = loaded();
  const r = T.migrateSecrets(s, vault);
  assert.equal(s.clickupToken, 'pk_clickup_2', 'not blanked: the store did not take it');
  assert.equal(s.todoistToken, '', 'the others moved');
  assert.ok(!r.moved.includes('clickupToken'));
  // The same rule on the settings tab's write path.
  assert.equal(T.writeSecret(s, vault, 'clickupToken', 'pk_new'), false);
  assert.equal(s.clickupToken, 'pk_new', 'kept in data.json, the fallback the user had before');
});

test('withSecrets fills every field and every feed address; the copy is shallow and never the original', () => {
  const { vault } = keychain();
  const s = loaded();
  T.migrateSecrets(s, vault);
  const r = T.withSecrets(s, vault);
  assert.notEqual(r, s);
  assert.equal(r.todoistToken, 'tok-todoist-1');
  assert.equal(r.clickupToken, 'pk_clickup_2');
  assert.equal(r.imapPassword, 'app-pass-3');
  assert.equal(r.imapUser, 'a@b.c');
  assert.deepEqual(r.calendars.map((f) => [f.id, f.url]), [['cal-work', GOOGLE], ['cal-2', ICLOUD], ['cal-off', '']]);
  assert.equal(r._shadow, s._shadow, 'the shadow map is the live one');
  assert.equal(s.todoistToken, '', 'the original stays blank');
  assert.equal(s.calendars[0].url, '', 'the original feed stays blank');
  // The pure consumers see a configured setup through the copy, not the original.
  assert.equal(T.sourceConfigured(s, 'todoist'), false, 'the raw settings look unconfigured in keychain mode');
  assert.equal(T.sourceConfigured(r, 'todoist'), true);
  assert.equal(T.sourceConfigured(r, 'clickup'), true);
  assert.equal(T.sourceConfigured(r, 'email'), true);
  assert.equal(T.sourceConfigured(r, 'calendar'), true);
  assert.deepEqual(T.enabledCalendarFeeds(r).map((f) => f.id), ['cal-work', 'cal-2']);
  assert.deepEqual(T.trayConnectionState(r).configured, ['todoist', 'clickup', 'email']);
  // A field that is still in data.json (data-json mode, or a value not yet moved) wins over the store.
  const mixed = Object.assign({}, s, { todoistToken: 'fresh-paste' });
  assert.equal(T.withSecrets(mixed, vault).todoistToken, 'fresh-paste');
  // Without a store the copy is the settings as they are.
  const plain = loaded();
  const p = T.withSecrets(plain, new T.SecretVault(null));
  assert.notEqual(p, plain);
  assert.equal(p.todoistToken, ' tok-todoist-1 ');
  assert.equal(p.calendars, plain.calendars);
});

test('the field accessors read and write through the store; a cleared value is deleted', () => {
  const { storage, vault } = keychain();
  const s = { todoistToken: '', secretsInKeychain: false };
  assert.equal(T.readSecret(s, vault, 'todoistToken'), '');
  assert.equal(T.writeSecret(s, vault, 'todoistToken', '  tok  '), true);
  assert.equal(s.todoistToken, '', 'the field stays blank');
  assert.equal(s.secretsInKeychain, true, 'the flag flips on the first store write');
  assert.equal(storage.getSecret('icor-for-life-planner-todoist-token'), 'tok');
  assert.equal(T.readSecret(s, vault, 'todoistToken'), 'tok');
  assert.equal(T.writeSecret(s, vault, 'todoistToken', ''), true);
  assert.equal(T.readSecret(s, vault, 'todoistToken'), '', 'cleared');
  assert.equal(storage.getSecret('icor-for-life-planner-todoist-token'), '', 'cleared by writing the empty string (the API has no delete)');
  // data-json mode: the field is the store.
  const none = new T.SecretVault(null);
  const d = { todoistToken: '' };
  assert.equal(T.writeSecret(d, none, 'todoistToken', 'tok'), false);
  assert.equal(d.todoistToken, 'tok');
  assert.equal(T.readSecret(d, none, 'todoistToken'), 'tok');
  assert.equal(d.secretsInKeychain, undefined);
});

test('the feed accessors read and write through the store; removing a feed forgets its address', () => {
  const { storage, vault } = keychain();
  const feed = { id: 'cal-work', name: 'Work', url: '', color: 1, enabled: true, kind: 'ics' };
  assert.equal(T.feedUrl(feed, vault), '');
  assert.equal(T.setFeedUrl(feed, ` ${GOOGLE} `, vault), true);
  assert.equal(feed.url, '', 'the entry stays blank');
  assert.equal(T.feedUrl(feed, vault), GOOGLE);
  assert.equal(T.feedUrl(feed), '', 'without the store a blank entry is blank: readers must be handed resolved feeds');
  assert.equal(T.calendarFeedStatusText(feed, null), 'Paste the iCal address to connect this calendar.');
  assert.equal(T.calendarFeedStatusText(feed, null, vault), 'Not synced yet this session.', 'the settings row sees the stored address');
  T.forgetFeedSecret(feed, vault);
  assert.equal(storage.getSecret('icor-for-life-planner-calendar-cal-work'), '');
  assert.equal(T.feedUrl(feed, vault), '');
  // A feed without an id cannot be keyed: the address stays on the entry.
  const anon = { name: 'X', url: '' };
  assert.equal(T.setFeedUrl(anon, GOOGLE, vault), false);
  assert.equal(anon.url, GOOGLE);
  // data-json mode: the entry is the store.
  const none = new T.SecretVault(null);
  const f2 = { id: 'cal-2', url: '' };
  assert.equal(T.setFeedUrl(f2, ICLOUD, none), false);
  assert.equal(f2.url, ICLOUD);
  assert.equal(T.feedUrl(f2, none), ICLOUD);
});

test('adoptSettings: what onload does with the bytes, in order, and whether it must write back', () => {
  const { storage, vault } = keychain();
  // A data.json from before 0.8.0: one icsUrl, no calendars. The calendar
  // migration runs first, then the address moves out and icsUrl is gone.
  const old = T.adoptSettings({ icsUrl: GOOGLE, todoistToken: 'tok' }, vault);
  assert.equal(old.changed, true);
  assert.deepEqual(old.moved, ['todoistToken', 'calendar:cal-1']);
  assert.deepEqual(old.settings.calendars.map((f) => [f.id, f.name, f.url]), [['cal-1', 'Google Calendar', '']]);
  assert.equal('icsUrl' in old.settings, false);
  assert.equal(old.settings.todoistToken, '');
  assert.equal(old.settings.secretsInKeychain, true);
  assert.equal(old.settings.plannerFolder, T.DEFAULT_SETTINGS.plannerFolder, 'the defaults are laid under');
  assert.equal(storage.getSecret('icor-for-life-planner-calendar-cal-1'), GOOGLE);
  // The second launch: nothing to move, nothing to write.
  const second = T.adoptSettings(JSON.parse(JSON.stringify(old.settings)), vault);
  assert.equal(second.changed, false);
  assert.deepEqual(second.moved, []);
  assert.equal(storage.writes, 2);
  // A fresh install on either Obsidian: the calendar migration adds the
  // empty `calendars` array (one write, the same as 0.8.0), nothing moves,
  // nothing reaches the store.
  const fresh = T.adoptSettings({}, vault);
  assert.equal(fresh.changed, true);
  assert.deepEqual(fresh.moved, []);
  assert.equal(storage.writes, 2, 'no store write for a fresh install');
  assert.deepEqual(T.adoptSettings(null, new T.SecretVault(null)).moved, []);
  // The same old data.json on an Obsidian without a store: the calendar
  // migration still runs, the address stays on the entry, icsUrl is dropped.
  const plain = T.adoptSettings({ icsUrl: GOOGLE }, new T.SecretVault(null));
  assert.equal(plain.changed, true);
  assert.equal(plain.settings.calendars[0].url, GOOGLE);
  assert.equal('icsUrl' in plain.settings, false);
  assert.equal(plain.settings.secretsInKeychain, false);
});

test('the settings tab says where the secrets are, in one line per mode', () => {
  assert.equal(T.secretsNoteText('data-json', false), 'Secrets are stored in this plugin\'s data.json (Obsidian 1.11.4 or newer keeps them in the system keychain).');
  assert.match(T.secretsNoteText('keychain', true), /system keychain/);
  assert.doesNotMatch(T.secretsNoteText('keychain', true), /data\.json \(/);
  // An older Obsidian opening a vault a newer one migrated: say why the fields are empty.
  const moved = T.secretsNoteText('data-json', true);
  assert.match(moved, /^Secrets are stored in this plugin's data\.json/);
  assert.match(moved, /paste them again here or update Obsidian/);
  for (const t of [T.secretsNoteText('data-json', false), moved, T.secretsNoteText('keychain', false)]) {
    assert.doesNotMatch(t, /[\u2013\u2014]/, 'no dashes of either length');
  }
});

test('secret-free after migration: the settings on disk and the cache note carry no secret', () => {
  const { vault } = keychain();
  const s = loaded();
  T.migrateSecrets(s, vault);
  const disk = JSON.stringify(Object.assign({}, T.DEFAULT_SETTINGS, s));
  for (const n of NEEDLES) assert.ok(!disk.includes(n), `data.json carries: ${n}`);
  // The cache note is built from the RESOLVED feeds (the fetch path) and
  // must still carry nothing: the def tag is id, name, colour only.
  const r = T.withSecrets(s, vault);
  const defs = [];
  for (const feed of T.enabledCalendarFeeds(r)) {
    defs.push(...T.tagCalendarDefs(T.parseIcs(
      `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:${feed.id}@x\nSUMMARY:Standup\nDTSTART;VALUE=DATE:20260907\nDTEND;VALUE=DATE:20260908\nEND:VEVENT\nEND:VCALENDAR\n`), feed));
  }
  const content = T.buildCalendarCacheContent(defs, new Date(2026, 8, 4, 9, 0), '02 Planner');
  for (const n of NEEDLES) assert.ok(!content.includes(n), `the cache carries: ${n}`);
  assert.deepEqual(Object.keys(defs[0]).filter((k) => /^feed/.test(k)).sort(), ['feedColor', 'feedId', 'feedName']);
});

test('source scan: no credential consumer is handed the raw settings', () => {
  const c = code();
  // The raw settings never reach a connector, a fetcher, the probe or a configured check.
  for (const bad of [
    /\.fetchOpen\(this\.settings\)/, /\.setClosed\(this\.settings/, /\.pushFields\(this\.settings/,
    /imapProbe\(this\.plugin\.settings\)/, /emailFetchStarred\(this\.settings/, /calendarFetchDefs\(this\.settings/,
    /calendarFetchAll\(this\.settings/, /sourceConfigured\(this\.settings/, /sourceConfigured\(this\.plugin\.settings/,
    /trayConnectionState\(this\.plugin\.settings/, /enabledCalendarFeeds\(this\.settings/, /calendarFeedFor\(plugin\.settings/,
  ]) assert.doesNotMatch(c, bad, `a credential consumer reads the raw settings: ${bad}`);
  // No class reads a secret field off the settings directly; the accessors do.
  assert.doesNotMatch(c, /this\.(plugin\.)?settings\.(todoistToken|clickupToken|imapPassword|outlookRefreshToken|icsUrl)\b/, 'a secret field is read off the settings object outside the layer');
  // The resolved view exists and the three sync paths use it.
  assert.match(c, /withSecrets\(\) \{ return withSecrets\(this\.settings, this\.secrets\); \}/);
  assert.match(c, /const s = this\.withSecrets\(\);[^\n]*\n\s*const runs = SYNCED_SOURCES\.map\(\(k\) => \[k, CONNECTORS\[k\]\.fetchOpen\(s\)\]\)/, 'syncNow resolves before the connectors start');
  assert.equal((c.match(/const s = this\.withSecrets\(\);/g) || []).length, 3, 'syncNow, upsertSource and detectAndPush');
  // Every write of the settings to disk goes through the one method that moves secrets out first.
  assert.equal((c.match(/this\.saveData\(this\.settings\)/g) || []).length, 1, 'saveData is called from persistSettings only');
  assert.match(c, /async persistSettings\(\) \{\n\s*migrateSecrets\(this\.settings, this\.secrets\);\n\s*await this\.saveData\(this\.settings\);/);
  assert.match(c, /this\.secrets = new SecretVault\(this\.app && this\.app\.secretStorage\);/, 'the store is feature-detected at load');
  assert.match(c, /const adopted = adoptSettings\(loaded, this\.secrets\);/, 'the load goes through adoptSettings');
});

test('source scan: a feed address is read through feedUrl and nowhere else', () => {
  const c = code();
  const allowed = [
    /^function feedUrl\(feed, vault\)/, /^  const v = trimmed\(feed && feed\.url\);$/, // feedUrl itself
    /^    url: typeof f\.url === 'string' \? f\.url\.trim\(\) : '',$/, // normalizeCalendarFeed
    /^  feed\.url = v;$/, /^    feed\.url = '';$/, // setFeedUrl
    /^      const v = trimmed\(f\.url\);$/, /^      f\.url = '';$/, // migrateSecrets
  ];
  const offenders = [];
  for (const line of c.split('\n')) {
    if (!/\b(feed|f|this\.feed)\.url\b/.test(line)) continue;
    if (allowed.some((re) => re.test(line))) continue;
    offenders.push(line.trim());
  }
  assert.deepEqual(offenders, [], 'a feed address is read off the entry directly');
  assert.match(c, /googleCalendarEventUrl\(ev, feedUrl\(this\.feed\)\)/, 'the modal reads the address through the accessor');
  // Since the Outlook calendar (2026-09-06) a feed is ready by its KIND: the
  // iCal connector still answers through the accessor, and both list
  // readers ask the connector rather than the entry.
  assert.match(c, /ready: \(feed\) => !!feedUrl\(feed\)/, 'the iCal connector asks the accessor');
  assert.match(c, /filter\(\(f\) => f\.enabled && calendarFeedReady\(f, settings\)\)/, 'enabledCalendarFeeds asks the connector');
  assert.match(c, /if \(feed\.enabled && c\.ready\(feed, settings\)\) jobs\.push/, 'calendarFetchAll asks the connector');
  assert.match(c, /secret\(row, \(\) => feedUrl\(feed, secrets\), \(v\) => \{ setFeedUrl\(feed, v, secrets\); \}/, 'the settings row reads and writes through the accessors');
  assert.match(c, /forgetFeedSecret\(feed, secrets\);\n\s*await this\.plugin\.saveSettings\(\);/, 'removing a feed forgets its address');
});

test('the settings tab: the secret fields read and write through the layer, and the note is shown', () => {
  const c = code();
  for (const field of ['todoistToken', 'clickupToken', 'imapPassword']) {
    assert.match(c, new RegExp(`readSecret\\(this\\.plugin\\.settings, secrets, '${field}'\\)`), `${field} read`);
    assert.match(c, new RegExp(`writeSecret\\(this\\.plugin\\.settings, secrets, '${field}', `), `${field} write`);
  }
  assert.match(c, /setDesc\(secretsNoteText\(secrets\.mode, this\.plugin\.settings\.secretsInKeychain === true\)\)/);
  assert.equal(T.DEFAULT_SETTINGS.secretsInKeychain, false, 'the flag is declared, off, and not a secret');
});
