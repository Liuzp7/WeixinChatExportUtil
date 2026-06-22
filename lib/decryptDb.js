const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PAGE_SZ = 4096;
const KEY_SZ = 32;
const SALT_SZ = 16;
const IV_SZ = 16;
const HMAC_SZ = 64;
const RESERVE_SZ = 80;
const SQLITE_HDR = Buffer.from('SQLite format 3\0');

function deriveMacKey(encKey, salt) {
  const macSalt = Buffer.alloc(salt.length);
  for (let i = 0; i < salt.length; i += 1) {
    macSalt[i] = salt[i] ^ 0x3a;
  }
  return crypto.pbkdf2Sync(encKey, macSalt, 2, KEY_SZ, 'sha512');
}

function deriveEncKeyFromPassphrase(passphrase, salt) {
  const passBuf = Buffer.isBuffer(passphrase) ? passphrase : Buffer.from(passphrase, 'utf8');
  return crypto.pbkdf2Sync(passBuf, salt, 256000, KEY_SZ, 'sha512');
}

function resolveEncKeyForPage(page1, { encKeyHex = null, passphrase = null } = {}) {
  if (encKeyHex) {
    const encKey = Buffer.from(encKeyHex, 'hex');
    if (encKey.length === 32 && verifyEncKey(encKey, page1)) {
      return encKey;
    }
    if (encKey.length === 32 && verifyEncKey(deriveEncKeyFromPassphrase(encKey, page1.subarray(0, SALT_SZ)), page1)) {
      return deriveEncKeyFromPassphrase(encKey, page1.subarray(0, SALT_SZ));
    }
  }

  if (passphrase) {
    const passBuf = Buffer.isBuffer(passphrase) ? passphrase : Buffer.from(passphrase, 'hex');
    const derived = deriveEncKeyFromPassphrase(passBuf, page1.subarray(0, SALT_SZ));
    if (verifyEncKey(derived, page1)) {
      return derived;
    }
  }

  return null;
}

function verifyEncKey(encKey, page1) {
  const salt = page1.subarray(0, SALT_SZ);
  const macKey = deriveMacKey(encKey, salt);
  const hmacData = page1.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ + IV_SZ);
  const storedHmac = page1.subarray(PAGE_SZ - HMAC_SZ, PAGE_SZ);
  const hm = crypto.createHmac('sha512', macKey).update(hmacData);
  hm.update(Buffer.from([1, 0, 0, 0]));
  return hm.digest().equals(storedHmac);
}

function decryptAesCbcNoPadding(encKey, iv, encrypted) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
  // SQLCipher page payloads are full AES blocks without PKCS7 padding (unlike PyCryptodome default).
  decipher.setAutoPadding(false);
  return decipher.update(encrypted);
}

function decryptPage(encKey, pageData, pgno) {
  const iv = pageData.subarray(PAGE_SZ - RESERVE_SZ, PAGE_SZ - RESERVE_SZ + IV_SZ);

  if (pgno === 1) {
    const encrypted = pageData.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ);
    const decrypted = decryptAesCbcNoPadding(encKey, iv, encrypted);
    const page = Buffer.alloc(PAGE_SZ, 0);
    SQLITE_HDR.copy(page, 0);
    decrypted.copy(page, SQLITE_HDR.length);
    return page;
  }

  const encrypted = pageData.subarray(0, PAGE_SZ - RESERVE_SZ);
  const decrypted = decryptAesCbcNoPadding(encKey, iv, encrypted);
  const page = Buffer.alloc(PAGE_SZ, 0);
  decrypted.copy(page, 0);
  return page;
}

