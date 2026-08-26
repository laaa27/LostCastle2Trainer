# 失落城堡2 修改器 (LostCastle2Trainer)

> **声明 / Disclaimer**
> 本项目仅供**学习与研究** IL2CPP 技术、Frida 进程注入与反作弊机制检测所编写。
> 请勿在任何**在线联机对局**中使用，由此产生的账号处罚、封禁或其他后果由使用者自行承担。
> 支持正版游戏与公平游玩。

一个基于 **Frida + frida-il2cpp-bridge** 的《失落城堡2》单机修改器，通过原生winui控制：

- 修改金币 / 魂晶 / 魔铁锭 / 虚灵通票 / 刷新币等资源
- 加载全部物品列表，搜索并按需生成物品掉落
- 读取 / 修改 / 重置玩家属性（生命、魔力、攻击、防御、移速、攻速、暴击等）

## 特性：新旧版本自动兼容

同一份代码支持**旧版与新版**游戏，无需识别版本号。核心采用**逐符号探测 + 语义校验 + 结果缓存**：

- 类 / 方法 / 字段均按名解析，天然免疫偏移地址变化
- 方法重载按候选签名组逐一探测，命中某个签名即采用该签名调用
- 写入类操作带"写回读回"语义校验，避免脏状态
- 主线程执行点多候选挂接，自动选择可 attach 的每帧调用点

即使游戏再次更新导致符号改名/改签名，也只需把新符号补充进探测候选列表，无需重写逻辑。

## 环境要求

- Windows
- 《失落城堡2》游戏本体
- （Release 压缩包内置 Node.js；从源码构建才需自行安装 Node.js 18+）

## 使用步骤

```bash
# 1. 下载源码 / Release 压缩包（Release 包已内置 Node.js，无需安装任何环境）
# 2. 解压
# 3. 启动游戏（推荐无边框窗口化）并进入营地/存档界面
# 4. 双击 winui\WinPanel.exe 即可运行
#    面板优先使用包内便携 node，零配置启动
```

面板为 **Windows 原生窗口**（非浏览器），游戏中按 **\` 反引号键** 随时呼出 / 收起（置顶显示）。
资源 / 物品 / 属性三个标签页对应全部功能；面板启动时会自动拉起 host.js 连接游戏进程。

> 标题栏已移除最小化 / 最大化 / 关闭按钮，窗口只能通过 \` 键呼出 / 隐藏；
> 面板底部有「关闭修改器」按钮用于真正退出（会一并停止 host 进程）。

> 独占全屏模式下外部窗口会被游戏压住，请使用无边框窗口化运行游戏。

## 从源码构建

Release 压缩包已内置环境直接可用；若从 GitHub 源码自行构建，需先安装 [Node.js](https://nodejs.org/) 18+（Windows 版）。

```powershell
# 1. 克隆源码
git clone https://github.com/laaa27/LostCastle2Trainer.git
cd LostCastle2Trainer

# 2. 安装依赖（约 120MB，含 frida 原生绑定）
npm install

# 3. 编译注入 agent（frida-compile: src/agent.ts -> dist/agent.js）
npm run build

# 4. 编译原生窗口面板（系统自带 csc.exe，不需要 Visual Studio）
powershell -ExecutionPolicy Bypass -File winui\build-ui.ps1

# 5. 启动游戏并进入营地/存档界面后，双击 winui\WinPanel.exe 运行
```

构建产物：

- `winui\WinPanel.exe` — 原生面板，双击启动，自动拉起 host.js 连接游戏
- `dist\agent.js` — Frida 注入脚本（由 `src\agent.ts` 编译）

> 面板具备自举能力：启动时会自动检查依赖与编译产物，缺失则自动 `npm install` / `npm run build`。
> 所以最小构建只需 `npm install` + `npm run build`，面板 exe 由 `build-ui.ps1` 编译一次即可长期使用。

发布新版本时，用 `winui\package-release.ps1` 一键打包免环境压缩包（自动下载官方便携 node 并整合 node_modules 等全部运行文件）。

## 项目结构

```
src/agent.ts            # 核心: Frida 注入 agent (IL2CPP 操作 + 多版本探测层)
host.js                 # 本地 HTTP 宿主 (附加游戏 + 提供面板 API)
winui/WinPanel.cs       # C# 原生窗口面板 (WinForms, ` 键全局热键 + 自动托管 host + 环境自举)
winui/WinPanel.exe      # 编译产物: 直接双击启动修改器 (优先用包内便携 node)
winui/build-ui.ps1      # 面板构建脚本 (系统自带 csc.exe, 零额外安装)
winui/package-release.ps1  # 一键打包免环境 Release zip (内置便携 node + node_modules)
diag.js                 # 独立诊断/验证脚本 (attach -> 各 RPC -> 干净 detach)
run-trainer.ps1         # 诊断用启动脚本 (带日志运行 host.js)
```

## 技术栈

- [frida](https://frida.re/) + [frida-il2cpp-bridge](https://github.com/vfsfitvnm/frida-il2cpp-bridge)
- TypeScript / frida-compile

## 免责声明

本项目不包含任何游戏资源或反作弊库源码，仅用于技术学习。请遵守所在地区法律与游戏服务条款，合理使用。
