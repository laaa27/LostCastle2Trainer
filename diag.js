// diag.js - 一次性的根因验证脚本
// 附加到 LostCastle2.exe, 加载 dist/agent.js, 依次调用各 RPC, 打印结果后干净 detach
// 用途: 验证 "BagSystem.LateUpdate hook 失败 -> mainThreadQueue 不消费 -> 掉落/HP-MP 超时" 假说
const frida = require("frida");
const fs = require("fs");
const path = require("path");

const TARGET = "LostCastle2.exe";
const AGENT_FILE = path.join(__dirname, "dist", "agent.js");

(async () => {
    const device = await frida.getLocalDevice();
    const list = await device.enumerateProcesses();
    const proc = list.find((p) => p.name === TARGET);
    if (!proc) { console.log("[diag] 未找到游戏进程"); process.exit(1); }
    console.log("[diag] attach PID " + proc.pid);
    const session = await frida.attach(proc.pid);
    const source = fs.readFileSync(AGENT_FILE, "utf8");
    const script = await session.createScript(source);
    script.message.connect((m) => {
        if (m.type === "send") console.log("[agent] " + m.payload);
        else if (m.type === "error") console.error("[agent err] " + m.stack);
    });
    await script.load();
    // 等 Il2Cpp.perform 完成
    await new Promise((r) => setTimeout(r, 1500));

    const e = script.exports;

    try {
        const initRes = await e.init();
        console.log("[diag] init -> " + JSON.stringify(initRes));
    } catch (err) { console.log("[diag] init EX: " + err.message); }

    try {
        const values = await e.getValues();
        console.log("[diag] getValues -> " + JSON.stringify(values));
    } catch (err) { console.log("[diag] getValues EX: " + err.message); }

    // 资源修改: 改魂晶 +100 (net, 不写档), 再读回验证语义校验
    try {
        const before = (await e.getValues()).find((r) => r.name === "crystal");
        const target = (before ? before.value || 0 : 0) + 100;
        const r = await e.setValue("crystal", target);
        const after = (await e.getValues()).find((r) => r.name === "crystal");
        console.log("[diag] setValue crystal " + JSON.stringify(before) + "->" + target + " => " + JSON.stringify(r) + " after=" + JSON.stringify(after));
    } catch (err) { console.log("[diag] setValue crystal EX: " + err.message); }

    let items = [];
    try {
        items = await e.getItems();
        console.log("[diag] getItems count=" + items.length + " first=" + JSON.stringify(items[0]));
    } catch (err) { console.log("[diag] getItems EX: " + err.message); }

    // 生成 1 个掉落 (走 mainThreadQueue)
    if (items.length > 0) {
        try {
            const sid = items[0].id;
            const r = await e.spawnItems([{ id: sid, count: 1 }]);
            console.log("[diag] spawnItems(" + sid + " x1) -> " + JSON.stringify(r));
        } catch (err) { console.log("[diag] spawnItems EX: " + err.message); }
    }

    try {
        const stats = await e.getHeroStats();
        console.log("[diag] getHeroStats -> " + JSON.stringify(stats));
    } catch (err) { console.log("[diag] getHeroStats EX: " + err.message); }

    // 试改一个普通属性 (走同步 SetValueAndSendChangeEvent, 不走队列)
    try {
        const atk = await e.getHeroStats();
        const cur = atk.find((s) => s.name === "atk");
        if (cur && cur.value != null) {
            const target = cur.value + 50;
            const r = await e.setHeroStat("atk", target);
            console.log("[diag] setHeroStat atk " + cur.value + "->" + target + " => " + JSON.stringify(r));
        } else {
            console.log("[diag] atk 读不到, 跳过");
        }
    } catch (err) { console.log("[diag] setHeroStat EX: " + err.message); }

    // 试改 HP (走队列)
    try {
        const stats = await e.getHeroStats();
        const curHp = stats.find((s) => s.name === "curHp");
        if (curHp && curHp.value != null) {
            const target = Math.min(curHp.value + 10, 9999);
            const r = await e.setHeroStat("curHp", target);
            console.log("[diag] setHeroStat curHp " + curHp.value + "->" + target + " => " + JSON.stringify(r));
        } else {
            console.log("[diag] curHp 读不到, 跳过");
        }
    } catch (err) { console.log("[diag] setHeroStat curHp EX: " + err.message); }

    // 试改 MP (走队列)
    try {
        const stats = await e.getHeroStats();
        const curMp = stats.find((s) => s.name === "curMp");
        if (curMp && curMp.value != null) {
            const target = Math.min(curMp.value + 10, 9999);
            const r = await e.setHeroStat("curMp", target);
            console.log("[diag] setHeroStat curMp " + curMp.value + "->" + target + " => " + JSON.stringify(r));
        } else {
            console.log("[diag] curMp 读不到, 跳过");
        }
    } catch (err) { console.log("[diag] setHeroStat curMp EX: " + err.message); }

    // 重置属性回到基线
    try {
        const r = await e.resetHeroStat();
        console.log("[diag] resetHeroStat -> " + JSON.stringify(r));
    } catch (err) { console.log("[diag] resetHeroStat EX: " + err.message); }

    // 干净卸载并退出
    try { await session.detach(); console.log("[diag] detach 完成"); } catch (err) { console.log("[diag] detach EX: " + err.message); }
    process.exit(0);
})();