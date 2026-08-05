/**
 * unzen core E2E Demo — client wiring (issue #104).
 *
 * The demo page is wired here with module event listeners (no inline onclick,
 * no global window.* handlers). Every demo section is driven through the SAME
 * `runDemo()` pipeline — validation → busy guard → AbortSignal → SDK call →
 * event→state mapping → result/diagnostics rendering → statistics — including
 * the Markdown demo, whose `onSuccess` hook renders the result in a sandboxed
 * iframe after the shared pipeline finishes.
 *
 * All testable logic (state machine, statistics, validation, diagnostics
 * schema/classification, copy) lives in the sibling pure modules so the same
 * code runs in the browser and in vitest:
 *   demo-state.js, demo-stats.js, demo-validate.js,
 *   demo-diagnostics.js, demo-i18n.js
 *
 * The SDK is consumed through the issue #105 API:
 *   client.executeWithDiagnostics({ name, args, signal, onEvent })
 * UI state is derived from event TYPES (never from parsing error messages) and
 * error copy/visuals come from stable error codes.
 */

import { UnzenClient } from '/client.js';
import {
  DemoState,
  createDemoState,
  reduceDemoState,
  canSubmit,
  isRunning,
  isTerminal,
} from './demo-state.js';
import {
  createStats,
  reduceStats,
  average,
  StatKind,
  STAT_COUNT_KEYS,
  statKindForError,
} from './demo-stats.js';
import { classifyError, summarizeDiagnostics } from './demo-diagnostics.js';
import {
  parseNumber,
  parseNumberList,
  parseJsonLite,
  validatePriceItems,
  validateDiscount,
  isValidEmail,
  isValidCardNumber,
  isValidPhone,
  isStrongPassword,
} from './demo-validate.js';
import { makeI18n, LANGUAGES } from './demo-i18n.js';

// ============================================================
// Endpoint resolution
// ============================================================

/**
 * Resolve the unzen API endpoint from the current origin so the page works on
 * HTTP (localhost) and HTTPS (mixed content is never produced by a hard-coded
 * "http://localhost:3000/unzen"). A deployment may override it by defining
 * `window.UNZEN_DEMO_CONFIG = { endpoint: '...' }` before this module loads.
 */
function resolveEndpoint() {
  const cfg = window.UNZEN_DEMO_CONFIG;
  if (cfg && typeof cfg.endpoint === 'string' && cfg.endpoint.length > 0) {
    return cfg.endpoint;
  }
  return new URL('/unzen', window.location.origin).href;
}

const client = new UnzenClient({
  endpoint: resolveEndpoint(),
  mode: 'production',
  workerUrl: '/worker.js',
});

// ============================================================
// i18n
// ============================================================

let i18n = makeI18n(detectLanguage());
let t = i18n.t;

/** Pick the page language from the browser preference (en/ja). */
function detectLanguage() {
  const nav = navigator.language || 'en';
  return nav.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

/** Apply data-i18n copy to static markup and switch the <html> lang. */
function applyStaticI18n() {
  document.documentElement.lang = i18n.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = t(key);
  });
}

