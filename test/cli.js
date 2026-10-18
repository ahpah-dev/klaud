'use strict';

/**
 * Klaud CLI test.
 *
 *   node test/cli.js
 *
 * The CLI is a front end, so the interesting claims are the ones a front end
 * can break on its own: that stdout carries only the answer (so `> file` and
 * `--json` work), that exit codes mean something, that a refusal is shown
 * rather than swallowed, that a typo is not silently sent to the network as a
 * prompt, and that the interactive session actually starts and leaves.
 *
 * Everything runs against a local mock provider — no network, no real key.
 */

const os = require('os');
const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const assert = require('assert/strict');
const { spawn } = require('child_process');

const PROJECT = path.resolve(__dirname, '..');
const CLI = path.join(PROJECT, 'bin', 'klaud.js');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

/** Run the CLI as a child process and collect both streams. */
function runCli(args, { env = {}, input = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: null, stdout, stderr: String(err) }));
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

/** A minimal OpenAI-compatible endpoint: tool call, tool call, answer. */
function mockProvider() {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');

      if (req.url.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'mock-large' }] }));
        return;
      }

      const body = JSON.parse(raw || '{}');
      const toolResults = (body.messages || []).filter((m) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);

      if (toolResults.length === 0) {
        w({ choices: [{ index: 0, delta: { content: 'Checking the workspace. ' } }] });
        w({ choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: 'call_1', type: 'function',
          function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) },
        }] } }] });
        w({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else if (toolResults.length === 1) {
        w({ choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: 'call_2', type: 'function',
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: 'cli-was-here.txt', content: 'written by the cli test\n' }),
          },
        }] } }] });
        w({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        w({ choices: [{ index: 0, delta: { content: 'Wrote cli-was-here.txt and verified it.' } }] });
        w({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      }
      w({ choices: [], usage: { prompt_tokens: 40, completion_tokens: 30, total_tokens: 70 } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

(async () => {
  console.log('\n\x1b[38;5;209m* Klaud CLI checks\x1b[0m\n');

  const scratch = [];
  const tempDir = async (label) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `klaud-cli-${label}-`));
    scratch.push(dir);
    return dir;
  };

  let mock = null;

  try {
    /* ------------------------------ surface ------------------------------ */
    const version = await runCli(['--version']);
    check('--version prints semver and exits 0',
      version.code === 0 && /^\d+\.\d+\.\d+\s*$/m.test(version.stdout),
      `code=${version.code} stdout=${JSON.stringify(version.stdout)}`);

    const help = await runCli(['--help']);
    const expected = ['klaud', 'Usage', 'Commands', 'Options', 'run', 'init', 'providers', 'doctor', 'serve'];
    check('--help lists the commands',
      help.code === 0 && expected.every((token) => help.stdout.includes(token)),
      help.stdout.slice(0, 400));
    check('--help does not mention another product',
      !/claude/i.test(help.stdout),
      'the help text must say klaud');

    const runHelp = await runCli(['help', 'run']);
    check('help run documents --json',
      runHelp.code === 0 && runHelp.stdout.includes('--json'));

    const typo = await runCli(['doctro']);
    check('a command typo is refused with a suggestion, exit 2',
      typo.code === 2 && /doctor/.test(typo.stderr),
      `code=${typo.code} stderr=${typo.stderr}`);

    const badFlag = await runCli(['--nope']);
    check('an unknown option is refused, exit 2', badFlag.code === 2);

    /* ------------------------------- config ------------------------------ */
    const dataDir = await tempDir('data');
    const workspace = await tempDir('ws');
    const env = { KLAUD_DATA_DIR: dataDir, KLAUD_WORKSPACE: workspace };

    const setModel = await runCli(['config', 'model', 'nemotron-test'], { env });
    check('config <key> <value> saves', setModel.code === 0 && setModel.stdout.includes('nemotron-test'));

    const getModel = await runCli(['config', 'model'], { env });
    check('config <key> reads it back', getModel.code === 0 && getModel.stdout.trim() === 'nemotron-test');

    const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
    check('the value landed in settings.json', stored.model === 'nemotron-test');

    const unknownKey = await runCli(['config', 'banana', '1'], { env });
    check('an unknown setting is refused, exit 2', unknownKey.code === 2);

    const list = await runCli(['config'], { env });
    check('config (no args) lists settings without dumping the system prompt',
      list.code === 0 && list.stdout.includes('hasApiKey') &&
        !list.stdout.includes('Keep every change inside the working directory'),
      list.stdout.slice(0, 300));

    const modelCmd = await runCli(['model'], { env });
    check('model prints the active model', modelCmd.code === 0 && modelCmd.stdout.includes('nemotron-test'));

    /* ---------------------------- offline commands ----------------------- */
    const skills = await runCli(['skills'], { env });
    check('skills lists the bundled skills',
      skills.code === 0 && skills.stdout.includes('code-review'));

    const chats = await runCli(['chats'], { env });
    check('chats on an empty store says so', chats.code === 0 && /No sessions yet/.test(chats.stdout));

    /* ------------------------------ end to end --------------------------- */
    mock = await mockProvider();
    await fs.writeFile(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${mock.port}/v1`,
        apiKey: 'test-key',
        model: 'mock-large',
        approvalMode: 'auto',
        workspace,
        maxSteps: 8,
        temperature: 0,
      }, null, 2)
    );

    const run = await runCli(['run', 'set something up'], { env });
    check('run exits 0', run.code === 0, `code=${run.code} stderr=${run.stderr.slice(0, 400)}`);
    check('stdout is the answer only — no step or tool chatter',
      run.stdout.includes('Wrote cli-was-here.txt') && !/step \d/.test(run.stdout),
      JSON.stringify(run.stdout));
    check('progress went to stderr instead',
      /step 1\/|list_dir/.test(run.stderr));
    const written = await fs.readFile(path.join(workspace, 'cli-was-here.txt'), 'utf8').catch(() => null);
    check('the tool actually wrote the file', written === 'written by the cli test\n');

    const jsonRun = await runCli(['--json', 'set something up'], { env });
    let parsed = null;
    try { parsed = JSON.parse(jsonRun.stdout); } catch { /* reported below */ }
    check('--json stdout parses as one object',
      jsonRun.code === 0 && parsed && parsed.finished === 'stop' && parsed.chatId && typeof parsed.finalText === 'string',
      jsonRun.stdout.slice(0, 300));
    check('--json reports the usage it was given',
      parsed && parsed.usage && parsed.usage.total_tokens > 0);

    const sessionFiles = (await fs.readdir(path.join(dataDir, 'chats'))).filter((f) => f.endsWith('.json'));
    check('sessions were persisted for --resume', sessionFiles.length >= 2, sessionFiles.join(', '));

    /* readonly refuses the write, and says so */
    const strictWorkspace = await tempDir('ro');
    const readonly = await runCli(
      ['run', '--permission-mode', 'readonly', 'write a file'],
      { env: { ...env, KLAUD_WORKSPACE: strictWorkspace } }
    );
    const blockedFile = await fs.readFile(path.join(strictWorkspace, 'cli-was-here.txt'), 'utf8').catch(() => null);
    check('readonly mode blocks the write', readonly.code === 0 && blockedFile === null,
      `code=${readonly.code} file=${blockedFile}`);
    check('the refusal is shown, not swallowed',
      /denied|Permission denied|refused/i.test(readonly.stderr + readonly.stdout),
      readonly.stderr.slice(0, 400));

    /* no key configured: a clear error, not a stack trace */
    const noKeyDir = await tempDir('nokey');
    const noKey = await runCli(['run', 'hello'], { env: { ...env, KLAUD_DATA_DIR: noKeyDir } });
    check('a missing key fails with instructions, exit 1',
      noKey.code === 1 && /No API key configured/.test(noKey.stderr) && !/at .*\.js:\d+/.test(noKey.stderr),
      noKey.stderr.slice(0, 300));

    /* doctor, against the mock endpoint, must pass end to end */
    const doctor = await runCli(['doctor'], { env });
    check('doctor passes with a reachable endpoint',
      doctor.code === 0 && /Everything checks out/.test(doctor.stdout),
      `code=${doctor.code}\n${doctor.stdout}`);

    /* ----------------------------- interactive --------------------------- */
    const session = await runCli([], { env, input: '/help\n/exit\n' });
    check('the interactive session starts and leaves cleanly',
      session.code === 0 && /Commands/.test(session.stderr),
      `code=${session.code} stderr=${session.stderr.slice(0, 300)}`);

    /* A closed pipe (| head) is not a crash. */
    const pipe = await new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, '--help'], {
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let seen = false;
      child.stdout.once('data', () => {
        if (seen) return;
        seen = true;
        child.stdout.destroy();
      });
      child.on('close', (code, signal) => resolve({ code, signal }));
      child.on('error', () => resolve({ code: null, signal: 'error' }));
    });
    check('a closed stdout pipe does not crash',
      pipe.signal === null && (pipe.code === 0 || pipe.code === null),
      JSON.stringify(pipe));
  } finally {
    if (mock) mock.server.close();
    for (const dir of scratch) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});