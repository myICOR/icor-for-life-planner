/* The IMAP write takes exactly one argument from the vault, the note's
 * external_id, and puts it on a command line. Anything that is not a plain
 * UID is refused before a socket opens: the wire format is line based, so
 * an id carrying a range or a CRLF would otherwise become further commands
 * with the user's own credentials behind them. The socket here records
 * every byte and answers OK to whatever tag opens the write, so the good
 * shape is asserted on the wire and the bad shapes on the absence of one.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const T = require('./harness.cjs');

function rawSocket() {
  const s = new EventEmitter();
  s.bytes = '';
  const emit = (t) => setImmediate(() => s.emit('data', t));
  s.write = (raw) => {
    s.bytes += raw;
    const tag = /^(A\d+) /.exec(raw)[1];
    emit(raw.startsWith(`${tag} LOGOUT`) ? `* BYE\r\n${tag} OK bye\r\n` : `${tag} OK done\r\n`);
    return true;
  };
  s.end = () => {}; s.destroy = () => {};
  emit('* OK ready\r\n');
  return s;
}
const OPTS = { host: 'mail.example.org', port: 993, security: 'tls' };

test('THE GATE: the star write refuses any uid that is not plain digits, before a socket opens', async () => {
  let opened = 0;
  const deps = { tls: { connect: () => { opened += 1; return rawSocket(); } } };
  for (const bad of ['1:*', '1,2', '', ' 42', '42 ', '4\r\n2', '1 +FLAGS.SILENT (\\Deleted)\r\nA9 EXPUNGE', 'manual-abc', null, undefined]) {
    await assert.rejects(T.imapSetStarredRaw(OPTS, 'u', 'p', bad, true, deps), /uid/i, `accepted ${JSON.stringify(bad)}`);
  }
  assert.equal(opened, 0, 'no socket is opened for a refused uid');
  // and the good shape still works, byte for byte
  const ok = rawSocket();
  await T.imapSetStarredRaw(OPTS, 'u', 'p', '42', true, { tls: { connect: () => ok } });
  assert.ok(ok.bytes.includes('UID STORE 42 +FLAGS (\\Flagged)\r\n'));
});

test('a LOGIN argument never carries CR or LF', () => {
  for (const s of ['a\r\nb', 'a\rb', 'a\nb']) assert.doesNotMatch(T.imapQuote(s), /[\r\n]/, JSON.stringify(s));
  assert.equal(T.imapQuote('p"w\\'), '"p\\"w\\\\"', 'quote and backslash escaping unchanged');
});
