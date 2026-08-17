@echo off
title ʧ��Ǳ�2 �޸���
cd /d "%~dp0"

echo ============================================
echo   ʧ��Ǳ�2 �����޸��� - ������
echo ============================================
echo.

rem --- 1. ��� Node.js ---
where node >nul 2>nul
if errorlevel 1 (
    echo [����] δ��⵽ Node.js�����Ȱ�װ Node.js �������С�
    pause
    exit /b 1
)

rem --- 2. ������� ---
if not exist "node_modules" (
    echo [��ʾ] δ�ҵ����������ڰ�װ node_modules...
    call npm install
    if errorlevel 1 (
        echo [����] ������װʧ�ܣ�������������ԡ�
        pause
        exit /b 1
    )
)

rem --- 3. ��������ȱʧ�򹹽� ---
if not exist "dist\agent.js" (
    echo [��ʾ] δ�ҵ�������� dist\agent.js�����ڹ���...
    call npm run build
    if errorlevel 1 (
        echo [����] ����ʧ�ܣ����� src/agent.ts ��������
        pause
        exit /b 1
    )
)

echo [��ʾ] �������� ʧ��Ǳ�2 ��Ϸ LostCastle2.exe ������Ӫ�������ԡ�
echo [����] ���������޸���...
echo        ����ַ�����·���ӡ����������Զ��򿪡�
echo        ��־��ͬʱд�� trainer.log������/�رպ�Ҳ�ܲ飩��
echo        �رձ����ڼ�ֹͣ�޸�����
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~dp0winui\WinPanel.exe'"

echo.
echo [�˳�] �޸�����ֹͣ��
pause
