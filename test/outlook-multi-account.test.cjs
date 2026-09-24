/* More than one Microsoft account.
 *
 * Accounts are typed into `outlookAccounts` in data.json and read on the next
 * reload; only the sign-in itself, which cannot happen in a text file, has a
 * button. The id `default` is RESERVED and means the sign-in that already
 * exists: it reads the flat outlook* fields, the legacy secret keys and the
 * legacy calendar feed id, so nobody re-authenticates and nothing moves.
 *
 * Gated here, pure and scripted (no live network):
 *   - absent `outlookAccounts` is ONE account, `default`, byte-identical to
 *     the release before this one;
 *   - the reserved default keeps the legacy secret keys, the legacy feed id
 *     and the legacy shadow-key shape; an extra account is namespaced;
 *   - every extra account's four token fields are visible to the secret
 *     layer (secretFieldNames), so a second refresh token is moved, audited
 *     and blanked by exactly the same rules as the first. A token the
 *     walkers cannot see is a token that stays in data.json;
 *     account the settings no longer list, and verified by the SET of
 *     external ids rather than by a count.
 *
 * Every test here was watched fail against a main.js without the feature
 * before it counted.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const CLIENT = '11111111-2222-3333-4444-555555555555';
const CLIENT2 = '99999999-8888-7777-6666-555555555555';
const SIGNED = {
  outlookClientId: CLIENT, outlookTenant: 'consumers', outlookRefreshToken: 'rt-1', outlookAccessToken: 'at-1',
  outlookExpiresAt: String(Date.now() + 3600000), outlookAccount: 'me@example.com', outlookScopes: 'Mail.Read Calendars.Read',
};
const base = (extra) => Object.assign({}, T.DEFAULT_SETTINGS, SIGNED, extra || {});
const WORK = {
  id: 'work', label: 'Work', folder: 'Work', clientId: CLIENT2, tenant: 'organizations',
  scopes: 'Mail.Read', includedFolderPaths: ['Inbox'],
};
const item = (o) => Object.assign({ source: 'outlook', id: 'x', status: 'open', path: '02 Planner/Outlook/x.md' }, o);

/* -------------------------------------------------------------------------
 * 1. ABSENT IS ONE ACCOUNT, AND IT IS THE ONE THAT ALREADY EXISTS
 * ---------------------------------------------------------------------- */

test('no outlookAccounts key at all is exactly one account, `default`, reading the flat fields', () => {
  const s = base();
  delete s.outlookAccounts;
  const list = T.outlookAccountList(s);
  assert.equal(list.length, 1, 'one account');
  assert.equal(list[0].id, 'default');
  assert.equal(list[0].clientId, CLIENT, 'the client id already in data.json');
  assert.equal(list[0].tenant, 'consumers', "the tenant already in data.json, not the 'common' default");
  assert.equal(list[0].scopes, 'Mail.Read Calendars.Read');
  assert.equal(list[0].enabled, true);
  // The projection for the reserved default is the settings object ITSELF,
  // so the existing sign-in path is not merely equivalent, it is the same.
  assert.equal(T.outlookAccountView(s, list[0]), s, 'default is not projected at all');
  // An empty array is the same thing.
  assert.deepEqual(T.outlookAccountList(base({ outlookAccounts: [] })), list);
});

test('the reserved default keeps the legacy secret keys, so the live sign-in is found where it already lives', () => {
  for (const f of T.OUTLOOK_ACCOUNT_SECRET_FIELDS) {
    assert.equal(T.outlookAccountField('default', f), f, 'the flat field name is unchanged');
    assert.equal(T.fieldSecretKey(T.outlookAccountField('default', f)), T.fieldSecretKey(f));
  }
  assert.equal(T.fieldSecretKey('outlookRefreshToken'), 'icor-for-life-planner-outlook-refresh-token');
  // An extra account is namespaced, and the account id sits INSIDE the
  // outlook- prefix so the keys still sort together.
  assert.equal(T.fieldSecretKey('outlookRefreshToken__work'), 'icor-for-life-planner-outlook-work-refresh-token');
  assert.equal(T.fieldSecretKey('outlookAccount__work'), 'icor-for-life-planner-outlook-work-account');
  assert.notEqual(T.fieldSecretKey('outlookRefreshToken__work'), T.fieldSecretKey('outlookRefreshToken'));
});

test('the account-field parser is strict, so fieldSecretKey still throws on anything else', () => {
  assert.deepEqual(T.outlookAccountFieldParts('outlookRefreshToken__work'), { field: 'outlookRefreshToken', accountId: 'work' });
  for (const bad of [
    'outlookRefreshToken', 'outlookScopes__work', 'outlookClientId__work',
    'outlookRefreshToken__default', 'outlookRefreshToken__', 'outlookRefreshToken__WORK',
    'outlookRefreshToken__a/b', 'todoistToken__work', '__work', null, undefined, 42,
  ]) assert.equal(T.outlookAccountFieldParts(bad), null, String(bad));
  assert.throws(() => T.fieldSecretKey('nonsense'), /not a secret field/);
  assert.throws(() => T.fieldSecretKey('outlookScopes__work'), /not a secret field/);
});

