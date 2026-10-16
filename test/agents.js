'use strict';

/**
 * Custom subagent definition test.
 *
 *   node test/agents.js
 *
 * Plain-text output, no framework. Covers the YAML-subset frontmatter parser,
 * discovery and shadowing across the three sources, the system-prompt block and
 * the `task` tool definition.
 *
 * Every fixture lives in a throwaway directory under the OS temp directory, and
 * KLAUD_AGENTS_DIR is pointed inside it before the module is used, so the real
 * ~/.klaud is never read or written. That is a hard rule: a test run must not be
 * able to edit somebody's actual subagents.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------------------------------------------------------------ *
 * Output helpers — same shape as the other suites
 * ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

console.log('\n\x1b[38;5;209m* Custom subagent definitions\x1b[0m\n');

/* ------------------------------------------------------------------ *
 * Throwaway world
 * ------------------------------------------------------------------ */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'klaud-agents-test-'));
const personalDir = path.join(root, 'personal-agents');
const projectRoot = path.join(root, 'workspace');
const projectDir = path.join(projectRoot, '.klaud', 'agents');
const pluginDir = path.join(root, 'plugins', 'demo-plugin', 'agents');
const otherPluginDir = path.join(root, 'plugins', 'other-plugin', 'agents');
const emptyDir = path.join(root, 'totally-empty');
// Where a workspace with nothing defined still has to be looked for. Creating it
// only when a fixture needs it is a trap: the directory that does not exist is
// an empty listing, which looks exactly like a fixture that failed to write.
const emptyAgentsDir = path.join(emptyDir, '.klaud', 'agents');

