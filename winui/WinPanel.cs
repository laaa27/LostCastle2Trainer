using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class WinPanel
{
    [STAThread]
    static int Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        // 单实例保护: 已有实例则激活其窗口后退出, 避免第二个实例抢占热键而静默失效
        bool createdNew;
        using (var mutex = new Mutex(true, "LostCastle2TrainerPanel", out createdNew))
        {
            if (!createdNew)
            {
                ActivateExisting();
                return 0;
            }
            try { EnsureEnvironment(); }
            catch (Exception ex)
            {
                MessageBox.Show("环境准备失败: " + ex.Message, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 1;
            }

            // 立即显示面板(感知启动 ~0.5s), host 的探测/启动全部放后台线程
            // (本机对已关闭端口做 TCP 连接约需 2s/端口, 同步探测会白白卡住窗口)
            var form = new MainForm(-1);
            var hostThread = new Thread(() =>
            {
                int port = -1;
                try
                {
                    port = new HostPoller().EnsureHost();
                    form.BeginInvoke((Action)(() => form.SetHostReady(port)));
                }
                catch (Exception ex)
                {
                    try
                    {
                        File.AppendAllText(
                            Path.Combine(Path.GetTempPath(), "winpanel_err.log"),
                            DateTime.Now.ToString("HH:mm:ss") + " " + ex + Environment.NewLine);
                    }
                    catch { }
                    form.BeginInvoke((Action)(() => form.HostFailed(ex.Message)));
                }
            });
            hostThread.IsBackground = true;
            hostThread.Start();
            Application.Run(form);
        }
        return 0;
    }

// 让已运行实例的面板窗口显示并置前 (用户重复双击 exe 时只弹出一个面板)
    static void ActivateExisting()
    {
        try
        {
            foreach (Process p in Process.GetProcessesByName("WinPanel"))
            {
                if (p.Id == Process.GetCurrentProcess().Id) continue;
                if (p.MainWindowHandle == IntPtr.Zero) continue;
                ShowWindow(p.MainWindowHandle, 5); // SW_SHOW
                SetForegroundWindow(p.MainWindowHandle);
                break;
            }
        }
        catch { }
    }

    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr hWnd);

    // 自举: 确保 node / node_modules / dist\agent.js 就绪 (首次运行免命令行)
    static void EnsureEnvironment()
    {
        string root = Directory.GetParent(Directory.GetParent(Application.ExecutablePath).FullName).FullName;
        var st = new StatusForm();
        st.Show();
        st.SetText("正在检查环境...");
        Application.DoEvents();
        try
        {
            if (!NodeAvailable(root))
                throw new Exception("未检测到 Node.js，请先安装 Node.js 后重试。");
            if (!Directory.Exists(Path.Combine(root, "node_modules")))
            {
                st.SetText("首次运行，正在安装依赖 (npm install)，可能需要几分钟...");
                Application.DoEvents();
                RunCmd(root, "npm install");
            }
            if (!File.Exists(Path.Combine(root, "dist", "agent.js")))
            {
                st.SetText("首次运行，正在编译 agent (npm run build)...");
                Application.DoEvents();
                RunCmd(root, "npm run build");
            }
        }
        finally
        {
            st.Close();
        }
    }

    // release 包内便携 node 优先 (node\node.exe), 否则回退系统 PATH 上的 node
    public static string ResolveNodeExe()
    {
        string root = Directory.GetParent(Directory.GetParent(Application.ExecutablePath).FullName).FullName;
        string bundled = Path.Combine(root, "node", "node.exe");
        if (File.Exists(bundled)) return bundled;
        return "node";
    }

    static string ResolveNodeDir()
    {
        string root = Directory.GetParent(Directory.GetParent(Application.ExecutablePath).FullName).FullName;
        string dir = Path.Combine(root, "node");
        return Directory.Exists(dir) ? dir : null;
    }

    static bool NodeAvailable(string root)
    {
        try
        {
            var psi = new ProcessStartInfo(ResolveNodeExe(), "--version")
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            using (var p = Process.Start(psi))
            {
                p.WaitForExit(8000);
                return p.ExitCode == 0;
            }
        }
        catch { return false; }
    }

    static void RunCmd(string root, string args)
    {
        var psi = new ProcessStartInfo("cmd.exe", "/c " + args)
        {
            WorkingDirectory = root,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        // 包内便携 node: 把 node 目录前置到 PATH, 让 npm/npx 也能找到
        string nodeDir = ResolveNodeDir();
        if (nodeDir != null)
            psi.EnvironmentVariables["PATH"] = nodeDir + ";" + Environment.GetEnvironmentVariable("PATH");
        using (var p = Process.Start(psi))
        {
            p.OutputDataReceived += (s, e) => LogCmd(e.Data);
            p.ErrorDataReceived += (s, e) => LogCmd(e.Data);
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            if (!p.WaitForExit(10 * 60 * 1000))
            {
                try { p.Kill(); } catch { }
                throw new Exception(args + " 执行超时。");
            }
            if (p.ExitCode != 0)
                throw new Exception(args + " 执行失败 (exit=" + p.ExitCode + ")，详见日志。");
        }
    }

    static void LogCmd(string line)
    {
        if (line == null) return;
        try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "winpanel_build.log"), line + Environment.NewLine); } catch { }
    }
}

