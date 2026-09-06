/* One IMAP state machine, driven by scripts.
 *
 * The read (EXAMINE, SEARCH, FETCH) and the star write (SELECT, STORE) were
 * two hand-rolled copies of the same greeting / login / tagged-reply
 * handling, and the probe would have been a third. Now imapSession is the
 * only machine and every script is a step list over it. The socket is
 * injected, so the suite can drive a whole session and read exactly which
 * verbs reached the wire.
 *
 * The regression that matters most: the star write is the ONE write the
 * mailbox ever sees, and after the refactor it must still send exactly one
 * UID STORE, after SELECT, before LOGOUT.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');
const { fakeSocket, okReply } = require('./fake-imap.cjs');

const OPTS = { host: 'mail.example.org', port: 993, security: 'tls' };
const tlsDeps = (sock) => ({ tls: { connect: () => sock } });

test('the session machine exists and is the only one', () => {
  assert.equal(typeof T.imapSession, 'function', 'imapSession must be a function');
  assert.equal(typeof T.imapItemsFromFetch, 'function');
  const code = fs.readFileSync(T.__mainPath, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal((code.match(/stage === 'greeting'/g) || []).length, 1, 'exactly one greeting handler');
  assert.equal((code.match(/socket\.on\('data'/g) || []).length, 1, 'exactly one data listener');
  assert.equal((code.match(/imapSession\(opts, user, pass, /g) || []).length >= 2, true, 'the read and the star write are scripts over the session');
});

test('THE REGRESSION: the star write still sends exactly one UID STORE, after SELECT, before LOGOUT', async () => {
  const sock = fakeSocket({ reply: okReply() });
  await T.imapSetStarredRaw(OPTS, 'me@example.org', 'p"w', '42', false, tlsDeps(sock));
  assert.deepEqual(sock.commands, [
    'LOGIN "me@example.org" "p\\"w"',
    'SELECT INBOX',
    'UID STORE 42 -FLAGS (\\Flagged)',
    'LOGOUT',
  ]);
  assert.equal(sock.commands.filter((c) => /UID STORE/.test(c)).length, 1);
  assert.equal(sock.ended, true, 'the socket is ended cleanly after LOGOUT');
  // and starring again is +FLAGS
  const sock2 = fakeSocket({ reply: okReply() });
  await T.imapSetStarredRaw(OPTS, 'u', 'p', '7', true, tlsDeps(sock2));
  assert.ok(sock2.commands.includes('UID STORE 7 +FLAGS (\\Flagged)'));
});

test('the read script is read-only: EXAMINE, UID SEARCH FLAGGED, one header-only UID FETCH', async () => {
  const header = 'Subject: =?UTF-8?Q?Caf=C3=A9_plan?=\r\nFrom: Ana <ana@example.org>\r\nDate: Tue, 01 Sep 2026 10:00:00 +0000\r\nMessage-ID: <m9@example.org>\r\n\r\n';
  const literal = Buffer.byteLength(header, 'utf8');
  const sock = fakeSocket({
    reply: okReply((cmd) => {
      if (cmd === 'UID SEARCH FLAGGED') return ['* SEARCH 5 9', '$TAG OK search done'];
      if (/^UID FETCH /.test(cmd)) {
        return `* 2 FETCH (UID 9 BODY[HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID)] {${literal}}\r\n${header})\r\n$TAG OK fetch done\r\n`;
      }
      return undefined;
    }),
  });
  const items = await T.imapFetchStarredRaw({ ...OPTS, host: 'imap.gmail.com' }, 'u', 'p', 50, tlsDeps(sock));
  assert.deepEqual(sock.commands, [
    'LOGIN "u" "p"',
    'EXAMINE INBOX',
    'UID SEARCH FLAGGED',
    'UID FETCH 5,9 (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID)])',
    'LOGOUT',
  ]);
  assert.ok(!sock.commands.some((c) => /STORE|SELECT/.test(c)), 'the read never writes and never SELECTs');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, '9');
  assert.equal(items[0].title, 'Café plan');
  assert.match(items[0].description, /From: Ana <ana@example.org>/);
  assert.match(items[0].url, /rfc822msgid:m9%40example.org/);
  // maxItems takes the NEWEST uids (the tail of the search result)
  const sock2 = fakeSocket({ reply: okReply((cmd) => (cmd === 'UID SEARCH FLAGGED' ? ['* SEARCH 1 2 3 4', '$TAG OK'] : undefined)) });
  await T.imapFetchStarredRaw(OPTS, 'u', 'p', 2, tlsDeps(sock2));
  assert.ok(sock2.commands.some((c) => c.startsWith('UID FETCH 3,4 ')));
});

test('no starred mail: the read logs out after the search without a FETCH', async () => {
  const sock = fakeSocket({ reply: okReply((cmd) => (cmd === 'UID SEARCH FLAGGED' ? ['* SEARCH', '$TAG OK'] : undefined)) });
  const items = await T.imapFetchStarredRaw(OPTS, 'u', 'p', 50, tlsDeps(sock));
  assert.deepEqual(items, []);
  assert.deepEqual(sock.commands.slice(-2), ['UID SEARCH FLAGGED', 'LOGOUT']);
});

test('a tagged NO at login rejects with the stage and the server text, and the socket is torn down', async () => {
  const sock = fakeSocket({ reply: (cmd) => (/^LOGIN /.test(cmd) ? ['$TAG NO [AUTHENTICATIONFAILED] Invalid credentials'] : ['$TAG OK']) });
  await assert.rejects(T.imapSession(OPTS, 'u', 'p', [], tlsDeps(sock)), (e) => {
    assert.equal(e.message, 'auth');
    assert.equal(e.stage, 'login');
    assert.match(e.serverText, /Invalid credentials/);
    return true;
  });
  assert.equal(sock.destroyed, true);
  assert.deepEqual(sock.commands, ['LOGIN "u" "p"'], 'nothing is sent after a refused login');
});

test('a BYE greeting, a socket error and a failed connect all reject through the one path', async () => {
  const bye = fakeSocket({ greeting: '* BYE go away', reply: okReply() });
  await assert.rejects(T.imapSession(OPTS, 'u', 'p', [], tlsDeps(bye)), /server refused connection/);
  assert.deepEqual(bye.commands, [], 'a BYE greeting never gets a LOGIN');
  const broken = fakeSocket({ greeting: null, reply: okReply() });
  const p = T.imapSession(OPTS, 'u', 'p', [], tlsDeps(broken));
  setImmediate(() => broken.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })));
  await assert.rejects(p, /ECONNRESET/);
  await assert.rejects(T.imapSession(OPTS, 'u', 'p', [], { tls: { connect: () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); } } }), /ENOTFOUND/);
});

test('a session with no steps is LOGIN then LOGOUT and nothing else', async () => {
  const sock = fakeSocket({ reply: okReply() });
  const ctx = await T.imapSession(OPTS, 'u', 'p', [], tlsDeps(sock));
  assert.deepEqual(sock.commands, ['LOGIN "u" "p"', 'LOGOUT']);
  assert.deepEqual(ctx, {});
});

test('a step whose cmd returns null ends the session early; untagged lines reach only the current step', async () => {
  const seen = [];
  const sock = fakeSocket({ reply: okReply((cmd) => (cmd === 'NOOP' ? ['* 3 EXISTS', '$TAG OK'] : undefined)) });
  await T.imapSession(OPTS, 'u', 'p', [
    { stage: 'noop', cmd: () => 'NOOP', untagged: (e) => seen.push(e) },
    { stage: 'never', cmd: () => null },
    { stage: 'unreached', cmd: () => 'CAPABILITY' },
  ], tlsDeps(sock));
  assert.deepEqual(seen, ['* 3 EXISTS']);
  assert.deepEqual(sock.commands, ['LOGIN "u" "p"', 'NOOP', 'LOGOUT']);
});

test('emailFetchStarred drives the read script and classifies its failures', async () => {
  assert.equal(typeof T.imapSession, 'function', 'guard: never reach a real socket on an old main.js');
  const sock = fakeSocket({ reply: okReply((cmd) => (cmd === 'UID SEARCH FLAGGED' ? ['* SEARCH', '$TAG OK'] : undefined)) });
  const ok = await T.emailFetchStarred({ imapHost: 'mail.example.org', imapUser: 'u', imapPassword: 'p' }, tlsDeps(sock));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.items, []);
  const bad = fakeSocket({ reply: (cmd) => (/^LOGIN /.test(cmd) ? ['$TAG NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833'] : ['$TAG OK']) });
  const r = await T.emailFetchStarred({ imapHost: 'imap.gmail.com', imapUser: 'u', imapPassword: 'p' }, tlsDeps(bad));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'misconfigured');
  assert.match(r.message, /app password/);
  assert.equal(r.docUrl, 'https://myaccount.google.com/apppasswords');
});

/* ---- the probe (Test connection) ---------------------------------------- */

