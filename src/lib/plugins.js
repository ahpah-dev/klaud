'use strict';

/**
 * Plugins: a directory that bundles the components Klaud already understands.
 *
 * Two roots are scanned:
 *
 *   <workspace>/.klaud/plugins/<plugin>/   project plugins
 *   <data dir>/plugins/<plugin>/           personal plugins (~/.klaud/plugins)
 *
 * and the layout inside a plugin is the published one, so a plugin written for
 * another agent tool works here unchanged:
 *
 *   <plugin>/.claude-plugin/plugin.json    manifest (optional)
 *   <plugin>/skills/<name>/SKILL.md        skills
 *   <plugin>/commands/<name>.md            slash commands
 *   <plugin>/agents/<name>.md              subagent definitions
 *
 * This module reports *paths*, never parsed components. Reading SKILL.md,
 * command front matter or an agent definition belongs to the modules that
 * consume those paths; all this file decides is which files are part of an
 * enabled plugin and where they live. It also never writes, and never installs
 * or downloads anything: dependency problems are reported, not resolved.
 *
 * Everything is synchronous. A scan is a few readdir calls over two small
 * directories, and every caller (the system-prompt builder, the skills loader)
 * wants a plain array now rather than a promise.
 */

const fs = require('fs');
const path = require('path');
const { dataDir } = require('../config');

const MANIFEST_REL = path.join('.claude-plugin', 'plugin.json');

/** The component kinds this module reports paths for. */
const COMPONENTS = ['skills', 'commands', 'agents'];

/** Standard layout, used whenever a manifest does not override a component. */
const DEFAULT_LAYOUT = {
  skills: ['skills'],
  commands: ['commands'],
  agents: ['agents'],
};

/**
 * Components the published plugin format defines and Klaud does not implement.
 *
 * These are reported explicitly instead of being dropped on the floor. A plugin
 * that declares hooks or MCP servers otherwise loads successfully, its skills
 * work, and the parts that were meant to run on every tool call never do - a
 * behaviour difference the user cannot see and therefore cannot diagnose.
 * One warning line buys honesty about what is actually running, so a manifest
 * key Klaud ignores is always named in `warnings`.
 */
const UNSUPPORTED_COMPONENTS = [
  ['hooks', 'plugin hooks'],
  ['mcpServers', 'MCP servers'],
];

/* ------------------------------------------------------------------ *
 * Small filesystem helpers
 * ------------------------------------------------------------------ */

function statOrNull(target) {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
}

function isDir(target) {
  const st = statOrNull(target);
  return Boolean(st && st.isDirectory());
}

function isFile(target) {
  const st = statOrNull(target);
  return Boolean(st && st.isFile());
}

/** realpath, or null when the path does not resolve (missing, or a loop). */
function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

function uniquePush(list, value) {
  if (!list.includes(value)) list.push(value);
}

function typeName(value) {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  return `a ${typeof value}`;
}

/** True when a manifest key carries no declaration worth reporting. */
function isAbsent(value) {
  if (value === undefined || value === null || value === false || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;
  return false;
}

function normalizeCwd(cwd) {
  return typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd) : process.cwd();
}

/* ------------------------------------------------------------------ *
 * Roots and discovery
 * ------------------------------------------------------------------ */

/**
 * Personal plugins sit next to settings and chats under the same data
 * directory, so they follow KLAUD_DATA_DIR and any future move of the data dir
 * without a second definition of "where the user's Klaud files live".
 */
function personalPluginsRoot() {
  return path.join(dataDir(), 'plugins');
}

function projectPluginsRoot(cwd) {
  return path.join(normalizeCwd(cwd), '.klaud', 'plugins');
}

/**
 * Every directory under `root` is a candidate plugin. A missing root is the
 * normal case, not an error: most users have never created one.
 */
