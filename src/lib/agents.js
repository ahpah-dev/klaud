'use strict';

/**
 * Custom subagent definitions.
 *
 * A subagent is one markdown file: YAML frontmatter for the metadata, and a
 * body that becomes part of that subagent's system prompt.
 *
 *   ~/.klaud/agents/<name>.md              personal, applies everywhere
 *   <workspace>/.klaud/agents/<name>.md    project, applies in that workspace
 *   <plugin>/agents/<name>.md              supplied through `extraDirs`
 *
 * Two deliberate properties of this module:
 *
 *   1. Nothing here executes a subagent, and nothing here reads or writes a
 *      file outside the directories it is asked to scan. This file is imported
 *      by tests and, one day, by a server that has no agent loop to hand.
 *   2. A malformed definition is always reported as a warning. Frontmatter is
 *      written by hand, so a stray indent or an unclosed quote is a normal
 *      event — it must never take down the listing or the turn.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/** Character budget for the block injected into the main system prompt. */
const PROMPT_LIMIT = 1500;

/** A long file is still parsed, but the body kept is capped to protect context. */
const MAX_BODY_CHARS = 40_000;

/** A slug: what can be typed into `task(agent: ...)` without quoting trouble. */
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
const MAX_NAME_LEN = 64;

const SOURCE_PROJECT = 'project';
const SOURCE_PERSONAL = 'personal';
const SOURCE_PLUGIN = 'plugin';

/** Frontmatter keys this module interprets. Anything else is kept + warned. */
const KNOWN_KEYS = new Set(['name', 'description', 'tools', 'model']);

/* ------------------------------------------------------------------ *
 * YAML subset
 *
 * Deliberately not a YAML parser. It covers what a subagent definition is
 * realistically written with:
 *   key: value            key: "quoted value"      key: 'single'
 *   key: true / false     key: 42 / 1.5 / null
 *   key: [a, b, c]        key:               followed by "- item" lines
 * It is total: every input returns an object, and anything it cannot place
 * comes back as a warning string rather than an exception.
 * ------------------------------------------------------------------ */

// Leading whitespace is allowed on a key: a hand-written block sometimes ends up
// indented as a whole, and refusing to parse it would throw away the definition.
// The indentation is still reported as a warning, because a value nested *under*
// a key is a shape this subset does not support.
const KEY_RE = /^\s*([A-Za-z_][\w.-]*)\s*:\s*(.*)$/;
const LIST_ITEM_RE = /^\s+-\s*(.*)$/;
const ANY_ITEM_RE = /^\s*-\s*(.*)$/;
// Deliberately shaped like an assignment. A bare /key|token/ would redact an
// innocent description ("keys on the file path") and hide a real parse problem.
const SECRET_RE = /\b[\w.-]*(?:api[_-]?key|token|secret|password|passwd|credential)[\w.-]*\s*[:=]|\bBearer\s+\S+|^sk-[A-Za-z0-9_-]{8,}/i;
const TRUNCATED_SECRET = '(value looks like a credential and was not kept)';

const isBlank = (line) => line.trim() === '';
const isComment = (line) => line.trimStart().startsWith('#');

function indentOf(line) {
  const m = /^([ \t]*)/.exec(line);
  return m ? m[1].length : 0;
}

/**
 * Peel one layer of quotes.
 *
 * Returns `{ text, ok }`. `ok` is false for an unclosed quote so the caller can
 * keep the raw text instead of silently inventing a value.
 */
function unquote(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (text.length >= 2 && text[0] === '"' && text[text.length - 1] === '"') {
    const inner = text.slice(1, -1);
    return {
      text: inner.replace(/\\(["\\/nrtbf])/g, (_, c) =>
        ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] || c)
      ),
      ok: true,
    };
  }
  if (text.length >= 2 && text[0] === "'" && text[text.length - 1] === "'") {
    // In YAML single quotes, '' is one literal quote.
    return { text: text.slice(1, -1).replace(/''/g, "'"), ok: true };
  }
  if (text[0] === '"' || text[0] === "'") return { text, ok: false };
  return { text, ok: true };
}

