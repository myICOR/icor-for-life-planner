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
  mailbox, and events from a Google Calendar secret iCal feed.
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
- Every synced task becomes a markdown note in `02 Planner/<Source>/`
  with the plan state in frontmatter, so the AI team can read and move
  items too.
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
- the Google Calendar secret iCal URL you paste, for your events

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
| `icsUrl` | the calendar's secret iCal address | empty |

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

## The calendar cache (`02 Planner/Calendar Events.md`)

One note, rewritten on every healthy calendar fetch (never per-event
notes): frontmatter (`type: calendar-cache`, `updated_at`, event count),
a readable list of the next 14 days (day, time, title, location,
meeting link), then a fenced `json` block the plugin uses to restore the
board instantly on relaunch. It is safe to read for AI / schedule
context and **secret-free by contract**: event data only, never the
calendar feed URL or its private key. Do not edit it; the next sync
overwrites it. Until the first live fetch of a session confirms the
cache, its events render pale and pulsing on the board.

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
