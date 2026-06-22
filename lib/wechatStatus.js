const fs = require('fs');
const path = require('path');
const { getWeChatProcesses, scanProcessForNeedles } = require('./winMemory');
const { buildPathNeedles } = require('./scanUtils');

function hasDecryptedStorage(wxDir) {
  const decDir = path.join(wxDir, 'db_storage_decrypted');
  return fs.existsSync(path.join(decDir, 'message'));
}

function getReadinessLevel({ running, dbPathInMemory, hasDecrypted }) {
  if (!running) return 'not_ready';
  if (dbPathInMemory) return 'ready';
  if (hasDecrypted) return 'fallback';
  return 'maybe';
}

function getReadinessHints(level) {
  switch (level) {
    case 'ready':
      return '微信进程正常，内存中已检测到数据库路径，可以尝试解密。';
    case 'fallback':
      return '微信已运行，但未在内存中检测到数据库路径。可先打开几个聊天再试；若已有 db_storage_decrypted 也可直接导出。';
    case 'maybe':
      return '微信已运行，但密钥可能尚未加载。请先在微信中打开 2～3 个聊天窗口，等待几秒后再点导出。';
    default:
      return '请先启动并登录微信 PC 版（Weixin.exe）。';
  }
}

function checkWeChatReadiness(wxDir) {
  const needles = buildPathNeedles(wxDir);
  let processes = [];

  try {
    processes = getWeChatProcesses();
  } catch (err) {
    return {
      running: false,
      level: 'not_ready',
      processes: [],
      dbPathInMemory: false,
      hasDecrypted: hasDecryptedStorage(wxDir),
      hint: err.message,
      suggestions: [
        '启动微信 PC 版并完成登录',
        '保持微信窗口不要最小化到托盘后立即退出',
      ],
    };
  }

  let dbPathInMemory = false;
  let matchedPid = null;

  for (const proc of processes) {
    const result = scanProcessForNeedles(proc.pid, needles, 400);
    if (result.found) {
      dbPathInMemory = true;
      matchedPid = proc.pid;
      break;
    }
  }

  const hasDecrypted = hasDecryptedStorage(wxDir);
  const level = getReadinessLevel({ running: true, dbPathInMemory, hasDecrypted });

  const suggestions = [];
  if (level === 'maybe' || level === 'fallback') {
    suggestions.push('在微信里点开 2～3 个最近聊天，让消息列表加载出来');
    suggestions.push('等待 3～5 秒后，再点击「开始解密并导出」');
  }
  if (level === 'maybe') {
    suggestions.push('若常规扫描失败，请勾选「登录时捕获密钥」后重试');
    suggestions.push('若仍失败，可完全退出微信后重新登录，再重复上述步骤');
  }
  if (level === 'maybe' || level === 'ready') {
    suggestions.push('微信 4.1.10+ 用户建议始终勾选「登录时捕获密钥」');
  }
  if (hasDecrypted) {
    suggestions.push('你已有 db_storage_decrypted，即使解密失败也可继续导出旧数据');
  }

  return {
    running: true,
    level,
    processes: processes.map((p) => ({
      pid: p.pid,
      imageName: p.imageName,
      memMb: Math.max(1, Math.round(p.memKb / 1024)),
      isPrimary: p.pid === processes[0].pid,
    })),
    dbPathInMemory,
    matchedPid,
    hasDecrypted,
    hint: getReadinessHints(level),
    suggestions,
  };
}

module.exports = {
  checkWeChatReadiness,
};
