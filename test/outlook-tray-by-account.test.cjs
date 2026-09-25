/* The tray, grouped by Outlook account.
 *
 * With two or more accounts listed in `outlookAccounts`, the tray's
 * "unscheduled by source" loop renders one OUTLOOK section per account, in
 * list order (default first), each with its own head, count and collapse
 * state. With zero or one account it renders exactly what it always has.
 *
 * Two kinds of gate. The pure ones read traySourceSections, the decision the
 * renderer takes. The rendered ones drive renderSync itself through a small
 * DOM stand-in (Obsidian's createDiv / createEl / createSpan / addClass on
 * top of the plain DOM the cards use) and serialise the tree, so the head
 * text, the counts, the card membership and the collapse class are asserted
 * on what the user would see, not on a regex over the source.
 *
 * Red first. Every test here was watched fail against a main.js without
 * traySourceSections: tests 2-7 on the missing function or the single
 * section. Test 1 is the no-change gate, so it is green there by design;
 * it was watched fail against a copy of this build with the
 * `listed.length < 2` guard changed to `< 1`, which splits a single account
 * into a labelled section and changes the head text.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('./harness.cjs');

/* ---- a DOM small enough to read ---- */
class FakeEl {
  constructor(tag) {
    this.tagName = String(tag).toLowerCase();
    this.children = [];
    this.attrs = {};
    this._classes = [];
    this._text = '';
    this.listeners = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.draggable = false;
    this.value = '';
    this.id = '';
    this.type = '';
    const self = this;
    this.classList = {
      add: (...c) => { for (const x of c) if (x && !self._classes.includes(x)) self._classes.push(x); },
      remove: (...c) => { self._classes = self._classes.filter((x) => !c.includes(x)); },
      contains: (c) => self._classes.includes(c),
      toggle: (c, force) => {
        const on = force === undefined ? !self._classes.includes(c) : !!force;
        if (on) self.classList.add(c); else self.classList.remove(c);
        return on;
      },
    };
  }
  get className() { return this._classes.join(' '); }
  set className(v) { this._classes = String(v || '').split(/\s+/).filter(Boolean); }
  get textContent() {
    return this._text + this.children.map((c) => (c instanceof FakeEl ? c.textContent : c.text)).join('');
  }
  set textContent(v) { this._text = String(v == null ? '' : v); this.children = []; }
  get childElementCount() { return this.children.filter((c) => c instanceof FakeEl).length; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  appendChild(c) { this.children.push(c); return c; }
  appendText(t) { this.children.push({ text: String(t) }); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener() { }
  remove() { }
  focus() { }
  setSelectionRange() { }
  /* Obsidian's helpers, the subset the tray uses. */
  createEl(tag, o) {
    const e = new FakeEl(tag);
    const opt = typeof o === 'string' ? { cls: o } : (o || {});
    if (opt.cls) e.classList.add(...(Array.isArray(opt.cls) ? opt.cls : String(opt.cls).split(/\s+/)));
    if (opt.text != null) e.textContent = opt.text;
    if (opt.attr) for (const [k, v] of Object.entries(opt.attr)) e.setAttribute(k, v);
    if (opt.href != null) e.setAttribute('href', opt.href);
    if (opt.type != null) e.setAttribute('type', opt.type);
    if (opt.placeholder != null) e.setAttribute('placeholder', opt.placeholder);
    if (opt.value != null) e.value = opt.value;
    this.appendChild(e);
    return e;
  }
  createDiv(o) { return this.createEl('div', o); }
  createSpan(o) { return this.createEl('span', o); }
  addClass(...c) { this.classList.add(...c); }
  removeClass(...c) { this.classList.remove(...c); }
  toggleClass(c, on) { this.classList.toggle(c, on); }
  hasClass(c) { return this.classList.contains(c); }
  empty() { this.children = []; this._text = ''; }
  /* A readable projection: what a diff would show. Listeners by type only. */
  toJSON() {
    const out = { tag: this.tagName };
    if (this._classes.length) out.cls = this._classes.join(' ');
    if (Object.keys(this.attrs).length) out.attrs = this.attrs;
    if (this._text) out.text = this._text;
    const ev = Object.keys(this.listeners).sort().map((k) => `${k}:${this.listeners[k].length}`);
    if (ev.length) out.on = ev;
    if (this.draggable) out.draggable = true;
    if (this.children.length) out.kids = this.children.map((c) => (c instanceof FakeEl ? c.toJSON() : { text: c.text }));
    return out;
  }
}

function withDom(fn) {
  const hadDoc = Object.prototype.hasOwnProperty.call(global, 'document');
  const hadWin = Object.prototype.hasOwnProperty.call(global, 'window');
  const prevDoc = global.document;
  const prevWin = global.window;
  global.document = {
    createElement: (t) => new FakeEl(t),
    createElementNS: (ns, t) => new FakeEl(t),
    createTextNode: (t) => ({ text: String(t) }),
    body: new FakeEl('body'),
    querySelectorAll: () => [],
    activeElement: null,
  };
  global.window = { setTimeout: () => 0, clearTimeout: () => { }, open: () => { } };
  try { return fn(); } finally {
    if (hadDoc) global.document = prevDoc; else delete global.document;
    if (hadWin) global.window = prevWin; else delete global.window;
  }
}

/* ---- fixtures ---- */
const TODAY = '2026-09-12';
function item(source, id, extra) {
  const fm = Object.assign({ type: 'planner-item', source, external_id: id, title: `${source} ${id}`, status: 'open' }, extra || {});
  return T.itemFromFrontmatter(fm, `02 Planner/${source}/${id}.md`, String(id));
}
// Twelve notes with no source_account, eight with `us`: two mailboxes in
// one vault. One Todoist item so a second source is in the loop too.
function fixtureItems() {
  const out = [];
  for (let i = 1; i <= 12; i += 1) out.push(item('outlook', `irl-${i}`, { priority: (i % 4) + 1 }));
  for (let i = 1; i <= 8; i += 1) out.push(item('outlook', `us-${i}`, { source_account: 'us', priority: (i % 3) + 1 }));
  out.push(item('todoist', 't-1'));
  return out;
}
const SIGNED_IN = { outlookClientId: 'cid', outlookRefreshToken: 'rt-default', outlookTenant: 'consumers', todoistToken: 'tok' };
const ONE_ACCOUNT = Object.assign({}, SIGNED_IN);
const TWO_ACCOUNTS = Object.assign({}, SIGNED_IN, {
  outlookAccounts: [
    { id: 'default', label: 'Irlpersonal', folder: 'Irlpersonal' },
    { id: 'us', label: 'USpersonal', folder: 'USpersonal', clientId: 'cid', tenant: 'consumers' },
  ],
  outlookRefreshToken__us: 'rt-us',
});

function trayFor(settings, items, opts) {
  const o = opts || {};
  const plugin = {
    withSecrets: () => Object.assign({}, settings),
    syncStatus: o.syncStatus || {},
    settings: { subtaskChecklist: false },
    app: { vault: { getAbstractFileByPath: () => null }, workspace: { getLeaf: () => ({ openFile() { } }) } },
    openPluginSettings() { },
    addManualItem: async () => null,
    toggleDoneLocal() { },
  };
  const view = Object.create(T.PlannerTrayView.prototype);
  view.plugin = plugin;
  view.collapsed = o.collapsed || {};
  view.composerOpen = false;
  view.composerDraft = '';
  view._composerWantsFocus = false;
  view.index = null;
  view.expanded = new Set();
  const root = withDom(() => {
    const el = new FakeEl('div');
    view.renderSync(el, items, TODAY);
    return el;
  });
  return { root, view };
}
// The source sections in render order: [{ head, count, collapsed, cards, note, connect }].
function sections(root) {
  return root.children
    .filter((c) => c instanceof FakeEl && c.hasClass('iplan-tray-section') && c.children[0] && c.children[0].hasClass('is-clickable'))
    .map((sec) => {
      const head = sec.children[0];
      const body = sec.children[1];
      const note = body.children.find((c) => c instanceof FakeEl && c.hasClass('iplan-tray-note'));
      return {
        head: head.children.filter((c) => c instanceof FakeEl && c.tagName === 'span' && !c.hasClass('iplan-source-mark') && !c.hasClass('iplan-tray-count')).map((c) => c.textContent).join(''),
        mark: head.children[0].className,
        count: Number(head.children.find((c) => c instanceof FakeEl && c.hasClass('iplan-tray-count')).textContent),
        collapsed: sec.hasClass('is-collapsed'),
        cards: body.children.filter((c) => c instanceof FakeEl && c.hasClass('iplan-card')).map((c) => c.getAttribute('data-path')),
        note: note ? note.textContent : null,
        connect: note ? (note.children.find((c) => c instanceof FakeEl && c.tagName === 'button') || null) : null,
        headEl: head, secEl: sec,
      };
    });
}
const serial = (root) => JSON.stringify(root.toJSON());

/* ---- 1. the no-change gate ---- */
test('no outlookAccounts, an empty list, or the default alone: the tray is the single OUTLOOK section it always was', () => {
  const items = fixtureItems();
  const base = trayFor(ONE_ACCOUNT, items).root;
  const secs = sections(base);
  const outlook = secs.filter((s) => s.mark.includes('iplan-source-outlook'));
  assert.equal(outlook.length, 1, 'one Outlook section');
  assert.equal(outlook[0].head, ' OUTLOOK', 'the head is the source label alone, no account');
  assert.equal(outlook[0].count, 20, 'every Outlook note, whatever its source_account, is counted in the one section');
  assert.equal(outlook[0].cards.length, 20);
  assert.equal(outlook[0].note, null);
  // The decision the renderer read: one part, keyed and labelled by the source,
  // admitting everything - the single-account shape, spelled out.
  const parts = T.traySourceSections(ONE_ACCOUNT, 'outlook', items);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].key, 'outlook');
  assert.equal(parts[0].label, T.SOURCES.outlook.label);
  assert.equal(parts[0].configured, T.sourceConfigured(ONE_ACCOUNT, 'outlook'));
  assert.ok(items.every((i) => parts[0].member(i)));
  for (const src of T.TASK_SOURCES) {
    const p = T.traySourceSections(ONE_ACCOUNT, src, items);
    assert.equal(p.length, 1, `${src}: one section`);
    assert.equal(p[0].key, src);
    assert.equal(p[0].label, T.SOURCES[src].label);
  }
  // `outlookAccounts: []` and a lone default record are the same single
  // account and render the same bytes.
  const s1 = serial(base);
  assert.equal(serial(trayFor(Object.assign({}, ONE_ACCOUNT, { outlookAccounts: [] }), items).root), s1, 'an empty list changes nothing');
  assert.equal(serial(trayFor(Object.assign({}, ONE_ACCOUNT, { outlookAccounts: [{ id: 'default', label: 'Irlpersonal' }] }), items).root), s1, 'a lone default record changes nothing, label included');
  // And the collapse key is still the bare source id.
  assert.equal(sections(trayFor(ONE_ACCOUNT, items, { collapsed: { outlook: true } }).root).find((s) => s.mark.includes('outlook')).collapsed, true);
  assert.equal(sections(trayFor(ONE_ACCOUNT, items, { collapsed: { 'outlook@us': true } }).root).find((s) => s.mark.includes('outlook')).collapsed, false);
});

