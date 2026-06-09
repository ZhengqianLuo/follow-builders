#!/usr/bin/env node

// Builds a concise deterministic morning brief from the Follow Builders feeds.
// Use this when a scheduled job needs a ready-to-send digest without relying on
// an interactive agent to rewrite the raw feed.

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = process.env.FOLLOW_BUILDERS_CONFIG || join(USER_DIR, 'config.json');
const STATE_PATH = process.env.FOLLOW_BUILDERS_STATE || join(dirname(CONFIG_PATH), 'delivery-state.json');
const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const ROOT_DIR = join(SCRIPT_DIR, '..');

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

function isSent(state, id) {
  return Boolean(state.sent?.[id]);
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

function topicId(title) {
  return `topic:${title}`;
}

function makeRecord(data) {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    items: [
      ...data.tweetItems.map(({ tweet, summary }) => ({
        id: tweetId(tweet),
        type: 'tweet',
        title: summary.title,
        url: tweet.url
      })),
      ...data.blogItems.map(({ summary, source }) => ({
        id: blogId(source),
        type: 'blog',
        title: summary.title,
        url: source.url
      })),
      ...data.podcastItems.map(({ summary, source }) => ({
        id: podcastId(source),
        type: 'podcast',
        title: summary.title,
        url: source.url
      }))
    ]
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

function compact(text = '', maxLen = 220) {
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
    'agent', 'codex', 'cursor', 'dreambeans', 'ai', 'tokens', 'jobs',
    'engineer', 'openclaw', 'model', 'eval', 'hiring', 'productivity',
    'TAM', 'software projects', 'downloads/week'
  ]) ? 1400 : 0;
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

function topTweets(feedX, limit = 6) {
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

function topBlogs(feedBlogs, limit = 2) {
  return (feedBlogs?.blogs || [])
    .slice()
    .sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0))
    .slice(0, limit);
}

