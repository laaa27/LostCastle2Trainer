// agent.ts 命令模式
// 注入 LostCastle2.exe, 暴露 rpc 接口供 host.js 调用:
//   init()                   初始化并等待背包就绪
//   getValues()              返回各资源当前值
//   setValue(name, value)    将指定资源改为目标数量
// 资源: 金币(local, 同步存档) 魂晶/魔铁锭/虚灵硬币/刷新币(net, 仅运行时)
import "frida-il2cpp-bridge";

const ok = "[\x1b[32mOK\x1b[0m]";
const warn = "[\x1b[33m?\x1b[0m]";
const err = "[\x1b[31m!\x1b[0m]";

function log(msg: string) {
    console.log("[LC2Trainer] " + msg);
}

let core: any = null;
let baseSingleton: any = null;
let bag: any = null;
let mine: any = null;
let oi: any = null;
let heroResources: any = null;
let objClass: any = null;
let initError: string | null = null;
let initDone = false;
let mainThreadQueue: (() => void)[] = [];
let mainThreadHooked = false;
let quitting = false;
let lateUpdateHook: any = null;

const OI_KEY = 1380401675;

const RESOURCES: {
    name: string;
    label: string;
    dict: "local" | "net";
    typeVal: number;
    getter: string;
    syncSave: boolean;
}[] = [
    { name: "coin", label: "金币", dict: "local", typeVal: 5, getter: "get_Coin", syncSave: true },
    { name: "crystal", label: "魂晶", dict: "net", typeVal: 4, getter: "get_Crystal", syncSave: false },
    { name: "ironPowder", label: "魔铁锭", dict: "net", typeVal: 7, getter: "get_IronPowder", syncSave: false },
    { name: "exchangeStone", label: "虚灵通票", dict: "net", typeVal: 52, getter: "get_ExchangeStone", syncSave: false },
    { name: "refreshPassive", label: "刷新币·宝藏", dict: "net", typeVal: 51, getter: "get_Refresh_PassiveProps", syncSave: false },
];

function writeDictKey(dict: any, typeVal: number, val: number): boolean {
    if (!dict || !oi) return false;
    try {
        const enc: any = oi.method("Encrypt").invoke(val, OI_KEY);
        const obscured: any = oi.method("FromEncrypted").invoke(enc, OI_KEY);
        dict.method("set_Item").invoke(typeVal, obscured);
        return true;
    } catch (e: any) {
        log(err + " 写字典失败 key=" + typeVal + ": " + e.message);
        return false;
    }
}

function refreshHUD(): boolean {
    if (!heroResources || !objClass) return false;
    try {
        const finder = objClass.method("FindObjectOfType").overload("System.Type");
        const hero: any = finder.invoke(heroResources.type.object);
        if (hero) {
            hero.method("InitResources").invoke();
            return true;
        }
    } catch (e: any) {
        log(err + " UI 刷新失败: " + e.message);
    }
    return false;
}

// 将 getter 返回值规范化为 number: 兼容 number / 可 toString 的类型 / ACTk ObscuredInt
function toNumber(v: any): number | null {
    if (typeof v === "number") return v;
    if (v === null || v === undefined) return null;
    // ObscuredInt 等混淆类型: 优先调用解密方法
    try {
        const dm = v.method("Decrypt");
        if (dm) {
            const d = dm.invoke();
            const n = typeof d === "number" ? d : parseInt(d.toString(), 10);
            if (!isNaN(n)) return n;
        }
    } catch {}
    try {
        const n = parseInt(v.toString(), 10);
        return isNaN(n) ? null : n;
    } catch {
        return null;
    }
}

function readValue(res: (typeof RESOURCES)[number]): number | null {
    if (!bag) return null;
    try {
        const v: any = bag.method(res.getter).invoke();
        const n = toNumber(v);
        if (n === null) {
            log(warn + " 读取 " + res.name + " 返回非数值(" + (v === null || v === undefined ? "null" : String(v)) + ")");
        }
        return n;
    } catch (e: any) {
        log(err + " 读取 " + res.name + " 失败: " + e.message);
        return null;
    }
}

function setValue(res: (typeof RESOURCES)[number], value: number): boolean {
    if (!bag) return false;
    const dictName = res.dict === "local" ? "_localValueItemDict" : "_netValueItemDict";
    const f = probeField(bag, [dictName]);
    if (!f) { log(err + " 字段 " + dictName + " 不存在"); return false; }
    const dict: any = f.value;
    if (!writeDictKey(dict, res.typeVal, value)) return false;
    if (res.syncSave && mine) {
        try {
            const enc: any = oi.method("Encrypt").invoke(value, OI_KEY);
            const obscured: any = oi.method("FromEncrypted").invoke(enc, OI_KEY);
            mine.method("set_Coin").invoke(obscured);
            mine.field("_coin").value = value;
        } catch (e: any) {
            log(err + " 同步 GameSaveData 失败: " + e.message);
        }
    }
    refreshHUD();
    // 语义校验: 写后读回与目标一致才算成功
    const rb = readValue(res);
    if (rb !== null && Math.abs(rb - value) < 1) {
        return true;
    }
    log(warn + " " + res.label + " 写入后读回不一致 (目标 " + value + ", 读回 " + rb + ")");
    return false;
}

