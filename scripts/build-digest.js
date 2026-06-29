#!/usr/bin/env node

// Builds the Follow Builders morning brief by having an LLM read each selected
// source item and produce a Chinese long-form summary plus excerpts.

import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { homedir } from 'os';

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = process.env.FOLLOW_BUILDERS_CONFIG || join(USER_DIR, 'config.json');
const STATE_PATH = process.env.FOLLOW_BUILDERS_STATE || join(dirname(CONFIG_PATH), 'delivery-state.json');
const SUMMARY_CACHE_PATH = process.env.FOLLOW_BUILDERS_SUMMARY_CACHE || join(dirname(STATE_PATH), 'llm-summary-cache.json');
const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const ROOT_DIR = join(SCRIPT_DIR, '..');

const PROMPT_VERSION = 'deep-read-zh-v1';
const MAX_DIGEST_ITEMS = Number(process.env.FOLLOW_BUILDERS_MAX_ITEMS || 10);
const MAX_DIRECT_SOURCE_CHARS = 45000;
const SOURCE_CHUNK_CHARS = 28000;
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const FEEDS = {
  x: {
    url: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-x.json',
    local: join(ROOT_DIR, 'feed-x.json')
  },
  podcasts: {
    url: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json',
    local: join(ROOT_DIR, 'feed-podcasts.json')
  },
  blogs: {
    url: 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-blogs.json',
    local: join(ROOT_DIR, 'feed-blogs.json')
  }
};

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'excerpts', 'materials'],
  properties: {
    title: {
      type: 'string',
      description: 'A concise Chinese title for this item.'
    },
    summary: {
      type: 'string',
      description: 'A substantial Chinese paragraph summarizing the full source and why it matters.'
    },
    excerpts: {
      type: 'array',
      minItems: 3,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'text', 'reference'],
        properties: {
          label: {
            type: 'string',
            description: '观点, 金句, 案例, 数据, 类比, or other short Chinese label.'
          },
          text: {
            type: 'string',
            description: 'Chinese excerpt or paraphrase with enough detail to be useful.'
          },
          reference: {
            type: 'string',
            description: 'Timestamp, section, source line, or URL evidence. Empty string only if unavailable.'
          }
        }
      }
    },
    materials: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'url', 'note'],
        properties: {
          label: { type: 'string' },
          url: { type: 'string' },
          note: { type: 'string' }
        }
      }
    }
  }
};

const NOTES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['notes'],
  properties: {
    notes: {
      type: 'array',
      minItems: 3,
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['point', 'evidence'],
        properties: {
          point: { type: 'string' },
          evidence: { type: 'string' }
        }
      }
    }
  }
};

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function readJSON(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, 'utf-8'));
}

async function loadFeed(feed) {
  return (await fetchJSON(feed.url)) || (await readJSON(feed.local));
}

async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    return {
      language: 'zh',
      timezone: 'Asia/Shanghai',
      frequency: 'daily',
      delivery: { method: 'stdout' }
    };
  }
  return JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
}

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { version: 1, sent: {} };
  }
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    return {
      version: 1,
      sent: state.sent || {}
    };
  } catch {
    return { version: 1, sent: {} };
  }
}

async function loadSummaryCache() {
  if (!existsSync(SUMMARY_CACHE_PATH)) {
    return { version: 1, promptVersion: PROMPT_VERSION, summaries: {} };
  }

  try {
    const cache = JSON.parse(await readFile(SUMMARY_CACHE_PATH, 'utf-8'));
    return {
      version: 1,
      promptVersion: PROMPT_VERSION,
      summaries: cache.summaries || {}
    };
  } catch {
    return { version: 1, promptVersion: PROMPT_VERSION, summaries: {} };
  }
}

async function saveSummaryCache(cache) {
  await mkdir(dirname(SUMMARY_CACHE_PATH), { recursive: true });
  await writeFile(SUMMARY_CACHE_PATH, `${JSON.stringify({
    version: 1,
    promptVersion: PROMPT_VERSION,
    updatedAt: new Date().toISOString(),
    summaries: cache.summaries || {}
  }, null, 2)}\n`);
}

function isSent(state, id) {
  return Boolean(state.sent?.[id]);
}

function topicId(title) {
  return `topic:${title}`;
}

function tweetId(tweet) {
  return `tweet:${tweet.id || tweet.url}`;
}

function blogId(blog) {
  return `blog:${blog.url}`;
}

