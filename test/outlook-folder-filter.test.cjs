/* Which Outlook folders the tray reads.
 *
 * A hand-edited list in data.json, `outlookIncludedFolderPaths`. No settings
 * UI, no cache: the list is typed into data.json, Obsidian is reloaded, and
 * the paths are resolved against the live mailbox at every fetch.
 *
 * Gated here, pure and scripted (no live network):
 *   - the parser: absent is OFF (every folder, exactly what this plugin did
 *     before the feature), present-but-empty is READ NOTHING, and non-string
 *     entries, stray slashes, case and duplicates all fall out;
 *   - subtree matching by SEGMENT, never by string prefix: 'Inbox' covers
 *     'Inbox/Receipts' and 'Inbox/Receipts/Scans', and never 'Inboxes',
 *     'Inbox Archive', or a folder named 'Inbox' nested under another one;
 *   - resolution: msgfolderroot plus the mailFolders delta collection, both
 *     well-known, both flat, no recursion, both inside Mail.Read;
 *   - THE HAZARD, twice: a configured-to-nothing list and a resolution that
 *     fails or matches nothing are DEGRADED results, never empty healthy
 *     ones. An empty healthy Outlook result is the cockpit's "all finished"
 *     signal and would stamp status: done on every Outlook note in the vault
 *     in a single sync;
 *   - retainedIds: mail the mailbox still carries that this run filtered out
 *     rides back on the result and is unioned into openIds WHERE IT IS BUILT,
 *     so reconcileStaleIds and pruneShadows both see it.
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
const SIGNED = {
  outlookClientId: CLIENT, outlookTenant: 'common', outlookRefreshToken: 'rt-1', outlookAccessToken: 'at-1',
  outlookExpiresAt: String(Date.now() + 3600000), outlookAccount: 'me@example.com', outlookScopes: 'Mail.Read Calendars.Read',
};
const resolved = (extra) => T.withSecrets(Object.assign({}, T.DEFAULT_SETTINGS, SIGNED, extra || {}), new T.SecretVault(null));

function wire(steps) {
  const calls = [];
  const requestUrl = async (req) => {
    calls.push(req);
    const step = steps.shift();
    if (!step) throw new Error(`unscripted call: ${req.method || 'GET'} ${req.url}`);
    return typeof step === 'function' ? step(req) : step;
  };
  return { calls, requestUrl };
}
const json = (status, body, headers) => ({ status, json: body, text: JSON.stringify(body), headers: headers || {} });

/* The mailbox every scripted test below uses. Six real shapes:
 * the Inbox with a child and a GRANDchild (subtree past one level), two
 * boundary traps at the root, and an 'Inbox' nested under Archive that must
 * stay out because paths are anchored at the mailbox root. */
const ROOT = 'ROOT-msgfolderroot';
const FOLDERS = [
  { id: 'f-inbox', displayName: 'Inbox', parentFolderId: ROOT },
  { id: 'f-receipts', displayName: 'Receipts', parentFolderId: 'f-inbox' },
  { id: 'f-scans', displayName: 'Scans', parentFolderId: 'f-receipts' },
  { id: 'f-inboxes', displayName: 'Inboxes', parentFolderId: ROOT },
  { id: 'f-inbox-archive', displayName: 'Inbox Archive', parentFolderId: ROOT },
  { id: 'f-archive', displayName: 'Archive', parentFolderId: ROOT },
  { id: 'f-archive-inbox', displayName: 'Inbox', parentFolderId: 'f-archive' },
  { id: 'f-sent', displayName: 'Sent Items', parentFolderId: ROOT },
];
const mail = (id, folder) => ({
  id, subject: `Mail ${id}`, bodyPreview: '', importance: 'normal',
  receivedDateTime: '2026-09-05T08:00:00Z', webLink: 'https://outlook.office365.com/owa/?ItemID=x',
  flag: { flagStatus: 'flagged' }, parentFolderId: folder, conversationId: 'c',
});
// root, then the delta page, then one page of flagged mail.
const mailbox = (messages, deltaPages) => wire(
  [json(200, { id: ROOT })]
    .concat(deltaPages || [json(200, { value: FOLDERS })])
    .concat([json(200, { value: messages })]),
);

