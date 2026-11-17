/* An iCal address with a user name and password in it.
 *
 * Some calendar servers (a CalDAV server such as SOGo, a self-hosted one)
 * serve their .ics only behind HTTP auth, and the way to give such a feed
 * to the Planner is the credentials in the address itself:
 * https://user:secret@calendar.example.com/.../calendar.ics. Desktop
 * answers the server's challenge with the credentials in the address,
 * whatever the scheme; mobile does not, so the same feed answered HTTP 401
 * on a phone.
 *
 * Gated here: on mobile, credentials in the address leave the address and
 * travel as one `Authorization: Basic` header (percent-decoded, UTF-8
 * before base64, so a non-Latin-1 password does not throw); on desktop a
 * credentialed address is sent untouched with no header, so Digest and
 * NTLM feeds keep working there; an address without credentials is
 * requested byte for byte as before on both; a 401 for an address with
 * credentials says the feed rejected the sign-in, any other 401 and every
 * 403 that it refused access; and no result a fetch returns ever carries
 * the userinfo or the header.
 *
 * Every test here was run red against main (0.16.3) before it counted.
 * Three of them are regression guards (an address without credentials is
 * unchanged, desktop sends a credentialed address unchanged, nothing
 * leaks): on main they fail only because main's fetch ignores the test
 * wire; the behaviour they hold is main's own.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

const ICS = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:one@example.com', 'SUMMARY:Standup',
  'DTSTART;VALUE=DATE:20261117', 'DTEND;VALUE=DATE:20261118', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n') + '\r\n';

// A scripted requestUrl: answers every call with `answer`, keeps each request.
function wire(answer) {
  const calls = [];
  const requestUrl = async (req) => {
    calls.push(req);
    if (answer instanceof Error) throw answer;
    return answer || { status: 200, text: ICS };
  };
  return { calls, requestUrl };
}
const feed = (url) => ({ id: 'cal-1', name: 'Work', url, color: 1, enabled: true, kind: 'ics' });
const basic = (s) => `Basic ${Buffer.from(s, 'utf8').toString('base64')}`;

// Run `fn` with main.js seeing a phone (or not). The harness stub is the
// object main.js destructured, so flipping its fields is what main.js reads.
async function on(mobile, fn) {
  const P = T.__obsidian.Platform;
  const was = { isMobile: P.isMobile, isDesktop: P.isDesktop, isDesktopApp: P.isDesktopApp, isMobileApp: P.isMobileApp };
  Object.assign(P, { isMobile: mobile, isDesktop: !mobile, isDesktopApp: !mobile, isMobileApp: mobile });
  try { return await fn(); } finally { Object.assign(P, was); }
}
const onMobile = (fn) => on(true, fn);
const onDesktop = (fn) => on(false, fn);

test('mobile: credentials in the address travel as a Basic header, never in the URL', () => onMobile(async () => {
  const w = wire();
  const r = await T.calendarFetchFeed(feed('https://user:secret@calendar.example.com/dav/user/Calendar/work.ics'), w);
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1, 'the feed is read');
  assert.equal(w.calls.length, 1);
  const req = w.calls[0];
  assert.equal(req.url, 'https://calendar.example.com/dav/user/Calendar/work.ics', 'the userinfo is gone from the URL');
  assert.equal(req.headers.Authorization, basic('user:secret'));
  assert.equal(req.headers.Accept, 'text/calendar', 'the Accept header stays');
  assert.equal(req.method, 'GET');
  assert.equal(req.throw, false);
}));

test('mobile: webcal:// with credentials is rewritten to https and stripped the same way', () => onMobile(async () => {
  const w = wire();
  await T.calendarFetchFeed(feed('webcal://user:secret@calendar.example.com/work.ics?export=1'), w);
  assert.equal(w.calls[0].url, 'https://calendar.example.com/work.ics?export=1');
  assert.equal(w.calls[0].headers.Authorization, basic('user:secret'));
}));

test('mobile: percent-encoded and non-Latin-1 credentials are decoded, then UTF-8 encoded', () => onMobile(async () => {
  const w = wire();
  // user "jürgen@example.com", password "p@ss:wörd ✓", as a browser would encode them
  await T.calendarFetchFeed(feed('https://j%C3%BCrgen%40example.com:p%40ss%3Aw%C3%B6rd%20%E2%9C%93@calendar.example.com/a.ics'), w);
  assert.equal(w.calls[0].url, 'https://calendar.example.com/a.ics');
  assert.equal(w.calls[0].headers.Authorization, basic('jürgen@example.com:p@ss:wörd ✓'));
}));

test('mobile: a user name without a password still signs in, with an empty password', () => onMobile(async () => {
  const w = wire();
  await T.calendarFetchFeed(feed('https://token-only@calendar.example.com/a.ics'), w);
  assert.equal(w.calls[0].url, 'https://calendar.example.com/a.ics');
  assert.equal(w.calls[0].headers.Authorization, basic('token-only:'));
}));

test('guard: an address without credentials is requested exactly as before, on both platforms', async () => {
  for (const mobile of [true, false]) {
    await on(mobile, async () => {
      for (const [given, sent] of [
        ['https://calendar.example.com/calendar/ical/x%40example.com/private-0123/basic.ics', 'https://calendar.example.com/calendar/ical/x%40example.com/private-0123/basic.ics'],
        ['webcal://p42-caldav.example.com/published/2/MTIz', 'https://p42-caldav.example.com/published/2/MTIz'],
        // shapes a URL parser would normalise (host case, an empty port, %7e): untouched
        ['https://Calendar.Example.com:/a%7eb.ics', 'https://Calendar.Example.com:/a%7eb.ics'],
      ]) {
        const w = wire();
        await T.calendarFetchFeed(feed(given), w);
        assert.equal(w.calls[0].url, sent, `${given} (mobile: ${mobile})`);
        assert.deepEqual(w.calls[0].headers, { Accept: 'text/calendar' }, 'no Authorization header is added');
      }
    });
  }
});

test('guard: desktop sends a credentialed address unchanged, with no Authorization header', () => onDesktop(async () => {
  // Desktop answers the server's challenge itself (Basic, Digest, NTLM);
  // a Basic header in its place would break the other schemes there.
  for (const url of [
    'https://user:secret@calendar.example.com/dav/user/Calendar/work.ics',
    'https://j%C3%BCrgen:p%40ss@calendar.example.com/a.ics',
  ]) {
    const w = wire();
    await T.calendarFetchFeed(feed(url), w);
    assert.equal(w.calls[0].url, url);
    assert.deepEqual(w.calls[0].headers, { Accept: 'text/calendar' });
  }
  const w = wire();
  await T.calendarFetchFeed(feed('webcal://user:secret@calendar.example.com/work.ics'), w);
  assert.equal(w.calls[0].url, 'https://user:secret@calendar.example.com/work.ics', 'only the webcal rewrite, as before');
  assert.deepEqual(w.calls[0].headers, { Accept: 'text/calendar' });
}));

test('a 401 for an address with credentials says the sign-in was rejected; other 401s and every 403 say access was refused', async () => {
  const SIGN_IN = 'Calendar feed rejected the sign-in (HTTP 401): check the user name and password in its address.';
  for (const mobile of [true, false]) {
    await on(mobile, async () => {
      const creds = (status) => T.calendarFetchFeed(feed('https://user:secret@calendar.example.com/a.ics'), wire({ status, text: '' }));
      const plain = (status) => T.calendarFetchFeed(feed('https://calendar.example.com/private-0123/a.ics'), wire({ status, text: '' }));
      const r401 = await creds(401);
      assert.equal(r401.ok, false);
      assert.equal(r401.reason, 'misconfigured');
      assert.equal(r401.message, SIGN_IN, `mobile: ${mobile}`);
      const p401 = await plain(401);
      assert.equal(p401.reason, 'misconfigured');
      assert.equal(p401.message, 'Calendar feed refused access (HTTP 401): check its address.');
      for (const r of [await creds(403), await plain(403)]) {
        assert.equal(r.reason, 'misconfigured');
        assert.equal(r.message, 'Calendar feed refused access (HTTP 403): check its address.', 'a 403 is not a failed sign-in');
      }
      // every other status reads as it always did
      const other = await creds(500);
      assert.equal(other.reason, 'unreachable');
      assert.equal(other.message, 'Calendar feed returned HTTP 500.');
    });
  }
});

test('guard: no result carries the userinfo or the header, not even when requestUrl throws with the URL', async () => {
  const url = 'https://user:secret@calendar.example.com/a.ics';
  const header = basic('user:secret').slice('Basic '.length);
  for (const mobile of [true, false]) {
    await on(mobile, async () => {
      const results = [
        await T.calendarFetchFeed(feed(url), wire({ status: 401, text: '' })),
        await T.calendarFetchFeed(feed(url), wire({ status: 403, text: '' })),
        await T.calendarFetchFeed(feed(url), wire({ status: 500, text: '' })),
        await T.calendarFetchFeed(feed(url), wire(new Error(`net::ERR_FAILED ${url}`))),
        await T.calendarFetchFeed(feed(url), wire()),
      ];
      for (const r of results) {
        const s = JSON.stringify(r);
        assert.doesNotMatch(s, /secret/, 'the password');
        assert.doesNotMatch(s, /user:/, 'the userinfo');
        assert.ok(!s.includes(header), 'the header value');
      }
      assert.equal(results[3].message, 'Calendar feed unreachable.');
    });
  }
});
