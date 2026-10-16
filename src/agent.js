'use strict';

/**
 * The agent loop: model -> tool calls -> tool results -> model, until the model
 * answers without asking for another tool.
 */

const path = require('path');
const { streamChat, LLMError, parseToolArguments } = require('./llm');
const { toolSchemas, executeTool, permissionForCall, registerTools } = require('./lib/tools');
const { listServiceTools, authToolDefinitions, describeConnectionsForPrompt } = require('./lib/api-tool');
const { LIMITS } = require('./config');
const {
  collectExtensions,
  augmentSystemPrompt,
  registerExtensionTools,
  runSubagent,
} = require('./extensions');

const MESSAGE_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * Keep only the fields an OpenAI-compatible endpoint accepts, and guarantee the
 * message sequence is well formed (an assistant tool_calls message must be
 * followed by one `tool` message per call, in order).
 */
function sanitizeMessages(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || !MESSAGE_ROLES.has(message.role)) continue;
    const clean = { role: message.role };

    if (typeof message.content === 'string') clean.content = message.content;
    else if (message.content == null) clean.content = null;
    else if (Array.isArray(message.content)) clean.content = message.content;
    else clean.content = String(message.content);

    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      clean.tool_calls = message.tool_calls
        .filter((c) => c?.function?.name)
        .map((c, i) => ({
          id: typeof c.id === 'string' && c.id ? c.id : `call_${i}`,
          type: 'function',
          function: {
            name: String(c.function.name),
            arguments:
              typeof c.function.arguments === 'string'
                ? c.function.arguments
                : JSON.stringify(c.function.arguments ?? {}),
          },
        }));
      if (!clean.tool_calls.length) delete clean.tool_calls;
      if (clean.content === null || clean.content === '') clean.content = null;
    }

    if (message.role === 'tool') {
      clean.tool_call_id = String(message.tool_call_id || '');
      if (!clean.tool_call_id) continue;
      if (typeof clean.content !== 'string') clean.content = String(clean.content ?? '');
    }

    out.push(clean);
  }
  return out;
}

/**
 * Drop orphaned tool results and fill in missing ones so providers that validate
 * strictly (OpenAI, Mistral) accept the history after an interrupted turn.
 */
function repairToolSequences(messages) {
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      out.push(message);
      const expected = message.tool_calls.map((c) => c.id);
      const found = new Map();
      let j = i + 1;
      while (j < messages.length && messages[j].role === 'tool') {
        found.set(messages[j].tool_call_id, messages[j]);
        j++;
      }
      for (const id of expected) {
        out.push(
          found.get(id) || {
            role: 'tool',
            tool_call_id: id,
            content: 'Tool result unavailable (the turn was interrupted).',
          }
        );
      }
      i = j - 1;
      continue;
    }
    if (message.role === 'tool') continue; // orphan, already handled or stray
    out.push(message);
  }
  return out;
}

