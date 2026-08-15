@echo off
title 失落城堡2 修改器
cd /d "%~dp0"

echo ============================================
echo   失落城堡2 单机修改器 - 启动器
echo ============================================
echo.

rem --- 1. 检查 Node.js ---
where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 后再运行。
    pause
    exit /b 1
)

rem --- 2. 检查依赖 ---
if not exist "node_modules" (
    echo [提示] 未找到依赖，正在安装 node_modules...
    call npm install
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络后重试。
        pause
        exit /b 1
    )
)

rem --- 3. 检查编译产物，缺失则构建 ---
if not exist "dist\agent.js" (
    echo [提示] 未找到编译产物 dist\agent.js，正在构建...
    call npm run build
    if errorlevel 1 (
        echo [错误] 构建失败，请检查 src/agent.ts 与依赖。
        pause
        exit /b 1
    )
)

echo [提示] 请先启动 失落城堡2 游戏 LostCastle2.exe 并且在营地篝火旁。
echo [启动] 正在启动修改器...
echo        面板地址会在下方打印，浏览器将自动打开。
echo        日志会同时写入 trainer.log（卡死/关闭后也能查）。
echo        关闭本窗口即停止修改器。
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-trainer.ps1"

echo.
echo [退出] 修改器已停止。
pause
