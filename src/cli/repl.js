'use strict';

/**
 * Klaud CLI — the interactive session.
 *
 * Behaviour worth spelling out, because these are the parts people judge a
 * terminal agent on:
 *
 *   · the readline interface is paused while a turn runs, so streamed output
 *     never fights the prompt for the line;
 *   · Ctrl+C aborts the running turn (an AbortController the engine honours),
 *     and only exits when the line is already empty;
 *   · /commands are handled here and never reach the model — a typo'd slash
 *     command says so instead of being sent as prose;
 *   · stdout stays the assistant's answer; banners, tools and prompts are
 *     stderr, so a piped session still yields clean text.
 */

const readline = require('readline');
const store = require('../store');
const skillsLib = require('../lib/skills');
const pkg = require('../../package.json');
const turn = require('./turn');
const { createRenderer } = require('./render');
const { sym, ask } = require('./ui');

const SLASH_COMMANDS = {
  help: 'Show this list',
  model: 'Show or set the model — /model <id>',
  permissions: 'Show or set auto | ask | readonly — /permissions <mode>',
  skills: 'List the skills that load into this session',
  workspace: 'Show or set the working directory — /workspace <path>',
  sessions: 'List saved sessions, with ids to /resume',
  resume: 'Continue a saved session — /resume <id>',
  clear: 'Forget this conversation and start a new one',
  config: 'Open the settings summary — /config [key] [value]',
  exit: 'Leave (Ctrl+D works too)',
};

function banner(c, settings, chat) {
  const lines = [
    `${c.accent('Klaud')} ${c.dim(`v${pkg.version}`)}  ${c.dim(sym.dot)}  ${c.bold(settings.model)}  ${c.dim(sym.dot)}  ${c.dim(settings.approvalMode)}`,
    `${c.dim(`workspace ${settings.workspace}`)}`,
    '',
    c.dim(`/help for commands · /exit to leave · Ctrl+C cancels a turn`),
  ];
  return lines.join('\n');
}

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

  const session = { approvalMode: settings.approvalMode };

  const interactive = Boolean(process.stdin.isTTY);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr, // the prompt is chatter; stdout is the answer
    terminal: interactive,
    prompt: c.accent(`${sym.prompt} `),
    history: [],
    historySize: 200,
  });

  renderer.note(banner(c, settings, chat));
  renderer.gap();

  let controller = null;
  let busy = false;
  let leaving = false;

  const say = (text) => process.stderr.write(`${text}\n`);

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
      say(c.bold('Commands'));
      for (const [cmd, note] of Object.entries(SLASH_COMMANDS)) {
        say(`  ${c.accent('/' + cmd.padEnd(12))} ${c.dim(note)}`);
      }
      say('');
      say(c.dim('Anything else is sent to the agent. A skill can be invoked as /<skill-name>.'));
      say('');
      return true;
    }

    if (key === 'clear') {
      chat = await store.createChat({ model: settings.model, workspace: settings.workspace });
      say(c.dim('  new session'));
      return true;
    }

    if (key === 'model') {
      if (!arg) {
        say(`  ${c.bold(settings.model)} ${c.dim(`at ${settings.baseUrl}`)}`);
        say(c.dim('  /model <id> changes it for this session · klaud model <id> keeps it'));
        return true;
      }
      settings.model = arg;
      await store.saveSettings({ model: arg });
      say(`${c.green(sym.ok)} model = ${c.bold(arg)}`);
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
      const resolved = require('path').resolve(arg);
      settings.workspace = resolved;
      await store.saveSettings({ workspace: resolved });
      say(`${c.green(sym.ok)} workspace = ${c.bold(resolved)}`);
      return true;
    }

    if (key === 'skills') {
      const list = skillsLib.listSkills(settings.workspace);
      if (!list.length) {
        say(c.dim('  no skills found'));
        return true;
      }
      say('');
      for (const s of list) say(`  ${c.accent('/' + s.name.padEnd(14))} ${c.dim(s.description || '')}`);
      say('');
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
        say(c.dim('  /resume <id> — ids are listed by /sessions'));
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

    if (key === 'config') {
      const parts = arg ? arg.split(/\s+/) : [];
      const current = await store.loadSettings();
      if (parts.length === 0) {
        const view = store.publicSettings(current);
        say('');
        for (const [k, v] of Object.entries(view)) {
          say(`  ${c.bold(k.padEnd(18))} ${c.dim(typeof v === 'object' ? JSON.stringify(v) : String(v))}`);
        }
        say('');
        return true;
      }
      const [configKey, ...valueParts] = parts;
      if (valueParts.length === 0) {
        const shown =
          configKey === 'apiKey' && current.apiKey ? store.maskKey(current.apiKey) : current[configKey];
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
    rl.pause();
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
      if (result.finished === 'aborted') {
        say(c.yellow('  cancelled'));
      }
      renderer.gap();
    } catch (err) {
      renderer.closeText();
      say(turn.describeError(err, c));
      renderer.gap();
    } finally {
      controller = null;
      busy = false;
      rl.resume();
      if (!leaving) rl.prompt();
    }
  };

  rl.on('line', async (line) => {
    const text = String(line || '').trim();
    if (!text) {
      rl.prompt();
      return;
    }

    if (text.startsWith('/')) {
      const handled = await slash(text);
      if (handled) {
        if (!leaving) rl.prompt();
        return;
      }
      /* Falls through: /skill-name is expanded by the turn itself. */
    }

    await runOne(text);
  });

  rl.on('SIGINT', () => {
    if (busy && controller) {
      controller.abort();
      return;
    }
    if (!leaving) {
      say(c.dim('  (Ctrl+C again on an empty line to exit)'));
      rl.prompt();
    }
  });

  rl.on('close', () => {
    if (leaving) return;
    leaving = true;
    process.stderr.write('\n');
  });

  /* Ctrl+D with a busy turn: same as Ctrl+C — stop the work, then leave. */
  process.stdin.on('end', () => {
    if (busy && controller) controller.abort();
  });

  rl.prompt();
  await new Promise((resolve) => rl.once('close', resolve));
  return 0;
}

module.exports = { repl, SLASH_COMMANDS };