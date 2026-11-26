/* A MAILBOX REBUILD MUST NEVER TRASH A STARRED-EMAIL NOTE (0.15.1).
 *
 * RFC 3501 2.3.1.1: UIDVALIDITY is the mailbox's generation number, and a
 * change to it invalidates every UID the client stored. A Dovecot rebuild,
 * an Exchange or iCloud migration, a mailbox restored from backup: after one
 * of those, every UID in the vault points at nothing.
 *
 * Before this release the gone-probe read that as "no such message" for every
 * starred-email note at once: 25 notes to the trash per sync, each mail
 * recreated under its new UID with its plan fields lost, and a note restored
 * by hand trashed again on the next pass.
 *
 * The rule now, in three parts:
 *   1. the fetch records the mailbox's UIDVALIDITY in each item's shadow
 *   2. the probe reads it again and resolves UNKNOWN (null) on a mismatch,
 *      which is the harmless path: the note is marked done, never trashed
 *   3. the one identifier a rebuild cannot change is the Message-ID, so the
 *      note is re-mapped onto the new UID instead of being recreated
 *
 * Every gate here was watched red against the 0.15.0 bytes before it counted.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');
const { fakeSocket, okReply } = require('./fake-imap.cjs');

const bare = () => fs.readFileSync(T.__mainPath, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

const PluginClass = require(T.__mainPath);
const { TFile, TFolder } = T.__obsidian;

const OPTS = { host: 'mail.example.org', port: 993, security: 'tls' };
const tlsDeps = (sock) => ({ tls: { connect: () => sock } });

// A mailbox that answers EXAMINE with `validity` and knows `uids`.
function mailbox(validity, uids, headers) {
  return fakeSocket({
    reply: okReply((cmd, tag) => {
      if (cmd === 'EXAMINE INBOX') return [`* OK [UIDVALIDITY ${validity}] UIDs valid`, '$TAG OK [READ-ONLY] done'];
      if (cmd === 'UID SEARCH FLAGGED') return [`* SEARCH ${uids.join(' ')}`, '$TAG OK search done'];
      const m = /^UID FETCH ([\d,]+) /.exec(cmd);
      if (m) {
        const asked = m[1].split(',').filter((u) => uids.includes(u));
        if (!asked.length) return ['$TAG OK fetch done'];   // the absence signal, RFC 3501 6.4.8
        if (!headers) return asked.map((u) => `* 1 FETCH (UID ${u})`).concat(['$TAG OK fetch done']);
        return asked.map((u) => {
          const h = headers[u];
          const bytes = Buffer.byteLength(h, 'utf8');
          return `* 1 FETCH (UID ${u} BODY[HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID)] {${bytes}}\r\n${h})\r\n`;
        }).join('') + `${tag} OK fetch done\r\n`;
      }
      return undefined;
    }),
  });
}
const header = (subject, messageId) => `Subject: ${subject}\r\nFrom: Ana <ana@example.org>\r\nDate: Tue, 01 Sep 2026 10:00:00 +0000\r\nMessage-ID: <${messageId}>\r\n\r\n`;

/* ---- 1. the signal itself ----------------------------------------------- */

test('the UIDVALIDITY code is read off the EXAMINE reply', () => {
  assert.equal(T.imapUidValidityOf('* OK [UIDVALIDITY 1234567] UIDs valid'), '1234567');
  assert.equal(T.imapUidValidityOf('* OK [uidvalidity 42]'), '42', 'the response code is case-insensitive');
  assert.equal(T.imapUidValidityOf('* OK [UIDNEXT 9]'), null, 'a different response code is not it');
  assert.equal(T.imapUidValidityOf('* 3 EXISTS'), null);
  assert.equal(T.imapUidValidityOf(null), null);
});

