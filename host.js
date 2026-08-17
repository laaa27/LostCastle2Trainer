// host.js
// 附加到 LostCastle2.exe, 加载编译后的 agent, 并启动本地 HTTP 面板后端
// 面板 UI 由 winui\WinPanel.exe (原生窗口) 提供
const frida = require("frida");
const fs = require("fs");
const path = require("path");
const http = require("http");

const TARGET = "LostCastle2.exe";
const AGENT_FILE = path.join(__dirname, "dist", "agent.js");
const PANEL_PORT = parseInt(process.env.LC2_PANEL_PORT || "8899", 10);

let script = null;

// 读取请求体 (Promise 化, 让 POST 处理回到外层 try/catch 覆盖范围)
function readBody(req) {
    return new Promise((resolve) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => resolve(body));
    });
}

// 自动回退端口序列: 首选 → 8899 → 9599 → 9800 → 系统随机分配 (0)
// 端口可能被系统动态保留 (EACCES, 如 Hyper-V/WinNAT 排除范围) 或已被占用 (EADDRINUSE)
function buildFallbackPorts(preferred) {
    const first = Number.isInteger(preferred) && preferred > 0 && preferred < 65536 ? preferred : 8899;
    return [...new Set([first, 8899, 9599, 9800, 0])];
}