/** Split a flow list body on top-level commas, ignoring commas inside quotes. */
function splitFlow(body) {
  const parts = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\' && quote === '"') {
        current += ch + (body[i + 1] || '');
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Is this a value the parser understands as a flow list? */
function isFlowList(text) {
  if (text[0] !== '[') return false;
  if (text[text.length - 1] !== ']') return false;
  if (text.length < 2) return false;
  if (text.length === 2) return true; // []
  // `[a, b` never closes; `[not a list].` ends with junk.
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i === text.length - 1;
    }
  }
  return false;
}

/**
 * Turn a raw value string into a scalar or a flow list.
 * `warnings` collects anything the parser had to guess at.
 */
function parseValue(raw, warnings) {
  const text = String(raw == null ? '' : raw).trim();
  if (text === '') return '';

  if (isFlowList(text)) {
    const body = text.slice(1, -1).trim();
    if (body === '') return [];
    const items = [];
    for (const part of splitFlow(body)) {
      // A trailing or doubled comma is a typo — dropping the hole silently
      // would hide it, so say so.
      if (part.trim() === '') {
        warnings.push('empty item in a list value (check for a stray comma)');
        continue;
      }
      const { text: item, ok } = unquote(part);
      if (!ok) warnings.push(`unclosed quote in a list value: ${part.trim().slice(0, 40)}`);
      items.push(item.trim());
    }
    return items;
  }

  // Started a list and never closed it. Turning this into a one-item list would
  // invent a tool name out of `[read_file, glob`, so it is left as text and
  // reported instead.
  if (text.startsWith('[')) warnings.push(`unterminated list value: ${text.slice(0, 60)}`);

  const lower = text.toLowerCase();  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null' || text === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);

  if (text[0] === '"' || text[0] === "'") {
    const { text: inner, ok } = unquote(text);
    if (!ok) warnings.push(`unclosed quote in value: ${text.slice(0, 60)}`);
    return inner;
  }

  return text;
}

/**
 * Parse the frontmatter of one definition.
 *
 * Returns `{ data, warnings, hasFrontmatter, body }` — `body` is everything
 * after the closing `---`.
 */
function parseFrontmatter(text) {
  const warnings = [];
  const data = Object.create(null);
  const source = String(text == null ? '' : text).replace(/^\uFEFF/, '');
  const lines = source.split(/\r\n|\n|\r/);

  if (!/^---\s*$/.test(lines[0] || '')) {
    return { data: {}, warnings, hasFrontmatter: false, body: source.trim() };
  }

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i]) || /^\.\.\.\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    warnings.push('frontmatter opened with --- but never closed');
    return { data: {}, warnings, hasFrontmatter: false, body: source.trim() };
  }

  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) continue;

    if (ANY_ITEM_RE.test(line)) {
      warnings.push(`list item outside any block list (line ${i + 1}): ${line.trim().slice(0, 40)}`);
      continue;
    }

    const match = KEY_RE.exec(line);
    if (!match) {
      warnings.push(`could not parse frontmatter line ${i + 1}: ${line.trim().slice(0, 60)}`);
      continue;
    }

    const key = match[1];
    const valueText = match[2].trim();
    const keyIndent = indentOf(line);

    let value;
    if (valueText !== '') {
      value = parseValue(valueText, warnings);
    } else {
      // A bare `key:` is either a block list or nothing at all.
      const items = [];
      if (i + 1 < end && LIST_ITEM_RE.test(lines[i + 1])) {
        let j = i + 1;
        const blockIndent = indentOf(lines[j]);
        while (j < end) {
          const itemLine = lines[j];
          if (isBlank(itemLine) || isComment(itemLine)) {
            j++;
            continue;
          }
          if (indentOf(itemLine) < blockIndent || !ANY_ITEM_RE.test(itemLine)) break;
          const raw = ANY_ITEM_RE.exec(itemLine)[1].trim();
          if (raw === '') {
            warnings.push(`empty list item under "${key}" (line ${j + 1})`);
          } else {
            const { text: item, ok } = unquote(raw);
            if (!ok) warnings.push(`unclosed quote in list item under "${key}" (line ${j + 1})`);
            items.push(item.trim());
          }
          j++;
        }
        i = j - 1;
      }
      value = items;
    }

    // A value more indented than its key is not something this subset supports,
    // but the nested block is not lost data — say which key it belonged to.
    const hadListItems = Array.isArray(value) && value.length > 0;
    if (valueText === '' && !hadListItems) {
      warnings.push(`"${key}" has no value`);
    } else if (valueText !== '' && keyIndent > 0) {
      warnings.push(`"${key}" is indented, which this parser does not support; used it anyway`);
    }

    if (Object.prototype.hasOwnProperty.call(data, key)) {
      warnings.push(`"${key}" is set more than once; the last value wins`);
    }
    data[key] = value;
  }

  return {
    data,
    warnings,
    hasFrontmatter: true,
    body: lines.slice(end + 1).join('\n').trim(),
  };
}

