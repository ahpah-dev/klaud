# Claude Code: goals and checkpoints/rewind — exact semantics

Research target: Anthropic's official Claude Code documentation at `code.claude.com/docs`.
All findings below are transcribed from the pages listed in **Sources fetched**. Where the docs are
silent or ambiguous, that is stated explicitly. Two items are marked **[inference]** — they are
consistent readings of documented facts, not documented statements; do not treat them as spec.

---

## Sources fetched

| URL | Result |
| :- | :- |
| `https://code.claude.com/docs/llms.txt` | **200 OK.** Documentation index. Confirms the goal page is `en/goal.md`, the checkpoint page is `en/checkpointing.md`, and there is no page named `checkpoints`. |
| `https://code.claude.com/docs/en/goal.md` | **200 OK.** Raw markdown, complete. Primary source for goals. |
| `https://code.claude.com/docs/en/goal` | **200 OK but useless.** HTML shell, JavaScript-rendered; returned nav chrome only, body content truncated. The `.md` form is the only usable one, as the task brief predicted. |
| `https://code.claude.com/docs/en/checkpoints.md` | **404 Not Found.** Page does not exist. |
| `https://code.claude.com/docs/en/checkpoints` | **404 Not Found.** Page does not exist. The 404 body's "Related topics" linked to `en/checkpointing.md`. |
| `https://code.claude.com/docs/en/checkpointing.md` | **200 OK.** Complete. Primary source for checkpointing. |
| `https://code.claude.com/docs/en/agent-sdk/file-checkpointing.md` | **200 OK.** Complete. SDK-side checkpoint API, UUID semantics, CLI `--rewind-files`, and a limitations table. |
| `https://code.claude.com/docs/en/tools-reference.md` | **200 OK.** Full built-in tool list — used to establish that no goal tool exists. |
| `https://code.claude.com/docs/en/commands.md` | **200 OK.** Slash-command table, including `/goal` and `/rewind`. |
| `https://code.claude.com/docs/en/hooks-guide.md` | **200 OK.** Complete. Documents the prompt-hook `ok`/`reason`/`impossible` contract and the Stop-hook block cap that `/goal` rests on. |
| `https://code.claude.com/docs/en/hooks.md` | **200 OK, middle omitted.** The hooks reference page; several middle sections were dropped by the fetch, including the "Prompt-based hooks" reference section body. Facts attributed to it below were retrieved; the missing section is noted where relevant. |
| `https://code.claude.com/docs/en/env-vars.md` | **200 OK, middle truncated.** `CLAUDE_CODE_GOAL_CHECKIN_MINUTES` retrieved verbatim. The row for `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` was **not** retrieved (it falls in the omitted middle); its existence and purpose are documented on `hooks-guide.md`, which is cited instead. |
| `https://code.claude.com/docs/en/claude-directory.md` | **200 OK.** Source for the on-disk location and retention of checkpoint snapshots. |
| `https://code.claude.com/docs/en/sessions.md` | **200 OK.** Source for transcript storage and for "Active goal" appearing in the resume-restore list. |
| `https://code.claude.com/docs/en/interactive-mode.md` | **200 OK.** Source for the `Esc` `Esc` rewind binding and background/queue behavior. |
| `https://code.claude.com/docs/en/errors.md` | **200 OK, middle omitted.** The error-message index rows for the two rewind messages were retrieved verbatim; the **body text** of their sections ("Rewind warnings and errors" → `No files were restored`, `Restored the code, but skipped N files`) was **not** retrieved. See the note under Limitations. |
| `https://code.claude.com/docs/en/whats-new/2026-w20.md` | **200 OK.** Release note for `/goal` (v2.1.139) and for the "Summarize up to here" rewind option. |

**Not retrieved / does not exist:** `en/checkpoints.md`, `en/checkpoints`. The task brief's guess that
checkpointing "may use git internally" is **not supported by any retrieved page** — see §C2.

---

# 1. Goals

## G1. What a goal is

The user-facing feature is a **slash command**, `/goal`, documented as *"Set a completion condition
with `/goal` and Claude keeps working until it's met, a model judges it impossible, or an error you
have to fix clears the goal."*

Claude Code's own model of the feature (quoted): *"`/goal` is a wrapper around a session-scoped
[prompt-based Stop hook]."* The command sets a condition; after every turn, a **separate evaluator
model** checks whether the condition holds; if not, Claude starts another turn instead of returning
control to the user.

What distinguishes it from an ordinary prompt:

- An ordinary prompt produces one turn. A goal **removes the per-turn prompt**: the next turn starts
  when the previous one finishes, without user input.
- Completion is decided by **a fresh model, not the model doing the work**. Documented explicitly:
  *"the two are complementary: auto mode removes per-tool prompts, and `/goal` removes per-turn
  prompts"*, and *"completion is decided by a fresh model rather than the one doing the work."*
- It does **not** change the permission mode. Tool calls still prompt as configured; the docs
  recommend running `/goal` in auto mode for unattended operation.