// === 多版本探测层: 逐符号探测 + 语义校验 + 缓存 (放在 bindMethod 之前, TS 声明提升不依赖顺序) ===
function findClass(fullName: string): any {
    for (const asm of Il2Cpp.domain.assemblies) {
        try {
            const c = asm.image.tryClass(fullName);
            if (c) return c;
        } catch {}
    }
    return null;
}

const probeClassCache: { [name: string]: any } = {};
function probeClass(candidates: string[]): any {
    for (const name of candidates) {
        if (probeClassCache[name] !== undefined) return probeClassCache[name];
        if (name in probeClassCache) continue;
        const c = findClass(name);
        probeClassCache[name] = c || null;
        if (c) return c;
    }
    return null;
}

function probeBound(instance: any, name: string, sigs: string[][]): { m: any; sig: string[] } | null {
    for (const sig of sigs) {
        const m = bindMethod(instance, name, sig);
        if (m) return { m, sig };
    }
    return null;
}

const probeFieldCache: { [key: string]: any } = {};
function probeField(obj: any, candidates: string[]): any {
    for (const name of candidates) {
        const key = obj.class.name + "::" + name;
        if (probeFieldCache[key] !== undefined) return probeFieldCache[key];
        if (key in probeFieldCache) continue;
        const f = obj.tryField(name);
        probeFieldCache[key] = f || null;
        if (f) return f;
    }
    return null;
}

function writeVerify(fn: () => void, readBack: () => number | null, target: number): boolean {
    try {
        fn();
        const got = readBack();
        return got !== null && !isNaN(got) && Math.abs(got - target) < 1;
    } catch (e: any) {
        log(err + " 语义校验写入失败: " + e.message);
        return false;
    }
}

// === 物品枚举与掉落生成 ===
const ITEM_TYPES: { typeVal: number; label: string }[] = [
    { typeVal: 0, label: "武器" },
    { typeVal: 1, label: "防具" },
    { typeVal: 2, label: "主动道具" },
    { typeVal: 3, label: "宝藏" },
    { typeVal: 6, label: "食物" },
    { typeVal: 12, label: "消耗品" },
    { typeVal: 11, label: "炼金材料" },
    { typeVal: 15, label: "铭文" },
    { typeVal: 16, label: "记忆碎片" },
];

let itemDataCache: { [id: string]: any } = {};

function getGlobalManager(): any {
    try {
        const gmCls: any = probeClass(["LC2.GlobalManager", "GlobalManager"]);
        if (!gmCls) return null;
        const gmSingleton = baseSingleton.inflate(gmCls);
        return gmSingleton.method("get_Instance").invoke();
    } catch (e: any) {
        log(err + " GlobalManager 获取失败: " + e.message);
        return null;
    }
}

function getSingleton<T = any>(typeName: string): any {
    try {
        const cls: any = probeClass([typeName]);
        if (!cls) return null;
        const singleton = baseSingleton.inflate(cls);
        return singleton.method("get_Instance").invoke();
    } catch (e: any) {
        log(err + " 单例 " + typeName + " 获取失败: " + e.message);
        return null;
    }
}

function getItemDataMgr(): any {
    return getSingleton("LC2.EntityDataAssetMgr");
}

function getItemMgr(): any {
    return getSingleton("LC2.ItemMgr");
}

function getLocalPlayer(): any {
    try {
        const pmCls: any = probeClass(["LC2.PlayerManager", "PlayerManager"]);
        if (!pmCls) return null;
        const pmSingleton = baseSingleton.inflate(pmCls);
        const pm: any = pmSingleton.method("get_Instance").invoke();
        if (!pm) return null;
        return pm.method("get_LocalPlayer").invoke();
    } catch (e: any) {
        log(err + " LocalPlayer 获取失败: " + e.message);
        return null;
    }
}

function listItems(): { id: string; name: string; typeLabel: string }[] {
    try {
        const mgr = getItemDataMgr();
        if (!mgr) { log(err + " 物品列表: EntityDataAssetMgr 不可用"); return []; }
        const out: { id: string; name: string; typeLabel: string }[] = [];
        itemDataCache = {};
        for (const t of ITEM_TYPES) {
            const list: any = mgr.method("GetItemDataListByType").invoke(t.typeVal);
            if (!list) continue;
            const cnt: any = list.method("get_Count").invoke();
            for (let i = 0; i < cnt; i++) {
                try {
                    const item: any = list.method("get_Item").invoke(i);
                    let id = "";
                    let name = "";
                    try { id = (item.method("get_ID").invoke() as any).content; } catch {}
                    try { name = (item.method("get_NameText").invoke() as any).content; } catch {}
                    itemDataCache[id] = item;
                    out.push({ id, name, typeLabel: t.label });
                } catch {}
            }
        }
        return out;
    } catch (e: any) {
        log(err + " 物品列表获取失败: " + e.message);
        return [];
    }
}