function decryptDatabase(dbPath, outPath, keyMaterial, options = {}) {
  const fd = fs.openSync(dbPath, 'r');
  const page1 = Buffer.alloc(PAGE_SZ);
  fs.readSync(fd, page1, 0, PAGE_SZ, 0);
  fs.closeSync(fd);

  const encKey = resolveEncKeyForPage(page1, {
    encKeyHex: typeof keyMaterial === 'string' ? keyMaterial : keyMaterial?.enc_key,
    passphrase: options.passphrase,
  });
  if (!encKey) {
    return false;
  }

  const fileSize = fs.statSync(dbPath).size;
  let totalPages = Math.floor(fileSize / PAGE_SZ);
  if (fileSize % PAGE_SZ !== 0) totalPages += 1;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const outFd = fs.openSync(outPath, 'w');

  const inFd = fs.openSync(dbPath, 'r');
  try {
    for (let pgno = 1; pgno <= totalPages; pgno += 1) {
      const page = Buffer.alloc(PAGE_SZ);
      const bytesRead = fs.readSync(inFd, page, 0, PAGE_SZ, (pgno - 1) * PAGE_SZ);
      if (bytesRead <= 0) break;

      let decrypted;
      try {
        decrypted = decryptPage(encKey, page, pgno);
      } catch (err) {
        return false;
      }
      fs.writeSync(outFd, decrypted, 0, PAGE_SZ);
    }
  } finally {
    fs.closeSync(inFd);
    fs.closeSync(outFd);
  }

  for (const suffix of ['-shm', '-wal']) {
    const residual = outPath + suffix;
    if (fs.existsSync(residual)) {
      try {
        fs.unlinkSync(residual);
      } catch {
        // ignore
      }
    }
  }

  return true;
}

function collectDbFiles(dbDir) {
  const dbFiles = [];
  const saltToDbs = {};

  function walk(currentDir) {
    for (const name of fs.readdirSync(currentDir)) {
      const fullPath = path.join(currentDir, name);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!name.endsWith('.db') || name.endsWith('-wal') || name.endsWith('-shm')) {
        continue;
      }
      if (stat.size < PAGE_SZ) continue;

      const page1 = Buffer.alloc(PAGE_SZ);
      const fd = fs.openSync(fullPath, 'r');
      fs.readSync(fd, page1, 0, PAGE_SZ, 0);
      fs.closeSync(fd);

      const rel = path.relative(dbDir, fullPath).replace(/\\/g, '/');
      const salt = page1.subarray(0, SALT_SZ).toString('hex');
      dbFiles.push({ rel, path: fullPath, size: stat.size, salt, page1 });
      if (!saltToDbs[salt]) saltToDbs[salt] = [];
      saltToDbs[salt].push(rel);
    }
  }

  walk(dbDir);
  return { dbFiles, saltToDbs };
}

function getKeyInfo(keys, relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  const variants = [
    relPath,
    normalized,
    normalized.replace(/\//g, '\\'),
    normalized.replace(/\//g, path.sep),
  ];
  for (const candidate of variants) {
    if (keys[candidate] && !candidate.startsWith('_')) {
      return keys[candidate];
    }
  }
  return null;
}

function decryptAllDatabases({ dbDir, outDir, keys, onProgress }) {
  const { dbFiles } = collectDbFiles(dbDir);
  const passphrase = keys._passphrase_hex ? Buffer.from(keys._passphrase_hex, 'hex') : null;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < dbFiles.length; i += 1) {
    const { rel, path: dbPath, size } = dbFiles[i];
    const keyInfo = getKeyInfo(keys, rel);
    if (!keyInfo && !passphrase) {
      skipped += 1;
      onProgress?.({ message: `跳过（无密钥）: ${rel}` });
      continue;
    }

    const outPath = path.join(outDir, rel.replace(/\//g, path.sep));
    onProgress?.({
      phase: 'decrypting',
      current: i + 1,
      total: dbFiles.length,
      rel,
      sizeMb: (size / 1024 / 1024).toFixed(1),
    });

    const ok = decryptDatabase(dbPath, outPath, keyInfo?.enc_key || null, { passphrase });
    if (ok) passed += 1;
    else failed += 1;
  }

  return { passed, failed, skipped, total: dbFiles.length };
}

module.exports = {
  verifyEncKey,
  deriveEncKeyFromPassphrase,
  resolveEncKeyForPage,
  decryptDatabase,
  collectDbFiles,
  decryptAllDatabases,
  getKeyInfo,
};
