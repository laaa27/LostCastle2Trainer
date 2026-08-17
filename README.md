# 失落城堡2 修改器 (LostCastle2Trainer)

> **声明 / Disclaimer**
> 本项目仅供**学习与研究** IL2CPP 技术、Frida 进程注入与反作弊机制检测所编写。
> 请勿在任何**在线联机对局**中使用，由此产生的账号处罚、封禁或其他后果由使用者自行承担。
> 支持正版游戏与公平游玩。

一个基于 **Frida + frida-il2cpp-bridge** 的《失落城堡2》单机修改器，通过本地网页面板操作：

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
- [Node.js](https://nodejs.org/) 18+
- 《失落城堡2》游戏本体

## 使用步骤

```bash
# 1. 安装依赖（仅首次，或直接双击 exe 由面板自动完成）
npm install

# 2. 编译 agent（frida-compile: src/agent.ts -> dist/agent.js）与原生面板
npm run build
powershell -ExecutionPolicy Bypass -File winui\build-ui.ps1

# 3. 启动游戏（推荐无边框窗口化）并进入营地/存档界面

# 4. 运行修改器
#    直接双击 winui\WinPanel.exe 即可（无需任何命令行）。
#    面板会自举：缺 node_modules 自动 npm install、缺 dist 自动编译，
#    随后自动拉起 host.js 连接游戏并打开窗口。
```

面板为 **Windows 原生窗口**（非浏览器），游戏中按 **\` 反引号键** 随时呼出 / 收起（置顶显示）。
资源 / 物品 / 属性三个标签页对应全部功能；面板启动时会自动拉起 host.js 连接游戏进程。

> 标题栏已移除最小化 / 最大化 / 关闭按钮，窗口只能通过 \` 键呼出 / 隐藏；
> 面板底部有「关闭修改器」按钮用于真正退出（会一并停止 host 进程）。

> 独占全屏模式下外部窗口会被游戏压住，请使用无边框窗口化运行游戏。

## 项目结构

```
src/agent.ts            # 核心: Frida 注入 agent (IL2CPP 操作 + 多版本探测层)
host.js                 # 本地 HTTP 宿主 (附加游戏 + 提供面板 API)
winui/WinPanel.cs       # C# 原生窗口面板 (WinForms, ` 键全局热键 + 自动托管 host + 环境自举)
winui/WinPanel.exe      # 编译产物: 直接双击启动修改器
winui/build-ui.ps1      # 面板构建脚本 (系统自带 csc.exe, 零额外安装)
diag.js                 # 独立诊断/验证脚本 (attach -> 各 RPC -> 干净 detach)
run-trainer.ps1         # 旧浏览器面板启动脚本 (host.js + 日志)
```

## 技术栈

- [frida](https://frida.re/) + [frida-il2cpp-bridge](https://github.com/vfsfitvnm/frida-il2cpp-bridge)
- TypeScript / frida-compile

## 免责声明

本项目不包含任何游戏资源或反作弊库源码，仅用于技术学习。请遵守所在地区法律与游戏服务条款，合理使用。