# Agent Pet - Create Desktop Shortcut
# Usage: powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1

$ErrorActionPreference = "Stop"

# Find the installed exe
$appName = "Agent Pet"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "$appName.lnk"

# Try to find the exe in common locations
$searchPaths = @(
    # NSIS install default
    "$env:LOCALAPPDATA\$appName\$appName.exe",
    # Build output
    (Join-Path $PSScriptRoot "..\src-tauri\target\release\$appName.exe"),
    (Join-Path $PSScriptRoot "..\src-tauri\target\release\bundle\nsis\*.exe")
)

$exePath = $null
foreach ($path in $searchPaths) {
    if ($path -match '\*') {
        $found = Get-ChildItem $path -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $exePath = $found.FullName; break }
    } else {
        if (Test-Path $path) { $exePath = $path; break }
    }
}

if (-not $exePath) {
    Write-Host "[!] Could not find Agent Pet exe." -ForegroundColor Yellow
    Write-Host "    Run 'npm run build:windows' first, then run this script again." -ForegroundColor Yellow
    exit 1
}

# Create shortcut
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = Split-Path $exePath
$shortcut.Description = "Agent Pet - AI Desktop Pet"
$shortcut.IconLocation = "$exePath,0"
$shortcut.Save()

Write-Host "[OK] Desktop shortcut created: $shortcutPath" -ForegroundColor Green
Write-Host "     Target: $exePath" -ForegroundColor Gray