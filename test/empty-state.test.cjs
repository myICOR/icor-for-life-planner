/* The tray's empty states.
 *
 * This is the gate for the actual reported bug: a fresh vault with no
 * credentials showed "WAITING FOR THE FIRST SYNC." under Todoist, ClickUp and
 * Email. No sync was coming, because no key existed. Case 1 is that screenshot.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

const COLD = {};
const WARM = { todoistToken: 'abc', clickupToken: 'pk_1', imapHost: 'imap.gmail.com', imapUser: 'a@b.c', imapPassword: 'x', icsUrl: 'https://example.com/x.ics' };
const okStatus = { ok: true, reason: null, message: null, count: 0, at: 'now' };

test('THE BUG: a fresh vault with no keys never says "waiting for the first sync"', () => {
  for (const source of T.SYNCED_SOURCES) {
    const st = T.trayEmptyState(source, T.sourceConfigured(COLD, source), undefined, 0);
    assert.equal(st.kind, 'unconfigured', `${source} must report unconfigured on a cold vault`);
    assert.notEqual(st.text, T.TRAY_COPY.unsynced,
      `${source} must not tell the user to wait for a sync that cannot happen`);
    assert.match(st.text, /not connected/i);
  }
});

test('configured but never synced: waiting IS honest', () => {
  for (const source of T.SYNCED_SOURCES) {
    const st = T.trayEmptyState(source, true, undefined, 0);
    assert.equal(st.kind, 'unsynced');
    assert.equal(st.text, T.TRAY_COPY.unsynced);
  }
});

test('configured, synced healthy, genuinely zero items: says zero, not waiting', () => {
  const st = T.trayEmptyState('todoist', true, okStatus, 0);
  assert.equal(st.kind, 'empty');
  assert.equal(st.text, T.TRAY_COPY.empty);
});

test('items present: the tray says nothing at all', () => {
  assert.equal(T.trayEmptyState('todoist', true, okStatus, 3), null);
  assert.equal(T.trayEmptyState('todoist', true, undefined, 3), null);
});

test('a failed fetch reports the failure, even with stale cards on screen', () => {
  const st = T.trayEmptyState('clickup', true, { ok: false, reason: 'unreachable', message: 'ClickUp is unreachable.' }, 4);
  assert.equal(st.kind, 'error');
  assert.equal(st.text, 'ClickUp is unreachable.');
});

test('a deleted key beats a stale ok status from earlier in the session', () => {
  // The user synced, then cleared the token. syncStatus still says ok.
  const st = T.trayEmptyState('todoist', T.sourceConfigured(COLD, 'todoist'), okStatus, 0);
  assert.equal(st.kind, 'unconfigured');
});

test('manual is never unconfigured and never waiting', () => {
  assert.equal(T.sourceConfigured(COLD, T.MANUAL_SOURCE), true);
  const empty = T.trayEmptyState(T.MANUAL_SOURCE, true, undefined, 0);
  assert.equal(empty.kind, 'empty');
  assert.notEqual(empty.text, T.TRAY_COPY.unsynced);
  assert.equal(T.trayEmptyState(T.MANUAL_SOURCE, true, undefined, 1), null);
});

test('sourceConfigured reads every credential the connectors read', () => {
  assert.equal(T.sourceConfigured({ todoistToken: '   ' }, 'todoist'), false, 'whitespace is not a token');
  assert.equal(T.sourceConfigured({ todoistToken: ' x ' }, 'todoist'), true);
  assert.equal(T.sourceConfigured({ clickupToken: 'pk_1' }, 'clickup'), true);
  // email needs all three, exactly like emailFetchStarred's guard
  assert.equal(T.sourceConfigured({ imapHost: 'h', imapUser: 'u' }, 'email'), false);
  assert.equal(T.sourceConfigured({ imapHost: 'h', imapUser: 'u', imapPassword: 'p' }, 'email'), true);
  assert.equal(T.sourceConfigured({ icsUrl: 'https://x' }, 'calendar'), true);
  assert.equal(T.sourceConfigured(WARM, 'nonsense'), false);
});

test('the connectors agree with sourceConfigured about what "not connected" means', async () => {
  // The no-token guard inside each connector is the other half of this rule.
  // If they ever disagree the tray claims one thing and the fetch does another.
  const fetchers = {
    todoist: T.todoistFetchOpen, clickup: T.clickupFetchOpen,
    email: T.emailFetchStarred, calendar: T.calendarFetchDefs, outlook: T.outlookFetchOpen,
  };
  for (const [source, fn] of Object.entries(fetchers)) {
    const res = await fn(COLD);
    assert.equal(res.ok, false, `${source} must not fetch without a credential`);
    assert.equal(res.reason, 'no-token', `${source} degraded reason`);
    assert.equal(T.sourceConfigured(COLD, source), false);
  }
});

test('trayConnectionState leads with one CTA only when every task source is cold', () => {
  const cold = T.trayConnectionState(COLD);
  assert.equal(cold.allCold, true);
  assert.deepEqual(cold.unconfigured, T.SYNCED_SOURCES);
  assert.equal(cold.calendar, false);

  const oneWarm = T.trayConnectionState({ todoistToken: 'abc' });
  assert.equal(oneWarm.allCold, false);
  assert.deepEqual(oneWarm.configured, ['todoist']);
  assert.deepEqual(oneWarm.unconfigured, ['clickup', 'email', 'outlook']);

  // A calendar-only setup still leaves the task tray with nothing to show,
  // so it still earns the lead block.
  const calOnly = T.trayConnectionState({ icsUrl: 'https://x' });
  assert.equal(calOnly.allCold, true);
  assert.equal(calOnly.calendar, true);

  assert.equal(T.trayConnectionState(WARM).allCold, false);
});

test('the copy never uses an em dash or an en dash', () => {
  const strings = [
    T.TRAY_COPY.lead, T.TRAY_COPY.leadAction, T.TRAY_COPY.connectAction,
    T.TRAY_COPY.unsynced, T.TRAY_COPY.empty, T.TRAY_COPY.manualEmpty,
    T.TRAY_COPY.errorFallback, T.TRAY_COPY.unconfigured('todoist'),
  ];
  for (const s of strings) assert.ok(!/[–—]/.test(s), `dash in: ${s}`);
});

test('the lead sentence names no source, so it cannot drift', () => {
  // Design ruling 2026-08-30: a hardcoded list of sources in a status line is wrong the
  // day a fifth source is added, with nothing pointing at it. The section
  // heads below already name each source.
  const lead = T.TRAY_COPY.lead.toLowerCase();
  for (const key of [...T.TASK_SOURCES, 'calendar']) {
    const label = (T.SOURCES[key] || {}).label || key;
    assert.ok(!lead.includes(label.toLowerCase()),
      `the lead block must not name ${label}`);
  }
  assert.ok(!lead.includes('add a key'),
    'the calendar takes a URL and the mailbox takes three fields; "key" is wrong for both');
  assert.ok(T.TRAY_COPY.lead.length < 120, 'three lines at 44ch, not four');
});

test('the per-source note carries no source name either', () => {
  // The section head directly above it already says which source this is.
  for (const key of T.SYNCED_SOURCES) {
    const text = T.trayEmptyState(key, false, undefined, 0).text;
    assert.equal(text, 'Not connected.');
  }
});

/* THE "CONNECT THIS DEVICE" PROMPT (Flint's mobile audit, fix 4 / finding
 * 7.2). secretsInStore is a whole-vault flag: true the moment ANY secret has
 * ever landed in Obsidian's per-device secret store. It rides data.json, so
 * it syncs; the secret itself never does (Store secrets doc). A device that
 * sees secretsInStore true and its OWN sourceConfigured false for a source
 * is not looking at a never-configured vault -- it is the one device that
 * has not authenticated yet, and the old flat "Not connected." said the
 * same thing either way. */