/* -------------------------------------------------------------------- *
 * 1. The parser: absent is not empty
 * -------------------------------------------------------------------- */

test('the include list is parsed defensively, and ABSENT is not the same as EMPTY', () => {
  assert.equal(typeof T.outlookIncludedFolderPaths, 'function', 'the parser must exist');
  // Off: the key was never written. Every vault that never edited data.json
  // is here, and it must behave exactly as it did before this feature.
  assert.equal(T.outlookIncludedFolderPaths({}), null, 'absent is OFF');
  assert.equal(T.outlookIncludedFolderPaths(undefined), null);
  assert.equal(T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: null }), null);
  assert.equal(T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: 'Inbox' }), null, 'a string is not a list');
  assert.equal(T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: { Inbox: true } }), null);
  // On, and configured to nothing: an ARRAY that yields no usable path.
  assert.deepEqual(T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: [] }), []);
  assert.deepEqual(T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: ['', '   ', '/', '///'] }), [], 'nothing usable is still an empty list, not OFF');
  assert.deepEqual(T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: [null, 5, {}, []] }), [], 'non-strings fall out');
  // On, with paths: lowercased segment arrays, stray slashes and repeats gone.
  assert.deepEqual(T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: ['Inbox'] }), [['inbox']]);
  assert.deepEqual(T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: ['/Inbox/'] }), [['inbox']], 'leading and trailing slashes are noise');
  assert.deepEqual(T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: ['Inbox//Receipts'] }), [['inbox', 'receipts']], 'a doubled slash is one boundary');
  assert.deepEqual(T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: ['  Inbox / Receipts  '] }), [['inbox', 'receipts']], 'segments are trimmed');
  assert.deepEqual(T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: ['Inbox', 'INBOX', '/inbox'] }), [['inbox']], 'duplicates collapse, case-insensitively');
  assert.deepEqual(
    T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: ['Inbox', 'Projects/Acme'] }),
    [['inbox'], ['projects', 'acme']],
  );
});

/* -------------------------------------------------------------------- *
 * 2. Subtree and boundary matching
 * -------------------------------------------------------------------- */

test('a listed path matches itself and everything beneath it, on SEGMENT boundaries only', () => {
  assert.equal(typeof T.outlookFolderPathIncluded, 'function');
  const inc = [['inbox']];
  assert.equal(T.outlookFolderPathIncluded(['inbox'], inc), true, 'the folder itself');
  assert.equal(T.outlookFolderPathIncluded(['inbox', 'receipts'], inc), true, 'a child');
  assert.equal(T.outlookFolderPathIncluded(['inbox', 'receipts', 'scans'], inc), true, 'a grandchild, and so any folder made later');
  // The trap a string prefix would fall into.
  assert.equal(T.outlookFolderPathIncluded(['inboxes'], inc), false, "'Inboxes' is a different folder");
  assert.equal(T.outlookFolderPathIncluded(['inbox archive'], inc), false, "'Inbox Archive' is a different folder");
  assert.equal(T.outlookFolderPathIncluded(['inboxed', 'receipts'], inc), false);
  // Anchored at the root: a deeper path never matches by its tail.
  assert.equal(T.outlookFolderPathIncluded(['archive', 'inbox'], inc), false, 'an Inbox under Archive is not the Inbox');
  // A deeper listed path.
  const deep = [['inbox', 'receipts']];
  assert.equal(T.outlookFolderPathIncluded(['inbox'], deep), false, 'the parent of a listed folder is not included');
  assert.equal(T.outlookFolderPathIncluded(['inbox', 'receipts'], deep), true);
  assert.equal(T.outlookFolderPathIncluded(['inbox', 'receipts', 'scans'], deep), true);
  assert.equal(T.outlookFolderPathIncluded(['inbox', 'receipts old'], deep), false);
  // No list at all matches nothing.
  assert.equal(T.outlookFolderPathIncluded(['inbox'], []), false);
  assert.equal(T.outlookFolderPathIncluded(['inbox'], null), false);
});

