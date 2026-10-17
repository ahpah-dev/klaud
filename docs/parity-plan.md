# Claude Code parity: assessment and implementation plan

Scope: **backend agent only** — no UI/UX work. Target: functional parity with Claude
Code's core agentic architecture, in Klaud's zero-dependency Node model.

In scope: hooks, scheduled tasks, goals, checkpoints, subagents, plugin system, skills,
MCP, background tasks.
Out of scope, by instruction: worktrees, agent teams, cross-session messaging, dynamic
workflows.

Method: every semantic claim below is drawn from Anthropic's own documentation, fetched
and cached under `_research/` (`hooks.md`, `mcp.md`, `goals-checkpoints.md`,
`tasks-and-extensions.md`, with raw sources in `_research/_src/`). Klaud's current
behaviour was read out of its own source, not recalled.

---

## 1. Two corrections to the brief

The brief carried two premises that the documentation does not support. Both change what
gets built, so they come first.

**Goals are not a tool surface.** The brief asked about a minimum-rounds gate on
"blocked". There is no goal tool at all — `tools-reference` enumerates every built-in
tool and the word "goal" never appears. `/goal` is a **slash command wrapping a
session-scoped, prompt-based Stop hook**. The *human* owns the lifecycle; the model
cannot set, read or clear a goal. There is also **no "blocked" state**: the three
verdicts are *not yet met*, *met*, and *impossible*. The nearest thing to a guard is a
no-progress circuit breaker inherited from the Stop-hook block cap — **8 consecutive
blocks with no tool call** — and the goal survives it.

**Checkpoints are not a shadow git repository.** No fetched page mentions git as the
checkpoint mechanism. The documented store is `~/.claude/file-history/<session>/`,
holding **pre-edit snapshots of files altered by Write/Edit/NotebookEdit**, plus state in
the transcript. Crucially, the restore point is *not* an edit: it is **each prompt that
started a turn**. So "copy the file before writing" is **not** equivalent — it gets the
bytes right but the wrong granularity, and it would wrongly capture Bash-modified files
(`rm`, `mv`, `cp`, `sed -i` are deliberately untracked).

Both corrections make the work *smaller* and more precisely specified than the brief
implied.

---

## 2. Klaud today: the seams that matter

Klaud is ~11,500 lines of source and ~11,900 lines of tests, 19 suites, 1750 checks. It
already has five seams that make most of this tractable, and they should be extended
rather than duplicated:

| Seam | Where | What it already does |
| --- | --- | --- |
| **Tool registry** | `src/lib/tools.js` → `registerTools()` | Any module can contribute tool definitions; built-ins cannot be shadowed. Already carries MCP, skills, subagents, auth tools. |
| **Event stream** | `src/agent.js` → `emit()` | 11 distinct event types emitted by the loop itself (`step`, `tool_start`, `tool_result`, `todos`, `notice`, `loop`, `usage`, `done`, `error`, `aborted`, `approval_denied`) plus 6 forwarded from the LLM client (`text`, `reasoning`, `usage`, `finish`, `notice`, `function`). The natural dispatch point for hooks. |
| **Permission resolver** | `src/lib/tools.js` → `permissionForCall()` | Per-call permission including the `send` level. Hooks and background need to consult it. |
| **Prompt augmentation** | `src/extensions.js` → `augmentSystemPrompt()` | One place that assembles skills/plugins/subagents/connections text; byte-identical prompt when nothing is installed. |
| **Extension collector** | `src/extensions.js` → `collectExtensions()` | One place that resolves skills, plugins, agents and their warnings per turn. |

---

## 3. Verdict

| Feature | Verdict | Scale |
| --- | --- | --- |
| **Hooks** | **BUILD** — nothing exists | Large |
| **MCP** | **BUILD** — nothing exists | Large |
| **Checkpoints** | **BUILD** — nothing exists | Medium |
| **Background tasks** | **BUILD** — `run_command` is synchronous only | Medium |
| **Scheduled tasks** | **BUILD** — nothing exists | Medium |
| **Goals** | **BUILD** — nothing exists | Small–medium |
| **Subagents** | **EXTEND** — core exists, 4 of 21 fields supported | Medium |
| **Skills** | **EXTEND** — 6 frontmatter fields, no execution control | Small |
| **Plugins** | **EXTEND** — commands collected but dead; no hooks/MCP | Small (blocked on hooks + MCP) |
| **Browser** | **SHIPPED** — added after this assessment; see §4.10 | Medium |