function podcastId(podcast) {
  return `podcast:${podcast.guid || podcast.url || podcast.title}`;
}

function sourceHash(text) {
  return createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

function cacheKey(item) {
  return `${PROMPT_VERSION}:${item.id}:${sourceHash(item.sourceText)}`;
}

function makeRecord(data) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    items: data.items.map(item => ({
      id: item.id,
      type: item.type,
      title: item.title,
      url: item.url
    }))
  };
}

async function markRecordSent(recordPath) {
  const record = JSON.parse(await readFile(recordPath, 'utf-8'));
  const state = await loadState();
  const sentAt = new Date().toISOString();

  for (const item of record.items || []) {
    state.sent[item.id] = {
      type: item.type,
      title: item.title,
      url: item.url,
      sentAt
    };
    state.sent[topicId(item.title)] = {
      type: 'topic',
      title: item.title,
      url: item.url,
      sentAt
    };
  }

  state.updatedAt = sentAt;
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  return { marked: (record.items || []).length, statePath: STATE_PATH };
}

function stripHtml(text = '') {
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(text = '', maxLen = 240) {
  const clean = stripHtml(text);
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen);
  const lastSpace = slice.lastIndexOf(' ');
  return `${slice.slice(0, lastSpace > maxLen * 0.6 ? lastSpace : maxLen).trim()}...`;
}

function hasAny(text = '', keywords = []) {
  const haystack = text.toLowerCase();
  return keywords.some(keyword => haystack.includes(keyword.toLowerCase()));
}

function scoreTweet(tweet) {
  const text = tweet.text || '';
  const created = Date.parse(tweet.createdAt || '') || 0;
  const ageHours = created ? Math.max(1, (Date.now() - created) / 36e5) : 48;
  const engagement = (tweet.likes || 0) + (tweet.retweets || 0) * 4 + (tweet.replies || 0) * 2;
  const quoteBonus = tweet.isQuote ? 10 : 0;
  const replyPenalty = text.trim().startsWith('@') ? -80 : 0;
  const signalBonus = hasAny(text, [
    'agent', 'codex', 'cursor', 'ai', 'tokens', 'jobs', 'engineer',
    'model', 'eval', 'hiring', 'productivity', 'startup', 'research'
  ]) ? 1000 : 0;
  const lowSignalPenalty = hasAny(text, [
    'san francisco', 'gaslighting', 'you know what to do', 'short story',
    'lots of little vectors'
  ]) ? -2400 : 0;

  return engagement + signalBonus + lowSignalPenalty + quoteBonus + replyPenalty + Math.max(0, 24 - ageHours) * 0.5;
}

function isLowSignalTweet(tweet) {
  return hasAny(tweet.text || '', [
    'san francisco', 'gaslighting', 'you know what to do', 'short story',
    'lots of little vectors'
  ]);
}

function recencyScore(dateValue) {
  const ts = Date.parse(dateValue || '') || 0;
  if (!ts) return 0;
  const ageHours = Math.max(1, (Date.now() - ts) / 36e5);
  return Math.max(0, 336 - ageHours);
}

function topTweets(feedX, limit = 50) {
  return (feedX?.x || [])
    .flatMap(builder =>
      (builder.tweets || []).map(tweet => ({
        ...tweet,
        builderName: builder.name,
        handle: builder.handle,
        score: scoreTweet(tweet)
      }))
    )
    .filter(tweet => tweet.score > 0)
    .filter(tweet => !isLowSignalTweet(tweet))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function topBlogs(feedBlogs, limit = 20) {
  return (feedBlogs?.blogs || [])
    .slice()
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, limit);
}

function topPodcasts(feedPodcasts, limit = 20) {
  return (feedPodcasts?.podcasts || [])
    .slice()
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, limit);
}

function formatDate(config) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: config.timezone || 'Asia/Shanghai',
    month: 'long',
    day: 'numeric',
    weekday: 'short'
  });
  return formatter.format(new Date());
}

