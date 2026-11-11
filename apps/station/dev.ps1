# Dev loop: builds and starts the station app, and on every saved .cs, .xaml or .csproj
# under src rebuilds and restarts it. A failed build keeps the running app and prints the errors.
# Our own loop, because dotnet watch sees WPF XAML edits but doesn't apply or restart on them.
# Ctrl+C stops it.
#   ./dev.ps1            with sample scans on the screen
#   ./dev.ps1 -Empty     without
param([switch]$Empty)

$src = Join-Path $PSScriptRoot "src"
$project = Join-Path $src "Ventisol.Station"
$appArgs = if ($Empty) { @() } else { @("--showcase") }

# Builds alternate between two folders. The running app locks its own folder,
# so the next build goes to the other one and the old window stays up until it succeeds.
$slots = (Join-Path $project "bin\dev-a"), (Join-Path $project "bin\dev-b")
$slot = 0

# Only the dev build, told by where its exe is: an installed app on the same PC is left running.
function Stop-App {
    Get-Process VentisolStation -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($slots -contains (Split-Path $_.Path -Parent)) } |
        Stop-Process -Force
}

function Restart-App {
    $dir = $slots[$script:slot]
    Write-Host "$(Get-Date -Format HH:mm:ss)  building..." -ForegroundColor DarkGray
    $out = dotnet build $project -nologo -v q -clp:NoSummary -o $dir 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "$(Get-Date -Format HH:mm:ss)  build failed, fix and save again:" -ForegroundColor Red
        $out | Select-String "error" | Select-Object -Unique | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        return
    }
    Stop-App
    $exe = Join-Path $dir "VentisolStation.exe"
    if ($appArgs) { Start-Process $exe -ArgumentList $appArgs } else { Start-Process $exe }
    $script:slot = 1 - $script:slot
    Write-Host "$(Get-Date -Format HH:mm:ss)  running" -ForegroundColor Green
}

$watcher = New-Object IO.FileSystemWatcher $src -Property @{ IncludeSubdirectories = $true; EnableRaisingEvents = $true }
$onChange = {
    $p = $Event.SourceEventArgs.FullPath
    # bin and obj are build output, and WPF writes a *_wpftmp.csproj beside the project on every build.
    if ($p -match '\\(bin|obj)\\' -or $p -match '_wpftmp\.csproj$') { return }
    if ($p -match '\.(cs|xaml|csproj)$') { $global:DevChanged = $true }
}
$global:DevChanged = $false
$subs = "Changed", "Created", "Renamed", "Deleted" | ForEach-Object { Register-ObjectEvent $watcher $_ -Action $onChange }

try {
    Restart-App
    while ($true) {
        Start-Sleep -Milliseconds 300
        if ($global:DevChanged) {
            # Let a burst of saves settle before building.
            do { $global:DevChanged = $false; Start-Sleep -Milliseconds 400 } while ($global:DevChanged)
            Restart-App
        }
    }
}
finally {
    $subs | ForEach-Object { Unregister-Event $_.Name }
    $watcher.Dispose()
    Stop-App
}
