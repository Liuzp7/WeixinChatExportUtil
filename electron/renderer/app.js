const STORAGE_KEY = 'wetrace.settings';

const wxDirInput = document.getElementById('wxDir');
const accountField = document.getElementById('accountField');
const accountList = document.getElementById('accountList');
const accountHint = document.getElementById('accountHint');
const scanToast = document.getElementById('scanToast');
const scanToastTitle = document.getElementById('scanToastTitle');
const scanToastMessage = document.getElementById('scanToastMessage');
const cancelScanBtn = document.getElementById('cancelScanBtn');
const scanToastElapsed = document.getElementById('scanToastElapsed');
const scanToastNote = document.getElementById('scanToastNote');
const cacheSection = document.getElementById('cacheSection');
const cacheList = document.getElementById('cacheList');
const rescanBtn = document.getElementById('rescanBtn');
const outputDirInput = document.getElementById('outputDir');
const wxDirHint = document.getElementById('wxDirHint');
const readinessPanel = document.getElementById('readinessPanel');
const readinessBadge = document.getElementById('readinessBadge');
const readinessHint = document.getElementById('readinessHint');
const readinessSuggestions = document.getElementById('readinessSuggestions');
const detectResults = document.getElementById('detectResults');
const autoDetectBtn = document.getElementById('autoDetectBtn');
const scanBtn = document.getElementById('scanBtn');
const step1Panel = document.getElementById('step1Panel');
const step2Panel = document.getElementById('step2Panel');
const step3Panel = document.getElementById('step3Panel');
const step4Panel = document.getElementById('step4Panel');
const step5Panel = document.getElementById('step5Panel');
const disclaimerAccepted = document.getElementById('disclaimerAccepted');
const welcomeNextBtn = document.getElementById('welcomeNextBtn');
const accountBackBtn = document.getElementById('accountBackBtn');
const exportBackBtn = document.getElementById('exportBackBtn');
const toExportBtn = document.getElementById('toExportBtn');
const openIndexBtn = document.getElementById('openIndexBtn');
const outputGuide = document.getElementById('outputGuide');
const convList = document.getElementById('convList');
const convSummary = document.getElementById('convSummary');
const convSearch = document.getElementById('convSearch');
const selectAllBtn = document.getElementById('selectAllBtn');
const selectNoneBtn = document.getElementById('selectNoneBtn');
const backBtn = document.getElementById('backBtn');
const startBtn = document.getElementById('startBtn');
const cancelBtn = document.getElementById('cancelBtn');
const openOutputBtn = document.getElementById('openOutputBtn');
const restartBtn = document.getElementById('restartBtn');
const progressText = document.getElementById('progressText');
const progressFill = document.getElementById('progressFill');
const logEl = document.getElementById('log');
const successSummary = document.getElementById('successSummary');
const appVersion = document.getElementById('appVersion');
const stepEls = [...document.querySelectorAll('.step')];
const appNotice = document.getElementById('appNotice');
const appNoticeIcon = document.getElementById('appNoticeIcon');
const appNoticeTitle = document.getElementById('appNoticeTitle');
const appNoticeMessage = document.getElementById('appNoticeMessage');
const appNoticeDetail = document.getElementById('appNoticeDetail');
const appNoticeBtn = document.getElementById('appNoticeBtn');

let currentStep = 1;
let noticeResolve = null;
let lastOutputDir = '';
let lastHtmlIndexPath = '';
let scannedAccounts = [];
let conversationItems = [];
let resolvedAccountPath = null;
let selectedAccountPath = null;
let exportRunning = false;
let scanRunning = false;
let userCancelledScan = false;
let scanElapsedTimer = null;
let scanStartedAt = 0;
let currentConversationCache = null;
let conversationCacheEntries = [];
const accountProfileCache = new Map();
let profileLoadToken = 0;

function cacheAccountProfiles(accounts) {
  for (const account of accounts) {
    accountProfileCache.set(account.path, {
      displayName: account.displayName,
      avatar: account.avatar,
    });
  }
}

function applyProfileCache(accounts) {
  return accounts.map((account) => {
    const cached = accountProfileCache.get(account.path);
    if (!cached) return account;
    return {
      ...account,
      displayName: cached.displayName || account.displayName || account.wxid,
      avatar: cached.avatar || account.avatar,
    };
  });
}

function loadSettingsLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

async function loadSettings() {
  const local = loadSettingsLocal();
  try {
    const saved = await window.exporter.loadSettings();
    if (saved && typeof saved === 'object' && Object.keys(saved).length > 0) {
      return { ...local, ...saved };
    }
  } catch {
    // fall back to localStorage
  }
  return local;
}

