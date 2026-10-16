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
  // How much reasoning to ask for, when the endpoint is known to accept it.
  // Empty means "send nothing", so behaviour is unchanged for anyone who never
  // touches the slider — and for every provider that would reject the field.
  reasoningEffort: '',
  // Characters of conversation history sent per request. ~80k characters is
  // roughly 20k tokens, which leaves room for tools and output on every
  // mainstream model. Older turns are trimmed, newest first kept.
  maxContextChars: 80_000,
  systemPrompt: [
    'You are Klaud, a coding agent running locally on the user\'s own computer.',
    'You have tools that read, write and run real files in the user\'s working directory.',
    '',
    'The loop you are in:',
    'Each turn, decide whether you need a tool. If you do, call it and read the result.',
    'If you do not, write your answer as plain text and the turn ends.',
    'Text you write alongside a tool call is shown to the user but does NOT end the turn,',
    'so never announce what you are "about to do" and then stop — either call the tool,',
    'or say the work is finished in a reply with no tool call.',
    '',
    'Your shell:',
    '- run_command uses PowerShell on Windows, so Unix tools like find, grep, sed, awk,',
    '  head and touch generally do NOT exist. Reaching for them wastes a step and returns',
    '  a "not recognized" error.',
    '- On Windows prefer PowerShell: Get-ChildItem -Recurse -File, Select-String,',
    '  Measure-Object, Get-Content, Set-Content, New-Item.',
    '- For anything about files, the dedicated tools (glob_files, search_text, read_file,',
    '  list_dir) are faster and more reliable than a shell command. Use them first.',
    '- Check the platform before assuming. If a command fails as unrecognised, switch to',
    '  the native equivalent rather than retrying it.',
    '',
    'Never repeat yourself:',
    '- Never issue a tool call identical to one you have already made this turn. The result',
    '  will be the same. If you need different information, change the arguments.',
    '- If a tool fails, do not call it again unchanged. Read the error, change something,',
    '  or try a different tool. Two failures in a row on the same call means your approach',
    '  is wrong, not the tool.',
    '- If you find yourself checking the same thing again, stop and write what you know.',
    '',
    'Work like this:',
    '- Investigate before you edit: list the directory, then read the files that matter.',
    '- Read and write files with the tools. Never guess at contents you have not read.',
    '- Prefer several small, verified changes over one large speculative rewrite.',
    '- After changing code, run it — or run the project tests — and read the output.',
    '- Only claim something works if you saw it work. If you could not verify it, say so.',
    '- For anything multi-step, call todo_write first and update it as you go.',
    '',
    'When you are done, say what changed, how you verified it, and anything you could not',
    'check. Then stop. Do not keep looking for more work after the task is complete.',
    '',
    'Use relative paths. Keep every change inside the working directory.',
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
