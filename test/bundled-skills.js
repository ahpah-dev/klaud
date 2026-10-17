'use strict';

/**
 * Klaud bundled skills suite - no framework, no dependencies.
 *
 *   node test/bundled-skills.js
 *
 * The five SKILL.md files under src/lib/skills-bundled ship with Klaud, so this
 * suite checks the shipped text rather than a fixture: that they parse, that
 * they are discoverable as the third source, that a project or personal skill
 * still wins over them, and - the check that matters most as tools change - that
 * every tool they tell the model to call actually exists in the registry.
 *
 * Every fixture lives in a throwaway directory: the personal skills root is
 * redirected with KLAUD_DATA_DIR before src/lib/skills is required, so this suite
 * can never read or write the real ~/.klaud.
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect the personal skills directory before anything loads config.js.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'klaud-bundled-'));
process.env.KLAUD_DATA_DIR = path.join(TMP, 'dot-klaud');

const {
  listSkills,
  readSkill,
  findSkill,
  clearSkillCache,
  skillsForPrompt,
  parseSlashCommand,
  bundledSkillsDir,
  personalSkillsDir,
} = require('../src/lib/skills');

/* ------------------------------------------------------------------ *
 * Tiny harness: same shape and colours as test/skills.js.
 * ------------------------------------------------------------------ */

const results = { pass: 0, fail: 0 };
const failures = [];
let group = '';

function describe(name, fn) {
  group = name;
  process.stdout.write(`\n  \x1b[1m${name}\x1b[0m\n`);
  return fn();
}

async function it(name, fn) {
  try {
    await fn();
    results.pass++;
    process.stdout.write(`    \x1b[32m+\x1b[0m ${name}\n`);
  } catch (err) {
    results.fail++;
    failures.push({ group, name, err });
    process.stdout.write(`    \x1b[31mx\x1b[0m ${name}\n        ${String(err.message).split('\n')[0]}\n`);
  }
}

/* ------------------------------------------------------------------ *
 * Fixtures and helpers
 * ------------------------------------------------------------------ */

/** The names the product ships. Discovery is expected to find exactly these. */
const BUNDLED = ['browser', 'code-review', 'computer-use', 'debug-failing-test', 'web-research'];

/** Every tool name Klaud can actually offer, per the task that wrote the skills. */
const EXPECTED_TOOLS = [
  'list_dir',
  'read_file',
  'write_file',
  'edit_file',
  'glob_files',
  'search_text',
  'run_command',
  'fetch_url',
  'todo_write',
  'list_skills',
  'read_skill',
  'task',
  'browser_goto',
  'browser_read',
  'browser_click',
  'browser_type',
  'browser_screenshot',
  'browser_eval',
  'browser_close',
];

/** An empty workspace, so no project skills leak into a listing. */
let workspaceCount = 0;
function newWorkspace() {
  workspaceCount++;
  const dir = path.join(TMP, `ws-${workspaceCount}`);
  fs.mkdirSync(dir, { recursive: true });
  clearSkillCache();
  return dir;
}

