const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { verifyEncKey } = require('./decryptDb');
const { deriveKeysFromPassphrase } = require('./passphraseScan');
const {
  terminateWeChatProcesses,
  rememberWeixinExecutable,
  launchWeChat,
  focusWeChatWindow,
  isWeixinRunning,
  sleep,
} = require('./wechatProcess');

let dllLib = null;
let fnInit = null;
let fnPoll = null;
let fnStatus = null;
let fnCleanup = null;
let fnError = null;
let hookActive = false;
let lastHookPassphrase = null;

function getLastHookPassphrase() {
  return lastHookPassphrase;
}

function isInsideAsarArchive(filePath) {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('app.asar/') && !normalized.includes('app.asar.unpacked/');
}

function resolveDllPath() {
  const names = ['wexin_hook.dll', 'wx_key.dll'];
  const subdirs = [
    ['app.asar.unpacked', 'assets', 'dll'],
    ['app.asar.unpacked', 'assets', 'dll', 'Release'],
    ['assets', 'dll'],
    ['assets', 'dll', 'Release'],
  ];

  const bases = [
    process.resourcesPath || '',
    path.join(path.dirname(process.execPath || ''), 'resources'),
    path.join(__dirname, '..'),
    path.dirname(process.execPath || ''),
    process.cwd(),
  ].filter(Boolean);

  const seen = new Set();
  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base);
    for (const parts of subdirs) {
      for (const name of names) {
        const candidate = path.join(base, ...parts, name);
        if (fs.existsSync(candidate) && !isInsideAsarArchive(candidate)) {
          return candidate;
        }
      }
    }
  }

  return null;
}

function loadDll() {
  if (dllLib) return true;

  const dllPath = resolveDllPath();
  if (!dllPath) {
    return false;
  }

  try {
    dllLib = koffi.load(dllPath);
  } catch {
    return false;
  }

  fnInit = dllLib.func('InitializeHook', 'bool', ['uint32']);
  fnPoll = dllLib.func('PollKeyData', 'bool', ['str', 'int']);
  fnStatus = dllLib.func('GetStatusMessage', 'bool', ['str', 'int', 'int *']);
  fnCleanup = dllLib.func('CleanupHook', 'bool', []);
  fnError = dllLib.func('GetLastErrorMsg', 'str', []);
  return true;
}

function isProcessElevated() {
  if (process.platform !== 'win32') return true;
  try {
    const { execSync } = require('child_process');
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function pickWeixinPid(processes) {
  const weixin = processes.filter((p) => p.imageName === 'Weixin.exe');
  if (!weixin.length) return null;
  return weixin.sort((a, b) => b.memKb - a.memKb)[0].pid;
}

async function waitForWeixinPid({ onProgress, timeoutMs = 60000 }) {
  const log = (message) => onProgress?.({ phase: 'keys', message });
  const { getWeChatProcesses } = require('./winMemory');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isWeixinRunning()) {
      await sleep(400);
      continue;
    }
    try {
      const pid = pickWeixinPid(getWeChatProcesses());
      if (pid) return pid;
    } catch {
      // ignore
    }
    await sleep(400);
  }

  log('未检测到 Weixin.exe，请手动启动微信后重试');
  return null;
}

async function initializeHookWithRetry(targetPid, log, maxAttempts = 30) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    cleanupHook(true);
    log(`正在安装 Hook（第 ${attempt}/${maxAttempts} 次，PID=${targetPid}）...`);
    const ok = fnInit(targetPid);
    drainStatusMessages(log);

    if (ok) {
      hookActive = true;
      return true;
    }

    const err = getDllError();
    if (attempt < maxAttempts) {
      log(`Hook 尚未就绪: ${err}`);
      log('等待微信组件加载…（请先不要点击登录）');
      await sleep(800);
    } else {
      throw new Error(
        `Hook 初始化失败：${err}\n` +
          '1. 右键本程序，选择「以管理员身份运行」\n' +
          '2. 关闭微信后重新扫描，等「Hook 已就绪」再点击「登录」'
      );
    }
  }
  return false;
}