/* ---- 2. two accounts, two sections ---- */
test('two accounts: one OUTLOOK section per account, list order, default first, each counting only its own notes', () => {
  const items = fixtureItems();
  const secs = sections(trayFor(TWO_ACCOUNTS, items).root);
  const outlook = secs.filter((s) => s.mark.includes('iplan-source-outlook'));
  assert.equal(outlook.length, 2, 'two Outlook sections');
  assert.equal(outlook[0].head, ' OUTLOOK · IRLPERSONAL');
  assert.equal(outlook[1].head, ' OUTLOOK · USPERSONAL');
  assert.equal(outlook[0].count, 12, 'the notes with no source_account are the default account\'s');
  assert.equal(outlook[1].count, 8, 'the notes stamped us are the us account\'s');
  assert.deepEqual(new Set(outlook[0].cards), new Set(items.filter((i) => i.source === 'outlook' && !i.sourceAccount).map((i) => i.path)));
  assert.deepEqual(new Set(outlook[1].cards), new Set(items.filter((i) => i.sourceAccount === 'us').map((i) => i.path)));
  assert.equal(outlook[0].note, null);
  assert.equal(outlook[1].note, null);
  // The source mark is the source's, on both heads: same glyph, same class.
  assert.equal(outlook[0].mark, outlook[1].mark);
  assert.ok(outlook[0].mark.includes('iplan-source-outlook'));
  // Other sources are untouched: one section each, same head as before.
  const todoist = secs.filter((s) => s.mark.includes('iplan-source-todoist'));
  assert.equal(todoist.length, 1);
  assert.equal(todoist[0].head, ' TODOIST');
  assert.equal(todoist[0].count, 1);
  // Render order follows the list, not the vault: us first when listed first.
  const swapped = Object.assign({}, TWO_ACCOUNTS, { outlookAccounts: [TWO_ACCOUNTS.outlookAccounts[1], TWO_ACCOUNTS.outlookAccounts[0]] });
  const heads = sections(trayFor(swapped, items).root).filter((s) => s.mark.includes('outlook')).map((s) => s.head);
  assert.deepEqual(heads, [' OUTLOOK · USPERSONAL', ' OUTLOOK · IRLPERSONAL']);
});

