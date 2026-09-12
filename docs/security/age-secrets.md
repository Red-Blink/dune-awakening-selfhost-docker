# Age-encrypted runtime secrets

This optional backend encrypts the server-login password and username
secrets (Stage 2), and the hosted-bot wizard's Discord OAuth client
secret (Stage 3), at rest. Existing installations remain on plaintext
until an operator explicitly migrates them.

## Prerequisites

Install `age` and Python's `cryptography` package before configuring the
backend. Package names for common distributions are:

```text
Debian/Ubuntu: age python3-cryptography
Fedora/RHEL:   age python3-cryptography
Arch:          age python-cryptography
Alpine:        age py3-cryptography
```

Confirm both dependencies before migration:

```bash
age --version
python3 -c 'from cryptography.hazmat.primitives.ciphers.aead import AESGCM'
```

## Create the identity and wrapped KEK

Keep the age identity outside the repository and outside normal runtime
backups. The following example uses `/etc/dune/age`; adjust ownership for
the account that runs Dune:

```bash
sudo install -d -m 700 -o "$USER" /etc/dune/age
age-keygen -o /etc/dune/age/identity.txt
age-keygen -y /etc/dune/age/identity.txt > /etc/dune/age/recipient.txt
openssl rand -hex 32 | age --encrypt -R /etc/dune/age/recipient.txt -o /etc/dune/age/kek.age
chmod 600 /etc/dune/age/identity.txt /etc/dune/age/kek.age
```

Set absolute paths in `.env`:

```dotenv
DUNE_KEK_FILE=/etc/dune/age/kek.age
DUNE_AGE_IDENTITY_FILE=/etc/dune/age/identity.txt
```

Back up the identity and wrapped KEK separately. Losing either makes the
encrypted secrets unrecoverable.

## Migrate and verify

Run the migration separately for each currently supported secret:

```bash
runtime/scripts/dune secrets migrate server-login-password-secret --dry-run
runtime/scripts/dune secrets migrate server-login-password-secret
runtime/scripts/dune secrets verify server-login-password-secret

runtime/scripts/dune secrets migrate username-server-login-secret --dry-run
runtime/scripts/dune secrets migrate username-server-login-secret
runtime/scripts/dune secrets verify username-server-login-secret
```

`discord-hosted-bot-oauth-client-secret` (Stage 3) is optional and
operator-supplied -- the hosted-bot wizard's "Advanced: connect
manually instead" fallback (Settings -> Discord Bot). If you have not
configured a Client Secret there, there is nothing to migrate yet;
`migrate` will correctly refuse with "nothing to migrate" rather than
fabricate one, unlike the two secrets above (which are auto-generated
if absent). If you have configured it:

```bash
runtime/scripts/dune secrets migrate discord-hosted-bot-oauth-client-secret --dry-run
runtime/scripts/dune secrets migrate discord-hosted-bot-oauth-client-secret
runtime/scripts/dune secrets verify discord-hosted-bot-oauth-client-secret
```

This secret is resolved on the host by `runtime/scripts/console.sh`
(not `runtime-env.sh`, which only game-server startup scripts use) the
next time the console is restarted (`dune console restart`) -- restart
the console after migrating for the encrypted form to actually take
effect.

After verifying services can start with the encrypted values, remove each
legacy plaintext through the guarded command:

```bash
runtime/scripts/dune secrets cleanup-legacy server-login-password-secret
runtime/scripts/dune secrets cleanup-legacy username-server-login-secret
runtime/scripts/dune secrets cleanup-legacy discord-hosted-bot-oauth-client-secret
```

After migration, the `.enc` file or migration marker is permanent migration
history. If backend configuration is missing, an artifact is unreadable, or
decryption fails, launchers stop instead of generating or using plaintext.
Restore the identity, KEK, and encrypted payload from backup; do not delete
the artifacts to bypass the safety check.