function readPluginDirs(root, source) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const out = [];
  for (const entry of entries) {
    // A dot directory is editor or VCS clutter, never a plugin. Symlinks are
    // followed deliberately: linking a plugin checkout into the plugins
    // directory is how people develop one.
    if (entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    if (!isDir(dir)) continue;
    out.push({ dir, dirName: entry.name, source });
  }
  out.sort((a, b) => a.dirName.localeCompare(b.dirName));
  return out;
}

/* ------------------------------------------------------------------ *
 * Manifest
 * ------------------------------------------------------------------ */

/**
 * Read plugin.json. A broken manifest never hides the plugin: the standard
 * layout is still loaded and the problem is reported, because a typo in a JSON
 * file should not make an installed plugin vanish without explanation.
 */
function readManifest(dir) {
  const file = path.join(dir, MANIFEST_REL);
  if (!isFile(file)) return { manifest: null, warnings: [] };

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return {
      manifest: null,
      warnings: [
        `plugin.json could not be read (${err.message}); the standard layout was used instead.`,
      ],
    };
  }

  let parsed;
  try {
    // Editors on Windows happily write a UTF-8 BOM, which JSON.parse rejects
    // with a message that points at the wrong character. Strip it first.
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    return {
      manifest: null,
      warnings: [
        `plugin.json is not valid JSON (${err.message}); the plugin was loaded from its ` +
          'standard layout instead, so fix the manifest rather than reinstalling.',
      ],
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      manifest: null,
      warnings: [
        `plugin.json must contain a JSON object with a field per setting (found ${typeName(parsed)}); ` +
          'the standard layout was used instead.',
      ],
    };
  }

  return { manifest: parsed, warnings: [] };
}

const STRING_FIELDS = [
  'name',
  'displayName',
  'version',
  'description',
  'homepage',
  'repository',
  'license',
];

/**
 * Field-level validation. A value of the wrong type is ignored with a warning
 * rather than coerced: `"version": 1.0` becomes the string "1" if you coerce it,
 * which is a silently wrong thing to show a user.
 */
