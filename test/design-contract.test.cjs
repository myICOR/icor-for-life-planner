/* The design-system contract, as a gate rather than a comment.
 *
 * What this can prove: that the source still SAYS the things the ruling
 * requires. What it cannot prove: that the browser then paints them. Cascade
 * outcome needs a real Obsidian and an eye; this catches the silent deletion
 * that would make that check never happen. Stated plainly because a gate whose
 * reach is overstated is worse than no gate.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// PLANNER_ROOT points the gate at a different copy of the plugin: the bytes a
// particular vault actually loads, or a deliberately regressed copy used to
// prove this gate can go red. Same rationale as PLANNER_MAIN in harness.cjs.
const root = process.env.PLANNER_ROOT
  ? path.resolve(process.env.PLANNER_ROOT)
  : path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

test('every plugin surface declares data-ink-plugin (the theme contract)', () => {
  // Without it the theme's control rules sit at (0,5,1) and beat every
  // (0,2,0) rule in styles.css. The tray's underline field would render as a
  // filled well, and the only symptom is that it looks wrong.
  assert.match(main, /function markInkPlugin\(/, 'the helper must exist');
  assert.match(main, /el\.dataset\.inkPlugin = pluginId/, 'it must actually set the attribute');

  // One call per mounted surface: board, tray, event modal.
  const calls = main.match(/markInkPlugin\(/g) || [];
  assert.ok(calls.length >= 4, `expected the helper plus 3 call sites, found ${calls.length}`);
  for (const surface of [
    /addClass\('iplan-root'\);\s*\n\s*markInkPlugin\(/,
    /addClass\('iplan-tray-root'\);\s*\n\s*markInkPlugin\(/,
    /addClass\('iplan-event-modal'\);\s*\n\s*markInkPlugin\(/,
  ]) assert.match(main, surface, `a surface mounts without declaring itself: ${surface}`);

  // Read from the manifest, never a literal, so a rename cannot unhook it.
  // This assertion USED to name the old slug and went stale the moment the
  // repo was renamed: a gate that hardcodes the very identity it polices is
  // the thing it exists to forbid. It now reads the id from manifest.json,
  // so the next rename carries it along instead of quietly defanging it.
  const declaredId = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).id;
  assert.ok(declaredId, 'manifest.json must declare an id');
  const hardcoded = new RegExp(`inkPlugin\\s*=\\s*['"]${declaredId}['"]`);
  assert.ok(!hardcoded.test(main),
    `the plugin id must come from the manifest, not the literal "${declaredId}"`);
});

test('the 2026-08-30 controls are stated at (0,2,0) and ride tokens only', () => {
  // Bound the block at BOTH ends. Slicing to end-of-file would sweep in the
  // pre-existing rules below it, and a gate that reads a superset of what it
  // names is the containment-versus-existence defect: it goes red for reasons
  // that have nothing to do with the thing it guards.
  const start = css.indexOf('/* ======================================================== 2026-08-30 ====');
  assert.ok(start > 0, 'the 2026-08-30 block must be findable');
  const end = css.indexOf('/* -------------------------------------------------- settings notes ---- */', start);
  assert.ok(end > start, 'the 2026-08-30 block must have an end marker after it');
  const block = css.slice(start, end);

  // No raw hex. Every colour rides an --iplan-* alias of an --ink-* token.
  const hex = block.match(/#[0-9a-fA-F]{3,8}\b/g);
  assert.equal(hex, null, `raw hex in the 2026-08-30 block: ${hex}`);

  // Interactive controls must carry the .iplan-tray-root prefix, or the
  // theme's own button and input rules outrank them in stock Obsidian.
  for (const sel of ['button.iplan-action', 'input.iplan-add-input']) {
    const bare = new RegExp(`(^|,)\\s*${sel.replace('.', '\\.')}[\\s,{:]`, 'm');
    assert.ok(!bare.test(block), `${sel} is stated bare somewhere; it needs the .iplan-tray-root prefix`);
    assert.ok(block.includes(`.iplan-tray-root ${sel}`), `${sel} must be stated under .iplan-tray-root`);
  }

  // The two new aliases are declared on the token block, not invented inline.
  for (const alias of ['--iplan-line-rest', '--iplan-hairline-subtle']) {
    assert.match(css, new RegExp(`${alias}: var\\(--ink-`), `${alias} must alias an --ink-* token`);
  }
});

test('the focus ring is switched off in exactly one place, with its replacement', () => {
  // A local ring switch-off is allowed only where the replacement carries two channels.
  // If outline:none ever spreads, this goes red and someone has to justify it.
  // Declarations only. The prose above the rule says "outline:none" too, and a
  // gate that counts its own explanation is not counting the code.
  const offs = css.match(/^\s*outline:\s*none\s*;/gm) || [];
  assert.equal(offs.length, 1, `outline:none appears ${offs.length} times; exactly one is sanctioned`);
  const i = css.indexOf('outline: none');
  const around = css.slice(i - 400, i + 40);
  assert.match(around, /border-bottom-color: var\(--iplan-marker\)/, 'channel 1: hue on the border');
  assert.match(around, /box-shadow: 0 1px 0 0 var\(--iplan-marker\)/, 'channel 2: a stroke that was not there at rest');
});

test('touch targets are expanded on coarse pointers, not on hover', () => {
  // any-pointer, never pointer, so a touchscreen laptop still qualifies.
  assert.match(css, /@media \(any-pointer: coarse\)/);
  assert.ok(!/@media \(pointer: coarse\)/.test(css), 'pointer: coarse misses hybrid devices');
  const i = css.indexOf('@media (any-pointer: coarse)');
  const block = css.slice(i, i + 500);
  assert.match(block, /min-height: 44px/, 'the touch-target minimum is 44px absolute');
});

test('the board and the tray describe the unconnected state with one sentence', () => {
  // Two surfaces, one state. If either grows its own wording, this goes red.
  const hits = main.match(/notices\.push\(TRAY_COPY\.lead\)/g) || [];
  assert.equal(hits.length, 1, 'the board notice must reuse the tray constant');
  assert.ok(!/Add API keys in Settings/.test(main),
    'the old board wording said "keys" for a calendar that takes a URL');
  assert.ok(!/Settings -> ICOR Planner/.test(main), 'stale arrow copy');
});
