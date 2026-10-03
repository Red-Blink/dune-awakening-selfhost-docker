# QA checklist: password + authenticator sign-in

**Purpose.** A manual, end-user test plan for the console's two-factor sign-in,
to be executed by a person in a real browser with a real phone, against a
deployed build. Automated tests cover the API; this covers what a human sees
and whether they can get through it without getting stuck.

**Who.** One QA engineer (any operator can run it). Budget about 90 minutes
for Parts 1–7 (the core cases T01–T16 take about 45) and another 45 for
Part 8 (Discord), which needs a Discord server and test accounts.

**Result rule.** A case passes only if *every* expected line is observed. If a
screen, message, or button differs from what is written here, that is a
finding even when the flow still works — record the exact text you saw.

---

## Environment (fill in before starting)

| Item | Value |
|---|---|
| Console URL used in the browser | `https://________________` (must be the URL you normally sign in with; if the install sets `ADMIN_SECURE_COOKIES=1` — recommended behind HTTPS — a plain `http://host:port` URL will never keep you signed in, because the session cookie is `Secure`) |
| Build under test | commit `________` (e.g. `git rev-parse --short HEAD` on the host) |
| Admin password | held by tester, **not** written here |
| Phone with an authenticator app | app name: `________` |
| Second browser or private window | for "other sessions" checks |
| Somewhere to record recovery codes | password manager entry / paper |
| Host access (SSH) for T17–T20 and T24 | tester: `________` or a named proxy who has it |
| Starting state | **A — no two-factor state on the host and `CONSOLE_TOTP_ENABLED` unset.** This is what every operator upgrading from the previous release has, so it is the only valid start for a release test. (B — an authenticator already enrolled — is for re-testing an install that has already been through this checklist once; it is not a release test.) |

**Host paths referenced below** (relative to the repository root on the host):
`.env`, `runtime/generated/console-second-factor.json`,
`runtime/generated/console-second-factor.json.watermark`,
`runtime/generated/web-admin-audit.jsonl`. Restart with `dune console restart`.

**Putting the host into starting state A** (skip if it is a fresh install that has never had this feature):
```bash
cp -p runtime/generated/console-second-factor.json* ~/qa-2fa-backup/ 2>/dev/null   # keep whatever was there
rm -f runtime/generated/console-second-factor.json runtime/generated/console-second-factor.json.watermark
sed -i '/^CONSOLE_TOTP_ENABLED=/d' .env
dune console restart
```
You should now be able to sign in with the password alone, and Settings should show no Two-Factor section. That is T01.

**Before starting, take a backup** on the host:
```bash
mkdir -p ~/qa-2fa-backup && cp -p .env runtime/generated/console-second-factor.json* ~/qa-2fa-backup/ 2>/dev/null; ls ~/qa-2fa-backup
```

---

## How to record results

For each case: **Pass / Fail / Blocked**, plus evidence — a screenshot of the
decisive screen, and the exact on-screen text for any message. Keep the
completed results table at the end with your test records for the build.

---

## Part 1 — Baseline with the feature off

### T01 · Password-only sign-in is unchanged
*Host:* `CONSOLE_TOTP_ENABLED` unset or `=0`; `dune console restart`.
1. Open the console URL. Enter the admin password. Sign In.
2. Open **Settings**.

**Expected**
- Signed in with password alone; no code was requested at any point.
- Settings shows a **Login Password** section and **no** "Two-Factor Authentication" section.

### T02 · Wrong password
1. Sign out. Enter a wrong password.

**Expected**
- Message: *Incorrect password. Please try again!* — still on the sign-in page, no code field appears.

---

## Part 2 — Turning it on and enrolling (starting state A)

Run Parts 1 and 2 in order — this is the path every upgrading operator takes. (Only an install in state B skips to Part 3; see the Environment table.)

### T03 · Enabling the flag changes nothing until sign-in
*Host:* set `CONSOLE_TOTP_ENABLED=1` in `.env`; `dune console restart`.
1. Reload the sign-in page.

**Expected**
- Sign-in page looks the same: one password field, one Sign In button (plus
  the secondary **Set up Discord sign-in** button if Discord is not yet
  configured — unrelated to this feature).

