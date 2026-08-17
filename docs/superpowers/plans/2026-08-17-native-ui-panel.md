# 原生窗口面板 + 全局热键 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 C# WinForms 原生面板（WinPanel.exe），全局热键 F12 在游戏内呼出/收起，全功能复刻现有 Web 面板，host.js 自动托管，游戏逻辑零改动。

**Architecture:** `winui/WinPanel.cs` 单个 C# 源文件用系统自带 `csc.exe` 编译为 WinForms 置顶窗口；`RegisterHotKey` 注册 F12 捕获 `WM_HOTKEY` 切换窗口可见性；通过 `HttpClient`/`WebRequest` 调现有 host.js HTTP API（/api/values, /api/set, /api/items, /api/spawn, /api/stats, /api/setstat, /api/resetstats）；启动时探测 8899→9599→9800 端口，无 host 则 `Process.Start("node host.js")` 并轮询等待。`启动修改器.bat` 改为启动 WinPanel.exe（缺失时先构建）。agent.ts/host.js 完全不动。

**Tech Stack:** C# / WinForms (.NET Framework 4.x) / Windows 自带 csc.exe（零安装）/ HTTP 客户端

**Spec:** `docs/superpowers/specs/2026-08-17-native-ui-panel-design.md`

## Global Constraints

- 全部改动提交到**本地 git**（不推 GitHub）。
- 不使用 Electron/Tauri/WebView；纯 WinForms 原生控件。
- 不修改 `src/agent.ts`、`host.js`（复用其 HTTP API 与端口回退 8899→9599→9800）。
- 构建命令：`powershell -ExecutionPolicy Bypass -File winui\build-ui.ps1`，输出 `winui\WinPanel.exe`。
- csc 路径固定：`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`（已确认真实存在）。
- C# 运行时用机器自带 .NET Framework 4.x，目标框架 `/target:winexe`，C# 4.0 语法兼容（避免 LINQ/lambda 之外的 5/6/7 特性，必须用则限制在 .NET 4.0 可用范围）。
- UI 文案与功能对齐 Web 面板：资源(金币/魂晶/魔铁锭/虚灵通票/刷新币)、物品(搜索+列表+数量+生成)、属性(读取/修改/重置, 含HP/MP)。

---

### Task 1: winui 目录骨架 + build-ui.ps1 构建脚本

**Files:**
- Create: `winui/build-ui.ps1`

**Interfaces:**
- Produces: `winui/build-ui.ps1` — 编译 `winui/WinPanel.cs`（后续任务逐步填充该文件）为 `winui/WinPanel.exe`；成功/失败退出码与明确日志。

- [ ] **Step 1: 创建 winui/build-ui.ps1**

```powershell
# build-ui.ps1 - 用系统自带 csc.exe 编译 WinPanel.exe (零额外安装)
$ErrorActionPreference = "Stop"
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { Write-Error "csc.exe not found: $csc"; exit 1 }
$src = Join-Path $PSScriptRoot "WinPanel.cs"
if (-not (Test-Path $src)) { Write-Error "源码缺失: $src"; exit 1 }
$out = Join-Path $PSScriptRoot "WinPanel.exe"
$args = @(
  "/nologo", "/target:winexe", "/utf8output",
  "/out:" + $out,
  "/r:System.dll", "/r:System.Core.dll",
  "/r:System.Drawing.dll", "/r:System.Windows.Forms.dll",
  "/r:System.Net.Http.dll",
  $src
)
& $csc @args
if ($LASTEXITCODE -ne 0) { Write-Error "编译失败 (exit $LASTEXITCODE)"; exit 1 }
Write-Host "[build-ui] OK: $out ($((Get-Item $out).Length) bytes)"
exit 0
```

- [ ] **Step 2: 创建最小 WinPanel.cs 占位（让脚本可通过编译，后续 Task 增量填充）**

```csharp
using System;
using System.Windows.Forms;

static class WinPanel
{
    [STAThread]
    static int Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        return 0;
    }
}
```

- [ ] **Step 3: 运行构建验证**

Run: `powershell -ExecutionPolicy Bypass -File winui\build-ui.ps1`
Expected: 输出 `[build-ui] OK: ...WinPanel.exe (... bytes)`，exit 0，`winui\WinPanel.exe` 生成。

- [ ] **Step 4: 提交**

```bash
git add winui/build-ui.ps1 winui/WinPanel.cs
git commit -m "feat: winui 构建脚本与骨架"
```