---

## 4. Per-feature assessment

### 4.1 Hooks — BUILD

Nothing in Klaud dispatches lifecycle events to user code. The only mentions of "hooks"
in the sourcebase are `plugins.js` **warning that it does not implement them**.

Claude Code has **33 events**. Klaud has no equivalent for 11 of them by construction
(worktrees, teammates, elicitation, model switch, message display, `@`-reference
loading), so a faithful subset is ~15–18 events. The ones that map cleanly onto Klaud's
existing loop: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStart`, `SubagentStop`,
`PreCompact`, `Notification`, `TaskCreated`, `TaskCompleted`, `FileChanged`,
`PermissionRequest`, `PermissionDenied`.

Semantics that a naive implementation gets wrong, and which the plan must pin with tests:

- **Hooks fail open.** Any exit other than 0 or 2, a timeout, a crash, or malformed JSON
  is a *non-blocking* error and the action proceeds. A mistyped script path silently
  disables a policy hook. `"onFailure": "block"` is the opt-in.
- **Decision fields are event-specific and misplacement is silent.** `PreToolUse` uses
  `hookSpecificOutput.permissionDecision` (`allow`/`deny`/`ask`/`defer`), *not* top-level
  `decision`. `PermissionRequest` uses `hookSpecificOutput.decision.behavior` and
  **ignores exit 2 entirely**. Top-level `decision:"block"` belongs to `Stop`,
  `UserPromptSubmit`, `PostToolUse` and a handful of others.
- **Matcher dispatch is character-class driven.** Only `[A-Za-z0-9_\- ,|]` gives
  exact-string matching; anything else is an *unanchored* regex. So `mcp__memory` matches
  nothing (it needs `mcp__memory__.*`) and `Edit.*` also matches `NotebookEdit`.
- **stdout must be only the JSON object.** A shell banner breaks parsing, and because the
  hook exited 0 the transcript shows no error at all.
- **Hooks merge across levels, never shadow.** Identical handlers run once; plugin and
  skill copies are separate.
- **Parallel, non-short-circuiting.** All matching hooks run; results merge afterwards; a
  `deny` in one does not stop siblings. Precedence `deny > defer > ask > allow`.
- **Timeout is not a gate** (except `PreModelSwitch`, which Klaud has no equivalent of).
- **Output caps at 10,000 characters** per string, replaced by a file path plus preview.

Two hook types are worth having beyond `command`: `prompt` (a model call returning
`{ok, reason, impossible}`) because goals are built on it, and `http`. The `agent` type is
a subagent invocation — Klaud has `runSubagent` already.

**The security decision this forces.** Command hooks are arbitrary code execution with
the user's full permissions, and Anthropic's own docs flag the asymmetry: interactive
sessions hold hooks back until you trust the folder, but `-p`/SDK sessions treat every
folder as trusted, so **a cloned repo's committed hooks run silently**. Klaud has no
workspace-trust concept *and* is a long-running server, which is strictly worse: a project
`.klaud/settings.json` would execute on server start. This needs a decision (§8).

### 4.2 MCP — BUILD

Nothing exists. Zero-dependency implementation is entirely feasible:

- **stdio framing is newline-delimited JSON**, not `Content-Length`. LSP-style framing
  appears in **no** published revision (checked 2024-11-05, 2025-11-25, 2026-07-28). Node's
  `readline` over `child.stdout` plus `JSON.stringify` (which escapes embedded newlines)
  is sufficient. This is the single most useful finding for Klaud — the thing most
  implementations reach for first is not in the spec.
- **Two eras.** Legacy (≤2025-11-25, which nearly every deployed server speaks):
  `initialize` request → result → **`notifications/initialized`** (the prefix is on the
  notification) → operation. A version mismatch is a **successful result** carrying the
  server's version, not an error. Modern (2026-07-28) removes the handshake for per-request
  `_meta`, and adds `server/discover` as the era probe.
  **Plan: implement legacy, detect modern via `server/discover`.** Legacy is what servers
  actually speak today.
- **`isError: true` lives inside a successful `tools/call` result.** A failed tool is a
  JSON-RPC *success*. Getting this wrong destroys the model's self-correction signal —
  exactly the failure mode Klaud already fixed once in its own tool layer.
- **Namespacing:** `mcp__<server>__<tool>`; plugin servers
  `mcp__plugin_<plugin>_<server>__<tool>`, all other characters replaced with `_`. Server
  names are only unique per server and `serverInfo.name` is explicitly not a
  disambiguation key.
- Transports: stdio and Streamable HTTP (one POST endpoint, `Accept: application/json,
  text/event-stream`). HTTP+SSE is deprecated. WebSocket is Claude-Code-only, not a spec
  transport — skip it.
- Config: `.mcp.json` = `{"mcpServers":{...}}`, `type` ∈ stdio (default when absent) /
  http / sse / ws. Scopes do **not** merge: local > project > user.
- Resources and prompts are lower value for Klaud: resources map to a read tool, prompts
  map onto the existing slash-command path (`/mcp__server__prompt`).

### 4.3 Checkpoints — BUILD

Klaud's `write_file` and `edit_file` **already read the previous file content** to produce
the diff shown in the tool card. That is the exact seam — the bytes are already in hand.

What must be built:

- Snapshot store: `~/.klaud/file-history/<chatId>/<n>/<relative-path>`.
- An index of checkpoints recorded in the chat record, each anchored to **the prompt that
  started the turn** — not to an edit.
- Deliberate exclusions to match the reference: **no** snapshot for files changed by
  `run_command`, no capture of external edits.
- Retention: 100 most recent per session, and each file's **first** snapshot always kept.
- Rewind offers **six** actions: restore code+conversation, conversation only, code only,
  Summarize from here, Summarize up to here, never mind.
- Symlinked/hard-linked paths are **skipped** with a `Restored the code, but skipped N
  files` warning rather than written through.
- `cleanupPeriodDays` retention sweep (default 30, **minimum 1, `0` is rejected**).

**Gap that surfaced on the way:** Klaud has no compaction to hook into. `pruneHistory()`
drops whole user turns by character budget — it is **lossy truncation, not
summarisation**. Claude Code's `PreCompact`/`PostCompact` and the "Summarize from here"
rewind actions both assume a real summary exists. Either Klaud gains summarising
compaction, or those two rewind actions are honestly omitted. This is a decision (§8).

### 4.4 Background tasks — BUILD

`run_command` spawns, buffers stdout/stderr into memory, and waits. It already has
`killTree`, a timeout, and `detached: process.platform !== 'win32'`. What is missing is
everything that makes a task outlive the call:

- `run_in_background: true` on the command tool; output streamed to a **file**, with the
  task id and that path returned in the tool result.
- A task registry with unique ids, listable and killable.
- **No `TaskOutput` tool.** Claude Code removed it in v2.1.277; the model reads the output
  *file*. Klaud already has `read_file`, so the same pattern drops straight in.
- Lifecycle rules worth copying: background work is **cleaned up when the process exits**;
  time limits are 30 min default (max 2 h) and only apply to unattended runs.
- Completion of a background task must be able to **start a turn** to deliver its result —
  see §5.
- Background *subagents* are a separate axis: Klaud's `task` tool is foreground-only
  today.

### 4.5 Scheduled tasks — BUILD

The brief's premise ("scheduled tasks") is three different features. The one worth
building is the **CLI/session one**: `/loop` plus the model-facing `CronCreate` /
`CronList` / `CronDelete` tools. Desktop scheduled tasks and cloud Routines both require
infrastructure Klaud does not have (a GUI scheduler, a cloud backend) and are out of
reach.

Precise semantics to implement:

- 5-field cron, vixie semantics; wildcards, values, `*/n` steps, ranges, lists. **No**
  `L`, `W`, `?` or name aliases. `0` or `7` = Sunday. When both day-of-month and
  day-of-week are constrained, a date matches if **either** matches.
- Minimum interval 1 minute; **seconds round up to the nearest minute**; `7m`/`90m` are
  rounded to the nearest representable interval and the choice is reported.
- Scheduler ticks every second and fires **between turns only** — never mid-response,
  with **no catch-up**: a task missed while busy fires *once* on idle, not once per
  interval.
- All times local; 8-character task ids; **50 tasks per session**; recurring tasks
  **expire after 7 days**, firing once more then deleting themselves.
- Deterministic jitter (recurring runs drift late by up to half the gap, capped 30 min).
  Worth implementing for cache behaviour, but it is cosmetic for Klaud and can be phase 2
  of this feature.
- `loop.md` lookup: `.claude/loop.md` then `~/.claude/loop.md`, 25,000-byte truncation.

Klaud-specific wrinkle: Claude Code is a CLI session with a beginning and an end. Klaud
is a **long-running server**, so "session-scoped" needs a definition, and the server
surviving a restart changes what "expires in 7 days" means.

### 4.6 Goals — BUILD (smaller than it looked)

Not a tool surface. The mechanism is: a condition (≤4,000 chars) → after every turn, a
**separate evaluator model** returns one of three verdicts → *not yet met* starts another
turn with the reason as guidance; *met* clears and records achieved; *impossible* clears
and records failed.

Precise semantics that matter:

- **The evaluator cannot run tools or read files.** It judges only what was surfaced in
  the conversation. Giving it file access would be a different, stronger feature — a real
  risk of over-building.
- **No runtime turn cap.** The only user-settable bound is a clause written into the
  condition ("or stop after 20 turns"), judged by the evaluator from the conversation.
- **No-progress guard** = 8 consecutive evaluator blocks with no tool call; the goal
  survives and control returns to the user.
- **Error classification:** exactly four failures (auth failure, exhausted credit, context
  overflow, unavailable model) **clear** the goal with `Goal cleared after an
  unrecoverable error … Run /goal again to continue`. Everything else retries — three
  automatic retries, then pause.
- **One goal per session**; setting a new one replaces it; setting a goal starts a turn
  immediately with the condition as the directive.
- **Background work defers evaluation**: if a subagent or background command is still
  running when a turn ends, that turn is not evaluated. Check-ins start at 30 min and back
  off to 1 h then every 2 h.

For Klaud, the evaluator is one extra `streamChat` call with a small JSON-returning
prompt. The honest caveat is that Claude Code picks a "small/fast" model and **Klaud runs
whichever OpenAI-compatible model the user configured** — possibly a slow free tier. The
evaluator should be configurable and default to the session model, with the cost stated.

### 4.7 Subagents — EXTEND

**Already have:** `name`, `description`, `tools`, `model`; personal/project/plugin
directories; project-shadows-personal; nearest-name suggestions; the `task` tool with a
name enum; **approval forwarding with per-delegation id namespacing**; recursion blocked by
removing `task` from the child's schema.

**Missing, in rough value order:**

| Gap | Notes |
| --- | --- |
| Only 4 of 21 frontmatter fields | `disallowedTools`, `permissionMode`, `maxTurns`, `skills` (preload), `mcpServers`, `hooks`, `memory`, `background`, `effort`, `color`, `initialPrompt` |
| `disallowedTools` semantics | A specifier entry like `Bash(git push *)` removes the **whole tool**; `disallowedTools` beats `tools` |
| Nesting depth | Klaud hard-stops at 1 level; Claude Code defaults to **3**, and **withholds the `Agent` tool** at the limit |
| Concurrency cap | 20 running subagents; resume takes a fresh slot without checking |
| Subagent transcripts | `subagents/agent-<id>.jsonl`, independent of main-conversation compaction |
| Resume | `SendMessage` by agent id or name |
| A zero-tool guard | If no entry resolves, Claude Code errors instead of launching |
| Silently-skipped files | No `name`, or `---` not on line 1, are skipped **silently** |

One deliberate difference to keep: Klaud's hard 1-level limit is *safer* than 3 and was a
deliberate anti-fan-out decision. Raising it should be opt-in, not a default.

### 4.8 Skills — EXTEND

**Already have:** `name`, `description`, `when_to_use`, `disable-model-invocation`,
`allowed-tools`, `metadata`; personal/project dirs with shadowing; `/name` expansion
server-side; typo suggestions; the untrusted-content wrapper.

**Missing:**

| Gap | Notes |
| --- | --- |
| `context: fork` | Runs the skill in a subagent. **Not** a conversation fork — the docs say so explicitly — and it **defaults to the background** with a narrower tool set |
| `agent:` | Which subagent type runs a forked skill |
| `model:`, `hooks:`, `once`, `paths`, `argument-hint` | `once: true` removes the hook after one success, and is honoured **only** in skill frontmatter |
| `allowed-tools` is recorded but **not enforced** | Claude Code enforces it. Klaud documents the gap honestly today |
| Slash-command expansion coverage | Claude Code fires `UserPromptExpansion` for the `/skillname` path that `PreToolUse` misses |

### 4.9 Plugins — EXTEND

**Already have:** manifest with metadata, optional manifest, `skills`/`commands`/`agents`
discovery, path overrides, `defaultEnabled`, `dependencies` as warnings, path containment
against `../`/absolute/symlink escape, and explicit warnings for unimplemented components.

**Two real gaps:**

1. **`commands/` is collected and never consumed.** `pluginSources()` returns
   `commandFiles`, and nothing reads it. A plugin can ship commands today and they do
   nothing, silently. This is a live bug, not just a gap.
2. **`hooks` and `mcpServers` are reported as unimplemented** — correct today, unblocked by
   §4.1 and §4.2. Plugin hooks live in `hooks/hooks.json` under a top-level `hooks` key in
   the **same shape as settings**, differing only in plugin env vars, the full
   `mcp__plugin_<plugin>_<server>__<tool>` matcher requirement, and a rule that two enabled
   plugins sharing a manifest name means only one registers hooks.

Also worth copying: **plugin subagents silently ignore `hooks`, `mcpServers`,
`permissionMode` and `initialPrompt`** — deliberately, for security. Klaud should match
that and say so in the warning, rather than quietly honouring them.

### 4.10 Browser — SHIPPED

Not in the original nine. Added because Cowork could edit files and read URLs but could
not use the web the way a person does.

**Transport: the DevTools protocol over a pipe, not a port.** Both obvious options cost
something Klaud will not pay — Puppeteer is a dependency, and `--remote-debugging-port`
speaks WebSocket, which Node only grew in 21 while Klaud declares 18. Chrome's
`--remote-debugging-pipe` reads commands from **fd 3** and writes replies to **fd 4**,
NUL-delimited JSON, which `child_process.spawn` can hand over directly. The whole
transport is `JSON.parse`, `JSON.stringify` and a scan for NUL. A side benefit: no TCP
port exists to be reached by anything else on the machine.

| Tool | Permission |
| --- | --- |
| `browser_goto`, `browser_read`, `browser_screenshot`, `browser_close` | read |
| `browser_click`, `browser_type` | write |
| `browser_eval` | exec |

**Three details that decide whether real sites work:**

1. **Input goes through CDP, not the DOM.** `element.click()` and `element.value = x` are
   invisible to React and Vue, so the model concludes the page is broken. Clicks are
   dispatched as `Input.dispatchMouseEvent` at the element centre; typing uses
   `Input.insertText` on the focused element.
2. **Enter needs `text: '\r'`.** A `keyDown`/`keyUp` pair without it types the value into
   the field and never fires submit — found by test, not by reading.
3. **`Runtime.evaluate` runs a classic script.** A bare `await` (the natural way to wait
   for a page) is a syntax error there, so the raw expression is tried first and re-wrapped
   in an async function only when it fails to *parse* — never on a runtime error.

**Boundaries held:** `file://` is refused, because a browser pointed at it would read any
file on the machine and hand it back as page text, defeating the working-directory
confinement every other tool observes. Screenshots are written inside the working
directory through the same containment check as everything else. The profile is
throwaway and removed on close, so no cookies of the user's are ever at risk.

