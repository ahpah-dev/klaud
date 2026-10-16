#!/usr/bin/env node
'use strict';

/**
 * NVIDIA NIM check — confirm the model this app recommends is still real.
 *
 *   npm run check-nvidia                 # list the live catalogue
 *   npm run check-nvidia -- <api-key>    # also send a real tool-calling test
 *
 * The catalogue endpoint answers without a key, which is what makes NVIDIA's
 * claims checkable in a way most providers' are not. If /models stops listing
 * `nvidia/nemotron-3.5-super-vl-120b-a12b`, the recommendation in the app is
 * stale and should be changed — that is exactly what this is for.
 */

const MODELS_URL = 'https://integrate.api.nvidia.com/v1/models';
const CHAT_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const WANTED = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  head: (s) => `\x1b[38;5;209m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

(async () => {
  const key = process.argv[2] || process.env.NVIDIA_API_KEY || '';
  console.log(`\n${C.head('◆ Klaud — NVIDIA NIM check')}\n`);

  /* 1. Is the model still in the catalogue? */
  let ids = [];
  try {
    const res = await fetch(MODELS_URL, { signal: AbortSignal.timeout(30_000) });
    const json = await res.json();
    ids = (json.data || []).map((m) => m.id);
    console.log(`  ${C.ok('OK  ')} GET /v1/models  ${C.dim(`HTTP ${res.status}`)}  ${ids.length} models listed`);
  } catch (err) {
    console.log(`  ${C.bad('FAIL')} GET /v1/models  ${err.message}\n`);
    process.exit(1);
  }

  const present = ids.includes(WANTED);
  console.log(`  ${present ? C.ok('OK  ') : C.bad('FAIL')} ${WANTED} ${present ? 'is served' : 'is NOT in the catalogue'}\n`);

  const nemotrons = ids.filter((i) => /nemotron/i.test(i)).sort();
  console.log(C.bold('  Nemotron models currently served\n'));
  for (const id of nemotrons) {
    console.log(`    ${id === WANTED ? C.ok('→') : ' '} ${id}`);
  }
  console.log('');

  if (!present) {
    console.log(`  ${C.warn('The recommended model is gone.')} Pick one of the ids above and`);
    console.log(C.dim('  update the nvidia entry in src/providers.js.\n'));
  }

  /* 2. Optional: a real tool-calling round trip. */
  if (!key) {
    console.log(C.dim('  No API key given, so the live request was skipped.'));
    console.log(C.dim('  Pass one to test tool calling end to end:'));
    console.log(`    ${C.bold('npm run check-nvidia -- <api-key>')}\n`);
    console.log(C.dim('  Get a free key at https://build.nvidia.com — no card.\n'));
    return;
  }

  console.log(C.bold('  Live tool-calling test\n'));
  const body = {
    model: WANTED,
    messages: [
      { role: 'system', content: 'You are a coding agent. Use the tools you are given.' },
      { role: 'user', content: 'What is in the file README.md? Use the read_file tool.' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file from disk',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'File to read' } },
            required: ['path'],
          },
        },
      },
    ],
    tool_choice: 'auto',
    max_tokens: 200,
    temperature: 0.2,
  };

  try {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });
    const text = await res.text();
    console.log(`  ${res.ok ? C.ok('OK  ') : C.bad('FAIL')} POST /v1/chat/completions  ${C.dim(`HTTP ${res.status}`)}`);
    console.log(`       ${C.dim(text.replace(/\s+/g, ' ').slice(0, 500))}\n`);

    if (res.ok) {
      let calls = [];
      try {
        calls = JSON.parse(text).choices?.[0]?.message?.tool_calls || [];
      } catch { /* ignore */ }
      if (calls.length) {
        console.log(`  ${C.ok('Tool calling works.')} It asked to call ${calls.map((c) => c.function?.name).join(', ')}.`);
        console.log(C.dim('  Klaud can drive this model as a coding agent.\n'));
      } else {
        console.log(`  ${C.warn('No tool call came back.')} The model answered in prose instead.`);
        console.log(C.dim('  It can still chat, but the agent loop will not edit files reliably.\n'));
      }
    } else {
      console.log(C.dim('  Common causes: the key is wrong or expired, or the trial terms need accepting'));
      console.log(C.dim('  on the model page at build.nvidia.com first.\n'));
    }
  } catch (err) {
    console.log(`  ${C.bad('FAIL')} POST /v1/chat/completions  ${err.message}\n`);
  }
})().catch((err) => {
  console.error(`\n  Check crashed: ${err.message}\n`);
  process.exit(1);
});