/* ------------------------------------------------------------------ *
 * Field normalisation
 * ------------------------------------------------------------------ */

/**
 * `tools` accepts three shapes, because all three get written by hand:
 *   tools: read_file glob_files
 *   tools: read_file, glob_files
 *   tools: [read_file, glob_files]
 * plus the block list form, which the parser has already turned into an array.
 */
function parseTools(value, warnings) {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter((item) => {
        if (item === '') {
          warnings.push('empty entry in "tools"');
          return false;
        }
        return true;
      });
  }
  if (typeof value === 'string') {
    let text = value.trim();
    if (text === '') return [];
    if (isFlowList(text)) return parseTools(parseValue(text, warnings), warnings);
    // Commas are a separator, never part of a tool name, so a comma with nothing
    // after it is a typo worth reporting rather than an empty tool name.
    if (text.endsWith(',')) {
      warnings.push('"tools" ends with a comma');
      text = text.replace(/,+$/, '');
    }
    return text
      .split(/[\s,]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  warnings.push(`"tools" should be a string or a list, got ${typeof value}`);
  return [];
}

function parseModel(value, warnings) {
  if (value == null || value === '') return 'inherit';
  if (typeof value === 'string') return value.trim() || 'inherit';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  warnings.push(`"model" should be a model id or "inherit", got ${Array.isArray(value) ? 'a list' : typeof value}`);
  return 'inherit';
}

/** `description` may be written across several lines; join them into one line. */
function normalizeDescription(value, warnings) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    const parts = value.map((v) => String(v).trim()).filter(Boolean);
    if (parts.length) warnings.push('"description" is a list; joined it into one line');
    return parts.join(' ');
  }
  if (typeof value === 'object') {
    warnings.push('"description" should be a string');
    return '';
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

/** Slug rules: lowercase, digits, hyphen, underscore; validated, never coerced. */
function validateName(name) {
  const text = String(name == null ? '' : name).trim();
  if (!text) return { ok: false, reason: 'is empty' };
  if (text.length > MAX_NAME_LEN) return { ok: false, reason: `is longer than ${MAX_NAME_LEN} characters` };
  if (!NAME_RE.test(text)) {
    return {
      ok: false,
      reason: 'must be lowercase letters, digits, hyphen or underscore, starting with a letter or digit',
    };
  }
  return { ok: true, name: text };
}

/** Cheap uppercase/lowercase/mixed signals the filename is not a slug. */
function looksLowercase(name) {
  return name === name.toLowerCase();
}

/**
 * A frontmatter value may be sensitive. Warnings are echoed into a transcript,
 * so a credential never goes into one verbatim.
 */
function safeExcerpt(value, max = 120) {
  const text = String(value == null ? '' : value).trim();
  if (SECRET_RE.test(text)) return TRUNCATED_SECRET;
  return text.slice(0, max);
}

/* ------------------------------------------------------------------ *
 * Discovery
 * ------------------------------------------------------------------ */

/** Path segment that holds agent definitions, relative to each root. */
const AGENTS_SEGMENT = path.join('.klaud', 'agents');

/**
 * Where personal agents live.
 *
 * KLAUD_AGENTS_DIR exists so tests (and portable installs) can point elsewhere
 * without ever touching the real home directory. It is read here rather than
 * from config.js because config.js has no concept of agents yet, and this
 * module must stay importable on its own.
 */
function personalAgentsDir() {
  if (process.env.KLAUD_AGENTS_DIR) return path.resolve(process.env.KLAUD_AGENTS_DIR);
  const home = os.homedir();
  if (!home) return path.join(process.cwd(), '.klaud', 'agents');
  return path.join(home, '.klaud', 'agents');
}

function projectAgentsDir(cwd) {
  const root = cwd ? path.resolve(cwd) : process.cwd();
  return path.join(root, AGENTS_SEGMENT);
}

/** Expand a leading ~ (a shell habit people bring to a config field) and resolve. */
function resolveDir(dir) {
  let text = String(dir == null ? '' : dir).trim();
  if (!text) return null;
  if (text === '~') text = os.homedir();
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(os.homedir(), text.slice(2));
  try {
    return path.resolve(text);
  } catch {
    return null;
  }
}

/** The directories scanned, in shadowing order: project, then personal, then plugins. */
function agentDirs(cwd, extraDirs = [], warnings = []) {
  const out = [{ dir: projectAgentsDir(cwd), source: SOURCE_PROJECT }];
  const personal = resolveDir(personalAgentsDir());
  // If a test or a portable install points the personal directory at the
  // workspace, project entries are the same files; scanning twice invites a
  // confusing "shadowed by itself" reading, so skip the duplicate.
  if (personal && !out.some((entry) => entry.dir === personal)) {
    out.push({ dir: personal, source: SOURCE_PERSONAL });
  }
  for (const raw of Array.isArray(extraDirs) ? extraDirs : []) {
    if (raw == null || String(raw).trim() === '') continue;
    if (typeof raw !== 'string') {
      warnings.push(`ignoring a non-string entry in extraDirs (${typeof raw})`);
      continue;
    }
    const dir = resolveDir(raw);
    if (!dir) {
      warnings.push(`ignoring an unusable directory in extraDirs: ${safeExcerpt(raw, 80)}`);
      continue;
    }
    if (out.some((entry) => entry.dir === dir)) continue;
    out.push({ dir, source: SOURCE_PLUGIN });
  }
  return out;
}

function readDefinitionFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EMFILE')) {
      try {
        return fs.readFileSync(file, 'utf8');
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Parse one definition file. `fallbackName` is the filename stem, used when the
 * frontmatter has no `name`.
 */
function parseAgentFile(file, dir, source, fallbackName) {
  const warnings = [];
  const text = readDefinitionFile(file);

  if (text === null) {
    return { agent: null, warnings: [`could not read ${safeExcerpt(file, 160)}`] };
  }

  const parsed = parseFrontmatter(text);
  for (const warning of parsed.warnings) warnings.push(warning);

  if (!parsed.hasFrontmatter) {
    warnings.push('no frontmatter block found; name came from the filename and there is no description');
  }

  const data = parsed.data || {};

  for (const key of Object.keys(data)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`unknown frontmatter key "${key}" (kept, ignored by Klaud)`);
    }
  }

  const nameCheck = validateName(data.name != null && data.name !== '' ? data.name : fallbackName);
  if (!nameCheck.ok) {
    const origin = data.name != null && data.name !== '' ? 'frontmatter "name"' : 'filename';
    return {
      agent: null,
      warnings: [...warnings, `rejected: ${origin} ${nameCheck.reason}`],
    };
  }

  const description = normalizeDescription(data.description, warnings);
  if (!description) {
    warnings.push('no "description": the model cannot tell when to use this subagent, so it may never be chosen');
  }

  const tools = parseTools(data.tools, warnings);
  if (data.tools !== undefined && tools.length === 0 && data.tools !== '' && !Array.isArray(data.tools)) {
    warnings.push('"tools" is present but no tool names could be read from it');
  }

  const model = parseModel(data.model, warnings);

  let body = String(parsed.body || '');
  let truncated = false;
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS);
    truncated = true;
    warnings.push(`body truncated to ${MAX_BODY_CHARS} characters`);
  }

  return {
    agent: {
      name: nameCheck.name,
      description,
      // An empty array means "no restriction" — the same convention the skills
      // and tool layers use, and it keeps `tools: []` from disabling everything.
      tools,
      model,
      dir,
      source,
      file,
      body,
      bodyTruncated: truncated,
      frontmatter: data,
    },
    warnings,
  };
}