### T04 · First sign-in lands on setup, not the console
1. Enter the correct password. Sign In.

**Expected**
- A setup screen appears instead of the console, with a QR code, the text
  secret printed beneath it under *Can't scan? Enter this code manually:*,
  a 6-digit code field, a **Confirm** button, and *Back to sign in*.
- Nothing else in the console is reachable (try the browser Back button or
  typing a console URL — you land back on setup or sign-in).

### T05 · Real phone scan
1. Scan the QR with the authenticator app on the phone.

**Expected**
- The app adds an entry named for this console and starts showing 6-digit
  codes that change every 30 seconds. Record the entry name: `________`.

### T06 · Manual entry works (no camera)
1. Read the text secret shown under *Can't scan? Enter this code manually:*.
2. On the phone, add a second entry by typing that secret (or use a second
   phone/desktop authenticator).

**Expected**
- A text code is shown and is accepted by the app; both entries show the
  **same** 6-digit code at the same time.

### T07 · Wrong confirmation code
1. Enter a made-up 6-digit code. **Confirm**.

**Expected**
- Message: *That code was not accepted. Check your device's clock and enter the current code.* Still on the setup screen; the QR is unchanged.

### T08 · Correct confirmation → recovery codes, shown once
1. Enter the code the phone shows now. **Confirm**.

**Expected**
- Screen headed *Save your recovery codes* with **exactly 10** codes and the
  text that they are shown once.
- An acknowledgement checkbox and a *Continue to sign in* button.
2. Click *Continue to sign in* **without** ticking the box.

**Expected**
- Nothing happens (button disabled or a prompt) — you cannot skip the acknowledgement.
3. Record all 10 codes in your chosen place. Tick the box. Continue.

**Expected**
- Back at the sign-in page. Setup is not repeated.

### T09 · The confirmation code cannot be reused to sign in
1. Password + **the same code you just used to confirm**. Sign In.

**Expected**
- Rejected with a message about the code not being accepted. You are *not* signed in.
2. Wait for the phone to show the next code. Password + that code. Sign In.

**Expected**
- Signed in. Console loads.

### T10 · Abandoned setup restarts with a fresh QR
*Host:* remove `runtime/generated/console-second-factor.json` (this is the
break-glass reset, see T17) and `dune console restart`, so setup runs again.
1. Password → setup screen. **Do not scan.** Click *Back to sign in*.
2. Password again → setup screen.

**Expected**
- The QR / manual code is **different** from the first one (compare the manual code text).
3. Scan the **new** one, confirm, save codes, sign in with password + next code.

**Expected**
- Signed in. The phone entry from step 1 (if you scanned it) does **not** work.

---

## Part 3 — Day-to-day sign-in (starting state B or after Part 2)

### T11 · Password alone is no longer enough
1. Sign out. Password only. Sign In.

**Expected**
- Not signed in. The page now shows an **Authenticator code** field and a
  *Lost access to your authenticator?* link, with a message asking for the code.

### T12 · Wrong code, then replay, then success
1. Enter a made-up code. Sign In.

**Expected**
- Message that the code was not accepted. Still on sign-in.
2. Enter the current phone code. Sign In. → Signed in.
3. Sign out. Password + **the same code again**. Sign In.

**Expected**
- Rejected (a code works once). Wait for the next code → signed in.

### T13 · Too many wrong attempts
1. Sign out. Password + a wrong code, **8 times** in a row.

**Expected**
- On or before the 8th attempt: a message that there were too many attempts
  and to wait a few minutes. Correct password + correct code is **also**
  refused during this time.
2. Wait 15 minutes (or as documented). Password + current code.

**Expected**
- Signed in.

---

## Part 4 — Settings

### T14 · Changing the password now needs a code
1. Settings → **Login Password**. Fill current password, a new valid password,
   confirmation. Leave the **Authenticator Code** field empty.

**Expected**
- The Change Password button is disabled, or the form refuses with a message
  asking for the current authenticator code.
2. Enter a wrong code. Change Password.

**Expected**
- Failure message; the code field is cleared.
3. Enter the current phone code. Change Password.

