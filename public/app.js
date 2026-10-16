/* ==========================================================================
   Klaud — client application
   Drives the agent loop against POST /api/chat (SSE), renders the transcript,
   and manages chats, settings and the working directory.
   ========================================================================== */

import { renderMarkdown, decorateCodeBlocks, escapeHtml } from './markdown.mjs';

/* ------------------------------------------------------------------ *
 * Session token
 * ------------------------------------------------------------------ */

const settings = { token: '', info: null };

function readToken() {
  const fromHash = new URLSearchParams(location.hash.replace(/^#/, '')).get('token');
  const fromQuery = new URLSearchParams(location.search).get('token');
  const stored = (() => {
    try {
      return localStorage.getItem('klaud.token');
    } catch {
      return null;
    }
  })();
  const token = fromHash || fromQuery || stored || '';
  try {
    if (token) localStorage.setItem('klaud.token', token);
  } catch { /* private mode */ }
  if (fromHash || fromQuery) {
    // Strip the token from the address bar and history.
    history.replaceState(null, '', location.pathname + (location.hash.includes('chat=') ? location.hash : ''));
  }
  settings.token = token;
  return token;
}

async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-klaud-token': settings.token,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text.slice(0, 400) };
  }
  if (!res.ok) {
    if (res.status === 401) {
      // The stored token is stale. Say what to do, and let the server print the
      // working URL to its console.
      const err = new Error(
        'This browser is using a session token the server no longer accepts. ' +
          `Open the URL printed by the server (http://127.0.0.1:${location.port}/?token=...) and the app will re-authorize.`
      );
      err.status = 401;
      err.unauthorized = true;
      throw err;
    }
    const message = payload?.error || `HTTP ${res.status}`;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * App state
 * ------------------------------------------------------------------ */

const state = {
  config: null,
  chats: [],
  chatId: null,
  title: '',
  messages: [], // API-format history
  blocks: [], // UI-format transcript
  streaming: false,
  controller: null,
  turnId: null,
  pendingApproval: null,
  steps: { index: 0, max: 0 },
  usage: null,
  toolCount: 0,
  unauthorized: false,
  // The greeting currently on screen, so a re-render does not reshuffle it.
  greeting: null,
};

const el = (id) => document.getElementById(id);

const dom = {
  sidebar: el('sidebar'),
  chatList: el('chat-list'),
  messages: el('messages'),
  scroller: el('scroller'),
  prompt: el('prompt'),
  send: el('send'),
  sendIcon: el('send-icon'),
  modelName: el('model-name'),
  modelDot: el('model-dot'),
  composerModeLabel: el('composer-mode-label'),
  wsPath: el('ws-path'),
  composerWs: el('composer-ws-label'),
  toasts: el('toasts'),
  modalRoot: el('modal-root'),
  hint: el('composer-hint'),
  themeIcon: el('theme-icon'),
};

/* ------------------------------------------------------------------ *
 * Utilities
 * ------------------------------------------------------------------ */

function toast(message, ms = 3800) {
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  dom.toasts.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 250);
  }, ms);
}

function icon(id, cls = '') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

const TOOL_ICONS = {
  read_file: 'i-file',
  write_file: 'i-pencil',
  edit_file: 'i-pencil',
  list_dir: 'i-folder',
  glob_files: 'i-search',
  search_text: 'i-search',
  run_command: 'i-terminal',
  fetch_url: 'i-globe',
  todo_write: 'i-list',
};

function toolIcon(name) {
  return TOOL_ICONS[name] || 'i-sparkle';
}

function shortPath(p) {
  const s = String(p ?? '');
  if (s.length <= 42) return s;
  const parts = s.split(/[\\/]/);
  return `…/${parts.slice(-2).join('/')}`;
}

/** One-line summary of a tool call: `read_file src/app.js`. */
function toolSummary(name, args) {
  if (!args || typeof args !== 'object') return '';
  if (args.__parse_error) return 'invalid JSON arguments';
  switch (name) {
    case 'read_file':
      return `${shortPath(args.path)}${args.offset ? ` @${args.offset}` : ''}`;
    case 'write_file':
      return `${shortPath(args.path)}${args.overwrite ? ' (overwrite)' : ''}`;
    case 'edit_file':
      return shortPath(args.path);
    case 'list_dir':
      return shortPath(args.path || '.');
    case 'glob_files':
      return `${args.pattern}${args.path ? ` in ${shortPath(args.path)}` : ''}`;
    case 'search_text':
      return `/${args.pattern}/${args.include ? ` in ${args.include}` : ''}`;
    case 'run_command':
      return String(args.command || '').slice(0, 90);
    case 'fetch_url':
      return String(args.url || '').slice(0, 70);
    case 'todo_write':
      return `${Array.isArray(args.todos) ? args.todos.length : 0} tasks`;
    default:
      return Object.keys(args).length ? JSON.stringify(args).slice(0, 70) : '';
  }
}

function prettyArgs(args) {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** Turn a tool result into readable text, unwrapping JSON when useful. */
function prettyResult(text) {
  const s = String(text ?? '');
  const trimmed = s.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return JSON.stringify(parsed, null, 2);
    } catch { /* not JSON after all */ }
  }
  return s;
}

function isNearBottom() {
  const s = dom.scroller;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
}

function scrollToBottom(force = false) {
  if (!force && !isNearBottom()) return;
  requestAnimationFrame(() => {
    dom.scroller.scrollTop = dom.scroller.scrollHeight;
  });
}

function formatTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* ------------------------------------------------------------------ *
 * Rendering — transcript
 * ------------------------------------------------------------------ */

/**
 * Mark the shell as having no transcript, so CSS can centre the greeting and
 * the composer as one block. Kept in a single helper because the welcome is
 * rendered from three different places, and doing this inline in only one of
 * them left the other two with the un-centred layout.
 */
function setEmptyShell(empty) {
  document.querySelector('.app')?.classList.toggle('is-empty', empty);
}

/**
 * The greeting on an empty chat, chosen from the local clock.
 *
 * "Here we go!" is the anchor and appears throughout the day; the others are
 * occasional, so the greeting feels alive without turning into a novelty every
 * time. The weighting is deliberate: a time-specific line repeated on every new
 * chat stops being charming after the third one, which is why each of them is a
 * single entry in a pool that the anchor fills out.
 *
 * The hour is a parameter rather than a call to `new Date()` inside, so the
 * buckets can actually be tested. The roll is a parameter too, for the same
 * reason: `test/run.js` drives both and asserts the distribution.
 *
 * Returns { text, emphasis } where `emphasis` is the part rendered in the accent
 * colour, or null. Kept as data rather than markup so the caller decides how to
 * present it.
 */
const GREETING_BUCKETS = [
  {
    // Past 11pm. A different flavour of late: still working, or still awake.
    name: 'late-night',
    hours: [23, 0, 1, 2, 3, 4],
    options: [
      { text: 'Here we go!', emphasis: 'go' },
      { text: 'Late night coding?', emphasis: 'Late night' },
      { text: 'Still at it?', emphasis: 'Still' },
      { text: 'Here we go!', emphasis: 'go' },
      { text: 'One more thing?', emphasis: 'One more' },
    ],
  },
  {
    // Early, before the day has properly started.
    name: 'morning',
    hours: [5, 6, 7, 8, 9, 10],
    options: [
      { text: 'Here we go!', emphasis: 'go' },
      { text: 'Coffee and Klaud time?', emphasis: 'Coffee' },
      { text: 'Morning. What are we building?', emphasis: 'Morning' },
      { text: 'Fresh start?', emphasis: 'Fresh' },
      { text: 'Here we go!', emphasis: 'go' },
      { text: 'Early. Good.', emphasis: 'Early' },
    ],
  },
  {
    // The long middle of the day, where most work happens.
    name: 'midday',
    hours: [11, 12, 13, 14, 15, 16],
    options: [
      { text: 'Here we go!', emphasis: 'go' },
      { text: 'What are we working on?', emphasis: 'working' },
      { text: 'Here we go!', emphasis: 'go' },
      { text: 'Right, what next?', emphasis: 'next' },
      { text: 'Here we go!', emphasis: 'go' },
      { text: 'Coffee and Klaud time?', emphasis: 'Coffee' },
    ],
  },
  {
    // Evening, winding down or picking something up again.
    name: 'evening',
    hours: [17, 18, 19, 20, 21, 22],
    options: [
      { text: 'Here we go!', emphasis: 'go' },
      { text: 'Evening thoughts?', emphasis: 'Evening' },
      { text: 'Here we go!', emphasis: 'go' },
      { text: 'Something to finish?', emphasis: 'finish' },
      { text: 'Here we go!', emphasis: 'go' },
      { text: 'Evening. What is it?', emphasis: 'Evening' },
    ],
  },
];

function greetingForHour(hour) {
  const h = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 12;
  return GREETING_BUCKETS.find((b) => b.hours.includes(h)) || GREETING_BUCKETS[2];
}

function pickGreeting(hour = new Date().getHours(), roll = Math.random()) {
  const bucket = greetingForHour(hour);
  const index = Math.min(
    bucket.options.length - 1,
    Math.max(0, Math.floor(roll * bucket.options.length))
  );
  return { ...bucket.options[index], bucket: bucket.name };
}

/** The `<em>` that carries the accent, or the plain text when there is none. */
function greetingMarkup(greeting) {
  const { text, emphasis } = greeting;
  if (!emphasis) return escapeHtml(text);
  const at = text.indexOf(emphasis);
  if (at === -1) return escapeHtml(text);
  return (
    escapeHtml(text.slice(0, at)) +
    `<em>${escapeHtml(emphasis)}</em>` +
    escapeHtml(text.slice(at + emphasis.length))
  );
}