// 游戏退出处理: 清空待办队列并还原 hook, 再通知 host 把 frida 完整卸载出游戏进程
function handleQuit() {
    quitting = true;
    mainThreadQueue.length = 0;
    if (lateUpdateHook) {
        try { lateUpdateHook.detach(); } catch {}
        lateUpdateHook = null;
    }
    // 通知 host 主动 session.detach() (连接断开 ≠ 模块卸载, 残留的 frida-agent 会让游戏退出卡死)
    try { send("quit"); } catch {}
    log(ok + " 检测到游戏退出, 已还原 hook 并通知 host 卸载 frida");
}

// 让出 JS 线程的等待 (不能用 Thread.sleep, 那会阻塞 JS 事件循环, 饿死主线程 hook 回调)
function jsSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}


// 批量生成掉落: 一次 RPC 处理 N 个物品, 共享玩家/位置/管理器查询, 统一等待主线程队列
async function spawnItemDrops(items: { id: string; count: number }[]): Promise<{ ok: boolean; spawned: number; failed: { id: string; error: string }[] }> {
    const failed: { id: string; error: string }[] = [];
    let spawned = 0;
    try {
        const player = getLocalPlayer();
        if (!player) return { ok: false, spawned, failed: [{ id: "", error: "本地玩家不可用" }] };
        const hero: any = player.method("get_OwnerHero").invoke();
        if (!hero) return { ok: false, spawned, failed: [{ id: "", error: "英雄不可用" }] };
        const itemMgr = getItemMgr();
        if (!itemMgr) return { ok: false, spawned, failed: [{ id: "", error: "ItemMgr 不可用" }] };
        // 共享的位置/朝向/玩家ID 只算一次
        const common = prepareDropCommon(player, hero, itemMgr);
        if (!common.ok) return { ok: false, spawned, failed: [{ id: "", error: common.error || "准备掉落上下文失败" }] };
        // 先解析所有 itemData (含缓存命中), 失败项直接记录
        const resolved: { itemData: any; id: string; count: number }[] = [];
        for (const req of items) {
            const c = Math.max(1, Math.min(99, parseInt(String(req.count)) || 1));
            let itemData: any = itemDataCache[req.id];
            if (!itemData) {
                try {
                    const mgr = getItemDataMgr();
                    if (!mgr) { failed.push({ id: req.id, error: "资源管理器不可用" }); continue; }
                    let found = false;
                    for (const t of ITEM_TYPES) {
                        const list: any = mgr.method("GetItemDataListByType").invoke(t.typeVal);
                        if (!list) continue;
                        const cnt: any = list.method("get_Count").invoke();
                        for (let i = 0; i < cnt; i++) {
                            try {
                                const it: any = list.method("get_Item").invoke(i);
                                if ((it.method("get_ID").invoke() as any).content === req.id) { itemData = it; found = true; break; }
                            } catch {}
                        }
                        if (found) break;
                    }
                } catch (e: any) {
                    failed.push({ id: req.id, error: "查找失败: " + e.message });
                    continue;
                }
            }
            if (!itemData) { failed.push({ id: req.id, error: "未找到物品" }); continue; }
            resolved.push({ itemData, id: req.id, count: c });
        }
        if (resolved.length === 0) return { ok: spawned > 0, spawned, failed };
        // 生成 ItemRuntimeData 也集中处理
        const runtimes: { itemData: any; runtimeData: any; id: string; count: number }[] = [];
        for (const r of resolved) {
            try {
                const runtimeData: any = r.itemData.method("CreateItemRuntimeData").overload().invoke();
                runtimes.push({ itemData: r.itemData, runtimeData, id: r.id, count: r.count });
            } catch (e: any) {
                failed.push({ id: r.id, error: "CreateItemRuntimeData 失败: " + e.message });
            }
        }
        // 全部任务一次入队
        const tasks: { id: string; ok: boolean; error: string | null }[] = [];
        for (const r of runtimes) {
            for (let k = 0; k < r.count; k++) {
                const rec: { id: string; ok: boolean; error: string | null } = { id: r.id, ok: false, error: null };
                tasks.push(rec);
                mainThreadQueue.push(() => {
                    try {
                        const dropped: any = common.dropFn!(r.itemData, r.runtimeData);
                        if (!dropped && !rec.error) rec.error = "掉落物生成失败";
                        rec.ok = true;
                    } catch (e: any) {
                        rec.error = "执行失败: " + e.message;
                        rec.ok = true;
                    }
                });
            }
        }
        // 统一等待全部任务完成 (最多 3s, 墙钟计时; 全部完成立即返回)
        const t0 = Date.now();
        const deadline = t0 + 3000;
        while (Date.now() < deadline) {
            if (tasks.every((t) => t.ok)) break;
            await jsSleep(5);
        }
        const waitMs = Date.now() - t0;
        if (waitMs > 100) log(warn + " 批量等待 " + waitMs + "ms (tasks=" + tasks.length + " done=" + tasks.filter((t) => t.ok).length + ")");
        for (const t of tasks) {
            if (t.ok && !t.error) spawned++;
            else failed.push({ id: t.id, error: t.error || "主线程执行超时" });
        }
        return { ok: failed.length === 0, spawned, failed };
    } catch (e: any) {
        log(err + " 批量生成掉落失败: " + e.message);
        return { ok: false, spawned, failed: [{ id: "", error: e.message }] };
    }
}

