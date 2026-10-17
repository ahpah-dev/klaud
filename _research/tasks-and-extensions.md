# Claude Code: scheduled tasks, background tasks, extension surfaces

Research for a parity implementation. Everything below is transcribed from the pages listed under
"Sources fetched"; nothing is from memory. Where the docs are silent or contradictory it says so
explicitly in **Gaps / ambiguities** at the end.

---

## Sources fetched

| # | URL | Result |
| - | --- | ------ |
| 1 | `https://code.claude.com/docs/llms.txt` | OK (HTTP 200). Documentation index — used to correct wrong URL guesses. |
| 2 | `https://code.claude.com/docs/en/scheduled-tasks.md` | OK. **Not** what the name suggests: this is in-session `/loop` + cron tools. |
| 3 | `https://code.claude.com/docs/en/desktop-scheduled-tasks.md` | OK. Found via index. This is the real Desktop scheduled-task page. |
| 4 | `https://code.claude.com/docs/en/routines.md` | OK. Cloud (Anthropic-managed) scheduled/API/GitHub-triggered sessions. |
| 5 | `https://code.claude.com/docs/en/headless.md` | OK. `claude -p`, `--bare`, background-at-exit, SIGTERM. |
| 6 | `https://code.claude.com/docs/en/sub-agents.md` | OK. Full page incl. frontmatter reference (read from the un-truncated fetch payload). |
| 7 | `https://code.claude.com/docs/en/skills.md` | OK. Full page incl. frontmatter reference. |
| 8 | `https://code.claude.com/docs/en/plugins/overview.md` | OK. |
| 9 | `https://code.claude.com/docs/en/plugins/components.md` | OK. Component-by-component authoring reference. |
| 10 | `https://code.claude.com/docs/en/plugins/loading.md` | OK (found via index). Discovery/settings-precedence/on-disk layout. |
| 11 | `https://code.claude.com/docs/en/plugins/cli-reference.md` | OK (found via index). `/reload-plugins` semantics, `--plugin-dir`, `claude plugin validate`. |
| 12 | `https://code.claude.com/docs/en/tools-reference.md` | OK. Background commands, Monitor, TaskStop, TaskOutput removal, tool permission table. |
| 13 | `https://code.claude.com/docs/en/interactive-mode.md` | OK. `Ctrl+B`, backgrounding, `/tasks` vs task list. |
| 14 | `https://code.claude.com/docs/en/commands.md` | OK. `/tasks`, `/loop`, `/schedule`, `/reload-skills`, `/reload-plugins`, `/subtask`, `/background`. |
| — | HTML variants (`…/scheduled-tasks` without `.md`) | **Not fetched.** The `.md` form worked for every page; the user-supplied HTML URL was skipped deliberately. |
| — | `hooks.md`, `permissions.md`, `agent-sdk/subagents.md`, `plugins/manifest-reference.md` | **Not fetched.** Hook-event details come from the sub-agents page and the plugin components page, which document plugin hooks and frontmatter hooks. Plugin manifest `defaultEnabled`/`dependencies` were treated as already implemented per the brief. |

Every fetch above returned HTTP 200; there were no failures. Two long pages (sub-agents, skills) were
truncated in the tool display and read back in full from the saved fetch payloads, so the frontmatter
tables below are complete rather than cut off.

---

# 1. Scheduled tasks

## 1.1 There are three separate features. The naming is a trap.

`/docs/en/scheduled-tasks` is **not** the Desktop feature and is **not** called "scheduled tasks" in
product terms — its title is *"Run prompts on a schedule"* and it documents `/loop` plus the
`CronCreate` / `CronList` / `CronDelete` tools. The page itself opens with a comparison table of three
scheduling mechanisms:

| | Cloud (**Routines**) | Desktop (**scheduled tasks**) | **`/loop`** |
| :- | :- | :- | :- |
| Runs on | Cloud, Anthropic-managed by default | Your machine | Your machine |
| Requires machine on | No | Yes | Yes |
| Requires open session | No | No | Yes |
| Persistent across restarts | Yes | Yes | Restored on `--resume`, with exceptions |
| Access to local files | No (fresh clone) | Yes | Yes |
| MCP servers | Connectors configured per task | Config files and connectors | Inherits from session |
| Permission prompts | No (runs autonomously) | Configurable per task | Inherits from session |
| Customizable schedule | Via `/schedule` in the CLI | Yes | Yes |
| Minimum interval | 1 hour | 1 minute | 1 minute |

Direct answers to the five questions you asked:

1. **Feature ownership.** There *is* a CLI-level equivalent: `/loop` + the cron tools, entirely
   in-session. The *Desktop* scheduled task is Desktop-only (Claude Code Desktop ≥ 1.1.5368), driven
   from the **Routines** page in the **Code** tab. A third, cloud-hosted variant (**Routines**, research
   preview) is created from `claude.ai/code/routines`, the Desktop app, or the CLI `/schedule` command.
   A fourth, edge-case variant: a repository can ship a GitHub Actions `schedule` trigger.
2. **Schedule format.** CLI cron tools take **standard 5-field cron**. `/loop` takes natural-language
   intervals (`5m`, `every 2 hours`, units `s`/`m`/`h`/`d`) which Claude converts to a cron expression,
   **or** no interval at all, in which case Claude self-paces (see 1.2). Desktop takes named presets
   (Manual/Hourly/Daily/Weekdays/Weekly) and, for anything else, natural language, with the real
   schedule living outside the on-disk prompt file.
3. **What a run is.** Three different answers — see 1.4.
4. **Surfacing/failure.** Different per mechanism — see 1.2, 1.3, 1.4.
5. **Limits.** Summarised in 1.5.

## 1.2 `/loop` and the cron tools (session-scoped, CLI)

**Three input shapes** (both interval and prompt are optional):

| You provide | Example | Behaviour |
| - | - | - |
| Interval + prompt | `/loop 5m check the deploy` | Fixed cron schedule |
| Prompt only | `/loop check the deploy` | Claude chooses the delay each iteration |
| Interval only, or nothing | `/loop` | Built-in maintenance prompt, or your `loop.md` |

**Interval parsing.** Interval may lead (`30m`) or trail as a clause (`every 2 hours`). Units: `s`,
`m`, `h`, `d`. **Seconds are rounded up to the nearest minute** because cron has one-minute
granularity. Intervals that don't map to a clean cron step (`7m`, `90m`) are **rounded to the nearest
interval that does**, and Claude reports which one it picked.

**Self-paced mode.** With no interval, after each iteration Claude picks a delay between **1 minute and
1 hour** based on what it observed, and prints the chosen delay and its reason at the end of the
iteration. It appears in the scheduled-task list as a normal task, showing its pending wakeup as a
one-shot task. Claude can end it by calling `ScheduleWakeup` with `stop: true`. If an iteration ends
without rescheduling *or* stopping, Claude Code schedules **one fallback wakeup ~20 minutes later** and
ends the loop when that iteration also doesn't reschedule. A self-paced loop is **not restored** on
`--resume`.

**Built-in maintenance prompt** (used when the prompt is omitted) works through, in order: continue
unfinished work from the conversation; tend to the current branch's PR (review comments, failed CI,
merge conflicts); run cleanup passes (bug hunts, simplification). Claude does **not** start new
initiatives outside that scope, and irreversible actions (push, delete) proceed only when they continue
something the transcript already authorised.

**`loop.md`** replaces the built-in default prompt for a bare `/loop`. Plain Markdown, no required
structure. Lookup order — first found wins:

| Path | Scope |
| - | - |
| `.claude/loop.md` | Project-level; takes precedence |
| `~/.claude/loop.md` | User-level |

It is ignored whenever you supply a prompt on the command line. Edits take effect on the **next
iteration**. Content beyond **25,000 bytes** is truncated.

**Stopping.** `Esc` while a self-paced loop waits for its next iteration clears the pending wakeup.
Tasks scheduled by asking Claude directly are **not** affected by `Esc`. Fixed-interval loops run until
cancelled or 7 days elapse.

**The underlying tools** (these are model-facing tools; permission column from the tools reference says
all three require no permission):

| Tool | Purpose |
| - | - |
| `CronCreate` | Schedules a task. Accepts a 5-field cron expression, the prompt, and whether it recurs or fires once. |
| `CronList` | Lists scheduled tasks with IDs, schedules, next run times, and prompts. |
| `CronDelete` | Cancels a task by ID. |

