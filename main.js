/* ICOR for Life - Planner - the myPKA Cockpit weekly planner, replicated inside Obsidian.
 *
 * Hand-written CommonJS, no build step. Architecture mirrors the
 * cockpit expansion (REFINE/Expansions/mypka-cockpit) with one structural
 * difference: plan state lives in MARKDOWN FRONTMATTER inside the vault
 * ("02 Planner/"), not in a SQLite sidecar. Every synced task is a note, so
 * the AI team can read and move items by editing frontmatter, and the board
 * re-renders live off metadataCache events.
 *
 * Connector posture (inherited from the cockpit contract, connectors/types.js):
 *   - each connector resolves its own secret from plugin settings and emits a
 *     flat, normalized, SECRET-FREE shape; the board never special-cases a source
 *   - connectors NEVER throw upward: every failure degrades to a calm
 *     { ok:false, reason } and the UI renders a quiet notice, never a crash
 *   - calendar is ALWAYS read-only; task sources are read-only in v1
 *     (completing a card is a local strike-through, never a source write)
 *   - calendar events never become per-event notes, but since 0.5.0 the
 *     parsed defs mirror into ONE cache file ("02 Planner/Calendar Events.md")
 *     so the board renders instantly on relaunch (pale + pulsing until the
 *     fresh fetch lands) and the AI team can read the schedule from the vault.
 *     The cache is SECRET-FREE by contract: event data only, never the ICS
 *     feed URL or its private key.
 *   - reconcile semantics: a task absent from a source's FULL open set on a
 *     healthy fetch is genuinely done -> status: done. On a failed fetch the
 *     files stay untouched (never prune on a blip).
 */
'use strict';

const {
  Plugin, ItemView, PluginSettingTab, Setting, Notice,
  TFile, TFolder, requestUrl, setIcon, normalizePath, Menu, Modal, Platform,
} = require('obsidian');

/* ========================================================================== *
 * Constants
 * ========================================================================== */

const BOARD_VIEW_TYPE = 'icor-for-life-planner-board';
const TRAY_VIEW_TYPE = 'icor-for-life-planner-tray';
// The version lives in manifest.json only (this.manifest.version at runtime).
// A second copy here drifted one release behind and nothing read it. The
// plugin's own folder likewise comes off the manifest (gitignoreLineFor).

// Connector registry. One object per source, and EVERYTHING the rest of the
// plugin knows about a source is derived from it: the presentation (label,
// folder, svg), whether a credential is present (`configured`), how its open
// set is fetched (`fetchOpen`), whether a completion can cross to it
// (`setClosed`), whether note edits can flow back (`pushFields`), and which
// platforms it runs on. Adding a source is adding one entry here plus a
// settings section; no list elsewhere needs to learn about it.
//
// `kind`: 'local' (nothing to fetch, nothing to write), 'task' (fetched into
// per-item notes, reconciled, writable), 'calendar' (fetched into the one
// cache note, always read-only).
//
// The svg paths are the verified single-path monochrome marks from the cockpit
// (SourceMark.tsx, fetched from simple-icons 2026-06-02).
const trimmed = (v) => String(v == null ? '' : v).trim();
const CONNECTORS = {
  // 2026-08-30: manual items. No connector, no credential, no write-back target.
  // It is a first-class source so the board, the tray, the drag logic and the
  // card menu treat a hand-written task exactly like a synced one; everything
  // that would reach outward is gated on SYNCED_SOURCES, never on a negation
  // of 'manual', so a future local source inherits the same protection.
  manual: {
    id: 'manual', label: 'Manual', folder: 'Manual', kind: 'local',
    // A pencil, not a brand mark: the meta row's job is to say where this came
    // from, and "you wrote it" is the answer.
    svg: 'M2 22l1.5-5.5L14.9 5.1l4 4L7.5 20.5 2 22zM16.3 3.7l1.4-1.4a1.9 1.9 0 0 1 2.7 0l1.3 1.3a1.9 1.9 0 0 1 0 2.7l-1.4 1.4-4-4z',
    // Always configured: there is nothing to configure.
    configured: () => true,
    fetchOpen: null, setClosed: null, pushFields: null,
    platforms: ['desktop', 'mobile'],
  },
  todoist: {
    id: 'todoist', label: 'Todoist', folder: 'Todoist', kind: 'task',
    configured: (s) => !!trimmed(s.todoistToken),
    fetchOpen: (s, deps) => todoistFetchOpen(s, deps),
    setClosed: (s, item, closed) => todoistSetClosed(trimmed(s.todoistToken), item.id, closed),
    pushFields: (s, item, pushes) => todoistPushFields(trimmed(s.todoistToken), item.id, pushes),
    doneNotice: (closed) => (closed ? 'Planner: closed in Todoist.' : 'Planner: reopened in Todoist.'),
    platforms: ['desktop', 'mobile'],
    svg: 'M21 0H3C1.35 0 0 1.35 0 3v3.858s3.854 2.24 4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.608 8.136-4.675.279-.161.58-.107.748-.01.164.097.606.348.84.48.232.134.221.502.013.622l-9.712 5.59c-.346.2-.69.204-1.048.002C3.478 10.907.998 9.463 0 8.882v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.008.164.096.606.347.84.48.232.133.221.5.013.62-.208.121-9.288 5.346-9.712 5.59-.346.2-.69.205-1.048.002C3.478 14.951.998 13.506 0 12.926v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.009.164.097.606.348.84.48.232.133.221.502.013.622l-9.712 5.59c-.346.199-.69.204-1.048.001C3.478 18.994.998 17.55 0 16.97V21c0 1.65 1.35 3 3 3h18c1.65 0 3-1.35 3-3V3c0-1.65-1.35-3-3-3z',
  },
  clickup: {
    id: 'clickup', label: 'ClickUp', folder: 'ClickUp', kind: 'task',
    configured: (s) => !!trimmed(s.clickupToken),
    fetchOpen: (s, deps) => clickupFetchOpen(s, deps),
    setClosed: (s, item, closed) => clickupSetClosed(trimmed(s.clickupToken), item.id, item.listId, closed),
    pushFields: (s, item, pushes) => clickupPushFields(trimmed(s.clickupToken), item.id, pushes),
    doneNotice: (closed) => (closed ? 'Planner: closed in ClickUp.' : 'Planner: reopened in ClickUp.'),
    platforms: ['desktop', 'mobile'],
    svg: 'M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z',
  },
  email: {
    id: 'email', label: 'Email', folder: 'Email', kind: 'task',
    configured: (s) => !!(trimmed(s.imapHost) && trimmed(s.imapUser) && trimmed(s.imapPassword)),
    fetchOpen: (s, deps) => emailFetchStarred(s, deps),
    // The star flag is the one write the mailbox ever sees; closing = unstar.
    setClosed: async (s, item, closed, deps) => {
      try {
        await imapSetStarredRaw(imapTransportOptions(s), trimmed(s.imapUser), trimmed(s.imapPassword), item.id, !closed, deps);
      } catch (e) {
        if (/tls unavailable/i.test((e && e.message) || '')) {
          throw new Error('the email star can only be written from the desktop app');
        }
        throw e;
      }
    },
    // Email takes the star flag only, never field writes.
    pushFields: null,
    doneNotice: (closed) => (closed ? 'Planner: unstarred the email.' : 'Planner: starred the email again.'),
    // IMAP needs a raw TLS socket, which the mobile app does not have.
    platforms: ['desktop'],
    // Lucide-style mail outline drawn as a filled-stroke substitute is wrong for a
    // fill-rendered mark, so email uses a simple filled envelope path instead.
    svg: 'M1.5 4.5h21a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-21A1.5 1.5 0 0 1 0 18V6a1.5 1.5 0 0 1 1.5-1.5zm10.5 8.25L2.25 6.375v11.25h19.5V6.375L12 12.75zM3.375 6l8.625 5.625L20.625 6H3.375z',
  },
  calendar: {
    id: 'calendar', label: 'Google Calendar', folder: null, kind: 'calendar', // no per-event notes; one cache file
    configured: (s) => !!trimmed(s.icsUrl),
    fetchOpen: null, setClosed: null, pushFields: null,
    platforms: ['desktop', 'mobile'],
    svg: 'M18.316 5.684H24v12.632h-5.684V5.684zM5.684 24h12.632v-5.684H5.684V24zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684h12.632zm-7.207 6.25v-.065c.272-.144.5-.349.687-.617s.279-.595.279-.982c0-.379-.099-.72-.3-1.025a2.05 2.05 0 0 0-.832-.714 2.703 2.703 0 0 0-1.197-.257c-.6 0-1.094.156-1.481.467-.386.311-.65.671-.793 1.078l1.085.452c.086-.249.224-.461.413-.633.189-.172.445-.257.767-.257.33 0 .602.088.816.264a.86.86 0 0 1 .322.703c0 .33-.12.589-.36.778-.24.19-.535.284-.886.284h-.567v1.085h.633c.407 0 .748.109 1.02.327.272.218.407.499.407.843 0 .336-.129.614-.387.832s-.565.327-.924.327c-.351 0-.651-.103-.897-.311-.248-.208-.422-.502-.521-.881l-1.096.452c.178.616.505 1.082.977 1.401.472.319.984.478 1.538.477a2.84 2.84 0 0 0 1.293-.291c.382-.193.684-.458.902-.794.218-.336.327-.72.327-1.149 0-.429-.115-.797-.344-1.105a2.067 2.067 0 0 0-.881-.689zm2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827l-2.158 1.557zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0zm-3.289 23.5l4.684-4.684h-4.684V23.5zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0v3.289z',
  },
};

// The presentation view of the registry (id, label, folder, svg): what the
// board, the tray and the card menu read. Derived, never hand-kept.
const SOURCES = Object.fromEntries(Object.values(CONNECTORS).map((c) => [
  c.id, { id: c.id, label: c.label, folder: c.folder, svg: c.svg },
]));

// The task sources that have a connector: they own a credential, they are
// fetched, they reconcile, and they can be written back to. MANUAL is
// absent by construction (kind 'local'), and every outward-facing decision
// in the plugin asks this list rather than testing for 'manual' by hand.
const SYNCED_SOURCES = Object.values(CONNECTORS).filter((c) => c.kind === 'task' && c.fetchOpen).map((c) => c.id);
const MANUAL_SOURCE = 'manual';
// Everything that is fetched at all, the calendar included: what the sync
// scheduler asks before it starts a run.
const FETCHED_SOURCES = Object.values(CONNECTORS).filter((c) => c.kind !== 'local').map((c) => c.id);
// Tray render order. Manual leads: it is the one section that works on a vault
// with no keys at all, and the add control lives in it.
const TASK_SOURCES = [MANUAL_SOURCE, ...SYNCED_SOURCES];

function isSyncedSource(source) { return SYNCED_SOURCES.includes(source); }
// Can an edit in the note be pushed outward? Exactly the sources whose
// connector accepts field writes; email takes the star flag only; manual has
// nowhere to go.
function canPushToSource(source) { return !!(CONNECTORS[source] && CONNECTORS[source].pushFields); }
// Can checking the card close something at the source? Exactly the sources
// whose connector can close.
function canCompleteOnSource(source) { return !!(CONNECTORS[source] && CONNECTORS[source].setClosed); }

// Is this source's credential actually present? The ONE authority on the
// question, so the tray, the board notice and the sync scheduler can never
// disagree about whether a source exists. Manual is always configured: there
// is nothing to configure.
//
// Each connector's `configured` mirrors, field for field, the no-token guard
// at the top of its fetch (todoistFetchOpen, clickupFetchOpen,
// emailFetchStarred, calendarFetchDefs). The fetch guard decides whether a
// FETCH runs; this decides what the UI is allowed to claim before any fetch
// has run. They must agree, and the test suite asserts they do.
function sourceConfigured(settings, source) {
  const c = CONNECTORS[source];
  return c ? !!c.configured(settings || {}) : false;
}

const DEFAULT_SETTINGS = {
  // Where the planner lives in the vault: the room folder. Every path the
  // plugin reads or writes derives from this one value (plannerPaths); a
  // renamed room is found on boot (detectPlannerFolder) instead of being
  // recreated empty beside the renamed one.
  plannerFolder: '02 Planner',
  todoistToken: '',
  clickupToken: '',
  clickupTeamId: '',
  imapHost: 'imap.gmail.com',
  imapUser: '',
  imapPassword: '',
  // Transport (Proton Bridge and other local or unusual hosts). The defaults
  // are exactly what every earlier release did: 993, implicit TLS, the
  // certificate verified. The self-signed allowance is honoured for a
  // loopback host only, and that rule is enforced in the transport code,
  // not just in the settings tab.
  imapPort: 993,
  imapSecurity: 'tls',
  imapAllowSelfSigned: false,
  icsUrl: '',
  syncMinutes: 10,
  showWeekend: false,
  splitTime: '13:00',
  lunchEnabled: false,
  lunchStart: '12:30',
  lunchEnd: '13:30',
  dayStart: '08:00',
  dayEnd: '18:00',
  // two-way sync (v0.2.0). completeOnSource is the user's explicit arm switch:
  // checking a card also closes the task at the source / unstars the mail.
  completeOnSource: false,
  // pushEdits: due / priority / description edits in the note flow back to
  // Todoist and ClickUp. Baseline-guarded: only fields the USER changed since
  // the last sync are pushed, so a fresh install never mass-writes.
  pushEdits: true,
  // v0.5.0: the next-event badge under the left ribbon (desktop only).
  showNextBadge: true,
  // Where a recurring task's card lands when its due date moves on to the
  // next occurrence: 'move' puts it on the new due day (keeping its half),
  // 'drop' sends it back to the tray. See syncCompletionPlan.
  recurringAdvance: 'move',
};

const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/* ========================================================================== *
 * Where the planner lives
 *
 * The room name used to be a module constant. Renaming the room made
 * collectItems return nothing, the file-tree click hook stop firing, and the
 * next sync recreate an empty default folder beside the renamed one, all of
 * it silently. Now the folder is a setting, every path derives from it, and
 * boot adopts a renamed room when it is the only candidate.
 * ========================================================================== */

// Validates a typed folder. Pure. Trims, strips surrounding slashes,
// collapses repeated ones; refuses empty, anything under .obsidian, and any
// '.' or '..' segment. Returns { ok, folder, error }.
function normalizePlannerFolder(raw) {
  let f = String(raw == null ? '' : raw).trim().replace(/\\/g, '/');
  f = f.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
  f = normalizePath(f);
  if (!f) return { ok: false, folder: null, error: 'The planner folder cannot be empty.' };
  if (/^\.obsidian(\/|$)/i.test(f)) return { ok: false, folder: null, error: 'The planner folder cannot live inside .obsidian.' };
  if (f.split('/').some((seg) => seg === '.' || seg === '..')) return { ok: false, folder: null, error: 'The planner folder cannot contain "." or ".." segments.' };
  return { ok: true, folder: f, error: null };
}

// Every path the plugin reads or writes, derived from the one setting. Pure.
// An invalid or missing setting falls back to the default, so an older
// data.json without the key behaves exactly as before.
function plannerPaths(settings) {
  const n = normalizePlannerFolder(settings && settings.plannerFolder);
  const root = n.ok ? n.folder : DEFAULT_SETTINGS.plannerFolder;
  return {
    root,
    // One cache file for ALL calendar events (never per-event notes).
    cache: `${root}/Calendar Events.md`,
    sourceFolder: (sourceId) => {
      const src = SOURCES[sourceId];
      return src && src.folder ? `${root}/${src.folder}` : null;
    },
    // A folder boundary, not a prefix: '02 Planner2/x.md' is outside '02 Planner'.
    isInside: (path) => typeof path === 'string' && path.startsWith(`${root}/`),
  };
}

// Boot-time detection. Pure. The configured folder existing wins. Otherwise
// exactly one top-level folder whose name ends in "planner" (any prefix,
// any case) is adopted; several ask; none keeps the setting (ensureFolders
// creates it). Returns { action: 'keep' | 'adopt' | 'ask', folder, candidates }.
function detectPlannerFolder(topLevelFolderNames, configured) {
  const names = Array.isArray(topLevelFolderNames) ? topLevelFolderNames : [];
  if (names.includes(configured)) return { action: 'keep', folder: configured, candidates: [] };
  const candidates = names.filter((n) => /(^|\s)planner$/i.test(String(n)));
  if (candidates.length === 1) return { action: 'adopt', folder: candidates[0], candidates };
  if (candidates.length > 1) return { action: 'ask', folder: configured, candidates };
  return { action: 'keep', folder: configured, candidates: [] };
}

// The settings tab's decision for a folder change. Pure. 'move' renames the
// current folder (link-safe, through fileManager.renameFile); 'switch' just
// points the setting; both existing is refused rather than guessed.
function plannerFolderChangePlan({ current, next, currentExists, nextExists }) {
  if (next === current) return { action: 'noop', reason: 'This is the current folder.' };
  if (currentExists && nextExists) return { action: 'refuse', reason: `Both "${current}" and "${next}" exist. Merge them by hand first, then apply.` };
  if (currentExists && !nextExists) return { action: 'move', reason: `Moves "${current}" and every note in it to "${next}", keeping links intact.` };
  return { action: 'switch', reason: nextExists ? `Uses the existing "${next}".` : `Creates "${next}".` };
}

// The .gitignore line for this plugin's own folder, off the manifest
// (Obsidian sets manifest.dir to the plugin folder; the id is the fallback).
function gitignoreLineFor(manifest) {
  const m = manifest || {};
  const dir = String(m.dir || (m.id ? `.obsidian/plugins/${m.id}` : '')).replace(/\\/g, '/').replace(/\/+$/, '');
  return dir ? `${dir}/` : null;
}

/* ========================================================================== *
 * Date helpers (all in the system-local timezone: the planner runs where the
 * user sits; the cockpit's fixed Berlin zone becomes "wherever this Mac is")
 * ========================================================================== */

function pad2(n) { return String(n).padStart(2, '0'); }

function localDayStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function todayStr() { return localDayStr(new Date()); }

// Monday of the week containing dayStr (ISO week anchor, matches the cockpit).
function mondayOf(dayStr) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const shift = (dt.getDay() + 6) % 7; // Mon=0 .. Sun=6
  dt.setDate(dt.getDate() - shift);
  return localDayStr(dt);
}

function addDays(dayStr, n) {
  const [y, m, d] = dayStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return localDayStr(dt);
}

function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

// Lexical compare is correct for YYYY-MM-DD.
function dayInWeek(day, weekStart) {
  return !!day && day >= weekStart && day < addDays(weekStart, 7);
}

function dueBucketOf(day, today) {
  if (!day) return 'none';
  if (day < today) return 'overdue';
  if (day === today) return 'today';
  return 'upcoming';
}

function fmtWeekLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const [sy, sm, sd] = weekStart.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  if (sm === em) return `${sd} - ${ed} ${months[sm - 1]} ${sy}`;
  if (sy === ey) return `${sd} ${months[sm - 1]} - ${ed} ${months[em - 1]} ${sy}`;
  return `${sd} ${months[sm - 1]} ${sy} - ${ed} ${months[em - 1]} ${ey}`;
}

function fmtDayNum(dayStr) {
  const [, m, d] = dayStr.split('-').map(Number);
  return `${d}.${pad2(m)}.`;
}

function fmtTimeHM(iso) {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Synthetic lane order for a timed calendar event: minutes since local
// midnight of its start (09:30 -> 570). Events are read-only and always sort
// by this; tasks sort by their planned_order and can be dropped around them.
function eventLaneOrder(ev) {
  const d = new Date(ev.start);
  return d.getHours() * 60 + d.getMinutes();
}

// One lane = ONE sequence: timed events (order = start minutes) and task
// cards (order = plannedOrder), ascending; ties put the event first so a task
// dropped "at 09:00" lands below the 09:00 chip. Both entry kinds expose
// `plannedOrder` so orderForInsert can rank over the mixed list. Known and
// accepted: tap-menu planning assigns order = Date.now() (huge), so those
// tasks land after every event; legacy hand orders like 10/20 render above a
// 09:00 (540) event until the next drag renormalizes them.
function laneSequence(laneEvents, cell) {
  const seq = laneEvents
    .map((ev) => ({ kind: 'event', ev, plannedOrder: eventLaneOrder(ev) }))
    .concat(cell.map((it) => ({ kind: 'task', it, path: it.path, plannedOrder: it.plannedOrder })));
  return seq.sort((a, b) => (a.plannedOrder - b.plannedOrder) || (a.kind === b.kind ? 0 : a.kind === 'event' ? -1 : 1));
}

// Minutes that `tz` is ahead of UTC at the given instant (cockpit types.js port).
function tzOffsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

// The UTC instant of local wall-clock time (y,m,d,hh,mm,ss) in IANA zone tz.
// Two-pass offset probe: guess with the offset at the UTC-interpreted instant,
// then re-probe at the corrected instant (handles DST boundaries).
function zonedToUtc(y, m, d, hh, mm, ss, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  let off = tzOffsetMinutes(new Date(guess), tz);
  let inst = guess - off * 60000;
  off = tzOffsetMinutes(new Date(inst), tz);
  return new Date(guess - off * 60000);
}

/* ========================================================================== *
 * Time zone resolution for ICS feeds (2026-09-04)
 *
 * Outlook, Exchange, and any calendar that re-exports a subscription to one
 * of them, write WINDOWS display names into TZID ("W. Australia Standard
 * Time"). Intl rejects those. Until now the rejection was caught and the wall
 * clock was reinterpreted in the machine's own zone, silently: a Perth 08:30
 * rendered as 08:30 on a Sydney machine, two hours early, with no marker.
 *
 * The resolver tries, in order: an IANA id, the CLDR Windows-to-IANA table,
 * a VTIMEZONE block from the feed itself, a fixed offset spelled inside the
 * id ("(UTC+08:00) Perth"). Whatever still fails is FLAGGED (tzUnresolved)
 * and rendered as written, never as a confident guess. A calendar-level
 * X-WR-TIMEZONE fills a MISSING TZID only; it never silently replaces an id
 * the feed did write, because a wrong zone stated with confidence is the
 * exact defect this block exists to remove.
 * ========================================================================== */

// CLDR windowsZones.xml, territory 001 rows only (the canonical IANA id per
// Windows zone). Generated from unicode-org/cldr main at commit c33a1f0a
// (2025-04-10), file typeVersion 2021a, by a one-line script over the XML.
// Regenerate the whole table rather than hand-editing rows.
const WINDOWS_TZ_TO_IANA = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'UTC-11': 'Etc/GMT+11',
  'Aleutian Standard Time': 'America/Adak',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Marquesas Standard Time': 'Pacific/Marquesas',
  'Alaskan Standard Time': 'America/Anchorage',
  'UTC-09': 'Etc/GMT+9',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'UTC-08': 'Etc/GMT+8',
  'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix',
  'Mountain Standard Time (Mexico)': 'America/Mazatlan',
  'Mountain Standard Time': 'America/Denver',
  'Yukon Standard Time': 'America/Whitehorse',
  'Central America Standard Time': 'America/Guatemala',
  'Central Standard Time': 'America/Chicago',
  'Easter Island Standard Time': 'Pacific/Easter',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'SA Pacific Standard Time': 'America/Bogota',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'Eastern Standard Time': 'America/New_York',
  'Haiti Standard Time': 'America/Port-au-Prince',
  'Cuba Standard Time': 'America/Havana',
  'US Eastern Standard Time': 'America/Indianapolis',
  'Turks And Caicos Standard Time': 'America/Grand_Turk',
  'Paraguay Standard Time': 'America/Asuncion',
  'Atlantic Standard Time': 'America/Halifax',
  'Venezuela Standard Time': 'America/Caracas',
  'Central Brazilian Standard Time': 'America/Cuiaba',
  'SA Western Standard Time': 'America/La_Paz',
  'Pacific SA Standard Time': 'America/Santiago',
  'Newfoundland Standard Time': 'America/St_Johns',
  'Tocantins Standard Time': 'America/Araguaina',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'SA Eastern Standard Time': 'America/Cayenne',
  'Argentina Standard Time': 'America/Buenos_Aires',
  'Greenland Standard Time': 'America/Godthab',
  'Montevideo Standard Time': 'America/Montevideo',
  'Magallanes Standard Time': 'America/Punta_Arenas',
  'Saint Pierre Standard Time': 'America/Miquelon',
  'Bahia Standard Time': 'America/Bahia',
  'UTC-02': 'Etc/GMT+2',
  'Azores Standard Time': 'Atlantic/Azores',
  'Cape Verde Standard Time': 'Atlantic/Cape_Verde',
  'UTC': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'Sao Tome Standard Time': 'Africa/Sao_Tome',
  'Morocco Standard Time': 'Africa/Casablanca',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'W. Central Africa Standard Time': 'Africa/Lagos',
  'Jordan Standard Time': 'Asia/Amman',
  'GTB Standard Time': 'Europe/Bucharest',
  'Middle East Standard Time': 'Asia/Beirut',
  'Egypt Standard Time': 'Africa/Cairo',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Syria Standard Time': 'Asia/Damascus',
  'West Bank Standard Time': 'Asia/Hebron',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'FLE Standard Time': 'Europe/Kiev',
  'Israel Standard Time': 'Asia/Jerusalem',
  'South Sudan Standard Time': 'Africa/Juba',
  'Kaliningrad Standard Time': 'Europe/Kaliningrad',
  'Sudan Standard Time': 'Africa/Khartoum',
  'Libya Standard Time': 'Africa/Tripoli',
  'Namibia Standard Time': 'Africa/Windhoek',
  'Arabic Standard Time': 'Asia/Baghdad',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Arab Standard Time': 'Asia/Riyadh',
  'Belarus Standard Time': 'Europe/Minsk',
  'Russian Standard Time': 'Europe/Moscow',
  'E. Africa Standard Time': 'Africa/Nairobi',
  'Iran Standard Time': 'Asia/Tehran',
  'Arabian Standard Time': 'Asia/Dubai',
  'Astrakhan Standard Time': 'Europe/Astrakhan',
  'Azerbaijan Standard Time': 'Asia/Baku',
  'Russia Time Zone 3': 'Europe/Samara',
  'Mauritius Standard Time': 'Indian/Mauritius',
  'Saratov Standard Time': 'Europe/Saratov',
  'Georgian Standard Time': 'Asia/Tbilisi',
  'Volgograd Standard Time': 'Europe/Volgograd',
  'Caucasus Standard Time': 'Asia/Yerevan',
  'Afghanistan Standard Time': 'Asia/Kabul',
  'West Asia Standard Time': 'Asia/Tashkent',
  'Ekaterinburg Standard Time': 'Asia/Yekaterinburg',
  'Pakistan Standard Time': 'Asia/Karachi',
  'Qyzylorda Standard Time': 'Asia/Qyzylorda',
  'India Standard Time': 'Asia/Calcutta',
  'Sri Lanka Standard Time': 'Asia/Colombo',
  'Nepal Standard Time': 'Asia/Katmandu',
  'Central Asia Standard Time': 'Asia/Bishkek',
  'Bangladesh Standard Time': 'Asia/Dhaka',
  'Omsk Standard Time': 'Asia/Omsk',
  'Myanmar Standard Time': 'Asia/Rangoon',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'Altai Standard Time': 'Asia/Barnaul',
  'W. Mongolia Standard Time': 'Asia/Hovd',
  'North Asia Standard Time': 'Asia/Krasnoyarsk',
  'N. Central Asia Standard Time': 'Asia/Novosibirsk',
  'Tomsk Standard Time': 'Asia/Tomsk',
  'China Standard Time': 'Asia/Shanghai',
  'North Asia East Standard Time': 'Asia/Irkutsk',
  'Singapore Standard Time': 'Asia/Singapore',
  'W. Australia Standard Time': 'Australia/Perth',
  'Taipei Standard Time': 'Asia/Taipei',
  'Ulaanbaatar Standard Time': 'Asia/Ulaanbaatar',
  'Aus Central W. Standard Time': 'Australia/Eucla',
  'Transbaikal Standard Time': 'Asia/Chita',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'North Korea Standard Time': 'Asia/Pyongyang',
  'Korea Standard Time': 'Asia/Seoul',
  'Yakutsk Standard Time': 'Asia/Yakutsk',
  'Cen. Australia Standard Time': 'Australia/Adelaide',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'West Pacific Standard Time': 'Pacific/Port_Moresby',
  'Tasmania Standard Time': 'Australia/Hobart',
  'Vladivostok Standard Time': 'Asia/Vladivostok',
  'Lord Howe Standard Time': 'Australia/Lord_Howe',
  'Bougainville Standard Time': 'Pacific/Bougainville',
  'Russia Time Zone 10': 'Asia/Srednekolymsk',
  'Magadan Standard Time': 'Asia/Magadan',
  'Norfolk Standard Time': 'Pacific/Norfolk',
  'Sakhalin Standard Time': 'Asia/Sakhalin',
  'Central Pacific Standard Time': 'Pacific/Guadalcanal',
  'Russia Time Zone 11': 'Asia/Kamchatka',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'UTC+12': 'Etc/GMT-12',
  'Fiji Standard Time': 'Pacific/Fiji',
  'Chatham Islands Standard Time': 'Pacific/Chatham',
  'UTC+13': 'Etc/GMT-13',
  'Tonga Standard Time': 'Pacific/Tongatapu',
  'Samoa Standard Time': 'Pacific/Apia',
  'Line Islands Standard Time': 'Pacific/Kiritimati',
};

