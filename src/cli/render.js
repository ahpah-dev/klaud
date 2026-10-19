'use strict';

/**
 * Klaud CLI — event rendering.
 *
 * The split matters more than the decoration:
 *
 *   stdout  the assistant's answer, and nothing else
 *   stderr  everything that is not the answer — tool cards, notices,
 *           reasoning, spinners, approval prompts
 *
 * so `klaud run "explain src/" > answer.md` writes prose and `--json` can own
 * stdout outright. The renderer keeps the two streams in step: a line of tool
 * output printed mid-sentence would corrupt the streamed answer, so every
 * non-text event first closes the open text line on stdout.
 *
 * Reading a turn:
 *
 *   ⏺ run_command   npm test
 *     ⎿ 18 lines · 3.1s
 *
 * The call line is a filled dot; its outcome hangs off the ⎿ below it, the
 * shape Claude Code uses so a long turn can be skimmed by the left margin
 * alone. Reasoning is buffered and printed once as a dim block — the provider
 * sends it in deltas, and one line per delta used to shred it into fragments.
 */

const {
  sym,
  wrap,
  indent,
  spinner,
  fmtDuration,
  fmtCount,
  visibleWidth,
} = require('./ui');

const MAX_PREVIEW_LINES = 4;
const MAX_VERBOSE_LINES = 14;
const MAX_LINE = 100;
const NAME_COLUMN = 13;

/** Short, human summary of the call's arguments — one line, clipped. */
function argSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  const pick = (key) => (typeof args[key] === 'string' ? args[key] : '');
  let value;
  switch (name) {
    case 'run_command':
      value = pick('command');
      break;
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      value = pick('path');
      break;
    case 'list_dir':
      value = pick('path') || pick('dir') || '.';
      break;
    case 'glob_files':
      value = pick('pattern');
      break;
    case 'search_text':
      value = pick('pattern') || pick('query');
      break;
    case 'fetch_url':
      value = pick('url');
      break;
    case 'todo_write':
      value = `${(args.todos || []).length} item${(args.todos || []).length === 1 ? '' : 's'}`;
      break;
    case 'task':
      value = pick('description');
      break;
    default:
      value = pick('path') || pick('url') || pick('pattern') || pick('query') || pick('description') || '';
  }
  // Commands and paths are the useful part; the line is a signpost, not a dump.
  const flat = String(value).replace(/\s+/g, ' ').trim();
  return flat.length > 96 ? `${flat.slice(0, 95)}…` : flat;
}

/** Line-level diff stats for an edit, good enough to say "+18 −4". */
function diffStats(name, args) {
  if (!args || typeof args !== 'object') return null;
  if (name === 'write_file' && typeof args.content === 'string') {
    const added = args.content === '' ? 0 : String(args.content).replace(/\n$/, '').split('\n').length;
    return { added, removed: 0 };
  }
  if (name === 'edit_file' && (typeof args.old_string === 'string' || typeof args.new_string === 'string')) {
    const before = String(args.old_string || '').replace(/\n$/, '').split('\n').filter((l, i, a) => !(l === '' && a.length === 1));
    const after = String(args.new_string || '').replace(/\n$/, '').split('\n').filter((l, i, a) => !(l === '' && a.length === 1));
    // Multiset difference: lines that disappear were removed, new lines added.
    // Not a real LCS, but for the "(unchanged) → (edited)" blocks an agent
    // sends it lands on the same counts a reviewer would.
    const counts = new Map();
    for (const line of before) counts.set(line, (counts.get(line) || 0) + 1);
    let added = 0;
    for (const line of after) {
      const seen = counts.get(line) || 0;
      if (seen > 0) counts.set(line, seen - 1);
      else added += 1;
    }
    let removed = 0;
    for (const seen of counts.values()) removed += seen;
    return { added, removed };
  }
  return null;
}

function previewOutput(output, c, pad, { limit = MAX_PREVIEW_LINES } = {}) {
  const text = String(output || '').trimEnd();
  if (!text) return '';
  const all = text.split('\n');
  const lines = all.slice(0, limit);
  const more = all.length - lines.length;
  const shown = lines.map((line) => (visibleWidth(line) > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line));
  if (more > 0) shown.push(c.dim(`… ${more} more line${more === 1 ? '' : 's'}`));
  return indent(shown.join('\n'), pad);
}

