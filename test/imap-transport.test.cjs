/* The mailbox transport: what the socket is asked to do, stated as data.
 *
 * imapTransportOptions reads the settings once; imapTlsOptions turns them
 * into the object tls.connect receives. Both are pure, so the suite can
 * pin the defaults an existing install relies on (port 993, implicit TLS,
 * certificate verification on) and, further down, the shapes the
 * Proton Bridge preset produces.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

test('defaults are unchanged: port 993, implicit TLS, host trimmed', () => {
  assert.equal(typeof T.imapTransportOptions, 'function', 'imapTransportOptions must be a pure function');
  const o = T.imapTransportOptions({ imapHost: ' imap.gmail.com ' });
  assert.equal(o.host, 'imap.gmail.com');
  assert.equal(o.port, 993);
  assert.equal(o.security, 'tls');
  const t = T.imapTlsOptions(o);
  assert.equal(t.host, 'imap.gmail.com');
  assert.equal(t.port, 993);
  assert.equal(t.servername, 'imap.gmail.com');
  assert.deepEqual(T.imapTransportOptions(undefined).host, '', 'missing settings never throw');
});

test('the presets fill a known provider and the active chip is read off the settings', () => {
  assert.ok(Array.isArray(T.IMAP_PRESETS) && T.IMAP_PRESETS.length >= 3);
  for (const p of T.IMAP_PRESETS) {
    assert.ok(p.id && p.label && p.host, `${p.id} must carry id, label, host`);
    assert.ok(Number.isInteger(p.port) && p.port > 0 && p.port < 65536, `${p.id} port`);
    assert.ok(['tls', 'starttls'].includes(p.security), `${p.id} security`);
    assert.equal(typeof p.allowSelfSigned, 'boolean', `${p.id} allowSelfSigned`);
  }
  const gmail = T.IMAP_PRESETS.find((p) => p.id === 'gmail');
  assert.equal(T.imapPresetFields(gmail).imapHost, 'imap.gmail.com');
  assert.equal(T.imapActivePreset({ imapHost: 'imap.gmail.com' }), 'gmail');
  assert.equal(T.imapActivePreset({ imapHost: 'imap.mail.me.com' }), 'icloud');
  assert.equal(T.imapActivePreset({ imapHost: 'mail.example.org' }), null);
});

/* ---- Proton Bridge: custom port, STARTTLS, self-signed on loopback only -- */
const { fakeSocket, okReply } = require('./fake-imap.cjs');
const fs = require('node:fs');

const BRIDGE = { imapHost: '127.0.0.1', imapPort: 1143, imapSecurity: 'starttls', imapAllowSelfSigned: true, imapUser: 'me@proton.me', imapPassword: 'bridgepw' };

