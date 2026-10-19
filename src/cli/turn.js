'use strict';

/**
 * Klaud CLI — running one turn.
 *
 * The web server does this over SSE with an approval bridge; here the same
 * work happens in-process: load settings, expand a slash command, call
 * runAgentTurn, persist the messages it returns. Nothing about the agent loop
 * is re-implemented — the CLI is a different front end on the same engine.
 */

const store = require('../store');
const llm = require('../llm');
const agent = require('../agent');
const extensions = require('../extensions');
const path = require('path');
const { sym, choose, panel } = require('./ui');
const { diffStats } = require('./render');

/** Local endpoints (Ollama, LM Studio, OmniRoute) do not need a key. */
function isLoopback(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * Settings for this invocation: stored config plus whatever the flags
 * override. Flags never write to disk — a one-off `--model` must not change
 * the model for the next session.
 */
async function loadSettings(flags = {}) {
  const stored = await store.loadSettings();
  const settings = { ...stored };

  if (flags['--model']) settings.model = flags['--model'];
  if (flags['--workspace']) settings.workspace = path.resolve(flags['--workspace']);
  if (flags['--permission-mode']) {
    const mode = String(flags['--permission-mode']).toLowerCase();
    if (!['auto', 'ask', 'readonly'].includes(mode)) {
      throw Object.assign(
        new Error(`--permission-mode must be auto, ask or readonly (got ${mode})`),
        { code: 'EUSAGE' }
      );
    }
    settings.approvalMode = mode;
  }
  if (flags['--yes']) settings.approvalMode = 'auto';
  if (flags['--effort']) {
    const value = String(flags['--effort']).toLowerCase();
    if (!['default', 'low', 'medium', 'high'].includes(value)) {
      throw Object.assign(
        new Error(`--effort must be default, low, medium or high (got ${value})`),
        { code: 'EUSAGE' }
      );
    }
    settings.reasoningEffort = value === 'default' ? '' : value;
  }

  llm.configureReasoningEffort(settings.reasoningEffort);
  return settings;
}

/** Which conversation this prompt belongs to. */
async function loadChat(flags = {}) {
  if (flags['--resume']) {
    const chat = await store.readChat(flags['--resume']);
    if (!chat) {
      throw Object.assign(new Error(`No session with id ${flags['--resume']}`), { code: 'ENOTFOUND' });
    }
    return chat;
  }
  if (flags['--continue']) {
    const chats = await store.listChats();
    if (chats.length) {
      const chat = await store.readChat(chats[0].id);
      if (chat) return chat;
    }
  }
  return store.createChat({ model: '', workspace: '' });
}

function promptFor(prompt) {
  return String(prompt || '').trim();
}

/**
 * Approvals, terminal edition.
 *
 * The call is boxed so it is impossible to miss what is about to happen — a
 * panel you have to answer, not a line that scrolls past between two others.
 * Single keypress, no Enter: y allow once · n deny · a allow for the rest of
 * this session · r switch the session to read-only. "a" and "r" mutate
 * `session.approvalMode`, which is exactly what the in-app buttons do — the
 * difference is only where the answer is typed.
 */
function makeApproval({ c, interactive, session }) {
  return async ({ name, args, permission, reason }) => {
    if (!interactive) return false;

    const detail = describeCall(name, args);
    const rows = [];
    if (detail) rows.push(clip(detail, 70));
    else rows.push(c.dim('(no arguments)'));
    if (reason) rows.push(c.dim(clip(reason, 70)));
    rows.push(c.dim(`permission ${permission}`));

    process.stderr.write(`\n${panel(`Allow ${name}?`, rows, c, { max: 72 })}\n`);
    process.stderr.write(
      `${c.dim('  y')} allow once ${c.dim(sym.dot)} ${c.dim('n')} deny ${c.dim(sym.dot)} ` +
        `${c.dim('a')} always ${c.dim(sym.dot)} ${c.dim('r')} read-only\n`
    );

    const answer = await choose(
      '  ›',
      [
        { key: 'y', value: 'yes', default: true },
        { key: 'n', value: 'no' },
        { key: 'a', value: 'always' },
        { key: 'r', value: 'readonly' },
      ],
      { c, output: process.stderr }
    );

    if (answer === 'always') {
      session.approvalMode = 'auto';
      process.stderr.write(`${c.dim('  auto-approving the rest of this session')}\n`);
      return true;
    }
    if (answer === 'readonly') {
      session.approvalMode = 'readonly';
      process.stderr.write(`${c.yellow('  switched this session to read-only')}\n`);
      return false;
    }
    return answer === 'yes';
  };
}

/** One line of what the call will actually touch — the part a human judges. */
function describeCall(name, args) {
  if (!args || typeof args !== 'object') return '';
  const value = (key) => (typeof args[key] === 'string' ? args[key] : '');
  if (name === 'run_command') return value('command') || value('description');
  if (name === 'edit_file') {
    const stats = diffStats('edit_file', args);
    const suffix = stats ? `  (+${stats.added} −${stats.removed})` : '';
    return `${value('path')}${suffix}`;
  }
  return (
    value('path') ||
    value('url') ||
    value('pattern') ||
    value('query') ||
    value('description') ||
    ''
  );
}

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Run one prompt against a chat. Returns the agent result plus the chat as it
 * now stands (already persisted when `persist` is true, the default).
 */
async function runPrompt({
  settings,
  chat,
  prompt,
  flags = {},
  renderer,
  controller,
  interactive = false,
  session = {},
  persist = true,
}) {
  const text = promptFor(prompt);
  if (!text) throw Object.assign(new Error('Empty prompt'), { code: 'EUSAGE' });

  if (!settings.apiKey && !isLoopback(settings.baseUrl)) {
    throw Object.assign(
      new Error(
        'No API key configured.\n' +
          '  Run `klaud init` to pick a free provider, or set one yourself:\n' +
          '  klaud config baseUrl <url>   klaud config apiKey <key>'
      ),
      { code: 'ENOKEY' }
    );
  }

  let messages = [...(chat.messages || []), { role: 'user', content: text }];

  /* A /skill prompt is expanded before it reaches the model, exactly as the
     web server does it, so typing /code-review applies the skill rather than
     asking the model to guess. */
  const expanded = extensions.expandSlashCommand(text, settings.workspace);
  if (expanded && expanded.error) {
    renderer.note(renderer.c.yellow(`${sym.warn} ${expanded.error}`));
  } else if (expanded) {
    renderer.note(renderer.c.dim(`${sym.bullet} skill: ${expanded.name}`));
    messages = messages.map((m, i) => (i === messages.length - 1 ? { ...m, content: expanded.content } : m));
  }

  const approvalMode = session.approvalMode || settings.approvalMode;
  const requestApproval = makeApproval({ c: renderer.c, interactive, session });

  // The "thinking" beat belongs to the turn, not to whichever front end ran it.
  renderer.begin();

  const result = await agent.runAgentTurn({
    settings,
    messages,
    cwd: settings.workspace,
    approvalMode,
    maxSteps: settings.maxSteps,
    signal: controller ? controller.signal : undefined,
    onEvent: (event) => renderer.handle(event),
    requestApproval,
  });

  const nextMessages = [...messages, ...(result.messages || [])];
  let saved = chat;
  if (persist) {
    const title =
      chat.title && chat.title !== 'New chat' && chat.title !== 'Untitled'
        ? chat.title
        : store.deriveTitle(nextMessages);
    saved = await store.saveChat({
      ...chat,
      title,
      messages: nextMessages,
      model: settings.model,
      workspace: settings.workspace,
    });
  }

  renderer.closeText();
  return { result, chat: saved, messages: nextMessages };
}

/** Friendly text for an engine error, without a stack unless asked. */
function describeError(err, c) {
  const code = err && err.code;
  if (code === 'EUSAGE') return `${c.red('error')} ${err.message}\nRun ${c.bold('klaud --help')}.`;
  if (code === 'ENOKEY') return `${c.red('error')} ${err.message}`;
  if (code === 'ENOTFOUND') return `${c.red('error')} ${err.message}`;
  if (err && err.name === 'LLMError') {
    const parts = [`${c.red('error')} ${err.message}`];
    if (err.status) parts.push(c.dim(`  HTTP ${err.status} from ${err.url || 'the endpoint'}`));
    if (err.body) parts.push(c.dim(`  ${String(err.body).slice(0, 300)}`));
    return parts.join('\n');
  }
  return `${c.red('error')} ${err && err.message ? err.message : String(err)}`;
}

module.exports = {
  loadSettings,
  loadChat,
  runPrompt,
  isLoopback,
  makeApproval,
  describeCall,
  describeError,
  promptFor,
};