function saveSettings() {
  const settings = {
    wxDir: wxDirInput.value.trim(),
    outputDir: outputDirInput.value.trim(),
    formats: getSelectedFormats(),
    accountPath: selectedAccountPath,
    disclaimerAccepted: disclaimerAccepted.checked,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  window.exporter.saveSettings(settings).catch(() => {});
}

function applySettingsToForm(settings) {
  if (settings.wxDir) wxDirInput.value = settings.wxDir;
  if (settings.outputDir) outputDirInput.value = settings.outputDir;
  if (Array.isArray(settings.formats)) {
    for (const input of document.querySelectorAll('input[name="format"]')) {
      input.checked = settings.formats.includes(input.value);
    }
  }
  if (settings.accountPath) {
    selectedAccountPath = settings.accountPath;
  }
  if (typeof settings.disclaimerAccepted === 'boolean') {
    disclaimerAccepted.checked = settings.disclaimerAccepted;
    welcomeNextBtn.disabled = !settings.disclaimerAccepted;
  }
}

function getSelectedFormats() {
  return [...document.querySelectorAll('input[name="format"]:checked')].map((el) => el.value);
}

function getStepBlockedReason(step) {
  if (scanRunning) {
    return '正在扫描会话，请稍候完成后再切换步骤。';
  }
  if (exportRunning) {
    return '正在导出，请稍候完成或取消后再切换步骤。';
  }
  if (step === 2 && !disclaimerAccepted.checked) {
    return '请先勾选页面下方的免责声明，再点击「开始导出」按钮。';
  }
  if (step === 3 && !conversationItems.length) {
    return '请先选择微信账号并点击「扫描会话」，或加载上次扫描结果。';
  }
  if (step === 4 && !conversationItems.length) {
    return '请先完成会话扫描。';
  }
  if (step === 4 && !getSelectedUsernames().length) {
    return '请至少勾选一个要导出的会话，再点击「下一步」。';
  }
  if (step === 5 && !lastOutputDir) {
    return '请先完成导出，才能查看完成页。';
  }
  return null;
}

function canNavigateToStep(step) {
  if (step === currentStep || step < 1 || step > 5) {
    return false;
  }
  if (scanRunning || exportRunning) {
    return false;
  }
  if (step < currentStep) {
    return true;
  }
  return !getStepBlockedReason(step);
}

function updateStepNavUI() {
  stepEls.forEach((el) => {
    const n = Number(el.dataset.step);
    const clickable = canNavigateToStep(n);
    el.classList.toggle('clickable', clickable);
    el.classList.toggle('locked', !clickable && n !== currentStep);
    el.setAttribute('aria-current', n === currentStep ? 'step' : 'false');
    el.setAttribute('aria-disabled', clickable || n === currentStep ? 'false' : 'true');
    el.title = clickable
      ? `前往：${el.textContent.trim()}`
      : n === currentStep
        ? '当前步骤'
        : getStepBlockedReason(n) || '请先完成前面的步骤';
  });

  welcomeNextBtn.classList.toggle('cta-pulse', currentStep === 1 && disclaimerAccepted.checked);
}

function setStep(step) {
  currentStep = step;
  step1Panel.classList.toggle('hidden', step !== 1);
  step2Panel.classList.toggle('hidden', step !== 2);
  step3Panel.classList.toggle('hidden', step !== 3);
  step4Panel.classList.toggle('hidden', step !== 4);
  step5Panel.classList.toggle('hidden', step !== 5);

  stepEls.forEach((el) => {
    const n = Number(el.dataset.step);
    el.classList.toggle('active', n === step);
    el.classList.toggle('done', n < step);
  });
  updateStepNavUI();
}

async function navigateToStep(step) {
  if (step === currentStep) {
    return;
  }
  if (!canNavigateToStep(step)) {
    const reason = getStepBlockedReason(step);
    if (reason) {
      await showFriendlyError('还差一步', reason, null, 'guide');
    }
    return;
  }
  if (step === 2) {
    void refreshConversationCacheHint();
  }
  setStep(step);
}

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
  return selectedAccountPath;
}

function updateAccountCardSelection() {
  for (const card of accountList.querySelectorAll('.account-card')) {
    card.classList.toggle('selected', card.dataset.path === selectedAccountPath);
  }
}

function getAccountStatusClass(account) {
  if (account.mode === 'decrypted') return 'decrypted';
  if (account.mode === 'encrypted') return 'encrypted';
  return '';
}

function renderAccountOptions(accounts, selectedPath = null) {
  scannedAccounts = applyProfileCache(accounts);
  accountList.innerHTML = '';

  if (!accounts.length) {
    accountField.classList.add('hidden');
    selectedAccountPath = null;
    accountHint.textContent = '';
    return;
  }

  accountField.classList.remove('hidden');

  for (const account of scannedAccounts) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'account-card';
    card.dataset.path = account.path;

    if (account.avatar) {
      const img = document.createElement('img');
      img.className = 'account-avatar';
      img.src = account.avatar;
      img.alt = '';
      card.appendChild(img);
    } else {
      const placeholder = document.createElement('div');
      placeholder.className = 'account-avatar placeholder';
      placeholder.textContent = (account.displayName || account.wxid || '?').slice(0, 1).toUpperCase();
      card.appendChild(placeholder);
    }

    const info = document.createElement('div');
    info.className = 'account-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'account-name';
    nameEl.textContent = account.displayName || account.wxid;
    nameEl.title = nameEl.textContent;

    const wxidEl = document.createElement('div');
    wxidEl.className = 'account-wxid';
    wxidEl.textContent = account.wxid;
    wxidEl.title = account.wxid;

    const statusEl = document.createElement('span');
    statusEl.className = `account-status ${getAccountStatusClass(account)}`;
    statusEl.textContent = account.description || '未知状态';

    info.appendChild(nameEl);
    info.appendChild(wxidEl);
    info.appendChild(statusEl);
    card.appendChild(info);

    card.addEventListener('click', () => selectAccount(account.path));
    accountList.appendChild(card);
  }

  const defaultPath =
    selectedPath || (scannedAccounts.length === 1 ? scannedAccounts[0].path : selectedAccountPath);
  if (defaultPath) {
    selectedAccountPath = defaultPath;
  } else if (!scannedAccounts.some((item) => item.path === selectedAccountPath)) {
    selectedAccountPath = null;
  }

  updateAccountCardSelection();
  accountHint.textContent =
    scannedAccounts.length > 1 && !selectedAccountPath ? '请点击选择要导出的账号' : '';
}

