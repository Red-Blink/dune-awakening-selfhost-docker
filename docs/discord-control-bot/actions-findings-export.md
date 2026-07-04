# GitHub Actions Findings JSON Export

## Purpose

`scripts/export-github-actions-findings.mjs` exports GitHub Actions run, job, step, and artifact findings into a local JSON file.

This avoids manually copying multiple workflow or job URLs into an analysis prompt. Export the JSON once, then attach or paste the file content for analysis.

## Supported Sources

The exporter accepts any mix of:

```text
https://github.com/OWNER/REPO/pull/3
https://github.com/OWNER/REPO/actions/workflows/soc2-readiness-check.yml
https://github.com/OWNER/REPO/actions/runs/123456789
https://github.com/OWNER/REPO/actions/runs/123456789/job/987654321
pr:3
#3
123456789
```

When using `pr:3`, `#3`, or a numeric run ID, pass `--repo OWNER/REPO` unless `GITHUB_REPOSITORY` is already set.

## Authentication and Rate Limits

For private repositories, workflow logs, or higher API limits, set one of:

```bash
export GITHUB_TOKEN="..."
# or
export GH_TOKEN="..."
```

If neither variable is set, the exporter now attempts to reuse the GitHub CLI token from:

```bash
gh auth token
```

Recommended setup:

```bash
gh auth login
export GH_TOKEN="$(gh auth token)"
```

If GitHub returns a rate-limit response, the output JSON includes `requestTelemetry.rateLimit` and `sourceErrors` with reset details when available.

Optional rate-limit controls:

```bash
--wait-rate-limit         Wait and retry once if the reset time is within the allowed wait window.
--max-wait-seconds 300    Maximum wait window for --wait-rate-limit.
--skip-artifacts          Skip artifact listing to reduce API calls.
--no-gh-token             Do not attempt to read a token from gh auth token.
```

The exporter also caches repeated API requests during one run and reuses workflow-run metadata returned by list endpoints to reduce API calls.

## Examples

Export all recent Actions findings for PR 3:

```bash
node scripts/export-github-actions-findings.mjs \
  https://github.com/yacketrj/dune-awakening-selfhost-docker-WSL/pull/3 \
  --out artifacts/security/pr-3-actions-findings.json
```

Export PR 3 using an authenticated GitHub CLI token:

```bash
export GH_TOKEN="$(gh auth token)"

node scripts/export-github-actions-findings.mjs \
  pr:3 \
  --repo yacketrj/dune-awakening-selfhost-docker-WSL \
  --out artifacts/security/pr-3-actions-findings.json
```

Export a lower-request summary without artifact metadata:

```bash
node scripts/export-github-actions-findings.mjs \
  pr:3 \
  --repo yacketrj/dune-awakening-selfhost-docker-WSL \
  --limit 6 \
  --skip-artifacts \
  --out artifacts/security/pr-3-actions-findings.json
```

Export a specific workflow's recent runs:

```bash
node scripts/export-github-actions-findings.mjs \
  https://github.com/yacketrj/dune-awakening-selfhost-docker-WSL/actions/workflows/soc2-readiness-check.yml \
  --limit 5 \
  --out artifacts/security/soc2-actions-findings.json
```

Export a failed run with log excerpts:

```bash
node scripts/export-github-actions-findings.mjs \
  https://github.com/yacketrj/dune-awakening-selfhost-docker-WSL/actions/runs/27715391676 \
  --include-logs \
  --out artifacts/security/actions-findings-with-logs.json
```

## Output Shape

The JSON file includes:

```text
schemaVersion
generatedAt
repository
sources
summary
requestTelemetry
findings
runs
sourceErrors
```

Important finding types:

```text
job_failure
step_failure
artifact_available
```

The `runs` section preserves workflow name, run ID, branch, head SHA, jobs, failed steps, and artifacts.

## Safety Notes

- The exporter does not mutate GitHub state.
- It does not download artifact contents.
- `--include-logs` stores excerpts only for failed jobs and truncates each excerpt.
- Treat generated JSON as internal diagnostic evidence because workflow logs may contain operational context.