function renderWelcome() {
  const hasKey = state.config?.hasApiKey;
  const ws = state.config?.workspace || '';
  setEmptyShell(true);
  // Held on state so a re-render during the same empty chat — a reconnect, a
  // settings change — does not reshuffle the greeting under the user.
  if (!state.greeting) state.greeting = pickGreeting();
  dom.messages.innerHTML = `
    <div class="welcome">
      <svg class="mark" aria-hidden="true"><use href="#i-mark"/></svg>
      <h1>${greetingMarkup(state.greeting)}</h1>
      ${
        hasKey
          ? ''
          : `<div class="setup-note">
              ${icon('i-gift')}
              <div>
                <strong>Start free — no card, no cost</strong>
                Klaud runs on any OpenAI-compatible endpoint, and several good ones cost nothing.
                The best of them for an agent is <strong>NVIDIA NIM</strong>, which serves
                Nemotron 3.5 Super VL — a model built for tool use — at about 40 requests a
                minute, with a free key and no card.
                <div class="setup-actions">
                  <button class="btn btn-primary btn-sm" type="button" data-open-free>
                    ${icon('i-gift')} Browse free providers
                  </button>
                  <button class="btn btn-ghost btn-sm" type="button" data-open-settings>
                    ${icon('i-key')} I have a key
                  </button>
                </div>
              </div>
            </div>`
      }
      <div class="suggestions">
        <button class="suggestion" data-prompt="Explore this project and tell me what it does. Then list three concrete improvements.">
          <div class="t">${icon('i-search')}Understand this project</div>
          <div class="d">Read the files in ${escapeHtml(shortPath(ws || 'the working directory'))} and explain the architecture.</div>
        </button>
        <button class="suggestion" data-prompt="Create a small Node.js script in this folder that fetches a URL and prints the page title. Then run it to prove it works.">
          <div class="t">${icon('i-terminal')}Write and run a script</div>
          <div class="d">Klaud creates the file, runs it, and shows you the real output.</div>
        </button>
        <button class="suggestion" data-prompt="Look at the code in this folder and find any bug, crash risk or obvious security problem. Explain each one with the file and line, and offer to fix it.">
          <div class="t">${icon('i-shield')}Find bugs and risks</div>
          <div class="d">A review pass over the working directory with file citations.</div>
        </button>
        <button class="suggestion" data-prompt="Set up a minimal HTML, CSS and JavaScript web page in a folder called demo, with a working interactive counter, then tell me how to open it.">
          <div class="t">${icon('i-pencil')}Scaffold something new</div>
          <div class="d">Multi-file scaffolding with parent directories created for you.</div>
        </button>
      </div>
    </div>`;

  dom.messages.querySelectorAll('[data-prompt]').forEach((node) => {
    node.addEventListener('click', () => {
      dom.prompt.value = node.dataset.prompt;
      autosize();
      submit();
    });
  });
  dom.messages.querySelectorAll('[data-open-settings]').forEach((node) => {
    node.addEventListener('click', openSettings);
  });
  dom.messages.querySelectorAll('[data-open-free]').forEach((node) => {
    node.addEventListener('click', openFreeProviders);
  });
}

function roleHeader(label, note = '') {
  return `<div class="role">${icon('i-mark')}<span>${escapeHtml(label)}</span>${
    note ? `<span class="stream-note">${escapeHtml(note)}</span>` : ''
  }</div>`;
}

function renderTodos(todos) {
  if (!Array.isArray(todos) || !todos.length) return '';
  const items = todos
    .map((t) => {
      const status = t.status || 'pending';
      const mark = status === 'completed' ? '☑' : status === 'in_progress' ? '▸' : '☐';
      const cls = status === 'completed' ? 'done' : status === 'in_progress' ? 'active' : '';
      return `<li class="${cls}"><span class="mark">${mark}</span><span>${escapeHtml(t.content || '')}</span></li>`;
    })
    .join('');
  return `<div class="todos"><div class="head">Task list</div><ul>${items}</ul></div>`;
}

function renderToolCard(call) {
  const stateClass = call.running ? 'running' : call.ok === false ? 'failed' : 'ok';
  const statusIcon = call.running ? 'i-spinner' : call.ok === false ? 'i-x' : 'i-check';
  const summary = toolSummary(call.name, call.args);
  const meta = [];
  if (call.durationMs !== undefined && call.durationMs !== null) meta.push(`${call.durationMs} ms`);
  if (call.denied) meta.push('denied by you');
  meta.push(call.running ? 'running…' : call.ok === false ? 'failed' : 'ok');

  const body = call.result
    ? `<div class="tool-body"><pre>${escapeHtml(prettyResult(call.result))}</pre></div>`
    : call.running
      ? ''
      : '<div class="tool-body"><pre>(no output)</pre></div>';

  return `
    <details class="tool ${stateClass}" ${call.ok === false ? 'open' : ''} data-tool="${escapeHtml(call.id)}">
      <summary class="tool-head">
        ${icon('i-chevron', 'chev')}
        ${icon(toolIcon(call.name), 'tool-icon')}
        <span class="name">${escapeHtml(call.name)}</span>
        <span class="arg">${escapeHtml(summary)}</span>
      </summary>
      <div class="tool-body"><pre>${escapeHtml(prettyArgs(call.args))}</pre></div>
      ${body}
      <div class="tool-meta">${meta.map(escapeHtml).join('<span>·</span>')}</div>
    </details>`;
}

/**
 * The row shown while the model is working but has not said anything yet.
 *
 * Without this a turn starts as a blank column: the assistant block has no text,
 * no reasoning and no tool card, so `renderBlock` had nothing to return and the
 * user saw nothing at all until the first token arrived. That is worst on a slow
 * free tier, where the wait is the longest.
 *
 * The three dots are written out as real `<circle>` elements rather than pulled
 * in from the icon sprite with `<use>`. A `<use>` renders its target inside a
 * shadow tree, which cannot be queried or measured from the page, so the
 * staggered animation could neither be verified nor safely relied upon.
 *
 * `data-phase` drives the label text; the caller updates that in place rather
 * than re-rendering, so the animation never restarts mid-wait.
 */
function thinkingRow(label = 'Thinking') {
  return `<div class="thinking-row" data-thinking aria-live="polite">
    <span class="tr-mark">${icon('i-mark')}</span>
    <svg class="tr-dots" viewBox="0 0 24 12" aria-hidden="true">
      <circle cx="4" cy="6" r="2.4" /><circle cx="12" cy="6" r="2.4" /><circle cx="20" cy="6" r="2.4" />
    </svg>
    <span class="tr-label" data-thinking-label>${escapeHtml(label)}</span>
  </div>`;
}

function renderBlock(block) {
  if (block.kind === 'user') {
    return `<div class="turn user"><div class="bubble-user">${escapeHtml(block.text)}</div></div>`;
  }

  const parts = [];

  if (block.notices?.length) {
    for (const notice of block.notices) {
      const level = notice.level === 'error' ? 'error' : notice.level === 'warn' ? 'warn' : 'info';
      const iconId = level === 'error' ? 'i-x' : level === 'warn' ? 'i-warn' : 'i-info';
      parts.push(
        `<div class="notice ${level}">${icon(iconId)}<div>${escapeHtml(notice.message)}</div></div>`
      );
    }
  }

  if (block.todos) parts.push(renderTodos(block.todos));

  if (block.approval && block.approval.state === 'pending') {
    const a = block.approval;
    parts.push(`
      <div class="approval" data-approval="${escapeHtml(a.id)}">
        <div class="head">${icon('i-shield')}<span>Permission required</span></div>
        <p>Klaud wants to run <code>${escapeHtml(a.name)}</code>. Review the arguments below before approving.</p>
        <pre>${escapeHtml(prettyArgs(a.args))}</pre>
        <div class="row">
          <button class="btn btn-primary btn-sm" data-approve="yes">Allow once</button>
          <button class="btn btn-ghost btn-sm" data-approve="no">Deny</button>
        </div>
      </div>`);
  }

  for (const item of block.items || []) {
    if (item.type === 'text') {
      if (!item.text && !item.streaming) continue;
      parts.push(
        `<div class="prose" data-text="${escapeHtml(item.id)}">${renderMarkdown(item.text)}${
          item.streaming && state.streaming ? '<span class="cursor"></span>' : ''
        }</div>`
      );
    } else if (item.type === 'reasoning') {
      parts.push(`
        <details class="thinking" ${item.open ? 'open' : ''}>
          <summary>${icon('i-brain')}<span>Thought for a moment</span></summary>
          <div class="body">${escapeHtml(item.text)}</div>
        </details>`);
    } else if (item.type === 'tool') {
      parts.push(renderToolCard(item));
    } else if (item.type === 'notice') {
      const level = item.level === 'error' ? 'error' : item.level === 'warn' ? 'warn' : 'info';
      const iconId = level === 'error' ? 'i-x' : level === 'warn' ? 'i-warn' : 'i-info';
      parts.push(`<div class="notice ${level}">${icon(iconId)}<div>${escapeHtml(item.message)}</div></div>`);
    }
  }

  // Nothing to show yet: this is the gap the indicator fills. Returning '' here
  // is what produced the blank column.
  const isCurrent = block === currentTurn();
  const trailing = (block.items || [])[block.items.length - 1];
  // A wait can also happen *after* a tool result, while the model reads it and
  // decides what to do next. Text streaming already shows a live cursor, so the
  // indicator is only added when the last thing on screen is a finished tool
  // card or a reasoning panel — otherwise there would be two live indicators.
  const waitingAfterWork =
    state.streaming &&
    isCurrent &&
    parts.length > 0 &&
    trailing &&
    trailing.type !== 'text' &&
    !(trailing.type === 'tool' && trailing.running);

  if (!parts.length) {
    // Nothing streamed yet. The indicator carries its own mark, so rendering the
    // role header too would stack three of them down the left edge: the empty
    // role row, the mark in the row, and the indicator. One row is enough.
    if (state.streaming || block.working) return `<div class="turn assistant">${thinkingRow()}</div>`;
    return '';
  }

  let note = '';
  if (state.streaming && state.steps.max) {
    const busy = (block.items || []).some((i) => i.streaming);
    if (busy) {
      note = state.steps.max > 1 ? `step ${state.steps.index}/${state.steps.max}` : 'working';
    }
  }

  if (waitingAfterWork) parts.push(thinkingRow('Thinking'));

  return `<div class="turn assistant">${roleHeader(state.config?.model || 'assistant', note)}<div class="block-body">${parts.join('')}</div></div>`;
}

function renderTranscript() {
  if (!state.blocks.length) {
    renderWelcome();
    return;
  }
  setEmptyShell(false);
  dom.messages.innerHTML = state.blocks.map(renderBlock).join('');
  dom.messages.querySelectorAll('.prose pre[data-lang]').forEach((pre) => decorateCodeBlocks(pre.parentElement || dom.messages));
  wireApprovalButtons();
  scrollToBottom();
}

/** Patch just the streaming text node instead of re-rendering everything. */
function patchStreamingText(item) {
  const node = dom.messages.querySelector(`[data-text="${CSS.escape(item.id)}"]`);
  if (!node) {
    renderTranscript();
    return;
  }
  node.innerHTML = renderMarkdown(item.text) + (state.streaming ? '<span class="cursor"></span>' : '');
  scrollToBottom();
}

function patchToolCard(call) {
  let node = dom.messages.querySelector(`details[data-tool="${CSS.escape(call.id)}"]`);
  if (!node) {
    renderTranscript();
    return;
  }
  const holder = document.createElement('div');
  holder.innerHTML = renderToolCard(call);
  const fresh = holder.firstElementChild;
  const wasOpen = node.open;
  fresh.open = wasOpen || call.ok === false;
  node.replaceWith(fresh);

  // A finished tool call is followed by another wait while the model reads the
  // result, so the trailing working indicator has to appear now. Patching only
  // the card left that second wait blank.
  const current = currentTurn();
  const trailing = current?.items?.[current.items.length - 1];
  const needsIndicator = state.streaming && !call.running && trailing && trailing.type !== 'text';
  if (needsIndicator && !dom.messages.querySelector('[data-thinking]')) {
    const body = fresh.closest('.block-body');
    if (body) body.insertAdjacentHTML('beforeend', thinkingRow());
  } else if (!needsIndicator) {
    dom.messages.querySelector('[data-thinking]')?.remove();
  }
  scrollToBottom();
}

