'use strict';

/**
 * Plugin system test.
 *
 *   node test/plugins.js
 *
 * Everything here runs against throwaway directories. KLAUD_DATA_DIR is pointed
 * at a temp directory *before* the module is loaded, so the suite can never read
 * or write the real ~/.klaud - a test that deletes a personal plugin would
 * otherwise be a test that deletes the user's work.
 *
 * The manifest is untrusted input that normally arrives by cloning a repository,
 * so the checks about rejected paths and reported-but-unimplemented components
 * are as important as the ones about fields being parsed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'klaud-plugins-'));
const DATA = path.join(SANDBOX, 'data');
process.env.KLAUD_DATA_DIR = DATA;

const WORKSPACE = path.join(SANDBOX, 'workspace');
const EMPTY_WORKSPACE = path.join(SANDBOX, 'empty-workspace');

const {
  listPlugins,
  loadPlugin,
  resolveEnabledPlugins,
  pluginSources,
  pluginsForPrompt,
  personalPluginsRoot,
  projectPluginsRoot,
} = require('../src/lib/plugins');

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

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const PERSONAL_ROOT = path.join(DATA, 'plugins');
const PROJECT_ROOT = path.join(WORKSPACE, '.klaud', 'plugins');

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

function writeJson(file, value) {
  write(file, JSON.stringify(value, null, 2));
}

function manifest(dir, value) {
  writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), value);
}

function skillFile(dir, name) {
  write(path.join(dir, 'skills', name, 'SKILL.md'), `# ${name}\n\nDoes a thing.\n`);
}

const project = (name) => path.join(PROJECT_ROOT, name);
const personal = (name) => path.join(PERSONAL_ROOT, name);

/** A skill directory behind an escape path, so "not followed" is provable. */
write(path.join(WORKSPACE, 'outside', 'skills', 'evil', 'SKILL.md'), '# evil\n');
write(path.join(WORKSPACE, 'outside', 'commands', 'evil.md'), '# evil\n');
write(path.join(WORKSPACE, 'outside', 'agents', 'evil.md'), '# evil\n');

/* 1. Every documented manifest field, plus all three component kinds. */
const fullDir = project('full');
manifest(fullDir, {
  name: 'full-manifest',
  displayName: 'Full Manifest Plugin',
  version: '2.1.0',
  description: 'Every documented field, set.',
  author: { name: 'Ada Lovelace', email: 'ada@example.com', url: 'https://example.com/ada' },
  homepage: 'https://example.com/full',
  repository: 'https://example.com/full.git',
  license: 'MIT',
  keywords: ['lint', 'test'],
  defaultEnabled: true,
  dependencies: ['dep-present'],
});
skillFile(fullDir, 'style');
write(path.join(fullDir, 'commands', 'deploy.md'), '# /deploy\n');
write(path.join(fullDir, 'agents', 'reviewer.md'), '# reviewer\n');

/* 2. The dependency the full manifest names, so it resolves cleanly. */
skillFile(project('dep-present'), 'dep');

/* 3. No manifest at all: the standard layout and the directory name. */
const plainDir = project('plain');
skillFile(plainDir, 'notes');
write(path.join(plainDir, 'commands', 'hello.md'), '# /hello\n');
write(path.join(plainDir, 'agents', 'helper.md'), '# helper\n');

/* 4. author as a plain string. */
const authorStrDir = project('author-str');
manifest(authorStrDir, { name: 'author-str', author: 'Bob <bob@example.com>' });
skillFile(authorStrDir, 'bob');

/* 5. Path overrides, including a command renamed by the object map. */
const overridesDir = project('overrides');
manifest(overridesDir, {
  name: 'overrides',
  skills: ['custom/skillz'],
  commands: { ship: './extras/release.md', wrong: './extras/agents' },
  agents: ['./extras/agents'],
});
write(path.join(overridesDir, 'custom', 'skillz', 'greet', 'SKILL.md'), '# greet\n');
write(path.join(overridesDir, 'extras', 'release.md'), '# /release\n');
write(path.join(overridesDir, 'extras', 'agents', 'checker.md'), '# checker\n');
/* Decoys in the default layout: an override replaces it, it does not add to it. */
write(path.join(overridesDir, 'skills', 'decoy', 'SKILL.md'), '# decoy\n');
write(path.join(overridesDir, 'commands', 'decoy.md'), '# decoy\n');
write(path.join(overridesDir, 'agents', 'decoy.md'), '# decoy\n');