// Strip the decorations feeds wrap around a zone id: surrounding quotes, a
// leading slash, the Mozilla and libical registry prefixes, doubled spaces.
function normalizeTzid(raw) {
  let s = String(raw == null ? '' : raw).trim();
  s = s.replace(/^"(.*)"$/, '$1').trim();
  s = s.replace(/^\/(mozilla\.org\/[^/]+\/|freeassociation\.sourceforge\.net\/(Tzfile\/)?)/i, '');
  s = s.replace(/^\//, '');
  return s.replace(/\s+/g, ' ').trim();
}

// "(UTC+08:00) Perth" -> 480, "(UTC-03:30) Newfoundland" -> -210,
// "(UTC) Coordinated Universal Time" -> 0, anything else -> null.
function tzidUtcPrefixOffset(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (/^\(UTC\)/i.test(s)) return 0;
  const m = /^\(UTC([+-])(\d{2}):(\d{2})\)/i.exec(s);
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// RFC 5545 UTC-OFFSET ("+0800", "-0330", "+053000") -> minutes east of UTC.
function icsUtcOffsetToMinutes(s) {
  const m = /^([+-])(\d{2})(\d{2})?(\d{2})?$/.exec(String(s == null ? '' : s).trim());
  if (!m) return null;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

// Does Intl know this id? Memoized: the probe constructs a formatter.
const _ianaProbe = new Map();
function isIanaZone(tz) {
  if (!tz) return false;
  if (_ianaProbe.has(tz)) return _ianaProbe.get(tz);
  let ok = false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ok = true; } catch { ok = false; }
  _ianaProbe.set(tz, ok);
  return ok;
}

// A VTIMEZONE reduced to its two offsets (minutes east of UTC) names a zone
// only by its behaviour, so the search is over the IANA ids the CLDR table
// knows: the first one whose January and July offsets are the same pair, in
// either order (the southern hemisphere has its standard time in July).
const _offsetPairMatch = new Map();
function ianaForOffsets(standardOffset, daylightOffset) {
  const key = `${standardOffset}/${daylightOffset}`;
  if (_offsetPairMatch.has(key)) return _offsetPairMatch.get(key);
  const year = new Date().getFullYear();
  const jan = new Date(Date.UTC(year, 0, 15, 12));
  const jul = new Date(Date.UTC(year, 6, 15, 12));
  let hit = null;
  for (const tz of new Set(Object.values(WINDOWS_TZ_TO_IANA))) {
    if (!isIanaZone(tz)) continue;
    const a = tzOffsetMinutes(jan, tz);
    const b = tzOffsetMinutes(jul, tz);
    if ((a === standardOffset && b === daylightOffset) || (b === standardOffset && a === daylightOffset)) {
      hit = tz;
      break;
    }
  }
  _offsetPairMatch.set(key, hit);
  return hit;
}

// -> { tz: IANA id | null, fixedOffsetMin: minutes | null, unresolved: the id
// as written | null }. Exactly one of tz / fixedOffsetMin / unresolved is set
// for a non-empty id. `ctx.vtimezones` is what parseIcs collected from the
// feed, keyed by the VTIMEZONE's own TZID (raw and normalized).
function resolveTzid(tzid, ctx) {
  const c = ctx || {};
  const raw = String(tzid == null ? '' : tzid).trim();
  const name = normalizeTzid(raw);
  const none = { tz: null, fixedOffsetMin: null, unresolved: null };
  if (!name) return none;
  if (isIanaZone(name)) return { tz: name, fixedOffsetMin: null, unresolved: null };
  const mapped = WINDOWS_TZ_TO_IANA[name];
  if (mapped) return { tz: mapped, fixedOffsetMin: null, unresolved: null };
  const vt = c.vtimezones ? (c.vtimezones[raw] || c.vtimezones[name] || null) : null;
  if (vt) {
    if (vt.standardOffset != null && vt.daylightOffset != null) {
      const tz = ianaForOffsets(vt.standardOffset, vt.daylightOffset);
      if (tz) return { tz, fixedOffsetMin: null, unresolved: null };
    }
    // STANDARD only, or a pair no known zone produces: a fixed offset, no DST.
    if (vt.standardOffset != null) return { tz: null, fixedOffsetMin: vt.standardOffset, unresolved: null };
  }
  const prefixed = tzidUtcPrefixOffset(name);
  if (prefixed != null) return { tz: null, fixedOffsetMin: prefixed, unresolved: null };
  return { tz: null, fixedOffsetMin: null, unresolved: raw };
}

// The one warning line the board shows after a sync with unresolved zones.
// One line for the whole feed, never a Notice per event.
function calendarTzWarning(defs) {
  const flagged = (defs || []).filter((d) => d && d.tzUnresolved);
  if (!flagged.length) return null;
  const n = flagged.length;
  return `${n} event${n === 1 ? ' uses' : 's use'} an unknown time zone (${flagged[0].tzUnresolved}); times are shown as written.`;
}

/* ========================================================================== *
 * Text helpers
 * ========================================================================== */

// A vault-safe file basename from a task title. Windows-illegal + Obsidian-hot
// characters are stripped; length bounded so paths stay sane.
function safeBasename(title) {
  const cleaned = String(title || 'untitled')
    .replace(/[\\/:*?"<>|#^[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70)
    .replace(/[. ]+$/, '');
  return cleaned || 'untitled';
}

// RFC 2047 encoded-word decoder for mail subjects: =?charset?B|Q?data?=
function decodeRfc2047(raw) {
  if (!raw || raw.indexOf('=?') === -1) return raw || '';
  return raw.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=(\s*(?==\?))?/g, (_m, charset, enc, data) => {
    try {
      let bytes;
      if (enc.toUpperCase() === 'B') {
        bytes = Buffer.from(data, 'base64');
      } else {
        const qp = data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x, h) =>
          String.fromCharCode(parseInt(h, 16)));
        bytes = Buffer.from(qp, 'binary');
      }
      const cs = charset.toLowerCase().split('*')[0];
      if (cs === 'utf-8' || cs === 'us-ascii') return bytes.toString('utf8');
      if (cs === 'iso-8859-1' || cs === 'latin1') return bytes.toString('latin1');
      return bytes.toString('utf8'); // best effort for anything else
    } catch {
      return raw;
    }
  });
}

// ICS TEXT unescaping per RFC 5545: \\n -> newline, \\, \\; \\\\ literals.
function icsUnescape(s) {
  return String(s || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\([,;\\])/g, '$1')
    .trim();
}

function hmToMin(hm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
}

// Height of the lunch band in px, scaled to its duration (cockpit break-fill:
// 28px floor so a short break still reads as a band).
function lunchBandHeight(startHM, endHM) {
  const mins = Math.max(0, hmToMin(endHM, 810) - hmToMin(startHM, 750));
  return Math.max(28, Math.round(mins * 0.55));
}

// Google Calendar descriptions arrive as HTML soup. Flatten to readable
// text: brs/blocks to newlines, anchors to "text url", tags stripped,
// entities decoded. Pure regex (no DOM) so it is headless-testable.
function htmlishToText(raw) {
  let x = String(raw || '');
  if (!/<[a-z!\/][^>]*>/i.test(x)) return x;
  x = x
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|tr|h[1-6]|ul|ol)>/gi, '\n')
    .replace(/<a\b[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href, inner) => {
      const txt = inner.replace(/<[^>]+>/g, '').trim();
      return txt && txt !== href ? `${txt} ${href}` : href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
  return x.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Render text into el with bare URLs as clickable anchors.
function linkifyInto(el, text) {
  const parts = String(text || '').split(/(https?:\/\/[^\s<>"']+)/g);
  for (const part of parts) {
    if (/^https?:\/\//.test(part)) {
      const clean = part.replace(/[).,;:!?]+$/, '');
      const trail = part.slice(clean.length);
      const a = el.createEl('a', { text: clean, href: clean });
      a.addEventListener('click', (e) => { e.preventDefault(); window.open(clean, '_external'); });
      if (trail) el.appendChild(document.createTextNode(trail));
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  }
}

// Which board segment is `minsNow` in, and how far along (cockpit countdown).
// Segments derive from dayStart / lunch (or split) / dayEnd. null outside.
function segmentInfo(settings, minsNow) {
  const dayStart = hmToMin(settings.dayStart, 480);
  const dayEnd = hmToMin(settings.dayEnd, 1080);
  const lunchOn = !!settings.lunchEnabled;
  const amEnd = lunchOn ? hmToMin(settings.lunchStart, 750) : hmToMin(settings.splitTime, 780);
  const pmStart = lunchOn ? hmToMin(settings.lunchEnd, 810) : amEnd;
  const seg = (name, a, b) => (minsNow >= a && minsNow < b && b > a)
    ? { name, pct: (minsNow - a) / (b - a), leftMin: b - minsNow } : null;
  return seg('MORNING', dayStart, amEnd) || (lunchOn && seg('LUNCH', amEnd, pmStart)) ||
    seg('AFTERNOON', pmStart, dayEnd) || null;
}

const DAY_TITLES = ['Monday.', 'Tuesday.', 'Wednesday.', 'Thursday.', 'Friday.', 'Saturday.', 'Sunday.'];
function fmtDayTitle(day, today) {
  if (day === today) return 'Today.';
  const [y, m, d] = day.split('-').map(Number);
  return DAY_TITLES[(new Date(y, m - 1, d, 12).getDay() + 6) % 7];
}
function fmtDayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  const idx = (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
  return `${DAY_NAMES[idx]} ${d}.${pad2(m)}.${y}`;
}

// Live pass 2026-08-30: with one task the board footer read "1 OPEN ITEMS",
// and one task is exactly what the first session has. One helper owns the
// string; a gate asserts no second call site hand-builds it.
function fmtOpenItems(count) {
  return count === 1 ? '1 OPEN ITEM' : `${count} OPEN ITEMS`;
}

function fmtLeft(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}H ${pad2(m)}M LEFT` : `${m}M LEFT`;
}

function clampPriorityRank(n) {
  if (n == null || !Number.isFinite(n)) return 5;
  return Math.min(5, Math.max(1, Math.round(n)));
}

/* ========================================================================== *
 * Connector results (cockpit contract: never throw upward)
 * ========================================================================== */

// `hint` (optional) is the second line a failure may carry: what to DO about
// it, when the classifier knows. `warning` (optional) rides a HEALTHY result
// whose data is complete but deserves one line on the board.
function degraded(source, reason, message, hint, docUrl) {
  const out = { ok: false, source, reason, message, items: [] };
  if (hint) out.hint = hint;
  if (docUrl) out.docUrl = docUrl;
  return out;
}
function okResult(source, items, warning) {
  const out = { ok: true, source, items };
  if (warning) out.warning = warning;
  return out;
}

/* ========================================================================== *
 * Three-way merge for two-way fields (due, priority, description).
 * shadow = the value both sides agreed on at the last sync. Per field:
 *   local changed, source unchanged -> PUSH local (keep local in the note)
 *   source changed (local too or not) -> PULL source (source wins conflicts)
 *   neither changed -> nothing
 * No shadow yet (first sync of an item) -> pull everything, seed the shadow.
 * ========================================================================== */

const TWO_WAY_FIELDS = ['due', 'priority', 'description'];

function threeWayMerge(sourceVals, localVals, shadow, pushEnabled) {
  const pushes = {};
  const finals = {};
  const nextShadow = {};
  for (const f of TWO_WAY_FIELDS) {
    const src = sourceVals[f] == null || sourceVals[f] === '' ? (f === 'priority' ? 5 : null) : sourceVals[f];
    const loc = localVals[f] == null || localVals[f] === '' ? (f === 'priority' ? 5 : null) : localVals[f];
    if (!shadow) { finals[f] = src; nextShadow[f] = src; continue; }
    const base = shadow[f] == null || shadow[f] === '' ? (f === 'priority' ? 5 : null) : shadow[f];
    const srcChanged = src !== base;
    const locChanged = loc !== base;
    if (locChanged && !srcChanged && pushEnabled) {
      pushes[f] = loc; finals[f] = loc; nextShadow[f] = loc;
    } else if (srcChanged) {
      finals[f] = src; nextShadow[f] = src;      // source wins (incl. conflicts)
    } else {
      finals[f] = loc; nextShadow[f] = base;      // unchanged, or local kept unpushed
    }
  }
  return { pushes, finals, nextShadow };
}

/* ========================================================================== *
 * Connector: Todoist (unified API v1, Bearer token, cursor pagination)
 * ========================================================================== */

// Todoist API priority is INVERTED: 4 = P1 (highest) .. 1 = none.
function todoistPriorityRank(apiPriority) {
  if (!apiPriority || apiPriority === 1) return apiPriority === 1 ? 4 : 5;
  return clampPriorityRank(5 - apiPriority);
}

async function todoistFetchOpen(settings) {
  const token = (settings.todoistToken || '').trim();
  if (!token) return degraded('todoist', 'no-token', 'Todoist is not connected (no token).');
  const base = 'https://api.todoist.com/api/v1';
  const items = [];
  let cursor = null;
  try {
    for (let page = 0; page < 20; page++) {
      const url = `${base}/tasks?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await requestUrl({
        url, method: 'GET', throw: false,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        return degraded('todoist', 'misconfigured', 'Todoist rejected the token.');
      }
      if (res.status < 200 || res.status >= 300) {
        return degraded('todoist', 'unreachable', `Todoist returned HTTP ${res.status}.`);
      }
      const body = res.json || {};
      for (const t of body.results || []) {
        items.push({
          source: 'todoist',
          id: String(t.id),
          title: t.content || '(untitled)',
          description: (t.description || '').replace(/\s+$/, ''),
          due: t.due && t.due.date ? String(t.due.date).slice(0, 10) : null,
          priority: todoistPriorityRank(t.priority),
          // v1 returns no url field (verified in the cockpit 2026-06-03);
          // the app deep link is constructed from the id.
          url: t.url || `https://app.todoist.com/app/task/${encodeURIComponent(String(t.id))}`,
          tags: Array.isArray(t.labels) ? t.labels : [],
          status: null,
          // The recurrence flag on the Due object is named `is_recurring` in
          // some api/v1 documents and `recurring` in others; both are read so
          // a doc-side rename cannot silently turn every task non-recurring.
          recurring: !!(t.due && (t.due.is_recurring || t.due.recurring)),
          dueString: t.due && t.due.string ? String(t.due.string) : null,
        });
      }
      cursor = body.next_cursor || null;
      if (!cursor) break;
    }
    return okResult('todoist', items);
  } catch (e) {
    return degraded('todoist', 'unreachable', 'Todoist is unreachable.');
  }
}

/* ========================================================================== *
 * Connector: ClickUp (API v2, RAW token in Authorization - no Bearer prefix)
 * ========================================================================== */

async function clickupApi(token, path) {
  const res = await requestUrl({
    url: `https://api.clickup.com/api/v2${path}`,
    method: 'GET', throw: false,
    headers: { Authorization: token },
  });
  if (res.status === 401 || res.status === 403) {
    const err = new Error('auth'); err.auth = true; throw err;
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
  return res.json || {};
}

async function clickupFetchOpen(settings) {
  const token = (settings.clickupToken || '').trim();
  if (!token) return degraded('clickup', 'no-token', 'ClickUp is not connected (no token).');
  try {
    // Who am I - assignee filter derives from the token, never hard-coded.
    const me = await clickupApi(token, '/user');
    const myId = me && me.user && me.user.id;
    if (!myId) return degraded('clickup', 'misconfigured', 'ClickUp: could not derive the user from the token.');

    // Which workspaces - configured id first, else every team on the token.
    let teamIds = [];
    const configured = (settings.clickupTeamId || '').trim();
    if (configured) {
      teamIds = [configured];
    } else {
      const teams = await clickupApi(token, '/team');
      teamIds = ((teams && teams.teams) || []).map((t) => String(t.id));
    }
    if (!teamIds.length) return degraded('clickup', 'misconfigured', 'ClickUp: no workspace visible to this token.');

    const items = [];
    for (const teamId of teamIds) {
      for (let page = 0; page < 20; page++) {
        const qs = new URLSearchParams({
          include_closed: 'false', subtasks: 'false', order_by: 'due_date', page: String(page),
        });
        qs.append('assignees[]', String(myId));
        const data = await clickupApi(token, `/team/${encodeURIComponent(teamId)}/task?${qs.toString()}`);
        const tasks = (data && data.tasks) || [];
        for (const t of tasks) {
          const st = (t.status && t.status.type || '').toLowerCase();
          if (st === 'done' || st === 'closed') continue;
          const dueMs = t.due_date ? Number(t.due_date) : null;
          items.push({
            source: 'clickup',
            id: String(t.id),
            title: t.name || '(untitled)',
            description: ((t.text_content || t.description || '')).replace(/\s+$/, ''),
            due: dueMs && Number.isFinite(dueMs) ? localDayStr(new Date(dueMs)) : null,
            priority: t.priority && t.priority.id != null ? clampPriorityRank(Number(t.priority.id)) : 5,
            url: t.url || null,
            tags: Array.isArray(t.tags) ? t.tags.map((x) => x.name).filter(Boolean) : [],
            status: (t.status && t.status.status) || null,
            listId: t.list && t.list.id ? String(t.list.id) : null,
            // ClickUp's API exposes no recurrence flag (recurrence is an
            // automation, not a task field). Unknown, so the occurrence rule
            // still applies when the due moves forward past its baseline.
            recurring: null,
            dueString: null,
          });
        }
        if (!tasks.length || (data && data.last_page === true)) break;
      }
    }
    return okResult('clickup', items);
  } catch (e) {
    if (e && e.auth) return degraded('clickup', 'misconfigured', 'ClickUp rejected the token.');
    return degraded('clickup', 'unreachable', 'ClickUp is unreachable.');
  }
}

/* ========================================================================== *
 * Source WRITE clients (v0.2.0, armed by settings only; never called
 * otherwise). Every writer throws on failure - callers catch and Notice.
 * ========================================================================== */

// rank 1..5 back to the Todoist API's inverted scale (1=P1 highest -> api 4).
function todoistApiPriority(rank) {
  const r = clampPriorityRank(rank);
  return r >= 5 ? 1 : 5 - r;
}

async function todoistWrite(token, path, payload) {
  const res = await requestUrl({
    url: `https://api.todoist.com/api/v1${path}`,
    method: 'POST', throw: false,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`Todoist HTTP ${res.status}`);
}

async function todoistSetClosed(token, id, closed) {
  await todoistWrite(token, `/tasks/${encodeURIComponent(id)}/${closed ? 'close' : 'reopen'}`);
}

async function todoistPushFields(token, id, pushes) {
  const payload = {};
  if ('description' in pushes) payload.description = pushes.description || '';
  if ('priority' in pushes) payload.priority = todoistApiPriority(pushes.priority);
  if ('due' in pushes) {
    if (pushes.due) payload.due_date = pushes.due;
    else payload.due_string = 'no date';
  }
  if (Object.keys(payload).length) await todoistWrite(token, `/tasks/${encodeURIComponent(id)}`, payload);
}

async function clickupWrite(token, path, payload) {
  const res = await requestUrl({
    url: `https://api.clickup.com/api/v2${path}`,
    method: 'PUT', throw: false,
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`ClickUp HTTP ${res.status}`);
}

// ClickUp has no universal close: statuses are per-list. Resolve the list's
// own done/closed (or open) status name once and cache it for the session.
const _clickupStatusCache = new Map();
async function clickupStatusName(token, listId, wantClosed) {
  const cacheKey = `${listId}`;
  if (!_clickupStatusCache.has(cacheKey)) {
    const res = await requestUrl({
      url: `https://api.clickup.com/api/v2/list/${encodeURIComponent(listId)}`,
      method: 'GET', throw: false, headers: { Authorization: token },
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`ClickUp HTTP ${res.status}`);
    _clickupStatusCache.set(cacheKey, (res.json && res.json.statuses) || []);
  }
  const statuses = _clickupStatusCache.get(cacheKey);
  const byType = (t) => statuses.find((x) => (x.type || '').toLowerCase() === t);
  const hit = wantClosed ? (byType('closed') || byType('done')) : byType('open');
  if (!hit || !hit.status) throw new Error('ClickUp: no matching list status');
  return hit.status;
}

async function clickupSetClosed(token, id, listId, closed) {
  if (!listId) throw new Error('ClickUp: task has no list id yet (resync first)');
  const status = await clickupStatusName(token, listId, closed);
  await clickupWrite(token, `/task/${encodeURIComponent(id)}`, { status });
}

async function clickupPushFields(token, id, pushes) {
  const payload = {};
  if ('description' in pushes) payload.description = pushes.description || '';
  if ('priority' in pushes) {
    const r = clampPriorityRank(pushes.priority);
    payload.priority = r >= 5 ? null : r;
  }
  if ('due' in pushes) {
    if (pushes.due) {
      const [y, m, d] = pushes.due.split('-').map(Number);
      payload.due_date = new Date(y, m - 1, d, 12, 0, 0).getTime();
      payload.due_date_time = false;
    } else {
      payload.due_date = null;
    }
  }
  if (Object.keys(payload).length) await clickupWrite(token, `/task/${encodeURIComponent(id)}`, payload);
}

/* ========================================================================== *
 * Connector: starred email over IMAP (Superhuman = the Gmail/Outlook account
 * underneath; a Superhuman star IS the Gmail star, so IMAP \Flagged reads it).
 * Minimal hand-rolled IMAP client: strictly read-only - EXAMINE (not SELECT),
 * UID SEARCH FLAGGED, UID FETCH of header fields only. No STORE, ever.
 * ========================================================================== */

// Parse an IMAP server stream into complete "entries" respecting {n} literals.
// Returns { lines: [...], rest: bufferedRemainder }. Each entry is the raw text
// of one response line WITH any literal payloads inlined after their marker.
function imapSplitResponses(buf) {
  const entries = [];
  let i = 0;
  while (true) {
    // find CRLF
    const nl = buf.indexOf('\r\n', i);
    if (nl === -1) break;
    let line = buf.slice(i, nl);
    let consumed = nl + 2;
    // literal continuation: line ends with {n}
    let m = /\{(\d+)\}$/.exec(line);
    let full = line;
    let cursor = consumed;
    let incomplete = false;
    while (m) {
      const n = Number(m[1]);
      if (buf.length < cursor + n) { incomplete = true; break; }
      const literal = buf.slice(cursor, cursor + n);
      cursor += n;
      const nl2 = buf.indexOf('\r\n', cursor);
      if (nl2 === -1) { incomplete = true; break; }
      const tail = buf.slice(cursor, nl2);
      cursor = nl2 + 2;
      full += '\n' + literal + tail;
      m = /\{(\d+)\}$/.exec(tail);
    }
    if (incomplete) break;
    entries.push(full);
    i = cursor;
  }
  return { entries, rest: buf.slice(i) };
}

function imapQuote(s) {
  return '"' + String(s).replace(/([\\"])/g, '\\$1') + '"';
}

/* ---- IMAP failure classification (2026-09-04) ------------------------------
 *
 * "IMAP login failed" was the whole story for four different failures: bad
 * credentials, credentials fine but the provider wants an APP password,
 * a certificate problem, and a network problem. Gmail literally answers
 * "NO [ALERT] Application-specific password required: <url>", and that text
 * was thrown away. Now the server's tagged reply and the stage ride the
 * Error, a pure classifier names the failure, and the provider table adds
 * the one sentence that unblocks the common case.
 */

// Host -> provider. `hint` is what to do; `appPasswordUrl` is where. Only
// URLs verified against the provider's own pages are linked; the rest name
// the path inside the app in words.
const IMAP_PROVIDERS = [
  {
    // Proton Bridge listens on the machine itself; a loopback host IS the
    // provider. The password is the one Bridge generates and shows, never
    // the Proton account password.
    id: 'proton-bridge', label: 'Proton Bridge', test: (h) => isLoopbackHost(h),
    appPasswordUrl: null,
    hint: 'Use the mailbox password shown inside the Bridge app, not your Proton password. Bridge must be running.',
  },
  {
    id: 'gmail', label: 'Gmail', test: /gmail|googlemail/i,
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    hint: 'Gmail needs an app password, not your account password. Turn on 2-step verification, then create one at myaccount.google.com/apppasswords.',
  },
  {
    id: 'icloud', label: 'iCloud', test: /imap\.mail\.me\.com|icloud|mac\.com|me\.com/i,
    appPasswordUrl: 'https://account.apple.com/account/manage',
    hint: 'iCloud needs an app-specific password, not your Apple Account password. Create one at account.apple.com under Sign-In and Security, App-Specific Passwords.',
  },
  {
    id: 'outlook', label: 'Outlook / Microsoft 365', test: /outlook|office365|office\.com|hotmail|live\.com/i,
    appPasswordUrl: null,
    hint: 'Microsoft retired password sign-in for IMAP, so Outlook and Microsoft 365 mailboxes cannot connect here yet; they need OAuth, which is on the way. Todoist, ClickUp and the calendar still sync.',
  },
  {
    id: 'fastmail', label: 'Fastmail', test: /fastmail/i,
    appPasswordUrl: null,
    hint: 'Fastmail needs an app password: Settings, Privacy & Security, Integrations, then New app password.',
  },
  {
    id: 'gmx', label: 'GMX', test: /gmx\./i,
    appPasswordUrl: null,
    hint: 'GMX: turn on IMAP in the webmail settings first (E-Mail, Einstellungen, POP3/IMAP Abruf).',
  },
  {
    id: 'webde', label: 'web.de', test: /web\.de/i,
    appPasswordUrl: null,
    hint: 'web.de: turn on IMAP in the webmail settings first (E-Mail, Einstellungen, POP3/IMAP).',
  },
  {
    id: 'yahoo', label: 'Yahoo', test: /yahoo|ymail/i,
    appPasswordUrl: null,
    hint: 'Yahoo needs an app password: Account Info, Account Security, Generate app password.',
  },
];
const IMAP_GENERIC_PROVIDER = { id: 'generic', label: 'IMAP', appPasswordUrl: null, hint: null };

function imapProviderOf(host) {
  const h = String(host == null ? '' : host).trim();
  if (!h) return IMAP_GENERIC_PROVIDER;
  for (const p of IMAP_PROVIDERS) {
    const hit = typeof p.test === 'function' ? p.test(h) : p.test.test(h);
    if (hit) return { id: p.id, label: p.label, appPasswordUrl: p.appPasswordUrl, hint: p.hint };
  }
  return IMAP_GENERIC_PROVIDER;
}

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

// err -> { reason, message, hint, docUrl }. Reasons: auth, auth-app-password,
// auth-oauth-required, tls, dns, refused, timeout, protocol, unsupported.
// Pure: reads err.message / err.code / err.stage / err.serverText and the
// host, touches nothing else.
function classifyImapError(err, host, opts) {
  const e = err || {};
  const port = (opts && opts.port) || 993;
  const msg = String(e.message || '');
  const code = String(e.code || '');
  const serverText = String(e.serverText || '');
  const provider = imapProviderOf(host);
  const out = (reason, message, hint, docUrl) => ({ reason, message, hint: hint || null, docUrl: docUrl || null });
  if (/tls unavailable/i.test(msg)) {
    return out('unsupported', 'Starred email needs the desktop app (IMAP). Todoist, ClickUp and Calendar still sync here.');
  }
  if (provider.id === 'outlook') {
    return out('auth-oauth-required', 'Outlook / Microsoft 365 cannot sign in with a password over IMAP.', provider.hint);
  }
  if (e.stage === 'starttls') {
    return out('protocol', 'The IMAP host does not offer STARTTLS on this port.',
      'Switch the security setting to TLS, or use the port the host offers STARTTLS on. The login was not sent.');
  }
  if (e.stage === 'login' || /^auth$/i.test(msg)) {
    if (/app(lication)?[- ]specific password|app password/i.test(serverText)) {
      const urlInReply = (/https?:\/\/\S+/.exec(serverText) || [null])[0];
      return out('auth-app-password',
        `IMAP login failed: ${provider.label} wants an app password, not your account password.`,
        provider.hint || 'Create an app password in your mail provider\'s security settings and paste it here instead of your normal password.',
        provider.appPasswordUrl || urlInReply);
    }
    if (/AUTHENTICATE|OAuth/i.test(serverText)) {
      return out('auth-oauth-required', 'IMAP login failed: this mailbox wants OAuth sign-in, which this version cannot do.', provider.hint);
    }
    return out('auth', 'IMAP login failed. Check the address and the app password.', provider.hint, provider.appPasswordUrl);
  }
  if (TLS_ERROR_CODES.has(code) || /certificate|self.signed/i.test(msg)) {
    return out('tls', 'The IMAP host presented a certificate this app does not trust.',
      isLoopbackHost(host)
        ? 'A local bridge uses its own certificate. Turn on "Accept a self-signed certificate" (it only ever applies to a host on this machine).'
        : 'A self-signed or expired certificate, or a host name that does not match it. Check the host name; a company or local mail server may need its certificate installed on this machine.');
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return out('dns', 'IMAP host not found.', 'Check the host name for typos.');
  }
  if (code === 'ECONNREFUSED' || /server refused/i.test(msg)) {
    return out('refused', 'IMAP host refused the connection.',
      provider.id === 'proton-bridge' ? provider.hint : `Check that the host accepts IMAP on port ${port}.`);
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg)) {
    return out('timeout', 'IMAP host did not answer in time.', 'Check the network, then the host name.');
  }
  return out('protocol', `IMAP host answered unexpectedly${serverText ? ` (${serverText.slice(0, 80)})` : ''}.`);
}

// Provider presets: one click fills the host and the connection shape for
// the providers people actually use. `imapPresetFields` maps a preset onto
// the settings keys; `imapActivePreset` says which chip is pressed.
const IMAP_PRESETS = [
  { id: 'gmail', label: 'Gmail', host: 'imap.gmail.com', port: 993, security: 'tls', allowSelfSigned: false },
  { id: 'icloud', label: 'iCloud', host: 'imap.mail.me.com', port: 993, security: 'tls', allowSelfSigned: false },
  { id: 'fastmail', label: 'Fastmail', host: 'imap.fastmail.com', port: 993, security: 'tls', allowSelfSigned: false },
  { id: 'proton-bridge', label: 'Proton Bridge', host: '127.0.0.1', port: 1143, security: 'starttls', allowSelfSigned: true },
];
function imapPresetFields(preset) {
  return { imapHost: preset.host, imapPort: preset.port, imapSecurity: preset.security, imapAllowSelfSigned: preset.allowSelfSigned };
}
function imapActivePreset(settings) {
  const opts = imapTransportOptions(settings);
  const hit = IMAP_PRESETS.find((p) => p.host === opts.host && p.port === opts.port && p.security === opts.security);
  return hit ? hit.id : null;
}

// A host on this machine: the only place a self-signed certificate may be
// accepted. 127.0.0.0/8, ::1 and localhost; nothing that merely starts
// with those (127.0.0.1.example.com is a remote host).
function isLoopbackHost(host) {
  const h = trimmed(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}
// An IP literal gets no SNI server name: node rejects a servername that is
// not a host name, and there is no name to verify against anyway.
function isIpLiteral(host) {
  const h = trimmed(host).replace(/^\[|\]$/g, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');
}

// Transport parameters for the mailbox, read once off the settings. Pure.
// The port is clamped to a valid one (else 993), the security to one of the
// two modes (else implicit TLS), and the self-signed allowance is dropped
// here already unless the host is loopback, so a hand-edited data.json
// cannot widen it to a remote host.
function imapTransportOptions(settings) {
  const s = settings || {};
  const host = trimmed(s.imapHost);
  const portN = Number(s.imapPort);
  const port = Number.isInteger(portN) && portN > 0 && portN < 65536 ? portN : 993;
  const security = s.imapSecurity === 'starttls' ? 'starttls' : 'tls';
  const allowSelfSigned = !!s.imapAllowSelfSigned && isLoopbackHost(host);
  return { host, port, security, allowSelfSigned };
}

// The object handed to tls.connect: a direct connection (host + port) or an
// upgrade of an already-open plain socket (STARTTLS). Pure, so the suite
// can read what the transport would be asked to do. Certificate
// verification is on unless the allowance holds AND the host is loopback;
// the second check is deliberate belt over braces.
function imapTlsOptions(opts, socket) {
  const o = { rejectUnauthorized: !(opts.allowSelfSigned && isLoopbackHost(opts.host)) };
  if (socket) o.socket = socket; else { o.host = opts.host; o.port = opts.port; }
  if (!isIpLiteral(opts.host)) o.servername = opts.host;
  return o;
}

// The server would not upgrade: the login is never sent in the clear.
function imapStarttlsError(statusLine) {
  return Object.assign(new Error('server does not offer STARTTLS'), { stage: 'starttls', serverText: String(statusLine || '') });
}

// The one place a mailbox socket is opened, for every session. Resolves
// { socket, greeted }: `greeted` says whether the server's greeting line was
// already consumed here (STARTTLS: yes, the plain greeting was read to get
// the upgrade; implicit TLS: no, the session waits for it). `deps.tls` and
// `deps.net` let a test script the transport, or prove no socket was opened
// at all. Rejects 'tls unavailable' where the runtime has no tls module
// (the mobile app).
//
// STARTTLS: plain connect, read `* OK`, send `A0 STARTTLS`, and ONLY on
// `A0 OK` wrap the socket in TLS. Any other answer (BAD, NO, a PREAUTH
// greeting) rejects before a LOGIN exists; there is no plaintext fallback.
function imapConnect(opts, deps) {
  return new Promise((resolve, reject) => {
    let tlsMod = deps && deps.tls;
    if (!tlsMod) { try { tlsMod = require('tls'); } catch { return reject(new Error('tls unavailable')); } }
    // The one raw TLS call site: a direct connection (no plain socket) or
    // the upgrade of one.
    const secure = (plainSocket) => tlsMod.connect(imapTlsOptions(opts, plainSocket));
    if (opts.security !== 'starttls') {
      let socket;
      try { socket = secure(null); } catch (e) { return reject(e); }
      return resolve({ socket, greeted: false });
    }
    let netMod = deps && deps.net;
    if (!netMod) { try { netMod = require('net'); } catch { return reject(new Error('tls unavailable')); } }
    let plain;
    try { plain = netMod.connect({ host: opts.host, port: opts.port }); } catch (e) { return reject(e); }
    let buffer = '';
    let phase = 'greeting';
    let settled = false;
    const abort = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { plain.destroy(); } catch {}
      reject(err);
    };
    const timer = setTimeout(() => abort(new Error('timeout')), 15000);
    const onError = (err) => abort(err);
    const onData = (chunk) => {
      buffer += chunk.toString('binary');
      const { entries, rest } = imapSplitResponses(buffer);
      buffer = rest;
      for (const entry of entries) {
        if (settled) return;
        if (phase === 'greeting') {
          if (entry.startsWith('* BYE')) return abort(new Error('server refused connection'));
          if (entry.startsWith('* PREAUTH')) return abort(imapStarttlsError(entry));
          if (entry.startsWith('* OK')) { phase = 'starttls'; plain.write('A0 STARTTLS\r\n'); }
          continue;
        }
        if (phase === 'starttls' && entry.startsWith('A0 ')) {
          if (!entry.startsWith('A0 OK')) return abort(imapStarttlsError(entry));
          settled = true;
          clearTimeout(timer);
          plain.removeListener('data', onData);
          plain.removeListener('error', onError);
          let socket;
          try { socket = secure(plain); } catch (e) { try { plain.destroy(); } catch {} return reject(e); }
          return resolve({ socket, greeted: true });
        }
      }
    };
    plain.on('data', onData);
    plain.on('error', onError);
  });
}

// A tagged non-OK reply as an Error that keeps what the server said and
// where in the session it said it; the classifier reads both.
function imapReplyError(stage, statusLine) {
  return Object.assign(new Error(stage === 'login' ? 'auth' : `imap ${stage} failed`), {
    stage, serverText: String(statusLine || ''),
  });
}

// One IMAP session, the only state machine the mailbox ever meets. Connects,
// waits for the greeting, LOGINs, runs `steps` in order, LOGOUTs, resolves
// the shared `ctx`. A step is { stage, cmd(ctx) -> string | null,
// untagged?(entry, ctx) }: `cmd` returning null ends the session early
// (nothing left to ask, for instance no starred mail to fetch). A tagged
// non-OK reply rejects with imapReplyError(stage, line); a `* BYE` greeting
// rejects 'server refused connection'; 20 s of silence rejects 'timeout'.
// The read, the star write and the probe are step lists over this one
// machine, so their greeting / login / error handling cannot drift apart.
function imapSession(opts, user, pass, steps, deps) {
  return new Promise((resolve, reject) => {
    const ctx = {};
    let socket = null;
    let buffer = '';
    let stage = 'connect';
    let tagN = 0;
    let pendingTag = null;
    let stepIndex = -1;
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (socket) { try { socket.destroy(); } catch {} }
      reject(err);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.end(); } catch {}
      resolve(ctx);
    };
    const timer = setTimeout(() => fail(new Error('timeout')), 20000);
    const send = (cmd) => {
      tagN += 1;
      pendingTag = `A${tagN}`;
      socket.write(`${pendingTag} ${cmd}\r\n`);
    };
    const login = () => { stage = 'login'; send(`LOGIN ${imapQuote(user)} ${imapQuote(pass)}`); };
    const logout = () => { stage = 'logout'; send('LOGOUT'); };
    const next = () => {
      stepIndex += 1;
      if (stepIndex >= steps.length) return logout();
      const step = steps[stepIndex];
      let cmd;
      try { cmd = step.cmd(ctx); } catch (e) { return fail(e); }
      if (cmd == null) return logout();
      stage = step.stage;
      send(cmd);
    };
    const onEntry = (entry) => {
      if (stage === 'greeting') {
        if (entry.startsWith('* OK') || entry.startsWith('* PREAUTH')) return login();
        if (entry.startsWith('* BYE')) return fail(new Error('server refused connection'));
        return;
      }
      if (pendingTag && entry.startsWith(`${pendingTag} `)) {
        if (!entry.startsWith(`${pendingTag} OK`)) return fail(imapReplyError(stage, entry));
        if (stage === 'logout') return finish();
        return next();
      }
      const step = stepIndex >= 0 ? steps[stepIndex] : null;
      if (step && step.untagged && entry.startsWith('* ')) {
        try { step.untagged(entry, ctx); } catch (e) { fail(e); }
      }
    };
    imapConnect(opts, deps).then(({ socket: sock, greeted }) => {
      if (settled) { try { sock.destroy(); } catch {} return; }
      socket = sock;
      socket.on('data', (chunk) => {
        buffer += chunk.toString('binary');
        const { entries, rest } = imapSplitResponses(buffer);
        buffer = rest;
        for (const entry of entries) { if (settled) break; onEntry(entry); }
      });
      socket.on('error', (err) => fail(err));
      if (greeted) login(); else stage = 'greeting';
    }, fail);
  });
}

// Raw FETCH entries (header block inlined after the first newline) to the
// normalized item shape, newest first. Pure.
function imapItemsFromFetch(fetched, host) {
  const items = [];
  for (const entry of fetched) {
    const um = /UID (\d+)/.exec(entry);
    const uid = um ? um[1] : null;
    if (!uid) continue;
    const headerText = entry.includes('\n') ? entry.slice(entry.indexOf('\n') + 1) : '';
    const unfolded = headerText.replace(/\r?\n[ \t]+/g, ' ');
    const header = (name) => {
      const hm = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(unfolded);
      return hm ? hm[1].trim() : null;
    };
    const subject = decodeRfc2047(header('Subject') || '') || '(no subject)';
    const from = decodeRfc2047(header('From') || '');
    const date = header('Date');
    const messageId = (header('Message-ID') || '').replace(/^<|>$/g, '');
    const dateLine = date ? (() => { const d = new Date(date); return isNaN(d) ? null : localDayStr(d); })() : null;
    let url = null;
    if (/gmail|googlemail/i.test(host) && messageId) {
      url = `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(messageId)}`;
    }
    items.push({
      source: 'email',
      id: String(uid),
      title: subject,
      description: [from && `From: ${from}`, dateLine && `Received: ${dateLine}`].filter(Boolean).join('\n'),
      due: null,
      priority: 4,
      url,
      tags: [],
      status: null,
      recurring: false,
      dueString: null,
    });
  }
  items.reverse(); // newest first
  return items;
}

// The read script: EXAMINE (read-only), UID SEARCH FLAGGED, one UID FETCH
// of header fields only. Returns normalized task items.
function imapFetchStarredRaw(opts, user, pass, maxItems, deps) {
  const steps = [
    { stage: 'examine', cmd: () => 'EXAMINE INBOX' },
    {
      stage: 'search', cmd: () => 'UID SEARCH FLAGGED',
      untagged: (entry, ctx) => {
        if (entry.startsWith('* SEARCH')) ctx.uids = entry.slice(8).trim().split(/\s+/).filter((x) => /^\d+$/.test(x));
      },
    },
    {
      stage: 'fetch',
      cmd: (ctx) => {
        const uids = ctx.uids || [];
        if (!uids.length) return null;
        return `UID FETCH ${uids.slice(-maxItems).join(',')} (BODY.PEEK[HEADER.FIELDS (SUBJECT FROM DATE MESSAGE-ID)])`;
      },
      untagged: (entry, ctx) => {
        if (/^\* \d+ FETCH/.test(entry)) (ctx.fetched = ctx.fetched || []).push(Buffer.from(entry, 'binary').toString('utf8'));
      },
    },
  ];
  return imapSession(opts, user, pass, steps, deps).then((ctx) => imapItemsFromFetch(ctx.fetched || [], opts.host));
}

// Classifier reason -> connector reason (the contract the UI renders).
function imapReasonToConnector(reason) {
  if (reason === 'no-token') return 'no-token';
  if (reason === 'unsupported') return 'unsupported';
  if (/^auth/.test(reason)) return 'misconfigured';
  return 'unreachable';
}

// What can be said before any socket opens. Pure. Returns null when a
// session is worth trying, else { reason, message, hint, docUrl } in the
// classifier's shape: missing fields, or a host that can never accept a
// password (the failure is known, and a 20 s timeout teaches nothing).
function imapPreflight(opts, user, pass) {
  if (!opts.host || !user || !pass) {
    return { reason: 'no-token', message: 'Starred email is not connected (host, address or app password missing).', hint: null, docUrl: null };
  }
  if (imapProviderOf(opts.host).id === 'outlook') {
    return classifyImapError({ message: 'auth', stage: 'login' }, opts.host, opts);
  }
  return null;
}

async function emailFetchStarred(settings, deps) {
  const opts = imapTransportOptions(settings);
  const user = trimmed(settings.imapUser);
  const pass = trimmed(settings.imapPassword);
  const early = imapPreflight(opts, user, pass);
  if (early) return degraded('email', imapReasonToConnector(early.reason), early.message, early.hint, early.docUrl);
  try {
    const items = await imapFetchStarredRaw(opts, user, pass, 50, deps);
    return okResult('email', items);
  } catch (e) {
    const c = classifyImapError(e, opts.host, opts);
    return degraded('email', imapReasonToConnector(c.reason), c.message, c.hint, c.docUrl);
  }
}

// The probe behind the settings tab's Test connection: LOGIN, then LOGOUT.
// It proves the host, the port, the certificate and the credentials, and it
// never reads a mailbox (no EXAMINE, no SEARCH, no SELECT). Same preflight
// and same classifier as the sync, so the two can never disagree.
async function imapProbe(settings, deps) {
  const opts = imapTransportOptions(settings);
  const user = trimmed(settings.imapUser);
  const pass = trimmed(settings.imapPassword);
  const out = (ok, c) => ({ ok, reason: c.reason || null, message: c.message, hint: c.hint || null, docUrl: c.docUrl || null });
  const early = imapPreflight(opts, user, pass);
  if (early) return out(false, early);
  try {
    await imapSession(opts, user, pass, [], deps);
    return out(true, { message: `Connected as ${user}.` });
  } catch (e) {
    return out(false, classifyImapError(e, opts.host, opts));
  }
}

// The star-write script. Set or clear \Flagged on one message: the ONLY
// write the mailbox ever sees, armed by completeOnSource. SELECT (not
// EXAMINE) + exactly one UID STORE.
function imapSetStarredRaw(opts, user, pass, uid, starred, deps) {
  const steps = [
    { stage: 'select', cmd: () => 'SELECT INBOX' },
    { stage: 'store', cmd: () => `UID STORE ${uid} ${starred ? '+' : '-'}FLAGS (\\Flagged)` },
  ];
  return imapSession(opts, user, pass, steps, deps).then(() => undefined);
}

/* ========================================================================== *
 * Connector: Google Calendar via secret ICS URL (read-only, no OAuth).
 * Minimal RFC 5545 parser + best-effort RRULE expansion for the visible week:
 * FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, BYDAY (weekly), UNTIL,
 * COUNT, EXDATE and RECURRENCE-ID overrides. Exotic rules degrade to "shows
 * the master occurrence only", never to a crash.
 * ========================================================================== */

// The parse context: VTIMEZONE blocks collected from the feed (keyed by their
// TZID, raw and normalized) and the calendar-level default zone from
// X-WR-TIMEZONE, itself resolved through the same chain as every TZID.
function parseIcs(text) {
  // Unfold: CRLF (or LF) followed by space/tab continues the line.
  const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  const ctx = { vtimezones: {}, defaultTz: null };
  let cur = null;       // the open VEVENT
  let vtz = null;       // the open VTIMEZONE
  let vtzPart = null;   // 'STANDARD' | 'DAYLIGHT' while inside one
  let wrTimezone = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { props: [] }; continue; }
    if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
    if (line === 'BEGIN:VTIMEZONE') { vtz = { tzid: null, standardOffset: null, daylightOffset: null }; vtzPart = null; continue; }
    if (line === 'END:VTIMEZONE') {
      if (vtz && vtz.tzid) {
        ctx.vtimezones[vtz.tzid] = vtz;
        ctx.vtimezones[normalizeTzid(vtz.tzid)] = vtz;
      }
      vtz = null; vtzPart = null;
      continue;
    }
    if (vtz && (line === 'BEGIN:STANDARD' || line === 'BEGIN:DAYLIGHT')) { vtzPart = line.slice(6); continue; }
    if (vtz && (line === 'END:STANDARD' || line === 'END:DAYLIGHT')) { vtzPart = null; continue; }
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = left.split(';');
    const params = {};
    for (const p of paramParts) {
      const eq = p.indexOf('=');
      if (eq !== -1) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
    }
    const upper = name.toUpperCase();
    if (vtz) {
      if (upper === 'TZID' && !vtzPart) vtz.tzid = value.trim();
      // Feeds with full history list several STANDARD / DAYLIGHT blocks, oldest
      // first; the last one listed is the rule in force now.
      else if (upper === 'TZOFFSETTO' && vtzPart) {
        const off = icsUtcOffsetToMinutes(value);
        if (off != null) vtz[vtzPart === 'DAYLIGHT' ? 'daylightOffset' : 'standardOffset'] = off;
      }
      continue;
    }
    if (!cur) {
      if (upper === 'X-WR-TIMEZONE') wrTimezone = value.trim();
      continue;
    }
    cur.props.push({ name: upper, params, value });
  }
  if (wrTimezone) ctx.defaultTz = resolveTzid(wrTimezone, ctx).tz || null;
  return events.map((ev) => icsEventDef(ev, ctx)).filter(Boolean);
}

// DTSTART value + params -> { instant: Date|null, day: 'YYYY-MM-DD'|null,
// allDay, tzUnresolved: the TZID as written when no zone could be resolved
// for it (the instant is then the wall clock in the machine's zone) }.
function icsParseDate(value, params, ctx) {
  const isDate = (params.VALUE === 'DATE') || /^\d{8}$/.test(value);
  if (isDate) {
    const y = Number(value.slice(0, 4)), m = Number(value.slice(4, 6)), d = Number(value.slice(6, 8));
    return { allDay: true, day: `${y}-${pad2(m)}-${pad2(d)}`, instant: new Date(y, m - 1, d), tzUnresolved: null };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss, z] = m;
  if (z === 'Z') {
    return { allDay: false, day: null, instant: new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss)), tzUnresolved: null };
  }
  const c = ctx || {};
  const tzid = params.TZID != null && String(params.TZID).trim() !== '' ? String(params.TZID) : null;
  // A missing TZID on a timed value is a floating time; the calendar's own
  // default zone is the right reading of it when the feed states one.
  const res = tzid
    ? resolveTzid(tzid, c)
    : (c.defaultTz ? { tz: c.defaultTz, fixedOffsetMin: null, unresolved: null } : null);
  if (res && res.tz) {
    try {
      return { allDay: false, day: null, instant: zonedToUtc(+y, +mo, +d, +hh, +mm, +ss, res.tz), tzUnresolved: null };
    } catch { /* the probe passed but the formatter did not: flagged below */ }
  }
  if (res && res.fixedOffsetMin != null) {
    const utc = Date.UTC(+y, +mo - 1, +d, +hh, +mm, +ss) - res.fixedOffsetMin * 60000;
    return { allDay: false, day: null, instant: new Date(utc), tzUnresolved: null };
  }
  // Floating (no TZID, no calendar default) or unresolved: the wall clock in
  // the machine's zone. Only the unresolved case carries a flag; a floating
  // time IS a local time by definition.
  return {
    allDay: false, day: null,
    instant: new Date(+y, +mo - 1, +d, +hh, +mm, +ss),
    tzUnresolved: tzid ? tzid.trim() : null,
  };
}

function icsEventDef(ev, ctx) {
  const prop = (n) => ev.props.find((p) => p.name === n) || null;
  const dtstart = prop('DTSTART');
  if (!dtstart) return null;
  const start = icsParseDate(dtstart.value, dtstart.params, ctx);
  if (!start) return null;
  const dtend = prop('DTEND');
  const end = dtend ? icsParseDate(dtend.value, dtend.params, ctx) : null;
  const rruleProp = prop('RRULE');
  const rrule = rruleProp ? Object.fromEntries(
    rruleProp.value.split(';').map((kv) => {
      const eq = kv.indexOf('=');
      return eq === -1 ? [kv, ''] : [kv.slice(0, eq).toUpperCase(), kv.slice(eq + 1)];
    })
  ) : null;
  const exdates = new Set();
  for (const p of ev.props.filter((x) => x.name === 'EXDATE')) {
    for (const v of p.value.split(',')) {
      const parsed = icsParseDate(v.trim(), p.params, ctx);
      if (parsed) exdates.add(parsed.allDay ? parsed.day : localDayStr(parsed.instant));
    }
  }
  const recurrenceId = prop('RECURRENCE-ID');
  return {
    uid: (prop('UID') || { value: `${dtstart.value}-${Math.abs(hashStr(ev.props.map((p) => p.value).join('|')))}` }).value,
    title: icsUnescape((prop('SUMMARY') || { value: '(no title)' }).value) || '(no title)',
    description: icsUnescape((prop('DESCRIPTION') || { value: '' }).value),
    location: icsUnescape((prop('LOCATION') || { value: '' }).value) || null,
    url: ((prop('URL') || { value: '' }).value || '').trim() || null,
    start, end, rrule, exdates,
    // The TZID as written when start or end could not be resolved; the board,
    // the modal and the cache all carry it so the fallback is never silent.
    tzUnresolved: start.tzUnresolved || (end && end.tzUnresolved) || null,
    recurrenceDay: recurrenceId ? (() => {
      const r = icsParseDate(recurrenceId.value, recurrenceId.params, ctx);
      return r ? (r.allDay ? r.day : localDayStr(r.instant)) : null;
    })() : null,
  };
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
  return h;
}

const ICS_BYDAY = { MO: 0, TU: 1, WE: 2, TH: 3, FR: 4, SA: 5, SU: 6 };

// Expand one event def into occurrence start Dates within [winStart, winEnd).
function expandOccurrences(def, winStart, winEnd) {
  const startInstant = def.start.instant;
  if (!def.rrule) {
    return (startInstant < winEnd) ? [startInstant] : [];
  }
  const freq = def.rrule.FREQ;
  const interval = Math.max(1, Number(def.rrule.INTERVAL || 1));
  const count = def.rrule.COUNT ? Number(def.rrule.COUNT) : null;
  let until = null;
  if (def.rrule.UNTIL) {
    const u = icsParseDate(def.rrule.UNTIL, {}, null); // UNTIL is UTC or date-only by spec
    until = u ? (u.allDay ? new Date(u.instant.getTime() + 86400000) : u.instant) : null;
  }
  const out = [];
  let produced = 0;
  const push = (d) => {
    if (until && d > until) return false;
    produced += 1;
    if (count && produced > count) return false;
    if (d >= winStart && d < winEnd) out.push(d);
    return true;
  };
  const HARD_CAP = 2000;
  if (freq === 'DAILY') {
    for (let i = 0, d = new Date(startInstant); i < HARD_CAP && d < winEnd; i++, d = new Date(d.getTime() + interval * 86400000)) {
      if (!push(new Date(d))) break;
    }
  } else if (freq === 'WEEKLY') {
    const bydays = def.rrule.BYDAY
      ? def.rrule.BYDAY.split(',').map((x) => ICS_BYDAY[x.trim()]).filter((x) => x != null)
      : [(startInstant.getDay() + 6) % 7];
    // Walk week by week from the start's Monday.
    let weekAnchor = new Date(startInstant);
    weekAnchor.setDate(weekAnchor.getDate() - ((weekAnchor.getDay() + 6) % 7));
    for (let w = 0; w < HARD_CAP / 7; w++) {
      let stop = false;
      for (const wd of [...bydays].sort((a, b) => a - b)) {
        const d = new Date(weekAnchor);
        d.setDate(d.getDate() + wd);
        d.setHours(startInstant.getHours(), startInstant.getMinutes(), startInstant.getSeconds(), 0);
        if (d < startInstant) continue;
        if (d >= winEnd && !until && !count) { stop = true; break; }
        if (!push(d)) { stop = true; break; }
      }
      if (stop) break;
      weekAnchor = new Date(weekAnchor.getTime() + interval * 7 * 86400000);
      if (weekAnchor >= winEnd) break;
    }
  } else if (freq === 'MONTHLY') {
    const dom = startInstant.getDate();
    for (let i = 0; i < 240; i++) {
      const d = new Date(startInstant);
      d.setMonth(d.getMonth() + i * interval);
      if (d.getDate() !== dom) continue; // month overflow (e.g. 31st) - skip
      if (d >= winEnd && !until && !count) break;
      if (!push(d)) break;
    }
  } else if (freq === 'YEARLY') {
    for (let i = 0; i < 50; i++) {
      const d = new Date(startInstant);
      d.setFullYear(d.getFullYear() + i * interval);
      if (d >= winEnd && !until && !count) break;
      if (!push(d)) break;
    }
  } else {
    return (startInstant >= winStart && startInstant < winEnd) ? [startInstant] : [];
  }
  return out;
}

// Expand parsed defs to per-day event cards for one week.
function icsEventsForWeek(defs, weekStart, splitHour) {
  const winStart = (() => { const [y, m, d] = weekStart.split('-').map(Number); return new Date(y, m - 1, d); })();
  const winEnd = new Date(winStart.getTime() + 7 * 86400000);
  const out = [];
  const overrides = new Map(); // uid::day -> def (RECURRENCE-ID edits)
  for (const def of defs) {
    if (def.recurrenceDay) overrides.set(`${def.uid}::${def.recurrenceDay}`, def);
  }
  for (const def of defs) {
    if (def.recurrenceDay) continue; // rendered via its master's expansion
    const durationMs = (def.end && def.end.instant && def.start.instant)
      ? Math.max(0, def.end.instant.getTime() - def.start.instant.getTime())
      : (def.start.allDay ? 86400000 : 0);
    const occurrences = expandOccurrences(def, winStart, winEnd);
    for (const occStart of occurrences) {
      const occDay = def.start.allDay && !def.rrule ? def.start.day : localDayStr(occStart);
      if (def.exdates.has(occDay)) continue;
      const ov = overrides.get(`${def.uid}::${occDay}`);
      const eff = ov || def;
      const effStart = ov ? ov.start.instant : occStart;
      const effEnd = ov && ov.end ? ov.end.instant : new Date(effStart.getTime() + durationMs);
      const allDay = eff.start.allDay;
      // Raw pieces for the Google Calendar deep link (built lazily in the
      // detail modal): master UID, whether this is an expanded recurrence,
      // and the ORIGINAL occurrence start (the recurrence id Google keys on;
      // an override's edited start is deliberately not used here).
      const recurring = !!def.rrule;
      const occStartUtc = allDay
        ? occDay.replace(/-/g, '')
        : occStart.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
      const tzUnresolved = eff.tzUnresolved || def.tzUnresolved || null;
      if (allDay) {
        // DTEND is exclusive for all-day events; emit one card per spanned day.
        const startDay = ov ? ov.start.day : occDay;
        const nDays = Math.max(1, Math.round(durationMs / 86400000));
        for (let i = 0; i < nDays; i++) {
          const day = addDays(startDay, i);
          if (!dayInWeek(day, weekStart)) continue;
          out.push({
            kind: 'event', source: 'calendar',
            uid: `${def.uid}::${day}`, title: eff.title, description: eff.description,
            start: null, end: null, allDay: true, day, half: null,
            location: eff.location, url: eff.url, continues: i > 0,
            masterUid: def.uid, recurring, occStartUtc, tzUnresolved,
          });
        }
      } else {
        const startDay = localDayStr(effStart);
        const endDayInclusive = localDayStr(new Date(Math.max(effStart.getTime(), effEnd.getTime() - 1)));
        let day = startDay;
        let first = true;
        while (day <= endDayInclusive) {
          if (dayInWeek(day, weekStart)) {
            out.push({
              kind: 'event', source: 'calendar',
              uid: `${def.uid}::${occStart.toISOString()}${first ? '' : `::${day}`}`,
              title: eff.title, description: eff.description,
              start: effStart.toISOString(), end: effEnd.toISOString(),
              allDay: !first, day,
              half: first ? (effStart.getHours() < splitHour ? 'am' : 'pm') : null,
              location: eff.location, url: eff.url, continues: !first,
              masterUid: def.uid, recurring, occStartUtc, tzUnresolved,
            });
          }
          day = addDays(day, 1);
          first = false;
        }
      }
    }
  }
  out.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    return String(a.start) < String(b.start) ? -1 : 1;
  });
  return out;
}

async function calendarFetchDefs(settings) {
  let raw = (settings.icsUrl || '').trim();
  if (!raw) return degraded('calendar', 'no-token', 'Calendar is not connected (no iCal URL).');
  if (/^webcal:\/\//i.test(raw)) raw = raw.replace(/^webcal:\/\//i, 'https://');
  if (!/^https:\/\//i.test(raw)) {
    return degraded('calendar', 'misconfigured', 'Calendar URL must be https:// (or webcal://).');
  }
  try {
    const res = await requestUrl({ url: raw, method: 'GET', throw: false, headers: { Accept: 'text/calendar' } });
    if (res.status < 200 || res.status >= 300) {
      return degraded('calendar', 'unreachable', `Calendar feed returned HTTP ${res.status}.`);
    }
    const defs = parseIcs(res.text || '');
    // Healthy fetch, but some zones could not be resolved: the result stays
    // ok (the events render, as written) and carries ONE warning line.
    return okResult('calendar', defs, calendarTzWarning(defs));
  } catch {
    return degraded('calendar', 'unreachable', 'Calendar feed unreachable.');
  }
}

/* ========================================================================== *
 * Calendar event cache (v0.5.0) - the parsed defs mirror into ONE vault file
 * (the cache note under the planner folder) so relaunch renders instantly from the last healthy
 * fetch. File shape: YAML frontmatter, a human/AI-readable list of the next
 * ~14 days, then a fenced ```json block holding the FULL serialized defs
 * array for exact rehydration (Date instants as ISO strings; rrule / exdates
 * / overrides preserved so icsEventsForWeek reproduces identical output).
 * HARD RULE: the cache never contains the ICS feed URL or its private key -
 * event data only. A malformed cache is ignored; the next fetch rebuilds it.
 * ========================================================================== */

// Meeting-URL detection: scan location, then description, then the URL
// property; inside a field, pattern order decides (first match wins). The
// character class stops at whitespace and quotes so URLs inside Google's
// HTML-soup descriptions come out clean.
const CONFERENCE_URL_PATTERNS = [
  /https?:\/\/[^\s<>"']*zoom\.us\/(?:j|my)\/[^\s<>"']+/i,
  /https?:\/\/meet\.google\.com\/[^\s<>"']+/i,
  /https?:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"']+/i,
  /https?:\/\/teams\.live\.com\/[^\s<>"']+/i,
  /https?:\/\/[^\s<>"']*webex\.com\/(?:meet|join)\/[^\s<>"']+/i,
  /https?:\/\/whereby\.com\/[^\s<>"']+/i,
  /https?:\/\/meet\.jit\.si\/[^\s<>"']+/i,
];

// ev needs only { location, description, url } - works for defs AND for the
// expanded per-day events. Returns the clean URL or null.
function detectConferenceUrl(ev) {
  if (!ev) return null;
  for (const field of [ev.location, ev.description, ev.url]) {
    if (!field) continue;
    const text = String(field);
    for (const re of CONFERENCE_URL_PATTERNS) {
      const m = re.exec(text);
      if (m) return m[0].replace(/[).,;:!?]+$/, '');
    }
  }
  return null;
}

function serializeIcsDate(x) {
  if (!x) return null;
  return {
    allDay: !!x.allDay,
    day: x.day || null,
    instant: x.instant instanceof Date && !isNaN(x.instant) ? x.instant.toISOString() : null,
  };
}
function reviveIcsDate(x) {
  if (!x || typeof x !== 'object') return null;
  return {
    allDay: !!x.allDay,
    day: x.day || null,
    instant: x.instant ? new Date(x.instant) : null,
  };
}

// defs (from parseIcs) -> plain-JSON array. conferenceUrl is derived and
// stored per def so the vault copy carries it explicitly for the AI team.
function serializeCalendarDefs(defs) {
  return (defs || []).map((def) => ({
    uid: def.uid,
    title: def.title,
    description: def.description || '',
    location: def.location || null,
    url: def.url || null,
    conferenceUrl: detectConferenceUrl(def),
    start: serializeIcsDate(def.start),
    end: serializeIcsDate(def.end),
    rrule: def.rrule || null,
    exdates: Array.from(def.exdates || []),
    recurrenceDay: def.recurrenceDay || null,
    tzUnresolved: def.tzUnresolved || null,
  }));
}

// plain-JSON array -> defs identical (for expansion purposes) to parseIcs
// output. Returns null when the payload is not an array; skips broken rows.
function reviveCalendarDefs(raw) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object' || !d.start) continue;
    const start = reviveIcsDate(d.start);
    if (!start || (!start.allDay && !(start.instant instanceof Date && !isNaN(start.instant)))) continue;
    out.push({
      uid: String(d.uid || ''),
      title: String(d.title || '(no title)'),
      description: String(d.description || ''),
      location: d.location || null,
      url: d.url || null,
      conferenceUrl: d.conferenceUrl || null,
      start,
      end: reviveIcsDate(d.end),
      rrule: d.rrule && typeof d.rrule === 'object' ? d.rrule : null,
      exdates: new Set(Array.isArray(d.exdates) ? d.exdates : []),
      recurrenceDay: d.recurrenceDay || null,
      tzUnresolved: d.tzUnresolved ? String(d.tzUnresolved) : null,
    });
  }
  return out;
}

// The full cache file content. `now` is injectable so tests are deterministic.
function buildCalendarCacheContent(defs, now, plannerFolder) {
  const serialized = serializeCalendarDefs(defs);
  const today = localDayStr(now);
  const lines = [
    '---',
    'type: calendar-cache',
    'source: google-calendar-ics',
    `updated_at: ${now.toISOString()}`,
    `events: ${serialized.length}`,
    // So an agent reading this note knows where the item notes live.
    ...(plannerFolder ? [`planner_folder: ${JSON.stringify(plannerFolder)}`] : []),
    '---',
    '',
    '# Calendar Events',
    '',
    'Last synced calendar state, written by the ICOR for Life - Planner plugin on every',
    'healthy fetch (may be minutes stale). Safe to read for schedule context;',
    'it never contains the calendar feed URL or any secret. Do not edit: the',
    'next sync overwrites this file.',
    '',
    `## Upcoming (${today} to ${addDays(today, 13)})`,
    '',
  ];
  // Reuse the board's own expansion so the readable list and the board agree.
  const w0 = mondayOf(today);
  const events = icsEventsForWeek(defs, w0, 13)
    .concat(icsEventsForWeek(defs, addDays(w0, 7), 13))
    .concat(icsEventsForWeek(defs, addDays(w0, 14), 13))
    .filter((ev) => ev.day >= today && ev.day < addDays(today, 14));
  let lastDay = null;
  for (const ev of events) {
    if (ev.day !== lastDay) {
      lines.push(`### ${fmtDayLabel(ev.day)}`);
      lastDay = ev.day;
    }
    const when = ev.allDay || !ev.start
      ? (ev.continues ? 'CONT.' : 'ALL DAY')
      : `${fmtTimeHM(ev.start)}-${fmtTimeHM(ev.end)}`;
    const conf = detectConferenceUrl(ev);
    // [tz?]: the feed named a zone the plugin could not resolve; the time is
    // the wall clock as written, in the machine's zone.
    const bits = [`- ${when} ${ev.title}${ev.tzUnresolved ? ' [tz?]' : ''}`];
    if (ev.location) bits.push(`  - location: ${ev.location}`);
    if (conf) bits.push(`  - conference: ${conf}`);
    lines.push(...bits);
  }
  if (!events.length) lines.push('No events in the next 14 days.');
  lines.push('', '## Serialized defs (for the plugin - do not edit)', '', '```json', JSON.stringify(serialized), '```', '');
  return lines.join('\n');
}

// Cache file content -> revived defs, or null on any malformed shape.
function parseCalendarCacheContent(text) {
  const m = /```json\s*\n([\s\S]*?)\n```/.exec(String(text || ''));
  if (!m) return null;
  try { return reviveCalendarDefs(JSON.parse(m[1])); } catch { return null; }
}

/* ========================================================================== *
 * Next-event badge helpers (v0.5.0)
 * ========================================================================== */

// From expanded per-day events: a RUNNING timed event wins (badge says NOW),
// else the next timed event whose start is in the future. All-day events and
// continuation rows are skipped. Returns the event or null.
function nextUpcomingEvent(events, now) {
  const t = now.getTime();
  let running = null;
  let next = null;
  for (const ev of events || []) {
    if (ev.allDay || !ev.start || !ev.end || ev.continues) continue;
    const s = new Date(ev.start).getTime();
    const e = new Date(ev.end).getTime();
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (s <= t && t < e) {
      if (!running || s < new Date(running.start).getTime()) running = ev;
    } else if (s > t) {
      if (!next || s < new Date(next.start).getTime()) next = ev;
    }
  }
  return running || next;
}

// Countdown label for the badge. Under 5 minutes it switches to M:SS (the
// caller also switches the tick to 1s there); running events read NOW.
function fmtBadgeCountdown(ev, now) {
  const s = new Date(ev.start).getTime();
  const t = now.getTime();
  if (s <= t) return 'NOW';
  const leftMs = s - t;
  if (leftMs <= 5 * 60000) {
    const totalSec = Math.max(0, Math.round(leftMs / 1000));
    return `IN ${Math.floor(totalSec / 60)}:${pad2(totalSec % 60)}`;
  }
  const mins = Math.round(leftMs / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `IN ${d}D ${h}H`;
  if (h > 0) return `IN ${h}H ${pad2(m)}M`;
  return `IN ${m}M`;
}

/* ========================================================================== *
 * Item store - synced tasks live as markdown notes under <planner folder>/<Source>/.
 * Frontmatter is the plan database (the cockpit's plan_assignments analog):
 *   type: planner-item        source / external_id  - identity (idempotency key)
 *   status: open|done         - SOURCE truth, written by reconcile
 *   planned_day / planned_half / planned_order - the board placement
 *   done_local / weekly_goal  - planner-local flags (never written to source)
 * The AI team edits the same fields to move items; the board re-renders live.
 * ========================================================================== */

// The normalizer, pure and shared: one place decides what a frontmatter block
// MEANS, so a manual item and a synced item are the same shape by
// construction rather than by two code paths agreeing. Everything downstream
// (board, tray, drag, menus) reads this output and nothing else.
function itemFromFrontmatter(fm, path, basename) {
  if (!fm || fm.type !== 'planner-item' || !fm.source || fm.external_id == null) return null;
  // priority: an ABSENT or EMPTY value means "no priority" (rank 5). Number(null)
  // and Number('') are both 0, which clampPriorityRank would floor up to 1 (the
  // TOP rank) - so the absent case must be caught before the coercion, never
  // after it. Manual items are the first items that can legitimately carry a
  // hand-cleared priority, which is how this surfaced.
  const rawPriority = fm.priority;
  const priority = (rawPriority == null || rawPriority === '')
    ? 5 : clampPriorityRank(Number(rawPriority));
  return {
    path,
    source: String(fm.source),
    id: String(fm.external_id),
    title: fm.title != null ? String(fm.title) : basename,
    status: fm.status === 'done' ? 'done' : 'open',
    due: fm.due ? String(fm.due).slice(0, 10) : null,
    priority,
    url: fm.url ? String(fm.url) : null,
    tags: Array.isArray(fm.tags) ? fm.tags.map(String) : [],
    sourceStatus: fm.source_status != null ? String(fm.source_status) : null,
    listId: fm.list_id != null ? String(fm.list_id) : null,
    plannedDay: fm.planned_day ? String(fm.planned_day).slice(0, 10) : null,
    plannedHalf: fm.planned_half === 'am' || fm.planned_half === 'pm' ? fm.planned_half : null,
    plannedOrder: Number.isFinite(Number(fm.planned_order)) ? Number(fm.planned_order) : 0,
    doneLocal: fm.done_local === true,
    weeklyGoal: fm.weekly_goal === true,
    // Recurrence (2026-09-04). `recurring` is three-valued on purpose: true,
    // false, or null for "unknown" (a note from before the field existed, or
    // a ClickUp task, whose API has no flag). The occurrence rule treats
    // unknown as recurring; see occurrenceAdvanced.
    recurring: fm.recurring === true ? true : (fm.recurring === false ? false : null),
    dueString: fm.due_string != null && fm.due_string !== '' ? String(fm.due_string) : null,
    // The uncheck-after-sync signal: the card was reopened here and the
    // source has not confirmed yet. Reconcile must not re-close it meanwhile.
    reopenPending: fm.reopen_pending === true,
    lastCompletedDue: fm.last_completed_due ? String(fm.last_completed_due).slice(0, 10) : null,
    occurrences: normalizeOccurrences(fm.occurrences),
  };
}

// `occurrences` in frontmatter: the finished occurrences of a recurring task,
// oldest first, capped. Each row is { due, planned_day, planned_half, done_at }
// in the note and camelCase here; a malformed row is dropped, never thrown on.
function normalizeOccurrences(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const o of raw) {
    if (!o || typeof o !== 'object') continue;
    out.push({
      due: o.due ? String(o.due).slice(0, 10) : null,
      plannedDay: o.planned_day ? String(o.planned_day).slice(0, 10) : null,
      plannedHalf: o.planned_half === 'am' || o.planned_half === 'pm' ? o.planned_half : null,
      doneAt: o.done_at ? String(o.done_at) : null,
    });
  }
  return out;
}

function itemFromFile(app, file) {
  const cache = app.metadataCache.getFileCache(file);
  const item = itemFromFrontmatter(cache && cache.frontmatter, file.path, file.basename);
  if (item) item.file = file;
  return item;
}
function collectItems(app, rootPath) {
  const root = app.vault.getAbstractFileByPath(rootPath);
  const items = [];
  const walk = (folder) => {
    for (const child of folder.children || []) {
      if (child instanceof TFolder) walk(child);
      else if (child instanceof TFile && child.extension === 'md') {
        const it = itemFromFile(app, child);
        if (it) items.push(it);
      }
    }
  };
  if (root instanceof TFolder) walk(root);
  return items;
}

// effective completion: struck when locally checked OR the source closed it
function isDone(item) { return item.doneLocal || item.status === 'done'; }

/* ========================================================================== *
 * Manual items (2026-08-30)
 *
 * A task typed straight into the tray. It is a planner-item like any other,
 * with source: manual and an external_id that CANNOT collide with a synced
 * one: the id is namespaced by the literal 'manual-' prefix, which no Todoist
 * id (digits or a 16-char base62 token), ClickUp id (base36, no hyphen) or
 * IMAP UID (digits) can ever produce. Identity is the (source, external_id)
 * pair, so the prefix is belt on top of braces - it means a hand-edited
 * `source:` field still cannot make a manual note shadow a synced one.
 *
 * Two hard rules, both enforced by SYNCED_SOURCES rather than by testing for
 * the string 'manual':
 *   - a sync run never deletes, closes or overwrites a manual item
 *     (reconcileStaleIds returns nothing for a source it does not own)
 *   - two-way sync never tries to push a manual item anywhere
 *     (canPushToSource / canCompleteOnSource are both false for it)
 * ========================================================================== */

// `manual-<base36 ms>-<6 base36 chars>`. Time-ordered so the ids sort the way
// they were created, random-tailed so two entries in the same millisecond do
// not collide. The caller may inject now/rand to make this deterministic.
function manualExternalId(now, rand) {
  const ms = Number.isFinite(now) ? now : Date.now();
  const r = typeof rand === 'function' ? rand : Math.random;
  let tail = '';
  for (let i = 0; i < 6; i++) tail += Math.floor(r() * 36).toString(36);
  return `manual-${ms.toString(36)}-${tail}`;
}

// The frontmatter object for a new manual item. Every field of the README
// contract is present and explicit: a manual note must be readable by anything
// that reads a synced note, and an ABSENT field is a different thing from a
// null one to the frontmatter parser.
//
// `priority: 5` is written literally rather than left null. 5 is "no
// priority"; see the coercion note in itemFromFrontmatter.
function manualItemFrontmatter(title, id, nowIso) {
  return {
    type: 'planner-item',
    source: MANUAL_SOURCE,
    external_id: String(id),
    title: String(title),
    status: 'open',
    due: null,
    priority: 5,
    url: null,
    tags: [],
    source_status: null,
    planned_day: null,
    planned_half: null,
    planned_order: 0,
    weekly_goal: false,
    done_local: false,
    // Manual items are never synced, so `synced_at` would be a lie. This is
    // the manual-only field, documented in the README contract table.
    created_at: nowIso,
  };
}

// Which of `allItems` a HEALTHY fetch of `source` proves are finished.
//
// The guard that matters is the first one: a source only ever reconciles its
// OWN items. A manual item is invisible to every sync run, including one whose
// external_id happens to look like the id of a task that just vanished from
// Todoist. Extracted as a pure function so that invariant is a test and not a
// comment.
function reconcileStaleIds(source, allItems, openIds) {
  if (!isSyncedSource(source)) return [];
  const out = [];
  for (const it of allItems || []) {
    if (it.source !== source) continue;
    if (openIds.has(it.id)) continue;
    if (it.status === 'done') continue;
    // Reopened here, not yet confirmed by the source: re-marking it done now
    // would undo the uncheck before the reopen has round-tripped.
    if (it.reopenPending === true) continue;
    out.push(it);
  }
  return out;
}

/* ========================================================================== *
 * Completion and recurrence (2026-09-04)
 *
 * Three defects shared two causes. First, reconcile deleted the shadow of a
 * task that left the open set, and the push path needs a shadow to act, so an
 * uncheck after a sync had nowhere to send a reopen. Second, the plugin had
 * no notion of an OCCURRENCE: a recurring Todoist task keeps its id and only
 * moves its due forward, so a local check stayed forever and a plan stayed on
 * the day of an occurrence that was already finished.
 *
 * The decision is pure so the one place that writes completions to a source
 * can be tested for the double-close hazard: if the reset of the local check
 * ran AFTER the completion comparison, the comparison would see a checked
 * card against an unchecked shadow and close the task a second time, which
 * advances the recurrence twice. An advance therefore never pushes anything,
 * in either direction (a reopen on a recurring task reverts its due date).
 * ========================================================================== */

// Did the source's due move forward past the baseline? Unknown recurrence
// (an older note, or ClickUp) counts as recurring: the rule keys on the due
// having MOVED while a baseline existed, which a one-off task's edit also
// satisfies only when the user changed the date at the source, and for a
// one-off the fetch says recurring: false and the rule stands down.
function occurrenceAdvanced(prior, sourceItem, shadow) {
  return prior.recurring !== false
    && !!(shadow && shadow.due && sourceItem && sourceItem.due && sourceItem.due > shadow.due);
}

// The completion decision for one item that IS in the source's open set.
//   advanced         the due moved on: the old occurrence is finished
//   resetDoneLocal   clear the check, status open, done_at gone
//   movePlan         { day, half } to put the card on ('move' mode)
//   clearPlan        send the card back to the tray ('drop' mode)
//   occurrence       what to record about the finished occurrence, or null
//   pushClose / pushReopen   the ONE call to the source, or neither
//   nextShadowDone   the done flag the shadow should carry after this sync
//   clearReopenPending       the source confirmed the reopen (the item is open)
function syncCompletionPlan({ prior, sourceItem, shadow, completeOnSource, recurringAdvance }) {
  const shadowDone = shadow ? !!shadow.done : false;
  const base = {
    advanced: false, resetDoneLocal: false, movePlan: null, clearPlan: false,
    occurrence: null, lastCompletedDue: null,
    pushClose: false, pushReopen: false, nextShadowDone: shadowDone,
    clearReopenPending: prior.reopenPending === true,
  };
  if (occurrenceAdvanced(prior, sourceItem, shadow)) {
    const mode = recurringAdvance === 'drop' ? 'drop' : 'move';
    // A plan on or after the new due was made for the NEXT occurrence and
    // stands in both modes; only a plan for a day before the new due belongs
    // to the occurrence that just finished.
    const plannedBefore = !!(prior.plannedDay && prior.plannedDay < sourceItem.due);
    return {
      ...base,
      advanced: true,
      resetDoneLocal: true,
      movePlan: mode === 'move' && plannedBefore ? { day: sourceItem.due, half: prior.plannedHalf || 'am' } : null,
      clearPlan: mode === 'drop' && plannedBefore,
      occurrence: {
        due: shadow.due,
        plannedDay: plannedBefore ? prior.plannedDay : null,
        plannedHalf: plannedBefore ? (prior.plannedHalf || null) : null,
      },
      lastCompletedDue: shadow.due,
      nextShadowDone: false,
    };
  }
  // The caller only asks about items in the open set, so a pending reopen is
  // confirmed by the fetch itself: the source is open, nothing to push.
  const sourceDone = prior.reopenPending === true ? false : shadowDone;
  const wantDone = !!prior.doneLocal;
  const push = !!completeOnSource && wantDone !== sourceDone;
  return { ...base, nextShadowDone: sourceDone, pushClose: push && wantDone, pushReopen: push && !wantDone };
}

// What unchecking a struck card means, given where the "done" came from.
//   local-only     done_local flips; nothing else is involved
//   push           the source closed it: reopen here now, tell the source
//   refuse-local   the source closed it and nothing may reach the source:
//                  say so, change nothing
function reopenDecision({ statusDone, completeOnSource, synced }) {
  if (!statusDone || !synced) return 'local-only';
  return completeOnSource ? 'push' : 'refuse-local';
}

// Newest last, oldest dropped past the cap.
const OCCURRENCE_CAP = 30;
function appendOccurrence(list, occurrence, cap) {
  const max = Number.isFinite(cap) && cap > 0 ? cap : OCCURRENCE_CAP;
  const out = (Array.isArray(list) ? list : []).concat([occurrence]);
  return out.length > max ? out.slice(out.length - max) : out;
}

// Finished occurrences as READ-ONLY board entries: one per recorded occurrence
// that had a plan, on the day and half it was planned, struck. An occurrence
// without a plan is history only and renders nothing. The tray never shows
// these; the board renders them through renderCard with `ghost` set, which
// disables the check, the drag and the menu. `path` is made distinct so lane
// sequencing never confuses a ghost with its live card; `notePath` opens it.
function ghostItemsFor(items) {
  const out = [];
  for (const it of items || []) {
    (it.occurrences || []).forEach((occ, i) => {
      if (!occ.plannedDay || !occ.plannedHalf) return;
      out.push({
        ...it,
        ghost: true,
        path: `${it.path}#occurrence-${i}`,
        notePath: it.path,
        due: occ.due || it.due,
        plannedDay: occ.plannedDay,
        plannedHalf: occ.plannedHalf,
        plannedOrder: 0,
        doneLocal: true,
        status: 'done',
        reopenPending: false,
        weeklyGoal: false,
        occurrences: [],
      });
    });
  }
  return out;
}

// Shadows are the memory of "what the source last agreed to" AND of "did we
// already close or reopen this there". They now survive reconcile (a task
// that left the open set keeps its shadow with done: true), so they are
// pruned by two rules instead: no note carries the id any more, or the done
// shadow is older than `maxDoneAgeMs`. Returns the keys to drop.
const DONE_SHADOW_MAX_AGE_MS = 90 * 86400000;
function pruneShadows(shadowMap, source, existingIds, openIds, nowMs, maxDoneAgeMs) {
  const maxAge = Number.isFinite(maxDoneAgeMs) ? maxDoneAgeMs : DONE_SHADOW_MAX_AGE_MS;
  const drop = [];
  const prefix = `${source}:`;
  for (const key of Object.keys(shadowMap || {})) {
    if (!key.startsWith(prefix)) continue;
    const id = key.slice(prefix.length);
    const sh = shadowMap[key] || {};
    if (!existingIds.has(id) && !openIds.has(id)) { drop.push(key); continue; }
    if (sh.done === true && Number.isFinite(sh.doneAt) && nowMs - sh.doneAt > maxAge) drop.push(key);
  }
  return drop;
}

/* ========================================================================== *
 * The plugin
 * ========================================================================== */

class IcorPlannerPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // _shadow: per-item last-synced baseline for the two-way fields. Lives in
    // data.json beside the settings; never shown in the settings UI.
    if (!this.settings._shadow || typeof this.settings._shadow !== 'object') this.settings._shadow = {};
    this._pushTimers = new Map();
    this.calendarDefs = null;        // parsed ICS defs (mirrored to the cache note on healthy fetches)
    this.calendarStale = false;      // true while defs come from the vault cache, not a live fetch
    this.calendarStatus = null;      // last calendar ConnectorResult status
    this.syncStatus = {};            // source -> { ok, reason, message, count, at }
    this.syncing = false;
    this.lastSyncAt = null;
    // One auto-reveal of the tray per session (trayRevealDecision).
    this._trayAutoRevealed = false;

    this.registerView(BOARD_VIEW_TYPE, (leaf) => new PlannerBoardView(leaf, this));
    this.registerView(TRAY_VIEW_TYPE, (leaf) => new PlannerTrayView(leaf, this));

    this.addCommand({ id: 'open-board', name: 'Open weekly planner', callback: () => this.openBoard() });
    this.addCommand({ id: 'open-tray', name: 'Open planner tray', callback: () => this.openTray(true) });
    this.addCommand({ id: 'sync-now', name: 'Sync planner sources now', callback: () => this.syncNow(true) });
    this.addCommand({ id: 'add-manual-task', name: 'Add a task', callback: () => this.focusAddTask() });

    this.addSettingTab(new IcorPlannerSettingTab(this.app, this));

    // The planner folder itself is the entry point (styled like the other
    // rooms by icor-rooms.css). A capture-phase listener turns its click into
    // opening the board instead of folding the folder - no injected rows.
    // The path is read at click time, so a changed setting needs no rewiring.
    this.registerDomEvent(document, 'click', (e) => {
      const title = e.target instanceof Element
        ? e.target.closest(`.nav-folder-title[data-path="${this.paths().root}"]`)
        : null;
      if (!title) return;
      e.preventDefault();
      e.stopPropagation();
      this.openBoard();
    }, { capture: true });

    this.app.workspace.onLayoutReady(() => {
      // A renamed room is found before anything reads or writes a path.
      this.adoptPlannerFolder();
      this.ensureGitignore();
      // Instant calendar: rehydrate the last healthy fetch from the vault
      // cache (rendered pale + pulsing) before the live fetch replaces it.
      this.loadCalendarCache();
      this.setupNextBadge();
      // First sync shortly after startup (never blocking plugin load), then on
      // the configured cadence.
      if (this.anySourceConfigured()) {
        window.setTimeout(() => this.syncNow(false), 4000);
      }
      this.scheduleSync();
    });

    // Live re-render when anything under the planner folder changes (sync
    // writes, user edits, or the AI team moving an item by editing
    // frontmatter). The boundary is read at event time (this.paths()).
    const inside = (file) => !!(file && this.paths().isInside(file.path));
    const notify = (file) => { if (inside(file)) this.emitModelChanged(); };
    this.registerEvent(this.app.metadataCache.on('changed', (file) => {
      notify(file);
      if (inside(file)) this.schedulePushCheck(file.path);
    }));
    this.registerEvent(this.app.vault.on('delete', notify));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (inside(file) || this.paths().isInside(oldPath)) this.emitModelChanged();
    }));
  }

  // Every path, derived from the setting at call time.
  paths() { return plannerPaths(this.settings); }

  // Boot: if the configured folder is missing but exactly one top-level
  // folder is called "... planner", use it. Several: say so once and leave
  // the setting alone. The vault is never guessed at.
  async adoptPlannerFolder() {
    try {
      const root = this.app.vault.getRoot();
      const names = (root && root.children ? root.children : []).filter((c) => c instanceof TFolder).map((c) => c.name);
      const d = detectPlannerFolder(names, this.paths().root);
      if (d.action === 'adopt') {
        this.settings.plannerFolder = d.folder;
        await this.saveData(this.settings);
        new Notice(`Planner: using the folder "${d.folder}".`);
      } else if (d.action === 'ask') {
        new Notice(`Planner: several folders look like the planner (${d.candidates.join(', ')}). Pick one under Settings, ICOR for Life - Planner, Planner folder.`, 12000);
      }
    } catch { /* detection is a convenience; ensureFolders covers the rest */ }
  }

  onunload() {
    this.removeNextBadge();
    if (this._cacheWriteTimer) { window.clearTimeout(this._cacheWriteTimer); this._cacheWriteTimer = null; }
  }

  // Any source with a connector, calendar included. Manual is excluded on
  // purpose: it needs no fetch, so it must never make the scheduler start one.
  anySourceConfigured() {
    return FETCHED_SOURCES.some((k) => sourceConfigured(this.settings, k));
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.scheduleSync();
    this.emitModelChanged();
  }

  scheduleSync() {
    if (this._syncTimer) { window.clearInterval(this._syncTimer); this._syncTimer = null; }
    const minutes = Math.max(2, Number(this.settings.syncMinutes) || 10);
    this._syncTimer = window.setInterval(() => {
      if (this.anySourceConfigured()) this.syncNow(false);
    }, minutes * 60000);
    this.registerInterval(this._syncTimer);
  }

  // Debounced fan-out to both views.
  emitModelChanged() {
    if (this._emitTimer) window.clearTimeout(this._emitTimer);
    this._emitTimer = window.setTimeout(() => {
      this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE).forEach((l) => {
        if (l.view instanceof PlannerBoardView) l.view.render();
      });
      this.app.workspace.getLeavesOfType(TRAY_VIEW_TYPE).forEach((l) => {
        if (l.view instanceof PlannerTrayView) l.view.render();
      });
      this.updateNextBadge();
    }, 250);
  }

  /* ---- gitignore guard: token store never reaches the scaffold repo ------ */
  async ensureGitignore() {
    try {
      const adapter = this.app.vault.adapter;
      const gi = '.gitignore';
      let text = '';
      try { text = await adapter.read(gi); } catch { text = ''; }
      const line = gitignoreLineFor(this.manifest);
      const wanted = line ? [line] : [];
      const missing = wanted.filter((line) => !text.split('\n').some((l) => l.trim() === line));
      if (missing.length) {
        const block = `\n# ICOR for Life - Planner is its own git repository (and its data.json holds API keys)\n${missing.join('\n')}\n`;
        await adapter.write(gi, (text.endsWith('\n') || !text ? text : text + '\n') + block);
      }
    } catch { /* never block load on this */ }
  }

  /* ---- calendar event cache (v0.5.0) ------------------------------------- */

  // Rehydrate the last healthy fetch from the cache note. Only fills the
  // gap before the first live fetch; a malformed cache is silently ignored
  // (the next healthy fetch rebuilds it).
  async loadCalendarCache() {
    if (this.calendarDefs) return;
    try {
      const file = this.app.vault.getAbstractFileByPath(normalizePath(this.paths().cache));
      if (!(file instanceof TFile)) return;
      const text = await this.app.vault.cachedRead(file);
      const defs = parseCalendarCacheContent(text);
      if (defs && defs.length && !this.calendarDefs) {
        this.calendarDefs = defs;
        this.calendarStale = true; // pale + pulsing until a healthy fetch lands
        this.emitModelChanged();
      }
    } catch { /* unreadable cache: the fetch path covers it */ }
  }

  // Debounced so a manual sync right after the scheduled one writes once.
  scheduleCalendarCacheWrite() {
    if (this._cacheWriteTimer) window.clearTimeout(this._cacheWriteTimer);
    this._cacheWriteTimer = window.setTimeout(() => {
      this._cacheWriteTimer = null;
      this.writeCalendarCache();
    }, 2000);
  }

  async writeCalendarCache() {
    try {
      if (!this.calendarDefs || this.calendarStale) return; // only persist live fetches
      await this.ensureFolders();
      const content = buildCalendarCacheContent(this.calendarDefs, new Date(), this.paths().root);
      const path = normalizePath(this.paths().cache);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) await this.app.vault.process(existing, () => content);
      else await this.app.vault.create(path, content);
    } catch { /* the cache is a convenience - never fail a sync on it */ }
  }

  /* ---- next-event badge (v0.5.0, desktop only) --------------------------- */

  // Expanded events for the badge window: this ISO week plus the next, so the
  // "next" pick can see ahead across a weekend regardless of the board's week.
  badgeEvents() {
    if (!this.calendarDefs) return [];
    const w0 = mondayOf(todayStr());
    const split = this.splitHour();
    return icsEventsForWeek(this.calendarDefs, w0, split)
      .concat(icsEventsForWeek(this.calendarDefs, addDays(w0, 7), split));
  }

  // Inject the badge into the LEFT ribbon, right after the action stack the
  // INKLINE theme styles (the theme positions .iplan-next-badge further).
  setupNextBadge() {
    if (Platform.isMobile) return;                       // desktop only
    if (!this.settings.showNextBadge) { this.removeNextBadge(); return; }
    if (this._badgeEl && this._badgeEl.isConnected) { this.updateNextBadge(); return; }
    const dock = document.querySelector('.workspace-ribbon.mod-left .side-dock-actions');
    if (!dock) return;                                   // layout not there yet
    const el = document.createElement('div');
    el.className = 'iplan-next-badge';
    el.hidden = true;
    el.setAttribute('role', 'button');
    el.setAttribute('tabindex', '0');
    const icon = document.createElement('span');
    icon.className = 'iplan-next-badge-icon';
    setIcon(icon, 'video');
    const count = document.createElement('span');
    count.className = 'iplan-next-badge-count';
    const title = document.createElement('span');
    title.className = 'iplan-next-badge-title';
    el.appendChild(icon);
    el.appendChild(count);
    el.appendChild(title);
    const activate = () => {
      if (this._badgeConfUrl) window.open(this._badgeConfUrl, '_external');
      else this.openBoard();
    };
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
    dock.insertAdjacentElement('afterend', el);
    this._badgeEl = el;
    this._badgeParts = { icon, count, title };
    this.updateNextBadge();
  }

  removeNextBadge() {
    if (this._badgeTimer != null) { window.clearTimeout(this._badgeTimer); this._badgeTimer = null; }
    if (this._badgeEl) { this._badgeEl.remove(); this._badgeEl = null; this._badgeParts = null; }
    this._badgeConfUrl = null;
  }

  // Single re-arming timer: 30s cadence normally, 1s once <= 5 minutes remain
  // (the label switches to M:SS there). Cleared on unload via removeNextBadge.
  _armBadgeTick(ms) {
    if (this._badgeTimer != null) window.clearTimeout(this._badgeTimer);
    this._badgeTimer = window.setTimeout(() => {
      this._badgeTimer = null;
      this.updateNextBadge();
    }, ms);
  }

  updateNextBadge() {
    if (Platform.isMobile) return;
    if (!this.settings.showNextBadge) { this.removeNextBadge(); return; }
    if (!this._badgeEl || !this._badgeEl.isConnected) {
      // Layout may not have carried the ribbon yet at first call.
      if (this._badgeEl) this.removeNextBadge();
      this.setupNextBadge();
      if (!this._badgeEl) return;
    }
    const now = new Date();
    const ev = nextUpcomingEvent(this.badgeEvents(), now);
    const el = this._badgeEl;
    const parts = this._badgeParts;
    if (!ev) {
      el.hidden = true;
      this._badgeConfUrl = null;
      this._armBadgeTick(30000);
      return;
    }
    const label = fmtBadgeCountdown(ev, now);
    const conf = detectConferenceUrl(ev);
    this._badgeConfUrl = conf;
    el.hidden = false;
    parts.count.textContent = label;
    parts.title.textContent = ev.title;
    parts.icon.style.display = conf ? '' : 'none';
    const msLeft = new Date(ev.start).getTime() - now.getTime();
    const imminent = msLeft > 0 && msLeft <= 5 * 60000;
    el.classList.toggle('is-imminent', imminent);
    el.classList.toggle('is-now', label === 'NOW');
    el.setAttribute('aria-label',
      `${ev.title}, ${label === 'NOW' ? 'running now' : label.toLowerCase()}. ` +
      (conf ? 'Opens the meeting link.' : 'Opens the planner board.'));
    el.title = `${ev.title} · ${label}${conf ? '\nClick to join the meeting' : ''}`;
    this._armBadgeTick(imminent ? 1000 : 30000);
  }

  /* ---- views ------------------------------------------------------------- */
  async openBoard() {
    const existing = this.app.workspace.getLeavesOfType(BOARD_VIEW_TYPE);
    const leaf = existing.length ? existing[0] : this.app.workspace.getLeaf(true);
    if (!existing.length) await leaf.setViewState({ type: BOARD_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
    await this.autoRevealTray();
    // Focus belongs on the board the user just asked for, never on the tray we
    // opened beside it.
    try { this.app.workspace.setActiveLeaf(leaf, { focus: true }); } catch { /* older API */ }
  }

  // Reveal the tray alongside the board, once per session, without fighting a
  // user who closed it. See trayRevealDecision for why the memory is
  // session-scoped rather than persisted.
  async autoRevealTray() {
    let collapsed = false;
    try { collapsed = !!(this.app.workspace.rightSplit && this.app.workspace.rightSplit.collapsed); } catch { collapsed = false; }
    const decision = trayRevealDecision({
      autoRevealedThisSession: !!this._trayAutoRevealed,
      trayLeafExists: this.app.workspace.getLeavesOfType(TRAY_VIEW_TYPE).length > 0,
      rightSplitCollapsed: collapsed,
    });
    if (decision === 'none' || decision === 'already-visible') {
      // The tray still has to EXIST even when we are not revealing it, which is
      // what openTray(false) has always done.
      if (decision === 'already-visible') return;
      await this.openTray(false);
      return;
    }
    if (trayRevealSpendsTurn(decision)) this._trayAutoRevealed = true;
    await this.openTray(true);
  }

  async openTray(reveal) {
    let leaves = this.app.workspace.getLeavesOfType(TRAY_VIEW_TYPE);
    if (!leaves.length) {
      const leaf = this.app.workspace.getRightLeaf(false);
      if (!leaf) return null;
      await leaf.setViewState({ type: TRAY_VIEW_TYPE, active: false });
      leaves = [leaf];
    }
    if (reveal) this.app.workspace.revealLeaf(leaves[0]);
    return leaves[0];
  }

  // Reveal the tray on its TASKS tab with the add-a-task field open and
  // focused. One capture surface, reachable from the command palette on
  // desktop and mobile alike, rather than a second modal to design and keep.
  async focusAddTask() {
    const leaf = await this.openTray(true);
    const view = leaf && leaf.view;
    if (view instanceof PlannerTrayView) view.openComposer();
  }

  /* ---- sync engine -------------------------------------------------------- */
  async ensureFolders() {
    const mk = async (path) => {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (!existing) { try { await this.app.vault.createFolder(path); } catch {} }
    };
    const p = this.paths();
    await mk(p.root);
    // Manual included: the folder must exist on a vault with no keys at all.
    for (const key of TASK_SOURCES) {
      await mk(p.sourceFolder(key));
    }
  }

  async syncNow(manual) {
    if (this.syncing) { if (manual) new Notice('Planner sync already running.'); return; }
    this.syncing = true;
    this.emitModelChanged();
    try {
      await this.ensureFolders();
      const s = this.settings;
      // Every task connector starts at once, in registry order; results are
      // awaited and applied in that same order.
      const runs = SYNCED_SOURCES.map((k) => [k, CONNECTORS[k].fetchOpen(s)]);
      for (const [source, promise] of runs) {
        const result = await promise;
        this.syncStatus[source] = {
          ok: result.ok, reason: result.reason || null, message: result.message || null,
          hint: result.hint || null, docUrl: result.docUrl || null,
          count: result.items.length, at: new Date().toISOString(),
        };
        if (result.ok) await this.upsertSource(source, result.items);
      }
      // A sync the user pressed for, with the mailbox misconfigured: say what
      // went wrong and what to do about it, once, here, not only in the tray.
      if (manual && this.syncStatus.email && this.syncStatus.email.reason === 'misconfigured') {
        const st = this.syncStatus.email;
        new Notice(`Email: ${st.message}${st.hint ? `\n${st.hint}` : ''}`, 12000);
      }
      // Calendar: no per-event notes; a healthy fetch replaces the defs,
      // clears the stale look and rewrites the ONE cache file. A failed fetch
      // keeps whatever renders now (cached or previous) - never prune on a blip.
      const cal = await calendarFetchDefs(s);
      this.calendarStatus = {
        ok: cal.ok, reason: cal.reason || null, message: cal.message || null,
        warning: cal.warning || null, at: new Date().toISOString(),
      };
      if (cal.ok) {
        this.calendarDefs = cal.items;
        this.calendarStale = false;
        this.scheduleCalendarCacheWrite();
      }
      this.lastSyncAt = new Date().toISOString();
      await this.saveData(this.settings); // persist the refreshed shadows
      if (manual) {
        const okCount = SYNCED_SOURCES.filter((k) => this.syncStatus[k] && this.syncStatus[k].ok).length;
        new Notice(`Planner sync done (${okCount} task source${okCount === 1 ? '' : 's'} healthy).`);
      }
    } finally {
      this.syncing = false;
      this.emitModelChanged();
    }
  }

  // Upsert one source's OPEN set into the vault + reconcile completions.
  // The fetch succeeded, so absence from `items` is a true completion signal
  // (the cockpit's reconcileOpenIds contract), never a window artifact.
  // v0.2.0: per item, the two-way fields go through threeWayMerge against the
  // stored shadow - local edits push, source edits pull, source wins conflicts.
  // Failed pushes keep the old baseline so the next sync retries them.
  async upsertSource(source, items) {
    const folder = this.paths().sourceFolder(source);
    const s = this.settings;
    const allItems = collectItems(this.app, this.paths().root);
    const existing = new Map(); // external id -> item
    for (const it of allItems) {
      if (it.source === source) existing.set(it.id, it);
    }
    const openIds = new Set();
    for (const t of items) {
      openIds.add(t.id);
      const prior = existing.get(t.id);
      if (!prior) {
        await this.createItemFile(folder, source, t);
        continue;
      }
      const key = `${source}:${t.id}`;
      const shadow = s._shadow[key] || null;
      const body = await this.readBody(prior.file);
      const sourceVals = { due: t.due || null, priority: t.priority, description: (t.description || '').trim() };
      const localVals = { due: prior.due, priority: prior.priority, description: body };
      const pushEnabled = !!s.pushEdits && canPushToSource(source);
      const { pushes, finals, nextShadow } = threeWayMerge(sourceVals, localVals, shadow, pushEnabled);
      if (Object.keys(pushes).length) {
        try {
          await CONNECTORS[source].pushFields(s, t, pushes);
          new Notice(`Planner: pushed ${Object.keys(pushes).join(', ')} to ${SOURCES[source].label}.`);
        } catch (e) {
          new Notice(`Planner: ${SOURCES[source].label} push failed (${e.message}). Will retry.`);
          for (const f of Object.keys(pushes)) {
            finals[f] = localVals[f];
            nextShadow[f] = shadow ? shadow[f] : sourceVals[f];
          }
        }
      }
      // Completion state, decided in one pure place (syncCompletionPlan): an
      // occurrence advance resets the check and never pushes; otherwise a
      // pending close / reopen is retried at sync time too.
      const plan = syncCompletionPlan({
        prior, sourceItem: t, shadow,
        completeOnSource: !!s.completeOnSource,
        recurringAdvance: s.recurringAdvance,
      });
      nextShadow.done = plan.nextShadowDone;
      if (plan.pushClose || plan.pushReopen) {
        try {
          await this.applyDoneOnSource(prior, plan.pushClose);
          nextShadow.done = plan.pushClose;
        } catch (e) {
          new Notice(`Planner: ${SOURCES[source].label} ${plan.pushClose ? 'close' : 'reopen'} failed (${e.message}). Will retry.`);
        }
      }
      if (nextShadow.done && shadow && shadow.doneAt) nextShadow.doneAt = shadow.doneAt;
      s._shadow[key] = nextShadow;
      await this.updateItemFile(prior, t, finals, body, plan);
    }
    // Reconcile: open file whose id vanished from the healthy open set -> done.
    // The decision runs over EVERY item in the vault, not a pre-filtered set,
    // so the "a source only reconciles its own items" rule is enforced by
    // reconcileStaleIds itself and is testable there. Manual items are never
    // returned, whatever their external_id looks like.
    //
    // The shadow is KEPT, marked done: it is what lets an uncheck after this
    // sync still reach the source. Pruning happens by pruneShadows below.
    const nowMs = Date.now();
    for (const it of reconcileStaleIds(source, allItems, openIds)) {
      const key = `${source}:${it.id}`;
      s._shadow[key] = Object.assign({}, s._shadow[key] || {
        due: it.due, priority: it.priority, description: '',
      }, { done: true, doneAt: nowMs });
      await this.app.fileManager.processFrontMatter(it.file, (fm) => {
        fm.status = 'done';
        fm.done_at = new Date().toISOString();
        fm.synced_at = new Date().toISOString();
      });
    }
    // A reopen that has not reached the source yet (the push path failed, or
    // the sync ran first): send it now. The flag is cleared only when the
    // task is back in the open set (updateItemFile), never on the promise.
    if (s.completeOnSource) {
      for (const it of allItems) {
        if (it.source !== source || openIds.has(it.id) || it.reopenPending !== true) continue;
        const key = `${source}:${it.id}`;
        if (s._shadow[key] && s._shadow[key].done === false) continue; // already sent
        try {
          await this.applyDoneOnSource(it, false);
          s._shadow[key] = Object.assign({}, s._shadow[key] || { due: it.due, priority: it.priority, description: '' }, { done: false });
        } catch (e) {
          new Notice(`Planner: ${SOURCES[source].label} reopen failed (${e.message}). Will retry.`);
        }
      }
    }
    for (const key of pruneShadows(s._shadow, source, new Set(existing.keys()), openIds, nowMs)) {
      delete s._shadow[key];
    }
  }

  async readBody(file) {
    try {
      const content = await this.app.vault.cachedRead(file);
      return content.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    } catch { return ''; }
  }

  // The one place a completion crosses to the source. Throws on failure.
  async applyDoneOnSource(item, closed) {
    const c = CONNECTORS[item.source];
    if (!c || !c.setClosed) return; // manual: nowhere to write
    await c.setClosed(this.settings, item, closed);
    new Notice(c.doneNotice(closed));
  }

  // Debounced per-file: a local edit (user typing, a card action, or an agent
  // editing frontmatter) pushes out without waiting for the next sync.
  schedulePushCheck(path) {
    if (this._pushTimers.has(path)) window.clearTimeout(this._pushTimers.get(path));
    this._pushTimers.set(path, window.setTimeout(() => {
      this._pushTimers.delete(path);
      this.detectAndPush(path);
    }, 900));
  }

  async detectAndPush(path) {
    const s = this.settings;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const item = itemFromFile(this.app, file);
    if (!item) return;
    // A manual item has no source to write to. Guarded explicitly rather than
    // relying on "it has no shadow entry, so it falls out below": that is true
    // today and would stop being true the moment anything else seeds a shadow.
    if (!isSyncedSource(item.source)) return;
    const key = `${item.source}:${item.id}`;
    const sh = s._shadow[key];
    // No baseline yet: the next sync seeds it. A pending reopen is the one
    // signal that must act without a shadow (older installs, or a note the
    // AI team reopened by hand).
    if (!sh && item.reopenPending !== true) return;
    let dirty = false;
    if (sh && s.pushEdits && canPushToSource(item.source)) {
      const body = await this.readBody(file);
      const localVals = { due: item.due, priority: item.priority, description: body };
      const pushes = {};
      for (const f of TWO_WAY_FIELDS) {
        const base = sh[f] == null || sh[f] === '' ? (f === 'priority' ? 5 : null) : sh[f];
        const loc = localVals[f] == null || localVals[f] === '' ? (f === 'priority' ? 5 : null) : localVals[f];
        if (loc !== base) pushes[f] = loc;
      }
      if (Object.keys(pushes).length) {
        try {
          await CONNECTORS[item.source].pushFields(s, item, pushes);
          for (const f of Object.keys(pushes)) sh[f] = pushes[f];
          dirty = true;
          new Notice(`Planner: pushed ${Object.keys(pushes).join(', ')} to ${SOURCES[item.source].label}.`);
        } catch (e) {
          new Notice(`Planner: ${SOURCES[item.source].label} push failed (${e.message}). Will retry on sync.`);
        }
      }
    }
    // A reopen the card asked for (uncheck on a source-closed task) acts even
    // when the shadow already says done; the shadow's done flag drives the
    // plain check / uncheck as before.
    const wantReopen = item.reopenPending === true && !item.doneLocal;
    const doneDiffers = sh ? item.doneLocal !== !!sh.done : false;
    if (s.completeOnSource && canCompleteOnSource(item.source) && (wantReopen || doneDiffers)) {
      try {
        await this.applyDoneOnSource(item, item.doneLocal);
        if (sh) {
          sh.done = item.doneLocal;
        } else {
          s._shadow[key] = { due: item.due, priority: item.priority, description: await this.readBody(file), done: item.doneLocal };
        }
        dirty = true;
        if (wantReopen) {
          await this.app.fileManager.processFrontMatter(file, (fm) => { delete fm.reopen_pending; });
        }
      } catch (e) {
        new Notice(`Planner: ${item.doneLocal ? 'close' : 'reopen'} on ${SOURCES[item.source].label} failed (${e.message}). Will retry on sync.`);
      }
    }
    if (dirty) {
      if (this._shadowSaveTimer) window.clearTimeout(this._shadowSaveTimer);
      this._shadowSaveTimer = window.setTimeout(() => this.saveData(this.settings), 1500);
    }
  }

  async createItemFile(folder, source, t) {
    let base = `${safeBasename(t.title)} (${source}-${t.id})`;
    let path = normalizePath(`${folder}/${base}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(`${folder}/${base}-2.md`);
    }
    const fmLines = [
      '---',
      'type: planner-item',
      `source: ${source}`,
      `external_id: "${String(t.id).replace(/"/g, '')}"`,
      `title: ${JSON.stringify(t.title)}`,
      'status: open',
      `due: ${t.due || null}`,
      `priority: ${t.priority}`,
      `url: ${t.url ? JSON.stringify(t.url) : null}`,
      `tags: ${JSON.stringify(t.tags || [])}`,
      `source_status: ${t.status ? JSON.stringify(t.status) : null}`,
      `list_id: ${t.listId ? JSON.stringify(String(t.listId)) : null}`,
      `recurring: ${t.recurring == null ? null : !!t.recurring}`,
      `due_string: ${t.dueString ? JSON.stringify(String(t.dueString)) : null}`,
      'planned_day: null',
      'planned_half: null',
      'planned_order: 0',
      'weekly_goal: false',
      'done_local: false',
      `synced_at: ${new Date().toISOString()}`,
      '---',
      '',
    ];
    const body = (t.description || '').trim();
    try {
      await this.app.vault.create(path, fmLines.join('\n') + (body ? body + '\n' : ''));
      this.settings._shadow[`${source}:${t.id}`] = {
        due: t.due || null, priority: t.priority, description: body, done: false,
      };
    } catch { /* a race with another writer - the next sync settles it */ }
  }

  // Applies the merge result: `finals` carries the settled two-way fields
  // (due / priority / description); source-owned metadata always pulls.
  // `plan` (optional) is the syncCompletionPlan result: the occurrence
  // advance and the reopen confirmation are applied to the note here, in the
  // same frontmatter write as the source pull.
  async updateItemFile(prior, t, finals, currentBody, plan) {
    const wantDue = finals.due || null;
    const wantPriority = clampPriorityRank(finals.priority);
    const wantRecurring = t.recurring == null ? null : !!t.recurring;
    const wantDueString = t.dueString ? String(t.dueString) : null;
    const ops = plan || {};
    const hasOps = !!(ops.resetDoneLocal || ops.clearPlan || ops.movePlan || ops.occurrence || ops.clearReopenPending);
    const changed =
      prior.title !== t.title || prior.due !== wantDue ||
      prior.priority !== wantPriority || prior.url !== (t.url || null) ||
      prior.status === 'done' || // reopened at the source
      prior.recurring !== wantRecurring || prior.dueString !== wantDueString ||
      hasOps ||
      JSON.stringify(prior.tags) !== JSON.stringify(t.tags || []) ||
      prior.sourceStatus !== (t.status || null) ||
      prior.listId !== (t.listId ? String(t.listId) : null);
    if (changed) {
      const nowIso = new Date().toISOString();
      await this.app.fileManager.processFrontMatter(prior.file, (fm) => {
        fm.title = t.title;
        fm.due = wantDue;
        fm.priority = wantPriority;
        fm.url = t.url || null;
        fm.tags = t.tags || [];
        fm.source_status = t.status || null;
        if (t.listId) fm.list_id = String(t.listId);
        fm.recurring = wantRecurring;
        fm.due_string = wantDueString;
        // Back in the open set: the source shows it open, whatever asked for it.
        if (fm.status === 'done') { fm.status = 'open'; delete fm.done_at; }
        if (ops.clearReopenPending) delete fm.reopen_pending;
        if (ops.resetDoneLocal) { fm.done_local = false; fm.status = 'open'; delete fm.done_at; }
        if (ops.clearPlan) { fm.planned_day = null; fm.planned_half = null; fm.planned_order = 0; }
        if (ops.movePlan) {
          // Appended at the end of the lane: the tap-to-plan convention
          // (order = wall-clock ms, past every hand order).
          fm.planned_day = ops.movePlan.day;
          fm.planned_half = ops.movePlan.half;
          fm.planned_order = Date.now();
        }
        if (ops.occurrence) {
          fm.occurrences = appendOccurrence(fm.occurrences, {
            due: ops.occurrence.due,
            planned_day: ops.occurrence.plannedDay,
            planned_half: ops.occurrence.plannedHalf,
            done_at: nowIso,
          });
          fm.last_completed_due = ops.lastCompletedDue;
        }
        fm.synced_at = nowIso;
      });
    }
    // Body follows the settled description, never blindly the source.
    const desc = (finals.description || '').trim();
    try {
      if ((currentBody || '').trim() !== desc) {
        await this.app.vault.process(prior.file, (data) => {
          const m = /^---\n[\s\S]*?\n---\n?/.exec(data);
          const head = m ? m[0] : '';
          return head + (desc ? desc + '\n' : '');
        });
      }
    } catch { /* body refresh is cosmetic - never fail the sync on it */ }
  }

  /* ---- plan writes (the drag-and-drop write path) ------------------------- */
  async assignItem(path, day, half, order) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.planned_day = day;
      fm.planned_half = half;
      fm.planned_order = order;
    });
  }

  async unassignItem(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.planned_day = null;
      fm.planned_half = null;
      fm.planned_order = 0;
    });
  }

  // The check toggles the EFFECTIVE done state (isDone), not the flag alone:
  // a card the source closed reads as done, and unchecking it must reopen
  // it, which before this only flipped done_local to true on a struck card.
  async toggleDoneLocal(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const item = itemFromFile(this.app, file);
    if (!item) return;
    if (!isDone(item)) {
      await this.app.fileManager.processFrontMatter(file, (fm) => { fm.done_local = true; });
      return;
    }
    const decision = reopenDecision({
      statusDone: item.status === 'done',
      completeOnSource: !!this.settings.completeOnSource,
      synced: isSyncedSource(item.source),
    });
    if (decision === 'refuse-local') {
      new Notice(`This task is closed in ${(SOURCES[item.source] || {}).label || item.source}. Turn on Complete on source to reopen it from here.`);
      return;
    }
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.done_local = false;
      if (fm.status === 'done') { fm.status = 'open'; delete fm.done_at; }
      // Optimistic: the card un-strikes now; the push path sends the reopen
      // and clears the flag; reconcile stands down while it is set.
      if (decision === 'push') fm.reopen_pending = true;
    });
  }

  async toggleWeeklyGoal(path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm.weekly_goal = fm.weekly_goal !== true;
    });
  }

  /* ---- manual items: the write path with no API key in front of it ------- */

  // Create one manual task and return its path (or null on an empty title).
  // Deliberately the same shape as createItemFile's output so the board, the
  // tray, the drag logic and the card menu cannot tell the difference.
  async addManualItem(title, opts) {
    const clean = String(title == null ? '' : title).trim();
    if (!clean) return null;
    await this.ensureFolders();
    const folder = this.paths().sourceFolder(MANUAL_SOURCE);
    const fm = manualItemFrontmatter(clean, manualExternalId(), new Date().toISOString());
    if (opts && opts.day) {
      fm.planned_day = opts.day;
      fm.planned_half = opts.half === 'pm' ? 'pm' : 'am';
      fm.planned_order = Date.now();
    }
    // The id is collision-proof by construction; this loop only guards against
    // a file that already sits at the path for an unrelated reason.
    let path = normalizePath(`${folder}/${safeBasename(clean)} (${fm.external_id}).md`);
    for (let n = 2; this.app.vault.getAbstractFileByPath(path) && n < 50; n++) {
      path = normalizePath(`${folder}/${safeBasename(clean)} (${fm.external_id}-${n}).md`);
    }
    const yaml = [
      '---',
      'type: planner-item',
      `source: ${fm.source}`,
      `external_id: "${fm.external_id}"`,
      `title: ${JSON.stringify(fm.title)}`,
      `status: ${fm.status}`,
      `due: ${fm.due === null ? 'null' : fm.due}`,
      `priority: ${fm.priority}`,
      'url: null',
      'tags: []',
      'source_status: null',
      `planned_day: ${fm.planned_day === null ? 'null' : fm.planned_day}`,
      `planned_half: ${fm.planned_half === null ? 'null' : fm.planned_half}`,
      `planned_order: ${fm.planned_order}`,
      `weekly_goal: ${fm.weekly_goal}`,
      `done_local: ${fm.done_local}`,
      `created_at: ${fm.created_at}`,
      '---',
      '',
    ].join('\n');
    try {
      await this.app.vault.create(path, yaml);
    } catch (e) {
      new Notice(`Planner: could not create the task (${(e && e.message) || 'unknown error'}).`);
      return null;
    }
    // No shadow entry: a manual item has no source baseline, and detectAndPush
    // must never find one for it.
    this.emitModelChanged();
    return path;
  }

  // Open the plugin's own settings tab. Obsidian exposes this on app.setting;
  // guarded because it is not part of the published API surface.
  openPluginSettings() {
    try {
      const setting = this.app.setting;
      if (!setting || typeof setting.open !== 'function') {
        new Notice('Open Settings, Community plugins, ICOR for Life - Planner to add a key.');
        return;
      }
      setting.open();
      if (typeof setting.openTabById === 'function') setting.openTabById(this.manifest.id);
    } catch {
      new Notice('Open Settings, Community plugins, ICOR for Life - Planner to add a key.');
    }
  }

  splitHour() {
    const src = this.settings.lunchEnabled
      ? (this.settings.lunchStart || '12:30')
      : (this.settings.splitTime || '13:00');
    const m = /^(\d{1,2}):(\d{2})$/.exec(src);
    return m ? Number(m[1]) : 13;
  }

  // Fractional rank for an insertion at `index` among `siblings` (sorted by
  // plannedOrder). The cockpit's server-computed-position rule, client-side.
  // Since 0.4.3 `siblings` is the lane's MIXED sequence from laneSequence():
  // read-only event entries (plannedOrder = start minutes since midnight)
  // interleaved with task entries (plannedOrder = planned_order). Dropping
  // between a 09:00 event (540) and an 11:00 event (660) yields 600, so the
  // task keeps its slot between them on the next render.
  orderForInsert(siblings, index) {
    if (!siblings.length) return 10;
    if (index <= 0) return siblings[0].plannedOrder - 10;
    if (index >= siblings.length) return siblings[siblings.length - 1].plannedOrder + 10;
    return (siblings[index - 1].plannedOrder + siblings[index].plannedOrder) / 2;
  }
}

