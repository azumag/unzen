/**
 * unzen core E2E Demo - Client Side
 *
 * Demonstrates usage of @unzen/client for browser-side function execution.
 * Uses UnzenClient.call() for execution and callWithDiagnostics() for
 * diagnostic information display.
 */

import { UnzenClient } from '/client.js';

// Statistics tracking for diagnostics display
const stats = {
  browserExecs: 0,
  serverExecs: 0,
  cacheHits: 0,
  execCount: 0,
  totalDurationMs: 0,
};

// Initialize client with QuickJS Wasm worker for browser-side sandbox execution.
// workerUrl points to the self-contained worker bundle served by the demo server.
// When workerUrl is provided, functions execute in a Web Worker running QuickJS Wasm
// with 4-layer isolation (Web Worker + Wasm + QuickJS + API restrictions).
const client = new UnzenClient({
  endpoint: 'http://localhost:3000/unzen',
  mode: 'production',
  workerUrl: '/worker.js',
});

console.log('✅ UnzenClient initialized');

/**
 * Display execution result with diagnostics information.
 * Shows where the function ran, how long it took, and cache status.
 * Uses DOM API instead of innerHTML to prevent XSS.
 *
 * @param elementId - DOM element ID to render into
 * @param result - Execution result or error
 * @param isError - Whether result is an error
 * @param diagnostics - Optional diagnostics info { executedOn, durationMs, cached }
 */
function displayResult(elementId, result, isError, diagnostics) {
  const element = document.getElementById(elementId);
  element.innerHTML = '';

  // Update statistics using diagnostics if available
  if (!isError) {
    if (diagnostics?.executedOn === 'server') {
      stats.serverExecs++;
    } else {
      stats.browserExecs++;
    }
    // Track cache hits from diagnostics
    if (diagnostics?.cached) {
      stats.cacheHits++;
    }
    // Track total duration for average calculation
    if (diagnostics?.durationMs != null) {
      stats.totalDurationMs += diagnostics.durationMs;
    }
  }
  stats.execCount++;
  updateStats();

  // Build result display using DOM API (XSS-safe)
  const resultDiv = document.createElement('div');
  resultDiv.className = `result ${isError ? 'error' : ''}`;

  const h3 = document.createElement('h3');
  h3.textContent = isError ? '❌ Error' : '✅ Result';
  resultDiv.appendChild(h3);

  // Execution location badge with timing (browser = blue, server = orange)
  if (!isError && diagnostics) {
    const badge = document.createElement('span');
    const isBrowser = diagnostics.executedOn !== 'server';
    badge.className = `badge ${isBrowser ? 'browser' : 'server'}`;
    const label = isBrowser ? 'Browser (QuickJS Wasm)' : 'Server';
    const timing = diagnostics.durationMs.toFixed(1);
    const cacheLabel = diagnostics.cached ? ' | cached' : '';
    badge.textContent = `${label} | ${timing}ms${cacheLabel}`;
    resultDiv.appendChild(badge);
  }

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(result, null, 2);
  resultDiv.appendChild(pre);

  element.appendChild(resultDiv);
}

/**
 * Display error message (XSS-safe)
 */
function displayError(elementId, message) {
  const element = document.getElementById(elementId);
  element.innerHTML = '';

  const resultDiv = document.createElement('div');
  resultDiv.className = 'result error';

  const h3 = document.createElement('h3');
  h3.textContent = '❌ Error';
  resultDiv.appendChild(h3);

  const pre = document.createElement('pre');
  pre.textContent = message;
  resultDiv.appendChild(pre);

  element.appendChild(resultDiv);
}

/**
 * Update statistics display with diagnostics data
 */
function updateStats() {
  document.getElementById('browserExecs').textContent = stats.browserExecs;
  document.getElementById('serverExecs').textContent = stats.serverExecs;
  document.getElementById('cacheHits').textContent = stats.cacheHits;

  // Show average execution time from diagnostics
  const avgTime = stats.execCount > 0
    ? (stats.totalDurationMs / stats.execCount).toFixed(1)
    : '0';
  document.getElementById('avgTime').textContent = avgTime + ' ms';
}

/**
 * Helper: Execute function with diagnostics and display result.
 * Uses callWithDiagnostics() to get execution location, timing, and cache info.
 *
 * @param elementId - DOM element ID to render result into
 * @param name - Function name to call
 * @param args - Arguments to pass to the function
 */
