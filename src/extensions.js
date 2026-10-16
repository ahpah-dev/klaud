'use strict';

/**
 * Cowork extensions: skills, plugins and subagents, consolidated.
 *
 * Each of those arrived as its own module with its own interface, and this file
 * is the one place that knows about all three. Keeping the joins here means the
 * agent loop, the server and the tools registry each make a single call and none
 * of them needs to learn three shapes.
 *
 * Everything is loaded defensively. A missing or broken extension module must
 * degrade to "that feature is off", never to a server that will not start — the
 * agent still has to work when someone's plugin manifest is unparseable.
 */

const fs = require('fs');
const path = require('path');
const { registerTools } = require('./lib/tools');

/* ------------------------------------------------------------------ *
 * Module loading
 * ------------------------------------------------------------------ */

const loaded = { skills: null, plugins: null, agents: null, errors: {} };

function load(name) {
  if (loaded[name] !== null) return loaded[name];
  try {
    loaded[name] = require(`./lib/${name}`);
  } catch (err) {
    loaded[name] = false;
    loaded.errors[name] = err && err.message ? err.message : String(err);
  }
  return loaded[name];
}

/** For tests: forget cached requires so a fixture directory is picked up. */
function resetExtensions() {
  loaded.skills = null;
  loaded.plugins = null;
  loaded.agents = null;
  loaded.errors = {};
  for (const name of ['skills', 'plugins', 'agents']) {
    try {
      delete require.cache[require.resolve(`./lib/${name}`)];
    } catch { /* not installed */ }
  }
  // The skills module caches its own directory scan; toggling a plugin changes
  // nothing in its cache key, so it has to be told to forget.
  const skills = load('skills');
  if (skills && typeof skills.clearSkillCache === 'function') skills.clearSkillCache();
}

/* ------------------------------------------------------------------ *
 * A single view of what extensions are available
 * ------------------------------------------------------------------ */

/**
 * Resolve everything once per turn.
 *
 * `enabledPlugins` comes from settings. Returns plain data plus the prompts and
 * tool definitions the rest of the app needs.
 */
function collectExtensions({ cwd, enabledPlugins = {} } = {}) {
  const skills = load('skills');
  const plugins = load('plugins');
  const agents = load('agents');

  const warnings = Object.entries(loaded.errors).map(
    ([name, message]) => `The ${name} module failed to load, so ${name} are unavailable: ${message}`
  );

  /* ---- plugins first: they decide where to look for skills and agents ---- */
  let sources = { skillDirs: [], skills: [], commandFiles: [], agentFiles: [], warnings: [] };
  if (plugins) {
    try {
      sources = plugins.pluginSources(cwd, enabledPlugins) || sources;
      for (const w of sources.warnings || []) warnings.push(w);
    } catch (err) {
      warnings.push(`Could not read plugins: ${err.message}`);
    }
    /* `pluginSources` only reports on plugins that are switched on, so a broken
     * manifest in a plugin the user has not enabled yet would stay invisible
     * until they turned it on and found the components missing. Inventory the
     * whole folder and report those problems now instead. */
    try {
      for (const plugin of plugins.listPlugins(cwd) || []) {
        for (const w of plugin.warnings || []) {
          if (!warnings.includes(w)) warnings.push(w);
        }
      }
    } catch (err) {
      warnings.push(`Could not list plugins: ${err.message}`);
    }
  }

  /* ---- agent directories, from plugins and from the usual two places ---- */
  // `agents.listAgents` wants directories, while `pluginSources` reports the
  // individual definition files. Deriving the directories here keeps both
  // modules' documented shapes intact rather than bending either one.
  const agentDirs = [
    ...new Set((sources.agentFiles || []).map((f) => path.dirname(f.path)).filter(Boolean)),
  ];
  // A plugin's agents normally live in one directory, so prefer that when the
  // files share a parent — one scan instead of N identical ones.
  const sharedAgentDir =
    agentDirs.length && agentDirs.every((d) => d === agentDirs[0]) ? [agentDirs[0]] : agentDirs;

  /* ---- listings for the system prompt ---- */
  const promptParts = [];
  let skillCount = 0;
  try {
    const pluginBlock = plugins ? plugins.pluginsForPrompt(cwd, enabledPlugins) : '';
    if (pluginBlock) promptParts.push(pluginBlock);
  } catch (err) {
    warnings.push(`Could not describe plugins: ${err.message}`);
  }
  try {
    const skillBlock = skills ? skills.skillsForPrompt(cwd) : '';
    if (skillBlock) promptParts.push(skillBlock);
    // Counted from the listing the model actually receives: personal, project
    // and plugin skills all end up in `skillBlock`, so counting only the plugin
    // directories reported "no skills" while a personal skill was loading fine.
    skillCount = skills
      ? (skills.listSkills(cwd) || []).filter((s) => s.name).length
      : 0;
  } catch (err) {
    warnings.push(`Could not describe skills: ${err.message}`);
  }
  let agentNames = [];
  try {
    const agentBlock = agents ? agents.agentsForPrompt(cwd, sharedAgentDir) : '';
    if (agentBlock) promptParts.push(agentBlock);
    agentNames = agents && typeof agents.agentNames === 'function' ? agents.agentNames(cwd, sharedAgentDir) : [];
  } catch (err) {
    warnings.push(`Could not describe subagents: ${err.message}`);
  }

  return {
    cwd,
    pluginDirs: sources,
    agentDirs: sharedAgentDir,
    prompt: promptParts.join('\n\n'),
    agentNames,
    warnings,
    available: {
      skills: skillCount,
      plugins: Boolean(plugins),
      agents: agentNames.length,
    },
  };
}

