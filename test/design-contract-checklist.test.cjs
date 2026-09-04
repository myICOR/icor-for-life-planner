/* The design contract for the checklist and the routine card, as a gate.
 *
 * Same reach and the same limit as design-contract.test.cjs: this proves the
 * stylesheet still SAYS what the rulings require; whether the browser paints
 * it needs a real Obsidian and an eye. Two rulings are pinned here because
 * each has a silent failure mode. The touch target: a row that shrinks below
 * 44px on a phone still works and just misses more often. The colour budget:
 * a hex literal added "for now" is invisible in a diff review of a 1,100
 * line stylesheet, and it is the one way this plugin drifts off the theme.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.PLANNER_ROOT
  ? path.resolve(process.env.PLANNER_ROOT)
  : path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');

// Every @media (any-pointer: coarse) block, by brace matching, so the gate
// reads the block and not a 500-character window that happens to follow it.
function coarseBlocks(text) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf('@media (any-pointer: coarse)', from);
    if (at < 0) return out;
    const open = text.indexOf('{', at);
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) break; }
    }
    out.push(text.slice(open + 1, i));
    from = i;
  }
}

test('a checklist row is 44px tall under a coarse pointer', () => {
  const blocks = coarseBlocks(css);
  assert.ok(blocks.length >= 1, 'the coarse-pointer block must exist');
  const hit = blocks.some((b) => /\.iplan-checklist-row[^{]*\{[^}]*min-height:\s*44px/.test(b));
  assert.ok(hit, '.iplan-checklist-row must set min-height: 44px inside @media (any-pointer: coarse)');
  // and never inside a hover query, which a touch device never matches
  assert.ok(!/@media \(hover: hover\)[^}]*\.iplan-checklist-row/.test(css));
});

test('the stylesheet gains no new hex literal', () => {
  // Every colour rides an --iplan-* alias of an --ink-* token. The literals
  // that exist are the stock-Obsidian fallbacks inside var() and the three
  // plugin-local tokens in the token block; the count is pinned so an
  // addition anywhere goes red. Removing one is fine: lower the number.
  const PINNED = 26;
  const hex = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.ok(hex.length <= PINNED, `${hex.length} hex literals, ${PINNED} allowed: a new colour was written by hand`);
});

test('the routine card wears one hairline edge for all three types', () => {
  const start = css.indexOf('/* ======================================================== 2026-09-04 ====');
  assert.ok(start > 0, 'the 2026-09-04 block must be findable');
  const block = css.slice(start);
  assert.match(block, /\.iplan-card\.iplan-routine \{[^}]*border-left: 2px solid var\(--iplan-hairline\)/);
  for (const t of ['morning', 'afternoon', 'evening']) {
    assert.ok(!new RegExp(`\\.is-${t}[^{]*\\{[^}]*(color|border)`).test(block), `no colour or edge keyed on is-${t}`);
  }
  assert.match(block, /\.iplan-checklist-row\[aria-checked="true"\] \.iplan-check \{[^}]*var\(--iplan-success\)/, 'the checked mark is the success ink');
  // the check control is the task card's rule, not a second drawing
  assert.match(css, /\.iplan-root button\.iplan-check, \.iplan-tray-root button\.iplan-check,\s*\n\.iplan-root \.iplan-checklist-row \.iplan-check/);
  // quiet is a token step, never an opacity dial, on the disabled row
  const disabled = /\.iplan-checklist-row\[aria-disabled="true"\] \{([^}]*)\}/.exec(block);
  assert.ok(disabled, 'the disabled row is stated');
  assert.ok(!/opacity/.test(disabled[1]), 'no opacity on the disabled row');
});
