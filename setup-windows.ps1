$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

function Invoke-ProjectPython {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  if (Test-Path ".venv\Scripts\python.exe") {
    & ".venv\Scripts\python.exe" @Arguments
    return
  }
  if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 @Arguments
    return
  }
  if (Get-Command python -ErrorAction SilentlyContinue) {
    & python @Arguments
    return
  }
  throw "Python 3.10+ was not found. Install Python, then run this script again."
}

function Test-CodexCommand {
  param([string]$Path)

  if (-not $Path) {
    return $false
  }
  try {
    $version = & $Path --version 2>&1
    if ($LASTEXITCODE -eq 0) {
      Write-Host "Codex CLI OK: $Path"
      Write-Host "  $version"
      return $true
    }
    Write-Warning "Codex command failed: $Path"
    Write-Warning "$version"
  } catch {
    Write-Warning "Codex command is not runnable: $Path"
    Write-Warning $_.Exception.Message
  }
  return $false
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  Invoke-ProjectPython @("-m", "venv", ".venv")
}

& ".venv\Scripts\python.exe" -m pip install --upgrade pip
& ".venv\Scripts\python.exe" -m pip install -r requirements.txt

$codexCandidates = @($env:PAPER_CODEX_READER_CODEX)
foreach ($name in @("codex.cmd", "codex.bat", "codex.exe", "codex")) {
  $codexCandidates += Get-Command $name -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }
}
if ($env:APPDATA) {
  $codexCandidates += Join-Path $env:APPDATA "npm\codex.cmd"
}
if ($env:LOCALAPPDATA) {
  $codexCandidates += Join-Path $env:LOCALAPPDATA "pnpm\codex.cmd"
}

$codexOk = $false
foreach ($candidate in $codexCandidates | Where-Object { $_ } | Select-Object -Unique) {
  if (Test-Path $candidate) {
    if (Test-CodexCommand $candidate) {
      $codexOk = $true
      break
    }
  }
}

if (-not $codexOk) {
  Write-Warning "No runnable Codex CLI was found."
  Write-Warning "If Windows finds a Codex path under WindowsApps but login fails with Access is denied, install the npm CLI:"
  Write-Warning "  npm install -g @openai/codex"
  Write-Warning "Then run:"
  Write-Warning "  codex login"
  Write-Warning "You can also set PAPER_CODEX_READER_CODEX to a working codex.cmd path before starting this app."
}

& ".venv\Scripts\python.exe" app.py --open @args