/* ========================================================================== *
 * Shared card rendering (board + tray speak the same visual grammar)
 * ========================================================================== */

// The theme's plugin-surface contract: declare this subtree a plugin surface,
// so the INKLINE theme's own control rules stand down inside it. Without it the theme's input-well
// rule sits at (0,5,1) and beats every (0,2,0) rule in styles.css on
// background, border, font-family and both focus properties, and the tray's
// underline field renders as a filled well. Measured against the shipped theme
// bytes 2026-08-30. Reads the manifest, never a literal, so a rename cannot
// silently unhook it.
function markInkPlugin(el, pluginId) {
  if (el && el.dataset && pluginId) el.dataset.inkPlugin = pluginId;
}

function sourceMarkEl(source) {
  const meta = SOURCES[source] || SOURCES.todoist;
  const span = document.createElement('span');
  span.className = `iplan-source-mark iplan-source-${source}`;
  span.setAttribute('aria-label', meta.label);
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(svgNS, 'path');
  path.setAttribute('d', meta.svg);
  svg.appendChild(path);
  span.appendChild(svg);
  return span;
}

function dueChipText(item, today) {
  if (!item.due) return null;
  const bucket = dueBucketOf(item.due, today);
  if (bucket === 'today') return 'TODAY';
  if (bucket === 'overdue') {
    const days = Math.round((new Date(today) - new Date(item.due)) / 86400000);
    return days === 1 ? '1D OVER' : `${days}D OVER`;
  }
  return fmtDayNum(item.due);
}