function patchTodos(todos) {
  const current = currentTurn();
  if (!current) return;
  current.todos = todos;
  renderTranscript();
}

function wireApprovalButtons() {
  dom.messages.querySelectorAll('[data-approve]').forEach((button) => {
    button.addEventListener('click', () => {
      const wrap = button.closest('[data-approval]');
      if (!wrap) return;
      const approved = button.dataset.approve === 'yes';
      wrap.remove();
      answerApproval(approved);
    });
  });
}

/* ------------------------------------------------------------------ *
 * Rendering — sidebar + chrome
 * ------------------------------------------------------------------ */

function renderChatList() {
  if (!state.chats.length) {
    dom.chatList.innerHTML = '<div class="chat-list-empty">No conversations yet. Your chats are saved locally.</div>';
    return;
  }
  dom.chatList.innerHTML = state.chats
    .map(
      (chat) => `
      <div class="chat-item ${chat.id === state.chatId ? 'active' : ''}" data-chat="${escapeHtml(chat.id)}" role="button" tabindex="0">
        <span class="title">${escapeHtml(chat.title || 'Untitled')}</span>
        <button class="del" data-delete="${escapeHtml(chat.id)}" title="Delete chat" aria-label="Delete chat">${icon('i-trash')}</button>
      </div>`
    )
    .join('');

  dom.chatList.querySelectorAll('[data-chat]').forEach((node) => {
    node.addEventListener('click', (event) => {
      if (event.target.closest('[data-delete]')) return;
      openChat(node.dataset.chat);
    });
    node.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openChat(node.dataset.chat);
      }
    });
  });
  dom.chatList.querySelectorAll('[data-delete]').forEach((node) => {
    node.addEventListener('click', async (event) => {
      event.stopPropagation();
      const id = node.dataset.delete;
      if (!confirm('Delete this conversation? This cannot be undone.')) return;
      await api(`/api/chats/${id}`, { method: 'DELETE' });
      state.chats = state.chats.filter((c) => c.id !== id);
      if (state.chatId === id) newChat();
      renderChatList();
      toast('Chat deleted');
    });
  });
}

/**
 * Short, readable model label for the composer chip.
 *
 * The reference layout shows a compact name ("Sonnet 5.5 High") rather than a
 * full identifier. A model id like
 * `@cf/meta/llama-3.1-8b-instruct-fp8-fast` or `anthropic/claude-haiku-5.5`
 * would blow the chip apart, so the vendor prefix and quantisation suffixes are
 * dropped — but only for display. The real id is always shown in Settings and
 * sent unchanged to the provider.
 */
function shortModelName(model) {
  const raw = String(model || '').trim();
  if (!raw) return '';
  let name = raw
    .replace(/^@[^/]+\//, '') // @cf/meta/… -> meta/…
    .replace(/^(meta|google|mistralai|anthropic|openai|qwen|deepseek|microsoft)\//i, '');
  // Quantisation and instruction suffixes stack, so strip repeatedly.
  let previous;
  do {
    previous = name;
    name = name
      .replace(/-(fp8|fp16|int8|awq|gguf|fast|instruct|chat|it)$/i, '')
      .replace(/-v\d+(\.\d+)?$/i, '');
  } while (name !== previous && name.length > 6);
  // Long version numbers are the ugliest part; trim to the ends.
  if (name.length > 26 && name.includes('-')) {
    const parts = name.split('-');
    if (parts.length > 3) name = `${parts.slice(0, 2).join('-')}…${parts[parts.length - 1]}`;
  }
  return name;
}

/**
 * Show or hide the sidebar.
 *
 * Two class names on purpose: `sidebar-hidden` collapses the grid column on a
 * wide screen, while `sidebar-open` drives the slide-in drawer on narrow ones.
 * Keeping them in step means one button is enough for both layouts, and the
 * state survives a viewport change without stranding the sidebar off-screen.
 */
function toggleSidebar() {
  const hidden = !document.body.classList.contains('sidebar-hidden');
  document.body.classList.toggle('sidebar-hidden', hidden);
  document.body.classList.toggle('sidebar-open', !hidden);
  try {
    localStorage.setItem('klaud.sidebar', hidden ? 'hidden' : 'shown');
  } catch { /* private mode */ }
  updateSidebarToggle();
}

/** Label state for whichever of the two buttons is currently on screen. */
function updateSidebarToggle() {
  const hidden = document.body.classList.contains('sidebar-hidden');
  const inner = el('collapse-sidebar');
  if (inner) {
    inner.setAttribute('aria-label', 'Hide sidebar');
    inner.setAttribute('aria-expanded', String(!hidden));
  }
  const reveal = el('toggle-sidebar');
  if (reveal) {
    reveal.setAttribute('aria-label', 'Show sidebar');
    reveal.setAttribute('aria-expanded', String(!hidden));
  }
}

/** Restore the sidebar state the user last chose, across reloads. */
function restoreSidebar() {
  let stored = null;
  try {
    stored = localStorage.getItem('klaud.sidebar');
  } catch { /* private mode */ }
  const hidden = stored === 'hidden';
  document.body.classList.toggle('sidebar-hidden', hidden);
  if (!hidden && window.matchMedia('(max-width: 860px)').matches) {
    // On a phone the sidebar starts closed; the button opens it.
    document.body.classList.remove('sidebar-open');
  }
  updateSidebarToggle();
}

function renderChrome() {
  const config = state.config || {};
  dom.modelName.textContent = shortModelName(config.model) || 'no model';
  dom.modelDot.className = `dot${config.hasApiKey ? '' : ' off'}`;
  const mode = config.approvalMode || 'auto';
  const modeText = mode === 'readonly' ? 'read-only' : mode === 'ask' ? 'ask first' : 'auto-run';
  dom.composerModeLabel.textContent = modeText;
  const ws = config.workspace || '';
  dom.wsPath.textContent = ws;
  dom.composerWs.textContent = shortPath(ws);
  dom.wsPath.title = ws;
  dom.composerWs.title = ws;

  const theme = document.documentElement.dataset.theme;
  dom.themeIcon.innerHTML = `<use href="#${theme === 'dark' ? 'i-sun' : 'i-moon'}"/>`;

  if (state.streaming) {
    dom.sendIcon.innerHTML = '<use href="#i-stop"/>';
    dom.send.classList.add('stop');
    dom.send.disabled = false;
    dom.send.setAttribute('aria-label', 'Stop');
  } else {
    dom.sendIcon.innerHTML = '<use href="#i-send"/>';
    dom.send.classList.remove('stop');
    dom.send.disabled = !dom.prompt.value.trim();
    dom.send.setAttribute('aria-label', 'Send');
  }

  const usage = state.usage;
  dom.hint.innerHTML = state.streaming
    ? `Working… ${state.toolCount} tool call${state.toolCount === 1 ? '' : 's'} so far · press Stop to cancel`
    : usage?.total_tokens
      ? `${usage.total_tokens.toLocaleString()} tokens this turn · Klaud runs real commands in ${escapeHtml(
          shortPath(state.config?.workspace || '')
        )}`
      : `Enter to send · Shift+Enter for a new line · Klaud runs real commands in your working directory`;
}

/* ------------------------------------------------------------------ *
 * Transcript bookkeeping
 * ------------------------------------------------------------------ */

function currentTurn() {
  const last = state.blocks[state.blocks.length - 1];
  return last && last.kind === 'assistant' ? last : null;
}

function ensureTurn() {
  let turn = currentTurn();
  if (!turn) {
    turn = { kind: 'assistant', items: [], notices: [], todos: null, approval: null };
    state.blocks.push(turn);
  }
  return turn;
}

function pushText(chunk) {
  const turn = ensureTurn();
  let item = turn.items[turn.items.length - 1];
  if (!item || item.type !== 'text' || !item.streaming) {
    item = { type: 'text', id: `t${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, text: '', streaming: true };
    turn.items.push(item);
  }
  item.text += chunk;
  patchStreamingText(item);
}

function pushReasoning(chunk) {
  const turn = ensureTurn();
  let item = turn.items[turn.items.length - 1];
  if (!item || item.type !== 'reasoning' || !item.streaming) {
    item = { type: 'reasoning', text: '', streaming: true, open: false };
    turn.items.push(item);
  }
  item.text += chunk;
  const node = dom.messages.querySelector('details.thinking:last-of-type .body');
  if (node) {
    node.textContent = item.text;
    scrollToBottom();
  } else {
    renderTranscript();
  }
}

function closeOpenStreams() {
  const turn = currentTurn();
  if (!turn) return;
  for (const item of turn.items) {
    if (item.streaming) item.streaming = false;
    if (item.type === 'reasoning') item.open = false;
  }
}

function addNotice(message, level = 'info') {
  const turn = ensureTurn();
  turn.items.push({ type: 'notice', message, level });
  renderTranscript();
}

/* ------------------------------------------------------------------ *
 * The agent turn
 * ------------------------------------------------------------------ */

async function submit() {
  const text = dom.prompt.value.trim();
  if (!text || state.streaming) return;

  if (!state.config?.hasApiKey && !state.config?.model) {
    openSettings();
    toast('Add an API key and pick a model first.');
    return;
  }
  if (!state.config?.hasApiKey) {
    openSettings();
    toast('Add your OpenAI-compatible API key in Settings.');
    return;
  }

  dom.prompt.value = '';
  autosize();
  state.usage = null;
  state.toolCount = 0;

  state.blocks.push({ kind: 'user', text });
  state.messages.push({ role: 'user', content: text });
  renderTranscript();
  scrollToBottom(true);
  setStreaming(true);

  // Open the assistant block before the request goes out. Without this the
  // column stays empty until the first event arrives, which on a slow provider
  // is several seconds of nothing — the blank the indicator exists to fill.
  ensureTurn();
  renderTranscript();
  scrollToBottom(true);

  const turnId = crypto.randomUUID().replace(/-/g, '');
  state.turnId = turnId;
  const controller = new AbortController();
  state.controller = controller;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-klaud-token': settings.token },
      body: JSON.stringify({
        chatId: state.chatId,
        turnId,
        messages: state.messages,
        approvalMode: state.config.approvalMode,
        maxSteps: state.config.maxSteps,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload.error || `HTTP ${res.status}`);
    }

    await consumeStream(res.body, turnId);
  } catch (err) {
    if (err.name !== 'AbortError') {
      addNotice(err.message || String(err), 'error');
    } else {
      addNotice('Stopped.', 'info');
    }
  } finally {
    closeOpenStreams();
    setStreaming(false);
    renderTranscript();
    await persistChat();
  }
}

async function consumeStream(body, turnId) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let turnEnded = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (!raw.trim() || raw.startsWith(':')) continue;

      const dataLine = raw
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (!dataLine) continue;

      let event;
      try {
        event = JSON.parse(dataLine);
      } catch {
        continue;
      }
      turnEnded = handleEvent(event, turnId) || turnEnded;
    }
  }
  if (!turnEnded) closeOpenStreams();
}

/**
 * Retitle the working indicator in place.
 *
 * Deliberately not a re-render: replacing the node restarts the pulse animation,
 * so a turn that changes phase several times would flicker. This only touches the
 * label text, and the dots keep their rhythm.
 */
function setThinkingPhase(label) {
  const node = dom.messages.querySelector('[data-thinking-label]');
  if (!node) return;
  if (node.textContent !== label) node.textContent = label;
}

function handleEvent(event, turnId) {
  switch (event.type) {
    case 'turn_start':
      state.steps = { index: 0, max: state.config?.maxSteps || 0 };
      state.turnId = event.turnId || turnId;
      return false;

    case 'step':
      state.steps = { index: event.index, max: event.max };
      setThinkingPhase(state.steps.max > 1 ? `Thinking · step ${event.index}/${event.max}` : 'Thinking');
      renderChrome();
      return false;

    case 'text':
      pushText(event.value);
      return false;

    case 'reasoning':
      setThinkingPhase('Reasoning');
      pushReasoning(event.value);
      return false;

    case 'tool_call': {
      const turn = ensureTurn();
      turn.items.push({
        type: 'tool',
        id: event.id,
        name: event.name,
        args: event.args,
        result: '',
        running: true,
        ok: undefined,
      });
      state.toolCount++;
      renderTranscript();
      return false;
    }

    case 'tool_start':
    case 'tool_result': {
      const turn = ensureTurn();
      const call = turn.items.find((i) => i.type === 'tool' && i.id === event.id);
      if (call) {
        if (event.type === 'tool_result') {
          call.running = false;
          call.ok = event.ok;
          call.result = event.output;
          call.durationMs = event.durationMs;
          call.denied = Boolean(event.denied);
          setThinkingPhase('Thinking');
        } else {
          setThinkingPhase(`Running ${event.name}`);
        }
        patchToolCard(call);
      }
      renderChrome();
      return false;
    }

    case 'todos':
      patchTodos(event.todos);
      return false;

    case 'approval_request': {
      const turn = ensureTurn();
      turn.approval = { id: event.id, name: event.name, args: event.args, state: 'pending' };
      state.pendingApproval = turn;
      renderTranscript();
      scrollToBottom(true);
      return false;
    }

    case 'notice':
      addNotice(event.message, event.level || 'info');
      return false;

    case 'usage':
      state.usage = event.usage;
      renderChrome();
      return false;

    case 'error':
      addNotice(event.message, 'error');
      return false;

    case 'aborted':
      addNotice('Stopped.', 'info');
      return false;

    case 'saved':
      state.chatId = event.chatId;
      state.title = event.title || state.title;
      refreshChats();
      return false;

    case 'turn_end': {
      if (Array.isArray(event.messages)) {
        // The server's copy is authoritative and already sequence-repaired.
        const history = state.messages.filter((m) => m.role === 'user');
        state.messages = [...history, ...event.messages];
      }
      if (event.usage) state.usage = event.usage;
      closeOpenStreams();
      renderTranscript();
      renderChrome();
      return true;
    }

    case 'done':
      closeOpenStreams();
      return true;

    default:
      return false;
  }
}

function setStreaming(value) {
  state.streaming = value;
  if (!value) {
    state.controller = null;
    state.pendingApproval = null;
  }
  renderChrome();
}

function stopStreaming() {
  if (!state.streaming) return;
  if (state.pendingApproval) answerApproval(false);
  state.controller?.abort();
  fetch(`/api/chat/${state.turnId}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-klaud-token': settings.token },
  }).catch(() => {});
  setStreaming(false);
}

async function answerApproval(approved) {
  const turn = state.pendingApproval;
  if (!turn) return;
  state.pendingApproval = null;
  turn.approval = { ...(turn.approval || {}), state: approved ? 'approved' : 'denied' };
  const id = turn.approval.id;
  try {
    await fetch(`/api/chat/${state.turnId}/approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-klaud-token': settings.token },
      body: JSON.stringify({ id, approved }),
    });
  } catch {
    toast('Could not deliver your decision to the server.');
  }
  renderTranscript();
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

function deriveTitle() {
  const first = state.messages.find((m) => m.role === 'user' && typeof m.content === 'string');
  if (!first) return 'New chat';
  const line = first.content.trim().split('\n')[0].replace(/^#+\s*/, '');
  return line.length > 58 ? `${line.slice(0, 55)}…` : line || 'New chat';
}

async function persistChat() {
  if (!state.messages.length) return;
  try {
    if (!state.chatId) {
      const created = await api('/api/chats', {
        method: 'POST',
        body: { title: deriveTitle() },
      });
      state.chatId = created.chat.id;
      state.title = created.chat.title;
      history.replaceState(null, '', `#chat=${state.chatId}`);
    }
    await api(`/api/chats/${state.chatId}`, {
      method: 'PUT',
      body: { messages: state.messages, title: state.title || deriveTitle(), model: state.config?.model },
    });
    await refreshChats();
  } catch (err) {
    toast(`Could not save the chat: ${err.message}`);
  }
}

async function refreshChats() {
  try {
    const data = await api('/api/chats');
    state.chats = data.chats || [];
    renderChatList();
  } catch { /* non-fatal */ }
}

/** Rebuild the UI transcript from API-format history. */
function blocksFromMessages(messages) {
  const blocks = [];
  const byId = new Map();
  for (const message of messages) {
    if (message.role === 'user') {
      blocks.push({ kind: 'user', text: typeof message.content === 'string' ? message.content : '' });
    } else if (message.role === 'assistant') {
      const turn = { kind: 'assistant', items: [], notices: [], todos: null, approval: null };
      if (message.reasoning) turn.items.push({ type: 'reasoning', text: message.reasoning, open: false });
      if (typeof message.content === 'string' && message.content.trim()) {
        turn.items.push({ type: 'text', id: `h${blocks.length}_${turn.items.length}`, text: message.content });
      }
      for (const call of message.tool_calls || []) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = { __parse_error: true, raw: call.function?.arguments || '' };
        }
        const item = {
          type: 'tool',
          id: call.id,
          name: call.function?.name || 'tool',
          args,
          result: '',
          running: false,
          ok: true,
        };
        turn.items.push(item);
        byId.set(call.id, item);
      }
      blocks.push(turn);
    } else if (message.role === 'tool') {
      const item = byId.get(message.tool_call_id);
      if (item) {
        item.result = message.content || '';
        item.ok = !/^(Error:|Permission denied)/.test(String(message.content || ''));
      }
    }
  }
  return blocks;
}