**The honest limitation: Klaud cannot see.** Screenshots exist for the user and the
transcript; the model's only view of a page is `browser_read`. A page that renders to a
canvas is invisible to it. Sending the PNG to a vision model is a separate change to
`llm.js` (message content arrays) and is not done.

---

## 5. The one architectural prerequisite

**Klaud has no way to start a turn except an HTTP request.**

`runAgentTurn` is called from exactly two places: `POST /api/chat` — inline in the route
handler, writing directly to the response object — and `runSubagent`. There is no
reusable turn-initiator, no session object, and no notion of a turn that nobody asked for.

Three of the nine features need exactly that:

- **Goals** start a turn when the evaluator says "not yet met".
- **Scheduled tasks** start a turn when a cron expression comes due.
- **Background tasks** start a turn to deliver a completed result.

So Phase 0 is a small, unglamorous refactor that everything else depends on:

1. Extract a `startTurn({ chatId, prompt, source, onEvent })` that owns the SSE fan-out
   and can be driven by the HTTP route *or* by a scheduler *or* by a completion callback.
2. Introduce an explicit turn-source (`user` / `goal` / `schedule` / `background`) that
   flows into hooks and into the transcript, so a reader can tell why a turn happened.
3. Add a per-chat session object the scheduler and goal loop can hold.