// One read-only calendar chip's behavior, shared by the board lanes and the
// tray's AGENDA tab: stale look while defs come from the vault cache, an
// aria label, and click-through into the detail modal (with the icsUrl so
// the Google edit deep-link can be built).
function wireEventChip(plugin, chip, ev) {
  if (plugin.calendarStale) chip.addClass('is-stale');
  // An unresolved zone is visible on the chip itself (dashed edge, a mark)
  // and spoken in the label; the modal names the zone.
  if (ev.tzUnresolved) chip.addClass('is-tz-unresolved');
  chip.setAttribute('aria-label',
    `${ev.title}${ev.location ? ', ' + ev.location : ''}${ev.tzUnresolved ? ', time zone not recognised, shown as written' : ''}`);
  chip.addEventListener('click', () => new EventDetailModal(plugin.app, ev, plugin.settings.icsUrl, plugin.manifest.id).open());
}

// One task card. mode: 'board' | 'tray'.
function renderCard(plugin, item, mode, view) {
  const today = todayStr();
  const card = document.createElement('div');
  card.className = 'iplan-card';
  card.setAttribute('data-path', item.path);
  card.setAttribute('data-order', String(item.plannedOrder));
  card.setAttribute('data-source', item.source);
  // A ghost is a finished occurrence of a recurring task (ghostItemsFor):
  // struck, not draggable, no check action, no menu. It opens the note.
  const ghost = item.ghost === true;
  const notePath = item.notePath || item.path;
  card.draggable = !ghost;
  if (isDone(item)) card.classList.add('is-done');
  if (ghost) card.classList.add('is-ghost');
  if (item.weeklyGoal) card.classList.add('is-goal');

  if (!ghost) {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', item.path);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('is-dragging');
      document.body.classList.add('iplan-dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('is-dragging');
      document.body.classList.remove('iplan-dragging');
      document.querySelectorAll('.iplan-drop-line').forEach((el) => el.remove());
    });
  }

  const check = document.createElement('button');
  check.className = 'iplan-check';
  if (ghost) {
    check.disabled = true;
    check.setAttribute('aria-label', 'Completed occurrence');
  } else {
    check.setAttribute('aria-label', isDone(item) ? 'Reopen' : 'Mark done');
    check.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      plugin.toggleDoneLocal(item.path);
    });
  }

  const bodyEl = document.createElement('div');
  bodyEl.className = 'iplan-card-body';
  const titleEl = document.createElement('div');
  titleEl.className = 'iplan-card-title';
  titleEl.textContent = item.title;
  const meta = document.createElement('div');
  meta.className = 'iplan-card-meta';
  meta.appendChild(sourceMarkEl(item.source));
  // A ghost's due is a date that has passed by design; "3D OVER" would be a
  // lie about a finished occurrence, so it shows the date, neutrally.
  const due = ghost ? (item.due ? fmtDayNum(item.due) : null) : dueChipText(item, today);
  if (due) {
    const chip = document.createElement('span');
    chip.className = ghost ? 'iplan-chip' : `iplan-chip iplan-due-${dueBucketOf(item.due, today)}`;
    chip.textContent = due;
    meta.appendChild(chip);
  }
  if (item.priority <= 2) {
    const pr = document.createElement('span');
    pr.className = `iplan-chip iplan-prio-${item.priority}`;
    pr.textContent = `P${item.priority}`;
    meta.appendChild(pr);
  }
  if (item.weeklyGoal) {
    const goal = document.createElement('span');
    goal.className = 'iplan-chip iplan-goal-chip';
    goal.textContent = 'GOAL';
    meta.appendChild(goal);
  }
  bodyEl.appendChild(titleEl);
  bodyEl.appendChild(meta);

  card.appendChild(check);
  card.appendChild(bodyEl);

  // Click opens the local note; the source link lives in the context menu.
  card.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const file = plugin.app.vault.getAbstractFileByPath(notePath);
    if (file instanceof TFile) plugin.app.workspace.getLeaf('tab').openFile(file);
  });
  if (ghost) return card;
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showCardMenu(plugin, item, view, { x: e.clientX, y: e.clientY });
  });

  // Touch long-press opens the same menu: mobile webviews fire neither
  // contextmenu nor HTML5 drag events, so this is the whole mobile write path.
  let lpTimer = null, lpStart = null;
  const lpCancel = () => { if (lpTimer != null) { window.clearTimeout(lpTimer); lpTimer = null; } };
  card.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    lpStart = { x: e.clientX, y: e.clientY };
    lpCancel();
    lpTimer = window.setTimeout(() => {
      lpTimer = null;
      card.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); },
        { once: true, capture: true });
      showCardMenu(plugin, item, view, lpStart);
    }, 480);
  });
  card.addEventListener('pointermove', (e) => {
    if (lpTimer != null && lpStart
      && Math.hypot(e.clientX - lpStart.x, e.clientY - lpStart.y) > 8) lpCancel();
  });
  card.addEventListener('pointerup', lpCancel);
  card.addEventListener('pointercancel', lpCancel);
  return card;
}

