/* A scripted IMAP socket for the session tests.
 *
 * Not a test file (no .test suffix): the harness helper the IMAP gates share.
 * `reply(cmd, tag)` answers each command the client writes; it returns an
 * array of lines (CRLF appended, `$TAG` replaced with the client's tag) or
 * one raw string emitted byte for byte (for FETCH literals). `greeting`
 * null means the server says nothing first (a socket that was already
 * upgraded by STARTTLS). Everything written is kept on `commands` without
 * the tag, so a test can assert exactly which verbs reached the wire.
 */
'use strict';
const { EventEmitter } = require('node:events');

function fakeSocket({ greeting = '* OK ready', reply }) {
  const s = new EventEmitter();
  s.written = [];
  s.commands = [];
  s.ended = false;
  s.destroyed = false;
  const emit = (text) => setImmediate(() => { if (!s.destroyed) s.emit('data', text); });
  s.write = (raw) => {
    const line = String(raw).replace(/\r\n$/, '');
    s.written.push(line);
    const m = /^(A\d+) (.*)$/.exec(line);
    const tag = m ? m[1] : null;
    const cmd = m ? m[2] : line;
    s.commands.push(cmd);
    const out = reply(cmd, tag);
    if (out == null) return true;
    if (typeof out === 'string') emit(out.replace(/\$TAG/g, tag));
    else emit(out.map((l) => l.replace(/\$TAG/g, tag) + '\r\n').join(''));
    return true;
  };
  s.end = () => { s.ended = true; };
  s.destroy = () => { s.destroyed = true; };
  if (greeting != null) emit(greeting + '\r\n');
  return s;
}

// A well-behaved server: OK to everything, with the verbs the scripts use.
function okReply(extra) {
  return (cmd, tag) => {
    if (extra) { const r = extra(cmd, tag); if (r !== undefined) return r; }
    if (cmd === 'LOGOUT') return ['* BYE', '$TAG OK bye'];
    return ['$TAG OK done'];
  };
}

module.exports = { fakeSocket, okReply };