/**
 * A compact line diff between an edit's before and after text.
 *
 * The app renders a full unified diff on the card; the terminal needs the same
 * signal in fewer rows, so this returns the changed lines with up to `context`
 * unchanged lines around them. Beyond a sane size the LCS is skipped and the
 * whole block is reported as replaced — a pathological rewrite must not stall
 * the terminal.
 */
function lineDiff(before, after, { context = 2, maxLines = 40 } = {}) {
  const a = String(before ?? '').replace(/\n$/, '').split('\n');
  const b = String(after ?? '').replace(/\n$/, '').split('\n');

  if (a.length * b.length > 250_000) {
    const ops = a.slice(0, maxLines).map((text) => ({ type: '-', text }));
    ops.push(...b.slice(0, maxLines).map((text) => ({ type: '+', text })));
    return ops.slice(0, maxLines);
  }

  // Classic LCS table, walked backwards into an edit script.
  const rows = a.length;
  const cols = b.length;
  const table = Array.from({ length: rows + 1 }, () => new Uint16Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: '-', text: a[i] });
      i += 1;
    } else {
      ops.push({ type: '+', text: b[j] });
      j += 1;
    }
  }
  while (i < rows) ops.push({ type: '-', text: a[i++] });
  while (j < cols) ops.push({ type: '+', text: b[j++] });

  // Keep the changes plus a little context, so a one-line edit does not print
  // the whole block that surrounded it.
  const keep = new Set();
  ops.forEach((op, index) => {
    if (op.type === ' ') return;
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k += 1) {
      keep.add(k);
    }
  });

  const out = [];
  let skipped = 0;
  ops.forEach((op, index) => {
    if (!keep.has(index)) {
      skipped += 1;
      return;
    }
    if (skipped) {
      out.push({ type: '…', text: '' });
      skipped = 0;
    }
    out.push(op);
  });
  if (skipped) out.push({ type: '…', text: '' });

  if (out.length > maxLines) {
    out.length = maxLines;
    out.push({ type: '…', text: '' });
  }
  return out;
}

/** Render a diff as terminal lines, coloured and clipped. */
function renderDiff(ops, c, pad = '      ') {
  return ops
    .map((op) => {
      if (op.type === '…') return c.dim(`${pad}…`);
      if (op.type === '-') return c.red(`${pad}- ${clipLine(op.text)}`);
      if (op.type === '+') return c.green(`${pad}+ ${clipLine(op.text)}`);
      return c.dim(`${pad}  ${clipLine(op.text)}`);
    })
    .join('\n');
}

/** The diff an edit or a write implies, from the arguments it was called with. */
function changeDiff(call, maxLines) {
  const args = (call && call.args) || {};
  if (call.name === 'edit_file') {
    return lineDiff(args.old_string || '', args.new_string || '', { maxLines });
  }
  if (call.name === 'write_file') {
    return lineDiff('', args.content || '', { maxLines });
  }
  return [];
}

function clipLine(text) {
  const value = String(text ?? '');
  return visibleWidth(value) > MAX_LINE ? `${value.slice(0, MAX_LINE - 1)}…` : value;
}

/** What the call produced, in the smallest honest form. */
function metricsFor(call, event, c) {
  const bits = [];
  const name = call && call.name;
  const args = (call && call.args) || {};
  const output = String(event.output || '');
  const nonEmpty = output.split('\n').filter((line) => line.trim()).length;

  /* A failed call gets one word and the reason below it — "+2 −0 failed" would
     claim work that did not happen. */
  if (event.ok === false) return [c.red('failed')];

  if (name === 'read_file') {
    bits.push(`${fmtCount(nonEmpty)} line${nonEmpty === 1 ? '' : 's'}`);
  } else if (name === 'write_file' || name === 'edit_file') {
    const stats = diffStats(name, args);
    if (stats && (stats.added || stats.removed)) {
      bits.push(`${c.green(`+${stats.added}`)} ${c.red(`−${stats.removed}`)}`);
    }
  } else if (name === 'glob_files' || name === 'search_text') {
    bits.push(`${fmtCount(nonEmpty)} match${nonEmpty === 1 ? '' : 'es'}`);
  } else if (name === 'list_dir') {
    bits.push(`${fmtCount(nonEmpty)} entr${nonEmpty === 1 ? 'y' : 'ies'}`);
  } else if (name === 'run_command' && nonEmpty) {
    bits.push(`${fmtCount(nonEmpty)} line${nonEmpty === 1 ? '' : 's'}`);
  }
  if (!bits.length) bits.push(c.green('ok'));
  return bits;
}