// The card menu, shared by right-click (desktop) and long-press (touch).
function showCardMenu(plugin, item, view, pos) {
  const menu = new Menu();
  menu.addItem((mi) => mi.setTitle(isDone(item) ? 'Reopen' : 'Mark done')
    .setIcon('check').onClick(() => plugin.toggleDoneLocal(item.path)));
  menu.addItem((mi) => mi.setTitle(item.weeklyGoal ? 'Unmark weekly goal' : 'Mark as weekly goal')
    .setIcon('star').onClick(() => plugin.toggleWeeklyGoal(item.path)));
  menu.addItem((mi) => mi.setTitle('Plan on...')
    .setIcon('calendar').onClick(() => showPlanMenu(plugin, item, view, pos)));
  if (item.plannedDay) {
    menu.addItem((mi) => mi.setTitle('Send back to tray')
      .setIcon('inbox').onClick(() => plugin.unassignItem(item.path)));
  }
  if (item.url) {
    menu.addItem((mi) => mi.setTitle(`Open in ${(SOURCES[item.source] || {}).label || item.source}`)
      .setIcon('external-link').onClick(() => window.open(item.url, '_external')));
  }
  menu.addItem((mi) => mi.setTitle('Open note')
    .setIcon('file-text').onClick(() => {
      const file = plugin.app.vault.getAbstractFileByPath(item.path);
      if (file instanceof TFile) plugin.app.workspace.getLeaf('tab').openFile(file);
    }));
  menu.showAtPosition(pos);
}