Is it a persisted object, a prompt convention, or both? **It is a session-scoped command whose state
is recorded in the session transcript.** It is not a file-backed object with its own schema (see
§G3), and it is not merely a prompt convention — it drives an evaluator loop with its own state
(condition, elapsed time, turn count, token spend, latest reason, achieved/failed entries).

The docs distinguish three approaches to keeping a session running:

| Approach | Next turn starts when | Stops when |
| :- | :- | :- |
| `/goal` | The previous turn finishes, or, in an interactive session, an idle check-in or an automatic retry comes due | A model confirms the condition is met or judges it impossible, or a turn fails on an error you have to fix, or you run `/goal clear` |
| `/loop` | A time interval elapses | You stop it, or Claude decides the work is done |
| Stop hook | The previous turn finishes | Your own script or prompt decides |

Unlike a Stop hook, `/goal` is *"a session-scoped shortcut: you type a condition and it's active for
the current session only."* A Stop hook lives in a settings file and applies to every session in its
scope.

## G2. Lifecycle

### Creation

- `/goal <condition>` sets a goal. **If a goal is already active, the new one replaces it** — there is
  no separate "edit" operation.
- **One goal can be active per session.**
- Setting a goal **starts a turn immediately, with the condition itself as the directive**. No
  separate prompt is needed.
- The condition **may be up to 4,000 characters**.
- While active, a `◎ /goal active` indicator shows how long the goal has been running.

### The "rounds" / continuation concept

The docs' unit is a **turn**, and the operative counter is **turns evaluated**.

- After each turn the evaluator is called; a "not yet met" verdict starts another turn.
- The status view reports how many turns have been evaluated.
- The turn count and most recent reason appear **after the first evaluation has run**.
- A goal can be bounded from inside the condition: *"To bound how long a goal runs, include a turn or
  time clause in the condition, such as `or stop after 20 turns`. Claude reports progress against that
  clause each turn and the evaluator judges it from the conversation."* — i.e. **the cap is enforced
  by the evaluator reading the conversation, not by a hard turn limit in the runtime.** The condition
  text is the only documented user-set cap.

**Is there a cap, and can the user set it?** There is no documented runtime turn cap for a goal. The
only user-settable bound is a clause written into the condition (above). What *does* exist is a
no-progress circuit breaker (below), which stops the loop without ending the goal.

### Verdicts

Each evaluation returns **one of three verdicts, each with a short reason**:

| Verdict | Effect |
| :- | :- |
| **Not yet met** | Claude keeps working and **takes the reason as guidance for the next turn**. |
| **Met** | Claude Code clears the goal and **records an achieved entry in the transcript**. |
| **Impossible** | The evaluator judged the condition can never be satisfied. Claude Code clears the goal and **records a failed entry in the transcript along with the reason**. The user does not need to clear it. |

The transcript shows **each verdict** the evaluator returns; `Ctrl+O` reveals the reason behind it.
The status view also shows the most recent reason.

### Completion, and the states that are *not* "blocked"

**There is no "blocked" state in Claude Code's goal model.** The task brief asked what "complete" and
"blocked" require and whether a minimum number of rounds gates "blocked". Answer: **no such gate is
documented, because no "blocked" verdict exists.** The nearest analogues are:

1. **Impossible verdict** — ends the goal, recorded as a failed entry. No minimum-round requirement is
   documented.
2. **Paused** — the goal stays set but stops auto-continuing (see below).
3. **No-progress stop** — the loop stops, the goal stays set, control returns to the user (below).

### The no-progress circuit breaker

Documented: *"If Claude keeps answering the evaluator without making progress (no tool use for several
turns in a row), Claude Code stops the loop, prints a warning, and returns control to you with the
goal still set. Evaluation resumes after your next prompt."*

The underlying mechanism is the Stop-hook block cap, documented on the hooks guide as: *"Claude Code
overrides a Stop hook after it blocks **eight** times in a row with no tool call from Claude in
between."* The hook input carries `stop_hook_active`, which a hook is told to check to avoid
re-triggering. The cap is raised with **`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`**. So the de facto
no-progress threshold is **8 consecutive evaluator blocks with no tool call**.

### Turn failure handling

Two classes of failure, with opposite effects:

**Errors you have to fix clear the goal.** Claude Code clears the goal and prints a warning that
**starts with `Goal cleared after an unrecoverable error` and ends with `Run /goal again to continue`.**
Exactly four kinds of failure do this:

1. An authentication failure, **when Claude Code manages its own credentials**. When a host manages
   them (desktop app, cloud session), Claude Code leaves the goal active because the host restores
   access on its own.
2. An exhausted credit balance.
3. A context overflow that auto-compaction couldn't clear.
4. A model that isn't available.

**Other errors retry or pause the goal.** After any other failure the goal stays set. In an
interactive session on Claude Code v2.1.269 or later, Claude Code prints a line naming the cause and
either retries on its own or waits:

- **Retry**: after a failure that tends to clear on its own (overloaded server, dropped connection), a
  notice **starting with `Goal still active`** shows the wait before the next attempt.
  **After three automatic retries, the goal pauses instead.**
