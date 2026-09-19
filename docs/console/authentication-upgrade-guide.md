# Console sign-in: upgrading an existing install

**Status: Current.** Verified 2026-08-27 by upgrading a live install running
v1.4.3 in place, with an authenticator already enrolled from an earlier build.

This guide is for operators who already run the console and want to know what
changes, what they need to do, and what they will see on screen. Nothing here
happens automatically — updating the console leaves your sign-in exactly as it
is until you deliberately turn the new option on.

## What sign-in options exist

| Option | Status | What it is |
|---|---|---|
| **Password** | Every install has this today | The admin password from `runtime/secrets/admin-web-password.txt` (or `ADMIN_PASSWORD`). |
| **Password + authenticator app** | New in this release, **off by default** | Your password plus a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password, Bitwarden, etc.), with 10 one-time recovery codes for the day you lose your phone. |

Passkeys are **not** part of this release. If you have read about them in the
design document (`docs/rfc-console-auth.md`), that is the plan, not something
you can turn on today.

There is one admin account. If several people sign in to your console, they
share the password today and they will share the authenticator too. Read the
"Several people sign in" question at the end before turning this on.

## Before you start (five minutes)

Do these first. The one that bites people is the second.

1. **Install an authenticator app on your phone** if you do not have one.
2. **Decide where the recovery codes will live.** They are shown exactly once.
   A password manager is ideal; a printed sheet in a drawer is fine. Your
   notes app that syncs to the phone you might lose is not.
3. **Confirm you can reach the machine the console runs on** (SSH, or the
   physical box). If you ever lose both your phone and your recovery codes,
   that access is the only way back in — see "If something goes wrong".
4. **Check who else signs in**, and tell them. After you finish, their password
   alone will stop working.
5. **Back up `runtime/generated/`** if you back up anything. Your authenticator
   state will live there.

## Step 1 — update the console (nothing changes yet)

Update your checkout the way you normally do, then rebuild the console:

```bash
dune self-update install latest      # or `git pull` if you track a branch
dune console restart                 # rebuilds the image and restarts it
```

`dune console restart` is the important line. The new sign-in code and the
package it needs only land when the image is rebuilt.

Sign in as usual. **Nothing is different.** The option is off until Step 2.

## Step 2 — make two-factor available

Open `.env` in the repository root and set:

```ini
CONSOLE_TOTP_ENABLED=1
```

If the line is not there, add it (`.env.example` has the full description).
Then:

```bash
dune console restart
```

