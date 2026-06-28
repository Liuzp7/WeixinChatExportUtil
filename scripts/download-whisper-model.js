#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const MODEL_ID = 'Xenova/whisper-small';
const HF_ENDPOINT = (process.env.WETRACE_HF_ENDPOINT || 'https://huggingface.co').replace(/\/$/, '');
const INSECURE_TLS =
  process.argv.includes('--insecure') || process.env.WETRACE_HF_INSECURE === '1';

if (INSECURE_TLS) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.warn('警告: 已关闭 TLS 证书校验（仅用于下载模型）');
}

const HF_HOST = new URL(HF_ENDPOINT).host;
const OUT_ROOT = path.join(__dirname, '..', 'assets', 'models');
const OUT_DIR = path.join(OUT_ROOT, 'Xenova', 'whisper-small');
const MARKER = path.join(OUT_DIR, 'config.json');

const REQUIRED_ONNX = new Set([
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
]);

const FALLBACK_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'merges.txt',
  'normalizer.json',
  'added_tokens.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

function filterModelFiles(files) {
  return files.filter((filePath) => {
    if (!filePath.endsWith('.onnx')) return true;
    return REQUIRED_ONNX.has(filePath);
  });
}

function getDirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += getDirSize(full);
    } else {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

function httpsGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'wetrace-model-downloader/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (redirects >= 8) {
          reject(new Error(`重定向过多: ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).href;
        res.resume();
        resolve(httpsGet(next, redirects + 1));
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${url}`));
        res.resume();
        return;
      }

      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
  });
}

function httpsGetJson(url) {
  return httpsGet(url).then((buf) => JSON.parse(buf.toString('utf8')));
}

async function listModelFiles() {
  try {
    const tree = await httpsGetJson(`${HF_ENDPOINT}/api/models/${MODEL_ID}/tree/main?recursive=true`);
    const files = tree
      .filter((item) => item.type === 'file')
      .map((item) => item.path)
      .filter((filePath) => !filePath.startsWith('.') && !filePath.endsWith('.md'));
    if (files.length > 0) {
      return filterModelFiles(files);
    }
  } catch (err) {
    console.warn(`无法读取 HuggingFace 文件列表，将使用内置清单: ${err.message}`);
  }
  return FALLBACK_FILES;
}

async function downloadFile(relPath) {
  const url = `${HF_ENDPOINT}/${MODEL_ID}/resolve/main/${relPath}`;
  const outFile = path.join(OUT_DIR, relPath);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const data = await httpsGet(url);
  fs.writeFileSync(outFile, data);
  return data.length;
}

async function main() {
  const force = process.argv.includes('--force');

  if (!force && fs.existsSync(MARKER)) {
    const sizeMb = Math.round(getDirSize(OUT_DIR) / (1024 * 1024));
    console.log(`语音识别模型已就绪 (${sizeMb} MB): ${OUT_DIR}`);
    return;
  }

  console.log(`正在下载 ${MODEL_ID} …`);
  console.log('（约 250MB，仅打包「完整版」时需要，不会提交到 Git）');

  const files = await listModelFiles();
  console.log(`共 ${files.length} 个文件待下载`);

  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let downloaded = 0;
  for (let i = 0; i < files.length; i += 1) {
    const relPath = files[i];
    process.stdout.write(`[${i + 1}/${files.length}] ${relPath} … `);
    try {
      const bytes = await downloadFile(relPath);
      downloaded += bytes;
      console.log(`${Math.round(bytes / 1024)} KB`);
    } catch (err) {
      console.log('失败');
      throw new Error(`下载失败 ${relPath}: ${err.message}`);
    }
  }

  const sizeMb = Math.round(getDirSize(OUT_DIR) / (1024 * 1024));
  console.log(`模型已保存 (${sizeMb} MB, 下载 ${Math.round(downloaded / (1024 * 1024))} MB): ${OUT_DIR}`);
}

main().catch((err) => {
  console.error('下载语音识别模型失败:', err.message);
  console.error('请确认网络可访问 HuggingFace，必要时尝试：');
  console.error('  set WETRACE_HF_ENDPOINT=https://hf-mirror.com');
  console.error('  npm run download-whisper-model -- --insecure');
  process.exit(1);
});
