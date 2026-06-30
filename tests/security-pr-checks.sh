#!/usr/bin/env bash
set -euo pipefail

BASE_REF="${BASE_REF:-upstream/main}"
REPORT_DIR="${REPORT_DIR:-.security-reports}"
PR_FILES_DIR="$REPORT_DIR/pr-files"

printf 'Security check base ref: %s\n' "$BASE_REF"
printf 'Report directory: %s\n' "$REPORT_DIR"
printf 'Changed-file staging directory: %s\n\n' "$PR_FILES_DIR"

mkdir -p "$REPORT_DIR"

printf '== Git whitespace/conflict check ==\n'
git diff --check "$BASE_REF"...HEAD

printf '\n== Changed files ==\n'
git diff --name-only "$BASE_REF"...HEAD --diff-filter=ACM | tee "$REPORT_DIR/changed-files.txt"

printf '\n== Preparing changed-file scan set ==\n'
rm -rf "$PR_FILES_DIR"
mkdir -p "$PR_FILES_DIR"

while IFS= read -r file; do
  [ -n "$file" ] || continue
  [ -f "$file" ] || continue

  mkdir -p "$PR_FILES_DIR/$(dirname "$file")"
  cp "$file" "$PR_FILES_DIR/$file"
done < "$REPORT_DIR/changed-files.txt"

if [ ! -d "$PR_FILES_DIR" ]; then
  printf 'ERROR: changed-file staging directory was not created: %s\n' "$PR_FILES_DIR" >&2
  exit 1
fi

printf 'Copied changed files into: %s\n' "$PR_FILES_DIR"
find "$PR_FILES_DIR" -type f | sort | tee "$REPORT_DIR/staged-files.txt"

printf '\n== Secret keyword review on changed files ==\n'
if [ -s "$REPORT_DIR/staged-files.txt" ]; then
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    grep -HnE '(password|passwd|secret|token|apikey|api_key|private[_-]?key|BEGIN RSA|BEGIN OPENSSH|FUNCOM|FLS|COMMAND_AUTH_TOKEN)' "$file" || true
  done < "$REPORT_DIR/staged-files.txt" | tee "$REPORT_DIR/secret-keyword-review.txt"
else
  printf 'No changed files to scan.\n' | tee "$REPORT_DIR/secret-keyword-review.txt"
fi

printf '\n== ShellCheck ==\n'
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck \
    runtime/scripts/dune \
    runtime/scripts/metrics-stack.sh \
    runtime/scripts/metrics-status.sh \
    tests/metrics-stack-unit.sh \
    tests/security-pr-checks.sh
else
  printf 'SKIP: shellcheck is not installed.\n'
fi

printf '\n== Gitleaks changed-file scan ==\n'
if command -v gitleaks >/dev/null 2>&1; then
  if gitleaks detect --help 2>/dev/null | grep -q -- '--no-git'; then
    GITLEAKS_CMD=(gitleaks detect --source "$PR_FILES_DIR" --no-git --redact --report-format json --report-path "$REPORT_DIR/gitleaks-pr-files.json")
  else
    GITLEAKS_CMD=(gitleaks detect --source "$PR_FILES_DIR" --redact --report-format json --report-path "$REPORT_DIR/gitleaks-pr-files.json")
  fi

  if "${GITLEAKS_CMD[@]}"; then
    printf 'Gitleaks changed-file scan passed.\n'
  else
    printf 'Gitleaks changed-file scan found findings. See %s\n' "$REPORT_DIR/gitleaks-pr-files.json" >&2
    exit 1
  fi
else
  printf 'SKIP: gitleaks is not installed.\n'
fi

printf '\n== Trivy filesystem scan ==\n'
if [ ! -d "$PR_FILES_DIR" ]; then
  printf 'ERROR: Trivy staging directory missing before scan: %s\n' "$PR_FILES_DIR" >&2
  exit 1
fi

if ! find "$PR_FILES_DIR" -type f -print -quit | grep -q .; then
  printf 'SKIP: no changed files copied into %s.\n' "$PR_FILES_DIR"
elif command -v trivy >/dev/null 2>&1; then
  printf 'Running Trivy against: %s\n' "$PR_FILES_DIR"
  trivy fs --scanners secret,misconfig --severity HIGH,CRITICAL "$PR_FILES_DIR"
else
  printf 'SKIP: trivy is not installed.\n'
fi

printf '\nSecurity checks completed.\n'
