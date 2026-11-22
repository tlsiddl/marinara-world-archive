# 세계관 설정집 (World Archive) — Windows 설치·업데이트·되돌리기·끄기
# PowerShell을 열고 (어느 폴더든):
#   irm https://raw.githubusercontent.com/tlsiddl/marinara-world-archive/main/install.ps1 | iex
# 이전 버전으로 되돌리기:
#   $env:WORLD_ARCHIVE_ACTION='rollback'; irm https://raw.githubusercontent.com/tlsiddl/marinara-world-archive/main/install.ps1 | iex
# 끄기(데이터는 남김):
#   $env:WORLD_ARCHIVE_ACTION='uninstall'; irm https://raw.githubusercontent.com/tlsiddl/marinara-world-archive/main/install.ps1 | iex
# 다시 실행하면 업데이트입니다. 세계관 데이터는 마리나라 데이터 폴더(world-archive)에 있어서 지워지지 않습니다.
# 마리나라 폴더 찾기는 기억 서재 install.ps1(tlsiddl/marinara-memory-module main bfafb3f)에서 옮겨 왔습니다.
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$repo = 'tlsiddl/marinara-world-archive'
$refName = if ($env:WORLD_ARCHIVE_REF) { $env:WORLD_ARCHIVE_REF } else { 'main' }
$action = if ($env:WORLD_ARCHIVE_ACTION) { $env:WORLD_ARCHIVE_ACTION } else { 'install' }
$env:WORLD_ARCHIVE_ACTION = $null
# The same list as FILES in install.sh (tests/install-files.test.cjs checks both).
$files = @(
  'world-archive/marinara-world-archive-runtime.cjs',
  'world-archive/lib/store.cjs',
  'world-archive/lib/inject.cjs',
  'world-archive/lib/service.cjs',
  'world-archive/lib/extract.cjs',
  'world-archive/lib/same.cjs',
  'world-archive/lib/names.cjs',
  'world-archive/lib/search.cjs',
  'world-archive/lib/roster.cjs',
  'world-archive/lib/timetable.cjs',
  'world-archive/lib/vendor/engine.cjs',
  'world-archive/lib/vendor/sentences.cjs',
  'world-archive/lib/vendor/glossary.cjs',
  'world-archive/lib/vendor/storydate.cjs',
  'world-archive/lib/calendar.cjs',
  'world-archive/lib/profile.cjs'
)
$linkName = 'Marinara + 세계관 설정집.lnk'

function Get-Version($path) {
  $m = Select-String -Path $path -Pattern "^const VERSION = '([^']*)'" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($m) { $m.Matches[0].Groups[1].Value } else { '?' }
}

function Rel([string]$f) { ($f -replace '^world-archive/', '') -replace '/', [IO.Path]::DirectorySeparatorChar }

# Accept a folder, launcher file, or a subfolder of an installation.
# Validate both the Windows entry point and server directory before writing.
function Resolve-MarinaraRoot([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  try {
    $Path = [Environment]::ExpandEnvironmentVariables($Path.Trim().Trim('"'))
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.PSProvider.Name -ne 'FileSystem') { return }
    $folder = if ($item.PSIsContainer) { $item } else { $item.Directory }
    while ($null -ne $folder) {
      if ((Test-Path -LiteralPath (Join-Path $folder.FullName 'start.bat') -PathType Leaf) -and
          (Test-Path -LiteralPath (Join-Path (Join-Path $folder.FullName 'packages') 'server') -PathType Container)) {
        return $folder.FullName
      }
      $folder = $folder.Parent
    }
  } catch {}
}