async function openChat(id) {
  if (state.streaming) {
    toast('Stop the current turn before switching chats.');
    return;
  }
  try {
    const data = await api(`/api/chats/${id}`);
    state.chatId = id;
    state.title = data.chat.title;
    state.messages = data.chat.messages || [];
    state.blocks = blocksFromMessages(state.messages);
    state.usage = null;
    state.toolCount = 0;
    history.replaceState(null, '', `#chat=${id}`);
    renderChatList();
    renderTranscript();
    scrollToBottom(true);
    document.body.classList.remove('sidebar-open');
  } catch (err) {
    toast(`Could not open the chat: ${err.message}`);
  }
}

function newChat() {
  if (state.streaming) {
    toast('Stop the current turn first.');
    return;
  }
  state.chatId = null;
  state.title = '';
  state.messages = [];
  state.blocks = [];
  // A new chat is a new moment, so it earns a fresh greeting. The same chat
  // keeps the one it started with.
  state.greeting = null;
  state.usage = null;
  state.toolCount = 0;
  history.replaceState(null, '', location.pathname);
  renderChatList();
  renderTranscript();
  dom.prompt.focus();
  document.body.classList.remove('sidebar-open');
}

/* ------------------------------------------------------------------ *
 * Recovery from a stale or missing session token
 * ------------------------------------------------------------------ */

function clearStoredToken() {
  try {
    localStorage.removeItem('klaud.token');
  } catch { /* private mode */ }
  settings.token = '';
}

/**
 * Shown whenever the server rejects our token. Without this the app is a dead
 * end: every request 401s, including the settings call, so the user has no way
 * back in short of finding the terminal.
 */
function showUnauthorizedScreen(detail = '') {
  clearStoredToken();
  state.unauthorized = true;

  const serverToken = (() => {
    try {
      return (
        new URLSearchParams(location.hash.replace(/^#/, '')).get('token') ||
        new URLSearchParams(location.search).get('token') ||
        ''
      );
    } catch {
      return '';
    }
  })();
  if (serverToken && /^[A-Za-z0-9_-]{20,}$/.test(serverToken)) settings.token = serverToken;

  dom.messages.innerHTML = `
    <div class="welcome">
      <svg class="mark" aria-hidden="true"><use href="#i-mark"/></svg>
      <h1>Click one button and you're <em>back in</em></h1>
      <p class="lede">
        This tab is holding a session token from an earlier run of the server, so Klaud
        answered <code>401 Unauthorized</code>. Nothing is lost — your chats and settings
        are safe. You just need a fresh tab.
      </p>
      ${detail ? `<div class="notice warn">${icon('i-warn')}<div>${escapeHtml(detail)}</div></div>` : ''}
      <div class="recovery-cta">
        <button class="btn btn-primary" id="recover-open">
          ${icon('i-external')} Re-authorize this browser
        </button>
        <span class="hint">Opens a new tab with a valid session. Close this one afterwards.</span>
      </div>
      <div id="recover-cta-status"></div>
      <details class="recovery-more">
        <summary>${icon('i-chevron')} That didn't work — use the terminal instead</summary>
        <div class="recovery">
          <div class="recovery-step">
            <span class="num">1</span>
            <div>
              <strong>Open the URL from the terminal</strong>
              <p>The server prints a line like <code>Open: http://127.0.0.1:${escapeHtml(
                location.port || '4317'
              )}/?token=…</code> when it starts, and again every time it rejects a request.</p>
            </div>
          </div>
          <div class="recovery-step">
            <span class="num">2</span>
            <div>
              <strong>Or paste the token</strong>
              <p>Find the <code>token</code> value in <code>~/.klaud/session.json</code>, paste it below, and Klaud will remember it here.</p>
              <div class="row" style="margin-top:9px">
                <input type="password" id="recover-token" placeholder="paste session token" spellcheck="false"
                       autocomplete="off" />
                <button class="btn btn-primary" id="recover-go">Authorize</button>
              </div>
              <div id="recover-status"></div>
            </div>
          </div>
        </div>
      </details>
    </div>`;

  const ctaStatus = el('recover-cta-status');
  el('recover-open').addEventListener('click', async () => {
    const button = el('recover-open');
    button.disabled = true;
    ctaStatus.innerHTML = `<div class="status-line">${icon('i-spinner')}<span>Asking the server for a fresh session…</span></div>`;
    try {
      const res = await fetch('/api/authorize', { method: 'POST' });
      if (!res.ok && res.status !== 403) throw new Error(`HTTP ${res.status}`);
      const data = await res.json().catch(() => null);
      if (!data || data.ok !== true) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }
      ctaStatus.innerHTML = `<div class="status-line ok">${icon('i-check')}<span>${escapeHtml(
        data.message
      )}</span></div>`;
    } catch (err) {
      // Never leave the user staring at a button that did nothing.
      ctaStatus.innerHTML = `<div class="status-line bad">${icon('i-warn')}<span>Could not reach the server (${escapeHtml(
        err.message
      )}). Use the steps below instead.</span></div>`;
      dom.messages.querySelector('.recovery-more')?.setAttribute('open', '');
    } finally {
      const toggle = el('recover-open');
      if (toggle) toggle.disabled = false;
    }
  });

  const input = el('recover-token');
  const status = el('recover-status');
  const submitToken = async () => {
    const value = input.value.trim();
    if (!value) return;
    status.innerHTML = `<div class="status-line">Checking…</div>`;
    try {
      const res = await fetch('/api/info', { headers: { 'x-klaud-token': value } });
      if (!res.ok) throw new Error('The server rejected that token.');
      try {
        localStorage.setItem('klaud.token', value);
      } catch { /* private mode */ }
      settings.token = value;
      status.innerHTML = `<div class="status-line ok">${icon('i-check')}<span>Authorized. Loading…</span></div>`;
      setTimeout(() => location.reload(), 350);
    } catch (err) {
      status.innerHTML = `<div class="status-line bad">${icon('i-warn')}<span>${escapeHtml(err.message)}</span></div>`;
    }
  };
  el('recover-go').addEventListener('click', submitToken);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitToken();
  });

  // Focus the fallback field only when it is revealed, so the screen does not
  // scroll past the primary button.
  dom.messages.querySelector('.recovery-more')?.addEventListener('toggle', (event) => {
    if (event.target.open) input.focus();
  });
}