/* -------------------------------------------------------------------------
 * 2. THE SECOND MAILBOX'S TOKEN IS A SECRET LIKE ANY OTHER
 * ---------------------------------------------------------------------- */

test('THE SECURITY GATE: an extra account adds its four token fields to the secret walkers', () => {
  const FIXED = Object.keys(T.SECRET_FIELDS);
  assert.deepEqual(T.secretFieldNames(base()), FIXED, 'one account adds nothing at all');
  const s = base({ outlookAccounts: [WORK] });
  const names = T.secretFieldNames(s);
  for (const f of T.OUTLOOK_ACCOUNT_SECRET_FIELDS) {
    assert.ok(names.includes(`${f}__work`), `${f}__work must be walked`);
  }
  assert.equal(names.length, FIXED.length + 4);
  // A field the walkers cannot see is a credential that never leaves
  // data.json. settingsHoldSecrets is the audit the save path asks.
  const empty = Object.assign({}, T.DEFAULT_SETTINGS, { outlookAccounts: [WORK] });
  assert.equal(T.settingsHoldSecrets(empty), false, 'nothing held yet');
  assert.equal(T.settingsHoldSecrets(Object.assign({}, empty, { outlookRefreshToken__work: 'rt-2' })), true,
    'a second refresh token sitting in data.json must be reported');
});

test('a second account\'s token is moved into the store and blanked, like the first', () => {
  const store = new Map();
  const vault = new T.SecretVault({ getSecret: (k) => store.get(k) || '', setSecret: (k, v) => { if (v) store.set(k, v); else store.delete(k); } });
  const s = base({ outlookAccounts: [WORK], outlookRefreshToken__work: 'rt-2', outlookAccount__work: 'work@example.com' });
  const r = T.migrateSecrets(s, vault);
  assert.ok(r.moved.includes('outlookRefreshToken__work'), 'moved');
  assert.equal(s.outlookRefreshToken__work, '', 'blanked in data.json only after the store took it');
  assert.equal(store.get('icor-for-life-planner-outlook-work-refresh-token'), 'rt-2');
  assert.equal(store.get('icor-for-life-planner-outlook-work-account'), 'work@example.com');
  // And read back: withSecrets fills the account fields in from the store.
  const resolved = T.withSecrets(s, vault);
  assert.equal(resolved.outlookRefreshToken__work, 'rt-2');
  assert.equal(T.settingsHoldSecrets(s), false, 'nothing left behind');
});

