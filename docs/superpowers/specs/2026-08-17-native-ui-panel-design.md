# 原生窗口面板 + 全局热键 设计

日期: 2026-08-17
状态: 待实现

## 背景

当前修改器是"Frida 注入 + 浏览器网页面板"。用户希望：
- 不使用/不寄生浏览器
- 在游戏中按快捷键随时呼出/收起面板
- UI 为 Windows 原生窗口

已确认方案：**C# 原生窗口 + 全局热键**（不选 ImGui 覆盖层——工程量最大且需 Visual Studio 编译；不选 Electron——200MB+ 体积臃肿）。

## 目标

- 新增 `winui/` 目录：C# WinForms 原生窗口面板（WinPanel.exe）
- 全局热键 **F12**（常量化可改），游戏内随时弹出/收起置顶面板
- **全功能复刻**现有 Web 面板：资源修改 / 物品搜索+生成掉落 / 属性读取修改重置
- 窗口自动托管 host.js（探测端口，无 host 则自动拉起 `node host.js`）
- 游戏逻辑、`agent.ts` 探测层、`host.js` 全部**不改**，仅复用其 HTTP API
- 构建用 Windows 自带 `csc.exe`（.NET Framework），**零额外安装**
- 代码提交到**本地 git**（不推 GitHub）

## 架构

```
双击 启动修改器.bat
   └─→ WinPanel.exe (C# WinForms, TopMost)
         ├─ ① 探测 127.0.0.1:8899 (回退 9599/9800) 是否有 host 响应
         │    无 → Process.Start("node host.js") 并轮询等待就绪
         ├─ ② RegisterHotKey 注册 F12, 消息循环捕获 WM_HOTKEY
         ├─ ③ 按 F12 切换窗口 Show/Hide
         └─ HTTP 调 host.js API:
              GET  /api/values   资源列表
              POST /api/set      修改资源
              GET  /api/items    物品列表
              POST /api/spawn    生成掉落
              GET  /api/stats    属性读取
              POST /api/setstat  修改属性
              POST /api/resetstats 重置属性
```

## 组件

### winui/WinPanel.cs (单一源文件)
- WinForms 窗体: 置顶小窗, 可拖拽, 可最小化
- 全局热键: `RegisterHotKey(hWnd, 1, 0, VK_F12)`; `WndProc` 捕获 `WM_HOTKEY` 切换可见性
- HTTP 客户端: `HttpClient` 调上述 API; 数据刷新逻辑照搬 Web 面板
- 三个功能区块: 资源 / 物品 / 属性
- host 托管: 启动时端口探测, 无则拉起 node host.js 并等待就绪; 关窗时若由本程序拉起则一并结束

### winui/build-ui.ps1
- 用 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` 编译 `WinPanel.cs` → `winui\WinPanel.exe`
- 引用 `System.Windows.Forms.dll` / `System.Drawing.dll` / `System.Net.Http.dll`

### 启动修改器.bat
- 改为启动 `winui\WinPanel.exe`（缺失时自动 `build-ui.ps1`）

## 已知边界

- 无边框窗口化模式: 热键弹窗正常置顶
- 独占全屏模式: 外部窗口会被游戏压住, 需用无边框窗口化

## 测试

1. 构建 exe 成功
2. 启动游戏(无边框窗口化) → 双击 bat → 游戏内按 F12 弹出/收起
3. 三项功能全过: 资源修改读回一致 / 物品生成掉落 / 属性修改重置

## 提交

- 本地 git 提交（不推 GitHub）