---

### Task 2: WinPanel 窗体 + 全局热键 F12 + host 自动托管

**Files:**
- Modify: `winui/WinPanel.cs`
- Test: 手动 — 构建后启动，验证窗口显示/隐藏与 host 拉起

**Interfaces:**
- Consumes: `build-ui.ps1`（Task 1）
- Produces:
  - 窗体 `WinPanel : Form`（TopMost, 置顶, 可拖拽, 最小化）
  - 常量 `const int HotKeyId = 1;` + 热键键码（当前 **VK_F12**，可改）
  - 方法 `AcquirePort()` → int：探测 htt:127.0.0.1:{8899,9599,9800}，返回可用端口（无则返回 -1 但抛出异常由宿主决定）
  - 方法 `EnsureHost()`：探测端口，无响应则 `Process.Start` 拉起 `node host.js`（工作目录=仓库根），轮询等待某一端口就绪（最多 30s），返回实际端口；失败抛异常
  - 方法 `HttpGet(string path)` → string / `HttpPostJson(string path, string json)` → string：基于所用端口请求 host API
  - `WndProc` 重写捕获 `WM_HOTKEY`，切换 `Visible`

- [ ] **Step 1: 实现窗体骨架 + 热键 + host 托管（替换 Task 1 占位 Main）**

```csharp
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class WinPanel
{
    const int WM_HOTKEY = 0x0312;
    const int HotKeyId = 1;
    const int VK_F12 = 0x7B;

    [STAThread]
    static int Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        int port;
        try { port = new HostPoller().EnsureHost(); }
        catch (Exception ex)
        {
            MessageBox.Show("无法启动 host.js: " + ex.Message, "LostCastle2 Trainer", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        Application.Run(new MainForm(port));
        return 0;
    }
}
```

（`new HostPoller().EnsureHost()` 返回端口；`MainForm` 承载 UI 与热键。）

- [ ] **Step 2: 实现 HostPoller（端口探测 + node host.js 托管）**

```csharp
class HostPoller
{
    static readonly int[] Ports = { 8899, 9599, 9800 };

    public int EnsureHost()
    {
        int p = Probe();
        if (p > 0) return p;
        var psi = new ProcessStartInfo("node", "host.js") { WorkingDirectory = Path.GetDirectoryName(Application.ExecutablePath) };
        using (var proc = Process.Start(psi))
        {
            DateTime deadline = DateTime.Now.AddSeconds(30);
            while (DateTime.Now < deadline)
            {
                Thread.Sleep(500);
                p = Probe();
                if (p > 0) return p;
            }
        }
        throw new Exception("host.js 30s 内未就绪");
    }

    int Probe()
    {
        foreach (int port in Ports)
        {
            try
            {
                using (var wc = new WebClient())
                {
                    wc.Encoding = Encoding.UTF8;
                    string s = wc.DownloadString("http://127.0.0.1:" + port + "/api/values");
                    if (s != null) return port;
                }
            }
            catch { }
        }
        return -1;
    }
}
```

- [ ] **Step 3: 实现 MainForm 窗口 + 全局热键**

```csharp
class MainForm : Form
{
    readonly int _port;
    public MainForm(int port)
    {
        _port = port;
        Text = "失落城堡2 修改器";
        StartPosition = FormStartPosition.CenterScreen;
        Width = 460;
        Height = 640;
        TopMost = true;
        FormBorderStyle = FormBorderStyle.Sizable;
        RegisterHotKey(Handle, HotKeyId, 0, VK_F12);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && (int)m.WParam == HotKeyId)
            Visible = !Visible;
        base.WndProc(ref m);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        UnregisterHotKey(Handle, HotKeyId);
        base.OnFormClosed(e);
    }

    [DllImport("user32.dll")]
    static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")]
    static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}
```

- [ ] **Step 4: 构建 + 手动验证**

Run: `powershell -ExecutionPolicy Bypass -File winui\build-ui.ps1`
然后启动一个 host（或让 WinPanel 自己拉起），确认：
- 窗口显示、置顶
- 按 F12 窗口隐藏再按恢复
- 首次运行能自动拉起 host.js 并连接

- [ ] **Step 5: 提交**

```bash
git add winui/WinPanel.cs
git commit -m "feat: 窗口骨架 + F12 全局热键 + host 自动托管"
```

---

### Task 3: 资源区块（全功能复刻 Web 面板）

