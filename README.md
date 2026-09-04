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
  mailbox, and events from as many calendars as you paste, one iCal
  address each (Google, iCloud, Proton, Outlook, or any other feed).
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
  Outlook / Microsoft 365 retired password IMAP and cannot connect yet.
  A Test connection button logs in and straight out, reads nothing, and
  names what went wrong within one attempt.
- A "Planner" entry in the file tree (between INBOX and WiP) opens the
  weekly board, and brings the tray up in the right sidebar with it. That
  happens once per session: if you close the tray or collapse the sidebar,
  opening the board again leaves it alone.
- The tray has three tabs. TASKS holds the unscheduled items grouped by
  source, with your weekly goals pinned on top. AGENDA answers "what is
  planned today", in order. GOALS is the weekly-goals list on its own.
  TASKS shows while the board is the active page; AGENDA and GOALS follow
  you everywhere else.
- Drag a card onto a day's AM or PM lane to plan it; drag it back to the
  tray to unschedule. On mobile, long-press a card and pick "Plan on...".
  Calendar events render read-only in their lanes.
- Routines: a block of steps at a time of day (morning, afternoon or
  evening), on the weekdays you pick. Each one is a note in
  `02 Planner/Routines/`; its block sits in the lane at its time, its steps
  check off one by one with the count on the card, and every day's result
  is a row in the note, readable by you and by the AI team.
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
- A badge below the left ribbon shows your next event with a live
  countdown (desktop only, toggleable). When the event carries a meeting
  link (Zoom, Google Meet, Teams, Webex, Whereby, Jitsi), clicking the
  badge opens the meeting; otherwise it opens the board. The same link
  appears as a JOIN MEETING button in the event detail.
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

No telemetry, no other endpoints. Without keys the plugin makes no network
requests at all.

## Settings the plugin stores (`data.json`)

The connection settings, for anyone reading or scripting `data.json`:

| key | meaning | default |
| --- | --- | --- |
| `todoistToken`, `clickupToken`, `clickupTeamId` | the task-source credentials; the workspace id is optional | empty |
| `imapHost`, `imapUser`, `imapPassword` | the mailbox: host, address, app password | `imap.gmail.com`, empty, empty |
| `imapPort` | the IMAP port | `993` |
| `imapSecurity` | `tls` (encrypted from the first byte) or `starttls` (plain connect, upgraded before login, never a plain login) | `tls` |
| `imapAllowSelfSigned` | accept the host's own certificate; honoured only when the host is loopback, enforced in the transport code, not just in the settings tab | `false` |
| `calendars` | the calendar feeds, one entry each: `{ id, name, url, color, enabled, kind }`; `url` is the secret iCal address, `color` is a swatch index 1 to 4 (never a colour value), `kind` is `ics`. An `icsUrl` from a release before 0.8.0 becomes the first entry on the first launch and is read nowhere else | empty |
| `plannerFolder` | the room folder every path derives from (`<folder>/Todoist`, `<folder>/Calendar Events.md`, `<folder>/Routines`); on launch a missing folder is replaced by the one top-level folder whose name ends in "planner", if there is exactly one | `02 Planner` |
| `routinesEnabled` | show routine blocks on the board and in the agenda; off hides them, the notes stay | `true` |
| `routineDefaults` | the times a new routine starts with, per type: `{ morning: { start, end }, afternoon: { start, end }, evening: { start, end } }`, each `HH:MM`; each routine keeps its own times in its note | `06:30` to `07:30`, `13:00` to `13:30`, `21:00` to `21:45` |
| `routineWeekdaysDefault` | the weekdays a new routine starts with, lowercase three-letter codes | `[mon, tue, wed, thu, fri]` |

The board preferences (sync interval, weekend, split, lunch, workday,
badge, the two-way toggles) sit beside them under their own names.

## Secrets

API keys live in this plugin's `data.json`. The plugin writes a `.gitignore`
guard into the vault so the folder never reaches your vault's git
repository, and this repository ignores `data.json` itself. Treat the iCal
URL like a password (it is one).

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

Editing `planned_day` / `planned_half` in any editor moves the card; the
board re-renders live off the metadata cache.

When a recurring task's due date moves on, the setting "When a recurring
task moves to its next date" decides where the card lands: on the new
due day, keeping its morning / afternoon half (the default), or back in
the tray. A plan already made for a day on or after the new due stands
either way.

`source` is `todoist`, `clickup`, `email` or `manual`. A manual item is a
task you typed instead of one that arrived from an account, and it is a
full planner item: it drags, it plans, it checks off, it can be a weekly
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
the first calendar. It is safe to read for AI / schedule context and
**secret-free by contract**: a calendar is named by its id, name and
colour index only, never its feed URL or private key. Names and colours
always come from the settings, not from this note. Do not edit it; the
next sync overwrites it. Until the first live fetch of a session confirms
the cache, its events render pale and pulsing on the board.

## Install

Requires Obsidian 1.4.0 or newer.

1. Copy `main.js`, `manifest.json` and `styles.css` from the latest
   release into `.obsidian/plugins/icor-for-life-planner/` in your vault.
2. Enable the plugin in Settings, Community plugins.
3. Open the "Planner" entry in the file tree (or run the command
   "ICOR for Life - Planner: Open the board") and start adding tasks in the tray with
   "+ ADD TASK".
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
  socket). Todoist, ClickUp and the calendar sync everywhere; email cards
  synced on desktop still show up on mobile through vault sync.

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
