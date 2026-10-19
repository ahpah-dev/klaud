'use strict';

/**
 * Klaud CLI — terminal presentation.
 *
 * Colour, symbols, layout, spinners and prompts. Everything degrades honestly:
 * when the stream is not a TTY, or NO_COLOR is set, the ANSI codes collapse to
 * empty strings and the output stays readable as plain text, which is what
 * makes `klaud run ... | tee log.txt` and CI runs sane.
 *
 * Layout primitives live here rather than in each command so a panel drawn by
 * the banner, the approval prompt and the help screen is the same panel: one
 * border weight, one padding, one truncation rule.
 */

const readline = require('readline');
const os = require('os');
const { stripVTControlCharacters } = require('util');

/* ------------------------------- colour ------------------------------- */

function colorEnabled(stream) {
  if (process.env.NO_COLOR) return false; // https://no-color.org
  if (process.env.FORCE_COLOR) return process.env.FORCE_COLOR !== '0';
  if (process.env.TERM === 'dumb') return false;
  if (process.env.CI) return false;
  return Boolean(stream && stream.isTTY);
}

function makePalette(stream) {
  const on = colorEnabled(stream);
  const wrap = (open, close) => (s) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

  return {
    enabled: on,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    italic: wrap(3, 23),
    underline: wrap(4, 24),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
    grey: wrap(90, 39),
    /* Claude terracotta, truecolor when the terminal can take it. */
    accent: on
      ? (s) => `\x1b[38;2;217;119;87m${s}\x1b[39m`
      : (s) => String(s),
    /* Inverse used for the user's own echo, so a turn reads directionally. */
    user: on
      ? (s) => `\x1b[38;2;250;249;245m\x1b[48;2;45;42;38m${s}\x1b[39m\x1b[49m`
      : (s) => String(s),
  };
}

/* ------------------------------ symbols ------------------------------- */

const sym = {
  ok: '✓',
  fail: '✗',
  arrow: '→',
  bullet: '•',
  warn: '!',
  dot: '·',
  prompt: '❯',
  chevron: '›',
  check: '[✓]',
  cross: '[✗]',
  /* A tool call opens with a filled dot and its outcome hangs off a T line —
     the two glyphs the reference CLI uses to make a turn skimmable. */
  tool: '⏺',
  result: '⎿',
  think: '✻',
  line: '─',
};

/* ------------------------------- output ------------------------------- */

/** Visible width, ignoring the ANSI codes we just added. */
function visibleWidth(str) {
  return stripVTControlCharacters(String(str)).length;
}

