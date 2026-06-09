#!/usr/bin/env node

// ============================================================================
// Follow Builders — Delivery Script
// ============================================================================
// Sends a digest to the user via their chosen delivery method.
// Supports: Telegram bot, Email (via Resend), Feishu/Lark, or stdout (default).
//
// Usage:
//   echo "digest text" | node deliver.js
//   node deliver.js --message "digest text"
//   node deliver.js --file /path/to/digest.txt
//   node deliver.js --post-file /path/to/feishu-post.json
//
// The script reads delivery config from ~/.follow-builders/config.json
// and API keys from ~/.follow-builders/.env
//
// Delivery methods:
//   - "telegram": sends via Telegram Bot API (needs TELEGRAM_BOT_TOKEN + chat ID)
//   - "email": sends via Resend API (needs RESEND_API_KEY + email address)
//   - "feishu": sends via lark-cli to a user/group, or via Feishu webhook
//   - "stdout" (default): just prints to terminal
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHmac } from 'crypto';
import { spawn } from 'child_process';
import { config as loadEnv } from 'dotenv';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = process.env.FOLLOW_BUILDERS_CONFIG || join(USER_DIR, 'config.json');
const ENV_PATH = process.env.FOLLOW_BUILDERS_ENV || join(USER_DIR, '.env');

// -- Read input --------------------------------------------------------------

// The digest can come from stdin, --message, --file, or --post-file.
async function getDigestInput() {
  const args = process.argv.slice(2);

  // Check --post-file flag. The file must contain Feishu post content JSON.
  const postFileIdx = args.indexOf('--post-file');
  if (postFileIdx !== -1 && args[postFileIdx + 1]) {
    const raw = await readFile(args[postFileIdx + 1], 'utf-8');
    return {
      type: 'post',
      content: JSON.stringify(JSON.parse(raw))
    };
  }

  // Check --message flag
  const msgIdx = args.indexOf('--message');
  if (msgIdx !== -1 && args[msgIdx + 1]) {
    return { type: 'text', content: args[msgIdx + 1] };
  }

  // Check --file flag
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    return { type: 'text', content: await readFile(args[fileIdx + 1], 'utf-8') };
  }

  // Read from stdin
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return { type: 'text', content: Buffer.concat(chunks).toString('utf-8') };
}

// -- Telegram Delivery -------------------------------------------------------

// Sends the digest via Telegram Bot API.
// The user creates a bot via @BotFather and provides the token.
// The chat ID is obtained when the user sends their first message to the bot.
async function sendTelegram(text, botToken, chatId) {
  // Telegram has a 4096 character limit per message.
  // If the digest is longer, we split it into chunks.
  const MAX_LEN = 4000;
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    // Try to split at a newline near the limit
    let splitAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (splitAt < MAX_LEN * 0.5) splitAt = MAX_LEN;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }

  for (const chunk of chunks) {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: chunk,
          parse_mode: 'Markdown',
          disable_web_page_preview: true
        })
      }
    );

    if (!res.ok) {
      const err = await res.json();
      // If Markdown parsing fails, retry without parse_mode
      if (err.description && err.description.includes("can't parse")) {
        await fetch(
          `https://api.telegram.org/bot${botToken}/sendMessage`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              disable_web_page_preview: true
            })
          }
        );
      } else {
        throw new Error(`Telegram API error: ${err.description}`);
      }
    }

    // Small delay between chunks to avoid rate limiting
    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

// -- Email Delivery (Resend) -------------------------------------------------

// Sends the digest via Resend's email API.
// The user provides their own Resend API key and email address.
async function sendEmail(text, apiKey, toEmail) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: 'AI Builders Digest <digest@resend.dev>',
      to: [toEmail],
      subject: `AI Builders Digest — ${new Date().toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
      })}`,
      text: text
    })
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`Resend API error: ${err.message || JSON.stringify(err)}`);
  }
}

// -- Feishu / Lark Delivery --------------------------------------------------

function chunkText(text, maxLen = 3800) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