- **Pause**: after a failure a retry would only repeat — an API rate limit, a claude.ai usage limit, or
  a hook that ended the turn — a notice **starting with `Goal paused`** names the cause. If the session
  is waiting to continue automatically when a usage limit resets, Claude resumes work toward the goal
  then.

Sending a message at any time starts the next turn immediately.

### Background work defers evaluation

- If a **subagent or background shell command is still running when a turn ends, Claude Code skips the
  evaluation for that turn.** It evaluates at the end of the next turn that finishes with no background
  work running.
- When the background work finishes, Claude Code delivers the result to Claude as a new turn.
- **Check-ins:** once background work has kept the goal waiting **30 minutes** (the default), a check-in
  is due. In it, Claude Code lists the running tasks and asks Claude to read their output, keep waiting
  if they're progressing, and fix or stop anything stuck.
- **Backoff:** after the first check-in, Claude Code waits **twice as long** before each later check-in,
  **up to four times the first interval**. With the default: **1 hour** after the first check-in, then
  **every 2 hours**.
- **Delivery:** a due check-in is delivered either at the end of the next turn that finishes with the
  work still running (the **only** way in a non-interactive `-p` session), or, in an interactive
  session, by starting a turn on its own while the session is idle.
- **Idle check-in cap:** Claude Code starts **at most three idle check-ins per goal between your
  prompts**; in the third, it says idle check-ins are paused until you send another prompt. Before
  v2.1.246, idle check-ins were uncapped. Idle check-ins require v2.1.236 or later.
- Before v2.1.239, only idle check-ins backed off this way; a check-in delivered at a turn end recurred
  at the first interval.
- Check-ins require Claude Code v2.1.234 or later.

### Configuration

- **`CLAUDE_CODE_GOAL_CHECKIN_MINUTES`** — verbatim from the environment-variables reference: *"How many
  minutes background work can keep an active goal waiting before Claude Code asks Claude to check on it.
  Default `30`. Set `0` to turn check-ins off. Give whole minutes in plain digits, at most `10080`, which
  is one week. Claude Code treats any other value as unset and uses the default. Requires Claude Code
  v2.1.234 or later."*
- Setting it to `0` **also turns automatic retries off**.
- **Evaluation model:** the goal document says to set `ANTHROPIC_DEFAULT_HAIKU_MODEL` to evaluate on a
  different model, with a warning that Claude Code reads that variable *"everywhere it uses the small
  fast model, not only for `/goal` evaluation"* — it also resolves the `haiku` alias to that model and
  runs background functionality such as conversation summarization on it. The evaluator **runs on
  whichever provider the session is configured for**.
- **Cost:** evaluation tokens are billed on the small fast model and are *"typically negligible compared
  to main-turn spend."*

### Availability requirements

`/goal` is available *"under the same workspace trust rule as hooks in settings files, because the
evaluator is part of the hooks system."* It is **unavailable** when `disableAllHooks` is `true` after
settings precedence applies, or when `allowManagedHooksOnly` is set in managed settings. In each case
the command tells you why instead of silently doing nothing.

## G3. How a goal is stored

**The documentation never names a file, directory, or format for a goal.** What is documented:

- The goal is **session-scoped**: *"you type a condition and it's active for the current session only."*
- **Verdicts, achieved entries, and failed entries are recorded in the transcript.** The achieved case
  is *"records an achieved entry in the transcript"*; the impossible case is *"records a failed entry in
  the transcript along with the reason."*
- The **`sessions.md` resume page lists "Active goal" among the state restored from the transcript**:
  *"Active goal: a goal that was still active when the session ended carries over; its turn count,
  timer, and token-spend baseline reset."*
