#!/usr/bin/env node

const path = require('path');
const { exportWeChatChats } = require('./lib/exportCore');

const DEFAULT_WX_DIR = 'D:/file/WexinChat/xwechat_files/wxid_6o9o8i7ffua012_c989';
const DEFAULT_OUTPUT = path.join(__dirname, 'export');

function parseArgs(argv) {
  const args = {
    wxDir: DEFAULT_WX_DIR,
    output: DEFAULT_OUTPUT,
    selfWxid: null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--wx-dir' && argv[i + 1]) {
      args.wxDir = argv[++i];
    } else if (arg === '--output' && argv[i + 1]) {
      args.output = argv[++i];
    } else if (arg === '--self-wxid' && argv[i + 1]) {
      args.selfWxid = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node export.js [--wx-dir PATH] [--output PATH] [--self-wxid WXID]');
      process.exit(0);
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  const result = await exportWeChatChats({
    wxDir: args.wxDir,
    outputDir: args.output,
    selfWxid: args.selfWxid,
    onProgress(event) {
      if (event.phase === 'init') {
        console.log(`[*] ${event.message}`);
      } else if (event.phase === 'exporting' && event.current % 25 === 0) {
        console.log(
          `[*] 已导出 ${event.current} 个会话，累计 ${event.totalMessages} 条消息...`
        );
      } else if (event.phase === 'done') {
        console.log(
          `[*] 完成: ${event.conversationCount} 个会话, ${event.totalMessages} 条消息`
        );
        console.log(`[*] 索引: ${event.indexPath}`);
        console.log(`[*] 目录: ${event.chatsDir}`);
      }
    },
  });

  return result;
}

main().catch((err) => {
  console.error(`[-] ${err.message}`);
  process.exit(1);
});
