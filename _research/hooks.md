# Claude Code hooks — exact semantics (research notes for a parity implementation)

Compiled 2026-10-16 from Anthropic's official docs. Everything below is drawn from the pages listed
under "Sources fetched". Where the docs are silent, ambiguous, or defer to a page I did not fetch,
that is stated explicitly rather than filled in.

## Sources fetched

| URL | Result |
| :- | :- |
| `https://code.claude.com/docs/en/hooks.md` | **OK, HTTP 200.** This is the reference page ("Hooks reference"), and it is separate from the guide. Page is 270,775 bytes. The `web_fetch` tool returned only ~100 KB of it (truncated mid-`SessionStart`, at "Persist environment variables"), so the full page was re-downloaded verbatim with `Invoke-WebRequest` into `_src/hooks.md`. All 4,205 lines were read. |
| `https://code.claude.com/docs/en/hooks-guide.md` | **OK, HTTP 200.** 61,796 bytes ("Automate actions with hooks"). Re-downloaded the same way (`_src/hooks-guide.md`) because the tool result was also truncated. Read in full. |
| `https://code.claude.com/docs/en/settings.md` | **OK, HTTP 200.** 57,985 bytes. Used only for the settings-precedence list, which the hooks pages reference instead of restating. |
| `https://code.claude.com/docs/llms.txt` | **OK, HTTP 200.** 63,675 bytes. Index only; not used to locate further pages because both hook pages were found directly and are the authoritative ones. |
| `https://code.claude.com/docs/en/hooks` | Not fetched separately. The reference lives at this path; `.md` on the same path is the raw form of the same page. There is no other "hooks reference" page. |

Pages the hooks reference defers to but that were **not** fetched (known gaps, see end of file):
`/docs/en/env-vars`, `/docs/en/agent-sdk/hooks`, `/docs/en/plugins/components`, `/docs/en/settings-reference`.

---

## 1. Lifecycle events

**33 events.** Nine you named all exist with those exact spellings; the other 24 are listed below.
Names are case-sensitive (PascalCase, no separators).

Cadence framing from the doc: three groups — per session (`SessionStart`, `SessionEnd`), per turn
(`UserPromptSubmit`, `Stop`, `StopFailure`), and per tool call inside the agentic loop (`PreToolUse`,
`PostToolUse`).

Two tools skip tool events: `EndConversation` calls skip both `PreToolUse` and `PostToolUse`
(and `PermissionRequest`).

| Event | Fires when (precise) | Before/after the action | Can block / change |
| :- | :- | :- | :- |
| `SessionStart` | A session begins or resumes. Backgrounded at launch and on `/clear`. | Before the first prompt; before session MCP servers are available | No blocking. Injects context, `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills` |
| `Setup` | Only with `--init-only`, or `--init` / `--maintenance` in `-p` mode. Not on normal startup | Before `SessionStart` (optional pre-step) | No blocking; all JSON output discarded on every exit code |
| `InstructionsLoaded` | A `CLAUDE.md` or `.claude/rules/*.md` file is loaded into context; at session start and on lazy loads | After the load decision, async | No decision control; JSON output discarded |
| `UserPromptSubmit` | A prompt is submitted, before Claude processes it. Also fires for scheduled-task/`/loop` turns, a background subagent reporting back, and a cross-session message | Before the model sees the prompt | Blocks the prompt (`decision:"block"` or exit 2); adds context; sets `sessionTitle`; `suppressOriginalPrompt` |
| `UserPromptExpansion` | A user-typed command expands into a prompt, before it reaches Claude. Covers the `/skillname` path that `PreToolUse` misses | Before expansion reaches Claude | Blocks the expansion |
| `PreToolUse` | After Claude creates tool parameters and before processing the tool call | Before execution | allow / deny / ask / defer; rewrites `tool_input` |
| `PermissionRequest` | Claude Code is about to ask you for permission, or would auto-deny a call that can't prompt | Before the permission decision | allow / deny via `decision.behavior`; **exit 2 is not honored** |
| `PermissionDenied` | Auto mode denies a tool call, including no-verdict and classifier-unavailable denials | After the denial | Only `hookSpecificOutput.retry` |
| `PostToolUse` | After a tool call completes **successfully** | After execution | Feedback (`decision:"block"` + `reason`), `additionalContext`, replace output |
| `PostToolUseFailure` | A tool that started executing failed (threw, or MCP returned an error result) | After failure | `additionalContext` only |
| `PostToolBatch` | Once after every tool call in a batch resolves, before the next model request | After the batch, before the next model call | Blocks the agentic loop |
| `Notification` | Claude Code sends a notification | Side channel, async | No decision control; `systemMessage`/`continue` discarded, `terminalSequence` still emitted |
| `MessageDisplay` | While assistant message text is displayed, once per batch of completed lines (once per message in non-interactive runs) | During streaming, holds rendering until it returns | `displayContent` replaces on-screen text only |
| `SubagentStart` | Claude spawns a subagent with the Agent tool, resumes a subagent, or an in-process teammate takes a new message | Before the subagent's first prompt | No blocking; `additionalContext` |
| `SubagentStop` | A subagent finished responding (also internal agents for prompt suggestions / `/btw`) | After the subagent responds | Blocks the stop → subagent keeps running |
| `TaskCreated` | A task is being created via the `TaskCreate` tool | Before creation completes | Exit 2 or `decision:"block"` cancels the task; `continue:false` ignored |
| `TaskCompleted` | A task is being marked completed via `TaskUpdate`, or a teammate ends its turn with in-progress tasks | Before completion is recorded | Exit 2 blocks; `continue:false` only when a teammate triggered it |
| `Stop` | The main agent finished responding. **Does not fire on user interrupt**; API errors produce `StopFailure` instead | After the response | Blocks the stop → conversation continues |
| `StopFailure` | The turn ends due to an API error | After the failure | None; output and exit code ignored except `terminalSequence` |
| `TeammateIdle` | An agent-team teammate is about to go idle after its turn | Before going idle | Exit 2 keeps it working; `continue:false` stops the teammate |
| `ConfigChange` | A settings / managed-policy / skill file changes during a session | Before the change is applied to the running session | Blocks, except `policy_settings` (never blockable) |
| `CwdChanged` | A shell command in the main conversation changes the working directory (e.g. Claude runs `cd`) | After the directory change | No blocking; `watchPaths` output |
| `DirectoryAdded` | A working directory is added mid-session via `/add-dir` or the SDK `register_repo_root` control request | After the add completes; runs in background | No decision control |
| `FileChanged` | A watched file changes on disk, detected by a filesystem watcher (any writer: Edit/Write, Bash, or an outside process) | After the change | No blocking; `watchPaths` output |
| `WorktreeCreate` | A worktree is created via `--worktree`, `EnterWorktree`, `isolation:"worktree"`, a workflow agent, a background session, or `claude remote-control` in `worktree` mode | Replaces the default `git worktree` behavior | Success/failure only — must return the path; any non-zero exit fails creation |
| `WorktreeRemove` | Removal of a worktree that a `WorktreeCreate` hook created | Before/around cleanup | Exit code decides; JSON discarded |
| `PreCompact` | Before context compaction | Before compaction | Exit 2 or `decision:"block"` blocks compaction |
| `PostCompact` | After compaction completes | After compaction | No decision control |
| `PreModelSwitch` | Before applying a model switch you or a client requested (`/model`, pickers, `/config`, fast mode, `set_model`, `apply_flag_settings`) | Before the switch | Blocks; `permissionDecision` allow/deny/ask |
| `PostModelSwitch` | After the session's model changes, including changes Claude Code makes on its own (fallback, resume, `opusplan`) | After the switch | No blocking; context only |
| `Elicitation` | An MCP server requests user input during a tool call | Before the dialog | accept / decline / cancel programmatically |
| `ElicitationResult` | After the user responds to an MCP elicitation, before the response reaches the server | Before the response is sent | Rewrites or blocks the response |
| `SessionEnd` | The session terminates | At teardown | No decision control; JSON discarded |

