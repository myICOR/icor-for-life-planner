# Connecting Outlook to the Planner

This connects your own Microsoft account to the Planner plugin. You do this once. Nobody at Paperless Movement / myICOR ever sees your login, your client ID, or your token: they live only in your own Microsoft account and in your own Obsidian vault.

It takes about ten minutes the first time. You will not need to repeat the Microsoft part again unless you disconnect.

## Part 1: register your own app in Microsoft

### Step 1: open App registrations

Go to [entra.microsoft.com](https://entra.microsoft.com) and sign in with the Microsoft account you want to connect. ([portal.azure.com](https://portal.azure.com), under Azure Active Directory, works too. Both reach the same screens; Entra is just Microsoft's current name for it.)

In the left menu: **Entra ID** then **App registrations**, then click **New registration**.

### Step 2: fill in the registration form

- **Name:** anything you like, for example "My Planner Connection."
- **Supported account types:** choose **Accounts in any organizational directory and personal Microsoft accounts**. This is the option that works whether you use a work account, a school account, or a personal outlook.com/hotmail account.
- Click **Register**.

### Step 3: add the redirect URI

On your new app's page, open **Authentication** in the left menu, then **Add a platform**, then choose **Mobile and desktop applications**.

Paste this exact value into the custom redirect URI field:

```
obsidian://icor-for-life-planner/auth
```

Click **Configure** or **Save**.

### Step 4: allow public client flows

Still on the **Authentication** page, scroll down to **Advanced settings**. Set **Allow public client flows** to **Yes**, then **Save**. Without this, sign-in will fail with an error mentioning a "client secret."

### Step 5: add the permissions

Open **API permissions** in the left menu, then **Add a permission**, then **Microsoft Graph**, then **Delegated permissions**. Add these four:

- `Mail.Read`
- `Mail.ReadWrite`
- `Calendars.Read`
- `offline_access`

None of these four need a Microsoft 365 admin to approve them for a personal or unmanaged account: you can consent to all of them yourself the first time you sign in through the Planner. You do not need to click any "Grant admin consent" button.

### Step 6: copy your Client ID

Open **Overview** in the left menu. Copy the value under **Application (client) ID**. This is the only value the Planner needs from this whole page. You never need the "Certificates & secrets" page: public clients like this one don't use a secret, so leave that page empty.

## Two caveats before you start

**On a work or school account:** some organizations turn off the ability for regular members to register their own apps. If Step 1 gives you an "Access denied, you don't have permission to register applications" message, ask your IT admin for one thing: "Please either register this app for me, or turn on 'Users can register applications' in Entra ID under Users, User settings." There is no personal workaround for this one: it is an organization-wide switch only an admin can flip.

**On a personal (outlook.com / hotmail) account:** a bare personal account cannot register an app on its own. You first need an Azure account, which currently requires a phone number and a credit or debit card for identity verification. Microsoft does not charge the card (it places a small temporary authorization hold that clears in a few days), but the card is required to sign up. This was verified against Microsoft's own pricing page as of 2026-09-06; if the requirement changes, check `azure.microsoft.com/en-us/pricing/purchase-options/azure-account` for the current wording before assuming otherwise.

## Part 2: connect it inside the Planner

1. Open the Planner's settings tab in Obsidian, section **Outlook**, and paste your **Application (client) ID** (from Step 6 above) into the **Application (client) ID** field.
2. Leave **Account type** on the default, `common`, unless you know you only ever want to sign in with a work or school account (choose `organizations`) or only ever with a personal account (choose `consumers`). When unsure, keep `common`.
3. Click **Sign in**. Your browser opens, you sign in and approve the permissions, and you're returned to Obsidian signed in. The Planner then fetches your flagged emails into the tray and adds an "Outlook calendar" row under Calendars, so your Outlook events show on the board.

If the browser cannot bring you back to Obsidian (some managed devices block custom links), click **Use a code instead** in the sign-in window: you get a short code and a Microsoft page to type it into, on any device.

**About the permissions.** The first sign-in asks for reading mail and calendars only. The one thing the Planner can write is the flag on an email (marking it complete when you check the card), and that needs the extra `Mail.ReadWrite` permission. It is asked for only when you switch **Complete on source** on in the settings: a second, short sign-in opens to grant it. If you never turn that toggle on, you never grant it.

## FAQ

**I see a warning that says the app was created by an "unverified publisher." Is that a problem?**
No. This warning appears because you registered the app yourself rather than a company going through Microsoft's formal publisher verification process. It's expected and safe to continue past it. It has nothing to do with whether the plugin itself is trustworthy: it only reflects who registered the Microsoft app.

**I get an error mentioning AADSTS7000218.**
This means "Allow public client flows" is still set to No. Go back to Step 4 and switch it to Yes.

**I get an error mentioning AADSTS50011.**
The redirect address doesn't match. Go back to Step 3 and check that the value is exactly `obsidian://icor-for-life-planner/auth`, added under **Mobile and desktop applications** (not Web, not Single-page application).

**I get an error mentioning AADSTS65001 (or AADSTS90094).**
One of the permissions hasn't been consented to yet. Try connecting again and approve every permission on the consent screen. On a work account where this keeps happening, ask your admin to grant consent for the app.

**My connection stopped working after a while and I'm asked to sign in again.**
This is normal. Microsoft's tokens expire after a period of inactivity or after a set time. Just click **Sign in** again in the Planner's settings; you'll sign in once more and it picks up where it left off.

**Can I disconnect later?**
Yes. Click **Sign out** under Outlook in the Planner's settings, which removes the tokens from your vault (or from your system keychain on Obsidian 1.11.4 or newer). To also revoke access on Microsoft's side, visit `myaccount.microsoft.com` (or `account.live.com/consent/Manage` for a personal account) and remove the app from your list of connected apps. The settings tab links to both.