- Transcripts are stored as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`, where
  `<project>` is the working directory path with non-alphanumeric characters replaced by `-`. **The
  per-line entry format is internal to Claude Code and changes between versions**; the docs explicitly
  warn that scripts parsing these files directly can break on any release.
- `claude-directory.md`'s two exhaustive application-data tables list **no goal directory or file**.
  That absence, plus the transcript statements above, is the evidence that goal state lives in the
  session transcript rather than a dedicated store. **Exact field names are not documented.**

### What survives a restart

Documented resume behavior, quoted in full: *"When you resume a session, Claude Code restores a goal
that was still active when the session ended. Claude Code restores it on every resume route:
`--continue`, `--resume` with a session ID, name, or transcript file path, and the session picker.
Before v2.1.239, Claude Code restored the goal on every route except the `claude --resume` picker."*

Critical asymmetry: *"Claude Code carries the condition over but **resets the turn count, timer, and
token-spend baseline**. It doesn't restore a goal that was already achieved or cleared."*

So a resumed goal is the **condition only** — all progress metrics restart.

`claude purge` deletes transcripts under `projects/`, which is where goal state lives; deleting
`~/.claude/projects/` loses *"Resume, continue, and rewind for past sessions"* per the
claude-directory table.

## G4. The tool surface

**There is no goal tool.** The tools reference (`en/tools-reference.md`) enumerates every built-in
tool — including `Agent`, `AskUserQuestion`, `CronCreate/Delete/List`, `ScheduleWakeup`, `TaskCreate`,
`TaskGet`, `TaskList`, `TaskUpdate`, `ReadMcpResourceTool`, and others. **No `create_goal`, `get_goal`,
`update_goal`, or any other goal-named tool appears in that table, and "goal" does not appear anywhere
in the tools reference page.** The documentation index (`llms.txt`) mentions goals on exactly two
pages: `en/goal.md` and the week-20 release note. The model is therefore **not** given goal tools and
cannot set, read, or clear a goal itself — the human drives it through `/goal`.

**The model-facing surface is the Stop hook contract**, not a goal API:

- Hook input for `Stop` includes the boolean field **`stop_hook_active`**.
- A `type: "prompt"` hook returns its decision as JSON: `"ok": true` (the action proceeds) or
  `"ok": false`.
- For `Stop` and `SubagentStop`: on `ok: false`, *"the `reason` is fed back to Claude so it keeps
  working, **unless the response also sets `"impossible": true`** to mark the condition as one that can
  never be satisfied, in which case Claude Code allows the stop and the turn ends."*
- Prompt-hook fields (from the hooks reference's "Prompt and agent hook fields"): `prompt` (required;
  `$ARGUMENTS` is the placeholder for the hook input JSON, escape with a backslash for a literal) and
  `model` (optional; defaults to the model Claude Code uses for background functionality). Prompt hooks
  have a **30-second default timeout**.
- The hooks guide shows the canonical Stop-hook form:
  `{"ok": false, "reason": "what remains to be done"}`.

**[inference]** The three documented goal verdicts map onto the documented prompt-hook response fields
as: Met = `ok: true`; Not yet met = `ok: false`; Impossible = `ok: false` + `"impossible": true`. The
goal page states `/goal` "is a wrapper around a session-scoped prompt-based Stop hook" and the hooks
guide defines exactly three outcomes for a prompt-based Stop hook with that field set, so the mapping is
strongly implied — but **no retrieved page states the mapping explicitly.**

### What "complete" and "blocked" require

- **Complete:** a positive verdict from the evaluator model. Nothing else. There is no tool call the
  working model makes, no minimum number of rounds, and no user confirmation.
- **Blocked:** does not exist as a state. See §G2.
- **Automatic continuation:** yes, and it is the core of the feature. Another round starts automatically
  when the previous turn finishes (or when an idle check-in / automatic retry comes due). It is halted
  by: a Met verdict, an Impossible verdict, one of the four unrecoverable errors, a pause, the
  8-block no-progress cap, or `/goal clear`.

## G5. Interaction with the user

| Operation | Surface |
| :- | :- |
| **Set** | `/goal <condition>`. Starts a turn immediately with the condition as the directive. Replaces any active goal. |
| **Display (inline)** | A `◎ /goal active` indicator showing how long the goal has been running. The transcript shows each evaluator verdict; `Ctrl+O` shows the reason behind it. |
| **Status** | `/goal` with no arguments. When active, shows: the condition, how long it has been running, how many turns have been evaluated, the current token spend, and the evaluator's most recent reason. If none is active but one was achieved earlier in the session, it shows the achieved condition with its duration, turn count, and token spend. |
| **Clear / abandon** | `/goal clear`. Prints `Goal cleared:` followed by the condition, or `No goal set` if nothing was active. Accepted aliases: `stop`, `off`, `reset`, `none`, `cancel`. Running `/clear` to start a new conversation **also removes any active goal**. |
| **Pause** | Not a user command. Claude Code pauses the goal itself after a failure that a retry would only repeat, or after three automatic retries of a failure that tends to clear on its own. The notice starts with `Goal paused`. |
| **Resume** | Automatic: the goal resumes when a usage-limit wait ends, or when the user sends a message (which starts the next turn immediately). A **paused** goal resumes on automatic continue after a usage-limit reset. A session resume restores an active goal's condition. |
| **Edit** | There is no edit operation. Setting a new condition replaces the old goal wholesale. |
| **Non-interactive** | `claude -p "/goal CHANGELOG.md has an entry for every PR merged this week"` runs the loop to completion in a single invocation. With default text output, Claude's final response prints only when the loop ends, so a long goal can look stuck; add `--output-format stream-json --verbose` to emit each message as it runs. `Ctrl+C` interrupts a non-interactive goal. |
| **Other surfaces** | `/goal` works in non-interactive mode, in the desktop app, and through Remote Control. Release note (v2.1.139) confirms interactive, `-p`, and Remote Control. |

## G6. Goals — easy to get wrong

1. **No goal tools exist.** A parity implementation that invents `create_goal` / `get_goal` /
   `update_goal` is adding a surface Claude Code does not have. In Claude Code the human owns the goal
   lifecycle; the model only experiences it as a Stop hook that keeps blocking the turn.
2. **There is no "blocked" state and no rounds-before-blocked gate.** The three verdicts are
   not-yet-met / met / impossible. Conflating "impossible" with a user-visible "blocked" state, or
   requiring N rounds before accepting it, is not what the docs describe.
3. **The evaluator cannot run tools or read files.** It judges *only what Claude has already surfaced in
   the conversation*. Writing a condition that a tool-using verifier could check (e.g. "the file on disk
   contains X" where Claude never printed it) will not work. This is the single most likely design
   mistake: a naive implementation would hand the evaluator file-read or bash access, which is a
   materially more powerful — and different — feature.
4. **Completion is judged by a different, small/fast model**, not the model doing the work, and it runs
   on the session's provider. Cost lands on the small-fast-model bucket; overriding the model with
   `ANTHROPIC_DEFAULT_HAIKU_MODEL` has global side effects (it also moves the `haiku` alias and all
   background functionality such as summarization).
5. **Turn count, timer, and token-spend baseline reset on resume; the condition does not.** Achieved and
   cleared goals are *not* restored. So "resume restores the goal" is only half true.
6. **The two failure classes are inverted from intuition.** Unrecoverable-looking errors (auth, credits,
   context overflow, missing model) **destroy** the goal, while transient errors (overload, dropped
   connection, rate limit, usage limit) **preserve** it. The auth case is host-dependent: with
   host-managed credentials the goal deliberately stays active.
7. **The 8-block no-progress cap is a Stop-hook property, not a goal property.** The counter is
   consecutive blocks with **no tool call in between** — Claude answering the evaluator in prose without
   acting trips it. A naive "max rounds" counter is a different (and wrong) guard.
8. **Background work suspends evaluation rather than counting as a turn**, and idle check-ins are capped
   at three per goal between user prompts, with backoff to 4× the first interval. Retry vs pause is a
   distinction (three retries, then pause) that a simple retry loop would miss.
9. **A goal does not change the permission mode.** Turns still stop on permission prompts. Unattended
   operation requires auto mode separately.
10. **Availability is coupled to hooks**: `disableAllHooks` and managed `allowManagedHooksOnly` both
    disable `/goal`, and it obeys the hooks workspace-trust rule.
11. **Condition length is capped at 4,000 characters**, and the only bound on run length is a clause
    inside the condition that the evaluator interprets.

---

# 2. Checkpoints / rewind

## C1. What is actually captured, and when (the boundary)

Two distinct statements in the docs describe the capture boundary, and both matter:

**The restore point is per prompt that starts a turn.** *"As you work with Claude, checkpointing
automatically captures the state of your code **before each prompt you send that starts a turn**."* And
under Automatic tracking: *"Every prompt you send that starts a turn creates a new checkpoint."*

**The snapshot files themselves are per-file pre-edit backups.** Per the SDK page: *"When you enable
file checkpointing, the SDK creates backups of files **before modifying them** through the Write, Edit,
or NotebookEdit tools."* And the interactive page: *"Claude Code tracks all changes made by its file
editing tools."*

So the correct mental model is: **files are backed up at edit time; the named, selectable checkpoint is
the turn boundary created by a user prompt.** It is *not* a whole-tree snapshot before every edit, and
it is *not* a snapshot after every turn.

The rewind menu confirms the anchoring: *"The rewind menu lists **the prompts you sent during the
session**."*

### What is NOT captured

- **Bash-command file changes.** Documented with examples: *"Checkpointing does not track files modified
  by Bash commands. For example, if Claude Code runs `rm file.txt`, `mv old.txt new.txt`,
  `cp source.txt dest.txt` — these file modifications cannot be undone through rewind. Only direct file
  edits made through Claude's file editing tools are tracked."* The SDK limitation table repeats it:
  *"Write/Edit/NotebookEdit tools only."*
- **Subagent edits, usually.** See §C5.
- **External / manual changes.** *"Checkpointing only tracks files that have been edited within the
  current session. Manual changes you make to files outside of Claude Code and edits from other
  concurrent sessions are normally not captured, unless they happen to modify the same files as the
  current session."*
- **Messages typed mid-turn.** *"Checkpoints are taken for prompts that start a turn, so this message has
  none of its own."* Such a message can be marked **`No code restore`** in the menu. The edits Claude
  made after reading it count toward the prompt that started the turn. Selecting the marked message still
  offers **Restore conversation**.
- **Symlinked and hard-linked paths are not restored** — see §C4.

**Is a naive "copy the file before writing" implementation equivalent?** **No.** It captures the right
*bytes* (pre-edit content of files touched by file-editing tools) but misses four things: (a) the
restore granularity is a prompt-that-started-a-turn, not an edit; (b) the selection UI is a list of
prompts; (c) a per-session retention cap of 100 checkpoints with a pruning rule; (d) the deliberate
exclusion of Bash-modified files, which a copy-on-write hook would silently include, making rewind
*more* powerful than documented and diverging on symlink/hard-link handling.

## C2. What a checkpoint contains, and where it is stored

**Both file contents and conversation state, stored in two different places.**

**File snapshots:** `~/.claude/file-history/<session>/`, described verbatim in the `.claude` directory
reference as *"Pre-edit snapshots of files Claude changed, used for checkpoint restore. Holds snapshots
for the 100 most recent checkpoints; snapshot files that no retained checkpoint references are deleted,
except **each file's first snapshot**."* The parenthetical purpose of that exception: the first snapshot
*"the VS Code extension uses as the baseline for its session diffs."*

**Conversation:** *"Claude Code saves checkpoints with the conversation, so you can still run `/rewind`
after you resume a session."* The conversation itself lives in the JSONL transcript at
`~/.claude/projects/<project>/<session-id>.jsonl`. `sessions.md` confirms the pairing indirectly:
deleting `~/.claude/projects/` loses *"Resume, continue, and rewind for past sessions"*, and deleting
`~/.claude/file-history/` loses *"Checkpoint restore for past sessions"*.

**Is it a shadow git repository?** **The retrieved documentation never mentions git as the checkpoint
mechanism, in any of the fetched pages.** The only documented storage is the `file-history/<session>/`
directory of plain snapshot files, plus state carried in the session transcript. The task brief's
hypothesis that the docs describe an internal git repository is **not supported by the pages fetched**
(`checkpointing.md`, `agent-sdk/file-checkpointing.md`, `claude-directory.md`). Git *is* mentioned in
the docs in two adjacent but different ways: as the recommended tool for permanent version history
(*"Checkpoints are designed for quick, session-level recovery… continue using version control, such as
Git"*), and as the source for `/diff`'s working-tree and per-turn views (*"In the changes `/diff` reads
from git"*). Neither is the checkpoint store. **If a shadow repo exists, the documentation does not say
so** — do not implement one on the belief that the docs require it.

### Retention and the 100-checkpoint cap

- **100 most recent checkpoints per session.** Discarding an older checkpoint deletes the snapshot files
  that no remaining checkpoint references — except each file's first snapshot.
- **Age-based deletion:** *"Claude Code deletes a session's file snapshots in the retention sweep, by
  default about 30 days after the session last saved one. Rewinding to a checkpoint whose snapshots are
  gone can fail with `No files were restored`. To keep snapshots longer, set `cleanupPeriodDays`."*
- `cleanupPeriodDays` default is 30 days, **minimum 1**; setting `0` **fails with a validation error**.

## C3. How restore / rewind works from the user's side

**Entry points:** `/rewind`, or **`Esc` twice when the prompt input is empty**. Aliases: `/checkpoint`,
`/undo`.

A binding subtlety: *"If the prompt input contains text, double `Esc` clears it instead of opening the
menu. The cleared text is saved to your input history, so press `Up` to recall it after you finish in
the rewind menu."*

**Granularity:** a **prompt that started a turn** — i.e. whole turns, not individual messages. The menu
lists the prompts sent during the session; select the point you want to act on, then choose an action.

**The six actions, verbatim:**

| Action | Effect |
| :- | :- |
| **Restore code and conversation** | Revert both code and conversation to that point |
| **Restore conversation** | Rewind to that message while keeping current code |
| **Restore code** | Revert file changes while keeping the conversation |
| **Summarize from here** | Compress the conversation from this point forward into a summary, freeing context window space |
| **Summarize up to here** | Compress the conversation before this point into a summary, keeping later messages intact |
| **Never mind** | Return to the message list without making changes |

**So yes: code only, conversation only, or both are all independently selectable.**

Conditional availability: *"The two code restore options appear only when the selected checkpoint has
tracked file changes to revert. If no file edits were captured after that point, the menu offers only
**Restore conversation**, the summarize options, and **Never mind**."*

Other documented behaviors:

- After restoring the conversation, or after choosing **Summarize from here**, *"the original prompt from
  the selected message is restored into the input field so you can re-send or edit it."*
- **Summarize up to here** *"leaves you at the end of the conversation with the input empty."*
- With either summarize option, a **`Summarized conversation`** marker appears where the compressed
  messages were.
- **Guiding a summary:** highlight a **Summarize** option with the arrow keys, type instructions where
  the row reads **add context (optional)**, then press `Enter`. Selecting with its number key summarizes
  immediately without instructions.
- **Summarizing does not change files on disk, and the original messages stay in the session
  transcript**, so Claude can still reference the details. It stays in the same session and compresses
  context, *"like a targeted `/compact`."*

### Rewind past a cleared conversation

*"If you ran `/clear` earlier in the same Claude Code process, the rewind menu shows an additional entry
at the top of the list labeled `/resume <session-id> (previous session)`. Select it to resume the
conversation that was active before `/clear` ran. The entry is available until you exit Claude Code or
resume a different session."*

### The SDK / programmatic surface

Distinct option names and a files-only rewind:

- Enable with `enable_file_checkpointing=True` (Python) / `enableFileCheckpointing: true` (TypeScript).
- **Checkpoint identity is a user-message UUID.** With `extra_args={"replay-user-messages": None}` /
  `extraArgs: { "replay-user-messages": null }`, each user message in the response stream carries a UUID
  that serves as a checkpoint. Capturing the **first** user message UUID and rewinding to it restores
  tracked files to their original state.
- Restore with `rewind_files()` (Python) / `rewindFiles()` (TypeScript). To rewind after the stream
  completes, **resume the session with an empty prompt `""`** and enable checkpointing on the resumed
  options too.
- **The SDK rewind is files-only:** *"File rewinding restores files on disk to a previous state. It does
  not rewind the conversation itself. The conversation history and context remain intact after calling
  `rewindFiles()`."*
- It *"deletes the files it created and restores the files it modified to their content at that point."*
- CLI equivalent: `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true claude -p --resume <session-id>
  --rewind-files <checkpoint-uuid>`. On success it prints `Files rewound to state at message
  <checkpoint-uuid>` and **exits without sending a prompt**. *"The `--rewind-files` flag doesn't appear
  in `claude --help` output, but the CLI accepts it as shown."*
- `RewindFilesResult` reports skipped paths in its **`skippedLinks`** field.
- Documented SDK error messages: `No file checkpoint found for this message` (checkpointing wasn't
  enabled on the original session), `File rewinding is not enabled` (non-interactive rewind without
  checkpointing enabled — the bare CLI never sets the env var), and `ProcessTransport is not ready for
  writing` (calling rewind after the response loop finished).

## C4. Limitations

| Limitation | Detail |
| :- | :- |
| **Bash command changes not tracked** | `rm`, `mv`, `cp`, `echo >`, `sed -i` etc. cannot be undone through rewind. Only file-editing tools. |
| **Subagent edits not restored** | See §C5 for the exact split. |
| **External changes not tracked** | Manual edits outside Claude Code and edits from other concurrent sessions are normally not captured, unless they modify the same files as the current session. |
| **Messages sent mid-turn not checkpointed** | Marked `No code restore`; no checkpoint of their own. |
| **Symlinked and hard-linked paths not restored** | *"When you pick **Restore code** or **Restore code and conversation** from the `/rewind` menu, Claude Code skips any tracked path that is a symlink or hard link and shows a `Restored the code, but skipped N files` warning. The skipped files keep their current contents."* Examples given: dotfile-manager symlinks, pnpm hard links. To see which paths are skipped, enable `/debug` before restoring — the debug log at **`~/.claude/debug/<session-id>.txt`** names each skipped path. |
| **Not a replacement for version control** | *"Checkpoints are designed for quick, session-level recovery. For permanent version history and collaboration, continue using version control, such as Git."* |
| **SDK additions** | *"Checkpoints are tied to the session that created them"*; *"File content only — creating, moving, or deleting directories is not undone by rewinding"*; *"Local files — remote or network files are not tracked."* |
| **SDK skip reasons** | Skips a tracked path that is a symlink, hard link, or other non-regular file; a tracked file whose parent directory no longer resolves to its checkpoint-time location; and a tracked file whose backup it can't read safely. Skipping requires **v2.1.216 or later**; *"before v2.1.216, a rewind wrote and deleted through links at tracked paths."* |

**Documented error strings** (from the error-reference index):

- `No files were restored: N files failed (backup missing, or the file could not be updated)`
- `Restored the code, but skipped N files`

**Note on a gap:** the error reference page was fetched with its middle omitted, so only these two index
rows and the section titles ("Rewind warnings and errors", "Restored the code, but skipped files", "No
files were restored") were retrieved — **the full body text of those two sections was not retrieved**,
and I am not reconstructing it from memory. The behavioral content above comes from `checkpointing.md`,
which documents both situations directly.

### Do checkpoints survive a session ending?

**Yes, with an age limit.** *"Claude Code saves checkpoints with the conversation, so you can still run
`/rewind` after you resume a session."* But the file snapshots are deleted by the retention sweep about
**30 days after the session last saved one** (configurable via `cleanupPeriodDays`), and rewinding to a
checkpoint whose snapshots are gone *"can fail with `No files were restored`."* The 100-most-recent
per-session cap also applies across resumes.

## C5. Interaction with other features

### Hooks

**No hook event exists for checkpoint creation, rewind, or restore.** The hooks reference enumerates the
complete event list — session-level (`SessionStart`, `SessionEnd`), turn-level (`UserPromptSubmit`,
`Stop`, `StopFailure`), per-tool-call (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`), plus
`PostToolBatch`, `PreCompact`/`PostCompact`, `SubagentStart`/`SubagentStop`, `FileChanged`, and others.
**There is no checkpoint or rewind event among them, and the checkpointing pages never mention hooks.**
So hooks cannot observe or veto a rewind. What hooks *do* affect is the underlying file content: a
`PostToolUse` formatter rewrites the working tree while the checkpoint snapshot still reflects the
pre-edit content, so restoring the code returns the file to its pre-Claude state, not to the formatted
intermediate. (That consequence follows from the documented snapshot timing; the docs do not state it
in these words.)

