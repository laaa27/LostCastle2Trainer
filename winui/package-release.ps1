# package-release.ps1 - 打包免环境 Release zip
# 内容: 便携 node + 完整 node_modules + dist + host.js + WinPanel.exe + 文档
# 用法: powershell -ExecutionPolicy Bypass -File winui\package-release.ps1 [-Version 1.1.0] [-NodeVersion 22.14.0] [-Out <zip 路径>]
param(
    [string]$Version = "1.1.0",
    [string]$NodeVersion = "22.14.0",
    [string]$Out = ""
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# 0. 确定 node 官方版本与本机 node_modules 匹配 (frida 原生绑定按 node 编译, 必须同版本)
$nodeZipUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$nodeDirName = "node-v$NodeVersion-win-x64"
$nodeCache = Join-Path $env:TEMP "opencode\node-v$NodeVersion-win-x64.zip"

Write-Host "[pkg] node: v$NodeVersion"
Write-Host "[pkg] 检查编译产物..."
$exe = Join-Path $PSScriptRoot "WinPanel.exe"
$agent = Join-Path $root "dist\agent.js"
if (-not (Test-Path $exe)) { Write-Host "[pkg] WinPanel.exe 缺失, 先编译..."; & (Join-Path $PSScriptRoot "build-ui.ps1"); if ($LASTEXITCODE -ne 0) { exit 1 } }
if (-not (Test-Path $agent)) { Write-Host "[pkg] dist\agent.js 缺失, 先编译 agent..."; Push-Location $root; npm run build; Pop-Location; if ($LASTEXITCODE -ne 0) { exit 1 } }

# 1. 下载便携 node (缓存到 temp)
if (-not (Test-Path $nodeCache)) {
    Write-Host "[pkg] 下载 node v$NodeVersion ($([Math]::Round((Invoke-WebRequest -Uri $nodeZipUrl -Method Head -UseBasicParsing).Headers.'Content-Length'[0]/1MB,1)) MB)..."
    Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeCache -UseBasicParsing
} else {
    Write-Host "[pkg] 使用缓存 node zip"
}

# 2. 组装打包目录
$stage = Join-Path $env:TEMP "opencode\relpkg"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Write-Host "[pkg] 解压便携 node..."
$nodeExtract = Join-Path $env:TEMP "opencode\node-extract"
if (Test-Path $nodeExtract) { Remove-Item $nodeExtract -Recurse -Force }
Expand-Archive -Path $nodeCache -DestinationPath $nodeExtract
Move-Item (Join-Path $nodeExtract $nodeDirName) (Join-Path $stage "node")

Write-Host "[pkg] 拷贝 node_modules ($([Math]::Round((Get-ChildItem $root\node_modules -Recurse -File | Measure-Object Length -Sum).Sum/1MB,1)) MB)..."
Copy-Item (Join-Path $root "node_modules") (Join-Path $stage "node_modules") -Recurse

Write-Host "[pkg] 拷贝运行文件..."
# 整个 winui 目录 (含 exe + WinPanel.cs 源码 + 构建/打包脚本)
Copy-Item (Join-Path $PSScriptRoot ".") (Join-Path $stage "winui") -Recurse
Copy-Item (Join-Path $root "host.js") $stage
Copy-Item (Join-Path $root "dist") (Join-Path $stage "dist") -Recurse
Copy-Item (Join-Path $root "src") (Join-Path $stage "src") -Recurse
Copy-Item (Join-Path $root "package.json") $stage
Copy-Item (Join-Path $root "package-lock.json") $stage
Copy-Item (Join-Path $root "README.md") $stage
Copy-Item (Join-Path $root "CHANGELOG.md") $stage

# 3. 压缩
if (-not $Out) { $Out = Join-Path $root "LostCastle2Trainer-v$Version.zip" }
if (Test-Path $Out) { Remove-Item $Out }
Write-Host "[pkg] 压缩 -> $Out"
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $Out -CompressionLevel Optimal

$sizeMB = [Math]::Round((Get-Item $Out).Length/1MB, 1)
Write-Host "[pkg] 完成: $Out ($sizeMB MB)"
Write-Host "[pkg] 临时目录可删: $stage"
exit 0