Write-Host ''
$dir = $null
if ($env:MARINARA_DIR) {
  $dir = Resolve-MarinaraRoot $env:MARINARA_DIR
  if (-not $dir) {
    Write-Host "[폴더 확인] MARINARA_DIR에 지정한 위치가 올바르지 않습니다: $env:MARINARA_DIR"
  }
} else {
  # Prefer the installation whose directory the user deliberately opened.
  $dir = Resolve-MarinaraRoot (Get-Location).Path
}
if (-not $dir) {
  $candidates = New-Object 'System.Collections.Generic.List[string]'
  foreach ($baseDir in @($env:LOCALAPPDATA, $env:USERPROFILE, $env:ProgramFiles, [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'))) {
    if ($baseDir) { [void]$candidates.Add((Join-Path $baseDir 'Marinara-Engine')) }
  }
  if ($env:LOCALAPPDATA) {
    [void]$candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Marinara-Engine'))
  }
  # Shortcuts locate custom installs on other drives without scanning whole disks.
  try {
    $shortcutShell = New-Object -ComObject WScript.Shell
    foreach ($special in @('Desktop', 'CommonDesktopDirectory', 'StartMenu', 'CommonStartMenu')) {
      $shortcutDir = [Environment]::GetFolderPath($special)
      if (-not $shortcutDir) { continue }
      foreach ($shortcutFile in @(Get-ChildItem -LiteralPath $shortcutDir -Filter '*Marinara*.lnk' -Recurse -File -ErrorAction SilentlyContinue)) {
        try {
          $shortcut = $shortcutShell.CreateShortcut($shortcutFile.FullName)
          if ($shortcut.TargetPath) { [void]$candidates.Add($shortcut.TargetPath) }
          if ($shortcut.WorkingDirectory) { [void]$candidates.Add($shortcut.WorkingDirectory) }
        } catch {}
      }
    }
  } catch {}
  $found = @($candidates | ForEach-Object { Resolve-MarinaraRoot $_ } | Sort-Object -Unique)
  if ($found.Count -eq 1 -and -not $env:MARINARA_DIR) {
    $dir = $found[0]
  } elseif ($found.Count -gt 0) {
    Write-Host '설치 위치를 선택해 주세요. 다른 위치라면 Enter를 누르세요.'
    for ($i = 0; $i -lt $found.Count; $i++) { Write-Host "  $($i + 1). $($found[$i])" }
    while (-not $dir) {
      $choice = Read-Host '번호 (Enter: 직접 폴더 선택)'
      if ([string]::IsNullOrWhiteSpace($choice)) { break }
      $index = 0
      if ([int]::TryParse($choice, [ref]$index) -and $index -ge 1 -and $index -le $found.Count) {
        $dir = $found[$index - 1]
      } else { Write-Host '목록에 있는 번호를 입력해 주세요.' }
    }
  }
}
if (-not $dir) {
  Write-Host 'start.bat과 packages 폴더가 들어 있는 마리나라 폴더를 선택해 주세요.'
  try {
    $folderShell = New-Object -ComObject Shell.Application
    $picked = $folderShell.BrowseForFolder(0, 'Marinara Engine - start.bat folder', 0x51, 0)
    if ($null -ne $picked) { $dir = Resolve-MarinaraRoot $picked.Self.Path }
  } catch {}
  while (-not $dir) {
    $typed = Read-Host '마리나라 폴더 경로 (따옴표 포함 가능, Enter: 취소)'
    if ([string]::IsNullOrWhiteSpace($typed)) {
      Write-Host '[취소] 아무것도 바꾸지 않았습니다.'
      return
    }
    $dir = Resolve-MarinaraRoot $typed
    if (-not $dir) {
      Write-Host '[폴더 확인] start.bat과 packages\server를 찾지 못했습니다. 경로를 다시 입력해 주세요.'
    }
  }
}
Write-Host "설치 대상: $dir"
$w = Join-Path $dir 'world-archive'
$prev = Join-Path $w '.prev'
$batPath = Join-Path $dir 'start-world-archive.bat'
$hasMemory = Test-Path -LiteralPath (Join-Path (Join-Path $dir 'memory-module') 'marinara-memory-runtime.cjs')

if ($action -eq 'rollback') {
  Write-Host '== 세계관 설정집 이전 버전으로 되돌리기 (Windows) =='
  if (-not (Test-Path (Join-Path $prev 'marinara-world-archive-runtime.cjs'))) {
    Write-Host "[실패] 되돌릴 이전 버전이 없습니다 ($prev)."
    return
  }
  foreach ($f in $files) {
    $src = Join-Path $prev (Rel $f)
    if (Test-Path $src) { Copy-Item -Force $src (Join-Path $w (Rel $f)) }
  }
  Write-Host "이전 버전 v$(Get-Version (Join-Path $w 'marinara-world-archive-runtime.cjs')) 으로 되돌렸습니다. 마리나라를 끄고 start-world-archive.bat으로 다시 켜 주세요."
  return
}

if ($action -eq 'uninstall') {
  Write-Host '== 세계관 설정집 끄기 (데이터는 남김, Windows) =='
  if (Test-Path $batPath) { Remove-Item -Force $batPath; Write-Host "[1/2] 실행 파일을 지웠습니다: $batPath" }
  try {
    $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) $linkName
    if (Test-Path -LiteralPath $lnk) { Remove-Item -Force -LiteralPath $lnk; Write-Host "[2/2] 바탕화면의 '$($linkName -replace '\.lnk$', '')' 바로가기를 지웠습니다." }
  } catch {}
  $next = if ($hasMemory) { 'start-memory.bat (기억 서재와 함께)' } else { 'start.bat' }
  Write-Host "앞으로는 $next 로 켜 주세요. 설정집 파일($w)과 세계관 데이터는 그대로 남아 있어서 다시 설치하면 이어집니다."
  Write-Host '잊지 말 것: 프리셋에 넣은 {{세계}} · {{세계외형}}은 지워 주세요. 끈 뒤에는 그 글자가 그대로 모델에 갑니다.'
  return
}

if ($action -ne 'install' -and $action -ne 'update') {
  Write-Host "[실패] 모르는 명령입니다: $action (rollback, uninstall 만 됩니다)"
  return
}

Write-Host '== 세계관 설정집 설치·업데이트 (Windows) =='
Write-Host "마리나라 폴더를 찾았습니다: $dir"

# Marinara's start.bat itself needs Node.js 24 or newer; World Archive needs 22.15+ (module.registerHooks).
try {
  $nodeVer = (& node -v) 2>$null
  if ($nodeVer -match '^v(\d+)\.(\d+)') {
    $major = [int]$Matches[1]; $minor = [int]$Matches[2]
    if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 15)) {
      Write-Host "[주의] Node.js $nodeVer 는 너무 낮습니다(22.15 이상 필요). 이대로 켜면 설정집만 꺼지고 마리나라는 그대로 켜집니다. https://nodejs.org 에서 업데이트해 주세요."
    }
  }
} catch {}

