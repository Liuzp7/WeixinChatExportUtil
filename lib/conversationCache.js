const fs = require('fs');
const path = require('path');

function getMessageDirs(accountPath) {
  return [
    path.join(accountPath, 'db_storage_decrypted', 'message'),
    path.join(accountPath, 'db_storage', 'message'),
  ].filter((dir) => fs.existsSync(dir));
}

function getAccountFingerprint(accountPath) {
  const parts = [];
  for (const dir of getMessageDirs(accountPath)) {
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .sort();
    for (const file of files) {
      const stat = fs.statSync(path.join(dir, file));
      parts.push(`${file}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
    }
  }
  return parts.join('|') || 'empty';
}

function loadCacheStore(cachePath) {
  try {
    if (fs.existsSync(cachePath)) {
      const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    }
  } catch {
    // ignore broken cache
  }
  return {};
}

function saveCacheStore(cachePath, store) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(store, null, 2), 'utf8');
}

function getConversationCache(cachePath, accountPath) {
  if (!accountPath) {
    return null;
  }

  const store = loadCacheStore(cachePath);
  const entry = store[accountPath];
  if (!entry || !Array.isArray(entry.conversations)) {
    return null;
  }

  const fingerprint = getAccountFingerprint(accountPath);
  return {
    ...entry,
    accountPath,
    fingerprint,
    stale: entry.fingerprint !== fingerprint,
  };
}

function saveConversationCache(cachePath, accountPath, payload) {
  if (!accountPath || !payload?.conversations?.length) {
    return null;
  }

  const store = loadCacheStore(cachePath);
  const entry = {
    fingerprint: getAccountFingerprint(accountPath),
    scannedAt: new Date().toISOString(),
    conversationCount: payload.conversationCount,
    totalMessages: payload.totalMessages,
    selfWxid: payload.selfWxid || null,
    displayName: payload.displayName || null,
    conversations: payload.conversations,
  };
  store[accountPath] = entry;
  saveCacheStore(cachePath, store);
  return entry;
}

function clearConversationCache(cachePath, accountPath) {
  const store = loadCacheStore(cachePath);
  if (!store[accountPath]) {
    return false;
  }
  delete store[accountPath];
  saveCacheStore(cachePath, store);
  return true;
}

function updateCacheDisplayName(cachePath, accountPath, displayName) {
  if (!displayName) {
    return false;
  }
  const store = loadCacheStore(cachePath);
  if (!store[accountPath]) {
    return false;
  }
  store[accountPath].displayName = displayName;
  saveCacheStore(cachePath, store);
  return true;
}

function listConversationCaches(cachePath) {
  const store = loadCacheStore(cachePath);
  return Object.entries(store)
    .filter(([, entry]) => Array.isArray(entry.conversations) && entry.conversations.length)
    .map(([accountPath, entry]) => {
      const fingerprint = getAccountFingerprint(accountPath);
      return {
        accountPath,
        scannedAt: entry.scannedAt,
        conversationCount: entry.conversationCount,
        totalMessages: entry.totalMessages,
        selfWxid: entry.selfWxid || null,
        displayName: entry.displayName || null,
        fingerprint,
        stale: entry.fingerprint !== fingerprint,
      };
    })
    .sort((a, b) => new Date(b.scannedAt || 0) - new Date(a.scannedAt || 0));
}

module.exports = {
  getAccountFingerprint,
  getConversationCache,
  saveConversationCache,
  clearConversationCache,
  listConversationCaches,
  updateCacheDisplayName,
};
