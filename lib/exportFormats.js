const fs = require('fs');
const path = require('path');

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeCsv(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatMessageLine(msg) {
  const sender = msg.isSelf ? '我' : msg.senderName || msg.senderWxid || '未知';
  const time = msg.datetime || '';
  const body = msg.content || `[${msg.typeName || '消息'}]`;
  return `[${time}] ${sender}: ${body}`;
}

function writeTxtChat(chat, outFile) {
  const lines = [
    `# ${chat.displayName}`,
    `# 类型: ${chat.type === 'group' ? '群聊' : '私聊'}`,
    `# 消息数: ${chat.messageCount}`,
    '',
  ];

  for (const msg of chat.messages) {
    lines.push(formatMessageLine(msg));
  }

  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
}

function writeCsvMessages(chats, outFile) {
  const lines = ['会话,类型,时间,发送者,是否本人,消息类型,内容'];

  for (const chat of chats) {
    for (const msg of chat.messages) {
      const sender = msg.isSelf ? '我' : msg.senderName || msg.senderWxid || '';
      lines.push(
        [
          escapeCsv(chat.displayName),
          escapeCsv(chat.type === 'group' ? '群聊' : '私聊'),
          escapeCsv(msg.datetime || ''),
          escapeCsv(sender),
          escapeCsv(msg.isSelf ? '是' : '否'),
          escapeCsv(msg.typeName || ''),
          escapeCsv(msg.content || ''),
        ].join(',')
      );
    }
  }

  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
}

function renderHtmlMessage(msg) {
  const sender = msg.isSelf ? '我' : msg.senderName || msg.senderWxid || '未知';
  const align = msg.isSelf ? 'self' : 'other';
  const isVoice = msg.type === 34 || msg.typeName === 'voice';
  const transcription = msg.extra?.transcription;
  let body;

  if (isVoice && transcription) {
    const durationMs = msg.extra?.voiceDurationMs || 0;
    const label =
      durationMs > 0 ? `[语音 ${(durationMs / 1000).toFixed(1)}s]` : '[语音]';
    body = `<span class="voice-label">${escapeHtml(label)}</span><span class="voice-text">${escapeHtml(transcription).replace(/\n/g, '<br>')}</span>`;
  } else {
    body = escapeHtml(msg.content || `[${msg.typeName || '消息'}]`).replace(/\n/g, '<br>');
  }

  const bubbleClass = isVoice && transcription ? 'bubble bubble-voice' : 'bubble';

  return `
    <div class="msg ${align}">
      <div class="meta">${escapeHtml(msg.datetime || '')} · ${escapeHtml(sender)}</div>
      <div class="${bubbleClass}">${body}</div>
    </div>`;
}

function writeHtmlChat(chat, outFile, indexRelPath) {
  const messagesHtml = chat.messages.map(renderHtmlMessage).join('\n');
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(chat.displayName)} - 微迹导出</title>
  <style>
    :root { --green: #07c160; --bg: #f5f7fa; --card: #fff; --text: #1f2937; --muted: #6b7280; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--text); }
    header { background: linear-gradient(135deg, #07c160, #34d399); color: #fff; padding: 20px 24px; }
    header h1 { margin: 0 0 6px; font-size: 22px; }
    header p { margin: 0; opacity: 0.9; font-size: 13px; }
    .back { display: inline-block; margin-top: 10px; color: #fff; font-size: 13px; text-decoration: none; opacity: 0.85; }
    main { max-width: 860px; margin: 0 auto; padding: 20px 16px 40px; }
    .msg { margin-bottom: 14px; display: flex; flex-direction: column; }
    .msg.self { align-items: flex-end; }
    .msg.other { align-items: flex-start; }
    .meta { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
    .bubble { max-width: 78%; padding: 10px 14px; border-radius: 14px; line-height: 1.55; font-size: 14px; word-break: break-word; }
    .msg.self .bubble { background: #dcf8c6; border-bottom-right-radius: 4px; }
    .msg.other .bubble { background: var(--card); border: 1px solid #e5e7eb; border-bottom-left-radius: 4px; }
    .bubble-voice { display: flex; flex-direction: column; gap: 6px; }
    .voice-label { font-size: 12px; color: var(--muted); font-weight: 600; }
    .voice-text { font-size: 14px; line-height: 1.55; }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHtml(chat.displayName)}</h1>
    <p>${chat.type === 'group' ? '群聊' : '私聊'} · ${chat.messageCount} 条消息</p>
    ${indexRelPath ? `<a class="back" href="${escapeHtml(indexRelPath)}">← 返回索引</a>` : ''}
  </header>
  <main>
    ${messagesHtml}
  </main>
</body>
</html>`;

  fs.writeFileSync(outFile, html, 'utf8');
}

function writeHtmlIndex({ outputDir, selfWxid, exportedAt, conversations, chatsRelDir }) {
  const items = conversations
    .map((conv) => {
      const htmlFile = conv.files?.html || null;
      if (!htmlFile) return '';
      const href = htmlFile.replace(/\\/g, '/');
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(conv.displayName)}</a> <span class="muted">(${conv.messageCount} 条 · ${conv.type === 'group' ? '群聊' : '私聊'})</span></li>`;
    })
    .filter(Boolean)
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>微迹导出索引</title>
  <style>
    body { font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; color: #1f2937; }
    h1 { color: #07c160; }
    .muted { color: #6b7280; font-size: 13px; }
    ul { line-height: 2; padding-left: 20px; }
    a { color: #059669; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <h1>微迹 Wetrace 导出索引</h1>
  <p class="muted">账号 ${escapeHtml(selfWxid)} · ${escapeHtml(exportedAt)} · 共 ${conversations.length} 个会话</p>
  <ul>
    ${items}
  </ul>
</body>
</html>`;

  const indexPath = path.join(outputDir, 'index.html');
  fs.writeFileSync(indexPath, html, 'utf8');
  return indexPath;
}

function writeChatFormats(chat, outputDir, formats, fileBase, indexRelPath) {
  const files = {};
  const chatsDir = path.join(outputDir, 'chats');

  if (formats.includes('json')) {
    const outFile = path.join(chatsDir, `${fileBase}.json`);
    fs.writeFileSync(outFile, JSON.stringify(chat, null, 2), 'utf8');
    files.json = path.relative(outputDir, outFile).replace(/\\/g, '/');
  }

  if (formats.includes('txt')) {
    const outFile = path.join(chatsDir, `${fileBase}.txt`);
    writeTxtChat(chat, outFile);
    files.txt = path.relative(outputDir, outFile).replace(/\\/g, '/');
  }

  if (formats.includes('html')) {
    const outFile = path.join(chatsDir, `${fileBase}.html`);
    writeHtmlChat(chat, outFile, indexRelPath);
    files.html = path.relative(outputDir, outFile).replace(/\\/g, '/');
  }

  return files;
}

module.exports = {
  writeChatFormats,
  writeCsvMessages,
  writeHtmlIndex,
  escapeHtml,
};
