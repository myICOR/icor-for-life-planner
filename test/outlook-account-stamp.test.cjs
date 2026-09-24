/* A run that cannot name its mailbox owns no note.
 *
 * The account a run fetched rides on the result object that syncNow stamps
 * one line before upstream's pinned `upsertSource(source, result)` call. The
 * stamp is load-bearing: `existing`, the shadow keys, reconcile and the
 * shadow prune are all scoped by it. It had no in-code fallback. A later
 * upstream that copies or freezes the result before its call drops the stamp
 * silently, `accountId` reads null, and null meant "every Outlook note is
 * mine": one mailbox's healthy open set then reconciles the OTHER mailbox's
 * notes to done.
 *
 * The gate, driven through the real upsertSource against a fake vault:
 *   1. two accounts listed, the result arrives without its stamp: reconcile
 *      stands down. Zero notes to done, zero shadows marked done. The same
 *      fetch WITH its stamp still retires the stale note of its own mailbox
 *      and leaves the other mailbox alone (the control, so the gate is seen
 *      to gate reconcile and nothing wider);
 *   2. one sign-in, no stamp at all: upstream's exact shape, reconciles as
 *      it always did. The guard is inert for the vault the release before
 *      accounts existed;
 *   3. another source, two Outlook accounts listed: its unstamped result
 *      reconciles as before. The guard is Outlook's, not the sync's.
 *
 * Test 1 was watched fail before the guard existed.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

const PluginClass = require(T.__mainPath);
const { TFile, TFolder } = T.__obsidian;

const ROOT = '02 Planner';
const HEAD = '---\ntype: planner-item\n---\n';

// A planner note backed by a mutable frontmatter object the fake
// processFrontMatter edits in place, the same thing Obsidian does.
function note(sub, source, id, fm) {
  const f = new TFile();
  f.path = `${ROOT}/${sub}/Item (${source}-${id}).md`;
  f.basename = `Item (${source}-${id})`;
  f.extension = 'md';
  f.fm = Object.assign({
    type: 'planner-item', source, external_id: id, title: `Item ${id}`,
    status: 'open', due: null, priority: 3, url: null, tags: [], source_status: 'flagged',
    planned_day: null, planned_half: null, planned_order: 0, weekly_goal: false,
    done_local: false,
  }, fm || {});
  f.body = '';
  return f;
}

// The folders the notes name, nested under the room, and nothing else.
function vault(files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  const folders = new Map();
  const folderFor = (p) => {
    if (!folders.has(p)) { const d = new TFolder(); d.path = p; d.children = []; folders.set(p, d); }
    return folders.get(p);
  };
  const root = folderFor(ROOT);
  for (const f of files) {
    const parts = f.path.split('/');
    let acc = parts[0];
    let parent = root;
    for (const part of parts.slice(1, -1)) {
      acc = `${acc}/${part}`;
      const d = folderFor(acc);
      if (!parent.children.includes(d)) parent.children.push(d);
      parent = d;
    }
    parent.children.push(f);
  }
  return {
    vault: {
      getAbstractFileByPath: (p) => folders.get(p) || byPath.get(p) || null,
      cachedRead: async (f) => `${HEAD}${f.body || ''}`,
      process: async (f, fn) => { f.body = fn(`${HEAD}${f.body || ''}`).replace(/^---\n[\s\S]*?\n---\n?/, ''); },
      create: async () => { throw new Error('no create in this gate'); },
      createFolder: async () => { },
    },
    metadataCache: { getFileCache: (f) => ({ frontmatter: f.fm }) },
    fileManager: { processFrontMatter: async (f, fn) => { fn(f.fm); } },
  };
}

function plugin(settings, files) {
  const p = Object.create(PluginClass.prototype);
  p.settings = Object.assign({
    plannerFolder: ROOT,
    outlookClientId: 'cid', outlookTenant: 'consumers', outlookRefreshToken: 'r-default',
    completeOnSource: false, pushEdits: false, _shadow: {},
  }, settings);
  p.secrets = null;
  p.app = vault(files);
  p._pushTimers = new Map();
  p._syncWrites = new Map();
  return p;
}

const TWO = [
  { id: 'default', label: 'Irl', folder: 'Irlpersonal' },
  { id: 'us', label: 'US', folder: 'USpersonal', clientId: 'cid', tenant: 'consumers', includedFolderPaths: ['Inbox'] },
];
const shadow = () => ({ due: null, priority: 3, description: '', done: false });
const mail = (id) => ({ id, title: `Item ${id}`, due: null, priority: 3, description: '', status: 'flagged', tags: [], url: null });

// What syncNow hands the upsert on a us run: upstream's own result, which
// syncNow stamps with the account. The gate strips the stamp the way a
// future upstream would - a copy made before the call - and freezes it, so
// the guard is also seen not to need a write on the object.
function usFixture() {
  const irl = note('Outlook/Irlpersonal', 'outlook', 'A1');
  const usKept = note('Outlook/USpersonal', 'outlook', 'B1', { source_account: 'us' });
  const usGone = note('Outlook/USpersonal', 'outlook', 'B2', { source_account: 'us' });
  const p = plugin({
    outlookAccounts: TWO, outlookRefreshToken__us: 'r-us',
    _shadow: { 'outlook:A1': shadow(), 'outlook@us:B1': shadow(), 'outlook@us:B2': shadow() },
  }, [irl, usKept, usGone]);
  const result = { ok: true, source: 'outlook', items: [mail('B1')], retainedIds: [] };
  return { p, irl, usKept, usGone, result };
}

test('THE GATE: two mailboxes and a result that lost its account stamp reconcile NOTHING', async () => {
  const { p, irl, usKept, usGone, result } = usFixture();
  const stripped = Object.freeze(Object.assign({}, result));
  assert.equal('account' in stripped, false);
  await p.upsertSource('outlook', stripped);
  for (const f of [irl, usKept, usGone]) {
    assert.equal(f.fm.status, 'open', `${f.path}: a run that cannot say whose notes it may touch touches none`);
    assert.equal(f.fm.done_local, false);
  }
  for (const k of ['outlook:A1', 'outlook@us:B1', 'outlook@us:B2']) {
    assert.ok(p.settings._shadow[k], `${k} survives`);
    assert.equal(p.settings._shadow[k].done, false, `${k} is not marked done`);
  }
});

test('the control: the same fetch WITH its stamp retires its own stale note and leaves the other mailbox alone', async () => {
  const { p, irl, usKept, usGone, result } = usFixture();
  result.account = T.outlookAccountById(p.settings, 'us');
  await p.upsertSource('outlook', result);
  assert.equal(usGone.fm.status, 'done', 'B2 vanished from the us open set: done');
  assert.equal(p.settings._shadow['outlook@us:B2'].done, true);
  assert.equal(usKept.fm.status, 'open');
  assert.equal(irl.fm.status, 'open', "the default mailbox is not this run's business");
  assert.equal(p.settings._shadow['outlook:A1'].done, false);
});

test("one sign-in and no stamp is upstream's own shape, and it still reconciles", async () => {
  const kept = note('Outlook', 'outlook', 'A1');
  const gone = note('Outlook', 'outlook', 'A2');
  const p = plugin({ _shadow: { 'outlook:A1': shadow(), 'outlook:A2': shadow() } }, [kept, gone]);
  assert.equal(T.outlookAccountList(p.settings).length, 1);
  await p.upsertSource('outlook', Object.freeze({ ok: true, source: 'outlook', items: [mail('A1')], retainedIds: [] }));
  assert.equal(gone.fm.status, 'done', 'with one account the null stamp means what it always meant');
  assert.equal(p.settings._shadow['outlook:A2'].done, true);
  assert.equal(kept.fm.status, 'open');
});

test("the guard is Outlook's: another source's unstamped run reconciles as before beside two mailboxes", async () => {
  const task = (id) => ({
    id, title: `Item ${id}`, due: null, priority: 3, description: '', status: 'uploaded',
    listId: '900601028885', tags: [], url: null, parentId: null, recurring: null, dueString: null,
  });
  const kept = note('ClickUp', 'clickup', 'c1', { source_status: 'uploaded', list_id: '900601028885' });
  const gone = note('ClickUp', 'clickup', 'c2', { source_status: 'uploaded', list_id: '900601028885' });
  const irl = note('Outlook/Irlpersonal', 'outlook', 'A1');
  const p = plugin({
    outlookAccounts: TWO, outlookRefreshToken__us: 'r-us', clickupToken: 'tok', clickupTeamId: '2608459',
    _shadow: { 'clickup:c1': shadow(), 'clickup:c2': shadow(), 'outlook:A1': shadow() },
  }, [kept, gone, irl]);
  await p.upsertSource('clickup', Object.freeze({ ok: true, source: 'clickup', items: [task('c1')] }));
  assert.equal(gone.fm.status, 'done');
  assert.equal(kept.fm.status, 'open');
  assert.equal(irl.fm.status, 'open', 'and a ClickUp run never reads an Outlook note');
});

/* ---- 0.15.x: a note the source says is GONE leaves with its own shadow ---- */

