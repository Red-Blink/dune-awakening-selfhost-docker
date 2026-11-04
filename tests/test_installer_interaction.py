"""Exercise installer prompts without installing packages or touching Docker."""

import errno
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import tarfile
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]


class InstallerInteractionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.project = self.work / "release" / "project-v9.8.7"
        self.project.mkdir(parents=True)
        helpers = self.project / "runtime" / "scripts"
        helpers.mkdir(parents=True)
        (helpers / "compose-project.sh").write_text(":\n")
        # Load the real functions, stopping before the host installation steps.
        source = (ROOT / "install.sh").read_text()
        functions = source.split('say "Starting Dune Docker Console Installer."', 1)[0]
        functions = functions.replace("\nreject_root_install\n", "\n")
        fixture = functions + '''
getent() { printf '%s\\n' 'docker:x:999:'; }
id() { printf '%s\\n' 'installer-test sudo'; }
usermod() { :; }
need_sudo() { printf '%s\\n' "$*" >> "$FIXTURE_GROUP_CALLS"; }
port_in_use() { [ "$1" = "${FIXTURE_OCCUPIED_PORT:-}" ]; }
existing_console_uses_port() { [ "$1" = "${FIXTURE_EXISTING_PORT:-}" ]; }
USER=installer-test
DOCKER_NEEDS_SUDO="${FIXTURE_DOCKER_NEEDS_SUDO:-1}"
ensure_docker_group_access
choose_web_port
printf '%s\\n' "$WEB_PORT" > "$FIXTURE_SELECTED_PORT"
'''
        (self.project / "install.sh").write_text(fixture)
        (self.project / "install.sh").chmod(0o755)
        self.bin = self.work / "bin"
        self.bin.mkdir()
        self.write_executable("id", "#!/bin/sh\nprintf '1000\\n'\n")
        self.write_executable("uname", "#!/bin/sh\nprintf 'Linux\\n'\n")
        self.write_executable("curl", '''#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then output="$2"; shift 2; else shift; fi
done
if [ -n "$output" ]; then
  cp "$FIXTURE_ARCHIVE" "$output"
else
  printf '%s\\n' '{"tag_name":"v9.8.7"}'
fi
''')
        self.env = {
            "HOME": str(self.work),
            "PATH": str(self.bin) + os.pathsep + os.defpath,
            "USER": "installer-test",
            "DUNE_INSTALL_DIR": str(self.work / "installed"),
            "FIXTURE_ARCHIVE": str(self.work / "release.tar.gz"),
            "FIXTURE_BOOTSTRAP": str(ROOT / "bootstrap.sh"),
            "FIXTURE_INSTALLER": str(self.project / "install.sh"),
            "FIXTURE_SELECTED_PORT": str(self.work / "selected-port"),
            "FIXTURE_GROUP_CALLS": str(self.work / "group-calls"),
        }

    def write_executable(self, name, text):
        path = self.bin / name
        path.write_text(text)
        path.chmod(0o755)

    def prepare_archive(self):
        with tarfile.open(self.env["FIXTURE_ARCHIVE"], "w:gz") as archive:
            archive.add(self.project, arcname=self.project.name)

    def selected_port(self):
        return Path(self.env["FIXTURE_SELECTED_PORT"]).read_text().strip()

    def run_unattended(self):
        self.prepare_archive()
        # setsid removes any controlling terminal inherited from the test runner.
        result = subprocess.run(
            ["/bin/sh", self.env["FIXTURE_BOOTSTRAP"]],
            env=self.env, stdin=subprocess.DEVNULL, capture_output=True,
            text=True, start_new_session=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def run_terminal(self, answers, piped=True):
        self.prepare_archive()
        pid, fd = pty.fork()
        if pid == 0:
            command = ('cat "$FIXTURE_BOOTSTRAP" | /bin/sh' if piped
                       else '/bin/sh "$FIXTURE_INSTALLER"')
            os.execve("/bin/sh", ["sh", "-c", command], self.env)
        output = bytearray()
        sent = False
        status = None
        finished = 0
        deadline = time.monotonic() + 10
        try:
            while time.monotonic() < deadline:
                if select.select([fd], [], [], 0.05)[0]:
                    try:
                        chunk = os.read(fd, 65536)
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        chunk = b""
                    output.extend(chunk)
                    if not sent and b"Enter the Web UI port" in output:
                        os.write(fd, answers.encode())
                        sent = True
                finished, status = os.waitpid(pid, os.WNOHANG)
                if finished:
                    break
            else:
                self.fail("Installer hung: " + output.decode(errors="replace"))
        finally:
            if status is None or not finished:
                os.killpg(pid, signal.SIGKILL)
                os.waitpid(pid, 0)
            os.close(fd)
        self.assertTrue(os.WIFEXITED(status), output.decode(errors="replace"))
        self.assertEqual(os.WEXITSTATUS(status), 0, output.decode(errors="replace"))
        return output.decode()

    def test_piped_bootstrap_prompts_and_uses_custom_port(self):
        output = self.run_terminal("8099\n")
        self.assertIn("Enter the Web UI port", output)
        self.assertEqual(self.selected_port(), "8099")
        self.assertIn("ADMIN_BIND_PORT=8099", (self.work / "installed" / ".env").read_text())

    def test_piped_bootstrap_accepts_default(self):
        output = self.run_terminal("\n")
        self.assertIn("Enter the Web UI port", output)
        self.assertEqual(self.selected_port(), "8088")

    def test_interactive_invalid_and_busy_ports_can_be_corrected(self):
        self.env["FIXTURE_OCCUPIED_PORT"] = "8090"
        output = self.run_terminal("invalid\n8090\n8091\n")
        self.assertIn("Enter a number between 1 and 65535.", output)
        self.assertIn("Port 8090 is already in use. Choose another port.", output)
        self.assertEqual(self.selected_port(), "8091")

    def test_direct_installer_still_prompts(self):
        output = self.run_terminal("8098\n", piped=False)
        self.assertIn("Enter the Web UI port", output)
        self.assertEqual(self.selected_port(), "8098")

    def test_unattended_install_uses_next_free_port(self):
        self.env["FIXTURE_OCCUPIED_PORT"] = "8088"
        output = self.run_unattended()
        self.assertNotIn("Enter the Web UI port", output)
        self.assertEqual(self.selected_port(), "8089")

    def test_explicit_port_stays_noninteractive_with_terminal(self):
        self.env["ADMIN_BIND_PORT"] = "9090"
        output = self.run_terminal("")
        self.assertNotIn("Enter the Web UI port", output)
        self.assertEqual(self.selected_port(), "9090")

    def test_existing_console_port_is_preserved(self):
        (self.project / ".env").write_text("ADMIN_BIND_PORT=8095\n")
        self.env["FIXTURE_EXISTING_PORT"] = "8095"
        output = self.run_terminal("")
        self.assertIn("Reusing Web UI port 8095", output)
        self.assertNotIn("Enter the Web UI port", output)
        self.assertEqual(self.selected_port(), "8095")

    def test_group_message_explains_session_and_sudo(self):
        output = self.run_unattended()
        self.assertIn("Your current login session has not changed.", output)
        self.assertIn("The installer will continue using sudo for Docker commands.", output)
        self.assertIn("After setup, log out and back in", output)
        self.assertEqual(Path(self.env["FIXTURE_GROUP_CALLS"]).read_text().strip(),
                         "usermod -aG docker installer-test")

    def test_group_message_does_not_claim_sudo_when_not_used(self):
        self.env["FIXTURE_DOCKER_NEEDS_SUDO"] = "0"
        output = self.run_unattended()
        self.assertIn("Your current login session has not changed.", output)
        self.assertNotIn("continue using sudo", output)


if __name__ == "__main__":
    unittest.main()
