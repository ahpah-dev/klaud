'use strict';

/**
 * Klaud CLI — the interactive session.
 *
 * Behaviour worth spelling out, because these are the parts people judge a
 * terminal agent on:
 *
 *   · the readline interface is paused while a turn runs, so streamed output
 *     never fights the prompt for the line;
 *   · Ctrl+C aborts the running turn, and a second Ctrl+C within a moment of
 *     the first exits — one key, two meanings, no accidental quits;
 *   · a line ending in `\` continues on the next one, so a long prompt does
 *     not have to be a paste;
 *   · Tab completes /commands and /skills, and lists them when several match;
 *   · /commands are handled here and never reach the model — a typo'd slash
 *     command says so instead of being sent as prose;
 *   · history survives restarts (~/.klaud/cli-history.json), so yesterday's
 *     prompt is one Up away;
 *   · stdout stays the assistant's answer; banners, tools and prompts are
 *     stderr, so a piped session still yields clean text.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const store = require('../store');
const llm = require('../llm');
const skillsLib = require('../lib/skills');
const { dataDir } = require('../config');
const pkg = require('../../package.json');
const turn = require('./turn');
const { createRenderer } = require('./render');
const {
  sym,
  panel,
  columns,
  shortPath,
  hostOf,
  fmtDuration,
  fmtTokens,
  fmtCount,
  spinner,
  wrap,
} = require('./ui');

const SLASH_COMMANDS = {
  help: 'Show commands and skills',
  model: 'Show or set the model — /model <id>, or /model --list',
  effort: 'Reasoning effort — /effort default | low | medium | high',
  permissions: 'auto | ask | readonly — /permissions <mode>',
  workspace: 'Show or set the working directory — /workspace <path>',
  skills: 'List the skills that load into this session',
  sessions: 'Saved sessions, with the ids /resume needs',
  resume: 'Continue a saved session — /resume <id>',
  cost: 'Tokens used so far in this session',
  clear: 'Forget this conversation and start a new one',
  config: 'Settings summary — /config [key] [value]',
  exit: 'Leave (Ctrl+D works too)',
};

const EFFORTS = ['default', 'low', 'medium', 'high'];

/* ------------------------------ history ------------------------------- */

function historyPath() {
  return path.join(dataDir(), 'cli-history.json');
}

function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry) => typeof entry === 'string' && entry.trim()).slice(0, 300);
  } catch {
    return [];
  }
}

function saveHistory(rl) {
  try {
    const entries = (rl.history || []).filter((entry) => entry && entry.trim()).slice(0, 300);
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
    fs.writeFileSync(historyPath(), JSON.stringify(entries));
  } catch {
    /* history is a convenience; a read-only home must not break the session */
  }
}

/* ------------------------------- banner -------------------------------- */

function clip(text, max = 46) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function banner(c, settings, chat) {
  const mode = settings.approvalMode || 'auto';
  const modeLine = settings.reasoningEffort
    ? `${mode} ${c.dim(sym.dot)} effort ${settings.reasoningEffort}`
    : `${mode} ${c.dim(sym.dot)} effort default`;

  const rows = [
    ['model', c.bold(clip(settings.model || '(none)'))],
    ['endpoint', c.dim(clip(hostOf(settings.baseUrl)))],
    ['folder', c.dim(clip(shortPath(settings.workspace), 46))],
    ['mode', modeLine],
  ];
  if (chat && (chat.messages || []).length) {
    rows.push(['session', c.dim(`${chat.id} ${sym.dot} ${chat.messages.length} messages`)]);
  }
  if (!settings.apiKey && !turn.isLoopback(settings.baseUrl)) {
    rows.push(['setup', c.yellow('no API key yet — run klaud init')]);
  }

  return [
    panel(`Klaud ${pkg.version}`, columns(rows, c, { left: 8 }).split('\n'), c, { max: 64 }),
    c.dim('  /help commands · Ctrl+C cancels a turn · Ctrl+D exits'),
  ].join('\n');
}

/* ----------------------------- completion ------------------------------ */

/**
 * Tab completes /commands and /skills. When several entries share the prefix
 * they are listed under the prompt and the common prefix is completed. Every
 * path here is guarded: a convenience must never be able to break input.
 */
function installKeys(rl, c, { getSkills, promptText }) {
  if (!process.stdin.isTTY) return;

  readline.emitKeypressEvents(process.stdin);

  process.stdin.on('keypress', (str, key) => {
    if (!key) return;
    try {
      if (key.ctrl && key.name === 'l') {
        process.stderr.write('\x1b[2J\x1b[H');
        rl.prompt(true);
        return;
      }
      if (key.name === 'tab') complete(rl, c, getSkills());
    } catch {
      /* never let a convenience break the line */
    }
  });
}