// Tap-to-plan: pick a day and half of the board's current week. The card
// lands at the end of the lane (order = wall-clock ms, past every hand
// order); the next drag renormalizes via orderForInsert.
function showPlanMenu(plugin, item, view, pos) {
  const weekStart = (view && view.weekStart) || mondayOf(todayStr());
  const today = todayStr();
  const days = weekDays(weekStart)
    .filter((d, i) => plugin.settings.showWeekend || i < 5);
  const menu = new Menu();
  days.forEach((day, i) => {
    const label = `${DAY_NAMES[i]} ${fmtDayNum(day)}${day === today ? ' (today)' : ''}`;
    for (const half of ['am', 'pm']) {
      menu.addItem((mi) => mi
        .setTitle(`${label} · ${half === 'am' ? 'morning' : 'afternoon'}`)
        .setIcon(half === 'am' ? 'sunrise' : 'sunset')
        .onClick(() => plugin.assignItem(item.path, day, half, Date.now())));
    }
  });
  menu.showAtPosition(pos);
}

// Wire one element as a drop lane. onDrop(path, index) receives the insertion
// index among the lane's current sequence: timed event chips AND non-dragged
// task cards in DOM order (the same order laneSequence() rendered them in), so
// a task can be dropped above, between or below calendar events. Event chips
// are never draggable; they only take part as positions.
function wireDropLane(laneEl, onDrop) {
  const clearLine = () => laneEl.querySelectorAll('.iplan-drop-line').forEach((el) => el.remove());
  // Ghost cards (finished occurrences) sit after the live sequence and take
  // no part in it, so they are excluded here exactly as they are excluded
  // from the sequence the drop handler ranks over.
  const cardsOf = () => Array.from(laneEl.querySelectorAll('.iplan-event, .iplan-card:not(.is-dragging):not(.is-ghost)'));
  const indexForY = (y) => {
    const cards = cardsOf();
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return cards.length;
  };
  laneEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    laneEl.classList.add('is-drop-target');
    clearLine();
    const idx = indexForY(e.clientY);
    const line = document.createElement('div');
    line.className = 'iplan-drop-line';
    const cards = cardsOf();
    if (idx >= cards.length) laneEl.appendChild(line);
    else laneEl.insertBefore(line, cards[idx]);
  });
  laneEl.addEventListener('dragleave', (e) => {
    if (laneEl.contains(e.relatedTarget)) return;
    laneEl.classList.remove('is-drop-target');
    clearLine();
  });
  laneEl.addEventListener('drop', (e) => {
    e.preventDefault();
    laneEl.classList.remove('is-drop-target');
    const idx = indexForY(e.clientY);
    clearLine();
    const path = e.dataTransfer.getData('text/plain');
    if (path) onDrop(path, idx);
  });
}

/* ========================================================================== *
 * Event detail modal - a calendar chip opens this on click (read-only)
 * ========================================================================== */