/* 6. A manifest trying to leave its own directory. */
const escapesDir = project('escapes');
manifest(escapesDir, {
  name: 'escapes',
  skills: ['../../../outside/skills'],
  commands: ['../../../outside/commands'],
  agents: ['../../../outside/agents'],
});

/* 7. Absolute paths, including one that happens to name the plugin itself. */
const absoluteDir = project('absolute');
manifest(absoluteDir, {
  name: 'absolute',
  commands: [absoluteDir],
  agents: [os.tmpdir()],
});
skillFile(absoluteDir, 'local');

/* 8. The same name in both roots. */
skillFile(project('shadow'), 'project-skill');
skillFile(personal('shadow'), 'personal-skill');
skillFile(personal('personal-only'), 'personal-only-skill');

/* 9. defaultEnabled, and the enabled map that overrides it both ways. */
manifest(project('default-on'), { name: 'default-on', defaultEnabled: true });
skillFile(project('default-on'), 'on');
manifest(project('default-off'), { name: 'default-off', defaultEnabled: false });
skillFile(project('default-off'), 'off');

/* 10. Dependencies: one missing, one installed but switched off. */
manifest(project('needs-dep'), { name: 'needs-dep', defaultEnabled: true, dependencies: ['ghost-plugin'] });
skillFile(project('needs-dep'), 'needy');
manifest(project('needs-off-dep'), {
  name: 'needs-off-dep',
  defaultEnabled: true,
  dependencies: ['default-off'],
});
skillFile(project('needs-off-dep'), 'off-dep');

/* 11. Components Klaud does not implement. */
manifest(project('unsupported'), {
  name: 'unsupported',
  hooks: { PreToolUse: [{ command: 'echo hi' }] },
  mcpServers: { files: { command: 'npx', args: ['-y', 'some-server'] } },
});
skillFile(project('unsupported'), 'works');

/* 12. Malformed JSON. */
write(path.join(project('broken'), '.claude-plugin', 'plugin.json'), '{ "name": "broken", oops }\n');
skillFile(project('broken'), 'broken-skill');

/* 13. A plugin that contributes nothing. */
fs.mkdirSync(project('empty'), { recursive: true });

/* 14. Two directories claiming one name. */
manifest(project('dup-a'), { name: 'dup' });
manifest(project('dup-b'), { name: 'dup' });

/* 15. A manifest written by an editor that adds a UTF-8 BOM. */
write(path.join(project('bom'), '.claude-plugin', 'plugin.json'), `\uFEFF${JSON.stringify({ name: 'bom' })}`);
skillFile(project('bom'), 'bom-skill');

/* 16. Fields of the wrong type. */
manifest(project('bad-types'), {
  name: 'bad-types',
  version: 1.0,
  keywords: 'lint',
  dependencies: 'dep-present',
  defaultEnabled: 'yes',
});
skillFile(project('bad-types'), 'bad');

/* 17. A directory under skills/ with no SKILL.md. */
fs.mkdirSync(path.join(project('no-skill-md'), 'skills', 'bare'), { recursive: true });

/* 18. A skills directory that is itself a symlink out of the plugin. Creating a
 * directory link needs no privilege on Windows (a junction) or POSIX, but if it
 * fails on this machine the two checks below are skipped rather than faked. */
const linkDir = project('linked');
fs.mkdirSync(path.join(linkDir, '.claude-plugin'), { recursive: true });
manifest(linkDir, { name: 'linked' });
write(path.join(SANDBOX, 'linked-outside', 'evil', 'SKILL.md'), '# evil\n');
let symlinkMade = false;
try {
  fs.symlinkSync(path.join(SANDBOX, 'linked-outside'), path.join(linkDir, 'skills'), 'junction');
  symlinkMade = true;
} catch {
  symlinkMade = false;
}

/* ------------------------------------------------------------------ *
 * Helpers over the results
 * ------------------------------------------------------------------ */