test('THE ASK: the probe logs in and out with a scripted server, and reads nothing', async () => {
  assert.equal(typeof T.imapProbe, 'function', 'imapProbe must be a function');
  const sock = fakeSocket({ reply: okReply() });
  const r = await T.imapProbe({ imapHost: 'mail.example.org', imapUser: 'u', imapPassword: 'p' }, tlsDeps(sock));
  assert.deepEqual(sock.commands, ['LOGIN "u" "p"', 'LOGOUT'], 'no EXAMINE, no SEARCH, no SELECT, no STORE');
  assert.deepEqual(r, { ok: true, reason: null, message: 'Connected as u.', hint: null, docUrl: null });
  assert.equal(sock.ended, true);
});

test('the probe answers missing fields and an Outlook host before any socket is opened', async () => {
  assert.equal(typeof T.imapProbe, 'function');
  let opened = 0;
  const deps = { tls: { connect: () => { opened += 1; throw new Error('socket opened'); } } };
  const empty = await T.imapProbe({ imapHost: 'imap.gmail.com', imapUser: '', imapPassword: 'p' }, deps);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'no-token');
  const o = await T.imapProbe({ imapHost: 'outlook.office365.com', imapUser: 'u', imapPassword: 'p' }, deps);
  assert.equal(o.ok, false);
  assert.equal(o.reason, 'auth-oauth-required');
  assert.match(o.hint, /OAuth/);
  assert.equal(opened, 0);
  // preflight is one pure function shared by the probe and the sync
  assert.equal(T.imapPreflight({ host: '', port: 993 }, 'u', 'p').reason, 'no-token');
  assert.equal(T.imapPreflight({ host: 'outlook.office365.com', port: 993 }, 'u', 'p').reason, 'auth-oauth-required');
  assert.equal(T.imapPreflight({ host: 'mail.example.org', port: 993 }, 'u', 'p'), null);
  assert.equal(T.imapReasonToConnector('no-token'), 'no-token');
});