function itemFromTweet(tweet) {
  const title = `${tweet.builderName || tweet.handle || 'Builder'}：${compact(tweet.text || '', 80)}`;
  const sourceText = [
    `来源类型：Builder/X 动态`,
    `作者：${tweet.builderName || ''} @${tweet.handle || ''}`,
    `发布时间：${tweet.createdAt || ''}`,
    `链接：${tweet.url || ''}`,
    `互动：likes=${tweet.likes || 0}, retweets=${tweet.retweets || 0}, replies=${tweet.replies || 0}`,
    '',
    `原文：`,
    tweet.text || ''
  ].join('\n');

  return {
    id: tweetId(tweet),
    type: 'tweet',
    title,
    sourceName: tweet.builderName || tweet.handle || 'Builder',
    url: tweet.url,
    publishedAt: tweet.createdAt,
    score: 1000 + tweet.score + recencyScore(tweet.createdAt),
    sourceText
  };
}

function itemFromBlog(blog) {
  const title = `${blog.name || 'Blog'}: ${blog.title}`;
  const sourceText = [
    `来源类型：深度文章`,
    `来源：${blog.name || ''}`,
    `标题：${blog.title || ''}`,
    `发布时间：${blog.publishedAt || ''}`,
    `链接：${blog.url || ''}`,
    '',
    `正文：`,
    stripHtml(blog.content || blog.description || '')
  ].join('\n');

  return {
    id: blogId(blog),
    type: 'blog',
    title,
    sourceName: blog.name || 'Blog',
    url: blog.url,
    publishedAt: blog.publishedAt,
    score: 1800 + recencyScore(blog.publishedAt) + Math.min(600, sourceText.length / 100),
    sourceText
  };
}

function itemFromPodcast(podcast) {
  const title = `${podcast.name || 'Podcast'}: ${podcast.title}`;
  const sourceText = [
    `来源类型：播客逐字稿`,
    `节目：${podcast.name || ''}`,
    `标题：${podcast.title || ''}`,
    `发布时间：${podcast.publishedAt || ''}`,
    `链接：${podcast.url || ''}`,
    '',
    `逐字稿：`,
    podcast.transcript || ''
  ].join('\n');

  return {
    id: podcastId(podcast),
    type: 'podcast',
    title,
    sourceName: podcast.name || 'Podcast',
    url: podcast.url,
    publishedAt: podcast.publishedAt,
    score: 2000 + recencyScore(podcast.publishedAt) + Math.min(900, sourceText.length / 160),
    sourceText
  };
}

function selectDigestItems({ feedX, feedPodcasts, feedBlogs, state }) {
  const items = [
    ...topTweets(feedX).map(itemFromTweet),
    ...topBlogs(feedBlogs).map(itemFromBlog),
    ...topPodcasts(feedPodcasts).map(itemFromPodcast)
  ];

  const seenTitles = new Set();
  return items
    .filter(item => item.url)
    .filter(item => item.sourceText.trim().length > 0)
    .filter(item => !isSent(state, item.id))
    .filter(item => !isSent(state, topicId(item.title)))
    .filter(item => {
      if (seenTitles.has(item.title)) return false;
      seenTitles.add(item.title);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_DIGEST_ITEMS);
}

function requireOpenAIConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for LLM deep-read digest generation');
  }
  if (!model) {
    throw new Error('OPENAI_MODEL is required for LLM deep-read digest generation');
  }
  return { apiKey, model };
}

function responseText(response) {
  if (response.output_text) return response.output_text;
  const parts = [];
  for (const output of response.output || []) {
    for (const content of output.content || []) {
      if (content.text) parts.push(content.text);
    }
  }
  return parts.join('\n');
}

async function createStructuredResponse({ apiKey, model, input, schema, name }) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          input,
          text: {
            format: {
              type: 'json_schema',
              name,
              schema,
              strict: true
            }
          }
        })
      });

      const bodyText = await res.text();
      if (!res.ok) {
        throw new Error(`OpenAI Responses API error: ${res.status} ${bodyText}`);
      }

      const data = JSON.parse(bodyText);
      const text = responseText(data);
      if (!text) throw new Error('OpenAI response did not include output text');
      return JSON.parse(text);
    } catch (err) {
      lastError = err;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1200));
    }
  }
  throw lastError;
}

function sourceChunks(text) {
  const chunks = [];
  for (let index = 0; index < text.length; index += SOURCE_CHUNK_CHARS) {
    chunks.push(text.slice(index, index + SOURCE_CHUNK_CHARS));
  }
  return chunks;
}