test('the flat folder list resolves to ids, anchored at the mailbox root', () => {
  assert.equal(typeof T.outlookIncludedFolderIds, 'function');
  const ids = T.outlookIncludedFolderIds(FOLDERS, ROOT, [['inbox']]);
  assert.deepEqual([...ids].sort(), ['f-inbox', 'f-receipts', 'f-scans'], 'the Inbox subtree, whole, and nothing else');
  assert.equal(ids.has('f-inboxes'), false);
  assert.equal(ids.has('f-inbox-archive'), false);
  assert.equal(ids.has('f-archive-inbox'), false, 'anchoring: the chain must reach msgfolderroot');
  // Case is the parser's job on the data.json side and Graph's display names
  // on the other, so the two together are what has to be case-blind.
  const parsed = T.outlookIncludedFolderPaths({ outlookIncludedFolderPaths: ['INBOX/Receipts'] });
  assert.deepEqual([...T.outlookIncludedFolderIds(FOLDERS, ROOT, parsed)].sort(), ['f-receipts', 'f-scans']);
  assert.deepEqual([...T.outlookIncludedFolderIds(FOLDERS, ROOT, [['archive', 'inbox']])], ['f-archive-inbox'], 'the deep path names it explicitly');
  // Nothing matches -> an empty set, which the caller must NOT read as a
  // healthy empty mailbox.
  assert.equal(T.outlookIncludedFolderIds(FOLDERS, ROOT, [['nowhere']]).size, 0);
  assert.equal(T.outlookIncludedFolderIds([], ROOT, [['inbox']]).size, 0);
  assert.equal(T.outlookIncludedFolderIds(null, ROOT, [['inbox']]).size, 0);
  // The root itself is never a path segment and never an id to read.
  assert.equal(T.outlookIncludedFolderIds(
    FOLDERS.concat([{ id: ROOT, displayName: 'Top of Information Store', parentFolderId: 'above' }]), ROOT, [['inbox']],
  ).has(ROOT), false);
  // A parent chain that loops ends instead of hanging.
  const cyclic = [
    { id: 'a', displayName: 'A', parentFolderId: 'b' },
    { id: 'b', displayName: 'B', parentFolderId: 'a' },
    { id: 'f-inbox', displayName: 'Inbox', parentFolderId: ROOT },
  ];
  assert.deepEqual([...T.outlookIncludedFolderIds(cyclic, ROOT, [['inbox'], ['a'], ['b']])], ['f-inbox']);
});

/* -------------------------------------------------------------------- *
 * 3. The fetch: off, configured-to-nothing, and the happy path
 * -------------------------------------------------------------------- */

test('with the key absent nothing is filtered and no folder call is made at all', async () => {
  const w = wire([json(200, { value: [mail('m1', 'f-inbox'), mail('m2', 'f-sent')] })]);
  const r = await T.outlookFetchOpen(resolved(), { requestUrl: w.requestUrl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => i.id), ['m1', 'm2'], 'every folder is read, as before the feature');
  assert.equal(r.retainedIds, undefined, 'nothing was held back, so nothing rides back');
  assert.equal(w.calls.length, 1, 'one call: the messages walk. The mailbox is never listed.');
  assert.match(w.calls[0].url, /\/me\/messages\?/);
});

test('THE HAZARD (1): configured to read nothing is DEGRADED, never an empty healthy result', async () => {
  const w = wire([]); // any Graph call at all is an unscripted-call throw
  const r = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: [] }), { requestUrl: w.requestUrl });
  assert.equal(r.ok, false, 'ok:true with items:[] would reconcile every Outlook note to done in one sync');
  assert.equal(r.reason, 'misconfigured');
  assert.deepEqual(r.items, []);
  assert.match(r.message, /no mail was read/i);
  assert.match(r.hint, /outlookIncludedFolderPaths/, 'the hint names the key to edit');
  assert.match(r.hint, /reload/i, 'and says the edit needs a reload');
  assert.equal(w.calls.length, 0, 'no fetch happens at all');
  // A list of junk is the same configuration, and the same answer.
  const junk = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: ['', '  ', 7] }), { requestUrl: wire([]).requestUrl });
  assert.equal(junk.ok, false);
  assert.equal(junk.reason, 'misconfigured');
});