test('THE RULE: a mismatch is never evidence, it is the absence of evidence', () => {
  assert.equal(T.uidValidityVerdict('111', '111'), 'same', 'same mailbox: the UID means what it meant');
  assert.equal(T.uidValidityVerdict('111', '222'), 'rebuilt', 'renumbered: every stored UID is meaningless');
  assert.equal(T.uidValidityVerdict(111, '111'), 'same', 'the code is compared as text, never as a number');
  assert.equal(T.uidValidityVerdict(null, '222'), 'unknown', 'a note fetched before 0.15.1 has no baseline');
  assert.equal(T.uidValidityVerdict('111', null), 'unknown', 'a server that sent no code teaches nothing');
});

/* ---- 2. the fetch records it, and the Message-ID -------------------------- */

test('the fetch reports the mailbox UIDVALIDITY and every item carries its Message-ID', async () => {
  const sock = mailbox('111', ['9'], { 9: header('Plan the week', 'm9@example.org') });
  const report = {};
  const items = await T.imapFetchStarredRaw(OPTS, 'u', 'p', 50, tlsDeps(sock), report);
  assert.equal(report.uidValidity, '111', 'the generation the UIDs below belong to');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, '9');
  assert.equal(items[0].messageId, 'm9@example.org', 'the one id a rebuild cannot change');
});

test('emailFetchStarred puts the UIDVALIDITY on the result, the way ClickUp puts its scope there', async () => {
  const sock = mailbox('111', ['9'], { 9: header('Plan the week', 'm9@example.org') });
  const s = { imapHost: OPTS.host, imapPort: 993, imapSecurity: 'tls', imapUser: 'u', imapPassword: 'p' };
  const out = await T.emailFetchStarred(s, tlsDeps(sock));
  assert.equal(out.ok, true);
  assert.equal(out.uidValidity, '111');
});

/* ---- 3. the probe ------------------------------------------------------- */

test('THE REGRESSION: a rebuilt mailbox answers unknown, never gone', async () => {
  // The mail is really gone from a mailbox that never rebuilt: evidence.
  const same = mailbox('111', [], null);
  assert.equal(await T.imapProbeGoneRaw(OPTS, 'u', 'p', '9', tlsDeps(same), '111'), true);
  // The same empty answer from a mailbox that renumbered: NOT evidence.
  const rebuilt = mailbox('222', [], null);
  assert.equal(await T.imapProbeGoneRaw(OPTS, 'u', 'p', '9', tlsDeps(rebuilt), '111'), null,
    'the UID cannot be asked about at all, so the probe knows nothing');
  // Still there, same mailbox.
  const present = mailbox('111', ['9'], null);
  assert.equal(await T.imapProbeGoneRaw(OPTS, 'u', 'p', '9', tlsDeps(present), '111'), false);
  // A note from before 0.15.1 has no baseline: the probe behaves as it did.
  const noBaseline = mailbox('222', [], null);
  assert.equal(await T.imapProbeGoneRaw(OPTS, 'u', 'p', '9', tlsDeps(noBaseline), null), true);
});

test('emailProbeGone reads the baseline from the item shadow it is handed', async () => {
  const s = { imapHost: OPTS.host, imapPort: 993, imapSecurity: 'tls', imapUser: 'u', imapPassword: 'p' };
  const item = { id: '9' };
  const rebuilt = () => Object.assign(tlsDeps(mailbox('222', [], null)), { shadow: { uidvalidity: '111' } });
  assert.equal(await T.emailProbeGone(s, item, rebuilt()), null, 'the rebuild reaches the connector');
  const stable = Object.assign(tlsDeps(mailbox('111', [], null)), { shadow: { uidvalidity: '111' } });
  assert.equal(await T.emailProbeGone(s, item, stable), true);
  const noShadow = Object.assign(tlsDeps(mailbox('222', [], null)), {});
  assert.equal(await T.emailProbeGone(s, item, noShadow), true, 'no baseline, no change in behaviour');
});

/* ---- 4. re-mapping by Message-ID ---------------------------------------- */