**Files:**
- Modify: `winui/WinPanel.cs`
- Test: 手动 — 面板上修改资源读回一致

**Interfaces:**
- Consumes: `MainForm._port`（Task 2）
- Produces: `GetJson(string path)`/`PostJson(string path, string json)` 私有方法（Task 3/4/5 共用）

- [ ] **Step 1: 添加 HTTP 请求辅助方法**

```csharp
string GetJson(string path)
{
    using (var wc = new WebClient())
    {
        wc.Encoding = Encoding.UTF8;
        return wc.DownloadString("http://127.0.0.1:" + _port + path);
    }
}
string PostJson(string path, string json)
{
    using (var wc = new WebClient())
    {
        wc.Encoding = Encoding.UTF8;
        wc.Headers[HttpRequestHeader.ContentType] = "application/json";
        return wc.UploadString("http://127.0.0.1:" + _port + path, json);
    }
}
```

- [ ] **Step 2: 在窗体加入资源区 TableLayoutPanel + 每行 名称/当前值/输入框/修改按钮**

每行：`Label 名称、Label 当前值、TextBox、Button 修改`。点击修改：`parse` 输入 → `PostJson("/api/set", "{\"name\":\"<name>\",\"value\":<v>}")` → 解析返回 `{ok, value}` → 成功更新"当前值"文本；失败 MessageBox。

资源清单（与 host 面板一致, name/label）:
- coin/金币, crystal/魂晶, ironPowder/魔铁锭, exchangeStone/虚灵通票, refreshPassive/刷新币·宝藏

- [ ] **Step 3: 构建 + 手动验证**

Run: 构建后启动面板，逐项: 金币/魂晶/魔铁锭/虚灵通票/刷新币 修改后"当前值"读回一致、无报错。

- [ ] **Step 4: 提交**

```bash
git add winui/WinPanel.cs
git commit -m "feat: 资源修改区块"
```

---

### Task 4: 物品区块（搜索 + 列表 + 数量 + 生成掉落）

**Files:**
- Modify: `winui/WinPanel.cs`
- Test: 手动 — 加载物品列表、搜索、生成掉落成功

**Interfaces:**
- Consumes: `GetJson` / `PostJson`（Task 3）
- Produces: `RefreshItems()` 填充 ListBox，`SpawnItem(id, count)` 调 `/api/spawn`

- [ ] **Step 1: 加入物品区控件**

- 顶部: 搜索 TextBox + "刷新物品" Button
- 中间: ListBox（显示 `名称 [类型] ID`）
- 底部: 数量 NumericUpDown(1..99) + "生成掉落" Button

- [ ] **Step 2: 实现加载/搜索/生成**

```csharp
void RefreshItems()
{
    string json = GetJson("/api/items");
    // 解析数组 {id,name,typeLabel} → 存入 List<ItemInfo>; ListBox 显示 name + " [" + typeLabel + "] " + id
}
void ApplyFilter()
{
    // 按 ListBox 显示文本包含输入关键词过滤重渲染
}
void SpawnSelected()
{
    // 取选中项 id + 数量 n → PostJson("/api/spawn", "{\"id\":\"<id>\",\"count\":<n>}") → 显示 spawned 数
}
```

注意：/api/spawn 返回 `{ok, count, spawned, error}`，用 messagebox 或状态栏显示 `已掉落 xN` 或返回的 error。

- [ ] **Step 3: 构建 + 手动验证**

Run: 游戏内启动游戏 → 打开面板 → "刷新物品" 出现列表 → 搜索过滤生效 → 选一件设置数量点"生成掉落" → 游戏中走到附近能拾取。

- [ ] **Step 4: 提交**

```bash
git add winui/WinPanel.cs
git commit -m "feat: 物品搜索与生成掉落区块"
```

---

### Task 5: 属性区块（读取/修改/重置, 含 HP/MP）

**Files:**
- Modify: `winui/WinPanel.cs`
- Test: 手动 — 属性读改重置一致

**Interfaces:**
- Consumes: `GetJson`/`PostJson`（Task 3）
- Produces: `RefreshStats()`（填充属性列表, 含上限）, `SetStat(name,value)`, `ResetStats()`

- [ ] **Step 1: 加入属性区控件 + 实现**