/* ---- 3. collapse state is per section ---- */
test('collapsing one account\'s section leaves the other open, and the default keeps its old key', () => {
  const items = fixtureItems();
  assert.equal(T.traySectionKey('outlook', 'default'), 'outlook', 'the reserved default keeps the single-account key');
  assert.equal(T.traySectionKey('outlook', 'us'), 'outlook@us');
  const parts = T.traySourceSections(TWO_ACCOUNTS, 'outlook', items);
  assert.deepEqual(parts.map((p) => p.key), ['outlook', 'outlook@us']);
  // A collapse recorded before this build (key `outlook`) still collapses
  // the default's section, and only that one.
  let out = sections(trayFor(TWO_ACCOUNTS, items, { collapsed: { outlook: true } }).root).filter((s) => s.mark.includes('outlook'));
  assert.deepEqual(out.map((s) => s.collapsed), [true, false]);
  out = sections(trayFor(TWO_ACCOUNTS, items, { collapsed: { 'outlook@us': true } }).root).filter((s) => s.mark.includes('outlook'));
  assert.deepEqual(out.map((s) => s.collapsed), [false, true]);
  // Clicking a head flips exactly its own key.
  const { root, view } = trayFor(TWO_ACCOUNTS, items);
  const live = sections(root).filter((s) => s.mark.includes('outlook'));
  live[1].headEl.listeners.click[0]();
  assert.deepEqual(view.collapsed, { 'outlook@us': true });
  assert.equal(live[1].secEl.hasClass('is-collapsed'), true);
  assert.equal(live[0].secEl.hasClass('is-collapsed'), false);
  live[0].headEl.listeners.click[0]();
  assert.deepEqual(view.collapsed, { 'outlook@us': true, outlook: true });
  live[1].headEl.listeners.click[0]();
  assert.deepEqual(view.collapsed, { 'outlook@us': false, outlook: true });
});