let listed = [];
function refresh() {
  listed = listPlugins(WORKSPACE);
  return listed;
}
const pick = (name, list = listed) => list.find((p) => p.name === name);
const warned = (plugin, pattern) => Boolean(plugin && plugin.warnings.some((w) => pattern.test(w)));

/**
 * An enabled map with everything off except the named plugins. Without it a
 * check about one plugin would also pick up every plugin whose manifest sets
 * defaultEnabled, and the assertion would be about the wrong thing.
 */
function only(...names) {
  const map = {};
  for (const plugin of listPlugins(WORKSPACE)) map[plugin.name] = false;
  for (const name of names) map[name] = true;
  return map;
}

console.log('\n\x1b[38;5;209m* Klaud plugin checks\x1b[0m\n');

/* ---------------------- personal root stays isolated ---------------------- */
check('the personal plugin root is inside the throwaway data directory',
  personalPluginsRoot().startsWith(DATA), personalPluginsRoot());
check('the personal plugin root is never the real home directory',
  !personalPluginsRoot().startsWith(path.join(os.homedir(), '.klaud')), personalPluginsRoot());
check('the project plugin root is inside the workspace',
  projectPluginsRoot(WORKSPACE) === PROJECT_ROOT, projectPluginsRoot(WORKSPACE));

/* ---------------------- inventory ---------------------- */
refresh();
check('listPlugins returns an array', Array.isArray(listed));
check('listPlugins finds the project plugins', listed.filter((p) => p.source === 'project').length >= 15,
  `${listed.length} found`);
check('listPlugins also finds personal plugins', Boolean(pick('personal-only')),
  listed.map((p) => p.name).join(', '));

const plain = pick('plain');
const documented = [
  'name', 'displayName', 'version', 'description', 'author', 'license', 'keywords',
  'dir', 'source', 'enabled', 'skills', 'commands', 'agents', 'dependencies', 'warnings',
];
const missingKeys = documented.filter((k) => plain[k] === undefined);
check('every documented field is present on a listed plugin', missingKeys.length === 0, missingKeys.join(', '));
check('dir is an absolute path', path.isAbsolute(plain.dir) && path.isAbsolute(pick('personal-only').dir));
check('source is project or personal', listed.every((p) => ['project', 'personal'].includes(p.source)));
check('the component lists are arrays of names',
  Array.isArray(plain.skills) && Array.isArray(plain.commands) && Array.isArray(plain.agents) &&
    plain.skills.every((s) => typeof s === 'string'));
check('the warnings list is an array of strings',
  Array.isArray(plain.warnings) && plain.warnings.every((w) => typeof w === 'string'));

/* ---------------------- full manifest, every field ---------------------- */
const full = pick('full-manifest');
check('a manifest name is used as the plugin name', full.name === 'full-manifest', full.name);
check('displayName is read', full.displayName === 'Full Manifest Plugin', full.displayName);
check('version is read', full.version === '2.1.0', full.version);
check('description is read', full.description === 'Every documented field, set.', full.description);
check('license is read', full.license === 'MIT', full.license);
check('keywords are read', JSON.stringify(full.keywords) === JSON.stringify(['lint', 'test']),
  JSON.stringify(full.keywords));
check('homepage is read', full.homepage === 'https://example.com/full', full.homepage);
check('repository is read', full.repository === 'https://example.com/full.git', full.repository);
check('an author object keeps name, email and url',
  full.author && full.author.name === 'Ada Lovelace' && full.author.email === 'ada@example.com' &&
    full.author.url === 'https://example.com/ada', JSON.stringify(full.author));
check('dependencies are read as names',
  JSON.stringify(full.dependencies) === JSON.stringify(['dep-present']), JSON.stringify(full.dependencies));
check('defaultEnabled true becomes enabled true', full.enabled === true, String(full.enabled));
check('a fully valid manifest produces no warnings', full.warnings.length === 0, full.warnings.join(' | '));
check('the plugin directory is the one that was written', full.dir === fullDir, full.dir);
check('a plugin whose manifest renames it is still found by its directory name',
  loadPlugin('full', WORKSPACE).ok === true && loadPlugin('full', WORKSPACE).dir === fullDir);