for (const dir of [personalDir, projectDir, pluginDir, otherPluginDir, emptyAgentsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Point "personal" at the sandbox before anything reads it.
const previousAgentsDir = process.env.KLAUD_AGENTS_DIR;
process.env.KLAUD_AGENTS_DIR = personalDir;

const {
  listAgents,
  readAgent,
  agentsForPrompt,
  agentToolDefinition,
  parseFrontmatter,
  personalAgentsDir,
  projectAgentsDir,
} = require('../src/lib/agents');

const write = (dir, file, content) => {
  fs.writeFileSync(path.join(dir, file), content, 'utf8');
  return path.join(dir, file);
};

const warningsOf = (agent) => (agent && Array.isArray(agent.warnings) ? agent.warnings : []);
const hasWarning = (agent, re) => warningsOf(agent).some((w) => re.test(w));
const find = (agents, name) => agents.find((a) => a.name === name);
const base = (cwd = projectRoot, extra = []) => ({ cwd, extra });

/* ------------------------------------------------------------------ *
 * The checks. CommonJS has no top-level await, so the tool's async `run` is
 * exercised inside one async IIFE and the summary follows it.
 * ------------------------------------------------------------------ */

async function runChecks() {

/* ------------------------------------------------------------------ *
 * 1. Frontmatter parsing
 * ------------------------------------------------------------------ */

console.log('\x1b[38;5;245m  frontmatter\x1b[0m');

const everyField = parseFrontmatter(
  [
    '---',
    '# a comment',
    '',
    'name: reviewer',
    'description: "Reviews a diff, carefully."',
    'tools: read_file, glob_files',
    'model: inherit',
    'enabled: true',
    'strict: false',
    'retries: 3',
    'ratio: 1.5',
    'nothing: null',
    'tilde: ~',
    'tags: [fast, small]',
    'extra:',
    '  - one',
    '  - "two"',
    "  - 'three'",
    '---',
    '',
    'Body line one.',
    'Body line two.',
  ].join('\n')
);

check('every field shape is parsed', everyField.data.name === 'reviewer', JSON.stringify(everyField.data));
check('a quoted value loses its quotes and keeps its comma',
  everyField.data.description === 'Reviews a diff, carefully.', String(everyField.data.description));
check('booleans are booleans, not the strings "true"/"false"',
  everyField.data.enabled === true && everyField.data.strict === false,
  `${typeof everyField.data.enabled} / ${typeof everyField.data.strict}`);
check('numbers are numbers',
  everyField.data.retries === 3 && everyField.data.ratio === 1.5,
  `${JSON.stringify(everyField.data.retries)} / ${JSON.stringify(everyField.data.ratio)}`);
check('null and ~ are recognised',
  everyField.data.nothing === null && everyField.data.tilde === null,
  `${JSON.stringify(everyField.data.nothing)} / ${JSON.stringify(everyField.data.tilde)}`);
check('a flow list is a list',
  Array.isArray(everyField.data.tags) && everyField.data.tags.join('|') === 'fast|small',
  JSON.stringify(everyField.data.tags));
check('a block list is a list, and its items are unquoted',
  Array.isArray(everyField.data.extra) && everyField.data.extra.join('|') === 'one|two|three',
  JSON.stringify(everyField.data.extra));
check('comments and blank lines are ignored',
  !('#' in everyField.data) && !Object.keys(everyField.data).some((k) => k.trim() === ''),
  JSON.stringify(Object.keys(everyField.data)));
check('the body is everything after the closing ---',
  everyField.body === 'Body line one.\nBody line two.', JSON.stringify(everyField.body));
check('a clean block produces no warnings', everyField.warnings.length === 0,
  JSON.stringify(everyField.warnings));

const emptyFlow = parseFrontmatter('---\ntools: []\n---\n');
check('an empty flow list is an empty array',
  Array.isArray(emptyFlow.data.tools) && emptyFlow.data.tools.length === 0,
  JSON.stringify(emptyFlow.data.tools));

const singleQuotes = parseFrontmatter("---\ndescription: 'it''s fine'\n---\n");
check('single quotes escape by doubling',
  singleQuotes.data.description === "it's fine", JSON.stringify(singleQuotes.data.description));

const noFrontmatter = parseFrontmatter('Just a body, no frontmatter at all.\n');
check('a file with no frontmatter still yields a usable body and a warning',
  noFrontmatter.hasFrontmatter === false &&
    noFrontmatter.body === 'Just a body, no frontmatter at all.' &&
    noFrontmatter.warnings.length === 0,
  JSON.stringify(noFrontmatter));

/* malformed blocks: a warning, never a throw */
const malformed = [
  ['unclosed frontmatter', '---\nname: reviewer\ndescription: y\n\nbody text\n', true],
  ['unclosed quote', '---\nname: reviewer\ndescription: "never closed\n---\nbody\n', false],
  ['unterminated flow list', '---\nname: reviewer\ntools: [read_file, glob\n---\nbody\n', false],
  ['a line that is not key: value', '---\nname: reviewer\nthis line has no colon\n---\nbody\n', false],
  ['a list item outside any list', '---\nname: reviewer\n- stray\n---\nbody\n', false],
  ['a key repeated', '---\nname: reviewer\nmodel: inherit\nmodel: gpt-4o\n---\nbody\n', false],
  ['trailing comma in a list', '---\nname: reviewer\ntools: [read_file,]\n---\nbody\n', false],
  ['an empty list item', '---\nname: reviewer\ntools:\n  - read_file\n  -\ndescription: d\n---\nbody\n', false],
  ['a key with no value at all', '---\nname: reviewer\nmodel:\ndescription: d\n---\nbody\n', false],
  ['a nested mapping', '---\nname: reviewer\nmeta:\n  owner: team\ndescription: d\n---\nbody\n', false],
  ['indented keys', '---\n  name: reviewer\n  description: d\n---\nbody\n', false],
  ['a stray tab', '---\nname: reviewer\n\tdescription: d\n---\nbody\n', false],
  // Not YAML at all, and full of bytes no parser should trust. The requirement
  // is that it is total, not that it understands this.
  ['binary junk', `---\n\u0000\u0001\u0007 ${'x'.repeat(500)}\nname: reviewer\n---\nbody\n`, false],
];

for (const [label, source, losesName] of malformed) {
  let out;
  let threw = null;
  try {
    out = parseFrontmatter(source);
  } catch (err) {
    threw = err;
  }
  check(`${label} does not throw and reports a warning`,
    !threw && out.warnings.length > 0 && typeof out.body === 'string' && out.data && typeof out.data === 'object',
    threw ? `threw: ${threw.message}` : JSON.stringify(out.warnings));
  // `unclosed frontmatter` yields no keys by design; everything else must keep
  // its valid keys even while complaining about the broken one.
  check(`${label} still parses the valid keys it does have`,
    !threw && (losesName || out.data.name === 'reviewer'),
    threw ? 'threw' : JSON.stringify(out.data));
}

// A file with no frontmatter is not malformed YAML — it is a plain body, and the
// warning about it belongs to discovery, not to the parser.
const bare = parseFrontmatter('Just a body, no frontmatter at all.\n');
check('a body with no frontmatter parses without a spurious warning',
  bare.hasFrontmatter === false && bare.warnings.length === 0 && bare.body === 'Just a body, no frontmatter at all.',
  JSON.stringify(bare));

const valueWithNullByte = parseFrontmatter('---\nname: reviewer\ndescription: a\u0000b\nmodel: inherit\n---\nbody\n');
check('a null byte inside a value is carried through without corrupting the block',
  valueWithNullByte.data.name === 'reviewer' && valueWithNullByte.data.model === 'inherit' &&
    valueWithNullByte.body === 'body',
  JSON.stringify(valueWithNullByte));

const lastWins = parseFrontmatter('---\nmodel: inherit\nmodel: gpt-4o\n---\n');
check('a repeated key keeps the last value and says so',
  lastWins.data.model === 'gpt-4o' && lastWins.warnings.some((w) => /more than once/.test(w)),
  JSON.stringify(lastWins));

const unclosedQuote = parseFrontmatter('---\ndescription: "never closed\n---\n');
check('an unclosed quote keeps the raw text rather than inventing a value',
  unclosedQuote.data.description === '"never closed' && unclosedQuote.warnings.some((w) => /quote/i.test(w)),
  JSON.stringify(unclosedQuote));

/* ------------------------------------------------------------------ *
 * 2. The `task` tool definition
 * ------------------------------------------------------------------ */

console.log('\x1b[38;5;245m  task tool\x1b[0m');

const tool = agentToolDefinition();

check('the tool is named "task", not "agent"', tool.name === 'task', String(tool.name));
check('the tool has the same five keys as src/lib/tools.js entries',
  ['name', 'permission', 'description', 'parameters', 'run'].every((k) => k in tool),
  JSON.stringify(Object.keys(tool)));
check('run is a function and permission is a known mode',
  typeof tool.run === 'function' && ['read', 'write', 'exec'].includes(tool.permission),
  String(tool.permission));

/* a small, strict JSON Schema validator — no schema library, no dependency */
function schemaProblems(node, at = 'parameters') {
  const problems = [];
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return [`${at} is not an object`];
  }
  const TYPES = { object: 'object', array: 'array', string: 'string', boolean: 'boolean', integer: 'number', number: 'number' };
  if (typeof node.type !== 'string' || !(node.type in TYPES)) problems.push(`${at}.type is not a JSON Schema type`);
  if (node.type === 'object') {
    if (!node.properties || typeof node.properties !== 'object' || Array.isArray(node.properties)) {
      problems.push(`${at}.properties is not an object`);
    } else {
      for (const [key, child] of Object.entries(node.properties)) {
        problems.push(...schemaProblems(child, `${at}.properties.${key}`));
      }
    }
    if (!Array.isArray(node.required)) {
      problems.push(`${at}.required is not an array`);
    } else {
      for (const key of node.required) {
        if (!node.properties || !(key in node.properties)) problems.push(`${at}.required names "${key}", which is not a property`);
      }
    }
  }
  if (node.enum !== undefined && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    problems.push(`${at}.enum is empty or not an array`);
  }
  return problems;
}

const problems = schemaProblems(tool.parameters);
check('parameters is a valid JSON Schema object', problems.length === 0, problems.join('; '));
check('parameters.type is "object"', tool.parameters.type === 'object', String(tool.parameters.type));
check('parameters.properties is an object with the three named arguments',
  typeof tool.parameters.properties === 'object' &&
    ['description', 'prompt', 'agent'].every((k) => k in tool.parameters.properties),
  JSON.stringify(Object.keys(tool.parameters.properties || {})));
check('required is an array holding exactly description and prompt',
  Array.isArray(tool.parameters.required) &&
    tool.parameters.required.length === 2 &&
    tool.parameters.required.includes('description') &&
    tool.parameters.required.includes('prompt'),
  JSON.stringify(tool.parameters.required));
check('description and prompt are strings; agent is an optional string',
  tool.parameters.properties.description.type === 'string' &&
    tool.parameters.properties.prompt.type === 'string' &&
    tool.parameters.properties.agent.type === 'string',
  JSON.stringify([tool.parameters.properties.description.type, tool.parameters.properties.prompt.type, tool.parameters.properties.agent.type]));
check('agent is not required', !tool.parameters.required.includes('agent'), JSON.stringify(tool.parameters.required));

/* no ctx.runSubagent: a result, not a throw */
let noRunner;
let noRunnerThrew = null;
try {
  noRunner = await tool.run({ description: 'look', prompt: 'do it' });
} catch (err) {
  noRunnerThrew = err;
}
check('run without ctx.runSubagent returns a result instead of throwing', !noRunnerThrew,
  noRunnerThrew ? `threw: ${noRunnerThrew.message}` : '');
check('run without ctx.runSubagent says subagents are unavailable',
  noRunner && noRunner.ok === false && noRunner.output === 'Subagents are not available in this context.',
  JSON.stringify(noRunner));

const noRunnerWithCtx = await tool.run({ description: 'd', prompt: 'p' }, { cwd: projectRoot });
check('a ctx that merely exists, without the runner, is still handled',
  noRunnerWithCtx.ok === false && /not available/.test(noRunnerWithCtx.output),
  JSON.stringify(noRunnerWithCtx));

/* with a runner: called through, with exactly the right arguments */
const calls = [];
const fakeRunner = async (payload) => {
  calls.push(payload);
  return { ok: true, output: 'the subagent report' };
};

const withRunner = await tool.run(
  { description: 'Review the diff', prompt: 'Read src/a.js and list real bugs.', agent: 'reviewer' },
  { cwd: projectRoot, runSubagent: fakeRunner }
);
check('run calls ctx.runSubagent exactly once', calls.length === 1, `${calls.length} call(s)`);
check('run passes description, prompt and agent through unchanged',
  calls[0] && calls[0].description === 'Review the diff' &&
    calls[0].prompt === 'Read src/a.js and list real bugs.' && calls[0].agent === 'reviewer',
  JSON.stringify(calls[0]));
check('run adds nothing else to the runner payload',
  calls[0] && Object.keys(calls[0]).sort().join(',') === 'agent,description,prompt',
  JSON.stringify(Object.keys(calls[0] || {})));
check('run returns { ok, output } from the runner',
  withRunner.ok === true && withRunner.output === 'the subagent report',
  JSON.stringify(withRunner));

calls.length = 0;
const withoutAgent = await tool.run({ description: 'd', prompt: 'p' }, { runSubagent: fakeRunner });
check('an omitted agent is passed as an empty string, not undefined',
  calls[0] && calls[0].agent === '', JSON.stringify(calls[0]));
check('an omitted agent still runs', withoutAgent.ok === true, JSON.stringify(withoutAgent));

calls.length = 0;
const noPrompt = await tool.run({ description: 'd' }, { runSubagent: fakeRunner });
check('a missing prompt is refused before the runner is called',
  calls.length === 0 && noPrompt.ok === false && /prompt/.test(noPrompt.output),
  JSON.stringify(noPrompt));

const failing = await tool.run(
  { description: 'd', prompt: 'p' },
  { runSubagent: async () => ({ ok: false, output: 'subagent hit its step limit' }) }
);
check('a failing runner result stays a failure, with its output intact',
  failing.ok === false && failing.output === 'subagent hit its step limit', JSON.stringify(failing));

const throwing = await tool.run(
  { description: 'd', prompt: 'p' },
  {
    runSubagent: async () => {
      throw new Error('runner exploded');
    },
  }
);
check('a runner that throws surfaces the message instead of crashing the turn',
  throwing.ok === false && /runner exploded/.test(throwing.output), JSON.stringify(throwing));

const stringRunner = await tool.run({ description: 'd', prompt: 'p' }, { runSubagent: async () => 'plain text' });
check('a runner returning a plain string is accepted', stringRunner.ok === true && stringRunner.output === 'plain text',
  JSON.stringify(stringRunner));

const enumTool = agentToolDefinition(['alpha', 'beta']);
check('known names become the agent enum',
  Array.isArray(enumTool.parameters.properties.agent.enum) &&
    enumTool.parameters.properties.agent.enum.join('|') === 'alpha|beta',
  JSON.stringify(enumTool.parameters.properties.agent.enum));
check('an enum-bearing schema is still valid JSON Schema', schemaProblems(enumTool.parameters).length === 0,
  schemaProblems(enumTool.parameters).join('; '));
check('junk passed where names belong does not produce a broken enum',
  agentToolDefinition([null, '', 42, 'ok']).parameters.properties.agent.enum.join('|') === '42|ok',
  JSON.stringify(agentToolDefinition([null, '', 42, 'ok']).parameters.properties.agent.enum));

/* ------------------------------------------------------------------ *
 * 3. Discovery: project and personal, and shadowing
 * ------------------------------------------------------------------ */

console.log('\x1b[38;5;245m  discovery\x1b[0m');

write(personalDir, 'reviewer.md', [
  '---',
  'name: reviewer',
  'description: Personal reviewer.',
  'tools: read_file glob_files',
  'model: inherit',
  '---',
  '',
  'You are a careful personal reviewer.',
].join('\n'));

write(personalDir, 'personal-only.md', [
  '---',
  'description: A personal-only agent.',
  '---',
  '',
  'Personal body.',
].join('\n'));

write(projectDir, 'reviewer.md', [
  '---',
  'name: reviewer',
  'description: Project reviewer, which must win.',
  'model: gpt-4o-mini',
  '---',
  '',
  'You are the project reviewer.',
].join('\n'));

write(projectDir, 'not-a-definition.txt', 'ignored, wrong extension');

const discovered = listAgents(projectRoot);
const names = discovered.map((a) => a.name);

check('agents are sorted by name',
  names.join('|') === [...names].sort((a, b) => a.localeCompare(b)).join('|'),
  names.join(', '));
check('both the project and the personal directory are discovered',
  names.includes('reviewer') && names.includes('personal-only'), names.join(', '));
check('only .md files are considered', !names.includes('not-a-definition'), names.join(', '));
check('a list entry carries name, description, tools, model, dir, source and warnings',
  ['name', 'description', 'tools', 'model', 'dir', 'source', 'warnings'].every((k) => k in discovered[0]),
  JSON.stringify(Object.keys(discovered[0] || {})));
check('the project definition shadows the personal one',
  find(discovered, 'reviewer').description === 'Project reviewer, which must win.',
  String(find(discovered, 'reviewer').description));
check('the shadowed definition is reported on the winner',
  hasWarning(find(discovered, 'reviewer'), /personal/i) &&
    /personal/i.test(warningsOf(find(discovered, 'reviewer')).join(' ')),
  JSON.stringify(warningsOf(find(discovered, 'reviewer'))));
check('source is "project" for the workspace directory and "personal" otherwise',
  find(discovered, 'reviewer').source === 'project' &&
    find(discovered, 'personal-only').source === 'personal',
  `${find(discovered, 'reviewer').source} / ${find(discovered, 'personal-only').source}`);
check('dir is the absolute directory the definition came from',
  find(discovered, 'reviewer').dir === projectDir && find(discovered, 'personal-only').dir === personalDir,
  `${find(discovered, 'reviewer').dir} / ${find(discovered, 'personal-only').dir}`);
check('a definition with no name field takes its name from the filename',
  find(discovered, 'personal-only').name === 'personal-only' &&
    find(discovered, 'personal-only').description === 'A personal-only agent.',
  JSON.stringify(find(discovered, 'personal-only')));
check('model defaults to inherit', find(discovered, 'reviewer').tools.length === 0 ||
  find(discovered, 'reviewer').model === 'gpt-4o-mini', String(find(discovered, 'reviewer').model));
check('the project model value was read',
  find(discovered, 'reviewer').model === 'gpt-4o-mini', String(find(discovered, 'reviewer').model));
check('the personal directory really is the temp sandbox, not the real home',
  personalAgentsDir() === personalDir && !personalAgentsDir().includes(path.join(os.homedir(), '.klaud')),
  personalAgentsDir());
check('the project directory is <cwd>/.klaud/agents',
  projectAgentsDir(projectRoot) === projectDir, projectAgentsDir(projectRoot));

/* ------------------------------------------------------------------ *
 * 4. tools: all three accepted shapes
 * ------------------------------------------------------------------ */

console.log('\x1b[38;5;245m  tools field\x1b[0m');

write(projectDir, 'tools-space.md', '---\ndescription: space separated\ntools: read_file glob_files search_text\n---\nbody\n');
write(projectDir, 'tools-comma.md', '---\ndescription: comma separated\ntools: read_file, glob_files,search_text\n---\nbody\n');
write(projectDir, 'tools-list.md', '---\ndescription: yaml list\ntools: [read_file, glob_files, search_text]\n---\nbody\n');
write(projectDir, 'tools-block.md', '---\ndescription: block list\ntools:\n  - read_file\n  - glob_files\n---\nbody\n');
write(projectDir, 'tools-none.md', '---\ndescription: no tools key\n---\nbody\n');
write(projectDir, 'tools-trailing.md', '---\ndescription: trailing comma\ntools: read_file,\n---\nbody\n');

const toolAgents = listAgents(projectRoot);
const toolsOf = (name) => (find(toolAgents, name) || {}).tools || [];
const EXPECTED = ['read_file', 'glob_files', 'search_text'];

check('tools as a space-separated string', toolsOf('tools-space').join('|') === EXPECTED.join('|'),
  JSON.stringify(toolsOf('tools-space')));
check('tools as a comma-separated string, with and without spaces',
  toolsOf('tools-comma').join('|') === EXPECTED.join('|'), JSON.stringify(toolsOf('tools-comma')));
check('tools as a YAML flow list', toolsOf('tools-list').join('|') === EXPECTED.join('|'),
  JSON.stringify(toolsOf('tools-list')));
check('tools as a YAML block list', toolsOf('tools-block').join('|') === 'read_file|glob_files',
  JSON.stringify(toolsOf('tools-block')));
check('a missing tools key is an empty array, meaning no restriction',
  Array.isArray(toolsOf('tools-none')) && toolsOf('tools-none').length === 0,
  JSON.stringify(toolsOf('tools-none')));
check('a trailing comma does not become an empty tool name',
  toolsOf('tools-trailing').join('|') === 'read_file', JSON.stringify(toolsOf('tools-trailing')));
check('a trailing comma is warned about',
  hasWarning(find(toolAgents, 'tools-trailing'), /comma/i),
  JSON.stringify(warningsOf(find(toolAgents, 'tools-trailing'))));

/* ------------------------------------------------------------------ *
 * 5. extraDirs: plugin agents
 * ------------------------------------------------------------------ */

console.log('\x1b[38;5;245m  plugins via extraDirs\x1b[0m');

write(pluginDir, 'doc-writer.md', [
  '---',
  'name: doc-writer',
  'description: Writes documentation from source.',
  'tools: read_file write_file',
  '---',
  '',
  'You write docs. Read the source first.',
].join('\n'));

write(pluginDir, 'reviewer.md', [
  '---',
  'name: reviewer',
  'description: A plugin reviewer that must lose to the project one.',
  '---',
  'Plugin body.',
].join('\n'));

write(otherPluginDir, 'other-agent.md', '---\ndescription: From a second plugin.\n---\nOther body.\n');

const withoutExtras = listAgents(projectRoot);
check('a plugin directory is not scanned on its own',
  !withoutExtras.some((a) => a.name === 'doc-writer'), withoutExtras.map((a) => a.name).join(', '));

const withExtras = listAgents(projectRoot, [pluginDir, otherPluginDir]);
check('extraDirs are scanned', withExtras.some((a) => a.name === 'doc-writer'),
  withExtras.map((a) => a.name).join(', '));
check('a plugin agent is reported as source "plugin"',
  find(withExtras, 'doc-writer').source === 'plugin', String(find(withExtras, 'doc-writer').source));
check('a plugin agent keeps its own directory',
  find(withExtras, 'doc-writer').dir === pluginDir, String(find(withExtras, 'doc-writer').dir));
check('a plugin agent body is available through readAgent',
  (() => {
    const result = readAgent('doc-writer', projectRoot, [pluginDir]);
    return result.ok && /Read the source first/.test(result.agent.body);
  })(), JSON.stringify(readAgent('doc-writer', projectRoot, [pluginDir]).error || ''));
check('several extraDirs are all scanned',
  withExtras.some((a) => a.name === 'other-agent'), withExtras.map((a) => a.name).join(', '));
check('project wins over a plugin of the same name',
  find(withExtras, 'reviewer').source === 'project' &&
    /plugin/i.test(warningsOf(find(withExtras, 'reviewer')).join(' ')),
  `${find(withExtras, 'reviewer').source}: ${JSON.stringify(warningsOf(find(withExtras, 'reviewer')))}`);
check('a non-existent extraDir is ignored without throwing',
  Array.isArray(listAgents(projectRoot, [path.join(root, 'no-such-plugin')])),
  'threw');
check('a junk entry in extraDirs is ignored without throwing',
  Array.isArray(listAgents(projectRoot, [null, '', 42, {}])), 'threw');
check('the same directory listed twice does not duplicate agents',
  listAgents(projectRoot, [pluginDir, pluginDir]).filter((a) => a.name === 'doc-writer').length === 1,
  String(listAgents(projectRoot, [pluginDir, pluginDir]).filter((a) => a.name === 'doc-writer').length));
check('a relative extraDir is resolved rather than silently skipped',
  listAgents(projectRoot, [path.relative(process.cwd(), pluginDir)]).some((a) => a.name === 'doc-writer'),
  path.relative(process.cwd(), pluginDir));

/* ------------------------------------------------------------------ *
 * 6. Names and descriptions that must be rejected or warned about
 * ------------------------------------------------------------------ */

console.log('\x1b[38;5;245m  names and descriptions\x1b[0m');

write(projectDir, 'junk name.md', '---\ndescription: filename is not a slug\n---\nbody\n');
write(projectDir, 'UPPER.md', '---\ndescription: uppercase filename\n---\nbody\n');
write(projectDir, '--two-lead.md', '---\ndescription: starts with a hyphen\n---\nbody\n');
write(projectDir, 'a'.repeat(80) + '.md', '---\ndescription: filename is far too long\n---\nbody\n');
write(projectDir, 'ok-name.md', '---\nname: Not A Slug\ndescription: frontmatter name is not a slug\n---\nbody\n');
write(projectDir, 'empty-name.md', '---\nname: ""\ndescription: empty name falls back to the filename\n---\nbody\n');
write(projectDir, 'no-description.md', '---\nname: no-description\n---\nbody\n');
write(projectDir, 'unknown-keys.md', [
  '---',
  'name: unknown-keys',
  'description: has keys Klaud does not know',
  'colour: blue',
  'retries: 3',
  '---',
  'body',
].join('\n'));
// A definition with no frontmatter at all: a plain body is a legitimate file,
// even if it is a poor one. It goes in the workspace's own agents directory —
// a definition dropped in the workspace root is not an agent.
write(emptyAgentsDir, 'bare.md', 'No frontmatter, just a body.\n');

const named = listAgents(projectRoot);
const namedList = named.map((a) => a.name);

check('a frontmatter name that is not a slug is rejected, not silently renamed',
  find(named, 'ok-name') === undefined && find(named, 'Not A Slug') === undefined, namedList.join(', '));
check('a filename slug is accepted even though the frontmatter name in that file is not',
  namedList.includes('empty-name'), namedList.join(', '));
check('a rejection is not listed as an agent with a warning — it is not listed at all',
  !named.some((a) => /Not A Slug/i.test(a.name)), namedList.join(', '));
check('a filename that is not a slug is skipped rather than listed',
  !namedList.includes('junk name') && !namedList.includes('junk-name'),
  namedList.join(', '));
check('an uppercase filename is skipped', !namedList.includes('UPPER') && !namedList.includes('upper'),
  namedList.join(', '));
check('a filename starting with a separator is skipped', !namedList.includes('--two-lead'),
  namedList.join(', '));
check('an over-long filename is skipped', !namedList.some((n) => n.length > 64),
  JSON.stringify(namedList.filter((n) => n.length > 64)));
check('a rejected file is reported in the listing warnings, not silently dropped',
  (() => {
    const listed = listAgents(projectRoot);
    const all = [...listed.warnings, ...listed.flatMap((a) => a.warnings)].join(' | ');
    return /junk name\.md/.test(all) && /ok-name\.md/.test(all);
  })(), JSON.stringify(listAgents(projectRoot).warnings));
check('an empty name falls back to the filename slug',
  namedList.includes('empty-name') && find(named, 'empty-name').description.startsWith('empty name falls back'),
  JSON.stringify(find(named, 'empty-name') || {}));
check('a missing description is a warning, not an error',
  find(named, 'no-description') !== undefined &&
    find(named, 'no-description').description === '' &&
    hasWarning(find(named, 'no-description'), /description/i),
  JSON.stringify(find(named, 'no-description')));
check('a file with no frontmatter at all is still usable, with warnings',
  (() => {
    const agent = find(listAgents(emptyDir, []), 'bare');
    return Boolean(agent) && hasWarning(agent, /frontmatter/i) && hasWarning(agent, /description/i) &&
      /No frontmatter/.test(agent.body);
  })(), JSON.stringify(listAgents(emptyDir).map((a) => ({ n: a.name, w: a.warnings }))));
check('unknown frontmatter keys are kept and warned about, not fatal',
  find(named, 'unknown-keys') !== undefined &&
    find(named, 'unknown-keys').frontmatter.colour === 'blue' &&
    hasWarning(find(named, 'unknown-keys'), /unknown frontmatter key "colour"/) &&
    hasWarning(find(named, 'unknown-keys'), /"retries"/),
  JSON.stringify(warningsOf(find(named, 'unknown-keys'))));
check('an unknown key does not stop the known fields being read',
  find(named, 'unknown-keys').description === 'has keys Klaud does not know',
  String(find(named, 'unknown-keys').description));
check('every listed agent has a warnings array',
  named.every((a) => Array.isArray(a.warnings)), JSON.stringify(named.filter((a) => !Array.isArray(a.warnings)).map((a) => a.name)));
check('a directory that does not exist yields an empty listing, not a throw',
  (() => {
    const listed = withNoAgentsAnywhere(() => listAgents(path.join(root, 'no-such-workspace')));
    return Array.isArray(listed) && listed.length === 0;
  })(), 'threw or found agents');

/* ------------------------------------------------------------------ *
 * 7. readAgent
 * ------------------------------------------------------------------ */

console.log('\x1b[38;5;245m  readAgent\x1b[0m');

const readOk = readAgent('reviewer', projectRoot);
check('readAgent returns { ok: true, agent } with the body',
  readOk.ok === true && readOk.agent && /project reviewer/.test(readOk.agent.body),
  JSON.stringify(readOk.ok === true ? readOk.agent.body : readOk));
check('the returned agent carries its metadata alongside the body',
  readOk.ok && readOk.agent.name === 'reviewer' && readOk.agent.source === 'project' && readOk.agent.dir === projectDir,
  JSON.stringify({ name: readOk.agent && readOk.agent.name, source: readOk.agent && readOk.agent.source }));

const typo = readAgent('reviwer', projectRoot);
check('a typo returns { ok: false, error }', typo.ok === false && typeof typo.error === 'string',
  JSON.stringify(typo));
check('a typo error suggests the nearest name',
  typo.ok === false && /Did you mean "reviewer"\?/.test(typo.error), String(typo.ok === false ? typo.error : ''));
check('a typo error lists what is available',
  typo.ok === false && /Available:/.test(typo.error) && /"reviewer"/.test(typo.error),
  String(typo.ok === false ? typo.error : ''));
check('a typo error says where it looked',
  typo.ok === false && typo.error.includes(projectDir) && typo.error.includes(personalDir),
  String(typo.ok === false ? typo.error : ''));

const missing = readAgent('totally-unrelated-xyz', projectRoot);
check('an unrelated missing name still gives an actionable error',
  missing.ok === false && /No subagent named/.test(missing.error) && /Add one as a markdown file/.test(missing.error),
  String(missing.ok === false ? missing.error : ''));
check('an unrelated missing name does not invent a suggestion',
  missing.ok === false && !/Did you mean/.test(missing.error), String(missing.ok === false ? missing.error : ''));
check('a short typo of a long name still matches',
  (() => {
    const r = readAgent('personal', projectRoot);
    return r.ok === false && /Did you mean "personal-only"/.test(r.error);
  })(), JSON.stringify(readAgent('personal', projectRoot)));
check('readAgent reads a plugin agent when handed the plugin directory',
  readAgent('doc-writer', projectRoot, [pluginDir]).ok === true,
  JSON.stringify(readAgent('doc-writer', projectRoot, [pluginDir])));
/* The "nothing is defined anywhere" cases need a directory that holds no agents
   of its own *and* the personal directory taken out of the picture, or the
   sandbox's own agents answer for it. */
const nothingDir = path.join(root, 'nothing-defined-here');

function withNoAgentsAnywhere(fn) {
  const saved = process.env.KLAUD_AGENTS_DIR;
  process.env.KLAUD_AGENTS_DIR = path.join(root, 'no-personal-agents-here');
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.KLAUD_AGENTS_DIR;
    else process.env.KLAUD_AGENTS_DIR = saved;
  }
}

check('readAgent on a workspace with nothing defined explains that, and where to put a file',
  (() => {
    const r = withNoAgentsAnywhere(() => readAgent('anything', nothingDir, []));
    return r.ok === false && /No subagents are defined yet/.test(r.error) && /Add one as a markdown file/.test(r.error);
  })(), JSON.stringify(withNoAgentsAnywhere(() => readAgent('anything', nothingDir, [])).error));
check('readAgent with a null name does not throw',
  (() => {
    const r = readAgent(null, projectRoot);
    return r.ok === false && typeof r.error === 'string';
  })(), 'threw');
check('readAgent with a missing cwd does not throw',
  (() => {
    const r = readAgent('reviewer', undefined);
    return r.ok === false || r.ok === true;
  })(), 'threw');

/* ------------------------------------------------------------------ *
 * 8. agentsForPrompt
 * ------------------------------------------------------------------ */

console.log('\x1b[38;5;245m  agentsForPrompt\x1b[0m');

const emptyPrompt = withNoAgentsAnywhere(() => agentsForPrompt(nothingDir, [path.join(root, 'no-such-plugin')]));
check('no agents at all returns exactly an empty string', emptyPrompt === '', JSON.stringify(emptyPrompt));

const prompt = agentsForPrompt(projectRoot, [pluginDir]);
check('the prompt block is produced when agents exist', prompt.length > 0, `${prompt.length} chars`);
check('it stays under the 1500 character cap', prompt.length <= 1500, `${prompt.length} chars`);
check('it names the task tool', /\btask\b/.test(prompt), prompt.slice(0, 200));
check('it tells the model to choose by description',
  /description/i.test(prompt) && /delegate/i.test(prompt), prompt.slice(0, 200));
check('every agent gets one line, "name — description"',
  /^- reviewer — Project reviewer, which must win\.$/m.test(prompt) &&
    /^- doc-writer — Writes documentation from source\.$/m.test(prompt),
  prompt);
check('a plugin agent supplied through extraDirs is listed too', /doc-writer/.test(prompt), prompt);
check('an agent with no description still gets a line', /no-description/.test(prompt), prompt);
check('there is exactly one line per agent plus a header',
  prompt.split('\n').length === listAgents(projectRoot, [pluginDir]).length + 1,
  `${prompt.split('\n').length} lines`);

/* overflow: many agents with long descriptions */
const floodDir = path.join(root, 'flood-agents');
fs.mkdirSync(floodDir, { recursive: true });
for (let i = 0; i < 40; i++) {
  write(floodDir, `flood-${String(i).padStart(2, '0')}.md`,
    `---\ndescription: ${'A long description of the task this agent performs. '.repeat(3)}\n---\nbody\n`);
}
const flooded = agentsForPrompt(projectRoot, [floodDir]);
check('an overflowing list is still capped at 1500 characters', flooded.length <= 1500, `${flooded.length} chars`);
check('an overflowing list says how many were omitted',
  /more not listed/.test(flooded) && /and \d+ more not listed\./.test(flooded),
  flooded.slice(-160));
check('the omitted count is accurate', (() => {
  const total = listAgents(projectRoot, [floodDir]).length;
  const shown = (flooded.match(/^- /gm) || []).length;
  const claimed = Number((/and (\d+) more not listed/.exec(flooded) || [])[1]);
  return Number.isFinite(claimed) && shown + claimed === total;
})(), `${(flooded.match(/^- /gm) || []).length} shown of ${listAgents(projectRoot, [floodDir]).length}: ${flooded.slice(-120)}`);
check('a tiny cap is respected rather than overflowing',
  agentsForPrompt(projectRoot, [floodDir], 320).length <= 320,
  String(agentsForPrompt(projectRoot, [floodDir], 320).length));
check('a cap too small for even one line still returns a string within it',
  agentsForPrompt(projectRoot, [floodDir], 40).length <= 40,
  JSON.stringify(agentsForPrompt(projectRoot, [floodDir], 40)));

/* ------------------------------------------------------------------ *
 * 9. The sandbox was never escaped
 * ------------------------------------------------------------------ */

console.log('\x1b[38;5;245m  isolation\x1b[0m');

const touched = [
  ...listAgents(projectRoot, [pluginDir]).map((a) => a.dir),
  readAgent('reviewer', projectRoot).agent.dir,
];
const realKlaud = path.join(os.homedir(), '.klaud');
check('every directory this module reported is inside the temp sandbox',
  touched.length > 0 && touched.every((dir) => dir.startsWith(root)),
  JSON.stringify(touched));
check('nothing ever pointed at the real ~/.klaud',
  touched.every((dir) => !dir.startsWith(realKlaud)) && !personalAgentsDir().startsWith(realKlaud),
  JSON.stringify(touched));

}

/* ------------------------------------------------------------------ *
 * Teardown, then the summary. Awaited so the temp world outlives every check.
 * ------------------------------------------------------------------ */

(async () => {
  await runChecks();

  if (previousAgentsDir === undefined) delete process.env.KLAUD_AGENTS_DIR;
  else process.env.KLAUD_AGENTS_DIR = previousAgentsDir;

  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // A locked temp file on Windows is not a test failure.
  }

  console.log('');
  if (fail) {
    console.log(`\x1b[31mx ${fail} of ${pass + fail} subagent checks failed\x1b[0m\n`);
    process.exit(1);
  }
  console.log(`\x1b[32m+ all ${pass} subagent checks passed\x1b[0m\n`);
})().catch((err) => {
  // A throw here is a bug in the module or the suite; report it as a failure
  // rather than a bare stack trace, and still exit non-zero.
  console.log(`  \x1b[31mx\x1b[0m the suite threw: ${err && err.stack ? err.stack : err}`);
  console.log(`\n\x1b[31mx ${fail + 1} of ${pass + fail + 1} subagent checks failed\x1b[0m\n`);
  process.exit(1);
});