test('THE ASK: the Proton Bridge preset yields net.connect on 1143, STARTTLS, a TLS upgrade, and LOGIN only after it', async () => {
  assert.equal(typeof T.isLoopbackHost, 'function', 'isLoopbackHost must be a pure function');
  const preset = T.IMAP_PRESETS.find((p) => p.id === 'proton-bridge');
  assert.ok(preset, 'a Proton Bridge preset must exist');
  assert.deepEqual(T.imapPresetFields(preset), { imapHost: '127.0.0.1', imapPort: 1143, imapSecurity: 'starttls', imapAllowSelfSigned: true });
  const settings = { ...T.imapPresetFields(preset), imapUser: 'me@proton.me', imapPassword: 'bridgepw' };
  assert.equal(T.imapActivePreset(settings), 'proton-bridge');
  const calls = [];
  const plain = fakeSocket({ greeting: '* OK Proton Mail Bridge ready', reply: (cmd) => (cmd === 'STARTTLS' ? ['$TAG OK Begin TLS negotiation now'] : ['$TAG BAD']) });
  const upgraded = fakeSocket({ greeting: null, reply: okReply() });
  const deps = {
    net: { connect: (o) => { calls.push(['net', o]); return plain; } },
    tls: { connect: (o) => { calls.push(['tls', o]); return upgraded; } },
  };
  const r = await T.imapProbe(settings, deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(calls.map((c) => c[0]), ['net', 'tls'], 'plain first, then the upgrade');
  assert.deepEqual(calls[0][1], { host: '127.0.0.1', port: 1143 });
  assert.equal(calls[1][1].socket, plain, 'TLS wraps the plain socket');
  assert.equal(calls[1][1].rejectUnauthorized, false, 'the Bridge certificate is accepted (loopback)');
  assert.equal('servername' in calls[1][1], false, 'an IP literal sends no SNI servername');
  assert.deepEqual(plain.commands, ['STARTTLS'], 'the plain socket sees STARTTLS and nothing else');
  assert.deepEqual(upgraded.commands, ['LOGIN "me@proton.me" "bridgepw"', 'LOGOUT'], 'the login rides the upgraded socket only');
});

test('self-signed is only ever accepted on loopback, at the options level and at the TLS level', () => {
  assert.equal(typeof T.isLoopbackHost, 'function');
  for (const h of ['127.0.0.1', '127.0.0.5', '127.255.255.254', 'localhost', 'LOCALHOST', '::1', '[::1]', ' 127.0.0.1 ']) assert.equal(T.isLoopbackHost(h), true, h);
  for (const h of ['imap.example.com', '127.0.0.1.example.com', '127.0.0.256', '128.0.0.1', '10.0.0.1', '', null, 'localhost.example.com']) assert.equal(T.isLoopbackHost(h), false, String(h));
  // a hand-edited data.json cannot widen the allowance to a remote host
  assert.equal(T.imapTransportOptions({ imapHost: 'imap.example.com', imapAllowSelfSigned: true }).allowSelfSigned, false);
  assert.equal(T.imapTransportOptions({ imapHost: '127.0.0.1', imapAllowSelfSigned: true }).allowSelfSigned, true);
  // and even a forged options object is verified again when the TLS object is built
  assert.equal(T.imapTlsOptions({ host: 'imap.example.com', port: 993, allowSelfSigned: true }).rejectUnauthorized, true);
  assert.equal(T.imapTlsOptions({ host: '127.0.0.1', port: 1143, allowSelfSigned: true }).rejectUnauthorized, false);
  assert.equal(T.imapTlsOptions({ host: '127.0.0.1', port: 1143, allowSelfSigned: false }).rejectUnauthorized, true, 'loopback without the toggle is still verified');
  assert.equal(T.imapTlsOptions({ host: 'imap.gmail.com', port: 993 }).rejectUnauthorized, true, 'the default verifies');
});

test('an IP literal sends no SNI servername; a host name does', () => {
  assert.equal(typeof T.isIpLiteral, 'function');
  for (const h of ['127.0.0.1', '10.1.2.3', '::1', '[::1]', 'fe80::1']) assert.equal(T.isIpLiteral(h), true, h);
  for (const h of ['imap.gmail.com', 'localhost', 'mail']) assert.equal(T.isIpLiteral(h), false, h);
  assert.equal('servername' in T.imapTlsOptions({ host: '127.0.0.1', port: 1143 }), false);
  assert.equal(T.imapTlsOptions({ host: 'imap.gmail.com', port: 993 }).servername, 'imap.gmail.com');
  const up = T.imapTlsOptions({ host: 'localhost', port: 1143, allowSelfSigned: true }, { fake: true });
  assert.deepEqual(up, { rejectUnauthorized: false, socket: { fake: true }, servername: 'localhost' }, 'an upgrade carries the socket, not host and port');
});

test('a server without STARTTLS never receives LOGIN in the clear', async () => {
  assert.equal(typeof T.imapStarttlsError, 'function');
  let tlsCalls = 0;
  const plain = fakeSocket({ greeting: '* OK plain server', reply: (cmd) => (cmd === 'STARTTLS' ? ['$TAG BAD Unknown command'] : ['$TAG OK']) });
  const deps = { net: { connect: () => plain }, tls: { connect: () => { tlsCalls += 1; throw new Error('must not upgrade'); } } };
  const r = await T.imapProbe(BRIDGE, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'protocol');
  assert.match(r.message, /STARTTLS/);
  assert.match(r.hint, /login was not sent/i);
  assert.equal(tlsCalls, 0);
  assert.deepEqual(plain.commands, ['STARTTLS'], 'no LOGIN reached the plain socket');
  assert.equal(plain.destroyed, true);
  // a PREAUTH greeting on the plain port is refused the same way: nothing is
  // ever spoken in the clear past the greeting
  const pre = fakeSocket({ greeting: '* PREAUTH already in', reply: okReply() });
  const r2 = await T.imapProbe(BRIDGE, { net: { connect: () => pre }, tls: { connect: () => { throw new Error('must not upgrade'); } } });
  assert.equal(r2.reason, 'protocol');
  assert.deepEqual(pre.commands, []);
  // and a BYE greeting is a refusal, with the Bridge hint
  const bye = fakeSocket({ greeting: '* BYE', reply: okReply() });
  const r3 = await T.imapProbe(BRIDGE, { net: { connect: () => bye }, tls: { connect: () => { throw new Error('must not upgrade'); } } });
  assert.equal(r3.reason, 'refused');
  assert.match(r3.hint, /Bridge must be running/);
});

test('the transport options clamp the port and the security to what the connector understands', () => {
  assert.equal(typeof T.imapTransportOptions, 'function');
  assert.equal(T.imapTransportOptions({ imapHost: 'h', imapPort: '1143' }).port, 1143);
  assert.equal(T.imapTransportOptions({ imapHost: 'h', imapPort: 'abc' }).port, 993);
  assert.equal(T.imapTransportOptions({ imapHost: 'h', imapPort: 70000 }).port, 993);
  assert.equal(T.imapTransportOptions({ imapHost: 'h', imapPort: 0 }).port, 993);
  assert.equal(T.imapTransportOptions({ imapHost: 'h', imapSecurity: 'weird' }).security, 'tls');
  assert.equal(T.imapTransportOptions({ imapHost: 'h', imapSecurity: 'starttls' }).security, 'starttls');
  assert.equal(T.DEFAULT_SETTINGS.imapPort, 993);
  assert.equal(T.DEFAULT_SETTINGS.imapSecurity, 'tls');
  assert.equal(T.DEFAULT_SETTINGS.imapAllowSelfSigned, false);
});

test('a loopback host is the Proton Bridge provider, with the hint that makes no plan claim', () => {
  const p = T.imapProviderOf('127.0.0.1');
  assert.equal(p.id, 'proton-bridge');
  assert.equal(p.hint, 'Use the mailbox password shown inside the Bridge app, not your Proton password. Bridge must be running.');
  assert.ok(!/paid|plan/i.test(p.hint), 'the plan requirement is unverified and must not be claimed');
  assert.equal(T.imapProviderOf('localhost').id, 'proton-bridge');
  assert.equal(T.imapProviderOf('127.0.0.1.example.com').id, 'generic');
  // a certificate failure on loopback points at the toggle; remote does not
  const loop = T.classifyImapError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, '127.0.0.1');
  assert.equal(loop.reason, 'tls');
  assert.match(loop.hint, /Accept a self-signed certificate/);
  assert.doesNotMatch(T.classifyImapError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'imap.example.com').hint, /Accept a self-signed/);
  // a refused connection names the configured port
  assert.match(T.classifyImapError({ code: 'ECONNREFUSED' }, 'mail.example.org', { port: 1143 }).hint, /port 1143/);
});

test('exactly one raw TLS connect site and one raw plain connect site; the settings tab gates the toggle on loopback', () => {
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal((code.match(/tlsMod\.connect\(/g) || []).length, 1, 'one TLS call site (direct and upgrade share it)');
  assert.equal((code.match(/netMod\.connect\(/g) || []).length, 1, 'one plain call site');
  assert.doesNotMatch(code, /require\('tls'\)\.connect|require\('net'\)\.connect/, 'no bypass of the injected modules');
  assert.match(code, /if \(!entry\.startsWith\('A0 OK'\)\) return abort\(imapStarttlsError\(entry\)\);/, 'only A0 OK upgrades');
  assert.match(code, /selfSignedToggle\.setDisabled\(!loop\)/, 'the toggle is disabled off-loopback');
  assert.match(code, /imapSecurity = v === 'starttls' \? 'starttls' : 'tls'/, 'the dropdown writes only the two modes');
  for (const s of ['Use the mailbox password shown inside the Bridge app', 'The login was not sent', 'A remote host is always verified']) {
    assert.ok(main.includes(s), `copy missing: ${s}`);
  }
  assert.ok(!/[–—]/.test(main), 'no em dash or en dash in the source');
});