function readFields(manifest, warnings) {
  const fields = {
    name: '',
    displayName: '',
    version: '',
    description: '',
    homepage: '',
    repository: '',
    license: '',
    author: null,
    keywords: [],
    defaultEnabled: false,
    dependencies: [],
    overrides: { skills: null, commands: null, agents: null },
  };
  if (!manifest) return fields;

  for (const key of STRING_FIELDS) {
    const value = manifest[key];
    if (value === undefined || value === null) continue;
    if (typeof value === 'string') {
      fields[key] = value.trim();
    } else {
      warnings.push(`"${key}" must be a string (found ${typeName(value)}) and was ignored.`);
    }
  }

  if (manifest.author !== undefined && manifest.author !== null) {
    if (typeof manifest.author === 'string') {
      fields.author = manifest.author.trim();
    } else if (typeof manifest.author === 'object' && !Array.isArray(manifest.author)) {
      // Both documented shapes are kept as written: a string stays a string, an
      // object is narrowed to the documented keys so unknown junk cannot reach
      // the UI, and an object with none of them is a mistake worth reporting.
      const author = {};
      for (const key of ['name', 'email', 'url']) {
        if (typeof manifest.author[key] === 'string' && manifest.author[key].trim()) {
          author[key] = manifest.author[key].trim();
        }
      }
      if (Object.keys(author).length) {
        fields.author = author;
      } else {
        warnings.push('"author" has none of the documented name/email/url strings and was ignored.');
      }
    } else {
      warnings.push(
        `"author" must be a string or an object with name/email/url (found ${typeName(manifest.author)}) and was ignored.`
      );
    }
  }

  if (manifest.keywords !== undefined && manifest.keywords !== null) {
    if (Array.isArray(manifest.keywords)) {
      const kept = manifest.keywords.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim());
      if (kept.length !== manifest.keywords.length) {
        warnings.push('"keywords" contains entries that are not strings; those were dropped.');
      }
      fields.keywords = kept;
    } else {
      warnings.push(`"keywords" must be an array of strings (found ${typeName(manifest.keywords)}) and was ignored.`);
    }
  }

  if (manifest.defaultEnabled !== undefined && manifest.defaultEnabled !== null) {
    if (typeof manifest.defaultEnabled === 'boolean') {
      fields.defaultEnabled = manifest.defaultEnabled;
    } else {
      warnings.push(
        `"defaultEnabled" must be a boolean (found ${typeName(manifest.defaultEnabled)}); ` +
          'the plugin stays off by default.'
      );
    }
  }

  if (manifest.dependencies !== undefined && manifest.dependencies !== null) {
    if (Array.isArray(manifest.dependencies)) {
      const named = manifest.dependencies.filter((d) => typeof d === 'string' && d.trim()).map((d) => d.trim());
      if (named.length !== manifest.dependencies.length) {
        warnings.push('"dependencies" contains entries that are not plugin names; those were dropped.');
      }
      fields.dependencies = [...new Set(named)];
    } else {
      warnings.push(
        `"dependencies" must be an array of plugin names (found ${typeName(manifest.dependencies)}) and was ignored.`
      );
    }
  }

  for (const kind of COMPONENTS) {
    const value = manifest[kind];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const paths = value.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim());
      if (paths.length !== value.length) {
        warnings.push(`"${kind}" contains entries that are not path strings; those were dropped.`);
      }
      // An explicit list - even an empty one - replaces the standard layout.
      fields.overrides[kind] = paths.map((p) => ({ path: p }));
    } else if (kind === 'commands' && typeof value === 'object') {
      // Commands also accept an object map of command name to relative path.
      const mapped = [];
      for (const [key, rel] of Object.entries(value)) {
        if (typeof rel === 'string' && rel.trim()) {
          mapped.push({ path: rel.trim(), name: key });
        } else {
          warnings.push(
            `"commands" entry "${key}" is not a path string (found ${typeName(rel)}) and was ignored.`
          );
        }
      }
      fields.overrides[kind] = mapped;
    } else {
      warnings.push(
        `"${kind}" must be ${kind === 'commands' ? 'an array of paths or an object of name to path' : 'an array of paths'} ` +
          `(found ${typeName(value)}) and was ignored.`
      );
    }
  }

  for (const [key, label] of UNSUPPORTED_COMPONENTS) {
    if (!isAbsent(manifest[key])) {
      warnings.push(
        `declares "${key}" (${label}), which Klaud does not implement; it will be ignored. ` +
          'Nothing is broken in the plugin itself - this build simply has no such component.'
      );
    }
  }

  return fields;
}

/* ------------------------------------------------------------------ *
 * Component discovery
 * ------------------------------------------------------------------ */

/**
 * Resolve a manifest-declared path against the plugin directory and prove it
 * stays inside that directory.
 *
 * A plugin is untrusted input: it normally arrives by cloning somebody's
 * repository, and its manifest is written by whoever wrote the repository. A
 * declared path therefore must never be able to point at anything the user did
 * not install - `../../..` and `/etc` would otherwise let a cloned repo aim
 * Klaud's skills, commands and subagents at files of its choosing outside its
 * own directory. So an escaping or absolute path is rejected and warned about,
 * never followed. Rejection is checked on the *resolved* path, and again on the
 * real path, because a symlink inside the plugin can point anywhere.
 */
function resolveDeclared(pluginDir, rel) {
  if (typeof rel !== 'string' || !rel.trim()) return { ok: false, reason: 'is not a usable path' };
  if (rel.includes('\0')) return { ok: false, reason: 'contains a null byte' };
  if (path.isAbsolute(rel)) return { ok: false, reason: 'is an absolute path' };

  const abs = path.resolve(pluginDir, rel);
  const inside = path.relative(pluginDir, abs);
  if (inside !== '' && (inside.startsWith('..') || path.isAbsolute(inside))) {
    return { ok: false, reason: 'escapes the plugin directory' };
  }

  const real = realpathOrNull(abs);
  const realRoot = realpathOrNull(pluginDir);
  if (real && realRoot) {
    const realInside = path.relative(realRoot, real);
    if (realInside !== '' && (realInside.startsWith('..') || path.isAbsolute(realInside))) {
      return { ok: false, reason: 'points outside the plugin directory through a symbolic link' };
    }
  }

  return { ok: true, abs };
}