/* ------------------------------------------------------------------ *
 * Free providers
 * ------------------------------------------------------------------ */

let freeCatalogCache = null;

async function loadFreeCatalog(force = false) {
  if (!force && freeCatalogCache) return freeCatalogCache;
  const data = await api(`/api/providers/free${force ? '?refresh=1' : ''}`);
  freeCatalogCache = data;
  return data;
}

function providerStatusChip(provider) {
  if (provider.localRunning === true) return '<span class="pchip ok">running now</span>';
  if (provider.localRunning === false) return '<span class="pchip">not running</span>';
  if (provider.freeModelCount) return `<span class="pchip accent">${provider.freeModelCount} free models</span>`;
  if (provider.toolCalling) return '<span class="pchip">tool calling</span>';
  return '';
}

/** A rough, honest read on how far the free allowance goes. */
function tierChip(provider) {
  if (provider.tier === 'generous') return '<span class="pchip best">generous</span>';
  if (provider.tier === 'tight') return '<span class="pchip warn">tight</span>';
  return '';
}

function isLocalProvider(provider) {
  return /localhost|127\.0\.0\.1/.test(provider.baseUrl);
}

/**
 * Providers that need more than a key and a URL get a guided setup. Cloudflare
 * requires an account ID inside the URL; the token already knows it, so the user
 * should never have to find and paste a 32-character hex string.
 */
const AUTO_SETUP = {
  cloudflare: {
    label: 'Cloudflare Workers AI',
    tokenUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    steps: [
      'Open the Cloudflare API tokens page and create a token with the <strong>Workers AI</strong> permission.',
      'Paste the <strong>token</strong> below.',
      'Optional: paste your <strong>account ID</strong> too. Klaud reads it from the token, but supplying it skips discovery entirely — useful if the token is account-scoped. It is in your dashboard URL.',
    ],
    note:
      'Klaud runs a real test request against Workers AI before saving anything, so you will know immediately whether the credentials work. The 10,000 free Neurons/day apply automatically.',
  },
};

/**
 * Per-model numbers where the provider publishes them, so picking a model is an
 * informed choice rather than a guess.
 */
function modelOptionLabel(provider, model) {
  const known = (provider.modelLimits || []).find((m) => m.id === model.id);
  const bits = [];
  if (known) {
    if (known.requestsPerDay) bits.push(`${known.requestsPerDay.toLocaleString()} req/day`);
    if (known.tokensPerMinute) bits.push(`${(known.tokensPerMinute / 1000).toFixed(0)}k tok/min`);
  }
  if (model.tools === false) bits.push('no tool calling');
  if (model.contextLength) bits.push(`${Math.round(model.contextLength / 1000)}k ctx`);
  return `${model.id}${bits.length ? ' — ' + bits.join(', ') : ''}`;
}

/** One provider card. */
function renderProviderCard(provider) {
  const models = provider.freeModelList || provider.localModels || [];
  const hasPicker = models.length > 1;
  const pickerId = `pick-${provider.id}`;
  const actionLabel = isLocalProvider(provider) ? 'Setup' : 'Get a key';

  const modelField = hasPicker
    ? `<select id="${pickerId}" data-model-select="${escapeHtml(provider.id)}">
         ${models
           .map(
             (m) => `<option value="${escapeHtml(m.id)}">${escapeHtml(modelOptionLabel(provider, m))}</option>`
           )
           .join('')}
       </select>`
    : `<input type="text" id="${pickerId}" value="${escapeHtml(provider.model)}"
              data-model-input="${escapeHtml(provider.id)}" spellcheck="false" />`;

  const perModel = (provider.modelLimits || []).length
    ? `<div class="plimits">${icon('i-info')}<span>${escapeHtml(
        provider.modelLimitsNote || 'Per-model figures as published by the provider.'
      )} ${provider.modelLimits
        .map((m) => `${escapeHtml(m.id)} ~${m.requestsPerDay.toLocaleString()}/day`)
        .join(' · ')}</span></div>`
    : '';

  // Say plainly where the number comes from. A stale figure presented as fact is
  // worse than no figure, so the label is derived from limitBasis, not guessed.
  const quality =
    provider.limitBasis === 'published'
      ? '<span class="pchip ok">documented</span>'
      : provider.limitBasis === 'no-quota'
        ? '<span class="pchip ok">no quota</span>'
        : provider.limitBasis === 'not-published'
          ? '<span class="pchip approx">limits not published</span>'
          : '';
  // A provider whose model id was confirmed against a live endpoint gets its own
  // chip: that is a stronger claim than a limit figure, and worth distinguishing.
  const verifiedChip = provider.verifiedNote
    ? `<span class="pchip ok" title="${escapeHtml(provider.verifiedNote)}">model verified live</span>`
    : '';
  const sourceLink = provider.limitsSource
    ? `<a class="plink" href="${escapeHtml(provider.limitsSource)}" target="_blank" rel="noopener noreferrer">${icon(
        'i-external'
      )} provider's own limits page</a>`
    : '';
  const checkLink = provider.limitsPageUrl
    ? `<a class="plink" href="${escapeHtml(provider.limitsPageUrl)}" target="_blank" rel="noopener noreferrer">${icon(
        'i-external'
      )} check your exact allowance</a>`
    : '';

  return `
    <div class="pcard ${provider.tier === 'tight' ? 'tight' : ''} ${provider.best ? 'best' : ''}">
      ${
        provider.recommended
          ? `<div class="precommended">${icon('i-star')} Recommended for coding agents</div>`
          : ''
      }
      <div class="pcard-head">
        <div>
          <div class="pname">
            ${escapeHtml(provider.name)}
            ${tierChip(provider)}
          </div>
          <div class="ptag">${escapeHtml(provider.tagline)}</div>
        </div>
        <div class="pchips">${providerStatusChip(provider)}${quality}${verifiedChip}</div>
      </div>
      ${provider.headline ? `<div class="pheadline">${escapeHtml(provider.headline)}</div>` : ''}
      <p class="pdetail">${escapeHtml(provider.detail)}</p>
      <div class="plimits">${icon('i-info')}<span>${escapeHtml(provider.limits)}</span></div>
      ${
        provider.caveat
          ? `<div class="pcaveat">${icon('i-warn')}<span>${escapeHtml(provider.caveat)}</span></div>`
          : ''
      }
      ${
        sourceLink || checkLink
          ? `<div class="plinks">${sourceLink}${checkLink}</div>`
          : ''
      }
      ${perModel}
      <div class="pfield">
        <label for="${pickerId}">Model</label>
        ${modelField}
      </div>
      <div class="pcard-foot">
        <button class="btn btn-primary btn-sm" data-use-provider="${escapeHtml(provider.id)}">
          ${icon('i-zap')} ${AUTO_SETUP[provider.id] ? 'Set up automatically' : 'Use this'}
        </button>
        <a class="btn btn-ghost btn-sm" href="${escapeHtml(provider.signupUrl)}" target="_blank" rel="noopener noreferrer">
          ${icon('i-external')} ${actionLabel}
        </a>
        <div class="grow"></div>
        <button class="btn btn-ghost btn-sm" data-copy-url="${escapeHtml(provider.baseUrl)}" title="Copy the base URL">
          ${icon('i-plug')} Copy URL
        </button>
      </div>
    </div>`;
}

