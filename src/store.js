'use strict';

/**
 * File-backed persistence. Chats are one JSON file each; settings live next to
 * them. No database, no ORM, no dependency — the whole store is a few small
 * atomic writes.
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { dataDir, ensureDir, DEFAULTS, defaultWorkspace } = require('./config');

function dirs() {
  const base = ensureDir(dataDir());
  return {
    base,
    chats: ensureDir(path.join(base, 'chats')),
    settings: path.join(base, 'settings.json'),
    session: path.join(base, 'session.json'),
  };
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/* ----------------------------- settings ----------------------------- */

const SETTING_KEYS = [
  'baseUrl', 'apiKey', 'model', 'temperature', 'systemPrompt', 'approvalMode',
  'workspace', 'maxSteps', 'maxContextChars', 'reasoningEffort', 'mode',
  'enabledPlugins',
];

/**
 * Which plugins are switched on, as `{ pluginName: true|false }`.
 *
 * A map rather than a list so "off" is expressible for a plugin that ships with
 * `defaultEnabled: true` — with a list, turning one off would be impossible. An
 * absent key means "use the plugin's own default", which is why this must stay
 * unset rather than defaulting to `{}` and implying every plugin is off.
 */
function normalizeEnabledPlugins(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [name, on] of Object.entries(value)) {
    const key = String(name || '').trim();
    if (!key) continue;
    if (on === true || on === 'true') out[key] = true;
    else if (on === false || on === 'false') out[key] = false;
  }
  return out;
}

/**
 * Chat is a conversation; Cowork is the same agent aimed at longer work. The
 * mode only changes how a turn is framed and presented — it is not a permission
 * setting, so an unknown value falls back to chat rather than to something with
 * more autonomy.
 */
const MODES = ['chat', 'cowork'];

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return MODES.includes(mode) ? mode : 'chat';
}

/**
 * The reasoning levels the UI offers. Empty is the unset state and must stay
 * unset: several endpoints reject the field outright, so an unknown or missing
 * value has to reach the wire as "no field at all" rather than as a guess.
 */
const REASONING_EFFORTS = ['', 'low', 'medium', 'high'];

async function loadSettings() {
  const { settings } = dirs();
  const stored = (await readJson(settings, {})) || {};
  const merged = {
    ...DEFAULTS,
    approvalMode: 'auto',
    workspace: defaultWorkspace(),
    maxSteps: 12,
    ...stored,
  };
  merged.baseUrl = normalizeBaseUrl(merged.baseUrl);
  merged.temperature = clamp(Number(merged.temperature), 0, 2, DEFAULTS.temperature);
  merged.maxSteps = clamp(Number(merged.maxSteps), 1, 40, 12);
  merged.maxContextChars = clamp(Number(merged.maxContextChars), 8_000, 2_000_000, DEFAULTS.maxContextChars);
  merged.reasoningEffort = normalizeReasoningEffort(merged.reasoningEffort);
  merged.mode = normalizeMode(merged.mode);
  merged.enabledPlugins = normalizeEnabledPlugins(merged.enabledPlugins);
  if (!['auto', 'ask', 'readonly'].includes(merged.approvalMode)) merged.approvalMode = 'auto';
  return merged;
}

async function saveSettings(patch) {
  const { settings } = dirs();
  const current = await loadSettings();
  const next = { ...current };
  for (const key of SETTING_KEYS) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && patch[key] !== undefined) {
      next[key] = patch[key];
    }
  }
  next.baseUrl = normalizeBaseUrl(next.baseUrl);
  next.temperature = clamp(Number(next.temperature), 0, 2, DEFAULTS.temperature);
  next.maxSteps = clamp(Number(next.maxSteps), 1, 40, 12);
  next.maxContextChars = clamp(Number(next.maxContextChars), 8_000, 2_000_000, DEFAULTS.maxContextChars);
  next.reasoningEffort = normalizeReasoningEffort(next.reasoningEffort);
  next.mode = normalizeMode(next.mode);
  next.enabledPlugins = normalizeEnabledPlugins(next.enabledPlugins);
  if (!['auto', 'ask', 'readonly'].includes(next.approvalMode)) next.approvalMode = 'auto';
  await writeJsonAtomic(settings, next);
  return next;
}

function normalizeBaseUrl(url) {
  let u = String(url || '').trim() || DEFAULTS.baseUrl;
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u.replace(/\/+$/, '');
}