/* ---------------------- no manifest ---------------------- */
const plainPlugin = pick('plain');
check('a plugin with no manifest is named after its directory', plainPlugin.name === 'plain', plainPlugin.name);
check('an absent manifest leaves the optional fields empty',
  plainPlugin.displayName === '' && plainPlugin.version === '' && plainPlugin.description === '' &&
    plainPlugin.author === null && plainPlugin.license === '' && plainPlugin.keywords.length === 0,
  JSON.stringify(plainPlugin));
check('an absent manifest means off by default', plainPlugin.enabled === false, String(plainPlugin.enabled));
check('an absent manifest produces no warnings', plainPlugin.warnings.length === 0, plainPlugin.warnings.join(' | '));

/* ---------------------- author shapes ---------------------- */
check('author given as a string stays a string',
  pick('author-str').author === 'Bob <bob@example.com>', JSON.stringify(pick('author-str').author));
check('an author object with unknown keys only is reported, not kept',
  (() => {
    const dir = project('author-junk');
    manifest(dir, { name: 'author-junk', author: { twitter: '@nobody' } });
    const found = loadPlugin('author-junk', WORKSPACE);
    return found.ok && found.author === null && /author/.test(found.warnings.join(' '));
  })());

/* ---------------------- components discovered ---------------------- */
check('a skill directory is discovered', JSON.stringify(plainPlugin.skills) === JSON.stringify(['notes']),
  JSON.stringify(plainPlugin.skills));
check('a command file is discovered', JSON.stringify(plainPlugin.commands) === JSON.stringify(['hello']),
  JSON.stringify(plainPlugin.commands));
check('an agent file is discovered', JSON.stringify(plainPlugin.agents) === JSON.stringify(['helper']),
  JSON.stringify(plainPlugin.agents));
check('components in the full plugin are all discovered',
  JSON.stringify(full.skills) === JSON.stringify(['style']) &&
    JSON.stringify(full.commands) === JSON.stringify(['deploy']) &&
    JSON.stringify(full.agents) === JSON.stringify(['reviewer']),
  JSON.stringify([full.skills, full.commands, full.agents]));

/* ---------------------- path overrides ---------------------- */
const overrides = pick('overrides');
check('a skills override is read from its custom location',
  JSON.stringify(overrides.skills) === JSON.stringify(['greet']), JSON.stringify(overrides.skills));
check('a commands object map names a command after its key',
  JSON.stringify(overrides.commands) === JSON.stringify(['ship']), JSON.stringify(overrides.commands));
check('an agents override pointing at a directory is read',
  JSON.stringify(overrides.agents) === JSON.stringify(['checker']), JSON.stringify(overrides.agents));
check('an override replaces the standard layout instead of adding to it',
  !overrides.skills.includes('decoy') && !overrides.commands.includes('decoy') && !overrides.agents.includes('decoy'),
  JSON.stringify([overrides.skills, overrides.commands, overrides.agents]));
check('a commands map entry pointing at a directory is reported',
  warned(overrides, /"wrong" points at a directory/), overrides.warnings.join(' | '));

/* ---------------------- paths that leave the plugin ---------------------- */
const escapes = pick('escapes');
check('a ../ escape yields no skills', escapes.skills.length === 0, JSON.stringify(escapes.skills));
check('a ../ escape yields no commands', escapes.commands.length === 0, JSON.stringify(escapes.commands));
check('a ../ escape yields no agents', escapes.agents.length === 0, JSON.stringify(escapes.agents));
check('a ../ escape is warned about, not silently dropped',
  warned(escapes, /skills path "\.\.\/\.\.\/\.\.\/outside\/skills" escapes the plugin directory/),
  escapes.warnings.join(' | '));
check('every escaping path is warned about individually', escapes.warnings.length === 3,
  escapes.warnings.join(' | '));
check('the escaped files are never reachable through pluginSources',
  !pluginSources(WORKSPACE, only('escapes')).skillDirs.some((d) => d.includes('outside')) &&
    pluginSources(WORKSPACE, only('escapes')).commandFiles.length === 0,
  JSON.stringify(pluginSources(WORKSPACE, only('escapes'))));

const absolute = pick('absolute');
check('an absolute path is rejected', absolute.commands.length === 0 && absolute.agents.length === 0,
  JSON.stringify([absolute.commands, absolute.agents]));