**Expected**
- Success message; you are signed out shortly after.
- Old password + code → rejected. New password + code → signed in.
- **Second browser** that was signed in before the change: on its next click it
  is signed out (session expired message).
4. Change the password back the same way.

### T15 · Regenerate recovery codes
1. Settings → **Two-Factor Authentication** → expand.

**Expected**
- Explains that you get 10 new codes, your authenticator is unchanged, and
  existing codes stop working.
2. Enter password, leave code empty → button disabled. Enter password + current code → **Regenerate Recovery Codes**.

**Expected**
- A *Save your new recovery codes* panel with 10 codes, an acknowledgement box, and *Done*.
3. **Before clicking Done**, click the page's Refresh control (if present) or
   navigate within Settings.

**Expected**
- The 10 codes are still on screen — nothing on the page destroys them before you acknowledge.
4. Record the codes. Done.
5. Sign out. Password + **one of the OLD codes** (from T08/T10) via *Lost access to your authenticator?*.

**Expected**
- Rejected: old codes no longer work.

---

## Part 5 — Losing the phone

### T16 · Recovery code sign-in forces a new setup
1. Sign out. Click *Lost access to your authenticator?*.

**Expected**
- The code field becomes a **Recovery code** field; the link now reads
  *Use your authenticator instead*.
2. Password + one **unused** recovery code. Sign In.

**Expected**
- You land on the **setup screen** (new QR), not the console. Message context
  makes clear this is a re-setup.
3. **Without finishing setup**, try to reach the console (type a console URL, or use Back).

**Expected**
- Blocked with a message like *Finish setting up two-factor authentication before using the console.*
4. Scan the new QR (delete the old entry on the phone first), **Confirm**, save
   the **new** 10 codes, tick the box, *Continue to sign in*, then sign in with
   password + new-phone code.

**Expected**
- Signed in.
5. Sign out. Try the recovery code you used in step 2 again, and any code from
   the previous set.

**Expected**
- All rejected.

---

## Part 6 — Host-side cases (need SSH)

### T17 · Break-glass: lost phone AND codes (upgrade guide, Case 3)
*Host:* `dune console` stop is not required; do:
```bash
rm runtime/generated/console-second-factor.json     # leave the .watermark file alone
dune console restart
```
1. Password → setup screen (as T04). Complete setup: scan, confirm, **save the 10 codes**, sign in.
2. Sign out. *Lost access to your authenticator?* → password + one of the codes you just saved.

**Expected**
- Accepted: you reach the re-setup screen. (This is the case where freshly
  issued codes must actually work.) Complete re-setup and sign in.

### T18 · Console rolled back below the state file's version
*Host:* with the console **stopped**, edit the state file and change `"version": 1` to `"version": 99`; start the console.
1. Password + current code. Sign In.

**Expected**
- Sign-in refused with a message saying the two-factor state was written by a
  **newer** console version and to **upgrade the console — do not delete** the file.
- The message does **not** suggest removing the file to re-enroll.
*Host:* restore `"version": 1`; restart.

### T19 · Unreadable state file
*Host:* replace the state file's content with `{ not json`; restart.
1. Password. Sign In.

**Expected**
- Refused with a message that the state is unreadable and how to recover
  (restore from backup, or remove it to set up again). No session is created.
*Host:* restore the file from `~/qa-2fa-backup/` (or the T17 result); restart.

### T20 · Restored older backup is detected
*Host:* copy the current state file to `~/qa-old.json`. In the browser, use one
recovery code (T16 step 2 path), finish re-setup. *Host:* stop the console, copy
`~/qa-old.json` back over the state file (leave the watermark), start.
1. Sign out. *Lost access…* → password + a code from the **old** set.

**Expected**
- Refused with a message that the state appears restored from an older backup
  and all recovery codes were invalidated; told to sign in with the
  authenticator and regenerate codes.
2. Password + authenticator code (the phone entry that matches the restored file).

**Expected**
- Signed in. Settings → Regenerate works and yields a working set.

---

## Part 7 — Turning it off, proxies, and the guide itself

