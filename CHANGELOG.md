# Changelog

All notable changes to ICOR for Life - Planner.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).
Releases before 0.12.0 carry their notes on the GitHub release itself
(the commit subjects since the previous tag).

## [0.16.2] - 2026-09-26

### Fixed
- **A My Life habit note that links only to itself can be imported.** A
  habit note whose planner_habit line named the note itself, not a planner
  habit note, counted as already imported, so it was never offered for
  import and never got its planner note. The import now counts a note as
  imported only when its planner_habit links to a planner habit note that
  exists. A My Life note whose planner note you deleted is offered again;
  nothing is imported unless you tick it. The settings text says the same.
  Thanks to Brian Carroll (@brijcarroll) for the fix (#28, closes #27).
- **Done notes left by tasks deleted before 0.15.0 are cleaned up.** Before
  0.15.0 a task deleted in Todoist or ClickUp was marked done here instead,
  and its note stayed forever. Once per source, the planner asks Todoist and
  ClickUp about your done task notes. A note whose task the source no longer
  has (answer "not found") moves to the system trash, where you can restore
  it. If you switched to another Todoist or ClickUp account, or left a
  shared project, check the trash after the first syncs. The check uses the
  same read-only request as the existing deletion check, within its limit
  of 25 requests per sync, and never writes to Todoist or ClickUp. Thanks
  to Brian Carroll (@brijcarroll) for the fix (#25, closes #24).

## [0.16.1] - 2026-09-23

### Fixed
- **A ClickUp task that only leaves your synced view stays open.** When a
  task was unassigned from you, or was a subtask whose parent was closed, it
  dropped out of what the planner syncs while it was still open in ClickUp,
  and the planner marked its note done. It now asks ClickUp for the task's
  status first: a task that is done or closed is completed here as before,
  and a task that is still open is left exactly as it is. Thanks to Brian
  Carroll (@brijcarroll) for the fix (#18, closes #17).
- **A monthly calendar event on "the third Sunday" stays on the third
  Sunday.** A repeating event defined by a weekday in the month, such as the
  third Sunday or the last Friday, was repeated on the same date as the
  first one, so from the second month on it landed on the wrong day, and a
  moved or cancelled occurrence of it was not matched. The planner now reads
  the weekday rule; an event that repeats on a date of the month works as
  before. Thanks to Matt Zymet (@zymetm) for the fix (#19).

## [0.16.0] - 2026-09-21

### Changed
- Relicensed under MIT. Releases before 0.16.0 remain under the ICOR for Life
  Source-Available License (Code) v1.0.

## [0.15.1] - 2026-09-17

### Fixed
- **Your starred-email notes survive a mailbox rebuild.** Mail servers
  occasionally renumber every message in a mailbox: after a server rebuild,
  a migration to another provider, or a restore from backup, the numbers the
  planner stored point at nothing. The planner used to read that as "every
  starred mail was deleted" and move all of those notes to the trash at
  once, taking the day, the half, the order, the week star and the linked
  note with them. It now checks whether the numbering still holds before it
  believes an answer, and when it does not, it changes nothing and says so
  in plain words instead. Where it can tell which note belongs to which mail
  (by the message's own permanent id) it simply re-matches the note to the
  mail, so nothing is lost and nothing is duplicated. Gmail almost never
  renumbers; other providers do.
- **An edit you type right after a sync is no longer held back.** The
  planner needs to tell its own writing from yours, and it used to do that
  with a three second stopwatch, which meant your edit inside those three
  seconds waited for the next sync, and a slow vault could confuse the two
  in the other direction. It now compares the file itself, which is exact:
  your edit is picked up the moment you make it, however busy the vault is.
- **Nothing the planner scheduled runs after you disable or update it.** A
  pending change on its way to a source and a pending settings save are both
  finished or dropped cleanly when the plugin unloads.

## [0.15.0] - 2026-09-17

### Changed
- **Tasks from a connected source are a mirror.** One rule, stated once and
  true everywhere: complete here and it completes there, edit here and it
  syncs there, changed there and it changes here, deleted there and it
  disappears here. Your own planning is never part of that. The day a card
  sits on, its half of the day, its order, the star for the week and the
  note you linked it to live only in your vault, and no sync touches them.

### Added
- **A task deleted in Todoist or ClickUp now disappears from your vault
  too.** Until now a deleted task left its note behind forever, as a card
  you could not open and could not get rid of, and every attempt to update
  it failed with a message you could do nothing about, over and over, every
  five minutes. The planner now asks the source what happened before it
  decides: a task that was completed is marked done as before, and a task
  that is really gone takes its note with it. The note moves to Obsidian's
  trash, so you can bring it back if you want it. You are told once per
  sync, in plain words, and never with an error code again. The same holds
  for starred email and Outlook flags: a message that is no longer in the
  mailbox takes its note with it.
- **The title of a task now syncs both ways.** Rename a task in its note and
  the new name reaches Todoist or ClickUp, the way the due date, the
  priority and the body already did. Rename it at the source and the note
  follows. If you rename it in both places between two syncs, the source
  wins and your note is updated to match.

### Fixed
- **No more repeating "HTTP 404" messages.** Any write that comes back
  saying the task no longer exists is now understood rather than retried.

### Note
- Nothing you delete in Obsidian is ever deleted at the source. The mirror
  runs one way for deletion: your vault follows the source.

## [0.14.3] - 2026-09-17

### Fixed
- **A task you complete in Todoist or ClickUp can no longer be reopened by
  the planner.** With Complete on source switched on, finishing a task in
  the source app made the planner mark its card done, as it should. What it
  then did wrong: it read its own note back a second later, decided the card
  looked unfinished, and set the task at the source to the first open status
  it could find. In ClickUp that meant a published podcast episode quietly
  went back to `not started`, minutes after it was published, again and
  again. The rule is now stated once and holds everywhere: the source
  always wins. What happens at the source is mirrored into your vault and
  never sent back out, and the planner never changes a status at the source
  to make it agree with a note. Complete on source means exactly one thing,
  which the setting now says in full: checking a card here closes the task
  there, and unchecking a card you had checked reopens it. Nothing else
  crosses. This affected every source that can be completed, Todoist,
  ClickUp, starred email and Outlook flags alike, and the fix is in the one
  place all four go through.

  Two things changed underneath, and either alone would have been enough.
  A sync now says so when it writes to a note, so the note-changed watcher
  can tell the plugin's own hand from your edit. And when a sync marks a
  card done because the source closed it, it writes both completion flags
  at once, so there is no disagreement left for anything to misread.

  Three new tests hold the rule in place, each one first run against the
  old code to prove it catches the problem: a task closed at the source
  now sends nothing back to it, a card you check here sends exactly one
  completion, and with the setting off nothing is sent at all.

## [0.14.2] - 2026-09-16

### Fixed
- **The link under a habit note now points where you expect.** Every
  habit in My Life carries a line reading Schedule and check-ins that
  takes you to its planner note. Because a habit lives in two notes that
  share a name by design, that link was ambiguous, and Obsidian resolved
  it to whichever note was closest, which from My Life meant the note you
  were already reading. It now carries the full planner path, so it opens
  the planner note. Notes written before this release are fixed in place
  the next time you press Import, one line each, once, and nothing else
  in the note moves. A note that already points somewhere is never
  pointed a second time, and a pointer whose planner note has been moved
  out of the planner folder is left exactly as it is, because a link that
  still works beats a tidier one that does not.

  Reported by Brian Carroll in the bug-reports channel.
- Housekeeping: the countdown strip toggles a class instead of an inline
  style, six error handlers say why they swallow, one regex escape
  removed; behaviour unchanged, pinned by a new source-hygiene test.

## [0.14.1] - 2026-09-16

### Fixed
- **A habit lives in two notes: the one in My Life, where you write about
  it, and the one in the planner, where its schedule and its check-ins
  live.** Both notes have the same name, which is the point, but it meant
  the links between them said only the name and not which note they meant.
  Obsidian then guessed, and guessed wrong: Open linked note in the planner
  opened the planner note you were already on, and anything scanning your
  vault read the My Life note as unlinked. Both links now carry the full
  path, taken from the two folders you set, so each one names exactly one
  note. Your existing habits are fixed the next time you run the import:
  each link is rewritten once, nothing else in the note is touched, your
  comments and your text stay exactly as they were, and a link that already
  carries a path is left alone. If there is nothing new to import, pressing
  Import in the plugin settings still fixes the existing links and tells you
  how many; a link whose note is not in the folder is left as it was.

  Reported by Brian Carroll in the bug-reports channel.

## [0.14.0] - 2026-09-15

### Added
- **The week note, and a tab that reads and writes it.** Beside the board
  there is now one note per week in `02 Planner/Weeks/`, holding the two
  things the board could never answer: what you are trying to achieve this
  week, and what would make today a win. Open it from the board, from the
  command palette, or by opening the note itself; it is plain markdown with
  two headings, so writing in it by hand works exactly as well.
- **Weekly priorities.** One line per outcome with a box you tick. Ticking it
  in the tab writes the box in the note, and ticking it in the note shows up
  in the tab. Not tasks: outcomes. A task can serve one.
- **Daily highlights.** One sentence per day, set in the morning and
  confirmed in the evening as done, not done, or left pending. Only today's
  row takes input; the rest of the week shows what it already says, because
  the highlight belongs to the day it was chosen on.
- **The week note is created the first time you put something in it**, and
  never before. A week nobody planned leaves no file behind, and a note
  already there is never overwritten.
- **Link a task to the note it is for.** A card's menu can point a task at a
  project, a key element, or any other note, and open it from the same menu.
  The link lives on the planner side only: nothing is written into the note
  you point at, and no sync run ever changes it, the same way your day
  placement and your pins have always survived a sync.

### Changed
- **A starred task is now "pinned to this week", not a "weekly goal".** The
  tray section reads PINNED THIS WEEK, the tab reads PINNED, the chip on the
  card reads WEEK, and the card menu offers to pin and unpin. Nothing about
  what the star does has changed, and nothing in your notes changed: the
  field in the file keeps its name. The word "goal" now means one thing in
  the suite, the goal note in your own vault.

## [0.13.0] - 2026-09-15

### Fixed
- **Sync no longer marks live tasks as done when it could not read all of
  them.** When a source has more open items than one sync can read in one
  go, the planner used to treat everything it had not seen as finished,
  tick it off in your vault, and, if you had switched on completing at the
  source, close it in Todoist, ClickUp or your mailbox too. It now notices
  when it has only read part of your open list, shows one line on the board
  saying so, and marks nothing done until it has read the whole list. The
  same applies when a mailbox has more starred mail than one read takes,
  when Microsoft hands back a paging link the planner will not follow, and
  when you change your ClickUp filter, so switching subtasks off no longer
  records them as achievements. Everything it did read still lands on the
  board as usual.

  Reported by Ian Slattery in the bug reports channel.

## [0.12.0] - 2026-09-08

### Added
- Where your keys live: a switch in settings between Obsidian's keychain
  (Settings, General, Keychain; the default, unchanged for everyone who
  already has keys there) and an env file inside the vault
  (`06 AI Team/AI Team Knowledge/.env` by default, the path is a setting).
  The env file holds one `KEY=value` line per secret (`TODOIST_TOKEN`,
  `CLICKUP_TOKEN`, `IMAP_PASSWORD`, `OUTLOOK_REFRESH_TOKEN`,
  `OUTLOOK_ACCESS_TOKEN`, and `PLANNER_CALENDAR_<ID>` per pasted
  calendar); the plugin edits exactly that line and leaves every other
  byte of the file as it was.
- Only the selected backend is read. Choosing the other one moves
  nothing by itself; the settings tab shows, per key, where a value
  exists and offers "Move to ..." per key and for all of them at once.
- The env file is read again before every sync, so a line edited by hand
  is picked up without a restart.
- A key is blanked in `data.json` only after its line is on disk in the
  env file. When the file cannot be written, the key stays in `data.json`,
  the settings tab says so once, and the next save that succeeds moves it.

### Changed
- The settings tab and the README call the store by Obsidian's own name
  for it, "Obsidian's keychain (Settings, General, Keychain)". It is still
  never called the operating system's own store, because it is not one.
- On an Obsidian older than 1.11.4 the option for Obsidian's keychain is
  shown but cannot be picked; `data.json` stays the fallback there until the env file is
  chosen, as in every release since 0.9.0.