/** Inline, step-by-step setup for a provider that needs more than a key. */
function showAutoSetup(provider, root, done) {
  const spec = AUTO_SETUP[provider.id];
  const existing = root.querySelector(`[data-setup="${CSS.escape(provider.id)}"]`);
  if (existing) {
    existing.querySelector('input')?.focus();
    return;
  }

  const panel = document.createElement('div');
  panel.className = 'setup-panel';
  panel.dataset.setup = provider.id;
  panel.innerHTML = `
    <div class="setup-head">
      ${icon('i-zap')}
      <div>
        <strong>${escapeHtml(spec.label)}</strong>
        <span>Two values, no dashboard digging: the API token, and your account ID if you have it.</span>
      </div>
    </div>
    <ol class="setup-steps">${spec.steps.map((s) => `<li>${s}</li>`).join('')}</ol>
    <a class="plink" href="${escapeHtml(spec.tokenUrl)}" target="_blank" rel="noopener noreferrer">
      ${icon('i-external')} Open the Cloudflare API tokens page
    </a>
    <div class="setup-row">
      <input type="password" data-setup-token placeholder="paste the API token" spellcheck="false" autocomplete="off" />
    </div>
    <div data-setup-account>
      <div class="setup-optional">
        <strong>Account ID</strong> — optional. Klaud reads it from your token. Paste it if you already
        have it handy, or if setup tells you it could not be found. It is in your Cloudflare dashboard
        URL: <code>dash.cloudflare.com/&lt;account-id&gt;</code>
      </div>
      <input type="text" data-setup-account-input placeholder="a1b2c3d4e5f60718293a4b5c6d7e8f90" spellcheck="false" autocomplete="off" />
    </div>
    <div data-setup-status></div>
    <div class="setup-row setup-row-actions">
      <button class="btn btn-primary" data-setup-run>${icon('i-zap')} Set up</button>
      <button class="btn btn-ghost" data-setup-cancel>Cancel</button>
    </div>
    <div class="setup-note">${escapeHtml(spec.note)}</div>`;

  root.querySelector(`[data-use-provider="${CSS.escape(provider.id)}"]`)?.closest('.pcard')?.after(panel);

  const input = panel.querySelector('input');
  const status = panel.querySelector('[data-setup-status]');
  input.focus();

  const setStatus = (message, kind = '') => {
    status.innerHTML = message
      ? `<div class="status-line ${kind}">${icon(
          kind === 'bad' ? 'i-warn' : kind === 'ok' ? 'i-check' : 'i-spinner'
        )}<span>${escapeHtml(message)}</span></div>`
      : '';
  };

  const run = async () => {
    const token = input.value.trim();
    if (!token) {
      input.focus();
      return;
    }
    const button = panel.querySelector('[data-setup-run]');
    const accountBox = panel.querySelector('[data-setup-account]');
    const accountInput = panel.querySelector('[data-setup-account-input]');
    button.disabled = true;
    setStatus('Reading the account from your token, then sending a real test request…');

    try {
      const select = root.querySelector(`[data-model-select="${CSS.escape(provider.id)}"]`);
      const result = await api('/api/providers/setup', {
        method: 'POST',
        body: {
          provider: provider.id,
          apiKey: token,
          model: select?.value,
          accountId: accountInput.value.trim() || undefined,
        },
      });

      // Always show what Cloudflare actually reported, step by step. Guessing
      // what went wrong and telling the user to fix something unrelated is the
      // failure mode this replaces.
      const diag = panel.querySelector('.setup-diagnostics');
      diag?.remove();
      if (Array.isArray(result.checks) && result.checks.length) {
        const box = document.createElement('ul');
        box.className = 'setup-diagnostics';
        box.innerHTML = result.checks
          .map(
            (c) =>
              `<li class="${c.ok ? 'ok' : 'bad'}">${icon(c.ok ? 'i-check' : 'i-x')}<span><strong>${escapeHtml(
                c.step
              )}</strong> — ${escapeHtml(String(c.detail || ''))}</span></li>`
          )
          .join('');
        panel.querySelector('.setup-note').before(box);
      }

      if (result.ok) {
        if (result.settings) state.config = result.settings;
        setStatus(result.message, 'ok');
        panel.querySelector('.setup-row')?.remove();
        accountBox?.remove();
        panel.querySelector('.setup-note')?.remove();
        renderChrome();
        setTimeout(() => {
          panel.remove();
          done?.();
        }, 2600);
        return;
      }

      setStatus(result.message || 'Setup failed.', 'bad');

      // Always offer the manual account ID once anything fails. Discovery cannot
      // work for Cloudflare account-scoped tokens, so hiding this behind one
      // specific failure mode would leave those users stuck.
      accountBox.hidden = false;
      if (result.needsAccountId) accountInput.focus();

      const detail = result.test?.raw || result.raw || '';
      const meta = [
        result.httpStatus || result.test?.status ? `HTTP ${result.httpStatus || result.test.status}` : '',
        result.stage ? `stage: ${result.stage}` : '',
        Array.isArray(result.claimNames) && result.claimNames.length
          ? `token claims: ${result.claimNames.join(', ')}`
          : '',
      ].filter(Boolean);
      if (detail) {
        const box = document.createElement('details');
        box.className = 'setup-error-detail';
        box.open = true;
        box.innerHTML = `
          <summary>${escapeHtml(meta.length ? meta.join(' · ') : 'What Cloudflare returned')}</summary>
          <pre>${escapeHtml(String(detail))}</pre>`;
        panel.querySelector('[data-setup-status]').after(box);
      } else if (meta.length) {
        const line = document.createElement('div');
        line.className = 'setup-meta';
        line.textContent = meta.join(' · ');
        panel.querySelector('[data-setup-status]').after(line);
      }
      button.disabled = false;
    } catch (err) {
      setStatus(err.message, 'bad');
      button.disabled = false;
    }
  };

  panel.querySelector('[data-setup-run]').addEventListener('click', run);
  panel.querySelector('[data-setup-cancel]').addEventListener('click', () => panel.remove());
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      run();
    }
  });
}

/** Applies a free provider to the live settings and reports what is still needed. */
async function useProvider(provider, model) {
  if (/\{[a-z_]+\}/i.test(provider.baseUrl)) {
    toast(
      `${provider.name} needs your own account ID substituted into the URL. Copy it, edit it, and paste it into Settings instead.`
    );
    return false;
  }
  try {
    state.config = await api('/api/settings', {
      method: 'PATCH',
      body: { baseUrl: provider.baseUrl, model: model || provider.model },
    });
    renderChrome();
    if (isLocalProvider(provider)) toast(`${provider.name} selected — local models need no key.`);
    else toast(`${provider.name} selected. Paste its API key to finish.`);
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

function wireProviderCards(root, onUse) {
  root.querySelectorAll('[data-use-provider]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.useProvider;
      const provider = (freeCatalogCache?.providers || []).find((p) => p.id === id);
      if (!provider) return;

      // Providers with a guided setup never touch settings directly.
      if (AUTO_SETUP[id]) {
        showAutoSetup(provider, root, onUse);
        return;
      }

      const select = root.querySelector(`[data-model-select="${CSS.escape(id)}"]`);
      const input = root.querySelector(`[data-model-input="${CSS.escape(id)}"]`);
      const model = select ? select.value : input ? input.value.trim() : provider.model;
      button.disabled = true;
      const ok = await useProvider(provider, model);
      button.disabled = false;
      if (ok) onUse?.(provider);
    });
  });

  root.querySelectorAll('[data-copy-url]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copyUrl);
        toast('Base URL copied');
      } catch {
        toast(button.dataset.copyUrl);
      }
    });
  });
}

/** The full picker: which free endpoints are reachable right now. */
async function openFreeProviders() {
  if (state.unauthorized || !settings.token) {
    showUnauthorizedScreen();
    return;
  }
  mountModal(`
    <div class="modal-head">
      ${icon('i-gift')}
      <h2>Free to use</h2>
      <button class="icon-btn" data-close aria-label="Close">${icon('i-close')}</button>
    </div>
    <div class="modal-body" id="fp-body">
      <div class="status-line">${icon('i-spinner')}<span>Checking which free endpoints are reachable…</span></div>
    </div>
    <div class="modal-foot">
      <span class="hint">No card required. Local models need no key at all.</span>
      <div class="grow"></div>
      <button class="btn btn-ghost" id="fp-refresh">${icon('i-zap')} Refresh</button>
      <button class="btn btn-ghost" data-close>Close</button>
    </div>
  `);

  const body = el('fp-body');

  const paint = (catalog) => {
    const live = catalog.liveChecks || {};
    const localUp = (catalog.providers || []).filter((p) => p.localRunning === true);
    const recommended = (catalog.providers || []).find((p) => p.recommended);

    body.innerHTML = `
      <p class="fp-lede">
        Free endpoints that speak the OpenAI API. Pick one, paste its key if it needs one, and
        Klaud runs the same agent loop: reading files, running commands, verifying its own work.
      </p>
      ${
        recommended
          ? `<div class="fp-pick">
              ${icon('i-star')}
              <div>
                <strong>Start with ${escapeHtml(recommended.name)}</strong>
                ${escapeHtml(recommended.headline)}
                <div class="fp-pick-sub">
                  It needs one free key and no card, and its rate limit resets every minute
                  rather than running out for the day the way a credit allowance does.
                </div>
              </div>
            </div>`
          : ''
      }

      <div class="fp-verified">
        ${icon('i-check')}
        <div>
          <strong>Checked on this run</strong>
          ${live.endpointsProbed || 0} endpoints probed ·
          ${live.openRouterFreeModels || 0} OpenRouter models priced at zero right now ·
          ${localUp.length ? `${localUp.length} local server(s) running` : 'no local servers detected'}
          <div class="fp-caveat">
            Rate-limit figures are not verified. Google and Groq have both stopped
            publishing fixed free-tier numbers and now tell you to check your own account,
            so those cards are labelled <em>not published</em> and every card links to the
            provider's own page.
          </div>
        </div>
      </div>
      ${catalog.providers.map(renderProviderCard).join('')}
      ${
        (catalog.removed || []).length
          ? `<details class="fp-removed">
              <summary>${icon('i-info')} ${(catalog.removed || []).length} providers removed for no longer being free</summary>
              <div class="fp-removed-body">
                ${(catalog.removed || [])
                  .map(
                    (r) => `<div class="fp-removed-item">
                      <strong>${escapeHtml(r.name)}</strong>
                      <span class="fp-removed-date">removed ${escapeHtml(r.removedOn)}</span>
                      <p>${escapeHtml(r.reason)}</p>
                      <a class="plink" href="${escapeHtml(r.source)}" target="_blank" rel="noopener noreferrer">
                        ${icon('i-external')} source
                      </a>
                    </div>`
                  )
                  .join('')}
              </div>
            </details>`
          : ''
      }
      <div class="fp-note">${icon('i-info')}<span>${escapeHtml(catalog.note)}${
        catalog.liveChecks?.openRouterError
          ? ` The live model lookup failed (${escapeHtml(catalog.liveChecks.openRouterError)}), so cached results are shown.`
          : ''
      }</span></div>`;
    wireProviderCards(body, () => {
      closeModal();
      renderChrome();
      renderWelcomeIfEmpty();
    });
  };

  const load = async (force) => {
    try {
      paint(await loadFreeCatalog(force));
    } catch (err) {
      body.innerHTML = `<div class="status-line bad">${icon('i-warn')}<span>${escapeHtml(err.message)}</span></div>`;
    }
  };

  el('fp-refresh').addEventListener('click', async () => {
    const button = el('fp-refresh');
    button.disabled = true;
    freeCatalogCache = null;
    await load(true);
    button.disabled = false;
  });

  await load(false);
}

/* ------------------------------------------------------------------ *
 * Modals
 * ------------------------------------------------------------------ */

function closeModal() {
  dom.modalRoot.innerHTML = '';
  document.removeEventListener('keydown', onModalKey);
}

function onModalKey(event) {
  if (event.key === 'Escape') closeModal();
}

