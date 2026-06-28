# Windows / WSL Quick Install

This command must be run from an **Administrative PowerShell** window.

To open PowerShell as Administrator:

1. Press the **Windows** key.
2. Type `PowerShell`.
3. Right-click **Windows PowerShell**.
4. Select **Run as administrator**.
5. Click **Yes** on the Windows security prompt.
6. Confirm the window title starts with **Administrator:**.

Paste this command into that Administrator PowerShell window:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force; $ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $root=Join-Path $env:USERPROFILE 'dune-awakening-selfhost-docker'; New-Item -ItemType Directory -Force -Path $root | Out-Null; Set-Location $root; $latest=(Invoke-WebRequest -UseBasicParsing -Method Head -Uri 'https://github.com/Red-Blink/dune-awakening-selfhost-docker/releases/latest').BaseResponse.ResponseUri.AbsoluteUri; $version=Split-Path -Leaf $latest; $zip=Join-Path $root 'dune-awakening-selfhost-docker.zip'; $extract=Join-Path $root 'release'; Remove-Item -Recurse -Force -LiteralPath $extract -ErrorAction SilentlyContinue; Invoke-WebRequest -UseBasicParsing -Uri ('https://github.com/Red-Blink/dune-awakening-selfhost-docker/archive/refs/tags/' + $version + '.zip') -OutFile $zip; Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force; $repo=(Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1).FullName; Set-Location $repo; powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Do not wrap this command in another `powershell -Command "..."` call. It is meant to be pasted directly into an already-open Administrator PowerShell window.

This command:

1. Creates `%USERPROFILE%\dune-awakening-selfhost-docker`.
2. Resolves the latest GitHub release.
3. Downloads the release ZIP.
4. Extracts the release.
5. Runs `install.ps1` from the extracted release.

The PowerShell helper then prepares WSL2, Ubuntu 26.04, Docker Engine inside Ubuntu, and delegates final server startup to the existing Linux `install.sh`.

For the full guide, see [WINDOWS-WSL-INSTALL.md](WINDOWS-WSL-INSTALL.md).