// 共享的掉落上下文: 位置/朝向/玩家ID/zero 向量/掉落方法, 只查询一次
function prepareDropCommon(player: any, hero: any, itemMgr: any): { ok: boolean; error: string | null; dropPos?: any; playerId?: any; zero?: any; itemMgr?: any; dropFn?: (arg: any, runtime?: any) => any } {
    try {
        const trans: any = hero.method("get_GetTransform").invoke();
        if (!trans) return { ok: false, error: "英雄 Transform 不可用" };
        const pos: any = trans.method("get_position").invoke();
        const facing: any = hero.method("get_FacingDir").invoke();
        const vec3Cls: any = (() => {
            const uc = Il2Cpp.domain.assemblies.find((a: any) => a.name.indexOf("UnityEngine") !== -1 && a.name.indexOf("CoreModule") !== -1);
            return uc ? uc.image.tryClass("UnityEngine.Vector3") : null;
        })();
        if (!vec3Cls) return { ok: false, error: "Vector3 不可用" };
        const zero: any = vec3Cls.method("get_zero").invoke();
        const dropPos = (() => {
            const forward: any = vec3Cls.method("get_forward").invoke();
            const offset: any = vec3Cls.method("op_Multiply").overload("UnityEngine.Vector3", "System.Single").invoke(forward, facing * 1.5);
            return vec3Cls.method("op_Addition").invoke(pos, offset);
        })();
        const playerId: any = player.method("get_ID").invoke();
        // CreateItemObjectAndDrop 重载: 依次探测已知签名, 命中即缓存, 运行期只用命中的
        const sigs: string[][] = [
            ["LC2.ItemData", "UnityEngine.Vector3", "LC2.ItemNetworkCtrl.ItemOwnerType", "System.UInt64", "UnityEngine.Vector3", "System.Single", "System.Single"],
            ["LC2.ItemRuntimeData", "UnityEngine.Vector3", "LC2.ItemNetworkCtrl.ItemOwnerType", "System.UInt64", "UnityEngine.Vector3", "System.Single", "System.Single"],
        ];
        const pb = probeBound(itemMgr, "CreateItemObjectAndDrop", sigs);
        if (!pb) return { ok: false, error: "CreateItemObjectAndDrop 无可用重载 (需更新)" };
        // 命中 ItemRuntimeData 重载 -> 传 runtimeData; 否则传 itemData
        const wantsRuntime = pb.sig[0] === "LC2.ItemRuntimeData";
        const dropFn = (arg: any, runtime?: any) => pb.m.invoke(wantsRuntime ? runtime : arg, dropPos, 1, playerId, zero, 0, 0);
        return { ok: true, error: null, dropPos, playerId, zero, itemMgr, dropFn };
    } catch (e: any) {
        return { ok: false, error: e.message };
    }
}

// 玩家属性: 通过 HeroRuntimeData -> StatValueAgent 读写
// getter 读最终值, SetValue 写基础值(会重算最终值)
// 重置按钮: 记录首次读取时的基础值(GetOrigValue), 重置时 SetValue 回基线
const HERO_STATS: { name: string; label: string; getter: string; typeVal: number }[] = [
    { name: "maxHp", label: "生命上限", getter: "get_MaxHP", typeVal: 2000 },
    { name: "maxMp", label: "魔力上限", getter: "get_MaxMP", typeVal: 2001 },
    { name: "atk", label: "攻击力", getter: "get_Atk", typeVal: 2010 },
    { name: "def", label: "防御", getter: "get_Def", typeVal: 2025 },
    { name: "spd", label: "移速", getter: "get_Spd", typeVal: 20401 },
    { name: "atkSpd", label: "攻速", getter: "get_AtkSpd", typeVal: 20411 },
    { name: "crit", label: "暴击率", getter: "get_Crit", typeVal: 2030 },
    { name: "critDmg", label: "暴击伤害", getter: "get_CritDmg", typeVal: 2031 },
];
let heroStatBaseline: { [name: string]: number } = {};

function getHeroStatAgent(): any {
    const rt = getHeroRuntimeData();
    if (!rt) return null;
    try {
        return rt.method("get_StatValueAgent").invoke();
    } catch {
        return null;
    }
}

// 记录基线: 读取当前基础值(GetOrigValue), 供重置使用
function recordHeroStatBaseline() {
    try {
        const rt = getHeroRuntimeData();
        const sv = getHeroStatAgent();
        if (!rt || !sv) return;
        for (const s of HERO_STATS) {
            if (heroStatBaseline[s.name] !== undefined) continue;
            try {
                const v = sv.method("GetOrigValue").overload("StatValueType").invoke(s.typeVal);
                heroStatBaseline[s.name] = parseFloat(v.toString());
            } catch {}
        }
    } catch {}
}