function wrap(text, width, indent = '') {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (visibleWidth(line) + 1 + visibleWidth(word) <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n');
}

function indent(text, pad) {
  return String(text)
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n');
}

/** Left-aligned column of label/value pairs, aligned on the widest label. */
function table(rows, c, gap = 2) {
  if (!rows.length) return '';
  const width = Math.max(...rows.map(([label]) => visibleWidth(label)));
  return rows
    .map(([label, value]) => {
      const pad = ' '.repeat(width - visibleWidth(label));
      return `${pad}${c.bold(label)}${' '.repeat(gap)}${value}`;
    })
    .join('\n');
}

/** Definition rows: term on the left, wrapped description on the right. */
function defList(rows, c, totalWidth = 78, labelWidth = 22) {
  const out = [];
  for (const [label, description] of rows) {
    const wrapped = wrap(String(description), totalWidth - labelWidth - 2, ' '.repeat(labelWidth + 2));
    const [first, ...rest] = wrapped.split('\n');
    out.push(`${c.bold(label.padEnd(labelWidth))}  ${first || ''}`);
    out.push(...rest);
  }
  return out.join('\n');
}

/** A dim horizontal rule, for separating sections without a blank line. */
function rule(width, c) {
  return c.dim(sym.line.repeat(Math.max(1, Math.floor(width))));
}

/** Fixed-width label column, for small key/value stacks (banner, details). */
function columns(rows, c, { left = 10, gap = 2 } = {}) {
  return rows
    .map(([label, value]) => `${c.dim(String(label).padEnd(left))}${' '.repeat(gap)}${value}`)
    .join('\n');
}

/**
 * A rounded panel: optional title, one line per row, dim border.
 *
 * Rows may contain ANSI colour; padding is computed on the visible width. A
 * row wider than the panel is clipped (coloured rows are left alone rather
 * than mangled mid-escape). This is the one box used by the banner, approval
 * prompts and help screens, so they cannot drift apart.
 */
function panel(title, rows, c, { max = 76, pad = 1 } = {}) {
  const body = (Array.isArray(rows) ? rows : [rows]).map((r) => String(r ?? ''));
  const titleWidth = title ? visibleWidth(title) + 4 : 0;
  const wanted = Math.max(titleWidth, ...body.map((r) => visibleWidth(r) + pad * 2), 10);
  const inner = Math.min(max, wanted);

  const border = (s) => c.dim(s);
  const fill = (n) => sym.line.repeat(Math.max(0, n));

  const top = title
    ? `${border('╭─')} ${c.bold(title)} ${border(`${fill(inner - visibleWidth(title) - 3)}╮`)}`
    : `${border(`╭${fill(inner)}╮`)}`;

  const lines = body.map((row) => {
    let content = row;
    if (visibleWidth(content) > inner - pad) {
      if (!/\x1b\[/.test(content)) {
        content = `${content.slice(0, Math.max(0, inner - pad - 1))}…`;
      }
    }
    return `${border('│')} ${content}${' '.repeat(Math.max(0, inner - pad - visibleWidth(content)))}${border('│')}`;
  });

  return [top, ...lines, border(`╰${fill(inner)}╯`)].join('\n');
}

/* ----------------------------- formatting ----------------------------- */

function fmtDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function fmtCount(n) {
  const value = Number(n) || 0;
  return value.toLocaleString('en-US');
}

function fmtTokens(n) {
  const value = Number(n) || 0;
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 10000) return `${(value / 1000).toFixed(1)}k`;
  return fmtCount(value);
}

/** `C:\Users\me\projects\api` → `~/projects/api`, shortened from the middle. */
function shortPath(target, { max = 44 } = {}) {
  let shown = String(target || '');
  const home = os.homedir();
  if (home && shown.toLowerCase().startsWith(home.toLowerCase())) shown = `~${shown.slice(home.length)}`;
  if (shown.length > max) {
    const keep = Math.max(6, Math.floor((max - 1) / 2));
    shown = `${shown.slice(0, keep)}…${shown.slice(-keep)}`;
  }
  return shown;
}

function hostOf(baseUrl) {
  try {
    return new URL(String(baseUrl || '')).host;
  } catch {
    return String(baseUrl || '');
  }
}

/* ------------------------------ spinner ------------------------------- */

/**
 * A one-line spinner on stderr, with the elapsed seconds beside the label.
 *
 * On a TTY it animates and erases itself; anywhere else it says what is
 * happening exactly once, so a CI log shows progress without carriage returns.
 */
function spinner(stream, c, text) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let index = 0;
  let timer = null;
  let label = text;
  let visible = false;
  const started = Date.now();
  const supported = Boolean(stream && stream.isTTY);

  const paint = () => {
    if (!supported) return;
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    stream.write(`\r\x1b[2K${c.accent(frames[index % frames.length])} ${label} ${c.dim(`${seconds}s`)}`);
    index += 1;
    visible = true;
  };

  const start = () => {
    if (timer) return;
    if (supported) {
      paint();
      timer = setInterval(paint, 90);
      if (timer.unref) timer.unref();
    } else if (stream) {
      // Not a TTY: no animation, but say something is happening exactly once.
      stream.write(`${label}…\n`);
      visible = true;
    }
  };

  return {
    start,
    text(next) {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      label = next;
      paint();
      timer = setInterval(paint, 90);
      if (timer.unref) timer.unref();
    },
    clear() {
      if (timer) clearInterval(timer);
      timer = null;
      if (supported && visible) stream.write('\r\x1b[2K');
      visible = false;
    },
    stop(message) {
      if (timer) clearInterval(timer);
      timer = null;
      if (supported && visible) stream.write('\r\x1b[2K');
      if (message && stream) stream.write(`${message}\n`);
      visible = false;
    },
    get active() {
      return Boolean(timer) || visible;
    },
  };
}

/* ------------------------------- prompts ------------------------------ */

/**
 * Prompts share one reader per input stream, and buffered input is never lost.
 *
 * Readline emits 'line' as data arrives, whether or not a question is pending.
 * Opening an interface per question therefore dropped every line the previous
 * one had already read, and a question registered a tick later missed the event
 * entirely — so piped input to `klaud init` answered only the first prompt and
 * silently took defaults for the rest. One reader plus a line queue keeps the
 * answers in the order they were written, and the TTY path still uses readline's
 * own question so typing, editing and echo behave normally.
 */
const readers = new WeakMap();
/** Streams already at EOF. A prompt on one must not build a fresh interface:
    nothing would hold the event loop open, and Node would exit in the middle of
    the flow instead of letting the remaining defaults run through. */
const endedStreams = new WeakSet();