/** Switch language and re-render the dynamic UI with the new copy. */
function setLanguage(lang) {
  if (!LANGUAGES.includes(lang)) return;
  i18n = makeI18n(lang);
  t = i18n.t;
  applyStaticI18n();
  document.querySelectorAll('.lang-btn').forEach((btn) => {
    const active = btn.getAttribute('data-lang') === lang;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  for (const adapter of demos) {
    applyState(adapter);
    renderLiveChain(adapter);
    if (adapter.lastResult !== null) renderResult(adapter, adapter.lastResult);
  }
  renderStats();
}

// ============================================================
// Session statistics (module-level, cleared by the Reset button)
// ============================================================

let stats = createStats();

const STAT_LABELS = {
  'browser-success': 'stats.browserSuccess',
  'fallback-success': 'stats.fallbackSuccess',
  'input-error': 'stats.inputError',
  'function-error': 'stats.functionError',
  'runtime-error': 'stats.runtimeError',
  'server-error': 'stats.serverError',
  'network-error': 'stats.networkError',
  cancelled: 'stats.cancelled',
  unknown: 'stats.unknown',
};

/** 'browser-success' → 'definitionBrowserSuccess' (stats definitions in i18n). */
function definitionKey(countKey) {
  const camel = countKey.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return `stats.definition${camel}`;
}

function makeStatCard(value, label, definition, isNull = false) {
  const card = document.createElement('div');
  card.className = 'stat-card';
  card.title = definition;
  const valueEl = document.createElement('div');
  valueEl.className = `stat-value${isNull ? ' is-null' : ''}`;
  valueEl.textContent = value;
  const labelEl = document.createElement('div');
  labelEl.className = 'stat-label';
  labelEl.textContent = label;
  card.appendChild(valueEl);
  card.appendChild(labelEl);
  return card;
}

function renderStats() {
  const grid = document.getElementById('stats-grid');
  if (!grid) return;
  grid.textContent = '';

  for (const key of STAT_COUNT_KEYS) {
    grid.appendChild(
      makeStatCard(String(stats.counts[key] || 0), t(STAT_LABELS[key]), t(definitionKey(key))),
    );
  }
  grid.appendChild(
    makeStatCard(String(stats.cacheHits), t('stats.cacheHit'), t('stats.definitionCacheHit')),
  );

  const averageDefs = [
    ['stats.avgTotal', 'stats.definitionAvgTotal', stats.totalDuration],
    ['stats.avgBrowser', 'stats.definitionAvgBrowser', stats.browserDuration],
    ['stats.avgServer', 'stats.definitionAvgServer', stats.serverDuration],
  ];
  for (const [labelKey, defKey, sample] of averageDefs) {
    const avg = average(sample);
    const card = makeStatCard(avg === null ? '—' : `${avg.toFixed(1)} ms`, t(labelKey), t(defKey), avg === null);
    const count = document.createElement('span');
    count.className = 'stat-count';
    count.textContent = t('stats.sampleCount', { count: sample.count });
    card.appendChild(count);
    grid.appendChild(card);
  }
}

function recordOutcome(action) {
  stats = reduceStats(stats, action);
  renderStats();
}

// ============================================================
// Small helpers
// ============================================================

function valueOf(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

/** Build the field config for a named input; error element id = input id + '-error'. */
const field = (inputId) => ({ inputId, errorId: `${inputId}-error` });

const ok = (args) => ({ ok: true, args });
const fieldError = (fieldName, messageKey, params) => ({
  ok: false,
  errors: [{ field: fieldName, messageKey, params }],
});

// ============================================================
// Demo adapters — one per section, all consumed by runDemo()
// ============================================================

function buildDemos() {
  return [
    {
      base: 'spam',
      sectionId: 'demo-spam',
      functionName: 'spamCheck',
      fields: { text: field('spam-text') },
      readInputs: () => ({ text: valueOf('spam-text') }),
      validate: ({ text }) => (text.trim() ? ok([text]) : fieldError('text', 'errors.required')),
    },
    {
      base: 'multiply',
      sectionId: 'demo-multiply',
      functionName: 'multiply',
      fields: { num1: field('num1'), num2: field('num2') },
      readInputs: () => ({ num1: valueOf('num1'), num2: valueOf('num2') }),
      validate: ({ num1, num2 }) => {
        const a = parseNumber(num1);
        const b = parseNumber(num2);
        const errors = [];
        if (!a.ok) errors.push({ field: 'num1', messageKey: 'errors.requiredNumber', params: { value: num1 } });
        if (!b.ok) errors.push({ field: 'num2', messageKey: 'errors.requiredNumber', params: { value: num2 } });
        if (errors.length) return { ok: false, errors };
        return ok([a.value, b.value]);
      },
    },
    {
      base: 'array',
      sectionId: 'demo-array',
      functionName: 'doubleArray',
      fields: { list: field('array-input') },
      readInputs: () => ({ list: valueOf('array-input') }),
      validate: ({ list }) => {
        const parsed = parseNumberList(list);
        if (parsed.isEmpty) return fieldError('list', 'errors.required');
        if (!parsed.ok) {
          // Positions are 1-based and the raw tokens are shown — invalid input
          // is never silently dropped (issue #104).
          const positions = parsed.invalid.map((token) => token.index + 1).join(', ');
          const tokens = parsed.invalid.map((token) => `"${token.raw}"`).join(', ');
          return {
            ok: false,
            errors: [{ field: 'list', messageKey: 'errors.invalidArrayTokens', params: { positions, tokens } }],
          };
        }
        return ok([parsed.values]);
      },
    },
    {
      base: 'user',
      sectionId: 'demo-user',
      functionName: 'getUserInfo',
      fields: { firstName: field('firstName'), lastName: field('lastName'), age: field('age') },
      readInputs: () => ({ firstName: valueOf('firstName'), lastName: valueOf('lastName'), age: valueOf('age') }),
      validate: ({ firstName, lastName, age }) => {
        const errors = [];
        if (!firstName.trim()) errors.push({ field: 'firstName', messageKey: 'errors.required' });
        if (!lastName.trim()) errors.push({ field: 'lastName', messageKey: 'errors.required' });
        const ageValue = parseNumber(age);
        if (!ageValue.ok || !Number.isInteger(ageValue.value) || ageValue.value < 0) {
          errors.push({ field: 'age', messageKey: 'errors.integerNumber' });
        }
        if (errors.length) return { ok: false, errors };
        return ok([{ firstName: firstName.trim(), lastName: lastName.trim(), age: ageValue.value }]);
      },
    },
    {
      base: 'form',
      sectionId: 'demo-form',
      functionName: 'formValidate',
      fields: {
        email: field('form-email'),
        card: field('form-card'),
        phone: field('form-phone'),
        password: field('form-password'),
      },
      readInputs: () => ({
        email: valueOf('form-email'),
        card: valueOf('form-card'),
        phone: valueOf('form-phone'),
        password: valueOf('form-password'),
      }),
      validate: ({ email, card, phone, password }) => {
        // Fields are optional; provided fields are checked locally (same rules
        // as the sandbox function) so errors can be associated per-field.
        const errors = [];
        if (email && !isValidEmail(email)) errors.push({ field: 'email', messageKey: 'errors.invalidEmail' });
        if (card && !isValidCardNumber(card)) errors.push({ field: 'card', messageKey: 'errors.invalidCard' });
        if (phone && !isValidPhone(phone)) errors.push({ field: 'phone', messageKey: 'errors.invalidPhone' });
        if (password && !isStrongPassword(password)) errors.push({ field: 'password', messageKey: 'errors.weakPassword' });
        if (errors.length) return { ok: false, errors };
        const payload = {};
        if (email) payload.email = email;
        if (card) payload.creditCard = card;
        if (phone) payload.phone = phone;
        if (password) payload.password = password;
        return ok([payload]);
      },
    },
    {
      base: 'price',
      sectionId: 'demo-price',
      functionName: 'calculatePrice',
      fields: {
        items: field('price-items'),
        region: field('price-region'),
        discount: field('price-discount'),
      },
      readInputs: () => ({
        items: valueOf('price-items'),
        region: valueOf('price-region'),
        discount: valueOf('price-discount'),
      }),
      validate: ({ items, region, discount }) => {
        const errors = [];
        const itemsParsed = parseJsonLite(items);
        if (!itemsParsed.ok) {
          errors.push({
            field: 'items',
            messageKey: 'errors.invalidJson',
            params: { line: itemsParsed.error.line, column: itemsParsed.error.column, message: itemsParsed.error.message },
          });
        } else {
          const shape = validatePriceItems(itemsParsed.value);
          if (!shape.ok) {
            errors.push({
              field: 'items',
              messageKey: 'errors.priceItemsShape',
              params: { detail: shape.errors.map((e) => e.message).join('; ') },
            });
          }
        }
        if (!region.trim()) errors.push({ field: 'region', messageKey: 'errors.required' });

        let discountValue = null;
        const discountText = discount.trim();
        if (discountText) {
          const parsed = parseJsonLite(discountText);
          if (!parsed.ok) {
            errors.push({
              field: 'discount',
              messageKey: 'errors.invalidJson',
              params: { line: parsed.error.line, column: parsed.error.column, message: parsed.error.message },
            });
          } else {
            const shape = validateDiscount(parsed.value);
            if (!shape.ok) {
              errors.push({
                field: 'discount',
                messageKey: 'errors.discountShape',
                params: { detail: shape.errors.map((e) => e.message).join('; ') },
              });
            } else {
              discountValue = parsed.value;
            }
          }
        }

        if (errors.length) return { ok: false, errors };
        const order = { items: itemsParsed.value, region: region.trim() };
        if (discountValue) order.discount = discountValue;
        return ok([order]);
      },
    },
    {
      base: 'markdown',
      sectionId: 'demo-markdown',
      functionName: 'markdownToHtml',
      fields: { text: field('markdown-input') },
      readInputs: () => ({ text: valueOf('markdown-input') }),
      validate: ({ text }) => (text.trim() ? ok([text]) : fieldError('text', 'errors.required')),
      // Success hook runs AFTER the shared pipeline: renders the result into a
      // sandboxed iframe (defense in depth, same as the original demo).
      onSuccess(area, result) {
        const pre = document.createElement('pre');
        pre.textContent = JSON.stringify(result.result, null, 2);
        area.appendChild(pre);
        const wrap = document.createElement('div');
        wrap.className = 'markdown-preview';
        const iframe = document.createElement('iframe');
        iframe.sandbox = '';
        iframe.srcdoc = typeof result.result === 'string' ? result.result : String(result.result);
        wrap.appendChild(iframe);
        area.appendChild(wrap);
      },
    },
    {
      base: 'text',
      sectionId: 'demo-text',
      functionName: 'textStats',
      fields: { text: field('text-input') },
      readInputs: () => ({ text: valueOf('text-input') }),
      validate: ({ text }) => (text.trim() ? ok([text]) : fieldError('text', 'errors.required')),
    },
  ];
}

// ============================================================
// Rendering helpers
// ============================================================

/**
 * Reflect the current state machine state into the DOM:
 *   - section [data-state] attribute (drives the CSS),
 *   - run button disabled + aria-busy while running (double-submit guard),
 *   - cancel button visible only while running (disabled while cancelling),
 *   - retry button visible only after a terminal state,
 *   - the aria-live status text announces the current state.
 */
function applyState(adapter) {
  const { state, errorCode } = adapter.state;
  const el = adapter.el;
  const running = isRunning(state);
  const terminal = isTerminal(state);

  el.section.dataset.state = state;

  el.run.disabled = running;
  el.run.setAttribute('aria-busy', running ? 'true' : 'false');
  el.run.textContent = running ? t('common.executing') : t('common.run');

  el.cancel.hidden = !running;
  el.cancel.disabled = state === DemoState.CANCELLING;

  el.retry.hidden = !terminal;

  el.statusText.textContent = t(`states.${state}`);
  el.status.setAttribute('aria-busy', running ? 'true' : 'false');
  el.status.dataset.errorCode = errorCode || '';
}

/** Render the live attempt chain (shown while an execution is in flight). */
function renderLiveChain(adapter) {
  const ol = adapter.el.liveChain;
  ol.textContent = '';
  ol.hidden = adapter.chain.length === 0;
  for (const entry of adapter.chain) {
    const li = document.createElement('li');
    li.textContent = `${t(`result.attemptKind.${entry.kind}`)}: ${t(`result.attemptOutcome.${entry.status}`)}`;
    ol.appendChild(li);
  }
}

/** Append the authoritative attempt chain (from diagnostics.attempts). */
function appendChain(area, attempts) {
  const list = document.createElement('ol');
  list.className = 'attempt-chain';
  for (const attempt of attempts) {
    const li = document.createElement('li');
    const duration = attempt.durationMs === null ? '' : ` (${attempt.durationMs.toFixed(1)} ms)`;
    let text = `${t('result.attempt')} ${attempt.index} — ${t(`result.attemptKind.${attempt.kind}`)} — ${t(`result.attemptOutcome.${attempt.outcome}`)}${duration}`;
    if (attempt.errorCode) text += ` [${attempt.errorCode}]`;
    li.textContent = text;
    list.appendChild(li);
  }
  area.appendChild(list);
}

/**
 * Render a completed run into the result area. `summarizeDiagnostics()` runs a
 * runtime schema check — malformed/missing diagnostics render as "unknown"
 * instead of crashing.
 */
function renderResult(adapter, result) {
  const area = adapter.el.result;
  area.hidden = false;
  area.textContent = '';
  area.dataset.state = adapter.state.state;

  if (adapter.state.state === DemoState.CANCELLED) {
    renderCancelledPanel(area, result);
    return;
  }

  if (result && result.success) {
    const heading = document.createElement('h3');
    heading.textContent = t('result.succeededTitle');
    area.appendChild(heading);
    renderSuccessPanel(area, result);
    if (adapter.onSuccess) {
      adapter.onSuccess(area, result);
    } else {
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify(result.result, null, 2);
      area.appendChild(pre);
    }
    return;
  }

  renderErrorPanel(area, result ? result.error : { code: 'unknown', message: '' }, result ? result.diagnostics : null);
}

function renderSuccessPanel(area, result) {
  const diagnostics = summarizeDiagnostics(result.diagnostics);

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  if (diagnostics) {
    const route = diagnostics.finalRoute || 'browser';
    const routeBadge = document.createElement('span');
    routeBadge.className = `badge route-${route}`;
    routeBadge.textContent = `${t('result.finalRoute')}: ${t(`result.route.${route}`)}`;
    meta.appendChild(routeBadge);

    const cacheBadge = document.createElement('span');
    cacheBadge.className = `badge cache-${diagnostics.manifestCache}`;
    cacheBadge.textContent = t(`result.cache.${diagnostics.manifestCache}`);
    meta.appendChild(cacheBadge);

    const duration = document.createElement('span');
    duration.className = 'badge';
    duration.textContent = `${t('result.duration')}: ${diagnostics.totalDurationMs.toFixed(1)} ms`;
    meta.appendChild(duration);
  }
  area.appendChild(meta);

  if (diagnostics && diagnostics.attempts.length > 0) {
    const attemptsHeading = document.createElement('p');
    attemptsHeading.textContent = t('result.attemptsHeading');
    area.appendChild(attemptsHeading);
    appendChain(area, diagnostics.attempts);
  } else {
    const note = document.createElement('p');
    note.className = 'diagnostics-note';
    note.textContent = t('result.diagnosticsUnknown');
    area.appendChild(note);
  }
}

/**
 * Error panel. The category badge is derived from the stable error CODE via
 * classifyError() — never from parsing message strings. Each category has its
 * own copy hint (input/function/runtime/server/network/cancelled/unknown).
 */
function renderErrorPanel(area, error, diagnostics) {
  const category = classifyError(error ? error.code : undefined);

  const heading = document.createElement('h3');
  heading.textContent = t('result.failedTitle');
  area.appendChild(heading);

  const badge = document.createElement('span');
  badge.className = `badge error-category ${category}`;
  badge.textContent = t(`errorCategories.${category}`);
  area.appendChild(badge);

  if (error && error.code) {
    const codeBadge = document.createElement('span');
    codeBadge.className = 'badge code';
    codeBadge.textContent = `${t('result.code')}: ${error.code}`;
    area.appendChild(codeBadge);
  }

  const hint = document.createElement('p');
  hint.className = 'error-hint';
  hint.textContent = t(`result.${category}Hint`);
  area.appendChild(hint);

  if (error && error.message) {
    const msg = document.createElement('pre');
    msg.textContent = error.message;
    area.appendChild(msg);
  }

  const summary = summarizeDiagnostics(diagnostics);
  if (summary && summary.attempts.length > 0) {
    const attemptsHeading = document.createElement('p');
    attemptsHeading.textContent = t('result.attemptsHeading');
    area.appendChild(attemptsHeading);
    appendChain(area, summary.attempts);
  } else {
    const note = document.createElement('p');
    note.className = 'diagnostics-note';
    note.textContent = t('result.diagnosticsUnknown');
    area.appendChild(note);
  }
}

function renderCancelledPanel(area, result) {
  const heading = document.createElement('h3');
  heading.textContent = t('result.cancelledTitle');
  area.appendChild(heading);

  const badge = document.createElement('span');
  badge.className = 'badge error-category cancelled';
  badge.textContent = t('errorCategories.cancelled');
  area.appendChild(badge);

  const hint = document.createElement('p');
  hint.className = 'error-hint';
  hint.textContent = t('result.cancelledHint');
  area.appendChild(hint);

  const summary = summarizeDiagnostics(result ? result.diagnostics : null);
  if (summary && summary.attempts.length > 0) {
    appendChain(area, summary.attempts);
  }
}

// ============================================================
// Field error rendering (per-field aria-invalid / aria-describedby)
// ============================================================

function renderFieldErrors(adapter, errors) {
  for (const error of errors) {
    const cfg = adapter.fields[error.field];
    if (!cfg) continue;
    const input = document.getElementById(cfg.inputId);
    const errorEl = document.getElementById(cfg.errorId);
    input.setAttribute('aria-invalid', 'true');
    input.setAttribute('aria-describedby', cfg.errorId);
    errorEl.textContent = t(error.messageKey, error.params);
    errorEl.hidden = false;
  }
}

function clearFieldErrors(adapter) {
  for (const cfg of Object.values(adapter.fields)) {
    const input = document.getElementById(cfg.inputId);
    const errorEl = document.getElementById(cfg.errorId);
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    errorEl.textContent = '';
    errorEl.hidden = true;
  }
}

/** Move focus to the first field that failed validation. */
function focusField(adapter, fieldName) {
  const cfg = adapter.fields[fieldName];
  if (cfg) document.getElementById(cfg.inputId).focus();
}

// ============================================================
// The shared execute pipeline (used by every demo)
// ============================================================

async function runDemo(adapter) {
  // Busy guard: a running/cancelling demo cannot be double-submitted.
  if (!canSubmit(adapter.state.state)) return;
  const runId = adapter.runId + 1;
  adapter.runId = runId;
  clearFieldErrors(adapter);

  adapter.state = reduceDemoState(adapter.state, { type: 'SUBMIT' });
  applyState(adapter);
  // The previous outcome is stale now — hide it until this run produces one.
  adapter.el.result.hidden = true;

  // --- Validation phase (state: validating) ---
  const inputs = adapter.readInputs();
  const validation = adapter.validate(inputs);
  if (!validation.ok) {
    adapter.state = reduceDemoState(adapter.state, { type: 'VALIDATION_FAILED', errorCode: 'input_error' });
    renderFieldErrors(adapter, validation.errors);
    applyState(adapter);
    adapter.lastResult = { success: false, error: { code: 'input_error', message: '' }, diagnostics: null };
    renderResult(adapter, adapter.lastResult);
    recordOutcome({ type: 'OUTCOME', kind: StatKind.INPUT_ERROR, diagnostics: null });
    focusField(adapter, validation.errors[0].field);
    return;
  }

  // --- Execution phase (state: preparing) ---
  adapter.lastInputs = inputs;
  adapter.state = reduceDemoState(adapter.state, { type: 'VALIDATED' });
  adapter.chain = [];
  const controller = new AbortController();
  adapter.controller = controller;
  applyState(adapter);

  // SDK events drive the state machine. Only the event TYPE is mapped to UI
  // state (demo-state.eventToState) — no message-string parsing.
  const onEvent = (event) => {
    if (adapter.runId !== runId) return;
    adapter.state = reduceDemoState(adapter.state, {
      type: 'SDK_EVENT',
      eventType: event.type,
      errorCode: event.type === 'failed' ? event.errorCode : undefined,
    });
    pushChainEvent(adapter, event);
    applyState(adapter);
  };

  let result;
  try {
    // Per-demo AbortSignal: the cancel button aborts this controller. The SDK
    // guarantees a user cancel surfaces as error.code === 'cancelled' and
    // never triggers a server fallback (issue #105) — the UI just reflects it.
    result = await client.executeWithDiagnostics({
      name: adapter.functionName,
      args: validation.args,
      signal: controller.signal,
      onEvent,
    });
  } catch (error) {
    // executeWithDiagnostics never throws; this is a defensive guard.
    result = { success: false, error: { code: 'unknown', message: String(error) }, diagnostics: null };
  }
  adapter.controller = null;

  // A reset/newer run superseded this one — discard everything.
  if (adapter.runId !== runId) return;

  // If a malformed SDK omitted the terminal event, force a failure state.
  if (!isTerminal(adapter.state.state)) {
    adapter.state = reduceDemoState(adapter.state, { type: 'SDK_EVENT', eventType: 'failed' });
  }

  adapter.chain = [];
  renderLiveChain(adapter);

  // --- Statistics (counted separately per outcome, never conflated) ---
  if (result.success) {
    const kind = result.diagnostics && result.diagnostics.fallbackUsed
      ? StatKind.FALLBACK_SUCCESS
      : StatKind.BROWSER_SUCCESS;
    recordOutcome({ type: 'OUTCOME', kind, diagnostics: result.diagnostics });
  } else {
    const code = result.error ? result.error.code : 'unknown';
    recordOutcome({ type: 'OUTCOME', kind: statKindForError(code), diagnostics: result.diagnostics });
  }

  adapter.lastResult = result;
  renderResult(adapter, result);
  applyState(adapter);
  focusResult(adapter);
}

/** Send the AbortSignal for a running demo (SDK events drive the rest). */
function cancelDemo(adapter) {
  if (!isRunning(adapter.state.state)) return;
  if (adapter.controller) adapter.controller.abort();
}

/** Move focus to the result panel after a run reaches a terminal state. */
function focusResult(adapter) {
  adapter.el.result.setAttribute('tabindex', '-1');
  adapter.el.result.focus({ preventScroll: true });
}

/** Track the live attempt chain from SDK events (shown while running). */
function pushChainEvent(adapter, event) {
  const chain = adapter.chain;
  switch (event.type) {
    case 'browser-execution-started':
      chain.push({ kind: 'browser', status: 'running' });
      break;
    case 'browser-execution-failed': {
      const last = chain[chain.length - 1];
      if (last && last.kind === 'browser') last.status = 'failed';
      break;
    }
    case 'server-execution-started':
      chain.push({ kind: 'server', status: 'running' });
      break;
    case 'completed': {
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        if (chain[i].status === 'running') {
          chain[i].status = 'succeeded';
          break;
        }
      }
      break;
    }
    case 'cancelled':
      for (const entry of chain) {
        if (entry.status === 'running') entry.status = 'cancelled';
      }
      break;
    default:
      break;
  }
  renderLiveChain(adapter);
}

// ============================================================
// Init / reset
// ============================================================

function initDemo(adapter) {
  const section = document.getElementById(adapter.sectionId);
  const status = document.getElementById(`${adapter.base}-status`);
  adapter.el = {
    section,
    form: section.querySelector('form'),
    run: document.getElementById(`${adapter.base}-run`),
    cancel: document.getElementById(`${adapter.base}-cancel`),
    retry: document.getElementById(`${adapter.base}-retry`),
    status,
    statusText: status.querySelector('.status-text'),
    liveChain: status.querySelector('.live-chain'),
    result: document.getElementById(`${adapter.base}-result`),
  };
  adapter.state = createDemoState();
  adapter.runId = 0;
  adapter.controller = null;
  adapter.chain = [];
  adapter.lastInputs = null;
  adapter.lastResult = null;

  adapter.el.form.addEventListener('submit', (event) => {
    event.preventDefault();
    runDemo(adapter);
  });
  adapter.el.cancel.addEventListener('click', () => cancelDemo(adapter));
  adapter.el.retry.addEventListener('click', () => runDemo(adapter));

  // A field's own error clears as soon as the user edits it.
  for (const cfg of Object.values(adapter.fields)) {
    const input = document.getElementById(cfg.inputId);
    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      const errorEl = document.getElementById(cfg.errorId);
      errorEl.textContent = '';
      errorEl.hidden = true;
    });
  }

  applyState(adapter);
}

