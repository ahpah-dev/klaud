'use strict';

/**
 * Frontend integrity check — no browser needed.
 *
 *   node test/ui-static.js
 *
 * Parses every client module (catches syntax and template-literal problems) and
 * cross-checks that every element id the app looks up actually exists in the
 * HTML, and that every icon it references is defined in the SVG sprite.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m+\x1b[0m ${name}`);
  } else {
    fail++;
    console.log(`  \x1b[31mx\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(PUBLIC, 'app.js'), 'utf8');
const markdown = fs.readFileSync(path.join(PUBLIC, 'markdown.mjs'), 'utf8');

console.log('\n\x1b[38;5;209m* Klaud frontend integrity check\x1b[0m\n');

/* ---------------- syntax ---------------- */
for (const file of ['app.js', 'markdown.mjs']) {
  const source = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
  try {
    // Wrap as a module so `import`/`export` parse.
    new vm.SourceTextModule(source, { identifier: file });
    check(`${file} parses as an ES module`, true);
  } catch (err) {
    if (err.name === 'TypeError' || /SourceTextModule is not a constructor|not defined/.test(err.message)) {
      // No vm module support: fall back to stripping module syntax.
      try {
        const stripped = source
          .replace(/^\s*import\s[^;]+;/gm, '')
          .replace(/^\s*export\s+(?=(async\s+)?(function|const|let|var|class))/gm, '');
        new vm.Script(stripped, { filename: file });
        check(`${file} parses`, true);
      } catch (inner) {
        check(`${file} parses`, false, inner.message);
      }
    } else {
      check(`${file} parses as an ES module`, false, err.message);
    }
  }
}

