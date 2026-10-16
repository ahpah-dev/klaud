'use strict';

/**
 * The agent loop: model -> tool calls -> tool results -> model, until the model
 * answers without asking for another tool.
 */

const path = require('path');
const { streamChat, LLMError, parseToolArguments } = require('./llm');
const { toolSchemas, executeTool } = require('./lib/tools');
const { LIMITS } = require('./config');

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

  let messages = repairToolSequences(sanitizeMessages(ctx.messages));
  if (!messages.some((m) => m.role === 'system')) {
    messages = [{ role: 'system', content: settings.systemPrompt }, ...messages];
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

  while (steps < maxSteps) {
    steps++;
    emit({ type: 'step', index: steps, max: maxSteps });

    const requestMessages = messages;
    let result;
    try {
      result = await streamChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        extraHeaders: settings.extraHeaders,
        model: settings.model,
        messages: requestMessages,
        tools: toolsDisabled ? null : toolSchemas(),
        temperature: settings.temperature,
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
          'Pick a tool-capable model (for example a GPT, Claude, Gemini, Qwen-Coder or Llama 3.1+ model) to let the agent edit files.';
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
      emit({ type: 'done', finished: 'stop', steps, usage: usageTotals });
      return {
        messages: newMessages,
        usage: usageTotals,
        steps,
        toolCalls: allToolCalls,
        finished: 'stop',
      };
    }

    // Execute the requested tools, in order.
    for (const call of result.toolCalls) {
      const name = call.function.name;
      const rawArgs = call.function.arguments;
      const args = parseToolArguments(rawArgs);

      emit({
        type: 'tool_call',
        id: call.id,
        name,
        args,
        raw: typeof rawArgs === 'string' ? rawArgs.slice(0, 4_000) : JSON.stringify(rawArgs ?? {}),
      });

      if (args && args.__parse_error) {
        const message =
          `Error: could not parse the arguments for ${name} as JSON. ` +
          `Re-send the call with valid JSON. Received: ${String(args.raw).slice(0, 500)}`;
        emit({ type: 'tool_result', id: call.id, name, ok: false, output: message, durationMs: 0 });
        record({ role: 'tool', tool_call_id: call.id, content: message });
        allToolCalls.push({ id: call.id, name, ok: false, args });
        continue;
      }

      const needsApproval =
        approvalMode === 'ask' && (name === 'run_command' || name === 'write_file' || name === 'edit_file');

      if (needsApproval && typeof ctx.requestApproval === 'function') {
        let approved = false;
        try {
          approved = await ctx.requestApproval({ id: call.id, name, args, permission: 'write' });
        } catch {
          approved = false;
        }
        if (!approved) {
          const message = `The user denied permission to run ${name}. Do not retry it; ask what they would prefer instead.`;
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
      });

      const content = truncateForModel(outcome.output);
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

    if (ctx.signal?.aborted) {
      emit({ type: 'aborted' });
      return { messages: newMessages, usage: usageTotals, steps, toolCalls: allToolCalls, finished: 'aborted' };
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

module.exports = { runAgentTurn, sanitizeMessages, repairToolSequences, pruneHistory };
