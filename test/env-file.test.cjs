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
 *   - Vex P-1 (2026-09-08): on the env backend no synchronous path (set,
 *     writeSecret, migrateSecrets, setFeedUrl) ever blanks data.json; the
 *     settled migration in persistSettings blanks a field only once its
 *     line is on disk, a failed write leaves the value in data.json, and
 *     the store's memory never claims what the disk refused;
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
  const failed = s.setSecret(T.fieldSecretKey('todoistToken'), 'tok-secret-value');
  assert.equal(s.getSecret(T.fieldSecretKey('todoistToken')), 'tok-secret-value', 'memory first, while the write is queued');
  assert.equal(await failed, false, 'the write answers for itself: false, never a throw');
  assert.equal(s.error, 'EACCES: permission denied');
  assert.ok(!s.error.includes('tok-secret-value'));
  assert.equal(a.files[ENV], 'A=1\n', 'the file is untouched');
  assert.equal(s.getSecret(T.fieldSecretKey('todoistToken')), null, 'memory takes it back: the store never claims what the disk refused (Vex P-1)');
  assert.deepEqual(s.listSecrets(), ['A']);
  // A key the disk already had goes back to the disk's value, not to nothing.
  assert.equal(await s.setSecret('a', 'two'), false);
  assert.equal(s.getSecret('a'), '1', 'back to the bytes read just before the failed write');
  a.fail = null;
  assert.equal(await s.setSecret(T.fieldSecretKey('clickupToken'), 'pk'), true);
  assert.equal(s.error, '', 'the next successful write clears the error');
  assert.equal(T.parseEnvText(a.files[ENV]).CLICKUP_TOKEN, 'pk');
  // Two writes of one key queued together: the first fails, the second
  // lands, and memory ends where the disk ends. Both failing ends at the disk too.
  const realWrite = a.write;
  let refusals = 1; // the adapter is asked at write time, so the refusal is counted there, not flipped here
  a.write = async (p, text) => { if (refusals > 0) { refusals -= 1; throw new Error('EACCES'); } return realWrite(p, text); };
  const first = s.setSecret('a', 'x');
  const second = s.setSecret('a', 'y');
  assert.deepEqual([await first, await second], [false, true]);
  assert.equal(s.getSecret('a'), 'y');
  assert.equal(T.parseEnvText(a.files[ENV]).A, 'y');
  refusals = 2;
  assert.deepEqual(await Promise.all([s.setSecret('a', 'p'), s.setSecret('a', 'q')]), [false, false]);
  assert.equal(s.getSecret('a'), 'y', 'the disk still says y, so memory says y');
  a.write = realWrite;
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
  // A sync write cannot be confirmed on this backend, so it keeps the value
  // in the field; the settled migration moves it, and the file has it
  // before the field is blanked.
  assert.equal(vault.immediate, false);
  assert.equal(T.writeSecret(s, vault, 'todoistToken', 'tok-env'), false);
  assert.equal(s.todoistToken, 'tok-env', 'kept in the field until the file has it');
  await vault.settle();
  assert.equal('TODOIST_TOKEN' in T.parseEnvText(a.files[ENV]), false, 'a sync set writes nothing on this backend');
  assert.deepEqual(await T.migrateSecretsSettled(s, vault), { changed: true, moved: ['todoistToken'] });
  assert.equal(s.todoistToken, '');
  assert.equal(T.parseEnvText(a.files[ENV]).TODOIST_TOKEN, 'tok-env');
  assert.equal(storage.getSecret(T.fieldSecretKey('todoistToken')), 'in-the-store', 'the store is never written in env mode');
  assert.equal(new T.SecretVault(storage).immediate, true);
  await new T.SecretVault(storage).settle();
});

