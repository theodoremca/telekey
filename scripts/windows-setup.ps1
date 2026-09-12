<#
.SYNOPSIS
  Install everything TeleKey needs on Windows, then build the installer.

.DESCRIPTION
  Checks each prerequisite and installs only what is missing, so it is safe to
  re-run. Ends by building an NSIS installer.

  Run it from the repository root:

      .\scripts\windows-setup.ps1

  Add -SkipBuild to set the machine up without building, or -Msi to produce an
  .msi instead of the default .exe installer.

.NOTES
  NSIS is the default because MSI additionally requires the VBSCRIPT optional
  Windows feature; without it the build fails with "failed to run light.exe",
  which is a confusing way to learn about a checkbox.
#>

[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$Msi
)

$ErrorActionPreference = 'Stop'

function Write-Step   { param($m) Write-Host "`n▸ $m" -ForegroundColor Cyan }
function Write-Ok     { param($m) Write-Host "  ✓ $m" -ForegroundColor Green }
function Write-Missing{ param($m) Write-Host "  … $m" -ForegroundColor Yellow }
function Write-Fail   { param($m) Write-Host "  ✗ $m" -ForegroundColor Red }

function Test-Command {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# PATH is set by installers for *new* shells, so pull the current machine and
# user values in rather than making the user reopen the terminal mid-script.
function Update-Path {
    $env:Path = @(
        [Environment]::GetEnvironmentVariable('Path', 'Machine')
        [Environment]::GetEnvironmentVariable('Path', 'User')
        "$env:USERPROFILE\.cargo\bin"
    ) -join ';'
}

function Install-WithWinget {
    param([string]$Id, [string]$Label, [string[]]$ExtraArgs = @())

    Write-Missing "$Label not found — installing"
    $args = @('install', '--id', $Id, '--exact', '--silent',
              '--accept-package-agreements', '--accept-source-agreements') + $ExtraArgs
    & winget @args
    if ($LASTEXITCODE -ne 0) {
        throw "winget failed to install $Label (exit $LASTEXITCODE)"
    }
    Update-Path
}

Write-Host "TeleKey — Windows setup" -ForegroundColor White
Write-Host "========================"

# ---- 0. Where are we? ---------------------------------------------------

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repoRoot 'src-tauri\tauri.conf.json'))) {
    Write-Fail "This does not look like the TeleKey repository."
    Write-Host "  Run it from the repo root:  .\scripts\windows-setup.ps1"
    exit 1
}
Set-Location $repoRoot

# ---- 1. winget ----------------------------------------------------------

Write-Step "Package manager"
if (Test-Command winget) {
    Write-Ok "winget available"
} else {
    Write-Fail "winget not found."
    Write-Host @"
  winget ships with Windows 11 and recent Windows 10. Install "App Installer"
  from the Microsoft Store, then re-run this script:

      https://apps.microsoft.com/detail/9nblggh4nns1
"@
    exit 1
}

# ---- 2. Visual Studio C++ build tools -----------------------------------

Write-Step "C++ build tools"

# Rust's MSVC toolchain links with link.exe, so the C++ workload is required
# even though none of this project's own code is C++.
$vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$haveCpp = $false
if (Test-Path $vsWhere) {
    $found = & $vsWhere -latest -products * `
        -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
        -property installationPath 2>$null
    $haveCpp = -not [string]::IsNullOrWhiteSpace($found)
}

if ($haveCpp) {
    Write-Ok "Desktop development with C++ present"
} else {
    Write-Missing "C++ build tools not found — installing (this one is large, ~2-4 GB)"
    Install-WithWinget -Id 'Microsoft.VisualStudio.2022.BuildTools' -Label 'VS Build Tools' `
        -ExtraArgs @('--override',
            '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended')
    Write-Ok "C++ build tools installed"
    Write-Host "  A reboot is occasionally needed before the linker is usable." -ForegroundColor DarkGray
}

# ---- 3. WebView2 --------------------------------------------------------

Write-Step "WebView2 runtime"

# Preinstalled on Windows 10 1803+ and Windows 11; checked anyway because a
# missing runtime produces a blank window rather than a build error.
$webViewKeys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
if ($webViewKeys | Where-Object { Test-Path $_ }) {
    Write-Ok "WebView2 present"
} else {
    Install-WithWinget -Id 'Microsoft.EdgeWebView2Runtime' -Label 'WebView2 runtime'
    Write-Ok "WebView2 installed"
}

# ---- 4. Rust ------------------------------------------------------------

Write-Step "Rust toolchain"
Update-Path

if (Test-Command rustc) {
    Write-Ok "Rust $((rustc --version) -replace 'rustc ', '')"
} else {
    Install-WithWinget -Id 'Rustlang.Rustup' -Label 'Rust'
    if (-not (Test-Command rustc)) {
        Write-Fail "Rust installed but not on PATH. Open a new terminal and re-run."
        exit 1
    }
    Write-Ok "Rust installed"
}

# Tauri requires the MSVC toolchain; the GNU one will not link against WebView2.
$toolchain = (rustup show active-toolchain) 2>$null
if ($toolchain -notmatch 'msvc') {
    Write-Missing "Active toolchain is not MSVC — switching"
    rustup default stable-msvc
    Write-Ok "Switched to stable-msvc"
} else {
    Write-Ok "MSVC toolchain active"
}

# ---- 5. Bun -------------------------------------------------------------

Write-Step "Bun"
if (Test-Command bun) {
    Write-Ok "Bun $(bun --version)"
} else {
    Install-WithWinget -Id 'Oven-sh.Bun' -Label 'Bun'
    if (-not (Test-Command bun)) {
        Write-Fail "Bun installed but not on PATH. Open a new terminal and re-run."
        exit 1
    }
    Write-Ok "Bun installed"
}

# ---- 6. Project dependencies -------------------------------------------

Write-Step "Frontend dependencies"
bun install
if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
Write-Ok "Installed"

if ($SkipBuild) {
    Write-Host "`nSetup complete. Build when ready:" -ForegroundColor White
    Write-Host "  bun tauri build --bundles nsis"
    exit 0
}

# ---- 7. Build -----------------------------------------------------------

$bundle = if ($Msi) { 'msi' } else { 'nsis' }

if ($Msi) {
    Write-Host "`n  MSI needs the VBSCRIPT optional feature enabled." -ForegroundColor DarkGray
    Write-Host "  Settings → System → Optional features → More Windows features" -ForegroundColor DarkGray
}

Write-Step "Building ($bundle)"
Write-Host "  The first build compiles the whole dependency tree — expect 5-15 minutes." -ForegroundColor DarkGray

bun tauri build --bundles $bundle
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Build failed."
    Write-Host @"

  Common causes:
    • link.exe not found      — reboot, or re-run to finish the C++ install
    • failed to run light.exe — MSI only; enable the VBSCRIPT optional feature
                                or build the default NSIS target instead
"@
    exit 1
}

# ---- 8. Where it landed -------------------------------------------------

$out = Join-Path $repoRoot "src-tauri\target\release\bundle\$bundle"
$installer = Get-ChildItem $out -Filter '*.exe','*.msi' -ErrorAction SilentlyContinue |
             Sort-Object LastWriteTime -Descending | Select-Object -First 1

Write-Host ""
if ($installer) {
    Write-Ok "Built $($installer.Name) ($([math]::Round($installer.Length / 1MB, 1)) MB)"
    Write-Host "  $($installer.FullName)"
    Write-Host "`nRun it to install TeleKey, then add your OpenAI API key in Settings." -ForegroundColor White
} else {
    Write-Fail "Build reported success but no installer was found in $out"
    exit 1
}
