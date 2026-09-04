/* The version has one home: manifest.json.
 *
 * main.js carried its own PLUGIN_VERSION constant, which read one release
 * behind the manifest and was read by nothing. A second copy of a version is
 * a second place to forget; the gate refuses any version literal in the
 * source so the runtime can only ever say this.manifest.version.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.PLANNER_ROOT
  ? path.resolve(process.env.PLANNER_ROOT)
  : path.join(__dirname, '..');
const mainPath = process.env.PLANNER_MAIN ? path.resolve(process.env.PLANNER_MAIN) : path.join(root, 'main.js');
const main = fs.readFileSync(mainPath, 'utf8');
// Comments may name past releases as history ("v0.5.0: the badge"); code may not.
const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

test('no version literal exists in main.js', () => {
  assert.doesNotMatch(code, /PLUGIN_VERSION/, 'the duplicate version constant is back');
  assert.doesNotMatch(code, /['"`]v?\d+\.\d+\.\d+['"`]/, 'a quoted semver literal lives in the source');
});

test('the manifest and versions.json agree on the current release', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const versions = JSON.parse(fs.readFileSync(path.join(root, 'versions.json'), 'utf8'));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(versions[manifest.version], `versions.json has no row for ${manifest.version}`);
  assert.equal(versions[manifest.version], manifest.minAppVersion);
});

test('a setting nothing reads is not declared', () => {
  // includeDatelessTasks was declared, defaulted, and never consulted.
  assert.doesNotMatch(main, /includeDatelessTasks/);
});