function mountModal(html) {
  dom.modalRoot.innerHTML = `<div class="overlay" data-overlay><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
  dom.modalRoot.querySelector('[data-overlay]').addEventListener('mousedown', (event) => {
    if (event.target.dataset.overlay !== undefined) closeModal();
  });
  dom.modalRoot.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', closeModal));
  document.addEventListener('keydown', onModalKey);
}

/**
 * Quick-fill presets for Settings.
 *
 * Free providers come first and are labelled as such, so the list leads with
 * something that costs nothing. Together AI was dropped: its free tier ended,
 * and leaving it here suggested a free option that no longer exists. Ollama is
 * listed first among the locals because it is the one most people already have
 * running.
 */
const PRESETS = [
  { label: 'NVIDIA NIM · free', url: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3.5-super-vl-120b-a12b' },
  { label: 'Groq · free', url: 'https://api.groq.com/openai/v1', model: 'openai/gpt-oss-120b' },
  { label: 'Google AI Studio · free', url: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'openrouter/free' },
  { label: 'Ollama · local', url: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b' },
  { label: 'LM Studio · local', url: 'http://localhost:1234/v1', model: 'local-model' },
  { label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'DeepSeek', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { label: 'xAI', url: 'https://api.x.ai/v1', model: 'grok-2-latest' },
  { label: 'Mistral', url: 'https://api.mistral.ai/v1', model: 'mistral-large-latest' },
];

const REASONING_STEPS = [
  { value: '', label: 'Provider default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/**
 * Whether the saved base URL is one the client will send an effort to.
 *
 * Host equality only: an OpenAI-compatible URL that merely contains "openai"
 * would be claimed wrongly here, and a wrong "this will be sent" is the one
 * thing this hint must not say.
 */
function reasoningEffortSent(baseUrl) {
  let host = '';
  try {
    host = new URL(String(baseUrl || '')).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'api.openai.com' || host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
}

/**
 * What the slider will actually do for the URL in the box, said out loud.
 *
 * Sending an unsupported parameter makes some providers reject the entire
 * request, so Klaud drops it — and if it dropped it silently the setting would
 * look broken. Better to name the reason.
 */
function reasoningEffortHint(baseUrl) {
  return reasoningEffortSent(baseUrl)
    ? 'How much the model should think before answering. Higher effort is slower and costs more tokens. This endpoint accepts the setting.'
    : 'How much the model should think before answering. This endpoint is not known to accept an effort setting, so Klaud sends nothing — an unsupported parameter makes some providers reject the whole request.';
}

function openSettings() {
  // Every settings call needs a valid token; without one, the modal would mount
  // empty and the user would be stuck staring at nothing.
  if (state.unauthorized || !settings.token) {
    showUnauthorizedScreen();
    return;
  }
  const config = state.config || {};
  mountModal(`
    <div class="modal-head">
      ${icon('i-settings')}
      <h2>Settings</h2>
      <button class="icon-btn" data-close aria-label="Close">${icon('i-close')}</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>${icon('i-plug')} API base URL</label>
        <input type="text" id="s-base" value="${escapeHtml(config.baseUrl || '')}" placeholder="https://api.openai.com/v1" spellcheck="false" />
        <div class="free-strip">
          ${icon('i-gift')}
          <span>Several good endpoints are free, with no card.</span>
          <button type="button" class="btn btn-primary btn-sm" id="s-free">${icon('i-gift')} Browse free providers</button>
        </div>
        <div class="presets">
          ${PRESETS.map((p) => `<button type="button" class="preset" data-url="${escapeHtml(p.url)}" data-model="${escapeHtml(p.model)}">${escapeHtml(p.label)}</button>`).join('')}
        </div>
        <div class="hint">Anything that speaks the OpenAI chat-completions API works: a provider, a gateway, or a local server.</div>
      </div>

      <div class="field">
        <label>${icon('i-key')} API key</label>
        <input type="password" id="s-key" placeholder="${config.hasApiKey ? escapeHtml(config.apiKeyHint || 'saved') : 'sk-…'}" spellcheck="false" autocomplete="off" />
        <div class="hint">Stored on this machine only, in <code>${escapeHtml(settings.info?.dataDir || '~/.klaud')}/settings.json</code>. It is never sent to the browser.</div>
      </div>

      <div class="field">
        <label>${icon('i-sparkle')} Model</label>
        <div class="row">
          <input type="text" id="s-model" value="${escapeHtml(config.model || '')}" placeholder="gpt-4o-mini" spellcheck="false" />
          <button class="btn btn-ghost" id="s-load-models">${icon('i-search')} Load models</button>
        </div>
        <div id="s-model-list"></div>
      </div>

      <div class="field">
        <label>${icon('i-shield')} Tool permissions</label>
        <div class="seg" id="s-mode">
          <button type="button" data-mode="auto"><span>Auto-run</span><small>no prompts</small></button>
          <button type="button" data-mode="ask"><span>Ask first</span><small>confirm writes and commands</small></button>
          <button type="button" data-mode="readonly"><span>Read-only</span><small>no writes at all</small></button>
        </div>
        <div class="hint">Ask first is the safest option when you point Klaud at a directory you care about.</div>
      </div>

      <div class="field">
        <label>${icon('i-folder')} Working directory</label>
        <div class="row">
          <input type="text" id="s-workspace" value="${escapeHtml(config.workspace || '')}" spellcheck="false" />
          <button class="btn btn-ghost" id="s-browse">${icon('i-folder')} Browse</button>
        </div>
        <div class="hint">All file and command tools are confined to this directory. Change it any time.</div>
      </div>

      <div class="field">
        <label>${icon('i-terminal')} Steps per turn</label>
        <input type="number" id="s-steps" min="1" max="40" value="${Number(config.maxSteps) || 12}" />
        <div class="hint">Largest number of tool round trips a single message may take before Klaud pauses and asks you to continue. Raise it for long autonomous jobs.</div>
      </div>

      <div class="field">
        <label>${icon('i-brain')} History budget (characters)</label>
        <input type="number" id="s-context" min="8000" max="2000000" step="8000" value="${Number(config.maxContextChars) || 80000}" />
        <div class="hint">How much of the conversation travels with each request. Roughly 4 characters per token, so 80,000 is about 20k tokens. When a session outgrows it, Klaud drops the oldest turns — newest work is always kept. Set a larger number for small models with big windows; a smaller one cuts cost.</div>
      </div>

      <div class="field">
        <label>${icon('i-sparkle')} Temperature</label>
        <input type="number" id="s-temp" min="0" max="2" step="0.1" value="${Number(config.temperature) ?? 0.2}" />
        <div class="hint">0.1–0.3 keeps edits predictable. Higher values explore more and break things more.</div>
      </div>

      <div class="field">
        <label>${icon('i-brain')} Reasoning effort</label>
        <div class="slider-row">
          <input type="range" id="s-effort" min="0" max="3" step="1" value="${REASONING_STEPS.findIndex((s) => s.value === (config.reasoningEffort || ''))}" aria-label="Reasoning effort" />
          <span class="slider-value" id="s-effort-value">${escapeHtml((REASONING_STEPS.find((s) => s.value === (config.reasoningEffort || '')) || REASONING_STEPS[0]).label)}</span>
        </div>
        <div class="hint" id="s-effort-hint">${escapeHtml(reasoningEffortHint(config.baseUrl))}</div>
      </div>

      <div class="field">
        <label>System prompt</label>
        <textarea id="s-system" spellcheck="false">${escapeHtml(config.systemPrompt || '')}</textarea>
      </div>

      <div id="s-status"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="s-test">${icon('i-plug')} Test connection</button>
      <div class="grow"></div>
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="s-save">Save</button>
    </div>
  `);

  const modeButtons = dom.modalRoot.querySelectorAll('#s-mode [data-mode]');
  const paintMode = (mode) => {
    modeButtons.forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  };
  paintMode(config.approvalMode || 'auto');
  modeButtons.forEach((b) =>
    b.addEventListener('click', () => {
      dom.modalRoot.dataset.mode = b.dataset.mode;
      paintMode(b.dataset.mode);
    })
  );
  dom.modalRoot.dataset.mode = config.approvalMode || 'auto';

  dom.modalRoot.querySelectorAll('[data-url]').forEach((button) => {
    button.addEventListener('click', () => {
      el('s-base').value = button.dataset.url;
      if (!el('s-model').value.trim()) el('s-model').value = button.dataset.model;
    });
  });

  // Both a preset button and the text field can change the URL, and the hint
  // depends on which host that URL names, so it is repainted from either one.
  const paintEffortHint = () => {
    el('s-effort-hint').textContent = reasoningEffortHint(el('s-base').value.trim());
  };
  el('s-base').addEventListener('input', paintEffortHint);
  dom.modalRoot.querySelectorAll('[data-url]').forEach((button) => {
    button.addEventListener('click', paintEffortHint);
  });

  // Hop over to the free picker. It mounts into the same modal root, so the
  // settings modal is replaced rather than stacked — say so instead of
  // pretending the fields are still there.
  el('s-free')?.addEventListener('click', () => {
    openFreeProviders();
  });

  const status = (message, kind = '') => {
    el('s-status').innerHTML = message
      ? `<div class="status-line ${kind}">${icon(kind === 'bad' ? 'i-warn' : kind === 'ok' ? 'i-check' : 'i-info')}<span>${escapeHtml(message)}</span></div>`
      : '';
  };

  el('s-test').addEventListener('click', async () => {
    status('Testing…');
    try {
      const result = await api('/api/models/test', {
        method: 'POST',
        body: { baseUrl: el('s-base').value.trim(), apiKey: el('s-key').value.trim() || undefined, model: el('s-model').value.trim() },
      });
      status(result.message, result.ok ? 'ok' : 'bad');
    } catch (err) {
      status(err.message, 'bad');
    }
  });

  el('s-load-models').addEventListener('click', async () => {
    const target = el('s-model-list');
    target.innerHTML = '<div class="status-line" style="margin-top:8px">Loading models…</div>';
    try {
      const data = await api('/api/models', {
        method: 'POST',
        body: { baseUrl: el('s-base').value.trim(), apiKey: el('s-key').value.trim() || undefined },
      });
      if (!data.models.length) {
        target.innerHTML = '<div class="status-line bad" style="margin-top:8px">The endpoint returned no models. Type the model name manually.</div>';
        return;
      }
      const current = el('s-model').value.trim();
      target.innerHTML = `<div class="model-list" style="margin-top:8px">${data.models
        .map(
          (m) =>
            `<button type="button" class="model-item ${m.id === current ? 'on' : ''}" data-pick="${escapeHtml(m.id)}">${escapeHtml(m.id)}${
              m.owned_by ? `<span class="owner">${escapeHtml(m.owned_by)}</span>` : ''
            }</button>`
        )
        .join('')}</div>`;
      target.querySelectorAll('[data-pick]').forEach((node) => {
        node.addEventListener('click', () => {
          el('s-model').value = node.dataset.pick;
          target.querySelectorAll('.model-item').forEach((n) => n.classList.toggle('on', n === node));
        });
      });
    } catch (err) {
      target.innerHTML = `<div class="status-line bad" style="margin-top:8px">${icon('i-warn')}<span>${escapeHtml(err.message)}</span></div>`;
    }
  });

  el('s-browse').addEventListener('click', () => {
    openFileBrowser(el('s-workspace').value.trim() || config.workspace, (picked) => {
      el('s-workspace').value = picked;
    });
  });

  // The range input carries an index, not one of the values: a range cannot
  // represent "unset", and "Provider default" has to stay unset rather than
  // become a level the provider never agreed to.
  const paintEffort = () => {
    const step = REASONING_STEPS[Number(el('s-effort').value)] || REASONING_STEPS[0];
    el('s-effort-value').textContent = step.label;
    el('s-effort-value').classList.toggle('on', Boolean(step.value));
  };
  paintEffort();
  el('s-effort').addEventListener('input', paintEffort);

  el('s-save').addEventListener('click', async () => {
    const effort = REASONING_STEPS[Number(el('s-effort').value)] || REASONING_STEPS[0];
    const patch = {
      baseUrl: el('s-base').value.trim(),
      model: el('s-model').value.trim(),
      approvalMode: dom.modalRoot.dataset.mode,
      workspace: el('s-workspace').value.trim(),
      maxSteps: Number(el('s-steps').value) || 12,
      maxContextChars: Number(el('s-context').value) || 80000,
      temperature: Number(el('s-temp').value),
      reasoningEffort: effort.value,
      systemPrompt: el('s-system').value,
    };
    const key = el('s-key').value.trim();
    if (key) patch.apiKey = key;

    try {
      state.config = await api('/api/settings', { method: 'PATCH', body: patch });
      closeModal();
      renderChrome();
      renderWelcomeIfEmpty();
      toast('Settings saved');
    } catch (err) {
      status(err.message, 'bad');
    }
  });
}

function renderWelcomeIfEmpty() {
  if (!state.blocks.length) renderWelcome();
}

/** Directory browser, rooted at the current workspace's drive. */
function openFileBrowser(startPath, onPick) {
  let current = startPath;
  let selected = startPath;

  mountModal(`
    <div class="modal-head">
      ${icon('i-folder')}
      <h2>Choose a folder</h2>
      <button class="icon-btn" data-close aria-label="Close">${icon('i-close')}</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>Location</label>
        <input type="text" id="b-path" value="${escapeHtml(startPath || '')}" spellcheck="false"
               placeholder="C:\\path\\to\\folder" />
        <div class="hint">Type a full path and press Enter to jump straight to it. Click any folder below to open it. Use <strong>New folder</strong> to create one.</div>
      </div>
      <div id="b-status"></div>
      <div class="model-list" id="b-list" style="max-height:42vh"></div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="b-up">${icon('i-chevron')} Up</button>
      <button class="btn btn-ghost" id="b-new">${icon('i-plus')} New folder</button>
      <div class="grow"></div>
      <button class="btn btn-ghost" data-close>Cancel</button>
      <button class="btn btn-primary" id="b-use">Use this folder</button>
    </div>
  `);

  const list = el('b-list');
  const pathInput = el('b-path');
  const statusBox = el('b-status');

  const setStatus = (message, kind = '') => {
    statusBox.innerHTML = message
      ? `<div class="status-line ${kind}">${icon(
          kind === 'bad' ? 'i-warn' : kind === 'ok' ? 'i-check' : 'i-info'
        )}<span>${escapeHtml(message)}</span></div>`
      : '';
  };

  async function load(target, successMessage = '') {
    list.innerHTML = '<div class="status-line">Loading…</div>';
    try {
      const data = await api(`/api/fs?path=${encodeURIComponent(target)}`);
      if (data.type === 'file') {
        const parent = data.path.replace(/[\\/][^\\/]*$/, '') || data.path;
        return load(parent, successMessage);
      }
      current = data.path;
      selected = data.path;
      pathInput.value = data.path;
      // Set the notice *after* loading, so it is not wiped by this call.
      setStatus(successMessage, successMessage ? 'ok' : '');
      const dirs = (data.entries || []).filter((e) => e.dir);
      const files = (data.entries || []).filter((e) => !e.dir);
      const shortName = data.path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || data.path;

      list.innerHTML = `
        ${dirs
          .map(
            (d) =>
              `<button type="button" class="model-item" data-dir="${escapeHtml(d.name)}" title="Open ${escapeHtml(
                d.name
              )}">${icon('i-folder')}<span>${escapeHtml(d.name)}</span></button>`
          )
          .join('')}
        ${
          dirs.length
            ? ''
            : `<div class="status-line" style="border:0;background:none">${(files.length
                ? 'No subfolders here'
                : 'This folder is empty')} — use <strong>New folder</strong> to create one.</div>`
        }
        ${
          files.length
            ? `<div class="status-line" style="border:0;background:none;color:var(--text-3)">${files.length} file(s) in this folder</div>`
            : ''
        }`;

      // The button names the folder it will select, so "Use this folder" is
      // never ambiguous about which folder "this" means.
      el('b-use').textContent = `Use "${shortName}"`;

      list.querySelectorAll('[data-dir]').forEach((node) => {
        node.addEventListener('click', () => {
          const sep = current.includes('\\') ? '\\' : '/';
          load(`${current.replace(/[\\/]$/, '')}${sep}${node.dataset.dir}`);
        });
      });
    } catch (err) {
      // Leave the field showing where we actually are, so the next keystroke
      // does not append to the path that just failed.
      pathInput.value = current;
      list.innerHTML = '';
      setStatus(err.message, 'bad');
    }
  }

  /** Inline form so a new folder can be named without leaving the picker. */
  function showNewFolderForm() {
    if (el('b-newform')) {
      el('b-new-input')?.focus();
      return;
    }
    const form = document.createElement('div');
    form.className = 'inline-form';
    form.id = 'b-newform';
    form.innerHTML = `
      <input type="text" id="b-new-input" placeholder="new-folder-name" spellcheck="false" autocomplete="off" />
      <button class="btn btn-primary btn-sm" id="b-new-create">Create</button>
      <button class="btn btn-ghost btn-sm" id="b-new-cancel">Cancel</button>`;
    statusBox.after(form);

    const input = el('b-new-input');
    input.focus();

    const create = async () => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      setStatus('Creating…');
      try {
        const result = await api('/api/fs/mkdir', { method: 'POST', body: { parent: current, name } });
        form.remove();
        const message = result.created
          ? `Created "${name}" and opened it.`
          : `"${name}" already existed, so it was opened.`;
        await load(result.path, message);
      } catch (err) {
        setStatus(err.message, 'bad');
        input.focus();
      }
    };

    el('b-new-create').addEventListener('click', create);
    el('b-new-cancel').addEventListener('click', () => {
      form.remove();
      setStatus('');
    });
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') {
        event.preventDefault();
        create();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        form.remove();
      }
    });
  }

  el('b-up').addEventListener('click', () => {
    const parent = current.replace(/[\\/][^\\/]*$/, '');
    if (parent && parent !== current) load(parent);
    else load(current.replace(/[^\\/]*$/, ''));
  });
  el('b-new').addEventListener('click', showNewFolderForm);
  el('b-use').addEventListener('click', () => {
    onPick(selected || current);
    closeModal();
  });

  // Typing replaces the existing value instead of appending to it.
  pathInput.addEventListener('focus', () => pathInput.select());
  pathInput.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      load(pathInput.value.trim());
    }
  });

  load(current);
}

/* ------------------------------------------------------------------ *
 * Composer
 * ------------------------------------------------------------------ */

function autosize() {
  const node = dom.prompt;
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, 320)}px`;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('klaud.theme', next);
  } catch { /* ignore */ }
  renderChrome();
}

