'use strict';

/**
 * The local toolbox.
 *
 * Every tool resolves its paths through `resolveInside(root, ...)`, which throws
 * rather than escaping the working directory. Nothing here trusts the model.
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const {
  resolveInside,
  toPosix,
  walk,
  matchGlob,
  looksBinaryExt,
  readTextFile,
  statOrNull,
} = require('./fsutil');
const { LIMITS, DEFAULTS } = require('../config');

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function truncate(text, max) {
  if (typeof text !== 'string') text = String(text ?? '');
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.6));
  const tail = text.slice(-Math.floor(max * 0.3));
  const dropped = text.length - head.length - tail.length;
  return `${head}\n\n... [${dropped} characters omitted] ...\n\n${tail}`;
}

function sliceLines(text, offset, limit) {
  const lines = text.split(/\r\n|\n|\r/);
  const total = lines.length;
  const start = Math.max(0, (Number(offset) || 0) - 1);
  const end = limit ? start + Number(limit) : total;
  const selected = lines.slice(start, Math.min(end, total));
  return {
    total,
    start: start + 1,
    end: start + selected.length,
    text: selected.join('\n'),
  };
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Compact line diff — enough to show the model and the user what changed. */
function lineDiff(before, after, context = 2) {
  const a = before.split(/\r\n|\n|\r/);
  const b = after.split(/\r\n|\n|\r/);
  const n = a.length;
  const m = b.length;

  if (n * m > 4_000_000) {
    return `- old: ${n} lines\n+ new: ${m} lines (diff too large to render)`;
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i]]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push(['-', a[i++]]);
    } else {
      ops.push(['+', b[j++]]);
    }
  }
  while (i < n) ops.push(['-', a[i++]]);
  while (j < m) ops.push(['+', b[j++]]);

  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op[0] === ' ') return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) {
      keep[k] = true;
    }
  });

  const lines = [];
  let skipped = 0;
  ops.forEach((op, idx) => {
    if (keep[idx]) {
      if (skipped) {
        lines.push(`@@ ${skipped} unchanged line${skipped === 1 ? '' : 's'} @@`);
        skipped = 0;
      }
      lines.push(op[0] + op[1]);
    } else {
      skipped++;
    }
  });
  return lines.join('\n');
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Commands that are almost never what a user wants an agent to run unattended. */
const DESTRUCTIVE = [
  /rm\s+-[a-z]*r[a-z]*f?\s+\/(?:\s|$)/i,
  /rm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(?:\s|$)/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdiskpart\b/i,
  /\bdel\s+\/[sqf]\b.*[a-z]:\\/i,
  /\brd\s+\/s\s+\/q\s+[a-z]:\\/i,
  /Remove-Item\s+.*-Recurse.*-Force.*[A-Za-z]:\\\s*$/i,
  /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/,
  /\bshutdown\b/i,
  /\breg\s+delete\b/i,
  /\bvssadmin\b/i,
  /\bcipher\s+\/w\b/i,
];

/* ------------------------------------------------------------------ *
 * Shell detection
 * ------------------------------------------------------------------ */

let cachedShell = null;

function which(cmd) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(finder, [cmd], { encoding: 'utf8', windowsHide: true });
  if (res.status === 0 && res.stdout) {
    const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  }
  return null;
}

