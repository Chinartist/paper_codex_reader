# Windows Setup Notes

Paper Codex Reader runs on Windows, but Codex CLI discovery can be different
from macOS and Linux.

## Quick Start

```powershell
cd paper_codex_reader
.\setup-windows.ps1
```

The setup script creates the Python virtual environment, installs `pypdf`,
checks whether a runnable Codex CLI is available, and starts the app.

The normal scripts still work:

```powershell
.\run.ps1
```

```bat
run.bat
```

## Codex CLI Access Denied

On some Windows installs, `where codex` or Python's path discovery can find a
Codex executable inside a Windows app package path such as:

```text
C:\Program Files\WindowsApps\OpenAI.Codex_...\codex.exe
```

That file can exist while still failing when launched by this local Python
server:

```text
Access is denied
```

The app now verifies Codex candidates by running `codex --version` instead of
only checking that the file exists. If the WindowsApps path is blocked, install
or expose a runnable CLI and point the app to it.

## Install A Runnable CLI

If you use Node.js:

```powershell
npm install -g @openai/codex
codex login
codex login status
```

If the app still cannot find the CLI, set an explicit path before launching:

```powershell
$env:PAPER_CODEX_READER_CODEX="$env:APPDATA\npm\codex.cmd"
.\run.ps1
```

You can also paste the working `codex.cmd` path into the app's Codex path
setting.

## Diagnostics

Useful commands:

```powershell
where.exe codex
codex --version
codex login status
```

If `codex --version` fails for the path that Windows reports, that path is not
usable by Paper Codex Reader. Use a different CLI path or set
`PAPER_CODEX_READER_CODEX`.
