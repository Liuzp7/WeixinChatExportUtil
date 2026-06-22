#Requires -Version 5.1
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$NativeDir = Join-Path $Root 'native\wexin-hook'
$OutDir = Join-Path $Root 'assets\dll'

Write-Host '=== Build wexin_hook.dll ===' -ForegroundColor Cyan

function Get-VsWherePath {
  $path = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (Test-Path $path) { return $path }
  return $null
}

function Find-VcVars {
  $vswhere = Get-VsWherePath
  if ($vswhere) {
    $found = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
      -find 'VC\Auxiliary\Build\vcvars64.bat' 2>$null
    if ($found) {
      return ($found | Select-Object -First 1)
    }
  }

  $candidates = @(
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Professional\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\17\Community\VC\Auxiliary\Build\vcvars64.bat"
  )
  foreach ($path in $candidates) {
    if (Test-Path $path) { return $path }
  }
  return $null
}

function Find-CMake {
  $cmake = Get-Command cmake -ErrorAction SilentlyContinue
  if ($cmake) { return $cmake.Source }

  $vswhere = Get-VsWherePath
  if ($vswhere) {
    $found = & $vswhere -latest -products * -find 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe' 2>$null
    if ($found) {
      return ($found | Select-Object -First 1)
    }
  }
  return $null
}

$vcvars = Find-VcVars
if (-not $vcvars) {
  Write-Host ''
  Write-Host 'Visual Studio C++ build tools not found.' -ForegroundColor Yellow
  Write-Host 'Install VS with "Desktop development with C++", or set a valid vcvars64.bat path.'
  exit 1
}
Write-Host "Using vcvars: $vcvars" -ForegroundColor DarkGray

$cmakePath = Find-CMake
if (-not $cmakePath) {
  Write-Host 'cmake not found. Install CMake or VS CMake component.' -ForegroundColor Yellow
  exit 1
}
Write-Host "Using cmake: $cmakePath" -ForegroundColor DarkGray

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$BuildDir = Join-Path $NativeDir 'build'
if (Test-Path $BuildDir) { Remove-Item -Recurse -Force $BuildDir }
New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

$buildCmd = "call `"$vcvars`" >nul && `"$cmakePath`" -S `"$NativeDir`" -B `"$BuildDir`" -A x64 && `"$cmakePath`" --build `"$BuildDir`" --config Release"
cmd.exe /c $buildCmd
if ($LASTEXITCODE -ne 0) {
  Write-Host "Build failed with exit code $LASTEXITCODE" -ForegroundColor Red
  exit $LASTEXITCODE
}

$built = @(
  Get-ChildItem -Path $BuildDir -Recurse -Filter 'wexin_hook.dll' -ErrorAction SilentlyContinue
  Get-ChildItem -Path $OutDir -Recurse -Filter 'wexin_hook.dll' -ErrorAction SilentlyContinue
) | Select-Object -First 1
if ($built) {
  $outPath = Join-Path $OutDir 'wexin_hook.dll'
  Copy-Item $built.FullName $outPath -Force
  Write-Host "Output: $outPath" -ForegroundColor Green
} else {
  Write-Host 'Build finished but wexin_hook.dll was not found.' -ForegroundColor Red
  exit 1
}