function declarePaths(fields, kind) {
  const override = fields.overrides[kind];
  if (override) return override.map((entry) => ({ ...entry, explicit: true }));
  // The standard layout is a suggestion, not a promise: a commands-only plugin
  // has no skills directory and that is not a fault. So only an explicitly
  // declared path is expected to exist, and only that one is complained about.
  return DEFAULT_LAYOUT[kind].map((p) => ({ path: p, explicit: false }));
}

function reject(pluginName, kind, declared, reason, warnings) {
  // A path from the manifest is "declared"; the standard layout path is not,
  // and saying so keeps the warning accurate about where the path came from.
  const where = declared.explicit
    ? `the declared ${kind} path "${declared.path}"`
    : `the standard ${kind} directory ("${declared.path}")`;
  warnings.push(
    `plugin "${pluginName}": ${where} ${reason}, so it was not followed. ` +
      'Components must live inside the plugin directory.'
  );
}

/**
 * Skills are directories. The standard layout puts them one level below the
 * plugin's skills directory, but a manifest path may also point straight at a
 * single skill, so both shapes are accepted. The directory name is the skill
 * name - the SKILL.md parser owns anything richer, and this module only checks
 * that the file exists.
 */
function collectSkills(pluginDir, pluginName, fields, warnings) {
  const skills = [];
  const roots = [];

  for (const declared of declarePaths(fields, 'skills')) {
    const target = resolveDeclared(pluginDir, declared.path);
    if (!target.ok) {
      reject(pluginName, 'skills', declared, target.reason, warnings);
      continue;
    }
    if (!isDir(target.abs)) {
      // A missing *standard* directory is simply a plugin without that kind of
      // component. A missing declared path is an authoring mistake.
      if (declared.explicit) {
        warnings.push(
          `plugin "${pluginName}": the declared skills path "${declared.path}" is not a directory and was ignored.`
        );
      }
      continue;
    }
    uniquePush(roots, target.abs);

    if (isFile(path.join(target.abs, 'SKILL.md'))) {
      skills.push({ name: path.basename(target.abs), path: target.abs });
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(target.abs, { withFileTypes: true });
    } catch (err) {
      warnings.push(`plugin "${pluginName}": the skills path "${declared.path}" could not be read (${err.message}).`);
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const dir = path.join(target.abs, entry.name);
      if (!isDir(dir)) continue;
      skills.push({ name: entry.name, path: dir });
      if (!isFile(path.join(dir, 'SKILL.md'))) {
        // Listed anyway, so the author can see it exists, plus the reason it
        // will not load as a skill. Silence here looks like a broken parser.
        warnings.push(
          `plugin "${pluginName}": skills/${entry.name} has no SKILL.md, so it will not load as a skill.`
        );
      }
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  roots.sort((a, b) => a.localeCompare(b));
  return { skills, roots };
}

/** Commands and agents are single markdown files, or directories of them. */
function collectMarkdown(pluginDir, pluginName, fields, kind, warnings) {
  const found = [];
  for (const declared of declarePaths(fields, kind)) {
    const target = resolveDeclared(pluginDir, declared.path);
    if (!target.ok) {
      reject(pluginName, kind, declared, target.reason, warnings);
      continue;
    }

    const st = statOrNull(target.abs);
    if (!st) {
      if (declared.explicit) {
        warnings.push(
          `plugin "${pluginName}": the declared ${kind} path "${declared.path}" does not exist and was ignored.`
        );
      }
      continue;
    }

    if (st.isFile()) {
      if (!target.abs.toLowerCase().endsWith('.md')) {
        if (declared.explicit) {
          warnings.push(
            `plugin "${pluginName}": the declared ${kind} path "${declared.path}" is not a markdown file and was ignored.`
          );
        }
        continue;
      }
      found.push({ name: declared.name || path.basename(target.abs, path.extname(target.abs)), path: target.abs });
      continue;
    }

    if (declared.name) {
      // A named entry in the commands map is one command, so a directory cannot
      // satisfy it. Guessing which file inside was meant would be worse.
      warnings.push(
        `plugin "${pluginName}": the declared commands entry "${declared.name}" points at a directory, not a markdown file, and was ignored.`
      );
      continue;
    }

    let entries;
    try {
      entries = fs.readdirSync(target.abs, { withFileTypes: true });
    } catch (err) {
      warnings.push(
        `plugin "${pluginName}": the declared ${kind} path "${declared.path}" could not be read (${err.message}).`
      );
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue;
      found.push({
        name: declared.name || entry.name.slice(0, -3),
        path: path.join(target.abs, entry.name),
      });
    }
  }

  found.sort((a, b) => a.name.localeCompare(b.name));
  return found;
}

/* ------------------------------------------------------------------ *
 * One plugin
 * ------------------------------------------------------------------ */

function scanPlugin(entry) {
  const { dir, dirName, source } = entry;
  const { manifest, warnings } = readManifest(dir);
  const fields = readFields(manifest, warnings);

  // The manifest name wins when it is present, so a hand-written plugin without
  // a manifest - the common case - is named after its directory and needs no
  // extra file to work.
  const name = fields.name || dirName;

  const skillResult = collectSkills(dir, name, fields, warnings);
  const commands = collectMarkdown(dir, name, fields, 'commands', warnings);
  const agents = collectMarkdown(dir, name, fields, 'agents', warnings);

  return {
    dirName,
    name,
    displayName: fields.displayName,
    version: fields.version,
    description: fields.description,
    author: fields.author,
    homepage: fields.homepage,
    repository: fields.repository,
    license: fields.license,
    keywords: fields.keywords,
    dir,
    source,
    // The plugin's own default. What is actually active depends on the enabled
    // map, which is resolveEnabledPlugins' job - listPlugins has no opinion.
    enabled: fields.defaultEnabled,
    skills: skillResult.skills.map((s) => s.name),
    commands: commands.map((c) => c.name),
    agents: agents.map((a) => a.name),
    dependencies: fields.dependencies,
    warnings,
    // Paths for the integration point. Kept off the public shape on purpose:
    // listPlugins reports names, pluginSources reports files.
    skillDirs: skillResult.roots,
    skillEntries: skillResult.skills,
    commandFiles: commands,
    agentFiles: agents,
  };
}

/**
 * The public shape. `homepage` and `repository` are carried through as well:
 * the manifest documents them, and dropping a field an author bothered to write
 * means the UI has nowhere to show it. Everything else is names, not internals.
 */
function toPublic(record) {
  return {
    name: record.name,
    displayName: record.displayName,
    version: record.version,
    description: record.description,
    author: record.author,
    homepage: record.homepage,
    repository: record.repository,
    license: record.license,
    keywords: record.keywords,
    dir: record.dir,
    source: record.source,
    enabled: record.enabled,
    skills: record.skills,
    commands: record.commands,
    agents: record.agents,
    dependencies: record.dependencies,
    warnings: record.warnings,
  };
}

/** Project root first: on a name clash the project copy is the preferred one. */
function scanAll(cwd) {
  const records = [
    ...readPluginDirs(projectPluginsRoot(cwd), 'project').map(scanPlugin),
    ...readPluginDirs(personalPluginsRoot(), 'personal').map(scanPlugin),
  ];

  // Two directories can declare the same plugin name. Loading one and silently
  // discarding the other is exactly the quiet wrongness this module exists to
  // avoid, so the shadowed copy says so on its own record.
  const seen = new Map();
  for (const record of records) {
    const key = `${record.source}/${record.name}`;
    const first = seen.get(key);
    if (first) {
      record.warnings.push(
        `another ${record.source} plugin already uses the name "${record.name}" (${first}); ` +
          `this copy (${record.dir}) is the one that gets ignored.`
      );
    } else {
      seen.set(key, record.dir);
    }
  }

  // A personal plugin whose name is also installed in the project root never
  // loads while that copy exists. It is still listed - it is installed, and
  // hiding it would make it impossible to find or remove - with the reason.
  const projectNames = new Map(
    records.filter((r) => r.source === 'project').map((r) => [r.name, r.dir])
  );
  for (const record of records) {
    if (record.source !== 'personal') continue;
    const shadowing = projectNames.get(record.name);
    if (shadowing) {
      record.warnings.push(
        `a project plugin of the same name (${shadowing}) shadows this copy; the project copy is the one that loads.`
      );
    }
  }

  return records;
}

/**
 * Dependencies are advisory and local. A plugin whose dependency is missing or
 * switched off still loads, with a warning: there is nothing to install from,
 * Klaud never fetches anything, and refusing to load would leave the user with a
 * plugin that silently does not appear and no offline way to fix it.
 */
function checkDependencies(record, installed, enabledNames) {
  for (const dep of record.dependencies) {
    let message = '';
    if (!installed.has(dep)) {
      message = `plugin "${record.name}" depends on "${dep}", which is not installed.`;
    } else if (enabledNames && !enabledNames.has(dep)) {
      message = `plugin "${record.name}" depends on "${dep}", which is installed but not enabled.`;
    }
    if (message) uniquePush(record.warnings, message);
  }
}

/* ------------------------------------------------------------------ *
 * Public interface
 * ------------------------------------------------------------------ */

/**
 * Every plugin found in both roots, with the components each one contributes.
 * Shadowed personal plugins are still listed - they are installed, and hiding
 * one would make it impossible to see or manage - but the shadowing is stated
 * in their warnings.
 */
function listPlugins(cwd) {
  const records = scanAll(cwd);
  const installed = new Set(records.map((r) => r.name));
  for (const record of records) checkDependencies(record, installed, null);

  return records
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.source.localeCompare(b.source) || a.dir.localeCompare(b.dir))
    .map(toPublic);
}

/**
 * One plugin by name, project copy first. The directory name is accepted as
 * well as the manifest name, so a plugin whose manifest renames it is still
 * reachable under the name the user sees on disk.
 */
function loadPlugin(name, cwd) {
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (!wanted) return { ok: false, error: 'a plugin name is required' };

  const records = scanAll(cwd);
  const installed = new Set(records.map((r) => r.name));
  for (const record of records) checkDependencies(record, installed, null);

  const found = records.find((r) => r.name === wanted || r.dirName === wanted);
  if (!found) {
    const known = records.map((r) => r.name).sort((a, b) => a.localeCompare(b));
    return {
      ok: false,
      error:
        `no plugin named "${wanted}" was found in ${projectPluginsRoot(cwd)} or ${personalPluginsRoot()}. ` +
        (known.length ? `Installed plugins: ${known.join(', ')}.` : 'No plugins are installed.'),
    };
  }

  // `ok` is the discriminator the failure shape needs, and consumers can read
  // the same fields they get from listPlugins once it is true.
  return { ok: true, ...toPublic(found) };
}

function isEnabled(record, enabledMap) {
  const value = enabledMap ? enabledMap[record.name] : undefined;
  if (typeof value === 'boolean') return value;
  // A UI usually round-trips this map through JSON or form values, so the string
  // spellings of the two booleans decide as well. Silently ignoring "false" would
  // switch a plugin off - or on - for no visible reason.
  if (value === 'true') return true;
  if (value === 'false') return false;
  // Anything else, including a missing key, leaves defaultEnabled in charge.
  return record.enabled;
}

/**
 * The active plugins as full records, including the paths the public shape
 * deliberately leaves out. Shadowing, defaults and dependency warnings are all
 * decided here, so every consumer sees the same answer.
 */
function activeRecords(cwd, enabledMap = {}) {
  const map = enabledMap && typeof enabledMap === 'object' ? enabledMap : {};
  const records = scanAll(cwd);
  const installed = new Set(records.map((r) => r.name));

  // Project plugins shadow personal ones of the same name: the copy that lives
  // in the workspace is the one the workspace asked for.
  const chosen = new Map();
  for (const record of records) {
    const existing = chosen.get(record.name);
    if (existing && !(existing.source === 'personal' && record.source === 'project')) continue;
    chosen.set(record.name, record);
  }

  const active = [...chosen.values()].filter((record) => isEnabled(record, map));
  const enabledNames = new Set(active.map((r) => r.name));
  for (const record of active) checkDependencies(record, installed, enabledNames);

  return active.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The plugins that should be active. An enabled map is the user's choice and
 * always wins over defaultEnabled in both directions.
 */
function resolveEnabledPlugins(cwd, enabledMap = {}) {
  return activeRecords(cwd, enabledMap).map((record) => ({ ...toPublic(record), enabled: true }));
}

/**
 * The integration point: plain filesystem paths for the skills loader, the
 * slash-command list and the subagent list, plus every warning worth showing.
 *
 *   skillDirs    each enabled plugin's skills root, to scan for skills
 *   skills       one entry per skill directory, with its plugin
 *   commandFiles one .md file per slash command
 *   agentFiles   one .md file per subagent
 */
function pluginSources(cwd, enabledMap = {}) {
  const skillDirs = [];
  const skills = [];
  const commandFiles = [];
  const agentFiles = [];
  const warnings = [];

  for (const plugin of activeRecords(cwd, enabledMap)) {
    for (const dir of plugin.skillDirs) uniquePush(skillDirs, dir);
    for (const skill of plugin.skillEntries) {
      skills.push({ name: skill.name, plugin: plugin.name, path: skill.path });
    }
    for (const command of plugin.commandFiles) {
      commandFiles.push({ name: command.name, plugin: plugin.name, path: command.path });
    }
    for (const agent of plugin.agentFiles) {
      agentFiles.push({ name: agent.name, plugin: plugin.name, path: agent.path });
    }
    for (const warning of plugin.warnings) uniquePush(warnings, warning);
  }

  return { skillDirs, skills, commandFiles, agentFiles, warnings };
}

/** Compact summary of what is active, for the system prompt. */
function pluginsForPrompt(cwd, enabledMap = {}) {
  const active = activeRecords(cwd, enabledMap);
  if (!active.length) return '';

  const lines = [`Enabled plugins (${active.length}):`];
  for (const plugin of active) {
    const label =
      plugin.displayName && plugin.displayName !== plugin.name
        ? `${plugin.displayName} (${plugin.name})`
        : plugin.name;
    const meta = [plugin.source];
    if (plugin.version) meta.push(`v${plugin.version}`);

    const parts = [];
    if (plugin.skills.length) parts.push(`${count(plugin.skills.length, 'skill')}: ${plugin.skills.join(', ')}`);
    if (plugin.commands.length) {
      parts.push(`${count(plugin.commands.length, 'command')}: ${plugin.commands.map((c) => `/${c}`).join(', ')}`);
    }
    if (plugin.agents.length) parts.push(`${count(plugin.agents.length, 'agent')}: ${plugin.agents.join(', ')}`);

    let line = `- ${label} [${meta.join(', ')}] - ${parts.length ? parts.join('; ') : 'no components'}`;
    if (plugin.description) line += ` - ${plugin.description}`;
    lines.push(line);
  }

  // Dependency problems belong in the prompt too: a plugin that half-works
  // because its dependency is off is something the model should know before it
  // relies on it.
  const warnings = [];
  for (const plugin of active) for (const warning of plugin.warnings) uniquePush(warnings, warning);
  if (warnings.length) {
    lines.push('Plugin warnings:');
    for (const warning of warnings) lines.push(`- ${warning}`);
  }

  return lines.join('\n');
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

module.exports = {
  listPlugins,
  loadPlugin,
  resolveEnabledPlugins,
  pluginSources,
  pluginsForPrompt,
  // Internals a wiring layer may want without reaching into the filesystem
  // itself. Not part of the interface other modules were promised.
  personalPluginsRoot,
  projectPluginsRoot,
};