test('the happy path: two flat well-known calls, the subtree filtered, the rest retained', async () => {
  const w = mailbox([
    mail('m-inbox', 'f-inbox'),
    mail('m-receipt', 'f-receipts'),
    mail('m-scan', 'f-scans'),
    mail('m-sent', 'f-sent'),
    mail('m-other-inbox', 'f-archive-inbox'),
  ]);
  const r = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: ['Inbox'] }), { requestUrl: w.requestUrl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => i.id), ['m-inbox', 'm-receipt', 'm-scan'], 'the whole subtree, nothing outside it');
  assert.deepEqual(r.retainedIds, ['m-sent', 'm-other-inbox'], 'filtered out is not finished: the ids ride back');
  // The shape of the resolution: well-known names, flat, no recursion.
  assert.equal(w.calls.length, 3, 'root, one folder page, one message page. No walk per folder.');
  assert.equal(w.calls[0].url, 'https://graph.microsoft.com/v1.0/me/mailFolders/msgfolderroot?$select=id',
    'the mailbox root by its well-known name, so the mailbox locale does not matter');
  assert.equal(w.calls[1].url, 'https://graph.microsoft.com/v1.0/me/mailFolders/delta?$select=displayName,parentFolderId',
    'delta is the one documented way to get EVERY folder in one collection; childFolders returns immediate children only');
  assert.match(w.calls[2].url, /\/me\/messages\?/);
  for (const c of w.calls) assert.ok(String(c.url).startsWith(T.GRAPH_ORIGIN), 'the bearer token never leaves Graph');
  // No new permission: a re-consent would be a blocker for every user.
  assert.deepEqual(T.OUTLOOK_SCOPES_READ, ['offline_access', 'openid', 'profile', 'Mail.Read', 'Calendars.Read'],
    'msgfolderroot and mailFolders/delta are both covered by Mail.Read; nothing was added');
});

test('the folder list is paged through, and the page bound throws rather than filtering on half a mailbox', async () => {
  const next = 'https://graph.microsoft.com/v1.0/me/mailFolders/delta?$skiptoken=abc';
  const w = mailbox([mail('m-inbox', 'f-inbox'), mail('m-sent', 'f-sent')], [
    json(200, { value: FOLDERS.slice(0, 2), '@odata.nextLink': next }),
    json(200, { value: FOLDERS.slice(2) }),
  ]);
  const r = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: ['Inbox'] }), { requestUrl: w.requestUrl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.items.map((i) => i.id), ['m-inbox']);
  assert.equal(w.calls.length, 4, 'root, two folder pages, one message page');
  // An off-origin nextLink ends the walk, and an unfinished list must not
  // silently become a filter: page 2 of 2 here is complete, so the bound is
  // proved with a list that never ends.
  assert.ok(Number.isFinite(T.OUTLOOK_FOLDER_PAGE_CAP) && T.OUTLOOK_FOLDER_PAGE_CAP > 0);
  const endless = [json(200, { id: ROOT })];
  for (let i = 0; i < T.OUTLOOK_FOLDER_PAGE_CAP + 2; i++) endless.push(json(200, { value: [], '@odata.nextLink': next }));
  const w2 = wire(endless);
  const r2 = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: ['Inbox'] }), { requestUrl: w2.requestUrl });
  assert.equal(r2.ok, false, 'a truncated folder list is a failure, never a healthy result over a partial filter');
  assert.deepEqual(r2.items, []);
  assert.ok(w2.calls.length <= T.OUTLOOK_FOLDER_PAGE_CAP + 1, 'and the walk is bounded');
  assert.ok(!w2.calls.some((c) => /\/me\/messages/.test(String(c.url))), 'no mail is fetched once resolution failed');
});

/* -------------------------------------------------------------------- *
 * 4. THE HAZARD again: resolution that fails or matches nothing
 * -------------------------------------------------------------------- */

