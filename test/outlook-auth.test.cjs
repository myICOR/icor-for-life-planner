/* Outlook sign-in (2026-09-06): the member's own Entra app, PKCE, the
 * obsidian:// redirect, the device code fallback, the token store.
 *
 * Gated here, pure and scripted (no live network, no Obsidian runtime):
 *   - PKCE: a known verifier gives the RFC 7636 challenge; the pair's shape;
 *   - the authorize URL carries every parameter, S256 always;
 *   - the callback is trusted only with the state nonce this session issued;
 *   - a token reply parses to the token set, an error reply to the mapped
 *     AADSTS message with its codes, a non-JSON body to the raw status;
 *   - the plain-language table, row by row, and the fallback that shows
 *     Microsoft's own sentence rather than nothing;
 *   - the exchange and the refresh over a scripted requestUrl: the exact
 *     form body, one Retry-After retry, the rotation rule for the refresh
 *     token, the vault keys in both storage modes;
 *   - the device code: pending, slow_down, declined, expired, cancelled;
 *   - the four secret fields, the settings, the source shape.
 *
 * Every test here was run red against the 0.8.0-plus-vault bytes through
 * PLANNER_MAIN before it counted.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const code = () => fs.readFileSync(T.__mainPath, 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

class FakeSecretStorage {
  constructor() { this.m = new Map(); this.writes = 0; }
  setSecret(id, secret) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`invalid secret id: ${id}`);
    this.writes += 1;
    this.m.set(id, String(secret));
  }
  getSecret(id) { return this.m.has(id) ? this.m.get(id) : null; }
  listSecrets() { return [...this.m.keys()]; }
}
const store = () => { const storage = new FakeSecretStorage(); return { storage, vault: new T.SecretVault(storage) }; };

// A scripted requestUrl: `steps` answer calls in order; every call is kept.
function wire(steps) {
  const calls = [];
  const requestUrl = async (req) => {
    calls.push(req);
    const step = steps.shift();
    if (!step) throw new Error(`unscripted call: ${req.method} ${req.url}`);
    return typeof step === 'function' ? step(req) : step;
  };
  return { calls, requestUrl };
}
const json = (status, body, headers) => ({ status, json: body, text: JSON.stringify(body), headers: headers || {} });
const form = (req) => Object.fromEntries(new URLSearchParams(req.body));

const CLIENT = '11111111-2222-3333-4444-555555555555';
const SIGNED = { outlookClientId: CLIENT, outlookTenant: 'common', outlookRefreshToken: 'rt-old', outlookAccessToken: '', outlookExpiresAt: '', outlookAccount: '', outlookScopes: 'Mail.Read Calendars.Read' };

test('PKCE: the RFC 7636 verifier gives the RFC 7636 challenge, and a pair has the shape', async () => {
  assert.equal(typeof T.pkceChallenge, 'function', 'the challenge function must exist');
  assert.equal(await T.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const a = await T.pkcePair();
  const b = await T.pkcePair();
  assert.equal(a.verifier.length, 43, '32 random bytes, base64url, no padding');
  assert.match(a.verifier, /^[A-Za-z0-9_-]+$/, 'the base64url alphabet only');
  assert.equal(a.challenge, await T.pkceChallenge(a.verifier), 'the challenge is the SHA-256 of the verifier');
  assert.match(a.challenge, /^[A-Za-z0-9_-]{43}$/, 'no padding, no + or /');
  assert.notEqual(a.verifier, b.verifier, 'random');
  assert.equal(T.base64url(new Uint8Array([251, 255, 191])), '-_-_', 'base64url swaps + and / and drops =');
  assert.match(T.randomState(), /^[A-Za-z0-9_-]{22}$/, '16 random bytes');
});

test('the authorize URL carries every parameter the flow needs, S256 always', () => {
  const url = T.authorizeUrl({ clientId: CLIENT, tenant: 'organizations', scopes: 'offline_access openid profile Mail.Read Calendars.Read', redirectUri: T.OUTLOOK_REDIRECT_URI, state: 'st-1', challenge: 'ch-1' });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
  const p = u.searchParams;
  assert.equal(p.get('client_id'), CLIENT);
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('redirect_uri'), 'obsidian://icor-for-life-planner/auth');
  assert.equal(p.get('response_mode'), 'query');
  assert.equal(p.get('scope'), 'offline_access openid profile Mail.Read Calendars.Read');
  assert.equal(p.get('state'), 'st-1');
  assert.equal(p.get('code_challenge'), 'ch-1');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('prompt'), 'select_account');
  assert.ok(url.includes('redirect_uri=obsidian%3A%2F%2Ficor-for-life-planner%2Fauth'), 'the redirect is percent-encoded');
  assert.ok(url.includes('scope=offline_access%20openid'), 'spaces are %20');
  // The tenant segment is one of three; anything else is common.
  assert.equal(T.outlookTenant({ outlookTenant: 'consumers' }), 'consumers');
  assert.equal(T.outlookTenant({ outlookTenant: 'evil' }), 'common');
  assert.equal(T.outlookTenant({}), 'common');
  assert.deepEqual(T.OUTLOOK_TENANTS, ['common', 'organizations', 'consumers']);
  assert.equal(T.OUTLOOK_REDIRECT_URI, 'obsidian://icor-for-life-planner/auth');
  assert.equal(T.OUTLOOK_PROTOCOL_ACTION, 'icor-for-life-planner/auth');
  // The scope sets: the write one is the read one plus Mail.ReadWrite.
  assert.equal(T.outlookScopeString(false), 'offline_access openid profile Mail.Read Calendars.Read');
  assert.equal(T.outlookScopeString(true), 'offline_access openid profile Mail.Read Mail.ReadWrite Calendars.Read');
});

test('the callback is trusted only with the state this session issued', () => {
  assert.deepEqual(T.parseAuthCallback({ action: 'icor-for-life-planner/auth', code: 'c1', state: 'st-1' }, 'st-1'), { ok: true, code: 'c1' });
  const wrong = T.parseAuthCallback({ code: 'c1', state: 'st-2' }, 'st-1');
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /state mismatch/);
  const none = T.parseAuthCallback({ code: 'c1', state: 'st-1' }, null);
  assert.equal(none.ok, false, 'no sign-in was waiting');
  assert.equal(T.parseAuthCallback({ state: 'st-1' }, 'st-1').ok, false, 'no code');
  const denied = T.parseAuthCallback({ error: 'access_denied', error_description: 'AADSTS65004: User declined to consent.' }, 'st-1');
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'no-token');
  assert.match(denied.message, /declined/);
});

test('a token reply parses to the token set; an error reply to the mapped message with its codes', () => {
  const ok = T.parseTokenResponse(json(200, { token_type: 'Bearer', scope: 'Mail.Read Calendars.Read', expires_in: 3599, access_token: 'at-1', refresh_token: 'rt-1' }));
  assert.deepEqual(ok, { accessToken: 'at-1', refreshToken: 'rt-1', expiresIn: 3599, scope: 'Mail.Read Calendars.Read' });
  assert.equal(T.parseTokenResponse(json(200, { access_token: 'at-2', expires_in: '60' })).refreshToken, null, 'absent refresh token is null, never the string undefined');
  // With error_codes.
  assert.throws(() => T.parseTokenResponse(json(400, { error: 'invalid_grant', error_description: 'AADSTS70008: The provided authorization code or refresh token has expired. Trace ID: x Correlation ID: y Timestamp: z', error_codes: [70008] })),
    (e) => e.reason === 'no-token' && /haven't used this connection/.test(e.message) && e.codes.join() === '70008');
  // Without error_codes: the number inside the description still counts.
  assert.throws(() => T.parseTokenResponse(json(400, { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired due to inactivity.' })),
    (e) => e.reason === 'no-token' && e.codes.join() === '700082');
  // Malformed: the raw status and the truncated body, never a blank.
  const long = 'x'.repeat(500);
  assert.throws(() => T.parseTokenResponse({ status: 502, text: `<html>${long}</html>` }),
    (e) => e.reason === 'unreachable' && /^Microsoft returned HTTP 502: <html>x/.test(e.message) && e.message.length < 240);
  // requestUrl's json getter throws on a non-JSON body: handled.
  assert.throws(() => T.parseTokenResponse({ status: 504, get json() { throw new Error('not json'); }, text: 'gateway timeout' }),
    (e) => e.reason === 'unreachable' && /504: gateway timeout/.test(e.message));
  assert.equal(T.tokenJson(null), null);
  assert.equal(T.tokenJson({ text: '{"a":1}' }).a, 1);
});

test('the AADSTS table, row by row, and the fallback that shows Microsoft\'s own sentence', () => {
  const rows = [
    [{ error: 'invalid_grant', error_description: 'AADSTS50000: something' }, 'no-token', /authentication material .* Sign in again/],
    [{ error: 'invalid_grant', error_codes: [70008] }, 'no-token', /haven't used this connection in a while/],
    [{ error: 'invalid_grant', error_codes: [700082] }, 'no-token', /Microsoft expired it/],
    [{ error: 'invalid_client', error_codes: [7000218] }, 'misconfigured', /public client/],
    [{ error: 'invalid_request', error_codes: [50011] }, 'misconfigured', /redirect doesn't match/],
    [{ error: 'invalid_grant', error_codes: [65001] }, 'misconfigured', /Consent is needed/],
    [{ error: 'invalid_grant', error_codes: [90094] }, 'misconfigured', /Consent is needed/],
    [{ error: 'interaction_required', error_codes: [700020] }, 'no-token', /sign in interactively again/],
    [{ error: 'interaction_required' }, 'no-token', /sign in interactively again/],
    [{ error: 'unauthorized_client', error_codes: [700016] }, 'misconfigured', /Wrong Client ID/],
  ];
  for (const [body, reason, re] of rows) {
    const m = T.mapAadError(body);
    assert.equal(m.reason, reason, JSON.stringify(body));
    assert.match(m.message, re, JSON.stringify(body));
    assert.doesNotMatch(`${m.message} ${m.hint || ''}`, /[\u2013\u2014]/, 'no dashes of either length');
  }
  assert.match(T.mapAadError({ error_codes: [7000218] }).hint, /Allow public client flows/);
  assert.match(T.mapAadError({ error_codes: [50011] }).hint, /obsidian:\/\/icor-for-life-planner\/auth/);
  // Unknown: the description, cleaned of the prefix and the trace tail.
  const unknown = T.mapAadError({ error: 'temporarily_unavailable', error_description: 'AADSTS90033: A transient error has occurred. Please try again. Trace ID: a Correlation ID: b Timestamp: 2026-09-06 10:00:00Z' });
  assert.equal(unknown.reason, 'unreachable');
  assert.equal(unknown.message, 'A transient error has occurred. Please try again.');
  assert.deepEqual(unknown.codes, [90033]);
  assert.equal(T.mapAadError({ error: 'invalid_scope' }).reason, 'misconfigured', 'a client-configuration error without a code is still misconfigured');
  assert.equal(T.mapAadError({ error: 'invalid_scope' }).message, 'Microsoft sign-in failed (invalid_scope).');
  assert.equal(T.mapAadError({}).message, 'Microsoft sign-in failed.', 'never blank');
  assert.deepEqual(T.aadCodesOf({ error_codes: [1, '2'], error_description: 'AADSTS3: x AADSTS1: y' }), [1, 2, 3]);
  assert.equal(T.cleanAadDescription('  AADSTS7: Hello.  Trace ID: t'), 'Hello.');
});

test('the exchange posts exactly the authorization_code form, once, over requestUrl', async () => {
  const { calls, requestUrl } = wire([json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'Mail.Read' })]);
  const tokens = await T.tokenExchange({ clientId: CLIENT, tenant: 'common', code: 'code-1', redirectUri: T.OUTLOOK_REDIRECT_URI, verifier: 'ver-1', scopes: 'a b' }, { requestUrl });
  assert.equal(tokens.accessToken, 'at-1');
  assert.equal(calls.length, 1);
  const req = calls[0];
  assert.equal(req.url, 'https://login.microsoftonline.com/common/oauth2/v2.0/token');
  assert.equal(req.method, 'POST');
  assert.equal(req.throw, false, 'requestUrl must not throw on a non-2xx: the body is the error');
  assert.equal(req.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(form(req), {
    client_id: CLIENT, grant_type: 'authorization_code', code: 'code-1',
    redirect_uri: 'obsidian://icor-for-life-planner/auth', code_verifier: 'ver-1', scope: 'a b',
  });
  assert.equal('client_secret' in form(req), false, 'a public client has no secret');
});

test('a 429 with Retry-After: 3 is retried exactly once after 3 seconds, then succeeds or fails cleanly', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const a = wire([json(429, { error: 'throttled' }, { 'retry-after': '3' }), json(200, { access_token: 'at-1', expires_in: 10 })]);
  const t = await T.tokenExchange({ clientId: CLIENT, tenant: 'common', code: 'c', verifier: 'v', scopes: 's' }, { requestUrl: a.requestUrl, sleep });
  assert.equal(t.accessToken, 'at-1');
  assert.equal(a.calls.length, 2);
  assert.deepEqual(waits, [3000], 'one wait, the header\'s seconds');
  // The second 429 is the answer: no third call.
  const b = wire([json(429, {}, { 'Retry-After': '1' }), json(429, { error: 'throttled', error_description: 'AADSTS90033: Please try again.' })]);
  await assert.rejects(() => T.tokenExchange({ clientId: CLIENT, tenant: 'common', code: 'c', verifier: 'v', scopes: 's' }, { requestUrl: b.requestUrl, sleep }),
    (e) => e.reason === 'unreachable' && /try again/.test(e.message));
  assert.equal(b.calls.length, 2, 'never a third attempt');
  assert.deepEqual(waits, [3000, 1000]);
  // No header: a 2 second step; 503 counts like 429.
  const c = wire([{ status: 503, text: 'busy', headers: {} }, json(200, { access_token: 'x', expires_in: 1 })]);
  await T.tokenExchange({ clientId: CLIENT, tenant: 'common', code: 'c', verifier: 'v', scopes: 's' }, { requestUrl: c.requestUrl, sleep });
  assert.deepEqual(waits, [3000, 1000, 2000]);
  assert.equal(T.retryAfterMs({ headers: { 'retry-after': '0' } }), 0);
  assert.equal(T.retryAfterMs({ headers: { 'retry-after': 'soon' } }), 2000);
});

test('the refresh posts the refresh_token grant; a rotated token overwrites the stored one, an absent one leaves it', async () => {
  const { storage, vault } = store();
  const settings = Object.assign({}, T.DEFAULT_SETTINGS, SIGNED);
  T.migrateSecrets(settings, vault);
  assert.equal(storage.getSecret('icor-for-life-planner-outlook-refresh-token'), 'rt-old');
  assert.equal(settings.outlookRefreshToken, '', 'the field is blank in store mode');
  const s = T.withSecrets(settings, vault);
  assert.equal(s.outlookRefreshToken, 'rt-old', 'the resolved copy carries it');
  // The hidden links: on the copy, not in its JSON, not in its keys.
  assert.equal(s._live, settings);
  assert.equal(s._vault, vault);
  assert.ok(!Object.keys(s).includes('_live') && !JSON.stringify(s).includes('_live'), 'non-enumerable');
  assert.equal(Object.assign({}, s)._live, undefined, 'a further copy does not carry the link');

  const now = () => 1000000;
  const w = wire([json(200, { access_token: 'at-1', refresh_token: 'rt-new', expires_in: 3600, scope: 'Mail.Read Calendars.Read' })]);
  const token = await T.ensureAccessToken(s, { requestUrl: w.requestUrl, now });
  assert.equal(token, 'at-1');
  assert.equal(w.calls.length, 1);
  assert.deepEqual(form(w.calls[0]), { client_id: CLIENT, grant_type: 'refresh_token', refresh_token: 'rt-old', scope: 'offline_access openid profile Mail.Read Calendars.Read' });
  assert.equal(storage.getSecret('icor-for-life-planner-outlook-refresh-token'), 'rt-new', 'rotation: the new token replaced the old one in the store');
  assert.equal(storage.getSecret('icor-for-life-planner-outlook-access-token'), 'at-1');
  assert.equal(storage.getSecret('icor-for-life-planner-outlook-expires-at'), String(1000000 + 3600000));
  assert.equal(settings.outlookRefreshToken, '', 'the live settings stay blank: data.json carries no token');
  assert.equal(s.outlookRefreshToken, 'rt-new', 'the copy the connector holds reads the rotated token for the rest of the run');
  assert.equal(s.outlookAccessToken, 'at-1');
  // A cached token with time left is used without a call.
  const quiet = wire([]);
  assert.equal(await T.ensureAccessToken(s, { requestUrl: quiet.requestUrl, now: () => 1000000 + 3600000 - 61000 }), 'at-1');
  assert.equal(quiet.calls.length, 0);
  // Inside the slack it is refreshed; an absent refresh_token leaves the stored one.
  const w2 = wire([json(200, { access_token: 'at-2', expires_in: 3600 })]);
  assert.equal(await T.ensureAccessToken(s, { requestUrl: w2.requestUrl, now: () => 1000000 + 3600000 - 59000 }), 'at-2');
  assert.equal(form(w2.calls[0]).refresh_token, 'rt-new', 'the rotated token is what the next refresh sends');
  assert.equal(storage.getSecret('icor-for-life-planner-outlook-refresh-token'), 'rt-new', 'untouched: the reply carried none');
  assert.equal(storage.getSecret('icor-for-life-planner-outlook-access-token'), 'at-2');
  // force: refresh even with time left (the 401 path).
  const w3 = wire([json(200, { access_token: 'at-3', expires_in: 3600 })]);
  assert.equal(await T.ensureAccessToken(s, { requestUrl: w3.requestUrl, now: () => 1000000 + 3600000 - 59000 }, true), 'at-3');
  // Not signed in: no call, the no-token reason.
  await assert.rejects(() => T.ensureAccessToken(T.withSecrets({ outlookClientId: CLIENT }, new T.SecretVault(null)), { requestUrl: quiet.requestUrl }), (e) => e.reason === 'no-token');
  assert.equal(quiet.calls.length, 0);
  // The refresh that fails carries the mapped reason.
  const w4 = wire([json(400, { error: 'invalid_grant', error_codes: [700082] })]);
  await assert.rejects(() => T.ensureAccessToken(s, { requestUrl: w4.requestUrl, now: () => 1000000 + 3600000 }, true), (e) => e.reason === 'no-token' && e.codes[0] === 700082);
});

test('without a store the tokens live in the settings, and a rotation reaches disk at once', async () => {
  const none = new T.SecretVault(null);
  const settings = Object.assign({}, T.DEFAULT_SETTINGS, SIGNED);
  let persisted = 0;
  Object.defineProperty(settings, '_persist', { value: () => { persisted += 1; }, enumerable: false });
  const s = T.withSecrets(settings, none);
  const w = wire([json(200, { access_token: 'at-1', refresh_token: 'rt-new', expires_in: 3600 })]);
  await T.ensureAccessToken(s, { requestUrl: w.requestUrl, now: () => 5 });
  assert.equal(settings.outlookRefreshToken, 'rt-new', 'the live settings object, not the copy');
  assert.equal(settings.outlookAccessToken, 'at-1');
  assert.equal(settings.outlookExpiresAt, String(5 + 3600000));
  assert.equal(s.outlookRefreshToken, 'rt-new');
  assert.equal(persisted, 1, 'the sink asked for a save');
  assert.ok(!('_persist' in JSON.parse(JSON.stringify(settings))), 'the hook never reaches data.json');
  // Sign-out clears the four, in both modes.
  T.clearOutlookTokens({ live: settings, vault: none });
  for (const f of ['outlookRefreshToken', 'outlookAccessToken', 'outlookExpiresAt', 'outlookAccount']) assert.equal(settings[f], '', f);
  assert.equal(persisted, 2);
  const { storage, vault } = store();
  const ks = Object.assign({}, T.DEFAULT_SETTINGS, SIGNED, { outlookAccount: 'me@example.com' });
  T.migrateSecrets(ks, vault);
  assert.equal(storage.getSecret('icor-for-life-planner-outlook-account'), 'me@example.com');
  T.clearOutlookTokens({ live: ks, vault });
  for (const key of ['outlook-refresh-token', 'outlook-access-token', 'outlook-expires-at', 'outlook-account']) {
    // Cleared by writing the empty string; a key never written stays absent (null). Both read as empty.
    assert.equal(vault.get(`icor-for-life-planner-${key}`), '', key);
  }
  assert.equal(storage.getSecret('icor-for-life-planner-outlook-refresh-token'), '', 'the one that was written is blanked');
  assert.equal(T.outlookSignedIn(T.withSecrets(ks, vault)), false);
});

test('the device code: pending, slow_down, then the tokens; declined, expired and cancelled each stop', async () => {
  const start = wire([json(200, { device_code: 'dc-1', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 5, message: 'go' })]);
  const dc = await T.deviceCodeStart({ clientId: CLIENT, tenant: 'common', scopes: 'a b' }, { requestUrl: start.requestUrl });
  assert.equal(start.calls[0].url, 'https://login.microsoftonline.com/common/oauth2/v2.0/devicecode');
  assert.deepEqual(form(start.calls[0]), { client_id: CLIENT, scope: 'a b' });
  assert.deepEqual(dc, { deviceCode: 'dc-1', userCode: 'ABCD-EFGH', verificationUri: 'https://microsoft.com/devicelogin', expiresIn: 900, interval: 5, message: 'go' });
  let clock = 0;
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); clock += ms; };
  const now = () => clock;
  const poll = wire([
    json(400, { error: 'authorization_pending' }),
    json(400, { error: 'slow_down' }),
    json(400, { error: 'authorization_pending' }),
    json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'a b' }),
  ]);
  const tokens = await T.deviceCodePoll({ clientId: CLIENT, tenant: 'common', deviceCode: 'dc-1', interval: 5, expiresIn: 900 }, { requestUrl: poll.requestUrl, sleep, now });
  assert.equal(tokens.refreshToken, 'rt-1');
  assert.equal(poll.calls.length, 4);
  assert.deepEqual(form(poll.calls[0]), { client_id: CLIENT, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dc-1' });
  assert.deepEqual(waits, [5000, 5000, 10000, 10000], 'slow_down widens the interval by five seconds');
  const declined = wire([json(400, { error: 'authorization_declined' })]);
  await assert.rejects(() => T.deviceCodePoll({ clientId: CLIENT, tenant: 'common', deviceCode: 'd', interval: 1, expiresIn: 60 }, { requestUrl: declined.requestUrl, sleep, now }), (e) => e.reason === 'no-token' && /declined/.test(e.message));
  const expired = wire([json(400, { error: 'expired_token' })]);
  await assert.rejects(() => T.deviceCodePoll({ clientId: CLIENT, tenant: 'common', deviceCode: 'd', interval: 1, expiresIn: 60 }, { requestUrl: expired.requestUrl, sleep, now }), (e) => /code expired/.test(e.message));
  const cancelled = wire([]);
  await assert.rejects(() => T.deviceCodePoll({ clientId: CLIENT, tenant: 'common', deviceCode: 'd', interval: 1, expiresIn: 60 }, { requestUrl: cancelled.requestUrl, sleep, now, cancelled: () => true }), (e) => e.reason === 'cancelled');
  assert.equal(cancelled.calls.length, 0, 'a cancelled poll never calls');
  // The deadline ends it without a reply.
  const silent = wire([json(400, { error: 'authorization_pending' }), json(400, { error: 'authorization_pending' })]);
  clock = 0;
  await assert.rejects(() => T.deviceCodePoll({ clientId: CLIENT, tenant: 'common', deviceCode: 'd', interval: 5, expiresIn: 8 }, { requestUrl: silent.requestUrl, sleep, now }), (e) => /code expired/.test(e.message));
  assert.equal(silent.calls.length, 1);
});

test('the four secret fields, the settings, the sign-in predicates, the status line', () => {
  for (const f of ['outlookRefreshToken', 'outlookAccessToken', 'outlookExpiresAt', 'outlookAccount']) {
    assert.ok(f in T.SECRET_FIELDS, `${f} is secret-typed`);
    assert.match(T.fieldSecretKey(f), /^icor-for-life-planner-outlook-[a-z-]+$/);
    assert.equal(T.DEFAULT_SETTINGS[f], '', `${f} declared, empty`);
  }
  assert.equal(T.DEFAULT_SETTINGS.outlookClientId, '');
  assert.equal(T.DEFAULT_SETTINGS.outlookTenant, 'common');
  assert.equal(T.DEFAULT_SETTINGS.outlookScopes, '');
  assert.ok(!('outlookClientId' in T.SECRET_FIELDS), 'the client id is a public-client GUID, not a secret');
  assert.equal(T.outlookSignedIn({ outlookClientId: CLIENT }), false);
  assert.equal(T.outlookSignedIn({ outlookRefreshToken: 'rt' }), false, 'a token without a client id cannot be used');
  assert.equal(T.outlookSignedIn(SIGNED), true);
  assert.equal(T.outlookHasWriteScope({ outlookScopes: 'Mail.Read Mail.ReadWrite Calendars.Read' }), true);
  assert.equal(T.outlookHasWriteScope({ outlookScopes: 'Mail.Read Calendars.Read' }), false);
  assert.equal(T.outlookHasWriteScope({}), false);
  assert.deepEqual(T.outlookTokens(Object.assign({}, SIGNED, { outlookExpiresAt: '12' })), { refreshToken: 'rt-old', accessToken: '', expiresAt: 12, account: '' });
  assert.equal(T.outlookStatusText({}), 'Paste your Application (client) ID above, then sign in.');
  assert.match(T.outlookStatusText({ outlookClientId: CLIENT }), /^Not signed in\./);
  assert.equal(T.outlookStatusText(Object.assign({}, SIGNED, { outlookAccount: 'me@example.com' })), 'Signed in as me@example.com.');
  assert.match(T.outlookStatusText(Object.assign({}, SIGNED, { completeOnSource: true })), /Mail\.ReadWrite.*sign in again/);
  assert.equal(T.outlookStatusText(Object.assign({}, SIGNED, { completeOnSource: true, outlookScopes: 'Mail.ReadWrite' })), 'Signed in as your Microsoft account.');
  // The registry entry.
  const c = T.CONNECTORS.outlook;
  assert.equal(c.kind, 'task');
  assert.equal(c.folder, 'Outlook');
  assert.deepEqual(c.platforms, ['desktop', 'mobile'], 'requestUrl and the protocol handler exist on both');
  assert.equal(c.pushFields, null, 'the flag is the one write; never field writes');
  assert.equal(T.sourceConfigured({ outlookClientId: CLIENT }, 'outlook'), false);
  assert.equal(T.sourceConfigured(SIGNED, 'outlook'), true);
  assert.equal(T.canCompleteOnSource('outlook'), true);
  assert.equal(T.canPushToSource('outlook'), false);
  // The notice, exactly as given; the guide link; the revoke pages.
  assert.equal(T.OUTLOOK_NOTICE, 'You are creating this in your own Microsoft account. Paperless Movement, S.L. never sees or stores your client id or token; you are bound by Microsoft\'s developer terms for it.');
  assert.match(T.OUTLOOK_GUIDE_URL, /\/docs\/outlook-setup-guide\.md$/);
  assert.equal(T.OUTLOOK_REVOKE_URLS.work, 'https://myaccount.microsoft.com/');
  assert.equal(T.OUTLOOK_REVOKE_URLS.personal, 'https://account.live.com/consent/Manage');
});

test('source scan: the handler is registered at load, the browser is opened, no fetch, the notice is shown', () => {
  const c = code();
  assert.match(c, /this\.registerObsidianProtocolHandler\(OUTLOOK_PROTOCOL_ACTION, \(params\) => this\.outlookAuthCallback\(params\)\)/, 'the redirect lands in the callback');
  assert.match(c, /window\.open\(url, '_external'\)/, 'the sign-in opens the system browser');
  const start = c.indexOf('const OUTLOOK_REDIRECT_URI');
  const end = c.indexOf('function imapSplitResponses');
  assert.ok(start > 0 && end > start, 'the Outlook module sits before the IMAP connector');
  const mod = c.slice(start, end);
  assert.doesNotMatch(mod, /\bfetch\(/, 'the renderer fetch carries an Origin header Entra refuses; requestUrl only');
  assert.match(mod, /requestUrlOf\(deps\)/);
  assert.doesNotMatch(mod, /http:\/\/localhost|createServer/, 'no loopback listener: the scheme covers desktop already');
  assert.match(c, /setName\('Application \(client\) ID'\)\.setDesc\(OUTLOOK_NOTICE\)/, 'the notice sits under the client id field, verbatim');
  assert.match(c, /if \(v && outlookSignedIn\(r\) && !outlookHasWriteScope\(r\)\) this\.plugin\.outlookSignIn\(\{ write: true/, 'switching Complete on source on asks for Mail.ReadWrite');
  assert.match(c, /clearOutlookTokens\(\{ live: this\.settings, vault: this\.secrets \}\)/, 'sign-out clears through the vault');
  assert.match(c, /OUTLOOK_REVOKE_URLS\.work/, 'the revoke link is offered');
  assert.doesNotMatch(c, /this\.(plugin\.)?settings\.outlook(RefreshToken|AccessToken|ExpiresAt|Account)\b/, 'no class reads an Outlook secret off the settings directly');
  // The two secret-vault gates that reach into the settings tab still hold
  // for the Outlook fields: the account is read for display only, through
  // the resolved copy.
  assert.doesNotMatch(c, /console\.(log|warn|error)\([^)]*(token|Token|clientId)/, 'no token or client id in a log line');
});

test('no dash of either length in the Outlook copy', () => {
  const src = fs.readFileSync(T.__mainPath, 'utf8');
  const start = src.indexOf('Connector: Outlook through Microsoft Graph');
  const end = src.indexOf('function imapSplitResponses');
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(src.slice(start, end), /[\u2013\u2014]/);
  for (const t of [T.OUTLOOK_NOTICE, T.outlookStatusText({}), T.outlookStatusText(SIGNED)]) assert.doesNotMatch(t, /[\u2013\u2014]/);
});