test('a source unconfigured on THIS device, with secrets known elsewhere, gets the device-specific prompt', () => {
  for (const source of T.SYNCED_SOURCES) {
    const st = T.trayEmptyState(source, false, undefined, 0, /* total */ undefined, /* secretsElsewhere */ true);
    assert.equal(st.kind, 'unconfigured-device', `${source} must report the device-specific kind`);
    assert.equal(st.text, T.TRAY_COPY.unconfiguredDevice());
    assert.match(st.text, /this device/i);
  }
});

test('a genuinely never-configured vault (no secrets anywhere) keeps the plain "Not connected."', () => {
  for (const source of T.SYNCED_SOURCES) {
    const st = T.trayEmptyState(source, false, undefined, 0, undefined, false);
    assert.equal(st.kind, 'unconfigured');
    assert.equal(st.text, T.TRAY_COPY.unconfigured(source));
  }
});

test('omitting secretsElsewhere entirely is the same as false (backward compatible default)', () => {
  const withArg = T.trayEmptyState('todoist', false, undefined, 0, undefined, false);
  const withoutArg = T.trayEmptyState('todoist', false, undefined, 0);
  assert.deepEqual(withoutArg, withArg);
  assert.equal(withoutArg.kind, 'unconfigured');
});

test('secretsElsewhere is irrelevant once this device IS configured -- no device prompt on a healthy device', () => {
  const st = T.trayEmptyState('todoist', true, okStatus, 0, undefined, true);
  assert.notEqual(st.kind, 'unconfigured-device');
  assert.equal(st.kind, 'empty');
});

test('manual never becomes a device prompt -- it has no credential to begin with', () => {
  const st = T.trayEmptyState(T.MANUAL_SOURCE, true, undefined, 0, 0, true);
  assert.notEqual(st.kind, 'unconfigured-device');
});

test('the device-prompt copy carries no em dash or en dash either', () => {
  assert.ok(!/[–—]/.test(T.TRAY_COPY.unconfiguredDevice()), 'dash in unconfiguredDevice');
  assert.ok(!/[–—]/.test(T.TRAY_COPY.connectDeviceAction), 'dash in connectDeviceAction');
});