// A us note confirmed gone by the probe goes to the trash, and the shadow it
// leaves behind is the ACCOUNT-KEYED one. removeGoneItem (0.15.0) deleted the
// bare `source:id`; for a second mailbox that key never existed, so the real
// shadow lingered until pruneShadows, and a re-appearing id would have read a
// stale baseline. The probe is asked only about this run's own notes.
test('a us note the probe confirms gone is trashed with its outlook@us shadow, and the irl note is never asked about', async () => {
  const { p, irl, usKept, usGone, result } = usFixture();
  const trashed = [];
  p.app.vault.trash = async (f, system) => { assert.equal(system, true); trashed.push(f.path); };
  const asked = [];
  const c = T.CONNECTORS.outlook;
  const real = c.probeGone;
  c.probeGone = async (s, item) => { asked.push(item.id); return item.id === 'B2'; };
  try {
    await p.upsertSource('outlook', Object.assign({}, result, { account: TWO[1] }));
  } finally { c.probeGone = real; }
  assert.deepEqual(asked, ['B2'], 'only this run\'s absent note is probed; the irl note belongs to another run');
  assert.deepEqual(trashed, [usGone.path], 'gone at the source, gone here');
  assert.equal('outlook@us:B2' in p.settings._shadow, false, 'its account-keyed shadow leaves with it');
  assert.ok(p.settings._shadow['outlook@us:B1'], 'the kept note keeps its shadow');
  assert.ok(p.settings._shadow['outlook:A1'], 'the irl shadow is untouched');
  assert.equal(irl.fm.status, 'open');
  assert.equal(usKept.fm.status, 'open');
});

test('SOURCE: removeGoneItem deletes the shadow under the item\'s own account key', () => {
  const main = require('fs').readFileSync(T.__mainPath, 'utf8');
  const body = main.slice(main.indexOf('async removeGoneItem('), main.indexOf('async probeGoneIds('));
  assert.ok(body.length > 50 && body.length < 1500);
  assert.match(body, /const key = shadowKey\(source, itemAccountId\(item\), item\.id\);/);
});
