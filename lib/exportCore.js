const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decompress } = require('fzstd');

const MSG_TYPE_MAP = {
  1: 'text',
  3: 'image',
  34: 'voice',
  42: 'card',
  43: 'video',
  47: 'emoji',
  48: 'location',
  49: 'link',
  10000: 'system',
  10002: 'revoke',
};

function getSqlJsLocateFile() {
  return (file) => {
    const candidates = [
      path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
    ];

    if (process.resourcesPath) {
      candidates.push(
        path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', file),
        path.join(process.resourcesPath, 'app', 'node_modules', 'sql.js', 'dist', file)
      );
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return candidates[0];
  };
}

function isWeChatAccountDir(dir) {
  return (
    fs.existsSync(path.join(dir, 'db_storage', 'message')) ||
    fs.existsSync(path.join(dir, 'db_storage_decrypted', 'message')) ||
    fs.existsSync(path.join(dir, 'db_storage', 'db_storage_decrypted', 'message'))
  );
}

function normalizeWxRootInput(inputPath) {
  const normalized = path.resolve(inputPath);
  if (!fs.existsSync(normalized)) {
    throw new Error(`路径不存在: ${normalized}`);
  }

  if (isWeChatAccountDir(normalized)) {
    return normalized;
  }

  if (path.basename(normalized) === 'db_storage_decrypted') {
    const parent = path.dirname(normalized);
    return isWeChatAccountDir(parent) ? parent : normalized;
  }

  if (path.basename(normalized) === 'db_storage') {
    const parent = path.dirname(normalized);
    return isWeChatAccountDir(parent) ? parent : normalized;
  }

  return normalized;
}

function parseAccountFolderName(folderName) {
  const match = folderName.match(/^(.+?)_c([a-f0-9]+)$/i);
  return {
    folderName,
    wxid: match ? match[1] : folderName,
    suffix: match ? match[2] : null,
  };
}

function describeAccountMode(summary) {
  const tags = [];
  if (summary.hasPassphraseCache) tags.push('已缓存密钥');
  if (summary.mode === 'encrypted') tags.push('需解密');
  else if (summary.mode === 'decrypted') tags.push('已解密');
  else if (summary.mode === 'both') tags.push('加密+已解密');
  return tags.join(' · ') || '未知状态';
}

function getAccountSummary(accountDir) {
  const parsed = parseAccountFolderName(path.basename(accountDir));
  const hasEncrypted = fs.existsSync(path.join(accountDir, 'db_storage', 'message'));
  const hasDecrypted = fs.existsSync(path.join(accountDir, 'db_storage_decrypted', 'message'));
  const hasPassphraseCache = fs.existsSync(path.join(accountDir, '.wexin_passphrase'));

  let mode = 'unknown';
  if (hasEncrypted && hasDecrypted) mode = 'both';
  else if (hasEncrypted) mode = 'encrypted';
  else if (hasDecrypted) mode = 'decrypted';

  const summary = {
    path: accountDir,
    folderName: parsed.folderName,
    wxid: parsed.wxid,
    suffix: parsed.suffix,
    hasEncrypted,
    hasDecrypted,
    hasPassphraseCache,
    mode,
  };
  summary.description = describeAccountMode(summary);
  summary.label = `${parsed.wxid}${summary.description ? `（${summary.description}）` : ''}`;
  return summary;
}

function scanWeChatAccounts(inputPath) {
  const normalized = normalizeWxRootInput(inputPath);

  if (isWeChatAccountDir(normalized)) {
    const summary = getAccountSummary(normalized);
    return {
      rootDir: path.dirname(normalized),
      inputPath: normalized,
      accounts: [summary],
      selectedPath: summary.path,
      needsAccountSelection: false,
    };
  }

  const entries = fs.readdirSync(normalized, { withFileTypes: true });
  const accounts = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(normalized, entry.name))
    .filter(isWeChatAccountDir)
    .map(getAccountSummary)
    .sort((a, b) => a.folderName.localeCompare(b.folderName));

  return {
    rootDir: normalized,
    inputPath: normalized,
    accounts,
    selectedPath: accounts.length === 1 ? accounts[0].path : null,
    needsAccountSelection: accounts.length > 1,
  };
}

