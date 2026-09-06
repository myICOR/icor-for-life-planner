/* The connector registry: one object per source, everything else derived.
 *
 * Before this, a task source was spread over nine touchpoints keyed by the
 * source id string: the presentation table, the SYNCED list, the push and
 * complete predicates, the configured switch, the runs array in the sync,
 * the healthy count, the board notice list, and three if/else chains that
 * chose a write client by comparing `source === '...'`. Adding a source
 * meant finding all nine, and missing one failed silently.
 *
 * Gated here: the derived values are what the hand-kept lists said; the
 * predicates are the presence of a capability, not a name; and no
 * per-source comparison survives outside the registry.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const T = require('./harness.cjs');

const code = () => fs.readFileSync(T.__mainPath, 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('every synced source has fetchOpen and configured; manual has neither', () => {
  assert.equal(typeof T.CONNECTORS, 'object', 'the registry must exist');
  for (const id of T.SYNCED_SOURCES) {
    const c = T.CONNECTORS[id];
    assert.ok(c, `${id} must be in the registry`);
    assert.equal(c.kind, 'task', id);
    assert.equal(typeof c.fetchOpen, 'function', `${id}.fetchOpen`);
    assert.equal(typeof c.configured, 'function', `${id}.configured`);
    assert.equal(typeof c.setClosed, 'function', `${id}.setClosed`);
    assert.equal(typeof c.doneNotice, 'function', `${id}.doneNotice`);
    assert.ok(Array.isArray(c.platforms) && c.platforms.length, `${id}.platforms`);
  }
  const m = T.CONNECTORS.manual;
  assert.equal(m.kind, 'local');
  assert.equal(m.fetchOpen, null);
  assert.equal(m.setClosed, null);
  assert.equal(m.pushFields, null);
  assert.equal(m.configured({}), true, 'manual is always configured');
});

test('the derived lists are what the hand-kept lists used to say', () => {
  assert.deepEqual(T.SYNCED_SOURCES, ['todoist', 'clickup', 'email']);
  assert.deepEqual(T.TASK_SOURCES, ['manual', 'todoist', 'clickup', 'email']);
  assert.deepEqual(T.FETCHED_SOURCES, ['todoist', 'clickup', 'email', 'calendar']);
  assert.deepEqual(Object.keys(T.SOURCES), Object.keys(T.CONNECTORS), 'SOURCES is the registry\'s presentation view');
  for (const id of Object.keys(T.CONNECTORS)) {
    const c = T.CONNECTORS[id];
    assert.deepEqual(T.SOURCES[id], { id: c.id, label: c.label, folder: c.folder, svg: c.svg }, id);
  }
});

test('canPushToSource and canCompleteOnSource are the presence of a capability', () => {
  for (const id of [...Object.keys(T.CONNECTORS), 'nonsense']) {
    const c = T.CONNECTORS[id];
    assert.equal(T.canPushToSource(id), !!(c && c.pushFields), `push ${id}`);
    assert.equal(T.canCompleteOnSource(id), !!(c && c.setClosed), `complete ${id}`);
  }
  assert.equal(T.canPushToSource('email'), false, 'email takes the star flag, not field writes');
  assert.equal(T.canCompleteOnSource('email'), true);
  assert.equal(T.canPushToSource('calendar'), false);
  assert.equal(T.canCompleteOnSource('calendar'), false);
});

test('sourceConfigured is the registry\'s configured, calendar included', () => {
  assert.equal(T.sourceConfigured({ icsUrl: ' https://x ' }, 'calendar'), true);
  assert.equal(T.sourceConfigured({ icsUrl: '   ' }, 'calendar'), false);
  assert.equal(T.CONNECTORS.calendar.kind, 'calendar');
  assert.ok(!T.SYNCED_SOURCES.includes('calendar'), 'the calendar is fetched but never a task source');
  assert.equal(T.sourceConfigured(undefined, 'todoist'), false, 'a missing settings object never throws');
});

test('email is desktop-only by declaration, the others run everywhere', () => {
  assert.deepEqual(T.CONNECTORS.email.platforms, ['desktop']);
  for (const id of ['manual', 'todoist', 'clickup', 'calendar']) {
    assert.deepEqual(T.CONNECTORS[id].platforms, ['desktop', 'mobile'], id);
  }
});

test('the runs list, the healthy count and the board notices are derived from the registry', () => {
  const c = code();
  assert.doesNotMatch(c, /\[\s*'todoist',\s*'clickup',\s*'email'\s*\]/, 'a literal source list survives outside the registry');
  assert.match(c, /SYNCED_SOURCES\.map\(\(k\) => \[k, CONNECTORS\[k\]\.fetchOpen\(s\)\]\)/, 'syncNow must start each connector through the registry');
  assert.match(c, /const okCount = SYNCED_SOURCES\.filter/, 'the healthy count reads the derived list');
  assert.match(c, /for \(const key of SYNCED_SOURCES\) \{\n\s*const st = this\.plugin\.syncStatus\[key\];/, 'the board notice loop reads the derived list');
});

test('no per-source comparison survives outside the registry', () => {
  const c = code();
  assert.doesNotMatch(c, /source === '(todoist|clickup|email)'/, 'a write client is still chosen by comparing the source name');
  assert.doesNotMatch(c, /source !== 'email'/, 'the push guard must ask canPushToSource, not the name');
  assert.match(c, /await c\.setClosed\(this\.withSecrets\(\), item, closed\);/, 'applyDoneOnSource goes through the registry with the resolved settings');
  assert.equal((c.match(/CONNECTORS\[[a-z.]+\]\.pushFields\(s, /g) || []).length, 2, 'both push paths (sync-time and edit-time) go through the registry');
});
