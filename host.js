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
        console.error("[host] GAME_NOT_FOUND 未找到进程 " + TARGET + " , 请先启动游戏");
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

    // 本地 HTTP API (供 WinPanel.exe 调用)
    const server = http.createServer(async (req, res) => {
        const url = req.url || "/";
        try {
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