This is the single highest-leverage item in the plan and should not be deferred.

---

## 6. Phased plan

Sizing is relative (S/M/L), not calendar — I have not measured this team's throughput.

| Phase | Work | Depends on | Size |
| --- | --- | --- | --- |
| **0** | Turn initiator + turn-source + session object (§5) | — | S–M |
| **1** | **Hooks**: config load/merge, matcher dispatch, command + prompt + http handler types, exit-code and JSON contract, fail-open, timeouts, parallel merge, 15–18 mapped events | 0 | L |
| **2** | **MCP**: JSON-RPC, stdio + Streamable HTTP transports, legacy `initialize`, `tools/list` + `tools/call`, `mcp__` namespacing, config scopes, lifecycle/shutdown | — | L |
| **3** | **Checkpoints**: snapshot store, per-turn anchoring, rewind actions, retention, symlink skip | 0 | M |
| **4** | **Background tasks**: `run_in_background`, output files, registry, list/kill, completion-triggered turns, time limits | 0 | M |
| **5** | **Goals**: condition state, evaluator call, continuation loop, no-progress guard, error classification | 0, 4 | S–M |
| **6** | **Scheduled tasks**: cron parser, scheduler tick, `CronCreate`/`CronList`/`CronDelete`, `/loop`, expiry, jitter, storage | 0, 4 | M |
| **7** | **Extend plugins**: consume `commands/`, wire `hooks/hooks.json`, wire `mcpServers`, plugin-subagent field restrictions | 1, 2 | S |
| **8** | **Extend skills**: `context: fork`, `agent:`, `model:`, `hooks:`, `once`, enforce `allowed-tools` | 1, 4 | S |
| **9** | **Extend subagents**: remaining frontmatter fields, transcripts, resume, opt-in nesting depth, concurrency cap | 1, 2 | M |

