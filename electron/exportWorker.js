const { parentPort, workerData } = require('worker_threads');
const { exportWeChatChats } = require('../lib/exportCore');

let cancelled = false;

parentPort.on('message', (msg) => {
  if (msg?.type === 'cancel') {
    cancelled = true;
  }
});

exportWeChatChats({
  wxDir: workerData.wxDir,
  outputDir: workerData.outputDir,
  selfWxid: workerData.selfWxid,
  forceDecrypt: workerData.forceDecrypt,
  loginCapture: workerData.loginCapture,
  keysPath: workerData.keysPath,
  formats: workerData.formats,
  selectedUsernames: workerData.selectedUsernames,
  voiceTranscription: workerData.voiceTranscription,
  shouldCancel: () => cancelled,
  onProgress: (event) => {
    parentPort.postMessage({ type: 'progress', event });
  },
})
  .then((result) => {
    if (cancelled) {
      parentPort.postMessage({ type: 'done', ok: false, error: '导出已取消', cancelled: true });
      return;
    }
    parentPort.postMessage({ type: 'done', ok: true, result });
  })
  .catch((err) => {
    parentPort.postMessage({
      type: 'done',
      ok: false,
      error: err.message,
      cancelled: cancelled || err.message === '导出已取消',
    });
  });