async function loadAccountProfiles(accounts) {
  if (!accounts.length) return;

  const token = ++profileLoadToken;
  const pathsKey = accounts.map((a) => a.path).join('|');

  for (const card of accountList.querySelectorAll('.account-card')) {
    card.classList.add('loading');
  }

  let result;
  try {
    result = await window.exporter.enrichAccounts({ accounts });
  } finally {
    if (token === profileLoadToken) {
      for (const card of accountList.querySelectorAll('.account-card')) {
        card.classList.remove('loading');
      }
    }
  }

  if (token !== profileLoadToken) return;
  if (pathsKey !== accounts.map((a) => a.path).join('|')) return;

  if (result.ok && result.accounts?.length) {
    cacheAccountProfiles(result.accounts);
    renderAccountOptions(result.accounts, selectedAccountPath);
    updateAccountProfileHint(result.accounts);
  }
}

function updateAccountProfileHint(accounts) {
  const selected = accounts.find((item) => item.path === selectedAccountPath) || accounts[0];
  if (!selected) return;

  const noDecrypted = selected.mode === 'encrypted' && !selected.hasDecrypted;

  if (noDecrypted) {
    accountHint.textContent = '首次扫描会自动解密以显示昵称和头像';
    accountHint.className = 'hint';
  } else if (accounts.length > 1 && !selectedAccountPath) {
    accountHint.textContent = '请点击选择要导出的账号';
    accountHint.className = 'hint';
  } else {
    accountHint.textContent = '';
    accountHint.className = 'hint';
  }
}

async function selectAccount(accountPath) {
  selectedAccountPath = accountPath;
  resolvedAccountPath = accountPath;
  updateAccountCardSelection();
  saveSettings();
  accountHint.textContent = '';

  const rootDir = wxDirInput.value.trim();
  if (!rootDir) return;

  const status = await window.exporter.checkWeChatStatus({
    wxDir: rootDir,
    accountPath,
  });
  if (status.ok) {
    renderReadiness(status.readiness);
  } else {
    renderReadiness(null);
  }
  void refreshConversationCacheHint();
}

