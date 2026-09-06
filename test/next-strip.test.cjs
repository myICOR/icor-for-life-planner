/* The next-event strip (0.9.1): out of the ribbon, above the sidebar logo.
 *
 * Three things are gated. The model is pure and is tested as values. The
 * mount rule is pure over a querySelector root and is tested with a fake
 * tree. The rest is a source scan: the ribbon hook is gone, the strip
 * carries its reading contract, the stylesheet carries the strip and no raw
 * hex, and the member-facing words match. What a scan cannot prove is the
 * paint; that still needs an Obsidian and an eye.
 *
 * PLANNER_ROOT / PLANNER_MAIN point every check at another copy of the
 * plugin, which is how this file was run red against the 0.9.0 bytes.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./harness.cjs');

const root = process.env.PLANNER_ROOT
  ? path.resolve(process.env.PLANNER_ROOT)
  : path.join(__dirname, '..');
const main = fs.readFileSync(T.__mainPath, 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

// A fixed "now": a Tuesday, 10:00 local.
const NOW = new Date(2026, 8, 8, 10, 0, 0);
const at = (h, m) => new Date(2026, 8, 8, h, m, 0).toISOString();
const ev = (title, sh, sm, eh, em, extra) => Object.assign(
  { title, start: at(sh, sm), end: at(eh, em), allDay: false }, extra || {});

/* ------------------------------------------------------------ the model */

test('nothing on the clock today: null, so the strip hides rather than shows an empty row', () => {
  assert.equal(T.nextBadgeModel([], [], NOW), null);
  assert.equal(T.nextBadgeModel(undefined, undefined, NOW), null);
});

test('the earliest future start today wins, with its countdown and title', () => {
  const m = T.nextBadgeModel([ev('Later', 14, 0, 15, 0), ev('Standup', 10, 18, 10, 30)], [], NOW);
  assert.equal(m.title, 'Standup');
  assert.equal(m.label, 'in 18 min');
  assert.equal(m.spoken, 'in 18 minutes');
  assert.equal(m.joinUrl, null);
  assert.equal(m.urgent, false);
  assert.equal(m.running, false);
});

test('a running entry beats every future one and reads now', () => {
  const m = T.nextBadgeModel([ev('Soon', 10, 5, 10, 30), ev('Deep work', 9, 30, 11, 0)], [], NOW);
  assert.equal(m.title, 'Deep work');
  assert.equal(m.label, 'now');
  assert.equal(m.spoken, 'running now');
  assert.equal(m.running, true);
  assert.equal(m.urgent, false, 'the marker is for what is coming, not what is on');
});

test('the marker window is fifteen minutes, closed at the edge', () => {
  assert.equal(T.nextBadgeModel([ev('A', 10, 15, 11, 0)], [], NOW).urgent, true);
  assert.equal(T.nextBadgeModel([ev('A', 10, 16, 11, 0)], [], NOW).urgent, false);
  assert.equal(T.NEXT_URGENT_MS, 15 * 60000);
});

test('inside five minutes the label ticks in M:SS and the model says so', () => {
  const m = T.nextBadgeModel([ev('A', 10, 4, 11, 0)], [], NOW);
  assert.equal(m.label, 'in 4:00');
  assert.equal(m.imminent, true);
  assert.equal(T.nextBadgeModel([ev('A', 10, 6, 11, 0)], [], NOW).imminent, false);
});

test('all-day rows, continuation rows and other days are not "next"', () => {
  const tomorrow = new Date(2026, 8, 9, 9, 0, 0).toISOString();
  const tomorrowEnd = new Date(2026, 8, 9, 10, 0, 0).toISOString();
  assert.equal(T.nextBadgeModel([
    ev('All day', 0, 0, 23, 59, { allDay: true }),
    ev('Continued', 11, 0, 12, 0, { continues: true }),
    { title: 'Tomorrow', start: tomorrow, end: tomorrowEnd, allDay: false },
  ], [], NOW), null);
});

test('a meeting link on the event becomes joinUrl', () => {
  const m = T.nextBadgeModel([ev('Call', 11, 0, 12, 0, { location: 'https://zoom.us/j/123456789' })], [], NOW);
  assert.equal(m.joinUrl, 'https://zoom.us/j/123456789');
});

