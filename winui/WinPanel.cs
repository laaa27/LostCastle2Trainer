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
    [STAThread]
    static int Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        int port;
        try { port = new HostPoller().EnsureHost(); }
        catch (Exception ex)
        {
            MessageBox.Show("无法启动 host.js: " + ex.Message, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        Application.Run(new MainForm(port));
        return 0;
    }
}

class HostPoller
{
    static readonly int[] Ports = { 8899, 9599, 9800 };

    public int EnsureHost()
    {
        int p = Probe();
        if (p > 0) return p;
        // exe 位于 winui\ 下, host.js 在仓库根 (winui 的父目录)
        string root = Directory.GetParent(Application.ExecutablePath).FullName;
        var psi = new ProcessStartInfo("node", "host.js")
        {
            WorkingDirectory = root
        };
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

class MainForm : Form
{
    const int WM_HOTKEY = 0x0312;
    const int HotKeyId = 1;
    const int VK_F12 = 0x7B;

    readonly int _port;
    readonly TabControl _tabs = new TabControl();
    readonly TableLayoutPanel _resTable = new TableLayoutPanel();

    public MainForm(int port)
    {
        _port = port;
        Text = "失落城堡2 修改器";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(520, 560);
        MinimumSize = new Size(420, 400);
        TopMost = true;
        RegisterHotKey(Handle, HotKeyId, 0, VK_F12);

        _tabs.Dock = DockStyle.Fill;
        Controls.Add(_tabs);

        BuildResTab();
        BuildItemTab();
        BuildStatTab();

        RefreshValues();
    }

    // ---------- HTTP 辅助 ----------
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
        return json.Substring(i, k - i);
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

        var search = new TextBox { Width = 220, Top = 8, Left = 8 };
        _itemSearch = search;
        search.TextChanged += (s, e) => ApplyFilter();
        var refreshBtn = new Button { Text = "刷新物品", Width = 80, Top = 8, Left = 236 };
        refreshBtn.Click += (s, e) => RefreshItems();

        _itemList.Left = 8;
        _itemList.Top = 40;
        _itemList.Width = 340;
        _itemList.Height = 300;
        _itemList.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left;

        var qty = new NumericUpDown { Left = 360, Top = 40, Width = 80, Minimum = 1, Maximum = 99, Value = 1 };
        qty.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        var spawnBtn = new Button { Text = "生成掉落", Left = 360, Top = 70, Width = 80 };
        spawnBtn.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        spawnBtn.Click += (s, e) => SpawnSelected(qty);

        tab.Controls.Add(search);
        tab.Controls.Add(refreshBtn);
        tab.Controls.Add(_itemList);
        tab.Controls.Add(qty);
        tab.Controls.Add(spawnBtn);
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
            if (ok == "true" && err == null)
                MessageBox.Show("已掉落 " + hit.Name + " x" + (spawned ?? n.ToString()), "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Information);
            else
                MessageBox.Show("生成失败: " + (err ?? "未知错误"), "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        catch (Exception ex)
        {
            MessageBox.Show("请求失败: " + ex.Message, "失落城堡2 修改器", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    // ---------- 属性区块 (Task 5 填充) ----------
    void BuildStatTab()
    {
        var tab = new TabPage("属性");
        var lbl = new Label { Text = "属性功能开发中", AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter };
        tab.Controls.Add(lbl);
        _tabs.TabPages.Add(tab);
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