test('THE HAZARD (2): a resolution that fails is DEGRADED, and no mail is fetched', async () => {
  // Graph refuses the folder call.
  const down = wire([json(500, { error: { code: 'InternalServerError' } })]);
  const r = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: ['Inbox'] }), { requestUrl: down.requestUrl });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
  assert.deepEqual(r.items, []);
  assert.ok(!down.calls.some((c) => /\/me\/messages/.test(String(c.url))), 'the messages walk never starts');
  // A permission failure keeps its own classification and its own hint.
  const forbidden = wire([json(403, { error: { code: 'ErrorAccessDenied' } })]);
  const f = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: ['Inbox'] }), { requestUrl: forbidden.requestUrl });
  assert.equal(f.ok, false);
  assert.equal(f.reason, 'misconfigured');
  // Graph answers, but without a root id: still a failure, never a filter.
  const rootless = wire([json(200, {})]);
  const n = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: ['Inbox'] }), { requestUrl: rootless.requestUrl });
  assert.equal(n.ok, false);
  assert.deepEqual(n.items, []);
});

test('THE HAZARD (3): a list that names no folder in this mailbox is DEGRADED, not an empty mailbox', async () => {
  const w = mailbox([mail('m-inbox', 'f-inbox')]);
  const r = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: ['Projects/Acme'] }), { requestUrl: w.requestUrl });
  assert.equal(r.ok, false, 'ok:true with items:[] here would mark every Outlook note done');
  assert.equal(r.reason, 'misconfigured');
  assert.deepEqual(r.items, []);
  assert.match(r.hint, /full path/i, 'the hint says paths start at the mailbox root');
  assert.ok(!w.calls.some((c) => /\/me\/messages/.test(String(c.url))), 'and no mail is read');
});

/* -------------------------------------------------------------------- *
 * 5. retainedIds reaches BOTH consumers of openIds
 * -------------------------------------------------------------------- */

test('THE GATE: retained ids are unioned into openIds WHERE IT IS BUILT, so reconcile and the pruner both see them', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const body = main.slice(main.indexOf('async upsertSource('), main.indexOf('async readBody('));
  assert.ok(body.length > 100, 'upsertSource must still be findable');
  // 0.13.0 hands the upsert the whole result; the retained set rides on it.
  assert.match(body, /async upsertSource\(source, result\) \{/, "upstream's signature, untouched");
  assert.match(body, /const retainedIds = result && result\.retainedIds;/, 'the retained set is read off the result');
  const union = body.indexOf('for (const id of retainedIds || []) openIds.add(String(id));');
  assert.ok(union > -1, 'the union must be an explicit line, not a second filtered set');
  const built = body.indexOf('const openIds = new Set();');
  const reconcile = body.indexOf('reconcileStaleIds(source, allItems, openIds, (it) =>');
  const prune = body.indexOf('pruneShadows(s._shadow, source');
  assert.ok(built > -1 && reconcile > -1 && prune > -1);
  assert.ok(union > built, 'the union happens on the set openIds already is');
  assert.ok(union < reconcile, 'BEFORE reconcile reads it');
  assert.ok(union < prune, 'and BEFORE the shadow pruner reads it - the half the first build of this got wrong');
  // And the sync hands it over.
  assert.match(main, /if \(result\.ok\) await this\.upsertSource\(source, result\);/, 'syncNow hands the whole result through, retained set included');
});