/* ------------------------------------------------------------------ *
 * Prompt augmentation
 * ------------------------------------------------------------------ */

/**
 * Append the extension listings to a system prompt.
 *
 * Returns the base prompt unchanged when there is nothing to add, so a session
 * with no skills, plugins or subagents sends byte-identical requests to before —
 * which keeps the feature free for anyone who does not use it.
 */
function augmentSystemPrompt(basePrompt, extensions) {
  const extra = (extensions && extensions.prompt ? extensions.prompt : '').trim();
  if (!extra) return basePrompt;

  const warnings = (extensions.warnings || []).length
    ? `\n\nExtension warnings (tell the user if relevant):\n${extensions.warnings.map((w) => `- ${w}`).join('\n')}`
    : '';

  return `${basePrompt}\n\n${extra}${warnings}`;
}

/* ------------------------------------------------------------------ *
 * Tool registration
 * ------------------------------------------------------------------ */

let registered = false;

/**
 * Add the extension-provided tools to the shared registry.
 *
 * Idempotent: `registerTools` replaces by name, so calling this on every request
 * is harmless and means a skill dropped into the folder is picked up without a
 * restart.
 */
function registerExtensionTools() {
  const skills = load('skills');
  const agents = load('agents');
  const defs = [];
  if (skills && typeof skills.skillToolDefinitions === 'function') {
    try {
      defs.push(...(skills.skillToolDefinitions() || []));
    } catch { /* reported through collectExtensions */ }
  }
  if (agents && typeof agents.agentToolDefinition === 'function') {
    try {
      const def = agents.agentToolDefinition();
      if (def) defs.push(def);
    } catch { /* reported through collectExtensions */ }
  }
  const result = registerTools(defs);
  registered = true;
  return result;
}

/* ------------------------------------------------------------------ *
 * Subagent execution
 * ------------------------------------------------------------------ */

/**
 * Run one subagent as a nested turn with its own context.
 *
 * Two rules make this safe, and both matter:
 *
 * 1. **No recursion.** A subagent is given `allowSubagents: false`, so the `task`
 *    tool is not offered to it. Without that, one delegation mistake becomes an
 *    unbounded fan-out of real API calls against the user's key.
 * 2. **Tools are narrowed, not widened.** An agent definition may declare an
 *    allow-list; it can never gain a tool the session does not already have, and
 *    the permission mode still applies to everything it calls.
 *
 * The approval prompt is forwarded, and that is not a detail. It used to be
 * dropped here, so in "Ask first" mode the user approved the delegation and the
 * nested turn then wrote files and ran commands without ever asking again — the
 * setting described a boundary that did not exist. See `nestedApproval` below
 * for how the ids stay unique.
 */
