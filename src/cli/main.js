'use strict';

/**
 * Klaud CLI — argv parsing and dispatch.
 *
 * Hand-rolled rather than a dependency: the whole parser is below, it has no
 * opinions the project did not ask for, and Klaud ships with zero packages.
 *
 * Resolution order for the first positional token:
 *   1. a known command            → run it
 *   2. a near-miss of a command   → refuse with a suggestion (a typo must not
 *                                   become a prompt that hits the network)
 *   3. anything else              → the prompt itself, i.e. `klaud fix the test`
 */

const { makePalette, defList } = require('./ui');
const pkg = require('../../package.json');

/* ------------------------------- options ------------------------------- */

/**
 * Every flag the CLI accepts, in one table. `type: 'value'` consumes the next
 * argument (or `--flag=value`); `type: 'bool'` never does.
 */
const OPTIONS = {
  '--help': { short: '-h', type: 'bool', note: 'Show help for the CLI or a command' },
  '--version': { short: '-V', type: 'bool', note: 'Print the version and exit' },
  '--model': { short: '-m', type: 'value', note: 'Model id to use for this run' },
  '--workspace': { short: '-w', type: 'value', note: 'Working directory the agent may touch' },
  '--permission-mode': { type: 'value', note: 'auto | ask | readonly' },
  '--yes': { short: '-y', type: 'bool', note: 'Approve every write and command (permission mode auto)' },
  '--json': { type: 'bool', note: 'Machine-readable output on stdout' },
  '--continue': { short: '-c', type: 'bool', note: 'Continue the most recent session' },
  '--resume': { type: 'value', note: 'Resume a session by id' },
  '--port': { type: 'value', note: 'Port for `klaud serve`' },
  '--open': { type: 'bool', note: 'Open the browser after `klaud serve`' },
  '--check': { type: 'bool', note: 'Probe endpoints before reporting' },
  '--list': { type: 'bool', note: 'List values instead of printing one' },
  '--provider': { type: 'value', note: 'Provider id for `klaud init` (skips prompts)' },
  '--key': { type: 'value', note: 'API key for `klaud init`' },
  '--quiet': { short: '-q', type: 'bool', note: 'Assistant text only; no progress lines' },
  '--verbose': { short: '-v', type: 'bool', note: 'Show tool arguments and output' },
  '--no-color': { type: 'bool', note: 'Disable colour (same as NO_COLOR=1)' },
};

function parseArgs(argv) {
  const out = { flags: {}, positional: [], rest: [], terminated: false };
  const byShort = {};
  for (const [name, spec] of Object.entries(OPTIONS)) if (spec.short) byShort[spec.short] = name;

  let terminated = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (terminated) {
      out.rest.push(token);
      continue;
    }
    if (token === '--') {
      terminated = true;
      out.terminated = true;
      continue;
    }

    let name = token;
    let inline = null;
    if (token.startsWith('--') && token.includes('=')) {
      const at = token.indexOf('=');
      name = token.slice(0, at);
      inline = token.slice(at + 1);
    } else if (byShort[token]) {
      name = byShort[token];
    }

    const spec = OPTIONS[name];
    if (!spec) {
      if (token.startsWith('-') && token !== '-' && !/^\d/.test(token)) {
        throw Object.assign(new Error(`Unknown option: ${token}`), { code: 'EUSAGE' });
      }
      out.positional.push(token);
      continue;
    }

    if (spec.type === 'value') {
      const value = inline !== null ? inline : argv[++i];
      if (value === undefined) {
        throw Object.assign(new Error(`Option ${name} needs a value`), { code: 'EUSAGE' });
      }
      out.flags[name] = value;
    } else {
      out.flags[name] = true;
    }
  }
  return out;
}

/* ------------------------------- dispatch ------------------------------ */

const COMMAND_NAMES = [
  'run',
  'init',
  'providers',
  'model',
  'config',
  'skills',
  'chats',
  'doctor',
  'serve',
  'help',
  'version',
];

function editDistance(a, b) {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const temp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = temp;
    }
  }
  return row[n];
}

function suggest(word) {
  let best = null;
  for (const name of COMMAND_NAMES) {
    const d = editDistance(word.toLowerCase(), name);
    if (d <= 2 && (best === null || d < best.d)) best = { name, d };
  }
  return best ? best.name : null;
}

/* --------------------------------- help -------------------------------- */