Notable **non-firing** cases stated in the docs: `PreToolUse` does not fire for files pulled in by an
`@`-reference in the prompt (they are inserted while building the prompt, with no tool call) unless
`CLAUDE_CODE_DISABLE_FILE_MENTIONS=1`; `PostToolUseFailure` does not fire for calls rejected before
execution (unknown tool, schema/validation failure, permission denial); `CwdChanged`/`DirectoryAdded`
do not fire for the `--add-dir` startup flag or the `/permissions` Workspace tab; `ConfigChange` does
not fire when server-managed settings arrive or refresh.

---

## 2. Configuration

### Shape

Three levels of nesting inside a settings file's single `hooks` object: event name → matcher group →
handler array. The doc's own vocabulary: *hook event*, *matcher group*, *hook handler*.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          { "type": "command", "command": "/path/lint.sh", "timeout": 30 }
        ]
      }
    ]
  }
}
```

- `hooks` is one object; each event name is a **key inside it** (sibling keys, not an array).
- Each event maps to an **array** of matcher groups.
- `matcher` is optional on a group; omitting it (or `""`/`"*"`) matches everything.
- Each group has a `hooks` array of handler objects. Every matching handler in the array runs.
- Plugin files (`hooks/hooks.json`) may add an optional top-level `description` alongside `hooks`.

There is no per-hook `enabled` flag and no way to disable a single hook while keeping it configured;
removal means deleting the entry.

### Locations and precedence

| Location | Scope |
| :- | :- |
| `~/.claude/settings.json` | All your projects |
| `.claude/settings.json` | Single project (committable — shared) |
| `.claude/settings.local.json` | Single project (personal, gitignored) |
| Managed policy settings (`managed-settings.json`, MDM, server-managed) | Organization-wide |
| Plugin `hooks/hooks.json` | While the plugin is enabled |
| Skill frontmatter `hooks:` | Rest of the session once the skill is invoked |
| Subagent frontmatter `hooks:` | While that subagent runs |

**Hooks are additive, not overriding.** The doc: entries "merge across settings levels rather than
replacing each other: user, project, and local settings add their own hooks without removing managed
ones". Consequence for a parity implementation: you cannot shadow a managed hook by redefining it.
Two related dedup rules: if you define the **same handler** in more than one settings file it runs
**once**, but a plugin's or skill's copy of the same handler **stays separate** (runs in addition).

The general settings precedence order (from `/docs/en/settings`, highest first) is **managed settings
→ command line (`--settings`) → `.claude/settings.local.json` → `.claude/settings.json` →
`~/.claude/settings.json`**. This order governs scalar keys only. The scalar that matters for hooks is
`disableAllHooks`: it is read after precedence, so a project's `"disableAllHooks": false` overrides a
user-level `true`, and `--settings '{"disableAllHooks": true}'` overrides project and local settings.
Managed hooks can only be disabled by `disableAllHooks` set at the managed level.

Surrounding policy keys, all in managed settings:

- `allowManagedHooksOnly` — blocks user, project, local and plugin hooks (plugins force-enabled in
  managed `enabledPlugins` are exempt), and also narrows `statusLine`, `fileSuggestion`,
  `subagentStatusLine` to managed settings.
- `allowedHttpHookUrls` — when defined at any level, an HTTP hook runs only if its URL matches the
  merged allowlist. Applies to every source, including managed policy settings.
- `httpHookAllowedEnvVars` — when defined, only these variables are interpolated into hook headers.

Cloud sessions do not read the local `~/.claude/settings.json`.

### Matcher semantics (this is the fiddliest part)

How the string is interpreted depends on the **characters it contains**:

| Value | Interpretation |
| :- | :- |
| `"*"`, `""`, omitted | Match all |
| Only letters, digits, `_`, `-`, space, `,`, `\|` | **Exact string**, or a list of exact strings separated by `\|` or `,`, with optional surrounding whitespace |
| Contains any other character | **JavaScript regular expression, unanchored** |

- Regex matchers are tested with `RegExp.prototype.test`, so a match anywhere in the value succeeds.
  `Edit.*` matches both `Edit` and `NotebookEdit`. Whole-string matching needs `^Edit$`.
- Consequence: `mcp__memory` (exact-character set) matches **no tool** — it is compared literally.
  Matching a whole MCP server requires `mcp__memory__.*`.
- `FileChanged` and `StopFailure` use a **narrower** exact-match set — letters, digits, `_`, `|` only.
  A hyphen, space or comma in those matchers forces the regex path, and only `|` separates alternatives.
- Matchers are case-sensitive (guide's troubleshooting section).
- Adding a `matcher` to an event that has no matcher support is **silently ignored**.

What the matcher is tested against, per event:

| Event(s) | Matched field | Values |
| :- | :- | :- |
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` | `tool_name` | `Bash`, `Edit\|Write`, `mcp__.*` |
| `SessionStart` | how the session started | `startup`, `resume`, `clear`, `compact`, `fork` |
| `Setup` | triggering CLI flag | `init`, `maintenance` |
| `SessionEnd` | end reason | `clear`, `resume`, `logout`, `prompt_input_exit`, `other` |
| `Notification` | notification type | `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_url_dialog`, `elicitation_complete`, `elicitation_response`, `agent_needs_input`, `agent_completed`, `quota_auto_resume_fired`, `quota_auto_resume_stale`, `quota_auto_resume_disabled` |
| `SubagentStart`, `SubagentStop` | agent type | `general-purpose`, `Explore`, `Plan`, custom names, plugin-scoped `my-plugin:reviewer` (colon → regex path, so anchor with `^…$`) |
| `PreCompact`, `PostCompact` | compaction trigger | `manual`, `auto` |
| `PreModelSwitch`, `PostModelSwitch` | canonical name of the model switched **to** | `claude-opus-5`, `claude-opus-4-6\|claude-opus-5`, `.*opus.*` |
| `ConfigChange` | config source | `user_settings`, `project_settings`, `local_settings`, `policy_settings`, `skills` |
| `DirectoryAdded` | how the dir was added | `slash_command`, `register_repo_root` |
| `FileChanged` | literal filenames to watch (see below) | `.envrc\|.env` |
| `StopFailure` | error type | `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown` |
| `InstructionsLoaded` | load reason | `session_start`, `nested_traversal`, `path_glob_match`, `include`, `compact` |
| `UserPromptExpansion` | command name | your skill / command names |
| `Elicitation`, `ElicitationResult` | MCP server name | configured server names |
| No matcher support | — | `UserPromptSubmit`, `PostToolBatch`, `Stop`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `WorktreeCreate`, `WorktreeRemove`, `CwdChanged`, `MessageDisplay` |