function getHeroRuntimeData(): any {
    const player = getLocalPlayer();
    if (!player) return null;
    try {
        const hero: any = player.method("get_OwnerHero").invoke();
        if (!hero) return null;
        return hero.method("get_RuntimeData").invoke();
    } catch (e: any) {
        log(err + " 获取英雄运行时数据失败: " + e.message);
        return null;
    }
}

// 查找某个方法在类层次中的指定参数重载, 并绑定到实例
function bindMethod(instance: any, name: string, paramTypes: string[]): any | null {
    try {
        for (const k of instance.class.hierarchy()) {
            for (const m of k.methods) {
                if (m.name !== name || m.parameterCount !== paramTypes.length) continue;
                const params = m.parameters.map((p: any) => p.type.name);
                let match = true;
                for (let i = 0; i < params.length; i++) {
                    if (params[i] !== paramTypes[i]) { match = false; break; }
                }
                if (match) return m.bind(instance);
            }
        }
    } catch {}
    return null;
}

// SetValueAndSendChangeEvent 的候选签名 (findings 两版 [相同], 基础候选即当前签名)
const svSetCandidates: string[][] = [
    ["StatValueType", "System.Single", "System.String", "LC2.SourceType"],
];
let svSetSig: string[] | null = null;
function svSetMethod(sv: any): any {
    if (svSetSig) return bindMethod(sv, "SetValueAndSendChangeEvent", svSetSig);
    const pb = probeBound(sv, "SetValueAndSendChangeEvent", svSetCandidates);
    if (!pb) return null;
    svSetSig = pb.sig;
    return pb.m;
}

function getHeroStats(): { name: string; label: string; value: number | null; max?: number | null }[] {
    recordHeroStatBaseline();
    const rt = getHeroRuntimeData();
    if (!rt) return HERO_STATS.map((s) => ({ name: s.name, label: s.label, value: null }));
    let sv: any = null;
    try { sv = rt.method("get_StatValueAgent").invoke(); } catch {}
    const out: { name: string; label: string; value: number | null; max?: number | null }[] = [];
    // 当前/最大 HP MP
    try { out.push({ name: "curHp", label: "当前生命", value: Number(rt.method("get_CurHP").invoke().toString()) }); } catch {}
    try { out.push({ name: "curMp", label: "当前魔力", value: Number(rt.method("get_CurMP").invoke().toString()) }); } catch {}
    for (const s of HERO_STATS) {
        let value: number | null = null;
        try {
            if (s.name === "def") {
                if (sv) value = parseFloat(sv.method("Get").overload("StatValueType").invoke(s.typeVal).toString());
            } else {
                value = Number(rt.method(s.getter).invoke().toString());
            }
        } catch (e: any) {
            value = null;
        }
        const item: { name: string; label: string; value: number | null; max?: number | null } = { name: s.name, label: s.label, value };
        // 上限: 移速 = 2*basicSpd, 攻速 = 2 (游戏 clamp 上限常量)
        if (s.name === "spd") {
            let basicSpd = 4;
            try { basicSpd = parseFloat(rt.method("get_BasicSpd").invoke().toString()) || 4; } catch {}
            item.max = 2 * basicSpd;
        } else if (s.name === "atkSpd") {
            item.max = 2;
        }
        out.push(item);
    }
    return out;
}

