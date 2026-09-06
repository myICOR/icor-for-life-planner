/* THE IMAP MOBILE GATE (Flint's mobile audit, fix 4).
 *
 * The Starred email (IMAP) settings section offers a host, port, security,
 * self-signed toggle, address, app password and a Test button -- a form
 * whose one write path (imapConnect, elsewhere in this file) already
 * refuses to run anywhere but the desktop app, first statement, before any
 * require. Offering the form on mobile anyway let a member fill it in and
 * meet that refusal only at the first sync, with no field ever having said
 * it could not work.
 *
 * What this proves, and what it cannot: that the settings-tab SOURCE still
 * puts the IMAP form behind `Platform.isDesktopApp` and states the one
 * sentence in its place. Whether the browser then actually hides it needs a
 * real Obsidian and an eye (same limit as design-contract.test.cjs).
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

const settings = main.slice(main.indexOf('class IcorPlannerSettingTab'));
const imapStart = settings.indexOf("setName('Starred email (IMAP)').setHeading()");
const outlookStart = settings.indexOf("/* ---- Outlook (2026-09-06) ---- */");
const imapBlock = settings.slice(imapStart, outlookStart > imapStart ? outlookStart : undefined);

test('the IMAP section exists and sits before the Outlook section', () => {
  assert.ok(imapStart > 0, 'the IMAP heading must be findable');
  assert.ok(outlookStart > imapStart, 'the Outlook section must follow the IMAP section');
});

test('the desktop-app check is the first thing after the IMAP heading, before any field is built', () => {
  const guardAt = imapBlock.indexOf('if (!Platform.isDesktopApp)');
  assert.ok(guardAt > 0, 'Platform.isDesktopApp must be checked right after the IMAP heading');
  // nothing that builds a field (addText, addToggle, addDropdown, a details
  // element, a preset button) may appear before the guard
  const beforeGuard = imapBlock.slice(0, guardAt);
  for (const marker of ["createEl('details'", '.addText(', '.addToggle(', '.addDropdown(', "createEl('button'"]) {
    assert.ok(!beforeGuard.includes(marker), `${marker} appears before the mobile guard`);
  }
});

test('the mobile branch states the one plain sentence and builds no field', () => {
  const guardAt = imapBlock.indexOf('if (!Platform.isDesktopApp) {');
  assert.ok(guardAt >= 0);
  const elseAt = imapBlock.indexOf('} else {', guardAt);
  assert.ok(elseAt > guardAt, 'the guard must have an else branch (the desktop form)');
  const mobileBranch = imapBlock.slice(guardAt, elseAt);
  assert.match(mobileBranch, /Email accounts connect on the desktop\./, 'the exact member sentence must be present');
  for (const marker of ['.addText(', '.addToggle(', '.addDropdown(', "createEl('details'"]) {
    assert.ok(!mobileBranch.includes(marker), `${marker} must not appear in the mobile branch`);
  }
});

test('the desktop branch still builds the full form: host, port, security, self-signed, address, password, test', () => {
  const elseAt = imapBlock.indexOf('} else {');
  assert.ok(elseAt > 0);
  const desktopBranch = imapBlock.slice(elseAt);
  for (const marker of [
    "setName('IMAP host')", "setName('Port')", "setName('Security')",
    "setName('Accept a self-signed certificate')", "setName('Email address')",
    "setName('App password')", "setName('Test connection')",
  ]) {
    assert.ok(desktopBranch.includes(marker), `${marker} is missing from the desktop branch`);
  }
});

test('the IMAP engine guard (imapConnect) is untouched: still Platform.isDesktop, not isDesktopApp', () => {
  // This settings-tab fix is a UI-visibility change; the actual TLS engine's
  // own guard, tested separately in imap-transport.test.cjs, is a different
  // property on purpose (see that file's header) and this fix must not have
  // renamed it.
  const fnStart = main.indexOf('function imapConnect(');
  const fnBody = main.slice(fnStart, main.indexOf('\n}', fnStart));
  assert.match(fnBody, /if \(!Platform\.isDesktop\) return Promise\.reject\(/);
});

test('the sentence carries no em dash or en dash', () => {
  const m = imapBlock.match(/Email accounts connect on the desktop\./);
  assert.ok(m);
  assert.ok(!/[–—]/.test(m[0]));
});
