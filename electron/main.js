const { app, BrowserWindow, dialog, ipcMain, shell, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { resolveWxDir, getWxDirStatus } = require('../lib/exportCore');
const { detectWeChatDataPaths } = require('../lib/wxPathDetect');
const {
  getConversationCache,
  saveConversationCache,
  clearConversationCache,
  listConversationCaches,
  updateCacheDisplayName,
} = require('../lib/conversationCache');

let mainWindow = null;
let exportRunning = false;
let scanRunning = false;
let scanCancelRequested = false;
let exportCancelRequested = false;
let currentWorker = null;
let scanWorker = null;
let profileWorker = null;

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'wetrace-settings.json');
}

function getConversationCachePath() {
  return path.join(app.getPath('userData'), 'conversation-cache.json');
}

function resolveAppIconPath() {
  const candidates = ['icon.ico', 'icon.png', 'logo.svg'];
  for (const name of candidates) {
    const candidate = path.join(__dirname, '..', 'build', name);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function createWindow() {
  const iconPath = resolveAppIconPath();
  const icon = iconPath ? nativeImage.createFromPath(iconPath) : undefined;

  mainWindow = new BrowserWindow({
    width: 920,
    height: 820,
    minWidth: 720,
    minHeight: 680,
    title: '微迹 Wetrace',
    icon: icon && !icon.isEmpty() ? icon : iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function sendProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('export-progress', payload);
  }
}

function runScanWorker(options) {
  return new Promise((resolve, reject) => {
    if (scanWorker) {
      scanWorker.terminate().catch(() => {});
      scanWorker = null;
    }

    scanCancelRequested = false;
    let settled = false;
    const worker = new Worker(path.join(__dirname, 'scanWorker.js'), {
      workerData: { options },
    });
    scanWorker = worker;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      if (scanWorker === worker) {
        scanWorker = null;
      }
      worker.terminate().catch(() => {});
      handler(value);
    };

    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        sendProgress(msg.event);
      } else if (msg.type === 'done') {
        finish(resolve, msg);
      }
    });

    worker.on('error', (err) => {
      finish(reject, err);
    });

    worker.on('exit', (code) => {
      if (settled) return;
      if (scanCancelRequested) {
        finish(resolve, { ok: false, cancelled: true, error: '扫描已取消' });
        return;
      }
      if (code !== 0) {
        finish(reject, new Error(`扫描任务异常退出 (code ${code})`));
      }
    });
  });
}

function runProfileWorker(accounts) {
  return new Promise((resolve, reject) => {
    if (profileWorker) {
      profileWorker.terminate().catch(() => {});
      profileWorker = null;
    }

    let settled = false;
    const worker = new Worker(path.join(__dirname, 'profileWorker.js'), {
      workerData: { accounts: accounts || [] },
    });
    profileWorker = worker;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      if (profileWorker === worker) {
        profileWorker = null;
      }
      worker.terminate().catch(() => {});
      handler(value);
    };

    worker.on('message', (msg) => {
      if (msg.type === 'done') {
        finish(resolve, msg);
      }
    });

    worker.on('error', (err) => {
      finish(reject, err);
    });

    worker.on('exit', (code) => {
      if (!settled && code !== 0) {
        finish(reject, new Error(`资料加载任务异常退出 (code ${code})`));
      }
    });
  });
}

ipcMain.handle('load-settings', async () => {
  const settingsPath = getSettingsPath();
  try {
    if (fs.existsSync(settingsPath)) {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
  } catch {
    // ignore broken settings file
  }
  return {};
});

ipcMain.handle('save-settings', async (_event, settings) => {
  const settingsPath = getSettingsPath();
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings || {}, null, 2), 'utf8');
  return { ok: true };
});

ipcMain.handle('get-app-info', async () => {
  const pkg = require('../package.json');
  return {
    name: pkg.productName || '微迹 Wetrace',
    version: pkg.version,
    description: '珍藏每一段对话',
  };
});

