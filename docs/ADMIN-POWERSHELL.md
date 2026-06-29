# Open PowerShell as Administrator

The Windows / WSL installer must be run from an **Administrative PowerShell** window.

## Windows 11 steps

1. Press the **Windows** key.
2. Type `PowerShell`.
3. Right-click **Windows PowerShell**.
4. Select **Run as administrator**.
5. Click **Yes** on the Windows security prompt.
6. Confirm the PowerShell window title starts with **Administrator:**.

## Why this is required

The installer may need administrative rights to:

- install or enable WSL components;
- restart WSL;
- configure Ubuntu for `systemd`;
- prepare Docker and networking prerequisites.

After PowerShell opens with Administrator rights, follow the command in [WINDOWS-WSL-QUICKSTART.md](WINDOWS-WSL-QUICKSTART.md).