function complete(rl, c, skillNames) {
  const match = /^\/(\S*)$/.exec(rl.line || '');
  if (!match) return;
  const prefix = match[1];

  const pool = [
    ...Object.entries(SLASH_COMMANDS).map(([name, note]) => ({ name, note })),
    ...skillNames.map((name) => ({ name, note: 'skill' })),
  ];
  const hits = pool.filter((item) => item.name.startsWith(prefix));
  if (!hits.length) return;

  let target = hits[0].name;
  if (hits.length > 1) {
    target = hits.reduce((common, item) => {
      let i = 0;
      while (i < common.length && i < item.name.length && common[i] === item.name[i]) i += 1;
      return common.slice(0, i);
    }, hits[0].name);
  }
  if (target.length < prefix.length) return;

  const replacement = hits.length === 1 ? `/${target} ` : `/${target}`;
  if (replacement.length > (rl.line || '').length) {
    rl.line = replacement;
    rl.cursor = replacement.length;
    if (typeof rl._refreshLine === 'function') rl._refreshLine();
  }

  if (hits.length > 1) {
    process.stderr.write(
      `\n${hits
        .slice(0, 10)
        .map((hit) => `  ${c.accent(`/${hit.name}`)}  ${c.dim(hit.note || '')}`)
        .join('\n')}\n`
    );
    rl.prompt(true);
  }
}

/* -------------------------------- session ------------------------------ */

