# ICOR for Life - Planner

Your week, planned in one place. Right now your tasks live in Todoist, in
ClickUp, in starred emails, in the calendar, and planning a week means
re-reading four apps and holding the result in your head. ICOR for Life - Planner
syncs all of it into your vault as plain markdown notes and gives you one
board: drag a card onto a morning or afternoon lane and that part of the
week is decided.

**Beta release.** This plugin works and is in daily use in a real vault,
but you will find rough edges. If something looks off, open an issue on
this repo, or post in the ICOR for Life community: the
[planner channel](https://app.myicor.com/icor-for-life?channel=planner)
for questions and ideas, the
[bug-reports channel](https://app.myicor.com/icor-for-life?channel=bug-reports)
for defects. It gets fixed fast.

## What it does

- Add a task by hand straight from the tray, with no account and no API key:
  it becomes a note in `02 Planner/Manual/` and behaves exactly like a synced
  one on the board. The planner is useful on a fresh vault before you have
  connected anything.
- Syncs open tasks from Todoist and ClickUp, starred emails from any IMAP
  mailbox, flagged emails from Outlook, and events from as many calendars
  as you paste, one iCal address each (Google, iCloud, Proton, Outlook, or
  any other feed), plus your Outlook calendar once you are signed in.
- Several calendars at once: each one has a name and one of four edge
  colours on its chips, the event card names it, an event present in two
  calendars shows once, and one calendar failing to load leaves the
  others live and says which one failed.
- Email providers: Gmail, iCloud and Fastmail have one-click presets and
  want an app password, never your account password (the settings tab
  says which and links where). Any other IMAP host works by typing it.
  Proton Mail connects through Proton Bridge: pick the Proton Bridge
  preset (host 127.0.0.1, port 1143, STARTTLS, the Bridge's own
  certificate accepted because the host is this machine) and use the
  mailbox password shown inside the Bridge app, with Bridge running.
  Outlook / Microsoft 365 retired password IMAP; it connects through its
  own section instead (next bullet). A Test connection button logs in and
  straight out, reads nothing, and names what went wrong within one
  attempt.
- Outlook / Microsoft 365 / outlook.com: sign in with your own Microsoft
  app registration and your flagged emails land in the tray as tasks, your
  Outlook calendar joins the board with a colour of its own, and checking
  a card can mark the email complete (behind "Complete on source"). A
  Microsoft account is required, and you register the app yourself in it,
  about ten minutes, once: the step-by-step guide is
  [docs/outlook-setup-guide.md](docs/outlook-setup-guide.md). Nothing
  passes through myICOR: the client id is yours, the tokens are yours, and
  they live in Obsidian's secret storage, outside the vault and outside
  `data.json` (or in your vault on an older Obsidian).
  Works on desktop and mobile; the sign-in comes back through an
  `obsidian://` link, with a device code as the fallback.
- A Planner button on the file-tree toolbar under the sidebar logo, and
  one in the left ribbon, open the weekly board and bring the tray up in
  the right sidebar with it. That happens once per session: if you close
  the tray or collapse the sidebar, opening the board again leaves it
  alone. The planner folder itself opens like any folder.
- The tray has four tabs. TASKS holds the unscheduled items grouped by
  source, with your weekly goals pinned on top. HABITS plans the week's
  habits: one row per habit, seven weekday toggles. AGENDA answers "what is
  planned today", in order. GOALS is the weekly-goals list on its own.
  TASKS and HABITS show while the board is the active page; AGENDA and
  GOALS follow you everywhere else.
- Drag a card onto a day's AM or PM lane to plan it; drag it back to the
  tray to unschedule. On mobile, long-press a card and pick "Plan on...".
  Calendar events render read-only in their lanes.
- Routines: a block of steps at a time of day (morning, afternoon or
  evening), on the weekdays you pick. Each one is a note in
  `02 Planner/Routines/`; its block sits in the lane at its time, its steps
  check off one by one with the count on the card, and every day's result
  is a row in the note, readable by you and by the AI team.
- Habits: the habit notes in your vault's Habits room
  (`04 Inner World/My Life/Habits` by default) appear as an all-day HABITS
  block under each day they are scheduled for, on the board and in the
  AGENDA tab. Checking one writes a row into the habit note's log table,
  the same row the AI team writes when it asks you in chat, so the two are
  one record; a streak count comes from that table and is never stored.
  The HABITS tab moves a habit from one weekday to another by writing
  `cadence` and `cadence_days` into its note.
- Subtasks: a Todoist or ClickUp subtask is a card that names its parent
  above its own title, and the parent card reads "n of m subtasks" with a
  chevron that opens the list; checking a row there is the same check as
  on the subtask's own card, and a subtask planned on another day shows
  that day (or TRAY). Dragging a parent moves the parent alone. ClickUp
  subtasks are fetched only when you turn that on. A recurring task wears
  a repeat mark, and when its due date moves on, its subtasks come back
  unchecked with it.
- Every synced task becomes a markdown note in `02 Planner/<Source>/`
  with the plan state in frontmatter, so the AI team can read and move
  items too.
- The room can be called what you like. `02 Planner` is the default; a
  room renamed to `Planner` or `2 Planner` is found on the next launch
  when it is the only folder called that, and the setting "Planner
  folder" moves the notes to a new folder with links kept intact. When
  two folders qualify the plugin asks instead of guessing.
- Calendar events mirror into one cache note, `02 Planner/Calendar
  Events.md`, so the board renders instantly on relaunch (pale and
  pulsing until the fresh fetch lands) and your schedule is readable
  vault state.
- A strip above the sidebar logo shows your next event with a live
  countdown, across the full width of the left sidebar (desktop and
  mobile, toggleable). It also counts down to a routine that is due. When
  the event carries a meeting link (Zoom, Google Meet, Teams, Webex,
  Whereby, Jitsi), clicking the strip opens the meeting; otherwise it
  opens the board. The same link appears as a JOIN MEETING button in the
  event detail. Nothing left on today's clock, no strip.
- Two-way sync, each direction under its own switch: with "Complete on
  source" on, checking a card closes the task in Todoist / ClickUp and
  unstars the email (unchecking reopens / re-stars). With "Push edits to
  source" on, due date, priority and description edits in the note flow
  back to Todoist and ClickUp. Only fields you changed since the last
  sync are pushed; when both sides changed, the source wins. The calendar
  is always read-only. A recurring task keeps one card: when its due date
  moves on to the next occurrence (completed here or in Todoist) the check
  clears and the card moves to the new date, or back to the tray if you
  prefer, while the finished occurrence stays struck through on the day
  it was planned.

## What makes it different

- **The vault is the database.** Every item is a markdown note; change
  `planned_day` in any editor and the card moves on the board. Your week
  plan is text you own and can grep, not state locked inside a task app.
- **Write-back is opt-in, per direction.** Reading always works; nothing
  is written to Todoist, ClickUp or your mailbox unless you flipped that
  exact switch.
- **AM and PM, not hour slots.** You decide when in the day something
  happens, not the minute. That is the level a week can actually be
  planned at, and the level a plan survives the week at.

## Network use (disclosure)

With the matching key configured, the plugin talks to exactly these
services (reads always; writes only through the two toggles above):

- `api.todoist.com` (Todoist REST API v1) for your open tasks
- `api.clickup.com` (ClickUp API v2) for your open tasks
- your IMAP host and port, default `imap.gmail.com` on 993; STARTTLS or
  TLS as configured (STARTTLS never falls back to a plain login: if the
  host refuses the upgrade nothing is sent); a self-signed certificate is
  accepted only for a loopback host (127.0.0.1, localhost) and only with
  the toggle on; for starred emails, headers only; the sole write is the
  star flag, and only when "Complete on source" is on. Test connection
  opens the same connection, logs in and logs out.
- the iCal URLs you paste (one per calendar), for your events
- `login.microsoftonline.com` (the Microsoft sign-in and the token refresh,
  through your own app registration: PKCE, no client secret) and
  `graph.microsoft.com` (your flagged messages, your calendar events, and
  the one write: a message's flag status, only when "Complete on source"
  is on and only after the sign-in granted `Mail.ReadWrite`)

No telemetry, no other endpoints. Without keys the plugin makes no network
requests at all.

## Settings the plugin stores (`data.json`)

The connection settings, for anyone reading or scripting `data.json`:

| key | meaning | default |
| --- | --- | --- |
| `todoistToken`, `clickupToken` | **secret.** The task-source API tokens. On Obsidian 1.11.4 or newer these fields are empty and the values live in Obsidian's secret store (see Secrets below) | empty |
| `clickupTeamId` | the ClickUp workspace id, optional | empty |
| `imapHost`, `imapUser` | the mailbox host and address; neither is a secret | `imap.gmail.com`, empty |
| `imapPassword` | **secret.** The app password; empty here on Obsidian 1.11.4 or newer, where it lives in the secret store | empty |
| `imapPort` | the IMAP port | `993` |
| `imapSecurity` | `tls` (encrypted from the first byte) or `starttls` (plain connect, upgraded before login, never a plain login) | `tls` |
| `imapAllowSelfSigned` | accept the host's own certificate; honoured only when the host is loopback, enforced in the transport code, not just in the settings tab | `false` |
| `outlookClientId` | the Application (client) ID of your own Entra app; a public-client id, not a secret | empty |
| `outlookTenant` | the sign-in's account segment: `common`, `organizations` or `consumers` | `common` |
| `outlookRefreshToken`, `outlookAccessToken`, `outlookExpiresAt`, `outlookAccount` | **secret.** The Microsoft sign-in: the refresh token, the short-lived access token with its expiry, and the account name shown in settings. Empty here on Obsidian 1.11.4 or newer, where they live in the secret store; all four cleared by Sign out | empty |
| `outlookScopes` | the permissions the last sign-in granted, space-separated; `Mail.ReadWrite` appears once "Complete on source" has been switched on and consented to | empty |
| `calendars` | the calendar feeds, one entry each: `{ id, name, url, color, enabled, kind }`; `url` is the **secret** iCal address (empty here on Obsidian 1.11.4 or newer, where it lives in the secret store under the feed's `id`), `color` is a swatch index 1 to 4 (never a colour value), `kind` is `ics` (a pasted address) or `graph` (the Outlook calendar, added on sign-in, id `outlook-graph`; it has no address, so `url` stays empty and it is ready when Outlook is signed in). An `icsUrl` from a release before 0.8.0 becomes the first entry on the first launch and the key is then deleted | empty |
| `secretsInStore` | `true` once any secret has been written to Obsidian's secret storage. Not a secret; it lets an older Obsidian explain its empty fields | `false` |
| `plannerFolder` | the room folder every path derives from (`<folder>/Todoist`, `<folder>/Calendar Events.md`, `<folder>/Routines`); on launch a missing folder is replaced by the one top-level folder whose name ends in "planner", if there is exactly one | `02 Planner` |
| `routinesEnabled` | show routine blocks on the board and in the agenda; off hides them, the notes stay | `true` |
| `routineDefaults` | the times a new routine starts with, per type: `{ morning: { start, end }, afternoon: { start, end }, evening: { start, end } }`, each `HH:MM`; each routine keeps its own times in its note | `06:30` to `07:30`, `13:00` to `13:30`, `21:00` to `21:45` |
| `routineWeekdaysDefault` | the weekdays a new routine starts with, lowercase three-letter codes | `[mon, tue, wed, thu, fri]` |
| `habitsEnabled` | show the HABITS block under each day and the HABITS tab; off hides both, the notes stay | `true` |
| `habitsFolder` | the vault's Habits room, one note per habit, read flat (no subfolders); validated like the planner folder (never empty, never under `.obsidian`) | `04 Inner World/My Life/Habits` |
| `habitStreaks` | show `STREAK n` on a habit row, computed from the note's log at render, never written | `true` |
| `clickupIncludeSubtasks` | also fetch ClickUp subtasks assigned to you (`subtasks=true` on the task query); off so an existing board does not fill up on upgrade | `false` |
| `subtaskChecklist` | the "n of m subtasks" row and its list on a parent card; off leaves the counter out, subtask cards keep their parent line | `true` |

The board preferences (sync interval, weekend, split, lunch, workday,
strip, the two-way toggles) sit beside them under their own names.

## Secrets

Five things the plugin holds are secrets: the Todoist token, the ClickUp
token, the mailbox app password, every calendar feed address (a Google
secret address or a published Apple, Proton or Outlook link is a bearer
credential: anyone holding it can read the calendar), and the Outlook
sign-in (its refresh token, the short-lived access token with its expiry,
and the account name). Where they live depends on the Obsidian you run:

- **Obsidian 1.11.4 or newer (desktop and mobile):** in Obsidian's secret
  storage (outside the vault and outside `data.json`, so it is never
  synced or committed with your notes), under keys prefixed
  `icor-for-life-planner-`. Obsidian's own docs describe it as "stored
  in local storage, keyed to the specific vault"; it is not a system
  keyring. The fields in `data.json` are empty. On the first launch after
  updating, any secret still in `data.json` is moved over once and its
  field blanked; nothing to do. The settings tab says "Secrets are stored
  in Obsidian's secret storage".
- **Older Obsidian:** in this plugin's `data.json`, as before. The
  settings tab says so in one line. If a newer Obsidian on another
  machine has already moved this vault's secrets into its secret storage,
  the fields here are empty; paste them again or update Obsidian.

The secret store is feature-detected at load, so the plugin's minimum
Obsidian version is unchanged. Nothing the plugin writes into the vault
ever carries a secret: not the item notes, not the calendar cache, not a
log line. The plugin also writes a `.gitignore` guard into the vault so
its folder never reaches your vault's git repository, and this
repository ignores `data.json` itself. Treat an iCal address like a
password (it is one).

## The frontmatter contract (for people and agents)

Every item note carries `type: planner-item` plus:

| field | meaning | who writes it |
| --- | --- | --- |
| `source`, `external_id` | identity, the idempotency key | sync, or the tray for a manual item |
| `title`, `due`, `priority`, `url`, `tags`, `source_status` | source truth | sync |
| `status` | `open` or `done` (reconciled from the source) | sync |
| `planned_day` | `YYYY-MM-DD` or `null` | board, or any editor |
| `planned_half` | `am`, `pm`, or `null` | board, or any editor |
| `planned_order` | fractional rank inside the lane | board, or any editor |
| `done_local` | the check; with "Complete on source" on it also closes / reopens at the source | board, or any editor |
| `weekly_goal` | pins the item to the top of the tray | board, or any editor |
| `created_at` | manual items only, in place of `synced_at` | the tray |
| `recurring` | `true`, `false`, or `null` when the source cannot say (ClickUp, or a note from before the field existed) | sync |
| `due_string` | the source's own recurrence phrase ("every monday"), Todoist only | sync |
| `reopen_pending` | `true` between unchecking a source-closed card and the source confirming the reopen; reconcile stands down while set | board, cleared by sync |
| `last_completed_due` | the due date of the most recently finished occurrence of a recurring task | sync |
| `occurrences` | finished occurrences of a recurring task, oldest first, at most 30: `due`, `planned_day`, `planned_half`, `done_at`. Each one with a plan renders read-only on the board | sync |
| `parent_id` | the parent task's `external_id` within the same source (Todoist `parent_id`, ClickUp `parent`), or `null`. A child card names its parent; a parent card counts its children | sync |

Editing `planned_day` / `planned_half` in any editor moves the card; the
board re-renders live off the metadata cache.

When a recurring task's due date moves on, the setting "When a recurring
task moves to its next date" decides where the card lands: on the new
due day, keeping its morning / afternoon half (the default), or back in
the tray. A plan already made for a day on or after the new due stands
either way.

`source` is `todoist`, `clickup`, `email`, `outlook` or `manual`. An
`outlook` item is a flagged email: `due` is always empty (mail carries no
due date), `priority` follows the message's importance (high 1, normal 3,
low 4), `list_id` is the id of the mail folder it sits in, `source_status`
is the flag state, and `url` opens the message on the web. A manual item
is a task you typed instead of one that arrived from an account, and it is
a full planner item: it drags, it plans, it checks off, it can be a weekly
goal. Two things are true of it that are not true of a synced item, and
both are deliberate:

- **A sync run never touches it.** Reconciliation only ever marks items of
  the source it just fetched, so a manual task cannot be closed or removed
  because something vanished from Todoist.
- **Nothing is ever pushed for it.** It has no account behind it, so the
  two-way toggles skip it entirely, whatever they are set to.

Its `external_id` is generated locally and always starts with `manual-`,
which no Todoist, ClickUp or IMAP id can produce.

## Routines (`02 Planner/Routines/`)

A routine is a recurring block of steps that takes a place in the day:
from a time to a time, one of three types (morning, afternoon, evening),
on the weekdays you choose. It is not a task (it is never in the tray,
never dragged, never synced anywhere) and not a habit (a habit is one yes
or no per day). On the board it is a block in the morning or afternoon
lane at its time, sorted with the calendar events and the tasks around it;
its steps check off one by one, the card reads "3 of 5", a complete day
strikes through like a done task, and a skipped day shows greyed. The
same block appears in the tray's AGENDA tab. Right-click or long-press the
block for Skip today, Unskip today, Reset today and Open routine note.

The folder holds one markdown note per routine. "New routine" in the
settings (or the command of the same name) writes it; you can also write
one by hand. The shape:

```markdown
---
type: planner-routine
name: "Morning launch"
routine_type: morning
start: "06:30"
end: "07:30"
weekdays: [mon, tue, wed, thu, fri]
active: true
created_at: 2026-09-04T09:00:00Z
---

# Morning launch

## Steps
- [ ] Water, 500 ml
- [ ] One journal page
- [ ] Plan the day on the board

## Log
<!-- routine-log: schema=steps -->
| Date | Done | Steps |
| --- | --- | --- |
| 2026-09-04 | 3/3 | 1,2,3 |
| 2026-09-03 | 1/3 | 2 |
| 2026-09-02 | S |  |
```

| field | meaning |
| --- | --- |
| `name` | the title on the card |
| `routine_type` | `morning`, `afternoon` or `evening`; said on the card's kicker |
| `start`, `end` | `HH:MM`; the start decides the lane (before the morning / afternoon split is the morning lane, from the split on the afternoon lane) and the order inside it |
| `weekdays` | the days it occurs, lowercase three-letter codes `mon` to `sun` |
| `active` | `false` takes it off the board without deleting the note |
| `created_at` | when it was created |

The `## Steps` list is the definition. Its boxes are labels only: the
plugin never writes them, and a `- [x]` there does not make a step done.
Steps are counted by position, so editing the list changes what the
numbers in the log point at from that day on.

The `## Log` table is the record, one row per day that had any
interaction: the date, the count done, and the numbers of the steps that
were checked. `S` in the Done column means the day was skipped. A day
with no row is a day nothing was recorded for. The plugin writes newest on
top, keeps whatever order a table already has, and never touches a row it
was not asked to; a person or an agent may append a row by hand in the
same shape (a `Y` with no step numbers counts as every step done), and
the board shows it on the next render. Nothing here is ever sent to
Todoist, ClickUp, the mailbox or a calendar.

## Habits (`04 Inner World/My Life/Habits/`)

A habit is one yes or no per day. It is defined in your vault's Habits
room, not in the planner: one markdown note per habit, the folder being
the identity. The planner reads that room and writes into it, and both
halves are narrow on purpose.

**What it reads.** Any note in the folder whose frontmatter says
`type: habit` or carries a `cadence`. `INDEX.md`, `README.md` and names
starting with `_` are skipped, and subfolders are not read. The fields:

| field | meaning |
| --- | --- |
| `name` | the label on the row; the file name when absent |
| `cadence` | `daily`, `weekdays`, `weekly`, `monthly` or `adhoc` (`weekday` is read as `weekdays`) |
| `cadence_days` | the weekdays, lowercase three-letter codes `mon` to `sun`; read for `weekly` and `adhoc` |
| `status` | `active` shows; `paused` and `abandoned` do not |
| `started_on` (or `since`) | when the habit began |

`daily` lands on every day, `weekdays` on Monday to Friday, `weekly` and
`adhoc` on the days in `cadence_days`, `monthly` on none (it is not a
weekday habit; the HABITS tab lists it greyed).

**What it writes.** Two things, and nothing else in the note.

1. The check-in, into the note **body**, as one row in the log table under
   the `habit-log` sentinel. Checking a row writes `Y` for that date;
   unchecking writes `_` (pending) when the row carries no text, `N` when
   it does, so a note you typed on the row survives. A note with no log
   yet gains this section on the first check, exactly:

```markdown
## Daily log
<!-- habit-log: schema=streak -->
| Date | Y/N | Note |
| --- | --- | --- |
| 2026-09-09 | Y |  |
```

   Newest on top; a table that is oldest on top keeps its order. A row an
   agent wrote in chat (`Y`, a check mark, `G` for done; `N`, `R` or a dash
   for not done) shows on the board on the next render, and a row the board
   wrote is not asked about again. A table whose sentinel says
   `schema=process` has a third column for the trigger; the planner leaves
   it empty and shows no streak for that habit. The check-in never touches
   frontmatter.

2. From the HABITS tab only, `cadence` and `cadence_days` in the
   frontmatter: all seven days becomes `cadence: daily` with the field
   removed, exactly Monday to Friday becomes `weekdays` with the field
   removed, anything else becomes `weekly` with the list.

A day still ahead shows its habits with the rows disabled; past days stay
checkable. `STREAK n` on a row is the run of consecutive scheduled days
with a done mark ending today or yesterday, skipping days the habit is not
scheduled for (a weekday habit's Friday and Monday join), computed from the
table at render and never written anywhere.

## The calendar cache (`02 Planner/Calendar Events.md`)

One note, rewritten whenever at least one calendar fetches healthily
(never per-event notes): frontmatter (`type: calendar-cache`,
`source: ics`, `updated_at`, event count, `feeds` count, `planner_folder`
so a reader knows where the item notes live), a short list of the
calendars with their event counts, a readable list of the next 14 days
(day, time, title, the calendar's name in brackets, location, meeting
link), then a fenced `json` block the plugin uses to restore the board
instantly on relaunch. Since 0.8.0 that block is version 2: `{ version,
updated_at, feeds: [{ id, name, color, updated_at, defs }] }`, one entry
per calendar, each with its own `updated_at` (a calendar kept from an
earlier sync because its last fetch failed keeps its older time). A cache
written by an earlier release (a bare array) still loads and belongs to
the first calendar. The Outlook calendar's events arrive from Microsoft
already unrolled, one row per occurrence, and are cached like any other
feed's (each row flagged `expanded` so it is never unrolled twice). It is safe to read for AI / schedule context and
**secret-free by contract**: a calendar is named by its id, name and
colour index only, never its feed URL or private key. Names and colours
always come from the settings, not from this note. Do not edit it; the
next sync overwrites it. Until the first live fetch of a session confirms
the cache, its events render pale and pulsing on the board.

## Install

Requires Obsidian 1.4.0 or newer. On 1.11.4 or newer your tokens,
password and feed addresses are kept in Obsidian's secret storage
(outside the vault and outside `data.json`, so they are never synced or
committed with your notes) instead of `data.json` (see Secrets).

1. Copy `main.js`, `manifest.json` and `styles.css` from the latest
   release into `.obsidian/plugins/icor-for-life-planner/` in your vault.
2. Enable the plugin in Settings, Community plugins.
3. Click the Planner button on the file-tree toolbar or in the left
   ribbon (or run the command "ICOR for Life - Planner: Open the board")
   and start adding tasks in the tray with "+ ADD TASK".
4. When you want your accounts in there too, add the keys in the plugin
   settings and drag the cards that arrive onto your week.

Step 4 is optional. With nothing connected the tray says so and offers the
way in; it does not pretend a sync is coming. The board, the tray, the
drag-and-drop planning and the weekly goals all work on manual tasks alone.

## On mobile

The board, the tray and the sync all run on phone and tablet. Two
differences:

- Planning is tap-first: long-press a card for the menu, then "Plan
  on..." picks the day and half. (Drag and drop stays the desktop way.)
- The starred-email source needs the desktop app (IMAP requires a raw TLS
  socket). Todoist, ClickUp, Outlook and the calendar sync everywhere;
  email cards synced on desktop still show up on mobile through vault
  sync.

## ICOR for Life Obsidian Edition

ICOR for Life - Planner is the planning surface of the **ICOR for Life Obsidian
Edition**: ICOR (Input, Control, Output, Refine), the productivity
methodology by Paperless Movement / myICOR, implemented as a ready-to-use
Obsidian vault. Best to be used in combination with:

- **[ICOR for Life - INKLINE theme](https://community.obsidian.md/themes/icor-for-life-inkline)**,
  the hand-drawn visual system the board is designed against. The
  planner's cards, lanes and tray ride INKLINE's tokens, so the board
  looks native in both light and dark.
- **[ICOR for Life - Focus](https://obsidian.md/plugins?id=icor-for-life-focus)**, the gravity map
  of your vault: what you touched today sits close, older work ripples
  outward. Focus shows where your attention actually went; the Planner is
  where you decide where it goes next week. Review one, plan on the other.
- **[ICOR for Life - Connect](https://obsidian.md/plugins?id=icor-for-life-connect)**, your
  app.myicor.com account inside the vault. The weekly-planning practice
  this board implements is taught step by step in the ICOR Journey on
  myicor.com; Connect puts those courses one click away.
- **[ICOR for Life - Diagrams](https://obsidian.md/plugins?id=icor-for-life-diagrams)**, a
  fullscreen viewer with zoom and pan for the mermaid diagrams in your
  notes, for when a plan is easier drawn than listed.
- **[ICOR for Life - Chat](https://obsidian.md/plugins?id=icor-for-life-chat)**, your AI team
  in a tab beside your notes, working from your vault's own instructions.
  For the card that needs thinking through before it can be dragged
  anywhere.

The complete, preconfigured experience (theme, all plugins, the seven-room
vault structure and the AI team) ships free as the **ICOR for Life**
vault: https://myicor.com

## License

Please note that while the source can be read and modified for your
personal use, this plugin is not open source. It is licensed under the
ICOR for Life Source-Available License (Code) - see the `LICENSE` file
for the full terms. Third-party notices live in `THIRD-PARTY-NOTICES.md`.
