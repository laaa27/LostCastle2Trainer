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
    public MainForm(int port)
    {
        _port = port;
        Text = "失落城堡2 修改器";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(480, 300);
        TopMost = true;
        RegisterHotKey(Handle, HotKeyId, 0, VK_F12);

        var label = new Label
        {
            Text = "面板已就绪 - 游戏中按 F12 呼出/收起",
            AutoSize = false,
            TextAlign = ContentAlignment.MiddleCenter,
            Dock = DockStyle.Fill
        };
        Controls.Add(label);
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