### Subagents

Documented in detail, and **the rule is not a simple yes/no**:

- **Foreground forked skill:** *"a skill with `context: fork` that runs in the foreground edits your
  working tree during your own turn, so rewinding restores its edits as usual. Set `background: false`
  to run a fork in the foreground; a few situations, listed on the skills page, run it there regardless
  of the setting."*
- **Any other subagent:** *"rewinding restores only the files Claude had already edited in your
  conversation. The subagent's edits to other files stay, so use git to revert them. This includes a
  forked skill that runs in the background, **the default**, and a background `/code-review --fix`
  run."*

The SDK page states the same restriction in its limitation table: subagent edits aren't tracked except a
foreground `context: fork` skill, and *"A rewind reverts them only in files the main conversation had
already edited; use git to revert the rest."*

### Background tasks

The only documented background interaction is the subagent rule above. **The docs are silent on any
other background-task interaction with checkpointing.** Since Bash-command changes are not tracked at
all, background Bash work is out of scope by construction; that reasoning is mine, the docs do not say
it.

### Compaction

The checkpoint menu **is** one of the compaction surfaces:

- **Summarize from here** and **Summarize up to here** are checkpoint-menu actions described as
  compressing the conversation, i.e. context management.
- Summarizing *"keeps you in the same session and compresses context, like a targeted `/compact`."*
- A **`Summarized conversation`** marker appears in the conversation where the compressed messages were.
- *"Summarizing doesn't change files on disk, and the original messages stay in the session transcript,
  so Claude can still reference the details."*