function truncateForModel(text, max = LIMITS.maxToolOutput) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max * 0.7)}\n\n... [output truncated: ${s.length - max} characters omitted] ...`;
}

function messageSize(message) {
  let size = typeof message.content === 'string' ? message.content.length : 0;
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      size += (call.function?.arguments || '').length + (call.function?.name || '').length + 40;
    }
  }
  return size;
}

/* ------------------------------------------------------------------ *
 * Loop detection
 *
 * Without this, a model that keeps asking for the same tool simply runs until
 * the step cap, burning the user's rate limit and producing nothing. Weaker
 * tool-callers on free tiers do this constantly — re-listing the same
 * directory, re-reading the same file — so the loop is broken here rather
 * than left to the model's judgement.
 * ------------------------------------------------------------------ */

/**
 * Stable signature for a tool call. Keys are sorted so that `{"a":1,"b":2}` and
 * `{"b":2,"a":1}` collide, which is what we want: the model means the same call.
 */
function callSignature(name, args) {
  let body;
  try {
    body = JSON.stringify(args ?? {}, Object.keys(args || {}).sort());
  } catch {
    body = String(args);
  }
  return `${name}(${body})`;
}

/**
 * Turn a raw tool failure into something the model can act on.
 *
 * A bare stack trace or "not found" gives the model nothing to change, so it
 * retries the same call. Every hint here names a different next action.
 */
function suggestRecovery(name, output) {
  const text = String(output || '');
  const rules = [
    [/ENOENT|no such file|not found|does not exist/i,
      'That path does not exist. Confirm it with list_dir or glob_files before reading or writing, and use a path relative to the working directory.'],
    [/EACCES|EPERM|permission denied/i,
      'Permission was denied. Do not retry the same path; choose a location inside the working directory.'],
    [/ambiguous|matches? \d+ (times|locations)|not unique/i,
      'The match was not unique. Read the file and include more surrounding context so the target is unambiguous.'],
    [/no match|not present|could not find the (string|text)/i,
      'The text was not found. Read the file first — the content is probably different from what you assumed.'],
    [/is a directory/i,
      'That is a directory, not a file. Use list_dir.'],
    [/command not found|not recognized as an internal/i,
      'That command is not available on this machine. Check what is installed, or use a different tool.'],
    [/timed out|timeout/i,
      'The command timed out. Narrow it down or give it more time rather than rerunning it unchanged.'],
    [/exit code [1-9]/i,
      'The command ran but failed. Read the output above and fix the cause before running it again.'],
  ];
  for (const [pattern, hint] of rules) {
    if (pattern.test(text)) return `${text}\n\n[Klaud] ${hint}`;
  }
  if (name === 'run_command') {
    return `${text}\n\n[Klaud] Read the output before running this again. If it failed, change the command or fix the cause.`;
  }
  return `${text}\n\n[Klaud] Running this again unchanged will produce the same result. Change the arguments or try another tool.`;
}

/** The nudge injected when the model repeats an entire step. */
function stuckMessage(stepSignature) {
  return [
    'You have issued this exact set of tool calls before in this turn, and re-running them',
    'would return the same output. Stop and reassess instead:',
    '',
    `  ${stepSignature.slice(0, 400)}`,
    '',
    'Say what you have established so far, why the previous attempt did not get you where',
    'you wanted, and what you will do differently. Then make a DIFFERENT call — or, if the',
    'task is complete, reply with no tool call at all to finish the turn.',
  ].join('\n');
}

const WRAP_UP_MESSAGE = [
  'You are nearly out of steps for this turn. Do not start anything new.',
  '',
  'Reply now, with no tool calls, and report: what you changed, how you verified it, and',
  'what is still unfinished. The user can ask you to continue, and your summary is what',
  'they will read to decide whether to.',
].join('\n');

/**
 * One sentence saying what the user is being asked to allow.
 *
 * "Klaud wants to run use_gmail" is not a decision anyone can make; "Klaud wants
 * to send this as you" is. The level comes from the same place the gate used, so
 * the words cannot drift away from what is actually being permitted — and a
 * dialog that describes the wrong effect is worse than no dialog, because it
 * teaches people to approve without reading.
 */
function approvalReason(permission, name, args) {
  if (permission === 'send') {
    const service = name.startsWith('use_') ? name.slice(4) : name;
    const action = args && typeof args.action === 'string' ? args.action.trim() : '';
    return (
      `Klaud wants to send this as you: ${service}${action ? ` · ${action}` : ''}. ` +
      'It leaves this machine, other people will see it, and it cannot be taken back — ' +
      'check the recipient and the content before allowing it.'
    );
  }
  if (permission === 'exec') {
    return 'Klaud wants to run a command on this machine. Check what it does before allowing it.';
  }
  return 'Klaud wants to write to a file in the working directory. Check the path and the content before allowing it.';
}

/**
 * Keep the most recent part of a long conversation so one session cannot grow
 * without bound. Cutting happens at whole user turns only, so an assistant
 * message never loses the tool results that answer it.
 *
 * Returns { messages, dropped }.
 */
function pruneHistory(messages, budgetChars) {
  const budget = Number(budgetChars);
  if (!Number.isFinite(budget) || budget <= 0) return { messages, dropped: 0 };

  const total = messages.reduce((sum, m) => sum + messageSize(m), 0);
  if (total <= budget) return { messages, dropped: 0 };

  // Find the start index of each user turn; these are the only safe cut points.
  const turnStarts = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') turnStarts.push(i);
  });
  if (turnStarts.length <= 1) return { messages, dropped: 0 };

  // Drop whole user turns from the front until the rest fits the budget.
  const sizes = messages.map(messageSize);
  let cut = 0;
  let remaining = total;
  for (let i = 1; i < turnStarts.length && remaining > budget; i++) {
    const start = turnStarts[i];
    for (let j = cut; j < start; j++) remaining -= sizes[j];
    cut = start;
  }

  if (cut === 0) return { messages, dropped: 0 };
  return { messages: messages.slice(cut), dropped: cut };
}

/**
 * Run one user turn to completion.
 *
 * ctx: {
 *   settings, cwd, approvalMode, maxSteps,
 *   onEvent(event),
 *   requestApproval({name, args, permission}) -> Promise<boolean>
 * }
 */
async function runAgentTurn(ctx) {
  const { settings, onEvent, cwd } = ctx;
  const emit = (event) => {
    try {
      onEvent(event);
    } catch { /* a broken client must not kill the turn */ }
  };

  const approvalMode = ctx.approvalMode || settings.approvalMode || 'auto';
  const maxSteps = Math.max(1, Math.min(Number(ctx.maxSteps) || settings.maxSteps || 12, LIMITS.maxAgentSteps));
  const allowTools = ctx.allowTools !== false;

  /* ---- extensions ----
   * Skills, plugins and subagents contribute tools and prompt text. Collected
   * once per turn so a skill added mid-session is picked up on the next message
   * without a restart. Everything here is defensive: a broken plugin manifest
   * must not stop the agent working.
   */
  const extensions = ctx.skipExtensions
    ? { prompt: '', warnings: [], agentDirs: [], agentNames: [] }
    : collectExtensions({ cwd, enabledPlugins: settings.enabledPlugins || {} });
  registerExtensionTools();

  /* The service tools — one per connector — and the three tools that manage the
   * credentials behind them are registered the same way and just as often, so a
   * connector or a fresh authorization that appears while Klaud is running is
   * picked up on the next message. `registerTools` replaces by name, so this is
   * idempotent and costs nothing on a turn that does not use them. */
  registerTools([...authToolDefinitions(), ...listServiceTools()]);

  // A subagent is a turn too, but it does not get the task tool, so delegation
  // can never fan out recursively against the user's key.
  const subagentsAllowed = ctx.allowSubagents !== false;

  let messages = repairToolSequences(sanitizeMessages(ctx.messages));
  // The prompt may arrive either from settings or as the first message of a
  // stored transcript, so find the existing system message rather than assuming
  // there is none. Either way the extension listings are appended to the copy
  // that goes on the wire, leaving the stored history untouched.
  const existingSystem = messages.find((m) => m.role === 'system');
  const augmentedPrompt = augmentSystemPrompt(
    (existingSystem && existingSystem.content) || settings.systemPrompt,
    extensions
  );
  /* The connected-service listing is joined here rather than inside
   * extensions.js. That module is the one place that knows about skills,
   * plugins and subagents, and a connection is none of those three: it is a
   * credential, not an extension. This is the single place that assembles the
   * prompt for a request, so the join is two lines here and no new dependency in
   * a file that three other features already share.
   *
   * `describeConnectionsForPrompt()` resolves to '' unless a service really is
   * connected, so the prompt stays byte-identical for every session that does
   * not use this — nobody pays for the feature in tokens or behaviour. It is
   * asynchronous because the authorization store reads the connection files,
   * which is why the join is awaited here rather than being a plain string. */
  const connectionsBlock = await describeConnectionsForPrompt();
  const systemPrompt = connectionsBlock ? `${augmentedPrompt}\n\n${connectionsBlock}` : augmentedPrompt;
  if (existingSystem) {
    existingSystem.content = systemPrompt;
  } else {
    messages = [{ role: 'system', content: systemPrompt }, ...messages];
  }
  if (extensions.warnings.length) {
    emit({ type: 'notice', level: 'warn', message: extensions.warnings.join(' ') });
  }

  const budget = ctx.maxContextChars ?? settings.maxContextChars;
  const pruned = pruneHistory(messages, budget);
  if (pruned.dropped > 0) {
    messages = pruned.messages;
    emit({
      type: 'notice',
      level: 'info',
      message:
        `Trimmed ${pruned.dropped} older message(s) to stay under the ` +
        `${Math.round(budget / 1000)}k character context budget. The recent turns are intact.`,
    });
  }

  const newMessages = [];
  const record = (message) => {
    messages.push(message);
    newMessages.push(message);
    return message;
  };

  const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const allToolCalls = [];
  let steps = 0;
  let toolsDisabled = !allowTools;
  let finalText = '';
  let degradedReason = '';

  // Loop bookkeeping. `seenCalls` counts identical calls within this turn;
  // `seenSteps` counts identical whole steps. Both reset per turn, because
  // repeating a call in a later turn after new information is legitimate.
  const seenCalls = new Map();
  const seenSteps = new Map();
  let wrapUpSent = false;
  // Only ever ask once for a missing answer, or a silent model becomes a loop.
  let answeredNothing = false;

  // The last step or two exist to let the model write its summary, not to start
  // more work. Telling it that up front produces a real hand-off instead of a
  // conversation that just stops mid-sentence at the cap.
  const wrapUpAfter = Math.max(1, maxSteps - 2);

  while (steps < maxSteps) {
    steps++;
    emit({ type: 'step', index: steps, max: maxSteps });

    if (!toolsDisabled && steps > wrapUpAfter && !wrapUpSent) {
      wrapUpSent = true;
      record({ role: 'system', content: WRAP_UP_MESSAGE });
      emit({
        type: 'notice',
        level: 'info',
        message: 'Near the step limit — asking the model to summarise instead of starting anything new.',
      });
    }

    const requestMessages = messages;
    let result;
    try {
      result = await streamChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        extraHeaders: settings.extraHeaders,
        model: settings.model,
        messages: requestMessages,
        // Not merely refusing the call: the tool is withheld from the schema, so
        // a subagent has no `task` to reach for. Offering a tool only to reject
        // it invites the model to try again a different way, which is the
        // unbounded fan-out this guard exists to prevent.
        tools: toolsDisabled
          ? null
          : toolSchemas().filter((t) => subagentsAllowed || t.function.name !== 'task'),
        temperature: settings.temperature,
        // Forwarded explicitly rather than read from module state inside the
        // client: one request, one set of options, nothing ambient to go stale.
        reasoningEffort: settings.reasoningEffort,
        signal: ctx.signal,
        onEvent: (event) => {
          if (event.type === 'usage') {
            emit({ type: 'usage', usage: event.usage });
          } else {
            emit(event);
          }
        },
      });
    } catch (err) {
      if (ctx.signal?.aborted) {
        emit({ type: 'aborted' });
        return { messages: newMessages, usage: usageTotals, steps, toolCalls: allToolCalls, finished: 'aborted' };
      }
      const isToolRejection =
        allowTools &&
        !toolsDisabled &&
        err instanceof LLMError &&
        [400, 404, 422, 500].includes(err.status) &&
        /tool|function|param|unsupported|schema/i.test(String(err.message) + (err.body || ''));

      if (isToolRejection) {
        toolsDisabled = true;
        steps--;
        degradedReason =
          `${settings.model} rejected the tool definitions, so Klaud continued without them. ` +
          `It can still read and run nothing itself, so expect answers only — no file edits. ` +
          `If you see tool syntax written out as text, that is the model trying anyway and being ignored. ` +
          `Pick a tool-capable model to get the agent back.`;
        emit({ type: 'notice', level: 'warn', message: degradedReason });
        continue;
      }
      emit({ type: 'error', message: err instanceof LLMError ? err.message : String(err?.message || err) });
      return {
        messages: newMessages,
        usage: usageTotals,
        steps,
        toolCalls: allToolCalls,
        finished: 'error',
      };
    }

    if (result.usage) {
      usageTotals.prompt_tokens += result.usage.prompt_tokens || 0;
      usageTotals.completion_tokens += result.usage.completion_tokens || 0;
      usageTotals.total_tokens += result.usage.total_tokens || 0;
    }

    const assistantMessage = {
      role: 'assistant',
      content: result.text || '',
    };
    if (result.reasoning) assistantMessage.reasoning = result.reasoning;
    if (result.toolCalls.length) {
      assistantMessage.tool_calls = result.toolCalls;
    }
    record(assistantMessage);
    if (result.text) finalText = result.text;

    if (!result.toolCalls.length) {
      if (result.finishReason === 'length') {
        emit({
          type: 'notice',
          level: 'warn',
          message: 'The model hit its output token limit, so the reply may be cut short.',
        });
      } else if (result.finishReason === 'content_filter') {
        emit({ type: 'notice', level: 'warn', message: 'The provider filtered this response.' });
      }

      // The model stopped without saying anything, after doing real work. Some
      // tool-calling models do this: they treat the final tool result as the
      // answer and end the turn. The user is then left with an empty reply and
      // no idea whether the task succeeded, so ask once, explicitly, for prose.
      const worked = steps > 1 || allToolCalls.length > 0;
      const said = String(result.text || '').trim();
      if (!said && worked && !answeredNothing) {
        answeredNothing = true;
        messages.push({
          role: 'system',
          content:
            'You ended the turn without writing anything, so the user has no answer to read. ' +
            'Write your reply now in plain text: what you did, what you found, and anything you ' +
            'could not complete. Do not call any tools.',
        });
        emit({
          type: 'notice',
          level: 'info',
          message: 'The model finished without an answer, so Klaud asked it to write one.',
        });
        continue;
      }
      if (!said && worked) {
        emit({
          type: 'notice',
          level: 'warn',
          message:
            'The model stopped twice without producing a reply. The tool results above are real — ' +
            'it just did not summarise them. Ask it to explain what it did if you need the summary.',
        });
      }

      emit({ type: 'done', finished: 'stop', steps, usage: usageTotals });
      return {
        messages: newMessages,
        usage: usageTotals,
        steps,
        toolCalls: allToolCalls,
        finished: 'stop',
        finalText,
      };
    }

    // Execute the requested tools, in order.
    const stepParts = [];
    let repeatedStep = null;
    let loopBroken = false;

    for (const call of result.toolCalls) {
      const name = call.function.name;
      const rawArgs = call.function.arguments;
      const args = parseToolArguments(rawArgs);
      const argsReady = !(args && args.__parse_error);
      const signature = argsReady ? callSignature(name, args) : `unparsed:${name}`;
      stepParts.push(signature);
      const priorCount = seenCalls.get(signature) || 0;
      seenCalls.set(signature, priorCount + 1);

      emit({
        type: 'tool_call',
        id: call.id,
        name,
        args,
        raw: typeof rawArgs === 'string' ? rawArgs.slice(0, 4_000) : JSON.stringify(rawArgs ?? {}),
      });

      if (args && args.__parse_error) {
        // Seen in practice: a model that cannot emit valid tool JSON answers in
        // prose instead, and at least one writes a <tool_call> block as text.
        // Saying so is more useful than only complaining about the JSON.
        const message = suggestRecovery(
          name,
          `Could not parse the arguments for ${name} as JSON. Received: ${String(args.raw).slice(0, 500)}` +
            `\n\nIf you cannot call tools, reply in plain text with what you need and Klaud will pass it on.` +
            ` Do not write tool syntax as prose — it will not be executed.`
        );
        emit({ type: 'tool_result', id: call.id, name, ok: false, output: message, durationMs: 0, loop: false });
        record({ role: 'tool', tool_call_id: call.id, content: message });
        allToolCalls.push({ id: call.id, name, ok: false, args });
        continue;
      }

      // Identical call already made this turn. The first repeat is answered with
      // a warning and the earlier result, which is cheap and often enough; the
      // second is refused outright, because by then the model is not reading.
      if (priorCount >= 1) {
        const repeated = priorCount >= 2;
        const message = repeated
          ? [
              `Refused: you have already called ${name} with these exact arguments`,
              `${priorCount} times this turn, and the result will not change.`,
              '',
              'Stop and reassess. Reply with no tool call, stating what you have established',
              'and what is blocking you, or make a genuinely different call.',
            ].join(' ')
          : [
              `Note: this is an identical repeat of a call you already made this turn, so the`,
              `result is unchanged. Do not call it a third time.`,
              '',
              'If you were checking whether something changed, it has not — you have not run',
              'anything since. Choose a different step or finish the turn with a summary.',
            ].join('\n');

        emit({
          type: 'tool_result',
          id: call.id,
          name,
          ok: false,
          output: message,
          durationMs: 0,
          loop: true,
          repeated,
        });
        emit({ type: 'loop', name, repeats: priorCount, blocked: repeated, args });
        record({ role: 'tool', tool_call_id: call.id, content: message });
        allToolCalls.push({ id: call.id, name, ok: false, loop: true, args });
        continue;
      }

      /* What the user is being asked to allow.
       *
       * Read from the tool's own permission rather than from a list of names.
       * The hardcoded list was the hole: it knew only about local effects, so an
       * action that leaves the machine — one that goes out as the user, is seen
       * by other people and cannot be taken back — reached a third party with no
       * prompt at all in "ask" mode. `read` still never asks; `write`, `exec` and
       * `send` all do, and `send` is resolved per call, because one service tool
       * spans all three levels. */
      const permission = permissionForCall(name, args);
      const needsApproval =
        approvalMode === 'ask' && (permission === 'write' || permission === 'exec' || permission === 'send');

      if (needsApproval && typeof ctx.requestApproval === 'function') {
        const reason = approvalReason(permission, name, args);
        /* The dialog the client renders names the tool and shows its arguments,
         * which for a service call reads "Klaud wants to run use_gmail" — the
         * wrong sentence for an email that goes out as the user. `send` is the
         * level where believing the wrong sentence costs the most, so the reason
         * is also emitted as a notice, which the transcript does render, and it
         * travels in the approval request for a dialog that shows it. */
        if (permission === 'send') emit({ type: 'notice', level: 'warn', message: reason });

        let approved = false;
        try {
          approved = await ctx.requestApproval({ id: call.id, name, args, permission, reason });
        } catch {
          approved = false;
        }
        if (!approved) {
          const message =
            permission === 'send'
              ? `The user denied permission for ${name} to act on their behalf. Nothing was sent; do not retry it, and ask what they would prefer instead.`
              : `The user denied permission to run ${name}. Do not retry it; ask what they would prefer instead.`;
          emit({ type: 'tool_result', id: call.id, name, ok: false, output: message, durationMs: 0, denied: true });
          emit({ type: 'approval_denied', id: call.id, name });
          record({ role: 'tool', tool_call_id: call.id, content: message });
          allToolCalls.push({ id: call.id, name, ok: false, denied: true, args });
          continue;
        }
      }

      emit({ type: 'tool_start', id: call.id, name, args });

      const outcome = await executeTool(name, args, {
        cwd,
        approvalMode,
        onTodos: (todos) => emit({ type: 'todos', todos }),
        // The `task` tool does not run anything itself; it calls back into here
        // so a subagent is just another turn with its own context. Absent when
        // subagents are not allowed, which is how the tool refuses politely
        // instead of failing the step.
        runSubagent: subagentsAllowed
          ? (request) =>
              runSubagent({
                ...request,
                settings,
                cwd,
                approvalMode,
                signal: ctx.signal,
                agentDirs: extensions.agentDirs,
                /* Forwarded, not dropped. Without this a subagent's own writes
                 * and commands bypassed the "Ask first" setting entirely: the
                 * user approved the delegation, and the nested turn then did as
                 * it liked. runSubagent namespaces the approval id per
                 * delegation so nested ids cannot collide with this turn's. */
                requestApproval: ctx.requestApproval,
                onEvent: emit,
              })
          : undefined,
      });

      // A failure with no guidance is what makes a model retry the same call, so
      // every failed tool result carries a concrete alternative.
      const rawOutput = outcome.ok ? outcome.output : suggestRecovery(name, outcome.output);
      const content = truncateForModel(rawOutput);
      emit({
        type: 'tool_result',
        id: call.id,
        name,
        ok: outcome.ok,
        output: content.slice(0, LIMITS.maxToolOutputToClient),
        durationMs: outcome.durationMs,
      });

      record({ role: 'tool', tool_call_id: call.id, content });
      allToolCalls.push({ id: call.id, name, ok: outcome.ok, args, durationMs: outcome.durationMs });
    }

    // Did the model ask for exactly the same set of calls as some earlier step?
    // That is a stuck loop regardless of how the individual calls are counted.
    const stepSignature = stepParts.join(' | ');
    if (stepSignature && stepParts.length) {
      const before = seenSteps.get(stepSignature) || 0;
      seenSteps.set(stepSignature, before + 1);
      if (before >= 1) repeatedStep = stepSignature;
    }

    if (repeatedStep) {
      emit({
        type: 'notice',
        level: 'warn',
        message:
          'The model repeated an identical step, so Klaud stopped the loop. It will summarise what it has instead.',
      });
      // Every tool call must be answered or the next request is malformed. Calls
      // that already produced a result keep it; only the unanswered ones get a
      // placeholder, and the conversation stays valid for strict providers.
      const answered = new Set(
        messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)
      );
      for (const call of result.toolCalls) {
        if (answered.has(call.id)) continue;
        record({
          role: 'tool',
          tool_call_id: call.id,
          content: 'Not executed: the previous identical step already answered this.',
        });
      }
      record({
        role: 'system',
        content:
          'The loop was detected and stopped. Write your final answer now, with no tool calls.',
      });
      loopBroken = true;
    }

    if (ctx.signal?.aborted) {
      emit({ type: 'aborted' });
      return { messages: newMessages, usage: usageTotals, steps, toolCalls: allToolCalls, finished: 'aborted' };
    }

    // Loop broken: give the model one final request with tools withheld so it
    // has to write prose, then end the turn.
    if (loopBroken) {
      steps++;
      let closing = null;
      try {
        closing = await streamChat({
          baseUrl: settings.baseUrl,
          apiKey: settings.apiKey,
          extraHeaders: settings.extraHeaders,
          model: settings.model,
          messages,
          tools: null,
          temperature: settings.temperature,
          reasoningEffort: settings.reasoningEffort,
          signal: ctx.signal,
          onEvent: (event) => {
            if (event.type === 'usage') emit({ type: 'usage', usage: event.usage });
            else emit(event);
          },
        });
      } catch (err) {
        emit({ type: 'error', message: err instanceof LLMError ? err.message : String(err?.message || err) });
      }

      if (closing) {
        if (closing.usage) {
          usageTotals.prompt_tokens += closing.usage.prompt_tokens || 0;
          usageTotals.completion_tokens += closing.usage.completion_tokens || 0;
          usageTotals.total_tokens += closing.usage.total_tokens || 0;
        }
        record({ role: 'assistant', content: closing.text || '' });
        if (closing.text) finalText = closing.text;
      }

      emit({ type: 'done', finished: 'loop_broken', steps, usage: usageTotals });
      return {
        messages: newMessages,
        usage: usageTotals,
        steps,
        toolCalls: allToolCalls,
        finished: 'loop_broken',
        finalText,
      };
    }
  }

  const notice = `Reached the ${maxSteps}-step limit for one turn. Ask me to continue if there is more to do.`;
  emit({ type: 'notice', level: 'warn', message: notice });
  emit({ type: 'done', finished: 'max_steps', steps, usage: usageTotals });
  return {
    messages: newMessages,
    usage: usageTotals,
    steps,
    toolCalls: allToolCalls,
    finished: 'max_steps',
    finalText,
  };
}

module.exports = {
  runAgentTurn,
  sanitizeMessages,
  repairToolSequences,
  pruneHistory,
  callSignature,
  suggestRecovery,
  stuckMessage,
  runSubagent,
};