async function setHeroStat(name: string, value: number): Promise<{ ok: boolean; error: string | null }> {
    try {
        const rt = getHeroRuntimeData();
        if (!rt) return { ok: false, error: "英雄运行时数据不可用" };
        const sv: any = rt.method("get_StatValueAgent").invoke();
        if (!sv) return { ok: false, error: "StatValueAgent 不可用" };
        if (name === "curHp") {
            // 用 ChangeCurrentHp 增加差值到目标 (主线程执行, 触发正常伤害/回血逻辑)
            try {
                const cur = Number(rt.method("get_CurHP").invoke().toString());
                const max = Number(rt.method("get_MaxHP").invoke().toString());
                const target = Math.min(value, max);
                const delta = target - cur;
                const hpb = probeBound(rt, "ChangeCurrentHp", [
                    ["System.Single", "System.Boolean", "System.String"],
                    ["System.Single", "LC2.DoInjuryType", "System.Boolean", "System.Boolean", "System.String"],
                ]);
                if (!hpb) return { ok: false, error: "ChangeCurrentHp 无可用重载 (需更新)" };
                const m = hpb.m;
                const hpThreeParams = hpb.sig.length === 3;
                let execError: string | null = null;
                let executed = false;
                mainThreadQueue.push(() => {
                    try {
                        if (hpThreeParams) {
                            m.invoke(delta, false, Il2Cpp.string("trainer"));
                        } else {
                            m.invoke(delta, 0, false, false, Il2Cpp.string("trainer"));
                        }
                    } catch (e: any) { execError = e.message; }
                    executed = true;
                });
                const deadline = Date.now() + 3000;
                while (!executed && Date.now() < deadline) { await jsSleep(10); }
                if (!executed) return { ok: false, error: "主线程执行超时" };
                if (execError) return { ok: false, error: "回血失败: " + execError };
            } catch (e: any) {
                return { ok: false, error: "回血失败: " + e.message };
            }
            return { ok: true, error: null };
        }
        if (name === "curMp") {
            try {
                const cur = Number(rt.method("get_CurMP").invoke().toString());
                const max = Number(rt.method("get_MaxMP").invoke().toString());
                const target = Math.min(value, max);
                const delta = target - cur;
                const mpb = probeBound(rt, "ChangeCurrentMp", [
                    ["System.Single", "System.Boolean", "System.String"],
                ]);
                if (!mpb) return { ok: false, error: "ChangeCurrentMp 无可用重载 (需更新)" };
                const m = mpb.m;
                let execError: string | null = null;
                let executed = false;
                mainThreadQueue.push(() => {
                    try {
                        m.invoke(delta, false, Il2Cpp.string("trainer"));
                    } catch (e: any) { execError = e.message; }
                    executed = true;
                });
                const deadline = Date.now() + 3000;
                while (!executed && Date.now() < deadline) { await jsSleep(10); }
                if (!executed) return { ok: false, error: "主线程执行超时" };
                if (execError) return { ok: false, error: "回蓝失败: " + execError };
            } catch (e: any) {
                return { ok: false, error: "回蓝失败: " + e.message };
            }
            return { ok: true, error: null };
        }
        // 常规属性用 StatValueAgent.SetValueAndSendChangeEvent
        // (带 change event, 让游戏 HUD/面板立即刷新显示)
        const stat = HERO_STATS.find((s) => s.name === name);
        if (!stat) return { ok: false, error: "未知属性 " + name };
        try {
            // 移速: 面板输入的是目标移速 get_Spd, 需换算成 Spd_Mul_0(20401)
            // get_Spd = (Spd_Mul_0 + 1) * basicSpd
            let writeVal = value;
            if (name === "spd") {
                let basicSpd = 4;
                try { basicSpd = parseFloat(rt.method("get_BasicSpd").invoke().toString()) || 4; } catch {}
                const target = parseFloat(value as any);
                if (isNaN(target)) return { ok: false, error: "无效数值" };
                writeVal = target / basicSpd - 1;
            }
            // 攻速: get_AtkSpd 读 AtkSpd_Mul_0(20411), get_AtkSpd = clamp(Get(20411) + 1)
            // 面板输入目标攻速, 换算: writeVal = target - 1
            if (name === "atkSpd") {
                const target = parseFloat(value as any);
                if (isNaN(target)) return { ok: false, error: "无效数值" };
                writeVal = target - 1;
            }
            // 直写属性(maxHp/maxMp/atk/def/crit/critDmg): SetValue 写的是基础值,
            // 但最终显示值 = a*基础值 + b (a/b 来自装备/成长乘区加成, 非恒等)
            // 例: maxMp 显示 = 1.05*基础 + 31.5。旧 offset 反算假设 a=1, 导致偏差。
            // 这里先探测一个偏移量测出 a, 再反算基础值使显示精确等于目标。
            if (name !== "spd" && name !== "atkSpd") {
                const target = parseFloat(value as any);
                if (isNaN(target)) return { ok: false, error: "无效数值" };
                const svSet = svSetMethod(sv);
                if (!svSet) return { ok: false, error: "SetValueAndSendChangeEvent 无可用重载 (需更新)" };
                const setVal = (v: number) => svSet.invoke(stat.typeVal, v, Il2Cpp.string("trainer"), 0);
                const readOrig = (): number => {
                    try { return parseFloat(sv.method("GetOrigValue").overload("StatValueType").invoke(stat.typeVal).toString()) || 0; } catch { return 0; }
                };
                const readFinal = (): number => {
                    try {
                        if (name === "def") return parseFloat(sv.method("Get").overload("StatValueType").invoke(stat.typeVal).toString()) || 0;
                        return parseFloat(rt.method(stat.getter).invoke().toString()) || 0;
                    } catch { return 0; }
                };
                const orig0 = readOrig();
                const final0 = readFinal();
                // 探测偏移: 量级自适应, 保证 Δfinal 可测又不至于过大
                const probe = Math.max(10, Math.abs(orig0) * 0.1 + 10);
                setVal(orig0 + probe);
                const orig1 = readOrig();
                const final1 = readFinal();
                const a = (final1 - final0) / (orig1 - orig0);
                if (a > 0 && isFinite(a) && orig1 !== orig0) {
                    const b = final0 - a * orig0;
                    setVal((target - b) / a);
                } else {
                    log(warn + " " + stat.label + " 线性探测失败, 直接写入目标值");
                    setVal(target);
                }
            } else {
                const svSet = svSetMethod(sv);
                if (!svSet) return { ok: false, error: "SetValueAndSendChangeEvent 无可用重载 (需更新)" };
                svSet.invoke(stat.typeVal, writeVal, Il2Cpp.string("trainer"), 0);
            }
        } catch (e: any) {
            return { ok: false, error: "SetValue 调用失败: " + e.message };
        }
        return { ok: true, error: null };
    } catch (e: any) {
        return { ok: false, error: e.message };
    }
}