/** Reset one demo to idle; aborts any in-flight run (discarded via runId). */
function resetDemo(adapter) {
  adapter.runId += 1;
  if (adapter.controller) adapter.controller.abort();
  adapter.controller = null;
  adapter.chain = [];
  adapter.lastInputs = null;
  adapter.lastResult = null;
  adapter.state = createDemoState();
  clearFieldErrors(adapter);
  const area = adapter.el.result;
  area.hidden = true;
  area.textContent = '';
  applyState(adapter);
}

/** Global reset: all demos to idle and the session statistics cleared. */
function resetAll() {
  for (const adapter of demos) resetDemo(adapter);
  stats = createStats();
  renderStats();
}

/** Load fictional sample values into the Form Validation demo. */
function loadFormSamples() {
  document.getElementById('form-email').value = 'user@example.com';
  document.getElementById('form-card').value = '4111 1111 1111 1111';
  document.getElementById('form-phone').value = '+1-555-123-4567';
  document.getElementById('form-password').value = 'MyP@ssw0rd!23';
  clearFieldErrors(demos.find((d) => d.base === 'form'));
}

// ============================================================
// Boot
// ============================================================

const demos = buildDemos();

function init() {
  applyStaticI18n();

  for (const adapter of demos) initDemo(adapter);

  document.getElementById('reset-all').addEventListener('click', resetAll);

  const formSample = document.getElementById('form-sample');
  if (formSample) formSample.addEventListener('click', loadFormSamples);

  document.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => setLanguage(btn.getAttribute('data-lang')));
  });

  renderStats();
}

init();