function detectShell() {
  if (cachedShell) return cachedShell;
  if (process.platform === 'win32') {
    const pwsh = which('pwsh');
    if (pwsh) {
      cachedShell = { file: pwsh, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'], label: 'pwsh' };
      return cachedShell;
    }
    const powershell = which('powershell');
    if (powershell) {
      cachedShell = { file: powershell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'], label: 'powershell' };
      return cachedShell;
    }
    const cmd = process.env.ComSpec || 'cmd.exe';
    cachedShell = { file: cmd, args: ['/d', '/s', '/c'], label: 'cmd' };
    return cachedShell;
  }
  const sh = which('bash') || '/bin/sh';
  cachedShell = { file: sh, args: ['-lc'], label: 'sh' };
  return cachedShell;
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * Build the command line that makes the shell report the *user's* exit code.
 *
 * Out of the box on Windows neither shell does the right thing for an agent:
 *   - `powershell -Command "node -e ..."` reports 1 for any non-zero child exit
 *   - a failed cmdlet (Remove-Item on a missing path) reports 0
 *   - `cmd /c` forgets the code as soon as the command list ends in `echo`
 * So the real status is captured inside the same scope and forwarded.
 */
function buildInvocation(command, shell) {
  if (shell.label === 'powershell' || shell.label === 'pwsh') {
    return [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      `$global:LASTEXITCODE = $null; & { ${command}; ` +
        `if ($null -ne $global:LASTEXITCODE) { exit $global:LASTEXITCODE }; ` +
        `if ($?) { exit 0 } else { exit 1 } }`,
    ];
  }
  if (shell.label === 'cmd') {
    // `& cmd /c exit N` runs the payload in a child cmd and leaves %ERRORLEVEL%
    // set to its real exit code; `||` covers cmd's own self-reported failures.
    return ['/d', '/s', '/c', `cmd /d /s /c "${command}" & exit /b %ERRORLEVEL% || exit /b 1`];
  }
  return ['-c', `{ ${command}\n} ; __klaud_status=$? ; exit $__klaud_status`];
}

function runShell(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const shell = detectShell();
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(shell.file, buildInvocation(command, shell), {
      cwd,
      windowsHide: true,
      env: { ...process.env, KLAUD_AGENT: '1', CI: process.env.CI ?? '1' },
      detached: process.platform !== 'win32',
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (stdout.length < 2_000_000) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 2_000_000) stderr += d.toString('utf8');
    });

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        error,
        shell: shell.label,
      });
    };

    child.on('error', (err) => finish(null, err.message));
    child.on('close', (code) => finish(code, null));
  });
}

/* ------------------------------------------------------------------ *
 * fetch_url
 * ------------------------------------------------------------------ */

async function fetchUrl(url, { maxBytes = 250_000, timeoutMs = 25_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'Klaud/1.0 (+local coding agent)',
        accept: 'text/html,application/json,text/plain,*/*',
      },
    });
    const type = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    let body = buf.subarray(0, maxBytes).toString('utf8');
    if (/html/i.test(type)) {
      body = body
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }
    return { status: res.status, contentType: type, bytes: buf.length, body };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Tool definitions
 * ------------------------------------------------------------------ */