`FileChanged` is the outlier: the matcher value serves **two** roles. It is split on `|` and each
segment registered as a **literal filename** in the working directory to build the watch list (so
`^\.env` watches a file literally named `^\.env`), and the same value then filters which hook groups
run, using the normal matcher rules, against the changed file's **basename**. `"*"` matches every
watched file but is also registered in the watch list as a literal file named `*`. The watcher starts
only when something names a file to watch.

`PreModelSwitch`/`PostModelSwitch`: the matcher is compared against the canonical model name,
ignoring any `[1m]` suffix. When no canonical name can be determined (e.g. a gateway-only custom
model ID), **every** hook runs regardless of matcher — so a blocking hook must check `to_model` itself.

### Handler shape (`hooks` array entries)

Five `type` values: `"command"`, `"http"`, `"mcp_tool"`, `"prompt"`, `"agent"`.

Common fields:

| Field | Notes |
| :- | :- |
| `type` | Required. One of the five above |
| `if` | Optional. One permission-rule pattern, e.g. `"Bash(git *)"`, `"Edit(*.ts)"`. **Only evaluated on tool events** (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`); on any other event a hook with `if` set never runs. No `&&`, `\|\|` or list syntax — use one handler per condition |
| `timeout` | Seconds before canceling. Not enforced on a command hook run with `async: true` |
| `statusMessage` | Custom spinner message while the hook runs |
| `once` | `true` removes the hook after its first successful run. **Honored only in skill frontmatter**; ignored in settings files and agent frontmatter. A failed / exit-2 / timed-out run leaves it in place |

Command-only: `command` (required), `args`, `async`, `asyncRewake`, `shell` (`"bash"` | `"powershell"`),
`onFailure` (`"continue"` default | `"block"`). HTTP-only: `url` (required), `headers`,
`allowedEnvVars`, `onFailure`. MCP-tool-only: `server` (required; plugin-bundled servers use
`plugin:<plugin>:<server>`), `tool` (required), `input` (string values support `${path}`
substitution from the hook's JSON input, e.g. `"${tool_input.file_path}"`). Prompt/agent: `prompt`
(required; `$ARGUMENTS` is replaced with the hook input JSON), `model`; prompt hooks also
`continueOnBlock`.

**Exec form vs shell form.** With `args` present the handler is *exec form*: `command` is resolved as
an executable and spawned directly with `args` as the argument vector, no shell, each element one
argument exactly as written, placeholders substituted as plain strings. Without `args` it is *shell
form*: the string goes to `sh -c` (macOS/Linux), Git Bash on Windows, or PowerShell when Git Bash is
absent; the `shell` field chooses explicitly and is ignored when `args` is set. On Windows exec form
requires a real executable — `.cmd`/`.bat` shims cannot be spawned without a shell.

### Hook types supported per event

- All five types: `PermissionDenied`, `PostToolBatch`, `PostToolUse`, `PostToolUseFailure`,
  `PreToolUse`, `Stop`, `SubagentStop`, `TaskCompleted`, `TaskCreated`, `TeammateIdle`,
  `UserPromptExpansion`, `UserPromptSubmit`.
- `command`, `http`, `mcp_tool`, `prompt` but **not** `agent`: `PermissionRequest` (an agent hook there
  is skipped and the permission flow proceeds unchanged).
- `command`, `http`, `mcp_tool` only: `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `Elicitation`,
  `ElicitationResult`, `FileChanged`, `InstructionsLoaded`, `MessageDisplay`, `Notification`,
  `PostCompact`, `PostModelSwitch`, `PreCompact`, `PreModelSwitch`, `SessionEnd`, `StopFailure`,
  `SubagentStart`, `WorktreeCreate`, `WorktreeRemove`.
- `command` and `mcp_tool` only: `SessionStart`, `Setup`. `SessionStart` at launch (including
  `--continue`/`--resume`) and every `Setup` event fire before MCP servers are available, so their
  `mcp_tool` hooks are skipped without calling the tool.

### Skill and subagent frontmatter

Same configuration format in YAML frontmatter under a `hooks:` key. Subagent hooks run only while the
subagent runs and are removed when it finishes; a `Stop` hook in subagent frontmatter is **converted
to `SubagentStop`**. Skill hooks register on invocation and keep running for the rest of the session,
including turns after the skill's own turn.

---

## 3. Hook input (stdin for `command`, POST body for `http`)

Common fields on every event:

| Field | Meaning |
| :- | :- |
| `session_id` | Current session identifier |
| `prompt_id` | UUID of the user prompt being processed; matches the `prompt.id` OTel attribute. **Absent until the first user input** |
| `transcript_path` | Path to the conversation JSON. Written asynchronously and may lag; may not yet contain the current turn's latest messages |
| `cwd` | Current working directory when the hook is invoked (follows Claude into a worktree, and follows `cd`) |
| `scratchpad_dir` | Session scratchpad directory. Absent when there is none. v2.1.257+ |
| `permission_mode` | `"default"`, `"plan"`, `"acceptEdits"`, `"auto"`, `"dontAsk"`, `"bypassPermissions"`. The mode labelled **Manual** arrives as `"default"`, never `"manual"`. Not all events carry it |
| `effort` | Object with `level`: `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`. Present for events in a tool-use context when the model supports it |
| `hook_event_name` | Name of the event that fired |
| `agent_id` | Subagent or in-process teammate identifier the hook fires in |
| `agent_type` | Agent name; present with `--agent` or inside a subagent (for tool events; on `SubagentStart`/`SubagentStop` it is the event-specific field as well) |

`model` appears **only** on `SessionStart`. `PreModelSwitch`/`PostModelSwitch` carry `from_model` /
`to_model` instead. There is **no `$CLAUDE_MODEL` environment variable**.

Universal event-specific fields worth calling out:

- `tool_use_id` — present on `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`.
  **Absent on `PermissionRequest`.**
- `tool_input` — Schema per tool; for `Write`/`Edit`/`Read` (and `PostToolUse` for file tools)
  `file_path` is always absolute, `~` and relative paths are expanded before hooks run, and on Windows
  it arrives with backslash separators even under Git Bash.
- `mcp_server` — object with `name` and `source` (`plugin`, `sdk`, config scopes such as `user`,
  `project`) on tool events for MCP tools. v2.1.274+. The doc says to base trust decisions on
  `source`, not on the name or the `mcp__<server>__` prefix.
- `tool_response` — on `PostToolUse`, the tool's structured `Output` object, and its shape **differs**
  from `PostToolBatch`'s `tool_response`, which is the serialized `tool_result` content the model
  sees (a string or content-block array; for `Read`, line-number-prefixed text).
- `duration_ms` — optional on `PostToolUse`/`PostToolUseFailure`; excludes permission-prompt and
  `PreToolUse` time.
- `last_assistant_message` — `Stop`, `SubagentStop` (Claude's final text; use this rather than reading
  the transcript), and `StopFailure` (there it holds the **API error string**, not conversational output).
- `stop_hook_active` — `Stop` and `SubagentStop`; `true` when Claude Code is already continuing because
  of a stop hook.

Per-event additional fields (compact list):

| Event | Extra fields |
| :- | :- |
| `SessionStart` | `source`; optional `model`, `agent_type`, `session_title`; when `source` is `resume`/`fork` and the transcript has ≥1 Claude response: `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired`, `estimated_cache_write_usd` (v2.1.251+) |
| `Setup` | `trigger` (`"init"` / `"maintenance"`) |
| `InstructionsLoaded` | `file_path`, `memory_type` (`User`/`Project`/`Local`/`Managed`), `load_reason`, optional `globs`, `trigger_file_path`, `parent_file_path` |
| `UserPromptSubmit` | `prompt` (pasted `[Pasted text #N]` placeholders arrive expanded, possibly wrapped in `<pasted_content id="…">` lines); `session_title` when set |
| `UserPromptExpansion` | `expansion_type` (`slash_command` / `mcp_prompt`), `command_name`, `command_args`, `command_source`, `prompt` |
| `MessageDisplay` | `turn_id`, `message_id` (not an API `msg_…` id), `index` (0-based batch index), `final`, `delta` |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` |
| `PermissionRequest` | `tool_name`, `tool_input` (**no** `tool_use_id`), optional `permission_suggestions` |
| `PermissionDenied` | `tool_name`, `tool_input`, `tool_use_id`, `reason` |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, optional `duration_ms` |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, `error`, optional `is_interrupt`, `duration_ms` |
| `PostToolBatch` | `tool_calls[]` with `tool_name`, `tool_input`, `tool_use_id`, `tool_response` |
| `Notification` | `message`, optional `title`, `notification_type` |
| `SubagentStart` | `agent_id`, `agent_type` |
| `SubagentStop` | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path` (nested `subagents/` transcript), `last_assistant_message`, `background_tasks`, `session_crons` |
| `TaskCreated` / `TaskCompleted` | `task_id`, `task_subject`, optional `task_description`, `teammate_name`, `team_name` (deprecated) |
| `Stop` | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` |
| `StopFailure` | `error`, optional `error_details`, optional `last_assistant_message` |
| `TeammateIdle` | `teammate_name`, `team_name` (deprecated) |
| `ConfigChange` | `source`, optional `file_path` |
| `CwdChanged` | `old_cwd`, `new_cwd` |
| `DirectoryAdded` | `directory`, `source` |
| `FileChanged` | `file_path`, `event` (`"change"` / `"add"` / `"unlink"`) |
| `WorktreeCreate` | `name` (slug, e.g. `bold-oak-a3f2`) |
| `WorktreeRemove` | `worktree_path` |
| `PreCompact` | `trigger`, `custom_instructions` (`null` for `auto`) |
| `PostCompact` | `trigger`, `compact_summary` |
| `PreModelSwitch` | `from_model`, `to_model`, `requested_model` (nullable), `source` (`command`/`picker`/`sdk`), `context_tokens`, `prompt_cache_warm`, `cache_ttl` (`"5m"`/`"1h"`), `estimated_cache_write_usd`, `pricing` (`configured`/`catalog`/`default`) |
| `PostModelSwitch` | Same as above, plus `source` values `"auto"` and `"resume"` |
| `SessionEnd` | `reason` (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`; `bypass_permissions_disabled` was removed in v2.1.234) |
| `Elicitation` | `mcp_server_name`, `message`, optional `mode` (`form`/`url`), `url`, `elicitation_id`, `requested_schema` |
| `ElicitationResult` | `mcp_server_name`, `action`, optional `mode`, `elicitation_id`, `content` |

