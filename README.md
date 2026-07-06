# Paper Codex Reader

[简体中文](README.zh-CN.md)

Paper Codex Reader is a local PDF reader with a Codex-powered chat panel. It is designed for reading papers, sending selected passages into a Codex conversation, and keeping paper-specific reading sessions organized locally.

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

## Supported Features

### Paper Library

- Import papers from local PDF paths, uploaded files, or direct PDF links.
- Search and sort papers in the paper library.
- Rename a paper display title without changing the source PDF file.
- Keep paper metadata, extracted text, conversations, and settings in the local data directory.

### PDF Reader

- Render PDFs in the browser with selectable text.
- Select one or more text passages and add them to the current conversation with the floating check button.
- Zoom in, zoom out, fit to width, or return to 100%.
- Preserve the reading position when zooming or resizing panels.
- Lazy-render visible pages so large PDFs stay responsive.
- Collapse or expand the left paper/conversation sidebar and the right chat sidebar.
- Resize the right chat sidebar horizontally.

### Codex Chat

- Use the local Codex CLI instead of an API key.
- Start Codex login, log out of Codex, and view the detected login/status inside the app.
- Show recent Codex local usage and rate-limit windows in a compact hover card when local telemetry is available.
- Choose Codex model, custom model, reasoning effort, verbosity, chunk size, and timeout.
- Start a new conversation or continue a historical conversation.
- Ask questions directly, with or without selected PDF passages.
- Use `读全文` to send the current PDF text to Codex in chunks and let the same conversation read the whole paper.
- For selected passages, the default prompt asks Codex to translate first and then analyze briefly.
- Add multiple selected passages to one message before sending.

### Conversations And Tasks

- Create, read, rename, delete, and switch conversations.
- Conversations are grouped under papers for easier navigation, while each conversation keeps its own Codex session id.
- Reorder conversation folders and conversations in the left sidebar by dragging them.
- Different conversations can run tasks in parallel.
- Tasks inside the same conversation stay ordered.
- Queue multiple sends in the same conversation and reorder queued tasks by dragging them in the task panel.
- View queued/running tasks and cancel tasks from the task panel.

### Prompt Templates

- Use the prompt dock beside the composer for reusable prompts.
- Built-in prompts include `总结当前论文` and `给我阅读路线`.
- Add, edit, delete, and reuse your own prompt templates.

## Keyboard Shortcuts

Global shortcuts are ignored while typing in an input, textarea, select, or editable field.

| Shortcut | Action |
| --- | --- |
| `Enter` in the chat box | Send the current message |
| `Shift+Enter` in the chat box | Insert a new line |
| `Cmd/Ctrl + +` or `Cmd/Ctrl + =` | Zoom in |
| `Cmd/Ctrl + -` | Zoom out |
| `Cmd/Ctrl + 0` | Set PDF zoom to 100% |
| `F` | Fit PDF to width |
| `Space` | Scroll the PDF reader down |
| `Shift+Space` | Scroll the PDF reader up |
| `PageDown` | Scroll the PDF reader down |
| `PageUp` | Scroll the PDF reader up |
| `Enter` in rename dialogs | Save the new paper or conversation name |
| `Alt+Up/Down` on a conversation folder | Move that folder earlier or later |
| `Alt+Up/Down` on a conversation | Move that conversation earlier or later inside its folder |
| `Alt+Up/Down` on a queued task | Move that queued task earlier or later |
| `Left/Right Arrow` on the chat resizer | Resize the right chat panel |
| `Shift+Left/Right Arrow` on the chat resizer | Resize the right chat panel faster |
| `Home` on the chat resizer | Set the right chat panel to minimum width |
| `End` on the chat resizer | Set the right chat panel to maximum width |

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