/* ---- 4. the sections are honest about their own state ---- */
test('a second account not yet signed in says "Not connected" under its own head, with the Connect button, while the first shows its notes', () => {
  const items = fixtureItems();
  const notYet = Object.assign({}, TWO_ACCOUNTS);
  delete notYet.outlookRefreshToken__us;
  const out = sections(trayFor(notYet, items).root).filter((s) => s.mark.includes('outlook'));
  assert.equal(out[0].note, null, 'the signed-in default says nothing above its cards');
  assert.equal(out[0].cards.length, 12);
  assert.equal(out[1].note.startsWith(T.TRAY_COPY.unconfigured()), true, 'the us section is unconfigured on its own account');
  assert.ok(out[1].connect, 'and carries the Connect button');
  assert.equal(out[1].connect.getAttribute('aria-label'), 'Connect Outlook · USpersonal');
  assert.equal(out[1].cards.length, 8, 'its notes are still listed under it');
  // The pure decision says the same: configured per account, through the
  // account's own view of the settings.
  const parts = T.traySourceSections(notYet, 'outlook', items);
  assert.deepEqual(parts.map((p) => p.configured), [true, false]);
  assert.deepEqual(T.traySourceSections(TWO_ACCOUNTS, 'outlook', items).map((p) => p.configured), [true, true]);
});

test('the one Outlook status row is shown under every section of the source; an empty section says "Nothing unscheduled" on its own count', () => {
  const items = fixtureItems().filter((i) => i.sourceAccount !== 'us');   // nothing for us
  const ok = { ok: true, reason: null, message: null, count: 12, at: 'now' };
  let out = sections(trayFor(TWO_ACCOUNTS, items, { syncStatus: { outlook: ok } }).root).filter((s) => s.mark.includes('outlook'));
  assert.equal(out[0].note, null);
  assert.equal(out[1].count, 0);
  assert.equal(out[1].note, T.TRAY_COPY.empty, 'zero of ITS notes, after a healthy sync');
  // No sync yet: both wait.
  out = sections(trayFor(TWO_ACCOUNTS, [], {}).root).filter((s) => s.mark.includes('outlook'));
  assert.deepEqual(out.map((s) => s.note), [T.TRAY_COPY.unsynced, T.TRAY_COPY.unsynced]);
  // The folded row is one fact about the source and is repeated under each
  // section, mailbox-prefixed message and all (syncNow's first-unhealthy-wins).
  const bad = { ok: false, reason: 'unreachable', message: 'USpersonal: Outlook is unreachable.', hint: 'Try again.', count: 12, at: 'now' };
  out = sections(trayFor(TWO_ACCOUNTS, fixtureItems(), { syncStatus: { outlook: bad } }).root).filter((s) => s.mark.includes('outlook'));
  assert.deepEqual(out.map((s) => s.note), ['USpersonal: Outlook is unreachable.Try again.', 'USpersonal: Outlook is unreachable.Try again.']);
  assert.deepEqual(out.map((s) => s.cards.length), [12, 8], 'the cards stay on screen under the error, as they always did');
});

