param(
  [switch]$Writes
)

$ErrorActionPreference = 'Stop'
$appRoot = (Resolve-Path $PSScriptRoot).Path
$nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue |
  Select-Object -First 1
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { $null }
if (-not $nodePath) {
  $nodeCandidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe"
  )
  $nodePath = $nodeCandidates |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
}
if (-not $nodePath) {
  throw 'Node.js was not found. Install Node.js 22.13 or newer, then run this script again.'
}
& $nodePath -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'
if ($LASTEXITCODE -ne 0) {
  throw 'JARVIS requires a working Node.js 22.13 or newer installation.'
}
if (-not (Test-Path -LiteralPath (Join-Path $appRoot 'node_modules\vite\bin\vite.js'))) {
  throw 'JARVIS dependencies are missing. Run npm install in this folder before restarting.'
}

$processes = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($process in $processes) {
  $byId[[int]$process.ProcessId] = $process
}

function Get-JarvisLauncherId([int]$processId) {
  $visited = @{}
  $currentId = $processId
  for ($depth = 0; $depth -lt 10 -and $currentId -gt 0; $depth++) {
    if ($visited.ContainsKey($currentId)) { break }
    $visited[$currentId] = $true
    $current = $byId[$currentId]
    if (-not $current) { break }
    if ($current.CommandLine -match 'scripts[\\/]+start\.mjs') {
      return $currentId
    }
    $currentId = [int]$current.ParentProcessId
  }
  return $null
}

$jarvisListeners = @{}
$unrelatedListeners = @()
foreach ($port in @(5173, 8787)) {
  foreach ($connection in @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) {
    $listenerId = [int]$connection.OwningProcess
    $launcherId = Get-JarvisLauncherId $listenerId
    if ($launcherId) {
      $jarvisListeners[$listenerId] = $port
    } else {
      $listener = $byId[$listenerId]
      if ($listener) {
        $unrelatedListeners += "port $port (PID $listenerId, $($listener.Name))"
      }
    }
  }
}

if ($jarvisListeners.Count -gt 0) {
  $jarvisListeners.Keys | ForEach-Object {
    $id = [int]$_
    $port = $jarvisListeners[$id]
    Write-Host "Stopping JARVIS listener on port $port (PID $id)..."
    Stop-Process -Id $id -Force -ErrorAction Stop
  }
  Start-Sleep -Seconds 2
} else {
  Write-Host 'No running JARVIS launcher was found on ports 5173 or 8787.'
}

if ($unrelatedListeners.Count -gt 0) {
  Write-Warning "Leaving unrelated port owner(s) untouched: $($unrelatedListeners -join ', ')"
}

Write-Host "`nStarting JARVIS from $appRoot"
$escapedRoot = $appRoot.Replace("'", "''")
$escapedNode = $nodePath.Replace("'", "''")
$nodeDirectory = (Split-Path -Parent $nodePath).Replace("'", "''")
$command = "`$ErrorActionPreference = 'Stop'; " +
  "Set-Location -LiteralPath '$escapedRoot'; " +
  "`$env:PATH = '$nodeDirectory;' + `$env:PATH; " +
  "& '$escapedNode' '.\scripts\start.mjs'"
if ($Writes) {
  $command += ' --writes'
}
$encodedCommand = [Convert]::ToBase64String(
  [Text.Encoding]::Unicode.GetBytes($command)
)
$powerShellPath = (Get-Process -Id $PID).Path
Start-Process -FilePath $powerShellPath -ArgumentList @(
  '-NoExit',
  '-EncodedCommand',
  $encodedCommand
)
Write-Host 'JARVIS is starting in a new PowerShell window.'
