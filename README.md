# 微迹 Wetrace — 微信 PC 版聊天记录导出工具

> 珍藏每一段对话 · 完全本地运行 · 开源 & 免费

微迹（Wetrace）是一款 Windows 桌面工具，用于在**本地**导出微信 PC 版的聊天记录。所有数据仅在你自己的电脑上处理，不会上传或分享到任何地方。

---

## ⚠️ 免责声明

**本工具仅供个人学习、研究和技术交流。**

- 本工具为**第三方开源软件**，与腾讯微信（WeChat）**没有任何关联**，也未获得其授权或认可。
- 解密微信本地数据库涉及对微信客户端数据保护机制的技术研究，**仅供安全研究与学习目的**。请于下载后 24 小时内删除。
- 你导出的聊天记录**仅可用于个人备份与合法查阅**。请严格遵守所在地法律法规。
- **禁止**将本工具用于：
  - 窃取或窥探他人隐私
  - 未经授权访问他人账号数据
  - 任何非法用途或侵犯他人合法权益的行为
- 使用本工具即表示你确认**有权访问**目标账号的本地数据（即该账号为你本人所有或已获授权）。
- 因使用本工具产生的任何后果（包括但不限于数据丢失、账号异常、法律纠纷），**由使用者自行承担**，开发者不承担任何责任。
- 若微信官方要求，本仓库将配合关闭。

---

## 隐私承诺

- ✅ **完全离线运行** — 无需联网，不上传、不同步、不收集任何数据
- ✅ **仅读写本地文件** — 操作范围仅限于你电脑上的微信数据目录和你指定的导出文件夹
- ✅ **不收集个人信息** — 无遥测、无埋点、无用户画像

---

## 功能特点

- 🔐 自动从本地微信进程提取数据库密钥（支持内存扫描 / DLL Hook 两种模式）
- 📂 解密并导出聊天记录为 **HTML**（推荐，支持浏览器浏览）、**JSON**、**TXT**、**CSV**
- 👥 支持多账号切换，自动检测微信数据目录
- 💬 按会话筛选导出，支持搜索会话名称
- 🖥️ 图形界面（Electron），操作简单，步骤引导
- 🎙️ **完整版**支持语音转文字（内置模型，全程本地识别）
- 📦 支持便携版和安装包两种分发方式（标准版 / 完整版）

---

## 快速开始

### 方式一：下载便携版（推荐）

从 [Releases](../../releases) 页面下载 `wetrace-portable.exe`，**右键 → 以管理员身份运行**。

### 方式二：从源码运行

```bash
# 1. 克隆仓库
git clone https://github.com/YOUR_USERNAME/wetrace.git
cd wetrace

# 2. 安装依赖
npm install

# 3. 启动
npm start
```

### 使用流程

1. **以管理员身份运行** — 解密需要读取微信进程内存
2. **选择微信数据目录** — 自动检测或手动浏览 `xwechat_files` 文件夹
3. **选择账号 → 扫描会话** — 首次可能需要几分钟
4. **（新版微信）配合 Hook 捕获密钥** — 工具会自动重启微信，看到「Hook 已就绪」后点击「登录」
5. **勾选会话 → 选择格式 → 导出** — 推荐勾选 HTML 格式，导出后双击 `index.html` 即可浏览

---

## 技术原理

微信 PC 版将聊天记录存储在加密的 SQLite 数据库中。本工具通过以下方式获取解密密钥：

| 微信版本 | 方式 | 说明 |
|---------|------|------|
| < 4.1.10 | 内存扫描 | 微信登录后密钥明文存在于进程内存中，通过特征匹配定位 |
| ≥ 4.1.10 | DLL Hook | 密钥仅在登录瞬间出现，通过注入 DLL 拦截密钥派生过程 |

解密后的数据仅存在于本地磁盘，由用户完全控制。

> 本项目是对微信客户端数据存储机制的技术研究。相关代码仅用于验证 SQLite 加密原理和 Windows 进程内存分析技术。

---

## 技术栈

- **运行时**: Node.js + Electron
- **数据库**: sql.js (SQLite compiled to WASM)
- **FFI**: koffi (调用 Windows API 和 Native DLL)
- **Native 模块**: C++ DLL (微信 Hook 模块，位于 `native/wexin-hook/`)
- **打包**: electron-builder

---

## 打包发布

打包前需先编译 Hook DLL（仅首次或改过 native 代码后）：

```bash
npm run build:hook
```

便携版 exe 有两种，按需选择：

| 版本 | 命令 | 说明 |
|------|------|------|
| **标准版**（体积小） | `npm run dist:portable` | 聊天记录导出；**不含**语音转文字 |
| **完整版**（含语音模型） | `npm run dist:portable:full` | 在标准版基础上增加语音转文字（内置模型，全程离线） |

产物在 `dist/` 目录，文件名类似：

- `微迹 Wetrace-1.0.0-portable.exe`
- `微迹 Wetrace 完整版-1.0.0-portable.exe`

安装包（NSIS）对应命令：`npm run dist:installer` / `npm run dist:installer:full`

下载语音模型若遇 SSL 证书错误，可尝试国内镜像：

```bash
# 方式一：HuggingFace 国内镜像（推荐）
set WETRACE_HF_ENDPOINT=https://hf-mirror.com
npm run download-whisper-model

# 方式二：临时跳过证书校验（仅下载模型时使用）
npm run download-whisper-model -- --insecure
```

---

## 项目结构

```
wetrace/
├── electron/           # Electron 主进程与渲染进程
│   ├── main.js         # 主进程入口
│   ├── preload.js      # 上下文桥接
│   ├── renderer/       # 前端界面 (HTML/CSS/JS)
│   └── *Worker.js      # Worker 线程
├── lib/                # 核心逻辑
│   ├── exportCore.js   # 导出主流程
│   ├── decryptCore.js  # 解密调度
│   ├── keyScan.js      # 内存密钥扫描
│   ├── wxKeyHook.js    # DLL Hook 密钥捕获
│   ├── decryptDb.js    # 数据库解密
│   └── ...
├── native/wexin-hook/  # C++ Hook DLL 源码
├── scripts/            # 构建脚本
├── assets/             # 静态资源 (含预编译 DLL)
└── export.js           # CLI 导出入口
```

---

## License

本项目采用 [MIT License](LICENSE)。

> 注意：MIT 仅授权代码使用，**不意味着授权用于非法目的**。请务必阅读并遵守上方免责声明。

---

## 致谢

- [sql.js](https://github.com/sql-js/sql.js) — SQLite WASM 实现
- [koffi](https://github.com/Koromix/koffi) — Node.js FFI 库
- [Electron](https://www.electronjs.org/) — 跨平台桌面应用框架
