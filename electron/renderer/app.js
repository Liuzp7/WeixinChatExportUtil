const wxDirInput = document.getElementById('wxDir');
const accountField = document.getElementById('accountField');
const accountSelect = document.getElementById('accountSelect');
const accountHint = document.getElementById('accountHint');
const keysPathInput = document.getElementById('keysPath');
const outputDirInput = document.getElementById('outputDir');
const selfWxidInput = document.getElementById('selfWxid');
const wxDirHint = document.getElementById('wxDirHint');
const readinessPanel = document.getElementById('readinessPanel');
const readinessBadge = document.getElementById('readinessBadge');
const readinessHint = document.getElementById('readinessHint');
const readinessSuggestions = document.getElementById('readinessSuggestions');
const readinessProcesses = document.getElementById('readinessProcesses');
const startBtn = document.getElementById('startBtn');
const openOutputBtn = document.getElementById('openOutputBtn');
const progressText = document.getElementById('progressText');
const progressFill = document.getElementById('progressFill');
const logEl = document.getElementById('log');

let lastOutputDir = '';
let scannedAccounts = [];

function appendLog(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${message}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setProgress(percent, text) {
  progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  progressText.textContent = text;
}

function getSelectedAccountPath() {
  return accountSelect.value || null;
}

function renderAccountOptions(accounts, selectedPath = null) {
  scannedAccounts = accounts;
  accountSelect.innerHTML = '';

  if (!accounts.length) {
    accountField.classList.add('hidden');
    accountHint.textContent = '';
    return;
  }

  if (accounts.length === 1) {
    accountField.classList.add('hidden');
    accountSelect.innerHTML = '';
    const option = document.createElement('option');
    option.value = accounts[0].path;
    option.textContent = accounts[0].label;
    accountSelect.appendChild(option);
    accountSelect.value = accounts[0].path;
    accountHint.textContent = '';
    return;
  }

  accountField.classList.remove('hidden');

  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '请选择要导出的微信账号';
  accountSelect.appendChild(placeholder);

  for (const account of accounts) {
    const option = document.createElement('option');
    option.value = account.path;
    option.textContent = account.label;
    accountSelect.appendChild(option);
  }

  if (selectedPath) {
    accountSelect.value = selectedPath;
  }

  accountHint.textContent = `共 ${accounts.length} 个账号，文件夹位于 xwechat_files 下`;
}

function applySelectedAccount(account) {
  if (!account) return;
  if (!selfWxidInput.value.trim()) {
    selfWxidInput.placeholder = account.wxid;
  }
}

async function pickDirectory(title, targetInput) {
  const selected = await window.exporter.pickDirectory({
    title,
    defaultPath: targetInput.value || undefined,
  });
  if (selected) {
    targetInput.value = selected;
    if (targetInput === wxDirInput) {
      validateWxDir(selected);
    }
  }
}

function renderReadiness(readiness) {
  if (!readiness) {
    readinessPanel.classList.add('hidden');
    return;
  }

  readinessPanel.classList.remove('hidden');

  const levelMap = {
    ready: { text: '可解密', className: 'ready' },
    fallback: { text: '可导出', className: 'fallback' },
    maybe: { text: '需预热', className: 'maybe' },
    not_ready: { text: '未就绪', className: 'not-ready' },
  };
  const badge = levelMap[readiness.level] || levelMap.not_ready;
  readinessBadge.textContent = badge.text;
  readinessBadge.className = `readiness-badge ${badge.className}`;
  readinessHint.textContent = readiness.hint || '';

  readinessSuggestions.innerHTML = '';
  for (const tip of readiness.suggestions || []) {
    const li = document.createElement('li');
    li.textContent = tip;
    readinessSuggestions.appendChild(li);
  }

  readinessProcesses.textContent = '';
  if (readiness.processes?.length) {
    const parts = readiness.processes.map((p) => {
      const tag = p.isPrimary ? '主进程' : '子进程';
      return `${p.imageName} PID ${p.pid} (${p.memMb}MB, ${tag})`;
    });
    readinessProcesses.textContent = `微信进程: ${parts.join(' · ')}`;
    if (readiness.dbPathInMemory) {
      readinessProcesses.textContent += ' · 内存中已检测到数据库路径';
    }
  }
}

async function validateWxDir(dir, accountPath = null) {
  if (!dir) {
    wxDirHint.textContent = '例如: D:\\WeChat\\xwechat_files（工具会自动扫描其中的账号）';
    wxDirHint.className = 'hint';
    renderAccountOptions([]);
    renderReadiness(null);
    return null;
  }

  const result = await window.exporter.validateWxDir({
    wxDir: dir,
    accountPath: accountPath || undefined,
  });

  if (!result.ok) {
    wxDirHint.textContent = result.error;
    wxDirHint.className = 'hint error';
    renderAccountOptions([]);
    renderReadiness(null);
    return null;
  }

  renderAccountOptions(result.accounts || [], result.resolved || accountPath);

  if (result.needsAccountSelection) {
    wxDirHint.textContent = result.hint;
    wxDirHint.className = 'hint';
    renderReadiness(null);
    return result;
  }

  wxDirHint.textContent = result.hint || `已识别账号目录: ${result.resolved}`;
  wxDirHint.className = 'hint ok';
  applySelectedAccount(result.selectedAccount);
  renderReadiness(result.readiness);
  return result;
}

document.getElementById('pickKeysPath').addEventListener('click', async () => {
  const selected = await window.exporter.pickFile({
    title: '选择密钥 JSON 文件',
    defaultPath: keysPathInput.value || undefined,
  });
  if (selected) {
    keysPathInput.value = selected;
  }
});

document.getElementById('pickWxDir').addEventListener('click', () => {
  pickDirectory('选择 xwechat_files 目录', wxDirInput);
});

document.getElementById('pickOutputDir').addEventListener('click', () => {
  pickDirectory('选择导出目录', outputDirInput);
});

wxDirInput.addEventListener('change', () => validateWxDir(wxDirInput.value.trim()));

accountSelect.addEventListener('change', async () => {
  const rootDir = wxDirInput.value.trim();
  const accountPath = getSelectedAccountPath();
  if (!rootDir || !accountPath) {
    renderReadiness(null);
    return;
  }

  const account = scannedAccounts.find((item) => item.path === accountPath);
  applySelectedAccount(account);
  await validateWxDir(rootDir, accountPath);
});

startBtn.addEventListener('click', async () => {
  const rootDir = wxDirInput.value.trim();
  const outputDir = outputDirInput.value.trim();
  const selfWxid = selfWxidInput.value.trim();
  const accountPath = getSelectedAccountPath();

  if (!rootDir || !outputDir) {
    appendLog('请先选择微信数据目录和导出目录');
    return;
  }

  if (scannedAccounts.length > 1 && !accountPath) {
    appendLog('请先选择要导出的微信账号');
    return;
  }

  const validation = await validateWxDir(rootDir, accountPath);
  if (!validation || validation.needsAccountSelection || !validation.resolved) {
    appendLog('请先选择要导出的微信账号');
    return;
  }

  const wxDir = validation.resolved;

  startBtn.disabled = true;
  openOutputBtn.disabled = true;
  logEl.textContent = '';
  setProgress(0, '准备中...');
  appendLog('开始解密并导出...');

  const statusCheck = await window.exporter.checkWeChatStatus({
    wxDir: rootDir,
    accountPath: wxDir,
  });
  if (statusCheck.ok && statusCheck.readiness) {
    renderReadiness(statusCheck.readiness);
    if (statusCheck.readiness.level === 'maybe') {
      appendLog('提示: 密钥可能尚未加载，建议先在微信中打开几个聊天窗口');
    } else if (statusCheck.readiness.level === 'not_ready') {
      appendLog('警告: 未检测到微信进程，解密可能失败');
    }
  }

  const result = await window.exporter.startExport({
    wxDir,
    outputDir,
    selfWxid: selfWxid || null,
    forceDecrypt: document.getElementById('forceDecrypt').checked,
    loginCapture: document.getElementById('loginCapture').checked,
    keysPath: keysPathInput.value.trim() || null,
  });

  startBtn.disabled = false;

  if (result.ok) {
    lastOutputDir = result.result.outputDir;
    openOutputBtn.disabled = false;
    setProgress(100, `完成：${result.result.conversationCount} 个会话，${result.result.totalMessages} 条消息`);
    appendLog(`导出完成: ${result.result.conversationCount} 个会话, ${result.result.totalMessages} 条消息`);
    appendLog(`索引文件: ${result.result.indexPath}`);
  } else {
    setProgress(0, '导出失败');
    appendLog(`错误: ${result.error}`);
  }
});

openOutputBtn.addEventListener('click', () => {
  if (lastOutputDir) {
    window.exporter.openPath(lastOutputDir);
  }
});

window.exporter.onProgress((event) => {
  if (event.phase === 'init' || event.phase === 'decrypt' || event.phase === 'keys') {
    appendLog(event.message);
    if (event.phase === 'decrypt' && event.current && event.total) {
      const percent = Math.round((event.current / event.total) * 30);
      setProgress(percent, event.message);
    } else if (event.phase === 'keys' || event.phase === 'decrypt') {
      setProgress(10, event.message);
    }
  } else if (event.phase === 'exporting') {
    const percent = event.totalCandidates
      ? 30 + Math.round((event.scanned / event.totalCandidates) * 70)
      : 30;
    setProgress(
      percent,
      `正在导出 ${event.displayName}（${event.current} 个会话，${event.totalMessages} 条消息）`
    );
    if (event.current % 10 === 0) {
      appendLog(`已导出 ${event.current} 个会话，累计 ${event.totalMessages} 条消息`);
    }
  } else if (event.phase === 'done') {
    setProgress(100, `完成：${event.conversationCount} 个会话，${event.totalMessages} 条消息`);
    appendLog(`导出完成: ${event.conversationCount} 个会话, ${event.totalMessages} 条消息`);
  } else if (event.phase === 'error') {
    appendLog(`错误: ${event.message}`);
  }
});

setProgress(0, '等待开始');