- The docs **contrast** summarize with `/branch` and `claude --continue --fork-session`, which branch off
  while preserving the original session.
- Related but separate: the task list *"persists across context compactions."*

**Not documented:** whether an auto-compaction or `/compact` invalidates or drops checkpoints. The
retention rules the docs give are the 100-checkpoint cap and the ~30-day sweep only. Treat
"compaction interacts with checkpoints" as **silent in the docs**.

### `/clear`, branching, and purge

- `/clear` starts a new conversation and removes any active goal; the rewind menu's
  `/resume <session-id> (previous session)` entry lets you reach the pre-`/clear` conversation from
  inside the same process.
- The sessions page points at checkpointing as the in-session alternative to branching: *"For
  checkpoint-based rewind within a single session, see Checkpointing."* `/branch` and
  `claude --continue --fork-session` copy the conversation into a new session with its own session ID
  instead.
- `claude purge` (formerly `claude project purge`) deletes *"Per-session `tasks/`, `debug/`, and
  `file-history/` entries"*, the project's transcripts and auto memory, matching `history.jsonl` lines,
  and the project's `~/.claude.json` entry — so it destroys both halves of checkpoint state for that
  project.

## C6. Checkpoints — easy to get wrong

1. **The restore boundary is a prompt that starts a turn, and the snapshot boundary is an edit.** These
   are two different events. A "snapshot every file before every write" design gets the bytes right but
   the selectable granularity, the menu contents, the pruning rule, and the first-snapshot baseline
   wrong.
