'use strict';

/**
 * Klaud CLI â€” terminal presentation.
 *
 * Colour, symbols, wrapping, spinners and prompts. Everything degrades
 * honestly: when the stream is not a TTY, or NO_COLOR is set, the ANSI codes
 * collapse to empty strings and the output stays readable as plain text,
 * which is what makes `klaud run ... | tee log.txt` and CI runs sane.
 */

const readline = require('readline');
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
  ok: 'âœ“',
  fail: 'âœ—',
  arrow: 'â†’',
  bullet: 'â€¢',
  warn: '!',
  dot: 'Â·',
  prompt: 'â¯',
  chevron: 'â€º',
  check: '[âœ“]',
  cross: '[âœ—]',
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

/* ------------------------------ spinner ------------------------------- */

function spinner(stream, c, text) {
  const frames = ['â ‹', 'â ™', 'â ¹', 'â ¸', 'â ¼', 'â ´', 'â ¦', 'â §', 'â ‡', 'â '];
  let i = 0;
  let timer = null;
  let visible = false;
  const supported = Boolean(stream && stream.isTTY);

  const paint = () => {
    if (!supported) return;
    stream.write(`\r\x1b[2K${c.accent(frames[i % frames.length])} ${c.dim(text)}`);
    i += 1;
    visible = true;
  };

  return {
    start() {
      if (timer) return;
      if (supported) {
        paint();
        timer = setInterval(paint, 90);
        if (timer.unref) timer.unref();
      } else if (stream) {
        // Not a TTY: no animation, but say something is happening exactly once.
        stream.write(`${text}â€¦\n`);
        visible = true;
      }
    },
    text(next) {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      text = next;
      paint();
      timer = setInterval(paint, 90);
      if (timer.unref) timer.unref();
    },
    stop(message) {
      if (timer) clearInterval(timer);
      timer = null;
      if (supported) stream.write('\r\x1b[2K');
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
 * Read one line from stdin. Resolves `null` on EOF (Ctrl+D), so a caller can
 * treat "stream ended" as "leave" rather than hanging forever.
 */
function ask(question, { input = process.stdin, output = process.stdout, def = '' } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
    const suffix = def ? ` ${def}` : '';
    rl.question(`${question}${suffix} `, (answer) => {
      rl.close();
      const value = String(answer || '').trim();
      resolve(value || (def || null));
    });
    rl.on('close', () => resolve(null));
  });
}

/** Read a line without echoing it â€” for API keys. */
function secret(question, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: Boolean(input.isTTY) });
    const originalWrite = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (chunk) => {
      const text = String(chunk);
      if (text.includes(question)) originalWrite?.(text);
      // Swallow the typed characters; the prompt itself was already written.
    };
    output.write(question);
    rl.question(' ', (answer) => {
      rl.close();
      output.write('\n');
      resolve(String(answer || '').trim() || null);
    });
    rl.on('close', () => resolve(null));
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
      if (key === '') return done(choices[choices.length - 1].value); // Ctrl+C
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
  spinner,
  ask,
  secret,
  choose,
};