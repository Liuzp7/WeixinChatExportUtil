const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { verifyEncKey } = require('./decryptDb');

const PBKDF2_ITERATIONS = 256000;
const PBKDF2_DKLEN = 32;
const PASSPHRASE_CACHE = '.wexin_passphrase';

let lastMatchedPassphrase = null;

function getLastMatchedPassphrase() {
  return lastMatchedPassphrase;
}

function clearLastMatchedPassphrase() {
  lastMatchedPassphrase = null;
}

function deriveEncKey(passphrase, salt) {
  const passBuf = Buffer.isBuffer(passphrase) ? passphrase : Buffer.from(passphrase, 'utf8');
  return crypto.pbkdf2Sync(passBuf, salt, PBKDF2_ITERATIONS, PBKDF2_DKLEN, 'sha512');
}

function hasEntropy(buf) {
  if (!buf || buf.length < 8) return false;
  const unique = new Set(buf);
  if (unique.size < 4) return false;
  if (buf.every((b) => b === 0)) return false;
  return true;
}

function extractPassphraseCandidates(buffer, maxCandidates = 10) {
  const seen = new Set();
  const candidates = [];

  const push = (value) => {
    const key = Buffer.isBuffer(value) ? value.toString('hex') : value;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(value);
  };

  // PBKDF2(256000) 极慢，仅在小窗口内提取少量候选
  if (buffer.length > 65536) {
    return candidates;
  }

  for (let i = 0; i <= buffer.length - 32 && candidates.length < maxCandidates; i += 32) {
    const chunk = buffer.subarray(i, i + 32);
    if (hasEntropy(chunk)) {
      push(chunk);
    }
  }

  let start = -1;
  for (let i = 0; i < buffer.length && candidates.length < maxCandidates; i += 1) {
    const c = buffer[i];
    if (c >= 0x20 && c <= 0x7e) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      const len = i - start;
      if (len >= 8 && len <= 64) {
        push(buffer.toString('utf8', start, i));
      }
      start = -1;
    }
  }

  return candidates.slice(0, maxCandidates);
}

function tryPassphraseCandidate(candidate, dbFiles, remainingSalts, keyMap, log, label) {
  let matched = 0;
  const sample = dbFiles.find((item) => remainingSalts.has(item.salt));
  if (!sample) return 0;

  const salt = sample.page1.subarray(0, 16);
  const encKey = deriveEncKey(candidate, salt);
  if (!verifyEncKey(encKey, sample.page1)) {
    return 0;
  }

  for (const item of dbFiles) {
    if (!remainingSalts.has(item.salt)) continue;
    const itemSalt = item.page1.subarray(0, 16);
    const itemKey = deriveEncKey(candidate, itemSalt);
    if (verifyEncKey(itemKey, item.page1)) {
      keyMap[item.salt] = itemKey.toString('hex');
      remainingSalts.delete(item.salt);
      matched += 1;
    }
  }

  if (matched > 0) {
    lastMatchedPassphrase = candidate;
    log?.(`PBKDF2 派生成功 (${label}): 匹配 ${matched} 个 salt`);
  }
  return matched;
}

function scanPassphraseInBuffer(buffer, dbFiles, saltToDbs, keyMap, remainingSalts, log, options = {}) {
  if (remainingSalts.size === 0) return 0;

  const maxCandidates = options.maxCandidates || 10;
  const candidates = extractPassphraseCandidates(buffer, maxCandidates);
  let matched = 0;
  for (const candidate of candidates) {
    if (remainingSalts.size === 0) break;
    matched += tryPassphraseCandidate(candidate, dbFiles, remainingSalts, keyMap, log, 'PBKDF2');
  }
  return matched;
}

function scanPassphraseNearNeedles(buffer, hits, dbFiles, saltToDbs, keyMap, remainingSalts, log) {
  if (remainingSalts.size === 0 || !hits.length) return 0;

  let matched = 0;
  const radius = 16384;
  const seenRanges = [];

  for (const hit of hits.slice(0, 6)) {
    const start = Math.max(0, hit.idx - radius);
    const end = Math.min(buffer.length, hit.idx + hit.needle.value.length + radius);
    const rangeKey = `${start}:${end}`;
    if (seenRanges.includes(rangeKey)) continue;
    seenRanges.push(rangeKey);

    const chunk = buffer.subarray(start, end);
    matched += scanPassphraseInBuffer(chunk, dbFiles, saltToDbs, keyMap, remainingSalts, log, {
      maxCandidates: 8,
    });
    if (remainingSalts.size === 0) break;
  }

  return matched;
}

function getPassphraseCachePath(wxDir) {
  return path.join(wxDir, PASSPHRASE_CACHE);
}

function loadCachedPassphrase(wxDir) {
  const cachePath = getPassphraseCachePath(wxDir);
  if (!fs.existsSync(cachePath)) return null;
  try {
    const raw = fs.readFileSync(cachePath, 'utf8').trim();
    if (!raw) return null;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    return raw;
  } catch {
    return null;
  }
}

function saveCachedPassphrase(wxDir, passphrase) {
  const cachePath = getPassphraseCachePath(wxDir);
  const payload = Buffer.isBuffer(passphrase) ? passphrase.toString('hex') : String(passphrase);
  fs.writeFileSync(cachePath, payload, { encoding: 'utf8', mode: 0o600 });
}

function deriveKeysFromPassphrase(passphrase, dbFiles, saltToDbs, keyMap, remainingSalts, log, label) {
  let matched = 0;
  for (const item of dbFiles) {
    if (!remainingSalts.has(item.salt)) continue;
    const salt = item.page1.subarray(0, 16);
    const encKey = deriveEncKey(passphrase, salt);
    if (verifyEncKey(encKey, item.page1)) {
      keyMap[item.salt] = encKey.toString('hex');
      remainingSalts.delete(item.salt);
      matched += 1;
    }
  }
  if (matched > 0) {
    lastMatchedPassphrase = passphrase;
    log?.(`${label}: 派生并验证 ${matched}/${Object.keys(saltToDbs).length} 个 salt`);
  }
  return matched;
}

function tryCachedPassphrase({ wxDir, dbFiles, saltToDbs, keyMap, remainingSalts, log }) {
  const cached = loadCachedPassphrase(wxDir);
  if (!cached) return 0;
  log?.('尝试使用已缓存的 passphrase 派生密钥...');
  return deriveKeysFromPassphrase(
    cached,
    dbFiles,
    saltToDbs,
    keyMap,
    remainingSalts,
    log,
    '缓存 passphrase'
  );
}

module.exports = {
  deriveEncKey,
  extractPassphraseCandidates,
  scanPassphraseInBuffer,
  scanPassphraseNearNeedles,
  tryPassphraseCandidate,
  deriveKeysFromPassphrase,
  loadCachedPassphrase,
  saveCachedPassphrase,
  tryCachedPassphrase,
  getLastMatchedPassphrase,
  clearLastMatchedPassphrase,
};