// Deep link into Google Calendar's edit view for an event that arrived via a
// Google secret iCal feed. The feed URL carries the calendarId
// (https://calendar.google.com/calendar/ical/<calendarId>/private-<key>/basic.ics);
// Google's per-event id is the ICS UID's localpart (trailing @google.com
// stripped), suffixed for expanded recurrences with the occurrence start
// (UTC basic format for timed, YYYYMMDD for all-day). The edit URL's eid is
// base64url("<eventId> <calendarId>") with the = padding stripped.
// Returns null when the feed is not that Google shape (caller falls back to
// a day-view link).
function googleCalendarEventUrl(ev, icsUrl) {
  const normalized = String(icsUrl || '').trim().replace(/^webcal:\/\//i, 'https://');
  const m = /^https:\/\/calendar\.google\.com\/calendar\/ical\/([^/?#]+)\//i.exec(normalized);
  if (!m || !ev || !ev.masterUid) return null;
  const calendarId = decodeURIComponent(m[1]);
  let eventId = ev.masterUid.replace(/@google\.com$/i, '');
  if (ev.recurring && ev.occStartUtc) eventId += `_${ev.occStartUtc}`;
  let b64;
  try { b64 = btoa(`${eventId} ${calendarId}`); } catch { return null; } // non-Latin1 uid
  const eid = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `https://calendar.google.com/calendar/u/0/r/eventedit/${eid}`;
}

class EventDetailModal extends Modal {
  constructor(app, ev, icsUrl, inkPluginId) {
    super(app);
    this.ev = ev;
    this.icsUrl = icsUrl || '';
    this.inkPluginId = inkPluginId || '';
  }
  onOpen() {
    const { contentEl } = this;
    const ev = this.ev;
    contentEl.addClass('iplan-event-modal');
    markInkPlugin(contentEl, this.inkPluginId);
    const kicker = contentEl.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' GOOGLE CALENDAR' });
    contentEl.createEl('h2', { cls: 'iplan-event-modal-title', text: ev.title });
    const meta = contentEl.createDiv({ cls: 'iplan-event-modal-meta' });
    const dayLabel = (() => {
      const [y, m, d] = ev.day.split('-').map(Number);
      const idx = (new Date(y, m - 1, d, 12).getDay() + 6) % 7;
      return `${DAY_NAMES[idx]} ${fmtDayNum(ev.day)}`;
    })();
    // Labeled property rows: when / location / conference are first-class
    // fields, never only buried in the description text.
    const metaRow = (label, value, href) => {
      const rowEl = meta.createDiv({ cls: 'iplan-event-modal-row' });
      rowEl.createSpan({ cls: 'iplan-event-modal-row-label', text: label });
      if (href) {
        const a = rowEl.createEl('a', { cls: 'iplan-event-modal-row-value', text: value, href });
        a.addEventListener('click', (e) => { e.preventDefault(); window.open(href, '_external'); });
      } else {
        rowEl.createSpan({ cls: 'iplan-event-modal-row-value', text: value });
      }
    };
    metaRow('WHEN', ev.allDay && !ev.start
      ? `${dayLabel} ALL DAY`
      : `${dayLabel} ${fmtTimeHM(ev.start)} - ${fmtTimeHM(ev.end)}`);
    if (ev.continues) meta.createDiv({ cls: 'iplan-event-modal-when', text: 'CONTINUED FROM AN EARLIER DAY' });
    if (ev.tzUnresolved) metaRow('TIME ZONE', `${ev.tzUnresolved} (not recognised, shown as written)`);
    if (ev.location) metaRow('WHERE', ev.location);
    const confUrl = detectConferenceUrl(ev);
    if (confUrl) metaRow('CONFERENCE', confUrl, confUrl);
    const descText = htmlishToText(ev.description);
    if (descText) {
      const desc = contentEl.createDiv({ cls: 'iplan-event-modal-desc' });
      linkifyInto(desc, descText);
    }
    const row = contentEl.createDiv({ cls: 'iplan-event-modal-actions' });
    // JOIN MEETING is the primary action when the event carries a meeting URL.
    if (confUrl) {
      const btn = row.createEl('button', { cls: 'iplan-event-modal-open is-primary', text: 'JOIN MEETING' });
      btn.addEventListener('click', () => window.open(confUrl, '_external'));
    }
    const gcalUrl = googleCalendarEventUrl(ev, this.icsUrl);
    if (gcalUrl) {
      const btn = row.createEl('button', { cls: 'iplan-event-modal-open', text: 'EDIT IN GOOGLE CALENDAR' });
      btn.addEventListener('click', () => window.open(gcalUrl, '_external'));
    } else {
      // Non-Google feed (or unparsable feed URL): land on the day instead.
      const [y, mo, d] = ev.day.split('-').map(Number);
      const dayUrl = `https://calendar.google.com/calendar/u/0/r/day/${y}/${mo}/${d}`;
      const btn = row.createEl('button', { cls: 'iplan-event-modal-open', text: 'OPEN CALENDAR' });
      btn.addEventListener('click', () => window.open(dayUrl, '_external'));
    }
    // A URL property on a Google event points back at the event itself; the
    // edit button above already covers it, so only render a second button for
    // genuinely external links (and not for the meeting link again).
    if (ev.url && ev.url !== confUrl && !(gcalUrl && /google\.com\/calendar/i.test(ev.url))) {
      const btn = row.createEl('button', { cls: 'iplan-event-modal-open is-secondary', text: 'OPEN EVENT LINK' });
      btn.addEventListener('click', () => window.open(ev.url, '_external'));
    }
  }
  onClose() { this.contentEl.empty(); }
}

/* ========================================================================== *
 * Board view - the weekly planner in the main pane
 * ========================================================================== */

class PlannerBoardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.weekStart = mondayOf(todayStr());
    this.mode = 'week'; // 'week' | 'day'
    this.day = todayStr();
  }

  getViewType() { return BOARD_VIEW_TYPE; }
  getDisplayText() { return 'Planner'; }
  getIcon() { return 'calendar-range'; }

  async onOpen() {
    this.contentEl.addClass('iplan-root');
    markInkPlugin(this.contentEl, this.plugin.manifest.id);
    this.render();
    // Minute tick keeps the now-rail honest.
    this.registerInterval(window.setInterval(() => this.updateNowRail(), 60000));
    if (this.plugin.anySourceConfigured() && !this.plugin.lastSyncAt && !this.plugin.syncing) {
      this.plugin.syncNow(false);
    }
  }

  async onClose() { this.contentEl.empty(); }

  getState() { return { weekStart: this.weekStart, mode: this.mode, day: this.day }; }
  async setState(state, result) {
    if (state) {
      if (state.weekStart) this.weekStart = state.weekStart;
      if (state.mode === 'day' || state.mode === 'week') this.mode = state.mode;
      if (state.day) this.day = state.day;
      this.render();
    }
    return super.setState(state, result);
  }

  setWeek(weekStart) { this.weekStart = weekStart; this.render(); }
  setDay(day) { this.day = day; this.weekStart = mondayOf(day); this.render(); }
  setMode(mode) {
    this.mode = mode;
    if (mode === 'day' && !this.day) this.day = todayStr();
    this.render();
  }

  render() {
    const el = this.contentEl;
    el.empty();
    const today = todayStr();
    const isDay = this.mode === 'day';
    const items = collectItems(this.plugin.app, this.plugin.paths().root);
    const splitHour = this.plugin.splitHour();
    const eventsWeekStart = isDay ? mondayOf(this.day) : this.weekStart;
    const events = this.plugin.calendarDefs
      ? icsEventsForWeek(this.plugin.calendarDefs, eventsWeekStart, splitHour)
      : [];

    /* ---- masthead ---- */
    const head = el.createDiv({ cls: 'iplan-masthead' });
    const kicker = head.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' ICOR PLANNER' });
    const titleRow = head.createDiv({ cls: 'iplan-title-row' });
    titleRow.createEl('h1', {
      cls: 'iplan-title',
      text: isDay
        ? fmtDayTitle(this.day, today)
        : (this.weekStart === mondayOf(today) ? 'This Week.' : 'The Week.'),
    });

    const nav = titleRow.createDiv({ cls: 'iplan-nav' });
    // WEEK | DAY segment switch
    const seg = nav.createDiv({ cls: 'iplan-seg' });
    const mkSeg = (label, mode) => {
      const b = seg.createEl('button', { cls: 'iplan-seg-btn', text: label });
      if (this.mode === mode) b.addClass('is-active');
      b.addEventListener('click', () => this.setMode(mode));
    };
    mkSeg('WEEK', 'week');
    mkSeg('DAY', 'day');
    const mkNavBtn = (icon, label, fn) => {
      const b = nav.createEl('button', { cls: 'iplan-nav-btn', attr: { 'aria-label': label } });
      setIcon(b, icon);
      b.addEventListener('click', fn);
      return b;
    };
    if (isDay) {
      mkNavBtn('chevron-left', 'Previous day', () => this.setDay(addDays(this.day, -1)));
      const todayBtn = nav.createEl('button', { cls: 'iplan-nav-btn iplan-nav-today', text: 'TODAY' });
      todayBtn.addEventListener('click', () => this.setDay(todayStr()));
      mkNavBtn('chevron-right', 'Next day', () => this.setDay(addDays(this.day, 1)));
      nav.createSpan({ cls: 'iplan-week-label', text: fmtDayLabel(this.day) });
    } else {
      mkNavBtn('chevron-left', 'Previous week', () => this.setWeek(addDays(this.weekStart, -7)));
      const todayBtn = nav.createEl('button', { cls: 'iplan-nav-btn iplan-nav-today', text: 'TODAY' });
      todayBtn.addEventListener('click', () => this.setWeek(mondayOf(todayStr())));
      mkNavBtn('chevron-right', 'Next week', () => this.setWeek(addDays(this.weekStart, 7)));
      nav.createSpan({ cls: 'iplan-week-label', text: fmtWeekLabel(this.weekStart) });
    }
    const syncBtn = nav.createEl('button', { cls: 'iplan-nav-btn iplan-sync-btn', attr: { 'aria-label': 'Sync now' } });
    setIcon(syncBtn, 'refresh-cw');
    if (this.plugin.syncing) syncBtn.addClass('is-syncing');
    syncBtn.addEventListener('click', () => this.plugin.syncNow(true));

    /* ---- source status line (only when something needs saying) ---- */
    const notices = [];
    for (const key of SYNCED_SOURCES) {
      const st = this.plugin.syncStatus[key];
      if (st && !st.ok && st.reason !== 'no-token') {
        notices.push(`${SOURCES[key].label}: ${st.message}${st.hint ? ` ${st.hint}` : ''}`);
      }
    }
    if (this.plugin.calendarStatus && !this.plugin.calendarStatus.ok &&
        this.plugin.calendarStatus.reason !== 'no-token') {
      notices.push(`Calendar: ${this.plugin.calendarStatus.message}`);
    } else if (this.plugin.calendarStatus && this.plugin.calendarStatus.warning) {
      // A healthy fetch with unresolved zones: one line, not one per event.
      notices.push(`Calendar: ${this.plugin.calendarStatus.warning}`);
    }
    if (!this.plugin.anySourceConfigured()) {
      // The SAME sentence the tray leads with, from the same constant. Two
      // surfaces describing one state in two different sentences is how a
      // first run starts feeling unfinished, and the old wording said "API
      // keys" when the calendar takes a URL and the mailbox takes three
      // fields. The tray beside this carries the two controls; the board
      // states the fact.
      notices.push(TRAY_COPY.lead);
    }
    if (notices.length) {
      const bar = el.createDiv({ cls: 'iplan-notices' });
      for (const n of notices) bar.createDiv({ cls: 'iplan-notice', text: n });
    }

    /* ---- board ---- */
    const visibleDays = isDay
      ? [this.day]
      : weekDays(this.weekStart).filter((d, i) => this.plugin.settings.showWeekend || i < 5);
    const board = el.createDiv({ cls: 'iplan-board' });
    if (isDay) board.addClass('is-day');
    board.style.setProperty('--iplan-day-count', String(visibleDays.length));

    const itemsByCell = new Map(); // day|half -> items
    for (const it of items) {
      if (!it.plannedDay || !it.plannedHalf) continue;
      const key = `${it.plannedDay}|${it.plannedHalf}`;
      if (!itemsByCell.has(key)) itemsByCell.set(key, []);
      itemsByCell.get(key).push(it);
    }
    for (const list of itemsByCell.values()) list.sort((a, b) => a.plannedOrder - b.plannedOrder);
    // Finished occurrences of recurring tasks, rendered after the live
    // sequence of their lane, read-only.
    const ghostsByCell = new Map();
    for (const g of ghostItemsFor(items)) {
      const key = `${g.plannedDay}|${g.plannedHalf}`;
      if (!ghostsByCell.has(key)) ghostsByCell.set(key, []);
      ghostsByCell.get(key).push(g);
    }
    for (const list of ghostsByCell.values()) list.sort((a, b) => String(a.due || '').localeCompare(String(b.due || '')));

    const eventsByCell = new Map();
    const allDayByDay = new Map();
    for (const ev of events) {
      if (ev.allDay || !ev.half) {
        if (!allDayByDay.has(ev.day)) allDayByDay.set(ev.day, []);
        allDayByDay.get(ev.day).push(ev);
      } else {
        const key = `${ev.day}|${ev.half}`;
        if (!eventsByCell.has(key)) eventsByCell.set(key, []);
        eventsByCell.get(key).push(ev);
      }
    }

    for (const day of visibleDays) {
      const dayIdx = (new Date(day + 'T12:00:00').getDay() + 6) % 7;
      const col = board.createDiv({ cls: 'iplan-day' });
      if (day === today) col.addClass('is-today');
      if (day < today) col.addClass('is-past'); // YYYY-MM-DD compares as text

      const colHead = col.createDiv({ cls: 'iplan-day-head' });
      colHead.createSpan({ cls: 'iplan-day-name', text: DAY_NAMES[dayIdx] });
      colHead.createSpan({ cls: 'iplan-day-date', text: fmtDayNum(day) });
      if (day === today) colHead.createSpan({ cls: 'iplan-day-now', text: 'NOW' });

      const allDay = allDayByDay.get(day) || [];
      if (allDay.length) {
        const band = col.createDiv({ cls: 'iplan-allday' });
        for (const ev of allDay) {
          const chip = band.createDiv({ cls: 'iplan-event iplan-event-allday' });
          if (ev.continues) chip.addClass('is-continues');
          chip.createSpan({ cls: 'iplan-event-title', text: ev.title });
          this.wireEvent(chip, ev);
        }
      }

      for (const half of ['am', 'pm']) {
        if (half === 'pm') {
          const s = this.plugin.settings;
          if (s.lunchEnabled) {
            const band = col.createDiv({ cls: 'iplan-lunch' });
            band.style.height = `${lunchBandHeight(s.lunchStart, s.lunchEnd)}px`;
            band.createSpan({
              cls: 'iplan-split-time',
              text: `${s.lunchStart || '12:30'} - ${s.lunchEnd || '13:30'} LUNCH`,
            });
          } else {
            const divider = col.createDiv({ cls: 'iplan-split' });
            divider.createSpan({ cls: 'iplan-split-time', text: s.splitTime || '13:00' });
          }
        }
        const lane = col.createDiv({ cls: 'iplan-lane', attr: { 'data-day': day, 'data-half': half } });
        const laneEvents = (eventsByCell.get(`${day}|${half}`) || []);
        const cell = itemsByCell.get(`${day}|${half}`) || [];
        // One sequential order per lane: event 09:00, task, event 11:00, task.
        for (const entry of laneSequence(laneEvents, cell)) {
          if (entry.kind === 'event') {
            const chip = lane.createDiv({ cls: 'iplan-event' });
            chip.createSpan({ cls: 'iplan-event-time', text: `${fmtTimeHM(entry.ev.start)}` });
            chip.createSpan({ cls: 'iplan-event-title', text: entry.ev.title });
            this.wireEvent(chip, entry.ev);
          } else {
            lane.appendChild(renderCard(this.plugin, entry.it, 'board', this));
          }
        }
        const ghosts = ghostsByCell.get(`${day}|${half}`) || [];
        for (const g of ghosts) lane.appendChild(renderCard(this.plugin, g, 'board', this));
        if (!laneEvents.length && !cell.length && !ghosts.length) lane.createDiv({ cls: 'iplan-lane-empty', text: half === 'am' ? 'morning' : 'afternoon' });

        wireDropLane(lane, (path, index) => {
          // Same mixed sequence the lane was rendered from, minus the dragged
          // task, so `index` (computed over chips + cards) maps 1:1.
          const current = laneSequence(laneEvents, cell).filter((x) => x.kind === 'event' || x.path !== path);
          const order = this.plugin.orderForInsert(current, index);
          this.plugin.assignItem(path, day, half, order);
        });
      }

      if (day === today) {
        const rail = col.createDiv({ cls: 'iplan-now-rail' });
        col.dataset.railState = 'on';
        this._todayCol = col;
        this._nowRail = rail;
        // cockpit countdown: time left in the current half, right under the head
        const cd = document.createElement('div');
        cd.className = 'iplan-countdown';
        const track = document.createElement('div');
        track.className = 'iplan-countdown-track';
        const fill = document.createElement('div');
        fill.className = 'iplan-countdown-fill';
        track.appendChild(fill);
        const cdLabel = document.createElement('span');
        cdLabel.className = 'iplan-countdown-label';
        cd.appendChild(track);
        cd.appendChild(cdLabel);
        colHead.insertAdjacentElement('afterend', cd);
        this._countdown = { wrap: cd, fill, label: cdLabel };
      }
    }
    this.updateNowRail();

    /* ---- foot: last sync stamp ---- */
    const foot = el.createDiv({ cls: 'iplan-foot' });
    const stamp = this.plugin.lastSyncAt
      ? `SYNCED ${fmtTimeHM(this.plugin.lastSyncAt)}`
      : (this.plugin.syncing ? 'SYNCING...' : 'NOT SYNCED YET');
    foot.createSpan({ text: stamp });
    foot.createSpan({ cls: 'iplan-foot-dot', text: ' · ' });
    foot.createSpan({ text: fmtOpenItems(items.filter((i) => !isDone(i)).length) });
  }

  wireEvent(chip, ev) {
    // Cache-rehydrated events render pale + pulsing until a live fetch lands.
    wireEventChip(this.plugin, chip, ev);
  }

  // The live day-progress marker on today's column (cockpit's progress rail).
  updateNowRail() {
    if (!this._todayCol || !this._nowRail || !this._todayCol.isConnected) return;
    const parse = (hm, fallback) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
      return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
    };
    const start = parse(this.plugin.settings.dayStart, 480);
    const end = parse(this.plugin.settings.dayEnd, 1080);
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const pct = Math.max(0, Math.min(1, (mins - start) / Math.max(1, end - start)));
    this._todayCol.style.setProperty('--iplan-now-pct', String(pct));
    this._todayCol.dataset.railState = mins < start ? 'before' : (mins > end ? 'after' : 'on');
    if (this._countdown && this._countdown.wrap.isConnected) {
      const seg = segmentInfo(this.plugin.settings, mins);
      if (!seg) {
        this._countdown.wrap.style.display = 'none';
      } else {
        this._countdown.wrap.style.display = '';
        this._countdown.wrap.dataset.seg = seg.name.toLowerCase();
        this._countdown.fill.style.width = `${Math.round(seg.pct * 100)}%`;
        this._countdown.label.textContent = `${seg.name} \u00b7 ${fmtLeft(seg.leftMin)}`;
      }
    }
  }
}

/* ========================================================================== *
 * Tray view - the right-panel companion, tabbed since 0.6.0:
 *   TASKS  - weekly goals pinned + unscheduled items by source (the classic
 *            tray; whole-panel drop unassigns). Internal id 'sync' (pre-0.6.1
 *            name, kept so no state migration is needed). Since 0.6.1 this
 *            tab ONLY exists while the planner board is the context
 *            (trayVisibleTabs); everywhere else the strip is AGENDA | GOALS.
 *   AGENDA - what is planned for TODAY, chronological: all-day chips, then
 *            MORNING / AFTERNOON as the board lane's mixed sequence.
 *            Read-plus-click in v1: no drop targets here.
 *   GOALS  - only the weekly-goals list.
 * Default follows context (trayDefaultTab): board active -> TASKS, any other
 * main-area page -> AGENDA. A manual pick sticks until the context flips.
 * ========================================================================== */

const TRAY_TABS = ['sync', 'agenda', 'goals'];

// Tom's default rule: with the planner board active the tray assists planning
// (SYNC); on every other page it answers "what is planned today" (AGENDA).
// GOALS is never a default anywhere.
function trayDefaultTab(contextIsBoard) {
  return contextIsBoard ? 'sync' : 'agenda';
}

// 0.6.1, Tom's rule: "your tasks" (the TASKS tab) should only show on the
// planner page; on all other pages only AGENDA and GOALS exist. Pure helper
// so render() and setTab() share one source of truth.
function trayVisibleTabs(contextIsBoard) {
  return contextIsBoard ? TRAY_TABS : TRAY_TABS.filter((t) => t !== 'sync');
}

// Rendered label per tab id. 'sync' renders as TASKS since 0.6.1 (Tom calls
// this panel "your tasks"); the id stays 'sync' so nothing persisted or
// wired to it needs a migration.
function trayTabLabel(tab) {
  return tab === 'sync' ? 'TASKS' : tab.toUpperCase();
}

// The guarded active tab: whatever state claims, a tab that is not visible
// in this context collapses to the context default - so 'sync' in a
// non-board context can only ever come out as 'agenda'. Pure so the
// invariant is testable headless.
function trayEffectiveTab(contextIsBoard, activeTab) {
  return trayVisibleTabs(contextIsBoard).includes(activeTab)
    ? activeTab
    : trayDefaultTab(contextIsBoard);
}

/* ---- the tray's honest empty states (2026-08-30) -----------------------------
 *
 * The bug this replaces: a fresh vault with no keys showed "WAITING FOR THE
 * FIRST SYNC." under all three sources. No sync was coming, because no key
 * existed and syncNow() is never called without one. The message told a new
 * user to wait for something that could not happen, and made an unconfigured
 * plugin look like a broken one.
 *
 * Four states, three of them previously collapsed into one:
 *   unconfigured  no credential. Waiting is a lie; the way out is a CTA.
 *   error         configured, the fetch failed. Say what went wrong.
 *   unsynced      configured, nothing has run yet. NOW waiting is honest.
 *   empty         configured, a healthy fetch, genuinely zero items.
 * and `null`, meaning the list speaks for itself and the tray says nothing.
 *
 * Configuration is checked FIRST and beats a stale status: a user who deletes
 * a key still has last session's ok status in memory, and "Nothing
 * unscheduled" would be the same class of lie one state over.
 */

// Copy per the design system, 2026-08-30. `lead` names NO source on purpose: a list in
// a status line is a settings page leaking into a state report, the section
// heads below already name each source, and a hardcoded list drifts silently
// the day a fifth source is added. "Set up" rather than "add a key" because
// the calendar takes a URL and the mailbox takes a host, an address and an app
// password; "key" was already wrong for two of the four.
const TRAY_COPY = {
  lead: 'Nothing is connected yet. Set up your task sources in settings, or add your own tasks by hand.',
  leadAction: 'Open settings',
  unconfigured: () => 'Not connected.',
  connectAction: 'Connect',
  unsynced: 'Waiting for the first sync.',
  empty: 'Nothing unscheduled.',
  manualEmpty: 'Nothing added yet.',
  errorFallback: 'Unavailable.',
};

function trayEmptyState(source, configured, status, count, total) {
  // Manual has no credential and no fetch. `count` is the unscheduled list;
  // `total` is every manual item that exists. The live pass 2026-08-30 caught
  // the two being conflated: with the only manual task dragged onto the board
  // the tray said "nothing added yet", denying a task that exists. The list
  // under a source head is the UNSCHEDULED list, so its empty copy states
  // that ("nothing unscheduled", the same vocabulary as the synced sections)
  // and never where the items went - a done-but-unscheduled item and a pinned
  // weekly goal both empty this list without being on the board.
  if (source === MANUAL_SOURCE) {
    if (count > 0) return null;
    const everAdded = (total || 0) > 0;
    return { kind: 'empty', text: everAdded ? TRAY_COPY.empty : TRAY_COPY.manualEmpty };
  }
  if (!configured) return { kind: 'unconfigured', text: TRAY_COPY.unconfigured(source) };
  // A configured source reporting no-token means settings and the connector
  // disagree; trust the connector's message rather than inventing one.
  if (status && !status.ok) {
    // `hint` is the second line: what to do. `docUrl` is where.
    return {
      kind: 'error', text: status.message || TRAY_COPY.errorFallback,
      hint: status.hint || null, docUrl: status.docUrl || null,
    };
  }
  if (!status) return count > 0 ? null : { kind: 'unsynced', text: TRAY_COPY.unsynced };
  return count > 0 ? null : { kind: 'empty', text: TRAY_COPY.empty };
}

// The whole-tray view of the connection state, so the renderer can lead with
// ONE setup call to action instead of repeating the same sentence under three
// empty sections. `allCold` is about the three TASK sources only: the calendar
// has no tray section (it never becomes per-item notes), so a calendar-only
// setup still leaves the task tray with nothing to show and still earns the
// lead block.
function trayConnectionState(settings) {
  const configured = SYNCED_SOURCES.filter((k) => sourceConfigured(settings, k));
  return {
    configured,
    unconfigured: SYNCED_SOURCES.filter((k) => !sourceConfigured(settings, k)),
    calendar: sourceConfigured(settings, 'calendar'),
    allCold: configured.length === 0,
  };
}

/* ---- opening the board should reveal the tray ----------------------------
 *
 * ...but exactly once per session. A user who collapses the right sidebar or
 * closes the tray has said no, and re-revealing on every board open is
 * fighting them. Session-scoped rather than persisted on purpose: a wrongly
 * recorded "dismissed" that survives a restart is the worse failure, and
 * onClose also fires on plugin unload and workspace reload, so it cannot tell
 * a dismissal from a shutdown.
 *
 * 'already-visible' does NOT spend the one reveal: nothing was forced on
 * anyone, so a later collapse-then-reopen still gets its single nudge.
 */
function trayRevealDecision(state) {
  const s = state || {};
  if (s.autoRevealedThisSession) return 'none';
  if (!s.trayLeafExists) return 'create-and-reveal';
  if (s.rightSplitCollapsed) return 'reveal';
  return 'already-visible';
}

function trayRevealSpendsTurn(decision) {
  return decision === 'create-and-reveal' || decision === 'reveal';
}

// Section model for the AGENDA tab, board-parity by construction: events are
// the week's expanded set (icsEventsForWeek output), tasks the full item list.
// Banding mirrors the board exactly - `allDay || !half` goes to the top band
// (so continuation days of multi-day timed events land there too), timed
// events join tasks planned for today's half in ONE laneSequence per half.
// Done tasks stay in (struck at render, like the board); tasks without a
// planned half are skipped (the board skips them too). Events pass through
// by reference so the stale treatment and the detail modal see the real
// objects. No splitHour parameter: expanded events already carry their half.
function agendaSections(items, events, today) {
  const allDay = [];
  const evHalf = { am: [], pm: [] };
  for (const ev of events || []) {
    if (ev.day !== today) continue;
    if (ev.allDay || !ev.half) allDay.push(ev);
    else evHalf[ev.half === 'am' ? 'am' : 'pm'].push(ev);
  }
  const taskHalf = { am: [], pm: [] };
  for (const it of items || []) {
    if (it.plannedDay !== today || !it.plannedHalf) continue;
    taskHalf[it.plannedHalf].push(it);
  }
  return {
    day: today,
    allDay,
    am: laneSequence(evHalf.am, taskHalf.am),
    pm: laneSequence(evHalf.pm, taskHalf.pm),
  };
}

class PlannerTrayView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.collapsed = {};
    this.composerOpen = false;
    this.composerDraft = '';
    this._composerWantsFocus = false;
    this.contextIsBoard = false;
    this.activeTab = trayDefaultTab(false);
  }

  getViewType() { return TRAY_VIEW_TYPE; }
  getDisplayText() { return 'Your Tasks'; }
  getIcon() { return 'check-square'; }

  async onOpen() {
    this.contentEl.addClass('iplan-tray-root');
    markInkPlugin(this.contentEl, this.plugin.manifest.id);

    // Whole-panel unassign drop target, wired ONCE on the persistent
    // contentEl (empty() clears children, not the element's own listeners -
    // wiring inside render() stacked a duplicate set per re-render). Guarded
    // to the SYNC tab: AGENDA and GOALS are read-plus-click surfaces.
    const el = this.contentEl;
    el.addEventListener('dragover', (e) => {
      if (this.activeTab !== 'sync') return;
      e.preventDefault();
      el.classList.add('is-drop-target');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('is-drop-target');
    });
    el.addEventListener('drop', (e) => {
      el.classList.remove('is-drop-target');
      if (this.activeTab !== 'sync') return;
      e.preventDefault();
      const path = e.dataTransfer.getData('text/plain');
      if (path) this.plugin.unassignItem(path);
    });

    // Context default at open: read the most recent MAIN-AREA leaf (the
    // sidebar neighbors, this tray included, are not context).
    try {
      const ctx = typeof this.app.workspace.getMostRecentLeaf === 'function'
        ? this.app.workspace.getMostRecentLeaf(this.app.workspace.rootSplit)
        : null;
      this.contextIsBoard = !!(ctx && ctx.view && typeof ctx.view.getViewType === 'function'
        && ctx.view.getViewType() === BOARD_VIEW_TYPE);
    } catch { this.contextIsBoard = false; }
    this.activeTab = trayDefaultTab(this.contextIsBoard);

    this.registerEvent(this.app.workspace.on('active-leaf-change',
      (leaf) => this.onActiveLeafChange(leaf)));
    this.render();
  }
  async onClose() { this.contentEl.empty(); }

  // The context default reasserts ONLY when the context flips between board
  // and non-board; a manual tab pick survives everything else. Sidebar leaves
  // (this tray itself, the file explorer, ...) never count as context, so
  // clicking into the tray does not flip tabs.
  onActiveLeafChange(leaf) {
    if (!leaf || !leaf.view || leaf.view === this) return;
    let root = null;
    try { root = typeof leaf.getRoot === 'function' ? leaf.getRoot() : null; } catch { root = null; }
    if (!root || root !== this.app.workspace.rootSplit) return;
    const isBoard = typeof leaf.view.getViewType === 'function'
      && leaf.view.getViewType() === BOARD_VIEW_TYPE;
    if (isBoard === this.contextIsBoard) return;
    this.contextIsBoard = isBoard;
    this.activeTab = trayDefaultTab(isBoard);
    this.render();
  }

  setTab(tab) {
    if (!trayVisibleTabs(this.contextIsBoard).includes(tab) || tab === this.activeTab) return;
    this.activeTab = tab;
    this.render();
  }

  render() {
    // Hard guard: 'sync' must never survive into a non-board render, even
    // through a path that skips onActiveLeafChange (e.g. a direct render()
    // after some other state change). Falls back to the context default.
    this.activeTab = trayEffectiveTab(this.contextIsBoard, this.activeTab);
    const el = this.contentEl;
    // empty() destroys the composer input. If it held the caret a moment ago -
    // a sync landing mid-typing is the common way in - hand the caret back
    // afterwards. This is restoring OUR OWN focus, never taking someone else's:
    // the flag is only set when the field we are about to destroy had it.
    try {
      const active = el.ownerDocument && el.ownerDocument.activeElement;
      if (active && el.contains(active) && active.classList.contains('iplan-add-input')) {
        this._composerWantsFocus = true;
      }
    } catch { /* no document in a headless context */ }
    el.empty();
    const today = todayStr();
    const items = collectItems(this.plugin.app, this.plugin.paths().root);

    const head = el.createDiv({ cls: 'iplan-tray-head' });
    const kicker = head.createDiv({ cls: 'iplan-kicker' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ' YOUR TASKS ' });
    kicker.createSpan({ cls: 'iplan-kicker-marker', text: '/' });
    kicker.createSpan({ text: ` ${trayTabLabel(this.activeTab)}` });
    // The sync button stays visible on every tab: it syncs everything.
    const syncBtn = head.createEl('button', { cls: 'iplan-nav-btn iplan-sync-btn', attr: { 'aria-label': 'Sync now' } });
    setIcon(syncBtn, 'refresh-cw');
    if (this.plugin.syncing) syncBtn.addClass('is-syncing');
    syncBtn.addEventListener('click', () => this.plugin.syncNow(true));

    // Tab strip: same visual family as the board's WEEK | DAY switch.
    const tabsRow = el.createDiv({ cls: 'iplan-tray-tabs' });
    const seg = tabsRow.createDiv({ cls: 'iplan-seg', attr: { role: 'tablist', 'aria-label': 'Tray panel' } });
    for (const tab of trayVisibleTabs(this.contextIsBoard)) {
      const b = seg.createEl('button', {
        cls: 'iplan-seg-btn', text: trayTabLabel(tab),
        attr: { role: 'tab', 'aria-selected': String(this.activeTab === tab) },
      });
      if (this.activeTab === tab) b.addClass('is-active');
      b.addEventListener('click', () => this.setTab(tab));
    }

    if (this.activeTab === 'agenda') this.renderAgenda(el, items, today);
    else if (this.activeTab === 'goals') this.renderGoals(el, items);
    else this.renderSync(el, items, today);
  }

  /* ---- AGENDA: today's plan, chronological, read-plus-click ---- */
  renderAgenda(el, items, today) {
    const events = this.plugin.calendarDefs
      ? icsEventsForWeek(this.plugin.calendarDefs, mondayOf(today), this.plugin.splitHour())
      : [];
    const model = agendaSections(items, events, today);

    const dayHead = el.createDiv({ cls: 'iplan-tray-agenda-head' });
    dayHead.createSpan({ cls: 'iplan-tray-agenda-title', text: fmtDayTitle(today, today) });
    dayHead.createSpan({ cls: 'iplan-week-label', text: fmtDayLabel(today) });

    if (model.allDay.length) {
      const band = el.createDiv({ cls: 'iplan-tray-allday' });
      for (const ev of model.allDay) {
        const chip = band.createDiv({ cls: 'iplan-event iplan-event-allday' });
        if (ev.continues) chip.addClass('is-continues');
        chip.createSpan({ cls: 'iplan-event-title', text: ev.title });
        wireEventChip(this.plugin, chip, ev);
      }
    }

    for (const half of ['am', 'pm']) {
      const sec = el.createDiv({ cls: 'iplan-tray-section' });
      sec.createDiv({ cls: 'iplan-tray-section-head', text: half === 'am' ? 'MORNING' : 'AFTERNOON' });
      const body = sec.createDiv({ cls: 'iplan-tray-section-body' });
      const seq = model[half];
      if (!seq.length) {
        body.createDiv({ cls: 'iplan-tray-note', text: 'Nothing planned.' });
        continue;
      }
      for (const entry of seq) {
        if (entry.kind === 'event') {
          const chip = body.createDiv({ cls: 'iplan-event' });
          chip.createSpan({ cls: 'iplan-event-time', text: fmtTimeHM(entry.ev.start) });
          chip.createSpan({ cls: 'iplan-event-title', text: entry.ev.title });
          wireEventChip(this.plugin, chip, entry.ev);
        } else {
          body.appendChild(renderCard(this.plugin, entry.it, 'tray', this));
        }
      }
    }
  }

  /* ---- GOALS: only the weekly-goals list ---- */
  renderGoals(el, items) {
    const goals = items.filter((i) => i.weeklyGoal && !isDone(i));
    const sec = el.createDiv({ cls: 'iplan-tray-section' });
    sec.createDiv({ cls: 'iplan-tray-section-head', text: 'WEEKLY GOALS' });
    const body = sec.createDiv({ cls: 'iplan-tray-section-body' });
    if (!goals.length) {
      body.createDiv({ cls: 'iplan-tray-note', text: 'No weekly goals yet. Mark one from a card’s menu.' });
    }
    for (const g of goals) body.appendChild(renderCard(this.plugin, g, 'tray', this));
  }

  /* ---- the add-a-task composer (2026-08-30) ---------------------------------
   *
   * Chrome: the first element below the tab strip, and its position never
   * moves. Clicking the trigger replaces the trigger row with the input row IN
   * PLACE, so nothing jumps and no new region opens. Escape restores the
   * trigger. Enter commits and keeps the field open for the next one; Enter on
   * an empty field does nothing and stays open (no error state, no red).
   * Commit feedback is the row appearing in MANUAL, nothing more.
   */
  openComposer() {
    this.composerOpen = true;
    this._composerWantsFocus = true;
    this.render();
  }

  closeComposer() {
    this.composerOpen = false;
    this.composerDraft = '';
    this._composerWantsFocus = false;
    this.render();
  }

  async commitComposer(value) {
    const path = await this.plugin.addManualItem(value);
    if (!path) return false;
    this.composerDraft = '';
    // Keep the field open and focused for a second entry: capture is a burst
    // activity, and reopening the trigger between two tasks costs a click each
    // time. emitModelChanged re-renders us, so the flag is what survives.
    this._composerWantsFocus = true;
    return true;
  }

  renderComposer(el) {
    const wrap = el.createDiv({ cls: 'iplan-tray-add' });
    if (!this.composerOpen) {
      const btn = wrap.createEl('button', {
        cls: 'iplan-action is-quiet',
        attr: { type: 'button', 'aria-label': 'Add a task' },
      });
      btn.createSpan({ cls: 'iplan-kicker-marker', text: '+' });
      btn.createSpan({ text: 'ADD TASK' });
      btn.addEventListener('click', () => this.openComposer());
      return;
    }
    const input = wrap.createEl('input', {
      cls: 'iplan-add-input',
      attr: {
        type: 'text', placeholder: 'What needs doing?',
        'aria-label': 'New task title', enterkeyhint: 'done',
        autocomplete: 'off', spellcheck: 'false',
      },
    });
    input.value = this.composerDraft || '';
    input.addEventListener('input', () => { this.composerDraft = input.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.closeComposer(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const value = input.value.trim();
      if (!value) return;              // nothing to say, nothing to complain about
      input.value = '';
      this.composerDraft = '';
      this.commitComposer(value);
    });
    // Blur closes an EMPTY field so the trigger comes back; a field with a
    // draft in it stays, because losing typed text to a stray click is worse
    // than an input that outstays its welcome.
    //
    // Deferred, and that is not cosmetic: blur fires BEFORE click, and
    // closeComposer re-renders the whole tray. Closing synchronously would
    // destroy the card the user just pressed on before its click handler ever
    // ran, so clicking a card while the composer was open would do nothing.
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        if (this.composerOpen && !(this.composerDraft || '').trim()
          && document.activeElement !== input) this.closeComposer();
      }, 120);
    });
    // Focus only when WE opened it. A re-render triggered by a sync landing
    // must never yank the caret out of whatever the user is typing in.
    if (this._composerWantsFocus) {
      this._composerWantsFocus = false;
      input.focus();
      const n = input.value.length;
      try { input.setSelectionRange(n, n); } catch { /* not all inputs support it */ }
    }
  }

  /* ---- SYNC: the classic tray (goals pinned + unscheduled by source) ---- */
  renderSync(el, items, today) {
    const conn = trayConnectionState(this.plugin.settings);

    // 1. The composer. Chrome, first, always, in every connection state.
    this.renderComposer(el);

    // 2. Nothing connected: ONE call to action, in place of the same sentence
    //    repeated under three section heads. The three heads do not render at
    //    all here: a head carrying a count of nothing, in a state where nothing
    //    can arrive, is three zero-count facts. It sits directly under the
    //    composer because the sentence points at it.
    if (conn.allCold) {
      const lead = el.createDiv({ cls: 'iplan-tray-lead' });
      lead.createDiv({ cls: 'iplan-tray-lead-text', text: TRAY_COPY.lead });
      const cta = lead.createEl('button', {
        cls: 'iplan-action', attr: { type: 'button' }, text: TRAY_COPY.leadAction,
      });
      cta.addEventListener('click', () => this.plugin.openPluginSettings());
    }

    /* ---- weekly goals, pinned on top of the lists ---- */
    const goals = items.filter((i) => i.weeklyGoal && !isDone(i));
    if (goals.length) {
      const sec = el.createDiv({ cls: 'iplan-tray-section' });
      sec.createDiv({ cls: 'iplan-tray-section-head', text: 'WEEKLY GOALS' });
      for (const g of goals) sec.appendChild(renderCard(this.plugin, g, 'tray', this));
    }

    /* ---- unscheduled, by source ---- */
    const bucketRank = { overdue: 0, today: 1, upcoming: 2, none: 3 };
    const anyManualEver = items.some((i) => i.source === MANUAL_SOURCE);
    for (const key of TASK_SOURCES) {
      // MANUAL is dropped until a manual task has existed: an empty section
      // under a labelled ADD TASK row says nothing the user cannot already see.
      if (key === MANUAL_SOURCE && !anyManualEver) continue;
      // In the all-cold state the synced heads are replaced by the lead block.
      if (key !== MANUAL_SOURCE && conn.allCold) continue;

      const meta = SOURCES[key];
      const configured = sourceConfigured(this.plugin.settings, key);
      const st = this.plugin.syncStatus[key];
      const list = items
        .filter((i) => i.source === key && !i.plannedDay && !isDone(i) && !i.weeklyGoal)
        .sort((a, b) => {
          const br = bucketRank[dueBucketOf(a.due, today)] - bucketRank[dueBucketOf(b.due, today)];
          if (br) return br;
          if (a.priority !== b.priority) return a.priority - b.priority;
          return (a.due || '9999').localeCompare(b.due || '9999');
        });

      const sec = el.createDiv({ cls: 'iplan-tray-section' });
      const headRow = sec.createDiv({ cls: 'iplan-tray-section-head is-clickable' });
      headRow.appendChild(sourceMarkEl(key));
      headRow.createSpan({ text: ` ${meta.label.toUpperCase()}` });
      headRow.createSpan({ cls: 'iplan-tray-count', text: String(list.length) });
      const body = sec.createDiv({ cls: 'iplan-tray-section-body' });
      if (this.collapsed[key]) sec.addClass('is-collapsed');
      headRow.addEventListener('click', () => {
        this.collapsed[key] = !this.collapsed[key];
        sec.classList.toggle('is-collapsed', this.collapsed[key]);
      });

      // The one authority on what this section is allowed to claim.
      const total = key === MANUAL_SOURCE
        ? items.filter((i) => i.source === MANUAL_SOURCE).length
        : undefined;
      const state = trayEmptyState(key, configured, st, list.length, total);
      if (state && state.kind === 'unconfigured') {
        const note = body.createDiv({ cls: 'iplan-tray-note is-unconfigured' });
        note.createSpan({ text: state.text });
        const connect = note.createEl('button', {
          cls: 'iplan-action',
          attr: { type: 'button', 'aria-label': `Connect ${meta.label}` },
          text: TRAY_COPY.connectAction,
        });
        connect.addEventListener('click', () => this.plugin.openPluginSettings());
      } else if (state) {
        const note = body.createDiv({ cls: 'iplan-tray-note', text: state.text });
        if (state.hint) {
          const hintEl = note.createDiv({ cls: 'iplan-tray-note-hint', text: state.hint });
          if (state.docUrl) {
            hintEl.appendText(' ');
            const a = hintEl.createEl('a', { text: 'Open', href: state.docUrl });
            a.addEventListener('click', (e) => { e.preventDefault(); window.open(state.docUrl, '_external'); });
          }
        }
      }
      for (const it of list) body.appendChild(renderCard(this.plugin, it, 'tray', this));
    }

    const foot = el.createDiv({ cls: 'iplan-tray-foot' });
    foot.createSpan({ text: 'DRAG A CARD ONTO THE WEEK. DROP IT BACK HERE TO UNSCHEDULE.' });
  }
}

