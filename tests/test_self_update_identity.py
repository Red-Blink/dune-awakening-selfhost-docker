"""Run the real self-update identity functions in a simulated helper namespace."""
from pathlib import Path
import os
import io
import subprocess
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SOURCE = (ROOT / "runtime/scripts/self-update.sh").read_text()


def function(name):
    start = SOURCE.index(name + "() {")
    end = SOURCE.index("\n}\n", start) + 3
    return SOURCE[start:end]


class SelfUpdateIdentityTests(unittest.TestCase):
    def resolve_identity(self, incoming=("", ""), saved=("", ""), owner=("1000", "1001")):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".env").write_text("".join(f"{key}={value}\n" for key, value in zip(("DUNE_HOST_UID", "DUNE_HOST_GID"), saved) if value != ""))
            script = "\n".join(function(name) for name in ("read_env_file_value", "host_repo_owner_id", "normalize_host_owner_env"))
            script += """
stat() {
  [ "$3" = "$ROOT_DIR" ] || return 1
  case "$2" in %u) echo "$FIXTURE_OWNER_UID";; %g) echo "$FIXTURE_OWNER_GID";; esac
}
id() { echo 0; }
normalize_host_owner_env
printf '%s:%s\\n' "$DUNE_HOST_UID" "$DUNE_HOST_GID"
"""
            result = subprocess.run(["bash", "-euc", script], cwd=root, capture_output=True, text=True,
                                    env={**os.environ, "ROOT_DIR": directory, "HOST_ROOT_DIR": "/host-only/missing-checkout",
                                         "DUNE_HOST_UID": incoming[0], "DUNE_HOST_GID": incoming[1],
                                         "FIXTURE_OWNER_UID": owner[0], "FIXTURE_OWNER_GID": owner[1]})
            self.assertEqual(result.returncode, 0, result.stderr)
            return result.stdout.strip()

    def test_helper_uses_visible_checkout_owner(self):
        self.assertEqual(self.resolve_identity(incoming=("0", "0")), "1000:1001")

    def test_inherited_root_cannot_replace_persisted_identity(self):
        self.assertEqual(self.resolve_identity(incoming=("0", "0"), saved=("1000", "1001"), owner=("0", "0")), "1000:1001")

    def test_persisted_identity_survives_changed_archive_directory_group(self):
        self.assertEqual(self.resolve_identity(incoming=("0", "0"), saved=("1000", "1001"), owner=("1000", "1000")), "1000:1001")

    def test_corrupt_zero_settings_fall_back_to_visible_owner(self):
        self.assertEqual(self.resolve_identity(incoming=("0", "0"), saved=("0", "0")), "1000:1001")

    def test_explicit_nonroot_identity_is_preserved(self):
        self.assertEqual(self.resolve_identity(incoming=("12345", "12346"), saved=("1000", "1001")), "12345:12346")

    def test_explicit_nonroot_user_can_intentionally_use_root_group(self):
        self.assertEqual(self.resolve_identity(incoming=("12345", "0"), saved=("1000", "1001")), "12345:0")

    def test_saved_nonroot_user_can_intentionally_use_root_group(self):
        self.assertEqual(self.resolve_identity(incoming=("0", "0"), saved=("1000", "0"), owner=("0", "0")), "1000:0")

    def test_true_root_install_remains_root(self):
        self.assertEqual(self.resolve_identity(incoming=("0", "0"), saved=("0", "0"), owner=("0", "0")), "0:0")

    def test_no_settings_uses_visible_owner(self):
        self.assertEqual(self.resolve_identity(), "1000:1001")

    @unittest.skipUnless(os.geteuid() == 0, "Privilege transition requires root; also run in isolated root fixture")
    def test_root_automatic_update_creates_files_as_installation_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o755)
            os.chown(root, 65534, 65534)
            script_path = root / "runtime/scripts/self-update.sh"
            script_path.parent.mkdir(parents=True)
            script_path.write_text('id -u > "$ROOT_DIR/uid"\nid -g > "$ROOT_DIR/gid"\nprintf "%s\\n" "$@" > "$ROOT_DIR/args"\n')
            code = 'normalize_host_owner_env() { export DUNE_HOST_UID=65534 DUNE_HOST_GID=65534; }\n'
            code += function("run_update_as_host_owner") + '\nrun_update_as_host_owner install v9.9.9\nexit 99\n'
            result = subprocess.run(["bash", "-euc", code], cwd=root, capture_output=True, text=True,
                                    env={**os.environ, "ROOT_DIR": directory})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((root / "uid").read_text().strip(), "65534")
            self.assertEqual((root / "gid").read_text().strip(), "65534")
            self.assertEqual((root / "args").read_text(), "install\nv9.9.9\n")
            self.assertEqual((root / "uid").stat().st_uid, 65534)

    def test_update_entry_points_resolve_owner_before_any_update_writes(self):
        for command in ("install|apply", "install-qa", "rebuild-web-console"):
            branch = SOURCE.split(f"  {command})\n", 1)[1]
            self.assertTrue(branch.lstrip().startswith('run_update_as_host_owner "$@"'))

    def test_release_and_qa_archives_preserve_resolved_owner_including_root(self):
        for name in ("install_release_tag_from_archive", "install_qa_commit"):
            body = function(name)
            tar_command = next(line.strip() for line in body.splitlines() if "tar --owner=" in line)
            with tempfile.TemporaryDirectory() as directory:
                (Path(directory) / "VERSION").write_text("fixture\n")
                for uid, gid in (("0", "0"), ("1000", "1001"), ("1000", "0")):
                    archive = subprocess.run(["bash", "-euc", tar_command], cwd=directory,
                                             env={**os.environ, "DUNE_HOST_UID": uid, "DUNE_HOST_GID": gid},
                                             check=True, capture_output=True).stdout
                    with tarfile.open(fileobj=io.BytesIO(archive)) as handle:
                        self.assertTrue(all((member.uid, member.gid) == (int(uid), int(gid)) for member in handle))


if __name__ == "__main__":
    unittest.main()