test('the migration moves a plaintext data.json value into the env file, once', async () => {
  const a = fakeAdapter({ [ENV]: '# keys\n' });
  const env = await new T.EnvFileStore(a, ENV).load();
  const vault = new T.SecretVault(null, env);
  const s = { todoistToken: ' tok-plain ', clickupToken: '', calendars: [{ id: 'cal-1', name: 'Work', url: 'https://x/private-abc/basic.ics', color: 1, enabled: true, kind: 'ics' }] };
  // The synchronous migration (adoptSettings at load) moves nothing on this
  // backend: it cannot know whether the file took the value.
  assert.deepEqual(T.migrateSecrets(s, vault), { changed: false, moved: [] });
  assert.equal(s.todoistToken, ' tok-plain ', 'untouched');
  assert.equal(s.calendars[0].url, 'https://x/private-abc/basic.ics');
  assert.equal(s.secretsInStore, undefined);
  assert.deepEqual(a.writes, []);
  // The settled one (persistSettings) moves each value once its line is on disk.
  const r = await T.migrateSecretsSettled(s, vault);
  assert.deepEqual(r, { changed: true, moved: ['todoistToken', 'calendar:cal-1'] });
  assert.equal(s.todoistToken, '');
  assert.equal(s.calendars[0].url, '');
  assert.equal(s.secretsInStore, true);
  assert.equal(a.files[ENV], '# keys\nTODOIST_TOKEN=tok-plain\nPLANNER_CALENDAR_CAL_1=https://x/private-abc/basic.ics\n');
  const json = JSON.stringify(s);
  for (const n of ['tok-plain', 'private-abc']) assert.ok(!json.includes(n), `data.json still carries: ${n}`);
  assert.deepEqual(await T.migrateSecretsSettled(s, vault), { changed: false, moved: [] });
  await vault.settle();
  assert.equal(a.writes.length, 2, 'a second run writes nothing');
  // On the store the settled migration is the sync one: same answer, no await needed inside.
  const storage = new FakeSecretStorage();
  const ks = { todoistToken: 'tok-store', calendars: [] };
  assert.deepEqual(await T.migrateSecretsSettled(ks, new T.SecretVault(storage)), { changed: true, moved: ['todoistToken'] });
  assert.equal(storage.getSecret(T.fieldSecretKey('todoistToken')), 'tok-store');
  assert.deepEqual(await T.migrateSecretsSettled({ todoistToken: 'x' }, new T.SecretVault(null)), { changed: false, moved: [] }, 'no backend, nothing moves');
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
  assert.match(code, /async persistSettings\(\) \{\n\s*await migrateSecretsSettled\(this\.settings, this\.secrets\);\n\s*await this\.saveData\(this\.settings\);\n\s*await this\.secrets\.settle\(\);\n\s*\}/, 'the move waits for the file before data.json is written, and a save is not done until the env file is');
  assert.doesNotMatch(code.slice(code.indexOf('async persistSettings()'), code.indexOf('envStoreFor(path)')), /[^d]\s*migrateSecrets\(this\.settings/, 'the sync migration is never the one a save relies on');
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

/* Vex P-1 (2026-09-08): with the env file selected, the automatic paths
 * blanked data.json on a synchronous "true" while the file write was only
 * queued; a write that then failed left the credential in memory only,
 * gone at unload. The gate: an adapter whose write throws, and data.json
 * keeps the value at every layer, up to the plugin's own persistSettings.
 */
test('P-1 gate: on the env backend no synchronous path blanks data.json, and a failed write leaves the value where it was', async () => {
  const id = T.fieldSecretKey('todoistToken');
  const a = fakeAdapter({ [ENV]: 'A=1\n' });
  const env = await new T.EnvFileStore(a, ENV).load();
  const vault = new T.SecretVault(null, env);
  assert.equal(vault.immediate, false);
  a.fail = 'EACCES: permission denied';
  const feed = { id: 'cal-1', name: 'Work', url: '', color: 1, enabled: true, kind: 'ics' };
  const s = { todoistToken: '', clickupToken: 'pk_plain', calendars: [feed] };
  // The sync paths: none claims, none writes, none blanks.
  assert.equal(vault.set(id, 'tok-typed'), false, 'a sync set cannot know, so it does not claim');
  assert.equal(T.writeSecret(s, vault, 'todoistToken', 'tok-typed'), false);
  assert.equal(s.todoistToken, 'tok-typed', 'the keystroke keeps the value in the field');
  assert.deepEqual(T.migrateSecrets(s, vault), { changed: false, moved: [] }, 'the sync migration moves nothing on this backend');
  assert.equal(s.clickupToken, 'pk_plain');
  assert.equal(T.setFeedUrl(feed, 'https://x/private-abc/basic.ics', vault), false);
  assert.equal(feed.url, 'https://x/private-abc/basic.ics');
  await vault.settle();
  assert.deepEqual(a.writes, [], 'the sync paths did not even queue a write');
  assert.equal(env.getSecret(id), null);
  // The settled migration with a write that fails: every value stays, the
  // error is the adapter's sentence without a value, nothing on disk, and
  // memory does not claim it either. The value is still the one in use.
  assert.deepEqual(await T.migrateSecretsSettled(s, vault), { changed: false, moved: [] });
  assert.equal(s.todoistToken, 'tok-typed');
  assert.equal(s.clickupToken, 'pk_plain');
  assert.equal(feed.url, 'https://x/private-abc/basic.ics');
  assert.equal(s.secretsInStore, undefined);
  assert.equal(env.error, 'EACCES: permission denied');
  assert.ok(!env.error.includes('tok-typed'));
  assert.equal(a.files[ENV], 'A=1\n');
  assert.equal(env.getSecret(id), null, 'memory does not claim what the disk refused');
  assert.equal(T.readSecret(s, vault, 'todoistToken'), 'tok-typed', 'and the value is still in use');
  assert.equal(T.withSecrets(s, vault).clickupToken, 'pk_plain');
  // put() is the honest form of set(): false on this failure, true once the disk has it.
  assert.equal(await vault.put(id, 'tok-typed'), false);
  a.fail = null;
  assert.equal(await vault.put(id, 'tok-typed'), true);
  assert.equal(T.parseEnvText(a.files[ENV]).TODOIST_TOKEN, 'tok-typed');
  // The adapter recovered: the next settled migration moves the rest,
  // blanks each field, and the file has every line.
  assert.deepEqual(await T.migrateSecretsSettled(s, vault), { changed: true, moved: ['todoistToken', 'clickupToken', 'calendar:cal-1'] });
  assert.equal(s.todoistToken, '');
  assert.equal(s.clickupToken, '');
  assert.equal(feed.url, '');
  assert.equal(s.secretsInStore, true);
  assert.deepEqual(T.parseEnvText(a.files[ENV]), { A: '1', TODOIST_TOKEN: 'tok-typed', CLICKUP_TOKEN: 'pk_plain', PLANNER_CALENDAR_CAL_1: 'https://x/private-abc/basic.ics' });
  // A clear still goes through synchronously: nothing is blanked on its answer, and a failed clear leaves an old line, not a lost key.
  assert.equal(T.writeSecret(s, vault, 'clickupToken', ''), true);
  await vault.settle();
  assert.equal(T.parseEnvText(a.files[ENV]).CLICKUP_TOKEN, '');
  // On the store, set() is still the immediate answer it always was.
  const storage = new FakeSecretStorage();
  const sv = new T.SecretVault(storage);
  const ks = { todoistToken: '' };
  assert.equal(T.writeSecret(ks, sv, 'todoistToken', 'tok-store'), true);
  assert.equal(ks.todoistToken, '');
  assert.equal(storage.getSecret(id), 'tok-store');
});

test('P-1 gate: persistSettings with a throwing adapter writes the value into data.json, and blanks it only after the file has it', async () => {
  const a = fakeAdapter({ [ENV]: '' });
  const p = Object.create(T.IcorPlannerPlugin.prototype);
  p.app = { vault: { adapter: a } };
  p.secretStorage = null;
  p.envStore = p.envStoreFor(ENV);
  await p.envStore.load();
  p.secrets = p.vaultFor('env-file');
  assert.equal(p.secrets.mode, 'env-file');
  p.settings = Object.assign({}, T.DEFAULT_SETTINGS, { secretsBackend: 'env-file', envFilePath: ENV, todoistToken: 'tok-live' });
  const saved = [];
  p.saveData = async (s) => { saved.push(JSON.parse(JSON.stringify(s))); };
  a.fail = 'EACCES: permission denied';
  await p.persistSettings();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].todoistToken, 'tok-live', 'data.json keeps the value when the env write fails');
  assert.equal(saved[0].secretsInStore, false);
  assert.equal(p.settings.todoistToken, 'tok-live');
  assert.equal(a.files[ENV], '');
  assert.equal(p.envStore.error, 'EACCES: permission denied');
  assert.equal(p.withSecrets().todoistToken, 'tok-live', 'the sync still has a token');
  a.fail = null;
  await p.persistSettings();
  assert.equal(saved.length, 2);
  assert.equal(saved[1].todoistToken, '', 'blanked once the line is on disk');
  assert.equal(saved[1].secretsInStore, true);
  assert.equal(T.parseEnvText(a.files[ENV]).TODOIST_TOKEN, 'tok-live');
  assert.equal(p.envStore.error, '');
  assert.equal(p.withSecrets().todoistToken, 'tok-live', 'now read from the file');
  // At load, adoptSettings leaves the value in place (the sync half cannot
  // move it) and reports the pending move, so onload writes back once and
  // that write-back is the settled one.
  // (calendars given as [] so the calendar migration has nothing to add and `changed` speaks for the secrets alone.)
  const adopted = T.adoptSettings({ secretsBackend: 'env-file', calendars: [], todoistToken: 'x' }, p.secrets);
  assert.equal(adopted.pending, true);
  assert.equal(adopted.changed, true);
  assert.deepEqual(adopted.moved, []);
  assert.equal(adopted.settings.todoistToken, 'x', 'not blanked by the sync half');
  const feedOnly = T.adoptSettings({ secretsBackend: 'env-file', calendars: [{ id: 'c', url: 'https://feed', kind: 'ics' }] }, p.secrets);
  assert.equal(feedOnly.pending, true);
  assert.equal(feedOnly.changed, true);
  assert.equal(T.adoptSettings({ secretsBackend: 'env-file', calendars: [] }, p.secrets).pending, false);
  assert.equal(T.adoptSettings({ secretsBackend: 'env-file', calendars: [] }, p.secrets).changed, false, 'nothing to move, nothing to write back');
  assert.equal(T.adoptSettings({ todoistToken: 'x', calendars: [] }, new T.SecretVault(new FakeSecretStorage())).pending, false, 'the store moved it on the spot');
  assert.equal(T.settingsHoldSecrets({ calendars: [{ id: 'c', url: ' ' }] }), false);
  assert.equal(T.settingsHoldSecrets(null), false);
});

test('P-1 gate: a rotated Outlook token in env mode asks for a save and stays in the settings until the file has it', async () => {
  const a = fakeAdapter({ [ENV]: '' });
  const env = await new T.EnvFileStore(a, ENV).load();
  const vault = new T.SecretVault(null, env);
  const settings = Object.assign({}, T.DEFAULT_SETTINGS, { secretsBackend: 'env-file', outlookClientId: 'client-1' });
  let persisted = 0;
  Object.defineProperty(settings, '_persist', { value: () => { persisted += 1; }, enumerable: false });
  const s = T.withSecrets(settings, vault);
  T.saveOutlookTokens(T.outlookTokenSink(s), { accessToken: 'at-1', refreshToken: 'rt-new', expiresIn: 3600 }, 5);
  assert.equal(settings.outlookRefreshToken, 'rt-new', 'in the live settings until the save moves it');
  assert.equal(settings.outlookAccessToken, 'at-1');
  assert.equal(settings.outlookExpiresAt, String(5 + 3600000));
  assert.equal(s.outlookRefreshToken, 'rt-new', 'and in the copy the run keeps reading');
  assert.equal(persisted, 1, 'the sink asked for a save, as without a store');
  await vault.settle();
  assert.equal(a.files[ENV], '', 'nothing reaches the file before the save');
  const r = await T.migrateSecretsSettled(settings, vault);
  assert.deepEqual(r.moved, ['outlookRefreshToken', 'outlookAccessToken', 'outlookExpiresAt']);
  assert.equal(settings.outlookRefreshToken, '');
  assert.deepEqual(T.parseEnvText(a.files[ENV]), { OUTLOOK_REFRESH_TOKEN: 'rt-new', OUTLOOK_ACCESS_TOKEN: 'at-1', OUTLOOK_EXPIRES_AT: String(5 + 3600000) });
  assert.equal(T.outlookSignedIn(T.withSecrets(settings, vault)), true);
  // Sign-out in env mode clears the file's lines and asks for nothing: the fields were already blank.
  T.clearOutlookTokens({ live: settings, vault });
  await vault.settle();
  assert.equal(persisted, 1);
  assert.deepEqual(T.parseEnvText(a.files[ENV]), { OUTLOOK_REFRESH_TOKEN: '', OUTLOOK_ACCESS_TOKEN: '', OUTLOOK_EXPIRES_AT: '' });
  // With a store the sink does not ask: the store held it on the spot.
  const storage = new FakeSecretStorage();
  const ks = Object.assign({}, T.DEFAULT_SETTINGS);
  let p2 = 0;
  Object.defineProperty(ks, '_persist', { value: () => { p2 += 1; }, enumerable: false });
  T.saveOutlookTokens(T.outlookTokenSink(T.withSecrets(ks, new T.SecretVault(storage))), { accessToken: 'at', refreshToken: 'rt', expiresIn: 1 }, 0);
  assert.equal(p2, 0);
  assert.equal(ks.outlookRefreshToken, '');
  assert.equal(storage.getSecret(T.fieldSecretKey('outlookRefreshToken')), 'rt');
});

test('source scan: the tab tells the member once when the env write failed, and the layer still raises no Notice', () => {
  const tab = code.slice(code.indexOf('class IcorPlannerSettingTab'));
  const helper = tab.slice(tab.indexOf('const secret = (setting, get, set, placeholder, label)'), tab.indexOf("setName('Secrets').setHeading()"));
  assert.match(helper, /await this\.plugin\.saveSettings\(\);\n\s*const err = this\.plugin\.secrets\.mode === 'env-file' \? this\.plugin\.envStore\.error : '';/, 'the check runs after the save that moves the key');
  assert.match(helper, /if \(err && err !== this\._envWriteWarned\) new Notice\('Planner: the env file could not be written; the key stays in data\.json until it can\./, 'one Notice per failure, naming no value');
  assert.doesNotMatch(helper, /\$\{(v|value|err|secret)\}/, 'the Notice carries neither the value nor the error text');
  assert.doesNotMatch(helper, /[\u2013\u2014]/, 'no dashes of either length');
});
