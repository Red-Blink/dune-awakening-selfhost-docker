# Windows / WSL Security Regression Checklist

This checklist covers the Windows `install.ps1` helper and the Windows / WSL documentation. It is intended for maintainers reviewing changes that affect WSL setup, Docker installation, or Web UI exposure.

## Scope

| Area | Regression concern |
|---|---|
| `install.ps1` | Unsafe PowerShell execution, secret leakage, destructive filesystem changes, wrong repository bootstrap |
| WSL setup | Root-only operations limited to OS/package setup |
| Docker setup | Docker installed from official apt repository; no unreviewed shell piping in the Windows helper |
| README | Linux `install.sh` path remains intact; Windows path is additive |
| Documentation | Web UI exposure warnings, secret handling, firewall/port guidance |

## Static security checks

Run these from the repository root:

```bash
python3 - <<'PY'
from pathlib import Path
import re

checks = []

def add(name, ok, detail=''):
    checks.append((name, bool(ok), detail))

install = Path('install.ps1').read_text(encoding='utf-8')
readme = Path('README.md').read_text(encoding='utf-8')
guide = Path('docs/WINDOWS-WSL-INSTALL.md').read_text(encoding='utf-8')
quickstart = Path('docs/WINDOWS-WSL-QUICKSTART.md').read_text(encoding='utf-8')
admin = Path('docs/ADMIN-POWERSHELL.md').read_text(encoding='utf-8')

lower_install = install.lower()

add('install.ps1 exists', Path('install.ps1').is_file())
add('install.ps1 avoids dynamic-expression execution', 'invoke-expression' not in lower_install and re.search(r'\biex\b', lower_install) is None)
add('install.ps1 avoids direct remote-download-to-shell pattern', not re.search(r'(curl|irm|iwr|wget).{0,80}\|.{0,40}(bash|sh|pwsh|powershell)', lower_install, re.S))
add('install.ps1 keeps admin authentication enabled by default', 'admin_auth_disabled=1' not in lower_install)
add('install.ps1 does not embed Funcom token values', 'funcom-token' not in lower_install and 'funcom_token=' not in lower_install)
add('install.ps1 removes only temporary helper scripts', 'Remove-Item -LiteralPath $scriptPath -Force' in install)
add('install.ps1 calls wsl.exe with explicit distro flag arrays', '@("-d", $WslDistro' in install)
add('install.ps1 converts Windows temp paths to WSL /mnt paths', 'return "/mnt/$drive/$rest"' in install and "-replace '\\\\', '/'" in install)
add('install.ps1 writes temp shell scripts without UTF-8 BOM', 'Set-Content -LiteralPath $scriptPath -Value $ScriptText -Encoding ASCII -NoNewline' in install)
add('README preserves Linux install.sh path', './install.sh' in readme and 'Copy and paste this on a fresh Linux server' in readme)
add('README adds Windows WSL option', 'Windows 11 Home / WSL2 / Ubuntu 26.04' in readme)
add('README links Windows quickstart', 'WINDOWS-WSL-QUICKSTART.md' in readme)
add('README links Administrator PowerShell instructions', 'ADMIN-POWERSHELL.md' in readme)
add('Quickstart downloads install.ps1 directly', 'raw.githubusercontent.com/Red-Blink/dune-awakening-selfhost-docker/main/install.ps1' in quickstart)
add('Quickstart passes explicit repo URL and ref', '-RepoUrl' in quickstart and '-RepoRef' in quickstart)
add('Quickstart explains Administrator PowerShell launch steps', 'Run as administrator' in quickstart and 'Administrator:' in quickstart)
add('Quickstart warns not to nest powershell command wrapper', 'Do not wrap this command' in quickstart)
add('Admin doc explains Run as administrator', 'Run as administrator' in admin and 'Administrator:' in admin)
add('WSL guide warns not to expose Web UI publicly', 'Do not expose `8088`' in guide or 'Do not expose the Web UI' in guide)
add('WSL guide tells users not to commit secrets', 'Do not commit `.env`' in guide and 'runtime/secrets' in guide)
add('WSL guide documents Docker socket risk', '/var/run/docker.sock' in guide and 'privileged' in guide)
add('WSL guide documents required public ports', '`31982`' in guide and '`7777-7810`' in guide and '`8088`' in guide)

failed = [c for c in checks if not c[1]]
for name, ok, detail in checks:
    print(f"{'PASS' if ok else 'FAIL'} {name}{': ' + detail if detail else ''}")

if failed:
    raise SystemExit(1)
print(f"PASS security regression checks completed: {len(checks)} checks")
PY
```

Expected result: all checks pass.

## Manual review checks

- Confirm `install.ps1` is additive and does not replace or modify `install.sh`.
- Confirm Linux users can still use the original README Linux installer.
- Confirm Windows users can either use the direct `install.ps1` bootstrap command or run the helper from a trusted local checkout.
- Confirm the direct bootstrap downloads `install.ps1` and runs it as a file, not through a nested command string.
- Confirm WSL subprocess calls include `-d <distro>` and do not rely on PowerShell argument passthrough.
- Confirm Windows temporary script paths are converted to `/mnt/<drive>/...` paths before WSL execution.
- Confirm temporary shell scripts are written without a UTF-8 BOM so Bash reads the first command correctly.
- Confirm Windows documentation tells users how to launch Administrator PowerShell.
- Confirm the helper delegates to `install.sh` after preparing WSL and Docker.
- Confirm the helper does not store Windows, Ubuntu, Funcom, or Web UI passwords.
- Confirm public port guidance distinguishes game ports from the admin Web UI.
- Confirm documentation tells users to keep database and internal admin ports private.
- Confirm the Web UI remains protected by the generated admin password unless the user explicitly changes configuration.

## Runtime smoke checks

On a Windows 11 Home host with virtualization enabled:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
.\install.ps1 -NoStart
```

Then inside Ubuntu:

```bash
docker version
docker compose version
cd ~/dune-awakening-selfhost-docker
chmod +x install.sh
./install.sh
```

Expected result:

- WSL2 is available.
- Ubuntu 26.04 starts.
- `systemd` is enabled.
- Docker Engine starts inside Ubuntu.
- Docker Compose plugin is available.
- Repository is present inside Ubuntu.
- `install.sh` starts the Web UI and prints the generated admin password.
