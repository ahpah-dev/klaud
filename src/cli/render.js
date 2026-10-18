'use strict';

/**
 * Klaud CLI — event rendering.
 *
 * The split matters more than the decoration:
 *
 *   stdout  the assistant's answer, and nothing else
 *   stderr  everything that is not the answer — steps, tool calls, notices,
 *           reasoning, spinners, approval prompts
 *
 * so `klaud run "explain src/" > answer.md` writes prose and `--json` can own
 * stdout outright. The renderer keeps the two streams in step: a line of tool
 * output printed mid-sentence would corrupt the streamed answer, so every
 * non-text event first closes the open text line on stdout.
 */

const { sym, wrap, indent, visibleWidth } = require('./ui');

const MAX_RESULT_LINES = 6;
const MAX_LINE = 110;

function argSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  const pick = (key) => (typeof args[key] === 'string' ? args[key] : '');
  switch (name) {
    case 'run_command':
      return pick('command');
    case 'read_file':
    case 'write_file':
    case 'edit_file':
      return pick('path');
    case 'list_dir':
      return pick('path') || pick('dir') || '.';
    case 'glob_files':
      return pick('pattern');
    case 'search_text':
      return pick('pattern') || pick('query');
    case 'fetch_url':
      return pick('url');
    case 'todo_write':
      return `${(args.todos || []).length} item(s)`;
    case 'task':
      return pick('description');
    default:
      return pick('path') || pick('url') || pick('pattern') || pick('query') || pick('description') || '';
  }
}

function previewOutput(output, c, pad) {
  const text = String(output || '').trimEnd();
  if (!text) return '';
  const lines = text.split('\n').slice(0, MAX_RESULT_LINES);
  const more = text.split('\n').length - lines.length;
  const shown = lines.map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line));
  if (more > 0) shown.push(c.dim(`… ${more} more line${more === 1 ? '' : 's'}`));
  return indent(shown.join('\n'), pad);
}

/**
 * @param {object} opts
 * @param {NodeJS.WriteStream} opts.out  assistant text
 * @param {NodeJS.WriteStream} opts.err  everything else
 * @param {object} opts.c                palette
 * @param {boolean} opts.quiet           suppress step/todo chatter
 * @param {boolean} opts.verbose         show arguments and raw tool output
 * @param {boolean} opts.json            stdout belongs to the caller
 */
function createRenderer({ out, err, c, quiet = false, verbose = false, json = false }) {
  let textOpen = false;
  let lastWasBlank = true;

  /* Progress always goes to stderr, whatever --json is doing with stdout.
     Under --json the streamed answer moves to stderr too, so stdout carries
     exactly one JSON document and nothing else. */
  const sink = err;
  const textSink = json ? err : out;

  const closeText = () => {
    if (textOpen) {
      textSink.write('\n');
      textOpen = false;
    }
  };

  const line = (str) => {
    closeText();
    sink.write(`${str}\n`);
    lastWasBlank = false;
  };

  return {
    /* The palette, exposed so a caller can style its own stderr lines the
       same way the renderer does. */
    c,

    /* Close the stdout line before anything else touches the terminal. */
    closeText,

    handle(event) {
      if (!event || typeof event !== 'object') return;

      switch (event.type) {
        case 'text': {
          if (!textOpen) textOpen = true;
          textSink.write(String(event.value || ''));
          return;
        }

        case 'reasoning': {
          const value = String(event.value || '').trimEnd();
          if (!value) return;
          line(`${c.dim(c.italic ? c.italic(value) : value)}`);
          return;
        }

        case 'step':
          if (!quiet && !verbose) line(c.dim(`${sym.dot} step ${event.index}/${event.max}`));
          return;

        case 'tool_call': {
          const summary = argSummary(event.name, event.args);
          line(
            `${c.accent(sym.arrow)} ${c.bold(event.name)}${summary ? ` ${c.dim(summary)}` : ''}` +
              (verbose && event.raw ? `\n${c.dim(indent(String(event.raw).slice(0, 400), '      '))}` : '')
          );
          return;
        }

        case 'tool_start':
          return; // the tool_call line already named it

        case 'tool_result': {
          const ms = typeof event.durationMs === 'number' ? `${event.durationMs}ms` : '';
          if (event.denied) {
            line(`  ${c.yellow(sym.cross)} ${c.yellow('refused')} ${c.dim(ms)}`);
            return;
          }
          if (event.loop) {
            line(`  ${c.yellow(sym.warn)} ${c.yellow(`repeated ${event.repeats}× — skipped`)}`);
            return;
          }
          if (event.ok) {
            line(`  ${c.green(sym.ok)} ${c.dim(ms || 'ok')}${verbose ? '' : ''}`);
            if (verbose) {
              const preview = previewOutput(event.output, c, '      ');
              if (preview) line(c.dim(preview));
            }
          } else {
            line(`  ${c.red(sym.cross)} ${c.dim(ms)}`);
            const preview = previewOutput(event.output, c, '      ');
            if (preview) line(c.dim(preview));
          }
          return;
        }

        case 'todos': {
          if (quiet) return;
          const list = (event.todos || []).filter(Boolean);
          const done = list.filter((t) => t.state === 'done' || t.done === true).length;
          const active = list.find((t) => t.state === 'in_progress' || t.active === true);
          const parts = [`${done}/${list.length} done`];
          if (active) parts.push(c.accent(`→ ${active.content || active.text || ''}`));
          line(`  ${c.dim(`☑ ${parts.join(' · ')}`)}`);
          return;
        }

        case 'loop':
          line(`${c.yellow(sym.warn)} ${c.yellow(`same call ${event.repeats}×: ${event.name}`)} — moving on`);
          return;

        case 'notice': {
          const glyph = event.level === 'warn' ? c.yellow(sym.warn) : c.accent(sym.bullet);
          line(`${glyph} ${event.level === 'warn' ? c.yellow(event.message) : c.dim(event.message)}`);
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
          sink.write(`${c.red(sym.cross)} ${event.message}\n`);
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

module.exports = { createRenderer, argSummary, previewOutput, visibleWidth, wrap };