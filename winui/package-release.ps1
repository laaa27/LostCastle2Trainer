# package-release.ps1 - 打包免环境 Release zip
# 内容: 便携 node + 完整 node_modules + dist + host.js + WinPanel.exe + 文档
# 用法: powershell -ExecutionPolicy Bypass -File winui\package-release.ps1 [-Version 1.1.0] [-NodeVersion 22.14.0] [-Out <zip 路径>]
param(
    [string]$Version = "1.2.0",
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

# 1. 获取便携 node: 仓库根 node\ 文件夹 -> 缓存 zip -> 本地旧 Release 包提取 (免下载) -> 官网下载
if ((Test-Path $nodeCache) -and ((Get-Item $nodeCache).Length -lt 25MB)) {
    Write-Host "[pkg] 缓存 zip 不完整, 已清除"
    Remove-Item $nodeCache -Force
}
$localNode = Join-Path $root "node"
$useLocalNode = Test-Path (Join-Path $localNode "node.exe")
$useOldZip = $false
$nodeStage = Join-Path $env:TEMP "opencode\node-stage"
if ($useLocalNode) {
    $lv = (Get-Item (Join-Path $localNode "node.exe")).VersionInfo.FileVersion
    Write-Host "[pkg] 使用仓库根 node\ 文件夹 (v$lv)"
    if ($lv -notmatch "^$NodeVersion") {
        Write-Host "[pkg] 警告: 版本与 NodeVersion=$NodeVersion 不同, frida 原生绑定可能无法加载"
    }
}
elseif (-not (Test-Path $nodeCache)) {
    $oldZip = Get-ChildItem -LiteralPath $root -Filter "LostCastle2Trainer-v*.zip" -File |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($oldZip) {
        Write-Host "[pkg] 尝试从 $($oldZip.Name) 提取便携 node (免下载)..."
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $z = [System.IO.Compression.ZipFile]::OpenRead($oldZip.FullName)
        try {
            # 兼容 Compress-Archive 的反斜杠与标准正斜杠两种条目风格; 排除顶层 node_modules
            $nodeEntries = @($z.Entries | Where-Object { ($_.FullName -like "node\*" -or $_.FullName -like "node/*") -and $_.Name -ne "" })
            if ($nodeEntries.Count -gt 100) {
                if (Test-Path $nodeStage) { Remove-Item $nodeStage -Recurse -Force }
                New-Item -ItemType Directory -Path $nodeStage | Out-Null
                foreach ($e in $nodeEntries) {
                    $rel = $e.FullName.Substring(5) -replace '[\\/]', '\'
                    $dest = Join-Path $nodeStage $rel
                    $dir = Split-Path -Parent $dest
                    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
                    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $dest, $true)
                }
                $useOldZip = Test-Path (Join-Path $nodeStage "node.exe")
            }
        } finally { $z.Dispose() }
        if ($useOldZip) {
            $nv = (Get-Item (Join-Path $nodeStage "node.exe")).VersionInfo.FileVersion
            Write-Host "[pkg] 成功复用包内 node (v$nv)"
            if ($nv -notmatch "^$NodeVersion") {
                Write-Host "[pkg] 警告: 版本与 NodeVersion=$NodeVersion 不同, 如遇运行异常请删除旧 Release 包后重新打包"
            }
        } else {
            Write-Host "[pkg] 旧包中未找到便携 node, 回退官网下载"
        }
    }
}
if (-not $useLocalNode -and -not $useOldZip) {
    if (-not (Test-Path $nodeCache)) {
        Write-Host "[pkg] 下载 node v$NodeVersion..."
        Invoke-WebRequest -Uri $nodeZipUrl -OutFile $nodeCache -UseBasicParsing
    } else {
        Write-Host "[pkg] 使用缓存 node zip"
    }
}

# 2. 组装打包目录
$stage = Join-Path $env:TEMP "opencode\relpkg"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage | Out-Null

Write-Host "[pkg] 放置便携 node..."
if ($useLocalNode) {
    New-Item -ItemType Directory -Path (Join-Path $stage "node") | Out-Null
    Copy-Item (Join-Path $localNode "*") (Join-Path $stage "node") -Recurse -Force
    # 排除用户自行放入的非官方文件, 不随包分发
    if (Test-Path (Join-Path $stage "node\install_tools.bat")) { Remove-Item (Join-Path $stage "node\install_tools.bat") -Force }
}
elseif ($useOldZip) {
    Move-Item $nodeStage (Join-Path $stage "node")
} else {
    $nodeExtract = Join-Path $env:TEMP "opencode\node-extract"
    if (Test-Path $nodeExtract) { Remove-Item $nodeExtract -Recurse -Force }
    Expand-Archive -Path $nodeCache -DestinationPath $nodeExtract
    Move-Item (Join-Path $nodeExtract $nodeDirName) (Join-Path $stage "node")
}

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
