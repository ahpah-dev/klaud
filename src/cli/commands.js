'use strict';

/**
 * Klaud CLI — command implementations.
 *
 * Every command is a small function returning an exit code. They share three
 * rules: stdout is the result (so `| jq`, `> file` work), stderr is the
 * chatter, and nothing here talks HTTP to itself — the engine modules are
 * called directly, exactly as src/server.js calls them.
 */

const fs = require('fs');
const path = require('path');
const store = require('../store');
const providers = require('../providers');
const llm = require('../llm');
const skillsLib = require('../lib/skills');
const toolsLib = require('../lib/tools');
const { PROJECT_ROOT, dataDir } = require('../config');
const pkg = require('../../package.json');
const { createRenderer } = require('./render');
const turn = require('./turn');
const { sym, table, defList, ask, secret, spinner } = require('./ui');

/** Mirrors store.js SETTING_KEYS, which is deliberately not exported. */
const SETTING_KEYS = [
  'baseUrl', 'apiKey', 'model', 'temperature', 'systemPrompt', 'approvalMode',
  'workspace', 'maxSteps', 'maxContextChars', 'reasoningEffort', 'mode',
];

const PERMISSION_MODES = ['auto', 'ask', 'readonly'];

/* ------------------------------- helpers ------------------------------- */

