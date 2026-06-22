# 内置 Hook 模块

微信 4.1.10+ 不再把密钥明文放在进程内存中，本工具通过 **wexin_hook.dll** 在登录时拦截 `Weixin.dll` 的密钥设置函数。

## 构建

需要 Visual Studio 2022（含「使用 C++ 的桌面开发」）和 CMake：

```powershell
npm run build:hook
```

产物输出到 `assets/dll/wexin_hook.dll`。

## 源码

实现位于 `native/wexin-hook/`，为本项目内置模块，API 与常见 Hook 工具兼容。

## 使用

1. 以**管理员身份**运行本工具
2. 勾选「登录时捕获密钥」
3. 工具会关闭并重启微信，请在提示后点击「登录」

若无法本地编译，可从 GitHub Actions 的 `wexin_hook-dll` 产物下载 DLL 放到此目录。