async function runSubagent({
  description,
  prompt,
  agent,
  settings,
  cwd,
  approvalMode,
  signal,
  onEvent,
  requestApproval,
  agentDirs = [],
}) {
  const agents = load('agents');
  const skills = load('skills');

  let definition = null;
  if (agents && agent) {
    try {
      const found = agents.readAgent(agent, cwd, agentDirs);
      if (found && found.ok) definition = found.agent;
    } catch { /* fall through to the default subagent */ }
  }

  const skillsBlock = skills ? skills.skillsForPrompt(cwd) : '';
  const systemPrompt = [
    definition
      ? definition.body
      : `You are a Klaud subagent. You were given one task. Do it, then report what you did and what you found.`,
    '',
    'You are working inside a larger session, so be specific and do not restate the task back.',
    'You have no way to ask a question: if something is ambiguous, choose the most reasonable reading,',
    'state the assumption you made, and continue.',
    'You cannot delegate further — finish the work yourself.',
    definition && Array.isArray(definition.tools) && definition.tools.length
      ? `\nUse only these tools: ${definition.tools.join(', ')}.`
      : '',
    skillsBlock ? `\n${skillsBlock}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const subSettings = {
    ...settings,
    systemPrompt,
    // Never send a nested agent's model choice it did not ask for.
    model: definition && definition.model && definition.model !== 'inherit' ? definition.model : settings.model,
  };

  /* Required lazily, and this is not optional style.
   *
   * agent.js requires this module at load time to build its system prompt, so a
   * top-level `require('./agent')` here creates a cycle: whichever file loads
   * second sees the other's half-built exports, and `runAgentTurn` comes back
   * undefined. Requiring inside the call means the cycle is resolved by the time
   * anything actually delegates. This was a real failure — the first subagent
   * returned "runAgentTurn is not defined". */
  const { runAgentTurn } = require('./agent');

  // Unique per delegation, so a nested approval id can never collide with the
  // parent turn's in the server's single pending-approvals map.
  const delegationId = `sub${Math.random().toString(36).slice(2, 8)}`;

  const inner = [];
  const result = await runAgentTurn({
    settings: subSettings,
    messages: [{ role: 'user', content: prompt }],
    cwd,
    approvalMode,
    maxSteps: Math.max(1, Math.min(Number(settings.maxSteps) || 12, 20)),
    signal,
    allowSubagents: false,
    allowTools: true,
    /* Approval ids are namespaced per delegation.
     *
     * The server holds pending approvals in one map keyed by id, and both turns
     * number their tool calls from `call_1`. Without a prefix, a nested write
     * asking to be approved as "call_1" would collide with the parent's own
     * "call_1" — the user would be shown one prompt and two different decisions
     * would resolve against it. The description is included because the dialog
     * may show it, and "which subagent is asking" is otherwise unanswerable. */
    requestApproval:
      typeof requestApproval === 'function'
        ? (request) =>
            requestApproval({
              ...request,
              id: `${delegationId}:${request.id}`,
              subagent: description || agent || 'subagent',
            })
        : undefined,
    // Forward only the events a parent transcript should show, and tag them so
    // the UI can nest them under the delegation rather than interleaving them.
    onEvent: (event) => {
      inner.push(event);
      if (onEvent && ['tool_call', 'tool_result', 'notice', 'approval_request'].includes(event.type)) {
        onEvent({ ...event, subagent: description || agent || 'subagent' });
      }
    },
  });

  const text = String(result.finalText || '').trim();
  const tools = result.toolCalls || [];

  /* Success means the subagent produced an answer, not merely that its turn
   * ended. A turn can stop for reasons that leave nothing useful — the loop
   * guard firing on a repeated step, or the model finishing silently — and
   * reporting `ok` for those told the parent model the delegation had worked
   * when it had not. Observed live: the parent saw a success with no answer,
   * gave up on the subagent and did the work itself, which is the right
   * behaviour but only because it distrusted the result. */
  const produced = text.length > 0;
  const why = {
    loop_broken: 'it kept repeating the same step, so Klaud stopped it',
    no_reply: 'it finished without writing an answer',
    aborted: 'it was cancelled',
    error: 'it hit an error',
  }[result.finished];

  const output = produced
    ? [
        text,
        tools.length
          ? `\n\n[subagent used ${tools.length} tool call(s): ${[...new Set(tools.map((t) => t.name))].join(', ')}]`
          : '',
      ]
        .join('')
        .trim()
    : `The subagent did not produce an answer${why ? ` because ${why}` : ''}.` +
      (tools.length
        ? ` It did make ${tools.length} tool call(s) (${[...new Set(tools.map((t) => t.name))].join(', ')}) before stopping.`
        : ' It made no tool calls.') +
      ' Consider doing this work yourself, or rephrasing the task.';

  return {
    ok: produced,
    output,
    steps: result.steps,
    finished: result.finished,
  };
}

/* ------------------------------------------------------------------ *
 * Slash commands
 * ------------------------------------------------------------------ */

/**
 * Expand a `/skill-name` message into the skill's instructions.
 *
 * The body is loaded here rather than left to the model so a user who typed the
 * command gets the skill applied even if the model would not have chosen it.
 * Returns null when the message is not a slash command or names no skill.
 */
function expandSlashCommand(text, cwd) {
  const skills = load('skills');
  if (!skills) return null;

  // `parseSlashCommand` deliberately returns null for a name that is not a known
  // skill, so a message like "/usr/bin/env is missing" is not treated as a
  // command. That leaves a typo'd command falling through to the model as
  // ordinary text, which reads as the command being ignored. Catch that shape
  // here and answer it, so the user is told rather than left guessing.
  const looksLikeCommand = typeof text === 'string' && /^\/[a-z0-9][a-z0-9-]*(\s|$)/i.test(text);

  let parsed = null;
  try {
    parsed = skills.parseSlashCommand(text, cwd);
  } catch {
    return null;
  }

  if (!parsed) {
    if (!looksLikeCommand) return null;
    const wanted = String(text).trim().slice(1).split(/\s+/)[0].toLowerCase();
    let names = [];
    try {
      names = (skills.listSkills(cwd) || []).map((s) => s.name).filter(Boolean);
    } catch { /* fall through to the plain message */ }
    const suggestion =
      typeof skills.suggestName === 'function' ? skills.suggestName(wanted, names) : null;
    const listed = names.slice(0, 12).join(', ');
    return {
      error:
        `No skill named "${wanted}".` +
        (suggestion ? ` Did you mean "${suggestion}"?` : '') +
        (listed ? ` Available: ${listed}.` : ' No skills are installed yet.'),
    };
  }

  let found = null;
  try {
    found = skills.readSkill(parsed.name, cwd);
  } catch {
    return null;
  }
  if (!found || !found.ok) {
    return { error: found && found.error ? found.error : `No skill named "${parsed.name}".` };
  }
  return {
    name: parsed.name,
    args: parsed.args || '',
    // The body carries its own untrusted-content wrapper from the skills module;
    // it is not re-wrapped here or the delimiters would nest.
    content: [
      `The user invoked the skill "${parsed.name}". Follow its instructions.`,
      found.skill && found.skill.body ? `\n${found.skill.body}` : '',
      parsed.args ? `\nArguments provided: ${parsed.args}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

/** Skills available to the slash-command palette in the UI. */
function listInvocableSkills(cwd) {
  const skills = load('skills');
  if (!skills) return [];
  try {
    return (skills.listSkills(cwd) || [])
      .filter((s) => s.name)
      .map((s) => ({
        name: s.name,
        description: s.description,
        source: s.source,
        modelInvocable: !s.userInvocableOnly,
      }));
  } catch {
    return [];
  }
}

module.exports = {
  load,
  resetExtensions,
  collectExtensions,
  augmentSystemPrompt,
  registerExtensionTools,
  runSubagent,
  expandSlashCommand,
  listInvocableSkills,
  isRegistered: () => registered,
};
