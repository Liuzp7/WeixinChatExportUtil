const fs = require('fs');
const path = require('path');
const koffi = require('koffi');
const { verifyEncKey } = require('./decryptDb');
const { deriveKeysFromPassphrase } = require('./passphraseScan');
const {
  terminateWeChatProcesses,
  rememberWeixinExecutable,
  launchWeChat,
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

function resolveDllPath() {
  const candidates = [
    path.join(__dirname, '..', 'assets', 'dll', 'wexin_hook.dll'),
    path.join(__dirname, '..', 'assets', 'dll', 'wx_key.dll'),
    path.join(process.resourcesPath || '', 'assets', 'dll', 'wexin_hook.dll'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'assets', 'dll', 'wexin_hook.dll'),
    path.join(process.cwd(), 'assets', 'dll', 'wexin_hook.dll'),
    path.join(process.cwd(), 'assets', 'dll', 'wx_key.dll'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
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

  dllLib = koffi.load(dllPath);
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

async function initializeHookWithRetry(targetPid, log, maxAttempts = 20) {
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
      log('等待 Weixin.dll 加载完成后再试（无需先登录）...');
      await sleep(2000);
    } else {
      throw new Error(
        `Hook 初始化失败: ${err}\n` +
          '请确认:\n' +
          '1. 以管理员身份运行本工具（Hook 需要写入微信进程内存）\n' +
          '2. 微信已完全关闭后由工具自动重启\n' +
          '3. 安装完成后先等 Hook 就绪，再在微信里点击「登录」'
      );
    }
  }
  return false;
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
}) {
  const log = (message) => onProgress?.({ phase: 'keys', message });

  if (!loadDll()) {
    throw new Error(
      '微信 4.1.10+ 无法通过内存扫描获取密钥，需要内置 Hook 模块 wexin_hook.dll。\n' +
        `请运行: npm run build:hook\n` +
        `或从 GitHub Actions 产物下载 wexin_hook.dll 放到: ${path.join(__dirname, '..', 'assets', 'dll')}\n` +
        '也可使用下方「导入密钥文件」功能。'
    );
  }

  log('');
  log('微信 4.1.10+ 使用内置 Hook 模块拦截 Weixin.dll 密钥（无需 ExportWeChat）');
  log('流程：先安装 Hook → 再在微信里点击「登录」→ 自动捕获密钥');
  log('');

  if (!isProcessElevated()) {
    log('警告: 当前未以管理员身份运行，Hook 很可能失败');
    log('请右键「以管理员身份运行」终端或 Electron 后再试');
  }

  const weixinExe = rememberWeixinExecutable();
  if (weixinExe) {
    log(`微信路径: ${weixinExe}`);
  }

  cleanupHook(true);
  await terminateWeChatProcesses(log);
  await sleep(2000);

  launchWeChat(log, weixinExe);
  log('等待微信启动（此时无需登录）...');

  const targetPid = await waitForWeixinPid({ onProgress });
  if (!targetPid) {
    throw new Error('未检测到 Weixin.exe，请手动启动微信后重试');
  }

  log(`已检测到 Weixin.exe PID=${targetPid}，等待 Weixin.dll 加载...`);
  await sleep(5000);

  await initializeHookWithRetry(targetPid, log);
  log('Hook 已就绪 — 现在请在微信中点击「登录」，工具会自动捕获密钥');

  const deadline = Date.now() + 180000;
  const keyBuf = Buffer.alloc(128);
  let lastStatusRound = 0;

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
      if (lastStatusRound % 30 === 0) {
        const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
        log(`等待密钥... 剩余 ${left}s（请点击登录或打开聊天）`);
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
      'Hook 未捕获到密钥。请确认:\n' +
        '1. 以管理员身份运行本工具\n' +
        '2. 完全关闭微信后重试，并在提示后点击「登录」\n' +
        '3. 已构建 wexin_hook.dll（npm run build:hook）且版本支持微信 4.1.10.53\n' +
        '4. 或使用「导入密钥文件」功能'
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
