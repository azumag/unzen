/**
 * QJS-proto E2E Demo - Client Side
 *
 * Demonstrates usage of @unzen/client for browser-side function execution.
 * Uses UnzenClient.call() for execution and callWithDiagnostics() for
 * diagnostic information display.
 */

import { UnzenClient } from '/client.js';

// Statistics tracking
const stats = {
  browserExecs: 0,
  serverExecs: 0,
  errors: 0,
  execCount: 0,
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
 * Display execution result with execution location indicator.
 * Shows whether the function ran in the browser (QuickJS Wasm) or on the server.
 * Uses DOM API instead of innerHTML to prevent XSS.
 *
 * @param elementId - DOM element ID to render into
 * @param result - Execution result or error
 * @param isError - Whether result is an error
 * @param executedOn - 'browser' or 'server' (defaults to 'browser' for successful calls)
 */
function displayResult(elementId, result, isError, executedOn) {
  const element = document.getElementById(elementId);
  element.innerHTML = '';

  // Update statistics
  if (!isError) {
    if (executedOn === 'server') {
      stats.serverExecs++;
    } else {
      stats.browserExecs++;
    }
  } else {
    stats.errors++;
  }
  stats.execCount++;
  updateStats();

  // Build result display using DOM API (XSS-safe)
  const resultDiv = document.createElement('div');
  resultDiv.className = `result ${isError ? 'error' : ''}`;

  const h3 = document.createElement('h3');
  h3.textContent = isError ? '❌ Error' : '✅ Result';
  resultDiv.appendChild(h3);

  // Execution location badge (browser = blue, server = orange)
  if (!isError) {
    const badge = document.createElement('span');
    badge.className = `badge ${executedOn === 'server' ? 'server' : 'browser'}`;
    badge.textContent = executedOn === 'server' ? 'Server' : 'Browser (QuickJS Wasm)';
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
 * Update statistics display
 */
function updateStats() {
  document.getElementById('browserExecs').textContent = stats.browserExecs;
  document.getElementById('serverExecs').textContent = stats.serverExecs;
  document.getElementById('cacheHits').textContent = stats.errors; // "cacheHits" repurposed as error count in Phase 2

  const avgTime = stats.execCount > 0 ? (stats.execCount) : 0;
  document.getElementById('avgTime').textContent = avgTime + ' calls';
}

/**
 * Demo 1: Spam Check
 * Uses callWithDiagnostics() to get success/error info without throwing
 */
window.checkSpam = async function() {
  const text = document.getElementById('spamText').value;

  try {
    const result = await client.call('spamCheck', text);
    displayResult('spamResult', result, false);
  } catch (error) {
    displayError('spamResult', error.message);
  }
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

  try {
    const result = await client.call('multiply', num1, num2);
    displayResult('multiplyResult', result, false);
  } catch (error) {
    displayError('multiplyResult', error.message);
  }
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

  try {
    const result = await client.call('doubleArray', arr);
    displayResult('arrayResult', result, false);
  } catch (error) {
    displayError('arrayResult', error.message);
  }
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

  try {
    const result = await client.call('getUserInfo', { firstName, lastName, age });
    displayResult('userResult', result, false);
  } catch (error) {
    displayError('userResult', error.message);
  }
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

  try {
    const result = await client.call('formValidate', fields);
    displayResult('formResult', result, false);
  } catch (error) {
    displayError('formResult', error.message);
  }
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
    const result = await client.call('calculatePrice', order);
    displayResult('priceResult', result, false);
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

  try {
    const result = await client.call('markdownToHtml', markdown);
    displayResult('markdownResult', result, false);
    // Defense in depth: render HTML in sandboxed iframe instead of innerHTML.
    // The sandbox="" attribute blocks all scripts, forms, popups, navigation.
    // Even if the markdown parser has a sanitization bug, scripts cannot execute.
    const preview = document.getElementById('markdownPreview');
    preview.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.sandbox = '';
    iframe.srcdoc = result;
    iframe.style.cssText = 'width:100%;border:1px solid #ddd;border-radius:4px;min-height:100px;';
    preview.appendChild(iframe);
    preview.style.display = 'block';
  } catch (error) {
    displayError('markdownResult', error.message);
  }
};

/**
 * Demo 8: Text Statistics
 * Pure computation: word count, readability scoring, Flesch-Kincaid grade
 */
window.analyzeText = async function() {
  const text = document.getElementById('textInput').value;

  try {
    const result = await client.call('textStats', text);
    displayResult('textResult', result, false);
  } catch (error) {
    displayError('textResult', error.message);
  }
};

console.log('✅ Demo ready! Try the examples above.');