check('an absolute path is warned about specifically',
  warned(absolute, /commands path ".*" is an absolute path/), absolute.warnings.join(' | '));
check('an absolute path that points back inside the plugin is still rejected',
  warned(absolute, new RegExp(`"${absoluteDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}" is an absolute path`)),
  absolute.warnings.join(' | '));
check('a plugin that only escapes still reports the components it does have',
  JSON.stringify(absolute.skills) === JSON.stringify(['local']), JSON.stringify(absolute.skills));

/* A symlinked skills directory is the same attack with no ../ in sight. */
if (symlinkMade) {
  const linked = loadPlugin('linked', WORKSPACE);
  check('a skills symlink pointing out of the plugin is not followed',
    linked.ok === true && linked.skills.length === 0, JSON.stringify((linked || {}).skills));
  check('a symlinked escape is reported as a symlink, not as a missing path',
    warned(linked, /points outside the plugin directory through a symbolic link/),
    (linked || {}).warnings?.join(' | '));
} else {
  console.log('  \x1b[33m-\x1b[0m symlinks could not be created here; the symlink escape checks were skipped');
}

/* ---------------------- shadowing ---------------------- */
const shadowed = resolveEnabledPlugins(WORKSPACE, only('shadow'));
check('only one copy of a shadowed name is active', shadowed.filter((p) => p.name === 'shadow').length === 1,
  JSON.stringify(shadowed.map((p) => [p.name, p.source])));
check('the project copy wins over the personal copy',
  shadowed[0].source === 'project' && shadowed[0].dir === project('shadow'),
  JSON.stringify([shadowed[0].source, shadowed[0].dir]));
check('active plugins are reported as enabled', shadowed[0].enabled === true);
const shadowSources = pluginSources(WORKSPACE, only('shadow'));
check('a shadowed plugin contributes the project skill directory',
  shadowSources.skillDirs.length === 1 && shadowSources.skillDirs[0] === path.join(project('shadow'), 'skills'),
  JSON.stringify(shadowSources.skillDirs));
check('a shadowed plugin contributes no skill of its own',
  JSON.stringify(shadowSources.skills.map((s) => s.name)) === JSON.stringify(['project-skill']),
  JSON.stringify(shadowSources.skills));
check('listPlugins still lists the shadowed copy, with the reason',
  listed.filter((p) => p.name === 'shadow').length === 2 &&
    warned(listed.find((p) => p.name === 'shadow' && p.source === 'personal'), /a project plugin of the same name .* shadows this copy/),
  listed.filter((p) => p.name === 'shadow').map((p) => `${p.source}: ${p.warnings.join('|')}`).join(' ; '));
check('in a workspace without the project copy, the personal one loads',
  resolveEnabledPlugins(EMPTY_WORKSPACE, { shadow: true })[0].source === 'personal');

/* ---------------------- defaultEnabled and the enabled map ---------------------- */
check('defaultEnabled true is reported by listPlugins', pick('default-on').enabled === true);
check('defaultEnabled false is reported by listPlugins', pick('default-off').enabled === false);
check('a plugin without defaultEnabled is off', pick('plain').enabled === false);
const defaultsOnly = resolveEnabledPlugins(WORKSPACE, {}).map((p) => p.name);
check('with no enabled map, only defaultEnabled plugins are active',
  defaultsOnly.includes('default-on') && !defaultsOnly.includes('default-off'),
  defaultsOnly.join(', '));
const turnedOff = resolveEnabledPlugins(WORKSPACE, { 'default-on': false }).map((p) => p.name);
check('an explicit false turns a defaultEnabled plugin off', !turnedOff.includes('default-on'),
  turnedOff.join(', '));
const turnedOn = resolveEnabledPlugins(WORKSPACE, { 'default-off': true }).map((p) => p.name);
check('an explicit true turns an opt-in plugin on', turnedOn.includes('default-off'), turnedOn.join(', '));
check('the enabled map decides in both directions at once',
  resolveEnabledPlugins(WORKSPACE, { 'default-on': false, 'default-off': true })
    .map((p) => p.name).filter((n) => n === 'default-on' || n === 'default-off')
    .join(',') === 'default-off');
check('a string "true" from a UI round trip still turns a plugin on',
  resolveEnabledPlugins(WORKSPACE, { 'default-off': 'true' }).some((p) => p.name === 'default-off'));