ipcMain.handle('detect-wx-paths', async () => {
  try {
    return { ok: true, paths: detectWeChatDataPaths() };
  } catch (err) {
    return { ok: false, error: err.message, paths: [] };
  }
});

ipcMain.handle('pick-file', async (_event, { title, filters, defaultPath }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    defaultPath,
    properties: ['openFile'],
    filters: filters || [{ name: 'JSON', extensions: ['json'] }],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('pick-directory', async (_event, { title, defaultPath }) => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle('validate-wx-dir', async (_event, payload) => {
  const wxDir = typeof payload === 'string' ? payload : payload?.wxDir;
  const accountPath = typeof payload === 'object' ? payload?.accountPath : null;
  try {
    const status = getWxDirStatus(wxDir, { accountPath });
    if (status.needsAccountSelection) {
      return { ok: true, ...status, readiness: null };
    }
    const { checkWeChatReadiness } = require('../lib/wechatStatus');
    const readiness = checkWeChatReadiness(status.resolved);
    return { ok: true, ...status, readiness };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('enrich-accounts', async (_event, { accounts }) => {
  try {
    const msg = await runProfileWorker(accounts || []);
    if (msg.ok) {
      return { ok: true, accounts: msg.accounts || [] };
    }
    return { ok: false, error: msg.error, accounts: accounts || [] };
  } catch (err) {
    return { ok: false, error: err.message, accounts: accounts || [] };
  }
});

ipcMain.handle('check-wechat-status', async (_event, payload) => {
  const wxDir = typeof payload === 'string' ? payload : payload?.wxDir;
  const accountPath = typeof payload === 'object' ? payload?.accountPath : null;
  try {
    const { checkWeChatReadiness } = require('../lib/wechatStatus');
    const { scanWeChatAccounts } = require('../lib/exportCore');
    let resolved = accountPath || null;
    if (!resolved && wxDir) {
      const scan = scanWeChatAccounts(wxDir);
      resolved = scan.selectedPath;
    }
    if (!resolved && wxDir) {
      resolved = resolveWxDir(wxDir, { accountPath });
    }
    const readiness = checkWeChatReadiness(resolved || wxDir);
    return { ok: true, readiness, resolved };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('load-conversation-cache', async (_event, { accountPath }) => {
  try {
    const cache = getConversationCache(getConversationCachePath(), accountPath);
    if (!cache) {
      return { ok: true, cache: null };
    }
    return { ok: true, cache };
  } catch (err) {
    return { ok: false, error: err.message, cache: null };
  }
});

ipcMain.handle('clear-conversation-cache', async (_event, { accountPath }) => {
  try {
    clearConversationCache(getConversationCachePath(), accountPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('patch-conversation-cache-label', async (_event, { accountPath, displayName }) => {
  try {
    const updated = updateCacheDisplayName(getConversationCachePath(), accountPath, displayName);
    return { ok: updated };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('list-conversation-caches', async () => {
  try {
    const caches = listConversationCaches(getConversationCachePath());
    return { ok: true, caches };
  } catch (err) {
    return { ok: false, error: err.message, caches: [] };
  }
});

ipcMain.handle('scan-conversations', async (_event, options) => {
  if (scanRunning) {
    return { ok: false, error: '扫描正在进行中' };
  }

  scanRunning = true;
  try {
    const msg = await runScanWorker(options);
    if (msg.ok) {
      const accountPath = options.accountPath || msg.wxDir;
      saveConversationCache(getConversationCachePath(), accountPath, {
        conversationCount: msg.conversationCount,
        totalMessages: msg.totalMessages,
        selfWxid: msg.selfWxid,
        displayName: options.displayName || null,
        conversations: msg.conversations,
      });
      return {
        ok: true,
        conversations: msg.conversations,
        conversationCount: msg.conversationCount,
        totalMessages: msg.totalMessages,
        wxDir: msg.wxDir,
        selfWxid: msg.selfWxid,
      };
    }
    return { ok: false, error: msg.error, cancelled: Boolean(msg.cancelled) };
  } catch (err) {
    if (scanCancelRequested) {
      return { ok: false, cancelled: true, error: '扫描已取消' };
    }
    return { ok: false, error: err.message };
  } finally {
    scanRunning = false;
    scanWorker = null;
  }
});

ipcMain.handle('cancel-scan', async () => {
  scanCancelRequested = true;
  scanRunning = false;
  const worker = scanWorker;
  if (!worker) {
    return { ok: true, cancelled: true };
  }
  worker.postMessage({ type: 'cancel' });
  await worker.terminate().catch(() => {});
  if (scanWorker === worker) {
    scanWorker = null;
  }
  return { ok: true, cancelled: true };
});

function runExportInWorker(options) {
  return new Promise((resolve, reject) => {
    exportCancelRequested = false;
    let settled = false;
    const worker = new Worker(path.join(__dirname, 'exportWorker.js'), {
      workerData: {
        wxDir: options.wxDir,
        outputDir: options.outputDir,
        selfWxid: options.selfWxid,
        forceDecrypt: options.forceDecrypt,
        loginCapture: options.loginCapture,
        keysPath: options.keysPath,
        formats: options.formats,
        selectedUsernames: options.selectedUsernames,
      },
    });
    currentWorker = worker;

    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      if (currentWorker === worker) {
        currentWorker = null;
      }
      worker.terminate().catch(() => {});
      handler(value);
    };

    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        sendProgress(msg.event);
      } else if (msg.type === 'done') {
        finish(resolve, msg);
      }
    });

    worker.on('error', (err) => {
      finish(reject, err);
    });

    worker.on('exit', (code) => {
      if (settled) return;
      if (exportCancelRequested) {
        finish(resolve, { ok: false, cancelled: true, error: '导出已取消' });
        return;
      }
      if (code !== 0) {
        finish(reject, new Error(`导出任务异常退出 (code ${code})`));
      }
    });
  });
}

ipcMain.handle('start-export', async (_event, options) => {
  if (exportRunning) {
    return { ok: false, error: '导出任务正在进行中' };
  }

  exportRunning = true;
  try {
    const msg = await runExportInWorker({
      wxDir: options.wxDir,
      outputDir: options.outputDir,
      selfWxid: options.selfWxid || null,
      forceDecrypt: Boolean(options.forceDecrypt),
      loginCapture: options.loginCapture !== false,
      keysPath: options.keysPath || null,
      formats: options.formats || ['json'],
      selectedUsernames: options.selectedUsernames || null,
    });
    if (msg.ok) {
      return { ok: true, result: msg.result };
    }
    if (!msg.cancelled) {
      sendProgress({ phase: 'error', message: msg.error });
    }
    return { ok: false, error: msg.error, cancelled: Boolean(msg.cancelled) };
  } catch (err) {
    if (exportCancelRequested) {
      return { ok: false, cancelled: true, error: '导出已取消' };
    }
    sendProgress({ phase: 'error', message: err.message });
    return { ok: false, error: err.message };
  } finally {
    exportRunning = false;
    currentWorker = null;
  }
});

ipcMain.handle('cancel-export', async () => {
  exportCancelRequested = true;
  exportRunning = false;
  const worker = currentWorker;
  if (!worker) {
    return { ok: true, cancelled: true };
  }
  worker.postMessage({ type: 'cancel' });
  await worker.terminate().catch(() => {});
  if (currentWorker === worker) {
    currentWorker = null;
  }
  return { ok: true, cancelled: true };
});

ipcMain.handle('open-path', async (_event, targetPath) => {
  await shell.openPath(targetPath);
});

ipcMain.handle('show-error-dialog', async (_event, { title, message, detail }) => {
  await dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: title || '操作失败',
    message,
    detail: detail || '',
    buttons: ['知道了'],
  });
});

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.wetrace.exporter');
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