# Every file from one and the same commit, so an update never mixes two versions.
$ref = $refName
try {
  $sha = (Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Uri "https://api.github.com/repos/$repo/commits/$refName").sha
  if ($sha -match '^[0-9a-f]{40}$') { $ref = $sha }
} catch {}
$base = if ($env:WORLD_ARCHIVE_BASE) { $env:WORLD_ARCHIVE_BASE } else { "https://raw.githubusercontent.com/$repo/$ref" }

# All files go to a holding folder first and are checked; only then do they replace the old ones,
# and the old ones are kept in world-archive\.prev.
$new = Join-Path $w '.incoming'
if (Test-Path $new) { Remove-Item -Recurse -Force $new }
New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $new 'lib') 'vendor') | Out-Null
try {
  foreach ($f in $files) {
    $out = Join-Path $new (Rel $f)
    if ($base -match '^https?://') { Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri "$base/$f" -OutFile $out }
    else { Copy-Item -Force (Join-Path $base $f) $out }
    if ((Get-Item $out).Length -eq 0) { throw "$f 가 비어 있습니다" }
  }
  if (-not (Select-String -Path (Join-Path $new 'marinara-world-archive-runtime.cjs') -Pattern 'const VERSION' -Quiet)) { throw '받은 파일이 올바르지 않습니다' }
} catch {
  Remove-Item -Recurse -Force $new -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host "[설치 실패] 파일을 받지 못했습니다 ($($_.Exception.Message)). 인터넷 연결을 확인하고 다시 실행해 주세요. 기존 설정집은 그대로입니다."
  return
}
if (Test-Path (Join-Path $w 'marinara-world-archive-runtime.cjs')) {
  if (Test-Path $prev) { Remove-Item -Recurse -Force $prev }
  New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $prev 'lib') 'vendor') | Out-Null
  foreach ($f in $files) {
    $cur = Join-Path $w (Rel $f)
    if (Test-Path $cur) { Copy-Item -Force $cur (Join-Path $prev (Rel $f)) }
  }
}
New-Item -ItemType Directory -Force -Path (Join-Path (Join-Path $w 'lib') 'vendor') | Out-Null
foreach ($f in $files) { Move-Item -Force (Join-Path $new (Rel $f)) (Join-Path $w (Rel $f)) }
Remove-Item -Recurse -Force $new
Write-Host "[1/3] 세계관 설정집 v$(Get-Version (Join-Path $w 'marinara-world-archive-runtime.cjs')) 파일을 받았습니다: $w"
if (Test-Path $prev) { Write-Host "      (이전 버전은 $prev 에 남겨 두었습니다)" }

