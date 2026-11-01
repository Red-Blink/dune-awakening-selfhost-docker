# CI security checks (`security-checks` job)

**Status:** Current | **Last Updated:** November 2026

The `security-checks` CI job runs `tests/security-pr-checks.sh`: a whitespace and merge-conflict check, ShellCheck,
gitleaks (secrets) and trivy (secrets and Dockerfile/IaC misconfiguration).

## What gets scanned

`SCAN_MODE` selects the scope (the workflow sets it from the trigger):

| Mode | When | Scope |
|---|---|---|
| `changed` (default) | pull requests | only the files the branch changed relative to `BASE_REF` (default `upstream/main`) |
| `full` | every other trigger: push to `main`, manual dispatch | every tracked file |

On a push to `main` HEAD is the base, so the changed set is empty by construction; without `full` mode the job
would scan nothing. A full scan of the tracked tree takes a few seconds. It refuses to report a clean result if it
staged no files.

Changed-file scans include renamed destinations and type-changed regular files, since a rename can also introduce
new contents. Deleted files and symlinks are not copied into the scan directory.

## Fail-closed behaviour

- gitleaks and trivy are installed in CI (pinned versions, sha256-verified). With `CI=true`, a missing scanner is
  an **error**, never a skip. Outside CI a missing scanner still prints `SKIP:` for local convenience.
- trivy exits non-zero on any HIGH or CRITICAL finding, using its embedded checks (`--skip-check-update`) so a
  commit scans the same way every time.
- After installation, CI tests both real scanners against clean files, synthetic secret fixtures (including a renamed
  file), and a Dockerfile with no `USER`, so regressions cannot silently turn the checks into a false success.

## Accepting a finding

- **gitleaks:** the allowlist is the `[allowlist]` table in `.gitleaks.toml` (the singular table is the only form
  the pinned release applies). Entries are regexes matched against the extracted secret; **anchor them**
  (`^value$`). An unanchored literal also hides any real token that merely contains it.
- **trivy:** add a path-scoped entry with a `statement` and an `expired_at` date to `.trivyignore-fs.yaml`.
  Never add a bare rule ID. After the expiry date the entry stops applying, the finding returns and the check
  fails on purpose (the log prints a `NOTE:` naming the lapsed date). Renewal is a maintainer decision: re-triage,
  then either fix the finding or renew the date with a fresh justification.

## For contributors

- A new or changed Dockerfile with no `USER` instruction fails the job (trivy rule DS-0002) unless it is covered
  by `.trivyignore-fs.yaml`.
- The eight Dockerfiles that currently have no `USER` (`orchestrator/` and the seven
  `patches/experimental-tanks/*/` overlays), plus one `apt-get` without `--no-install-recommends` in the
  orchestrator image, are accepted in `.trivyignore-fs.yaml` until 2027-01-07 and must be re-triaged by then.

## Hardening recommendation (not applied here)

The scanner reads `.gitleaks.toml`, `.trivyignore-fs.yaml` and the script itself from the pull request's own
checkout, so a PR can change the rules that judge it. A `CODEOWNERS` entry for those files and
`.github/workflows/` with required code-owner review closes that gap; it needs the maintainers' handles and a
branch-protection setting, so it is left to them.
