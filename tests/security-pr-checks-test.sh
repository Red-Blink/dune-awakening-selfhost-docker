#!/usr/bin/env bash
# Behavioural tests for tests/security-pr-checks.sh.
#
# That script is a security gate, and its worst failure mode is silent: reporting success while a scanner
# never ran (it used to print "SKIP: <tool> is not installed" and exit 0 on a runner that had neither).
# These tests lock the fail-closed behaviour so a refactor cannot turn it back into a fail-open "success".
#
# Each case builds a throwaway git repository and runs the script under a restricted PATH, so "scanner
# missing" is real rather than simulated. The first group needs no real scanner (small stubs stand in for
# gitleaks); the last group runs the real gitleaks/trivy end to end and is skipped when they are not installed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$ROOT/tests/security-pr-checks.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
RC=0
OUT=""

pass() { printf 'ok   %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; FAILED=1; }

expect_rc() { # description expected-rc
  if [ "$RC" -eq "$2" ]; then pass "$1"; else fail "$1 (exit $RC, expected $2)"; printf '%s\n' "$OUT" | tail -n 12 >&2; fi
}
expect_out() { # description fixed-string
  if printf '%s\n' "$OUT" | grep -qF -- "$2"; then pass "$1"; else fail "$1 (output lacks: $2)"; printf '%s\n' "$OUT" | tail -n 12 >&2; fi
}

# A PATH holding only what the script itself needs, so a missing scanner is genuinely missing.
TOOLS="$WORK/tools"
mkdir -p "$TOOLS"
for tool in bash sh env git grep tr wc find sort cp mkdir rm dirname date cat tee head sed python3 mktemp basename; do
  path="$(command -v "$tool" 2>/dev/null || true)"
  if [ -n "$path" ]; then ln -s "$path" "$TOOLS/$tool"; fi
done

# A stand-in gitleaks: answers `detect --help` and records which files were staged for the scan.
STUBS="$WORK/stubs"
mkdir -p "$STUBS"
cat > "$STUBS/gitleaks" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "detect" ]; then
  src=""
  prev=""
  for arg in "$@"; do
    if [ "$prev" = "--source" ]; then src="$arg"; fi
    if [ "$arg" = "--help" ]; then echo "      --no-git   treat the git repo as a regular directory"; exit 0; fi
    prev="$arg"
  done
  if [ -n "$src" ] && [ -n "${STUB_STAGED_LIST:-}" ]; then
    find "$src" -type f -print0 | tr '\0' '|' > "$STUB_STAGED_LIST"
  fi
fi
exit 0
EOF
chmod +x "$STUBS/gitleaks"

new_repo() { # name -> prints the repo path; one commit with a README, upstream/main pointing at it
  local dir="$WORK/$1"
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  git -C "$dir" config user.email test@example.test
  git -C "$dir" config user.name test
  git -C "$dir" config commit.gpgsign false
  printf 'hello\n' > "$dir/README.md"
  git -C "$dir" add -A
  git -C "$dir" commit -q -m base
  git -C "$dir" update-ref refs/remotes/upstream/main HEAD
  printf '%s' "$dir"
}

run_script() { # repo path-for-the-run [VAR=value ...]
  local repo="$1" run_path="$2"
  shift 2
  if OUT="$(cd "$repo" && env -i PATH="$run_path" HOME="$WORK" "$@" bash "$SCRIPT" 2>&1)"; then RC=0; else RC=$?; fi
}

# ---------------------------------------------------------------- no real scanner needed
repo="$(new_repo basic)"

run_script "$repo" "$TOOLS" SCAN_MODE=bogus
expect_rc "an invalid SCAN_MODE is rejected" 1
expect_out "an invalid SCAN_MODE says what is allowed" 'SCAN_MODE must be "changed" or "full"'