test('the re-map pairs a new UID with the note that already holds that mail', () => {
  const shadows = {
    'email:9': { messageId: 'm9@example.org', uidvalidity: '111' },
    'email:10': { messageId: 'm10@example.org', uidvalidity: '111' },
    'clickup:9': { messageId: 'm9@example.org' },
  };
  const existing = new Map([['9', { id: '9' }], ['10', { id: '10' }]]);
  const items = [
    { id: '77', messageId: 'm9@example.org' },
    { id: '78', messageId: 'unknown@example.org' },
  ];
  const out = T.remapByMessageId('email', items, existing, shadows);
  assert.deepEqual(out.map((r) => [r.from, r.to]), [['9', '77']], 'only the mail the vault already has');
  // An id the fetch still returns is never re-mapped onto another note.
  assert.deepEqual(T.remapByMessageId('email', [{ id: '9', messageId: 'm9@example.org' }], existing, shadows), []);
  // One note per mail: two new UIDs cannot both claim it.
  const twice = T.remapByMessageId('email', [
    { id: '77', messageId: 'm9@example.org' }, { id: '79', messageId: 'm9@example.org' },
  ], existing, shadows);
  assert.equal(twice.length, 1, 'the second is a new note, not a second claim');
  // A source whose items carry no Message-ID is never re-mapped.
  assert.deepEqual(T.remapByMessageId('clickup', [{ id: '77' }], existing, shadows), []);
});

/* ---- 5. end to end: the rebuild, through upsertSource -------------------- */

const ROOT = '06 Planner';
const FOLDER = `${ROOT}/Email`;
const HEAD = '---\ntype: planner-item\n---\n';

function mailNote(uid) {
  const f = new TFile();
  f.path = `${FOLDER}/Plan the week (email-${uid}).md`;
  f.basename = `Plan the week (email-${uid})`;
  f.extension = 'md';
  f.stat = { mtime: 1000, ctime: 1000, size: 10 };
  f.fm = {
    type: 'planner-item', source: 'email', external_id: uid, title: 'Plan the week',
    status: 'open', due: null, priority: 4, url: null, tags: [],
    planned_day: '2026-09-17', planned_half: 'am', planned_order: 7,
    weekly_goal: true, done_local: false, linked_note: '[[chaser]]',
  };
  f.body = '';
  return f;
}

function plugin(files, shadow) {
  const sub = new TFolder(); sub.path = FOLDER; sub.children = files;
  const root = new TFolder(); root.path = ROOT; root.children = [sub];
  const byPath = new Map(files.map((f) => [f.path, f]));
  const trashed = [];
  const created = [];
  const app = {
    vault: {
      getAbstractFileByPath: (p) => (p === ROOT ? root : (byPath.get(p) || null)),
      cachedRead: async (f) => `${HEAD}${f.body || ''}`,
      process: async (f, fn) => { f.body = fn(`${HEAD}${f.body || ''}`).replace(/^---\n[\s\S]*?\n---\n?/, ''); f.stat.mtime += 1; },
      create: async (p) => { created.push(p); throw new Error('a rebuild must re-map, not recreate'); },
      trash: async (f) => { trashed.push(f.path); byPath.delete(f.path); },
    },
    metadataCache: { getFileCache: (f) => ({ frontmatter: f.fm }) },
    fileManager: {
      processFrontMatter: async (f, fn) => { fn(f.fm); f.stat.mtime += 1; },
      trashFile: async (f) => { trashed.push(`OBEYS-MEMBER-SETTING:${f.path}`); },
    },
  };
  const p = Object.create(PluginClass.prototype);
  p.settings = {
    plannerFolder: ROOT, imapHost: OPTS.host, imapUser: 'u', imapPassword: 'p',
    imapPort: 993, imapSecurity: 'tls', completeOnSource: false, pushEdits: true,
    _shadow: shadow || {},
  };
  p.secrets = null;
  p.app = app;
  p._pushTimers = new Map();
  p._syncWrites = new Map();
  p._goneProbed = new Set();
  return { p, trashed, created };
}

const fetched = (uid, messageId) => ({
  source: 'email', id: uid, title: 'Plan the week', description: 'From: Ana <ana@example.org>',
  due: null, priority: 4, url: null, tags: [], status: null, recurring: false, dueString: null,
  messageId,
});