- 属性列表: 每行 Label名称 + 当前值 + TextBox + "修改"按钮
- 顶部: "刷新属性" 按钮; 底部: "重置为装备数值" 按钮
- `RefreshStats()`: `GetJson("/api/stats")` → 解析数组 `{name,label,value,max}` → 渲染行
- `SetStat`: `PostJson("/api/setstat", "{\"name\":\"<name>\",\"value\":<v>}")` → 成功刷新属性
- `ResetStats`: `PostJson("/api/resetstats", "{}")` → 用响应 `changed` 数组提示已重置项

（Web 面板显示: 当前值 + "/ 上限: <max>"，HP/MP/攻速等; agent 侧无需任何改动，host.js API 已支持。）

- [ ] **Step 2: 构建 + 手动验证**

Run: 面板读取属性 10 项全显示(含 HP/MP) → 修改攻击/生命/魔力成功读回一致 → 重置后恢复装备数值。

- [ ] **Step 3: 提交**

```bash
git add winui/WinPanel.cs
git commit -m "feat: 属性读取修改重置区块"
```

---

### Task 6: 启动修改器.bat 接线 + 收尾

**Files:**
- Modify: `启动修改器.bat`
- Modify: `README.md`
- Test: 整体流程 — 双击 bat → 面板出现 → 游戏内 F12 验证

**Interfaces:**
- Consumes: `winui/WinPanel.exe`（Task 1–5 产物）

- [ ] **Step 1: 修改启动修改器.bat 启动 WinPanel.exe**

在原有 node/npm 检查基础上，追加/替换启动段为：

```bat
rem --- 构建面板 (缺失时) ---
if not exist "winui\WinPanel.exe" (
    echo [提示] 未找到 winui\WinPanel.exe，正在编译...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0winui\build-ui.ps1"
    if errorlevel 1 (
        echo [错误] 面板编译失败，请检查 winui\WinPanel.cs。
        pause
        exit /b 1
    )
)

echo [提示] 启动原生面板，游戏内按 F12 呼出/隐藏...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~dp0winui\WinPanel.exe'"
echo [退出] 面板已启动，关闭面板窗口以退出修改器。
```

（保留原有 node/npm 依赖检查，host 由面板内托管，无需单独 `node host.js`。）

- [ ] **Step 2: 更新 README.md**

把"使用方法"小节改为: 双击「启动修改器.bat」→ 游戏内按 F12 呼出面板。保留环境要求(Node.js)。在项目结构中新增 `winui/` 一行。

- [ ] **Step 3: 端到端验证**

Run: `npm run build`（确认 dist 最新）→ 游戏(无边框窗口化)运行中 → 双击 bat → 面板出现 → F12 隐藏/呼出 → 资源/物品/属性三区全过 → 关闭窗口 host 正常退出。
Expected: 全部通过，游戏不崩。

- [ ] **Step 4: 提交**

```bash
git add "启动修改器.bat" README.md
git commit -m "feat: 启动器接入原生面板"
```

---

### Task 7: 验证记录 + 文档收尾

**Files:**
- Create: `docs/superpowers/analysis/2026-08-17-native-ui-verify.md`
- Modify: `docs/superpowers/specs/2026-08-17-native-ui-panel-design.md`（状态 → 已实现）

**Interfaces:**
- Consumes: 全部前述产物

- [ ] **Step 1: 写验证记录**

记录: WinPanel.exe 构建、F12 呼出/收起、资源三区块、host 自动托管、host 卸载、游戏不崩，逐项 pass/fail。含"独占全屏需无边框窗口化"提示。

- [ ] **Step 2: spec 状态改已实现**

将 `docs/superpowers/specs/2026-08-17-native-ui-panel-design.md` 顶部 `状态: 待实现` 改为 `状态: 已实现`。

- [ ] **Step 3: 提交**

```bash
git add docs
git commit -m "test: 原生面板全功能实测 + 设计文档收尾"
```

---

## Self-Review Notes

- 覆盖: spec 的目标(winui/WinPanel.exe)、热键F12、host托管、全功能复刻、csc零安装、本地git、无边框提示 均有对应 Task。
- 无占位: 每个 Task 给出实际代码/命令/验证步骤。
- 一致性: `HostPoller.EnsureHost()` 返回 int 端口并传给 `MainForm`; `GetJson/PostJson` 由 Task 3 定义、Task 4/5 消费; `/api/spawn` 响应结构 `{ok,count,spawned,error}`、`/api/resetstats` 响应 `{ok,changed,...}` 与 host.js 实现一致。
- WebClient 同步调用在 UI 线程（宿主摆动小、响应毫秒级），可接受；如遇卡顿追加 Task 或改 async，设计评审已接受。