function renderReadiness(readiness) {
  if (!readiness) {
    readinessPanel.classList.add('hidden');
    return;
  }

  readinessPanel.classList.remove('hidden');
  const levelMap = {
    ready: { text: '微信已登录', className: 'ready' },
    fallback: { text: '微信已登录', className: 'fallback' },
    maybe: { text: '建议预热', className: 'maybe' },
    not_ready: { text: '微信未运行', className: 'not-ready' },
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
  readinessSuggestions.style.display = readinessSuggestions.children.length ? '' : 'none';
}

async function validateWxDir(dir, accountPath = null) {
  if (!dir) {
    wxDirHint.textContent = '通常位于 Documents 或 D:\\WeChat\\xwechat_files';
    wxDirHint.className = 'hint';
    renderAccountOptions([]);
    renderReadiness(null);
    resolvedAccountPath = null;
    void refreshConversationCacheHint();
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
    resolvedAccountPath = null;
    void refreshConversationCacheHint();
    return null;
  }

  renderAccountOptions(result.accounts || [], result.resolved || accountPath || selectedAccountPath);
  void loadAccountProfiles(result.accounts || []);

  if (result.needsAccountSelection) {
    wxDirHint.textContent = result.hint;
    wxDirHint.className = 'hint';
    renderReadiness(null);
    resolvedAccountPath = null;
    void refreshConversationCacheHint();
    return result;
  }

  resolvedAccountPath = result.resolved;
  selectedAccountPath = result.resolved;
  updateAccountCardSelection();
  wxDirHint.textContent = result.hint || '已识别微信账号';
  wxDirHint.className = 'hint ok';
  renderReadiness(result.readiness);
  void refreshConversationCacheHint();
  return result;
}

async function pickDirectory(title, targetInput) {
  const selected = await window.exporter.pickDirectory({
    title,
    defaultPath: targetInput.value || undefined,
  });
  if (selected) {
    targetInput.value = selected;
    saveSettings();
    if (targetInput === wxDirInput) {
      void validateWxDir(selected);
    }
  }
}

function formatCount(n) {
  return n.toLocaleString('zh-CN');
}

function renderConversationList(conversations) {
  conversationItems = conversations;
  convList.innerHTML = '';

  if (!conversations.length) {
    convList.innerHTML = '<div class="conv-item"><div class="conv-name">未找到可导出的会话</div></div>';
    updateConvSummary();
    return;
  }

  for (const conv of conversations) {
    const item = document.createElement('label');
    item.className = 'conv-item';
    item.dataset.name = conv.displayName.toLowerCase();

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.username = conv.username;
    checkbox.addEventListener('change', updateConvSummary);

    const main = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'conv-name';
    name.textContent = conv.displayName;

    const tag = document.createElement('span');
    tag.className = `type-tag ${conv.type === 'group' ? 'group' : ''}`;
    tag.textContent = conv.type === 'group' ? '群聊' : '私聊';
    name.appendChild(tag);

    const meta = document.createElement('div');
    meta.className = 'conv-meta';
    meta.textContent = conv.summary || conv.username;

    main.appendChild(name);
    main.appendChild(meta);

    const count = document.createElement('div');
    count.className = 'conv-count';
    count.textContent = `${formatCount(conv.messageCount)} 条`;

    item.appendChild(checkbox);
    item.appendChild(main);
    item.appendChild(count);
    convList.appendChild(item);
  }

  updateConvSummary();
}

function getVisibleConvCheckboxes() {
  return [...convList.querySelectorAll('.conv-item:not(.hidden-by-search) input[type="checkbox"]')];
}

function getSelectedUsernames() {
  return [...convList.querySelectorAll('input[type="checkbox"]:checked')].map((el) => el.dataset.username);
}

function updateConvSummary() {
  const selected = getSelectedUsernames();
  const selectedMessages = conversationItems
    .filter((item) => selected.includes(item.username))
    .reduce((sum, item) => sum + item.messageCount, 0);

  convSummary.textContent = `已选 ${selected.length} / ${conversationItems.length} 个会话，约 ${formatCount(selectedMessages)} 条消息`;
  toExportBtn.disabled = selected.length === 0;
  startBtn.disabled = exportRunning;
  updateStepNavUI();
}

function setConvSelection(checked) {
  for (const checkbox of getVisibleConvCheckboxes()) {
    checkbox.checked = checked;
  }
  updateConvSummary();
}

function filterConversations(keyword) {
  const q = keyword.trim().toLowerCase();
  for (const item of convList.querySelectorAll('.conv-item')) {
    const name = item.dataset.name || '';
    item.classList.toggle('hidden-by-search', q && !name.includes(q));
  }
  updateConvSummary();
}

function inferNoticeTone(title, message) {
  const text = `${title} ${message || ''}`;
  if (/失败|错误|无法删除|无法扫描|导出失败|扫描失败|检测失败|删除失败/.test(text)) {
    return 'error';
  }
  if (/请先|请选择|未选择|未找到|还差|暂时|建议|确认/.test(text)) {
    return 'guide';
  }
  return 'warn';
}

const NOTICE_ICON = {
  guide: 'i',
  warn: '!',
  error: '!',
};

function hideAppNotice() {
  appNotice.classList.add('hidden');
  if (noticeResolve) {
    noticeResolve();
    noticeResolve = null;
  }
}

function showAppNotice({ title, message, detail, tone = 'guide' }) {
  return new Promise((resolve) => {
    noticeResolve = resolve;
    appNoticeTitle.textContent = title || '提示';
    appNoticeMessage.textContent = message || '';
    if (detail) {
      appNoticeDetail.textContent = detail;
      appNoticeDetail.classList.remove('hidden');
    } else {
      appNoticeDetail.textContent = '';
      appNoticeDetail.classList.add('hidden');
    }
    appNoticeIcon.textContent = NOTICE_ICON[tone] || NOTICE_ICON.guide;
    appNoticeIcon.className = `app-notice-icon ${tone}`;
    appNotice.classList.remove('hidden');
    appNoticeBtn.focus();
  });
}

async function showFriendlyError(title, message, detail, tone) {
  const resolvedTone = tone || inferNoticeTone(title, message);
  await showAppNotice({
    title,
    message,
    detail,
    tone: resolvedTone,
  });
}

function getExportOptions() {
  return {
    wxDir: wxDirInput.value.trim(),
    accountPath: resolvedAccountPath || getSelectedAccountPath(),
    outputDir: outputDirInput.value.trim(),
    selfWxid: null,
    forceDecrypt: false,
    loginCapture: true,
    keysPath: null,
    formats: getSelectedFormats(),
    selectedUsernames: getSelectedUsernames(),
  };
}

function formatElapsed(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min} 分 ${sec.toString().padStart(2, '0')} 秒` : `${sec} 秒`;
}

function formatCacheTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sanitizeScanMessage(msg) {
  return msg
    .replace(/db_storage[^\s]*/g, '数据')
    .replace(/\.wexin_passphrase/g, '密钥')
    .replace(/Weixin\.dll/g, '微信组件')
    .replace(/Weixin\.exe/g, '微信');
}

function friendlyScanMessage(event) {
  const msg = event?.message || '';
  const phase = event?.phase || '';

  if (phase === 'decrypt' && event.current && event.total) {
    return `正在解密数据（${event.current}/${event.total}）…`;
  }

  if (phase === 'keys' && msg) {
    if (msg.includes('Hook 已就绪') || msg.includes('请点击「登录」') || msg.includes('点击「登录」')) {
      return 'Hook 已就绪，请在微信窗口点击「登录」（通常无需扫码）';
    }
    if (msg.includes('请先不要点击') || msg.includes('不要点击登录') || msg.includes('等待提示后再点击')) {
      return '正在安装 Hook，请先不要点击「登录」…';
    }
    if (msg.includes('等待密钥') || msg.includes('仍在捕获')) {
      return sanitizeScanMessage(msg);
    }
    if (msg.includes('正在安装 Hook') || msg.includes('Hook 尚未就绪') || msg.includes('等待微信组件')) {
      return '正在安装 Hook，请先不要点击「登录」…';
    }
    if (msg.includes('已启动微信') || msg.includes('等待微信启动') || msg.includes('未检测到 Weixin')) {
      return sanitizeScanMessage(msg);
    }
    if (msg.includes('已结束进程') || msg.includes('重新启动') || msg.includes('关闭微信')) {
      return '正在重启微信以捕获密钥…';
    }
    if (msg.includes('管理员')) {
      return sanitizeScanMessage(msg);
    }
    if (msg.includes('提取') || msg.includes('密钥') || msg.includes('Hook') || msg.includes('捕获')) {
      return sanitizeScanMessage(msg);
    }
  }

  if (msg.includes('正在从微信进程内存提取数据库密钥')) {
    return '正在准备获取解密密钥…';
  }
  if (msg.includes('解密数据库文件') || msg.startsWith('解密中')) {
    return '正在解密聊天记录…';
  }
  if (msg.includes('解密完成')) {
    return '解密完成，正在整理会话…';
  }
  if (msg.includes('跳过解密')) {
    return '正在读取已有数据…';
  }
  if (msg.includes('会话列表') || msg.includes('统计会话')) {
    return '正在整理会话列表…';
  }
  if (msg.includes('未找到已解密') || msg.includes('首次扫描需要解密')) {
    return '首次扫描需要解密，可能需要几分钟…';
  }
  return sanitizeScanMessage(msg) || '处理中…';
}

function friendlyScanTitle(event) {
  const phase = event?.phase || '';
  const msg = event?.message || '';
  if (phase === 'keys') return '正在获取密钥';
  if (phase === 'decrypt') {
    if (msg.includes('解密中') || msg.includes('解密数据库')) return '正在解密';
    if (msg.includes('提取') || msg.includes('密钥')) return '正在获取密钥';
    return '正在解密';
  }
  return '正在扫描';
}

function friendlyScanNote(event) {
  const msg = event?.message || '';
  const phase = event?.phase || '';

  if (phase === 'keys') {
    if (msg.includes('Hook 已就绪') || msg.includes('等待密钥') || msg.includes('仍在捕获') || msg.includes('点击「登录」')) {
      return '请在弹出的微信窗口点击「登录」。若长时间无响应，请右键本程序「以管理员身份运行」后重试。';
    }
    if (
      msg.includes('请先不要点击') ||
      msg.includes('不要点击登录') ||
      msg.includes('正在安装 Hook') ||
      msg.includes('Hook 尚未就绪') ||
      msg.includes('后台启动')
    ) {
      return '微信已重启，正在安装 Hook。看到「Hook 已就绪」后再点击「登录」，否则无法捕获密钥。';
    }
    if (msg.includes('管理员') || msg.includes('安装 Hook')) {
      return '获取密钥需要管理员权限。请关闭本程序，右键「以管理员身份运行」后再扫描。';
    }
    return '工具会暂时关闭并重启微信，Hook 就绪后再点击「登录」。整个过程通常 1～3 分钟。';
  }

  if (phase === 'decrypt' && (msg.includes('提取') || msg.includes('密钥'))) {
    return '首次扫描需要获取解密密钥。若弹出微信，请点击「登录」。';
  }

  return '首次扫描可能需要几分钟。若弹出微信，请点击「登录」';
}

function startScanElapsedTimer() {
  stopScanElapsedTimer();
  scanStartedAt = Date.now();
  scanToastElapsed.textContent = '已等待 0 秒';
  scanElapsedTimer = setInterval(() => {
    scanToastElapsed.textContent = `已等待 ${formatElapsed(Date.now() - scanStartedAt)}`;
  }, 1000);
}

function stopScanElapsedTimer() {
  if (scanElapsedTimer) {
    clearInterval(scanElapsedTimer);
    scanElapsedTimer = null;
  }
  scanToastElapsed.textContent = '';
}

function getParentDir(filePath) {
  const normalized = filePath.replace(/[/\\]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'));
  return idx >= 0 ? normalized.slice(0, idx) : normalized;
}

function getAccountLabel(accountPath, selfWxid = null) {
  const account = scannedAccounts.find((item) => item.path === accountPath);
  if (account?.displayName) {
    return account.displayName;
  }
  if (selfWxid) {
    return selfWxid;
  }
  const folderName = accountPath.split(/[/\\]/).pop() || accountPath;
  const match = folderName.match(/^(.+?)_c[a-f0-9]+$/i);
  return match ? match[1] : folderName;
}

async function refreshConversationCacheHint() {
  const selectedPath = getSelectedAccountPath();
  const result = await window.exporter.listConversationCaches();
  if (!result.ok || !result.caches?.length) {
    conversationCacheEntries = [];
    currentConversationCache = null;
    cacheSection.classList.add('hidden');
    cacheList.innerHTML = '';
    scanBtn.textContent = '扫描会话';
    return;
  }

  conversationCacheEntries = result.caches;
  currentConversationCache = selectedPath
    ? result.caches.find((item) => item.accountPath === selectedPath) || null
    : null;

  renderConversationCacheList(result.caches, selectedPath);
  cacheSection.classList.remove('hidden');

  const selectedCache = currentConversationCache;
  scanBtn.textContent = selectedCache ? '重新扫描' : '扫描会话';
}

function renderConversationCacheList(caches, selectedPath) {
  cacheList.innerHTML = '';

  for (const cache of caches) {
    const item = document.createElement('div');
    item.className = 'cache-item';
    if (cache.accountPath === selectedPath) {
      item.classList.add('selected');
    }
    if (cache.stale) {
      item.classList.add('stale');
    }

    const info = document.createElement('div');
    info.className = 'cache-item-info';

    const title = document.createElement('div');
    title.className = 'cache-item-title';
    title.textContent = getAccountLabel(cache.accountPath, cache.selfWxid);

    const meta = document.createElement('div');
    meta.className = 'cache-item-meta';
    const scannedAt = formatCacheTime(cache.scannedAt);
    const staleNote = cache.stale ? ' · 可能有新消息' : '';
    meta.textContent = `${cache.conversationCount} 个会话，约 ${formatCount(cache.totalMessages)} 条消息${scannedAt ? ` · ${scannedAt}` : ''}${staleNote}`;

    info.appendChild(title);
    info.appendChild(meta);
    item.appendChild(info);

    const actions = document.createElement('div');
    actions.className = 'cache-item-actions';

    const useBtn = document.createElement('button');
    useBtn.className = 'btn secondary';
    useBtn.type = 'button';
    useBtn.textContent = '使用';
    useBtn.addEventListener('click', () => useCachedConversations(cache.accountPath));

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn ghost danger-text';
    deleteBtn.type = 'button';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', () => deleteConversationCache(cache.accountPath));

    actions.appendChild(useBtn);
    actions.appendChild(deleteBtn);
    item.appendChild(actions);
    cacheList.appendChild(item);
  }
}

async function deleteConversationCache(accountPath) {
  const label = getAccountLabel(accountPath);
  const confirmed = window.confirm(`确定删除「${label}」的上次扫描结果吗？删除后需要重新扫描才能导出。`);
  if (!confirmed) {
    return;
  }

  const result = await window.exporter.clearConversationCache({ accountPath });
  if (!result.ok) {
    await showFriendlyError('删除失败', result.error || '无法删除扫描缓存');
    return;
  }

  if (getSelectedAccountPath() === accountPath) {
    currentConversationCache = null;
  }
  void refreshConversationCacheHint();
}

function applyConversationScanResult(result, { fromCache = false } = {}) {
  renderConversationList(result.conversations || []);
  setStep(3);
  if (fromCache) {
    appendLog(`已加载缓存：${result.conversationCount} 个会话，${formatCount(result.totalMessages)} 条消息`);
  } else {
    appendLog(`扫描完成：${result.conversationCount} 个会话，${formatCount(result.totalMessages)} 条消息`);
  }
}

function renderOutputGuide(formats) {
  const items = [];
  if (formats.includes('html')) {
    items.push('<strong>index.html</strong> — 用浏览器打开，浏览所有会话');
    items.push('<strong>chats/*.html</strong> — 每个会话的网页版聊天记录');
  }
  if (formats.includes('json')) {
    items.push('<strong>conversations.json</strong> — 会话索引');
    items.push('<strong>contacts.json</strong> — 联系人昵称');
    items.push('<strong>chats/*.json</strong> — 每个会话的完整数据');
  }
  if (formats.includes('txt')) {
    items.push('<strong>chats/*.txt</strong> — 纯文本格式，方便阅读');
  }
  if (formats.includes('csv')) {
    items.push('<strong>messages.csv</strong> — 全部消息汇总，可用 Excel 打开');
  }

  if (!items.length) {
    outputGuide.innerHTML = '';
    return;
  }

  outputGuide.innerHTML = `<strong>文件说明</strong><ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

async function useCachedConversations(accountPath = null) {
  const targetPath = accountPath || getSelectedAccountPath();
  if (!targetPath) {
    await showFriendlyError('请选择账号', '请先选择要导出的微信账号。');
    return;
  }

  const rootDir = wxDirInput.value.trim();
  if (!rootDir) {
    const parentDir = getParentDir(targetPath);
    wxDirInput.value = parentDir;
    saveSettings();
    await validateWxDir(parentDir, targetPath);
  } else if (targetPath !== getSelectedAccountPath()) {
    await selectAccount(targetPath);
  }

  const cacheResult = await window.exporter.loadConversationCache({ accountPath: targetPath });
  if (!cacheResult.ok || !cacheResult.cache?.conversations?.length) {
    await showFriendlyError('缓存不可用', '未找到该账号的上次扫描结果，请重新扫描。');
    void refreshConversationCacheHint();
    return;
  }

  currentConversationCache = cacheResult.cache;
  applyConversationScanResult(
    {
      conversations: cacheResult.cache.conversations,
      conversationCount: cacheResult.cache.conversationCount,
      totalMessages: cacheResult.cache.totalMessages,
    },
    { fromCache: true }
  );
}

function showScanToast(title, message, note = null) {
  scanToast.classList.remove('hidden');
  scanToastTitle.textContent = title;
  scanToastMessage.textContent = message;
  scanToastNote.textContent = note || scanToastNote.textContent;
  scanToastNote.classList.remove('hidden');
}

function hideScanToast() {
  scanToast.classList.add('hidden');
  stopScanElapsedTimer();
}

async function scanConversations({ forceRescan = false } = {}) {
  const rootDir = wxDirInput.value.trim();

  if (!rootDir) {
    await showFriendlyError('请选择目录', '请选择微信数据目录。');
    return;
  }

  const accountPath = getSelectedAccountPath();
  const validation = await validateWxDir(rootDir, accountPath);
  if (!validation || validation.needsAccountSelection || !accountPath) {
    await showFriendlyError('请选择账号', '请点击头像卡片，选择要导出的微信账号。');
    return;
  }

  resolvedAccountPath = accountPath;
  saveSettings();

  userCancelledScan = false;
  scanRunning = true;
  updateStepNavUI();
  scanBtn.disabled = true;
  scanBtn.textContent = '扫描中…';
  showScanToast('正在扫描', '正在准备，请稍候…');
  startScanElapsedTimer();

  const result = await window.exporter.scanConversations(getExportOptions());

  scanRunning = false;
  updateStepNavUI();
  scanBtn.disabled = false;
  hideScanToast();
  void refreshConversationCacheHint();

  if (result.cancelled || userCancelledScan) {
    scanBtn.textContent = currentConversationCache ? '重新扫描' : '扫描会话';
    return;
  }

  if (!result.ok) {
    scanBtn.textContent = currentConversationCache ? '重新扫描' : '扫描会话';
    await showFriendlyError(
      '扫描失败',
      result.error,
      '请确认微信已登录，并在微信中打开几个聊天窗口后重试。\n若仍失败，请以管理员身份运行本程序，并在 Hook 就绪后再点击微信「登录」。'
    );
    return;
  }

  applyConversationScanResult(result);
  scanBtn.textContent = '重新扫描';

  if (rootDir && resolvedAccountPath) {
    const status = await window.exporter.validateWxDir({
      wxDir: rootDir,
      accountPath: resolvedAccountPath,
    });
    if (status.ok && status.accounts?.length) {
      void loadAccountProfiles(status.accounts);
    }
  }
}

async function startExport() {
  const options = getExportOptions();

  if (!options.outputDir) {
    await showFriendlyError('请选择保存位置', '请选择导出文件的保存目录。');
    return;
  }

  if (!options.formats.length) {
    await showFriendlyError('请选择导出格式', '至少勾选一种导出格式（JSON / HTML / TXT / CSV）。');
    return;
  }

  if (!options.selectedUsernames.length) {
    await showFriendlyError('未选择会话', '请至少选择一个要导出的会话。');
    return;
  }

  exportRunning = true;
  updateStepNavUI();
  startBtn.disabled = true;
  cancelBtn.classList.remove('hidden');
  openOutputBtn.disabled = true;
  logEl.textContent = '';
  setProgress(0, '准备中…');
  appendLog('开始导出…');
  saveSettings();

  const result = await window.exporter.startExport({
    wxDir: resolvedAccountPath,
    outputDir: options.outputDir,
    selfWxid: options.selfWxid,
    forceDecrypt: options.forceDecrypt,
    loginCapture: options.loginCapture,
    keysPath: options.keysPath,
    formats: options.formats,
    selectedUsernames: options.selectedUsernames,
  });

  exportRunning = false;
  updateStepNavUI();
  cancelBtn.classList.add('hidden');
  startBtn.disabled = false;

  if (result.ok) {
    lastOutputDir = result.result.outputDir;
    lastHtmlIndexPath = result.result.htmlIndexPath || '';
    openOutputBtn.disabled = false;
    if (lastHtmlIndexPath) {
      openIndexBtn.classList.remove('hidden');
    } else {
      openIndexBtn.classList.add('hidden');
    }
    setProgress(100, '导出完成');
    successSummary.textContent = `共导出 ${result.result.conversationCount} 个会话，${formatCount(result.result.totalMessages)} 条消息。\n文件已保存到：${result.result.outputDir}`;
    renderOutputGuide(options.formats);
    setStep(5);
  } else if (result.cancelled) {
    setProgress(0, '已取消');
    appendLog('导出已取消');
  } else {
    setProgress(0, '导出失败');
    appendLog(`错误: ${result.error}`);
    await showFriendlyError(
      '导出失败',
      result.error,
      '常见原因：微信未登录、密钥未加载、目录无写入权限。\n建议先打开几个聊天窗口，或以管理员身份运行后重试。'
    );
  }
}

function renderDetectResults(paths) {
  detectResults.innerHTML = '';
  if (!paths.length) {
    detectResults.classList.add('hidden');
    return;
  }

  detectResults.classList.remove('hidden');
  for (const item of paths) {
    const row = document.createElement('div');
    row.className = 'detect-item';
    row.innerHTML = `<div><strong>${item.label}</strong><br><code>${item.path}</code></div>`;
    const btn = document.createElement('button');
    btn.className = 'btn ghost';
    btn.type = 'button';
    btn.textContent = '使用';
    btn.addEventListener('click', async () => {
      wxDirInput.value = item.path;
      saveSettings();
      await validateWxDir(item.path);
    });
    row.appendChild(btn);
    detectResults.appendChild(row);
  }
}

async function initApp() {
  const info = await window.exporter.getAppInfo();
  appVersion.textContent = `v${info.version}`;

  const settings = await loadSettings();
  applySettingsToForm(settings);

  setStep(settings.disclaimerAccepted ? 2 : 1);
  setProgress(0, '等待开始');

  if (settings.wxDir) {
    void validateWxDir(settings.wxDir, settings.accountPath || null);
    if (settings.wxDir || settings.outputDir) {
      window.exporter.saveSettings(settings).catch(() => {});
    }
  } else {
    void refreshConversationCacheHint();
  }
}

document.getElementById('pickWxDir').addEventListener('click', () => {
  pickDirectory('选择 xwechat_files 目录', wxDirInput);
});

document.getElementById('pickOutputDir').addEventListener('click', () => {
  pickDirectory('选择导出目录', outputDirInput);
});

wxDirInput.addEventListener('change', () => {
  saveSettings();
  void validateWxDir(wxDirInput.value.trim());
});

autoDetectBtn.addEventListener('click', async () => {
  autoDetectBtn.disabled = true;
  autoDetectBtn.textContent = '检测中…';
  const result = await window.exporter.detectWxPaths();
  autoDetectBtn.disabled = false;
  autoDetectBtn.textContent = '自动检测';

  if (!result.ok) {
    await showFriendlyError('检测失败', result.error || '无法扫描常见微信目录');
    return;
  }

  renderDetectResults(result.paths || []);
  if (!result.paths?.length) {
    wxDirHint.textContent = '未在常见位置找到微信数据，请手动浏览选择';
    wxDirHint.className = 'hint';
  }
});

scanBtn.addEventListener('click', () => scanConversations());
rescanBtn.addEventListener('click', () => scanConversations({ forceRescan: true }));

disclaimerAccepted.addEventListener('change', () => {
  welcomeNextBtn.disabled = !disclaimerAccepted.checked;
  saveSettings();
  updateStepNavUI();
});

stepEls.forEach((el) => {
  el.addEventListener('click', () => {
    void navigateToStep(Number(el.dataset.step));
  });
});

appNoticeBtn.addEventListener('click', hideAppNotice);
appNotice.querySelector('[data-notice-dismiss]').addEventListener('click', hideAppNotice);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !appNotice.classList.contains('hidden')) {
    hideAppNotice();
  }
});

