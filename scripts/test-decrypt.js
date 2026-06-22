const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  collectDbFiles,
  resolveEncKeyForPage,
  decryptDatabase,
} = require('../lib/decryptDb');

const PAGE_SZ = 4096;
const RESERVE_SZ = 80;
const SALT_SZ = 16;
const IV_SZ = 16;
const SQLITE_HDR = Buffer.from('SQLite format 3\0');

function decryptPage(encKey, pageData, pgno) {
  const iv = pageData.subarray(PAGE_SZ - RESERVE_SZ, PAGE_SZ - RESERVE_SZ + IV_SZ);
  const decipher = (encrypted) => {
    const d = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
    d.setAutoPadding(false);
    return d.update(encrypted);
  };

  if (pgno === 1) {
    const decrypted = decipher(pageData.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ));
    const page = Buffer.alloc(PAGE_SZ, 0);
    SQLITE_HDR.copy(page, 0);
    decrypted.copy(page, SQLITE_HDR.length);
    return page;
  }

  const decrypted = decipher(pageData.subarray(0, PAGE_SZ - RESERVE_SZ));
  const page = Buffer.alloc(PAGE_SZ, 0);
  decrypted.copy(page, 0);
  return page;
}

function main() {
  const wxDir = process.argv[2];
  if (!wxDir) {
    console.error('Usage: node scripts/test-decrypt.js <wxDir>');
    process.exit(1);
  }

  const dbDir = path.join(wxDir, 'db_storage');
  const cachePath = path.join(wxDir, '.wexin_passphrase');
  if (!fs.existsSync(cachePath)) {
    console.error('No .wexin_passphrase cache');
    process.exit(1);
  }

  const passphrase = Buffer.from(fs.readFileSync(cachePath, 'utf8').trim(), 'hex');
  const { dbFiles } = collectDbFiles(dbDir);
  console.log(`DBs: ${dbFiles.length}, passphrase: ${passphrase.toString('hex').slice(0, 8)}...`);

  let walCount = 0;
  for (const item of dbFiles) {
    if (fs.existsSync(`${item.path}-wal`)) walCount += 1;
  }
  console.log(`DBs with -wal: ${walCount}/${dbFiles.length}`);

  const sample = dbFiles.find((d) => d.rel.includes('message')) || dbFiles[0];
  console.log(`\nSample: ${sample.rel} (${(sample.size / 1024 / 1024).toFixed(2)} MB)`);

  const page1 = Buffer.alloc(PAGE_SZ);
  const fd = fs.openSync(sample.path, 'r');
  fs.readSync(fd, page1, 0, PAGE_SZ, 0);
  const encKey = resolveEncKeyForPage(page1, { passphrase });
  console.log(`resolveEncKey: ${encKey ? 'OK' : 'FAIL'}`);

  try {
    const dec1 = decryptPage(encKey, page1, 1);
    console.log(`page1 header: ${JSON.stringify(dec1.subarray(0, 16).toString('utf8'))}`);
  } catch (err) {
    console.log(`page1 decrypt FAIL: ${err.message}`);
  }

  const totalPages = Math.ceil(sample.size / PAGE_SZ);
  for (let pg = 2; pg <= Math.min(totalPages, 5); pg += 1) {
    const page = Buffer.alloc(PAGE_SZ);
    fs.readSync(fd, page, 0, PAGE_SZ, (pg - 1) * PAGE_SZ);
    try {
      decryptPage(encKey, page, pg);
      console.log(`page ${pg}: decrypt OK`);
    } catch (err) {
      console.log(`page ${pg}: decrypt FAIL (${err.message})`);
    }
  }
  fs.closeSync(fd);

  const outPath = path.join(wxDir, '_test_decrypt_out.db');
  const ok = decryptDatabase(sample.path, outPath, null, { passphrase });
  console.log(`\ndecryptDatabase: ${ok ? 'OK' : 'FAIL'}`);
  if (fs.existsSync(outPath)) {
    fs.unlinkSync(outPath);
  }

  let resolveOk = 0;
  let decryptOk = 0;
  for (const item of dbFiles) {
    const p1 = Buffer.alloc(PAGE_SZ);
    const f = fs.openSync(item.path, 'r');
    fs.readSync(f, p1, 0, PAGE_SZ, 0);
    fs.closeSync(f);
    const key = resolveEncKeyForPage(p1, { passphrase });
    if (key) resolveOk += 1;
    const tmpOut = path.join(wxDir, '_tmp_test', item.rel);
    if (decryptDatabase(item.path, tmpOut, null, { passphrase })) {
      decryptOk += 1;
    }
  }
  console.log(`\nAll DBs: resolve ${resolveOk}/${dbFiles.length}, decrypt ${decryptOk}/${dbFiles.length}`);
}

main();
