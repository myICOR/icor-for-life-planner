/* The env file's move out of room 06 (0.17.0).
 *
 * The ICOR for Life vault no longer has the room `06 AI Team`. The shared
 * keys file moved from `06 AI Team/AI Team Knowledge/.env` to the vault's
 * system folder, `.icor-for-life/.env`, which Obsidian does not index, so
 * it is reached through the vault adapter only. The contract, gated here
 * against a fake adapter:
 *   - the default is the new path, and data.json's old default reads as it;
 *   - a vault that only has the old file keeps working: it is read AND
 *     written there, and no half-empty new file appears beside it;
 *   - a path the member chose has no fallback;
 *   - the one-time move copies the old bytes unchanged, reads them back,
 *     makes the system folder when it is missing, waits for a write in
 *     flight, and never deletes the old file;
 *   - the old file goes to the trash only on request, and only once the new
 *     one is there to read;
 *   - the vault's .gitignore guard covers the file in use and the new one;
 *   - source scans: the load offers the move once, only for the env file,
 *     after the settings are saved; the move's Notices name paths only.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const main = fs.readFileSync(T.__mainPath, 'utf8');
const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const NEW = '.icor-for-life/.env';
const OLD = '06 AI Team/AI Team Knowledge/.env';

// The adapter as the store uses it, folders included: exists answers for a
// file or for any folder above one, mkdir records what it made, and the two
// trash calls record what they took.
function fakeAdapter(files, opts) {
  const o = opts || {};
  const a = {
    files: Object.assign({}, files || {}),
    dirs: new Set(),
    writes: [],
    made: [],
    trashed: [],
    fail: null,
    async exists(p) {
      if (Object.prototype.hasOwnProperty.call(a.files, p) || a.dirs.has(p)) return true;
      return Object.keys(a.files).some((f) => f.startsWith(`${p}/`));
    },
    async read(p) { if (!(p in a.files)) throw new Error(`ENOENT: ${p}`); return a.files[p]; },
    async write(p, text) {
      if (a.fail) throw new Error(a.fail);
      const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
      if (dir && o.strictDirs && !(await a.exists(dir))) throw new Error(`ENOENT: ${dir}`);
      a.files[p] = text;
      a.writes.push(p);
    },
    async mkdir(p) { a.dirs.add(p); a.made.push(p); },
  };
  if (o.trashSystem !== false) a.trashSystem = async (p) => { if (o.trashSystem === 'refuse') return false; a.trashed.push(['system', p]); delete a.files[p]; return true; };
  a.trashLocal = async (p) => { a.trashed.push(['local', p]); delete a.files[p]; };
  return a;
}

const OLD_TEXT = '# The AI team\'s keys\r\nTODOIST_TOKEN=tok-old\r\nOPENAI_API_KEY=sk-not-real\r\n';

test('the default is the system folder, and the old default reads as it', () => {
  assert.equal(T.DEFAULT_ENV_FILE_PATH, NEW);
  assert.equal(T.LEGACY_ENV_FILE_PATH, OLD);
  assert.equal(T.DEFAULT_SETTINGS.envFilePath, NEW);
  assert.equal(T.DEFAULT_SETTINGS.envMoveOffered, false);
  for (const v of [undefined, null, '', '  ', OLD, ` ${OLD} `, '06 AI Team\\AI Team Knowledge\\.env', NEW, './.icor-for-life/.env']) {
    assert.equal(T.adoptEnvFilePath(v), NEW, JSON.stringify(v));
  }
  assert.equal(T.adoptEnvFilePath('Secrets/keys.env'), 'Secrets/keys.env', 'a path the member chose is kept');
  assert.equal(T.adoptEnvFilePath('../outside/.env'), NEW, 'a path that fails the check falls back to the default, as before');
  assert.equal(T.legacyEnvFileFor(NEW), OLD);
  assert.equal(T.legacyEnvFileFor('Secrets/keys.env'), '');
  assert.equal(T.legacyEnvFileFor(OLD), '');
});

test('a vault with only the old file keeps working: read there, written there, nothing new appears', async () => {
  const a = fakeAdapter({ [OLD]: OLD_TEXT });
  const env = await new T.EnvFileStore(a, NEW).load();
  assert.equal(env.path, NEW);
  assert.equal(env.fallback, OLD);
  assert.equal(env.active, OLD);
  assert.equal(env.onLegacy, true);
  assert.equal(env.legacyExists, true);
  assert.equal(env.exists, true);
  assert.equal(env.error, '');
  assert.equal(env.getSecret(T.fieldSecretKey('todoistToken')), 'tok-old');
  assert.equal(await env.setSecret(T.fieldSecretKey('clickupToken'), 'cu-1'), true);
  assert.deepEqual(a.writes, [OLD], 'the write lands in the file that is read');
  assert.ok(!(NEW in a.files), 'no half-empty new file beside the full old one');
  assert.equal(a.files[OLD], `${OLD_TEXT}CLICKUP_TOKEN=cu-1\r\n`, 'every other byte as it was, CRLF kept');
});

test('with both files the new one is the one in use; with neither the first save makes the new one, folder and all', async () => {
  const both = fakeAdapter({ [OLD]: 'TODOIST_TOKEN=old\n', [NEW]: 'TODOIST_TOKEN=new\n' });
  const env = await new T.EnvFileStore(both, NEW).load();
  assert.equal(env.active, NEW);
  assert.equal(env.onLegacy, false);
  assert.equal(env.legacyExists, true);
  assert.equal(env.getSecret(T.fieldSecretKey('todoistToken')), 'new');

  const none = fakeAdapter({}, { strictDirs: true });
  const fresh = await new T.EnvFileStore(none, NEW).load();
  assert.equal(fresh.exists, false);
  assert.equal(fresh.onLegacy, false);
  assert.equal(fresh.legacyExists, false);
  assert.equal(await fresh.setSecret(T.fieldSecretKey('todoistToken'), 'tok'), true);
  assert.deepEqual(none.made, ['.icor-for-life'], 'the system folder is made when it is missing');
  assert.equal(none.files[NEW], 'TODOIST_TOKEN=tok\n');
  // A second write finds the folder there and makes nothing.
  assert.equal(await fresh.setSecret(T.fieldSecretKey('clickupToken'), 'cu'), true);
  assert.deepEqual(none.made, ['.icor-for-life']);
});

test('a path the member chose is read as typed, with no fallback', async () => {
  const a = fakeAdapter({ [OLD]: 'TODOIST_TOKEN=old\n' });
  const env = await new T.EnvFileStore(a, 'Secrets/keys.env').load();
  assert.equal(env.fallback, '');
  assert.equal(env.active, 'Secrets/keys.env');
  assert.equal(env.onLegacy, false);
  assert.equal(env.exists, false);
  assert.equal(env.getSecret(T.fieldSecretKey('todoistToken')), null);
  assert.equal(await env.adoptLegacy(), 'none', 'nothing to move for a chosen path');
  assert.equal(await env.trashLegacy(), false);
  assert.deepEqual(a.trashed, []);
});

test('the one-time move copies the old bytes unchanged, reads from the new place, and keeps the old file', async () => {
  const a = fakeAdapter({ [OLD]: OLD_TEXT }, { strictDirs: true });
  const env = await new T.EnvFileStore(a, NEW).load();
  assert.equal(await env.adoptLegacy(), 'moved');
  assert.equal(a.files[NEW], OLD_TEXT, 'byte for byte, comments and CRLF included');
  assert.equal(a.files[OLD], OLD_TEXT, 'the old file is untouched');
  assert.deepEqual(a.made, ['.icor-for-life']);
  assert.equal(env.active, NEW);
  assert.equal(env.onLegacy, false);
  assert.equal(env.legacyExists, true, 'so the tab can offer the trash');
  assert.equal(env.getSecret(T.fieldSecretKey('todoistToken')), 'tok-old');
  assert.equal(await env.adoptLegacy(), 'already', 'asked twice, it copies once');
  assert.equal(a.writes.filter((p) => p === NEW).length, 1);
  // Later writes go to the new file only.
  await env.setSecret(T.fieldSecretKey('todoistToken'), 'tok-new');
  assert.equal(T.parseEnvText(a.files[NEW]).TODOIST_TOKEN, 'tok-new');
  assert.equal(a.files[OLD], OLD_TEXT);
  // No old file: nothing to move.
  const empty = await new T.EnvFileStore(fakeAdapter({}), NEW).load();
  assert.equal(await empty.adoptLegacy(), 'none');
});

test('a write in flight lands in the copy, and a failed copy leaves the old file in use with an error that carries no value', async () => {
  const a = fakeAdapter({ [OLD]: 'A=1\n' });
  const env = await new T.EnvFileStore(a, NEW).load();
  const w = env.setSecret(T.fieldSecretKey('todoistToken'), 'tok-flight');
  const r = await env.adoptLegacy();
  assert.equal(await w, true);
  assert.equal(r, 'moved');
  assert.equal(T.parseEnvText(a.files[NEW]).TODOIST_TOKEN, 'tok-flight', 'queued behind the write, so the copy holds it');

  const b = fakeAdapter({ [OLD]: 'TODOIST_TOKEN=tok-secret-value\n' });
  const broken = await new T.EnvFileStore(b, NEW).load();
  b.fail = 'EACCES: permission denied';
  assert.equal(await broken.adoptLegacy(), 'failed');
  assert.match(broken.error, /EACCES/);
  assert.doesNotMatch(broken.error, /tok-secret-value/);
  assert.equal(broken.onLegacy, true, 'the old file is still the one in use');
  assert.equal(broken.getSecret(T.fieldSecretKey('todoistToken')), 'tok-secret-value');
  assert.equal(b.files[OLD], 'TODOIST_TOKEN=tok-secret-value\n');
});

test('the old file goes to the trash only on request, only once the new one is there, and nothing else is touched', async () => {
  const onlyOld = fakeAdapter({ [OLD]: 'A=1\n' });
  const env = await new T.EnvFileStore(onlyOld, NEW).load();
  assert.equal(await env.trashLegacy(), false, 'never while the old file is the only copy');
  assert.deepEqual(onlyOld.trashed, []);
  assert.equal(await env.adoptLegacy(), 'moved');
  assert.equal(await env.trashLegacy(), true);
  assert.deepEqual(onlyOld.trashed, [['system', OLD]], 'the system trash, the old path, nothing else');
  assert.equal(onlyOld.files[NEW], 'A=1\n');
  assert.equal(env.legacyExists, false);

  // A system trash that says no: the vault's own .trash.
  const refusing = fakeAdapter({ [OLD]: 'A=1\n', [NEW]: 'A=1\n' }, { trashSystem: 'refuse' });
  const env2 = await new T.EnvFileStore(refusing, NEW).load();
  assert.equal(await env2.trashLegacy(), true);
  assert.deepEqual(refusing.trashed, [['local', OLD]]);
  // No trash API at all: the system one missing still falls to the local one.
  const local = fakeAdapter({ [OLD]: 'A=1\n', [NEW]: 'A=1\n' }, { trashSystem: false });
  const env3 = await new T.EnvFileStore(local, NEW).load();
  assert.equal(await env3.trashLegacy(), true);
  assert.deepEqual(local.trashed, [['local', OLD]]);
});

test('the plugin: the move and the trash through its own methods, and the .gitignore guard covers both files', async () => {
  const a = fakeAdapter({ [OLD]: 'TODOIST_TOKEN=tok-old\n', '.gitignore': 'node_modules/\n' });
  const p = Object.create(T.IcorPlannerPlugin.prototype);
  p.app = { vault: { adapter: a } };
  p.manifest = { id: 'icor-for-life-planner', dir: '.obsidian/plugins/icor-for-life-planner' };
  p.settings = Object.assign({}, T.DEFAULT_SETTINGS, { secretsBackend: 'env-file' });
  p.envStore = p.envStoreFor(p.settings.envFilePath);
  await p.envStore.load();
  assert.equal(p.envStore.onLegacy, true);
  await p.ensureGitignore();
  const gi = a.files['.gitignore'].split('\n');
  assert.ok(gi.includes(NEW), 'the new place is ignored before anything is written there');
  assert.ok(gi.includes(OLD), 'and the file in use');
  assert.ok(gi.includes('.obsidian/plugins/icor-for-life-planner/'), 'the plugin folder, as always');
  assert.equal(await p.moveEnvFileFromLegacy(), 'moved');
  assert.equal(a.files[NEW], 'TODOIST_TOKEN=tok-old\n');
  assert.equal(await p.trashLegacyEnvFile(), true);
  assert.ok(!(OLD in a.files));
  // On the keychain the env file is not guarded (nor read).
  const b = fakeAdapter({ '.gitignore': '' });
  const q = Object.create(T.IcorPlannerPlugin.prototype);
  q.app = { vault: { adapter: b } };
  q.manifest = { id: 'icor-for-life-planner', dir: '.obsidian/plugins/icor-for-life-planner' };
  q.settings = Object.assign({}, T.DEFAULT_SETTINGS);
  q.envStore = q.envStoreFor(q.settings.envFilePath);
  await q.ensureGitignore();
  assert.ok(!b.files['.gitignore'].includes(NEW));
});

test('source scan: the load offers the move once, only for the env file, after the settings are saved', () => {
  const from = code.indexOf('const envPath = adoptEnvFilePath(loaded.envFilePath);');
  assert.ok(from > 0);
  const load = code.slice(from, code.indexOf('setDisplayFormatSource(', from));
  assert.match(load, /const offerMove = backend === 'env-file' && this\.envStore\.onLegacy && this\.settings\.envMoveOffered !== true;\n\s*if \(offerMove\) this\.settings\.envMoveOffered = true;/);
  assert.match(load, /if \(adopted\.changed \|\| offerMove \|\| [^\n]*\) await this\.persistSettings\(\);\n\s*if \(offerMove\) this\.offerEnvFileMove\(\);/, 'asked after the flag is on disk, so a crash cannot ask twice');
  assert.doesNotMatch(load, /adoptLegacy|trashLegacy/, 'the load itself moves and deletes nothing');
});

test('source scan: the move\'s sentences name paths only, and nothing in it logs', () => {
  const block = main.slice(main.indexOf('the env file\'s move out of room 06 (0.17.0)'), main.indexOf('// Move the keys of the given slots'));
  assert.ok(block.length > 200);
  assert.doesNotMatch(block, /console\./);
  const allowed = new Set(['LEGACY_ENV_FILE_PATH', 'DEFAULT_ENV_FILE_PATH', 'text', 'store.path', 'store.fallback', 'old']);
  for (const m of block.matchAll(/\$\{([^}]+)\}/g)) assert.ok(allowed.has(m[1].trim()), `a Notice interpolates ${m[1]}`);
  assert.doesNotMatch(block, /[–—]/, 'no dashes of either length');
  const tab = code.slice(code.indexOf('class IcorPlannerSettingTab'));
  const legacy = tab.slice(tab.indexOf('const renderLegacy = () => {'), tab.indexOf('const keysEl ='));
  assert.match(legacy, /this\.plugin\.moveEnvFileFromLegacy\(\)/, 'the copy runs on the button');
  assert.match(legacy, /this\.plugin\.trashLegacyEnvFile\(\)/, 'the trash runs on its own button');
  for (const m of legacy.matchAll(/\$\{([^}]+)\}/g)) assert.ok(['store.path', 'store.fallback'].includes(m[1].trim()), `the tab interpolates ${m[1]}`);
  assert.doesNotMatch(legacy, /[–—]/);
});
