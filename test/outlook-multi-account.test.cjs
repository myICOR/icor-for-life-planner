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
 *   - THE CORRUPTION GATE: reconcileStaleIds, pruneShadows and the upsert's
 *     `existing` map are scoped by account. Two mailboxes both reporting
 *     source: 'outlook' means account A's healthy fetch reads account B's
 *     notes as vanished and stamps status: done on every one of them;
 *   - `source_account` absent MEANS `default`, and is
 *     WRITTEN only from the second mailbox on, so the notes that already
 *     exist are correct without being opened;
 *   - a flag write goes to the mailbox the note came from, resolved from the
 *     item, not from whichever account is first in the list;
 *   - a disabled or unreachable account DEGRADES and never returns a healthy
 *     empty result, which would stamp done on every note it owns;
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

/* -------------------------------------------------------------------------
 * 4. THE CORRUPTION GATE
 * ---------------------------------------------------------------------- */

test('source_account is absent for the notes that already exist, and absent MEANS default', () => {
  assert.equal(T.itemAccountId(item({})), 'default');
  assert.equal(T.itemAccountId(item({ sourceAccount: null })), 'default');
  assert.equal(T.itemAccountId(item({ sourceAccount: '  ' })), 'default');
  assert.equal(T.itemAccountId(item({ sourceAccount: 'work' })), 'work');
  // And it is read off the frontmatter, so a note that carries it is claimed.
  const fm = { type: 'planner-item', source: 'outlook', external_id: 'm1', source_account: 'work' };
  assert.equal(T.itemFromFrontmatter(fm, 'p.md', 'p').sourceAccount, 'work');
  assert.equal(T.itemFromFrontmatter({ type: 'planner-item', source: 'outlook', external_id: 'm1' }, 'p.md', 'p').sourceAccount, null);
});

test('THE GATE: one account\'s healthy fetch never reconciles another account\'s notes', () => {
  const all = [
    item({ id: 'a1', path: '02 Planner/Outlook/Personal/a1.md' }),                        // default, no field
    item({ id: 'a2', path: '02 Planner/Outlook/Personal/a2.md', sourceAccount: 'default' }),
    item({ id: 'b1', path: '02 Planner/Outlook/Work/b1.md', sourceAccount: 'work' }),
    item({ id: 'b2', path: '02 Planner/Outlook/Work/b2.md', sourceAccount: 'work' }),
    Object.assign(item({ id: 't1' }), { source: 'todoist' }),
  ];
  // Since 0.13.0 reconcileStaleIds is upstream's, untouched: it takes an
  // `inScope` predicate, and the account rule lives in the predicate
  // upsertSource hands it. So the gate is on that predicate AS THE CALL SITE
  // BUILDS IT: pinned to the byte here, then exercised through the real
  // reconcileStaleIds below.
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const body = main.slice(main.indexOf('async upsertSource('), main.indexOf('async readBody('));
  const call = 'reconcileStaleIds(source, allItems, openIds, (it) => scopeAgrees(s._shadow[shadowKey(source, accountId, it.id)], scope)\n'
    + '        && (!accountId || itemAccountId(it) === accountId))';
  assert.ok(body.indexOf(call) > -1, 'the predicate the sync passes: the query scope first, then the account');
  const inScope = (accountId, shadows, scope) => (it) => T.scopeAgrees(shadows[T.shadowKey('outlook', accountId, it.id)], scope)
    && (!accountId || T.itemAccountId(it) === accountId);
  const stale = (open, accountId, shadows, scope) => T.reconcileStaleIds('outlook', all, new Set(open), inScope(accountId, shadows || {}, scope || null)).map((x) => x.id);
  // The default account syncs and its own two are still open: nothing at all
  // is stale, and the Work notes are NOT seen as vanished.
  assert.deepEqual(stale(['a1', 'a2'], 'default'), []);
  // The work account syncs and one of ITS items has gone.
  assert.deepEqual(stale(['b1'], 'work'), ['b2']);
  // A default run where its own item really has gone still closes it.
  assert.deepEqual(stale(['a1'], 'default'), ['a2']);
  // No account is the single-sign-in behaviour, unchanged.
  assert.deepEqual(stale(['a1'], null).sort(), ['a2', 'b1', 'b2']);
  // A manual item is never returned, whatever account it claims.
  assert.deepEqual(T.reconcileStaleIds('manual', all, new Set(), inScope('default', {}, null)), []);
  // And upstream's half of the predicate still holds beside the account's:
  // a note last seen by another query is that query's business, not this one's.
  assert.deepEqual(stale(['b1'], 'work', { 'outlook@work:b2': { scope: 'old-filter' } }, 'new-filter'), []);
  assert.deepEqual(stale(['b1'], 'work', { 'outlook@work:b2': { scope: 'new-filter' } }, 'new-filter'), ['b2']);
});