`background_tasks[]` entries: `id`, `type` (`shell`, `subagent`, `monitor`, `workflow`, `teammate`,
`cloud session`, `MCP task`), `status`, `description` (capped 1000 chars with an in-string
`… [+N chars]` marker), and type-specific `command`, `agent_type`, `server`, `tool`, `name`.
`session_crons[]` entries: `id`, `schedule`, `recurring`, `prompt`.

---

## 4. Hook response

### Exit codes

| Exit code | Meaning |
| :- | :- |
| `0` | Success. JSON output fields apply; the action proceeds unless those fields block it |
| `2` | Blocking error, **on events that can block** |
| anything else | Non-blocking error. The action proceeds; the transcript shows `<hook name> hook error`. **Exit 1 is not special** |

The exit code and stdout interact. The doc's matrix, for `PreToolUse`:

| stdout | exit 0 | exit 2 | other |
| :- | :- | :- | :- |
| Valid JSON object | Success, fields apply | Blocking error; fields are still read but **cannot override the block**, even `permissionDecision:"allow"` | Success — the exit code is ignored and the fields alone decide. With `onFailure:"block"` this counts as a failure |
| Unparseable / schema-invalid JSON | Non-blocking error carrying the parse/validation message | Blocking error; stderr is the reason | Non-blocking error with the parse/validation message |
| Plain text or nothing | Success | Blocking error; stderr is the reason | Non-blocking error carrying the first line of stderr |

