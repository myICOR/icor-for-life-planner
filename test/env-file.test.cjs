/* The env file backend (0.12.0): a second place for the secrets, chosen in
 * settings, read INSTEAD of Obsidian's keychain and never beside it.
 *
 * The contract, gated here against a fake vault adapter:
 *   - the parser: comments, blanks, an export prefix, one pair of quotes,
 *     no interpolation, the first occurrence of a key wins;
 *   - the writer: exactly one line changes or one is appended, every other
 *     byte of the file is the byte that came in (CRLF included), a second
 *     write of the same value is the identity, an empty value is never
 *     appended, a present key is cleared to `KEY=`;
 *   - the store: memory first, disk through one queue, a fresh read before
 *     every write so another writer's lines survive, a failed write is an
 *     error sentence without the value and never a throw, and load waits for
 *     the queue so it can never read stale bytes over a pending write;
 *   - the vault: env mode ignores Obsidian's store entirely (no fallback,
 *     because a fallback hides a misconfiguration);
 *   - the migration moves a plaintext data.json value into the env file;
 *   - a move copies into the selected backend and blanks the source only
 *     after the target holds the value;
 *   - the existing store ids are unchanged, so nothing already stored is lost;
 *   - source scans: the load order, the sync reload, the settle in
 *     persistSettings, the dropdown, and no console or Notice inside the layer;
 *   - the shipped files: README section, CHANGELOG line, versions agree.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./harness.cjs');

const root = process.env.PLANNER_ROOT ? path.resolve(process.env.PLANNER_ROOT) : path.join(__dirname, '..');
const main = fs.readFileSync(T.__mainPath, 'utf8');
const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const ENV = '06 AI Team/AI Team Knowledge/.env';

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

// The vault adapter as the layer uses it: exists, read, write. Counts the
// writes and can be told to refuse them.
function fakeAdapter(files) {
  const a = {
    files: Object.assign({}, files || {}),
    writes: [],
    fail: null,
    async exists(p) { return Object.prototype.hasOwnProperty.call(a.files, p); },
    async read(p) { if (!(p in a.files)) throw new Error(`ENOENT: ${p}`); return a.files[p]; },
    async write(p, text) { if (a.fail) throw new Error(a.fail); a.files[p] = text; a.writes.push(p); },
  };
  return a;
}

const FIXTURE = [
  '# The AI team\'s keys',
  '',
  'SUPABASE_URL=https://example.supabase.co',
  'export OPENAI_API_KEY=sk-first',
  'OPENAI_API_KEY=sk-second',
  'QUOTED="with spaces inside"',
  'SINGLE=\'single\'',
  'SPACED = spaced value ',
  '#TODOIST_TOKEN=commented-out',
  'LITERAL=$SUPABASE_URL/x',
  'TRAILING=value # not a comment',
  '',
  'LAST=9',
].join('\n');

test('the parser: comments, blanks, export, quotes, spacing, no interpolation, first wins', () => {
  const p = T.parseEnvText(FIXTURE);
  assert.equal(p.SUPABASE_URL, 'https://example.supabase.co');
  assert.equal(p.OPENAI_API_KEY, 'sk-first', 'the first occurrence wins, export prefix or not');
  assert.equal(p.QUOTED, 'with spaces inside');
  assert.equal(p.SINGLE, 'single');
  assert.equal(p.SPACED, 'spaced value');
  assert.equal('TODOIST_TOKEN' in p, false, 'a commented-out line is a comment');
  assert.equal(p.LITERAL, '$SUPABASE_URL/x', 'no interpolation');
  assert.equal(p.TRAILING, 'value # not a comment', 'no inline comments: the value is everything after the first =');
  assert.equal(p.LAST, '9', 'a file without a trailing newline still yields its last line');
  assert.deepEqual(T.parseEnvText(''), {});
  assert.deepEqual(T.parseEnvText(null), {});
  assert.deepEqual(T.parseEnvText('A=1\r\nB=2\r\n'), { A: '1', B: '2' }, 'CRLF lines parse without the CR');
  assert.deepEqual(T.parseEnvText('not a line\n=novalue\n1A=x\n'), {}, 'lines that are not KEY=value are skipped');
  assert.equal(T.parseEnvText('EMPTY=\n').EMPTY, '', 'a present key with no value is the empty string');
});

test('the env key of every store id, and the store ids themselves are unchanged', () => {
  assert.equal(T.SECRET_KEY_PREFIX, 'icor-for-life-planner-');
  assert.deepEqual(T.SECRET_FIELDS, {
    todoistToken: 'todoist-token', clickupToken: 'clickup-token', imapPassword: 'imap-password',
    outlookRefreshToken: 'outlook-refresh-token', outlookAccessToken: 'outlook-access-token',
    outlookExpiresAt: 'outlook-expires-at', outlookAccount: 'outlook-account',
  }, 'the ids members already have in their keychain must keep resolving');
  const want = {
    todoistToken: 'TODOIST_TOKEN', clickupToken: 'CLICKUP_TOKEN', imapPassword: 'IMAP_PASSWORD',
    outlookRefreshToken: 'OUTLOOK_REFRESH_TOKEN', outlookAccessToken: 'OUTLOOK_ACCESS_TOKEN',
    outlookExpiresAt: 'OUTLOOK_EXPIRES_AT', outlookAccount: 'OUTLOOK_ACCOUNT',
  };
  for (const [field, key] of Object.entries(want)) assert.equal(T.envKeyFor(T.fieldSecretKey(field)), key, field);
  assert.equal(T.envKeyFor(T.calendarSecretKey('cal-1')), 'PLANNER_CALENDAR_CAL_1');
  assert.equal(T.envKeyFor(T.calendarSecretKey('Cal Work')), 'PLANNER_CALENDAR_CAL_WORK');
  assert.equal(T.envKeyFor('todoist-token'), 'TODOIST_TOKEN', 'a bare suffix maps the same way');
  assert.throws(() => T.envKeyFor(''), /not an env key/);
  assert.throws(() => T.envLineFor('bad key', 'x'), /not an env key/);
  assert.equal(T.envLineFor('A', 'one\ntwo\r\n'), 'A=onetwo', 'a value cannot carry a line break into the file');
});

test('the writer appends one line and every byte before it is the byte that came in', () => {
  const noNl = 'A=1\nB=2';
  const out = T.upsertEnvLine(noNl, 'TODOIST_TOKEN', 'tok');
  assert.ok(out.startsWith(noNl), 'the existing bytes are a prefix of the result');
  assert.equal(out, 'A=1\nB=2\nTODOIST_TOKEN=tok\n', 'a separator when the file did not end in one, then the line, then a newline');
  assert.equal(T.upsertEnvLine('A=1\n', 'K', 'v'), 'A=1\nK=v\n');
  assert.equal(T.upsertEnvLine('', 'K', 'v'), 'K=v\n');
  assert.equal(T.upsertEnvLine(null, 'K', 'v'), 'K=v\n');
  assert.equal(T.upsertEnvLine('A=1\r\nB=2', 'K', 'v'), 'A=1\r\nB=2\r\nK=v\r\n', 'a CRLF file gets a CRLF line');
  assert.equal(T.upsertEnvLine(FIXTURE, 'TODOIST_TOKEN', 'tok'), `${FIXTURE}\nTODOIST_TOKEN=tok\n`, 'a commented-out key is not the line to edit');
});

test('the writer rewrites exactly one line, the first occurrence, and leaves the rest byte-identical', () => {
  const out = T.upsertEnvLine(FIXTURE, 'OPENAI_API_KEY', 'sk-new');
  const before = FIXTURE.split('\n');
  const after = out.split('\n');
  assert.equal(after.length, before.length, 'no line added or removed');
  const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
  assert.deepEqual(changed, [3], 'only the first OPENAI_API_KEY line changed');
  assert.equal(after[3], 'OPENAI_API_KEY=sk-new', 'rewritten bare: no export prefix, no quotes');
  assert.equal(after[4], 'OPENAI_API_KEY=sk-second', 'the second occurrence is untouched');
  assert.equal(T.parseEnvText(out).OPENAI_API_KEY, 'sk-new', 'reader and writer agree on which line counts');
  // A quoted or spaced line becomes a bare one; parse gives the value back.
  for (const key of ['QUOTED', 'SPACED', 'SINGLE']) {
    const o = T.upsertEnvLine(FIXTURE, key, 'plain');
    assert.equal(T.parseEnvText(o)[key], 'plain');
    assert.equal(o.split('\n').filter((l, i) => l !== before[i]).length, 1, `${key}: one line`);
  }
  // CRLF: the edited line keeps its CR.
  assert.equal(T.upsertEnvLine('A=1\r\nB=2\r\n', 'A', '9'), 'A=9\r\nB=2\r\n');
});

test('the writer is idempotent, and clearing keeps the slot without ever adding one', () => {
  const once = T.upsertEnvLine(FIXTURE, 'TODOIST_TOKEN', 'tok');
  assert.equal(T.upsertEnvLine(once, 'TODOIST_TOKEN', 'tok'), once, 'the same text back when the line already reads so');
  assert.equal(T.upsertEnvLine(FIXTURE, 'LAST', '9'), FIXTURE, 'identity on a present exact line, trailing newline or not');
  assert.equal(T.upsertEnvLine(FIXTURE, 'ABSENT', ''), FIXTURE, 'an empty value for an absent key adds nothing');
  const cleared = T.upsertEnvLine(once, 'TODOIST_TOKEN', '');
  assert.equal(cleared, `${FIXTURE}\nTODOIST_TOKEN=\n`, 'a present key clears to KEY=');
  assert.equal(T.parseEnvText(cleared).TODOIST_TOKEN, '');
  assert.equal(T.upsertEnvLine(cleared, 'TODOIST_TOKEN', ''), cleared, 'clearing twice is the identity');
});

test('the store: load, read from memory, write through one queue with a fresh read first', async () => {
  const a = fakeAdapter({ [ENV]: 'A=1\nOPENAI_API_KEY=sk\n' });
  const s = new T.EnvFileStore(a, ENV);
  assert.equal(s.loaded, false);
  await s.load();
  assert.equal(s.exists, true);
  assert.equal(s.error, '');
  assert.equal(s.getSecret(T.fieldSecretKey('todoistToken')), null, 'absent is null, like the API');
  s.setSecret(T.fieldSecretKey('todoistToken'), 'tok-1');
  assert.equal(s.getSecret(T.fieldSecretKey('todoistToken')), 'tok-1', 'in memory at once');
  assert.deepEqual(a.writes, [], 'not on disk yet');
  await s.settle();
  assert.equal(a.files[ENV], 'A=1\nOPENAI_API_KEY=sk\nTODOIST_TOKEN=tok-1\n');
  // Another tool writes a line between two of ours: it survives, because
  // every flush reads the file again before it edits.
  s.setSecret(T.fieldSecretKey('clickupToken'), 'pk_1');
  a.files[ENV] += 'FOREIGN=yes\n';
  await s.settle();
  assert.equal(a.files[ENV], 'A=1\nOPENAI_API_KEY=sk\nTODOIST_TOKEN=tok-1\nFOREIGN=yes\nCLICKUP_TOKEN=pk_1\n');
  // Two writes back to back land in order, and a rewrite of the same value
  // costs no write.
  s.setSecret(T.fieldSecretKey('todoistToken'), 'tok-2');
  s.setSecret(T.fieldSecretKey('todoistToken'), 'tok-2');
  await s.settle();
  assert.equal(T.parseEnvText(a.files[ENV]).TODOIST_TOKEN, 'tok-2');
  assert.equal(a.writes.length, 3, 'three writes changed bytes; the repeat did not');
  assert.deepEqual(s.listSecrets().sort(), ['A', 'CLICKUP_TOKEN', 'OPENAI_API_KEY', 'TODOIST_TOKEN']);
  // A value with a line break lands on one line.
  s.setSecret(T.fieldSecretKey('imapPassword'), 'ab\ncd');
  await s.settle();
  assert.equal(T.parseEnvText(a.files[ENV]).IMAP_PASSWORD, 'abcd');
  assert.equal(a.files[ENV].split('\n').filter((l) => l.startsWith('IMAP_PASSWORD=')).length, 1);
});

test('the store: a missing file is empty, is created on the first write, and load waits for the queue', async () => {
  const a = fakeAdapter({});
  const s = new T.EnvFileStore(a, ENV);
  await s.load();
  assert.equal(s.exists, false);
  assert.equal(s.error, '');
  assert.deepEqual(s.values, {});
  s.setSecret(T.fieldSecretKey('todoistToken'), 'tok');
  // load() right behind a write must see the write, never the old disk.
  await s.load();
  assert.equal(s.getSecret(T.fieldSecretKey('todoistToken')), 'tok');
  assert.equal(s.exists, true);
  assert.equal(a.files[ENV], 'TODOIST_TOKEN=tok\n');
  // Defaults: a blank path is the default path; a store without an adapter reads as empty and cannot write.
  assert.equal(new T.EnvFileStore(a, '').path, T.DEFAULT_ENV_FILE_PATH);
  const none = new T.EnvFileStore(null, ENV);
  await none.load();
  assert.equal(none.exists, false);
  none.setSecret(T.fieldSecretKey('todoistToken'), 'x');
  await none.settle();
  assert.match(none.error, /no vault adapter/);
});

test('the store: a refused write is an error sentence, never a throw, never the value; the queue goes on', async () => {
  const a = fakeAdapter({ [ENV]: 'A=1\n' });
  const s = new T.EnvFileStore(a, ENV);
  await s.load();
  a.fail = 'EACCES: permission denied';
  s.setSecret(T.fieldSecretKey('todoistToken'), 'tok-secret-value');
  await s.settle();
  assert.equal(s.error, 'EACCES: permission denied');
  assert.ok(!s.error.includes('tok-secret-value'));
  assert.equal(a.files[ENV], 'A=1\n', 'the file is untouched');
  assert.equal(s.getSecret(T.fieldSecretKey('todoistToken')), 'tok-secret-value', 'memory still holds it, and the tab says the write failed');
  a.fail = null;
  s.setSecret(T.fieldSecretKey('clickupToken'), 'pk');
  await s.settle();
  assert.equal(s.error, '', 'the next successful write clears the error');
  assert.equal(T.parseEnvText(a.files[ENV]).CLICKUP_TOKEN, 'pk');
  // An unreadable file: an error and an empty store, never a stale one.
  const b = fakeAdapter({ [ENV]: 'A=1\n' });
  b.read = async () => { throw new Error('EISDIR: is a directory'); };
  const t = new T.EnvFileStore(b, ENV);
  await t.load();
  assert.equal(t.error, 'EISDIR: is a directory');
  assert.deepEqual(t.values, {});
  assert.equal(t.exists, false);
});

test('the vault in env mode reads the file and only the file: no fallback to the store', async () => {
  const storage = new FakeSecretStorage();
  storage.setSecret(T.fieldSecretKey('todoistToken'), 'in-the-store');
  const a = fakeAdapter({ [ENV]: 'CLICKUP_TOKEN=pk_env\n' });
  const env = await new T.EnvFileStore(a, ENV).load();
  const vault = new T.SecretVault(storage, env);
  assert.equal(vault.mode, 'env-file');
  assert.equal(vault.backend, 'env-file');
  assert.equal(vault.available(), true);
  assert.equal(vault.storage, null, 'the store is not even held');
  assert.equal(vault.get(T.fieldSecretKey('todoistToken')), '', 'a value only in the store is not read');
  assert.equal(vault.get(T.fieldSecretKey('clickupToken')), 'pk_env');
  const s = { todoistToken: '', clickupToken: '', imapHost: 'h', imapUser: 'u', imapPassword: '', calendars: [], secretsInStore: true };
  assert.equal(T.readSecret(s, vault, 'todoistToken'), '');
  const r = T.withSecrets(s, vault);
  assert.equal(r.todoistToken, '');
  assert.equal(r.clickupToken, 'pk_env');
  assert.equal(T.sourceConfigured(r, 'todoist'), false, 'unconfigured, visibly, rather than quietly served from the other backend');
  assert.equal(T.sourceConfigured(r, 'clickup'), true);
  // The other two shapes are what they were.
  assert.equal(new T.SecretVault(storage).mode, 'store');
  assert.equal(new T.SecretVault(storage).backend, 'secret-storage');
  assert.equal(new T.SecretVault(null).backend, 'data-json');
  assert.equal(new T.SecretVault(storage, {}).mode, 'store', 'a thing that is not a store is not an env backend');
  // A write goes to the file, and settle resolves once it is there.
  assert.equal(T.writeSecret(s, vault, 'todoistToken', 'tok-env'), true);
  assert.equal(s.todoistToken, '');
  await vault.settle();
  assert.equal(T.parseEnvText(a.files[ENV]).TODOIST_TOKEN, 'tok-env');
  assert.equal(storage.getSecret(T.fieldSecretKey('todoistToken')), 'in-the-store', 'the store is never written in env mode');
  await new T.SecretVault(storage).settle();
});

test('the migration moves a plaintext data.json value into the env file, once', async () => {
  const a = fakeAdapter({ [ENV]: '# keys\n' });
  const env = await new T.EnvFileStore(a, ENV).load();
  const vault = new T.SecretVault(null, env);
  const s = { todoistToken: ' tok-plain ', clickupToken: '', calendars: [{ id: 'cal-1', name: 'Work', url: 'https://x/private-abc/basic.ics', color: 1, enabled: true, kind: 'ics' }] };
  const r = T.migrateSecrets(s, vault);
  assert.deepEqual(r, { changed: true, moved: ['todoistToken', 'calendar:cal-1'] });
  assert.equal(s.todoistToken, '');
  assert.equal(s.calendars[0].url, '');
  assert.equal(s.secretsInStore, true);
  await vault.settle();
  assert.equal(a.files[ENV], '# keys\nTODOIST_TOKEN=tok-plain\nPLANNER_CALENDAR_CAL_1=https://x/private-abc/basic.ics\n');
  const json = JSON.stringify(s);
  for (const n of ['tok-plain', 'private-abc']) assert.ok(!json.includes(n), `data.json still carries: ${n}`);
  assert.deepEqual(T.migrateSecrets(s, vault), { changed: false, moved: [] });
  await vault.settle();
  assert.equal(a.writes.length, 2, 'a second run writes nothing');
  // adoptSettings carries the two settings through untouched and lays the defaults under them.
  const adopted = T.adoptSettings({ secretsBackend: 'env-file', envFilePath: 'x/.env' }, new T.SecretVault(null));
  assert.equal(adopted.settings.secretsBackend, 'env-file');
  assert.equal(adopted.settings.envFilePath, 'x/.env');
  assert.equal(T.DEFAULT_SETTINGS.secretsBackend, 'secret-storage');
  assert.equal(T.DEFAULT_SETTINGS.envFilePath, T.DEFAULT_ENV_FILE_PATH);
  assert.equal(T.DEFAULT_ENV_FILE_PATH, ENV);
});

test('data.json seen as a store, and where each key is present', () => {
  const s = { todoistToken: 'tok', clickupToken: '', calendars: [{ id: 'cal-1', url: 'https://feed' }, { id: 'outlook-graph', kind: 'graph', url: '' }] };
  const d = T.dataJsonStore(s);
  assert.equal(d.getSecret(T.fieldSecretKey('todoistToken')), 'tok');
  assert.equal(d.getSecret(T.fieldSecretKey('clickupToken')), '');
  assert.equal(d.getSecret(T.calendarSecretKey('cal-1')), 'https://feed');
  assert.equal(d.getSecret('icor-for-life-planner-nope'), null);
  assert.throws(() => d.setSecret('icor-for-life-planner-nope', 'x'), /unknown secret/);
  d.setSecret(T.fieldSecretKey('todoistToken'), ' new ');
  assert.equal(s.todoistToken, 'new', 'written in place, trimmed');
  d.setSecret(T.calendarSecretKey('cal-1'), '');
  assert.equal(s.calendars[0].url, '', 'the entry, not a copy');
  const storage = new FakeSecretStorage();
  storage.setSecret(T.fieldSecretKey('todoistToken'), 'store-copy');
  const env = new T.EnvFileStore(null, ENV);
  env.values = { TODOIST_TOKEN: 'env-copy', CLICKUP_TOKEN: '' };
  const holders = { 'secret-storage': storage, 'env-file': env, 'data-json': d };
  assert.deepEqual(T.secretPresence(T.fieldSecretKey('todoistToken'), holders), ['secret-storage', 'env-file', 'data-json']);
  assert.deepEqual(T.secretPresence(T.fieldSecretKey('clickupToken'), holders), []);
  assert.deepEqual(T.secretPresence(T.fieldSecretKey('todoistToken'), { 'secret-storage': null, 'env-file': env }), ['env-file'], 'a missing backend is skipped');
  const throwing = { getSecret() { throw new Error('locked'); } };
  assert.deepEqual(T.secretPresence('x', { 'secret-storage': throwing }), [], 'a throwing backend counts as empty');
});

test('a move copies into the target and blanks the source only once the target holds it', async () => {
  const id = T.fieldSecretKey('todoistToken');
  // store -> env file
  const storage = new FakeSecretStorage();
  storage.setSecret(id, 'tok');
  const a = fakeAdapter({ [ENV]: '' });
  const env = await new T.EnvFileStore(a, ENV).load();
  assert.equal(await T.moveSecret(id, storage, env), true);
  assert.equal(a.files[ENV], 'TODOIST_TOKEN=tok\n', 'on disk before the source is blanked');
  assert.equal(storage.getSecret(id), '', 'the source is cleared (the API has no delete)');
  // env file -> store
  assert.equal(await T.moveSecret(id, env, storage), true);
  assert.equal(storage.getSecret(id), 'tok');
  assert.equal(a.files[ENV], 'TODOIST_TOKEN=\n', 'the file keeps the slot, empty');
  // data.json -> env file
  const s = { todoistToken: 'plain' };
  assert.equal(await T.moveSecret(id, T.dataJsonStore(s), env), true);
  assert.equal(s.todoistToken, '');
  assert.equal(T.parseEnvText(a.files[ENV]).TODOIST_TOKEN, 'plain');
  // A target that cannot write: the source is untouched, the answer is false.
  const b = fakeAdapter({ [ENV]: '' });
  const broken = await new T.EnvFileStore(b, ENV).load();
  b.fail = 'EACCES';
  const s2 = new FakeSecretStorage();
  s2.setSecret(id, 'keep-me');
  assert.equal(await T.moveSecret(id, s2, broken), false);
  assert.equal(s2.getSecret(id), 'keep-me');
  assert.equal(b.files[ENV], '');
  // A store that refuses, an empty source, the same object twice: all false.
  const refusing = { getSecret() { return null; }, setSecret() { throw new Error('locked'); } };
  assert.equal(await T.moveSecret(id, s2, refusing), false);
  assert.equal(s2.getSecret(id), 'keep-me');
  assert.equal(await T.moveSecret(id, new FakeSecretStorage(), env), false);
  assert.equal(await T.moveSecret(id, env, env), false);
  assert.equal(await T.moveSecret(id, null, env), false);
});

test('the settings: backend and path normalisers', () => {
  assert.deepEqual(T.SECRETS_BACKENDS, ['secret-storage', 'env-file']);
  assert.equal(T.normalizeSecretsBackend('env-file'), 'env-file');
  for (const v of ['secret-storage', undefined, null, '', 'data-json', 'keychain', 42]) assert.equal(T.normalizeSecretsBackend(v), 'secret-storage', String(v));
  const ok = (v) => T.normalizeEnvFilePath(v);
  assert.deepEqual(ok(' 06 AI Team/AI Team Knowledge/.env '), { ok: true, path: ENV, error: '' });
  assert.equal(ok('./a/./b/.env').path, 'a/b/.env');
  assert.equal(ok('a\\b\\.env').path, 'a/b/.env', 'backslashes are read as separators');
  assert.equal(ok('a//b/.env').path, 'a/b/.env');
  assert.equal(ok('.env').path, '.env', 'the vault root is fine');
  for (const bad of ['', '   ', '/abs/.env', 'C:/x/.env', '~/.env', '../.env', 'a/../.env', '.', './']) {
    const r = ok(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.path, '');
    assert.ok(r.error.length > 10);
    assert.doesNotMatch(r.error, /[\u2013\u2014]/);
  }
  assert.equal(T.secretsBackendLabel('secret-storage'), 'Obsidian\'s keychain');
  assert.equal(T.secretsBackendLabel('env-file'), 'the env file');
  assert.equal(T.secretsBackendLabel('data-json'), 'this plugin\'s data.json');
  assert.equal(T.secretsBackendLabel('other'), 'this plugin\'s data.json');
});

test('the key list: the five credentials by name, every pasted calendar, never the Outlook calendar', () => {
  const s = { calendars: [
    { id: 'cal-1', name: 'Work', url: '', color: 1, enabled: true, kind: 'ics' },
    { id: 'outlook-graph', name: 'Outlook', url: '', color: 2, enabled: true, kind: 'graph' },
    { id: 'cal-3', name: '', url: '', color: 3, enabled: false, kind: 'ics' },
  ] };
  const slots = T.secretSlots(s);
  assert.deepEqual(slots.map((x) => x.envKey), ['TODOIST_TOKEN', 'CLICKUP_TOKEN', 'IMAP_PASSWORD', 'OUTLOOK_REFRESH_TOKEN', 'OUTLOOK_ACCESS_TOKEN', 'PLANNER_CALENDAR_CAL_1', 'PLANNER_CALENDAR_CAL_3']);
  assert.deepEqual(slots.map((x) => x.label), ['Todoist API token', 'ClickUp API token', 'Mailbox app password', 'Outlook refresh token', 'Outlook access token', 'Calendar address: Work', 'Calendar address: Calendar 3']);
  assert.deepEqual(slots[4].ids, ['outlook-access-token', 'outlook-expires-at', 'outlook-account'].map((x) => `icor-for-life-planner-${x}`), 'the expiry and the account name travel with the access token');
  assert.deepEqual(slots[0].ids, [T.fieldSecretKey('todoistToken')]);
  assert.equal(T.secretSlots({}).length, 5);
  assert.equal(T.secretSlots(null).length, 5);
  // Status sentences.
  assert.equal(T.secretStatusText([], 'env-file'), 'Not set.');
  assert.equal(T.secretStatusText(['env-file'], 'env-file'), 'Stored in the env file.');
  assert.equal(T.secretStatusText(['secret-storage'], 'env-file'), 'Stored in Obsidian\'s keychain. Not in the env file, the backend in use, so it is not read until it is moved.');
  assert.equal(T.secretStatusText(['secret-storage', 'env-file'], 'secret-storage'), 'Stored in Obsidian\'s keychain and the env file. The copy in Obsidian\'s keychain is the one in use.');
  assert.equal(T.secretStatusText(['secret-storage', 'env-file', 'data-json'], 'env-file'), 'Stored in Obsidian\'s keychain, the env file and this plugin\'s data.json. The copy in the env file is the one in use.');
  assert.equal(T.secretStatusText(['data-json'], 'data-json'), 'Stored in this plugin\'s data.json.');
  // The note for env mode names the path and says the keychain is not read.
  const note = T.secretsNoteText('env-file', true, 'x/.env');
  assert.match(note, /^Secrets are stored in the env file at x\/\.env /);
  assert.match(note, /Obsidian's keychain is not consulted/);
  assert.match(T.secretsNoteText('env-file', false, ''), new RegExp(ENV.replace(/[.\/]/g, '\\$&')), 'a blank path reads as the default');
  for (const t of [note, T.secretsNoteText('store', true), T.secretsNoteText('data-json', true), T.secretsNoteText('data-json', false)]) {
    assert.doesNotMatch(t, /[\u2013\u2014]/, 'no dashes of either length');
  }
});

test('source scan: the load order, the reload before a sync, the settle after a save', () => {
  assert.match(code, /this\.secretStorage = secretStorageUsable\(this\.app && this\.app\.secretStorage\) \? this\.app\.secretStorage : null;/);
  assert.match(code, /const backend = normalizeSecretsBackend\(loaded\.secretsBackend\);\n\s*const envPath = normalizeEnvFilePath\(loaded\.envFilePath\)\.path \|\| DEFAULT_ENV_FILE_PATH;\n\s*this\.envStore = this\.envStoreFor\(envPath\);\n\s*if \(backend === 'env-file'\) await this\.envStore\.load\(\);\n\s*this\.secrets = this\.vaultFor\(backend\);\n\s*const adopted = adoptSettings\(loaded, this\.secrets\);/, 'the env file is read before the migration and only when selected');
  assert.match(code, /async persistSettings\(\) \{\n\s*migrateSecrets\(this\.settings, this\.secrets\);\n\s*await this\.saveData\(this\.settings\);\n\s*await this\.secrets\.settle\(\);\n\s*\}/, 'a save is not done until the env file is');
  assert.match(code, /await this\.ensureFolders\(\);\n\s*if \(this\.secrets\.mode === 'env-file'\) await this\.envStore\.load\(\);\n\s*const s = this\.withSecrets\(\);/, 'a hand edit of the env file is seen at the next sync');
  assert.match(code, /vaultFor\(backend\) \{\n\s*return normalizeSecretsBackend\(backend\) === 'env-file' \? new SecretVault\(null, this\.envStore\) : new SecretVault\(this\.secretStorage\);/, 'one backend per vault, never both');
  assert.match(code, /'secret-storage': this\.secretStorage, 'env-file': this\.envStore, 'data-json': dataJsonStore\(this\.settings\)/, 'the three holders for the status rows');
  assert.equal((code.match(/new EnvFileStore\(/g) || []).length, 1, 'the env store is built in one place');
});

test('source scan: the settings tab offers the two backends, the path, and a Move per key', () => {
  const tab = code.slice(code.indexOf('class IcorPlannerSettingTab'));
  assert.match(tab, /d\.addOption\('secret-storage', hasStore \? 'Obsidian\\'s keychain' : 'Obsidian\\'s keychain \(needs Obsidian 1\.11\.4 or newer\)'\);\n\s*d\.addOption\('env-file', 'An env file in the vault'\);/);
  assert.match(tab, /if \(opt\) opt\.disabled = true;/, 'without a store the keychain option cannot be picked');
  assert.match(tab, /d\.onChange\(async \(v\) => \{ await this\.plugin\.setSecretsBackend\(v\); this\.display\(\); \}\);/);
  assert.match(tab, /\.setName\('Env file'\)/);
  assert.match(tab, /await this\.plugin\.setEnvFilePath\(n\.path\);/);
  assert.match(tab, /t\.inputEl\.setAttribute\('aria-label', 'Env file path, relative to the vault'\);/);
  assert.match(tab, /for \(const slot of secretSlots\(this\.plugin\.settings\)\) \{/);
  assert.match(tab, /b\.setButtonText\(`Move to \$\{secretsBackendLabel\(selected\)\}`\)/);
  assert.match(tab, /const n = await this\.plugin\.moveSecretsFrom\(from, \[slot\]\);/);
  assert.match(tab, /\.setName\('Move every key'\)/);
  assert.match(tab, /setDesc\(secretsNoteText\(secrets\.mode, this\.plugin\.settings\.secretsInStore === true, this\.plugin\.settings\.envFilePath\)\)/);
  // Every token row says where the value goes.
  assert.equal((tab.match(/\$\{storedIn\}`\)/g) || []).length, 3, 'Todoist, ClickUp, the app password');
  assert.match(tab, /const storedIn = ` Stored in \$\{secretsBackendLabel\(secrets\.backend\)\}\.`;/);
  // The switch itself moves nothing: no move call inside setSecretsBackend.
  const sw = code.slice(code.indexOf('async setSecretsBackend('), code.indexOf('async setEnvFilePath('));
  assert.doesNotMatch(sw, /moveSecret/, 'choosing a backend moves nothing by itself');
});

test('source scan: nothing in the layer logs, and no Notice carries a value', () => {
  const start = main.indexOf('the env file backend (0.12.0)');
  const end = main.indexOf('function secretStatusText(');
  assert.ok(start > 0 && end > start);
  const layer = main.slice(start, end);
  assert.doesNotMatch(layer, /console\./, 'the layer never logs');
  assert.doesNotMatch(layer, /new Notice\(/, 'the layer never raises a Notice');
  // The Notices the tab raises name a key by its label and a count, never a value.
  const tab = code.slice(code.indexOf('class IcorPlannerSettingTab'));
  const secretsBlock = tab.slice(tab.indexOf("setName('Secrets').setHeading()"), tab.indexOf("setName('Vault').setHeading()"));
  for (const m of secretsBlock.match(/new Notice\([^\n]*\)/g) || []) {
    assert.doesNotMatch(m, /\$\{(v|value|secret)\}/, m);
  }
  // No dash of either length anywhere in the added code.
  assert.doesNotMatch(layer, /[\u2013\u2014]/);
  assert.doesNotMatch(secretsBlock, /[\u2013\u2014]/);
});

test('the shipped files: README section, CHANGELOG line, the three version files agree', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const section = readme.slice(readme.indexOf('## Where your keys live'));
  assert.ok(section.length > 0, 'README has a "Where your keys live" section');
  for (const key of ['TODOIST_TOKEN', 'CLICKUP_TOKEN', 'IMAP_PASSWORD', 'OUTLOOK_REFRESH_TOKEN', 'OUTLOOK_ACCESS_TOKEN', 'OUTLOOK_EXPIRES_AT', 'OUTLOOK_ACCOUNT', 'PLANNER_CALENDAR_']) {
    assert.ok(section.includes(`\`${key}`), `README names ${key}`);
  }
  assert.match(section, /secretsBackend/);
  assert.match(section, /envFilePath/);
  assert.match(readme, /An account is required/i, 'the account disclosure');
  assert.match(readme, /## Network use \(disclosure\)/, 'the network disclosure');
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
  assert.ok(changelog.includes(`## [${manifest.version}]`), `CHANGELOG has a ${manifest.version} entry`);
  assert.match(changelog, /env file/);
  assert.equal(pkg.version, manifest.version, 'package.json and manifest.json name the same version');
  assert.equal(versions[manifest.version], manifest.minAppVersion);
  for (const f of ['README.md', 'CHANGELOG.md', 'SECURITY.md']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /[\u2013\u2014]/, `${f}: no dashes of either length`);
  }
});