/* ---------------- element ids ---------------- */
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const lookedUp = [...app.matchAll(/\bel\('([^']+)'\)/g)].map((m) => m[1]);
const alsoLookedUp = [...app.matchAll(/\bgetElementById\('([^']+)'\)/g)].map((m) => m[1]);

// Ids that live inside markup the app injects at runtime (modals, recovery),
// plus ids assigned programmatically (`node.id = 'x'`).
const dynamicIds = new Set([
  ...[...app.matchAll(/\bid="([^"$]+)"/g)].map((m) => m[1]),
  ...[...app.matchAll(/id='([^'$]+)'/g)].map((m) => m[1]),
  ...[...app.matchAll(/\.id\s*=\s*['"]([^'"$]+)['"]/g)].map((m) => m[1]),
]);
const wanted = new Set([...lookedUp, ...alsoLookedUp].filter((id) => !dynamicIds.has(id)));

check(`the app looks up ${wanted.size + dynamicIds.size} element ids`, wanted.size + dynamicIds.size > 20);

const missing = [...wanted].filter((id) => !htmlIds.has(id));
check('every shell element id the app uses exists in index.html', missing.length === 0, `missing: ${missing.join(', ')}`);

const expectedModalIds = ['s-base', 's-key', 's-model', 's-model-list', 's-load-models', 's-test',
  's-save', 's-status', 's-mode', 's-browse', 's-workspace', 's-steps', 's-temp', 's-system',
  's-context', 'b-list', 'b-path', 'b-up', 'b-use', 'b-new', 'b-status',
  'b-newform', 'b-new-input', 'b-new-create', 'b-new-cancel',
  'recover-token', 'recover-go', 'recover-status'];
const missingModal = expectedModalIds.filter((id) => !dynamicIds.has(id));
check('every modal field the app reads back is created', missingModal.length === 0, `missing: ${missingModal.join(', ')}`);

/* ---------------- svg sprite ---------------- */
const symbols = new Set([...html.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
const referenced = new Set([
  ...[...app.matchAll(/href="#(i-[a-z-]+)"/g)].map((m) => m[1]),
  ...[...app.matchAll(/\bicon\('(i-[a-z-]+)'/g)].map((m) => m[1]),
  ...[...app.matchAll(/'(i-[a-z-]+)'/g)].map((m) => m[1]),
  ...[...html.matchAll(/href="#(i-[a-z-]+)"/g)].map((m) => m[1]),
]);

const undefinedIcons = [...referenced].filter((id) => !symbols.has(id));
check(`all ${referenced.size} referenced icons exist in the sprite`, undefinedIcons.length === 0,
  `missing: ${undefinedIcons.join(', ')}`);

const unusedIcons = [...symbols].filter((id) => !referenced.has(id));
check('no unused sprite icons (dead weight)', unusedIcons.length === 0, `unused: ${unusedIcons.join(', ')}`);

/* ---------------- css coverage ---------------- */
const appClasses = new Set();
for (const m of app.matchAll(/class="([^"$]+)"/g)) {
  for (const cls of m[1].split(/\s+/)) if (cls) appClasses.add(cls);
}
for (const m of html.matchAll(/class="([^"]+)"/g)) {
  for (const cls of m[1].split(/\s+/)) if (cls) appClasses.add(cls);
}
// Wrapper divs that exist only to give a node a single child.
const structural = new Set(['block-body']);
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const unstyled = [...appClasses].filter(
  (cls) => !cssClasses.has(cls) && !cls.startsWith('diff-') && !structural.has(cls)
);
check(`all ${appClasses.size} markup classes are styled`, unstyled.length === 0, `unstyled: ${unstyled.join(', ')}`);

/* ---------------- theme tokens ---------------- */
for (const token of ['--bg', '--text', '--accent', '--border', '--surface']) {
  const declared = (css.match(new RegExp(`\\${token}:`, 'g')) || []).length;
  check(`${token} is declared for both themes (${declared} definitions)`, declared >= 2);
}

/* ---------------- the working indicator ---------------- */
// It only exists between sending and the first token, so it cannot be caught by
// the browser suite without deliberately stalling a provider. These static
// checks cover the parts that are easy to break silently.
check('the working indicator renders three real dot elements',
  /class="tr-dots"[\s\S]{0,200}<circle/.test(app), 'dots must not come from <use>');
// A <use> renders into a shadow tree, so the staggered animation could neither
// be measured nor relied upon. Inline circles are the whole reason this works.
check('the indicator does not pull its dots from the icon sprite',
  !/tr-dots[\s\S]{0,80}href="#i-dots"/.test(app));
check('the indicator has a label hook for phase updates', /data-thinking-label/.test(app));

for (const keyframes of ['think-breathe', 'think-dot', 'think-sheen']) {
  check(`the ${keyframes} animation is defined`, new RegExp(`@keyframes ${keyframes}`).test(css));
}

// Without transform-box the circles scale about the SVG origin, not their own
// centres, so the dots fly out of the viewBox instead of pulsing. This was a
// real bug, and it is invisible in a static screenshot.
check('the pulsing dots scale about their own centres',
  /\.tr-dots circle\s*\{[^}]*transform-box:\s*fill-box/.test(css),
  'transform-box: fill-box is required for SVG child transforms');
check('the dots carry staggered delays so they do not move as one blob',
  /tr-dots circle:nth-child\(2\)/.test(css) && /tr-dots circle:nth-child\(3\)/.test(css));
check('the indicator is disabled under prefers-reduced-motion',
  /prefers-reduced-motion[\s\S]{0,600}tr-dots circle/.test(css));
// The sheen needs background-clip: text; without it the label renders invisible
// because the fill is transparent.
check('the label shimmer keeps the text visible',
  /-webkit-text-fill-color:\s*transparent/.test(css) && /background-clip:\s*text/.test(css));

/* ---------------- api surface ---------------- */
for (const route of ['/api/chat', '/api/settings', '/api/chats', '/api/models', '/api/info', '/api/fs']) {
  check(`the client calls ${route}`, app.includes(`'${route}`) || app.includes(`\`${route}`) || app.includes(`${route}/`));
}

check('the client sends the session token on every API call', /x-klaud-token/.test(app));
check('the client reads the token out of the URL fragment', /location\.hash/.test(app));
check('the client strips the token from the address bar', /replaceState/.test(app));

// Regression: app.js is an ES module, so the tag that loads it must say so.
const moduleTag = html.match(/<script[^>]*src="\/app\.js"[^>]*>/);
check('index.html loads app.js as a module', Boolean(moduleTag) && /type="module"/.test(moduleTag[0]),
  moduleTag ? moduleTag[0] : 'script tag not found');
check('app.js really uses import syntax', /^\s*import\s/m.test(app));

/* ---------------- markdown renderer ---------------- */
check('markdown escapes HTML before rendering', /escapeHtml/.test(markdown) && /&lt;/.test(markdown));
check('markdown handles fenced code blocks', /```/.test(markdown) && /data-lang/.test(markdown));
check('markdown handles tables', /<table>/.test(markdown));
check('markdown handles task lists', /todo/.test(markdown));

console.log('');
if (fail) {
  console.log(`\x1b[31mx ${fail} of ${pass + fail} frontend checks failed\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m+ all ${pass} frontend checks passed\x1b[0m\n`);