function resolveWxDir(inputPath, options = {}) {
  const { accountPath = null } = options;

  if (accountPath) {
    const resolvedAccount = path.resolve(accountPath);
    if (!isWeChatAccountDir(resolvedAccount)) {
      throw new Error('所选微信账号目录无效，请重新选择');
    }
    return resolvedAccount;
  }

  const scan = scanWeChatAccounts(inputPath);

  if (scan.accounts.length === 0) {
    throw new Error(
      '未找到微信账号数据。\n' +
        '请选择 xwechat_files 目录，或包含 db_storage 的 wxid_xxx 账号目录。'
    );
  }

  if (scan.accounts.length === 1) {
    return scan.accounts[0].path;
  }

  throw new Error(
    `该目录下有 ${scan.accounts.length} 个微信账号，请选择要导出的账号。`
  );
}

function getWxDirStatus(inputPath, options = {}) {
  const scan = scanWeChatAccounts(inputPath);

  if (scan.accounts.length === 0) {
    throw new Error(
      '未找到微信账号数据。\n' +
        '请选择 xwechat_files 目录，或包含 db_storage 的 wxid_xxx 账号目录。'
    );
  }

  const accountPath = options.accountPath || scan.selectedPath;
  if (scan.needsAccountSelection && !accountPath) {
    return {
      resolved: null,
      rootDir: scan.rootDir,
      accounts: scan.accounts,
      needsAccountSelection: true,
      hasEncrypted: null,
      hasDecrypted: null,
      mode: null,
      hint: `找到 ${scan.accounts.length} 个微信账号，请选择要导出的账号`,
    };
  }

  const resolved = resolveWxDir(inputPath, { accountPath });
  const summary = scan.accounts.find((item) => item.path === resolved) || getAccountSummary(resolved);
  const hasEncrypted = summary.hasEncrypted;
  const hasDecrypted = summary.hasDecrypted;
  const mode = summary.mode;

  return {
    resolved,
    rootDir: scan.rootDir,
    accounts: scan.accounts,
    needsAccountSelection: false,
    selectedAccount: summary,
    hasEncrypted,
    hasDecrypted,
    mode,
    hint:
      mode === 'encrypted'
        ? `账号 ${summary.wxid}：检测到加密数据库，将自动提取密钥并解密`
        : mode === 'both'
          ? `账号 ${summary.wxid}：检测到加密和解密数据库，如有更新将自动重新解密`
          : mode === 'decrypted'
            ? `账号 ${summary.wxid}：检测到已解密数据库，可直接导出`
            : `账号 ${summary.wxid}：未识别到有效的微信数据库`,
  };
}

function resolveDecryptedDir(wxDir) {
  const direct = path.join(wxDir, 'db_storage_decrypted');
  if (fs.existsSync(direct)) return direct;

  const nested = path.join(wxDir, 'db_storage', 'db_storage_decrypted');
  if (fs.existsSync(nested)) return nested;

  throw new Error(`未找到 db_storage_decrypted: ${wxDir}`);
}

function inferSelfWxid(wxDir, selfWxid) {
  if (selfWxid) return selfWxid;
  return path.basename(wxDir).replace(/_c[a-f0-9]+$/i, '');
}

function usernameToTable(username) {
  return `Msg_${crypto.createHash('md5').update(username).digest('hex')}`;
}

function safeFilename(name, fallback) {
  const base = (name || fallback || 'unknown')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return base || 'unknown';
}

function toBuffer(value) {
  if (value == null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+(,\d+)*$/.test(trimmed)) {
      return Buffer.from(trimmed.split(',').map((n) => Number(n)));
    }
    return Buffer.from(value, 'utf8');
  }
  return Buffer.from(String(value));
}

function bufferToText(buf) {
  if (!buf || buf.length === 0) return '';
  const text = buf.toString('utf8');
  if (text.includes('\uFFFD') && buf.some((b) => b === 0)) {
    return null;
  }
  return text;
}