Phases 1 and 2 are independent of each other and of everything else; 3 is independent.
That gives three parallel tracks after Phase 0.

**Every phase ships with its own test suite.** Klaud's 19 suites are the project's main
safety net and the reason the last two releases went out clean. Budget roughly a third of
the effort per feature for tests — the OAuth work landed 150 checks, the Gmail connector
251. Non-negotiable for hooks and MCP in particular, where the failure modes are silent
(a hook that fails open, a tool error that reads as success).

---

## 7. What I would cut, and why

Being explicit about this is more useful than a plan that quietly overreaches.

- **11 of the 33 hook events** have no Klaud equivalent (worktrees, teammates,
  elicitation, model switching, message display, directory events). Implement the ~15–18
  that map, and document the rest as absent rather than stubbing events that can never
  fire.
- **Desktop scheduled tasks and cloud Routines.** Different products with infrastructure
  Klaud does not have. Session-scoped cron only.
- **Cron jitter.** Deterministic drift exists for prompt-cache behaviour. Klaud has no
  prompt cache. Defer until it matters.
- **MCP `resources/subscribe`, `InputRequiredResult`, and the 2026-07-28 revision.**
  Forward-compat, not current server reality. Implement legacy, detect modern, stop there.
- **MCP `outputSchema` validation.** The spec says clients *SHOULD* validate. Type-checking
  arbitrary model output against arbitrary schemas without a JSON-Schema dependency is a
  poor trade for Klaud.
