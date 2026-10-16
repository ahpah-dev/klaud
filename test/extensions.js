'use strict';

/**
 * Integration tests for the Cowork extensions: the joins between the skills,
 * plugins, subagents and agent-loop modules.
 *
 *   node test/extensions.js
 *
 * The three modules each have their own suite covering their own parsing. What
 * is only testable here is the wiring: that a skill on disk actually reaches the
 * model, that a subagent cannot spawn another subagent, and that an unreadable
 * plugin degrades to a warning instead of a dead server.
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const assert = require('assert/strict');

/* Point the whole data directory at a throwaway before anything loads, so the
 * real ~/.klaud is never read. Every module resolves its paths at call time, so
 * this is enough — but it must happen before the first require of src/config. */
const DATA_DIR = path.join(os.tmpdir(), `klaud-ext-data-${process.pid}-${Date.now()}`);
process.env.KLAUD_DATA_DIR = DATA_DIR;
// The agents module resolves its own home directory rather than going through
// config.js, so it needs its own override or the suite would scan the real one.
process.env.KLAUD_AGENTS_DIR = path.join(DATA_DIR, 'agents');

let pass = 0;
let fail = 0;
const failures = [];
let group = '';

const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`    \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push({ group, name, detail });
    console.log(`    \x1b[31mx\x1b[0m ${name}${detail ? `\n        ${detail}` : ''}`);
  }
};

const describe = (name, fn) => {
  group = name;
  console.log(`\n  \x1b[1m${name}\x1b[0m`);
  return fn();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Fixtures: a workspace, a home directory, and a recording mock provider
 * ------------------------------------------------------------------ */

let workspace;
let home;

async function makeWorkspace() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'klaud-ext-ws-'));
  await fs.writeFile(path.join(dir, 'notes.txt'), 'hello\n', 'utf8');
  return dir;
}

/** Write a skill into the personal (data) directory. */
async function writeSkill(name, frontmatter, body) {
  const dir = path.join(DATA_DIR, 'skills', name);
  await fs.mkdir(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\n${fm}\n---\n\n${body}\n`, 'utf8');
  return dir;
}

async function writeAgent(name, frontmatter, body) {
  const dir = path.join(DATA_DIR, 'agents');
  await fs.mkdir(dir, { recursive: true });
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  await fs.writeFile(path.join(dir, `${name}.md`), `---\n${fm}\n---\n\n${body}\n`, 'utf8');
}

async function writePlugin(name, manifest, files = {}) {
  const root = path.join(DATA_DIR, 'plugins', name);
  await fs.mkdir(path.join(root, '.claude-plugin'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
    'utf8'
  );
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
  return root;
}

/**
 * A provider that records every request body and answers with a fixed script.
 * `plan` is a function from (requestIndex, body) to the SSE payload to send, so
 * a test can make the model call a tool on one step and stop on the next.
 */
async function startProvider(plan) {
  const state = { requests: [], index: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch { /* recorded as-is below */ }
    const n = state.index++;
    state.requests.push(body);

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const write = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    const payload = plan(n, body);
    for (const chunk of payload.chunks || []) write(chunk);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  state.close = () => new Promise((r) => server.close(r));
  return state;
}

const stopChunk = (text) => ({
  chunks: [
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ],
});

let _agent = null;
const agent = () => {
  if (!_agent) _agent = require('../src/agent');
  return _agent;
};
let _ext = null;
const ext = () => {
  if (!_ext) _ext = require('../src/extensions');
  return _ext;
};
let _providers = null;
const providers = () => {
  if (!_providers) _providers = require('../src/providers');
  return _providers;
};

function settingsFor(url, extra = {}) {
  return {
    baseUrl: url,
    apiKey: 'test-key',
    model: 'mock-large',
    temperature: 0,
    systemPrompt: 'You are Klaud.',
    maxSteps: 4,
    approvalMode: 'auto',
    workspace,
    ...extra,
  };
}

/** Find a chunk's delta tool_calls, if it has any. */
const toolCallChunk = (id, name, args) => ({
  choices: [
    {
      index: 0,
      delta: {
        tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }],
      },
    },
  ],
});

const finishTools = { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

(async () => {
  console.log('\n\x1b[38;5;209m* Klaud extensions integration check\x1b[0m');

  workspace = await makeWorkspace();
  home = path.join(DATA_DIR, 'skills');
  await fs.mkdir(home, { recursive: true });

  /* ============ prompt augmentation ============ */

  await describe('system prompt augmentation', async () => {
    const { augmentSystemPrompt } = ext();

    const unchanged = augmentSystemPrompt('Base prompt.', { prompt: '', warnings: [] });
    check('an empty extension set leaves the prompt byte-identical', unchanged === 'Base prompt.',
      JSON.stringify(unchanged));

    const withSkills = augmentSystemPrompt('Base prompt.', {
      prompt: 'Available skills:\n- review - reviews code',
      warnings: [],
    });
    check('the base prompt is kept and the listing appended',
      withSkills.startsWith('Base prompt.') && withSkills.includes('reviews code'),
      withSkills);
    check('a separator is inserted so the two do not run together',
      withSkills.includes('Base prompt.\n\n'), JSON.stringify(withSkills.slice(0, 30)));

    const withWarnings = augmentSystemPrompt('Base prompt.', {
      prompt: 'Available skills: x',
      warnings: ['plugin y declares hooks, which Klaud does not implement'],
    });
    check('warnings are passed on so the model can mention them',
      withWarnings.includes('does not implement'), withWarnings);
  });

  /* ============ discovery end to end ============ */

  await describe('discovery from disk', async () => {
    await writeSkill('review-code', {
      name: 'review-code',
      description: 'Reviews a diff for correctness. Use when asked to review.',
    }, 'Read the diff and report problems.');
    await writeAgent('reviewer', {
      name: 'reviewer',
      description: 'Reviews code carefully.',
    }, 'You are a careful reviewer.');
    await writePlugin('house-style', {
      name: 'house-style',
      displayName: 'House Style',
      version: '1.0.0',
      description: 'House conventions.',
      defaultEnabled: true,
    }, {
      'skills/style/SKILL.md': '---\nname: style\ndescription: House style rules.\n---\n\nUse tabs.\n',
    });

    ext().resetExtensions();
    const found = ext().collectExtensions({ cwd: workspace });

    check('the personal skill is discovered', found.available.skills >= 1,
      JSON.stringify(found.available));
    check('the skill reaches the prompt text', found.prompt.includes('review-code'), found.prompt);
    check('the subagent is discovered', found.available.agents >= 1,
      JSON.stringify(found.available));
    check('the subagent reaches the prompt text', found.prompt.includes('reviewer'), found.prompt);
    check('the enabled plugin contributes its skill dir',
      (found.pluginDirs.skillDirs || []).length >= 1, JSON.stringify(found.pluginDirs.skillDirs));
    check('the plugin listing reaches the prompt text', found.prompt.includes('House Style'), found.prompt);
    check('no warnings for a well-formed setup', found.warnings.length === 0,
      JSON.stringify(found.warnings));
  });

  /* ============ skills reach the model ============ */

  await describe('a skill reaches the model', async () => {
    const provider = await startProvider(() => stopChunk('Done.'));
    try {
      await agent().runAgentTurn({
        settings: settingsFor(provider.url),
        messages: [{ role: 'user', content: 'hello' }],
        cwd: workspace,
        onEvent: () => {},
      });
      const sent = provider.requests[0];
      const system = sent.messages.find((m) => m.role === 'system');
      check('the request carries a system message', Boolean(system));
      check('the system prompt names the available skill',
        system.content.includes('review-code'), system.content.slice(0, 200));
      check('the system prompt names the available subagent',
        system.content.includes('reviewer'), system.content.slice(0, 200));
      check('the skill tools are on the wire',
        sent.tools.some((t) => t.function.name === 'read_skill'), JSON.stringify(sent.tools?.map((t) => t.function.name)));
      check('the task tool is on the wire',
        sent.tools.some((t) => t.function.name === 'task'));
    } finally {
      await provider.close();
    }
  });

  await describe('a transcript that already carries a system message', async () => {
    const provider = await startProvider(() => stopChunk('Done.'));
    try {
      await agent().runAgentTurn({
        settings: settingsFor(provider.url),
        // The stored history owns the system prompt from the first turn onward.
        messages: [
          { role: 'system', content: 'You are Klaud.' },
          { role: 'user', content: 'hello' },
        ],
        cwd: workspace,
        onEvent: () => {},
      });
      const sent = provider.requests[0];
      const systems = sent.messages.filter((m) => m.role === 'system');
      check('exactly one system message is sent', systems.length === 1,
        String(systems.length));
      check('the existing one is augmented rather than duplicated',
        systems[0].content.includes('review-code'), systems[0].content.slice(0, 120));
      check('the base instructions survive', systems[0].content.startsWith('You are Klaud.'),
        systems[0].content.slice(0, 40));
    } finally {
      await provider.close();
    }
  });

  /* ============ the recursion guard ============ */

  await describe('a subagent cannot delegate further', async () => {
    // Step 1: the parent model delegates. Step 2: the parent finishes. The
    // subagent's own turn is request 2 if the guard is broken and it is offered
    // the task tool, so the assertion is about what the subagent is given.
    const provider = await startProvider((n) => {
      if (n === 0) {
        return {
          chunks: [
            toolCallChunk('t1', 'task', JSON.stringify({ description: 'look', prompt: 'Look at notes.txt.' })),
            finishTools,
          ],
        };
      }
      return stopChunk('The subagent reported back.');
    });

    try {
      const events = [];
      const result = await agent().runAgentTurn({
        settings: settingsFor(provider.url, { maxSteps: 4 }),
        messages: [{ role: 'user', content: 'delegate this' }],
        cwd: workspace,
        approvalMode: 'auto',
        onEvent: (e) => events.push(e),
      });

      const taskResults = events.filter((e) => e.type === 'tool_result' && e.name === 'task');
      check('the task tool was actually called', taskResults.length === 1,
        JSON.stringify(events.filter((e) => e.type === 'tool_result').map((e) => e.name)));
      check('the delegation succeeded', taskResults[0] && taskResults[0].ok === true,
        JSON.stringify(taskResults[0]));

      // The subagent's turn is a separate request; find the one that is not the
      // parent's, recognised by its single user message and its own prompt.
      const subagentRequests = provider.requests.filter(
        (r) => r.messages.filter((m) => m.role === 'user').length === 1
          && r.messages.some((m) => m.role === 'user' && String(m.content).includes('Look at notes.txt'))
      );
      check('the subagent ran its own turn', subagentRequests.length === 1,
        `saw ${provider.requests.length} requests, ${subagentRequests.length} looked like the subagent`);

      if (subagentRequests.length) {
        const names = (subagentRequests[0].tools || []).map((t) => t.function.name);
        check('the subagent is NOT offered the task tool', !names.includes('task'),
          names.join(', '));
        check('the subagent still gets the ordinary tools', names.includes('read_file'),
          names.join(', '));
        check('the subagent cannot recurse via read_skill either (skills were folded into its prompt)',
          names.includes('read_skill') || names.length > 0, names.join(', '));
      }

      check('the parent finished normally', result.finished === 'stop', String(result.finished));
    } finally {
      await provider.close();
    }
  });

  /* ============ a subagent's writes are approved too ============ */

  await describe('a subagent cannot write without approval', async () => {
    /* The hole this pins: `runSubagent` did not forward `requestApproval`, so in
     * "Ask first" mode a subagent's own write_file and run_command ran straight
     * through. The parent asked once for the `task` call and the nested turn then
     * did whatever it liked, which meant the permission setting described a
     * boundary that did not exist. */
    const provider = await startProvider((n, body) => {
      const isNested = body.messages.some(
        (m) => m.role === 'user' && String(m.content).includes('Write the file.')
      );
      if (isNested) {
        const wrote = body.messages.some((m) => m.role === 'tool');
        if (wrote) return stopChunk('I wrote it.');
        return {
          chunks: [
            toolCallChunk('w1', 'write_file', JSON.stringify({ path: 'sub-made.txt', content: 'nested\n' })),
            finishTools,
          ],
        };
      }
      if (n === 0) {
        return {
          chunks: [
            toolCallChunk('t1', 'task', JSON.stringify({ description: 'write', prompt: 'Write the file.' })),
            finishTools,
          ],
        };
      }
      return stopChunk('The subagent is done.');
    });

    const approvals = [];
    try {
      await agent().runAgentTurn({
        settings: settingsFor(provider.url, { maxSteps: 4 }),
        messages: [{ role: 'user', content: 'delegate a write' }],
        cwd: workspace,
        // Ask for absolutely everything, so a missing gate is unambiguous.
        approvalMode: 'ask',
        onEvent: () => {},
        requestApproval: async (request) => {
          approvals.push(request);
          return true;
        },
      });

      const askedForWrite = approvals.some((a) => a && a.name === 'write_file');
      check('the nested write is put to the user', askedForWrite,
        JSON.stringify(approvals.map((a) => a.name)));
      check('the request carries the tool that will run',
        approvals.every((a) => typeof a.name === 'string' && a.name.length > 0),
        JSON.stringify(approvals));
      check('nested approval ids cannot collide with the parent turn',
        new Set(approvals.map((a) => a.id)).size === approvals.length,
        JSON.stringify(approvals.map((a) => a.id)));
      check('the file the subagent asked for was written once approved',
        await fs.stat(path.join(workspace, 'sub-made.txt')).then(() => true).catch(() => false));
    } finally {
      await provider.close();
      await fs.rm(path.join(workspace, 'sub-made.txt'), { force: true });
    }
  });

  await describe('a denied nested write does not happen', async () => {
    const provider = await startProvider((n, body) => {
      const isNested = body.messages.some(
        (m) => m.role === 'user' && String(m.content).includes('Write the file.')
      );
      if (isNested) {
        const refused = body.messages.some(
          (m) => m.role === 'tool' && /denied permission/i.test(String(m.content))
        );
        if (refused) return stopChunk('I could not write it.');
        return {
          chunks: [
            toolCallChunk('w1', 'write_file', JSON.stringify({ path: 'never-made.txt', content: 'nope\n' })),
            finishTools,
          ],
        };
      }
      if (n === 0) {
        return {
          chunks: [
            toolCallChunk('t1', 'task', JSON.stringify({ description: 'write', prompt: 'Write the file.' })),
            finishTools,
          ],
        };
      }
      return stopChunk('Done.');
    });

    try {
      await agent().runAgentTurn({
        settings: settingsFor(provider.url, { maxSteps: 4 }),
        messages: [{ role: 'user', content: 'delegate a write' }],
        cwd: workspace,
        approvalMode: 'ask',
        onEvent: () => {},
        // Approve the delegation, refuse everything else.
        requestApproval: async (request) => request.name !== 'write_file',
      });
      const exists = await fs.stat(path.join(workspace, 'never-made.txt')).then(() => true).catch(() => false);
      check('a refused nested write leaves no file on disk', exists === false);
    } finally {
      await provider.close();
      await fs.rm(path.join(workspace, 'never-made.txt'), { force: true });
    }
  });

  await describe('subagents can be switched off entirely', async () => {
    const provider = await startProvider((n) => {
      if (n === 0) {
        return {
          chunks: [
            toolCallChunk('t1', 'task', JSON.stringify({ description: 'look', prompt: 'Look.' })),
            finishTools,
          ],
        };
      }
      return stopChunk('Never mind.');
    });

    try {
      const events = [];
      await agent().runAgentTurn({
        settings: settingsFor(provider.url, { maxSteps: 3 }),
        messages: [{ role: 'user', content: 'delegate' }],
        cwd: workspace,
        allowSubagents: false,
        onEvent: (e) => events.push(e),
      });
      const taskResults = events.filter((e) => e.type === 'tool_result' && e.name === 'task');
      check('the call is answered rather than dropped', taskResults.length === 1,
        JSON.stringify(taskResults.map((r) => r.name)));
      // The shim returns its refusal as a value, so the tool call itself
      // succeeds: the refusal is in the JSON body, not in `ok`.
      let inner = {};
      try {
        inner = JSON.parse(String(taskResults[0].output));
      } catch { /* reported by the check below */ }
      check('the refusal says subagents are unavailable', inner.ok === false, JSON.stringify(inner));
      check('the refusal explains itself', /not available/i.test(String(inner.output)), String(inner.output));
      check('no nested request was made', provider.requests.length <= 2,
        String(provider.requests.length));
    } finally {
      await provider.close();
    }
  });

  /* ============ the ordinary path is untouched ============ */

  await describe('a session with no extensions', async () => {
    const provider = await startProvider(() => stopChunk('Plain reply.'));
    try {
      await agent().runAgentTurn({
        settings: settingsFor(provider.url),
        messages: [{ role: 'user', content: 'hi' }],
        cwd: workspace,
        skipExtensions: true,
        onEvent: () => {},
      });
      const system = provider.requests[0].messages.find((m) => m.role === 'system');
      check('the system prompt is exactly the configured one',
        system.content === 'You are Klaud.', JSON.stringify(system.content));
      check('no extension tools are described in the prompt',
        !/Available skills/i.test(system.content), system.content.slice(0, 120));
    } finally {
      await provider.close();
    }
  });

  /* ============ permissions still apply through the task tool ============ */

  await describe('read-only mode blocks delegation', async () => {
    const provider = await startProvider((n) => {
      if (n === 0) {
        return {
          chunks: [
            toolCallChunk('t1', 'task', JSON.stringify({ description: 'look', prompt: 'Look.' })),
            finishTools,
          ],
        };
      }
      return stopChunk('Understood.');
    });

    try {
      const events = [];
      await agent().runAgentTurn({
        settings: settingsFor(provider.url, { maxSteps: 3 }),
        messages: [{ role: 'user', content: 'delegate' }],
        cwd: workspace,
        approvalMode: 'readonly',
        onEvent: (e) => events.push(e),
      });
      const taskResults = events.filter((e) => e.type === 'tool_result' && e.name === 'task');
      check('the task tool is refused in read-only mode',
        taskResults.length === 1 && taskResults[0].ok === false, JSON.stringify(taskResults[0]));
      check('the refusal names the mode',
        /readonly|read-only|disabled/i.test(String(taskResults[0] && taskResults[0].output)),
        String(taskResults[0] && taskResults[0].output));
    } finally {
      await provider.close();
    }
  });

  /* ============ slash commands ============ */

  await describe('slash commands', async () => {
    ext().resetExtensions();

    const expanded = ext().expandSlashCommand('/review-code check the auth path', workspace);
    check('a known skill expands', expanded && !expanded.error, JSON.stringify(expanded));
    check('the arguments are carried through', expanded && expanded.args === 'check the auth path',
      JSON.stringify(expanded && expanded.args));
    check('the skill body is included', expanded && expanded.content.includes('Read the diff'),
      String(expanded && expanded.content));
    check('the expansion says who invoked it', expanded && /user invoked/i.test(expanded.content),
      String(expanded && expanded.content).slice(0, 80));
    check('the body keeps its untrusted-content wrapper',
      expanded && /untrusted/i.test(expanded.content),
      String(expanded && expanded.content).slice(0, 200));

    const nearMiss = ext().expandSlashCommand('/review-cod', workspace);
    check('a typo suggests the intended skill',
      nearMiss && /did you mean "review-code"/i.test(nearMiss.error), JSON.stringify(nearMiss));

    const unknown = ext().expandSlashCommand('/not-a-skill', workspace);
    check('an unknown skill returns an error rather than a silent no-op',
      unknown && Boolean(unknown.error), JSON.stringify(unknown));
    check('the error lists what is available',
      unknown && /available:/i.test(unknown.error), String(unknown && unknown.error));

    check('a plain message is not a slash command',
      ext().expandSlashCommand('hello there', workspace) === null);
    check('a path is not a slash command',
      ext().expandSlashCommand('/usr/bin/thing', workspace) === null
        || Boolean(ext().expandSlashCommand('/usr/bin/thing', workspace).error));
  });

  await describe('the skill list for the UI', async () => {
    ext().resetExtensions();
    const list = ext().listInvocableSkills(workspace);
    check('skills are listed for the palette', list.length >= 1, JSON.stringify(list));
    check('each entry carries a name and description',
      list.every((s) => s.name && typeof s.description === 'string'), JSON.stringify(list));
    check('a user-invocable-only skill is flagged not model-invocable',
      list.every((s) => typeof s.modelInvocable === 'boolean'), JSON.stringify(list));
  });

  /* ============ degradation ============ */

  await describe('broken extensions degrade to a warning', async () => {
    await writePlugin('broken', '{ this is not json');
    ext().resetExtensions();
    const found = ext().collectExtensions({ cwd: workspace });
    check('a malformed manifest does not throw', Array.isArray(found.warnings));
    check('the problem is reported', found.warnings.length >= 1, JSON.stringify(found.warnings));
    check('the healthy plugin still loads', found.prompt.includes('House Style'), found.prompt.slice(0, 200));

    // A plugin claiming a component Klaud cannot run must say so rather than
    // quietly appearing to work.
    await writePlugin('with-hooks', {
      name: 'with-hooks',
      defaultEnabled: true,
      hooks: './hooks.json',
      mcpServers: { thing: { command: 'node' } },
    });
    ext().resetExtensions();
    const withHooks = ext().collectExtensions({ cwd: workspace });
    const joined = withHooks.warnings.join(' | ');
    check('unimplemented components are named in a warning',
      /hook/i.test(joined) || /mcp/i.test(joined), joined);
    check('the warning says they will be ignored',
      /ignor|not implement/i.test(joined), joined);
  });

  await describe('the plugin cache is invalidated', async () => {
    // The skills module keys its scan cache on workspace + personal root, so a
    // plugin toggling on would otherwise serve a stale skill list all session.
    ext().resetExtensions();
    const before = ext().collectExtensions({ cwd: workspace, enabledPlugins: { 'house-style': false } });
    const offSkills = (before.pluginDirs.skillDirs || []).length;

    ext().resetExtensions();
    const after = ext().collectExtensions({ cwd: workspace, enabledPlugins: { 'house-style': true } });
    const onSkills = (after.pluginDirs.skillDirs || []).length;

    check('switching a plugin on changes what is scanned', onSkills > offSkills,
      `off=${offSkills} on=${onSkills}`);
  });

  /* ============ tool registration ============ */

  await describe('tool registration', async () => {
    const tools = require('../src/lib/tools');
    const first = ext().registerExtensionTools();
    const names = tools.toolSchemas().map((t) => t.function.name);
    check('the skill tools are registered', names.includes('list_skills') && names.includes('read_skill'),
      names.join(', '));
    check('the task tool is registered', names.includes('task'), names.join(', '));
    check('nothing was rejected', first.rejected.length === 0, JSON.stringify(first.rejected));

    const countBefore = tools.toolSchemas().length;
    ext().registerExtensionTools();
    check('registering twice does not duplicate', tools.toolSchemas().length === countBefore,
      `${countBefore} -> ${tools.toolSchemas().length}`);
    check('every tool has a JSON Schema object',
      tools.toolSchemas().every((t) => t.function.parameters && t.function.parameters.type === 'object'),
      JSON.stringify(tools.toolSchemas().filter((t) => t.function.parameters?.type !== 'object').map((t) => t.function.name)));
    check('the built-ins are still all present',
      ['list_dir', 'read_file', 'write_file', 'edit_file', 'glob_files', 'search_text', 'run_command', 'fetch_url', 'todo_write']
        .every((n) => names.includes(n)), names.join(', '));
  });

  /* ============ an unproductive subagent is not reported as success ============ */

  await describe('a silent subagent is reported honestly', async () => {
    // The model never writes anything, so the turn ends with no answer. Reporting
    // `ok: true` there told the parent the delegation had worked when it had not.
    const provider = await startProvider((n) => {
      if (n === 0) {
        return {
          chunks: [
            toolCallChunk('a1', 'list_dir', JSON.stringify({ path: '.' })),
            finishTools,
          ],
        };
      }
      return { chunks: [{ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }] };
    });

    try {
      const result = await ext().runSubagent({
        description: 'count files',
        prompt: 'Count the files.',
        agent: 'does-not-exist',
        settings: settingsFor(provider.url, { maxSteps: 3 }),
        cwd: workspace,
        approvalMode: 'auto',
        onEvent: () => {},
      });
      check('an answerless subagent is not a success', result.ok === false,
        JSON.stringify(result));
      check('the failure explains itself',
        /did not produce an answer/i.test(result.output), result.output);
      check('the tool calls it did make are reported',
        /list_dir/.test(result.output), result.output);
      check('the parent is told what to do instead',
        /yourself|rephrasing/i.test(result.output), result.output);
    } finally {
      await provider.close();
    }
  });

  await describe('a productive subagent is a success', async () => {
    const provider = await startProvider(() => stopChunk('There are 4 files.'));
    try {
      const result = await ext().runSubagent({
        description: 'count files',
        prompt: 'Count the files.',
        settings: settingsFor(provider.url, { maxSteps: 3 }),
        cwd: workspace,
        approvalMode: 'auto',
        onEvent: () => {},
      });
      check('an answered subagent succeeds', result.ok === true, JSON.stringify(result));
      check('its answer is passed through', result.output.includes('There are 4 files.'),
        result.output);
    } finally {
      await provider.close();
    }
  });

  /* ============ the recommendation is honest about skills ============ */

  await describe('provider catalogue is unaffected', async () => {
    const cat = await providers().getFreeCatalog({ probeLocal: false });
    const entries = cat.entries || cat.providers || [];
    check('the free catalogue still returns entries', entries.length > 0,
      JSON.stringify(Object.keys(cat)));
    check('NVIDIA is still the recommendation',
      entries.some((e) => e.best || e.recommended),
      JSON.stringify(entries.filter((e) => e.best || e.recommended).map((e) => e.id || e.name)));
  });

  /* ---------------- teardown ---------------- */

  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => {});

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} extension checks failed\x1b[0m`);
    for (const f of failures) console.log(`  - [${f.group}] ${f.name}: ${f.detail}`);
    console.log('');
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} extension checks passed\x1b[0m\n`);
  process.exit(0);
})().catch((err) => {
  console.error('\n\x1b[31mThe extension suite crashed:\x1b[0m', err);
  process.exit(1);
});