/* ---- 5. an account the list no longer names ---- */
test('a note whose account nothing lists any more still renders, in a trailing section under its id; an invalid id is unlisted too, never the first mailbox', () => {
  const items = fixtureItems();
  items.push(item('outlook', 'gone-1', { source_account: 'gone' }));
  items.push(item('outlook', 'bad-1', { source_account: 'Not An Id' }));
  const parts = T.traySourceSections(TWO_ACCOUNTS, 'outlook', items);
  assert.deepEqual(parts.map((p) => p.key), ['outlook', 'outlook@us', 'outlook@gone', 'outlook@Not An Id']);
  assert.equal(parts[2].label, 'Outlook · gone');
  assert.equal(parts[2].configured, false, 'a blank account is never signed in');
  assert.equal(parts[3].label, 'Outlook · Not An Id');
  assert.equal(parts[3].configured, false, 'an invalid id is an account nothing lists: not signed in, and not the default');
  const out = sections(trayFor(TWO_ACCOUNTS, items).root).filter((s) => s.mark.includes('outlook'));
  assert.deepEqual(out.map((s) => s.head), [' OUTLOOK · IRLPERSONAL', ' OUTLOOK · USPERSONAL', ' OUTLOOK · GONE', ' OUTLOOK · NOT AN ID']);
  assert.deepEqual(out.map((s) => s.count), [12, 8, 1, 1]);
  assert.ok(!out[0].cards.includes('02 Planner/outlook/bad-1.md'), 'the first mailbox never shows a note with an invalid source_account');
  assert.deepEqual(out[2].cards, ['02 Planner/outlook/gone-1.md']);
  assert.deepEqual(out[3].cards, ['02 Planner/outlook/bad-1.md'], 'the invalid id resolves as outlookAccountById resolves it: an unlisted account of that id');
  // Every Outlook note is in exactly one section.
  const all = out.flatMap((s) => s.cards);
  assert.equal(all.length, new Set(all).size);
  assert.equal(all.length, items.filter((i) => i.source === 'outlook').length);
});

/* ---- 6. the loop only ever splits Outlook, and reads the part for what differs ---- */
test('SOURCE: the by-source loop takes its head label, membership, collapse key and configured from the part', () => {
  const fs = require('node:fs');
  const main = fs.readFileSync(T.__mainPath, 'utf8');
  const start = main.indexOf('/* ---- unscheduled, by source ---- */');
  const end = main.indexOf("const foot = el.createDiv({ cls: 'iplan-tray-foot' });", start);
  assert.ok(start > 0 && end > start);
  const loop = main.slice(start, end);
  assert.match(loop, /for \(const part of traySourceSections\(resolved, key, items\)\) \{/);
  assert.match(loop, /const configured = part\.configured;/);
  assert.match(loop, /i\.source === key && part\.member\(i\) && !i\.plannedDay/);
  assert.match(loop, /headRow\.appendChild\(sourceMarkEl\(key\)\);/, 'the mark is still the source\'s');
  assert.match(loop, /text: ` \$\{part\.label\.toUpperCase\(\)\}`/);
  assert.match(loop, /this\.collapsed\[part\.key\]/);
  assert.doesNotMatch(loop, /this\.collapsed\[key\]/, 'no collapse read on the bare source key remains');
  assert.match(loop, /trayEmptyState\(key, configured, st, list\.length, total, resolved\.secretsInStore === true\)/, 'the empty-state authority is called as before, on the source status row');
  // `total` is still manual's alone; an account section never claims one.
  assert.match(loop, /const total = key === MANUAL_SOURCE\s*\n\s*\? items\.filter\(\(i\) => i\.source === MANUAL_SOURCE\)\.length\s*\n\s*: undefined;/);
});

/* ---- 7. no CR, and nothing else moved ---- */
test('the file stays LF', () => {
  const fs = require('node:fs');
  const buf = fs.readFileSync(T.__mainPath);
  let cr = 0;
  for (const b of buf) if (b === 13) cr += 1;
  assert.equal(cr, 0);
});