/* ========================================================================== *
 * Settings
 * ========================================================================== */

class IcorPlannerSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const secret = (setting, get, set, placeholder) => {
      setting.addText((t) => {
        t.setPlaceholder(placeholder || '').setValue(get());
        t.inputEl.type = 'password';
        t.inputEl.autocomplete = 'off';
        t.onChange(async (v) => { set(v.trim()); await this.plugin.saveSettings(); });
      });
    };

    // The planner folder. Typing validates live (announced); Apply commits,
    // moving the existing notes with a link-safe rename when the new folder
    // does not exist yet, refusing when both exist rather than guessing.
    new Setting(containerEl).setName('Vault').setHeading();
    const folderSetting = new Setting(containerEl).setName('Planner folder');
    folderSetting.descEl.setAttribute('aria-live', 'polite');
    let pendingFolder = this.plugin.settings.plannerFolder;
    let applyBtn = null;
    const folderPlan = () => {
      const n = normalizePlannerFolder(pendingFolder);
      if (!n.ok) return { ok: false, plan: null, text: n.error };
      const current = this.plugin.paths().root;
      const cur = this.app.vault.getAbstractFileByPath(current);
      const nxt = this.app.vault.getAbstractFileByPath(n.folder);
      const plan = plannerFolderChangePlan({ current, next: n.folder, currentExists: cur instanceof TFolder, nextExists: nxt instanceof TFolder });
      return { ok: plan.action !== 'refuse' && plan.action !== 'noop', plan, folder: n.folder, current: cur, text: plan.reason };
    };
    const renderFolderPlan = () => {
      const fp = folderPlan();
      folderSetting.setDesc(fp.text);
      if (applyBtn) {
        applyBtn.setDisabled(!fp.ok);
        applyBtn.setButtonText(fp.plan && fp.plan.action === 'move' ? 'Move and apply' : 'Apply');
      }
    };
    folderSetting.addText((t) => t.setPlaceholder(DEFAULT_SETTINGS.plannerFolder).setValue(pendingFolder)
      .onChange((v) => { pendingFolder = v; renderFolderPlan(); }));
    folderSetting.addButton((b) => {
      applyBtn = b;
      b.setButtonText('Apply').onClick(async () => {
        const fp = folderPlan();
        if (!fp.ok) return;
        b.setDisabled(true);
        try {
          if (fp.plan.action === 'move') await this.app.fileManager.renameFile(fp.current, fp.folder);
          this.plugin.settings.plannerFolder = fp.folder;
          await this.plugin.saveSettings();
          await this.plugin.ensureFolders();
          new Notice(`Planner: now using "${fp.folder}".`);
          this.display();
        } catch (e) {
          folderSetting.setDesc(`Could not apply: ${e && e.message ? e.message : e}`);
          b.setDisabled(false);
        }
      });
      renderFolderPlan();
    });

    new Setting(containerEl).setName('Todoist').setHeading();
    secret(new Setting(containerEl)
      .setName('API token')
      .setDesc('Todoist -> Settings -> Integrations -> Developer -> API token.'),
      () => this.plugin.settings.todoistToken,
      (v) => { this.plugin.settings.todoistToken = v; }, 'paste token');

    new Setting(containerEl).setName('ClickUp').setHeading();
    secret(new Setting(containerEl)
      .setName('Personal API token')
      .setDesc('ClickUp -> avatar -> Settings -> Apps -> API Token. Starts with pk_.'),
      () => this.plugin.settings.clickupToken,
      (v) => { this.plugin.settings.clickupToken = v; }, 'pk_...');
    new Setting(containerEl)
      .setName('Workspace ID (optional)')
      .setDesc('Leave empty to read every workspace the token can see.')
      .addText((t) => t.setValue(this.plugin.settings.clickupTeamId)
        .onChange(async (v) => { this.plugin.settings.clickupTeamId = v.trim(); await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Starred email (IMAP)').setHeading();
    const setup = containerEl.createEl('details', { cls: 'iplan-setup' });
    setup.createEl('summary', { text: 'Setup guide: app passwords per provider' });
    const setupBody = setup.createEl('div', { cls: 'iplan-setup-body' });
    setupBody.createEl('p', {
      text: 'Any IMAP mailbox works: star or flag an email and it lands in the planner tray as a task. Reading is strictly read-only; the one write is unstarring on complete, and only while "Complete on source" is on. Most providers want an app password here, never your normal one:',
    });
    const setupList = setupBody.createEl('ul');
    const li = (before, linkText, href, after) => {
      const item = setupList.createEl('li');
      item.appendText(before);
      if (href) {
        const a = item.createEl('a', { text: linkText, href });
        a.addEventListener('click', (e) => { e.preventDefault(); window.open(href, '_external'); });
      }
      if (after) item.appendText(after);
    };
    li('Gmail: turn on 2-step verification, then create one at ',
      'myaccount.google.com/apppasswords', 'https://myaccount.google.com/apppasswords',
      ' (host imap.gmail.com).');
    li('iCloud: app-specific password at ',
      'account.apple.com', 'https://account.apple.com/account/manage',
      ' (host imap.mail.me.com).');
    li('Fastmail: Settings, Privacy & Security, app passwords (host imap.fastmail.com).', null, null, null);
    li('Proton Mail: install Proton Bridge, pick the Proton Bridge preset above the host, and use the mailbox password Bridge shows (host 127.0.0.1, port 1143, STARTTLS, its own certificate).', null, null, null);
    li('GMX / web.de and most others: enable IMAP in the webmail settings first. Outlook / Microsoft 365 retired password IMAP and cannot connect here.', null, null, null);
    // Presets: one chip per known provider fills the host and the
    // connection shape. A radio group for the keyboard and the screen reader
    // (arrow keys move, aria-checked says which is on), rendered on the
    // planner's own segmented control so it reads like the rest of the plugin.
    const presetSetting = new Setting(containerEl)
      .setName('Provider')
      .setDesc('Fills the host and the connection settings for a known provider. Any other IMAP host works too: type it below.');
    const presetGroup = presetSetting.controlEl.createDiv({ cls: 'iplan-seg iplan-settings-presets', attr: { role: 'radiogroup', 'aria-label': 'Email provider preset' } });
    const activePreset = imapActivePreset(this.plugin.settings);
    const presetButtons = [];
    for (const preset of IMAP_PRESETS) {
      const on = preset.id === activePreset;
      const btn = presetGroup.createEl('button', {
        cls: `iplan-seg-btn${on ? ' is-active' : ''}`, text: preset.label,
        attr: { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', tabindex: on || (!activePreset && preset === IMAP_PRESETS[0]) ? '0' : '-1', 'data-preset': preset.id },
      });
      btn.addEventListener('click', async () => {
        Object.assign(this.plugin.settings, imapPresetFields(preset));
        await this.plugin.saveSettings();
        this.display();
        const again = this.containerEl.querySelector(`[data-preset="${preset.id}"]`);
        if (again) again.focus();
      });
      btn.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const i = presetButtons.indexOf(btn);
        const nextBtn = presetButtons[(i + (e.key === 'ArrowRight' ? 1 : presetButtons.length - 1)) % presetButtons.length];
        nextBtn.focus();
      });
      presetButtons.push(btn);
    }
    // The host decides the provider, and the provider decides the one
    // sentence that unblocks most first attempts. It re-renders as the host
    // is typed, so the advice is never about a host the field no longer says.
    const hostSetting = new Setting(containerEl).setName('IMAP host');
    const renderHostHint = (host) => {
      const p = imapProviderOf(host);
      hostSetting.descEl.empty();
      if (!p.hint) return;
      hostSetting.descEl.appendText(p.hint);
      if (p.appPasswordUrl) {
        hostSetting.descEl.appendText(' ');
        const a = hostSetting.descEl.createEl('a', { text: 'Open', href: p.appPasswordUrl });
        a.addEventListener('click', (e) => { e.preventDefault(); window.open(p.appPasswordUrl, '_external'); });
      }
    };
    hostSetting.addText((t) => t.setValue(this.plugin.settings.imapHost)
      .onChange(async (v) => {
        this.plugin.settings.imapHost = v.trim();
        renderHostHint(v);
        renderSelfSigned(v);
        await this.plugin.saveSettings();
      }));
    renderHostHint(this.plugin.settings.imapHost);
    new Setting(containerEl)
      .setName('Port')
      .setDesc('993 for TLS with most providers; 1143 for Proton Bridge.')
      .addText((t) => t.setPlaceholder('993').setValue(String(this.plugin.settings.imapPort || 993))
        .onChange(async (v) => {
          const n = Number(v.trim());
          if (Number.isInteger(n) && n > 0 && n < 65536) { this.plugin.settings.imapPort = n; await this.plugin.saveSettings(); }
        }));
    new Setting(containerEl)
      .setName('Security')
      .setDesc('TLS connects encrypted from the first byte (the default). STARTTLS opens a plain connection and upgrades it before the login; if the host refuses the upgrade, nothing is sent.')
      .addDropdown((d) => d
        .addOption('tls', 'TLS (default)')
        .addOption('starttls', 'STARTTLS')
        .setValue(this.plugin.settings.imapSecurity === 'starttls' ? 'starttls' : 'tls')
        .onChange(async (v) => {
          this.plugin.settings.imapSecurity = v === 'starttls' ? 'starttls' : 'tls';
          await this.plugin.saveSettings();
        }));
    // The allowance is a toggle that only means something for a host on this
    // machine, and the transport enforces the same rule regardless of what
    // the toggle says. Off-loopback it is disabled with the reason stated.
    const selfSignedSetting = new Setting(containerEl).setName('Accept a self-signed certificate');
    let selfSignedToggle = null;
    const renderSelfSigned = (host) => {
      const loop = isLoopbackHost(host);
      selfSignedSetting.setDesc(loop
        ? 'The host is on this machine, so its own certificate (Proton Bridge makes one) can be accepted.'
        : 'Only for a host on this machine (127.0.0.1, localhost). A remote host is always verified.');
      if (selfSignedToggle) selfSignedToggle.setDisabled(!loop);
    };
    selfSignedSetting.addToggle((t) => {
      selfSignedToggle = t;
      t.setValue(!!this.plugin.settings.imapAllowSelfSigned)
        .onChange(async (v) => { this.plugin.settings.imapAllowSelfSigned = v; await this.plugin.saveSettings(); });
      renderSelfSigned(this.plugin.settings.imapHost);
    });
    new Setting(containerEl)
      .setName('Email address')
      .addText((t) => t.setValue(this.plugin.settings.imapUser)
        .onChange(async (v) => { this.plugin.settings.imapUser = v.trim(); await this.plugin.saveSettings(); }));
    secret(new Setting(containerEl)
      .setName('App password')
      .setDesc('Never your normal password. Paste the app password without spaces.'),
      () => this.plugin.settings.imapPassword,
      (v) => { this.plugin.settings.imapPassword = v.replace(/\s+/g, ''); }, 'app password');
    // Test connection: the probe logs in and straight out, so a wrong host,
    // port, certificate or password is named here, now, with the same
    // sentence the tray would show after the next sync. The outcome lands in
    // a live region so a screen reader hears it without hunting for it.
    const probeSetting = new Setting(containerEl)
      .setName('Test connection')
      .setDesc('Logs in and straight out. Reads nothing, writes nothing.');
    probeSetting.descEl.setAttribute('aria-live', 'polite');
    const renderProbe = (r) => {
      probeSetting.descEl.empty();
      probeSetting.descEl.toggleClass('is-ok', !!r.ok);
      probeSetting.descEl.toggleClass('is-failed', !r.ok);
      probeSetting.descEl.appendText(r.message);
      if (r.hint) { probeSetting.descEl.createEl('br'); probeSetting.descEl.appendText(r.hint); }
      if (r.docUrl) {
        probeSetting.descEl.appendText(' ');
        const a = probeSetting.descEl.createEl('a', { text: 'Open', href: r.docUrl });
        a.addEventListener('click', (e) => { e.preventDefault(); window.open(r.docUrl, '_external'); });
      }
    };
    probeSetting.addButton((b) => b.setButtonText('Test').onClick(async () => {
      b.setDisabled(true);
      probeSetting.descEl.empty();
      probeSetting.descEl.appendText('Connecting...');
      try { renderProbe(await imapProbe(this.plugin.settings)); }
      finally { b.setDisabled(false); }
    }));

    new Setting(containerEl).setName('Google Calendar').setHeading();
    secret(new Setting(containerEl)
      .setName('Secret iCal URL')
      .setDesc('Google Calendar -> Settings -> your calendar -> Integrate calendar -> "Secret address in iCal format". Read-only, no OAuth needed. Treat the URL like a password.'),
      () => this.plugin.settings.icsUrl,
      (v) => { this.plugin.settings.icsUrl = v; }, 'https://calendar.google.com/calendar/ical/...');

    new Setting(containerEl).setName('Board').setHeading();
    new Setting(containerEl)
      .setName('Sync interval (minutes)')
      .addText((t) => t.setValue(String(this.plugin.settings.syncMinutes))
        .onChange(async (v) => {
          const n = Math.max(2, Number(v) || 10);
          this.plugin.settings.syncMinutes = n;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Upcoming event badge')
      .setDesc('Shows your next calendar event with a live countdown below the ribbon on the left (desktop only). When the event carries a meeting link (Zoom, Google Meet, Teams, Webex, Whereby, Jitsi), clicking the badge opens the meeting; otherwise it opens the board.')
      .addToggle((t) => t.setValue(this.plugin.settings.showNextBadge)
        .onChange(async (v) => {
          this.plugin.settings.showNextBadge = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.setupNextBadge(); else this.plugin.removeNextBadge();
        }));
    new Setting(containerEl)
      .setName('Show weekend')
      .addToggle((t) => t.setValue(this.plugin.settings.showWeekend)
        .onChange(async (v) => { this.plugin.settings.showWeekend = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Morning / afternoon split')
      .setDesc('HH:MM. Timed events before this hour land in the morning lane.')
      .addText((t) => t.setValue(this.plugin.settings.splitTime)
        .onChange(async (v) => {
          if (/^\d{1,2}:\d{2}$/.test(v.trim())) { this.plugin.settings.splitTime = v.trim(); await this.plugin.saveSettings(); }
        }));
    new Setting(containerEl)
      .setName('Lunch break')
      .setDesc('Renders a lunch band between morning and afternoon instead of the split line. Its height follows its length.')
      .addToggle((t) => t.setValue(this.plugin.settings.lunchEnabled)
        .onChange(async (v) => { this.plugin.settings.lunchEnabled = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Lunch from / until')
      .setDesc('HH:MM. With the lunch break on, its start also decides what still counts as morning.')
      .addText((t) => t.setPlaceholder('12:30').setValue(this.plugin.settings.lunchStart)
        .onChange(async (v) => {
          if (/^\d{1,2}:\d{2}$/.test(v.trim())) { this.plugin.settings.lunchStart = v.trim(); await this.plugin.saveSettings(); }
        }))
      .addText((t) => t.setPlaceholder('13:30').setValue(this.plugin.settings.lunchEnd)
        .onChange(async (v) => {
          if (/^\d{1,2}:\d{2}$/.test(v.trim())) { this.plugin.settings.lunchEnd = v.trim(); await this.plugin.saveSettings(); }
        }));
    new Setting(containerEl)
      .setName('Workday start / end')
      .setDesc('Drives the live progress marker on today.')
      .addText((t) => t.setPlaceholder('08:00').setValue(this.plugin.settings.dayStart)
        .onChange(async (v) => {
          if (/^\d{1,2}:\d{2}$/.test(v.trim())) { this.plugin.settings.dayStart = v.trim(); await this.plugin.saveSettings(); }
        }))
      .addText((t) => t.setPlaceholder('18:00').setValue(this.plugin.settings.dayEnd)
        .onChange(async (v) => {
          if (/^\d{1,2}:\d{2}$/.test(v.trim())) { this.plugin.settings.dayEnd = v.trim(); await this.plugin.saveSettings(); }
        }));

    new Setting(containerEl).setName('Two-way sync').setHeading();
    new Setting(containerEl)
      .setName('Complete on source')
      .setDesc('Checking a card here also closes the task in Todoist / ClickUp and unstars the email. Unchecking reopens or re-stars it, also after a sync has confirmed the close. Off = completing stays local to this vault: a task the source closed cannot be reopened from here, and a checked recurring task stays struck until it is completed in the source app.')
      .addToggle((t) => t.setValue(this.plugin.settings.completeOnSource)
        .onChange(async (v) => { this.plugin.settings.completeOnSource = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('When a recurring task moves to its next date')
      .setDesc('A recurring task keeps one card. When its due date moves on (completed here or in the source app) the check clears and the card reopens; this decides where it lands. The finished occurrence stays on the day it was planned, struck through.')
      .addDropdown((d) => d
        .addOption('move', 'Move the card to the new date (default)')
        .addOption('drop', 'Send the card back to the tray')
        .setValue(this.plugin.settings.recurringAdvance === 'drop' ? 'drop' : 'move')
        .onChange(async (v) => {
          this.plugin.settings.recurringAdvance = v === 'drop' ? 'drop' : 'move';
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Push edits to source')
      .setDesc('Due date, priority and description edits in the note flow back to Todoist and ClickUp. Only fields you changed since the last sync are pushed; if both sides changed, the source wins.')
      .addToggle((t) => t.setValue(this.plugin.settings.pushEdits)
        .onChange(async (v) => { this.plugin.settings.pushEdits = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Sync now')
      .setDesc(this.plugin.lastSyncAt ? `Last sync ${fmtTimeHM(this.plugin.lastSyncAt)}.` : 'No sync yet this session.')
      .addButton((b) => b.setButtonText('Sync').setCta()
        .onClick(() => this.plugin.syncNow(true)));
  }
}

module.exports = IcorPlannerPlugin;

// Headless test surface (harmless in Obsidian; the test harness reaches the
// internals through it instead of duplicating them).
module.exports.__test = {
  mondayOf, addDays, dayInWeek, dueBucketOf, weekDays, fmtWeekLabel,
  decodeRfc2047, icsUnescape,
  todoistPriorityRank, imapSplitResponses, imapQuote,
  imapProviderOf, classifyImapError, imapReplyError, imapReasonToConnector, imapConnect, IMAP_PROVIDERS,
  imapTransportOptions, imapTlsOptions, imapSession, imapItemsFromFetch, imapFetchStarredRaw, imapSetStarredRaw,
  imapPreflight, imapProbe, IMAP_PRESETS, imapPresetFields, imapActivePreset,
  isLoopbackHost, isIpLiteral, imapStarttlsError,
  parseIcs, icsParseDate, expandOccurrences, icsEventsForWeek,
  googleCalendarEventUrl,
  serializeCalendarDefs, reviveCalendarDefs,
  buildCalendarCacheContent, parseCalendarCacheContent,
  detectConferenceUrl, nextUpcomingEvent, fmtBadgeCountdown,
  CONFERENCE_URL_PATTERNS,
  plannerPaths, normalizePlannerFolder, detectPlannerFolder, plannerFolderChangePlan, gitignoreLineFor, collectItems,
  zonedToUtc, tzOffsetMinutes, hmToMin, lunchBandHeight,
  WINDOWS_TZ_TO_IANA, normalizeTzid, isIanaZone, resolveTzid, tzidUtcPrefixOffset,
  icsUtcOffsetToMinutes, ianaForOffsets, calendarTzWarning, degraded, okResult,
  threeWayMerge, todoistApiPriority, TWO_WAY_FIELDS,
  htmlishToText, segmentInfo, fmtLeft, fmtDayTitle, fmtDayLabel,
  trayDefaultTab, trayVisibleTabs, trayTabLabel, trayEffectiveTab,
  trayEmptyState, trayConnectionState, TRAY_COPY, fmtOpenItems,
  trayRevealDecision, trayRevealSpendsTurn,
  sourceConfigured, isSyncedSource, canPushToSource, canCompleteOnSource,
  SYNCED_SOURCES, TASK_SOURCES, MANUAL_SOURCE, FETCHED_SOURCES, CONNECTORS,
  manualExternalId, manualItemFrontmatter, reconcileStaleIds,
  itemFromFrontmatter, clampPriorityRank, safeBasename,
  syncCompletionPlan, occurrenceAdvanced, reopenDecision, appendOccurrence,
  ghostItemsFor, pruneShadows, normalizeOccurrences, OCCURRENCE_CAP, DONE_SHADOW_MAX_AGE_MS,
  agendaSections, laneSequence, TRAY_TABS,
  todoistFetchOpen, clickupFetchOpen, emailFetchStarred, calendarFetchDefs,
  SOURCES, DEFAULT_SETTINGS,
};