async function isWeixinLoggedIn(wxDir) {
  if (wxDir) {
    try {
      const { checkWeChatReadiness } = require('./wechatStatus');
      const readiness = checkWeChatReadiness(wxDir);
      if (readiness.dbPathInMemory || readiness.level === 'ready' || readiness.level === 'fallback') {
        return true;
      }
    } catch {
      // fall through to memory heuristic
    }
  }

  try {
    const { getWeChatProcesses } = require('./winMemory');
    const weixin = getWeChatProcesses().filter((p) => p.imageName === 'Weixin.exe');
    if (!weixin.length) return false;
    const top = weixin.sort((a, b) => b.memKb - a.memKb)[0];
    return top.memKb > 350 * 1024;
  } catch {
    return false;
  }
}

async function prepareWeChatWithHook({ weixinExe, wxDir, onProgress, maxRestarts = 1 }) {
  const log = (message) => onProgress?.({ phase: 'keys', message });

  for (let restart = 0; restart <= maxRestarts; restart += 1) {
    if (restart > 0) {
      log('检测到登录发生在 Hook 安装之前，正在重新启动微信…');
    }

    cleanupHook(true);
    await terminateWeChatProcesses(log);
    await sleep(2000);

    const launched = launchWeChat(log, weixinExe, { deferLoginHint: true });
    if (!launched) {
      throw new Error('未能启动微信，请手动打开 Weixin.exe 后重试');
    }

    if (restart === 0) {
      log('微信正在后台启动，正在安装 Hook — 请先不要点击「登录」');
    } else {
      log('微信已重新启动，正在安装 Hook — 请等待提示后再点击「登录」');
    }

    const targetPid = await waitForWeixinPid({ onProgress });
    if (!targetPid) {
      throw new Error('未检测到 Weixin.exe，请手动启动微信后重试');
    }

    log(`已检测到 Weixin.exe PID=${targetPid}，正在安装 Hook…`);
    await initializeHookWithRetry(targetPid, log);

    if (restart < maxRestarts && (await isWeixinLoggedIn(wxDir))) {
      log('微信似乎已在 Hook 就绪前完成登录，将关闭并重来一次');
      continue;
    }

    return targetPid;
  }

  throw new Error('多次重启后仍无法在安装 Hook 前保持未登录状态，请手动退出微信账号后重试');
}

function getDllError() {
  try {
    return fnError?.() || '未知错误';
  } catch {
    return '无法读取 DLL 错误信息';
  }
}

function drainStatusMessages(log) {
  if (!fnStatus) return;
  const levelPtr = koffi.alloc('int', 1);
  const buf = Buffer.alloc(512);
  while (fnStatus(buf, buf.length, levelPtr)) {
    const msg = buf.toString('utf8').replace(/\0.*$/, '').trim();
    if (msg) {
      log?.(`[Hook] ${msg}`);
    }
  }
}

function cleanupHook(force = false) {
  if (!fnCleanup) return;
  if (!force && !hookActive) return;
  try {
    fnCleanup();
  } catch {
    // ignore
  }
  hookActive = false;
}

function applyRawKey(rawKeyHex, dbFiles, saltToDbs, keyMap, remainingSalts, log) {
  const raw = Buffer.from(rawKeyHex, 'hex');
  if (raw.length !== 32) {
    return 0;
  }

  lastHookPassphrase = raw;

  let matched = 0;
  for (const item of dbFiles) {
    if (!remainingSalts.has(item.salt)) continue;
    if (verifyEncKey(raw, item.page1)) {
      keyMap[item.salt] = rawKeyHex;
      remainingSalts.delete(item.salt);
      matched += 1;
    }
  }

  if (matched > 0) {
    log?.(`Hook 密钥直接验证成功: ${matched} 个数据库`);
    return matched;
  }

  matched = deriveKeysFromPassphrase(
    raw,
    dbFiles,
    saltToDbs,
    keyMap,
    remainingSalts,
    log,
    'Hook PBKDF2'
  );
  return matched;
}

async function finalizeHookPassphraseKeys({
  dbDir,
  dbFiles,
  saltToDbs,
  keyMap,
  remainingSalts,
  onProgress,
}) {
  const log = (message) => onProgress?.({ phase: 'keys', message });
  const passphrase = lastHookPassphrase;
  if (!passphrase) return false;

  log('登录后重新读取数据库文件头，并用 passphrase 派生密钥...');
  await sleep(800);

  const { collectDbFiles } = require('./decryptDb');
  const fresh = collectDbFiles(dbDir);

  dbFiles.splice(0, dbFiles.length, ...fresh.dbFiles);
  for (const key of Object.keys(saltToDbs)) {
    delete saltToDbs[key];
  }
  Object.assign(saltToDbs, fresh.saltToDbs);

  for (const key of Object.keys(keyMap)) {
    delete keyMap[key];
  }
  remainingSalts.clear();
  for (const salt of Object.keys(saltToDbs)) {
    remainingSalts.add(salt);
  }

  const matched = deriveKeysFromPassphrase(
    passphrase,
    dbFiles,
    saltToDbs,
    keyMap,
    remainingSalts,
    log,
    'Hook PBKDF2(登录后)'
  );

  return matched > 0;
}