function helpText(c, topic) {
  const B = c.bold;
  const D = c.dim;
  const A = c.accent;

  if (topic === 'run') {
    return [
      `${B('klaud run <prompt>')} — answer one prompt and exit`,
      '',
      defList(
        [
          ['-y, --yes', 'Approve every write and command without asking'],
          ['--permission-mode', 'auto | ask | readonly for this run'],
          ['--json', 'Print one JSON object on stdout: finished, steps, usage, finalText'],
          ['-c, --continue', 'Append to the most recent session'],
          ['--resume <id>', 'Append to a named session'],
          ['-m, --model <id>', 'Model override for this run'],
          ['-w, --workspace <dir>', 'Working directory for the tools'],
          ['-q, --quiet', 'Only the assistant text, nothing else'],
          ['-v, --verbose', 'Show tool arguments and raw tool output'],
        ],
        c
      ),
      '',
      `${D('Examples')}`,
      `  ${A('$')} klaud run "add input validation to the signup form"`,
      `  ${A('$')} klaud -c --json "did the tests pass?" | jq -r .finalText`,
    ].join('\n');
  }

  const rows = [
    ['run', 'Answer one prompt and exit (also: klaud "prompt")'],
    ['init', 'Guided setup: pick a free provider, paste a key, choose a model'],
    ['providers', 'List the built-in free, no-card endpoints (--check probes them)'],
    ['model', 'Show or set the model; --list asks the endpoint what it has'],
    ['config', 'Read or write any setting (config <key> [value])'],
    ['skills', 'List the skills that load into every session'],
    ['chats', 'List saved sessions with their ids, for --resume'],
    ['doctor', 'Check Node, config, workspace and provider reachability'],
    ['serve', 'Start the web UI from this same install'],
    ['help', 'help [command] — this text, or one command in detail'],
    ['version', 'Print the version'],
  ];

  return [
    `${B('Klaud CLI')} ${D(`v${pkg.version}`)} — a local coding agent in your terminal`,
    '',
    `${B('Usage')}`,
    `  ${A('$')} klaud                          interactive chat session`,
    `  ${A('$')} klaud "fix the failing test"   one-shot: answer and exit`,
    `  ${A('$')} klaud <command> [options]      run a command`,
    '',
    `${B('Commands')}`,
    defList(rows, c),
    '',
    `${B('Options')}`,
    defList(
      Object.entries(OPTIONS).map(([name, spec]) => [
        spec.short ? `${spec.short}, ${name}` : `    ${name}`,
        spec.note,
      ]),
      c
    ),
    '',
    `${B('In a session')}`,
    `  ${D('/help  /model  /permissions  /skills  /clear  /resume  /exit')}`,
    '',
    `${B('Environment')}`,
    defList(
      [
        ['KLAUD_DATA_DIR', 'Where settings and sessions live (default ~/.klaud)'],
        ['KLAUD_WORKSPACE', 'Default working directory'],
        ['NO_COLOR', 'Disable colour entirely'],
        ['FORCE_COLOR', 'Force colour when piping'],
      ],
      c
    ),
    '',
    D('Shares ~/.klaud with the Klaud web app — one config, two front ends.'),
  ].join('\n');
}

/* --------------------------------- main -------------------------------- */

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    const c = makePalette(process.stderr);
    process.stderr.write(`${c.red('error')} ${err.message}\n`);
    process.stderr.write(`Run ${c.bold('klaud --help')} to see the options.\n`);
    return 2;
  }

  const { flags, positional, rest, terminated } = parsed;
  const c = makePalette(flags['--no-color'] ? null : process.stdout);
  const commands = require('./commands');

  if (flags['--version'] && positional.length === 0 && rest.length === 0) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  if (flags['--help'] && positional.length === 0 && rest.length === 0) {
    process.stdout.write(`${helpText(c)}\n`);
    return 0;
  }

  // Words in the order they were given. Everything after `--` is prompt text,
  // never a command name.
  const words = [...positional, ...rest];
  const head = terminated || !words.length ? null : words[0];
  const tail = head ? words.slice(1) : words;

  /* No command at all: interactive chat. */
  if (!head) {
    return require('./repl').repl({ flags, c, args: tail });
  }

  if (COMMAND_NAMES.includes(head)) {
    if (head === 'help') {
      const topic = tail[0];
      if (topic && !COMMAND_NAMES.includes(topic)) {
        const guess = suggest(topic);
        process.stderr.write(
          `Unknown command: ${topic}${guess ? ` — did you mean ${c.bold(guess)}?` : ''}\n`
        );
        return 2;
      }
      process.stdout.write(`${helpText(c, topic)}\n`);
      return 0;
    }
    return commands.run(head, { flags, c, args: tail });
  }

  /* Not a command: either a typo of one, or the prompt itself. */
  const guess = suggest(head);
  if (guess && head.length <= 12) {
    process.stderr.write(
      `${c.red('error')} Unknown command: ${head}\n` +
        `Did you mean ${c.bold(guess)}? Run ${c.bold('klaud --help')} for the list.\n`
    );
    return 2;
  }

  return commands.run('run', { flags, c, args: words, raw: true });
}

module.exports = { main, parseArgs, helpText, COMMAND_NAMES, OPTIONS, suggest };