function topPodcasts(feedPodcasts, limit = 2) {
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

function summarizeTweet(tweet) {
  const text = tweet.text || '';

  if (tweet.handle === 'thsottiaux' && hasAny(text, ['codex reliability', 'usage limits'])) {
    return {
      title: 'Codex 可靠性事故后，OpenAI 重置了付费用户的 Codex 使用额度',
      why: '这说明 coding agent 已经进入高频生产工具阶段，可靠性和额度体验会直接影响用户信任。对我们来说，关注点不是“有没有事故”，而是事故后的恢复、补偿和产品节奏。',
      ask: '可以追问：Codex 这类 coding agent 的可靠性指标应该怎么看？'
    };
  }

  if (tweet.handle === 'GoogleLabs' || hasAny(text, ['Dreambeans'])) {
    return {
      title: 'Google Labs 推出 Dreambeans，用个人数据做“希望刷屏”式每日故事流',
      why: '这是 Google 把 Personal Intelligence 落到消费端体验的一次实验：不是让用户继续无目的刷信息流，而是把 Gmail、日历等上下文变成个性化故事和主题。值得观察它会不会成为 AI 原生信息消费的新形态。',
      ask: '可以追问：Dreambeans 和传统推荐流、AI 日报有什么区别？'
    };
  }

  if (tweet.handle === 'ryolu_' || hasAny(text, ['Cursor is hiring'])) {
    return {
      title: 'Cursor 在招 design engineer，重点是“品味、系统思维、帮人和 agent ship 高质量代码”',
      why: 'AI coding 工具的竞争正在从“模型能不能写代码”转向“体验能不能把人、设计师、工程师、agent 协同起来”。设计工程师会变成这类产品的关键角色。',
      ask: '可以追问：为什么 AI 工具公司这么看重 design engineer？'
    };
  }

  if (tweet.handle === 'levie' && hasAny(text, ['jobs', 'AI is going to have the opposite effect'])) {
    return {
      title: 'Aaron Levie 反驳“AI 会减少岗位”：AI 可能让公司开出更多项目，反而需要更多工程、销售和营销角色',
      why: '他的观点是 AI 降低了启动项目和处理线索的成本，需求会被放大；真正稀缺的是能理解、维护、加固系统的人。这是一个偏乐观但很值得辩论的就业叙事。',
      ask: '可以追问：AI 到底会替代岗位，还是扩大岗位需求？'
    };
  }

  if (tweet.handle === 'levie' && hasAny(text, ['tokens', 'TAM'])) {
    return {
      title: '企业愿意为 AI token 花远超传统 SaaS seat 的钱，说明“智能”的市场可能比软件许可大很多',
      why: '传统软件按人头每月几十美元，AI token 可能是每人每月数百到数千美元。Levie 的判断是：enterprise intelligence 的 TAM 会扩张传统软件市场。',
      ask: '可以追问：token spend 会怎样改变 SaaS 商业模式？'
    };
  }

  if (tweet.handle === 'steipete' || hasAny(text, ['openclaw', 'downloads/week'])) {
    return {
      title: 'OpenClaw 本周 npm 下载量创新高，叠加 Docker/GitHub/内部分发可能达到千万级周下载',
      why: '这类数据代表开源 agent 工具链正在快速扩散。虽然下载量不等于活跃使用，但它说明开发者对本地/开源 agent 工作流的兴趣很强。',
      ask: '可以追问：OpenClaw 和 Claude Code/Codex 的定位有什么不同？'
    };
  }

  return {
    title: `${tweet.builderName} 的一条高互动动态`,
    why: compact(text, 180),
    ask: '可以追问：这条动态背后的背景是什么？',
    generic: true
  };
}

function summarizeBlog(blog) {
  if (hasAny(blog.title, ['contain Claude'])) {
    return {
      title: 'Anthropic 复盘 Claude 在不同产品里的 containment：核心不是让模型“乖”，而是限制它能碰到什么',
      why: '文章把 agent 风险拆成用户误用、模型误行为、外部攻击三类。Anthropic 认为 human-in-the-loop 会疲劳，Claude Code 里用户大约会批准 93% 的权限请求，所以真正关键的是 sandbox、VM、文件权限、egress allowlist 等环境级边界。',
      detail: '最有价值的教训是：allowlist 不是简单的“允许访问某个域名”，而是给了这个域名背后所有功能一张通行证。它们曾允许 api.anthropic.com，结果攻击者可借 Anthropic Files API 外传数据，最后要用 VM 内代理拦截非本会话 token。',
      ask: '可以追问：agent containment 应该怎么设计？Claude Code auto mode 到底解决什么问题？'
    };
  }

  return {
    title: `${blog.name}: ${blog.title}`,
    why: compact(blog.description || blog.content, 260),
    detail: '',
    ask: '可以追问：这篇文章的重点是什么？'
  };
}

function summarizePodcast(podcast) {
  if (hasAny(podcast.title, ['AI Research Legend']) || hasAny(podcast.transcript, ['Lucas Kaiser'])) {
    return {
      title: 'Lucas Kaiser 谈 AI 前沿：reasoning 很强，但可能还不够解决真正的 generalization',
      why: 'Kaiser 的判断很克制：Transformer 加 reasoning、tools、agents 已经强到不可思议，Codex 这类工具每天都能帮人处理真实工作；但它们学习概念仍像“穷尽其他选项后才学会”，不像人类能从少量数据里抓住抽象概念。',
      detail: '这期值得看三点：1. post-transformer 不是玄学，一些 lab 正在认真探索更强的泛化方式；2. Anthropic 早期专注 coding 可能是明智取舍，因为它无法正面和 ChatGPT 路线竞争；3. 未来几年 open/closed source、模型公司和应用公司的边界仍会继续变化。',
      ask: '可以追问：generalization 为什么是当前 AI 的核心问题？'
    };
  }

  if (hasAny(podcast.title, ['Satya Nadella', 'Full-Stack Builder'])) {
    return {
      title: 'Satya Nadella 谈 full-stack builder：AI 平台的重点不是单个模型，而是让每家公司训练自己的“前沿智能”',
      why: '他把 Microsoft 的 AI 战略描述成 ecosystem play：企业不只是调用通用模型，而是用自己的私有 eval、工具、上下文和 harness，让小模型或专用系统在真实任务上 hill climb。',
      detail: '几个值得记住的点：企业最有价值的新 IP 可能是 private eval；coding agent 带来 100 个并行 agent session 后，IDE/UI 也要重做；AI 的价值不只在写代码，还在压缩 glue work，让长时间运行的 agent 替人推进流程。',
      ask: '可以追问：什么是 harness？为什么 private eval 会变成企业 AI 的护城河？'
    };
  }

  return {
    title: `${podcast.name}: ${podcast.title}`,
    why: compact(podcast.transcript, 260),
    detail: '',
    ask: '可以追问：这期播客讲了什么？'
  };
}

function buildDigestData({ config, feedX, feedPodcasts, feedBlogs, state }) {
  const candidateTweets = topTweets(feedX, 50);
  const blogItems = [];
  const podcastItems = [];

  for (const blog of topBlogs(feedBlogs, 10)) {
    const summary = summarizeBlog(blog);
    if (isSent(state, blogId(blog)) || isSent(state, topicId(summary.title))) continue;
    blogItems.push({ summary, source: blog });
    if (blogItems.length >= 1) break;
  }

  for (const podcast of topPodcasts(feedPodcasts, 10)) {
    const summary = summarizePodcast(podcast);
    if (isSent(state, podcastId(podcast)) || isSent(state, topicId(summary.title))) continue;
    podcastItems.push({ summary, source: podcast });
    if (podcastItems.length >= 1) break;
  }

  const tweetItems = [];
  const seenTweetTitles = new Set();
  for (const tweet of candidateTweets) {
    const summary = summarizeTweet(tweet);
    if (summary.generic) continue;
    if (isSent(state, tweetId(tweet)) || isSent(state, topicId(summary.title))) continue;
    if (seenTweetTitles.has(summary.title)) continue;
    seenTweetTitles.add(summary.title);
    tweetItems.push({ tweet, summary });
    if (tweetItems.length >= 5) break;
  }
  const tweetSummaries = tweetItems.map(item => item.summary);
  const contentItemCount = tweetItems.length + blogItems.length + podcastItems.length;
  const highlights = contentItemCount >= 3 ? [
    blogItems[0]?.summary,
    podcastItems[0]?.summary,
    tweetSummaries.find(item => item.title.includes('Dreambeans')) || tweetSummaries[0]
  ].filter(Boolean) : [];

  return {
    title: `AI Builders 早餐速读 | ${formatDate(config)}`,
    theme: 'AI agent 正在从 demo 走向生产，竞争焦点从“模型能力”转向安全边界、enterprise context、product experience 和真实商业价值。',
    highlights,
    tweetItems,
    blogItems,
    podcastItems
  };
}

function hasDigestContent(data) {
  return data.tweetItems.length > 0 || data.blogItems.length > 0 || data.podcastItems.length > 0;
}

function builderTakeaway(data) {
  if (data.tweetItems.length === 1) {
    return `今天只有 1 条未推过的 Builder 新观点，重点是：${data.tweetItems[0].summary.title}`;
  }
  return '今天值得留意的是未推过的新产品、工具链、商业模式或岗位需求变化。';
}

function podcastTakeaway(data) {
  if (data.podcastItems.length === 1) {
    return `今天只有 1 条未推过的播客精华，重点是：${data.podcastItems[0].summary.title}`;
  }
  return '今天的播客内容主要关注 AI 前沿判断、模型能力边界和产业走向。';
}

function formatDigestData(data) {
  if (!hasDigestContent(data)) return '';

  const lines = [
    data.title,
    '',
    `今天主线：${data.theme}`,
    ''
  ];

  if (data.highlights.length) {
    lines.push('【今日最值得看】');
    lines.push('本区要点：先看三条主线，分别对应 AI agent 安全、private intelligence、个人信息流产品化。');
    data.highlights.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.title}`);
      lines.push(`   重点：${item.why}`);
    });
    lines.push('');
  }

  if (data.tweetItems.length) {
    lines.push('【Builder 动态】');
    lines.push(`本区要点：${builderTakeaway(data)}`);
    for (const { tweet, summary: item } of data.tweetItems) {
      lines.push(`- ${item.title}`);
      lines.push(`  重点：${item.why}`);
      lines.push(`  ${tweet.url}`);
    }
    lines.push('');
  }

  if (data.blogItems.length) {
    lines.push('【深度文章】');
    lines.push('本区要点：Anthropic 的核心判断是，agent 安全不能只靠人类审批，必须在环境层限制 agent 能访问什么、能把数据发到哪里。');
    for (const { summary: item, source: blog } of data.blogItems) {
      lines.push(`- ${item.title}`);
      lines.push(`  重点：${item.why}`);
      if (item.detail) lines.push(`  细节：${item.detail}`);
      lines.push(`  ${blog.url}`);
    }
    lines.push('');
  }

  if (data.podcastItems.length) {
    lines.push('【播客精华】');
    lines.push(`本区要点：${podcastTakeaway(data)}`);
    for (const { summary: item, source: podcast } of data.podcastItems) {
      lines.push(`- ${item.title}`);
      lines.push(`  重点：${item.why}`);
      if (item.detail) lines.push(`  细节：${item.detail}`);
      lines.push(`  ${podcast.url}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

function node(tag, text, extra = {}) {
  return { tag, text, ...extra };
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

function sectionHeading(title, takeaway) {
  return [
    dividerLine(),
    paragraph(textNode(title, ['bold'])),
    paragraph(textNode('本区要点：', ['bold']), textNode(takeaway)),
    blankLine()
  ];
}

function formatPostDigestData(data) {
  if (!hasDigestContent(data)) return '';

  const content = [
    paragraph(textNode('今日主线', ['bold'])),
    paragraph(textNode(data.theme)),
    blankLine()
  ];

  if (data.highlights.length) {
    content.push(
      ...sectionHeading('今日最值得看', '三条主线：AI agent 安全、private intelligence、个人信息流产品化。')
    );
    data.highlights.forEach((item, index) => {
      content.push(
        paragraph(textNode(`${index + 1}. ${item.title}`, ['bold'])),
        paragraph(textNode('重点：', ['bold']), textNode(item.why)),
        blankLine()
      );
    });
  }

  if (data.tweetItems.length) {
    content.push(
      ...sectionHeading('Builder 动态', builderTakeaway(data))
    );
    for (const { tweet, summary } of data.tweetItems) {
      content.push(
        paragraph(textNode('• ', ['bold']), linkNode(summary.title, tweet.url)),
        paragraph(textNode('重点：', ['bold']), textNode(summary.why)),
        blankLine()
      );
    }
  }

  if (data.blogItems.length) {
    content.push(
      ...sectionHeading('深度文章', 'Anthropic 的核心判断是，agent 安全不能只靠人类审批，必须在环境层限制 agent 能访问什么、能把数据发到哪里。')
    );
    for (const { summary, source } of data.blogItems) {
      content.push(
        paragraph(textNode('• ', ['bold']), linkNode(summary.title, source.url)),
        paragraph(textNode('重点：', ['bold']), textNode(summary.why)),
        summary.detail ? paragraph(textNode('细节：', ['bold']), textNode(summary.detail)) : null,
        blankLine()
      );
    }
  }

  if (data.podcastItems.length) {
    content.push(
      ...sectionHeading('播客精华', podcastTakeaway(data))
    );
    for (const { summary, source } of data.podcastItems) {
      content.push(
        paragraph(textNode('• ', ['bold']), linkNode(summary.title, source.url)),
        paragraph(textNode('重点：', ['bold']), textNode(summary.why)),
        summary.detail ? paragraph(textNode('细节：', ['bold']), textNode(summary.detail)) : null,
        blankLine()
      );
    }
  }

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

  const digestData = buildDigestData({ config, feedX, feedPodcasts, feedBlogs, state });
  if (recordFile) {
    await writeFile(recordFile, `${JSON.stringify(makeRecord(digestData), null, 2)}\n`);
  }

  if (outputFormat === 'post') {
    const output = formatPostDigestData(digestData);
    if (output) console.log(output);
  } else {
    const output = formatDigestData(digestData);
    if (output) console.log(output);
  }
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
