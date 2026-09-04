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