const TOOLS = [
  {
    name: 'list_dir',
    permission: 'read',
    description:
      'List the entries of a directory inside the working directory. Use "" or "." for the working directory root.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the working directory.' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories (default false).' },
        max_entries: { type: 'integer', description: 'Maximum entries to return (default 100).' },
      },
      required: [],
    },
    async run(args, ctx) {
      const rel = args.path ?? '.';
      const { abs, rel: shown } = resolveInside(ctx.cwd, rel === '' ? '.' : rel);
      const st = await statOrNull(abs);
      if (!st) throw new Error(`"${rel}" does not exist`);
      if (!st.isDirectory()) throw new Error(`"${rel}" is a file, not a directory. Use read_file.`);

      // 100, not 200. A home or Downloads directory holds hundreds of entries,
      // and at ~32 characters per line the old default pushed 8k characters into
      // the request for a single call — enough to crowd out a free tier's context
      // and slow every later step. The note also tells the model how to narrow
      // down, instead of leaving it to guess.
      const max = Math.min(Number(args.max_entries) || 100, 2_000);
      if (!args.recursive) {
        const entries = await fs.readdir(abs, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        const lines = [];
        for (const e of entries.slice(0, max)) {
          if (e.isDirectory()) {
            lines.push(`[dir]  ${e.name}/`);
          } else if (e.isFile()) {
            let size = '';
            try {
              size = ` (${humanSize((await fs.stat(path.join(abs, e.name))).size)})`;
            } catch { /* ignore */ }
            lines.push(`[file] ${e.name}${size}`);
          }
        }
        const more =
          entries.length > max
            ? `\n... ${entries.length - max} more entries not shown. Use glob_files to filter, or raise max_entries if you really need them all.`
            : '';
        // State both numbers. "254 entries" above a 100-line listing reads as a
        // complete inventory, and a model that trusts it reports the wrong count.
        const header =
          entries.length > max
            ? `${shown === '.' ? '.' : shown} — ${entries.length} entries, showing the first ${max}`
            : `${shown === '.' ? '.' : shown} — ${entries.length} entries`;
        return `${header}\n${lines.join('\n')}${more}`;
      }

      const all = await walk(abs, { max });
      const lines = all.map((e) => (e.type === 'dir' ? `[dir]  ${e.rel}/` : `[file] ${e.rel}`));
      return `${shown} — ${all.length} entries (recursive)\n${lines.join('\n')}`;
    },
  },

  {
    name: 'read_file',
    permission: 'read',
    description:
      'Read a UTF-8 text file from the working directory. Output is line-numbered. Use offset/limit for large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the working directory.' },
        offset: { type: 'integer', description: '1-based first line to read (default 1).' },
        limit: { type: 'integer', description: 'Number of lines to read (default 400).' },
      },
      required: ['path'],
    },
    async run(args, ctx) {
      const { abs, rel } = resolveInside(ctx.cwd, args.path);
      const st = await statOrNull(abs);
      if (!st) throw new Error(`"${args.path}" does not exist`);
      if (st.isDirectory()) {
        throw new Error(`"${args.path}" is a directory. Use list_dir.`);
      }
      if (looksBinaryExt(abs)) {
        throw new Error(`"${args.path}" looks binary (${path.extname(abs)}).`);
      }
      const text = await readTextFile(abs);
      const limit = Math.min(Number(args.limit) || 400, LIMITS.maxReadLines);
      const slice = sliceLines(text, args.offset, limit);
      const numbered = slice.text
        .split('\n')
        .map((line, idx) => `${String(slice.start + idx).padStart(5, ' ')} | ${line}`)
        .join('\n');
      const footer =
        slice.end < slice.total
          ? `\n... showing lines ${slice.start}-${slice.end} of ${slice.total}. Continue with offset=${slice.end + 1}.`
          : `\n... end of file (${slice.total} lines).`;
      return `# ${rel} (${humanSize(st.size)})\n${numbered}${footer}`;
    },
  },

  {
    name: 'write_file',
    permission: 'write',
    description:
      'Create a file, or replace an existing file entirely. Parent directories are created automatically. Prefer edit_file for small changes to existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the working directory.' },
        content: { type: 'string', description: 'Full file contents to write.' },
        overwrite: {
          type: 'boolean',
          description: 'Must be true to replace an existing file (default false).',
        },
      },
      required: ['path', 'content'],
    },
    async run(args, ctx) {
      const { abs, rel } = resolveInside(ctx.cwd, args.path);
      const existing = await statOrNull(abs);
      if (existing && existing.isDirectory()) throw new Error(`"${rel}" is a directory`);
      if (existing && !args.overwrite) {
        throw new Error(
          `"${rel}" already exists. Re-send with overwrite:true to replace it, or use edit_file for a targeted change.`
        );
      }
      const previous = existing ? await readTextFile(abs).catch(() => '') : '';
      const content = typeof args.content === 'string' ? args.content : String(args.content ?? '');
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      const after = await fs.readFile(abs, 'utf8');
      const lines = after.split('\n').length;
      const verb = existing ? 'Replaced' : 'Created';
      /* Always a diff, including for a file that did not exist, where the diff is
       * every line as an addition: that reads the same way as a change, so the
       * interface has one thing to render instead of two. The "Diff:" label and
       * the "First lines as written" preview that used to follow it are gone —
       * the preview duplicated what the diff already shows, and the model wrote
       * the content itself, so echoing 40 lines of it back bought nothing. */
      const diff = lineDiff(previous, after);
      return `${verb} ${rel} — ${humanSize(Buffer.byteLength(after, 'utf8'))}, ${lines} lines.\n\n${diff}`;
    },
  },

  {
    name: 'edit_file',
    permission: 'write',
    description:
      'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true. Include 3-5 lines of surrounding context in old_string so the match is unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the working directory.' },
        old_string: { type: 'string', description: 'Exact text to find, including indentation.' },
        new_string: { type: 'string', description: 'Replacement text. Use "" to delete.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false).' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async run(args, ctx) {
      const { abs, rel } = resolveInside(ctx.cwd, args.path);
      const st = await statOrNull(abs);
      if (!st || !st.isFile()) throw new Error(`"${rel}" is not an existing file`);
      const before = await readTextFile(abs);
      const oldString = String(args.old_string ?? '');
      const newString = String(args.new_string ?? '');
      if (!oldString) throw new Error('old_string must not be empty');

      const matches = countOccurrences(before, oldString);
      if (matches === 0) {
        throw new Error(
          `old_string was not found in ${rel}. Re-read the file and copy the exact text (including whitespace).`
        );
      }
      if (matches > 1 && !args.replace_all) {
        throw new Error(
          `old_string appears ${matches} times in ${rel}. Add surrounding context to make it unique, or set replace_all:true.`
        );
      }
      const after = args.replace_all
        ? before.split(oldString).join(newString)
        : before.replace(oldString, newString);

      await fs.writeFile(abs, after, 'utf8');
      return `Edited ${rel} (${matches} replacement${matches === 1 ? '' : 's'}).\n\n${lineDiff(before, after)}`;
    },
  },

  {
    name: 'glob_files',
    permission: 'read',
    description:
      'Find files by glob pattern, e.g. "**/*.ts", "src/**/*.jsx", "*.md". Returns matching paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern. ** matches across directories.' },
        path: { type: 'string', description: 'Directory to search from (default ".").' },
        max_results: { type: 'integer', description: 'Maximum paths to return (default 100).' },
      },
      required: ['pattern'],
    },
    async run(args, ctx) {
      const { abs } = resolveInside(ctx.cwd, args.path || '.');
      const entries = await walk(abs, { max: 20_000 });
      const max = Math.min(Number(args.max_results) || 100, 1_000);
      const hits = entries
        .filter((e) => (e.type === 'file' ? matchGlob(args.pattern, e.rel) : false))
        .slice(0, max)
        .map((e) => e.rel);
      if (!hits.length) return `No files matched "${args.pattern}".`;
      return `${hits.length} file(s) matched "${args.pattern}":\n${hits.join('\n')}`;
    },
  },

  {
    name: 'search_text',
    permission: 'read',
    description:
      'Search file contents with a regular expression. Returns matching lines with line numbers, grouped by file.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression source.' },
        path: { type: 'string', description: 'Directory to search from (default ".").' },
        include: { type: 'string', description: 'Optional glob restricting which files to search, e.g. "*.js".' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search (default false).' },
        max_matches: { type: 'integer', description: 'Maximum matching lines (default 120).' },
      },
      required: ['pattern'],
    },
    async run(args, ctx) {
      const { abs } = resolveInside(ctx.cwd, args.path || '.');
      let re;
      try {
        re = new RegExp(args.pattern, args.ignore_case ? 'i' : '');
      } catch (err) {
        throw new Error(`invalid regular expression: ${err.message}`);
      }
      const entries = await walk(abs, { max: 20_000 });
      const max = Math.min(Number(args.max_matches) || 120, 1_000);
      const groups = [];
      let total = 0;
      let scanned = 0;

      for (const entry of entries) {
        if (total >= max) break;
        if (entry.type !== 'file') continue;
        if (args.include && !matchGlob(args.include, entry.rel)) continue;
        if (looksBinaryExt(entry.rel)) continue;
        const full = path.join(abs, entry.rel);
        let st;
        try {
          st = await fs.stat(full);
        } catch {
          continue;
        }
        if (st.size > 2_000_000) continue;
        scanned++;
        let text;
        try {
          text = await fs.readFile(full, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\0')) continue;
        const lines = text.split(/\r\n|\n|\r/);
        const hits = [];
        for (let i = 0; i < lines.length && total + hits.length < max; i++) {
          if (re.test(lines[i])) {
            hits.push(`${i + 1}: ${lines[i].trim().slice(0, 300)}`);
          }
        }
        if (hits.length) {
          total += hits.length;
          groups.push(`${entry.rel}\n${hits.map((h) => `  ${h}`).join('\n')}`);
        }
      }

      if (!groups.length) return `No matches for /${args.pattern}/ in ${scanned} file(s).`;
      return `${total} match(es) in ${groups.length} file(s):\n\n${groups.join('\n\n')}`;
    },
  },

  {
    name: 'run_command',
    permission: 'exec',
    description:
      'Run a shell command in the working directory and return stdout, stderr and the exit code. Use this to build, test and run code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute.' },
        cwd: { type: 'string', description: 'Subdirectory to run in (default the working directory).' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 60000, max 120000).' },
      },
      required: ['command'],
    },
    async run(args, ctx) {
      const command = String(args.command ?? '').trim();
      if (!command) throw new Error('command must not be empty');

      const danger = DESTRUCTIVE.find((re) => re.test(command));
      if (danger) {
        throw new Error(
          `refusing to run a potentially destructive command: ${command}\n` +
            'If you really need this, ask the user to run it themselves.'
        );
      }

      const { abs } = resolveInside(ctx.cwd, args.cwd || '.');
      const st = await statOrNull(abs);
      if (!st || !st.isDirectory()) throw new Error(`cwd "${args.cwd}" is not a directory`);

      const timeoutMs = Math.min(Number(args.timeout_ms) || 60_000, LIMITS.maxCommandMs);
      const result = await runShell(command, abs, timeoutMs);

      if (result.error) {
        return `Command failed to start: ${result.error}\nShell: ${result.shell}`;
      }

      const parts = [
        `$ ${command}`,
        `shell: ${result.shell}   exit: ${result.timedOut ? 'TIMEOUT' : result.code}   time: ${result.durationMs}ms`,
      ];
      if (result.timedOut) parts.push(`(killed after ${timeoutMs}ms)`);
      if (result.stdout.trim()) parts.push(`--- stdout ---\n${truncate(result.stdout, 30_000)}`);
      if (result.stderr.trim()) parts.push(`--- stderr ---\n${truncate(result.stderr, 20_000)}`);
      if (!result.stdout.trim() && !result.stderr.trim()) parts.push('(no output)');
      return parts.join('\n');
    },
  },

  {
    name: 'fetch_url',
    permission: 'read',
    description:
      'Fetch a URL over the network and return its text (HTML is stripped to readable text). Useful for reading docs.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
      },
      required: ['url'],
    },
    async run(args) {
      let parsed;
      try {
        parsed = new URL(String(args.url));
      } catch {
        throw new Error('url must be an absolute http(s) URL');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('only http and https URLs are supported');
      }
      const res = await fetchUrl(parsed.toString());
      return `HTTP ${res.status} ${res.contentType} (${humanSize(res.bytes)})\n\n${truncate(res.body, 30_000)}`;
    },
  },

  {
    name: 'todo_write',
    permission: 'read',
    description:
      'Record or update a task list for the current job. Use it to plan multi-step work and to show the user progress.',
    parameters: {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete task list, replacing any previous list.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Short imperative description.' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed'],
                description: 'Current state of this task.',
              },
            },
            required: ['content', 'status'],
          },
        },
      },
      required: ['todos'],
    },
    async run(args, ctx) {
      const todos = Array.isArray(args.todos) ? args.todos.slice(0, 50) : [];
      ctx.onTodos?.(todos);
      const marks = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };
      const lines = todos.map((t) => `${marks[t.status] || '[ ]'} ${t.content}`);
      return `Task list updated (${todos.length} items):\n${lines.join('\n')}`;
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/* ------------------------------------------------------------------ *
 * Tool registry
 *
 * The nine built-ins above are not the whole story any more: skills,
 * subagents and plugins each contribute tools of their own. They are appended
 * here rather than merged into `TOOLS` so the built-in list stays readable and
 * a contributed tool can never shadow a built-in — a plugin shipped in a cloned
 * repo does not get to redefine `run_command`.
 * ------------------------------------------------------------------ */