test('the shadow key keeps its legacy shape for default, and the pruner is scoped by account', () => {
  assert.equal(T.shadowKey('outlook', null, 'm1'), 'outlook:m1');
  assert.equal(T.shadowKey('outlook', 'default', 'm1'), 'outlook:m1', 'the shadows already in data.json keep working');
  assert.equal(T.shadowKey('todoist', null, '7'), 'todoist:7');
  assert.equal(T.shadowKey('outlook', 'work', 'm1'), 'outlook@work:m1');
  assert.equal(T.shadowPrefix('outlook', 'work'), 'outlook@work:');
  const shadows = { 'outlook:a1': { done: false }, 'outlook@work:b1': { done: false }, 'todoist:7': { done: false } };
  // The default run knows nothing of b1: without the scope it would drop the
  // work shadow, and an uncheck on that card could then never reach Outlook.
  assert.deepEqual(T.pruneShadows(shadows, 'outlook', new Set(['a1']), new Set(['a1']), 0, undefined, 'default'), []);
  assert.deepEqual(T.pruneShadows(shadows, 'outlook', new Set(['b1']), new Set(['b1']), 0, undefined, 'work'), []);
  // and each still prunes its own
  assert.deepEqual(T.pruneShadows(shadows, 'outlook', new Set(), new Set(), 0, undefined, 'work'), ['outlook@work:b1']);
  assert.deepEqual(T.pruneShadows(shadows, 'outlook', new Set(), new Set(), 0, undefined, 'default'), ['outlook:a1']);
});