/**
 * Discover every subagent visible from `cwd`.
 *
 * `extraDirs` is an array of absolute directories to scan as well. A plugin
 * supplies `<plugin>/agents` here and its agents are reported as
 * `source: 'plugin'`; nothing else in this module needs to know what a plugin is.
 *
 * Order matters and is intentional: project shadows personal, and both shadow a
 * plugin of the same name. Every shadowed definition is reported as a warning on
 * the winner, so "why is my edit not taking effect" has an answer.
 */
function listAgents(cwd, extraDirs = []) {
  const warnings = [];
  const dirs = agentDirs(cwd, extraDirs, warnings);
  const byName = new Map();
  const seenFiles = new Set();

  for (const { dir, source } of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // A directory that does not exist is the normal case for a fresh install.
      if (!err || err.code !== 'ENOENT') {
        warnings.push(`could not read ${safeExcerpt(dir, 160)} (${err ? err.code || err.message : 'unknown error'})`);
      }
      continue;
    }

    const names = entries
      .filter((entry) => entry.isFile() && /\.md$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const file of names) {
      const full = path.join(dir, file);
      // Same file reachable from two roots: report it once, at the first root
      // that claims it, rather than as a shadow of itself.
      const identity = process.platform === 'win32' ? full.toLowerCase() : full;
      if (seenFiles.has(identity)) continue;
      seenFiles.add(identity);

      const stem = file.replace(/\.md$/i, '');
      const result = parseAgentFile(full, dir, source, stem);

      if (!result.agent) {
        // Not usable as an agent. A filename that is not a slug is not a
        // definition anyone can call, so it is skipped rather than listed.
        warnings.push(`${file}: ${result.warnings.join('; ')}`);
        continue;
      }

      const agent = result.agent;
      const existing = byName.get(agent.name);
      if (existing) {
        // The winner keeps a warning naming the definition it hid, so "my edit
        // is not taking effect" is answerable from the listing alone.
        existing.shadowed = existing.shadowed || [];
        existing.shadowed.push({ file: agent.file, dir: agent.dir, source });
        existing.warnings.push(
          `"${agent.name}" is also defined in ${source} (${agent.file}); the ${existing.source} definition wins`
        );
        continue;
      }
      agent.warnings = result.warnings;
      byName.set(agent.name, agent);
    }
  }

  const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  // Directory-level problems are attached to the first agent so a caller that
  // only looks at entries still sees them; when nothing was found, the same
  // strings are available on the (empty) listing's own array.
  if (agents.length && warnings.length) {
    for (const warning of warnings) {
      if (!agents.some((agent) => agent.warnings.includes(warning))) agents[0].warnings.push(warning);
    }
  }
  agents.warnings = warnings;
  return agents;
}