const CONTRIBUTED = [];
const BUILTIN_NAMES = new Set(TOOLS.map((t) => t.name));

/**
 * Add tool definitions, typically from another module's `*ToolDefinitions()`.
 *
 * Matching entries are replaced so a hot reload does not stack duplicates, but
 * a name that collides with a built-in is refused and reported rather than
 * quietly winning.
 */
function registerTools(definitions) {
  const rejected = [];
  for (const def of Array.isArray(definitions) ? definitions : []) {
    if (!def || typeof def.name !== 'string' || typeof def.run !== 'function') {
      rejected.push(String(def && def.name ? def.name : '(unnamed)'));
      continue;
    }
    if (BUILTIN_NAMES.has(def.name)) {
      rejected.push(`${def.name} (shadows a built-in)`);
      continue;
    }
    const at = CONTRIBUTED.findIndex((t) => t.name === def.name);
    if (at === -1) CONTRIBUTED.push(def);
    else CONTRIBUTED[at] = def;
  }
  return { registered: CONTRIBUTED.length, rejected };
}

/** Every tool currently available, built-ins first. */
function allTools() {
  return TOOLS.concat(CONTRIBUTED);
}

function findTool(name) {
  return TOOLS_BY_NAME.get(name) || CONTRIBUTED.find((t) => t.name === name) || null;
}