test('the settings key list gains one labelled pair per extra account, and no graph feed', () => {
  const one = T.secretSlots(base()).map((x) => x.label);
  assert.ok(!one.some((l) => /\(/.test(l)), 'one account: no account-qualified rows');
  const slots = T.secretSlots(base({ outlookAccounts: [WORK], calendars: [{ id: 'outlook-graph', kind: 'graph', name: 'Outlook calendar' }] }));
  const labels = slots.map((x) => x.label);
  assert.ok(labels.includes('Outlook refresh token (Work)'), labels.join(' | '));
  assert.ok(labels.includes('Outlook access token (Work)'));
  assert.ok(!labels.some((l) => /Outlook calendar/.test(l)), 'a graph feed never appears in the key list');
  const work = slots.find((x) => x.label === 'Outlook access token (Work)');
  // The expiry and the account name travel with the access token, per account.
  assert.deepEqual(work.ids, [
    'icor-for-life-planner-outlook-work-access-token',
    'icor-for-life-planner-outlook-work-expires-at',
    'icor-for-life-planner-outlook-work-account',
  ]);
});

/* -------------------------------------------------------------------------
 * 3. THE PROJECTION, AND WHERE A ROTATED TOKEN LANDS
 * ---------------------------------------------------------------------- */

test('an account view is the flat shape every Outlook function already reads', () => {
  const s = base({ outlookAccounts: [WORK], outlookRefreshToken__work: 'rt-2', outlookAccessToken__work: 'at-2', outlookAccount__work: 'work@example.com' });
  const v = T.outlookAccountView(s, T.outlookAccountById(s, 'work'));
  assert.equal(v.outlookClientId, CLIENT2);
  assert.equal(v.outlookTenant, 'organizations');
  assert.equal(v.outlookRefreshToken, 'rt-2');
  assert.equal(v.outlookAccount, 'work@example.com');
  assert.deepEqual(v.outlookIncludedFolderPaths, ['Inbox'], "the folder filter is per mailbox");
  assert.equal(T.outlookSignedIn(v), true);
  // and the first account is untouched by the projection
  assert.equal(s.outlookRefreshToken, 'rt-1');
  assert.equal(T.outlookSignedIn(s), true);
  // An account with no includedFolderPaths of its own does NOT inherit
  // another mailbox's: absent means the filter was never switched on there.
  const bare = T.outlookAccountView(base({ outlookIncludedFolderPaths: ['Inbox'], outlookAccounts: [{ id: 'b', clientId: CLIENT2 }] }),
    T.outlookAccountById(base({ outlookAccounts: [{ id: 'b', clientId: CLIENT2 }] }), 'b'));
  assert.equal(T.outlookIncludedFolderPaths(bare), null, 'off, not inherited');
});

test('a rotated token is written to the account it belongs to, never to the first one', () => {
  const store = new Map();
  const vault = new T.SecretVault({ getSecret: (k) => store.get(k) || '', setSecret: (k, v) => { if (v) store.set(k, v); else store.delete(k); } });
  const live = base({ outlookAccounts: [WORK] });
  const view = T.outlookAccountView(T.withSecrets(live, vault), T.outlookAccountById(live, 'work'));
  T.saveOutlookTokens(T.outlookTokenSink(view), { accessToken: 'at-new', refreshToken: 'rt-new', expiresIn: 3600, account: 'work@example.com' }, 1000);
  assert.equal(store.get('icor-for-life-planner-outlook-work-refresh-token'), 'rt-new');
  assert.equal(store.get('icor-for-life-planner-outlook-refresh-token'), undefined, "the first account's key is untouched");
  assert.equal(view.outlookRefreshToken, 'rt-new', 'the rest of the run reads the rotated token');
  // and sign-out clears that account only
  store.set('icor-for-life-planner-outlook-refresh-token', 'rt-1');
  T.clearOutlookTokens({ live, vault, account: 'work' });
  assert.equal(store.get('icor-for-life-planner-outlook-work-refresh-token'), undefined);
  assert.equal(store.get('icor-for-life-planner-outlook-refresh-token'), 'rt-1', 'the other mailbox stays signed in');
});

test('a junk account record cannot make the plugin read a mailbox it should not', () => {
  const s = base({
    outlookAccounts: [
      null, 'nope', {}, { id: '' }, { id: 'WORK' }, { id: 'a/b' },
      { id: 'work', label: 'Work' }, { id: 'work', label: 'Duplicate' },
    ],
  });
  const ids = T.outlookAccountList(s).map((a) => a.id);
  assert.deepEqual(ids, ['default', 'work'], 'junk, a bad id and a duplicate all fall out; default is always present and first');
  assert.equal(T.outlookAccountList(s)[1].label, 'Work', 'the first record with an id wins');
  // A tenant the login endpoint does not accept falls back rather than being
  // pasted into an authorize URL.
  assert.equal(T.outlookAccountList(base({ outlookAccounts: [{ id: 'x', tenant: 'evil.example.com' }] }))[1].tenant, 'common');
});

test('a `default` record adds what is new and can never override the flat credentials', () => {
  // The default account IS the flat fields. If a record could override them
  // the list would say one thing and the fetch, which reads the settings
  // object itself, would do another.
  const s = base({
    outlookAccounts: [{ id: 'default', label: 'Personal', folder: 'Personal', clientId: CLIENT2, tenant: 'organizations', includedFolderPaths: ['Nope'] }],
  });
  const a = T.outlookAccountById(s, 'default');
  assert.equal(a.label, 'Personal', 'the label is the record\'s');
  assert.equal(a.clientId, CLIENT, 'the client id is the flat one');
  assert.equal(a.tenant, 'consumers', 'and so is the tenant');
  assert.equal(a.includedFolderPaths, undefined, 'and the filter is read off the flat key by the fetch');
  assert.equal(T.outlookAccountView(s, a), s, 'still the settings object itself');
});

const PluginClass = require(T.__mainPath);
/* -------------------------------------------------------------------------
 * 12. ORPHANED TOKEN FIELDS ARE STILL SECRETS
 * ---------------------------------------------------------------------- */

// The secret walkers derived the extra field names from the ACCOUNT LIST
// only, so an account record deleted from data.json before Sign out was
// pressed left its four `__<id>` keys orphaned: in the store forever with no
// row to clear them from, or - after a failed write
// that left the value in the settings - sitting in data.json as a key no
// walker could see or blank again. The names now follow the DATA as well:
// every own key of the settings the strict account-field parser accepts.
test('THE SECURITY GATE, orphaned: a token field with no account record is still walked by all six', () => {
  const s = Object.assign({}, T.DEFAULT_SETTINGS, {
    outlookAccounts: [],
    outlookRefreshToken__gone: 'rt-9', outlookAccessToken__gone: 'at-9', outlookExpiresAt__gone: '1', outlookAccount__gone: 'gone@example.com',
  });
  const names = T.secretFieldNames(s);
  for (const f of T.OUTLOOK_ACCOUNT_SECRET_FIELDS) assert.ok(names.includes(`${f}__gone`), `${f}__gone must be walked`);
  assert.equal(names.length, Object.keys(T.SECRET_FIELDS).length + 4, 'each orphan once');
  // Only the strict shape is picked up: junk keys are not secret fields.
  const junk = Object.assign({}, s, { outlookRefreshToken__Bad: 'x', somethingElse__gone: 'y', outlookRefreshToken__default: 'z', outlookRefreshToken__: 'w' });
  assert.deepEqual(T.secretFieldNames(junk), names, 'a key the parser rejects is not a secret field');
  // The walkers, one by one.
  assert.equal(T.settingsHoldSecrets(s), true, 'the audit reports it');
  const store = new Map();
  const vault = new T.SecretVault({ getSecret: (k) => store.get(k) || '', setSecret: (k, v) => { if (v) store.set(k, v); else store.delete(k); } });
  const r = T.migrateSecrets(s, vault);
  assert.ok(r.moved.includes('outlookRefreshToken__gone'), 'the migrator moves it');
  assert.equal(s.outlookRefreshToken__gone, '', 'and blanks it only once the store took it');
  assert.equal(store.get('icor-for-life-planner-outlook-gone-refresh-token'), 'rt-9');
  assert.equal(T.settingsHoldSecrets(s), false, 'nothing left in data.json');
  assert.equal(T.withSecrets(s, vault).outlookRefreshToken__gone, 'rt-9', 'the resolver reads it back');
  const slot = T.secretSlots(s).find((x) => x.id === 'icor-for-life-planner-outlook-gone-refresh-token');
  assert.ok(slot, 'the key list carries a row for it, so it can be cleared from the UI');
  assert.match(slot.label, /gone/, 'labelled by the id it belongs to');
  const access = T.secretSlots(s).find((x) => x.id === 'icor-for-life-planner-outlook-gone-access-token');
  assert.deepEqual(access.ids, ['icor-for-life-planner-outlook-gone-access-token', 'icor-for-life-planner-outlook-gone-expires-at', 'icor-for-life-planner-outlook-gone-account']);
  // The data-json backend seen through the store interface: the mover
  // between backends can find it.
  const dj = T.dataJsonStore(Object.assign({}, T.DEFAULT_SETTINGS, { outlookAccounts: [], outlookRefreshToken__gone: 'rt-9' }));
  assert.equal(dj.getSecret('icor-for-life-planner-outlook-gone-refresh-token'), 'rt-9');
  // Bare flat keys are the reserved default, and the reservation is not widened.
  const flat = T.secretFieldNames(Object.assign({}, T.DEFAULT_SETTINGS, { outlookRefreshToken: 'rt-1' }));
  assert.deepEqual(flat, Object.keys(T.SECRET_FIELDS), 'a bare key is `default`, and adds no name');
});

test('the env-file gate, orphaned: an orphan token is blanked from data.json only once the env file has it', async () => {
  const ENV = '06 AI Team/AI Team Knowledge/.env';
  const a = {
    files: { [ENV]: '' }, fail: null,
    async exists(p) { return Object.prototype.hasOwnProperty.call(a.files, p); },
    async read(p) { if (!(p in a.files)) throw new Error(`ENOENT: ${p}`); return a.files[p]; },
    async write(p, text) { if (a.fail) throw new Error(a.fail); a.files[p] = text; },
  };
  const p = Object.create(PluginClass.prototype);
  p.app = { vault: { adapter: a } };
  p.secretStorage = null;
  p.envStore = p.envStoreFor(ENV);
  await p.envStore.load();
  p.secrets = p.vaultFor('env-file');
  p.settings = Object.assign({}, T.DEFAULT_SETTINGS, { secretsBackend: 'env-file', envFilePath: ENV, outlookAccounts: [], outlookRefreshToken__gone: 'rt-9' });
  const saved = [];
  p.saveData = async (s) => { saved.push(JSON.parse(JSON.stringify(s))); };
  a.fail = 'EACCES: permission denied';
  await p.persistSettings();
  assert.equal(saved[0].outlookRefreshToken__gone, 'rt-9', 'data.json keeps the value while the file refuses it');
  a.fail = null;
  await p.persistSettings();
  assert.equal(saved[1].outlookRefreshToken__gone, '', 'blanked once the line is on disk');
  assert.equal(T.parseEnvText(a.files[ENV]).OUTLOOK_GONE_REFRESH_TOKEN, 'rt-9', 'and the file has it under its own key');
  assert.equal(p.withSecrets().outlookRefreshToken__gone, 'rt-9', 'read back from the file');
});
