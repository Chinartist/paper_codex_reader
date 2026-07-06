# Paper Codex Reader

Paper Codex Reader is a local PDF reader with a Codex-powered chat panel.

It uses the local Codex CLI, so it can use your ChatGPT/Codex membership quota instead of an API key.

## Supported Systems

- macOS
- Windows
- Linux

You need:

- Python 3.10+
- Codex CLI installed and logged in
- A modern browser

Check Codex login:

```bash
codex login
codex login status
```

On Windows, make sure `codex`, `codex.cmd`, or `codex.exe` works in PowerShell/CMD. If it does not, open the app settings and set the full Codex CLI path.

## Run On macOS / Linux

```bash
cd paper_codex_reader
./run.sh
```

## Run On Windows

In PowerShell:

```powershell
cd paper_codex_reader
.\run.ps1
```

Or in CMD:

```bat
cd paper_codex_reader
run.bat
```

The app opens:

```text
http://127.0.0.1:8765
```

The first run creates a virtual environment and installs `pypdf`.

## Data Directory

If `PAPER_CODEX_READER_HOME` is set, that directory is used.

Otherwise the app uses:

- Existing legacy data: `~/.paper_codex_reader`
- macOS new installs: `~/Library/Application Support/PaperCodexReader`
- Windows new installs: `%LOCALAPPDATA%\PaperCodexReader`
- Linux new installs: `$XDG_DATA_HOME/paper-codex-reader` or `~/.local/share/paper-codex-reader`

Override it:

macOS/Linux:

```bash
PAPER_CODEX_READER_HOME=/path/to/data ./run.sh
```

Windows PowerShell:

```powershell
$env:PAPER_CODEX_READER_HOME="D:\PaperCodexReaderData"
.\run.ps1
```

## Import Papers

You can import:

- A local PDF path
- A direct PDF URL
- A PDF file selected from the file picker

Supported local path examples:

```text
/Users/me/Documents/paper.pdf
C:\Users\me\Documents\paper.pdf
"C:\Users\me\Documents\paper with spaces.pdf"
file:///C:/Users/me/Documents/paper.pdf
```

## Features

- Import papers from local PDF paths, uploads, or direct PDF links.
- Render PDFs with selectable text.
- Save local conversations and message history in SQLite.
- Configure Codex CLI path, model, reasoning effort, verbosity, chunk size, and timeout.
- Initialize a conversation by sending the current PDF text to Codex in chunks.
- Send normal questions or selected-text prompts to the same conversation.
- Run different conversations in parallel while keeping each conversation ordered.

## Packaging Notes

The app is intentionally built without Node.js. A packaged desktop app can wrap this Python server with Tauri, Electron, Briefcase, PyInstaller, or a small native launcher.

For a portable folder distribution, include:

- `app.py`
- `static/`
- `requirements.txt`
- `run.sh`
- `run.bat`
- `run.ps1`

Users still need Python 3 and Codex CLI installed unless the package bundles Python.
