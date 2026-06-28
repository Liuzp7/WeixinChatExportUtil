const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { decode: decodeSilk } = require('silk-wasm');
const { VoiceStore, getMediaDbs } = require('./voiceMedia');

const VOICE_MSG_TYPE = 34;
const SAMPLE_RATE = 24000;
const WHISPER_MODEL = 'Xenova/whisper-small';

let transcriberPromise = null;
let transcriberConfigKey = null;

function parseVoiceDurationMs(content) {
  if (!content || !content.includes('<voicemsg')) return 0;
  const match = content.match(/voicelength="(\d+)"/i);
  return match ? Number(match[1]) || 0 : 0;
}

function formatVoiceLabel(durationMs) {
  if (durationMs > 0) {
    return `[语音 ${(durationMs / 1000).toFixed(1)}s]`;
  }
  return '[语音]';
}

function stripSilkPrefix(data) {
  if (!data || data.length === 0) return data;
  return data[0] === 0x02 ? data.subarray(1) : data;
}

function pcmToWav(pcmBuffer, sampleRate = SAMPLE_RATE) {
  const channels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcmBuffer]);
}

function getBundledModelRoot() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'models'));
  }
  candidates.push(path.join(__dirname, '..', 'assets', 'models'));

  for (const root of candidates) {
    const configPath = path.join(root, 'Xenova', 'whisper-small', 'config.json');
    if (fs.existsSync(configPath)) {
      return root;
    }
  }
  return null;
}

function isWhisperModelBundled() {
  return Boolean(getBundledModelRoot());
}

function isVoiceTranscriptionAvailable() {
  return isWhisperModelBundled();
}

function assertVoiceTranscriptionAvailable() {
  if (!isVoiceTranscriptionAvailable()) {
    throw new Error(
      '语音转文字仅「完整版」可用。请下载「微迹 Wetrace 完整版」，或在开发环境执行 npm run download-whisper-model 后重试。'
    );
  }
}

function configureWhisperEnv() {
  const bundledRoot = getBundledModelRoot();
  if (!bundledRoot) {
    assertVoiceTranscriptionAvailable();
  }

  const { env } = require('@xenova/transformers');
  env.localModelPath = bundledRoot;
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.cacheDir = bundledRoot;
  return { configKey: `bundled:${bundledRoot}` };
}

function getTranscriptionCachePath(wxDir) {
  return path.join(path.resolve(wxDir), '.wetrace_voice_transcriptions.json');
}

function loadTranscriptionCache(wxDir) {
  const cachePath = getTranscriptionCachePath(wxDir);
  if (!fs.existsSync(cachePath)) {
    return { version: 1, entries: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed && typeof parsed.entries === 'object') {
      return parsed;
    }
  } catch {
    // ignore corrupt cache
  }
  return { version: 1, entries: {} };
}

function saveTranscriptionCache(wxDir, cache) {
  const cachePath = getTranscriptionCachePath(wxDir);
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
}

function cacheKey(username, localId, createTime) {
  return `${username}|${localId}|${createTime}`;
}

async function getTranscriber(_wxDir, onProgress) {
  const whisperEnv = configureWhisperEnv();
  if (!transcriberPromise || transcriberConfigKey !== whisperEnv.configKey) {
    transcriberConfigKey = whisperEnv.configKey;
    transcriberPromise = (async () => {
      onProgress?.({
        phase: 'voice-transcription',
        subphase: 'model-load',
        message: '正在加载内置语音识别模型…',
        whisperModelBundled: true,
      });

      const { pipeline } = require('@xenova/transformers');
      return pipeline('automatic-speech-recognition', WHISPER_MODEL);
    })();
  }
  return transcriberPromise;
}

async function decodeVoiceToPcm(voiceData) {
  const silkData = stripSilkPrefix(voiceData);
  const result = await decodeSilk(silkData, SAMPLE_RATE);
  return Buffer.from(result.data);
}

async function transcribePcm(transcriber, pcmBuffer) {
  const wavBuffer = pcmToWav(pcmBuffer, SAMPLE_RATE);
  const tempDir = path.join(os.tmpdir(), 'wetrace-voice');
  fs.mkdirSync(tempDir, { recursive: true });
  const tempFile = path.join(
    tempDir,
    `voice_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.wav`
  );

  try {
    fs.writeFileSync(tempFile, wavBuffer);
    const output = await transcriber(tempFile, {
      language: 'chinese',
      task: 'transcribe',
      chunk_length_s: 30,
      stride_length_s: 5,
    });
    const text = (output?.text || '').trim();
    return text;
  } finally {
    fs.unlink(tempFile, () => {});
  }
}

function countVoiceMessages(chat) {
  return chat.messages.filter((msg) => msg.type === VOICE_MSG_TYPE).length;
}

function applyTranscriptionToMessage(msg, text) {
  const durationMs = msg.extra?.voiceDurationMs || parseVoiceDurationMs(msg.extra?.rawXml || '');
  const prefix = formatVoiceLabel(durationMs);
  msg.content = text ? `${prefix} ${text}` : prefix;
  msg.extra = {
    ...(msg.extra || {}),
    voiceDurationMs: durationMs || msg.extra?.voiceDurationMs || 0,
    transcription: text || null,
    transcriptionSource: text ? 'whisper-local' : null,
  };
}