/** OpenAI `tools` array (all of them — permission filtering happens at call time). */
function toolSchemas() {
  return allTools().map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/** Metadata for the UI. */
function toolCatalog() {
  return allTools().map((t) => ({
    name: t.name,
    description: t.description,
    permission: t.permission,
  }));
}

/**
 * The permission a *call* actually runs at — a tool, or a tool name.
 *
 * Almost every tool has exactly one level, and for those this is just
 * `tool.permission`. A tool that dispatches to sub-actions of different levels
 * is why this exists. The service tools in `api-tool.js` are the case: a
 * `use_<service>` tool is one schema for a whole API, so its declared level is
 * the strongest action it can reach (the catalogue has to show that, because
 * the tool *can* send). A call that only searches is still a `read` call
 * though, and refusing it in read-only mode would be the wrong answer to give
 * someone who asked for a search. Such a tool answers for the call in hand with
 * `resolvePermission(args)`, and the fallback is its declared level, so a tool
 * without one behaves exactly as before.
 */
function permissionForCall(toolOrName, args) {
  const tool = typeof toolOrName === 'string' ? findTool(toolOrName) : toolOrName;
  if (!tool) return null;
  if (typeof tool.resolvePermission === 'function') {
    try {
      const level = tool.resolvePermission(args || {});
      if (typeof level === 'string' && level) return level;
    } catch {
      /* Fall through to the declared level. A resolver that throws must not
       * become a way past the gate. */
    }
  }
  return tool.permission;
}

/**
 * Execute one tool call. Never throws: failures come back as `ok:false` so the
 * model can read the error and repair itself.
 */
async function executeTool(name, args, ctx) {
  const started = Date.now();
  const tool = findTool(name);
  if (!tool) {
    const available = allTools().map((t) => t.name).join(', ');
    return {
      ok: false,
      output: `Unknown tool "${name}". Available: ${available}`,
      durationMs: 0,
    };
  }

  const mode = ctx.approvalMode || 'auto';
  // Checked at the level of this call: a service tool can be `read` for a
  // search and `send` for a message, and read-only mode has to tell those apart.
  const permission = permissionForCall(tool, args);
  if (permission === 'write' && mode === 'readonly') {
    return {
      ok: false,
      output: `Permission denied: writes are disabled (approval mode "readonly").`,
      durationMs: 0,
    };
  }
  if (permission === 'exec' && mode === 'readonly') {
    return {
      ok: false,
      output: `Permission denied: command execution is disabled (approval mode "readonly").`,
      durationMs: 0,
    };
  }
  // `send` is its own level because it is the one that leaves the machine: it
  // goes out as the user, other people see it, and it cannot be taken back. It
  // is refused here rather than only in the tool's own code, so a read-only
  // session cannot perform an external action even if the tool forgets to ask —
  // and the message says which of the two refusals this is, because "writes are
  // disabled" would send someone looking for a file that was never the problem.
  if (permission === 'send' && mode === 'readonly') {
    // The action is named as well as the tool: a service tool is one schema for
    // a whole API, so "use_gmail was refused" would not say whether the model
    // tried to search or to send.
    const action =
      args && typeof args.action === 'string' && args.action.trim() ? ` (action ${args.action.trim()})` : '';
    return {
      ok: false,
      output:
        `Permission denied: external actions are disabled (approval mode "readonly"). ` +
        `"${name}"${action} would go out as the user, other people would see it, and it could not be ` +
        `taken back, so nothing was sent. Switch to "Ask first" to approve it case by case.`,
      durationMs: 0,
    };
  }

  try {
    const output = await tool.run(args || {}, ctx);
    return {
      ok: true,
      output: truncate(typeof output === 'string' ? output : JSON.stringify(output), LIMITS.maxToolOutput),
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      ok: false,
      output: truncate(`Error: ${err && err.message ? err.message : String(err)}`, 4_000),
      durationMs: Date.now() - started,
    };
  }
}

module.exports = {
  TOOLS,
  toolSchemas,
  toolCatalog,
  executeTool,
  permissionForCall,
  detectShell,
  buildInvocation,
  runShell,
  killTree,
  lineDiff,
  truncate,
  DEFAULTS,
  registerTools,
  allTools,
};
