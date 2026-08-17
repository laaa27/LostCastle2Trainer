# build-ui.ps1 - 用系统自带 csc.exe 编译 WinPanel.exe (零额外安装)
$ErrorActionPreference = "Stop"
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { Write-Error "csc.exe not found: $csc"; exit 1 }
$src = Join-Path $PSScriptRoot "WinPanel.cs"
if (-not (Test-Path $src)) { Write-Error "源码缺失: $src"; exit 1 }
$out = Join-Path $PSScriptRoot "WinPanel.exe"
$cscArgs = @(
  "/nologo", "/target:winexe", "/utf8output",
  ("/out:" + $out),
  "/r:System.dll", "/r:System.Core.dll",
  "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
  "/r:System.Net.Http.dll",
  $src
)
& $csc @cscArgs 2>&1 | Out-Host
if ($LASTEXITCODE -ne 0) { Write-Error "编译失败 (exit $LASTEXITCODE)"; exit 1 }
Write-Host "[build-ui] OK: $out ($((Get-Item $out).Length) bytes)"
exit 0