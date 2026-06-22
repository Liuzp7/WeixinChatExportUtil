const path = require('path');

const WECHAT_PROCESS_NAMES = ['Weixin.exe', 'WeChat.exe', 'WeChatAppEx.exe'];

function buildPathNeedles(wxDir) {
  const normalized = path.resolve(wxDir);
  const candidates = new Set([
    normalized,
    normalized.replace(/\//g, '\\'),
    path.join(normalized, 'db_storage'),
    path.join(normalized, 'db_storage').replace(/\//g, '\\'),
    'db_storage',
    'xwechat_files',
    path.basename(normalized),
  ]);

  const needles = [];
  for (const text of candidates) {
    if (!text) continue;
    needles.push({ kind: 'utf8', value: Buffer.from(text, 'utf8'), text });
    const utf16 = Buffer.alloc(text.length * 2);
    for (let i = 0; i < text.length; i += 1) {
      utf16.writeUInt16LE(text.charCodeAt(i), i * 2);
    }
    needles.push({ kind: 'utf16', value: utf16, text });
  }
  return needles;
}

function bufferContainsNeedle(buffer, needle) {
  return buffer.indexOf(needle.value) !== -1;
}

function findNeedleHits(buffer, needles) {
  const hits = [];
  for (const needle of needles) {
    let pos = 0;
    while (pos < buffer.length) {
      const idx = buffer.indexOf(needle.value, pos);
      if (idx === -1) break;
      hits.push({ idx, needle });
      pos = idx + 1;
    }
  }
  return hits;
}

function getPrioritySlices(buffer, hits, radius = 262144) {
  if (hits.length === 0) {
    return [{ start: 0, end: buffer.length, reason: 'full' }];
  }

  const slices = [];
  const covered = [];

  for (const hit of hits) {
    const start = Math.max(0, hit.idx - radius);
    const end = Math.min(buffer.length, hit.idx + hit.needle.value.length + radius);
    slices.push({
      start,
      end,
      reason: `near:${hit.needle.text}`,
    });
    covered.push([start, end]);
  }

  covered.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of covered) {
    if (!merged.length || range[0] > merged[merged.length - 1][1]) {
      merged.push(range);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], range[1]);
    }
  }

  let cursor = 0;
  for (const [start, end] of merged) {
    if (cursor < start) {
      slices.push({ start: cursor, end: start, reason: 'gap' });
    }
    cursor = Math.max(cursor, end);
  }
  if (cursor < buffer.length) {
    slices.push({ start: cursor, end: buffer.length, reason: 'tail' });
  }

  return slices;
}

module.exports = {
  WECHAT_PROCESS_NAMES,
  buildPathNeedles,
  bufferContainsNeedle,
  findNeedleHits,
  getPrioritySlices,
};