async function sendFeishuWebhook(message, webhookUrl, webhookSecret) {
  const chunks = message.type === 'post' ? [message.content] : chunkText(message.content);

  for (const chunk of chunks) {
    const post = message.type === 'post' ? normalizePostForWebhook(JSON.parse(chunk)) : null;
    const body = message.type === 'post'
      ? {
          msg_type: 'post',
          content: {
            post
          }
        }
      : {
          msg_type: 'text',
          content: { text: chunk }
        };

    if (webhookSecret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signString = `${timestamp}\n${webhookSecret}`;
      body.timestamp = timestamp;
      body.sign = createHmac('sha256', signString).update('').digest('base64');
    }

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const responseText = await res.text();
    if (!res.ok) {
      throw new Error(`Feishu webhook error: ${res.status} ${responseText}`);
    }

    if (responseText) {
      const result = JSON.parse(responseText);
      const statusCode = result.StatusCode ?? result.code ?? 0;
      if (statusCode !== 0) {
        throw new Error(`Feishu webhook error: ${responseText}`);
      }
    }

    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

function normalizePostForWebhook(post) {
  const normalized = {};

  for (const [locale, value] of Object.entries(post)) {
    normalized[locale] = {
      title: value.title || '',
      content: (value.content || []).map(line =>
        line
          .map(node => {
            if (node.tag === 'a') {
              return {
                tag: 'a',
                text: node.text || '',
                href: node.href || ''
              };
            }

            return {
              tag: 'text',
              text: node.text || ''
            };
          })
          .filter(node => node.text || node.href)
      )
    };
  }

  return normalized;
}

function runLarkCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('lark-cli', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', err => {
      reject(new Error(`Could not run lark-cli: ${err.message}`));
    });
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`lark-cli exited with ${code}: ${stderr || stdout}`));
      }
    });
  });
}

async function sendFeishuWithCli(message, delivery) {
  const chunks = message.type === 'post' ? [message.content] : chunkText(message.content);
  const identity = delivery.identity || 'bot';
  const targetArgs = delivery.userId
    ? ['--user-id', delivery.userId]
    : ['--chat-id', delivery.chatId];

  if (!delivery.userId && !delivery.chatId) {
    throw new Error('delivery.userId or delivery.chatId is required for Feishu lark-cli delivery');
  }

  for (const chunk of chunks) {
    const contentArgs = message.type === 'post'
      ? ['--msg-type', 'post', '--content', chunk]
      : ['--text', chunk];

    await runLarkCli([
      'im',
      '+messages-send',
      '--as',
      identity,
      ...targetArgs,
      ...contentArgs
    ]);

    if (chunks.length > 1) await new Promise(r => setTimeout(r, 500));
  }
}

async function sendFeishu(message, delivery) {
  const webhookUrl = process.env.FEISHU_WEBHOOK_URL || delivery.webhookUrl;
  const webhookSecret = process.env.FEISHU_WEBHOOK_SECRET || delivery.webhookSecret;

  if (webhookUrl) {
    await sendFeishuWebhook(message, webhookUrl, webhookSecret);
    return 'webhook';
  }

  await sendFeishuWithCli(message, delivery);
  return 'lark-cli';
}

// -- Main --------------------------------------------------------------------

async function main() {
  // Load env and config
  loadEnv({ path: ENV_PATH });

  let config = {};
  if (existsSync(CONFIG_PATH)) {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
  }

  const delivery = config.delivery || { method: 'stdout' };
  const digest = await getDigestInput();

  if (!digest.content || digest.content.trim().length === 0) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'Empty digest text' }));
    return;
  }

  try {
    switch (delivery.method) {
      case 'telegram': {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const chatId = delivery.chatId;
        if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not found in .env');
        if (!chatId) throw new Error('delivery.chatId not found in config.json');
        if (digest.type !== 'text') throw new Error('Telegram delivery only supports text input');
        await sendTelegram(digest.content, botToken, chatId);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'telegram',
          message: 'Digest sent to Telegram'
        }));
        break;
      }

      case 'email': {
        const apiKey = process.env.RESEND_API_KEY;
        const toEmail = delivery.email;
        if (!apiKey) throw new Error('RESEND_API_KEY not found in .env');
        if (!toEmail) throw new Error('delivery.email not found in config.json');
        if (digest.type !== 'text') throw new Error('Email delivery only supports text input');
        await sendEmail(digest.content, apiKey, toEmail);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'email',
          message: `Digest sent to ${toEmail}`
        }));
        break;
      }

      case 'feishu': {
        const transport = await sendFeishu(digest, delivery);
        console.log(JSON.stringify({
          status: 'ok',
          method: 'feishu',
          transport,
          message: 'Digest sent to Feishu'
        }));
        break;
      }

      case 'stdout':
      default:
        // Just print to terminal — the agent or OpenClaw handles delivery
        console.log(digest.content);
        break;
    }
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      method: delivery.method,
      message: err.message
    }));
    process.exit(1);
  }
}

main();
