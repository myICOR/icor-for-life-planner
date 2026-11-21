/* KEYS LIVE IN OBSIDIAN'S KEYCHAIN (plugin review, 2026-11-21).
 *
 * Below Obsidian 1.11.4 there is no keychain (app.secretStorage), and the
 * Planner quietly kept keys in plain text instead: in data.json, or the env
 * file. With minAppVersion 1.11.4 the keychain always exists, so a key is
 * never written in plain text unless the member chooses the env file. The
 * README's "keys are held in Obsidian's own keychain" is true again.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));

test('the plugin needs an Obsidian that has the keychain', () => {
  assert.equal(manifest.minAppVersion, '1.11.4');
  assert.equal(versions[manifest.version], '1.11.4', 'versions.json says the same for this release');
});