test('a filtered message is neither reconciled to done nor stripped of its shadow', () => {
  // openIds exactly as upsertSource now builds it: the retained id first,
  // then the ids the fetch returned.
  const items = [{ id: 'm-inbox' }];
  const retainedIds = ['m-sent'];
  const openIds = new Set();
  for (const id of retainedIds) openIds.add(String(id));
  for (const t of items) openIds.add(t.id);

  const note = (id) => ({ source: 'outlook', id, status: 'open', reopenPending: false, due: null, priority: 3 });
  const allItems = [note('m-inbox'), note('m-sent'), note('m-deleted')];
  // Reconcile: only the message that really left the mailbox.
  const stale = T.reconcileStaleIds('outlook', allItems, openIds).map((i) => i.id);
  assert.deepEqual(stale, ['m-deleted'], 'the filtered message is still flagged in Outlook; done would be a lie');
  // Without the union it would be reconciled - the bug this exists to stop.
  const naive = new Set(items.map((t) => t.id));
  assert.deepEqual(T.reconcileStaleIds('outlook', allItems, naive).map((i) => i.id).sort(), ['m-deleted', 'm-sent']);
  // The pruner: the same set, so a filtered message whose note was deleted
  // keeps its shadow while the mailbox still carries it.
  const shadows = {
    'outlook:m-inbox': { due: null, done: false },
    'outlook:m-sent': { due: null, done: false },
    'outlook:m-deleted': { due: null, done: true, doneAt: Date.now() },
  };
  const existing = new Set(['m-inbox', 'm-deleted']); // the filtered note was never written
  const dropped = T.pruneShadows(shadows, 'outlook', existing, openIds, Date.now());
  assert.deepEqual(dropped, [], 'the retained id keeps its shadow');
  assert.deepEqual(
    T.pruneShadows(shadows, 'outlook', existing, naive, Date.now()), ['outlook:m-sent'],
    'without the union the shadow is thrown away, and the next reopen has nowhere to go',
  );
});

test('a walk that stops short still carries the retained ids: filtered is not finished, complete or not', async () => {
  // Upstream 0.13.0 returns a healthy-but-incomplete result when the page
  // cap is hit or a paging link is refused. The filtered mail on those
  // pages is still flagged at the source, so it rides back on the short
  // result exactly as on the clean one; openIds unions it either way and the
  // shadow pruner, which is not behind the completeness gate, keeps seeing
  // it. Ran red against a main.js that attached retainedIds to the clean
  // return only.
  const folderCalls = (req) => {
    if (/msgfolderroot/.test(req.url)) return json(200, { id: ROOT });
    if (/mailFolders\/delta/.test(req.url)) return json(200, { value: FOLDERS });
    return null;
  };
  // The cap: every message page offers another link, each page has one
  // Inbox mail and one Sent mail.
  let pages = 0;
  const capped = async (req) => folderCalls(req) || (() => {
    pages += 1;
    return json(200, {
      value: [mail(`in-${pages}`, 'f-inbox'), mail(`sent-${pages}`, 'f-sent')],
      '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/messages?$skip=${pages * 50}`,
    });
  })();
  let r = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: ['Inbox'] }), { requestUrl: capped });
  assert.equal(r.ok, true);
  assert.equal(r.complete, false, 'upstream: a link still in hand means the walk is short');
  assert.match(r.warning, /nothing was marked done/);
  assert.equal(r.items.length, pages, 'every Inbox mail read reaches the board');
  assert.deepEqual(r.retainedIds, Array.from({ length: pages }, (_, i) => `sent-${i + 1}`), 'and every Sent mail read is retained');
  // The refused link: one page, then a link the origin guard will not follow.
  const refused = async (req) => folderCalls(req) || json(200, {
    value: [mail('in-1', 'f-inbox'), mail('sent-1', 'f-sent')],
    '@odata.nextLink': 'https://graph.microsoft.com.evil.example/v1.0/me/messages?$skip=50',
  });
  r = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: ['Inbox'] }), { requestUrl: refused });
  assert.equal(r.ok, true);
  assert.equal(r.complete, false);
  assert.match(r.warning, /another host/);
  assert.deepEqual(r.items.map((i) => i.id), ['in-1']);
  assert.deepEqual(r.retainedIds, ['sent-1'], 'the refused walk retains what it read too');
});

test('nothing filtered means nothing retained, and the result is the plain healthy one', async () => {
  const w = mailbox([mail('m-inbox', 'f-inbox'), mail('m-receipt', 'f-receipts')]);
  const r = await T.outlookFetchOpen(resolved({ outlookIncludedFolderPaths: ['Inbox'] }), { requestUrl: w.requestUrl });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
  assert.equal('retainedIds' in r, false, 'the field is absent when it has nothing to say');
});