`exit 0` with no output means "no decision" — it is **not** an approval; the normal permission flow
still applies. The exit-2 blocking message is stderr, unless the hook also printed JSON with a
blocking decision, in which case that decision's reason is used.

Per-event exit-2 behaviour (the doc's table, condensed):

Blocking: `PreToolUse` (blocks the call) · `UserPromptSubmit` (blocks the prompt) ·
`UserPromptExpansion` (blocks the expansion) · `Stop` (prevents stopping) · `SubagentStop` ·
`TeammateIdle` · `TaskCreated` (rolls back creation) · `TaskCompleted` · `PostToolBatch` (stops the
loop before the next model call) · `PreCompact` · `PreModelSwitch` · `Elicitation` (declines, no
dialog) · `ElicitationResult` (blocks the response; action becomes decline) · `ConfigChange` (except
`policy_settings`) · `WorktreeCreate` / `WorktreeRemove` (any **non-zero** code fails the operation).

Non-blocking: `PermissionRequest` (**exit 2 is not honored at all** — the permission flow proceeds
unchanged; deny through the `decision` object) · `PermissionDenied` (exit code and stderr ignored) ·
`PostToolUse` / `PostToolUseFailure` (stderr shown to Claude; the tool already ran) · `Notification` ·
`StopFailure` · `SubagentStart` (stderr to user only; notice appears in the subagent's transcript) ·
`SessionStart` · `Setup` · `SessionEnd` · `CwdChanged` · `DirectoryAdded` (stderr to debug log) ·
`FileChanged` · `PostCompact` · `PostModelSwitch` · `InstructionsLoaded` (exit code ignored) ·
`MessageDisplay`.

Special parsing rules: on `Stop`, `SubagentStop`, `TaskCompleted`, and a plugin's `UserPromptSubmit`
hook, exit 2 with empty stdout whose stderr says a file is missing (e.g. `No such file or directory`)
is treated as a non-blocking error. On `Elicitation`/`ElicitationResult`, `hookSpecificOutput` is
applied **only** at exit 0. Events that discard output (`StopFailure`) ignore JSON on any exit code,
apart from side-effect fields like `terminalSequence`.

### stdout parsing

For a non-async hook, stdout is parsed as JSON output **only** when the whole output is one JSON object
with nothing around it but whitespace:

- One JSON object, one line or several → parsed.
- Doesn't start with `{`, or starts with `{` and doesn't end with `}` → plain text (this includes a
  JSON array and a quoted JSON string).
- Two or more lines that each parse as JSON, first starting `{`, last ending `}` → plain text when no
  line sets a field, parse failure when one does.
- Starts `{`, ends `}`, not valid JSON → parse failure.

Anything before the JSON (e.g. a shell profile echoing a banner) breaks parsing, and because the hook
exited 0 the transcript shows **no error at all**. Debug log line to look for:
`Hook output does not start with {`.

Exit 0 stdout handling: written to the debug log and not shown in the transcript, **except**
`UserPromptSubmit`, `UserPromptExpansion`, `SessionStart`, and `PostModelSwitch`, where plain-text
stdout is added to Claude's context. Claude never sees stderr from an exit-0 hook.

### JSON output fields

Universal fields (accepted on every event, though some events discard them):

| Field | Default | Meaning |
| :- | :- | :- |
| `continue` | `true` | `false` stops Claude processing entirely after the hook runs; takes precedence over any event-specific decision field |
| `stopReason` | — | Shown to the user when `continue` is `false`; stays in the conversation so Claude sees it if the conversation continues |
| `suppressOutput` | `false` | **Has no effect.** Claude Code accepts the field but does not act on it |
| `systemMessage` | — | Warning shown to the user (may arrive as an `SDKInformationalMessage` in SDK / `stream-json`) |
| `terminalSequence` | — | Allowlisted terminal escape sequence for Claude Code to emit: OSC `0`/`1`/`2`/`9`/`99`/`777` and bare BEL, terminated with BEL or ST. Anything else (CSI, OSC 8, OSC 52, OSC 1337) is rejected and the whole field ignored. Only written in an interactive session with the UI on screen |

`hookSpecificOutput` requires `hookEventName` set to the event name. Top-level `decision` / `reason`
are used by some events; the only valid `decision` value is `"block"`.

Decision patterns by event:

| Events | Pattern | Fields |
| :- | :- | :- |
| `UserPromptSubmit`, `UserPromptExpansion`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `Stop`, `SubagentStop`, `ConfigChange`, `PreCompact` | top-level `decision` | `decision:"block"`, `reason` |
| `PreToolUse` | `hookSpecificOutput` | `permissionDecision` (`allow`/`deny`/`ask`/`defer`), `permissionDecisionReason`, `updatedInput`, `additionalContext` |
| `PermissionRequest` | `hookSpecificOutput.decision` object | `behavior` (`allow`/`deny`), `updatedInput` (allow only), `updatedPermissions` (allow only), `message` (deny only), `interrupt` (deny only) |
| `PermissionDenied` | `hookSpecificOutput` | `retry: true` |
| `Elicitation`, `ElicitationResult` | `hookSpecificOutput` or top-level `decision` | `action` (`accept`/`decline`/`cancel`), `content` |
| `PreModelSwitch` | `hookSpecificOutput` or top-level `decision` | `permissionDecision` (`allow`/`deny`/`ask`; **no** `defer`, no `updatedInput`, no `additionalContext`), `permissionDecisionReason` |
| `SessionStart`, `SubagentStart`, `PostModelSwitch` | context only | `additionalContext`; `SessionStart` also `initialUserMessage`, `sessionTitle`, `watchPaths`, `reloadSkills` |
| `MessageDisplay` | `hookSpecificOutput` | `displayContent` |
| `WorktreeCreate` | path return | command hook: last non-empty stdout line (ANSI stripped); HTTP hook: `hookSpecificOutput.worktreePath` |
| `TaskCreated` | exit code or top-level `decision` | exit 2 or `decision:"block"` cancels; `continue:false` is ignored |
| `TeammateIdle`, `TaskCompleted` | exit code or `continue:false` | exit 2 blocks with stderr feedback; `{"continue": false, "stopReason": "..."}` stops the teammate |
| `Setup`, `Notification`, `SessionEnd`, `PostCompact`, `InstructionsLoaded`, `StopFailure`, `CwdChanged`, `DirectoryAdded`, `FileChanged` | none | No decision control |

Content rewriting: `PreToolUse.updatedInput` (replaces the whole input object), `PermissionRequest`
`decision.updatedInput`, `PostToolUse.updatedToolOutput` (must match the tool's output shape; a
mismatched built-in value is ignored, MCP output passes through unvalidated) and
`updatedMCPToolOutput` (legacy), `UserPromptSubmit` cannot replace the prompt. `UserPromptSubmit` also
supports `sessionTitle` and `suppressOriginalPrompt`. `PostToolUse` has `classifierContext` (≤2,000
chars per tool call, shared across hooks; ignored for async hooks and read-only calls).

### `decision:"block"` vs exit 2

Both block, and on most events they route the same way (stderr ≡ `reason`). Differences that matter:

- Exit 2 blocks **even when validated JSON is printed**, and cannot be overridden by JSON fields — not
  even `permissionDecision:"allow"`. With a JSON `decision:"block"` you get to keep full structured
  output control, and exit code 0 keeps the run a success.
- `decision:"block"` is event-specific and unavailable on `PreToolUse` (use `permissionDecision`) and
  `PermissionRequest` (use the `decision` object, where exit 2 is ignored entirely).
- Some events silently drop the message: `ConfigChange` shows nothing (debug log only), `Elicitation`
  shows nothing to user or server.
- `UserPromptSubmit` supports `suppressOriginalPrompt` with **either** mechanism.

Multiple hooks: all matching hooks run to completion and their results are merged **afterwards** — a
`deny` in one does not stop siblings. `PreToolUse` precedence is `deny` > `defer` > `ask` > `allow`;
`PreModelSwitch` is `deny` > `ask` > `allow`. `additionalContext` from every hook is kept.
For `PreToolUse.updatedInput`, the **last hook to finish** wins and the order is non-deterministic.
For `Elicitation`, a decline from one hook overrides an accept or cancel from another.

---

## 5. Timeouts, parallelism, failure behaviour

- **Parallelism**: "All matching hooks run in parallel." Every matching hook's command runs to
  completion before Claude Code merges results. `PostToolUse` therefore fires concurrently for
  parallel tool calls; `PostToolBatch` fires exactly once with the whole batch.
- **Dedup**: identical handler defined in more than one settings file runs once; plugin/skill copies
  are separate.
- **Default timeouts** (`timeout` in seconds overrides per handler):
  `command`, `http`, `mcp_tool` → **600 s**; `prompt` → **30 s**; `agent` → **60 s**.
  Lowered to **30 s** on `UserPromptSubmit`, `PreModelSwitch`, `PostModelSwitch`; **10 s** on
  `MessageDisplay`. `SessionEnd` hooks share a **1.5 s** budget for all hooks of any type; a per-hook
  `timeout` raises the budget to match, up to 60 s (timeouts on plugin-provided hooks do not raise it),
  and `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS` overrides the budget explicitly. Not enforced on
  `async: true` command hooks; still enforced on `asyncRewake`.
- **Timeout effect**: the hook is canceled and its output discarded, so on most events a timed-out
  hook renders **no decision**. Two exceptions: a timed-out `PreModelSwitch` hook **blocks** the
  switch, and a timed-out Agent SDK callback hook on `PreToolUse` blocks the tool call (a timed-out
  `command`/`http`/`mcp_tool` hook on `PreToolUse` does **not** block — use `onFailure: "block"`).
- **Failure**: a non-0/2 exit, a failure to start, a timeout, or unparseable/schema-invalid output is
  a non-blocking error by default — **the action proceeds**. This is the "fails open" property the doc
  calls out as a hazard for policy hooks: a mistyped path means the hook never runs and everything is
  allowed. `"onFailure": "block"` (command and HTTP hooks, v2.1.295+) makes a failure do what exit 2
  does on that event, except on `PermissionRequest` where it denies the request. `onFailure` has no
  effect on `Stop`, `SubagentStop`, `TaskCompleted`, `TeammateIdle` (exit 2 there sends Claude back to
  work; a hook that won't run can't be repaired), or on `async`/`asyncRewake` hooks.
- **HTTP specifics**: 2xx + empty body ≡ exit 0 with no output; 2xx + JSON object parsed with the same
  schema; 2xx + anything else, non-2xx, and connection failure are all non-blocking errors. HTTP hooks
  **cannot block via status code** — blocking requires a 2xx body carrying the decision fields.
- **Background process hazard**: if a hook starts a background process and exits, Claude Code finishes
  reading output shortly after the process exits; a deny printed later does not block. If an allow is
  printed and then a background process is started without redirecting its stdout/stderr, Claude Code
  blocks the call and the error includes the phrase `refusing to honor the suspect capture`.
- **Async hooks** (`async: true`, command hooks only): never block; `decision`/`permissionDecision`/
  `continue` have no effect. `additionalContext`/`systemMessage` from the response are delivered on the
  next conversation turn and, unlike synchronous hooks, are **not** shown to the user. `asyncRewake`
  wakes Claude on exit code 2 using stderr (or stdout if stderr is empty). In `-p` mode, async hooks
  still running at teardown are killed and finalized as `cancelled`.
- Per-event loop guards: `Stop`/`SubagentStop` blocking is capped at **8 consecutive continuations**
  (reset each time Claude calls a tool); override with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`.
  `stop_hook_active` is the per-invocation guard a hook must check.

---

## 6. Security (what Anthropic says)

The doc's disclaimer, quoted because it is the framing: command hooks "execute shell commands with
your full user permissions. They can modify, delete, or access any files your user account can
access." The guidance is to review and test every hook command before adding it.

**Workspace trust.** Claude Code checks workspace trust before running any hook from a settings file,
with a sharp asymmetry:

- Interactive session: hooks from **every** settings file are held back, including your own
  `~/.claude/settings.json`, until you accept the workspace-trust dialog for the folder (or a trusted
  parent).
- `-p` / SDK session: no dialog is shown, the folder is treated as trusted, so hooks committed in a
  repository's `.claude/settings.json` **run in a folder you have never trusted**.

The doc's mitigation advice: before scripting `claude -p` over a repository you didn't write, review
its `.claude/` settings files, start with `--bare`, or disable hooks for that run with
`--settings '{"disableAllHooks": true}'`. Project **subagent frontmatter** hooks follow a stricter rule
than settings-file hooks (they need the trust dialog; a `-p` session doesn't count as accepting it).
Project **skill** frontmatter hooks follow the settings-file rule and register even in a `-p` run in an
untrusted folder.

**Best practices listed**: validate and sanitize inputs, never trust input data blindly; always quote
shell variables (`"$VAR"`); block path traversal (check for `..`); use absolute paths; skip sensitive
files (`.env`, `.git/`, keys).

**Untrusted input, stated where it matters**: `classifierContext` is read as information from the
hosting application, so the doc warns not to copy untrusted tool output or third-party text into it.
`additionalContext` is injected as a system reminder; the doc advises writing factual statements
rather than imperative system instructions because text framed as out-of-band system commands "can
trigger Claude's prompt-injection defenses". Hook-supplied `<system-reminder>` tags are neutralised by
replacing the `<`. The `if` filter for Bash is explicitly documented as **best-effort**, with the
advice to use the permission system rather than a hook to enforce a hard allow or deny. `PreToolUse`
hooks fire before any permission-mode check and a `"deny"` holds even under `bypassPermissions` /
`--dangerously-skip-permissions`, but the reverse is not true: `"allow"` does not bypass deny rules and
cannot suppress prompts for network-path reads, MCP tools marked `requiresUserInteraction`, or
connector tools set to `ask`. Hooks in settings files and plugin `hooks/hooks.json` can tighten
restrictions but not loosen them past permission rules — with one caveat: a plugin **mod** handling
`tool.check` can approve a call a `PreToolUse` hook blocked, unless the hook is in managed settings.

---

## 7. Environment

- **Working directory**: handlers run in the current directory with Claude Code's environment. If that
  directory no longer exists, Claude Code falls back, in order: the directory the session started in,
  the project root, home, the system temp directory (and logs a warning naming the fallback).
- **`CLAUDE_PROJECT_DIR`**: project root where the session started. Set in the environment of the hook
  process **and** substituted in the command/args text. It stays put if Claude enters a worktree; `cwd`
  in the JSON input is what follows Claude.
- **`CLAUDE_PLUGIN_ROOT`**, **`CLAUDE_PLUGIN_DATA`**: plugin install dir and persistent data dir;
  substituted as placeholders and exported as environment variables.
- **`CLAUDE_ENV_FILE`**: available to `SessionStart`, `Setup`, `CwdChanged`, and `FileChanged` hooks
  only (**not** to a hook running in PowerShell, whether via `"shell": "powershell"` or by default on
  Windows without Git Bash). Lines written to it are run as shell code before each Bash command.
  `CwdChanged` clears them until the next `CwdChanged` event.
- **`CLAUDE_EFFORT`**: the effort level, also available to hook commands and the Bash tool.
- **`CLAUDE_CODE_REMOTE`** (`"true"` in remote web environments), **`CLAUDE_CODE_BRIDGE_SESSION_ID`**
  (v2.1.199+, set while a Remote Control connection is active).
- **`CLAUDE_PLUGIN_OPTION_<KEY>`**: plugin option values readable from a shell-form plugin hook
  (e.g. `$CLAUDE_PLUGIN_OPTION_WEBHOOK_URL` for a `webhook_url` option).
- The hook process **inherits the parent environment**, except `OTEL_*` exporter variables (stripped
  from every subprocess) and whatever `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` strips; in a HIPAA-configured
  session Anthropic credentials are also removed.
- **Interpolation**: `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` work in
  both exec and shell form; in exec form each `args` element is a plain string with no shell quoting,
  and in shell form each placeholder should be wrapped in double quotes. Plugin hooks additionally
  substitute `${user_config.*}` — **exec form only**; in shell form a `command` referencing
  `${user_config.*}` errors out instead of running. MCP-tool hook `input` string values support
  `${path}` substitution from the hook's JSON input (`"${tool_input.file_path}"`). HTTP hook header
  values interpolate `$VAR_NAME` or `${VAR_NAME}`, but **only** variables listed in `allowedEnvVars`;
  all other references become empty strings. PowerShell shell-form commands are rewritten to
  `${env:NAME}`; the bare `$CLAUDE_PROJECT_DIR` spelling is not rewritten (PowerShell resolves it to
  `$null`) and only logs a warning.
- **Templates**: `$ARGUMENTS` in a `prompt`/`agent` hook is replaced with the hook input JSON
  (appended if absent); escape a literal dollar as `\$1.00`.

---

## 8. Surprises and easy-to-get-wrong behaviour

1. **Fails open by default.** Non-zero-non-2 exit, timeout, crash, or bad JSON → the action proceeds.
   Every policy hook needs `"onFailure": "block"` or `exit 2` semantics, or a typo silently disables it.
2. **`suppressOutput` does nothing.** It is accepted and ignored. Successful stdout is never shown in
   the transcript anyway; it goes to the debug log.
3. **`PermissionRequest` ignores exit 2 entirely.** Blocking it requires the `decision` object; a hook
   that exits 2 with no `decision` leaves the flow unchanged and its stderr is discarded.
4. **`PreToolUse` does not use top-level `decision`.** It uses `hookSpecificOutput.permissionDecision`.
   The deprecated values `"approve"`/`"block"` map to `"allow"`/`"deny"`. Misplaced top-level fields
   parse fine and are **silently ignored** (`Hook JSON output had unrecognized keys` in the debug log).
5. **stdout must be *only* the JSON object.** A shell profile banner (or `BASH_ENV` → `~/.bashrc`)
   breaks parsing, and because the hook exits 0 the transcript shows no error. Debug marker:
   `Hook output does not start with {`.
6. **Matcher `mcp__memory` matches nothing.** Servers need `mcp__memory__.*` because the exact-character
   path compares literally. Plugin-bundled servers appear as
   `mcp__plugin_<plugin>_<server>__<tool>` and never match a bare server prefix.
7. **Regex matchers are unanchored** (`Edit.*` matches `NotebookEdit`), and the *choice* between exact
   and regex interpretation is driven by the character set of the matcher string, not by a flag.
8. **`FileChanged`'s matcher is not a regex for the watch list** — it is split on `|` into literal
   filenames, so `^\.env` watches a file named `^\.env`; `"*"` adds a literal file named `*`.
   Self-retriggering loops are a documented hazard (the `perl -i` example that rewrites even when it
   changes nothing).
9. **`Stop` fires on every response, not on task completion**, and never on a user interrupt — API
   errors fire `StopFailure` instead. Blocking loops must honour `stop_hook_active` and the 8-block cap.
10. **`last_assistant_message` exists because `transcript_path` lags.** The transcript is written
    asynchronously and may not yet contain the current turn's final message at `Stop` time.
11. **`SubagentStop` also fires for internal agents** (prompt suggestions, `/btw`), where `agent_type`
    is the session's own agent name or an empty string — and a matcher naming agent types never matches
    an empty `agent_type`.
12. **Parallel hooks do not short-circuit each other.** "One hook returning `deny` doesn't stop sibling
    hooks from executing" — side effects (logging, uploads) from a sibling still happen. And with two
    `PreToolUse` hooks returning `updatedInput`, the last one to finish wins, non-deterministically.
13. **Timeout is not a gate.** A stalled `PreToolUse` hook lets the call through; only `PreModelSwitch`
    and Agent SDK callback hooks fail closed on timeout.
14. **`SessionEnd` gets 1.5 s total** for all hooks, unless a per-hook `timeout` raises the budget.
15. **`disableAllHooks` is not a hook-level key**, follows settings precedence (a project `false` beats
    a user `true`), cannot disable managed hooks from below, and there is no way to disable one hook.
16. **Hooks merge across levels; they never shadow.** Same handler in two settings files runs once, but
    a plugin's or skill's copy is kept separate.
17. **Trust asymmetry**: interactive sessions hold back hooks until you trust the folder; `-p`/SDK
    sessions treat every folder as trusted, so a cloned repo's committed hooks run silently.
18. **Hook output caps at 10,000 characters** per string (`additionalContext`, `systemMessage`,
    `initialUserMessage`, and plain stdout measured separately). Over the cap, the text is replaced by
    a file path plus a ≤2,000-character preview, and Claude is **not** told to read the file. No setting
    raises this cap.
19. **`/dev/tty` is unavailable** (macOS/Linux hooks run in their own session without a controlling
    terminal; Windows has none). Terminal output must go through `terminalSequence`, which is
    interactive-only — ignored under `-p` and the Agent SDK.
20. **`WorktreeCreate` replaces default git behaviour**, so `.worktreeinclude` is not processed, and a
    command-hook `WorktreeCreate` **cannot return JSON** (its stdout is read as the path). Absolute
    paths containing `.` or `..`, and paths passing through a symlink below the repo root, are rejected.
21. **`PreToolUse` does not fire for `@`-referenced files** pasted into the prompt, and does not fire
    for `EndConversation`. A file-protection hook matching `Read` silently misses that path.
22. **Windows path separators**: `file_path` arrives with backslashes even under Git Bash, so a
    forward-slash comparison never matches and the tool call proceeds as if nothing were blocked.
23. **A hook that starts a background process and prints later** can produce
    `refusing to honor the suspect capture`, which turns an intended allow into a block.
24. **`once: true` only works in skill frontmatter**; ignored in settings files and agent frontmatter.
25. **`if` on a non-tool event prevents the hook from running entirely** rather than being ignored.
26. **`async` hooks lose decision power** (`decision`, `permissionDecision`, `continue` do nothing) and
    their `systemMessage` is delivered to Claude, not to the user.

---

## Known gaps / ambiguities (do not guess here)

- **No separate "hooks" page beyond the reference.** `/docs/en/hooks` *is* the reference;
  `/docs/en/hooks-guide` is the guide. The guide duplicates the event table and matcher table.
- **Tool-level truncation, not doc-level absence.** Both `.md` pages fetch fine; the initial tool
  results were truncated and had to be re-downloaded. The findings above come from the complete files.
- **Environment variable inventory is partial.** The hooks reference lists the hook-relevant variables
  but defers the full list to `/docs/en/env-vars`, which was **not** fetched. Do not treat §7 as a
  complete inventory of what a hook process can see.
- **Agent SDK callback hooks are documented from the outside only.** The reference states the timeout
  and blocking differences for `PreToolUse` and `UserPromptSubmit` SDK callbacks but
  `/docs/en/agent-sdk/hooks` was not fetched, so the callback API surface itself is not covered here.
- **Plugin internals not covered.** `hooks/hooks.json` merging, `${user_config.*}`, and
  `CLAUDE_PLUGIN_OPTION_*` are described on the plugins pages, which were not fetched.
- **Silences in the reference**: it does not specify the order in which parallel hooks complete (it
  says the order is non-deterministic for `updatedInput`); it does not give a schema for `tool_input`
  of tools beyond the ones tabulated (`Bash`, `PowerShell`, `Write`, `Edit`, `Read`, `Glob`, `Grep`,
  `WebFetch`, `WebSearch`, `Agent`, `AskUserQuestion`, `ExitPlanMode`, plus `TaskCreate`/`TaskUpdate`
  referenced indirectly); and it does not state what happens if a settings file's `hooks` value has the
  wrong JSON shape.
- **`tool_input` schemas are tool-version-dependent**, so a parity implementation should treat them as
  pass-through data rather than validating against a fixed list.