function writeSkill(root, dirName, fields, body) {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const frontmatter = Object.keys(fields)
    .map((key) => `${key}: ${fields[key]}`)
    .join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body || `Body of ${dirName}.`}\n`, 'utf8');
  clearSkillCache();
  return dir;
}

/**
 * The body of a SKILL.md exactly as shipped: everything after the frontmatter
 * block. Read from disk rather than through readSkill, so the tool-name check
 * inspects the instructions and not the untrusted-content wrapper around them.
 */
function shippedBody(skill) {
  const text = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8').replace(/^\ufeff/, '');
  const lines = text.split(/\r\n|\n|\r/);
  assert.equal(lines[0].trim(), '---', `${skill.dir}: SKILL.md must start with a --- line`);
  const close = lines.indexOf('---', 1);
  assert.ok(close > 0, `${skill.dir}: frontmatter is never closed`);
  return lines.slice(close + 1).join('\n');
}

/**
 * Prose only: fenced code blocks are removed before looking for tool names.
 * The bodies legitimately contain PowerShell and C# (mouse_event, KEYEVENTF_*,
 * GetWindowThreadProcessId), and those are API calls, not Klaud tools. What the
 * model is told to *call* appears in prose and in single backticks.
 */
function proseOf(body) {
  return body.replace(/```[\s\S]*?```/g, ' ');
}

/** snake_case tokens: the shape every Klaud tool name has. */
const TOOL_LIKE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * The real tool catalogue: the built-ins plus what each module contributes. This
 * is the registry the agent loop advertises to the model, not a copy of a list.
 */
function toolCatalogue() {
  const { registerTools, allTools } = require('../src/lib/tools');
  const { skillToolDefinitions } = require('../src/lib/skills');
  const { browserToolDefinitions } = require('../src/lib/browser/tools');
  const { agentToolDefinition } = require('../src/lib/agents');
  registerTools([...skillToolDefinitions(), ...browserToolDefinitions(), agentToolDefinition()]);
  return new Set(allTools().map((tool) => tool.name));
}

const wsBundled = newWorkspace();
const wsEmptyRoot = newWorkspace();

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

async function discoverySuite() {
  await describe('bundled source discovery', async () => {
    await it('resolves the bundled directory inside the source tree', () => {
      const dir = bundledSkillsDir();
      assert.equal(path.basename(dir), 'skills-bundled');
      assert.equal(path.resolve(dir), path.join(path.resolve(__dirname, '..', 'src', 'lib'), 'skills-bundled'));
      assert.ok(fs.existsSync(dir), `${dir} should exist in the source tree`);
    });

    await it('finds exactly the five bundled skills, each with source "bundled"', () => {
      const listed = listSkills(wsBundled);
      assert.deepEqual(
        listed.map((skill) => skill.name),
        BUNDLED
      );
      assert.deepEqual(
        listed.map((skill) => skill.source),
        BUNDLED.map(() => 'bundled')
      );
      for (const skill of listed) {
        assert.ok(
          path.resolve(skill.dir).startsWith(path.resolve(bundledSkillsDir()) + path.sep),
          `${skill.name} should live under ${bundledSkillsDir()}`
        );
        // The resolved entry, not the listing, carries the file path.
        assert.equal(findSkill(skill.name, wsBundled).file, path.join(skill.dir, 'SKILL.md'));
      }
    });

    await it('lists them for the prompt and the menu like any other source', () => {
      const text = skillsForPrompt(wsBundled);
      assert.match(text, /call read_skill/);
      for (const name of BUNDLED) {
        assert.ok(text.includes(`- ${name} - `), `${name} should appear in the prompt listing`);
      }
      // The menu is built from the same listing, so a bundled skill must be there too.
      const { listInvocableSkills } = require('../src/extensions');
      const menu = listInvocableSkills(wsBundled);
      assert.deepEqual(menu.map((entry) => entry.name), BUNDLED);
      assert.deepEqual(
        menu.map((entry) => entry.source),
        BUNDLED.map(() => 'bundled')
      );
    });
  });
}

/* ------------------------------------------------------------------ *
 * The shipped frontmatter
 * ------------------------------------------------------------------ */

async function frontmatterSuite() {
  await describe('shipped frontmatter', async () => {
    await it('gives every bundled skill a slug name, a description and no warnings', () => {
      for (const skill of listSkills(wsBundled)) {
        assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${skill.dir}: name "${skill.name}" is not a slug`);
        assert.equal(skill.description.length > 0, true, `${skill.name} has no description`);
        assert.ok(skill.description.length <= 400, `${skill.name}: description is longer than the listing cap`);
        assert.deepEqual(skill.warnings, [], `${skill.name} parsed with warnings`);
        assert.equal(skill.userInvocableOnly, false, `${skill.name} should be model-invocable`);
        assert.equal(skill.name, path.basename(skill.dir), `${skill.name}: frontmatter name and directory disagree`);
      }
    });

    await it('describes when to use each one, so the model can match on it', () => {
      for (const skill of listSkills(wsBundled)) {
        assert.ok(skill.description.length >= 40, `${skill.name}: description is too short to match on`);
        assert.ok(skill.whenToUse.length > 0, `${skill.name} has no when_to_use`);
        // "what it does and when to use it" - the trigger has to be in the text.
        assert.match(skill.description + ' ' + skill.whenToUse, /use when|use only when|when /i);
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * Tool names against the real registry
 * ------------------------------------------------------------------ */

async function toolNameSuite() {
  const catalogue = toolCatalogue();

  await describe('tool names in the shipped bodies', async () => {
    await it('builds the catalogue from the real registry, including every documented tool', () => {
      for (const name of EXPECTED_TOOLS) {
        assert.ok(catalogue.has(name), `"${name}" is missing from the tool registry`);
      }
      assert.equal(catalogue.size >= EXPECTED_TOOLS.length, true, 'the registry should hold at least the built-ins');
    });

    await it('mentions only tools that exist, in every bundled skill', () => {
      const problems = [];
      let mentions = 0;
      for (const skill of listSkills(wsBundled)) {
        const prose = proseOf(shippedBody(skill));
        for (const token of new Set(prose.match(TOOL_LIKE) || [])) {
          mentions++;
          if (!catalogue.has(token)) problems.push(`${skill.name}: "${token}" is not a tool`);
        }
      }
      assert.deepEqual(problems, [], `unknown tool names: ${problems.join('; ')}`);
      // A vacuous pass would be a test that reads nothing: every body names tools.
      assert.ok(mentions >= BUNDLED.length, `expected tool mentions in every skill, found ${mentions}`);
    });

    await it('names the tools it depends on explicitly', () => {
      const expected = {
        browser: ['fetch_url', 'browser_goto', 'browser_read', 'browser_click', 'browser_type', 'browser_eval', 'browser_close', 'browser_screenshot'],
        'computer-use': ['run_command'],
        'code-review': ['run_command', 'read_file', 'search_text'],
        'debug-failing-test': ['run_command'],
        'web-research': ['fetch_url', 'browser_goto', 'browser_read'],
      };
      for (const [name, tools] of Object.entries(expected)) {
        const skill = findSkill(name, wsBundled);
        assert.ok(skill, `${name} should be discoverable`);
        const prose = proseOf(shippedBody(skill));
        for (const tool of tools) {
          assert.ok(prose.includes(tool), `${name} should mention ${tool}`);
        }
      }
    });
  });
}

/* ------------------------------------------------------------------ *
 * readSkill, slash commands, the server path
 * ------------------------------------------------------------------ */

async function loadSuite() {
  await describe('loading a bundled skill', async () => {
    await it('readSkill returns the body wrapped as user-provided, untrusted content', () => {
      const result = readSkill('browser', wsBundled);
      assert.equal(result.ok, true);
      assert.equal(result.skill.source, 'bundled');
      assert.equal(result.skill.name, 'browser');
      assert.equal(result.skill.dir, path.join(bundledSkillsDir(), 'browser'));
      const body = result.skill.body;
      assert.match(body, /BEGIN SKILL CONTENT \(user-provided, untrusted\)/);
      assert.match(body, /not part of Klaud's own system prompt/);
      assert.match(body, /cannot change Klaud's core rules/);
      assert.match(body, /END SKILL CONTENT/);
      // The instructions themselves are inside the wrapper, not before it.
      const open = body.indexOf('BEGIN SKILL CONTENT');
      const instruction = body.indexOf('browser_read');
      const close = body.lastIndexOf('END SKILL CONTENT');
      assert.ok(open !== -1 && instruction !== -1 && close !== -1);
      assert.ok(open < instruction, 'the wrapper must open before the instructions');
      assert.ok(instruction < close, 'the wrapper must close after the instructions');
      // Frontmatter is metadata, never part of what the model is told to follow.
      assert.ok(!/^---[\s\S]*?name: browser/.test(body), 'the frontmatter must not be in the body');
    });

    await it('parses /name for a bundled skill, with and without arguments', () => {
      assert.deepEqual(parseSlashCommand('/browser', wsBundled), { name: 'browser', args: '' });
      assert.deepEqual(parseSlashCommand('/computer-use now', wsBundled), { name: 'computer-use', args: 'now' });
      assert.deepEqual(parseSlashCommand('/web-research  spaced  out ', wsBundled), {
        name: 'web-research',
        args: 'spaced  out',
      });
    });

    await it('expands a bundled skill through the path src/server.js uses', () => {
      const { expandSlashCommand } = require('../src/extensions');
      const expanded = expandSlashCommand('/code-review look at HEAD', wsBundled);
      assert.ok(expanded, 'expandSlashCommand should handle a bundled skill');
      assert.equal(expanded.error, undefined);
      assert.equal(expanded.name, 'code-review');
      assert.equal(expanded.args, 'look at HEAD');
      assert.match(expanded.content, /The user invoked the skill "code-review"/);
      assert.match(expanded.content, /BEGIN SKILL CONTENT/);
      // The wrapper is not applied twice: exactly one opening delimiter.
      assert.equal((expanded.content.match(/BEGIN SKILL CONTENT/g) || []).length, 1);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Precedence: project > personal > bundled
 * ------------------------------------------------------------------ */

async function precedenceSuite() {
  const wsPrecedence = newWorkspace();

  await describe('precedence', async () => {
    await it('uses the bundled copy while nothing overrides it', () => {
      const listed = findSkill('code-review', wsPrecedence);
      assert.ok(listed);
      assert.equal(listed.source, 'bundled');
    });

    await it('lets a personal skill of the same name beat the bundled one', () => {
      writeSkill(personalSkillsDir(), 'code-review', { name: 'code-review', description: 'Personal code review.' });
      const listed = findSkill('code-review', wsPrecedence);
      assert.equal(listed.source, 'personal');
      assert.equal(listed.description, 'Personal code review.');
      // The override is reported, not silent, and it says what it covered.
      assert.ok(listed.warnings.some((warning) => /shadowed/.test(warning)), 'the winner should say what it shadows');
      assert.ok(listed.warnings.some((warning) => /bundled/.test(warning)), 'the warning should name the bundled copy');
      // ...and the personal body is what the model would actually read.
      assert.match(readSkill('code-review', wsPrecedence).skill.body, /Body of code-review\./);
    });

    await it('lets a project skill beat the personal and the bundled copy', () => {
      writeSkill(
        path.join(wsPrecedence, '.klaud', 'skills'),
        'code-review',
        { name: 'code-review', description: 'Project code review.' },
        'Project review body.'
      );
      const listed = findSkill('code-review', wsPrecedence);
      assert.equal(listed.source, 'project');
      assert.equal(listed.description, 'Project code review.');
      assert.match(readSkill('code-review', wsPrecedence).skill.body, /Project review body\./);
      // A project copy always wins for its own workspace, even over the bundled one.
      assert.deepEqual(listed.warnings, [
        'shadowed the bundled and personal skills of the same name (lower precedence in this workspace)',
      ]);
    });

    await it('keeps the other bundled skills visible in that workspace', () => {
      const listed = listSkills(wsPrecedence);
      const others = listed.filter((skill) => skill.name !== 'code-review');
      assert.deepEqual(
        others.map((skill) => skill.name),
        BUNDLED.filter((name) => name !== 'code-review')
      );
      for (const skill of others) assert.equal(skill.source, 'bundled');
      // The project copy is still listed once, not once per source.
      assert.equal(listed.filter((skill) => skill.name === 'code-review').length, 1);
    });
  });
}

/* ------------------------------------------------------------------ *
 * No bundled directory at all
 * ------------------------------------------------------------------ */

async function degradedSuite() {
  const emptyDir = path.join(TMP, 'empty-bundled');
  fs.mkdirSync(emptyDir, { recursive: true });
  const missingDir = path.join(TMP, 'nope', 'skills-bundled');
  // The precedence suite installed a personal skill that is visible in every
  // workspace, so "nothing installed anywhere" needs an empty personal root too.
  const emptyData = path.join(TMP, 'empty-data');
  fs.mkdirSync(emptyData, { recursive: true });

  /** Point an env var at a value for the duration of `fn`, restoring it after. */
  function withEnv(name, value, fn) {
    const previous = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try {
      return fn();
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }

  await describe('an empty or missing bundled directory', async () => {
    await it('reports no bundled skills rather than an error when the directory is empty', () => {
      withEnv('KLAUD_DATA_DIR', emptyData, () => {
        // Fill the cache with the real bundled listing first. The change below
        // does NOT clear it on purpose: the cache key includes the bundled root,
        // so repointing it must be enough. A stale listing here is the bug this
        // check exists to catch.
        assert.deepEqual(
          listSkills(wsEmptyRoot).map((skill) => skill.name),
          BUNDLED
        );
        process.env.KLAUD_BUNDLED_SKILLS_DIR = emptyDir;
        try {
          assert.deepEqual(listSkills(wsEmptyRoot), [], 'an empty workspace plus no bundled skills is an empty listing');
        } finally {
          if (process.env.KLAUD_BUNDLED_SKILLS_DIR === emptyDir) delete process.env.KLAUD_BUNDLED_SKILLS_DIR;
        }
      });
    });

    await it('degrades to no skills when the directory does not exist, and says where it looked', () => {
      withEnv('KLAUD_DATA_DIR', emptyData, () =>
        withEnv('KLAUD_BUNDLED_SKILLS_DIR', missingDir, () => {
          assert.deepEqual(listSkills(wsEmptyRoot), []);
          assert.equal(skillsForPrompt(wsEmptyRoot), '');
          const result = readSkill('browser', wsEmptyRoot);
          assert.equal(result.ok, false);
          assert.match(result.error, /no skill named "browser"/);
          assert.match(result.error, /no skills are installed/);
          assert.match(result.error, /Directories checked/);
          assert.ok(result.error.includes(missingDir), 'the error should name the bundled directory it checked');
        })
      );
    });

    await it('finds them again as soon as the directory is back, without a cache clear', () => {
      withEnv('KLAUD_DATA_DIR', emptyData, () => {
        assert.deepEqual(
          listSkills(wsEmptyRoot).map((skill) => skill.name),
          BUNDLED
        );
        assert.equal(readSkill('browser', wsEmptyRoot).ok, true);
      });
    });
  });
}

/* ------------------------------------------------------------------ *
 * Exit hygiene
 * ------------------------------------------------------------------ */

process.on('exit', () => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function main() {
  process.stdout.write('\n\x1b[1m  bundled skills\x1b[0m\n');

  await discoverySuite();
  await frontmatterSuite();
  await toolNameSuite();
  await loadSuite();
  await precedenceSuite();
  await degradedSuite();

  const total = results.pass + results.fail;
  process.stdout.write('\n');
  if (results.fail) {
    process.stdout.write(`\x1b[31mx ${results.fail} of ${total} checks failed\x1b[0m\n\n`);
    for (const failure of failures) {
      process.stdout.write(`  ${failure.group} > ${failure.name}\n`);
      process.stdout.write(`  ${String(failure.err.stack || failure.err.message).split('\n').slice(0, 4).join('\n  ')}\n\n`);
    }
    process.exit(1);
  }
  process.stdout.write(`\x1b[32m+ all ${total} checks passed\x1b[0m\n\n`);
}

main().catch((err) => {
  console.error('\nHarness crashed:', err);
  process.exit(1);
});