welcomeNextBtn.addEventListener('click', () => {
  if (!disclaimerAccepted.checked) return;
  saveSettings();
  setStep(2);
  void refreshConversationCacheHint();
});

accountBackBtn.addEventListener('click', () => setStep(1));
exportBackBtn.addEventListener('click', () => setStep(3));

cancelScanBtn.addEventListener('click', async () => {
  userCancelledScan = true;
  await window.exporter.cancelScan();
  scanRunning = false;
  updateStepNavUI();
  scanBtn.disabled = false;
  scanBtn.textContent = currentConversationCache ? '重新扫描' : '扫描会话';
  hideScanToast();
});
backBtn.addEventListener('click', () => setStep(2));
toExportBtn.addEventListener('click', async () => {
  if (!getSelectedUsernames().length) {
    await showFriendlyError('未选择会话', '请至少选择一个要导出的会话。');
    return;
  }
  setStep(4);
});
startBtn.addEventListener('click', startExport);
cancelBtn.addEventListener('click', async () => {
  await window.exporter.cancelExport();
});
selectAllBtn.addEventListener('click', () => setConvSelection(true));
selectNoneBtn.addEventListener('click', () => setConvSelection(false));
convSearch.addEventListener('input', () => filterConversations(convSearch.value));

openOutputBtn.addEventListener('click', () => {
  if (lastOutputDir) {
    window.exporter.openPath(lastOutputDir);
  }
});