test('timed items (a routine that is due) compete with events on the same clock', () => {
  const items = [{ title: 'Morning routine', start: at(10, 10), end: at(10, 40), joinUrl: null }];
  const m = T.nextBadgeModel([ev('Standup', 10, 18, 10, 30)], items, NOW);
  assert.equal(m.title, 'Morning routine');
  assert.equal(m.label, 'in 10 min');
});

test('the key names the entry, not the tick, so the reader hears a change once', () => {
  const a = T.nextBadgeModel([ev('Standup', 10, 18, 10, 30)], [], NOW);
  const b = T.nextBadgeModel([ev('Standup', 10, 18, 10, 30)], [], new Date(NOW.getTime() + 60000));
  assert.equal(a.key, b.key);
  assert.notEqual(a.label, b.label);
});

test('routineTimedEntries: skipped and finished instances are not upcoming', () => {
  const occ = (extra) => Object.assign({ routine: { name: 'Evening' }, day: '2026-09-08', startMin: 21 * 60, endMin: 22 * 60, done: 0, total: 3, skipped: false }, extra);
  assert.equal(T.routineTimedEntries([occ({})]).length, 1);
  assert.equal(T.routineTimedEntries([occ({ skipped: true })]).length, 0);
  assert.equal(T.routineTimedEntries([occ({ done: 3 })]).length, 0);
  const e = T.routineTimedEntries([occ({})])[0];
  assert.equal(e.title, 'Evening');
  assert.equal(new Date(e.start).getHours(), 21);
});

test('the countdown reads like a person says it', () => {
  const min = 60000;
  const f = (ms) => T.fmtNextCountdown(NOW.getTime() + ms, NOW.getTime());
  assert.deepEqual(f(18 * min), { label: 'in 18 min', spoken: 'in 18 minutes' });
  assert.deepEqual(f(1 * min + 30000), { label: 'in 1:30', spoken: 'in 1 minute' });
  assert.deepEqual(f(60 * min), { label: 'in 1h', spoken: 'in 1 hour' });
  assert.deepEqual(f(18 * 60 * min + 4 * min), { label: 'in 18h 4m', spoken: 'in 18 hours 4 minutes' });
  assert.deepEqual(f(2 * 1440 * min + 3 * 60 * min), { label: 'in 2d 3h', spoken: 'in 2 days 3 hours' });
  assert.deepEqual(f(0), { label: 'now', spoken: 'running now' });
});

/* ------------------------------------------------------ the mount rule */

// A tiny querySelector root. Each node answers the selectors it was built
// to answer and nothing else; the real DOM is not needed to test a rule
// about which of two hosts is preferred.
function node(answers, props) {
  return Object.assign({ querySelector: (sel) => (answers && sel in answers) ? answers[sel] : null }, props || {});
}

test('the strip mounts before the file explorer\'s .nav-header, above the painted logo', () => {
  const header = node({}, { id: 'nav-header' });
  const explorer = node({ '.nav-header': header }, { firstElementChild: header });
  const tabs = node({}, { firstElementChild: node({}) });
  const root = node({ [T.NEXT_STRIP_LOGO_HOST]: explorer, [T.NEXT_STRIP_SPLIT_HOST]: tabs });
  const at = T.nextStripMountPoint(root);
  assert.equal(at.place, 'logo');
  assert.equal(at.parent, explorer);
  assert.equal(at.before, header, 'before .nav-header, never inside it: a ::before cannot be preceded by a child');
});

test('without a file explorer it falls back to the top of the left split', () => {
  const first = node({}, { id: 'tab-headers' });
  const tabs = node({}, { firstElementChild: first });
  const root = node({ [T.NEXT_STRIP_SPLIT_HOST]: tabs });
  const at = T.nextStripMountPoint(root);
  assert.equal(at.place, 'split');
  assert.equal(at.parent, tabs);
  assert.equal(at.before, first);
});