function cycleMode() {
  const order = ['auto', 'ask', 'readonly'];
  const current = state.config?.approvalMode || 'auto';
  const next = order[(order.indexOf(current) + 1) % order.length];
  api('/api/settings', { method: 'PATCH', body: { approvalMode: next } })
    .then((config) => {
      state.config = config;
      renderChrome();
      toast(`Tool permissions: ${next === 'readonly' ? 'read-only' : next === 'ask' ? 'ask first' : 'auto-run'}`);
    })
    .catch((err) => toast(err.message));
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function wireEvents() {
  dom.prompt.addEventListener('input', () => {
    autosize();
    renderChrome();
  });
  dom.prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    }
  });
  dom.send.addEventListener('click', () => (state.streaming ? stopStreaming() : submit()));
  el('open-free').addEventListener('click', openFreeProviders);
  el('new-chat').addEventListener('click', newChat);
  el('open-settings-top').addEventListener('click', openSettings);
  el('toggle-theme').addEventListener('click', toggleTheme);
  // The sidebar header's button hides it; the button that appears in the top bar
  // brings it back. One control visible at a time, so there is never a dead
  // button on screen and never two buttons doing the same job.
  el('collapse-sidebar').addEventListener('click', toggleSidebar);
  el('toggle-sidebar').addEventListener('click', toggleSidebar);
  el('model-pill').addEventListener('click', () => {
    // With no key yet, the useful destination is the free list, not a form.
    if (!state.config?.hasApiKey) openFreeProviders();
    else openSettings();
  });
  el('workspace-chip').addEventListener('click', () => {
    openFileBrowser(state.config?.workspace, async (picked) => {
      try {
        state.config = await api('/api/settings', { method: 'PATCH', body: { workspace: picked } });
        renderChrome();
        toast(`Working directory: ${picked}`);
      } catch (err) {
        toast(err.message);
      }
    });
  });
  el('composer-workspace').addEventListener('click', () => el('workspace-chip').click());
  el('composer-mode').addEventListener('click', cycleMode);

  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      newChat();
    } else if (mod && event.key === ',') {
      event.preventDefault();
      openSettings();
    } else if (mod && event.key === '/') {
      event.preventDefault();
      dom.prompt.focus();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.streaming) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

async function boot() {
  readToken();
  wireEvents();
  autosize();

  // Exposed for the headless browser tests, which assert on app state rather
  // than scraping the DOM. Harmless in normal use.
  window.__klaud = {
    state,
    settings,
    version: 1,
    renderChrome,
    shortModelName,
  };

  if (!settings.token) {
    showUnauthorizedScreen('No session token is stored in this browser.');
    return;
  }

  try {
    const [info, config] = await Promise.all([api('/api/info'), api('/api/settings')]);
    settings.info = info;
    state.config = config;
  } catch (err) {
    if (err.unauthorized) {
      showUnauthorizedScreen('The server rejected the stored token.');
      return;
    }
    dom.messages.innerHTML = `
      <div class="welcome">
        <svg class="mark" aria-hidden="true"><use href="#i-mark"/></svg>
        <h1>Cannot reach the Klaud server</h1>
        <p class="lede">${escapeHtml(err.message)}</p>
      </div>`;
    return;
  }

  renderChrome();
  restoreSidebar();
  renderWelcome();
  await refreshChats();

  const hashChat = new URLSearchParams(location.hash.replace(/^#/, '')).get('chat');
  if (hashChat && state.chats.some((c) => c.id === hashChat)) {
    await openChat(hashChat);
  } else if (state.chats.length) {
    // Start fresh, but surface the most recent conversation in the sidebar.
    renderChatList();
  }

  dom.prompt.focus();

  if (!state.config.hasApiKey) {
    setTimeout(openSettings, 350);
  }
}

boot();

/* ------------------------------------------------------------------ *
 * Keyboard or pointer?
 *
 * A focus ring belongs to keyboard users. `:focus-visible` cannot answer that
 * question here: Chrome always matches it for a textarea, so clicking the prompt
 * box looked identical to tabbing into it and the composer painted an outline on
 * a plain click. `data-kb` records how focus last arrived — set by Tab, cleared
 * by any pointer or by typing — and CSS keys the ring off it, so a mouse user
 * sees no ring and a keyboard user always does.
 * ------------------------------------------------------------------ */
document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    document.documentElement.dataset.kb = '1';
    return;
  }
  // Typing is not navigating. A printable key clears the flag so a mouse click
  // into the field cannot gain a ring just because a letter was typed after it,
  // which would put the outline back the moment the user starts writing.
  const typed = event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
  if (typed) delete document.documentElement.dataset.kb;
}, true);

document.addEventListener('pointerdown', () => {
  delete document.documentElement.dataset.kb;
}, true);
