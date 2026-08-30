/* Internal-reference residue in the tracked tree.
 *
 * The repo is public and the shipped files travel further still (the member
 * zip). A comment may teach a reader WHY a rule holds; it must never teach
 * WHERE it was decided or by whom. So: keep the rule and the reasoning, drop
 * the personal names, the ruling ids, the internal document refs and the
 * section refs. Where a pointer was load-bearing, its referent is named in
 * words instead.
 *
 * Method notes, both measured today:
 *   - No grep. `git grep -E` silently dropped a bare ruling-id hit during the
 *     theme's own sweep, so matching happens in JS regex over bytes read
 *     straight from disk; git is used only to enumerate tracked files.
 *   - This file is the one place the pattern family may appear (a gate must
 *     state what it hunts), so it excludes exactly itself and nothing else.
 *     Every OTHER test file is inside the net on purpose: a pattern quoted in
 *     a sibling gate's explanation is still bytes in a public repo.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = process.env.PLANNER_ROOT
  ? path.resolve(process.env.PLANNER_ROOT)
  : path.join(__dirname, '..');

const SELF = 'test/residue.test.cjs';

// The family, verbatim from the zip builder's block list plus the sweep law.
// "Larry" is deliberately absent: he is the shipped orchestrator persona, so
// his name in a user-facing string is product, not residue.
const FAMILY = /\bIris\b|\bFelix\b|\bVera\b|GL-0[0-9]{2}|ruling A[0-9]|\bA[0-9]{3}\b|§[0-9]|icor-ai-chat/;

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

test('no tracked file outside this gate carries the internal-reference family', () => {
  const findings = [];
  for (const f of trackedFiles()) {
    if (f === SELF) continue;
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = FAMILY.exec(lines[i]);
      if (m) findings.push(`${f}:${i + 1}: ${m[0]} in: ${lines[i].trim().slice(0, 80)}`);
    }
  }
  assert.deepEqual(findings, [], `internal references in tracked files:\n${findings.join('\n')}`);
});

test('the hard zip-blocker pattern is gone from the shipped files specifically', () => {
  // The member-zip builder aborts on the old plugin id. Asserted separately
  // from the family sweep so the build-blocking subset has its own red.
  for (const f of ['main.js', 'styles.css', 'manifest.json']) {
    const text = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(!text.includes('icor-ai-chat'), `${f} carries the zip-blocking id`);
  }
});

test('the sweep kept the reasoning: load-bearing referents survive in words', () => {
  // The law is rewrite, not delete. Spot-check that the rules the refs
  // used to carry are still taught: the plugin-surface attribute contract,
  // the touch-target minimum, and the two-channel focus treatment.
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  assert.match(main, /plugin-surface contract|plugin surface/i, 'the attribute contract must still be explained');
  assert.match(css, /44px/, 'the touch-target minimum must survive as a number');
  assert.match(css, /TWO channels|two channels/i, 'the focus treatment reasoning must survive');
  assert.match(css, /marker must not become the canvas/i, 'the marker-budget rule must survive');
});
