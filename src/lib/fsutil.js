'use strict';

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

/** Path helpers + glob/ignore primitives. No dependencies. */

function toPosix(p) {
  return p.split(path.sep).join('/');
}

/**
 * Resolve `input` against `root` and guarantee the result stays inside `root`.
 * Throws with a model-readable message when it would escape.
 */
function resolveInside(root, input) {
  const base = path.resolve(root);
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('path is required and must be a non-empty string');
  }
  if (input.includes('\0')) throw new Error('path contains a null byte');

  const target = path.resolve(base, input);
  const rel = path.relative(base, target);

  if (rel === '') return { abs: target, rel: '.' };
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `path "${input}" resolves outside the working directory (${base}). ` +
        `Use paths relative to the working directory.`
    );
  }
  return { abs: target, rel: toPosix(rel) };
}

async function statOrNull(abs) {
  try {
    return await fs.stat(abs);
  } catch {
    return null;
  }
}

async function exists(abs) {
  return (await statOrNull(abs)) !== null;
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next',
  '.nuxt', '.cache', '.parcel-cache', 'coverage', '.venv', 'venv', '__pycache__',
  '.mypy_cache', '.pytest_cache', '.turbo', '.gradle', 'target', 'vendor',
  '.idea', '.vscode-test', '.klaud', 'AppData',
]);

function isIgnoredDir(name) {
  return IGNORED_DIRS.has(name) || (name.startsWith('.') && name !== '.env.example');
}

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.pdf',
  '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib',
  '.node', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov',
  '.avi', '.wav', '.ogg', '.class', '.jar', '.pyc', '.wasm', '.bin', '.db',
  '.sqlite', '.sqlite3', '.lock',
]);

function looksBinaryExt(file) {
  return BINARY_EXT.has(path.extname(file).toLowerCase());
}

/**
 * Walk a tree, honouring ignore rules, yielding relative posix paths.
 * Stops once `max` entries have been produced.
 */
async function walk(root, { max = 5_000, includeIgnored = false, signal } = {}) {
  const out = [];
  const queue = [''];
  while (queue.length) {
    if (signal && signal.aborted) break;
    const relDir = queue.shift();
    const absDir = relDir ? path.join(root, relDir) : root;
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= max) return out;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!includeIgnored && isIgnoredDir(entry.name)) continue;
        queue.push(rel);
        out.push({ type: 'dir', rel });
      } else if (entry.isFile()) {
        out.push({ type: 'file', rel });
      }
    }
  }
  return out;
}

/**
 * Compile a glob into a RegExp. Supports **, *, ? and {a,b} alternation —
 * enough for the patterns a model actually emits.
 */
function globToRegExp(pattern) {
  let p = toPosix(pattern).replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        // `**/` matches zero or more directories; bare `**` matches anything.
        if (p[i + 2] === '/') {
          re += '(?:[^/]*/)*';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      const end = p.indexOf('}', i);
      if (end === -1) {
        re += '\\{';
      } else {
        const parts = p.slice(i + 1, end).split(',').map(escapeRe);
        re += `(?:${parts.join('|')})`;
        i = end;
      }
    } else {
      re += escapeRe(c);
    }
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Very small glob matcher used to decide which files a glob may return. */
function matchGlob(pattern, relPath) {
  const p = toPosix(relPath);
  const re = globToRegExp(pattern);
  if (re.test(p)) return true;
  // A pattern naming a directory (src) should match everything beneath it.
  if (!/[*?{]/.test(pattern) && (p === pattern || p.startsWith(`${pattern}/`))) return true;
  return false;
}

async function readTextFile(abs, { maxBytes = 4_000_000 } = {}) {
  const st = await fs.stat(abs);
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > maxBytes) {
    throw new Error(
      `file is ${st.size} bytes, larger than the ${maxBytes} byte limit. Read it in chunks.`
    );
  }
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) throw new Error('file appears to be binary; refusing to read as text');
  return buf.toString('utf8');
}

function ensureDirSync(dir) {
  fsSync.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  toPosix,
  resolveInside,
  statOrNull,
  exists,
  walk,
  globToRegExp,
  matchGlob,
  looksBinaryExt,
  isIgnoredDir,
  readTextFile,
  ensureDirSync,
  IGNORED_DIRS,
  BINARY_EXT,
};