async function repl({ flags, c }) {
  const settings = await turn.loadSettings(flags);
  let chat = await turn.loadChat(flags);

  const renderer = createRenderer({
    out: process.stdout,
    err: process.stderr,
    c,
    quiet: Boolean(flags['--quiet']),
    verbose: Boolean(flags['--verbose']),
    json: false,
  });

  const session = {
    approvalMode: settings.approvalMode,
    usage: { prompt: 0, completion: 0, total: 0 },
  };

  const interactive = Boolean(process.stdin.isTTY);
  const promptText = c.accent(`${sym.prompt} `);
  const contText = c.dim(`${sym.dot} `);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // the prompt is chatter; stdout is the answer
    terminal: interactive,
    prompt: promptText,
    history: loadHistory(),
    historySize: 300,
    removeHistoryDuplicates: true,
  });

  renderer.note(banner(c, settings, chat));
  renderer.gap();

  let controller = null;
  let busy = false;
  let leaving = false;
  let closed = false;
  let pendingText = '';
  let lastInterrupt = 0;

  const say = (text) => process.stderr.write(`${text}\n`);

  /**
   * Redraw the prompt only while the interface is still open.
   *
   * A piped session can deliver several lines in one burst: /exit closes the
   * interface while the remaining queued lines are still being handled, and a
   * bare `rl.prompt()` after that throws ERR_USE_AFTER_CLOSE — which would turn
   * a clean exit into a crash.
   */
  const reprompt = (preserveCursor = false) => {
    if (closed || leaving) return;
    try {
      rl.prompt(preserveCursor);
    } catch {
      /* the interface closed between the check and the call */
    }
  };

  const skillNames = () => skillsLib.listSkills(settings.workspace).map((s) => s.name);

  const describeSkills = () => {
    const list = skillsLib.listSkills(settings.workspace);
    if (!list.length) {
      say(c.dim('  no skills found — add one at .klaud/skills/<name>/SKILL.md'));
      return;
    }
    say('');
    for (const skill of list) {
      const label = `/${skill.name}`.padEnd(16);
      const detail = wrap(String(skill.description || ''), 62, ' '.repeat(20));
      const [first, ...rest] = detail.split('\n');
      say(`  ${c.accent(label)} ${c.dim(first)}`);
      for (const line of rest) say(c.dim(line));
    }
    say('');
  };

  const slash = async (line) => {
    const [name, ...rest] = line.slice(1).split(/\s+/);
    const key = (name || '').toLowerCase();
    const arg = rest.join(' ').trim();

    if (key === 'exit' || key === 'quit') {
      leaving = true;
      rl.close();
      return true;
    }

    if (key === 'help') {
      say('');
      say(`  ${c.bold('Commands')}`);
      for (const [cmd, note] of Object.entries(SLASH_COMMANDS)) {
        say(`  ${c.accent(`/${cmd}`.padEnd(15))} ${c.dim(note)}`);
      }
      say('');
      say(`  ${c.bold('Skills')}`);
      describeSkills();
      say(c.dim('  Anything else is sent to the agent. Tab completes a command.'));
      say('');
      return true;
    }

    if (key === 'clear') {
      chat = await store.createChat({ model: settings.model, workspace: settings.workspace });
      say(c.dim('  new session'));
      return true;
    }

    if (key === 'model') {
      if (arg === '--list' || arg === 'list') {
        const spin = spinner(process.stderr, c, `asking ${hostOf(settings.baseUrl)} for its models`);
        spin.start();
        try {
          const models = await llm.listModels({ baseUrl: settings.baseUrl, apiKey: settings.apiKey });
          spin.stop();
          say('');
          for (const model of models.slice(0, 40)) say(`  ${c.accent(model.id)}`);
          if (models.length > 40) say(c.dim(`  … ${models.length - 40} more`));
          say('');
          say(c.dim('  switch with /model <id>'));
        } catch (err) {
          spin.stop();
          say(turn.describeError(err, c));
        }
        return true;
      }
      if (!arg) {
        say(`  ${c.bold(settings.model)} ${c.dim(`at ${hostOf(settings.baseUrl)}`)}`);
        say(c.dim('  /model <id> switches this session · /model --list asks the endpoint'));
        return true;
      }
      settings.model = arg;
      await store.saveSettings({ model: arg });
      say(`${c.green(sym.ok)} model = ${c.bold(arg)}`);
      return true;
    }

    if (key === 'effort') {
      if (!arg) {
        say(`  ${c.bold(settings.reasoningEffort || 'default')} ${c.dim('(default · low · medium · high)')}`);
        say(c.dim('  sent only to endpoints known to accept it'));
        return true;
      }
      const value = arg.toLowerCase();
      if (!EFFORTS.includes(value)) {
        say(c.yellow(`  expected default, low, medium or high — got ${arg}`));
        return true;
      }
      const stored = value === 'default' ? '' : value;
      settings.reasoningEffort = stored;
      await store.saveSettings({ reasoningEffort: stored });
      llm.configureReasoningEffort(stored);
      say(`${c.green(sym.ok)} effort = ${c.bold(value)}`);
      return true;
    }

    if (key === 'permissions' || key === 'approval') {
      if (!arg) {
        say(`  ${c.bold(session.approvalMode)} ${c.dim('(auto · ask · readonly)')}`);
        return true;
      }
      const mode = arg.toLowerCase();
      if (!['auto', 'ask', 'readonly'].includes(mode)) {
        say(c.yellow(`  expected auto, ask or readonly — got ${arg}`));
        return true;
      }
      session.approvalMode = mode;
      await store.saveSettings({ approvalMode: mode });
      say(`${c.green(sym.ok)} permission mode = ${c.bold(mode)}`);
      return true;
    }

    if (key === 'workspace') {
      if (!arg) {
        say(`  ${c.bold(settings.workspace)}`);
        return true;
      }
      const resolved = path.resolve(arg);
      settings.workspace = resolved;
      await store.saveSettings({ workspace: resolved });
      say(`${c.green(sym.ok)} workspace = ${c.bold(resolved)}`);
      return true;
    }

    if (key === 'skills') {
      describeSkills();
      return true;
    }

    if (key === 'sessions') {
      const list = await store.listChats();
      say('');
      if (!list.length) say(c.dim('  no saved sessions yet'));
      for (const item of list.slice(0, 12)) {
        say(`  ${c.accent(item.id)}  ${item.title} ${c.dim(`${item.messageCount} msg`)}`);
      }
      say('');
      return true;
    }

    if (key === 'resume') {
      if (!arg) {
        const list = await store.listChats();
        say('');
        if (!list.length) {
          say(c.dim('  no saved sessions yet'));
        } else {
          for (const item of list.slice(0, 12)) {
            say(`  ${c.accent(item.id)}  ${item.title} ${c.dim(`${item.messageCount} msg`)}`);
          }
          say(c.dim('  /resume <id>'));
        }
        say('');
        return true;
      }
      const target = await store.readChat(arg);
      if (!target) {
        say(c.yellow(`  no session with id ${arg}`));
        return true;
      }
      chat = target;
      say(`${c.green(sym.ok)} resumed ${c.bold(target.title)} ${c.dim(`(${target.messages.length} messages)`)}`);
      return true;
    }

    if (key === 'cost') {
      const usage = session.usage;
      if (!usage.total) {
        say(c.dim('  no tokens used yet in this session'));
        return true;
      }
      say(
        `  ${c.bold(fmtCount(usage.total))} tokens ${c.dim(
          `${sym.dot} prompt ${fmtCount(usage.prompt)} ${sym.dot} completion ${fmtCount(usage.completion)}`
        )}`
      );
      return true;
    }

    if (key === 'config') {
      const parts = arg ? arg.split(/\s+/) : [];
      const current = await store.loadSettings();
      if (parts.length === 0) {
        const view = store.publicSettings(current);
        say('');
        for (const [configKey, value] of Object.entries(view)) {
          say(`  ${c.bold(configKey.padEnd(18))} ${c.dim(typeof value === 'object' ? JSON.stringify(value) : String(value))}`);
        }
        say('');
        return true;
      }
      const [configKey, ...valueParts] = parts;
      if (valueParts.length === 0) {
        const shown = configKey === 'apiKey' && current.apiKey ? store.maskKey(current.apiKey) : current[configKey];
        say(`  ${c.bold(configKey)} = ${c.dim(String(shown === undefined ? '' : shown))}`);
        return true;
      }
      await store.saveSettings({ [configKey]: valueParts.join(' ') });
      settings[configKey] = valueParts.join(' ');
      say(`${c.green(sym.ok)} ${configKey} saved`);
      return true;
    }

    /* Not one of ours: it may still be a skill, and the turn expands it. */
    return false;
  };

  const runOne = async (text) => {
    busy = true;
    controller = new AbortController();
    const startedAt = Date.now();
    if (!closed) rl.pause();
    try {
      renderer.gap();
      const { result, chat: saved } = await turn.runPrompt({
        settings,
        chat,
        prompt: text,
        flags,
        renderer,
        controller,
        interactive,
        session,
      });
      chat = saved;

      const usage = result.usage || {};
      session.usage.prompt += usage.prompt_tokens || 0;
      session.usage.completion += usage.completion_tokens || 0;
      session.usage.total += usage.total_tokens || 0;

      const tools = (result.toolCalls || []).filter((call) => !call.denied).length;
      const elapsed = fmtDuration(Date.now() - startedAt);
      const bits = [elapsed, `${tools} tool${tools === 1 ? '' : 's'}`, `${fmtTokens(usage.total_tokens || 0)} tokens`];

      renderer.gap();
      if (result.finished === 'aborted') {
        renderer.finish(`${c.yellow(sym.warn)} ${c.dim(`cancelled ${sym.dot} ${bits.join(` ${sym.dot} `)}`)}`);
      } else if (!flags['--quiet']) {
        renderer.finish(`  ${c.green(sym.ok)} ${c.dim(bits.join(` ${sym.dot} `))}`);
      }
      renderer.gap();
    } catch (err) {
      renderer.closeText();
      say(turn.describeError(err, c));
      renderer.gap();
    } finally {
      controller = null;
      busy = false;
      try {
        rl.resume();
      } catch {
        /* the interface closed while the turn ran */
      }
      reprompt();
    }
  };

  /* One turn at a time, and the session does not exit underneath a running
     one: a piped script can deliver its last line (and EOF) while the model is
     still answering, and dropping that answer would be a silent data loss. */
  let currentTurn = null;

  rl.on('line', async (line) => {
    const raw = String(line || '');

    /* A trailing backslash continues the prompt on the next line. */
    if (/\\$/.test(raw) && !/\\\\$/.test(raw)) {
      pendingText += `${raw.slice(0, -1)}\n`;
      rl.setPrompt(contText);
      reprompt();
      return;
    }

    const text = (pendingText + raw).trim();
    pendingText = '';
    rl.setPrompt(promptText);

    if (!text) {
      reprompt();
      return;
    }

    if (text.startsWith('/')) {
      const handled = await slash(text);
      if (handled) {
        reprompt();
        return;
      }
      /* Falls through: /skill-name is expanded by the turn itself. */
    }

    await (currentTurn = runOne(text));
  });

  rl.on('SIGINT', () => {
    if (busy && controller) {
      controller.abort();
      say(c.yellow(`  cancelling ${sym.dot} Ctrl+C again to quit`));
      return;
    }
    const now = Date.now();
    if (now - lastInterrupt < 1500) {
      leaving = true;
      rl.close();
      return;
    }
    lastInterrupt = now;
    if (rl.line) {
      rl.line = '';
      rl.cursor = 0;
      if (typeof rl._refreshLine === 'function') rl._refreshLine();
    }
    say(c.dim('  Ctrl+C again to exit · /exit leaves too · /help lists commands'));
    reprompt(true);
  });

  rl.on('close', () => {
    closed = true;
    saveHistory(rl);
    if (leaving) return;
    leaving = true;
    process.stderr.write('\n');
  });

  /* Ctrl+D means "stop and leave" for a person at a keyboard. Piped input ends
     for a different reason — the script finished writing — so an EOF there must
     not abort the turn that is still running. */
  process.stdin.on('end', () => {
    if (busy && controller && process.stdin.isTTY) controller.abort();
  });

  installKeys(rl, c, { getSkills: skillNames, promptText });

  reprompt();
  await new Promise((resolve) => rl.once('close', resolve));
  if (currentTurn) {
    try {
      await currentTurn;
    } catch {
      /* already reported by the turn itself */
    }
  }
  return 0;
}

module.exports = { repl, SLASH_COMMANDS };