function out(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function errOut(c, text) {
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

function usageError(c, message) {
  errOut(c, `${c.red('error')} ${message}\nRun ${c.bold('klaud --help')} to see the options.`);
  return 2;
}

function relTime(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function asJson(value) {
  out(JSON.stringify(value, null, 2));
}

/* --------------------------------- run --------------------------------- */

async function cmdRun({ flags, c, args, raw }) {
  const prompt = args.join(' ').trim();
  const wantJson = Boolean(flags['--json']);

  if (!prompt && !flags['--continue'] && !flags['--resume']) {
    return usageError(c, raw ? 'No prompt given.' : 'klaud run needs a prompt.');
  }

  const settings = await turn.loadSettings(flags);
  const chat = await turn.loadChat(flags);

  const interactive = Boolean(process.stdin.isTTY) && !wantJson;
  if (settings.approvalMode === 'ask' && !interactive) {
    return usageError(
      c,
      "Permission mode is 'ask' but stdin is not a terminal, so nothing can approve.\n" +
        '  Pass --yes to approve every write and command, or --permission-mode readonly.'
    );
  }

  const renderer = createRenderer({
    out: process.stdout,
    err: process.stderr,
    c,
    quiet: Boolean(flags['--quiet']),
    verbose: Boolean(flags['--verbose']),
    json: wantJson,
  });

  const controller = new AbortController();
  let interrupted = false;
  const onSigint = () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    controller.abort();
    renderer.note(c.yellow(`${sym.warn} cancelling — press Ctrl+C again to quit`));
  };
  process.on('SIGINT', onSigint);

  const startedAt = Date.now();
  const session = { approvalMode: settings.approvalMode };

  try {
    const { result, chat: saved } = await turn.runPrompt({
      settings,
      chat,
      prompt,
      flags,
      renderer,
      controller,
      interactive,
      session,
    });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const toolsUsed = (result.toolCalls || []).filter((t) => !t.denied).length;

    if (wantJson) {
      asJson({
        ok: result.finished === 'stop' || result.finished === 'loop_broken' || result.finished === 'max_steps',
        finished: result.finished,
        steps: result.steps,
        usage: result.usage,
        toolCalls: result.toolCalls,
        finalText: result.finalText || '',
        chatId: saved.id,
        elapsedMs: Date.now() - startedAt,
      });
    } else if (!flags['--quiet']) {
      const bits = [
        `${result.steps} step${result.steps === 1 ? '' : 's'}`,
        `${toolsUsed} tool${toolsUsed === 1 ? '' : 's'}`,
        `${(result.usage && result.usage.total_tokens) || 0} tokens`,
        `${elapsed}s`,
      ];
      renderer.gap();
      renderer.note(`${c.green(sym.ok)} ${c.dim(bits.join(' · '))}  ${c.dim(`session ${saved.id}`)}`);
    }

    if (result.finished === 'error') return 1;
    if (result.finished === 'aborted' || interrupted) return 130;
    return 0;
  } catch (err) {
    renderer.closeText();
    errOut(c, turn.describeError(err, c));
    return err && err.code === 'EUSAGE' ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

/* -------------------------------- init --------------------------------- */

async function cmdInit({ flags, c, args }) {
  const settings = await store.loadSettings();

  /* Non-interactive path: `klaud init --provider nvidia --key …` never prompts. */
  const nonInteractive = Boolean(flags['--provider']);
  const chosen = providers.REGISTRY.find((p) => p.id === (flags['--provider'] || ''));
  if (flags['--provider'] && !chosen) {
    const ids = providers.REGISTRY.map((p) => p.id).join(', ');
    return usageError(c, `Unknown provider "${flags['--provider']}". Known: ${ids}`);
  }

  let provider = chosen;
  let apiKey = settings.apiKey;
  let model = settings.model;
  let workspace = settings.workspace;
  let approvalMode = settings.approvalMode;

  if (!nonInteractive) {
    out('');
    out(c.bold(`Klaud CLI setup ${c.dim(`v${pkg.version}`)}`));
    out(c.dim('Free endpoints only. No card, no trial credit, no expiry.'));
    out('');

    const ordered = [...providers.REGISTRY].sort((a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0));
    ordered.forEach((p, i) => {
      const marker = p.recommended ? c.accent(' ← recommended') : '';
      const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(p.baseUrl) ? c.dim('  local, no key') : '';
      out(`  ${c.bold(String(i + 1).padStart(2))}. ${p.name}${marker}${local}`);
      out(c.dim(`      ${p.baseUrl} · ${p.model}`));
    });
    out('');

    const pick = await ask(`Provider [1-${ordered.length}]`, { def: '1' });
    provider = ordered[Math.max(0, Math.min(ordered.length - 1, (Number(pick) || 1) - 1))];
    model = provider.model;

    const local = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(provider.baseUrl);
    if (!local) {
      out('');
      out(c.dim(`Get a key at ${provider.signupUrl || provider.limitsSource || provider.baseUrl}`));
      out(c.dim(`Limits: ${provider.limits || 'see the provider'}`));
      const key = await secret('API key (Enter to skip): ');
      if (key) apiKey = key;
    }

    const workspaceAnswer = await ask('Working directory', { def: workspace });
    if (workspaceAnswer) workspace = path.resolve(workspaceAnswer);

    const mode = await ask('Permission mode: auto, ask or readonly', { def: approvalMode });
    if (mode && PERMISSION_MODES.includes(mode)) approvalMode = mode;
  } else {
    if (chosen) model = flags['--model'] || chosen.model;
    if (flags['--key']) apiKey = flags['--key'];
    if (flags['--workspace']) workspace = path.resolve(flags['--workspace']);
    if (flags['--permission-mode'] && PERMISSION_MODES.includes(flags['--permission-mode'])) {
      approvalMode = flags['--permission-mode'];
    }
  }

  const patch = { model, workspace, approvalMode };
  if (provider) patch.baseUrl = provider.baseUrl;
  if (apiKey) patch.apiKey = apiKey;
  if (flags['--model']) patch.model = flags['--model'];

  const next = await store.saveSettings(patch);

  out('');
  out(`${c.green(sym.ok)} saved to ${c.bold(path.join(dataDir(), 'settings.json'))}`);
  out(
    table(
      [
        ['provider', provider ? provider.name : '(unchanged)'],
        ['baseUrl', next.baseUrl],
        ['model', next.model],
        ['key', next.apiKey ? store.maskKey(next.apiKey) : c.yellow('none — local endpoints need none')],
        ['workspace', next.workspace],
        ['permissions', next.approvalMode],
      ],
      c
    )
  );
  out('');
  out(`Run ${c.accent('klaud')} to chat, or ${c.accent('klaud "fix the failing test"')} for one shot.`);
  return 0;
}

/* ------------------------------ providers ------------------------------ */

async function cmdProviders({ flags, c }) {
  const spin = spinner(process.stderr, c, 'Probing free endpoints');
  if (!flags['--json']) spin.start();

  let catalog;
  try {
    catalog = await providers.getFreeCatalog({ probeLocal: true });
  } finally {
    spin.stop();
  }

  const list = catalog.providers || [];

  if (flags['--json']) {
    if (flags['--check']) {
      const checks = await probeProviders(list, c);
      asJson({ generatedAt: catalog.generatedAt, liveChecks: catalog.liveChecks, providers: list, probe: checks });
    } else {
      asJson({ generatedAt: catalog.generatedAt, liveChecks: catalog.liveChecks, providers: list });
    }
    return 0;
  }

  const rows = list.map((p) => [p.name, p.baseUrl, p.model, p.limits || '']);
  out(
    c.bold('Free, no-card endpoints') +
      c.dim(`  ·  verified ${new Date(catalog.verifiedOn || Date.now()).toISOString().slice(0, 10)}`)
  );
  out('');
  for (const [name, url, model, limits] of rows) {
    const p = list.find((entry) => entry.baseUrl === url);
    out(`${c.bold(name)}${p && p.recommended ? c.accent(' ★ recommended') : ''}`);
    out(`  ${c.dim(url)}`);
    out(`  ${'model'.padEnd(6)} ${model}`);
    if (limits) out(c.dim(`  ${limits}`));
    out('');
  }

  if (flags['--check']) {
    const checks = await probeProviders(list, c);
    out('');
    out(c.bold('Reachable now'));
    out(
      defList(
        checks.map((k) => [
          k.name,
          k.ok
            ? `${c.green(sym.ok)} ${k.count} model${k.count === 1 ? '' : 's'}${k.modelKnown ? c.dim(' · configured model present') : c.yellow(' · configured model missing')}`
            : `${c.red(sym.cross)} ${c.dim(k.error)}`,
        ]),
        c,
        100,
        26
      )
    );
  }

  out('');
  out(c.dim(catalog.note || 'Rate limits are quoted from the providers and not verified by Klaud.'));
  out(c.dim(`Run ${c.accent('klaud init')} to pick one and save it.`));
  return 0;
}

async function probeProviders(list, c) {
  const settings = await store.loadSettings().catch(() => null);
  return Promise.all(
    list.map(async (p) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      try {
        const models = await llm.listModels({
          baseUrl: p.baseUrl,
          apiKey: p.id && settings && settings.baseUrl === p.baseUrl ? settings.apiKey : '',
          signal: controller.signal,
        });
        const ids = (models || []).map((m) => m.id);
        return {
          id: p.id,
          name: p.name,
          ok: true,
          count: ids.length,
          modelKnown: ids.includes(p.model) || ids.some((id) => id.endsWith(p.model)),
        };
      } catch (err) {
        return { id: p.id, name: p.name, ok: false, error: err && err.message ? err.message : String(err) };
      } finally {
        clearTimeout(timer);
      }
    })
  );
}

/* -------------------------------- model -------------------------------- */

async function cmdModel({ flags, c, args }) {
  const settings = await store.loadSettings();
  const wanted = args.join(' ').trim();

  if (flags['--list']) {
    const spin = spinner(process.stderr, c, `Asking ${settings.baseUrl} for its models`);
    spin.start();
    try {
      const models = await llm.listModels({ baseUrl: settings.baseUrl, apiKey: settings.apiKey });
      spin.stop();
      out(models.map((m) => m.id).join('\n'));
      return 0;
    } catch (err) {
      spin.stop();
      errOut(c, turn.describeError(err, c));
      return 1;
    }
  }

  if (!wanted) {
    out(
      table(
        [
          ['model', settings.model],
          ['endpoint', settings.baseUrl],
          ['key', settings.apiKey ? store.maskKey(settings.apiKey) : '(none)'],
        ],
        c
      )
    );
    out(c.dim('Change it: klaud model <id>'));
    return 0;
  }

  await store.saveSettings({ model: wanted });
  out(`${c.green(sym.ok)} model set to ${c.bold(wanted)}`);
  return 0;
}

/* -------------------------------- config ------------------------------- */

async function cmdConfig({ flags, c, args }) {
  const settings = await store.loadSettings();
  const key = args[0];
  const value = args.slice(1).join(' ');

  if (!key) {
    const publicView = store.publicSettings(settings);
    if (flags['--json']) {
      asJson(publicView);
      return 0;
    }
    out(c.bold('Settings') + c.dim(`  ${path.join(dataDir(), 'settings.json')}`));
    out('');
    const rows = Object.entries(publicView).map(([k, v]) => {
      let shown;
      if (typeof v === 'object' && v !== null) shown = JSON.stringify(v);
      else shown = String(v);
      // A 2,000-character system prompt is not a summary. Show the first line
      // and say how much is hidden, so `config` stays scannable.
      if (shown.length > 96) {
        const lines = shown.split('\n')[0];
        shown = `${lines.slice(0, 92)}… ${c.dim(`+${shown.length - 92} chars; edit with: klaud config systemPrompt <text>`)}`;
      }
      return [k, shown];
    });
    out(defList(rows, c, 100, 22));
    out(c.dim('Set one: klaud config <key> <value>'));
    return 0;
  }

  if (!SETTING_KEYS.includes(key)) {
    return usageError(
      c,
      `Unknown setting "${key}".\n  Known keys: ${SETTING_KEYS.join(', ')}`
    );
  }

  if (value === '') {
    const shown = key === 'apiKey' && settings.apiKey ? store.maskKey(settings.apiKey) : settings[key];
    if (flags['--json']) asJson({ [key]: key === 'apiKey' ? Boolean(settings.apiKey) : settings[key] });
    else out(String(shown === undefined || shown === null ? '' : shown));
    return 0;
  }

  const patch = { [key]: value };
  const next = await store.saveSettings(patch);
  const accepted = next[key] === value || (key === 'workspace' && next[key] === path.resolve(value));
  if (!accepted && !SETTING_KEYS.includes(key)) {
    return usageError(c, `Refused: ${key} did not change.`);
  }
  const shown = key === 'apiKey' && value ? store.maskKey(value) : value;
  out(`${c.green(sym.ok)} ${key} = ${c.bold(String(shown))}`);
  return 0;
}

/* -------------------------------- skills ------------------------------- */

async function cmdSkills({ flags, c }) {
  const settings = await store.loadSettings();
  const list = skillsLib.listSkills(settings.workspace);

  if (flags['--json']) {
    asJson(list.map((s) => ({ name: s.name, source: s.source, description: s.description })));
    return 0;
  }

  if (!list.length) {
    out(c.dim('No skills found. Add one at .klaud/skills/<name>/SKILL.md'));
    return 0;
  }

  out(c.bold(`${list.length} skill${list.length === 1 ? '' : 's'}`) + c.dim(`  ·  ${settings.workspace}`));
  out('');
  out(
    defList(
      list.map((s) => [s.name, `${s.description || ''} ${c.dim(`[${s.source}]`)}`]),
      c,
      100,
      22
    )
  );
  out(c.dim(`Invoke one in a prompt: /<name>`));
  return 0;
}

/* -------------------------------- chats -------------------------------- */

async function cmdChats({ flags, c }) {
  const list = await store.listChats();

  if (flags['--json']) {
    asJson(list);
    return 0;
  }

  if (!list.length) {
    out(c.dim('No sessions yet. Run klaud to start one.'));
    return 0;
  }

  out(c.bold(`${list.length} session${list.length === 1 ? '' : 's'}`));
  out('');
  for (const chat of list) {
    out(
      `  ${c.accent(chat.id)}  ${chat.title}  ${c.dim(
        `${chat.messageCount} msg · ${relTime(chat.updatedAt)}${chat.model ? ` · ${chat.model}` : ''}`
      )}`
    );
  }
  out('');
  out(c.dim('Resume one: klaud --resume <id>   ·   the most recent: klaud -c'));
  return 0;
}

/* -------------------------------- doctor ------------------------------- */

async function cmdDoctor({ flags, c }) {
  const checks = [];
  const add = (name, ok, detail, hard = true) => checks.push({ name, ok, detail, hard });

  const [major] = process.versions.node.split('.').map(Number);
  add('node', major >= 18, `v${process.versions.node}${major >= 18 ? '' : ' — Klaud needs 18+'}`);

  let settings = null;
  try {
    settings = await store.loadSettings();
    add('settings', true, `${path.join(dataDir(), 'settings.json')} parsed`);
  } catch (err) {
    add('settings', false, err.message);
  }

  if (settings) {
    add(
      'endpoint',
      /^https?:\/\//.test(settings.baseUrl),
      `${settings.baseUrl}${/^https?:\/\/(localhost|127\.0\.0\.1)/.test(settings.baseUrl) ? ' (local)' : ''}`
    );
    add(
      'api key',
      Boolean(settings.apiKey) || turn.isLoopback(settings.baseUrl),
      settings.apiKey ? store.maskKey(settings.apiKey) : turn.isLoopback(settings.baseUrl) ? 'not needed for a local endpoint' : 'missing — run `klaud init`'
    );

    const ws = settings.workspace;
    let wsOk = false;
    let wsDetail = ws;
    try {
      fs.accessSync(ws, fs.constants.R_OK | fs.constants.W_OK);
      wsOk = true;
    } catch (err) {
      wsDetail = `${ws} — ${err.code || err.message}`;
    }
    add('workspace', wsOk && fs.existsSync(ws), wsDetail);

    const spin = spinner(process.stderr, c, `Probing ${settings.baseUrl}`);
    spin.start();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const models = await llm.listModels({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, signal: controller.signal });
      clearTimeout(timer);
      const ids = (models || []).map((m) => m.id);
      const known = ids.includes(settings.model);
      add(
        'provider',
        ids.length > 0,
        `${ids.length} model${ids.length === 1 ? '' : 's'}` +
          (known ? ` · ${settings.model} present` : ` · ${settings.model} not in the list`),
        false
      );
    } catch (err) {
      add('provider', false, err && err.message ? err.message : String(err), false);
    } finally {
      spin.stop();
    }
  }

  const skillCount = skillsLib.listSkills(settings ? settings.workspace : process.cwd()).length;
  add('skills', true, `${skillCount} loaded`);
  add('tools', toolsLib.toolCatalog().length >= 9, `${toolsLib.toolCatalog().length} tools registered`);

  out(c.bold('Klaud CLI doctor') + c.dim(`  v${pkg.version}`));
  out('');
  for (const check of checks) {
    const glyph = check.ok ? c.green(sym.ok) : check.hard ? c.red(sym.cross) : c.yellow(sym.warn);
    out(`  ${glyph} ${c.bold(check.name.padEnd(10))} ${c.dim(check.detail)}`);
  }

  const failed = checks.filter((x) => !x.ok && x.hard);
  const warned = checks.filter((x) => !x.ok && !x.hard);
  out('');
  if (failed.length) {
    out(`${c.red(sym.cross)} ${failed.length} problem${failed.length === 1 ? '' : 's'} to fix.`);
    return 1;
  }
  if (warned.length) {
    out(`${c.yellow(sym.warn)} Works, but ${warned[0].name} is unreachable right now — the model will fail when you send a prompt.`);
    return 0;
  }
  out(`${c.green(sym.ok)} Everything checks out. Run ${c.accent('klaud')} to start.`);
  return 0;
}

/* -------------------------------- serve -------------------------------- */

async function cmdServe({ flags, c }) {
  const { spawn } = require('child_process');
  const port = flags['--port'] || process.env.KLAUD_PORT || process.env.PORT || '';
  const env = { ...process.env };
  if (port) env.PORT = String(port);
  if (flags['--open']) env.KLAUD_OPEN = '1';

  const serverPath = path.join(PROJECT_ROOT, 'src', 'server.js');
  out(c.dim(`Starting the Klaud web UI from ${serverPath}…`));

  const child = spawn(process.execPath, [serverPath], { env, stdio: 'inherit' });

  const forward = (signal) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      resolve(signal ? 130 : code || 0);
    });
    child.on('error', (err) => {
      errOut(c, `${c.red(sym.cross)} ${err.message}`);
      resolve(1);
    });
  });
}

/* ------------------------------- dispatch ------------------------------ */

const HANDLERS = {
  run: cmdRun,
  init: cmdInit,
  providers: cmdProviders,
  model: cmdModel,
  config: cmdConfig,
  skills: cmdSkills,
  chats: cmdChats,
  doctor: cmdDoctor,
  serve: cmdServe,
};

async function run(name, context) {
  const handler = HANDLERS[name];
  if (!handler) {
    errOut(context.c, `${context.c.red('error')} Unknown command: ${name}`);
    return 2;
  }
  return handler(context);
}

module.exports = { run, HANDLERS, SETTING_KEYS, relTime };