async function summarizeChunk({ apiKey, model, item, chunk, index, total }) {
  return createStructuredResponse({
    apiKey,
    model,
    name: 'source_chunk_notes',
    schema: NOTES_SCHEMA,
    input: [
      {
        role: 'system',
        content: '你是中文研究助理。请只从给定片段提炼事实性笔记，不要泛泛而谈，不要编造。'
      },
      {
        role: 'user',
        content: [
          `内容标题：${item.title}`,
          `来源链接：${item.url}`,
          `片段：${index + 1}/${total}`,
          '',
          chunk
        ].join('\n')
      }
    ]
  });
}

async function summarizeItemWithLLM(item) {
  const { apiKey, model } = requireOpenAIConfig();
  let sourceForFinal = item.sourceText;

  if (item.sourceText.length > MAX_DIRECT_SOURCE_CHARS) {
    const chunks = sourceChunks(item.sourceText);
    const notes = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const result = await summarizeChunk({
        apiKey,
        model,
        item,
        chunk: chunks[index],
        index,
        total: chunks.length
      });
      notes.push(...(result.notes || []));
    }
    sourceForFinal = [
      `原内容过长，以下是逐段阅读后的中间笔记。最终摘要必须基于这些笔记和标题/链接，不要补充笔记之外的事实。`,
      '',
      ...notes.map((note, index) => `${index + 1}. ${note.point}\n证据：${note.evidence}`)
    ].join('\n');
  }

  const summary = await createStructuredResponse({
    apiKey,
    model,
    name: 'deep_read_summary',
    schema: SUMMARY_SCHEMA,
    input: [
      {
        role: 'system',
        content: [
          '你是一个给中文读者写 AI 行业早餐精读的研究员。',
          '你必须认真阅读用户提供的完整内容或中间笔记，然后输出中文。',
          '输出只允许基于来源材料；不要写“本文主要介绍了”这种空话；不要编造图表。',
          '摘要要稍长，讲清核心内容、关键论证和为什么值得看。',
          '摘录要挑令人印象深刻的观点、金句、案例、数据或类比；播客摘录尽量带时间点。',
          '如果来源中有图、图表、截图、demo、slide、figure 等明确线索，可在 materials 中给原文链接并说明看什么；没有就返回空数组。'
        ].join('\n')
      },
      {
        role: 'user',
        content: [
          `内容类型：${item.type}`,
          `标题：${item.title}`,
          `来源：${item.sourceName}`,
          `链接：${item.url}`,
          `发布时间：${item.publishedAt || ''}`,
          '',
          sourceForFinal
        ].join('\n')
      }
    ]
  });

  return normalizeSummary(summary, item);
}

function normalizeSummary(summary, item) {
  const excerpts = Array.isArray(summary.excerpts) ? summary.excerpts.slice(0, 8) : [];
  const materials = Array.isArray(summary.materials) ? summary.materials.slice(0, 4) : [];
  if (!summary.summary || excerpts.length < 3) {
    throw new Error(`LLM summary for ${item.id} did not include a summary and at least 3 excerpts`);
  }

  return {
    title: summary.title || item.title,
    summary: summary.summary,
    excerpts: excerpts.map(excerpt => ({
      label: excerpt.label || '摘录',
      text: excerpt.text || '',
      reference: excerpt.reference || ''
    })).filter(excerpt => excerpt.text),
    materials: materials.map(material => ({
      label: material.label || '图表/素材',
      url: material.url || item.url,
      note: material.note || ''
    })).filter(material => material.url)
  };
}

async function summarizeItems(items) {
  if (!items.length) return [];
  const cache = await loadSummaryCache();
  let cacheChanged = false;
  const summarized = [];

  for (const item of items) {
    const key = cacheKey(item);
    const cached = cache.summaries[key];
    if (cached?.summary) {
      summarized.push({ ...item, summary: cached.summary, cacheKey: key });
      continue;
    }

    const summary = await summarizeItemWithLLM(item);
    cache.summaries[key] = {
      itemId: item.id,
      sourceHash: sourceHash(item.sourceText),
      promptVersion: PROMPT_VERSION,
      title: item.title,
      url: item.url,
      generatedAt: new Date().toISOString(),
      summary
    };
    cacheChanged = true;
    summarized.push({ ...item, summary, cacheKey: key });
  }

  if (cacheChanged) await saveSummaryCache(cache);
  return summarized;
}

async function buildDigestData({ config, feedX, feedPodcasts, feedBlogs, state }) {
  const items = selectDigestItems({ feedX, feedPodcasts, feedBlogs, state });
  const summarizedItems = await summarizeItems(items);
  return {
    title: `AI Builders 早餐精读 | ${formatDate(config)}`,
    items: summarizedItems
  };
}

