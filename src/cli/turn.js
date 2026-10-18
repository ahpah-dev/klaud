'use strict';

/**
 * Klaud CLI â€” running one turn.
 *
 * The web server does this over SSE with an approval bridge; here the same
 * work happens in-process: load settings, expand a slash command, call
 * runAgentTurn, persist the messages it returns. Nothing about the agent loop
 * is re-implemented â€” the CLI is a different front end on the same engine.
 */

const store = require('../store');
const llm = require('../llm');
const agent = require('../agent');
const extensions = require('../extensions');
const path = require('path');
const { sym, choose } = require('./ui');

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
 * override. Flags never write to disk â€” a one-off `--model` must not change
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
 * Single keypress, no Enter: y allow once Â· n deny Â· a allow for the rest of
 * this session Â· r switch the session to read-only. "a" and "r" mutate
 * `session.approvalMode`, which is exactly what the in-app buttons do â€” the
 * difference is only where the answer is typed.
 */
function makeApproval({ c, interactive, session }) {
  return async ({ name, args, permission, reason }) => {
    if (!interactive) return false;

    const summary = describeCall(name, args);
    process.stderr.write(
      `\n${c.bold('Allow this?')} ${c.dim(`permission: ${permission}`)}\n` +
        `  ${c.accent(sym.arrow)} ${c.bold(name)}${summary ? ` ${summary}` : ''}\n` +
        (reason ? `${c.dim(`  ${reason}`)}\n` : '')
    );

    const answer = await choose(
      'Approve',
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

function describeCall(name, args) {
  if (!args || typeof args !== 'object') return '';
  const value = (key) => (typeof args[key] === 'string' ? args[key] : '');
  return (
    value('command') ||
    value('path') ||
    value('url') ||
    value('pattern') ||
    value('query') ||
    value('description') ||
    ''
  );
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