openIndexBtn.addEventListener('click', () => {
  if (lastHtmlIndexPath) {
    window.exporter.openPath(lastHtmlIndexPath);
  }
});

restartBtn.addEventListener('click', () => {
  setStep(2);
  setProgress(0, '等待开始');
  logEl.textContent = '';
  outputGuide.innerHTML = '';
});

document.querySelectorAll('input[name="format"]').forEach((input) => {
  input.addEventListener('change', saveSettings);
});

window.exporter.onProgress((event) => {
  if (event.phase === 'scan' || event.phase === 'init' || event.phase === 'decrypt' || event.phase === 'keys') {
    if (scanRunning) {
      showScanToast(
        friendlyScanTitle(event),
        friendlyScanMessage(event),
        friendlyScanNote(event)
      );
    }
    if (event.phase !== 'scan') {
      appendLog(event.message);
    }
  } else if (event.phase === 'exporting') {
    const percent = event.totalCandidates
      ? 25 + Math.round((event.scanned / event.totalCandidates) * 75)
      : 25;
    setProgress(
      percent,
      `正在导出 ${event.displayName}（${event.current}/${event.totalCandidates}）`
    );
    if (event.current % 5 === 0) {
      appendLog(`已导出 ${event.current} 个会话，累计 ${formatCount(event.totalMessages)} 条消息`);
    }
  } else if (event.phase === 'done') {
    setProgress(100, `完成：${event.conversationCount} 个会话，${formatCount(event.totalMessages)} 条消息`);
  } else if (event.phase === 'error') {
    appendLog(`错误: ${event.message}`);
  }
});

initApp();