check('a string "false" from a UI round trip still turns a plugin off',
  !resolveEnabledPlugins(WORKSPACE, { 'default-on': 'false' }).some((p) => p.name === 'default-on'));
check('junk in the enabled map leaves the default in charge',
  resolveEnabledPlugins(WORKSPACE, { 'default-on': 'yes' }).some((p) => p.name === 'default-on') &&
    !resolveEnabledPlugins(WORKSPACE, { plain: 'yes' }).some((p) => p.name === 'plain'));
check('a disabled plugin contributes nothing to pluginSources',
  pluginSources(WORKSPACE, only('plain')).skills.every((s) => s.plugin !== 'full-manifest'));
check('an enabled plugin contributes its skill, command and agent paths', (() => {
  const src = pluginSources(WORKSPACE, only('plain'));
  return src.skills.length === 1 && src.commandFiles.length === 1 && src.agentFiles.length === 1;
})());

/* ---------------------- dependencies ---------------------- */
let depThrew = null;
let needsDep = null;
try {
  needsDep = loadPlugin('needs-dep', WORKSPACE);
} catch (err) {
  depThrew = err;
}
check('a missing dependency does not throw', depThrew === null, String(depThrew && depThrew.message));
check('a missing dependency is a warning on the plugin',
  warned(needsDep, /depends on "ghost-plugin", which is not installed/), (needsDep || {}).warnings?.join(' | '));
check('a missing dependency is reported by listPlugins too',
  warned(pick('needs-dep'), /ghost-plugin/), pick('needs-dep').warnings.join(' | '));
const needsOff = loadPlugin('needs-off-dep', WORKSPACE);
check('an installed dependency is not called missing when it is merely off',
  needsOff.ok === true && !/depends on/.test(needsOff.warnings.join(' ')), needsOff.warnings.join(' | '));
check('an installed but disabled dependency is reported once it is active',
  warned(resolveEnabledPlugins(WORKSPACE, only('needs-off-dep')).find((p) => p.name === 'needs-off-dep'),
    /depends on "default-off", which is installed but not enabled/),
  JSON.stringify(resolveEnabledPlugins(WORKSPACE, only('needs-off-dep'))));
check('an installed dependency is not reported when it is enabled too', (() => {
  const active = resolveEnabledPlugins(WORKSPACE, only('full-manifest', 'dep-present'));
  return active.length === 2 && active.every((p) => !/depends on/.test(p.warnings.join(' ')));
})());
check('dependency warnings reach pluginSources', (() => {
  const src = pluginSources(WORKSPACE, only('needs-dep'));
  return src.warnings.some((w) => /ghost-plugin/.test(w));
})());
check('a dependency does not drag the plugin out of the active set',
  resolveEnabledPlugins(WORKSPACE, only('needs-dep')).length === 1);

/* ---------------------- hooks and MCP servers ---------------------- */
const unsupported = pick('unsupported');
check('a declared hooks component warns that it is not implemented',
  warned(unsupported, /"hooks"/) && warned(unsupported, /does not implement/) && warned(unsupported, /will be ignored/),
  unsupported.warnings.join(' | '));
check('a declared mcpServers component warns that it is not implemented',
  warned(unsupported, /"mcpServers"/) && warned(unsupported, /will be ignored/),
  unsupported.warnings.join(' | '));
check('the unsupported warning names what is ignored, in full words',
  unsupported.warnings.some((w) => /plugin hooks/.test(w)) && unsupported.warnings.some((w) => /MCP servers/.test(w)),
  unsupported.warnings.join(' | '));
check('the rest of such a plugin still loads',
  JSON.stringify(unsupported.skills) === JSON.stringify(['works']), JSON.stringify(unsupported.skills));
check('a manifest without hooks or mcpServers produces no such warning',
  !warned(full, /hooks|mcpServers/), full.warnings.join(' | '));
check('the unsupported warning reaches pluginSources',
  pluginSources(WORKSPACE, only('unsupported')).warnings.some((w) => /mcpServers/.test(w)));