// 重置属性到首次读取时的基础值(正常带装备的数值)
function resetHeroStat(): { ok: boolean; error: string | null; changed: string[] } {
    const changed: string[] = [];
    try {
        const rt = getHeroRuntimeData();
        if (!rt) return { ok: false, error: "英雄运行时数据不可用", changed };
        const sv = getHeroStatAgent();
        if (!sv) return { ok: false, error: "StatValueAgent 不可用", changed };
        recordHeroStatBaseline();
        for (const s of HERO_STATS) {
            const base = heroStatBaseline[s.name];
            if (base === undefined) continue;
            try {
                const svSet = svSetMethod(sv);
                if (!svSet) continue;
                svSet.invoke(s.typeVal, base, Il2Cpp.string("trainer"), 0);
                changed.push(s.label);
            } catch {}
        }
        return { ok: true, error: null, changed };
    } catch (e: any) {
        return { ok: false, error: e.message, changed };
    }
}

function ensureRuntime(): boolean {
    try {
        if (!core) return false;
        if (!baseSingleton) return false;
        // 每次强制重新解析: 场景/房间切换后旧引用会失效, 不能依赖 init 时的缓存 (与属性读取一致)
        bag = null;
        const pmCls: any = probeClass(["LC2.PlayerManager", "PlayerManager"]);
        if (pmCls) {
            const pmSingleton = baseSingleton.inflate(pmCls);
            const pm: any = pmSingleton.method("get_Instance").invoke();
            if (pm) {
                const player: any = pm.method("get_LocalPlayer").invoke();
                if (player) {
                    bag = player.method("get_OwnBagSystem").invoke();
                }
            }
        }
        // GameSaveDataMgr -> MineData
        mine = null;
        const mgrCls: any = probeClass(["LC2.GameSaveDataMgr", "GameSaveDataMgr"]);
        if (mgrCls) {
            const mgrSingleton = baseSingleton.inflate(mgrCls);
            const mgr: any = mgrSingleton.method("get_Instance").invoke();
            if (mgr) mine = mgr.method("get_MineData").invoke();
        }
        // 类引用不会随场景变化, 只需缓存一次
        if (!heroResources) heroResources = probeClass(["LC2.HeroResources", "HeroResources"]);
        if (!objClass) {
            const unityObj = Il2Cpp.domain.assemblies.find(
                (a: any) => a.name.indexOf("UnityEngine") !== -1 && a.name.indexOf("CoreModule") !== -1
            );
            if (unityObj) objClass = unityObj.image.tryClass("UnityEngine.Object");
        }
        return !!(bag && mine);
    } catch (e: any) {
        initError = e.message;
        return false;
    }
}

