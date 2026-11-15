#!/usr/bin/env node
/**
 * GitHub Profile 素材自动刷新（零依赖，Node >= 18）
 *
 * 思路：下载发生在 GitHub Actions 的境外 runner 上，仓库里只存静态图片。
 *       README 引用仓库内相对路径 -> 国内访问 GitHub 自家域名即可显示，且数据能持续更新。
 *
 * 安全约定：
 *   - GITHUB_TOKEN 只发给 api.github.com，绝不发给任何第三方服务。
 *   - 下载失败 / 内容非法时保留上一次成功的图片，绝不写入空文件。
 *   - 只有内容真的变化才落盘，便于 Actions 判断是否需要提交。
 *
 * 本地运行： node scripts/refresh-assets.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const USER = 'xkx121029';
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ASSETS_DIR = path.join(REPO_ROOT, 'assets');
const README_PATH = path.join(REPO_ROOT, 'README.md');
const TOKEN = process.env.GITHUB_TOKEN || '';

// 版本号同时用于 README 的 ?v= 缓存破坏，和 OG 图的缓存 key
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
const ICONS = 'py,kotlin,js,ts,html,go,rust,cpp,cs,dart,vue,threejs,tauri,docker';
const OG_REPOS = ['Phtomt', 'happy-search', 'happy-relay', 'AioShell', 'HappyLook'];

// README 中这些图片会被加上 ?v=STAMP，避免 GitHub 图片代理缓存旧内容
const DYNAMIC_FILES = [
  'avatar.jpg', 'streak.svg', 'visitors.svg',
  'badge-repos.svg', 'badge-forks.svg', 'badge-stars.svg',
  ...OG_REPOS.map((r) => `og-${r}.png`),
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function download(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'profile-assets-refresh/1.0' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function isValid(name, buf) {
  if (!buf || buf.length < 100) return false;
  if (name.endsWith('.svg')) return buf.toString('utf8', 0, Math.min(buf.length, 4096)).includes('<svg');
  const hex = buf.subarray(0, 4).toString('hex');
  return name.endsWith('.png') ? hex.startsWith('89504e47') : hex.startsWith('ffd8');
}

async function ghApi(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'profile-assets-refresh/1.0',
      'Accept': 'application/vnd.github+json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  return res.json();
}

const badgeUrl = (label, color) =>
  `https://img.shields.io/badge/${encodeURIComponent(label)}-${color}`;

// ---- 1. 真实数据（公开 API 匿名即可，有 token 时限额更高） ----
let numbers = null;
try {
  const repos = await ghApi(`https://api.github.com/users/${USER}/repos?per_page=100&type=owner`);
  if (!Array.isArray(repos)) throw new Error('返回不是数组');
  const projects = repos.filter((r) => !r.fork && r.name.toLowerCase() !== USER.toLowerCase());
  numbers = {
    repos: projects.length,
    forks: repos.filter((r) => r.fork).length,
    stars: projects.reduce((sum, r) => sum + (r.stargazers_count || 0), 0),
  };
  console.log(`GitHub 实时数据：${numbers.repos} 个项目 / ${numbers.forks} 个 fork / ${numbers.stars} 个 star`);
} catch (err) {
  console.warn(`GitHub API 失败（数字徽章本次跳过，保留旧图）：${err.message}`);
}

mkdirSync(ASSETS_DIR, { recursive: true });

// ---- 2. 动态素材任务 ----
const tasks = [
  {
    name: 'streak.svg',
    url: `https://streak-stats.demolab.com/?user=${USER}&t=${STAMP}`,
    fallback: `https://streak-stats.demolab.com/?user=${USER}`,
  },
  {
    name: 'visitors.svg',
    url: `https://komarev.com/ghpvc/?username=${USER}&color=blueviolet&style=flat-square&t=${STAMP}`,
    fallback: `https://komarev.com/ghpvc/?username=${USER}&color=blueviolet&style=flat-square`,
  },
  { name: 'avatar.jpg', url: `https://github.com/${USER}.png?size=240` },
  ...(numbers ? [
    // shields 偶发超时，fallback 用同一地址重试一次
    { name: 'badge-repos.svg', url: badgeUrl(`${numbers.repos} repos`, '58a6ff'), fallback: badgeUrl(`${numbers.repos} repos`, '58a6ff') },
    { name: 'badge-forks.svg', url: badgeUrl(`${numbers.forks} forks`, 'a371f7'), fallback: badgeUrl(`${numbers.forks} forks`, 'a371f7') },
    { name: 'badge-stars.svg', url: badgeUrl(`${numbers.stars} stars`, 'f778ba'), fallback: badgeUrl(`${numbers.stars} stars`, 'f778ba') },
  ] : []),
  // OG 图带时间戳做缓存 key，每次都能拿到最新 star / 描述
  ...OG_REPOS.map((r) => ({
    name: `og-${r}.png`,
    url: `https://opengraph.githubassets.com/r${STAMP}/${USER}/${r}`,
    fallback: `https://opengraph.githubassets.com/k${STAMP}z/${USER}/${r}`,
  })),
];

const changed = [];
async function refresh(task) {
  const candidates = [task.url, task.fallback].filter(Boolean);
  let buf = null;
  for (const url of candidates) {
    try {
      const b = await download(url);
      if (isValid(task.name, b)) { buf = b; break; }
      console.warn(`  ! ${task.name} 内容不是图片，换下一个地址`);
    } catch (err) {
      console.warn(`  ! ${task.name} 下载失败（${err.message}），尝试备用地址`);
    }
  }
  if (!buf) {
    console.warn(`  - 跳过 ${task.name}，保留上一次成功的图片`);
    return;
  }
  const target = path.join(ASSETS_DIR, task.name);
  const old = existsSync(target) ? readFileSync(target) : null;
  if (old && sha(old) === sha(buf)) return;
  writeFileSync(target, buf);
  changed.push(task.name);
  console.log(`  ✓ ${old ? '更新' : '新增'} ${task.name} (${buf.length} B)`);
}

console.log('刷新动态素材：');
for (const task of tasks) await refresh(task);

// ---- 3. 静态素材补齐（只在文件缺失时下载，日常不重复请求） ----
const STATIC_BADGES = [
  ['badge-python.svg', 'Python-3572A5'], ['badge-kotlin.svg', 'Kotlin-A97BFF'],
  ['badge-android.svg', 'Android-3DDC84'], ['badge-ai-agent.svg', 'AI%20Agent-8A2BE2'],
  ['badge-rust.svg', 'Rust-DEA584'], ['badge-go.svg', 'Go-00ADD8'],
  ['badge-cpp.svg', 'C++-F34B7D'], ['badge-vue.svg', 'Vue-41B883'],
  ['badge-wip.svg', 'WIP-d29922'], ['badge-coming-soon.svg', 'Coming%20Soon-3fb950'],
  ['badge-starstruck.svg', 'Starstruck%20x2-f778ba'], ['badge-dalian.svg', 'Dalian-39c5cf'],
  ['badge-self-hosted.svg', 'self-hosted-238636'], ['badge-mcp.svg', 'MCP%20ACP-6f42c1'],
  ['badge-docker.svg', 'Docker-2496ED'], ['badge-tauri.svg', 'Tauri2-FFC131'],
];
const STATIC_FILES = [
  ['skillicons-dark.svg', `https://skillicons.dev/icons?i=${ICONS}&theme=dark`],
  ['skillicons-light.svg', `https://skillicons.dev/icons?i=${ICONS}&theme=light`],
  ['typing.svg', 'https://readme-typing-svg.demolab.com/?lines=happy~happy~happy~&center=true&size=24'],
  ...STATIC_BADGES.map(([f, label]) => [f, `https://img.shields.io/badge/${label}`]),
];
let added = 0;
for (const [name, url] of STATIC_FILES) {
  const target = path.join(ASSETS_DIR, name);
  if (existsSync(target)) continue;
  try {
    const buf = await download(url);
    if (!isValid(name, buf)) throw new Error('内容不是图片');
    writeFileSync(target, buf);
    changed.push(name);
    added++;
    console.log(`  ✓ 补齐静态素材 ${name}`);
  } catch (err) {
    console.warn(`  ! 静态素材 ${name} 补齐失败：${err.message}`);
  }
}
if (!added) console.log('静态素材齐全，无需补齐');

// ---- 4. 有变化才更新 README 的缓存版本号（破 GitHub 图片代理缓存） ----
if (changed.length) {
  let md = readFileSync(README_PATH, 'utf8');
  for (const file of DYNAMIC_FILES) {
    const escaped = file.replace(/\./g, '\\.');
    const re = new RegExp(`(\\.\\/assets\\/${escaped})(\\?v=[A-Za-z0-9]+)?`, 'g');
    md = md.replace(re, `$1?v=${STAMP}`);
  }
  writeFileSync(README_PATH, md);
  console.log(`README 缓存版本号 → ?v=${STAMP}`);
}

console.log(`\n完成：${tasks.length} 个动态任务、${STATIC_FILES.length} 个静态素材，${changed.length} 个文件有变化。`);