test('with neither host there is nowhere to mount, and that is a null, not a throw', () => {
  assert.equal(T.nextStripMountPoint(node({})), null);
  assert.equal(T.nextStripMountPoint(null), null);
});

test('the logo host is the file explorer leaf and the fallback is the left split', () => {
  assert.equal(T.NEXT_STRIP_LOGO_HOST, '.workspace-leaf-content[data-type="file-explorer"]');
  assert.match(T.NEXT_STRIP_SPLIT_HOST, /^\.workspace-split\.mod-left-split /);
});

/* ------------------------------------------------------ the source scan */

test('the ribbon hook is gone from main.js', () => {
  assert.doesNotMatch(main, /side-dock-actions/, 'the strip still hangs off the ribbon action stack');
  assert.doesNotMatch(main, /workspace-ribbon/, 'main.js still names the ribbon');
});

test('the strip is mounted through the rule, re-mounted on layout change, and watched by a scoped observer that is disconnected', () => {
  assert.match(main, /nextStripMountPoint\(document\)/, 'the runtime must use the same rule the test checked');
  assert.match(main, /workspace\.on\('layout-change', \(\) => this\.mountNextStrip\(\)\)/);
  assert.match(main, /new MutationObserver\(/);
  assert.match(main, /querySelector\('\.workspace-split\.mod-left-split'\)/, 'the observer is scoped to the left split');
  assert.match(main, /_badgeObserver\.disconnect\(\)/, 'the observer must be disconnected on remove / unload');
});

test('the strip no longer refuses mobile', () => {
  const s = main.indexOf('  setupNextBadge() {');
  const e = main.indexOf('  /* ---- views ---', s);
  assert.ok(s > 0 && e > s, 'the strip methods must be findable');
  const block = main.slice(s, e);
  assert.doesNotMatch(block, /isMobile/, 'the desktop-only guard belonged to the ribbon, not to the strip');
});

test('the reading contract: a real button with a full label, a polite status region spoken once per entry', () => {
  assert.match(main, /btn\.type = 'button'/);
  assert.match(main, /live\.setAttribute\('role', 'status'\)/);
  assert.match(main, /live\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(main, /if \(model\.key !== this\._badgeKey\) \{ this\._badgeKey = model\.key; parts\.live\.textContent = sentence; \}/,
    'the live region is written on a new entry only, never on a tick');
  assert.match(main, /aria-label', `\$\{sentence\}, \$\{model\.joinUrl \? 'join meeting' : 'open the board'\}`/);
});

test('the stylesheet carries the strip on the token aliases and no raw hex, and the ribbon badge is gone', () => {
  const s = css.indexOf('/* ------------------------------------------------ next-event strip ---- */');
  const e = css.indexOf('/* --------------------------------------------- today countdown bar ---- */', s);
  assert.ok(s > 0 && e > s, 'the strip block must be findable and bounded');
  const block = css.slice(s, e);
  assert.equal(block.match(/#[0-9a-fA-F]{3,8}\b/g), null, 'raw hex in the strip block');
  assert.match(block, /min-height: 32px/);
  assert.match(block, /background: var\(--iplan-surface\)/);
  assert.match(block, /border-bottom: 1px solid var\(--iplan-hairline\)/);
  assert.match(block, /\.iplan-next-strip\.is-urgent \.iplan-next-strip-count \{ color: var\(--iplan-marker\)/,
    'the marker is state ink on the countdown only');
  assert.match(block, /text-overflow: ellipsis/);
  assert.match(css, /\.iplan-next-strip, \.iplan-root, \.iplan-tray-root, \.iplan-settings \{/,
    'the strip must be in the alias block or every --iplan-* it names is unset');
  assert.doesNotMatch(css, /iplan-next-badge/, 'the ribbon badge rules are still shipped');
});

test('the member-facing words match: README bullet and the settings row', () => {
  assert.match(readme, /A strip above the sidebar logo shows your next event with a live\n\s+countdown/);
  assert.doesNotMatch(readme, /below the left ribbon/);
  assert.match(main, /\.setName\('Next event strip'\)/);
  assert.doesNotMatch(main, /desktop only\)/, 'the settings row still says desktop only');
});