Each task has an **8-character ID**. A session holds **up to 50 scheduled tasks**.

**Triggering.** The scheduler checks **every second** for due tasks and enqueues them **at low
priority**. A scheduled prompt fires **between your turns**, never mid-response: if Claude is busy when
a task comes due, the prompt waits until the current turn ends. **No catch-up**: a task whose time
passed while Claude was busy fires **once** when Claude becomes idle, not once per missed interval. All
times are **local timezone** (`0 9 * * *` = 9am wherever Claude Code is running, not UTC).

**Cron expression support.** `minute hour day-of-month month day-of-week`; wildcards `*`, single values
`5`, steps `*/15`, ranges `1-5`, lists `1,15,30`. Day-of-week: `0` **or** `7` = Sunday through `6` =
Saturday. **Not supported**: `L`, `W`, `?`, and name aliases such as `MON` or `JAN`. When both
day-of-month and day-of-week are constrained, a date matches if **either** field matches (vixie-cron
semantics).

**Jitter.** Recurring tasks run **late** by up to half the gap to the next run, capped at 30 minutes —
except a task written exactly `*/5 * * * *`, which is **not delayed** (it starts 15 seconds *early*
each run, so the run doesn't land after a five-minute prompt-cache TTL expires). One-shot tasks
scheduled on `:00` or `:30` run **up to 90 seconds early**; one-shots on any other minute are not
shifted. Delay is deterministic per task.

| Schedule | When each run starts |
| - | - |
| Every 5 minutes, written `*/5 * * * *` (what `/loop 5m` creates) | 4 min 45 s after the previous run |
| Every 10 minutes | 0–5 min late |
| Every 30 minutes | 0–15 min late |
| Every hour or less often (e.g. daily) | 0–30 min late |

Next-run times are readable in the terminal under the `CronCreate` row (`next run 10:21 AM`) and under
`CronList`; requires v2.1.299+.

**Storage.** Sessions restore tasks on `--resume` / `--continue` except expired recurring tasks,
one-shot tasks whose time has passed, and self-paced `/loop`. Background Bash and Monitor tasks are
**never** restored on resume. With **feature-flag fetching off**, Claude Code stores a task you asked
to keep across sessions in the project's **`.claude/scheduled_tasks.json`**. If `.claude` or that file
is a **symlink**, Claude Code returns an **error** instead of scheduling. A saved task runs only in the
project folder where it was created; copy the file into another folder (e.g. a new worktree) and
sessions there **list** the copied tasks but don't run them.

**Seven-day expiry.** Recurring tasks expire 7 days after creation; the task fires one final time then
deletes itself.

**Disable.** `CLAUDE_CODE_DISABLE_CRON=1` disables the scheduler entirely: cron tools and `/loop` become
unavailable and already-scheduled tasks stop firing.

**Skill prompts.** `/loop 20m /review-pr 1234` works only for skills Claude is allowed to invoke on its
own. These reach Claude as **plain text instead of executing**: built-in commands (`/permissions`,
`/model`, `/clear`); skills marked `disable-model-invocation: true` (including bundled `/verify`);
skills withheld by a `skillOverrides` setting or a `Skill` deny rule; MCP prompts (`/mcp__github__list_prs`).

## 1.3 Desktop scheduled tasks (Claude Code Desktop)

**Availability.** Claude Desktop **before 1.1.5368** has no local scheduled tasks. Entry point: **Code**
tab → **Routines** in the sidebar (or its **More** menu) → **New routine** → **Local**.

**Create-form fields.**

| Field | Notes |
| - | - |
| Name | Converted to lowercase kebab-case and used as the **folder name on disk**. Must be unique. |
| Description | Short summary in the task list. |
| Instructions | The prompt. The input includes pickers for **permission mode** and **model**, plus working-folder selection and an **isolated worktree** toggle. |
| Schedule | Presets below. |

A folder is required before saving; an untrusted folder triggers a trust prompt. Tasks can also be
created conversationally from any session ("set up a daily code review that runs every morning at 9am";
"remind me at 3pm tomorrow to check the deploy" creates a one-shot that disables itself after firing).

**Schedule presets.** **Manual** (no schedule, only **Run now**), **Hourly**, **Daily** (local time you
pick), **Weekdays** (Daily minus Sat/Sun), **Weekly** (time + day picker). For anything else — every 15
minutes, first of the month, a single future run — you ask Claude in plain language.

**How a run happens.** Desktop checks the schedule **every minute while the app is open** and starts a
**fresh session** when a task is due, **independent of any manual sessions** you have open. Each task
gets **a small delay of a few minutes** after the scheduled time to stagger API traffic; the delay is
**deterministic** (same task, same offset). On firing you get a **desktop notification** and a new
session under a **Scheduled** section in the sidebar. The run can edit files, run commands, create
commits, and open PRs, but **cannot send or receive inter-session messages** through the desktop app's
session surface. By default a task runs against the working directory's **current state, including
uncommitted changes**; the worktree toggle gives each run its own isolated Git worktree.

**Storage on disk.** `~/.claude/scheduled-tasks/<task-name>/SKILL.md` (or under `CLAUDE_CONFIG_DIR` if
set). YAML frontmatter holds `name` and `description`; the body is the prompt. **Schedule, folder,
model, and enabled state are *not* in this file** — change them through the Edit form or by asking
Claude. Edits to the prompt take effect on the next run. Deleting a task can optionally also delete this
file and associated data (the confirmation dialog's **Also delete files on disk** checkbox).

**Self-modification.** A running session can modify its own schedule or prompt via the
`update_scheduled_task` **MCP tool**.

**Permissions.** Each task has its own permission mode set at create/edit time. Allow rules from
`~/.claude/settings.json` also apply to scheduled-task sessions. In **Manual** mode a task needing an
unpermitted tool **stalls until you approve it**, and the session **stays open in the sidebar** so you
can answer later. "Always allow" approvals are saved per task and reviewable/revocable from the task's
detail page. MCP tools marked `requiresUserInteraction` prompt on **every** call and offer no
always-allow option, so runs calling them stall every time.

**Missed runs.** On app start or computer wake, Desktop checks whether each task missed runs in the
**last seven days**. If so it starts **exactly one** catch-up run for the **most recently missed** time
and **discards anything older** (a daily task that missed six days runs once). A notification appears
when a catch-up run starts. Because of this the docs advise adding guardrails to prompts ("If it's after
5pm, skip the review…"), since a 9am task can run at 11pm.

**Only while awake.** Tasks run only while the app is running **and the computer is awake**. Sleeping
through a scheduled time **skips** the run. **Settings > This computer > System > Keep computer awake**
prevents idle sleep; closing the laptop lid still sleeps it.

**Management.** Detail page offers **Run now**, **Status** (Active/Paused toggle), **Edit**, run
**history** (including skipped runs, with hover reasons: computer asleep, previous run still in
progress, other scheduled tasks already running), **Always allowed** permission review, and **Delete**
(which archives all sessions it created). Listing, creating, editing, and pausing can also be done by
asking Claude in any Desktop session; **deletion requires the Delete button**.

## 1.4 Cloud Routines (for completeness — this is where "scheduled tasks" become durable)

A **routine** is a saved configuration: a prompt, one or more repositories, and connectors, with one or
more triggers. It executes on **Anthropic-managed cloud infrastructure** (or an organisation's
self-hosted environment). **Research preview.** Pro/Max/Team/Enterprise.

**Triggers** (combinable on one routine):

* **Scheduled** — hourly, nightly, weekly, or once at a future timestamp. Entered in local time and
  converted automatically. **Minimum interval 1 hour**; faster cron expressions are **rejected**.
  Scheduling exactly on the hour (9:00) can start several minutes late; the docs advise 9:07.
  One-off schedules auto-disable after firing and the UI marks them **Ran**.
* **API** — `POST` to a per-routine `…/fire` endpoint with `Authorization: Bearer <token>`. Returns
  `{"type":"routine_fire","claude_code_session_id":…,"claude_code_session_url":…}`. Ships under the
  beta header `experimental-cc-routine-2026-04-01`. Optional `text` field; it is passed as freeform
  text and **not parsed**, arriving wrapped in a `<routine-fire-payload>` block labelled as untrusted
  data — a routine's saved prompt must explicitly reference that block to act on it. Tokens are shown
  **once**; the CLI cannot create, regenerate, or delete them.
* **GitHub** — pull request (opened/closed/assigned/labeled/synchronized/etc.) and release events, with
  filters on author, title, body, base branch, head branch, labels, is draft, is merged; operators
  equals, contains, starts with, is one of, is not one of, matches regex. `matches regex` tests the
  **entire field value**, so `.*hotfix.*` is needed for a substring. Requires the Claude GitHub App
  (running `/web-setup` does **not** install it). Each event starts a **new independent session**;
  sessions are never reused across events.

**Create from CLI** with `/schedule [description]` (alias `/routines`). Conversational; Claude collects
the same information as the web form. Manage with `/schedule list`, `/schedule update`, `/schedule run`;
ask about run history with e.g. `/schedule why did my nightly review do nothing this morning?`
(v2.1.227+). Requires a **claude.ai subscription login** — it is hidden and returns
`Unknown command: /schedule` under a Console API key, an Anthropic profile/federation credential, or a
cloud-provider login, and `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `apiKeyHelper` must be removed
first because they take precedence. Also unavailable inside a cloud session, when the org disables cloud
sessions, or when an Owner turns off the Routines toggle.

**A routine run is a full cloud session that runs autonomously**: no permission-mode picker, no
approval prompts. It runs shell commands, uses **skills committed to the cloned repository**, and calls
included connectors. MCP servers added locally with `claude mcp add` are **not** available (they live on
your machine, not your account) — they must be added as connectors at claude.ai, or declared in a
committed `.mcp.json` for a single-repository routine. `~/.claude/skills/` is **not read** (see 3.5).
Each repository is cloned at the start of each run; Claude starts from the default branch unless the
prompt says otherwise, or from the PR head commit when a PR event triggered it. Work is pushed to a
`claude/`-prefixed branch.

**Result surfacing.** The routine detail page lists past runs; clicking one opens it as a full session
where you can review changes, open a PR, or continue manually. **A green status means the session
started and exited without an infrastructure error — it does not mean the task succeeded.** Blocked
network requests, missing connector tools, and task-level failures appear only inside the transcript.

**Failures and holds.** A missing/expired GitHub connection makes a routine **skip runs until
reconnected, for up to 72 hours**; reconnect inside that window and it resumes on its own; after 72
hours the routine **turns off**. Subscription usage limits reject additional runs until the window
resets (unless usage credits are on). While a subscription is paused, routines are **put on hold**.

**Artifacts.** A scheduled or **Run now** run can publish a **new** artifact without asking (private
until shared); declaring runtime capabilities such as connector calls or file downloads *does* prompt.
Republishing an existing artifact without asking requires a specific list of conditions (editable, own
org, not public, not forcing over a newer version, no runtime capabilities, no page-reaching grants).
API- or GitHub-triggered runs always ask. This is a nuance most reimplementations would miss.

## 1.5 Limits, in one place

| Limit | Value |
| - | - |
| `/loop` + cron minimum interval | 1 minute (seconds rounded up) |
| Self-paced `/loop` delay range | 1 minute – 1 hour |
| Recurring-task expiry | 7 days after creation |
| Tasks per session | 50 |
| Scheduler poll | every 1 second, low priority, between turns |
| Recurring jitter | up to half the inter-run gap, max 30 min late; `*/5 * * * *` exempt (−15 s) |
| One-shot jitter | up to 90 s early, only at `:00`/`:30` |
| `loop.md` size | 25,000 bytes, then truncated |
| Desktop minimum interval | 1 minute |
| Desktop scheduling check | every minute while the app is open |
| Desktop catch-up | one run for the most recent miss within 7 days |
| Cloud routine minimum interval | 1 hour |
| Cloud scheduled runs | 100/hour per account; over the limit the run waits |
| Cloud **Run now** + API fires + re-arming a one-off | 30/hour **per routine**, shared across all three |
| Cloud **Run now** + re-arming | 100/hour per account |
| Cloud API fires | 100/hour per account, counted separately from Run now |
| Cloud GitHub events | per-routine and per-account **hourly caps**; excess events are dropped |
| Disable flag | `CLAUDE_CODE_DISABLE_CRON=1` (CLI scheduler only) |

## 1.6 What a scheduled run *is* — the inheritance table

| | **Cloud routine** | **Desktop task** | **`/loop` / cron** |
| - | - | - | - |
| Fresh session? | Yes — a new cloud session per run | Yes — a fresh session per run, independent of manual sessions | **No.** It is a prompt injected into the *existing* session, between turns |
| Conversation context | None (fresh clone, fresh session) | None from your open sessions | **Full** — it runs inside the session that created it |
| Working directory | Fresh clone of the selected repos | The folder you chose (or a per-run worktree) | The session's cwd |
| `~/.claude/skills/` | **No** (fresh cloud session) | **Yes** (runs locally) | Yes, inherits from session |
| Project skills | Yes, if committed to the repo | Yes | Yes |
| MCP servers | Connectors configured per task; local `claude mcp add` servers are **not** available | Config files + connectors | Inherits the session's servers |
| Permission prompts | None — fully autonomous | Configurable per task; Manual mode stalls and waits | Inherits the session's permission state |
| Local file access | No | Yes | Yes |
| Survives restart / machine off | Yes | Yes (persisted), but **runs only while the app is open and the machine is awake** | Restored on `--resume`/`--continue` with the exceptions in 1.2 |

**How results reach you.** Cloud: a new session in your session list plus the run list, with optional artifact publishing. Desktop: a desktop notification and a new session under **Scheduled** in the sidebar. `/loop`: the prompt executes in your current conversation, so the output appears inline as a normal turn. There is also a `PushNotification` tool that sends a desktop notification (and a phone push when Remote Control is connected) so a long-running or scheduled task can reach you when you step away — it is unavailable on Bedrock/AWS/Vertex/Foundry.

---

# 2. Background tasks

## 2.1 What can run in the background, and how it is started

| Thing | How it starts | Who can start it |
| - | - | - |
| **Bash / PowerShell command** | Claude sets `run_in_background: true` on the tool call, **or** you press `Ctrl+B` to move a running Bash tool invocation to the background | Model **and** user |
| **Foreground command that exceeds its timeout** | Automatic: Claude Code **moves it to the background** instead of stopping it — **unless the command starts with `sleep`** | Automatic |
| **Subagent** | The `Agent` tool. Background is the **default**; fork mode (on by default interactively) makes it unconditional. The Agent tool accepts a `run_in_background` input | Model; user can ask for foreground/background, press `Ctrl+B`, or run `/subtask` |
| **Forked subagent** | `/subtask <task>` (v2.1.212+; on v2.1.161–2.1.211 the command was `/fork`). Claude starts one by requesting the `fork` subagent type | User (`/subtask`) or model |
| **Dynamic workflow** | The `Workflow` tool — a script orchestrating many subagents, runs in the background, returns one consolidated result | Model (permission required) |
| **Monitor watch** | The `Monitor` tool: runs a command in the background and feeds **each output line** back as it arrives; can also open a **WebSocket** (`ws` input) and treat each message as an event. A single call cannot combine `command` and `ws` | Model (permission required) |
| **Whole session** | `/background [prompt]` (alias `/bg`) detaches the session to run as a background agent and frees the terminal. Monitor with `claude agents` | User |
| **Plugin monitor** | `monitors/monitors.json` in a plugin: a shell command started at session start and kept running until the session ends. Interactive sessions only — **never** in `-p` | Plugin author |

`Ctrl+B` backgrounds **Bash commands and agents**; **tmux users must press it twice** (prefix key).
Note `Ctrl+T` is *not* the background view — it toggles Claude's to-do checklist. The docs say this
explicitly.

**Command in `!` shell mode** supports the same `Ctrl+B` backgrounding. Shell-mode commands run
**outside the sandbox** even when sandboxing is enabled, because the sandbox applies to commands Claude runs.

## 2.2 Output capture and retrieval

* A background command's output **is written to a file**, and the tool result includes **the task ID and
  the path of the file the output is being written to**. Claude retrieves it by reading that file with
  the `Read` tool.
* **`TaskOutput` was removed in v2.1.277.** Previously it retrieved output from a background task; the
  docs now state Claude reads a background task's **output file** with `Read` instead.
* Background tasks have **unique IDs** for tracking and output retrieval.
* A background **subagent's** results reach Claude as a **completion notification in a later turn**,
  marked as an automated event rather than a message from you (not as a file read). Claude waits for that
  notification before reporting results, and if you ask about progress first it reports that the
  subagent is still running.
* A background subagent's report also passes **output scanning** before Claude reads it: the scan
  inserts a backslash into text imitating Claude Code's own output (`<system-reminder>` tags, lines
  starting `Human:`/`Assistant:`) so it reads as ordinary text, and/or prepends a marker line
  `[harness: subagent output matched instruction-shaped pattern(s):` when the report imitates a tag or
  mentions permission settings such as `bypassPermissions` or `--dangerously-skip-permissions`. It never
  removes or rewords content, and it does not bypass permission checks. Requires v2.1.210+.
* Completion notifications: when a background **Bash/PowerShell command started by a background subagent**
  ends, Claude Code sends **that subagent** a notification. In the main conversation, a completed
  subagent stays listed in `/tasks` marked done for **30 seconds**, sorted below running work.
* **Size cap**: a background task is automatically terminated if its **output exceeds 5GB**, with a note
  in stderr explaining why.
* `/tasks` is the UI list. In the transcript viewer, `Ctrl+O` collapses things like MCP calls into a
  single line, but background work is `/tasks`.

## 2.3 Lifecycle: list, wait, kill

**Listing.** `/tasks` — "View and manage background work in the current session, **including subagents
that have finished**." Alias `/bashes`. It runs immediately even while Claude is responding (one of the
commands that doesn't wait for the turn). The docs elsewhere describe `/tasks` as the place to "see
running shells and subagents", contrasted with the to-do task list.

**Killing.**

| Action | Effect |
| - | - |
| `x` in `/tasks` | Stops the selected running background task. For a subagent, a subagent you stopped yourself this way (or via an SDK `stop_task` request) does **not** auto-resume; a later message from Claude is **refused** and Claude is told the agent was cancelled |
| `/tasks` stop of a background command | Claude **moves on** instead of waiting for it. If a subagent started the command, **that subagent** is the one that moves on |
| `TaskStop` tool | Stops a running background task by ID. Also accepts an agent-team teammate or a named background agent by **agent ID or name**. When no task matches the ID the error lists running background agents by ID and description, including agents another agent spawned |
| `Ctrl+X Ctrl+K` | Stops **all** running background subagents in the session (and turns off artifact auto-replies). Press twice within 3 seconds to confirm. Works even while a background subagent's permission prompt is open |
| `Esc` on a background subagent's permission prompt | Denies **that one tool call** without stopping the subagent |

**Waiting.**

* A background subagent that leaves a **background Bash/PowerShell command** running past the end of its
  turn keeps it running; when the command ends the subagent gets a notification.
* In `claude -p`, the run stays open after finishing its turn to wait for background work — see 2.5.
* Monitor watches wait until the watch times out (default **five minutes** after Claude starts it) or the
  10-minute cap ends the wait.

**When the session ends.**

* Background tasks are **automatically cleaned up when Claude Code exits**. On macOS and Linux, when you
  stop a background task from `/tasks` or Claude Code stops it at exit, **processes that detached from
  the task's shell also stop** — including ones started under `setsid` or `timeout`.
* If you **background the session** instead of exiting, background tasks **keep running in the
  background session**.
* On macOS and Linux, Claude Code stops running background tasks when the OS reports **critical memory
  pressure**, provided the session has been **idle at least 30 minutes** and **no turn or subagent is
  running**. The debug log says why tasks were stopped or left running. `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1`
  turns this off.
* A background command started by a **foreground subagent** stops when **that subagent's run ends**,
  whether it finished, failed, or was interrupted. A command started by the **main conversation or a
  background subagent** keeps running after a final response until it exits, is stopped, or hits its
  time limit.

**Time limits** (unattended sessions only — a local interactive session has **no** time limit):

| Case | Limit |
| - | - |
| Command Claude starts in the background | 30 minutes, or the `timeout` Claude passes with `run_in_background`, **max 2 hours** |
| Command that started in the foreground and moved to the background | 30 minutes **from the move** |
| `-p` run whose prompt was passed as text (not `--input-format stream-json`) | Both defaults become **10 minutes**, because the run waits for background commands after its result |
| Reached limit | Claude Code stops it and says `Background command "<description>" was stopped after reaching its background time limit`; Claude can restart it with a longer `timeout` |

**Disabling.** `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` disables **all** background task functionality,
including auto-backgrounding on timeout (the command stops at its timeout instead), and makes forked
skills wait. **Bare mode** (`--bare`) also turns background tasks off — a command that reaches its
timeout stops instead of moving to the background.

## 2.4 Can the model start background work itself?

**Yes.** The model-facing surface is:

* `Bash` / `PowerShell` with **`run_in_background: true`** (plus `timeout`, which doubles as the
  background time limit when combined with `run_in_background`).
* `Agent` with a **`run_in_background`** input; background is the default anyway. A subagent definition's
  `background: true` frontmatter forces it to stay in the background even when Claude wants the result.
* `Monitor` (permission required) — background command or WebSocket, streaming each line back.
* `Workflow` (permission required) — orchestrates many subagents in the background.
* `TaskStop` — kills background work by ID, agent ID, or agent name.
* `ScheduleWakeup` — self-pacing for `/loop` (not user-callable in practice).
* `CronCreate` / `CronList` / `CronDelete` — session-scoped scheduling.

`TaskOutput` is **gone** (v2.1.277). There is no model-facing "wait for background task" tool anymore;
the mechanism is the completion notification plus reading the output file.

**Forced-foreground cases** (when the model *cannot* get background):
an in-process agent-team teammate's subagent runs in the foreground; a teammate whose definition sets
`background: true` is **refused with an error**; with fork mode off, a teammate setting
`run_in_background: true` is also refused. With fork mode **on** (the default interactively) Claude
Code runs the subagent in the background and **Claude can't ask for the foreground**.

**Forked skills force waiting** even when the skill doesn't set `background: false`: in non-interactive
mode (`-p` / Agent SDK); when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`; when you invoke a forked skill
while an earlier invocation of the same skill is still running; and when a **scheduled task fires with
the skill as its prompt**.

## 2.5 Background work at the end of a `claude -p` run

After Claude finishes its turn and stdin closes, the run can stay open for background work. Default cap:
**10 minutes of continuous idle waiting**, then it stops what's still running and **drops the partial
result** — unless a background command the *main conversation* started is still running, in which case
the cap doesn't end the wait. Change with `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`; `0` = wait without one.

What it waits for: background commands (until exit or time limit, then Claude takes **one more turn**
with the outcome); background subagents and workflows (until complete, because the result is part of the
final output); Monitor watches (until timeout or the 10-minute cap); pending self-paced `/loop` wakeups
(each wakeup fires and runs its iteration until the loop ends, **even past the 10-minute cap**) — but
only when the prompt was passed as text rather than via `--input-format stream-json`.

When stderr is a terminal and the run has waited 5 seconds, Claude Code prints
`Waiting for background work to finish` and names the work. With `json`/`stream-json` output that line
prints only when stdout isn't a terminal, so it never pollutes the JSON. Reaching `--max-budget-usd`
stops remaining background work instead of waiting.

**SIGTERM** → exit code **143**, the in-progress turn is left unfinished with **no recorded result**,
the process tree of any still-running Bash command is terminated, `SessionEnd` hooks run, and no new
tool call, model request, or other hook starts. **SIGINT** (or the SDK's `interrupt()`) ends the turn
instead. On resume, `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` makes Claude Code continue the interrupted
turn.

---

# 3. Subagents, plugins, skills — the gaps

## 3.1 Subagent frontmatter — the complete field list

Only `name` and `description` are required. Multi-word names are **camelCase** and must match the table
**exactly**: an unrecognised field is **ignored without an error**. To find misspellings, run
`claude --debug` and search `~/.claude/debug/<session-id>.txt` for `does not recognize or apply`
(v2.1.296+); the log names up to five unrecognised top-level fields with the likely intended name.

| Field | Req | Semantics |
| - | - | - |
| `name` | Yes | Unique identifier, **max 256 chars**. Hooks receive it as `agent_type`. Filename need not match. **Cannot contain `:`** (reserved for plugin-scoped ids). |
| `description` | Yes | Drives delegation. |
| `tools` | No | Comma-separated string or YAML list. Omitted ⇒ inherits every tool available to subagents. If **no** entry resolves to a usable tool, the Agent tool usually **errors instead of launching** (`Agent would be spawned with zero tools`). To preload skills use `skills`, **not** `Skill` here. |
| `disallowedTools` | No | Removed from inherited or specified list. **An entry with a specifier, e.g. `Bash(git push *)`, still removes the whole tool.** If both `tools` and `disallowedTools` are set, `disallowedTools` wins. |
| `model` | No | `sonnet`, `opus`, `haiku`, `fable`, a full model ID such as `claude-opus-5-5`, or `inherit`. |
| `permissionMode` | No | `default`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan`, or `manual` as an alias for `default`. **Ignored for plugin subagents.** |
| `maxTurns` | No | Max agentic turns. On reaching it, output is returned **marked as partial**, and Claude can resume to continue (partial marking requires v2.1.246+). |
| `autoCompactWindow` | No | Per-subagent auto-compact window, **100000–1000000 tokens**. Write a plain integer: `200k` is read as **200**, out of range, and silently ignored. `CLAUDE_CODE_AUTO_COMPACT_WINDOW` overrides it. v2.1.296+. No effect when the session runs as this agent via `--agent`/`agent` setting. |
| `skills` | No | Skills to **preload**: the **full skill content is injected at startup**, not just descriptions. The subagent can still invoke unlisted project/user/plugin skills through the `Skill` tool. |
| `mcpServers` | No | Server **name** referencing an already-configured server, or an inline full MCP server config. **Ignored for plugin subagents.** |
| `hooks` | No | Lifecycle hooks scoped to this subagent. **Ignored for plugin subagents.** |
| `memory` | No | Persistent memory scope: `user`, `project`, or `local`. Enables cross-session learning. |
| `background` | No | `true` keeps the subagent in the background even when Claude asks for foreground. |
| `omitClaudeMd` | No | `true` starts it without user/project/local CLAUDE.md; **managed policy files still load** (except for managed subagents). Ignored when the agent is the main session agent via `--agent`/`agent`. v2.1.271+. |
| `effort` | No | `low`, `medium`, `high`, `xhigh`, `max`. Overrides session effort, **but not** `CLAUDE_CODE_EFFORT_LEVEL`. A per-invocation `effort` parameter overrides the field and persists across resume (v2.1.292+). |
| `isolation` | No | Only value `worktree`: a temporary git worktree, branched by default from your **default branch** rather than the parent session's `HEAD`. Auto-cleaned if the subagent makes no changes. |
| `color` | No | `red`, `blue`, `green`, `yellow`, `purple`, `orange`, `pink`, `cyan`. Display only. |
| `initialPrompt` | No | Auto-submitted as the first user turn **when this agent runs as the main session agent** (`--agent` or the `agent` setting); commands and skills are processed; prepended to any user prompt. **Ignored for plugin subagents.** |
| `experimental` | No | Map. Only `cacheTtl: 5m\|1h` is read (prompt-cache lifetime for this subagent's requests). Must be nested **inside** `experimental`, not top-level. `1h` is ignored while a subscription is using usage credits. Subagent files only. v2.1.248+. |

**`--agents` JSON differences.** Each top-level key is the agent name (must not start with `-`). Fields
supported: `prompt` (the system prompt, equivalent to the markdown body; **may be empty**) plus
`description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`,
`autoCompactWindow`, `skills`, `initialPrompt`, `memory`, `effort`, `background`, `omitClaudeMd`,
`isolation`. **Ignored:** `color` and `experimental` — "not accepted here and are ignored rather than
rejected". In non-interactive mode `--agents` also accepts a **path to a JSON file** (v2.1.281+); an
interactive session **refuses a file path**.

**Files Claude Code skips silently** (project / user / managed `agents` dirs, and `--add-dir` dirs):
no `name` (treated as documentation); an opening `---` that isn't the file's **first line**; a `name`
starting with `-`, containing `:`, or >256 chars; a `name` with no `description`; unparseable YAML.
The first two are silent; the rest write to the debug log. A **plugin** subagent with no `name` or
unparseable frontmatter **still loads, under its filename**, with description `Agent from <plugin> plugin`.
`claude plugin validate <dir>` (v2.1.233+) finds unparseable files in an `agents` directory.

**Scope priority** (highest first): managed settings → `--agents` CLI flag → `.claude/agents/` →
`~/.claude/agents/` → plugin `agents/`. Project scope is discovered by walking **up** from the cwd, so
every `.claude/agents/` between the cwd and the repo root is scanned and the definition **closest to the
cwd** wins a name collision. Both project and user dirs are scanned **recursively**, and **the
subdirectory path does not affect identity** — only `name` matters. Two files in the same directory tree
declaring the same name: only one loads, **chosen by filesystem read order, with no documented
precedence**. Plugin `agents/` is different: subfolders **become part of the scoped identifier**, so
`agents/review/security.md` in plugin `my-plugin` registers as `my-plugin:review:security`.

## 3.2 Where a subagent genuinely differs at execution time

* **Own context window: yes.** Each subagent starts fresh and isolated; it does **not** see your
  conversation history, the skills already invoked, or files already read. Initial context =
  its own system prompt (the markdown body / `prompt`) **plus** environment details — **not** the Claude
  Code system prompt — the delegation message, the full CLAUDE.md hierarchy the main conversation loads,
  a **git status snapshot**, preloaded skills, and (conditionally) a sibling roster. Exceptions: Explore
  and Plan skip CLAUDE.md and git status; `omitClaudeMd` skips the non-managed CLAUDE.md files.
* **It never inherits:** your output style (a subagent runs its own system prompt), the main
  conversation's auto memory, or the parent's context-window size — **the window is sized by the
  subagent's own model**.
* **Own model: yes** (see `model` above). The resolution order is per-invocation parameter → frontmatter
  `model` → `CLAUDE_CODE_SUBAGENT_MODEL` → main conversation's model. (Before v2.1.251 the env var came
  first and overrode everything, including `inherit`.) `CLAUDE_CODE_SUBAGENT_MODEL` can be forced onto
  **every** subagent, Explore included.
* **Own permission mode: yes**, via `permissionMode` — and **no for plugin subagents**. Also relevant:
  launching a subagent does **not** itself prompt; the subagent's own tool calls are checked against your
  rules as it runs. Foreground subagents show prompts inline; **background subagents surface prompts in
  your main session**, naming which subagent is asking, and `Esc` denies just that call.
* **Own MCP servers: yes**, via `mcpServers` — **no for plugin subagents**. Subagents otherwise inherit
  the main conversation's MCP tools (and in the background, keep **every** MCP tool).
* **Own hooks: yes**, via `hooks` — **no for plugin subagents**.
* **Tool set is filtered twice.** Filter 1 removes a short list of tools from **every** subagent, even
  when listed in `tools`. Filter 2 applies to **background** subagents (the default), which keep every
  MCP tool but only these built-ins: `Read`, `Grep`, `Glob`, `LSP`, `Bash`, `PowerShell`, `Edit`,
  `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `Skill`, `ToolSearch`, `EnterWorktree`,
  `ExitWorktree`, `Monitor`, `TaskStop`, `SendMessage`, `Artifact`, plus `SubagentHandback` where it
  applies. **Every other built-in is removed** from a background subagent whether inherited or listed —
  so *the same definition can resolve to different tools in foreground and background*, silently, unless
  it leaves the `tools` list resolving to nothing. **Forks skip both filters** and get the main
  conversation's exact tool pool. `ListAgents` follows the filters like any built-in.
* **Resume: yes, explicitly.** Each invocation creates a **new instance**; Claude resumes via the
  **`SendMessage`** tool with the agent's **ID or name** in the `to` field. Resumed subagents keep their
  **full conversation history** including previous tool calls, results, reasoning, and results delivered
  by background children. A resumed run **keeps the tool set from where the subagent first ran** and can
  keep reading the prompt cache the original run warmed. Resuming starts a **new run under the same ID**,
  so a completed/failed subagent shows as running again. **Explore and Plan are one-shot and return no
  agent ID, so they can't be resumed.** `SendMessage` **checks that a name still refers to the same agent**
  it reached earlier in the conversation; if a newer agent took the name, the send is refused and the
  error names where the name now points. The check is scoped to the conversation and **resets on
  `/clear`**.
* **Lifecycle limits.** Nesting: default **3 layers** below the main conversation, set by
  `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (**1 turns nesting off**). At the depth limit Claude Code
  **withholds the `Agent` tool** from every subagent **except a fork**; a fork at the limit keeps `Agent`
  in its list but the tool returns an error. History: v2.1.172–2.1.216 defaulted to **five** layers and
  wasn't configurable; v2.1.217–2.1.218 defaulted to **one**; v2.1.219 raised it to three. Concurrency:
  **20 running subagents** per session, then spawning fails with `Concurrent subagent limit reached` and
  Claude is told not to retry; set `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`. Sessions with **ultracode**
  active are exempt. The limit blocks only Agent-tool spawns, but **`/subtask` forks take a slot**
  (and are never blocked), and **resumes take a fresh slot without checking the limit**, so resumes can
  push the running count past it. Workflow agents and agent-team teammates follow their own limits.
  There is **no limit on total subagents per session**.
* **Transcripts.** `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`. These
  persist independently of the main conversation: main-conversation compaction doesn't touch them, they
  survive a restart if you resume the same session, and they're deleted after `cleanupPeriodDays`
  (**30 days** default). Auto-compaction is per-subagent and logs `compact_boundary` events with
  `trigger` and `preTokens`.
* **`--append-subagent-system-prompt`** appends text to **every** subagent's system prompt, nested
  included, **except a fork** (which reuses the conversation's own prompt). A `-file` variant exists.
  v2.1.205+ / v2.1.261+.
* **`isolation: worktree`** enforces the working directory for Bash **and PowerShell** commands; for Bash
  it also blocks commands that redirect git into the main checkout and **refuses commands where it can't
  verify from the command text that any git they run stays inside the worktree** (e.g. a computed command
  name). PowerShell gets only the cwd check. **Monitor commands go through the same checks as Bash.**
* **A post-failure fallback**: with a fallback model chain configured, a subagent that hits a covered
  failure (e.g. its model is unavailable) is **switched to the first model in the chain that accepts the
  request** rather than failing.

## 3.3 Plugin hooks vs settings hooks

**How a plugin ships hooks.** `hooks/hooks.json` at the plugin root, under a **top-level `"hooks"` key**,
in the **same shape as the `hooks` object in `settings.json`** — explicitly so that "you can copy an
existing settings hook in unchanged":

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Write|Edit",
        "hooks": [ { "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}/scripts/format.sh\"" } ] }
    ]
  }
}
```

`hooks/hooks.json` **and** the manifest's `hooks` key **both load**. Hook types are broader than shell:
a hook can be a shell command, an HTTP request, an MCP tool call, a prompt to a model, or a subagent.
Hooks can also be written as **JavaScript functions running inside Claude Code** that can draw in its
interface: list a module file under a **`modules`** key in the same `hooks/hooks.json` — a plugin with
one is called a **mod**.

**How plugin hooks differ from settings hooks.**

1. **Environment variables.** Every plugin hook process receives `CLAUDE_PLUGIN_ROOT`,
   `CLAUDE_PLUGIN_DATA`, and `CLAUDE_PLUGIN_OPTION_<KEY>` for each `userConfig` value.
2. **Quoting/exec form.** When `command` has **no `args`**, it runs through a shell, so
   `${CLAUDE_PLUGIN_ROOT}` must be wrapped in double quotes to stay one shell word. When you pass
   **`args`**, each element is passed as one argument with **no shell** and needs no quoting.
3. **Firing time.** Plugin hooks **don't wait** for one of the plugin's skills or commands to be used:
   Claude Code registers them when a session loads the plugin and they fire on their events from then on.
   Narrow the `matcher` to limit them.
4. **MCP tool matchers.** A tool from an MCP server the plugin declares is named
   `mcp__plugin_<plugin>_<server>__<tool>`, so that **full name** must be written in the matcher. **A
   matcher on the server name alone never fires.**
5. **Name-collision rule (no equivalent in settings).** When two enabled plugins share a **manifest
   name**, both appear enabled but **only one registers its `hooks/hooks.json` hooks**, and only one
   loads a hooks module. A managed-settings-enabled copy holds the name; otherwise the copy Claude Code
   loads **first** does. The left-out copy gets a note in `/plugin`'s **Errors** tab beginning
   `Its hooks.json hooks do not run` (or `Its hooks module does not load`) and naming the winner; the
   note requires v2.1.296+. To switch, disable/uninstall the winner and run `/reload-plugins`.
6. **Plugin hooks apply inside subagents** — the sub-agents page states that hooks from settings files,
   managed policy settings, **and plugins** all apply inside subagents, so a `PreToolUse` hook in
   `settings.json` also runs before every tool a subagent uses.
7. **Reload behavior.** After a **copied** plugin updates mid-session, its **hook commands, monitors, MCP
   servers, and LSP servers keep using the previous version's path** until you run `/reload-plugins`,
   which switches hooks, MCP servers, and LSP servers to the new path. **Monitors require a session
   restart.** MCP server reload rule: an unchanged config keeps its connection, a changed config
   reconnects, a removed one disconnects.
8. **No plugin hooks for plugin subagents.** `hooks`, `mcpServers`, `permissionMode`, and
   `initialPrompt` are **ignored** in a plugin agent's frontmatter. A plugin agent's **supported**
   frontmatter is: `name`, `description`, `model`, `effort`, `maxTurns`, `autoCompactWindow`, `tools`,
   `disallowedTools`, `skills`, `memory`, `background`, `omitClaudeMd`, `isolation`, `color`, and the
   **`cacheTtl` key of `experimental`**. `isolation` accepts only `"worktree"`. **Frontmatter that
   doesn't parse: the agent still loads with every field ignored**, named after the file, description
   `Agent from <plugin> plugin`. If you need real hooks/MCP/permission mode, ship them in the plugin's
   `hooks/hooks.json` and `.mcp.json` (they then apply whenever the plugin is enabled, not only inside
   the subagent) or copy the agent file into `.claude/agents/`.
9. **Frontmatter hooks in *subagent* files** (a different mechanism from plugin hooks) fire when the
   agent is spawned via the Agent tool or an @-mention **and** when it runs as the main session via
   `--agent`/the `agent` setting (there, alongside `settings.json` hooks). They are cleaned up when it
   finishes. **All hook events are supported.** When the agent is invoked **as a subagent**, `Stop`
   hooks in frontmatter are **automatically converted to `SubagentStop`**. Trust rule — **stricter than
   for settings hooks**: a project-level subagent's frontmatter hooks require accepting the **workspace
   trust dialog for the folder containing the agent file**; trusting a parent folder is not enough, and
   **a `-p` session doesn't count as trusted**. User-level (`~/.claude/agents/`) and `--agents` hooks
   need no trust step. Until trusted, the subagent still runs but its hooks are skipped and an error is
   logged. Session-level `SubagentStart` / `SubagentStop` hooks take the agent type name as the matcher;
   for plugin subagents that's the scoped id containing a colon, which makes the matcher an **unanchored
   regex** — anchor it as `^my-plugin:db-agent$`.

## 3.4 Skills — invocation control and the fields you may have missed

**`context: fork` and `agent:`**

* `context: fork` starts **a new subagent of the type in the `agent` field**, with the skill content as
  its prompt. The subagent **does not see your conversation history**, so the skill's instructions must
  stand alone.
* **It is not a fork of the conversation**, despite the name. The docs call this out in a Note: a fork of
  the current conversation would hand the subagent everything discussed so far; when the task depends on
  that history, **fork the conversation instead** (`/subtask`).
* It **runs in the background** by default: you keep working and the result arrives when it completes.
  `background: false` makes it wait in the invoking turn. Before v2.1.218 forked skills always blocked.
* Claude Code **waits anyway** (even without `background: false`) in: non-interactive mode (`-p` / Agent
  SDK); `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`; when the same skill is already running from an earlier
  invocation; when a **scheduled task fires with the skill as its prompt**; and when an agent in a
  **dynamic workflow** invokes it (before v2.1.295 Claude Code didn't wait and the result went to the
  main conversation instead of that agent).
* A **backgrounded** fork runs with the **narrower background-subagent tool set** (the `Agent`-fork
  exemption doesn't cover skills, because the skill's subagent is a regular agent type). If the skill
  needs a tool outside that set, set `background: false`. A **forked skill that sets `agent`** also
  aborts a scheduled/injected command whose permission check isn't a clean allow.
* A backgrounded forked skill applies its edits **outside your session's checkpoints**: after one,
  `/rewind` restores only the files Claude had already edited in the conversation, and the skill's other
  edits stay — use git to revert.
* `agent:` picks the subagent type: built-in `Explore`, `Plan`, `general-purpose`, or any custom
  subagent from `.claude/agents/`. **Omitted ⇒ `general-purpose`.**
* With `context: fork`, the skill's `model` value sets the **forked subagent's** model.
* Warning in the docs: `context: fork` only makes sense for skills with **explicit instructions**. A
  skill of guidelines ("use these API conventions") gives the subagent guidelines with no actionable
  prompt and it returns nothing meaningful.

**The two-directional relationship:**

| Approach | System prompt | Task | Also loads |
| - | - | - | - |
| Skill with `context: fork` | From the agent type | SKILL.md content | CLAUDE.md, per the agent's startup context |
| Subagent with `skills` field | The subagent's markdown body | Claude's delegation message | Preloaded skills + CLAUDE.md |

**Skill frontmatter — beyond the set you listed.** Your implemented set is `name`, `description`,
`when_to_use`, `disable-model-invocation`, `allowed-tools`, `metadata`. The full documented set also
includes:

| Field | Semantics worth noting |
| - | - |
| `arguments` | Named positional arguments for `$name` substitution; space-separated string or YAML list; names map to positions **in order**. |
| `argument-hint` | Autocomplete hint only, e.g. `[issue-number]`. |
| `user-invocable` | `false` hides it from the `/` menu and stops `/name` running it, **but Claude still can**. Opposite of `disable-model-invocation`. |
| `disallowed-tools` | Tools **removed from Claude's pool while the skill is active**. Clears when you send your next message. Like deny rules, it **cannot remove `EndConversation` while any other tool remains**. |
| `model` | Overrides the model **for the rest of the current turn only**, not saved to settings; the session model resumes on your next prompt. `inherit` keeps the active model. Blocked by an `availableModels` allowlist, by auto mode for unsupported models, and in plan mode while the classifier reviews commands. |
| `effort` | `low`…`max`; overrides session effort. |
| `context` | `fork` only. |
| `agent` | Subagent type when `context: fork`. |
| `background` | Only with `context: fork`; `false` waits. Default `true`. v2.1.218+. |
| `hooks` | Hooks registered **when the skill is invoked and kept running for the rest of the session** (not just the skill's turn). Has a `once` option. |
| `paths` | Glob patterns; when set, Claude loads the skill automatically **only when working with matching files**. Not supported in `.claude/commands/` files. |
| `shell` | `bash` (default) or `powershell` — the shell for `` !`command` `` and ```` ```! ```` blocks. |
| `license` | Agent Skills spec; **accepted but not acted on**. |
| `compatibility` | Agent Skills spec; string up to 500 chars; **accepted but not acted on**. |

**Invocation/context matrix** (exact):

| Frontmatter | You can invoke | Claude can invoke | When loaded into context |
| - | - | - | - |
| (default) | Yes | Yes | Description always in context, full skill loads when invoked |
| `disable-model-invocation: true` | Yes | Not on its own | Description **not** in context, full skill loads when invoked |
| `user-invocable: false` | **No** | Yes | Description always in context, full skill loads when invoked |

Also: `disable-model-invocation: true` additionally **prevents the skill being preloaded into subagents**
and **prevents it running when a scheduled task fires with the skill as its prompt**.

**`skillOverrides`** (a settings key, not frontmatter) has four states: `"on"` (name+description listed,
in menu), `"name-only"`, `"user-invocable-only"` (hidden from Claude, **still in the `/` menu**; the
`/skills` menu labels this `user-only`), `"off"` (hidden both; also hidden from command lists advertised
to Remote Control clients and Agent SDK callers). Absent ⇒ `"on"`. **Plugin skills are not affected by
`skillOverrides`** — manage those through `/plugin`. In user/project/local settings entries match skill
**names only**; only in managed settings or `--settings` do alias entries apply to the skill behind the
alias, and only to **restrict** further, never to widen.

**Permission syntax for skill access:** deny the `Skill` tool to disable all; `Skill(commit)` exact,
`Skill(review-pr *)` prefix. A deny on an **alias** also blocks the underlying bundled skill (blocking
`Skill(review)` also blocks bundled `/code-review`); a deny on an **unqualified** name also blocks a
nested skill listed as `apps/web:deploy` (v2.1.260+).

**Dynamic context injection** (you may not have this): `` !`command` `` lines and ```` ```! ```` blocks
run **before Claude sees the skill content** and are replaced with their output. Substitutions:
`$ARGUMENTS`, `$ARGUMENTS[N]` (0-based), `$N`, `$name`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`,
`${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`.
Injected commands **never prompt while the skill renders**: each is checked against permission rules
first, and **outside auto mode, anything other than a clean allow aborts the invocation** with
`Shell command permission check failed for pattern "..."` — including a rule that would merely *ask*.
Pre-approve with `allowed-tools`. In **auto mode** the invocation doesn't abort; the skill loads with an
instruction telling Claude to run the command first.

## 3.5 Discovery and reload — the exact matrix

| Artifact | Watched live? | How to pick up a change |
| - | - | - |
| Skill `SKILL.md` (personal `~/.claude/skills/`, project `.claude/skills/`, or `.claude/skills/` in an `--add-dir` dir) | **Yes** — changes are detected within the session, no restart. **Except in bare mode.** | Nothing, for an existing directory. If you **create** a top-level skills directory that didn't exist at session start, Claude Code **isn't watching it yet**: run **`/reload-skills`**, and again after each later change there. |
| `loop.md` | Yes — edits take effect on the **next iteration** | Nothing |
| Subagent files (`~/.claude/agents/`, `.claude/agents/`) | **Yes** — "detects the change within a few seconds and the next delegation uses the updated definition, with no restart" | Three exceptions requiring a restart: the watcher covers only directories that **existed when the session started** (so creating the scope's **first** agent file in a new `agents` directory needs a restart); `.claude/agents/` inside an **`--add-dir`** directory is **not watched**; sessions started with **`--disable-slash-commands`** don't watch these directories at all |
| Plugin components (skills, commands, agents, hooks, output-styles, MCP/LSP servers, themes) | **No** | **`/reload-plugins`**, or a new session. `/reload-plugins [--force]`. Closing the `/plugin` panel with pending changes runs it for you. Sessions **without an interactive terminal** (Desktop, Agent SDK, `-p`) support it, but **only when you type it into the session yourself** — over Remote Control or a relayed Slack message it replies `/reload-plugins isn't available over a remote connection in this session.` In those sessions it **does not connect or disconnect plugin MCP servers**; those take effect next session |
| A skill folder that is **also** a plugin (`.claude-plugin/plugin.json` inside it) | Only `SKILL.md` text is watched | Changes to `hooks/`, `.mcp.json`, `agents/`, `output-styles/` need **`/reload-plugins`** |
| Plugin monitors (`monitors/monitors.json`) | No | **Session restart.** Disabling a plugin mid-session does **not** stop monitors already running; they stop when the session ends |
| Plugin auto-update | n/a | Interactive session: after your first message Claude Code waits a **random delay up to 10 minutes**, then refreshes every auto-update marketplace and updates installed plugins on disk. The running session keeps the loaded versions; you see `Plugin updated: <name> · Run /reload-plugins to apply`. New versions load on next launch regardless |
| `claude plugin update` | n/a | Ends with `Restart to apply changes.` |

**Reload safety.** `/reload-plugins` prints one summary line
`Reloaded: N plugins · N skills · N agents · N hooks · N plugin MCP servers · N plugin LSP servers`
(the MCP count is omitted in a session without an interactive terminal), adding
`N errors during load. Run /plugin for details.` The **skills** count covers both `commands/` entries and
`SKILL.md` skills; the **agents** count includes agents that don't come from plugins. If a reloaded
plugin's dependencies are missing, Claude Code installs them, reloads again, and appends
`(+ N dependencies: <names>) resolved`. If the reload would **add or remove a plugin MCP server or the
`LSP` tool**, which would invalidate the prompt cache, **it is refused** with
`This reload changes MCP tools (<server>) — your next message will re-read the whole conversation instead of using the cache. Run /reload-plugins --force to apply.`

**Plugin resolution order for a name collision** (highest first): managed-settings `enabledPlugins` entry
→ enabled `--plugin-dir`/`--plugin-url`/`CLAUDE_CODE_PLUGIN_DIRS` plugin (replaces an installed
marketplace plugin **silently**; replaces a skills-directory plugin with a `/plugin` Errors row) →
installed marketplace plugin → skills-directory plugin (**between two of these, `~/.claude/skills/` wins
over the project's `.claude/skills/`**) → synced-from-claude.ai plugin.

**`enabledPlugins` precedence** (lowest to highest): `--add-dir` settings → `user` → `project` → `local`
→ `flag` (`--settings`) → `managed`. Merged **key by key**; for each plugin id the value comes from the
highest-precedence source that **mentions** the id. A `true` in a higher source overrides your `false`,
and `claude plugin list` says so explicitly (`Disabled in ~/.claude/settings.json but still loads —
project settings enable it, which overrides your user setting`).

**On-disk plugin layout** (`~/.claude/plugins` unless `CLAUDE_CODE_PLUGIN_CACHE_DIR`):
`cache/<marketplace>/<plugin>/<version>/` (= `${CLAUDE_PLUGIN_ROOT}`, **changes every version**),
`data/<plugin-id>/` (= `${CLAUDE_PLUGIN_DATA}`; `<id>` = the plugin id with every char other than
letters/digits/`_`/`-` replaced by `-`, so `my-plugin@my-marketplace` → `my-plugin-my-marketplace`),
`marketplaces/<name>/`, `synced/`, `.trash/`, `installed_plugins.json`, `known_marketplaces.json`,
`flagged-plugins.json`. On **Windows**, substituted paths use **forward slashes** so a shell doesn't read
backslashes as escapes.

**Plugin path rejection rules worth copying.** Claude Code rejects a component path that resolves outside
the plugin root — a literal `../shared-utils`, a symlink leading outside, or (on macOS/Linux) **a path
containing a backslash anywhere**, even if it stays inside the plugin. The last one means backslash paths
load on **Windows only**; write forward slashes. Error: `path escapes plugin directory`, and the plugin
loads without that component.

**Skills are not read from some places at all.** Cloud/Cowork sessions, including routines, **do not
read `~/.claude/skills/`**; they load skills enabled for your claude.ai account (synced at session
start, into `~/.claude/skills/synced/`) plus project skills committed to the cloned repo. Plugins
declared in a repository's `.claude/settings.json`, and plugins enabled only in user settings, **don't
load in cloud sessions**. **Desktop scheduled tasks run locally, so they *do* load `~/.claude/skills/`.**

## 3.6 Gaps and ambiguities in the docs — stated plainly

1. **The background output file's directory is never documented.** The docs say output is written to a
   file, the tool result carries the task ID and the file's path, and Claude reads it with `Read`. I
   found no page naming a fixed output directory or a glob for it. A reimplementation can choose its own
   location, but cannot copy Claude Code's.
2. **Cross-session persistence of cron tasks is under-specified.** The limitations section describes
   `.claude/scheduled_tasks.json` only "with feature-flag fetching off", and refers to "a task you asked
   to keep across sessions" — but no page I fetched documents *how* you ask for that, or what the
   persisted schema is. Which tasks are restored on `--resume` is documented; where they live is not,
   for the default (feature-flag-fetching-on) configuration.
3. **`/tasks` key bindings are only partially documented.** I found `x` (stop the selected running task /
   dismiss a finished row) and `↑`/`↓`/`Enter`/`Esc` for the *subagent and fork panel below the prompt*,
   which the docs describe as the place to steer them. Whether `/tasks` itself uses the same keys is
   never stated. `/tasks` has no documented flags.
4. **The exact `Ctrl+B` behaviour on the model side is not specified.** `Ctrl+B` "moves a regular Bash
   tool invocation to the background"; whether Claude is notified, and how the tool result is rewritten
   (the docs *do* give the exact string for the timeout-driven move), is not stated for the manual case.
5. **Nesting interplay with `background`.** The docs say a nested subagent is configured the same way and
   resolves from the same scopes, and that at the depth limit the `Agent` tool is withheld — but they do
   not say whether a nested subagent's own `background`/`isolation` frontmatter is honoured the same way
   as a top-level one, beyond the note that an `isolation` frontmatter value doesn't prevent a
   named-teammate launch.
6. **Plugin `skills`/`agents`/`commands` recursion depth is not specified** for anything beyond
   `agents/`, where subfolders are documented to become part of the scoped name one level deep in the
   examples (`agents/review/security.md`). Deeper nesting is unstated.
7. **Two source-of-truth mismatches** between the CLI and Desktop surfaces that a parity implementation
   must decide for itself: Desktop tasks get a **deterministic few-minute delay** while `/loop` gets a
   **schedule-derived jitter**, and Desktop does **catch-up for one missed run** while `/loop` explicitly
   does **no catch-up**.

---

## Quick-reference: every exact string that a reimplementation must match

**Commands.** `/loop [interval] [prompt]` (alias `/proactive`); `/tasks` (alias `/bashes`);
`/subtask <task>`; `/background [prompt]` (alias `/bg`); `/reload-skills`; `/reload-plugins [--force]`;
`/schedule [description]` (alias `/routines`), `/schedule list|update|run`, `/schedule add a GitHub
trigger to …`; `/agents`; `/skills`; `/skill-doctor`; `/plugin` and subcommands; `claude plugin
init|install|uninstall|enable|disable|update|list|validate|tag|test|eval`; `claude plugin marketplace
add|list|remove|update`; `claude plugin configure --values-stdin`.

**Tools.** `CronCreate`, `CronList`, `CronDelete`, `ScheduleWakeup` (`stop: true` to end a loop),
`Agent` (`run_in_background`, `subagent_type`, `name`, `isolation`, `effort`), `TaskStop`, `TaskOutput`
(**removed** in v2.1.277), `SendMessage` (`to`, optional `summary`, truncate at 200 chars),
`ListAgents`, `Monitor` (`command` | `ws`), `Workflow`, `PushNotification`, `RemoteTrigger`,
`SubagentHandback`, `Bash`/`PowerShell` (`run_in_background`, `timeout`).

**Frontmatter field names, exactly.** Subagent: `name`, `description`, `tools`, `disallowedTools`,
`model`, `permissionMode`, `maxTurns`, `autoCompactWindow`, `skills`, `mcpServers`, `hooks`, `memory`,
`background`, `omitClaudeMd`, `effort`, `isolation`, `color`, `initialPrompt`, `experimental`
(+`cacheTtl`). Skill: `name`, `description`, `when_to_use`, `argument-hint`, `arguments`,
`disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`,
`context`, `agent`, `background`, `hooks`, `paths`, `shell`, `metadata`, `license`, `compatibility`.

**Paths.** `~/.claude/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`,
`~/.claude/agents/*.md`, `.claude/agents/*.md`, `.claude/loop.md`, `~/.claude/loop.md`,
`.claude/scheduled_tasks.json`, `~/.claude/scheduled-tasks/<task-name>/SKILL.md`,
`~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl`, `~/.claude/tasks/`,
`~/.claude/debug/<session-id>.txt`, `~/.claude/plugins/…`,
`<plugin>/{.claude-plugin/plugin.json,hooks/hooks.json,monitors/monitors.json,.mcp.json,.lsp.json,settings.json,skills/,commands/,agents/,bin/,themes/,output-styles/,workflows/,scripts/}`.

**Environment variables.** `CLAUDE_CODE_DISABLE_CRON`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`,
`CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`,
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`,
`CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_CODE_EFFORT_LEVEL`,
`CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS`,
`CLAUDE_CODE_ENABLE_TODO_TOOLS`, `CLAUDE_CODE_TASK_LIST_ID`, `CLAUDE_CODE_PLUGIN_DIRS`,
`CLAUDE_CODE_PLUGIN_CACHE_DIR`, `CLAUDE_CODE_SYNC_PLUGIN_INSTALL`, `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`,
`CLAUDE_CODE_TOOL_MEMORY_LIMIT`, `CLAUDE_CODE_TOOL_MEMORY_CGROUP_EXCLUDE`, `BASH_DEFAULT_TIMEOUT_MS`,
`BASH_MAX_TIMEOUT_MS`, `MCP_TIMEOUT`, `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`,
`CLAUDE_PLUGIN_OPTION_<KEY>`, `CLAUDE_PROJECT_DIR`.