// 尝试按顺序监听, 端口不可用时自动换下一个; resolve 实际监听端口
function listenWithFallback(server, ports) {
    return new Promise((resolve, reject) => {
        let idx = 0;
        const tryNext = () => {
            if (idx >= ports.length) {
                reject(new Error("所有端口均不可用"));
                return;
            }
            const port = ports[idx++];
            const label = port === 0 ? "(随机端口)" : port;
            const onError = (err) => {
                server.removeListener("listening", onListening);
                if (err.code === "EACCES" || err.code === "EADDRINUSE") {
                    console.log("[host] 端口 " + label + " 不可用 (" + err.code + ")，尝试下一个...");
                    tryNext();
                } else {
                    reject(err);
                }
            };
            const onListening = () => {
                server.removeListener("error", onError);
                resolve(server.address().port);
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(port, "127.0.0.1");
        };
        tryNext();
    });
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>失落城堡2 修改器</title>
<style>
  body { font-family: "Microsoft YaHei", sans-serif; background: #1a1a2e; color: #eee; margin: 0; padding: 24px; }
  h1 { font-size: 22px; color: #e94560; margin: 0 0 4px; }
  .sub { color: #888; font-size: 12px; margin-bottom: 20px; }
  .row { display: flex; align-items: center; gap: 12px; background: #16213e; padding: 12px 16px; border-radius: 8px; margin-bottom: 10px; }
  .name { width: 140px; font-size: 15px; }
  .cur { width: 120px; color: #4ecdc4; font-size: 14px; text-align: right; }
  input { width: 150px; padding: 8px 10px; border-radius: 6px; border: 1px solid #333; background: #0f3460; color: #eee; font-size: 14px; }
  input::-webkit-outer-spin-button, input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  input[type=number] { -moz-appearance: textfield; }
  button { padding: 8px 18px; border-radius: 6px; border: none; background: #e94560; color: #fff; font-size: 14px; cursor: pointer; }
  button:hover { background: #c8334d; }
  .section-title { font-size: 18px; color: #e94560; margin: 24px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #333; }
  .item-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .item-bar input { flex: 1; }
  .item-bar button { background: #4ecdc4; color: #16213e; }
  .item-bar button:hover { background: #3db5ad; }
  .item-list { max-height: 420px; overflow-y: auto; border: 1px solid #333; border-radius: 8px; padding: 8px; background: #10152b; }
  .item-row { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 6px; cursor: pointer; }
  .item-row:hover { background: #1b2a4a; }
  .item-row.selected { background: #2a3f6b; }
  .item-id { color: #888; font-size: 11px; width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .item-type { color: #f0a500; font-size: 12px; width: 50px; }
  .item-name { flex: 1; font-size: 14px; }
  .add-btn { padding: 4px 12px; border-radius: 6px; border: none; background: #e94560; color: #fff; font-size: 12px; cursor: pointer; }
  .add-btn:hover { background: #c8334d; }
  .qty-input { width: 60px; padding: 4px 6px; border-radius: 6px; border: 1px solid #333; background: #0f3460; color: #eee; font-size: 12px; }
  .qty-input::-webkit-outer-spin-button, .qty-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
  .status { position: fixed; bottom: 0; left: 0; right: 0; padding: 8px 24px; background: #16213e; border-top: 1px solid #333; font-size: 13px; color: #aaa; }
  .status.ok { color: #4ecdc4; }
  .status.err { color: #e94560; }
</style>
</head>
<body>
  <h1>失落城堡2 修改器</h1>
  <div class="sub">输入目标数量后点击「修改」。金币会同时写入存档；魂晶/魔铁锭/虚灵硬币/刷新币仅修改本局数据。</div>
  <div id="list"></div>

  <div class="section-title">装备 / 宝藏 / 道具</div>
  <div class="item-bar">
    <input type="text" id="item-search" placeholder="搜索名称或ID...">
    <input type="number" class="qty-input" id="item-qty" value="1" min="1" max="99" title="每次添加数量">
    <button onclick="loadItems()">加载物品</button>
  </div>
  <div class="item-list" id="item-list"></div>

  <div class="section-title">玩家属性</div>
  <div id="stat-list"></div>
  <div style="margin-top:10px; display:flex; gap:12px; align-items:center;">
    <button onclick="refreshStats()" style="background:#4ecdc4;color:#16213e;">刷新属性</button>
    <button id="reset-stats-btn" style="background:#ff6b6b;color:#fff;">重置为装备数值</button>
    <span class="sub" style="margin:0;">重置: 恢复首次打开面板时的数值(含装备); 属性通过 StatValueAgent 写入，进关卡生效</span>
  </div>

  <div class="status" id="status">连接中...</div>
<script>
  const list = document.getElementById("list");
  const status = document.getElementById("status");
  let rows = {};

  function setStatus(text, cls) {
    status.textContent = text;
    status.className = "status" + (cls ? " " + cls : "");
  }

  function buildRows(data) {
    list.innerHTML = "";
    rows = {};
    data.forEach((item) => {
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("span"); name.className = "name"; name.textContent = item.label;
      const cur = document.createElement("span"); cur.className = "cur"; cur.textContent = "当前: " + item.value;
      const input = document.createElement("input");
      input.type = "number"; input.min = "0"; input.value = item.value;
      const btn = document.createElement("button");
      btn.textContent = "修改";
      btn.onclick = async () => {
        setStatus("正在修改 " + item.label + " ...");
        try {
          const res = await fetch("/api/set", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: item.name, value: parseInt(input.value, 10) })
          });
          const d = await res.json();
          if (d.ok) {
            cur.textContent = d.value;
            setStatus("已修改 " + item.label + " -> " + d.value, "ok");
          } else {
            setStatus("修改失败: " + (d.error || "未知错误"), "err");
          }
        } catch (e) {
          setStatus("请求失败: " + e.message, "err");
        }
      };
      row.appendChild(name); row.appendChild(cur); row.appendChild(input); row.appendChild(btn);
      list.appendChild(row);
      rows[item.name] = cur;
    });
  }

  async function refreshValues() {
    try {
      const r = await fetch("/api/values");
      const data = await r.json();
      if (Object.keys(rows).length === 0) {
        buildRows(data);
      } else {
        data.forEach((item) => {
          const el = rows[item.name];
          if (el) el.textContent = "当前: " + item.value;
        });
      }
      setStatus("已连接，游戏内背包就绪", "ok");
    } catch (e) {
      setStatus("读取失败: " + e.message, "err");
    }
  }

  setInterval(refreshValues, 3000);
  refreshValues();

  // === 装备/宝藏 ===
  const itemListEl = document.getElementById("item-list");
  const itemSearchEl = document.getElementById("item-search");
  const itemQtyEl = document.getElementById("item-qty");
  let allItems = [];

  async function loadItems() {
    setStatus("正在加载物品列表...");
    try {
      const r = await fetch("/api/items");
      allItems = await r.json();
      setStatus("已加载 " + allItems.length + " 件物品，输入关键词过滤", "ok");
      renderItems();
    } catch (e) {
      setStatus("加载物品失败: " + e.message, "err");
    }
  }

  function renderItems() {
    const kw = itemSearchEl.value.trim().toLowerCase();
    itemListEl.innerHTML = "";
    const filtered = allItems.filter((it) => {
      if (!kw) return true;
      return it.name.toLowerCase().indexOf(kw) !== -1 || it.id.toLowerCase().indexOf(kw) !== -1;
    });
    filtered.forEach((it) => {
      const row = document.createElement("div");
      row.className = "item-row";
      const type = document.createElement("span"); type.className = "item-type"; type.textContent = it.typeLabel;
      const name = document.createElement("span"); name.className = "item-name"; name.textContent = it.name || "(无名称)";
      const id = document.createElement("span"); id.className = "item-id"; id.textContent = it.id;
      const qty = document.createElement("input");
      qty.type = "number"; qty.className = "qty-input"; qty.value = "1"; qty.min = "1"; qty.max = "99";
      const btn = document.createElement("button"); btn.className = "add-btn"; btn.textContent = "添加";
      btn.onclick = async () => {
        const n = parseInt(qty.value, 10) || 1;
        setStatus("正在生成 " + (it.name || it.id) + " x" + n + " ...");
        try {
          const res = await fetch("/api/spawn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: it.id, count: n })
          });
          const d = await res.json();
          if (d.ok) setStatus("已掉落 " + (it.name || it.id) + " x" + n + "，走到附近拾取", "ok");
          else setStatus("生成失败: " + (d.error || "未知错误"), "err");
        } catch (e) {
          setStatus("请求失败: " + e.message, "err");
        }
      };
      row.appendChild(type); row.appendChild(name); row.appendChild(id); row.appendChild(qty); row.appendChild(btn);
      itemListEl.appendChild(row);
    });
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.className = "item-row"; empty.textContent = "无匹配物品";
      itemListEl.appendChild(empty);
    }
  }

  itemSearchEl.addEventListener("input", renderItems);

  // === 玩家属性 ===
  const statListEl = document.getElementById("stat-list");
  let statRows = {};

  function buildStatRows(data) {
    statListEl.innerHTML = "";
    statRows = {};
    data.forEach((item) => {
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("span"); name.className = "name"; name.textContent = item.label;
      const cur = document.createElement("span"); cur.className = "cur"; cur.textContent = "当前: " + (item.value == null ? "?" : item.value) + (item.max != null ? " / 上限: " + item.max : "");
      const input = document.createElement("input");
      input.type = "number"; input.min = "0"; input.step = "any"; input.value = item.value == null ? "" : item.value;
      const btn = document.createElement("button");
      btn.textContent = "修改";
      btn.onclick = async () => {
        setStatus("正在修改 " + item.label + " ...");
        try {
          const res = await fetch("/api/setstat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: item.name, value: parseFloat(input.value) })
          });
          const d = await res.json();
          if (d.ok) {
            setStatus("已修改 " + item.label, "ok");
            refreshStats();
          } else {
            setStatus("修改失败: " + (d.error || "未知错误"), "err");
          }
        } catch (e) {
          setStatus("请求失败: " + e.message, "err");
        }
      };
      row.appendChild(name); row.appendChild(cur); row.appendChild(input); row.appendChild(btn);
      statListEl.appendChild(row);
      statRows[item.name] = cur;
    });
  }

  async function refreshStats() {
    try {
      const r = await fetch("/api/stats");
      const data = await r.json();
      if (Array.isArray(data)) {
        if (Object.keys(statRows).length === 0) {
          buildStatRows(data);
        } else {
          data.forEach((item) => {
            const el = statRows[item.name];
            if (el) el.textContent = "当前: " + (item.value == null ? "?" : item.value) + (item.max != null ? " / 上限: " + item.max : "");
          });
        }
      }
    } catch (e) {
      setStatus("读取属性失败: " + e.message, "err");
    }
  }

  document.getElementById("reset-stats-btn").addEventListener("click", async () => {
    setStatus("正在重置属性...");
    try {
      const res = await fetch("/api/resetstats", { method: "POST" });
      const d = await res.json();
      if (d.ok) {
        setStatus("已重置属性: " + (d.changed || []).join(", "), "ok");
        refreshStats();
      } else {
        setStatus("重置失败: " + (d.error || "未知错误"), "err");
      }
    } catch (e) {
      setStatus("请求失败: " + e.message, "err");
    }
  });

  refreshStats();
</script>
</body>
</html>`;

(async () => {
    if (!fs.existsSync(AGENT_FILE)) {
        console.error("[host] 缺少编译产物 " + AGENT_FILE + " , 请先运行 npm run build");
        process.exit(1);
    }

    let proc = null;
    try {
        const device = await frida.getLocalDevice();
        const list = await device.enumerateProcesses();
        proc = list.find((p) => p.name === TARGET);
    } catch (e) {
        console.error("[host] 枚举进程失败: " + e.message);
        process.exit(1);
    }
    if (!proc) {
        console.error("[host] 未找到进程 " + TARGET + " , 请先启动游戏");
        process.exit(1);
    }
    console.log("[host] 附加到 " + TARGET + " (PID " + proc.pid + ") ...");

    let session;
    try {
        session = await frida.attach(proc.pid);
    } catch (e) {
        console.error("[host] 附加失败: " + e.message);
        process.exit(1);
    }

    const source = fs.readFileSync(AGENT_FILE, "utf8");
    script = await session.createScript(source);

    // 游戏退出信号处理: 主动 session.detach() 把 frida 完整卸载出游戏进程
    // (连接断开 ≠ 模块卸载, 残留的 frida-agent 会让游戏退出流程卡死)
    let exiting = false;
    const handleAgentQuit = async () => {
        if (exiting) return;
        exiting = true;
        try {
            await session.detach();
            console.log("[host] 已卸载 frida, 游戏可正常退出");
        } catch (e) {
            console.error("[host] 卸载 frida 失败: " + e.message);
        }
        process.exit(0);
    };

    script.message.connect((message) => {
        if (message.type === "send") {
            if (message.payload === "quit") {
                handleAgentQuit();
                return;
            }
            console.log(message.payload);
        } else if (message.type === "error") {
            console.error("[agent error] " + message.stack);
        }
    });

    await script.load();
    console.log("[host] agent 已加载, 等待 IL2CPP 就绪...");

    const initResult = await script.exports.init();
    if (!initResult.ok) {
        console.error("[host] 初始化失败: " + initResult.error);
    } else {
        console.log("[host] 背包就绪");
    }

    script.destroyed.connect(() => {
        console.log("[host] session 结束");
        if (!exiting) process.exit(0);
    });

    // 本地网页面板
    const server = http.createServer(async (req, res) => {
        const url = req.url || "/";
        try {
            if (url === "/" || url === "/index.html") {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(HTML);
                return;
            }
            if (url === "/api/values") {
                const values = await script.exports.getValues();
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(values));
                return;
            }
            if (url === "/api/set") {
                const body = await readBody(req);
                let parsed = {};
                try { parsed = JSON.parse(body); } catch (e) {}
                const result = await script.exports.setValue(parsed.name, parsed.value);
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(result));
                return;
            }
            if (url === "/api/items") {
                const items = await script.exports.getItems();
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(items));
                return;
            }
            if (url === "/api/spawn") {
                const body = await readBody(req);
                let parsed = {};
                try { parsed = JSON.parse(body); } catch (e) {}
                const count = Math.max(1, Math.min(99, parseInt(parsed.count, 10) || 1));
                // 批量生成: 一次 RPC 处理全部, 共享查询/位置, 统一等待主线程队列
                const items = [];
                for (let i = 0; i < count; i++) items.push({ id: parsed.id, count: 1 });
                const result = await script.exports.spawnItems(items);
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ ok: result.ok, count, spawned: result.spawned, error: result.failed[0] ? result.failed[0].error : null }));
                return;
            }
            if (url === "/api/stats") {
                const stats = await script.exports.getHeroStats();
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(stats));
                return;
            }
            if (url === "/api/setstat") {
                const body = await readBody(req);
                let parsed = {};
                try { parsed = JSON.parse(body); } catch (e) {}
                const result = await script.exports.setHeroStat(parsed.name, parsed.value);
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(result));
                return;
            }
            if (url === "/api/resetstats") {
                const result = await script.exports.resetHeroStat();
                res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify(result));
                return;
            }
            res.writeHead(404); res.end();
        } catch (e) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: e.message }));
        }
    });

    // 尝试监听, 端口被保留/占用时自动回退
    listenWithFallback(server, buildFallbackPorts(PANEL_PORT))
        .then((port) => {
            const url = "http://127.0.0.1:" + port;
            console.log("[host] 修改面板已启动: " + url);
        })
        .catch((err) => {
            console.error("[host] 无法启动网页面板: " + err.message);
        });
})();