test('SOURCE: the upsert scopes its existing map, its shadow keys and its reconcile by account', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const body = main.slice(main.indexOf('async upsertSource('), main.indexOf('async readBody('));
  assert.ok(body.length > 100);
  assert.match(body, /const accountId = account \? account\.id : null;/);
  assert.match(body, /if \(accountId && itemAccountId\(it\) !== accountId\) continue;/, 'the existing map is scoped');
  assert.match(body, /const account = \(result && result\.account\) \|\| null;/, 'the account is read off the result syncNow stamped on it');
  assert.match(body, /reconcileStaleIds\(source, allItems, openIds, \(it\) => scopeAgrees\(s\._shadow\[shadowKey\(source, accountId, it\.id\)\], scope\)\n\s*&& \(!accountId \|\| itemAccountId\(it\) === accountId\)\)/);
  const sync = main.slice(main.indexOf('async syncNow('), main.indexOf('async upsertSource('));
  assert.match(sync, /if \(account\) result\.account = account;\n\s*if \(result\.ok\) await this\.upsertSource\(source, result\);/,
    'syncNow stamps the run\'s account on its result right before upstream\'s own call');
  assert.match(body, /pruneShadows\(s\._shadow, source, new Set\(existing\.keys\(\)\), openIds, nowMs, undefined, accountId\)/);
  assert.ok(!/`\$\{source\}:\$\{/.test(body), 'every shadow key goes through shadowKey');
  // The reopen retry is scoped too: it walks every item in the vault.
  const reopen = body.slice(body.indexOf('if (s.completeOnSource) {'));
  assert.match(reopen, /if \(accountId && itemAccountId\(it\) !== accountId\) continue;/);
});

test('SOURCE: source_account is written only from the second mailbox on', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const body = main.slice(main.indexOf('async createItemFile('), main.indexOf('// Applies the merge result'));
  assert.match(body, /accountId && accountId !== OUTLOOK_DEFAULT_ACCOUNT \? \[`source_account: \$\{JSON\.stringify\(String\(accountId\)\)\}`\] : \[\]/,
    'the default account writes no field, so the notes that exist are never touched');
  assert.match(body, /this\.settings\._shadow\[shadowKey\(source, accountId, t\.id\)\]/);
});

/* -------------------------------------------------------------------------
 * 5. A WRITE GOES TO THE MAILBOX THE NOTE CAME FROM
 * ---------------------------------------------------------------------- */

test('the flag write is routed by the item, not by whichever account is first', async () => {
  const seen = [];
  const requestUrl = async (req) => { seen.push(req); return { status: 200, json: {}, text: '{}', headers: {} }; };
  const s = T.withSecrets(base({
    outlookAccounts: [WORK], outlookRefreshToken__work: 'rt-2', outlookAccessToken__work: 'at-2',
    outlookExpiresAt__work: String(Date.now() + 3600000), outlookScopes: 'Mail.Read Mail.ReadWrite',
  }), new T.SecretVault(null));
  // The work account granted only Mail.Read, so a flag write must be refused
  // on ITS scopes and not on the first account's.
  await assert.rejects(
    T.outlookSetClosed(s, { id: 'm-work', sourceAccount: 'work' }, true, { requestUrl }),
    /Mail\.ReadWrite/, 'the refusal reads the work account\'s granted scopes');
  assert.equal(seen.length, 0, 'and it is refused before any call');
  // The default account did grant it, and the call carries ITS token.
  await T.outlookSetClosed(s, { id: 'm-default' }, true, { requestUrl });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.Authorization, 'Bearer at-1');
});

test('SOURCE: the registry call site is unchanged; the connector resolves the account', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  // The upstream gate on applyDoneOnSource still holds byte for byte.
  assert.match(main, /await c\.setClosed\(this\.withSecrets\(\), item, closed\);/);
  const body = main.slice(main.indexOf('async function outlookSetClosed('), main.indexOf('// The settings tab\'s one line on the sign-in'));
  assert.match(body, /outlookAccountView\(settings \|\| \{\}, outlookAccountById\(settings \|\| \{\}, itemAccountId\(item\)\)\)/);
});

/* -------------------------------------------------------------------------
 * 6. NOTHING EVER RETURNS A HEALTHY EMPTY RESULT
 * ---------------------------------------------------------------------- */

test('an account switched off degrades; it never returns an empty healthy result', async () => {
  const off = Object.assign({}, WORK, { enabled: false });
  const s = base({ outlookAccounts: [off], outlookRefreshToken__work: 'rt-2' });
  const view = T.outlookAccountView(T.withSecrets(s, new T.SecretVault(null)), T.outlookAccountById(s, 'work'));
  const r = await T.outlookFetchOpen(view, { requestUrl: async () => { throw new Error('no call may be made'); } });
  assert.equal(r.ok, false, 'a healthy empty set would stamp done on every note this mailbox owns');
  assert.equal(r.reason, 'misconfigured');
  assert.match(r.message, /switched off/);
  assert.deepEqual(r.items, []);
  // A disabled account also contributes no run at all.
  assert.deepEqual(T.outlookExtraRuns(s).map((x) => x.account.id), []);
});

test('the extra runs are the mailboxes past the first, and the status rows fold into one', () => {
  const s = base({ outlookAccounts: [{ id: 'default', folder: 'Personal' }, WORK, { id: 'third', clientId: CLIENT2 }] });
  assert.deepEqual(T.outlookExtraRuns(s).map((x) => x.account.id), ['work', 'third'], 'default is the run syncNow already makes');
  assert.deepEqual(T.outlookExtraRuns(s).map((x) => x.source), ['outlook', 'outlook']);
  // Two healthy runs add up; one unhealthy run wins and is what the tray says.
  const ok1 = { ok: true, reason: null, message: null, count: 3, at: 'A' };
  const ok2 = { ok: true, reason: null, message: null, count: 4, at: 'B' };
  assert.deepEqual(T.mergeSyncStatus(ok1, ok2), { ok: true, reason: null, message: null, count: 7, at: 'B' });
  const bad = { ok: false, reason: 'no-token', message: 'Work: Outlook is not signed in.', count: 0, at: 'B' };
  assert.equal(T.mergeSyncStatus(ok1, bad).ok, false);
  assert.match(T.mergeSyncStatus(ok1, bad).message, /^Work: /, 'the row names the mailbox');
  assert.equal(T.mergeSyncStatus(bad, ok2).message, bad.message, 'the FIRST unhealthy run is the one reported');
  assert.equal(T.mergeSyncStatus(null, ok1), ok1);
});

/* -------------------------------------------------------------------------
 * 9. THE CALENDAR FEED, AND THE OAUTH CALLBACK
 * ---------------------------------------------------------------------- */

test('the default calendar feed keeps its legacy id and its exact legacy shape', () => {
  assert.equal(T.graphFeedId('default'), 'outlook-graph');
  assert.equal(T.graphFeedId(null), 'outlook-graph');
  assert.equal(T.graphFeedId('work'), 'outlook-graph-work');
  assert.equal(T.graphFeedAccountId({ id: 'outlook-graph' }), 'default', 'a feed from before accounts existed is the default one');
  assert.equal(T.graphFeedAccountId({ id: 'outlook-graph-work', accountId: 'work' }), 'work');
  const s = { calendars: [] };
  assert.equal(T.ensureGraphCalendarFeed(s), true);
  assert.deepEqual(Object.keys(s.calendars[0]).sort(), ['color', 'enabled', 'id', 'kind', 'name', 'url'],
    'no accountId key on the default feed: the row already in data.json stays byte-identical');
  // The guard is per account: a second sign-in must not find the first
  // account's feed and decide there is nothing to do.
  assert.equal(T.ensureGraphCalendarFeed(s), false, 'idempotent for the same account');
  assert.equal(T.ensureGraphCalendarFeed(s, 'work', 'Work'), true, 'the second mailbox gets its own');
  assert.equal(s.calendars[1].id, 'outlook-graph-work');
  assert.equal(s.calendars[1].accountId, 'work');
  assert.equal(s.calendars[1].name, 'Outlook calendar (Work)');
  assert.equal(T.ensureGraphCalendarFeed(s, 'work', 'Work'), false);
  // accountId survives the sanitiser, or it would vanish on the next save.
  assert.equal(T.calendarFeeds(s)[1].accountId, 'work');
  assert.equal(T.calendarFeeds(s)[0].accountId, undefined);
});

test('a graph feed is ready by ITS OWN account\'s sign-in', () => {
  const s = T.withSecrets(base({
    outlookAccounts: [WORK],
    calendars: [{ id: 'outlook-graph', kind: 'graph' }, { id: 'outlook-graph-work', kind: 'graph', accountId: 'work' }],
  }), new T.SecretVault(null));
  const c = T.CONNECTORS['outlook-calendar'];
  assert.equal(c.ready({ id: 'outlook-graph', kind: 'graph' }, s), true, 'the first account is signed in');
  assert.equal(c.ready({ id: 'outlook-graph-work', kind: 'graph', accountId: 'work' }, s), false, 'the work account is not');
  const signedIn = T.withSecrets(base({ outlookAccounts: [WORK], outlookRefreshToken__work: 'rt-2' }), new T.SecretVault(null));
  assert.equal(c.ready({ id: 'outlook-graph-work', kind: 'graph', accountId: 'work' }, signedIn), true);
});

test('SOURCE: the callback is routed on the state nonce, with a TTL, behind the one handler', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  // One handler, one redirect URI: a per-account redirect URI would mean a
  // per-account Entra registration.
  assert.equal((main.match(/registerObsidianProtocolHandler\(/g) || []).length, 1);
  assert.match(main, /const OUTLOOK_REDIRECT_URI = 'obsidian:\/\/icor-for-life-planner\/auth';/);
  const cb = main.slice(main.indexOf('async outlookAuthCallback('), main.indexOf('async outlookDeviceSignIn('));
  assert.match(cb, /const pending = \(replyState && map\.get\(replyState\)\) \|\| null;/, 'routed on the nonce');
  assert.match(cb, /map\.delete\(pending\.state\);/, 'and the entry is consumed');
  const signIn = main.slice(main.indexOf('async outlookSignIn('), main.indexOf('// The protocol handler'));
  assert.match(signIn, /this\.outlookSweepPending\(\)\.set\(state, \{/, 'swept before every new sign-in');
  assert.match(signIn, /accountId: account\.id/);
  assert.match(main, /const OUTLOOK_PENDING_TTL_MS = 10 \* 60 \* 1000;/);
  // The no-match branch is the one that was already correct.
  assert.match(main, /No sign-in was waiting for this reply\./);
});

test('the granted scopes are written where that account reads them back', () => {
  const s = base({ outlookAccounts: [WORK] });
  T.outlookWriteAccountScopes(s, 'work', 'Mail.Read Mail.ReadWrite');
  assert.equal(T.outlookAccountById(s, 'work').scopes, 'Mail.Read Mail.ReadWrite');
  assert.equal(T.outlookHasWriteScope(T.outlookAccountView(s, T.outlookAccountById(s, 'work'))), true);
  assert.equal(s.outlookScopes, 'Mail.Read Calendars.Read', 'the first account is not touched');
  T.outlookWriteAccountScopes(s, 'default', 'Mail.Read');
  assert.equal(s.outlookScopes, 'Mail.Read', 'the reserved default writes the flat field it always wrote');
  T.outlookWriteAccountScopes(s, 'work', '');
  assert.equal(T.outlookHasWriteScope(T.outlookAccountView(s, T.outlookAccountById(s, 'work'))), false, 'sign-out revokes it');
});

test('no scope crept in: an extra mailbox asks for exactly what the first one asked for', () => {
  // A forced re-consent is a blocker the member must hear about before it
  // ships, so the constants are pinned rather than eyeballed.
  assert.deepEqual(T.OUTLOOK_SCOPES_READ, ['offline_access', 'openid', 'profile', 'Mail.Read', 'Calendars.Read']);
  assert.deepEqual(T.OUTLOOK_SCOPES_WRITE, ['offline_access', 'openid', 'profile', 'Mail.Read', 'Mail.ReadWrite', 'Calendars.Read']);
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

test('an account nothing lists any more resolves to NOT SIGNED IN, never to the first mailbox', () => {
  const s = base({ outlookAccounts: [WORK] });
  // A note, or a calendar feed, left behind by a record deleted from
  // data.json. Falling back to the default account would read - and flag -
  // somebody else's mail under the wrong label.
  const ghost = T.outlookAccountById(s, 'ghost');
  assert.equal(ghost.id, 'ghost');
  assert.equal(ghost.enabled, false);
  assert.equal(ghost.clientId, '');
  const view = T.outlookAccountView(s, ghost);
  assert.equal(T.outlookSignedIn(view), false);
  assert.notEqual(view.outlookRefreshToken, 'rt-1', 'not the first account\'s token');
  const feed = { id: 'outlook-graph-ghost', kind: 'graph', accountId: 'ghost' };
  assert.equal(T.CONNECTORS['outlook-calendar'].ready(feed, T.withSecrets(s, new T.SecretVault(null))), false);
  // A flag write for such a note is refused rather than sent anywhere.
  assert.equal(T.outlookSignedIn(T.outlookFeedView(s, feed)), false);
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