- **Raising subagent nesting to 3 by default.** Klaud's 1-level cap is deliberate and
  safer. Make depth configurable, keep the default.

---

## 8. Decisions only you can make

1. **Hook trust.** Command hooks are arbitrary code execution. Klaud is a long-running
   server, so a project `.klaud/settings.json` would execute on start — and unlike Claude
   Code's interactive mode, there is no trust dialog holding it back. Options: (a) personal
   `~/.klaud` hooks only, project hooks require an explicit opt-in flag; (b) a
   workspace-trust prompt on first run in a folder; (c) match Claude Code exactly, which
   means project hooks run. **I recommend (a)** for a server that starts unattended.

2. **Compaction.** Goals, `PreCompact` hooks and two rewind actions all assume a real
   summary. Klaud currently truncates. Do we build summarising compaction (a real feature,
   with token cost and a failure mode), or omit the dependent behaviours and say so?

3. **Goal evaluator model.** A separate evaluation call after every turn costs tokens.
   Which model — the session model (simple, possibly slow and expensive), or a separate
   configurable one (better, more config)? And is the feature on by default?

4. **Background task limits.** Claude Code applies 30 min / 2 h limits to *unattended*
   sessions only. Klaud has no notion of unattended. Do background commands get a limit
   always, or none, given the user is presumably present?

