const fs = require('fs');
const path = require('path');
const { extractKeysFromWeChat } = require('./keyScan');
const { decryptAllDatabases } = require('./decryptDb');

function getDbStorageDir(wxDir) {
  return path.join(wxDir, 'db_storage');
}

function getDecryptedDir(wxDir) {
  return path.join(wxDir, 'db_storage_decrypted');
}

function hasEncryptedStorage(wxDir) {
  const dbDir = getDbStorageDir(wxDir);
  return fs.existsSync(path.join(dbDir, 'message')) || fs.existsSync(dbDir);
}

function hasDecryptedStorage(wxDir) {
  const decDir = getDecryptedDir(wxDir);
  return fs.existsSync(path.join(decDir, 'message'));
}

function needsDecrypt(wxDir, force = false) {
  if (force) return hasEncryptedStorage(wxDir);
  if (!hasEncryptedStorage(wxDir)) return false;
  if (!hasDecryptedStorage(wxDir)) return true;

  const encStat = fs.statSync(getDbStorageDir(wxDir));
  const decStat = fs.statSync(getDecryptedDir(wxDir));
  return encStat.mtimeMs > decStat.mtimeMs;
}

function writeInfoJson(wxDir) {
  const infoPath = path.join(getDecryptedDir(wxDir), 'info.json');
  const payload = {
    wx_dir: wxDir.replace(/\\/g, '/'),
    decrypted_by: 'wexinchat-exporter',
    decrypted_at: new Date().toISOString(),
  };
  fs.writeFileSync(infoPath, JSON.stringify(payload, null, 2), 'utf8');
  return infoPath;
}

async function decryptWeChatData({ wxDir, forceDecrypt = false, loginCapture = true, keysPath = null, onProgress }) {
  const dbDir = getDbStorageDir(wxDir);
  const outDir = getDecryptedDir(wxDir);

  if (!hasEncryptedStorage(wxDir)) {
    throw new Error('未找到加密的 db_storage 目录');
  }

  onProgress?.({ phase: 'decrypt', message: '正在从微信进程内存提取数据库密钥...' });
  const keys = await extractKeysFromWeChat({
    dbDir,
    wxDir,
    onProgress,
    loginCapture,
    keysPath,
  });

  onProgress?.({ phase: 'decrypt', message: '正在解密数据库文件...' });
  const result = decryptAllDatabases({
    dbDir,
    outDir,
    keys,
    onProgress: (event) => {
      if (event.phase === 'decrypting') {
        onProgress?.({
          phase: 'decrypt',
          message: `解密中 (${event.current}/${event.total}): ${event.rel} (${event.sizeMb}MB)`,
          ...event,
        });
      } else if (event.message) {
        onProgress?.({ phase: 'decrypt', message: event.message });
      }
    },
  });

  const infoPath = writeInfoJson(wxDir);

  onProgress?.({
    phase: 'decrypt',
    message: `解密完成: ${result.passed} 成功, ${result.failed} 失败, ${result.skipped} 跳过`,
  });

  if (result.passed === 0 && result.failed > 0) {
    throw new Error(`所有数据库解密失败（${result.failed} 个）。请确认微信已登录且 Hook 捕获的 passphrase 有效。`);
  }

  return {
    wxDir,
    decryptedDir: outDir,
    infoPath,
    ...result,
  };
}

async function ensureDecrypted({ wxDir, forceDecrypt = false, loginCapture = true, keysPath = null, onProgress }) {
  if (!needsDecrypt(wxDir, forceDecrypt)) {
    if (hasDecryptedStorage(wxDir)) {
      onProgress?.({ phase: 'decrypt', message: '已存在解密数据库，跳过解密步骤' });
      return { skipped: true, decryptedDir: getDecryptedDir(wxDir) };
    }
    throw new Error('未找到 db_storage 或 db_storage_decrypted');
  }

  if (!hasEncryptedStorage(wxDir)) {
    throw new Error('未找到加密的 db_storage 目录');
  }

  try {
    const result = await decryptWeChatData({ wxDir, forceDecrypt, loginCapture, keysPath, onProgress });
    return { skipped: false, ...result };
  } catch (err) {
    if (hasDecryptedStorage(wxDir) && !forceDecrypt) {
      onProgress?.({
        phase: 'decrypt',
        message:
          '无法从微信内存提取新密钥，将使用已有的 db_storage_decrypted。\n' +
          '提示：如需重新解密，请先打开微信并浏览几个聊天，再勾选「强制重新解密」。',
      });
      return {
        skipped: true,
        usedFallback: true,
        decryptedDir: getDecryptedDir(wxDir),
        warning: err.message,
      };
    }

    throw new Error(
      `${err.message}\n\n` +
        '请确认：\n' +
        '1. 微信 PC 版已启动并登录\n' +
        '2. 打开几个聊天窗口后再试\n' +
        '3. 以普通用户权限运行本工具（与微信同一用户）'
    );
  }
}

module.exports = {
  getDbStorageDir,
  getDecryptedDir,
  hasEncryptedStorage,
  hasDecryptedStorage,
  needsDecrypt,
  decryptWeChatData,
  ensureDecrypted,
};