async function transcribeVoiceMessagesInChat({
  chat,
  wxDir,
  voiceStore,
  transcriber,
  cache,
  onProgress,
  shouldCancel,
  voiceProgress,
}) {
  const voiceMessages = chat.messages.filter((msg) => msg.type === VOICE_MSG_TYPE);
  if (voiceMessages.length === 0) return { transcribed: 0, skipped: 0, failed: 0 };

  let transcribed = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < voiceMessages.length; i += 1) {
    if (shouldCancel?.()) {
      throw new Error('导出已取消');
    }

    const msg = voiceMessages[i];
    const key = cacheKey(chat.username, msg.id, msg.createTime);
    voiceProgress.current += 1;

    onProgress?.({
      phase: 'voice-transcription',
      subphase: 'transcribing',
      message: `正在转写语音：${chat.displayName}（${voiceProgress.current}/${voiceProgress.total}）`,
      displayName: chat.displayName,
      current: voiceProgress.current,
      total: voiceProgress.total,
      chatCurrent: i + 1,
      chatTotal: voiceMessages.length,
    });

    const cached = cache.entries[key];
    if (cached?.text) {
      applyTranscriptionToMessage(msg, cached.text);
      skipped += 1;
      continue;
    }

    const voiceData = voiceStore.fetchVoiceData(chat.username, msg.id, msg.createTime);
    if (!voiceData) {
      failed += 1;
      continue;
    }

    try {
      const pcmBuffer = await decodeVoiceToPcm(voiceData);
      const text = await transcribePcm(transcriber, pcmBuffer);
      if (text) {
        applyTranscriptionToMessage(msg, text);
        cache.entries[key] = { text, at: new Date().toISOString() };
        transcribed += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { transcribed, skipped, failed };
}

function initVoiceTranscriptionContext({ SQL, decryptedDir, wxDir }) {
  const mediaDbs = getMediaDbs(decryptedDir);
  if (mediaDbs.length === 0) {
    throw new Error(
      '未找到语音数据库（media_*.db）。请先在 PC 微信中打开含语音的聊天，并确保数据库已成功解密。'
    );
  }

  return {
    voiceStore: new VoiceStore(SQL, mediaDbs),
    cache: loadTranscriptionCache(wxDir),
    transcriber: null,
    wxDir,
    stats: { transcribed: 0, skipped: 0, failed: 0, processed: 0 },
  };
}

async function ensureTranscriber(voiceCtx, onProgress) {
  if (!voiceCtx.transcriber) {
    voiceCtx.transcriber = await getTranscriber(voiceCtx.wxDir, onProgress);
  }
  return voiceCtx.transcriber;
}

async function transcribeChatVoiceMessages({
  chat,
  voiceCtx,
  onProgress,
  shouldCancel,
}) {
  const voiceMessages = chat.messages.filter((msg) => msg.type === VOICE_MSG_TYPE);
  if (voiceMessages.length === 0) {
    return { transcribed: 0, skipped: 0, failed: 0 };
  }

  onProgress?.({
    phase: 'voice-transcription',
    subphase: 'chat-start',
    message: `${chat.displayName}：${voiceMessages.length} 条语音待转写…`,
    displayName: chat.displayName,
    chatVoiceCount: voiceMessages.length,
  });

  const transcriber = await ensureTranscriber(voiceCtx, onProgress);
  const voiceProgress = {
    current: voiceCtx.stats.processed,
    total: voiceCtx.stats.processed + voiceMessages.length,
  };

  const result = await transcribeVoiceMessagesInChat({
    chat,
    wxDir: voiceCtx.wxDir,
    voiceStore: voiceCtx.voiceStore,
    transcriber,
    cache: voiceCtx.cache,
    onProgress,
    shouldCancel,
    voiceProgress,
  });

  voiceCtx.stats.processed += voiceMessages.length;
  voiceCtx.stats.transcribed += result.transcribed;
  voiceCtx.stats.skipped += result.skipped;
  voiceCtx.stats.failed += result.failed;

  return result;
}

function finalizeVoiceTranscription(voiceCtx, onProgress) {
  if (!voiceCtx) return;
  saveTranscriptionCache(voiceCtx.wxDir, voiceCtx.cache);
  if (voiceCtx.stats.processed === 0) return;

  onProgress?.({
    phase: 'voice-transcription',
    subphase: 'done',
    message: `语音转写完成：成功 ${voiceCtx.stats.transcribed}，缓存命中 ${voiceCtx.stats.skipped}，未识别 ${voiceCtx.stats.failed}`,
    transcribed: voiceCtx.stats.transcribed,
    skipped: voiceCtx.stats.skipped,
    failed: voiceCtx.stats.failed,
    total: voiceCtx.stats.processed,
  });
}

function resetTranscriberForTests() {
  transcriberPromise = null;
  transcriberConfigKey = null;
}

module.exports = {
  VOICE_MSG_TYPE,
  parseVoiceDurationMs,
  formatVoiceLabel,
  countVoiceMessages,
  getMediaDbs,
  isWhisperModelBundled,
  isVoiceTranscriptionAvailable,
  assertVoiceTranscriptionAvailable,
  initVoiceTranscriptionContext,
  transcribeChatVoiceMessages,
  finalizeVoiceTranscription,
  resetTranscriberForTests,
};
