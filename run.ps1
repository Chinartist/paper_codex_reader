$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$python = "python"
if (Get-Command py -ErrorAction SilentlyContinue) {
  $python = "py -3"
}

if (-not (Test-Path ".venv\Scripts\python.exe")) {
  Invoke-Expression "$python -m venv .venv"
}

& ".venv\Scripts\Activate.ps1"
python -m pip install --upgrade pip | Out-Null
python -m pip install -r requirements.txt
python app.py --open @args