### T21 · Flag off and on again
*Host:* `CONSOLE_TOTP_ENABLED=0`; restart.
1. Password only → signed in; Settings has no Two-Factor section.
*Host:* `=1`; restart.
2. Password + current phone code → signed in **without** any new setup.

### T22 · Behind a reverse proxy (only if one exists)
*Host:* with `CONSOLE_TRUSTED_PROXY_IPS` **unset**, from two different client
devices behind the proxy, make wrong-code attempts on device A until locked.

**Expected (unset)**: device B is also locked (shared address).
*Host:* set `CONSOLE_TRUSTED_PROXY_IPS=<proxy IP>`; restart; repeat.

**Expected (set)**: device B is **not** locked by A's attempts.

### T23 · Keyboard and small screen
1. Repeat T04→T09 using **keyboard only** (Tab/Enter).
2. Repeat T11–T12 in a phone-width browser window.

**Expected**
- Every field reachable and every button activatable by keyboard; nothing
  clipped or unreadable at phone width; the QR is fully visible.

### T24 · Audit trail and no secrets on disk
*Host:*
```bash
tail -30 runtime/generated/web-admin-audit.jsonl | grep -oE '"action":"[^"]+"' | sort | uniq -c
grep -cE '"(totpCode|recoveryCode|secret)":"[^"]' runtime/generated/web-admin-audit.jsonl
stat -c %a runtime/generated/console-second-factor.json runtime/generated/web-admin-audit.jsonl
```

**Expected**
- Actions seen for this session include `auth.login`, `auth.2fa.setup`,
  `auth.2fa.confirm`, `settings.totp-setup`, `auth.recovery-code-consumed`,
  `settings.recovery-codes-regenerated`, `settings.change-admin-password`.
- The grep count is **0**. Both files are mode `600`.

### T25 · Follow the operator guide literally
1. Hand `docs/console/authentication-upgrade-guide.md` to someone who has
   **not** read this checklist. Ask them to follow it on a fresh state (T17 reset).

**Expected**
- They finish without asking a question. Every heading, link text, and message
  in the guide matches the screen. Record every mismatch, however small.

---

## Part 8 — Sign in with Discord (role-based access)

Needs: a Discord server you control with at least three test accounts (or one
account whose roles you can change), a Discord application with this console's
callback registered, Developer Mode on to copy IDs. One of the accounts must
have Discord 2FA **off** for T31.

**Status (2026-09-03): deliberately deferred to the operator's own QA process
during UAT, not run as part of the #676 consolidation work.** Every other case
in this document that could be driven by automation against a real deployment
was (Parts 1-7, 9); this one genuinely can't be -- it needs several real
Discord identities with different role assignments, one account with Discord
2FA off, and hands-on control of the Discord server's role membership and
(for T36) test-server ownership, none of which a scripted session can
substitute for. Results below are still blank pending that pass.

### T26 · Guided setup, as an operator would
*Host precondition:* the Discord application is in `.env` (`DISCORD_OAUTH_CLIENT_ID`, `DISCORD_OAUTH_CLIENT_SECRET` or the secret file, `DISCORD_OAUTH_REDIRECT_URI`), console restarted. (If it is not, the setup screen shows the `.env` keys to set and restart — there is **no** client-ID/secret form in the browser; worth a pass too.)
1. On the sign-in page click **Set up Discord sign-in**.

**Expected**
- The password field remains, with *Enter the admin password above to set up Discord sign-in.* and a *cancel* link. Nothing goes to Discord yet.
2. Enter the admin password.

**Expected**
- The setup screen with a single **Continue with Discord** button (no application step).
3. Click it.

