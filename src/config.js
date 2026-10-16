'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');

/**
 * Paths and tunables. Nothing here requires a build step or a package install.
 */

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');

/**
 * Default workspace = the directory the agent is allowed to read/write.
 * Resolved at call time because the user can change it from the UI.
 */
function defaultWorkspace() {
  return process.env.KLAUD_WORKSPACE
    ? path.resolve(process.env.KLAUD_WORKSPACE)
    : PROJECT_ROOT;
}

/**
 * Where conversations and settings live.
 *
 * The app was previously called Forge, so an existing ~/.forge directory is
 * adopted on first run rather than silently starting empty — losing someone's
 * saved API key and chat history on a rename would be rude.
 */
function dataDir() {
  if (process.env.KLAUD_DATA_DIR) return path.resolve(process.env.KLAUD_DATA_DIR);
  const home = os.homedir();
  if (!home) return path.join(PROJECT_ROOT, '.klaud');

  const target = path.join(home, '.klaud');
  const legacy = path.join(home, '.forge');

  if (!fs.existsSync(target) && fs.existsSync(legacy)) {
    try {
      fs.renameSync(legacy, target);
      console.log(`  migrated   ${legacy} -> ${target}`);
    } catch {
      // A cross-device or locked rename: copy what matters instead.
      try {
        fs.mkdirSync(target, { recursive: true });
        fs.cpSync(legacy, target, { recursive: true, errorOnExist: false });
        console.log(`  copied     ${legacy} -> ${target}`);
      } catch {
        return legacy;
      }
    }
  }
  return target;
}

const LIMITS = {
  // Max characters of file/command output handed back to the model.
  maxToolOutput: 60_000,
  // Max characters of output streamed to the browser per tool call.
  maxToolOutputToClient: 80_000,
  maxReadLines: 2_000,
  maxCommandMs: 120_000,
  maxAgentSteps: 24,
  maxRequestBytes: 32 * 1024 * 1024,
};

const DEFAULTS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.2,
  // Characters of conversation history sent per request. ~80k characters is
  // roughly 20k tokens, which leaves room for tools and output on every
  // mainstream model. Older turns are trimmed, newest first kept.
  maxContextChars: 80_000,
  systemPrompt: [
    'You are Klaud, a coding agent running locally on the user\'s own computer.',
    'You have tools that read, write and run real files in the user\'s working directory.',
    '',
    'Operating rules:',
    '- Investigate before you edit: list the directory and read the relevant files first.',
    '- Prefer many small, verified steps over one large speculative rewrite.',
    '- After changing code, run it (or run the project tests) to confirm it works.',
    '- Never invent file contents or claim a command succeeded unless you saw its output.',
    '- When a task is done, summarize what changed and how you verified it. Be brief.',
    '- Use relative paths. Keep changes inside the working directory.',
  ].join('\n'),
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  PROJECT_ROOT,
  PUBLIC_DIR,
  DEFAULTS,
  LIMITS,
  defaultWorkspace,
  dataDir,
  ensureDir,
};