// 简单状态窗口, 避免自举时看起来卡死
class StatusForm : Form
{
    readonly Label _lb = new Label();
    public StatusForm()
    {
        Text = "失落城堡2 修改器";
        FormBorderStyle = FormBorderStyle.FixedToolWindow;
        StartPosition = FormStartPosition.CenterScreen;
        TopMost = true;
        ClientSize = new Size(420, 50);
        _lb.Dock = DockStyle.Fill;
        _lb.TextAlign = ContentAlignment.MiddleLeft;
        _lb.Padding = new Padding(8);
        Controls.Add(_lb);
    }
    public void SetText(string s) { _lb.Text = s; }
}

class HostPoller
{
    static readonly int[] Ports = { 8899, 9599, 9800 };
    static Process _ownedProc = null;
    static readonly System.Collections.Generic.List<string> _hostLines = new System.Collections.Generic.List<string>();

    public static void StopHost()
    {
        Process p = _ownedProc;
        if (p != null && !p.HasExited)
        {
            try { p.Kill(); } catch { }
            try { p.WaitForExit(2000); } catch { }
        }
    }

    public int EnsureHost()
    {
        int p = Probe();
        if (p > 0) return p;
        // exe 位于 winui\ 下, host.js 在仓库根 (winui 的上一级)
        string root = Directory.GetParent(Directory.GetParent(Application.ExecutablePath).FullName).FullName;
        string hostJs = Path.Combine(root, "host.js");
        Process proc = null;
        try
        {
            var psi = new ProcessStartInfo(WinPanel.ResolveNodeExe(), hostJs)
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            proc = Process.Start(psi);
            _ownedProc = proc;
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();
            proc.OutputDataReceived += delegate (object s, DataReceivedEventArgs a)
            {
                if (a.Data != null)
                {
                    lock (_hostLines) _hostLines.Add(a.Data);
                    try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "winpanel_host_out.log"), a.Data + Environment.NewLine); } catch { }
                }
            };
            proc.ErrorDataReceived += delegate (object s, DataReceivedEventArgs a)
            {
                if (a.Data != null) try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "winpanel_host_err.log"), a.Data + Environment.NewLine); } catch { }
            };
        }
        catch (Exception e)
        {
            try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "winpanel_err.log"), DateTime.Now.ToString("HH:mm:ss") + " [ProcessStart] " + e + Environment.NewLine); } catch { }
        }
        if (proc != null)
        {
            DateTime deadline = DateTime.Now.AddSeconds(30);
            while (DateTime.Now < deadline)
            {
                Thread.Sleep(500);
                p = Probe();
                if (p > 0) return p;
                // host 若落到随机端口, 从输出日志解析实际端口
                int discovered = ProbeDiscovered();
                if (discovered > 0) return discovered;
            }
        }
        throw new Exception("host.js 30s 内未就绪");
    }

    // 从 host 的 stdout 里解析 "http://127.0.0.1:<port>" 实际监听端口并探测
    int ProbeDiscovered()
    {
        string[] lines;
        lock (_hostLines) lines = _hostLines.ToArray();
        foreach (string line in lines)
        {
            int idx = line.IndexOf("127.0.0.1:", StringComparison.Ordinal);
            if (idx < 0) continue;
            int s = idx + "127.0.0.1:".Length;
            int e = s;
            while (e < line.Length && char.IsDigit(line[e])) e++;
            if (e <= s) continue;
            int port;
            if (!int.TryParse(line.Substring(s, e - s), out port) || port <= 0 || port > 65535) continue;
            if (TryPort(port) > 0) return port;
        }
        return -1;
    }

    public int Probe()
    {
        foreach (int port in Ports)
        {
            // 本机对已关闭端口的 TCP 连接拒绝可能要等 ~2s, 先做一次快速连接探测跳过死端口
            if (!IsListening(port)) continue;
            int hit = TryPort(port);
            if (hit > 0) return hit;
        }
        return -1;
    }

    // 快速 TCP 连接测试: 端口无监听者时立即返回 false (不等系统连接超时)
    bool IsListening(int port)
    {
        try
        {
            using (var tcp = new TcpClient())
            {
                var ar = tcp.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(200)) { tcp.Close(); return false; }
                try { tcp.EndConnect(ar); return true; }
                catch { return false; }
            }
        }
        catch { return false; }
    }

    int TryPort(int port)
    {
        try
        {
            using (var wc = new TimedWebClient(1500)) // 非我方监听者不响应时快速跳过, 避免卡住
            {
                wc.Encoding = Encoding.UTF8;
                string s = wc.DownloadString("http://127.0.0.1:" + port + "/api/values");
                // 仅当响应当真是本修改器的 host (JSON 含 name 字段) 才接受该端口
                if (s != null && s.Contains("name")) return port;
            }
        }
        catch { }
        return -1;
    }
}