**Corrected 2026-09-02 (issue #665): this step only makes the feature
available.** It does not turn two-factor on by itself, and your next sign-in
is unaffected — password sign-in keeps working exactly as before until you
opt in yourself in Step 3. (This page previously described the flag as
forcing setup on your very next sign-in; live-testing feedback from the
upstream maintainer was that forcing every operator into 2FA with no way to
decline was the wrong default, so enrollment is now something you start
yourself, whenever you're ready.)

## Step 3 — turn it on from Settings, when you're ready

Sign in as usual, then open **Settings → Two-Factor Authentication → Enable
Two-Factor Authentication**. Do this when you are sitting in front of the
console with your phone in hand and somewhere to save the codes — not as
part of an unattended session, because of what happens next.

Enter your current login password and click **Enable Two-Factor
Authentication**. You land on a setup screen. You have **10 minutes**; if it
expires, open the Settings control again to start over.

**Scan the QR code** with your authenticator app. If you cannot scan, the
same secret is printed beneath the QR under *Can't scan? Enter this code
manually:* — type it into the app instead.

**Enter the 6-digit code** the app now shows, to prove the pairing worked.

**Save your recovery codes.** The next screen says *Save your recovery codes*
and shows ten of them. This is the moment from the checklist: they are shown
once, right now, and never again. Each works only once. Store all ten, then
tick the acknowledgement and click *Continue to sign in*.

**Sign in again** with your password **and a fresh code** from the app. The
code you used to confirm the pairing will not work here — wait for the app to
show the next one. That is deliberate.

You are in. Setup is finished.

## Every sign-in from now on

Password, then the current 6-digit code. Codes change every 30 seconds and each
one can be used once, so if a code is rejected, wait for the next one rather
than retyping it. The sign-in page also offers *Lost access to your
authenticator?* for the day you need a recovery code instead.

## Managing it afterwards (Settings)

Two things change on the Settings page once you've enabled two-factor:

- **Login Password** now asks for a current authenticator code as well as your
  current password before it will change the password.
- The **Two-Factor Authentication** section now lets you **Regenerate Recovery
  Codes** — enter your password and a current code, and you get ten fresh
  ones. The old ten stop working the moment the new ones are issued. Do this if
  you have used several, or are not sure where the sheet went.

Your authenticator itself is not changed by either action.

The same section also has a **Disable Two-Factor Authentication** control
(password + a current code, same fresh-proof requirement as everything else
here) — see *Turning it off again* below.

## Running behind a reverse proxy or tunnel

Skip this section if the console is reached directly.

The console limits failed sign-in attempts per visitor address. Behind a proxy
or tunnel (nginx, Caddy, Cloudflare Tunnel, …) every visitor arrives from the
proxy's own address, so one person's typos can lock everyone out — including
you. Tell the console the proxy's exact IP address(es) so it uses the real
visitor address instead:

```ini
CONSOLE_TRUSTED_PROXY_IPS=127.0.0.1
```

Comma-separate several. Exact IPs only, no ranges. Leave it unset if there is
no proxy — that is the safe default. The console reads the **last** address the
trusted proxy appends to `X-Forwarded-For` (the real visitor), never the
client-supplied leftmost value, so a visitor cannot spoof the header. Only a
single trusted proxy hop is supported; chained proxies are out of scope.

## Turning it off again

Two different things can be turned off, and they're not the same:

- **Just for yourself, keeping the feature available:** Settings → Two-Factor
  Authentication → **Disable Two-Factor Authentication** (password + a
  current code). Sign-in goes back to password only immediately. This
  deletes your authenticator pairing and recovery codes outright — if you
  turn it back on later, you set up again from scratch, same as the first
  time.
- **Making the feature unavailable to everyone on this install:** set
  `CONSOLE_TOTP_ENABLED=0` (or remove the line) and run `dune console
  restart`. Sign-in goes back to password only. Unlike the Settings control
  above, this does **not** delete anything — your authenticator state is
  kept, so if you flip the flag back on later you do **not** set up again,
  and the Settings control just shows you as already enrolled.

## If something goes wrong

**I lost my phone but I have my recovery codes.** On the sign-in page, click
*Lost access to your authenticator?*, enter your password and one recovery
code. You will be taken straight back to the setup screen to pair a new phone
and receive ten new codes. The old authenticator and the remaining old codes
stop working **when you finish that setup** — until then they are still valid,
so finish it. This is the normal path and needs nothing from the server.

**I still have my phone but lost the codes.** Sign in normally and use
*Regenerate Recovery Codes* in Settings.

**I lost both.** There is no way back in from the sign-in page, on purpose — a
second factor that could be reset from the sign-in page would not be one. You
need access to the machine: follow *Case 3* in
[two-factor-recovery.md](two-factor-recovery.md). It is a two-minute
procedure, and your password is not affected.

**I set the flag and nothing happened.** That's expected now — Step 2 only
makes the feature available; it doesn't turn it on by itself. Password
sign-in keeps working with no code and no setup screen until you go to
Settings → Two-Factor Authentication and enable it yourself (Step 3). If the
Settings section isn't there at all, that's the real problem: confirm you ran
`dune console restart` *after* editing `.env`, then check with
`docker inspect redblink-dune-docker-console --format '{{.Config.Env}}' | tr ' ' '\n' | grep CONSOLE_TOTP`.
If it prints nothing, the compose file in your checkout predates this feature —
update it.

**After updating, sign-in says my two-factor state was written by a newer
console.** You have rolled the console back to an older version than the one
that last ran. Your state is fine; **do not delete it**. Update the console
forward again and sign in normally.

**Sign-in says the two-factor state is unreadable.** The state file itself is
damaged. Restore `runtime/generated/console-second-factor.json` from a backup,
or — if you have no backup — remove it and enable two-factor again from
Settings, exactly as in Step 3.

**My recovery codes were rejected and the message mentions a restored backup.**
The console noticed its state file is older than one it has seen before
(usually a restored backup) and retired every recovery code rather than risk
honouring one that had already been spent. Sign in with your authenticator
app, then regenerate the codes from Settings.

## Backups

Two files hold everything, both in `runtime/generated/` and both already
ignored by git:

```
console-second-factor.json             your authenticator + recovery codes (hashed)
console-second-factor.json.watermark   a small integrity marker
```

Back them up together and restore them together. If you restore only the first
from an old backup, expect the "restored backup" message above the first time
you use a recovery code — that is the marker doing its job.

## Questions operators ask

**Several people sign in to my console. Do they each get their own
authenticator?** No: one account, one authenticator, one set of recovery
codes.

**My password is set with `ADMIN_PASSWORD` in `.env`, not the file.** Password
+ authenticator works exactly the same. The only difference is one you already
have: the *Login Password* section in Settings cannot change an
environment-managed password, with or without this feature.

**I run with `ADMIN_AUTH_DISABLED=1`.** Then there is no password check, and
there is no authenticator check either — that setting bypasses sign-in
entirely and is meant for a console that is not reachable from anywhere
untrusted. Turning this feature on does not change that.

**Does this affect players or the game server?** No. It only changes how you
sign in to the web console. The game servers are separate containers and are
not restarted by any step here.

**Can I use a hardware key / passkey instead of a phone app?** Not in this
release. Any app that does standard time-based codes (TOTP) works, and most
password managers can act as one.

## See also

- [two-factor-recovery.md](two-factor-recovery.md) — the lockout cases in
  detail, including the host-side reset.
- [API-REFERENCE.md](API-REFERENCE.md) — the endpoints behind all of this.
- `.env.example` — the full description of `CONSOLE_TOTP_ENABLED` and
  `CONSOLE_TRUSTED_PROXY_IPS`.
