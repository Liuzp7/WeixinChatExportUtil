#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const STUB = `'use strict';

// Stub for audio-only Whisper usage. @xenova/transformers imports sharp in Node,
// but speech recognition never calls image APIs.
function sharp() {
  throw new Error('Image processing is not available in Wetrace (audio-only build).');
}

module.exports = sharp;
module.exports.default = sharp;
`;

const ROOT = path.join(__dirname, '..');

function findSharpPackageDirs(dir, found, depth) {
  if (!fs.existsSync(dir) || depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name === 'sharp') {
      const pkg = path.join(full, 'package.json');
      if (fs.existsSync(pkg)) {
        found.add(full);
      }
      continue;
    }
    if (entry.name === '.bin' || entry.name.startsWith('.')) {
      continue;
    }
    findSharpPackageDirs(full, found, depth + 1);
  }
}

function patchSharpDir(sharpDir) {
  const indexJs = path.join(sharpDir, 'lib', 'index.js');
  const pkgJson = path.join(sharpDir, 'package.json');
  let pkgName = sharpDir;
  try {
    pkgName = JSON.parse(fs.readFileSync(pkgJson, 'utf8')).name || pkgName;
  } catch {
    // ignore
  }

  fs.mkdirSync(path.dirname(indexJs), { recursive: true });
  fs.writeFileSync(indexJs, STUB, 'utf8');
  console.log(`已应用 sharp 占位模块: ${pkgName} (${sharpDir})`);
}

function main() {
  const targets = new Set();
  findSharpPackageDirs(path.join(ROOT, 'node_modules'), targets, 0);

  if (targets.size === 0) {
    console.log('未找到 sharp 包，跳过占位模块安装。');
    return;
  }

  for (const sharpDir of targets) {
    patchSharpDir(sharpDir);
  }
}

main();