/* ------------------------------------------------------------------ *
 * Lookup
 * ------------------------------------------------------------------ */

/** Levenshtein distance, iterative with a single row. */
function editDistance(a, b) {
  const s = String(a);
  const t = String(b);
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let previous = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) previous[j] = j;
  for (let i = 1; i <= s.length; i++) {
    const current = [i];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[t.length];
}

/**
 * The closest known name to a typo, or ''. A shared prefix counts, because
 * "review" for a missing "reviewer" should match even though it is short.
 */
function nearestName(input, names) {
  const target = String(input == null ? '' : input).trim().toLowerCase();
  if (!target) return '';
  let best = '';
  let bestScore = Infinity;
  for (const name of names) {
    const distance = editDistance(target, String(name).toLowerCase());
    const prefix = target.length >= 3 && String(name).toLowerCase().startsWith(target.slice(0, 3));
    const score = prefix ? Math.min(distance, 2) : distance;
    if (score < bestScore) {
      bestScore = score;
      best = name;
    }
  }
  const limit = Math.max(2, Math.ceil(target.length / 3));
  return bestScore <= limit ? best : '';
}

function formatList(names) {
  return names.map((name) => `"${name}"`).join(', ');
}

function findByName(name, cwd, extraDirs) {
  const wanted = String(name == null ? '' : name).trim();
  const agents = listAgents(cwd, extraDirs);
  const found = agents.find((agent) => agent.name === wanted);
  if (found) return { ok: true, agent: found, agents };

  const names = agents.map((agent) => agent.name);
  const suggestion = nearestName(wanted, names);
  const where = agentDirs(cwd, extraDirs, []).map((entry) => entry.dir).join(', ');
  const lines = [`No subagent named "${wanted}".`];
  if (suggestion) lines.push(`Did you mean "${suggestion}"?`);
  if (names.length) lines.push(`Available: ${formatList(names)}.`);
  else lines.push('No subagents are defined yet.');
  lines.push(`Searched: ${where}.`);
  lines.push(
    'Add one as a markdown file with YAML frontmatter (name, description, tools, model) in one of those directories.'
  );

  return {
    ok: false,
    error: lines.join(' '),
    suggestion,
    available: names,
    agents,
  };
}

