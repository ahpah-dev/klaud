# Klaud

[![Website](https://img.shields.io/badge/website-klaud--app.vercel.app-d97757?style=flat)](https://klaud-app.vercel.app)
[![Release](https://img.shields.io/github/v/release/ahpah-dev/klaud?color=24211c&label=release)](https://github.com/ahpah-dev/klaud/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-5c564c)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-d97757)](#)
[![Node](https://img.shields.io/badge/node-%3E%3D18-24211c)](#)

> **Website & Live Guide:** [klaud-app.vercel.app](https://klaud-app.vercel.app)

**v1.5.0** — a local coding agent with a built-in list of **genuinely free, no-card
OpenAI-compatible providers**. It reads and writes real files on your machine,
runs real commands, and verifies its own work — behind a warm, paper-like
interface.

Bring your own key, or bring no key at all. Nothing else to install: no npm
packages, no build step, no database. Node 18+ and the standard library.

## Cowork

Cowork is the same agent pointed at longer work instead of a conversation. Pick
**Cowork** in the composer and Klaud plans, works through the steps, and shows
its task list as it goes. Nothing about your setup changes — same provider, same
workspace, same permissions — so it is a mode, not a second product.

### Skills

A skill is a procedure you write once and Klaud loads when it is relevant, or
when you ask for it by name with `/skill-name`. Unlike a system prompt, a skill's
body is only read when it is used, so a long checklist costs nothing until you
need it.

Type **`/` in the prompt** and the skills you have installed appear above the
composer, filtered as you type — arrow keys move, Enter or Tab inserts, Escape
dismisses. The list is read from the same directories the agent reads, so the menu
cannot offer a skill Klaud would not find, and a query that matches nothing says
so instead of showing an empty box.

![The skill menu, opened by typing a slash](docs/screenshots/screenshot-skill-menu.png)

The prompt's own hint rotates every fifteen seconds between **Type / for skills**
and **How can I help you today?**, crossfading between them. It is an overlay
rather than the textarea's `placeholder` attribute, because an attribute holds a
single string and cannot animate; both lines sit in the layout the whole time and
only their opacity changes. It hides the moment you type, and the timer stops with
it.

![The prompt hint](docs/screenshots/screenshot-prompt-hint.png)

```
~/.klaud/skills/<name>/SKILL.md            personal, every project
<workspace>/.klaud/skills/<name>/SKILL.md  project, committed with the code
```

```markdown
---
name: house-style
description: House conventions for any file in this project. Use when writing or reviewing code.
when_to_use: writing code, reviewing code, style questions
---

Two-space indent, single quotes, semicolons. Never use `var`.
```

| Field | Meaning |
| --- | --- |
| `name` | Defaults to the folder name. Must be a slug (`[a-z0-9-]`). |
| `description` | What it does and **when to use it**. This is what Klaud matches on. |
| `when_to_use` | Trigger phrases, shown alongside the description. |
| `disable-model-invocation` | `true` keeps Klaud from applying it on its own; `/name` still works. |
| `allowed-tools` | Recorded and shown to the model. **Not enforced** — see below. |
| `metadata` | Anything you like. Ignored, never a crash. |

A skill folder can hold supporting files, and the body can reference its own
directory with `${KLAUD_SKILL_DIR}`. Project skills shadow personal ones of the
same name.

Two honest notes. First, `allowed-tools` is a *request*, not a wall: Klaud tells
the model which tools the skill declares and tells it to stay inside them, but
nothing prevents a call outside the list. Second, a skill's body is treated as
**untrusted**: it can come from a repository you cloned, so it arrives wrapped in
a delimiter marking it as user-authored procedure rather than part of Klaud's own
rules. It cannot change Klaud's tools or permissions, and Klaud is told to report
a skill that claims to.

### Plugins

A plugin bundles skills and subagents so one folder sets up a whole workflow.

```
~/.klaud/plugins/<name>/.claude-plugin/plugin.json   optional manifest
~/.klaud/plugins/<name>/skills/<skill>/SKILL.md
~/.klaud/plugins/<name>/agents/<agent>.md
```

The manifest is optional — without it, whatever sits in the standard layout is
loaded and the plugin takes its folder's name. Supported fields: `name`,
`displayName`, `version`, `description`, `author` (string or object), `homepage`,
`repository`, `license`, `keywords`, `defaultEnabled`, `dependencies`, and the
`skills` / `agents` path overrides. Every declared path must stay inside the
plugin's own folder; anything escaping with `../`, an absolute path, or a symlink
is rejected with a warning and never followed.

**What Klaud does not do:** real plugins can bundle hooks and MCP servers. Klaud
has neither, and a manifest declaring them gets an explicit warning saying so
rather than appearing to work.

### Subagents

A subagent is a delegate with its own context, so a long side task does not fill
the main conversation.

```markdown
---
name: file-counter
description: Counts files and reports the number. Use for quick inventory questions.
tools: list_dir
model: inherit
---

Count the files you are asked about and reply with just the number.
```

Klaud delegates to one with the `task` tool, choosing by description. Two
guarantees, both enforced in the loop rather than trusted to the model:

- **A subagent cannot delegate further.** `task` is removed from its tool schema
  entirely, so it cannot reach for it at all. Without that, one bad decision
  becomes an unbounded fan-out of real API calls on your key.
- **A subagent cannot exceed your session.** Its `tools` list narrows what it may
  use; it can never gain a tool the session lacks, and read-only mode blocks
  delegation outright because `task` counts as execution.

A subagent that stops without producing an answer is reported to Klaud as a
failure with the reason, not as a success with no text — otherwise the main model
relays a blank as though it were a result.

### Skills that ship with Klaud

Five arrive with the app, so a fresh install has something to type `/` for:

| Skill | What it does |
| --- | --- |
| `/browser` | Drive a real page — open, read, click, type, wait for slow content — and know when `fetch_url` is the better tool |
| `/computer-use` | Operate the Windows desktop through PowerShell: screenshot, list windows, focus one, move the mouse, type, press keys |
| `/code-review` | Review a change for defects: find the diff, read the touched files, report `path:line` |
| `/debug-failing-test` | Reproduce a failure, read it, minimise it, one hypothesis per change |
| `/web-research` | Answer from the web with sources you can point at, separating what a source says from what you inferred |

They are ordinary skills in every respect — same frontmatter, same `/name`
invocation, same skill menu — and they are **lowest precedence**, so your own skill
of the same name replaces one without deleting anything:

```
project  >  personal  >  bundled
```

`/computer-use` is worth a special word: it is the most dangerous thing here.
A click lands on whatever window is at those pixels and there is no undo, so it
targets the Windows desktop only, states exactly which parts were verified on which
Windows build, and says plainly that input arriving through Klaud's own
console-less shell is unconfirmed — confirm the effect in the app rather than
trusting a return value.

### Where extensions live

`GET /api/extensions` reports what is actually loaded, and the paths are:

| Kind | Personal | Project |
| --- | --- | --- |
| Skills | `~/.klaud/skills/` | `<workspace>/.klaud/skills/` |
| Plugins | `~/.klaud/plugins/` | `<workspace>/.klaud/plugins/` |
| Subagents | `~/.klaud/agents/` | `<workspace>/.klaud/agents/` |

The bundled skills live inside the app (`src/lib/skills-bundled/`), and
`KLAUD_BUNDLED_SKILLS_DIR` repoints them — which is how the test suites keep their
own fixtures isolated instead of asserting against whatever ships.

Everything is read from disk on each turn, so a skill added while Klaud is
running is picked up on your next message — no restart.

## Connections: Gmail, and acting as you

A connection lets Klaud use a real service **as you** — mail sent through Gmail
comes from your address, because it is your account it is using. Gmail is the
first connector.

### There is one thing you have to do yourself

**You must register your own OAuth client with Google.** Klaud cannot ship one: a
client secret published in a repository is not a secret, and Google requires each
user's own consent screen. That is not a limitation to work around, it is the
only correct arrangement.

1. Create a project at <https://console.cloud.google.com/>.
2. **APIs & Services → Library**, enable the **Gmail API**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
4. Choose **Desktop app**. Desktop clients accept any loopback port; a *Web
   application* client rejects the redirect and you will get
   `redirect_uri_mismatch`.
5. Copy the **client ID** and **client secret** into Settings → Connections.

Google will show an "unverified app" warning. That is expected for a personal
client and is not a Klaud problem — you are the developer and the only user.

### What Klaud asks Google for

Three scopes, and no more:

| Scope | Why |
| --- | --- |
| `gmail.readonly` | Search, read and list labels |
| `gmail.send` | Send a message — the narrowest scope that can |
| `gmail.modify` | Change labels. Gmail has no label-only write scope, so this is the minimum for that one action |

Not requested: `mail.google.com/` (full access) and `gmail.compose`. Google's
consent screen describes `gmail.modify` as the ability to "read, compose, send,
and permanently delete all your email" — accurate and alarming in equal measure,
and worth reading before you approve.

### Being honest about the tokens

They are stored as **plain JSON** in `~/.klaud/connections/` — not encrypted, and
not in your OS keychain. There is no keychain integration because every route to
one needs a native dependency, and Klaud has none. On POSIX the files are created
`0600`; on Windows the filesystem does not enforce that. **A refresh token is
durable access to your account until you revoke it** — at
<https://myaccount.google.com/permissions>.

Disconnect removes the stored credential. Revoking at Google is the
belt-and-braces version.

### What it can do

| Action | Permission |
| --- | --- |
| `gmail_search` — search the mailbox | read |
| `gmail_read` — read one message | read |
| `gmail_labels` — list labels | read |
| `gmail_modify` — add or remove labels | write |
| `gmail_send` — send a message | **send** |

`send` is a distinct permission level, not a flavour of `write`. It means *this
leaves the machine, other people see it, and it cannot be taken back*. In **Ask
first** mode it is confirmed before it goes out; **Read-only** refuses it
outright. A successful send means Gmail accepted the message for sending — which,
per Google's own documentation, is not proof it was delivered. Check Sent.

## Browsing

Klaud can drive a real browser. Ask it to look something up, check a deployment,
fill in a form, or read a page that renders with JavaScript — the kind `fetch_url`
returns as an empty shell.

It uses **Chrome, Edge, Chromium or Brave**, whichever it finds first, and speaks
the DevTools protocol over a **pipe** rather than a debug port. Two consequences
worth knowing: no TCP port is opened, so nothing else on your machine can reach
the browser while Klaud is driving it; and it works on Node 18, where the
`WebSocket` that a debug port would need does not exist.

Set `KLAUD_BROWSER` to force a specific executable.

| Tool | Permission | What it does |
| --- | --- | --- |
| `browser_goto` | read | Open a page and wait for it to load |
| `browser_read` | read | The page as clean markdown-ish text, with its links and form fields |
| `browser_screenshot` | read | Save a PNG into the working directory |
| `browser_close` | read | Close the browser and discard its session |
| `browser_click` | **write** | Click by CSS selector or by visible text |
| `browser_type` | **write** | Type into a field, optionally pressing Enter |
| `browser_eval` | **exec** | Run one JavaScript expression in the page |

Clicks and typing are dispatched as real CDP input events, not `element.click()`,
because a framework will not see a DOM-level click and the model would conclude
the page was broken. Permissions reflect what each action can do: reading a page
changes nothing of yours, but a click can buy something or post as you, so it is
confirmed in "Ask first" mode and refused outright in read-only mode.

**Three honest limitations.**

Klaud **cannot see**. Screenshots are saved for you and for the transcript; the
model's only view of a page is `browser_read`, which is text. A page that renders
to a canvas is invisible to it.

`file://` is **refused**. Every other tool is confined to the working directory by
a path check, and a browser pointed at `file:///C:/...` would read any file on the
machine and hand it back as page text. Blocking the scheme is what keeps that
boundary real.

The browser runs with a **throwaway profile**, so it holds none of your cookies
and nothing you are logged into. That is deliberate — it cannot corrupt your real
profile or leak its sessions — but it also means a site behind a login will not
work without you handling the sign-in. `browser_close` discards the session
entirely, and the profile directory with it.

### The greeting changes with the clock

An empty chat says something different depending on the hour, so the app does not
open with the same four words every single time. "Here we go!" is the anchor and
appears throughout the day; the rest are occasional.

| When | You might see |
| --- | --- |
| 05:00–10:59 | Coffee and Klaud time? · Morning. What are we building? · Fresh start? · Early. Good. |
| 11:00–16:59 | What are we working on? · Right, what next? · Coffee and Klaud time? |
| 17:00–22:59 | Evening thoughts? · Something to finish? · Evening. What is it? |
| 23:00–04:59 | Late night coding? · Still at it? · One more thing? |

It re-rolls on **New chat**, and a chat that is already open keeps the line it
started with, so it never reshuffles under you. Each line has one phrase in the
accent colour, and all of them are escaped rather than trusted.

![Klaud's empty state — cream sidebar, near-white canvas, centred greeting and prompt box](docs/screenshots/screenshot-welcome.png)

![Klaud working — an animated indicator while the model is thinking](docs/screenshots/screenshot-thinking.png)

![A morning greeting](docs/screenshots/greeting-morning.png)

```
  ◆ Klaud  local coding agent
  ────────────────────────────────────────────────
  url        http://127.0.0.1:4317
  workspace  C:\Users\you\projects\my-app
  model      agnes-3.0-flash:free
```

## Quick start

**Windows** — double-click `start-klaud.cmd`
**macOS / Linux** — `./start-klaud.sh`
**Any platform** — `npm start`, then open the URL it prints

The console prints a URL carrying a session token. Open it once and Klaud
remembers the browser. Every `/api/*` route requires that token, so a random web
page on your machine cannot drive your agent.

## Klaud CLI

The same agent in your terminal: the same nine tools, the same permission modes
and the same `~/.klaud` as the web app. Not a wrapper around it — both front
ends call the same engine in-process.

```sh
git clone https://github.com/ahpah-dev/klaud.git
cd klaud && npm i -g .

klaud                            # interactive session
klaud "fix the failing test"     # one prompt, then exit
```

A folder install works on every npm, including npm 12, which ships with
`allow-git` and `allow-remote` set to `none`. Where git installs are allowed,
`npm i -g github:ahpah-dev/klaud` does the same thing in one step.

| command | what it does |
| --- | --- |
| `klaud` | streamed replies, tool calls as they happen, approvals answered with one keypress (`y` once · `n` deny · `a` always · `r` read-only) |
| `klaud run "…"` | one shot; `--json` for scripts, `-c` / `--resume <id>` to continue a session |
| `klaud init` | guided setup: pick a free provider, paste its key, choose model and permission mode (`--provider`, `--key` skip the prompts) |
| `klaud providers --check` | the built-in no-card endpoints, probed live before printing |
| `klaud model [id]` | show or set the model; `--list` asks the endpoint what it actually has |
| `klaud config [key] [value]` | read or write any setting; `apiKey` is masked on read |
| `klaud skills` | the skills loaded into every session, with their sources |
| `klaud chats` | saved sessions and their ids, for `--resume` |
| `klaud doctor` | Node, settings, workspace writability and provider reachability in one pass |
| `klaud serve` | start the web UI from the same install |

Inside a session: `/help`, `/model`, `/permissions`, `/skills`, `/sessions`,
`/resume <id>`, `/config`, `/clear`, `/exit`. Ctrl+C cancels a running turn, and
exits from an empty line. Typing `/code-review …` invokes a skill the same way
the web app does.

Two rules the output follows, because they are what makes a CLI scriptable:

- **stdout is the answer, stderr is the chatter** — so `klaud run "…" > out.md`
  writes prose, and `--json` can own stdout with one object:
  `{finished, steps, usage, toolCalls, finalText, chatId}`.
- **exit codes mean something** — `0` done, `1` the run failed, `2` bad usage,
  `130` you cancelled it.

Flags: `--yes` (approve every write and command), `--permission-mode
auto|ask|readonly`, `--model`, `--workspace`, `--quiet`, `--verbose`,
`--no-color` (as is `NO_COLOR`). In `ask` mode a run with no terminal on stdin
refuses to start instead of approving on your behalf — pass `--yes` or
`--permission-mode readonly`.

Covered by `node test/cli.js`: 27 checks over the surface, the exit codes, a
full turn against a mock provider, and the interactive session.

## Start free — no card, ever

The **Free** button in the top bar opens a picker of endpoints that cost nothing.
Every base URL was probed and confirmed live, and the OpenRouter entry reads its
model list in real time.

**Read this before trusting a number.** Rate-limit figures are *not* verified by
Klaud. The big providers have stopped publishing fixed free-tier numbers
altogether — Google's docs now say limits depend on your usage tier and are
applied per project, and Groq's own rate-limit page calls its table "a high level
summary" and tells you to read the exact numbers from your account settings. So
each card is labelled with where its figure came from, links to the provider's
own page, and says "not published" where there is no public number to quote.

| Provider | Basis | Free tier |
| --- | --- | --- |
| **NVIDIA NIM** ⭐ | not published | **The recommended pick.** ~40 requests/minute on `nvidia/nemotron-3.5-super-vl-120b-a12b` — a model built for tool use. A rate limit refills every minute, unlike a daily quota. No card. See the caveats below. |
| **Ollama / LM Studio** | no quota | Nothing is metered. The only allowance that never runs out. |
| **Groq** | published | Free plan: 30 requests/min, 1,000/day, 8k tokens/min for `openai/gpt-oss-120b`. A full per-model table, shown in the model picker. |
| **Mistral La Plateforme** | not published | Measured in tokens, not requests: roughly 1B tokens/month and 500k tokens/min per model. Needs a phone-verified account. |
| **Google AI Studio** | not published | Google no longer publishes figures. The free tier covers Flash-class models only — Pro is excluded. |
| **Cloudflare Workers AI** | published | 10,000 Neurons/day with per-model rates published, so you can compute exactly what a model costs. **One-field setup** — see below. |
| **OpenRouter** | not published | ~50 free requests/day, ~1,000/day after a one-time $10 credit. Best model variety. |

Removed on purpose, and recorded in the app with dates and source links:

- **GitHub Models** — [retired 30 July 2026](https://github.blog/changelog/2026-07-30-github-models-is-now-retired/). Its old hostname still answers `200 OK` to every path, which is why a naive liveness check kept it listed.
- **Cerebras** — no free tier any more; a one-time $5 promotional credit that [requires a payment method](https://www.cerebras.ai/pricing) and expires in 30 days.
- **Together AI**, **SambaNova** — free tier ended and 20 requests/day respectively.

Trial-credit offers are excluded throughout.

### Two caveats on the recommended pick

NVIDIA's trial terms allow **testing, prototyping and evaluation — not production
use**, and they let NVIDIA collect de-identified prompts and outputs to improve
its models. Klaud reads your files, so that content travels to NVIDIA. Fine for
open-source work; think twice for private code. Both are on the card in the app,
not buried here.

> **Tool calling is not optional.** Reading files, editing them and running
> commands all need it. If a model refuses the tool schema, Klaud says so in the
> transcript and continues as plain chat instead of failing silently.
>
> **Rate limits are the usual reason an agent turn stalls.** An agent needs 5–15
> requests per task. Local models have no limit at all and are the only option
> that never runs out; Groq and Cloudflare are the best hosted bets.

### The recommended free setup: NVIDIA NIM

**Free → NVIDIA NIM → Set up automatically.** One free key from
[build.nvidia.com](https://build.nvidia.com/nvidia/nemotron-3.5-super-vl-120b-a12b), no card,
and the model it points at is `nvidia/nemotron-3.5-super-vl-120b-a12b` — a 120B
mixture-of-experts that activates 12B parameters per token and was built for
agentic work: reasoning, instruction following and **tool use** in one model.
NVIDIA reports it beating its own Nemotron 3 Ultra on Hermes Bench (63.4% vs
56.3%) and LangChain evals (87.1% vs 84.3%).

Why it is the default rather than Cloudflare:

| | NVIDIA NIM | Cloudflare Workers AI |
| --- | --- | --- |
| Limit kind | ~40 requests/minute | 10,000 Neurons/day |
| Runs out? | resets every minute | yes, once the day's Neurons are spent |
| Card needed | no | no |
| Account ID dance | none — just a key | needs your account ID in the URL |

The important difference is the **kind** of limit. A per-minute rate limit refills
continuously, so an agent that makes 15 requests in a turn is throttled for a
minute rather than dead until midnight. A per-day quota is spent.

Two caveats are on the card itself, because they matter for a coding agent:

- **Trial terms allow testing, prototyping and evaluation — not production use.**
- **NVIDIA may collect de-identified prompts and outputs to improve its models.**
  Klaud reads your files, so that content travels to NVIDIA. Fine for open-source
  work; think twice for private code.

Confirm the model is still served at any time — this needs no key, which is what
makes the claim checkable:

```
npm run check-nvidia
```

Pass a key to also run a live tool-calling round trip. If NVIDIA drops the model,
this says so instead of letting the recommendation go stale.

### Cloudflare: the account ID is handled for you

Cloudflare is the best-value free tier here, but its URL normally needs your
account ID — a 32-character hex string. Klaud tries to save you the trip:

1. **The account ID is read out of your token.** A Cloudflare API token is a JWT
   whose claims carry the account it was scoped to, so this usually needs no
   network call. It prefers explicit claims and only falls back to a whole-payload
   scan when a single unambiguous candidate exists.
2. **The account ID field is always visible**, and optional. If you already have
   it, paste it — that skips discovery entirely, which matters because
   account-scoped tokens cannot be discovered.
3. **A real completion is sent before anything is saved.** Nothing is written
   unless a model answers.
4. Failures name their stage and show Cloudflare's own words.

If it still refuses, `npm run check-cloudflare` tells you which of the two values
is wrong.

### OmniRoute: a free gateway on your own machine

[OmniRoute](https://github.com/diegosouzapw/OmniRoute) is MIT-licensed and runs
locally, routing across many providers' free tiers behind one OpenAI-compatible
endpoint. Klaud sets it up for you:

```
npm i -g omniroute        # needs Node 22 or newer
omniroute                 # dashboard and API on the same port
```

Then **Free → OmniRoute → Set up automatically**. Klaud looks for it on
`127.0.0.1:20128`, starts it if it is installed but not running, and sends a real
request to prove the key works before saving anything. It will not install a global
npm package on its own — that changes your machine, so the install step stays yours
and Klaud hands you the exact command instead.

Three things measured on this machine rather than read in its README:

1. **It needs its own API key even on loopback.** `/v1/models` answers
   `401 Authentication required` with no key, and a *different* `401 Invalid API key`
   with a wrong one. The key is a free local token from its dashboard
   (Dashboard → Endpoints), not a paid credential — but it is not the keyless
   provider its README implies.
2. **A first start takes about two and a half minutes** before the port answers, so
   setup waits rather than calling that a failure.
3. **What it gives you is whatever the upstreams allow.** `tier: generous` here means
   many free tiers behind a local gateway, not a quota OmniRoute grants, and it moves
   when an upstream changes its terms.

Not verified: whether its `auto` alias resolves, whether it accepts tool calls, and
whether a keyless chat request works. Its card says "documented, not tested" rather
than "model verified live" for exactly that reason.

### Any other endpoint

Anything speaking `POST {baseUrl}/chat/completions` with SSE and tool calls
works. Klaud's Settings presets lead with the free options, then the locals, then
the paid ones:

| Provider | Base URL |
| --- | --- |
| NVIDIA NIM · free | `https://integrate.api.nvidia.com/v1` |
| Groq · free | `https://api.groq.com/openai/v1` |
| Google AI Studio · free | `https://generativelanguage.googleapis.com/v1beta/openai` |
| OmniRoute · free, local | `http://127.0.0.1:20128/v1` — set up from the app |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Ollama · local | `http://localhost:11434/v1` |
| LM Studio · local | `http://localhost:1234/v1` |
| OpenAI | `https://api.openai.com/v1` |
| Mistral | `https://api.mistral.ai/v1` |
| DeepSeek | `https://api.deepseek.com/v1` |
| xAI | `https://api.x.ai/v1` |
| Cloudflare Workers AI | `https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1` |

**Test connection** verifies the key and URL line up. **Load models** queries
`{baseUrl}/models` and gives you a picker — over POST for Cloudflare, which
answers `405` to a GET, and over GET everywhere else.

Keys are stored on your machine only, in `~/.klaud/settings.json`, and are never
returned to the browser — the UI only ever sees a masked hint like
`sk-pro…••••••••4d9c`.

## What it can do

Nine tools, all confined to the working directory you choose:

| Tool | What it does |
| --- | --- |
| `read_file` | Reads UTF-8 text with line numbers, paged with `offset` / `limit` |
| `write_file` | Creates a file (and parent directories); refuses to clobber unless `overwrite: true` |
| `edit_file` | Exact-string replacement; rejects ambiguous matches and tells the model why |
| `list_dir` | Lists a directory, flat or recursive |
| `glob_files` | Finds files by pattern, e.g. `src/**/*.{js,tsx}` |
| `search_text` | Regex content search with `file:line` results |
| `run_command` | Runs a shell command, returns stdout, stderr and the real exit code |
| `fetch_url` | Reads a web page or API over the network, HTML stripped to text |
| `todo_write` | Keeps a visible task list for multi-step jobs |

The model sees each result, so it can run a build, read the error, fix the file,
and run it again — up to the step limit you configure.

### How the loop avoids getting stuck

A model that keeps asking for the same thing is the classic failure of a tool
loop, and it is worst on the free tiers this app targets. Klaud guards against it
in the loop itself rather than trusting the model to notice:
- **Identical calls are refused.** A repeat of a call already made this turn is
  answered with the earlier result and a warning; a second repeat is blocked
  outright. Calls with *different* arguments are untouched — that is real work.
  Argument comparison ignores key order, so `{"a":1,"b":2}` and `{"b":2,"a":1}`
  count as the same call.
- **A repeated step ends the turn.** If a whole step repeats, the loop stops and
  the model is asked for a final answer with tools withheld. The alternative is
  burning every remaining step and a chunk of your rate limit for nothing.
- **Failures carry a next action.** A tool error is appended with a concrete
  alternative — read the file first, check the path with `glob_files`, use the
  native shell equivalent. A bare "not found" gives the model nothing to change,
  which is exactly why it retries.
- **The step limit is announced.** Two steps before the cap the model is told to
  stop starting things and write a summary, so a long job ends with a hand-off
  rather than mid-sentence.
- **A silent finish is challenged once.** Some models complete the work and then
  end the turn without writing anything, leaving an empty reply. Klaud asks once,
  explicitly, for prose. If the model stays silent it says so rather than showing
  a blank transcript.
- **Throttling is respected, not hammered.** `Retry-After` and waits quoted in
  the provider's message ("retry in 42s") are honoured. A fixed 1.5s backoff
  against a per-minute free tier just burns every attempt and reports a failure
  that would have cleared on its own. A wait longer than a minute fails fast with
  the reason instead of appearing to hang.

- **A wait never looks like a hang.** Between sending and the first token the
  transcript used to be blank, which on a slow free tier is the longest part of
  the turn. There is now a working indicator — a breathing mark, three dots
  pulsing in sequence, and a sheen across the label — that names the phase
  ("Thinking · step 2/4", "Running run_command", "Reasoning") and appears again
  after each tool result, while the model reads it. It is disabled under
  `prefers-reduced-motion`, which leaves a static row rather than a blank one.

### Permissions

Three modes, switchable from the top bar:

- **Auto-run** — no prompts. Fastest, and the default.
- **Ask first** — every write and every command waits for your approval, shown
  inline in the transcript with the exact arguments.
- **Read-only** — all writes and command execution are refused, by the server,
  not just hidden in the UI.

### The working directory and folder picker

Click the folder in the sidebar to change where Klaud works. Type a full path and
press Enter to jump anywhere, click a folder to descend into it, or use **New
folder** to create one where you are. The **Use "name"** button always names the
folder it will select, so there is no guessing which one you are about to switch
to.

## Safety model

Klaud runs a model's instructions against your filesystem, so the boundaries are
enforced in code, not in the prompt:

- **Path confinement.** Every path goes through `resolveInside(root, input)`,
  which resolves and then rejects anything outside the workspace — `../`,
  absolute paths and null bytes included. The check is on the resolved path.
- **Loopback only.** The server binds `127.0.0.1` and requires the session token
  on every API route.
- **A way back in.** If the browser holds a stale token, every request would
  401 — including the settings call. Instead Klaud shows a screen with a
  **Re-authorize this browser** button: it asks the server to open a fresh tab
  with a valid session, which only ever acts on the machine it runs on. Pasting
  the token from `~/.klaud/session.json` remains as a fallback, and the server
  reprints its working URL in the terminal whenever it rejects a request.
- **Destructive commands are refused.** Patterns like `rm -rf /`, `mkfs`,
  `diskpart`, `format C:` and fork bombs are blocked before spawning.
- **Real exit codes.** Windows shells report a child's non-zero exit as `1` and
  a failed cmdlet as `0`; Klaud wraps commands so the model sees the truth —
  otherwise it "fixes" builds that were never broken.
- **Timeouts and truncation.** Commands are killed at the limit (60s default,
  120s max); tool output is capped so one huge file cannot eat the context.
- **Symlink policy.** Path confinement is lexical. A symlink inside the
  workspace that points outside it will be followed. Do not point the workspace
  at a directory whose symlinks you do not trust.

## Configuration

Change any of this in Settings, or edit `~/.klaud/settings.json` directly.

| Setting | Default | Notes |
| --- | --- | --- |
| Base URL | `https://api.openai.com/v1` | Anything OpenAI-compatible |
| API key | — | Stored locally, never sent to the browser |
| Model | `gpt-4o-mini` | Load the full list from the endpoint |
| Temperature | `0.2` | 0.1–0.3 is best for editing code |
| Reasoning effort | Provider default | A slider: Provider default / Low / Medium / High. See below. |
| Steps per turn | `12` | Tool round trips allowed in one request (max 40) |
| History budget | `80000` | Characters of transcript per request (~20k tokens). Older turns are dropped when a long session outgrows it, newest kept. |
| Working directory | The folder Klaud runs in | All tools are confined here |
| Tool permissions | Auto-run | See above |
| System prompt | A coding-agent prompt | Replace it for different behaviour |

Environment overrides: `PORT`, `KLAUD_HOST`, `KLAUD_WORKSPACE`,
`KLAUD_DATA_DIR`, `KLAUD_OPEN=1`.

### Reasoning effort, and why most providers get nothing

There is no standard field for this, so Klaud sends the one each host documents
and **sends nothing at all** to everyone else:

| Host | Field sent |
| --- | --- |
| `api.openai.com` | `reasoning_effort: "low" \| "medium" \| "high"` |
| `openrouter.ai` | `reasoning: { effort: … }` — OpenRouter's normalised form, which it translates for whichever model it routes to |
| `integrate.api.nvidia.com` | **nothing** — NVIDIA's NIM reference documents no effort parameter |
| Groq, Google AI Studio, Mistral, DeepSeek, xAI, Cloudflare, Ollama, LM Studio, anything unknown | **nothing** |

Silence is deliberate, not an oversight. A provider that does not recognise a
body parameter can reject the entire request with a `400`, so one wrong guess
kills the turn. "OpenAI-compatible" does not mean "tolerates unknown keys", and
the Settings panel says plainly which of the two is happening for your endpoint.

"Provider default" leaves the parameter off entirely, so nothing changes unless
you move the slider.

## Where your data lives

```
~/.klaud/
  settings.json      provider config and API key
  session.json       the local API token
  chats/*.json       one file per conversation
```

Klaud was previously called Forge. On first run it adopts an existing `~/.forge`
directory, so saved conversations and keys carry over instead of vanishing.

Delete the folder to reset everything. Nothing is sent anywhere except to the API
endpoint you configure.

## Architecture

A single Node process serves the UI and runs the agent loop; the browser holds
the transcript and renders the stream.

```
src/
  server.js        HTTP + SSE API, static files, token auth
  agent.js         the loop: model -> tool calls -> results -> model
  llm.js           OpenAI-compatible streaming client, tool-call assembly
  providers.js     the free-provider catalogue and live free-model lookup
  store.js         JSON persistence for chats and settings
  config.js        paths, limits, defaults, data-dir migration
  lib/
    tools.js       the nine tools, shell wrapper, diffing
    fsutil.js      path confinement, glob matching, tree walking
public/
  index.html       shell markup + SVG icon sprite
  styles.css       design tokens, light and dark themes, polish layer
  app.js           transcript rendering, SSE client, settings and pickers
  markdown.mjs     dependency-free markdown renderer
test/
  run.js                  62 unit and integration checks
  markdown.mjs            29 renderer and escaping checks
  ui-static.js            28 frontend integrity checks
  cloudflare-token.mjs    16 token claim extraction checks
  cloudflare-setup.js     27 setup-path checks against a stand-in API
  cloudflare-errors.js    40 Cloudflare error-reporting checks
  providers.js            53 free-provider catalogue checks
  e2e-http.js             37 checks against a live server
  auth-recovery.js        21 session token recovery checks
  folder-picker.js        30 folder browser and workspace checks
  browser.js              66 checks driving the app in headless Chrome
```

The agent loop lives on the server so a browser refresh cannot corrupt a turn,
and so tool calls execute next to the files they touch. Events stream to the
browser as they happen (`text`, `reasoning`, `tool_call`, `tool_result`,
`todos`, `approval_request`, `usage`), which is why you watch the work instead of
waiting for it.

### API

Everything under `/api/*` needs the `x-klaud-token` header.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness (public) |
| `POST` | `/api/authorize` | Open a fresh authorized tab (loopback callers only) |
| `GET` | `/api/info` | Platform, shell, tool catalogue |
| `GET` | `/api/providers/free` | The free-provider catalogue, with live free models |
| `POST` | `/api/providers/setup` | One-field setup (Cloudflare): resolves the account, tests, saves |
| `GET` `PATCH` | `/api/settings` | Read or update configuration |
| `POST` | `/api/models` | List models from the configured endpoint |
| `POST` | `/api/models/test` | Verify key + URL + model |
| `POST` | `/api/chat` | Run a turn; streams SSE |
| `POST` | `/api/chat/:turnId/cancel` | Stop a running turn |
| `POST` | `/api/chat/:turnId/approval` | Answer a permission request |
| `POST` | `/api/tool` | Execute one tool directly |
| `GET` `POST` `DELETE` | `/api/chats` | List, create, clear conversations |
| `GET` `PUT` `DELETE` | `/api/chats/:id` | Read, save or delete one |
| `GET` | `/api/fs` | Browse directories for the workspace picker |
| `POST` | `/api/fs/mkdir` | Create a folder from the workspace picker |
| `GET` | `/api/extensions` | What skills, plugins and subagents are actually loaded |

## Testing

```
npm test
```

2178 checks in total, no test framework, no dependencies. Every suite is
self-contained: they spawn their own servers on throwaway data directories, so
running the tests can never disturb your real configuration.

| Suite | Checks | What it proves |
| --- | --- | --- |
| `test/run.js` | 126 | Tool sandbox, shell exit codes, LLM client, agent loop, **loop detection**, reasoning-effort wire format, retry timing, **time-of-day greeting**, **connector credentials in the settings store**, history pruning |
| `test/markdown.mjs` | 107 | Markdown rendering and HTML escaping, including table cells, nested lists, ordered-list starts, `<hr>`, and a 10-shape XSS battery through every hard path |
| `test/ui-static.js` | 38 | Element ids, icon sprite, CSS coverage, module wiring, working-indicator animations |
| `test/skills.js` | 70 | Frontmatter parsing, discovery, shadowing, the slash-command parser, and that a skill body is wrapped as untrusted |
| `test/bundled-skills.js` | 18 | The five shipped skills: discovered as `bundled`, project and personal both beat them, `/name` works, and **every tool name mentioned in every skill body exists in the real catalogue** — the check that stops a skill drifting as tools change |
| `test/plugins.js` | 124 | Manifests, optional manifests, path containment against `../` and symlink escapes, dependencies, and that hooks and MCP are reported as unimplemented |
| `test/agents.js` | 143 | Subagent definitions, all three `tools` shapes, shadowing, and the `task` shim's behaviour with and without a runner |
| `test/extensions.js` | 72 | The joins: a skill reaching a real request, **a subagent not being offered the `task` tool**, **a subagent's own writes being approved rather than slipping through**, honest reporting of an answerless subagent, and a malformed plugin degrading to a warning |
| `test/connectors.js` | 44 | The registry: an unsafe id refused, a file that throws on load contained, duplicate ids, sibling `actions`/`scopes` exports, and that every shipped connector resolves an API root |
| `test/oauth.js` | 150 | PKCE against the RFC 7636 vector, a real loopback exchange against a mock token endpoint, `state` mismatch refusing to exchange, timeout closing its socket, absolute `expires_at`, refresh only when expired, and that a 5xx is retryable while `invalid_grant` needs a reconnect |
| `test/connectors-gmail.js` | 251 | The Gmail API contract against mocks: base64url bodies, multipart walking, the RFC 2047 subject round trip, every documented error reason mapped, and that no full-access scope is requested |
| `test/api-tool.js` | 112 | The `send` permission level: refused under read-only with its own wording, `write`/`exec` refusals unchanged, a missing connector registry degrading to an empty tool list, and that no token ever appears in the prompt text |
| `test/cloudflare-token.mjs` | 16 | Account IDs are read from every token claim shape, and never guessed |
| `test/cloudflare-setup.js` | 42 | The setup path against a stand-in Cloudflare API, including empty account lists |
| `test/cloudflare-errors.js` | 51 | Every Cloudflare failure explains itself; a bare "unknown" is impossible |
| `test/providers.js` | 80 | Catalogue honesty, the NVIDIA recommendation, live lookups, no silent config changes, and that a loopback gateway over metered upstreams never claims to be unmetered |
| `test/omniroute.js` | 121 | Detecting, starting and installing a local gateway against a mock: a refused connection as a normal "not running", the Node floor refusing to start, no install without consent, and the stored-key decision across its three branches |
| `test/e2e-http.js` | 41 | The full HTTP and SSE API, malformed-request resilience, and that the tool catalogue reports every tool before a turn has run |
| `test/auth-recovery.js` | 21 | A stale session token can be recovered with one click |
| `test/folder-picker.js` | 30 | Typing a path, creating a folder, switching workspace |
| `test/browser-extract.js` | 166 | Turning a page into readable text: headings, nested lists, code, tables, boilerplate collapse, truncation, and that a hostile page makes it warn rather than throw |
| `test/browser-tools.js` | 87 | The browser subsystem against a **real Chrome** and a local site: the URL policy (`file://` refused), the two permission levels, click/type/Enter actually driving the page, screenshot containment, and every failure path explaining itself |
| `test/browser.js` | 268 | The app driven in headless Chrome, start to finish: no accent ring on a mouse click, the Chat/Cowork toggle and its persisted mode, the diff reader, the connections payload not being double-wrapped, and **the prompt hint and skill menu** — including that the crossfade is two overlaid lines rather than a text swap |

`test/browser.js` is the important one. It launches Chrome, loads the real page,
and fails on any uncaught exception or console error. It then types a message,
clicks send, waits for the reply to stream in, and checks that the file really
appeared on disk. A suite that only inspects markup cannot catch "the page loads
but nothing runs", which is exactly the class of bug that matters most here.

The browser suite writes screenshots to `docs/` so you can see what it saw.

## Troubleshooting

**Cloudflare fails and you want to know exactly why** — run the checker instead
of reading a UI:

```
npm run check-cloudflare
```

It uses the token already in your settings, prints Cloudflare's raw response for
every step, and says which of the two values is wrong. Pass your account ID to
test a different one:

```
npm run check-cloudflare -- 0264a5ba1b8e355492b8570976239fb3
```

**Copying a URL from documentation** — the `{account_id}` and similar bracketed
parts in this file are **placeholders, not part of the URL**. Pasted verbatim they
produce `URL rejected: Bad hostname` from curl, because Windows treats `<` and `>`
as redirections. Replace the bracketed part with your own 32-character account
ID, or let Klaud build the URL for you via **Free → Cloudflare → Set up
automatically**. Klaud now detects leftover brackets and says so instead of
sending a broken request.

**"This browser needs to be re-authorized"** — the tab holds a session token
from an earlier server run. Click **Re-authorize this browser**; a fresh tab with
a valid session opens and you are back in. If that fails, open the URL the server
prints (it reprints it in the terminal whenever it rejects a request), or paste
the `token` value from `~/.klaud/session.json` under "That didn't work".

**"No API key configured"** — click **Free** in the top bar, or open Settings.

**`HTTP 404` from the provider** — the base URL usually needs to end in `/v1`.

**`HTTP 401` from the provider** — that is the *model* rejecting your API key,
not Klaud rejecting your session.

**`Too many requests. The free tier allows 1 request(s) every 1 min`** — you are
on a very tight free tier. An agent turn needs several requests, so it will feel
stalled. Switch to a different free provider — Ollama runs locally with no quota
at all, and NVIDIA NIM or Groq allow far more than a shared 1-request-per-minute
tier — or paste your own key.

**`503 All providers for model X are busy`** — the free model you picked is rate
limited upstream. This is not a typo in the model name. Pick another from the
dropdown.

**The model never calls tools** — it can't. Klaud detects the rejection, warns
you in the transcript, and continues as plain chat. Pick a tool-capable model.

**A long session gets slow or expensive** — lower the history budget in
Settings. Klaud drops the oldest turns and tells you when it does.

**The page loads but nothing is clickable** — hard-reload with `Ctrl+Shift+R`.

## License

MIT. Do what you like with it.