function withNotice(fn) {
  const RealNotice = T.__obsidian.Notice;
  const notices = [];
  T.__obsidian.Notice = function (msg) { notices.push(String(msg)); };
  const hadWindow = 'window' in globalThis;
  if (!hadWindow) globalThis.window = { setTimeout: () => 0, clearTimeout: () => { } };
  return Promise.resolve(fn(notices)).finally(() => {
    T.__obsidian.Notice = RealNotice;
    if (!hadWindow) delete globalThis.window;
  });
}

test('THE DEFECT: a rebuilt mailbox re-maps the note and trashes nothing', () => {
  const note = mailNote('9');
  const { p, trashed, created } = plugin([note], {
    'email:9': { title: 'Plan the week', due: null, priority: 4, description: '', done: false, uidvalidity: '111', messageId: 'm9@example.org' },
  });
  return withNotice(async (notices) => {
    await p.upsertSource('email', { ok: true, items: [fetched('77', 'm9@example.org')], uidValidity: '222' });
    assert.deepEqual(trashed, [], 'not one note moved to the trash');
    assert.deepEqual(created, [], 'and the mail was not recreated as a second note');
    assert.equal(note.fm.external_id, '77', 'the note follows the mail onto its new UID');
    assert.equal(note.fm.planned_day, '2026-09-17', 'the plan fields survive the rebuild');
    assert.equal(note.fm.planned_order, 7);
    assert.equal(note.fm.weekly_goal, true);
    assert.equal(note.fm.linked_note, '[[chaser]]');
    assert.ok(p.settings._shadow['email:77'], 'the shadow follows the note');
    assert.equal(p.settings._shadow['email:77'].uidvalidity, '222', 'stamped with the mailbox it now belongs to');
    assert.equal(p.settings._shadow['email:9'], undefined, 'and the stale key is gone');
    // What the member is told, and how often: the wording is a pure function
    // and the sync raises it once per pass, never once per note.
    assert.equal(T.remapNotice('Email', 1), 'Planner: Email renumbered its messages, so a note was re-matched to its mail.');
    assert.equal(T.remapNotice('Email', 3), 'Planner: Email renumbered its messages, so 3 notes were re-matched to their mail.');
    assert.equal(T.remapNotice('Email', 0), null, 'a sync that re-mapped nothing says nothing');
    const b = bare();
    assert.equal((b.match(/remapNotice\(SOURCES\[source\]\.label, remapped\.length\)/g) || []).length, 1, 'one notice per sync pass');
    assert.match(b, /if \(rnote\) new Notice\(rnote, 8000\);/);
    assert.ok(notices);
  });
});

test('the ordinary sync stamps the mailbox generation and the Message-ID, and re-maps nothing', () => {
  const note = mailNote('9');
  const { p, trashed } = plugin([note], {
    'email:9': { title: 'Plan the week', due: null, priority: 4, description: '', done: false },
  });
  return withNotice(async (notices) => {
    await p.upsertSource('email', { ok: true, items: [fetched('9', 'm9@example.org')], uidValidity: '111' });
    assert.deepEqual(trashed, []);
    assert.equal(note.fm.external_id, '9', 'the same mailbox renames nothing');
    assert.equal(p.settings._shadow['email:9'].uidvalidity, '111');
    assert.equal(p.settings._shadow['email:9'].messageId, 'm9@example.org');
    assert.ok(notices);
  });
});

test('the probe is handed the shadow of the item it is asking about', () => {
  const note = mailNote('9');
  const { p } = plugin([note], { 'email:9': { done: false, uidvalidity: '111', messageId: 'm9@example.org' } });
  const c = T.CONNECTORS.email;
  const real = c.probeGone;
  const seen = [];
  c.probeGone = async (s, item, deps) => { seen.push(deps && deps.shadow); return null; };
  return withNotice(async () => {
    await p.probeGoneIds('email', [{ id: '9' }], {});
    assert.equal(seen.length, 1);
    assert.equal(seen[0] && seen[0].uidvalidity, '111', 'without it the connector cannot tell a rebuild from a deletion');
  }).finally(() => { c.probeGone = real; });
});
