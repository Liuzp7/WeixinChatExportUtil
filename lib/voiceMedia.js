const fs = require('fs');
const path = require('path');

function openDatabase(SQL, filePath) {
  return new SQL.Database(fs.readFileSync(filePath));
}

function queryAll(db, sql) {
  const result = db.exec(sql);
  if (!result[0]) return [];
  const { columns, values } = result[0];
  return values.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
}

function tableExists(db, tableName) {
  const rows = db.exec(
    `SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='${tableName.replace(/'/g, "''")}'`
  );
  return rows[0]?.values?.[0]?.[0] > 0;
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

function getMediaDbs(decryptedDir) {
  const found = new Set();

  function scanDir(dir, depth) {
    if (!fs.existsSync(dir) || depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(full, depth + 1);
      } else if (/^media_\d+\.db$/i.test(entry.name)) {
        found.add(full);
      }
    }
  }

  scanDir(decryptedDir, 0);
  return [...found].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

class VoiceStore {
  constructor(SQL, mediaDbPaths) {
    this.SQL = SQL;
    this.mediaDbPaths = mediaDbPaths;
    this.chatNameIdCache = new Map();
  }

  _getChatNameId(dbPath, username) {
    const key = `${dbPath}:${username}`;
    if (this.chatNameIdCache.has(key)) {
      return this.chatNameIdCache.get(key);
    }

    const db = openDatabase(this.SQL, dbPath);
    try {
      if (!tableExists(db, 'Name2Id')) {
        this.chatNameIdCache.set(key, null);
        return null;
      }
      const escaped = username.replace(/'/g, "''");
      const rows = queryAll(
        db,
        `SELECT rowid FROM Name2Id WHERE user_name = '${escaped}' LIMIT 1`
      );
      const id = rows[0]?.rowid ?? null;
      this.chatNameIdCache.set(key, id);
      return id;
    } finally {
      db.close();
    }
  }

  fetchVoiceData(username, localId, createTime) {
    for (const dbPath of this.mediaDbPaths) {
      const chatNameId = this._getChatNameId(dbPath, username);
      if (chatNameId == null) continue;

      const db = openDatabase(this.SQL, dbPath);
      try {
        if (!tableExists(db, 'VoiceInfo')) continue;

        let rows = queryAll(
          db,
          `SELECT voice_data FROM VoiceInfo WHERE chat_name_id = ${chatNameId} AND local_id = ${localId} AND create_time = ${createTime} LIMIT 1`
        );
        if (rows.length === 0) {
          rows = queryAll(
            db,
            `SELECT voice_data FROM VoiceInfo WHERE chat_name_id = ${chatNameId} AND local_id = ${localId} LIMIT 1`
          );
        }

        const voiceData = rows[0]?.voice_data;
        if (voiceData != null) {
          const buf = toBuffer(voiceData);
          if (buf && buf.length > 0) return buf;
        }
      } finally {
        db.close();
      }
    }
    return null;
  }
}

module.exports = {
  VoiceStore,
  getMediaDbs,
};