# ASCII only: cmd reads .bat files in the console code page.
# Starts World Archive, plus the memory module when it is installed in the same folder, so one launcher runs both.
$bat = @'
@echo off
rem Starts Marinara Engine with World Archive (and the memory module if it is installed here). Use this instead of start.bat.
setlocal DisableDelayedExpansion
cd /d "%~dp0"
rem NODE_OPTIONS treats backslashes inside quotes as escapes. Use forward slashes.
set "WA_ROOT=%~dp0"
set "WA_ROOT=%WA_ROOT:\=/%"
set "NODE_OPTIONS=--require="%WA_ROOT%world-archive/marinara-world-archive-runtime.cjs" %NODE_OPTIONS%"
if exist "%~dp0memory-module\marinara-memory-runtime.cjs" set "NODE_OPTIONS=--require="%WA_ROOT%memory-module/marinara-memory-runtime.cjs" %NODE_OPTIONS%"
call "%~dp0start.bat" %*
endlocal & exit /b %errorlevel%
'@
Set-Content -Path $batPath -Value $bat -Encoding Ascii
$withMemory = if ($hasMemory) { ' (기억 서재도 같이 켜집니다)' } else { '' }
Write-Host "[2/3] 실행 파일을 만들었습니다: $batPath$withMemory"

try {
  $desktop = [Environment]::GetFolderPath('Desktop')
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut((Join-Path $desktop $linkName))
  $link.TargetPath = $batPath
  $link.WorkingDirectory = $dir
  $icon = Join-Path $dir 'MarinaraLauncher.exe'
  if (Test-Path $icon) { $link.IconLocation = $icon }
  $link.Save()
  Write-Host "[3/3] 바탕화면에 '$($linkName -replace '\.lnk$', '')' 바로가기를 만들었습니다."
} catch {
  Write-Host '[3/3] 바로가기는 만들지 못했습니다. start-world-archive.bat을 직접 실행해 주세요.'
}
Write-Host ''
Write-Host '이제부터 마리나라를 start-world-archive.bat (또는 바탕화면 바로가기)로 켜 주세요.'
if ($hasMemory) { Write-Host '기억 서재도 이 파일 하나로 같이 켜집니다. start-memory.bat으로 켜면 설정집 없이 기억 서재만 켜집니다.' }
Write-Host '이미 켜져 있다면 끄고 다시 켜 주세요. start.bat이나 MarinaraLauncher로 켜면 설정집 없이 켜집니다.'
