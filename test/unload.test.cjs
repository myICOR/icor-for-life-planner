/* NOTHING THIS PLUGIN SCHEDULED MAY RUN AFTER IT IS UNLOADED (0.15.1).
 *
 * Found during the 0.14.3 review: `onunload` cleared the cache-write
 * timer and nothing else. A pending 900 ms push check and a pending 1.5 s
 * shadow save both survived the unload, so a disable, an update or a plugin
 * reload could be followed by a write to a source, or by a settings write
 * from an object the next load had already replaced.
 *
 * Watched red against the 0.15.0 bytes.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

const PluginClass = require(T.__mainPath);

// A plugin far enough along to unload, with every timer window() hands out
// recorded so the gate can say exactly which ones were cleared.
function loaded() {
  const cleared = [];
  const hadWindow = 'window' in globalThis;
  const real = hadWindow ? globalThis.window : null;
  let n = 0;
  globalThis.window = {
    setTimeout: () => { n += 1; return n; },
    clearTimeout: (id) => { cleared.push(id); },
    setInterval: () => { n += 1; return n; },
    clearInterval: (id) => { cleared.push(id); },
  };
  const p = Object.create(PluginClass.prototype);
  p.settings = { plannerFolder: '06 Planner' };
  p._pushTimers = new Map([['06 Planner/A.md', 11], ['06 Planner/B.md', 12]]);
  p._shadowSaveTimer = 13;
  p._cacheWriteTimer = 14;
  p.removeNextBadge = () => { };
  p.persistSettings = () => { p.persisted = (p.persisted || 0) + 1; return Promise.resolve(); };
  const restore = () => { if (hadWindow) globalThis.window = real; else delete globalThis.window; };
  return { p, cleared, restore };
}

test('THE DEFECT: onunload clears the push timers and the shadow save, not just the cache write', () => {
  const { p, cleared, restore } = loaded();
  try {
    p.onunload();
    assert.ok(cleared.includes(14), 'the cache write, as before');
    assert.ok(cleared.includes(11) && cleared.includes(12), 'every pending push check');
    assert.ok(cleared.includes(13), 'the pending shadow save');
    assert.equal(p._pushTimers.size, 0, 'and the map is emptied, not left holding dead ids');
    assert.equal(p._shadowSaveTimer, null);
    assert.equal(p._cacheWriteTimer, null);
  } finally { restore(); }
});

test('a shadow save that was still pending is written, not dropped', () => {
  const { p, restore } = loaded();
  try {
    p.onunload();
    assert.equal(p.persisted, 1, 'the 1.5 s debounce must not cost a quit its shadow state');
  } finally { restore(); }
});

test('onunload with nothing pending is quiet and throws nothing', () => {
  const { p, restore } = loaded();
  try {
    p._pushTimers = new Map();
    p._shadowSaveTimer = null;
    p._cacheWriteTimer = null;
    p.onunload();
    assert.equal(p.persisted, undefined, 'no pending save, no write');
  } finally { restore(); }
});
