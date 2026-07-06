# Paper Codex Reader

[English](README.md)

Paper Codex Reader 是一个本地论文 PDF 阅读器，右侧集成 Codex 对话面板。它适合用来阅读论文、把选中的段落加入 Codex 对话、管理不同论文下的阅读会话。

它调用的是本机 Codex CLI，所以可以使用你的 ChatGPT/Codex 会员额度，不需要单独配置 API Key。

## 支持系统

- macOS
- Windows
- Linux

你需要准备：

- Python 3.10+
- 已安装并且能正常使用的 Codex
- 现代浏览器

## macOS / Linux 启动

```bash
cd paper_codex_reader
./run.sh
```

## Windows 启动

PowerShell：

```powershell
cd paper_codex_reader
.\run.ps1
```

CMD：

```bat
cd paper_codex_reader
run.bat
```

应用会打开：

```text
http://127.0.0.1:8765
```

第一次启动会创建虚拟环境并安装 `pypdf`。

## 数据目录

如果设置了 `PAPER_CODEX_READER_HOME`，应用会使用这个目录。

否则默认使用：

- 已存在的旧数据：`~/.paper_codex_reader`
- macOS 新安装：`~/Library/Application Support/PaperCodexReader`
- Windows 新安装：`%LOCALAPPDATA%\PaperCodexReader`
- Linux 新安装：`$XDG_DATA_HOME/paper-codex-reader` 或 `~/.local/share/paper-codex-reader`

自定义数据目录：

macOS/Linux：

```bash
PAPER_CODEX_READER_HOME=/path/to/data ./run.sh
```

Windows PowerShell：

```powershell
$env:PAPER_CODEX_READER_HOME="D:\PaperCodexReaderData"
.\run.ps1
```

## 导入论文

支持导入：

- 本地 PDF 路径
- 直接 PDF 链接
- 文件选择器选择的 PDF 文件

本地路径示例：

```text
/Users/me/Documents/paper.pdf
C:\Users\me\Documents\paper.pdf
"C:\Users\me\Documents\paper with spaces.pdf"
file:///C:/Users/me/Documents/paper.pdf
```

## 支持功能

### 论文库

- 从本地 PDF 路径、上传文件或直接 PDF 链接导入论文。
- 在论文库里搜索和排序论文。
- 修改论文显示名称，不改变原始 PDF 文件名。
- 将论文元数据、提取文本、会话和设置保存在本地数据目录。

### PDF 阅读器

- 在浏览器中渲染 PDF，并支持文本选择。
- 选中一段或多段文本后，用浮动对勾按钮加入当前对话。
- 支持放大、缩小、适合宽度、恢复 100%。
- 缩放或调整面板时尽量保持当前阅读位置。
- 对可见页面进行懒加载渲染，大 PDF 阅读更流畅。
- 左侧论文/会话栏和右侧聊天栏都可以收起或展开。
- 右侧聊天栏可以横向拖拽调整宽度。

### Codex 对话

- 通过本地 Codex CLI 调用 Codex，不需要 API Key。
- 支持在应用内发起 Codex 登录、退出 Codex 账号，并显示检测到的登录/状态。
- 当本地 Codex telemetry 可用时，用一个紧凑的悬浮卡显示最近用量和限额窗口。
- 可选择 Codex 模型、自定义模型、推理级别、详细程度、分块大小和超时时间。
- 可以新建对话，也可以继续历史对话。
- 可以直接提问，也可以带着 PDF 选区一起提问。
- 点击 `读全文` 会把当前 PDF 文本分块发送给 Codex，让同一个对话读完整篇论文。
- 对选中文本的默认提示词是先翻译，再做简短分析。
- 一次消息可以加入多个选区。

### 会话和任务

- 支持会话的新建、查看、改名、删除和切换。
- 会话按论文分组展示，便于管理；每个会话仍保留自己的 Codex session id。
- 左侧栏里的会话文件夹和会话都可以拖动调整顺序。
- 不同会话的任务可以并行运行。
- 同一个会话内的任务会按顺序执行。
- 同一个会话可以连续发送多个问题进入队列，并在任务面板里拖动调整排队任务顺序。
- 可以查看排队/运行中的任务，并在任务面板中取消任务。

### Prompt 模板

- 输入框旁边有 Prompt 模板面板，方便复用常用提问。
- 内置 `总结当前论文` 和 `给我阅读路线`。
- 支持新增、编辑、删除和复用自己的 Prompt 模板。

## 快捷键

当光标正在输入框、文本框、下拉框或可编辑区域内时，全局快捷键不会触发。

| 快捷键 | 功能 |
| --- | --- |
| 聊天框内 `Enter` | 发送当前消息 |
| 聊天框内 `Shift+Enter` | 换行 |
| `Cmd/Ctrl + +` 或 `Cmd/Ctrl + =` | 放大 PDF |
| `Cmd/Ctrl + -` | 缩小 PDF |
| `Cmd/Ctrl + 0` | PDF 缩放恢复到 100% |
| `F` | PDF 适合宽度 |
| `Space` | PDF 阅读器向下滚动 |
| `Shift+Space` | PDF 阅读器向上滚动 |
| `PageDown` | PDF 阅读器向下滚动 |
| `PageUp` | PDF 阅读器向上滚动 |
| 改名弹窗内 `Enter` | 保存新的论文名或会话名 |
| 聚焦会话文件夹时 `Alt+Up/Down` | 将该文件夹前移或后移 |
| 聚焦会话时 `Alt+Up/Down` | 将该会话在当前文件夹内前移或后移 |
| 聚焦排队任务时 `Alt+Up/Down` | 将该排队任务前移或后移 |
| 聚焦右侧栏拖拽条时 `Left/Right Arrow` | 调整右侧聊天栏宽度 |
| 聚焦右侧栏拖拽条时 `Shift+Left/Right Arrow` | 更快调整右侧聊天栏宽度 |
| 聚焦右侧栏拖拽条时 `Home` | 右侧聊天栏设为最小宽度 |
| 聚焦右侧栏拖拽条时 `End` | 右侧聊天栏设为最大宽度 |

## 打包说明

这个应用刻意没有引入 Node.js。桌面打包可以用 Tauri、Electron、Briefcase、PyInstaller，或者写一个很小的原生启动器来包住这个 Python 服务。

如果只是做便携文件夹分发，需要包含：

- `app.py`
- `static/`
- `requirements.txt`
- `run.sh`
- `run.bat`
- `run.ps1`

除非打包时内置 Python，否则用户电脑上仍然需要安装 Python 3 和 Codex CLI。