/**
 * @param {object} opts
 * @param {NodeJS.WriteStream} opts.out  assistant text
 * @param {NodeJS.WriteStream} opts.err  everything else
 * @param {object} opts.c                palette
 * @param {boolean} opts.quiet           suppress progress chatter
 * @param {boolean} opts.verbose         show arguments and raw tool output
 * @param {boolean} opts.json            stdout belongs to the caller
 * @param {boolean} [opts.live]          animate a spinner; defaults to err.isTTY
 */
function createRenderer({ out, err, c, quiet = false, verbose = false, json = false, live }) {
  let textOpen = false;
  let lastWasBlank = true;
  let spin = null;
  let reasoning = '';
  let pending = null;

  /* Progress always goes to stderr, whatever --json is doing with stdout.
     Under --json the streamed answer moves to stderr too, so stdout carries
     exactly one JSON document and nothing else. */
  const sink = err;
  const textSink = json ? err : out;
  const animate = live === undefined ? Boolean(err && err.isTTY) : Boolean(live);

  const stopSpin = () => {
    if (!spin) return;
    spin.clear();
    spin = null;
  };

  const startSpin = (label = 'thinking') => {
    if (!animate || quiet) return;
    if (spin) {
      spin.text(label);
      return;
    }
    spin = spinner(sink, c, label);
    spin.start();
  };

  function flushReasoning() {
    const text = reasoning.replace(/\s+$/, '');
    reasoning = '';
    if (!text) return;
    stopSpin();
    const width = Math.max(40, (sink.columns || 80) - 6);
    const lines = wrap(text, width, '    ').split('\n');
    sink.write(`${c.dim(`  ${sym.think} ${lines[0]}`)}\n`);
    for (const rest of lines.slice(1)) sink.write(`${c.dim(rest)}\n`);
    lastWasBlank = false;
  }

  const closeText = () => {
    flushReasoning();
    if (textOpen) {
      textSink.write('\n');
      textOpen = false;
    }
  };

  const write = (str) => {
    sink.write(`${str}\n`);
    lastWasBlank = false;
  };

  const line = (str) => {
    closeText();
    stopSpin();
    write(str);
  };

  return {
    /* The palette, exposed so a caller can style its own stderr lines the
       same way the renderer does. */
    c,

    /* Close the stdout line before anything else touches the terminal. */
    closeText,

    /** Start the "thinking" beat before the first model token arrives. */
    begin() {
      startSpin('thinking');
    },

    /** End a turn: flush anything buffered, then print a summary line. */
    finish(message) {
      closeText();
      stopSpin();
      if (message) write(message);
    },

    handle(event) {
      if (!event || typeof event !== 'object') return;

      switch (event.type) {
        case 'text': {
          flushReasoning();
          stopSpin();
          if (!textOpen) textOpen = true;
          textSink.write(String(event.value || ''));
          return;
        }

        case 'reasoning': {
          stopSpin();
          reasoning += String(event.value || '');
          return;
        }

        case 'step': {
          /* The step counter is the engine's bookkeeping; the tool cards and
             the spinner already say what is happening. Keep it for -v. */
          if (verbose) line(c.dim(`${sym.dot} step ${event.index}/${event.max}`));
          else startSpin('thinking');
          return;
        }

        case 'tool_call': {
          pending = { name: event.name, args: event.args || {}, startedAt: Date.now() };
          const summary = argSummary(event.name, event.args);
          line(
            `  ${c.accent(sym.tool)} ${c.bold(String(event.name).padEnd(NAME_COLUMN))}` +
              (summary ? c.dim(summary) : '')
          );
          if (verbose && event.raw) line(c.dim(indent(String(event.raw).slice(0, 400), '      ')));
          return;
        }

        case 'tool_start':
          return; // the tool_call card already named it

        case 'tool_result': {
          const call = pending || { name: event.name, args: {} };
          pending = null;
          const ms = typeof event.durationMs === 'number' ? fmtDuration(event.durationMs) : '';
          if (event.denied) {
            line(`    ${c.yellow(sym.result)} ${c.yellow('denied')}${ms ? c.dim(` · ${ms}`) : ''}`);
            return;
          }
          if (event.loop) {
            line(`    ${c.yellow(sym.result)} ${c.yellow(`repeated ${event.repeats}× — skipped`)}`);
            return;
          }
          const glyph = event.ok === false ? c.red(sym.result) : c.green(sym.result);
          const bits = metricsFor(call, event, c);
          if (ms) bits.push(c.dim(ms));
          line(`    ${glyph} ${bits.join(c.dim(' · '))}`);
          /* A change is the thing worth reading: show it, clipped, right under
             the card — the same signal the app's diff card carries. */
          if (event.ok && (call.name === 'edit_file' || call.name === 'write_file')) {
            const ops = changeDiff(call, verbose ? 24 : 10);
            if (ops.length) line(renderDiff(ops, c));
          }
          if (!event.ok || verbose) {
            const preview = previewOutput(event.output, c, '      ', {
              limit: verbose ? MAX_VERBOSE_LINES : MAX_PREVIEW_LINES,
            });
            if (preview) line(preview);
          }
          return;
        }

        case 'todos': {
          if (quiet) return;
          const list = (event.todos || []).filter(Boolean);
          if (!list.length) return;
          const done = list.filter((t) => t.state === 'done' || t.done === true).length;
          const active = list.find((t) => t.state === 'in_progress' || t.active === true);
          const current = active ? String(active.content || active.text || '').replace(/\s+/g, ' ').slice(0, 64) : '';
          line(
            `  ${c.dim(`☑ ${done}/${list.length} done`)}` + (current ? ` ${c.dim(sym.dot)} ${c.accent(current)}` : '')
          );
          return;
        }

        case 'loop':
          line(`${c.yellow(sym.warn)} ${c.yellow(`same call ${event.repeats}×: ${event.name}`)} ${c.dim('— moving on')}`);
          return;

        case 'notice': {
          const warn = event.level === 'warn';
          line(warn ? `  ${c.yellow(sym.warn)} ${c.yellow(event.message)}` : `  ${c.dim(`${sym.bullet} ${event.message}`)}`);
          return;
        }

        case 'approval_denied':
          line(`  ${c.yellow(sym.cross)} ${c.yellow('denied by you')} ${c.dim(event.name)}`);
          return;

        case 'aborted':
          line(`${c.yellow(sym.warn)} ${c.yellow('cancelled')}`);
          return;

        case 'error':
          closeText();
          stopSpin();
          sink.write(`${c.red(sym.fail)} ${c.red(event.message)}\n`);
          lastWasBlank = false;
          return;

        case 'done':
        case 'finish':
        case 'usage':
        case 'turn_start':
        case 'saved':
        case 'turn_end':
          return; // summarised by the caller

        default:
          return;
      }
    },

    /** A quiet informational line on stderr (banner, session id, timings). */
    note(text) {
      line(text);
    },

    /** Blank separator on stderr, collapsed when the last line already was one. */
    gap() {
      if (lastWasBlank) return;
      closeText();
      stopSpin();
      sink.write('\n');
      lastWasBlank = true;
    },

    /** The final answer, when it was not streamed (error paths only). */
    answer(text) {
      if (!text || json) return;
      closeText();
      textSink.write(`${text}\n`);
    },
  };
}

module.exports = {
  createRenderer,
  argSummary,
  previewOutput,
  diffStats,
  metricsFor,
  visibleWidth,
  wrap,
};
