const { parentPort, workerData } = require('worker_threads');
const { exportWeChatChats } = require('../lib/exportCore');

exportWeChatChats({
  wxDir: workerData.wxDir,
  outputDir: workerData.outputDir,
  selfWxid: workerData.selfWxid,
  forceDecrypt: workerData.forceDecrypt,
  loginCapture: workerData.loginCapture,
  keysPath: workerData.keysPath,
  onProgress: (event) => {
    parentPort.postMessage({ type: 'progress', event });
  },
})
  .then((result) => {
    parentPort.postMessage({ type: 'done', ok: true, result });
  })
  .catch((err) => {
    parentPort.postMessage({ type: 'done', ok: false, error: err.message });
  });