2. **Bash-command changes are deliberately not reversible.** This is the most consequential omission: a
   naive copy-on-write implementation that hooks *all* file mutation (e.g. by watching the filesystem)
   would revert things Claude Code refuses to revert, including `rm`/`mv`/`cp`.
3. **No shadow git repo is documented.** Implement `~/.claude/file-history/<session>/`-style pre-edit
   snapshots plus conversation-anchored checkpoints, or state explicitly that you are diverging. Do not
   claim the docs specify a git backend — they don't.
4. **The three restore modes are independent**, and the two code modes are *conditionally present* in
   the menu. Code-only and conversation-only are both first-class, so code and conversation state must
   be separately addressable.
5. **Files that Claude created are deleted on rewind**, and modified files are restored to their content
   at that point. It is not a "restore every tracked file from a manifest" operation.
6. **A partial restore is a normal, warned outcome, not a failure.** Symlinks, hard links, unresolvable
   parent directories, and unreadable backups are skipped, with the count surfaced
   (`Restored the code, but skipped N files`, or `No files were restored: N files failed…`). Pre-v2.1.216
   builds wrote and deleted *through* links, which is a materially different and dangerous behavior.
7. **The 100-checkpoint cap has a carve-out** — each file's first snapshot is retained even when
   unreferenced, because the VS Code extension uses it as the session-diff baseline. A naive LRU prune
   breaks that.
8. **Retention is time-based and shared with the transcript sweep** (~30 days, `cleanupPeriodDays`,
   minimum 1, `0` rejected). Rewind can therefore fail long after a session ended with
   `No files were restored`.
9. **Checkpoints follow the conversation across a resume, but only within the 100-cap and retention
   window.** Surviving a restart is not the same as surviving indefinitely.
10. **The SDK rewind is files-only and needs a UUID from the response stream** gated behind the
    `replay-user-messages` extra arg, plus a resume-with-empty-prompt dance to rewind after the stream
    completes. Its checkpoint identity (a user-message UUID) is not the same as the interactive menu's
    notion of a checkpoint.
11. **Subagent restores are conditionally partial**, and the condition is *foreground vs background*
    plus *forked skill vs other subagent* — with background being the default. Restoring "only files the
    main conversation had already edited" is a subtle rule that a simple snapshot design will not
    reproduce.