function decodeContent(messageContent, compressContent, contentType) {
  if (contentType === 4) {
    const compressed = toBuffer(compressContent);
    if (compressed && compressed.length > 0) {
      try {
        const decoded = Buffer.from(decompress(compressed));
        const text = bufferToText(decoded);
        if (text) return text;
      } catch {
        // fall through
      }
    }
  }

  if (typeof messageContent === 'string' && messageContent.length > 0) {
    if (!/^\d+(,\d+)*$/.test(messageContent.trim())) {
      return messageContent;
    }
  }

  const raw = toBuffer(messageContent);
  if (raw && raw.length > 0) {
    const text = bufferToText(raw);
    if (text) return text;

    try {
      const decoded = Buffer.from(decompress(raw));
      const text2 = bufferToText(decoded);
      if (text2) return text2;
    } catch {
      // ignore
    }
  }

  return '';
}

function formatDateTime(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function extractXmlTag(xml, tag) {
  const match = xml.match(
    new RegExp(`<${tag}><!\\[CDATA\\[(.*?)\\]\\]></${tag}>|<${tag}>([^<]*)</${tag}>`, 's')
  );
  return match ? (match[1] || match[2] || '').trim() : '';
}

function enrichContent(type, content) {
  if (!content) return { content: '', extra: null };

  if (type === 49 || (type === 1 && content.startsWith('<?xml'))) {
    const title = extractXmlTag(content, 'title');
    const url = extractXmlTag(content, 'url');
    const des = extractXmlTag(content, 'des');
    if (title || url || des) {
      return {
        content: title || des || content.slice(0, 200),
        extra: { title, url, des, rawXml: content.length > 500 ? undefined : content },
      };
    }
  }

  return { content, extra: null };
}

function parseGroupContent(content) {
  if (!content || !content.includes(':\n')) {
    return { senderWxid: null, body: content || '' };
  }
  const idx = content.indexOf(':\n');
  const senderWxid = content.slice(0, idx);
  const body = content.slice(idx + 2);
  if (/^(wxid_|[^@\s]+@)/.test(senderWxid)) {
    return { senderWxid, body };
  }
  return { senderWxid: null, body: content };
}

function openDatabase(SQL, filePath) {
  return new SQL.Database(fs.readFileSync(filePath));
}

function queryAll(db, sql) {
  const result = db.exec(sql);
  if (!result[0]) return [];
  const { columns, values } = result[0];
  return values.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
}

function loadContacts(decryptedDir, SQL) {
  const contacts = {};
  const contactDbPath = path.join(decryptedDir, 'contact', 'contact.db');
  if (!fs.existsSync(contactDbPath)) return contacts;

  const db = openDatabase(SQL, contactDbPath);
  try {
    for (const row of queryAll(
      db,
      'SELECT username, remark, nick_name FROM contact WHERE username IS NOT NULL'
    )) {
      contacts[row.username] = row.remark || row.nick_name || row.username;
    }
    for (const row of queryAll(
      db,
      'SELECT username, remark, nick_name FROM stranger WHERE username IS NOT NULL'
    )) {
      if (!contacts[row.username]) {
        contacts[row.username] = row.remark || row.nick_name || row.username;
      }
    }
  } finally {
    db.close();
  }
  return contacts;
}

function loadSessions(decryptedDir, SQL) {
  const sessions = {};
  const sessionDbPath = path.join(decryptedDir, 'session', 'session.db');
  if (!fs.existsSync(sessionDbPath)) return sessions;

  const db = openDatabase(SQL, sessionDbPath);
  try {
    for (const row of queryAll(
      db,
      'SELECT username, type, summary, last_sender_display_name, last_timestamp, sort_timestamp FROM SessionTable'
    )) {
      sessions[row.username] = {
        sessionType: row.type,
        summary: row.summary || '',
        lastSender: row.last_sender_display_name || '',
        lastTimestamp: row.last_timestamp || 0,
        sortTimestamp: row.sort_timestamp || 0,
      };
    }
  } finally {
    db.close();
  }
  return sessions;
}

function loadSenderMap(db) {
  const senderMap = {};
  for (const row of queryAll(db, 'SELECT rowid, user_name FROM Name2Id')) {
    if (row.user_name) senderMap[row.rowid] = row.user_name;
  }
  return senderMap;
}

function getMessageDbs(decryptedDir) {
  const msgDir = path.join(decryptedDir, 'message');
  if (!fs.existsSync(msgDir)) return [];
  return fs
    .readdirSync(msgDir)
    .filter((name) => /^message_\d+\.db$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => path.join(msgDir, name));
}

function tableExists(db, tableName) {
  const rows = db.exec(
    `SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='${tableName.replace(/'/g, "''")}'`
  );
  return rows[0]?.values?.[0]?.[0] > 0;
}

function findDbsForUsername(msgDbs, SQL, username) {
  const table = usernameToTable(username);
  const matched = [];
  for (const dbPath of msgDbs) {
    const db = openDatabase(SQL, dbPath);
    try {
      if (tableExists(db, table)) {
        const count = db.exec(`SELECT count(*) FROM "${table}"`);
        if (count[0].values[0][0] > 0) {
          matched.push(dbPath);
        }
      }
    } finally {
      db.close();
    }
  }
  return matched;
}

function exportConversation({ msgDbs, SQL, username, contacts, senderMaps, selfWxid }) {
  const table = usernameToTable(username);
  const dbPaths = findDbsForUsername(msgDbs, SQL, username);
  if (dbPaths.length === 0) {
    return null;
  }

  const isGroup = username.includes('@chatroom');
  const displayName = contacts[username] || username;
  const rowMap = new Map();

  for (const dbPath of dbPaths) {
    const db = openDatabase(SQL, dbPath);
    const senderMap = senderMaps.get(dbPath) || {};
    try {
      if (!tableExists(db, table)) continue;
      const rows = queryAll(
        db,
        `SELECT local_id, server_id, local_type, sort_seq, real_sender_id, create_time, status, message_content, compress_content, source, WCDB_CT_message_content FROM "${table}"`
      );
      for (const row of rows) {
        const key = `${row.create_time}:${row.local_id}:${row.server_id}`;
        if (rowMap.has(key)) continue;
        rowMap.set(key, { row, senderMap });
      }
    } finally {
      db.close();
    }
  }

  const sortedRows = [...rowMap.values()].sort((a, b) => {
    if (a.row.create_time !== b.row.create_time) {
      return a.row.create_time - b.row.create_time;
    }
    return a.row.local_id - b.row.local_id;
  });

  const messages = sortedRows.map(({ row, senderMap }) => {
    const type = Number(row.local_type);
    const typeName = MSG_TYPE_MAP[type] || `type_${type}`;
    const decoded = decodeContent(
      row.message_content,
      row.compress_content,
      row.WCDB_CT_message_content
    );

    let senderWxid = senderMap[row.real_sender_id] || null;
    let body = decoded;

    if (isGroup) {
      const parsed = parseGroupContent(decoded);
      if (parsed.senderWxid) {
        senderWxid = parsed.senderWxid;
        body = parsed.body;
      }
    }

    const enriched = enrichContent(type, body);
    const senderName = senderWxid ? contacts[senderWxid] || senderWxid : null;

    return {
      id: row.local_id,
      serverId: row.server_id != null ? String(row.server_id) : null,
      type,
      typeName,
      createTime: row.create_time,
      datetime: formatDateTime(row.create_time),
      sortSeq: row.sort_seq,
      senderId: row.real_sender_id,
      senderWxid,
      senderName,
      isSelf: senderWxid === selfWxid,
      content: enriched.content,
      extra: enriched.extra,
      status: row.status,
    };
  });

  return {
    username,
    displayName,
    type: isGroup ? 'group' : 'private',
    dbFiles: dbPaths.map((p) => path.basename(p)),
    messageCount: messages.length,
    messages,
  };
}

async function createSqlEngine() {
  return initSqlJs({ locateFile: getSqlJsLocateFile() });
}

/**
 * @param {object} options
 * @param {string} options.wxDir - 微信账号目录或 xwechat_files 目录
 * @param {string} options.outputDir - JSON 导出目录
 * @param {string} [options.selfWxid] - 当前账号 wxid，可自动推断
 * @param {(event: object) => void} [options.onProgress]
 */
async function exportWeChatChats({
  wxDir,
  outputDir,
  selfWxid,
  forceDecrypt = false,
  loginCapture = true,
  keysPath = null,
  onProgress,
}) {
  const resolvedWxDir = resolveWxDir(wxDir);
  const { ensureDecrypted } = require('./decryptCore');

  onProgress?.({
    phase: 'init',
    message: `微信目录: ${resolvedWxDir}`,
  });

  await ensureDecrypted({
    wxDir: resolvedWxDir,
    forceDecrypt,
    loginCapture,
    keysPath,
    onProgress,
  });

  const decryptedDir = resolveDecryptedDir(resolvedWxDir);
  const resolvedSelfWxid = inferSelfWxid(resolvedWxDir, selfWxid);
  const chatsDir = path.join(outputDir, 'chats');

  onProgress?.({
    phase: 'init',
    message: `微信目录: ${resolvedWxDir}`,
  });
  onProgress?.({
    phase: 'init',
    message: `当前账号: ${resolvedSelfWxid}`,
  });

  const SQL = await createSqlEngine();
  const contacts = loadContacts(decryptedDir, SQL);
  const sessions = loadSessions(decryptedDir, SQL);
  const msgDbs = getMessageDbs(decryptedDir);

  if (msgDbs.length === 0) {
    throw new Error('未找到 message_0.db 等消息数据库文件');
  }

  onProgress?.({
    phase: 'init',
    message: `已加载 ${msgDbs.length} 个消息库，${Object.keys(contacts).length} 个联系人`,
  });

  fs.mkdirSync(chatsDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const usernames = new Set();
  const senderMaps = new Map();

  for (const dbPath of msgDbs) {
    const db = openDatabase(SQL, dbPath);
    senderMaps.set(dbPath, loadSenderMap(db));
    for (const row of queryAll(db, "SELECT user_name FROM Name2Id WHERE user_name != ''")) {
      usernames.add(row.user_name);
    }
    db.close();
  }

  const exportedAt = new Date().toISOString();
  const conversations = [];
  let exportedCount = 0;
  let totalMessages = 0;
  const usedNames = new Set();
  const usernameList = [...usernames];

  for (let i = 0; i < usernameList.length; i += 1) {
    const username = usernameList[i];
    const chat = exportConversation({
      msgDbs,
      SQL,
      username,
      contacts,
      senderMaps,
      selfWxid: resolvedSelfWxid,
    });
    if (!chat || chat.messageCount === 0) continue;

    let fileBase = safeFilename(chat.displayName, username);
    if (usedNames.has(fileBase)) {
      fileBase = safeFilename(`${fileBase}_${username.replace('@', '_at_')}`, username);
    }
    usedNames.add(fileBase);

    const session = sessions[username] || {};
    const payload = {
      ...chat,
      session,
      exportedAt,
    };

    const outFile = path.join(chatsDir, `${fileBase}.json`);
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf8');

    conversations.push({
      username,
      displayName: chat.displayName,
      type: chat.type,
      messageCount: chat.messageCount,
      file: path.relative(outputDir, outFile).replace(/\\/g, '/'),
      lastTimestamp: session.lastTimestamp || 0,
      summary: session.summary || '',
    });

    exportedCount += 1;
    totalMessages += chat.messageCount;

    onProgress?.({
      phase: 'exporting',
      current: exportedCount,
      scanned: i + 1,
      totalCandidates: usernameList.length,
      displayName: chat.displayName,
      messageCount: chat.messageCount,
      totalMessages,
    });
  }

  conversations.sort((a, b) => (b.lastTimestamp || 0) - (a.lastTimestamp || 0));

  const index = {
    exportedAt,
    selfWxid: resolvedSelfWxid,
    sourceDir: resolvedWxDir,
    conversationCount: exportedCount,
    totalMessages,
    conversations,
  };

  const indexPath = path.join(outputDir, 'conversations.json');
  const contactsPath = path.join(outputDir, 'contacts.json');
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
  fs.writeFileSync(contactsPath, JSON.stringify(contacts, null, 2), 'utf8');

  const result = {
    wxDir: resolvedWxDir,
    outputDir,
    selfWxid: resolvedSelfWxid,
    conversationCount: exportedCount,
    totalMessages,
    indexPath,
    contactsPath,
    chatsDir,
  };

  onProgress?.({ phase: 'done', ...result });
  return result;
}

module.exports = {
  exportWeChatChats,
  resolveWxDir,
  resolveDecryptedDir,
  getWxDirStatus,
  scanWeChatAccounts,
  isWeChatAccountDir,
  MSG_TYPE_MAP,
};
