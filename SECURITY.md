# Security Policy

ICOR for Life - Planner is an Obsidian plugin that syncs Todoist, ClickUp, starred email and
Google Calendar into your vault. It holds credentials for those services and it can
write back to them. That makes it the most sensitive plugin in the ICOR for Life
suite after ICOR for Life - Chat, and we would rather hear about a problem early than read
about it later.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

Two channels, in order of preference:

1. **GitHub private security advisory** (preferred). Go to the
   [Security tab](https://github.com/myICOR/icor-for-life-planner/security/advisories/new)
   of this repository and open a draft advisory. This keeps the report private
   between you and the maintainer until a fix ships.
2. **Email** `team@myicor.com` with `SECURITY` and `icor-for-life-planner` in the subject
   line. This is a monitored mailbox. If you want to encrypt the report, say so in
   a first message and we will arrange a key.

A useful report contains:

- The plugin version (see `manifest.json`, or Settings, Community plugins).
- Your Obsidian version and operating system.
- What an attacker can do, and what they need in order to do it.
- Steps to reproduce, ideally against a throwaway vault.
- **Never send us a real API token, iCal URL, or password.** Describe the
  credential ("the ClickUp token in `data.json`"), do not paste its value. If a
  credential of yours was exposed, rotate it at the provider first, then report.

## What to expect

This project is maintained by one person, so these are timelines we can actually
keep rather than ones that sound good:

| Stage | Target |
| --- | --- |
| We acknowledge your report | within 5 business days |
| We tell you whether we agree it is a vulnerability, and how severe | within 10 business days |
| We ship a fix for a confirmed critical or high issue | we aim for 30 days |
| We ask you to hold public disclosure until | a fix ships, or 90 days from your report, whichever comes first |

If a deadline is going to slip we will tell you before it slips, not after. If you
do not hear from us within 10 business days, please chase us: assume the message
got lost rather than ignored.

## Supported versions

**Only the most recent release is supported.** This project has one branch (`main`)
and no long-term-support line. There are no backports to older versions and no
security patches for anything but the current release. If you are running an older
version, the fix is to update.

We are not going to publish a version-support table we would not honour.

## Scope: what this plugin actually touches

This is what the plugin does, so you can aim your effort at the parts that matter.
The figures below were measured against the shipped `main.js` of v0.6.1.

**Credentials it stores.** The plugin keeps user-supplied secrets in Obsidian's
per-plugin `data.json` inside the vault, at
`.obsidian/plugins/icor-for-life-planner/data.json`:

- a Todoist API token
- a ClickUp API token
- IMAP host, username and password for the starred-email sync
- a Google Calendar **secret iCal URL** (this is a bearer credential: anyone
  holding the URL can read the calendar)

`data.json` is git-ignored in this repository and is never transmitted anywhere by
the plugin other than to the services the credential belongs to.

**Where it connects.** Outbound hosts referenced in the shipped bundle:
`api.todoist.com`, `api.clickup.com`, `calendar.google.com`, and the IMAP server
you configure. There is no telemetry, no analytics, and no myICOR-operated
endpoint in this plugin.

**What it writes.** The plugin can write back to Todoist and ClickUp. Write-back is
off by default and sits behind two explicit user-facing toggles.

**In scope, and we want to hear about it:**

- Any path by which a stored credential leaves the vault to somewhere other than
  the service that credential belongs to.
- Any way a credential ends up in a note, a log line, a rendered pane, a
  clipboard, an error message, or a crash report.
- Write-back firing while the toggle is off, or writing to a target the user did
  not select.
- Injection into the sync path: a task title, description or calendar event from a
  remote service that causes code execution, arbitrary file write, or arbitrary
  network access when it is rendered or synced into the vault.
- Path traversal in note creation: a remote-controlled string that writes outside
  the configured folder.
- TLS verification being skipped or downgraded on any outbound request.
- Any read or write of vault files outside the folders the plugin is configured
  to use.

**Note on the published artifact.** This repository distributes the built plugin
(`main.js`, `manifest.json`, `styles.css`). `main.js` is a readable, non-minified
esbuild bundle, so it can be reviewed directly. The TypeScript source is not
published in this repository.

## Out of scope

These are not vulnerabilities and we will close them as such:

- **Your own API keys being stored in your own vault.** That is the design. The
  plugin needs the token to call the service, and Obsidian's storage for that is
  `data.json` in your vault. If your vault is synced somewhere, those credentials
  go with it, which is a property of your sync setup rather than a flaw in this
  plugin. Exfiltration *away* from your vault is in scope; storage *in* it is not.
- Anyone with filesystem access to your vault being able to read `data.json`. If
  an attacker is already reading your vault, the credentials are the smaller
  problem.
- Bugs in Obsidian itself. Report those to
  [Obsidian](https://github.com/obsidianmd/obsidian-releases/issues).
- Interactions with third-party plugins, or breakage caused by another plugin
  changing shared state. Please report those as normal issues so we can look at
  compatibility, but they are not handled as security reports.
- Vulnerabilities in Todoist, ClickUp, or Google. Report those to the vendor.
- Missing hardening that has no demonstrated impact: absent security headers on a
  non-existent server, "the token is not encrypted at rest", dependency versions
  with no reachable exploit path, or the output of an automated scanner with no
  working proof of concept.
- Social engineering, physical access, or attacks that require the user to
  already be running attacker-controlled code.

## Good-faith research

We will not pursue or support legal action against anyone who reports a
vulnerability to us in good faith, follows this policy, gives us reasonable time to
fix the issue before disclosure, and does not access, modify or destroy data that
is not their own. Test against your own vault and your own accounts.

There is no bug bounty. We are a small team and cannot pay for reports. We will
credit you by name and link in the release notes and the advisory unless you would
rather stay anonymous.

## Credit

Thank you for taking the time. A report that arrives privately and with a
reproduction is worth a great deal more than the effort it costs you to write it.