/**
 * Read one subagent, body included.
 *
 * Returns `{ ok: true, agent }` or `{ ok: false, error }` where the error is
 * something a person can act on — including the nearest name when the request
 * looks like a typo.
 */
function readAgent(name, cwd, extraDirs = []) {
  const result = findByName(name, cwd, extraDirs);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      suggestion: result.suggestion,
      available: result.available,
    };
  }
  return { ok: true, agent: result.agent };
}

/** Names only — cheap, and what a schema enum or an error message wants. */
function agentNames(cwd, extraDirs = []) {
  return listAgents(cwd, extraDirs).map((agent) => agent.name);
}

/* ------------------------------------------------------------------ *
 * System-prompt block
 * ------------------------------------------------------------------ */

const AGENT_HEADER =
  'Available subagents: delegate with the task tool, choosing the agent whose description fits the job.';

function agentLine(agent) {
  const description = String(agent.description || '').replace(/\s+/g, ' ').trim();
  // A description is what the model chooses on. When it is missing, say so here
  // too — otherwise the line is a bare name that looks like a complete option.
  return description ? `- ${agent.name} — ${description}` : `- ${agent.name} — (no description)`;
}

/** How many of the trailing lines to drop so the notice still fits. */
function fitNotice(max, total, kept) {
  let omitted = total - kept;
  while (kept > 0 && `\n... and ${omitted} more not listed.`.length + kept > max) {
    kept--;
    omitted++;
  }
  return omitted;
}

/**
 * The compact subagent list for the main system prompt. One line per agent,
 * `name — description`, capped at PROMPT_LIMIT characters.
 *
 * Returns '' when there is nothing to say, so a caller can append it
 * unconditionally without leaving a stray empty section in the prompt.
 */
function agentsForPrompt(cwd, extraDirs = [], limit = PROMPT_LIMIT) {
  const agents = listAgents(cwd, extraDirs);
  if (!agents.length) return '';

  const max = Number(limit) || PROMPT_LIMIT;
  const lines = [AGENT_HEADER];
  for (const agent of agents) lines.push(agentLine(agent));

  let text = lines.join('\n');
  if (text.length <= max) return text;

  // Drop whole agents from the end rather than cutting mid-sentence, then say
  // how many were left out so the model knows the list is incomplete.
  let kept = agents.length;
  while (kept > 1) {
    const omitted = fitNotice(max, agents.length, kept);
    const candidate = [AGENT_HEADER, ...agents.slice(0, kept).map(agentLine)].join('\n') +
      `\n... and ${omitted} more not listed.`;
    if (candidate.length <= max) return candidate;
    kept--;
  }

  // One very long description can still overflow; clamp it and keep the promise
  // that the result fits the cap.
  const notice = `\n... and ${agents.length - 1} more not listed.`;
  const room = Math.max(0, max - AGENT_HEADER.length - notice.length - 3);
  const only = `- ${agents[0].name} — ${agents[0].description || '(no description)'}`;
  return `${AGENT_HEADER}\n${only.slice(0, room)}${notice}`.slice(0, max);
}