empty="$WORK/empty"
mkdir -p "$empty"
git -C "$empty" init -q -b main
git -C "$empty" config user.email test@example.test
git -C "$empty" config user.name test
git -C "$empty" config commit.gpgsign false
git -C "$empty" commit -q --allow-empty -m empty
git -C "$empty" update-ref refs/remotes/upstream/main HEAD
run_script "$empty" "$TOOLS" SCAN_MODE=full
expect_rc "a full scan of a tree with no tracked files refuses to report clean" 1
expect_out "...and says so" "refusing to report a clean scan of nothing"

run_script "$repo" "$TOOLS" SCAN_MODE=full CI=true
expect_rc "under CI a missing gitleaks is an error, not a skip" 1
expect_out "...naming the tool" "gitleaks is not installed on this CI runner"

run_script "$repo" "$STUBS:$TOOLS" SCAN_MODE=full CI=true
expect_rc "under CI a missing trivy is an error, not a skip" 1
expect_out "...naming the tool" "trivy is not installed on this CI runner"

run_script "$repo" "$TOOLS" SCAN_MODE=full
expect_rc "outside CI a missing scanner still skips, for local runs" 0
expect_out "...and says SKIP" "SKIP: gitleaks is not installed."

# deletion-only change in changed mode: nothing to scan is a pass with a NOTE, never a SKIP and never a failure
del="$(new_repo deletion)"
git -C "$del" rm -q README.md
git -C "$del" -c user.email=t@t -c user.name=t commit -q -m "delete the only file"
run_script "$del" "$TOOLS" SCAN_MODE=changed CI=true
expect_rc "a deletion-only change passes in changed mode" 0
expect_out "...with a NOTE rather than a SKIP" "NOTE: no changed files to scan"

# staging: every tracked file is staged, including one whose name contains a newline (a newline-delimited
# list would split it into two names that do not exist and silently drop it from the scan)
stage="$(new_repo staging)"
nl_name=$'with\nnewline.txt'
printf 'x\n' > "$stage/$nl_name"
printf 'outside\n' > "$WORK/outside.txt"
ln -s "$WORK/outside.txt" "$stage/link-to-outside"
git -C "$stage" add -A
git -C "$stage" -c user.email=t@t -c user.name=t commit -q -m files
run_script "$stage" "$STUBS:$TOOLS" SCAN_MODE=full STUB_STAGED_LIST="$WORK/staged.list"
tracked_regular=2   # README.md and the newline-named file; the symlink must NOT be staged
staged_count="$(find "$stage/.security-reports/pr-files" -type f -print0 | tr -cd '\0' | wc -c | tr -d ' ')"
if [ "$staged_count" -eq "$tracked_regular" ]; then pass "a file name containing a newline is staged and scanned"; else fail "staged $staged_count files, expected $tracked_regular"; fi
if [ ! -e "$stage/.security-reports/pr-files/link-to-outside" ]; then pass "a tracked symlink is not followed into the staging directory"; else fail "a symlink was staged"; fi

# A high-similarity rename is status R, not M. Its new contents still need
# scanning, including when a secret was added during the rename.
renamed="$(new_repo renamed)"
for i in {1..100}; do printf 'ordinary setting %s\n' "$i"; done > "$renamed/config.txt"
git -C "$renamed" add config.txt
git -C "$renamed" -c user.email=t@t -c user.name=t commit -q -m config
git -C "$renamed" update-ref refs/remotes/upstream/main HEAD
git -C "$renamed" mv config.txt renamed-config.txt
printf 'api_key = "%s%s"\n' 'a9F3kLm7Qp2Wx8Vz4Nc6' 'Rt1Yu5Hs0De9Bj7Gi3Ko' >> "$renamed/renamed-config.txt"
git -C "$renamed" add -A
git -C "$renamed" -c user.email=t@t -c user.name=t commit -q -m rename
run_script "$renamed" "$STUBS:$TOOLS" SCAN_MODE=changed
expect_rc "a rename with edited contents is staged in changed mode" 0
if [ -f "$renamed/.security-reports/pr-files/renamed-config.txt" ]; then pass "the renamed file's new contents are scanned"; else fail "the renamed file escaped the scan"; fi

