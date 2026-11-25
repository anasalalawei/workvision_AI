# WorkVision AI - automatic Windows environment setup and launcher
# Run from PowerShell: powershell -ExecutionPolicy Bypass -File .\Start_WorkVision_AI.ps1

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
$VenvDir = Join-Path $ProjectRoot '.venv_workvision'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$Requirements = Join-Path $ProjectRoot 'requirements.txt'
$StaticIndex = Join-Path $ProjectRoot 'static\index.html'
$ModelsDir = Join-Path $ProjectRoot 'models'
$StdoutLog = Join-Path $ProjectRoot 'workvision_server.log'
$StderrLog = Join-Path $ProjectRoot 'workvision_server_error.log'
$PidFile = Join-Path $ProjectRoot 'workvision_server.pid'
$Port = 8000
$BaseUrl = "http://127.0.0.1:$Port"

function Write-Step([string]$Message) { Write-Host "`n[WorkVision AI] $Message" -ForegroundColor Cyan }
function Fail([string]$Message) { Write-Host "`nERROR: $Message" -ForegroundColor Red; exit 1 }

try {
    Set-Location $ProjectRoot
    Write-Host '============================================' -ForegroundColor DarkCyan
    Write-Host '       WorkVision AI - Setup & Run' -ForegroundColor Cyan
    Write-Host '============================================' -ForegroundColor DarkCyan
    Write-Host "Project: $ProjectRoot"

    # Remove Python environment overrides that can make Python 3.11 load a 3.13 DLL.
    Write-Step 'Clearing conflicting Python environment variables for this session...'
    foreach ($name in @('PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP')) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }

    # Verify the project layout before installing anything.
    Write-Step 'Checking project files...'
    if (-not (Test-Path $Requirements)) { Fail 'requirements.txt is missing. Put this script beside app.py and requirements.txt.' }
    if (-not (Test-Path (Join-Path $ProjectRoot 'app.py'))) { Fail 'app.py is missing. Run this script from the WorkVision_AI project folder.' }
    if (-not (Test-Path $StaticIndex)) { Fail 'static\index.html is missing. The expected folder is static beside app.py.' }
    if (-not (Test-Path $ModelsDir)) { Fail 'models folder is missing.' }

    $modelFiles = @(
        'hazard_detector_yolo11n_classaware.pt',
        'ppe_detector_yolo11n.pt',
        'person_detector_augmented.pt'
    )
    $missingModels = @($modelFiles | Where-Object { -not (Test-Path (Join-Path $ModelsDir $_)) })
    if ($missingModels.Count -gt 0) {
        Write-Host 'Warning: some model files are missing:' -ForegroundColor Yellow
        $missingModels | ForEach-Object { Write-Host " - $_" -ForegroundColor Yellow }
        Write-Host 'The website may open, but the corresponding AI analysis will not work until the model files are restored.' -ForegroundColor Yellow
    }

    # Select a supported Python installation. Prefer 3.11 for this project.
    Write-Step 'Finding Python 3.11 / 3.12 / 3.10...'
    $PythonLauncher = Get-Command py -ErrorAction SilentlyContinue
    $PythonBase = $null
    if ($PythonLauncher) {
        foreach ($version in @('3.11', '3.12', '3.10')) {
            & py "-$version" --version *> $null
            if ($LASTEXITCODE -eq 0) {
                $PythonBase = "py -$version"
                $SelectedVersion = $version
                break
            }
        }
    }
    if (-not $PythonBase) {
        $PythonCommand = Get-Command python -ErrorAction SilentlyContinue
        if ($PythonCommand) {
            $ver = & python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
            if ($LASTEXITCODE -eq 0 -and @('3.10','3.11','3.12') -contains $ver.Trim()) {
                $PythonBase = 'python'
                $SelectedVersion = $ver.Trim()
            }
        }
    }
    if (-not $PythonBase) {
        Fail 'No supported Python 3.10, 3.11, or 3.12 installation was found. Install Python 3.11 (64-bit) and enable the Python Launcher, then run this script again.'
    }
    Write-Host "Selected Python: $SelectedVersion" -ForegroundColor Green

    # Create a dedicated venv; do not modify or delete the user's existing .venv.
    $venvUsable = $false
    if (Test-Path $VenvPython) {
        $venvVersion = & $VenvPython -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
        $venvUsable = ($LASTEXITCODE -eq 0 -and $venvVersion.Trim() -eq $SelectedVersion)
    }
    if (-not $venvUsable) {
        if (Test-Path $VenvDir) {
            $backupName = '.venv_workvision_broken_' + (Get-Date -Format 'yyyyMMdd_HHmmss')
            Write-Host "Existing dedicated environment is invalid; moving it to $backupName" -ForegroundColor Yellow
            Rename-Item -Path $VenvDir -NewName $backupName
        }
        Write-Step 'Creating a clean isolated environment (.venv_workvision)...'
        if ($PythonBase -eq 'python') {
            & python -m venv $VenvDir
        } else {
            $parts = $PythonBase.Split(' ')
            & $parts[0] $parts[1] -m venv $VenvDir
        }
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VenvPython)) { Fail 'Could not create the virtual environment. Check that Python was installed with the venv component.' }
    } else {
        Write-Host 'Dedicated virtual environment already exists.' -ForegroundColor Green
    }

    # Always use the venv interpreter explicitly, not the global python/pip commands.
    Write-Step 'Preparing pip and installing all project requirements...'
    & $VenvPython -m ensurepip --upgrade
    if ($LASTEXITCODE -ne 0) { Fail 'ensurepip failed inside .venv_workvision.' }
    & $VenvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { Fail 'Could not upgrade pip.' }
    & $VenvPython -m pip install --prefer-binary -r $Requirements
    if ($LASTEXITCODE -ne 0) { Fail 'Installing requirements failed. Review the pip error above; check internet connection and available disk space.' }

    Write-Step 'Checking Python imports...'
    & $VenvPython -c "import sys, uvicorn, fastapi, cv2, numpy, ultralytics; print('Python:', sys.version.split()[0]); print('Interpreter:', sys.executable); print('Imports: OK')"
    if ($LASTEXITCODE -ne 0) { Fail 'One or more required packages could not be imported. Review the error above.' }

    # If port 8000 already serves this app, reuse it instead of launching a duplicate.
    $existingApp = $false
    try {
        $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 2
        if ($health.status -eq 'ok') { $existingApp = $true }
    } catch { }

    if ($existingApp) {
        Write-Host "An active WorkVision AI server is already responding at $BaseUrl" -ForegroundColor Green
        Start-Process $BaseUrl
        exit 0
    }

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        Fail "Port $Port is already used by another program. Close that program or change `$Port in this script, then run again. I did not terminate any process."
    }

    Write-Step 'Starting FastAPI / Uvicorn...'
    Remove-Item $StdoutLog, $StderrLog -ErrorAction SilentlyContinue
    $server = Start-Process -FilePath $VenvPython `
        -ArgumentList @('-m','uvicorn','app:app','--host','127.0.0.1','--port',"$Port") `
        -WorkingDirectory $ProjectRoot `
        -RedirectStandardOutput $StdoutLog `
        -RedirectStandardError $StderrLog `
        -PassThru
    Set-Content -Path $PidFile -Value $server.Id -Encoding ASCII

    Write-Host 'Waiting for the server to become ready...' -ForegroundColor Cyan
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Seconds 1
        if ($server.HasExited) { break }
        try {
            $health = Invoke-RestMethod -Uri "$BaseUrl/api/health" -TimeoutSec 2
            if ($health.status -eq 'ok') { $ready = $true; break }
        } catch { }
    }

    if (-not $ready) {
        Write-Host "Server did not become ready. Recent error log:" -ForegroundColor Red
        if (Test-Path $StderrLog) { Get-Content $StderrLog -Tail 60 }
        if (Test-Path $StdoutLog) { Get-Content $StdoutLog -Tail 30 }
        Fail 'The server could not start. The logs are workvision_server_error.log and workvision_server.log in the project folder.'
    }

    Write-Host "`nSUCCESS: WorkVision AI is running at $BaseUrl" -ForegroundColor Green
    Write-Host 'Health check: OK' -ForegroundColor Green
    Write-Host "Server PID: $($server.Id)"
    Write-Host "Logs: $StdoutLog and $StderrLog"
    Write-Host "To stop the server later, run: Stop-Process -Id (Get-Content '.\workvision_server.pid')"
    Start-Process $BaseUrl
}
catch {
    Write-Host "`nUnexpected error: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Copy the complete message and send it for troubleshooting.' -ForegroundColor Yellow
    exit 1
}