/* ------------------------------------------------------------------ *
 * The `task` tool
 * ------------------------------------------------------------------ */

const TASK_TOOL_DESCRIPTION = [
  'Delegate a self-contained piece of work to a subagent, which runs with its own context and returns a report.',
  'The subagent cannot see this conversation, so the prompt must carry everything it needs: what to do, which',
  'paths to look at, and what to report back. Use it to keep long reading or searching out of this context, or to',
  'get a second, independent opinion on work you have already done.',
].join(' ');

/**
 * Build the `task` tool definition with `agent` constrained to the names that
 * actually exist. Call this at request time; `agentToolDefinition()` alone
 * leaves the enum empty, which is valid but unhelpful to the model.
 */
function taskToolFor(cwd, extraDirs = []) {
  return agentToolDefinition(agentNames(cwd, extraDirs));
}

/**
 * A tool definition in exactly the shape of the entries in `src/lib/tools.js`:
 * `{ name, permission, description, parameters, run(args, ctx) }`.
 *
 * Name: `task`, not `agent` — `agent` is also the optional argument name, and
 * "agent: agent" reads badly in a transcript.
 *
 * `run` executes NOTHING itself. Real execution lives in the agent loop, which
 * injects `ctx.runSubagent`. That keeps this module free of any dependency on
 * the loop, the LLM client or the server.
 */
function agentToolDefinition(knownNames = []) {
  const names = (Array.isArray(knownNames) ? knownNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);

  const agentParameter = {
    type: 'string',
    description:
      'Which subagent to use. Must be one of the defined subagent names. Omit to let Klaud choose the default.',
  };
  if (names.length) agentParameter.enum = names;

  return {
    name: 'task',
    // 'exec', not 'read': a subagent runs its own tools, so a read-only session
    // must not be able to reach write or run_command through this door.
    permission: 'exec',
    description: TASK_TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Short label for the task, shown to the user while the subagent works (3-8 words).',
        },
        prompt: {
          type: 'string',
          description:
            'The complete instruction for the subagent. It shares no context with this conversation, so include every detail it needs.',
        },
        agent: agentParameter,
      },
      required: ['description', 'prompt'],
    },
    async run(args, ctx = {}) {
      const runner = ctx && typeof ctx.runSubagent === 'function' ? ctx.runSubagent : null;
      if (!runner) {
        // Not an error the model caused, and throwing would surface as a stack
        // trace, so hand back the same `{ ok, output }` shape every other tool
        // result uses.
        return { ok: false, output: 'Subagents are not available in this context.' };
      }

      const description = String(args && args.description != null ? args.description : '').trim();
      const prompt = String(args && args.prompt != null ? args.prompt : '').trim();
      const agent = args && args.agent != null ? String(args.agent).trim() : '';

      if (!prompt) {
        return { ok: false, output: 'task requires a "prompt": the full instruction for the subagent.' };
      }

      // Deliberately minimal: `{ description, prompt, agent }` and nothing else.
      // What a subagent is, how it is sandboxed and what it costs are decisions
      // for the code that owns execution, not for this definition.
      //
      // A runner that throws is turned into a failed result rather than being
      // allowed to escape: the model should always see a tool result it can read
      // and react to, never a broken turn.
      let result;
      try {
        result = await runner({ description, prompt, agent });
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        return { ok: false, output: `Subagent failed: ${message}` };
      }

      if (result && typeof result === 'object' && typeof result.output === 'string') {
        return { ok: result.ok !== false, output: result.output };
      }
      return {
        ok: true,
        output: result == null ? '' : typeof result === 'string' ? result : JSON.stringify(result),
      };
    },
  };
}

module.exports = {
  listAgents,
  readAgent,
  agentsForPrompt,
  agentToolDefinition,
  // Extra surface used by the wiring layer and by tests.
  agentNames,
  taskToolFor,
  parseFrontmatter,
  personalAgentsDir,
  projectAgentsDir,
  PROMPT_LIMIT,
};