async function extractKeysViaDllHook({
  dbDir,
  dbFiles,
  saltToDbs,
  keyMap,
  remainingSalts,
  onProgress,
  wxDir = null,
}) {
  const log = (message) => onProgress?.({ phase: 'keys', message });

  if (!loadDll()) {
    throw new Error(
      '内置解密模块未加载。\n' +
        '请确认使用的是完整安装包；若从文件夹版运行，请保留整个 win-unpacked 目录。'
    );
  }

  log('');
  log('微信 4.1.10+ 使用内置 Hook 模块拦截密钥');
  log('流程：重启微信 → 安装 Hook → Hook 就绪后再点击「登录」');
  log('');

  if (!isProcessElevated()) {
    log('警告: 当前未以管理员身份运行，Hook 很可能失败');
    log('请右键「以管理员身份运行」终端或 Electron 后再试');
  }

  const weixinExe = rememberWeixinExecutable();
  if (weixinExe) {
    log(`微信路径: ${weixinExe}`);
  }

  await prepareWeChatWithHook({ weixinExe, wxDir, onProgress });

  log('Hook 已就绪 — 现在请在微信中点击「登录」，工具会自动捕获密钥');
  await focusWeChatWindow(log, { retries: 5, intervalMs: 500 });

  const deadline = Date.now() + 180000;
  const keyBuf = Buffer.alloc(128);
  let lastStatusRound = 0;
  let relaunchAttempted = false;

  try {
    while (remainingSalts.size > 0 && Date.now() < deadline) {
      drainStatusMessages(log);

      if (fnPoll(keyBuf, keyBuf.length)) {
        const keyHex = keyBuf.toString('utf8').replace(/\0.*$/, '').trim();
        if (/^[0-9a-fA-F]{64}$/.test(keyHex)) {
          log(`捕获到 32 字节密钥: ${keyHex.slice(0, 8)}...`);
          applyRawKey(keyHex, dbFiles, saltToDbs, keyMap, remainingSalts, log);
        }
      }

      if (Object.keys(keyMap).length > 0) {
        log(`Hook 捕获成功: ${Object.keys(keyMap).length}/${Object.keys(saltToDbs).length} 个密钥`);
        break;
      }

      lastStatusRound += 1;

      if (
        !relaunchAttempted &&
        lastStatusRound > 60 &&
        (await isWeixinLoggedIn(wxDir)) &&
        Object.keys(keyMap).length === 0
      ) {
        relaunchAttempted = true;
        log('微信已登录但未捕获到密钥，可能是登录过早 — 正在重新尝试…');
        cleanupHook(true);
        await prepareWeChatWithHook({ weixinExe, wxDir, onProgress, maxRestarts: 0 });
        log('Hook 已就绪 — 请再次点击「登录」');
        await focusWeChatWindow(log, { retries: 5, intervalMs: 500 });
        lastStatusRound = 0;
        continue;
      }

      if (lastStatusRound % 30 === 0) {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        log(`等待密钥... 剩余 ${left}s（请点击登录）`);
      }

      await sleep(100);
    }
  } finally {
    cleanupHook(true);
  }

  if (lastHookPassphrase) {
    await finalizeHookPassphraseKeys({
      dbDir,
      dbFiles,
      saltToDbs,
      keyMap,
      remainingSalts,
      onProgress,
    });
  }

  if (Object.keys(keyMap).length === 0) {
    throw new Error(
      '未能捕获解密密钥，请按以下步骤重试：\n' +
        '1. 右键本程序，选择「以管理员身份运行」\n' +
        '2. 确认微信已登录，并打开几个聊天窗口\n' +
        '3. 扫描时若微信被重启，等「Hook 已就绪」后再点击「登录」'
    );
  }
}

function isDllHookAvailable() {
  return Boolean(resolveDllPath());
}

module.exports = {
  extractKeysViaDllHook,
  isDllHookAvailable,
  resolveDllPath,
  cleanupHook,
  applyRawKey,
  getLastHookPassphrase,
};