function hasDigestContent(data) {
  return data.items.length > 0;
}

function formatDigestData(data) {
  if (!hasDigestContent(data)) return '';

  const lines = [
    data.title,
    '',
    `今天精选 ${data.items.length} 条新内容。每条都包含摘要和摘录。`,
    ''
  ];

  data.items.forEach((item, index) => {
    lines.push(`【${index + 1}. ${item.summary.title}】`);
    lines.push(item.url);
    lines.push('');
    lines.push('摘要：');
    lines.push(item.summary.summary);
    lines.push('');
    lines.push('摘录：');
    for (const excerpt of item.summary.excerpts) {
      const reference = excerpt.reference ? `（${excerpt.reference}）` : '';
      lines.push(`- ${excerpt.label}：${excerpt.text}${reference}`);
    }
    if (item.summary.materials.length) {
      lines.push('');
      lines.push('图表/素材：');
      for (const material of item.summary.materials) {
        lines.push(`- ${material.label}：${material.note} ${material.url}`.trim());
      }
    }
    lines.push('');
  });

  return lines.join('\n').trim();
}

function textNode(text, style) {
  const value = { tag: 'text', text };
  if (style) value.style = style;
  return value;
}

function linkNode(text, href) {
  return { tag: 'a', text, href };
}

function paragraph(...items) {
  return items.flat().filter(Boolean);
}

function blankLine() {
  return [textNode(' ')];
}

function dividerLine() {
  return [textNode('━━━━━━━━━━━━━━━━━━━━')];
}

function formatPostDigestData(data) {
  if (!hasDigestContent(data)) return '';

  const content = [
    paragraph(textNode(`今天精选 ${data.items.length} 条新内容。每条都包含摘要和摘录。`)),
    blankLine()
  ];

  data.items.forEach((item, index) => {
    content.push(
      dividerLine(),
      paragraph(textNode(`${index + 1}. `, ['bold']), linkNode(item.summary.title, item.url)),
      paragraph(textNode('摘要', ['bold'])),
      paragraph(textNode(item.summary.summary)),
      paragraph(textNode('摘录', ['bold']))
    );

    for (const excerpt of item.summary.excerpts) {
      const reference = excerpt.reference ? `（${excerpt.reference}）` : '';
      content.push(paragraph(textNode(`• ${excerpt.label}：`, ['bold']), textNode(`${excerpt.text}${reference}`)));
    }

    if (item.summary.materials.length) {
      content.push(paragraph(textNode('图表/素材', ['bold'])));
      for (const material of item.summary.materials) {
        content.push(paragraph(textNode(`• ${material.label}：`), linkNode(material.note || material.url, material.url)));
      }
    }

    content.push(blankLine());
  });

  return JSON.stringify({
    zh_cn: {
      title: data.title,
      content: content.filter(Boolean)
    }
  }, null, 2);
}

async function main() {
  const args = process.argv.slice(2);
  const markSentIdx = args.indexOf('--mark-sent');
  if (markSentIdx !== -1) {
    const recordPath = args[markSentIdx + 1];
    if (!recordPath) throw new Error('--mark-sent requires a record file path');
    console.log(JSON.stringify(await markRecordSent(recordPath), null, 2));
    return;
  }

  const formatIdx = args.indexOf('--format');
  const outputFormat = formatIdx !== -1 && args[formatIdx + 1] ? args[formatIdx + 1] : 'text';
  const recordFileIdx = args.indexOf('--record-file');
  const recordFile = recordFileIdx !== -1 ? args[recordFileIdx + 1] : null;
  if (recordFileIdx !== -1 && !recordFile) throw new Error('--record-file requires a file path');

  const config = await loadConfig();
  const state = await loadState();
  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    loadFeed(FEEDS.x),
    loadFeed(FEEDS.podcasts),
    loadFeed(FEEDS.blogs)
  ]);

  if (!feedX && !feedPodcasts && !feedBlogs) {
    throw new Error('No Follow Builders feeds could be loaded');
  }

  const digestData = await buildDigestData({ config, feedX, feedPodcasts, feedBlogs, state });
  if (recordFile) {
    await writeFile(recordFile, `${JSON.stringify(makeRecord(digestData), null, 2)}\n`);
  }

  const output = outputFormat === 'post'
    ? formatPostDigestData(digestData)
    : formatDigestData(digestData);
  if (output) console.log(output);
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