/* ---------------------- malformed manifest ---------------------- */
let brokenThrew = null;
let broken = null;
try {
  broken = loadPlugin('broken', WORKSPACE);
} catch (err) {
  brokenThrew = err;
}
check('malformed JSON in plugin.json does not throw', brokenThrew === null, String(brokenThrew && brokenThrew.message));
check('malformed JSON is reported clearly',
  warned(broken, /plugin.json is not valid JSON/) && warned(broken, /standard layout/),
  (broken || {}).warnings?.join(' | '));
check('the plugin still loads from the standard layout when the manifest is broken',
  broken.ok === true && JSON.stringify(broken.skills) === JSON.stringify(['broken-skill']) &&
    broken.name === 'broken', JSON.stringify((broken || {}).skills));
check('a plugin.json that is not an object is reported',
  (() => {
    const dir = project('array-manifest');
    writeJson(path.join(dir, '.claude-plugin', 'plugin.json'), ['nope']);
    const found = loadPlugin('array-manifest', WORKSPACE);
    return found.ok && /must contain a JSON object/.test(found.warnings.join(' '));
  })());

/* ---------------------- robustness of the field readers ---------------------- */
const badTypes = pick('bad-types');
check('a non-string version is reported rather than coerced',
  badTypes.version === '' && warned(badTypes, /"version" must be a string/), badTypes.warnings.join(' | '));
check('a non-array keywords field is reported', warned(badTypes, /"keywords" must be an array/));
check('a non-array dependencies field is reported',
  warned(badTypes, /"dependencies" must be an array/) && badTypes.dependencies.length === 0);
check('a non-boolean defaultEnabled is reported and stays off',
  warned(badTypes, /"defaultEnabled" must be a boolean/) && badTypes.enabled === false);
check('a UTF-8 BOM in plugin.json does not break parsing',
  pick('bom').version === '' && pick('bom').name === 'bom' && !warned(pick('bom'), /not valid JSON/),
  pick('bom').warnings.join(' | '));
check('a duplicate plugin name in one root is reported, not silently merged',
  listed.filter((p) => p.name === 'dup').length === 2 &&
    listed.filter((p) => p.name === 'dup').some((p) => warned(p, /already uses the name "dup"/)),
  listed.filter((p) => p.name === 'dup').map((p) => p.dir).join(', '));
check('a skills subdirectory without SKILL.md says why it will not load',
  (() => {
    const found = loadPlugin('no-skill-md', WORKSPACE);
    return found.ok && warned(found, /skills\/bare has no SKILL.md/);
  })());
check('a plugin with no components at all is still listed with empty lists',
  pick('empty') && pick('empty').skills.length === 0 && pick('empty').commands.length === 0 &&
    pick('empty').agents.length === 0);

/* ---------------------- loadPlugin errors ---------------------- */
const missing = loadPlugin('no-such-plugin', WORKSPACE);
check('loadPlugin returns ok:false for an unknown plugin', missing.ok === false && typeof missing.error === 'string');
check('the loadPlugin error names both roots that were searched',
  missing.error.includes(PROJECT_ROOT) && missing.error.includes(PERSONAL_ROOT), missing.error);
check('the loadPlugin error lists what is installed', /Installed plugins: /.test(missing.error), missing.error);
check('loadPlugin rejects an empty name with a message',
  loadPlugin('', WORKSPACE).ok === false && typeof loadPlugin('', WORKSPACE).error === 'string');
check('loadPlugin returns the same fields listPlugins does', (() => {
  const one = loadPlugin('plain', WORKSPACE);
  const fromList = pick('plain');
  return documented.every((k) => JSON.stringify(one[k]) === JSON.stringify(fromList[k]));
})());

/* ---------------------- pluginSources shape ---------------------- */
const src = pluginSources(WORKSPACE, only('full-manifest', 'plain'));
check('pluginSources returns the documented keys',
  ['skillDirs', 'skills', 'commandFiles', 'agentFiles', 'warnings'].every((k) => Array.isArray(src[k])),
  Object.keys(src).join(', '));
check('skillDirs are absolute directories that exist',
  src.skillDirs.length === 2 && src.skillDirs.every((d) => path.isAbsolute(d) && fs.statSync(d).isDirectory()),
  JSON.stringify(src.skillDirs));
check('skillDirs point at each plugin skills root',
  src.skillDirs.includes(path.join(fullDir, 'skills')) && src.skillDirs.includes(path.join(plainDir, 'skills')),
  JSON.stringify(src.skillDirs));