5. **Order.** Phases 1 and 2 are both large and independent. Hooks unblocks three later
   phases (7, 8, 9) and is the higher-leverage single choice; MCP is self-contained and
   delivers the most obvious new user-visible capability. Which first?

---

## 9. Honest risks

- **Provider-agnosticism is a real divergence.** Claude Code assumes Anthropic models with
  a reliable cheap fast model available. Klaud runs whatever OpenAI-compatible endpoint is
  configured — free tiers with rate limits, occasional bare 500s, and no guarantee of a
  small model. Goals (`prompt` hooks especially) depend on an extra model call per turn.
  This is the least faithful area of any parity work and should be documented, not hidden.
- **Silent-failure surface is large.** Hooks fail open by design; MCP tool errors arrive
  inside successful responses; background tasks can die quietly. Klaud's existing
  philosophy — every failure carries an actionable message, and no error string is
  invented — should be applied hard here, with tests that assert the *failure* text.
- **Migration.** New settings keys, a scheduled-task store, a file-history store, and a
  changed tool catalogue. Klaud has an established pattern for this (`SETTING_KEYS`, atomic
  writes, throwaway dirs in tests) and it should be followed rather than reinvented.
- **Scope.** Nine features at this fidelity is a multi-release effort, not one release.
  Phases 0–3 alone are a coherent, shippable milestone.

---

## 10. Sources

All under `_research/`, each with its own sources-fetched table noting every URL and
whether the fetch succeeded:

| File | Covers |
| --- | --- |
| `hooks.md` | 33 events, config shape and precedence, stdin schema per event, exit codes, JSON output fields, timeouts, security, environment, 26 documented surprises |
| `mcp.md` | JSON-RPC, both protocol eras, stdio + Streamable HTTP framing, tools/resources/prompts, notifications, errors, Claude Code config and scopes, 10 gaps |
| `goals-checkpoints.md` | Goal lifecycle, verdicts, no-progress breaker, error classification; checkpoint boundary, storage, six rewind actions, retention, limitations |
| `tasks-and-extensions.md` | `/loop` + cron tools, Desktop tasks, Routines, background task lifecycle and output capture, complete subagent/skill/plugin field lists and discovery rules |

Known gaps, carried forward rather than papered over: the full bodies of two rewind-error
sections and the `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` row were not retrieved (the fetch tool
truncated those pages); the MCP page's tail came from a 2026-02-08 Wayback capture of the
same official page; `ToolAnnotations` defaults were unreachable; and the exact
`protocolVersion` string Claude Code sends is undocumented.
