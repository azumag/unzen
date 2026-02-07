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

// Initialize client
// endpoint: base URL of the Unzen server middleware mount point
// mode: 'production' enables browser-first with server fallback
const client = new UnzenClient({
  endpoint: 'http://localhost:3000/unzen',
  mode: 'production',
});

console.log('✅ UnzenClient initialized');

/**
 * Safely set text content to prevent XSS
 * Uses textContent instead of innerHTML for user-generated content
 */
function escapeAndDisplay(element, text) {
  const pre = document.createElement('pre');
  pre.textContent = text;
  return pre;
}

/**
 * Display execution result
 * Uses DOM API instead of innerHTML to prevent XSS
 */
function displayResult(elementId, result, isError) {
  const element = document.getElementById(elementId);
  element.innerHTML = '';

  // Update statistics
  if (!isError) {
    stats.browserExecs++;
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

  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(isError ? result : result, null, 2);
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
  document.getElementById('cacheHits').textContent = stats.errors;

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

console.log('✅ Demo ready! Try the examples above.');