function clamp(n, min, max, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Reduce whatever arrived to a level Klaud will put on the wire.
 *
 * Junk becomes '' — the unset state — rather than a nearest match. Clamping
 * "banana" to "low" would silently start sending a parameter the user did not
 * ask for, and some providers answer an unsupported one with a 400.
 */
function normalizeReasoningEffort(value) {
  const effort = String(value ?? '').trim().toLowerCase();
  return REASONING_EFFORTS.includes(effort) ? effort : '';
}

/** Never ship the raw key to the browser. */
function publicSettings(settings) {
  const { apiKey, ...rest } = settings;
  return {
    ...rest,
    hasApiKey: Boolean(apiKey),
    apiKeyHint: apiKey ? maskKey(apiKey) : '',
  };
}

function maskKey(key) {
  const k = String(key);
  if (k.length <= 10) return `${k.slice(0, 3)}${'•'.repeat(Math.max(0, k.length - 3))}`;
  return `${k.slice(0, 6)}${'•'.repeat(8)}${k.slice(-4)}`;
}

/* ------------------------------ chats ------------------------------ */

function safeId(id) {
  const s = String(id || '');
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(s)) throw new Error('invalid chat id');
  return s;
}

function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

async function listChats() {
  const { chats } = dirs();
  let files;
  try {
    files = await fs.readdir(chats);
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const chat = await readJson(path.join(chats, file), null);
    if (!chat || !chat.id) continue;
    const lastMessage = [...(chat.messages || [])].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
    out.push({
      id: chat.id,
      title: chat.title || 'Untitled',
      createdAt: chat.createdAt || 0,
      updatedAt: chat.updatedAt || 0,
      messageCount: (chat.messages || []).length,
      preview: (lastMessage?.content || '').slice(0, 120),
      model: chat.model || '',
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

async function readChat(id) {
  const { chats } = dirs();
  return readJson(path.join(chats, `${safeId(id)}.json`), null);
}

async function saveChat(chat) {
  const { chats } = dirs();
  const id = safeId(chat.id || newId());
  const record = {
    id,
    title: String(chat.title || 'Untitled').slice(0, 200),
    createdAt: chat.createdAt || Date.now(),
    updatedAt: Date.now(),
    model: chat.model || '',
    workspace: chat.workspace || '',
    messages: Array.isArray(chat.messages) ? chat.messages : [],
  };
  await writeJsonAtomic(path.join(chats, `${id}.json`), record);
  return record;
}

async function createChat(patch = {}) {
  return saveChat({
    id: newId(),
    title: patch.title || 'New chat',
    messages: [],
    model: patch.model || '',
    workspace: patch.workspace || '',
  });
}

async function deleteChat(id) {
  const { chats } = dirs();
  try {
    await fs.unlink(path.join(chats, `${safeId(id)}.json`));
    return true;
  } catch {
    return false;
  }
}

async function deleteAllChats() {
  const { chats } = dirs();
  const files = await fs.readdir(chats).catch(() => []);
  await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => fs.unlink(path.join(chats, f)).catch(() => {})));
  return files.length;
}

/** First user line, trimmed to something that fits a sidebar. */
function deriveTitle(messages, fallback = 'New chat') {
  const first = (messages || []).find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.trim());
  if (!first) return fallback;
  const line = first.content.trim().split('\n')[0].replace(/^#+\s*/, '');
  return (line.length > 60 ? `${line.slice(0, 57)}...` : line) || fallback;
}

/* ------------------------------ session ----------------------------- */

async function loadOrCreateSessionToken() {
  const { session } = dirs();
  const stored = await readJson(session, null);
  if (stored && typeof stored.token === 'string' && stored.token.length >= 24) return stored.token;
  const token = crypto.randomBytes(24).toString('base64url');
  await writeJsonAtomic(session, { token, createdAt: Date.now() });
  return token;
}

module.exports = {
  dirs,
  loadSettings,
  saveSettings,
  publicSettings,
  normalizeBaseUrl,
  normalizeReasoningEffort,
  REASONING_EFFORTS,
  listChats,
  readChat,
  saveChat,
  createChat,
  deleteChat,
  deleteAllChats,
  deriveTitle,
  newId,
  loadOrCreateSessionToken,
  readJson,
  writeJsonAtomic,
  maskKey,
};