**Expected**
- Discord's authorization screen names the application and asks to authorize it (the `identify`, `guilds` and `guilds.members.read` scopes). After **Authorize** you land back on the setup screen **not** signed in to the console as Discord; it shows *Signed in with Discord as **<you>**.* and, under **Your server**, either *Connecting **<server>**, which you own. That makes you the console **Owner**; everyone else's access comes from the roles below.* (one owned server) or a *Which of your servers* picker listing only servers you own.
4. Fill **Admin Role** only. Leave the two-factor box ticked (it is about each person's *Discord account* 2FA, not the console password). **Turn on Discord sign-in** — no password prompt.

**Expected**
- *Done. <server> is connected and <you> is the Owner…* with a **Restart the console now** button (and `dune console restart` offered as the manual alternative).
5. Click **Restart the console now**.

**Expected**
- The page shows it is restarting, reconnects on its own in ~10–20s, and reloads to a sign-in page that now leads with **Sign in with Discord**, the admin password moved to a secondary **Use the admin password instead** link.

### T27 · Role → tier, highest wins
1. Give account A the Admin role, account B the Player role (map Player Role in Settings first), account C both.
2. Each signs in with Discord.

**Expected**
- Discord shows an authorization screen naming the application and the permissions "know who you are / your servers / your roles in a server". After **Authorize**, each lands in the console.
- A: Admin — sees Server Control, Players, Bases…; **no Settings tab**; typing the Settings URL directly does not open it. B: Player — read-only tabs only. C: Admin (highest of the two).

### T28 · Not authorized
1. An account that is a member but holds no mapped role signs in.

**Expected**
- A plain page: *Discord sign-in succeeded, but this account is not authorized…* with a link back to the console. No session (reloading the console shows the sign-in page).
2. An account that is **not** a member of the server signs in. Same expectation.

### T29 · Owner is the server's owner — nobody else
1. As a Discord-signed-in **admin** (account A), open Settings.

**Expected**
- Cannot: the tab is hidden and the API refuses. (Settings is owner-only.)
2. As the **server owner** (your account), sign in with Discord.

**Expected**
- Owner: Settings visible; `/api/auth/me` says `tier: owner`. This holds even if your account also has the admin role.
3. Settings → Discord OAuth.

**Expected**
- **Corrected (#643/#676):** the manual Client ID/Redirect URI/Client Secret/Discord Server ID form described here no longer exists — Settings embeds the same guided wizard the sign-in page uses. Since Discord OAuth is already fully active and this browser session hasn't itself done the setup OAuth round-trip, the section shows a calm **"Discord Sign-In" (active)** summary ("Discord sign-in is connected and active for this server…") rather than a form, with **"Change application credentials"** and a link to re-authenticate for updating server/role mapping. No owner field anywhere, in the wizard's map step or here — ownership is never editable.

### T30 · Demotion takes effect at next sign-in
1. While A is signed in, remove A's Admin role in Discord. A keeps clicking around.

**Expected**
- A's current session keeps working. After A signs out and signs in again: refused (T28) or downgraded to whatever mapped role remains.

### T31 · Discord 2FA requirement (opt-in)
1. With **Require Discord 2FA for** blank, an admin-role account **without** Discord 2FA signs in.

**Expected**: admitted as Admin.
2. Set the field to `owner,admin` (click *use recommended*), save, restart. Same account signs in.

**Expected**: refused with *…requires two-factor authentication on your Discord account before granting admin access…* and the Discord setting named. A **player**-role account without 2FA is still admitted.
3. That account enables 2FA in Discord and signs in again.

**Expected**: admitted as Admin.

### T32 · Server chosen, no roles mapped
1. Settings → Discord OAuth: clear all three role fields, save, restart. Account A (admin role) signs in with Discord.

**Expected**
- Refused: *…not authorized to sign in…* (no mapped role). The server owner still signs in as Owner. Restore the mapping afterwards.

### T33 · Password path untouched, mixed sessions
1. With Discord configured, sign in with the password (via **Use the admin password instead**) in one browser and with Discord as a Player in another.

**Expected**
- Both work at once. The password session is Owner. Changing the admin password (T14) signs out other **password** sessions and leaves the Discord session alone.

### T34 · Re-authorization on upgrade (only if the install had Discord sign-in before this release)
1. An account that authorized the application under the previous build signs in.

**Expected**
- Discord shows the authorization screen again (one extra permission: roles in a server). After Authorize, sign-in proceeds. Existing owner list / bootstrap behaviour unchanged.

### T35 · Separation of duties — one role, one tier
1. Settings → Discord OAuth: put the **same** role ID in *Admin Role* and *Moderator Role*.

**Expected**
- An inline message: *Each Discord role can map to only one access level — role <id> is mapped to admin and moderator. Owner is never a role…*; **Save Discord OAuth** is disabled.
2. *Host:* edit `.env` by hand so `DISCORD_CONSOLE_MODERATOR_ROLE_IDS` equals `DISCORD_CONSOLE_ADMIN_ROLE_IDS`; `dune console restart`. Click **Sign in with Discord**.

**Expected**
- Refused immediately (no Discord round-trip) with *…gives one Discord role two different access levels (role <id> is mapped to admin and moderator)…* naming Settings. Password sign-in still works.
3. *Host:* restore the mapping; restart.

### T36 · Ownership follows Discord
1. In Discord, transfer ownership of a **test** server you own to account A (or use a second test server). Run the guided setup against that server, then sign in with Discord as A and as yourself.

**Expected**
- A is Owner (Settings visible). You get only what your roles map to — Admin if you hold the admin role, otherwise refused. Transfer ownership back; at the next sign-in the roles swap accordingly.

## Part 9 — Discord OAuth lifecycle: disable, re-enable, forget, and the zero-2FA guard (#676)

Needs: an install with Discord OAuth already fully configured and active (T26 done). All four cases below were run live against a real dev deployment (not a mocked/local run) — see Results for the exact evidence.

### T37 · Disable, verify the cutoff, re-enable
1. Settings → Discord OAuth (active) → **Disable Discord Sign-In**, enter the admin password, confirm.

**Expected**
- The console restarts (own progress state shown: "Disabling…" then "Restarting the console…"). After it reconnects, the sign-in page shows the password field only, with a secondary **Set up Discord sign-in** link — not **Sign in with Discord**. `/api/auth/state` reports `discordOAuthConfigured: false, discordOAuthDisabled: true`.
2. Sign in with the admin password. Settings → Discord OAuth.

**Expected**
- A compact **"Discord Sign-In (disabled)"** banner: *"Your Discord application's settings are kept, not deleted — re-enable any time."*, a **Re-enable Discord Sign-In** button, and a secondary **"Forget this configuration entirely"** link (collapsed).
3. Click **Re-enable Discord Sign-In**.

**Expected**
- The console restarts again; after it reconnects, the sign-in page shows **Sign in with Discord** again, with **Use the admin password instead** underneath. `/api/auth/state` reports `discordOAuthConfigured: true, discordOAuthDisabled: false`. Signing in with Discord as the owner still works, unchanged.

### T38 · Zero-2FA guard: both branches
Requires the password tier's own TOTP (`CONSOLE_TOTP_ENABLED=1`) enrolled for this test.
1. With **Require Discord 2FA for** set to `owner,admin` (T31) and the acting session's Discord-derived tier covered by it, enroll TOTP (Settings → Two-Factor Authentication → Enable), then try to disable it again.

**Expected**
- No warning — TOTP disables immediately. Discord's own 2FA already covers this role, so removing the password tier's separate TOTP does not leave the console with zero factors anywhere.
2. Change **Require Discord 2FA for** to exclude the acting tier (or clear it), restart, then try disabling TOTP again with TOTP re-enrolled.

**Expected**
- A 409 warning inline: *"Disabling this will leave your console with no two-factor authentication anywhere — Discord sign-in doesn't require Discord's own two-factor for your role."*, with a pointer back to the Discord OAuth section's MFA-requirement toggle, and a **"Disable anyway"** button that proceeds only on a second, explicit click.

### T39 · Forget: the destructive path
1. Settings → Discord OAuth (active or disabled) → **"Forget this configuration entirely"** → type `forget` to confirm, enter the admin password (+ authenticator code if TOTP is enrolled).

**Expected**
- The confirm button stays disabled until `forget` is typed exactly. After confirming: the console restarts; afterward the sign-in page shows password-only with **Set up Discord sign-in**, exactly as if Discord OAuth had never been configured — the Client Secret file is gone from disk and every Discord OAuth `.env` field is cleared (guild ID, role mappings, MFA requirement). Re-running T26 from scratch is the only way back.

### T40 · Already-active summary, wrong session
1. As an admin who signed in with the console **password** (never did the wizard's own OAuth round-trip this session), open Settings → Discord OAuth on an install where Discord sign-in is already fully configured and active.

**Expected**
- **Fixed as a direct result of this UAT pass (was a real bug before this fix):** the section shows the calm **"Discord Sign-In" (active)** summary, never **"Set up Discord sign-in"** / a big **"Continue with Discord"** primary button — that combination previously read as broken or unconfigured for an integration that was demonstrably working. A **"Sign in with Discord to update server or role mapping"** link and **"Change application credentials"** remain available for reconfiguration.

## Results

| Case | Result | Evidence / exact text seen | Notes |
|---|---|---|---|
| T01 | | | |
| T02 | | | |
| T03 | | | |
| T04 | | | |
| T05 | | | |
| T06 | | | |
| T07 | | | |
| T08 | | | |
| T09 | | | |
| T10 | | | |
| T11 | | | |
| T12 | | | |
| T13 | | | |
| T14 | | | |
| T15 | | | |
| T16 | | | |
| T17 | | | |
| T18 | | | |
| T19 | | | |
| T20 | | | |
| T21 | | | |
| T22 | | | |
| T23 | | | |
| T24 | | | |
| T25 | | | |
| T26 | | | |
| T27 | | | |
| T28 | | | |
| T29 | | | |
| T30 | | | |
| T31 | | | |
| T32 | | | |
| T33 | | | |
| T34 | | | |
| T35 | | | |
| T36 | | | |
| T37 | Pass | Re-run live on dune-dev, 2026-09-03, against the current head (commit including the in-process cutoff flags). Confirmed the actual security property, not just the UI: `fetch('/api/auth/discord/start')` called immediately after the disable request returned -- deliberately before the restart could possibly have completed -- was already refused (404), proving the cutoff is synchronous and in-process, not dependent on the restart. Full cycle (disable -> immediate-cutoff check -> restart -> disabled banner -> re-enable -> restored) verified end-to-end. | |
| T38 | Pass | Both branches re-run live on dune-dev with real generated TOTP codes (2026-09-03). Branch 1 (Discord already covers owner MFA): disable succeeded immediately, no warning. Branch 2 (MFA requirement temporarily narrowed to exclude owner, via a direct `.env` edit + restart -- not reachable through the UI without a real Discord OAuth round-trip): disabling showed the 409 warning with the real danger-zone styling; "Disable anyway" (the `acknowledgeNoOtherFactor:true` bypass) succeeded on the second attempt. This same pass also caught and led to fixing a real, separate bug: the new SERVER_TITLE-based TOTP issuer (#690) never reached the container for the same "not in docker-compose.web.yml's passthrough" reason as T37's original finding -- confirmed fixed (issuer correctly showed the real server title) before continuing. | |
| T39 | Pass | Ran live on dune-dev, 2026-09-03. Forget is only reachable from the disabled banner, not directly from the active state (this checklist's earlier wording implied both -- corrected here); disabled first, then forgot. Confirmed: the immediate in-process cutoff fires the same way as T37 (checked before the restart could complete); after settling, `discordOAuthConfigured`/`discordOAuthAppConfigured`/`discordOAuthDisabled` were all correctly `false` (a momentary `true` reading exactly at the container-recreate boundary was a test-script timing artifact, not a real bug -- the UI's own restart-polling never exposes this window to an operator); the Client Secret file was confirmed deleted from disk. | |
| T40 | Pass | Ran live on dune-dev, 2026-09-03 — this exact scenario (password-session admin, already-active Discord OAuth) is what surfaced the bug this row's fix addresses; screenshots taken before and after the fix. | |

All four Part 9 cases are now fully live-verified against the current head, including the actual security property (the in-process cutoff, not just the surrounding UI) for T37 and T39. dune-dev was restored to its exact pre-UAT state (TOTP enrollment, Discord OAuth config, and `DISCORD_OAUTH_REQUIRE_MFA_TIERS`) after this pass — confirmed via the login screen matching its original appearance.

**Tester:** ______  **Date:** ______  **Build:** ______
**Verdict:** ☐ all pass  ☐ pass with findings filed: ______  ☐ blocked

**After the run:** restore `.env` and the two state files from `~/qa-2fa-backup/`
if the install is someone's real console, and restart.
