/* Opening the board should reveal the tray, once, without fighting the user. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

const state = (o) => Object.assign(
  { autoRevealedThisSession: false, trayLeafExists: false, rightSplitCollapsed: false }, o);

test('first board open on a fresh workspace creates and reveals the tray', () => {
  assert.equal(T.trayRevealDecision(state({})), 'create-and-reveal');
});

test('tray exists but the sidebar is collapsed: reveal it', () => {
  assert.equal(T.trayRevealDecision(state({ trayLeafExists: true, rightSplitCollapsed: true })), 'reveal');
});

test('tray already on screen: leave it alone and do not spend the turn', () => {
  const d = T.trayRevealDecision(state({ trayLeafExists: true }));
  assert.equal(d, 'already-visible');
  assert.equal(T.trayRevealSpendsTurn(d), false,
    'nothing was forced on anyone, so the single nudge is still available later');
});

test('THE RULE: once revealed this session, never again', () => {
  // The user closed the tray or collapsed the sidebar on purpose. Re-opening
  // the board must not reopen it.
  for (const s of [
    { autoRevealedThisSession: true },
    { autoRevealedThisSession: true, trayLeafExists: true, rightSplitCollapsed: true },
    { autoRevealedThisSession: true, trayLeafExists: false },
  ]) {
    assert.equal(T.trayRevealDecision(state(s)), 'none', JSON.stringify(s));
  }
});

test('only a real reveal spends the one-per-session turn', () => {
  assert.equal(T.trayRevealSpendsTurn('create-and-reveal'), true);
  assert.equal(T.trayRevealSpendsTurn('reveal'), true);
  assert.equal(T.trayRevealSpendsTurn('already-visible'), false);
  assert.equal(T.trayRevealSpendsTurn('none'), false);
});

test('a missing state object does not throw', () => {
  assert.equal(T.trayRevealDecision(undefined), 'create-and-reveal');
});
