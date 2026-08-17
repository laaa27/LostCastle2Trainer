@echo off
title 失落城堡2 修改器
cd /d "%~dp0"

echo ============================================
echo   失落城堡2 单机修改器 - 原生面板
echo ============================================
echo.

rem --- 1. 检查 Node.js ---
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 后重试。
    pause
    exit /b 1
)

rem --- 2. 依赖与编译 ---
if not exist "node_modules" (
    echo [提示] 未找到依赖，正在安装 node_modules...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)
if not exist "dist\agent.js" (
    echo [提示] 未找到 dist\agent.js，正在编译...
    call npm run build
    if errorlevel 1 (
        echo [错误] 构建失败，请检查 src/agent.ts 是否有错误。
        pause
        exit /b 1
    )
)

rem --- 3. 构建面板 (缺失时) ---
if not exist "winui\WinPanel.exe" (
    echo [提示] 未找到 winui\WinPanel.exe，正在编译...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0winui\build-ui.ps1"
    if errorlevel 1 (
        echo [错误] 面板编译失败，请检查 winui\WinPanel.cs。
        pause
        exit /b 1
    )
)

echo [提示] 请先启动游戏并进入营地/存档界面(推荐无边框窗口化)。
echo [提示] 面板启动后，游戏中按 ` 键(反引号)呼出/隐藏窗口。
echo.

start "" "%~dp0winui\WinPanel.exe"

echo [退出] 面板已启动，关闭面板窗口以退出修改器。
pause