# ---------------------------------------------------------------- real scanners, end to end (skipped when absent)
real_gitleaks="$(command -v gitleaks 2>/dev/null || true)"
real_trivy="$(command -v trivy 2>/dev/null || true)"
if [ -n "$real_gitleaks" ] && [ -n "$real_trivy" ]; then
  REAL="$WORK/real"
  mkdir -p "$REAL"
  ln -s "$real_gitleaks" "$REAL/gitleaks"
  ln -s "$real_trivy" "$REAL/trivy"

  clean="$(new_repo realclean)"
  printf 'FROM ubuntu:24.04\nRUN useradd app\nUSER app\n' > "$clean/Dockerfile"
  git -C "$clean" add -A
  git -C "$clean" -c user.email=t@t -c user.name=t commit -q -m dockerfile
  run_script "$clean" "$REAL:$TOOLS" SCAN_MODE=full CI=true
  expect_rc "real scanners: a clean tree passes in full mode" 0

  vendor="$(new_repo realvendor)"
  for build in 2147284 2156652 2160922 2162777 2168446; do
    mkdir -p "$vendor/patches/experimental-tanks/$build"
    cp "$ROOT/patches/experimental-tanks/$build/Dockerfile" "$vendor/patches/experimental-tanks/$build/Dockerfile"
  done
  cp "$ROOT/.trivyignore-fs.yaml" "$vendor/.trivyignore-fs.yaml"
  git -C "$vendor" add -A
  git -C "$vendor" -c user.email=t@t -c user.name=t commit -q -m vendoroverlay
  run_script "$vendor" "$REAL:$TOOLS" SCAN_MODE=full CI=true
  expect_rc "real scanners: reviewed vendor overlays have scoped acceptances for all supported rebases" 0

  cp "$vendor/patches/experimental-tanks/2168446/Dockerfile" "$vendor/Dockerfile"
  git -C "$vendor" add Dockerfile
  git -C "$vendor" -c user.email=t@t -c user.name=t commit -q -m unrelatedoverlay
  run_script "$vendor" "$REAL:$TOOLS" SCAN_MODE=full CI=true
  expect_rc "real scanners: vendor acceptance does not hide the same finding at another path" 1
  expect_out "...and unrelated root startup still names the rule" "DS-0002"

  leak="$(new_repo reallleak)"
  printf 'api_key = "%s%s"\n' 'a9F3kLm7Qp2Wx8Vz4Nc6' 'Rt1Yu5Hs0De9Bj7Gi3Ko' > "$leak/config.txt"
  git -C "$leak" add -A
  git -C "$leak" -c user.email=t@t -c user.name=t commit -q -m secret
  run_script "$leak" "$REAL:$TOOLS" SCAN_MODE=full CI=true
  expect_rc "real scanners: a committed secret fails the job" 1
  expect_out "...and the failure says how to proceed" "allowlist it narrowly in .gitleaks.toml"

  root="$(new_repo realroot)"
  printf 'FROM ubuntu:24.04\nRUN echo hi\n' > "$root/Dockerfile"
  git -C "$root" add -A
  git -C "$root" -c user.email=t@t -c user.name=t commit -q -m rootdockerfile
  run_script "$root" "$REAL:$TOOLS" SCAN_MODE=full CI=true
  expect_rc "real scanners: a Dockerfile with no USER fails the job (trivy exits non-zero on findings)" 1
  expect_out "...and names the rule" "DS-0002"

  run_script "$renamed" "$REAL:$TOOLS" SCAN_MODE=changed CI=true
  expect_rc "real scanners: a secret added to a renamed file fails the job" 1
  expect_out "...the renamed file was checked rather than treated as an empty diff" "renamed-config.txt"
else
  printf 'skip real-scanner cases (gitleaks and trivy are not both installed here; the security-checks CI job covers them)\n'
fi

if [ "$FAILED" -ne 0 ]; then
  printf '\nsecurity-pr-checks tests FAILED\n' >&2
  exit 1
fi
printf '\nsecurity-pr-checks tests passed\n'