check('commandFiles carry a name, a plugin and an existing absolute path',
  src.commandFiles.length === 2 &&
    src.commandFiles.every((c) => typeof c.name === 'string' && typeof c.plugin === 'string' &&
      path.isAbsolute(c.path) && fs.statSync(c.path).isFile()),
  JSON.stringify(src.commandFiles));
check('agentFiles carry a name, a plugin and an existing absolute path',
  src.agentFiles.length === 2 &&
    src.agentFiles.every((a) => typeof a.name === 'string' && typeof a.plugin === 'string' &&
      path.isAbsolute(a.path) && fs.statSync(a.path).isFile()),
  JSON.stringify(src.agentFiles));
check('a command file is attributed to the plugin that declared it',
  src.commandFiles.find((c) => c.name === 'deploy').plugin === 'full-manifest',
  JSON.stringify(src.commandFiles));
check('paths are plain strings, never parsed objects',
  src.commandFiles.every((c) => typeof c.path === 'string' && typeof c.name === 'string'));
check('nothing is enabled when every plugin is explicitly off',
  pluginSources(WORKSPACE, only()).skillDirs.length === 0,
  JSON.stringify(pluginSources(WORKSPACE, only())));
check('a missing workspace directory is survivable',
  pluginSources(path.join(SANDBOX, 'does-not-exist'), {}).skillDirs.length === 0);

/* ---------------------- pluginsForPrompt ---------------------- */
check('pluginsForPrompt is empty when nothing is enabled',
  pluginsForPrompt(EMPTY_WORKSPACE, {}) === '', JSON.stringify(pluginsForPrompt(EMPTY_WORKSPACE, {})));
check('pluginsForPrompt is empty when every installed plugin is switched off',
  pluginsForPrompt(WORKSPACE, only()) === '', JSON.stringify(pluginsForPrompt(WORKSPACE, only())));
check('pluginsForPrompt is empty in a workspace with no plugins and no defaults',
  pluginsForPrompt(path.join(SANDBOX, 'another-empty-workspace'), {}) === '');

const prompt = pluginsForPrompt(WORKSPACE, only('full-manifest', 'dep-present', 'needs-dep'));
check('pluginsForPrompt lists the enabled plugins', /full-manifest/.test(prompt) && /needs-dep/.test(prompt), prompt);
check('it says what each plugin contributes',
  /1 skill: style/.test(prompt) && /1 command: \/deploy/.test(prompt) && /1 agent: reviewer/.test(prompt), prompt);
check('it names the plugin source', /project/.test(prompt), prompt);
check('it includes the version when there is one', /v2\.1\.0/.test(prompt), prompt);
check('it includes the display name', /Full Manifest Plugin \(full-manifest\)/.test(prompt), prompt);
check('it reports dependency warnings too',
  /Plugin warnings:/.test(prompt) && /ghost-plugin/.test(prompt), prompt);
check('an empty enabled map still activates the defaultEnabled plugins',
  (() => {
    const names = resolveEnabledPlugins(WORKSPACE, {}).map((p) => p.name);
    return names.includes('default-on') && !names.includes('default-off');
  })() && /^- default-on /m.test(pluginsForPrompt(WORKSPACE, {})),
  pluginsForPrompt(WORKSPACE, {}));
check('it reports the unimplemented components too',
  /mcpServers/.test(pluginsForPrompt(WORKSPACE, only('unsupported'))),
  pluginsForPrompt(WORKSPACE, only('unsupported')));
check('a plugin with no components says so instead of listing nothing',
  /no components/.test(pluginsForPrompt(WORKSPACE, only('empty'))),
  pluginsForPrompt(WORKSPACE, only('empty')));
check('it says nothing about plugins that are not enabled',
  !/personal-only/.test(prompt) && !/default-off/.test(prompt), prompt);

/* ---------------------- cleanup ---------------------- */
try {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
} catch {
  /* A temp directory that will not delete is not a test failure. */
}

console.log('');
if (fail) {
  console.log(`\x1b[31mx ${fail} of ${pass + fail} plugin checks failed\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m+ all ${pass} plugin checks passed\x1b[0m\n`);
