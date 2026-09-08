# Changelog

All notable changes to ICOR for Life - Planner.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/).
Releases before 0.12.0 carry their notes on the GitHub release itself
(the commit subjects since the previous tag).

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

### Changed
- The settings tab and the README call the store by Obsidian's own name
  for it, "Obsidian's keychain (Settings, General, Keychain)". It is still
  never called the operating system's own store, because it is not one.
- On an Obsidian older than 1.11.4 the option for Obsidian's keychain is
  shown but cannot be picked; `data.json` stays the fallback there until the env file is
  chosen, as in every release since 0.9.0.