test('the probe and the sync classify the same failure with the same words', async () => {
  assert.equal(typeof T.imapProbe, 'function');
  const alert = (cmd) => (/^LOGIN /.test(cmd) ? ['$TAG NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833'] : ['$TAG OK']);
  const s = { imapHost: 'imap.gmail.com', imapUser: 'u', imapPassword: 'p' };
  const p = await T.imapProbe(s, tlsDeps(fakeSocket({ reply: alert })));
  const f = await T.emailFetchStarred(s, tlsDeps(fakeSocket({ reply: alert })));
  assert.equal(p.ok, false);
  assert.equal(p.reason, 'auth-app-password');
  assert.equal(p.message, f.message);
  assert.equal(p.hint, f.hint);
  assert.equal(p.docUrl, 'https://myaccount.google.com/apppasswords');
  // a refused connection names the port it tried
  const refused = await T.imapProbe({ ...s, imapHost: 'mail.example.org' }, { tls: { connect: () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); } } });
  assert.equal(refused.reason, 'refused');
  assert.match(refused.hint, /port 993/);
});

test('the settings tab wires the probe and the presets accessibly', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.match(code, /renderProbe\(await imapProbe\(this\.plugin\.withSecrets\(\)\)\)/, 'the Test button runs the probe on the resolved settings');
  assert.match(code, /probeSetting\.descEl\.setAttribute\('aria-live', 'polite'\)/, 'the outcome is announced');
  assert.match(code, /role: 'radiogroup'/, 'the presets are a radio group');
  assert.match(code, /role: 'radio'/, 'each preset chip is a radio');
  assert.match(code, /'aria-checked': on \? 'true' : 'false'/, 'the pressed preset is stated');
  assert.match(code, /e\.key !== 'ArrowRight' && e\.key !== 'ArrowLeft'/, 'arrow keys move between chips');
  assert.match(code, /imapPresetFields\(preset\)/, 'a chip applies the preset through the pure mapper');
  assert.equal((code.match(/= imapPreflight\(opts, user, pass\)/g) || []).length, 2, 'the probe and the sync share one preflight');
  const css = fs.readFileSync(require('node:path').join(require('node:path').dirname(T.__mainPath), 'styles.css'), 'utf8');
  assert.match(css, /\.iplan-settings-presets button\.iplan-seg-btn/, 'the chips ride the segmented-control rules');
  assert.match(css, /\.setting-item-description\.is-ok \{ color: var\(--iplan-success\); \}/, 'the ok colour is a token');
  assert.match(css, /\.setting-item-description\.is-failed \{ color: var\(--iplan-overdue\); \}/, 'the failed colour is a token');
});