async function execWithDiagnostics(elementId, name, ...args) {
  const result = await client.callWithDiagnostics(name, ...args);
  if (result.success) {
    displayResult(elementId, result.result, false, result.diagnostics);
  } else {
    displayError(elementId, result.error.message);
  }
}

/**
 * Demo 1: Spam Check
 * Uses callWithDiagnostics() to get execution diagnostics
 */
window.checkSpam = async function() {
  const text = document.getElementById('spamText').value;
  await execWithDiagnostics('spamResult', 'spamCheck', text);
};

/**
 * Demo 2: Multiply Numbers
 */
window.multiplyNumbers = async function() {
  const num1 = parseFloat(document.getElementById('num1').value);
  const num2 = parseFloat(document.getElementById('num2').value);

  if (isNaN(num1) || isNaN(num2)) {
    displayError('multiplyResult', 'Please enter valid numbers');
    return;
  }

  await execWithDiagnostics('multiplyResult', 'multiply', num1, num2);
};

/**
 * Demo 3: Double Array
 */
window.doubleArray = async function() {
  const input = document.getElementById('arrayInput').value;
  const arr = input.split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x));

  if (arr.length === 0) {
    displayError('arrayResult', 'Please enter valid numbers separated by commas');
    return;
  }

  await execWithDiagnostics('arrayResult', 'doubleArray', arr);
};

/**
 * Demo 4: Transform User
 */
window.transformUser = async function() {
  const firstName = document.getElementById('firstName').value;
  const lastName = document.getElementById('lastName').value;
  const age = parseInt(document.getElementById('age').value);

  if (!firstName || !lastName || isNaN(age)) {
    displayError('userResult', 'Please fill in all fields with valid data');
    return;
  }

  await execWithDiagnostics('userResult', 'getUserInfo', { firstName, lastName, age });
};

// ============================================================
// Practical Server-Side Delegation Demos
// ============================================================

/**
 * Demo 5: Form Validation
 * Tamper-proof validation in QuickJS sandbox (email, credit card, phone, password)
 */
window.validateForm = async function() {
  const fields = {};
  const email = document.getElementById('validateEmail').value;
  const card = document.getElementById('validateCard').value;
  const phone = document.getElementById('validatePhone').value;
  const password = document.getElementById('validatePassword').value;

  if (email) fields.email = email;
  if (card) fields.creditCard = card;
  if (phone) fields.phone = phone;
  if (password) fields.password = password;

  await execWithDiagnostics('formResult', 'formValidate', fields);
};

/**
 * Demo 6: Price Calculator
 * Tamper-proof price computation with tax, discount, and shipping
 */
window.calculatePrice = async function() {
  try {
    const items = JSON.parse(document.getElementById('priceItems').value);
    const region = document.getElementById('priceRegion').value;
    const discountStr = document.getElementById('priceDiscount').value.trim();
    const order = { items, region };
    if (discountStr) {
      order.discount = JSON.parse(discountStr);
    }
    await execWithDiagnostics('priceResult', 'calculatePrice', order);
  } catch (error) {
    displayError('priceResult', error.message);
  }
};

/**
 * Demo 7: Markdown to HTML
 * Offload SSR Markdown rendering to client sandbox
 */
window.convertMarkdown = async function() {
  const markdown = document.getElementById('markdownInput').value;

  const diagResult = await client.callWithDiagnostics('markdownToHtml', markdown);
  if (diagResult.success) {
    displayResult('markdownResult', diagResult.result, false, diagResult.diagnostics);
    // Defense in depth: render HTML in sandboxed iframe instead of innerHTML.
    // The sandbox="" attribute blocks all scripts, forms, popups, navigation.
    // Even if the markdown parser has a sanitization bug, scripts cannot execute.
    const preview = document.getElementById('markdownPreview');
    preview.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.sandbox = '';
    iframe.srcdoc = diagResult.result;
    iframe.style.cssText = 'width:100%;border:1px solid #ddd;border-radius:4px;min-height:100px;';
    preview.appendChild(iframe);
    preview.style.display = 'block';
  } else {
    displayError('markdownResult', diagResult.error.message);
  }
};

/**
 * Demo 8: Text Statistics
 * Pure computation: word count, readability scoring, Flesch-Kincaid grade
 */
window.analyzeText = async function() {
  const text = document.getElementById('textInput').value;
  await execWithDiagnostics('textResult', 'textStats', text);
};

console.log('✅ Demo ready! Try the examples above.');