function readerFor(input, output) {
  let state = readers.get(input);
  if (state) return state;

  const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
  state = { rl, queue: [], waiters: [], closed: false, tty: Boolean(input.isTTY) };

  // Piped input: keep every line until a prompt asks for it.
  rl.on('line', (line) => {
    if (state.tty) return; // on a TTY readline hands lines to rl.question
    const waiter = state.waiters.shift();
    if (waiter) waiter(line);
    else state.queue.push(line);
  });
  rl.on('close', () => {
    state.closed = true;
    endedStreams.add(input);
    while (state.waiters.length) state.waiters.shift()(null);
    readers.delete(input);
  });

  readers.set(input, state);
  return state;
}

/** Close the shared reader, so a finished setup does not hold the process open. */
function endPrompts(input = process.stdin) {
  const state = readers.get(input);
  if (!state) return;
  readers.delete(input);
  try {
    state.rl.close();
  } catch { /* already closed */ }
}

/**
 * Read one line. Resolves `null` on EOF (Ctrl+D), so a caller can treat
 * "stream ended" as "leave" rather than hanging forever.
 */
function ask(question, { input = process.stdin, output = process.stdout, def = '' } = {}) {
  const prompt = `${question}${def ? ` ${def}` : ''} `;
  return new Promise((resolve) => {
    const finish = (raw) => {
      const value = String(raw ?? '').trim();
      resolve(value || (def || null));
    };

    if (endedStreams.has(input)) {
      finish(null);
      return;
    }

    const state = readerFor(input, output);
    if (state.closed) {
      finish(null);
      return;
    }

    if (state.tty) {
      state.rl.question(prompt, finish);
      state.rl.once('close', () => finish(null));
      return;
    }

    output.write(prompt);
    if (state.queue.length) {
      finish(state.queue.shift());
      return;
    }
    state.waiters.push(finish);
    state.rl.once('close', () => finish(null));
  });
}

/** Read a line without echoing it — for API keys. Piped input has no echo. */
function secret(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) return ask(question, { input, output });

  const state = readerFor(input, output);
  const originalWrite = state.rl._writeToOutput?.bind(state.rl);
  state.rl._writeToOutput = (chunk) => {
    const text = String(chunk);
    if (text.includes(question)) originalWrite?.(text);
    // Swallow the typed characters; the prompt itself was already written.
  };
  output.write(question);

  return new Promise((resolve) => {
    const finish = (raw) => {
      state.rl._writeToOutput = originalWrite;
      resolve(String(raw ?? '').trim() || null);
    };
    state.rl.question(' ', (answer) => {
      output.write('\n');
      finish(answer);
    });
    state.rl.once('close', () => finish(null));
  });
}

/**
 * A single-key choice: press y/n/a and continue, no Enter needed.
 * Falls back to a line-based prompt when stdin is not a TTY (piped input),
 * so automated runs can answer approvals with `echo y | klaud run ...`.
 */
function choose(question, choices, { input = process.stdin, output = process.stdout, c } = {}) {
  const keys = choices.map((ch) => ch.key.toLowerCase()).join('/');

  if (!input.isTTY) {
    return ask(`${question} [${keys}]`, { input, output }).then((answer) => {
      const found = choices.find((ch) => ch.key.toLowerCase() === String(answer || '').toLowerCase());
      return found ? found.value : choices[choices.length - 1].value;
    });
  }

  return new Promise((resolve) => {
    output.write(`${question} ${c ? c.dim(`(${keys})`) : `(${keys})`} `);
    const wasRaw = input.isRaw;
    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');

    const done = (value) => {
      input.removeListener('data', onData);
      input.setRawMode?.(wasRaw);
      input.pause();
      output.write('\n');
      resolve(value);
    };

    const onData = (chunk) => {
      const key = String(chunk);
      if (key === '\u0003') return done(choices[choices.length - 1].value); // Ctrl+C
      if (key === '\r' || key === '\n') {
        const fallback = choices.find((ch) => ch.default);
        return done(fallback ? fallback.value : choices[choices.length - 1].value);
      }
      const found = choices.find((ch) => ch.key.toLowerCase() === key.toLowerCase());
      if (found) done(found.value);
    };

    input.on('data', onData);
  });
}

module.exports = {
  colorEnabled,
  makePalette,
  sym,
  visibleWidth,
  wrap,
  indent,
  table,
  defList,
  rule,
  columns,
  panel,
  fmtDuration,
  fmtCount,
  fmtTokens,
  shortPath,
  hostOf,
  spinner,
  ask,
  secret,
  endPrompts,
  choose,
};