// WebClient 无 Timeout 属性, 子类化以设置请求超时 (避免 host 无响应时 UI 卡死)
class TimedWebClient : WebClient
{
    readonly int _ms;
    public TimedWebClient(int ms) { _ms = ms; }
    protected override WebRequest GetWebRequest(Uri address)
    {
        WebRequest wr = base.GetWebRequest(address);
        if (wr != null) wr.Timeout = _ms;
        return wr;
    }
}

class MainForm : Form
{
    const int WM_HOTKEY = 0x0312;
    const int HotKeyId = 1;
    const int VK_OEM3 = 0xC0; // 反引号 ` 键

    bool _allowExit = false;
    System.Windows.Forms.Timer _gameWatcher = null;

    int _port;
    readonly TabControl _tabs = new TabControl();
    readonly TableLayoutPanel _resTable = new TableLayoutPanel();

    public MainForm(int port)
    {
        _port = port;
        Text = "失落城堡2 修改器 | 按 ` 键隐藏/显示窗口";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(540, 560);
        MinimumSize = new Size(520, 400);
        TopMost = true;
        // 去掉标题栏的最小化/最大化/关闭按钮: 只能用快捷键呼出/隐藏
        ControlBox = false;
        if (!RegisterHotKey(Handle, HotKeyId, 0, VK_OEM3))
        {
            string msg = "注册全局热键 (反引号键 `) 失败。可能是其他程序占用了该快捷键，或权限不足。\n\n修改器窗口仍可使用，但无法用 ` 键呼出/隐藏。";
            try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "winpanel_err.log"), DateTime.Now.ToString("HH:mm:ss") + " RegisterHotKey 失败" + Environment.NewLine); } catch { }
            MessageBox.Show(msg, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        _tabs.Dock = DockStyle.Fill;
        Controls.Add(_tabs);

        _gameWatcher = new System.Windows.Forms.Timer { Interval = 1500 };
        _gameWatcher.Tick += (s, e) => CheckGameClosed();
        _gameWatcher.Start();

        var closeBtn = new Button
        {
            Text = "关闭修改器",
            Dock = DockStyle.Bottom,
            Height = 32
        };
        closeBtn.Click += (s, e) => CloseTrainer();
        Controls.Add(closeBtn);

        BuildResTab();
        BuildItemTab();
        BuildStatTab();

        if (_port > 0)
        {
            RefreshValues();
            RefreshStats();
        }
        else
        {
            // host 还在后台启动中: 标题栏提示, 数据区等就绪后刷新
            Text = "失落城堡2 修改器 | 连接中... (按 ` 键隐藏/显示窗口)";
        }
    }

    // 后台线程启动 host 成功后的回调 (UI 线程)
    public void SetHostReady(int port)
    {
        _port = port;
        Text = "失落城堡2 修改器 | 按 ` 键隐藏/显示窗口";
        try
        {
            RefreshValues();
            RefreshStats();
        }
        catch (Exception ex)
        {
            try { File.AppendAllText(Path.Combine(Path.GetTempPath(), "winpanel_err.log"), DateTime.Now.ToString("HH:mm:ss") + " 首次刷新失败: " + ex + Environment.NewLine); } catch { }
        }
    }

    // 后台启动 host 失败回调 (UI 线程)
    public void HostFailed(string message)
    {
        Text = "失落城堡2 修改器 | 连接失败";
        MessageBox.Show("无法启动 host.js: " + message, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Error);
        CloseTrainer();
    }

    void CloseTrainer()
    {
        _allowExit = true;
        HostPoller.StopHost();
        Close();
    }

    // 游戏进程消失 → 自动关闭面板 (与点"关闭修改器"行为一致)
    void CheckGameClosed()
    {
        try
        {
            Process[] procs = Process.GetProcessesByName("LostCastle2");
            if (procs.Length == 0)
                CloseTrainer();
        }
        catch { } // 权限/进程枚举异常时忽略, 下一次轮询再试
    }

    // ---------- HTTP 辅助 ----------
    string GetJson(string path)
    {
        using (var wc = new TimedWebClient(5000))
        {
            wc.Encoding = Encoding.UTF8;
            return wc.DownloadString("http://127.0.0.1:" + _port + path);
        }
    }
    string PostJson(string path, string json)
    {
        using (var wc = new TimedWebClient(5000))
        {
            wc.Encoding = Encoding.UTF8;
            wc.Headers[HttpRequestHeader.ContentType] = "application/json";
            return wc.UploadString("http://127.0.0.1:" + _port + path, json);
        }
    }

    // ---------- 资源区块 ----------
    void BuildResTab()
    {
        var tab = new TabPage("资源");
        tab.AutoScroll = true;
        _resTable.Dock = DockStyle.Top;
        _resTable.AutoSize = true;
        _resTable.ColumnCount = 4;
        _resTable.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 30));
        _resTable.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        _resTable.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        _resTable.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 20));
        tab.Controls.Add(_resTable);
        _tabs.TabPages.Add(tab);
        BuildResRow("coin", "金币");
        BuildResRow("crystal", "魂晶");
        BuildResRow("ironPowder", "魔铁锭");
        BuildResRow("exchangeStone", "虚灵通票");
        BuildResRow("refreshPassive", "刷新币·宝藏");
    }

    void BuildResRow(string name, string label)
    {
        int row = _resTable.RowCount++;
        _resTable.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        var lb = new Label { Text = label, TextAlign = ContentAlignment.MiddleLeft, Dock = DockStyle.Fill, AutoSize = false };
        var cur = new Label { Text = "...", TextAlign = ContentAlignment.MiddleRight, Dock = DockStyle.Fill, AutoSize = false };
        cur.Tag = name;
        var input = new TextBox { Dock = DockStyle.Fill };
        input.Tag = name;
        var btn = new Button { Text = "修改", Dock = DockStyle.Fill };
        btn.Tag = name;
        btn.Click += (s, e) => SetResource((string)((Control)s).Tag, input.Text, (Label)cur);
        _resTable.Controls.Add(lb, 0, row);
        _resTable.Controls.Add(cur, 1, row);
        _resTable.Controls.Add(input, 2, row);
        _resTable.Controls.Add(btn, 3, row);
    }

    void SetResource(string name, string text, Label cur)
    {
        try
        {
            long val = long.Parse(text.Trim());
            string resp = PostJson("/api/set", "{\"name\":\"" + name + "\",\"value\":" + val + "}");
            string ok = FindJsonField(resp, "ok");
            if (ok == "true")
            {
                string v = FindJsonField(resp, "value");
                cur.Text = "当前: " + v;
            }
            else
            {
                string err = FindJsonField(resp, "error");
                MessageBox.Show("修改失败: " + err, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("输入无效或请求失败: " + ex.Message, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    void RefreshValues()
    {
        try
        {
            string json = GetJson("/api/values");
            foreach (Control c in _resTable.Controls)
            {
                if (c is Label && c.Tag != null)
                {
                    string name = (string)c.Tag;
                    string v = ExtractFieldValue(json, "name", name);
                    if (v != null)
                    {
                        string val = ExtractFieldValue(v, "value");
                        c.Text = val != null ? "当前: " + val : "...";
                    }
                }
            }
        }
        catch { }
    }

    // 简易 JSON 字段提取 (仅用于 host 返回的扁平结构; 不引入 JSON 依赖)
    string FindJsonField(string json, string field)
    {
        int i = json.IndexOf("\"" + field + "\"");
        if (i < 0) return null;
        i = json.IndexOf(':', i + field.Length + 2);
        if (i < 0) return null;
        i++;
        while (i < json.Length && (json[i] == ' ' || json[i] == '\t' || json[i] == '\n' || json[i] == '\r')) i++;
        if (i < json.Length && json[i] == '"')
        {
            int j = i + 1;
            var sb = new StringBuilder();
            while (j < json.Length && json[j] != '"')
            {
                if (json[j] == '\\' && j + 1 < json.Length) { sb.Append(json[j + 1]); j += 2; }
                else { sb.Append(json[j]); j++; }
            }
            return sb.ToString();
        }
        int k = i;
        while (k < json.Length && (char.IsDigit(json[k]) || json[k] == '-' || json[k] == '.' || json[k] == 'e' || json[k] == 'E')) k++;
        if (k > i) return json.Substring(i, k - i);
        // JSON 布尔/null 字面量: true / false / null
        foreach (string lit in new string[] { "true", "false", "null" })
        {
            if (json.IndexOf(lit, i, StringComparison.Ordinal) == i)
                return lit;
        }
        return "";
    }

    // 在数组元素中按字段=值定位并返回该元素的原始子串
    string ExtractFieldValue(string json, string field, string value)
    {
        string needle = "\"" + field + "\":\"" + value + "\"";
        int i = json.IndexOf(needle);
        if (i < 0) return null;
        int start = json.LastIndexOf('{', i);
        int end = json.IndexOf('}', i);
        if (start < 0 || end < 0 || end <= start) return json;
        return json.Substring(start, end - start + 1);
    }

    // 直接在该元素子串/对象内取某字段值
    string ExtractFieldValue(string element, string field)
    {
        if (element == null) return null;
        bool isObj = element.TrimStart().StartsWith("{");
        string scope = isObj ? element : "{" + element + "}";
        return FindJsonField(scope, field);
    }

    // ---------- 物品区块 ----------
    class ItemInfo
    {
        public string Id;
        public string Name;
        public string TypeLabel;
        public string Display;
    }
    readonly System.Collections.Generic.List<ItemInfo> _allItems = new System.Collections.Generic.List<ItemInfo>();
    readonly ListBox _itemList = new ListBox();
    TextBox _itemSearch = null;

    void BuildItemTab()
    {
        var tab = new TabPage("物品");
        tab.Padding = new Padding(8);

        // 顶部操作栏: 搜索框 + 刷新 + 数量 + 添加按钮 (FlowLayout 自动换行, 永不裁剪)
        var top = new FlowLayoutPanel
        {
            Dock = DockStyle.Top,
            Height = 40,
            AutoScroll = false,
            WrapContents = false,
            Padding = new Padding(0, 4, 0, 4)
        };

        var search = new TextBox { Width = 200, Margin = new Padding(0, 0, 8, 0) };
        _itemSearch = search;
        search.TextChanged += (s, e) => ApplyFilter();

        var refreshBtn = new Button { Text = "刷新物品", Width = 90, Margin = new Padding(0, 0, 8, 0) };
        refreshBtn.Click += (s, e) => RefreshItems();

        var qty = new NumericUpDown { Width = 70, Minimum = 1, Maximum = 99, Value = 1, Margin = new Padding(0, 0, 8, 0) };

        var addBtn = new Button { Text = "添加物品", Width = 100, BackColor = System.Drawing.Color.LightGreen };
        addBtn.Click += (s, e) => SpawnSelected(qty);

        top.Controls.Add(search);
        top.Controls.Add(refreshBtn);
        top.Controls.Add(qty);
        top.Controls.Add(addBtn);

        // 物品列表占满剩余空间
        _itemList.Dock = DockStyle.Fill;

        tab.Controls.Add(_itemList);
        tab.Controls.Add(top);
        _tabs.TabPages.Add(tab);
    }

    void RefreshItems()
    {
        try
        {
            _allItems.Clear();
            _itemList.Items.Clear();
            string json = GetJson("/api/items");
            // 形如 [{ "id":"...","name":"...","typeLabel":"..." }, ...] 逐项解析
            int pos = 0;
            while (pos < json.Length)
            {
                int start = json.IndexOf('{', pos);
                if (start < 0) break;
                int end = json.IndexOf('}', start);
                if (end < 0) break;
                string el = json.Substring(start, end - start + 1);
                string id = FindJsonField(el, "id");
                string name = FindJsonField(el, "name");
                string type = FindJsonField(el, "typeLabel");
                if (id != null)
                {
                    var it = new ItemInfo { Id = id, Name = name ?? "(无名称)", TypeLabel = type ?? "" };
                    it.Display = it.Name + " [" + it.TypeLabel + "] " + it.Id;
                    _allItems.Add(it);
                }
                pos = end + 1;
            }
            ApplyFilter();
        }
        catch (Exception ex)
        {
            MessageBox.Show("加载物品失败: " + ex.Message, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    void ApplyFilter()
    {
        _itemList.Items.Clear();
        string kw = _itemSearch != null ? _itemSearch.Text.Trim().ToLowerInvariant() : "";
        foreach (ItemInfo it in _allItems)
        {
            if (kw.Length == 0 || it.Display.ToLowerInvariant().IndexOf(kw) >= 0)
                _itemList.Items.Add(it.Display);
        }
    }

    void SpawnSelected(NumericUpDown qty)
    {
        if (_itemList.SelectedItem == null)
        {
            MessageBox.Show("请先在列表中选择一个物品", "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }
        string display = (string)_itemList.SelectedItem;
        ItemInfo hit = _allItems.Find(it => it.Display == display);
        if (hit == null) return;
        int n = (int)qty.Value;
        try
        {
            string resp = PostJson("/api/spawn", "{\"id\":\"" + hit.Id + "\",\"count\":" + n + "}");
            string spawned = FindJsonField(resp, "spawned");
            string err = FindJsonField(resp, "error");
            string ok = FindJsonField(resp, "ok");
            if (ok == "true" && (err == null || err == "null" || err.Length == 0))
                MessageBox.Show("已掉落 " + hit.Name + " x" + (spawned ?? n.ToString()), "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Information);
            else
                MessageBox.Show("生成失败: " + (err ?? "未知错误"), "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            MessageBox.Show("请求失败: " + ex.Message, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    // ---------- 属性区块 ----------
    readonly Panel _statArea = new Panel();
    readonly System.Collections.Generic.Dictionary<string, Label> _statLbls = new System.Collections.Generic.Dictionary<string, Label>();
    readonly System.Collections.Generic.Dictionary<string, TextBox> _statInputs = new System.Collections.Generic.Dictionary<string, TextBox>();

    void BuildStatTab()
    {
        var tab = new TabPage("属性");
        tab.Padding = new Padding(8);

        var refreshBtn = new Button { Text = "刷新属性", Width = 90 };
        refreshBtn.Click += (s, e) => RefreshStats();
        var resetBtn = new Button { Text = "重置为装备数值", Width = 120 };
        resetBtn.Click += (s, e) => ResetStats();
        refreshBtn.Anchor = AnchorStyles.Top | AnchorStyles.Left;
        resetBtn.Anchor = AnchorStyles.Top | AnchorStyles.Left;

        _statArea.Left = 0;
        _statArea.Width = tab.ClientSize.Width;
        _statArea.Top = 40;
        _statArea.Height = Math.Max(100, tab.ClientSize.Height - 48);
        _statArea.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        _statArea.AutoScroll = true;

        tab.Controls.Add(_statArea);
        tab.Controls.Add(refreshBtn);
        tab.Controls.Add(resetBtn);
        refreshBtn.Location = new Point(8, 8);
        resetBtn.Location = new Point(100, 8);
        _tabs.TabPages.Add(tab);
    }

    void RefreshStats()
    {
        try
        {
            string json = GetJson("/api/stats");
            // 解析 [{name,label,value,max}, ...]
            var rows = new System.Collections.Generic.List<string[]>();
            int pos = 0;
            while (pos < json.Length)
            {
                int start = json.IndexOf('{', pos);
                if (start < 0) break;
                int end = json.IndexOf('}', start);
                if (end < 0) break;
                string el = json.Substring(start, end - start + 1);
                string name = FindJsonField(el, "name");
                string label = FindJsonField(el, "label");
                string value = FindJsonField(el, "value");
                string max = FindJsonField(el, "max");
                if (name != null) rows.Add(new string[] { name, label, value, max });
                pos = end + 1;
            }
            EnsureStatRows(rows);
            foreach (string[] row in rows)
            {
                Label cur;
                if (_statLbls.TryGetValue(row[0], out cur))
                {
                    string maxTxt = row[3] != null ? " / 上限: " + row[3] : "";
                    cur.Text = "当前: " + (row[2] == null ? "?" : row[2]) + maxTxt;
                }
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("读取属性失败: " + ex.Message, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    void EnsureStatRows(System.Collections.Generic.List<string[]> rows)
    {
        if (_statLbls.Count > 0) return;
        _statArea.SuspendLayout();
        int y = 4;
        foreach (string[] row in rows)
        {
            string name = row[0], label = row[1];
            var lb = new Label { Text = label, Left = 4, Top = y, Width = 90, AutoSize = false };
            var cur = new Label { Text = "...", Left = 96, Top = y, Width = 150, AutoSize = false };
            var input = new TextBox { Left = 248, Top = y - 2, Width = 80 };
            var btn = new Button { Text = "修改", Left = 334, Top = y - 2, Width = 50 };
            btn.Click += (s, e) => SetStat(name, input.Text);
            _statArea.Controls.Add(lb);
            _statArea.Controls.Add(cur);
            _statArea.Controls.Add(input);
            _statArea.Controls.Add(btn);
            _statLbls[name] = cur;
            _statInputs[name] = input;
            y += 32;
        }
        _statArea.ResumeLayout();
    }

    void SetStat(string name, string text)
    {
        try
        {
            double val = double.Parse(text.Trim());
            string resp = PostJson("/api/setstat", "{\"name\":\"" + name + "\",\"value\":" + val.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}");
            string ok = FindJsonField(resp, "ok");
            if (ok == "true")
            {
                RefreshStats();
            }
            else
            {
                MessageBox.Show("修改失败: " + (FindJsonField(resp, "error") ?? "未知错误"), "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }
        catch (Exception ex)
        {
            MessageBox.Show("输入无效或请求失败: " + ex.Message, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    void ResetStats()
    {
        try
        {
            string resp = PostJson("/api/resetstats", "{}");
            string ok = FindJsonField(resp, "ok");
            string changed = FindJsonField(resp, "changed");
            if (ok == "true")
                MessageBox.Show("已重置属性" + (changed != null ? ": " + changed : ""), "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Information);
            else
                MessageBox.Show("重置失败: " + (FindJsonField(resp, "error") ?? "未知错误"), "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            MessageBox.Show("请求失败: " + ex.Message, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_HOTKEY && (int)m.WParam == HotKeyId)
            Visible = !Visible;
        base.WndProc(ref m);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        // 只有点了"关闭修改器"按钮才真正退出; 其他关闭途径(Alt+F4等)一律拦截
        if (!_allowExit)
        {
            e.Cancel = true;
            WindowState = FormWindowState.Minimized;
            return;
        }
        base.OnFormClosing(e);
    }

    protected override void OnFormClosed(FormClosedEventArgs e)
    {
        if (_gameWatcher != null) { _gameWatcher.Stop(); _gameWatcher.Dispose(); }
        UnregisterHotKey(Handle, HotKeyId);
        base.OnFormClosed(e);
    }

    [DllImport("user32.dll")]
    static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")]
    static extern bool UnregisterHotKey(IntPtr hWnd, int id);
}