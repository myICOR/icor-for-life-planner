/* IMAP failures must say what happened and what to do.
 *
 * The reported case: a Gmail account with the normal account password read
 * "IMAP login failed" for a day, when Gmail's own reply on the wire had said
 * "Application-specific password required" with a link. Four failures
 * (bad credentials, app password wanted, certificate, network) collapsed
 * into two messages and the server's text was thrown away.
 *
 * Gated here: the tagged reply and the stage ride the Error; a pure
 * classifier names the failure; the provider table adds the hint; an
 * Outlook host is answered before any socket is opened.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const GMAIL_ALERT = 'A2 NO [ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)';

test('THE BUG: Gmail\'s "application-specific password required" is named, with the link', () => {
  assert.equal(typeof T.classifyImapError, 'function', 'the classifier must be a pure function');
  const c = T.classifyImapError({ message: 'auth', stage: 'login', serverText: GMAIL_ALERT }, 'imap.gmail.com');
  assert.equal(c.reason, 'auth-app-password');
  assert.equal(c.docUrl, 'https://myaccount.google.com/apppasswords');
  assert.match(c.message, /app password/i);
  assert.equal(c.hint, 'Gmail needs an app password, not your account password. Turn on 2-step verification, then create one at myaccount.google.com/apppasswords.');
});

test('a plain Gmail login failure still carries the Gmail hint (2-step verification off, wrong password)', () => {
  const c = T.classifyImapError({ message: 'auth', stage: 'login', serverText: 'A2 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)' }, 'imap.gmail.com');
  assert.equal(c.reason, 'auth');
  assert.match(c.hint, /app password/);
  assert.equal(c.docUrl, 'https://myaccount.google.com/apppasswords');
  // and the iCloud equivalent
  const i = T.classifyImapError({ message: 'auth', stage: 'login', serverText: 'A2 NO [AUTHENTICATIONFAILED] Authentication failed' }, 'imap.mail.me.com');
  assert.equal(i.reason, 'auth');
  assert.match(i.hint, /app-specific password/);
  assert.match(i.hint, /account\.apple\.com/);
  // a generic host gets the generic message and no invented hint
  const g = T.classifyImapError({ message: 'auth', stage: 'login', serverText: 'A2 NO LOGIN failed' }, 'mail.example.org');
  assert.equal(g.reason, 'auth');
  assert.equal(g.message, 'IMAP login failed. Check the address and the app password.');
  assert.equal(g.hint, null);
  // an app-password reply on a generic host: the link the server sent is used
  const ga = T.classifyImapError({ message: 'auth', stage: 'login', serverText: 'A2 NO app password required: https://example.org/app-passwords' }, 'mail.example.org');
  assert.equal(ga.reason, 'auth-app-password');
  assert.equal(ga.docUrl, 'https://example.org/app-passwords');
});

test('a certificate failure is a TLS failure, not "host unreachable"', () => {
  for (const code of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED']) {
    const c = T.classifyImapError({ code, message: 'some openssl text' }, 'mail.example.org');
    assert.equal(c.reason, 'tls', code);
    assert.match(c.message, /certificate/i);
    assert.ok(c.hint, 'a TLS failure must say what to check');
  }
  assert.equal(T.imapReasonToConnector('tls'), 'unreachable');
});

test('DNS, refused, timeout and protocol are told apart', () => {
  assert.equal(T.classifyImapError({ code: 'ENOTFOUND' }, 'x').reason, 'dns');
  assert.equal(T.classifyImapError({ code: 'EAI_AGAIN' }, 'x').reason, 'dns');
  assert.equal(T.classifyImapError({ code: 'ECONNREFUSED' }, 'x').reason, 'refused');
  assert.equal(T.classifyImapError({ message: 'server refused connection' }, 'x').reason, 'refused');
  assert.equal(T.classifyImapError({ message: 'timeout' }, 'x').reason, 'timeout');
  assert.equal(T.classifyImapError({ code: 'ETIMEDOUT' }, 'x').reason, 'timeout');
  const p = T.classifyImapError({ message: 'imap examine failed', stage: 'examine', serverText: 'A3 NO EXAMINE failed' }, 'x');
  assert.equal(p.reason, 'protocol');
  assert.match(p.message, /EXAMINE failed/, 'the server text is kept');
  assert.equal(T.classifyImapError({ message: 'tls unavailable' }, 'imap.gmail.com').reason, 'unsupported');
  assert.equal(T.classifyImapError(null, 'x').reason, 'protocol', 'a missing error never throws');
  for (const [reason, expected] of [['auth', 'misconfigured'], ['auth-app-password', 'misconfigured'], ['auth-oauth-required', 'misconfigured'], ['dns', 'unreachable'], ['refused', 'unreachable'], ['timeout', 'unreachable'], ['protocol', 'unreachable'], ['unsupported', 'unsupported']]) {
    assert.equal(T.imapReasonToConnector(reason), expected, reason);
  }
});

test('the provider is read off the host', () => {
  const id = (h) => T.imapProviderOf(h).id;
  assert.equal(id('imap.gmail.com'), 'gmail');
  assert.equal(id('imap.googlemail.com'), 'gmail');
  assert.equal(id('imap.mail.me.com'), 'icloud');
  assert.equal(id('outlook.office365.com'), 'outlook');
  assert.equal(id('imap-mail.outlook.com'), 'outlook');
  assert.equal(id('imap.fastmail.com'), 'fastmail');
  assert.equal(id('imap.gmx.net'), 'gmx');
  assert.equal(id('imap.web.de'), 'webde');
  assert.equal(id('imap.mail.yahoo.com'), 'yahoo');
  assert.equal(id('mail.example.org'), 'generic');
  assert.equal(id(''), 'generic');
  assert.equal(id(null), 'generic');
  assert.equal(T.imapProviderOf('imap.gmail.com').appPasswordUrl, 'https://myaccount.google.com/apppasswords');
  assert.equal(T.imapProviderOf('mail.example.org').hint, null);
  for (const p of T.IMAP_PROVIDERS) assert.ok(p.hint, `${p.id} must carry a hint`);
});

test('an outlook host says OAuth is needed before any socket is opened', async () => {
  let opened = 0;
  const deps = { connect: () => { opened += 1; throw new Error('socket opened'); } };
  const r = await T.emailFetchStarred({ imapHost: 'outlook.office365.com', imapUser: 'a@b.c', imapPassword: 'x' }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'misconfigured');
  assert.match(r.hint, /OAuth/i);
  assert.equal(opened, 0, 'no socket may be opened for a host that can never accept a password');
  // A generic host DOES open one, and a failure there is classified.
  const g = await T.emailFetchStarred({ imapHost: 'mail.example.org', imapUser: 'a@b.c', imapPassword: 'x' }, deps);
  assert.equal(opened, 1);
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'unreachable');
  // A DNS failure thrown by the transport reads as DNS.
  const d = await T.emailFetchStarred({ imapHost: 'nope.example.org', imapUser: 'a@b.c', imapPassword: 'x' },
    { connect: () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); } });
  assert.equal(d.reason, 'unreachable');
  assert.equal(d.message, 'IMAP host not found.');
  assert.equal(d.hint, 'Check the host name for typos.');
  // The no-token guard still comes first (the connector / sourceConfigured agreement).
  const n = await T.emailFetchStarred({ imapHost: 'outlook.office365.com' }, deps);
  assert.equal(n.reason, 'no-token');
});

test('the tagged reply and the stage ride the Error', () => {
  const e = T.imapReplyError('login', GMAIL_ALERT);
  assert.equal(e.message, 'auth');
  assert.equal(e.stage, 'login');
  assert.equal(e.serverText, GMAIL_ALERT);
  const e2 = T.imapReplyError('search', 'A3 BAD');
  assert.equal(e2.message, 'imap search failed');
  assert.equal(e2.stage, 'search');
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  // Both sessions (the read and the star write) must build failures through it.
  assert.equal((code.match(/fail\(imapReplyError\(stage, /g) || []).length, 2, 'both IMAP sessions must keep the server text');
  assert.doesNotMatch(code, /new Error\(authFail \? 'auth'/, 'the old text-dropping error is back');
  // and both sessions open their socket through the one injectable connector
  assert.equal((code.match(/socket = imapConnect\(host, deps\)/g) || []).length, 2, 'the read session and the star write both use the shared connector');
  assert.equal((code.match(/tls\.connect\(/g) || []).length, 1, 'exactly one raw tls.connect call site');
});

test('the hint reaches the tray note and the board notice', () => {
  const st = { ok: false, reason: 'misconfigured', message: 'IMAP login failed: Gmail wants an app password, not your account password.', hint: 'Gmail needs an app password.', docUrl: 'https://myaccount.google.com/apppasswords' };
  const state = T.trayEmptyState('email', true, st, 0);
  assert.equal(state.kind, 'error');
  assert.equal(state.text, st.message);
  assert.equal(state.hint, st.hint);
  assert.equal(state.docUrl, st.docUrl);
  const plain = T.trayEmptyState('email', true, { ok: false, reason: 'unreachable', message: 'x' }, 0);
  assert.equal(plain.hint, null);
  const d = T.degraded('email', 'misconfigured', 'm', 'h', 'u');
  assert.equal(d.hint, 'h');
  assert.equal(d.docUrl, 'u');
  assert.equal('hint' in T.degraded('email', 'unreachable', 'm'), false);
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  assert.match(main, /iplan-tray-note-hint/, 'the tray renders the hint line');
  assert.match(main, /notices\.push\(`\$\{SOURCES\[key\]\.label\}: \$\{st\.message\}\$\{st\.hint/, 'the board notice appends the hint');
  assert.match(main, /renderHostHint\(v\)/, 'the settings hint re-renders on host change');
  assert.match(main, /this\.syncStatus\.email\.reason === 'misconfigured'/, 'a manual sync shows the email failure as a Notice');
});
