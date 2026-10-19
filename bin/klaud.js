#!/usr/bin/env node
'use strict';

/**
 * Klaud CLI launcher.
 *
 * Flushes stdout before exiting: `process.exit()` alone truncates piped output,
 * which would corrupt exactly the use this binary is built for —
 * `klaud run "summarise this repo" > out.md`.
 */

const { main } = require('../src/cli/main');

/* Piping into `head` (or PowerShell's Select-Object -First) closes our stdout
   mid-write. That is not a failure — exit quietly rather than crash on EPIPE. */
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(process.exitCode || 0);
  });
}

main(process.argv.slice(2)).then(
  (code) => {
    const exitCode = typeof code === 'number' ? code : 0;
    process.exitCode = exitCode;

    // Let stdout drain on its own. Forcing an exit from inside a write
    // callback trips a libuv assertion on Windows, and an idle keep-alive
    // socket from the provider can otherwise hold the loop open for seconds —
    // so leave a single unref'd timer behind: it fires only if something else
    // is still keeping the process alive, and never keeps it alive itself.
    setImmediate(() => {
      const fallback = setTimeout(() => process.exit(exitCode), 300);
      if (fallback.unref) fallback.unref();
    });
  },
  (err) => {
    /* A usage mistake is not a crash: say what is wrong and point at --help,
       without a stack trace that makes the terminal look broken. */
    if (err && err.code === 'EUSAGE') {
      const { makePalette } = require('../src/cli/ui');
      const c = makePalette(process.stderr);
      process.stderr.write(`${c.red('error')} ${err.message}\n`);
      process.stderr.write(`Run ${c.bold('klaud --help')} to see the options.\n`);
      process.exitCode = 2;
      setImmediate(() => {
        const fallback = setTimeout(() => process.exit(2), 300);
        if (fallback.unref) fallback.unref();
      });
      return;
    }
    process.stderr.write(`${err && err.stack ? err.stack : String(err)}\n`);
    process.exitCode = 1;
    setImmediate(() => {
      const fallback = setTimeout(() => process.exit(1), 300);
      if (fallback.unref) fallback.unref();
    });
  }
);