Il2Cpp.perform(() => {
    log(ok + " 进程已附加, IL2CPP 桥接就绪 (Unity " + Il2Cpp.unityVersion + ")");

    const coreA = Il2Cpp.domain.assemblies.find((a: any) => a.name === "LC2.Core") || Il2Cpp.domain.assemblies.find((a: any) => a.name === "LC2");
    if (!coreA) { initError = "未找到 LC2.Core"; return; }
    core = coreA;

    const actk = Il2Cpp.domain.assemblies.find((a: any) => a.name === "ACTk.Runtime");
    if (actk) oi = actk.image.tryClass("CodeStage.AntiCheat.ObscuredTypes.ObscuredInt");
    if (!oi) oi = findClass("CodeStage.AntiCheat.ObscuredTypes.ObscuredInt");
    if (oi) {
        try {
            const probe: any = oi.method("Encrypt").invoke(123456, OI_KEY);
            const back: any = oi.method("FromEncrypted").invoke(probe, OI_KEY);
            const n = parseInt(back.toString(), 10);
            if (n === 123456) log(ok + " ObscuredInt 加密往返校验通过");
            else log(warn + " ObscuredInt 往返解密不一致 (" + n + "), 请核对 OI_KEY");
        } catch (e: any) {
            log(err + " ObscuredInt 探测失败: " + e.message);
        }
    }

    const common = Il2Cpp.domain.assemblies.find((a: any) => a.name === "Hunter.Common");
    if (common) baseSingleton = common.image.tryClass("Hunter.Common.Singleton`1");
    if (!baseSingleton) baseSingleton = findClass("Hunter.Common.Singleton`1");
    if (!baseSingleton) { initError = "未找到 Singleton`1"; return; }
    if (!oi) { initError = "未找到 ObscuredInt"; return; }

    // 轮询等待玩家背包就绪 (最长 60s, 需进入营地)
    log(warn + " 等待玩家背包初始化...");
    let waited = 0;
    while (waited < 60 && !ensureRuntime()) {
        Thread.sleep(2);
        waited += 2;
    }
    if (!bag || !mine) {
        initError = "60s 内未就绪 (请确认已进入营地/存档)";
        log(err + " " + initError);
    } else {
        log(ok + " 背包已就绪");
    }

    // Hook 主线程执行点: 对候选每帧调用方法依次尝试, 命中可 attach 者即消费 mainThreadQueue
    // (新版 BagSystem.LateUpdate 是 jmp stub, Frida 无法 attach, 自动落到 GlobalManager)
    const hookCandidates: { cls: string; mth: string }[] = [
        { cls: "LC2.GlobalManager", mth: "LateUpdate" },
        { cls: "LC2.GlobalManager", mth: "Update" },
        { cls: "LC2.BagSystem", mth: "LateUpdate" },
    ];
    mainThreadHooked = false;
    for (const cand of hookCandidates) {
        try {
            const cls: any = probeClass([cand.cls]);
            if (!cls) { log(warn + " 主线程执行点候选类不存在: " + cand.cls); continue; }
            const mth: any = cls.method(cand.mth);
            if (!mth) { log(warn + " 主线程执行点候选方法不存在: " + cand.cls + "." + cand.mth); continue; }
            lateUpdateHook = Interceptor.attach(mth.virtualAddress, {
                onEnter() {
                    if (quitting) return;
                    while (mainThreadQueue.length > 0) {
                        const task = mainThreadQueue.shift();
                        if (task) { try { task(); } catch (e: any) { log(err + " 主线程任务失败: " + e.message); } }
                    }
                },
            });
            mainThreadHooked = true;
            log(ok + " 主线程执行点已挂接 (" + cand.cls + "." + cand.mth + ")");
            break;
        } catch (e: any) {
            log(warn + " 主线程执行点 attach 失败 (" + cand.cls + "." + cand.mth + "): " + e.message);
            lateUpdateHook = null;
        }
    }
    if (!mainThreadHooked) {
        log(err + " 所有主线程执行点均无法挂接, 掉落/回血等队列操作将超时");
    }

    // Hook Application.Quit: 游戏点退出时先清空队列并还原 hook,
    // 避免 Unity 卸载 IL2CPP 模块阶段主线程卡死在 hook 还原上
    try {
        const unityCore = Il2Cpp.domain.assemblies.find(
            (a: any) => a.name.indexOf("UnityEngine") !== -1 && a.name.indexOf("CoreModule") !== -1
        );
        if (unityCore) {
            const appCls = unityCore.image.tryClass("UnityEngine.Application");
            if (appCls) {
                const quitMethods = appCls.methods.filter((m: any) => m.name === "Quit");
                const seen: { [addr: string]: boolean } = {};
                let hookedQuit = 0;
                for (const qm of quitMethods) {
                    const addr = qm.virtualAddress.toString();
                    if (seen[addr]) continue;
                    seen[addr] = true;
                    Interceptor.attach(qm.virtualAddress, {
                        onEnter() { handleQuit(); },
                    });
                    hookedQuit++;
                }
                if (hookedQuit > 0) log(ok + " 退出流程已挂接 (Application.Quit x" + hookedQuit + ")");
                else log(warn + " 未找到 Application.Quit 方法");
            } else {
                log(warn + " 未找到 UnityEngine.Application 类");
            }
        }
    } catch (e: any) {
        log(warn + " 退出流程挂接失败: " + e.message);
    }
    initDone = true;
});

rpc.exports = {
    init: (): { ok: boolean; error: string | null } => {
        const okNow = ensureRuntime();
        return { ok: okNow && !!bag && !!mine, error: initError };
    },
    getValues: (): { name: string; label: string; value: number | null }[] => {
        ensureRuntime();
        return RESOURCES.map((r) => ({ name: r.name, label: r.label, value: readValue(r) }));
    },
    setValue: (name: string, value: number): { ok: boolean; name: string; value: number | null; error: string | null } => {
        try {
            ensureRuntime();
            const res = RESOURCES.find((r) => r.name === name);
            if (!res) return { ok: false, name, value: null, error: "未知资源 " + name };
            const num = parseInt(value as any, 10);
            if (isNaN(num) || num < 0) return { ok: false, name, value: null, error: "无效数量 " + value };
            const okNow = setValue(res, num);
            return { ok: okNow, name, value: readValue(res), error: okNow ? null : "修改失败" };
        } catch (e: any) {
            // 游戏场景切换后实例可能失效, 兜底返回错误而不是让原生异常崩掉 host
            return { ok: false, name, value: null, error: e.message };
        }
    },
    getItems: (): { id: string; name: string; typeLabel: string }[] => {
        return listItems();
    },
    spawnItems: (items: { id: string; count: number }[]): Promise<{ ok: boolean; spawned: number; failed: { id: string; error: string }[] }> => {
        if (!Array.isArray(items)) return Promise.resolve({ ok: false, spawned: 0, failed: [{ id: "", error: "参数错误" }] });
        return spawnItemDrops(items);
    },
    getHeroStats: (): { name: string; label: string; value: number | null }[] => {
        return getHeroStats();
    },
    setHeroStat: (name: string, value: number): Promise<{ ok: boolean; error: string | null }> => {
        const num = parseFloat(value as any);
        if (isNaN(num)) return Promise.resolve({ ok: false, error: "无效数值" });
        return setHeroStat(name, num);
    },
    resetHeroStat: (): { ok: boolean; error: string | null; changed: string[] } => {
        return resetHeroStat();
    },
};
