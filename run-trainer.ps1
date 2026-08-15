# run-trainer.ps1
# Launch host.js with console output mirrored to trainer.log (UTF-8)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$log = Join-Path $PSScriptRoot 'trainer.log'
$header = '===== ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ====='
Write-Output $header
$header | Out-File -FilePath $log -Append -Encoding utf8
& node host.js 2>&1 | ForEach-Object {
    $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_.ToString() }
    Write-Output $line
    $line | Out-File -FilePath $log -Append -Encoding utf8
}
