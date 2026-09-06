# Security Policy

ICOR for Life - Planner is an Obsidian plugin that syncs Todoist, ClickUp, starred email,
Outlook and calendar feeds into your vault. It holds credentials for those services and it can
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
- **Never send us a real API token, iCal URL, Microsoft token, or password.** Describe the
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
The figures below describe the shipped `main.js` on `main` (the 0.8.0 line).

**Credentials it stores.** The plugin holds these user-supplied secrets:

- a Todoist API token
- a ClickUp API token
- the IMAP password for the starred-email sync (the host and the username
  are stored beside it and are not secrets)
- one or more calendar feed URLs (`calendars[].url`); each is a bearer
  credential: anyone holding it can read that calendar
- the Outlook sign-in: a refresh token, a short-lived access token with its
  expiry, and the account name shown in settings (store keys
  `outlook-refresh-token`, `outlook-access-token`, `outlook-expires-at`,
  `outlook-account`, all four cleared by Sign out). The Application (client)
  ID of the member's own Entra app sits beside them in settings and is not a
  secret (a public-client id; there is no client secret anywhere)

Where they live depends on the Obsidian running the plugin. On Obsidian
1.11.4 or newer (desktop and mobile) they are in Obsidian's secret store,
`app.secretStorage` (outside the vault and outside `data.json`, so it is
never synced or committed with your notes; Obsidian's docs describe it as
"stored in local storage, keyed to the specific vault", not a system
keyring), under ids prefixed `icor-for-life-planner-`; the matching fields
in `data.json` are empty, and
any secret found in `data.json` on load is moved over once and blanked. On
an older Obsidian they are in the plugin's `data.json` inside the vault, at
`.obsidian/plugins/icor-for-life-planner/data.json`, as in every release
before 0.9.0. The store is feature-detected; there is no third place. The
single `icsUrl` key of releases before 0.8.0 is deleted on load.

`data.json` is git-ignored in this repository and is never transmitted anywhere by
the plugin other than to the services the credential belongs to.

**Where it connects.** `api.todoist.com`, `api.clickup.com`,
`login.microsoftonline.com` (the Microsoft sign-in and token refresh with
the member's own client id, PKCE, no client secret; the redirect is the
`obsidian://icor-for-life-planner/auth` protocol handler, the device code
flow the fallback, and there is no loopback listener), `graph.microsoft.com`
(flagged messages, calendar events, and the flag write), every
calendar feed host you configure (https only; `webcal://` is rewritten to
https), and the IMAP host you configure (TLS, or STARTTLS upgraded before
any login; a self-signed certificate is accepted only for a host on this
machine, enforced in the transport code). There is no telemetry, no
analytics, and no myICOR-operated endpoint in this plugin.

**What it writes.** The plugin can write back to Todoist, ClickUp, the
mailbox (the star flag only) and Outlook (a message's flag status only,
and only after a sign-in granted `Mail.ReadWrite`, which is requested the
moment the toggle is switched on and never before). Write-back is off by
default and sits behind two explicit user-facing toggles. The one mailbox argument that comes from
the vault, a note's `external_id`, is refused before a socket opens unless it
is a plain IMAP UID. In the vault it writes the planner folder (a setting;
changing it moves the folder through Obsidian's own rename), and, for
habits, one log row into the body of a note in the habits folder (a setting,
validated the same way), never that note's frontmatter except `cadence` and
`cadence_days` from the HABITS tab.

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
- Any read or write of vault files outside the two folders the plugin is
  configured to use (the planner folder and the habits folder).
- A vault note's content reaching a remote service as anything other than
  the field it stands for: an id that becomes a command, a title that becomes
  a query.

**Note on the published artifact.** This repository distributes the built plugin
(`main.js`, `manifest.json`, `styles.css`). `main.js` is a readable, non-minified
esbuild bundle, so it can be reviewed directly. The TypeScript source is not
published in this repository.

## Out of scope

These are not vulnerabilities and we will close them as such:

- **Your own API keys being stored in your own vault on an Obsidian older than
  1.11.4.** That is the design there. The plugin needs the token to call the
  service, and the only storage those versions offer a plugin is `data.json` in
  your vault. If your vault is synced somewhere, those credentials go with it,
  which is a property of your sync setup rather than a flaw in this plugin. On
  1.11.4 or newer the secrets are in Obsidian's secret storage, outside the
  vault and never in `data.json`; a secret found in `data.json` there IS in
  scope. Exfiltration *away*
  from your vault is in scope everywhere; storage *in* it, on an older
  Obsidian, is not.
- Anyone with filesystem access to your vault being able to read `data.json`. If
  an attacker is already reading your vault, the credentials are the smaller
  problem.
- Bugs in Obsidian itself. Report those to
  [Obsidian](https://github.com/obsidianmd/obsidian-releases/issues).
- Interactions with third-party plugins, or breakage caused by another plugin
  changing shared state. Please report those as normal issues so we can look at
  compatibility, but they are not handled as security reports.
- Vulnerabilities in Todoist, ClickUp, Microsoft, or Google. Report those to the vendor.
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
