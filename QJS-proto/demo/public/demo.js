/**
 * QJS-proto E2E Demo - Client Side
 *
 * Demonstrates usage of @unzen/client for browser-side function execution
 */

import { UnzenClient } from '/client.js';

// Statistics tracking
const stats = {
  browserExecs: 0,
  serverExecs: 0,
  cacheHits: 0,
  totalTime: 0,
  execCount: 0,
};

// Initialize client
const client = new UnzenClient({
  baseUrl: 'http://localhost:3000/unzen',
});

// Initialize the client
await client.initialize();
console.log('✅ UnzenClient initialized');

/**
 * Display execution result with metadata
 */
function displayResult(elementId, result) {
  const element = document.getElementById(elementId);

  // Update statistics
  if (result.executedOn === 'browser') {
    stats.browserExecs++;
  } else {
    stats.serverExecs++;
  }

  if (result.cached) {
    stats.cacheHits++;
  }

  stats.totalTime += result.durationMs;
  stats.execCount++;

  updateStats();

  // Display result
  const isError = result.error !== undefined;
  element.innerHTML = `
    <div class="result ${isError ? 'error' : ''}">
      <h3>${isError ? '❌ Error' : '✅ Result'}</h3>
      <pre>${JSON.stringify(isError ? result.error : result.value, null, 2)}</pre>
      <div class="metadata">
        <span class="badge ${result.executedOn}">${result.executedOn === 'browser' ? '🌐 Browser' : '🖥️ Server'}</span>
        <span class="badge">${result.runtime}</span>
        ${result.cached ? '<span class="badge cached">💾 Cached</span>' : ''}
        <span>⏱️ ${result.durationMs.toFixed(2)}ms</span>
      </div>
    </div>
  `;
}

/**
 * Update statistics display
 */
function updateStats() {
  document.getElementById('browserExecs').textContent = stats.browserExecs;
  document.getElementById('serverExecs').textContent = stats.serverExecs;
  document.getElementById('cacheHits').textContent = stats.cacheHits;

  const avgTime = stats.execCount > 0 ? stats.totalTime / stats.execCount : 0;
  document.getElementById('avgTime').textContent = avgTime.toFixed(2) + 'ms';
}

/**
 * Demo 1: Spam Check
 */
window.checkSpam = async function() {
  const text = document.getElementById('spamText').value;

  try {
    const result = await client.execute('spamCheck', [text], {
      diagnostics: true,
    });

    displayResult('spamResult', result);
  } catch (error) {
    document.getElementById('spamResult').innerHTML = `
      <div class="result error">
        <h3>❌ Error</h3>
        <pre>${error.message}</pre>
      </div>
    `;
  }
};

/**
 * Demo 2: Multiply Numbers
 */
window.multiplyNumbers = async function() {
  const num1 = parseFloat(document.getElementById('num1').value);
  const num2 = parseFloat(document.getElementById('num2').value);

  if (isNaN(num1) || isNaN(num2)) {
    document.getElementById('multiplyResult').innerHTML = `
      <div class="result error">
        <h3>❌ Error</h3>
        <pre>Please enter valid numbers</pre>
      </div>
    `;
    return;
  }

  try {
    const result = await client.execute('multiply', [num1, num2], {
      diagnostics: true,
    });

    displayResult('multiplyResult', result);
  } catch (error) {
    document.getElementById('multiplyResult').innerHTML = `
      <div class="result error">
        <h3>❌ Error</h3>
        <pre>${error.message}</pre>
      </div>
    `;
  }
};

/**
 * Demo 3: Double Array
 */
window.doubleArray = async function() {
  const input = document.getElementById('arrayInput').value;
  const arr = input.split(',').map(x => parseFloat(x.trim())).filter(x => !isNaN(x));

  if (arr.length === 0) {
    document.getElementById('arrayResult').innerHTML = `
      <div class="result error">
        <h3>❌ Error</h3>
        <pre>Please enter valid numbers separated by commas</pre>
      </div>
    `;
    return;
  }

  try {
    const result = await client.execute('doubleArray', [arr], {
      diagnostics: true,
    });

    displayResult('arrayResult', result);
  } catch (error) {
    document.getElementById('arrayResult').innerHTML = `
      <div class="result error">
        <h3>❌ Error</h3>
        <pre>${error.message}</pre>
      </div>
    `;
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
    document.getElementById('userResult').innerHTML = `
      <div class="result error">
        <h3>❌ Error</h3>
        <pre>Please fill in all fields with valid data</pre>
      </div>
    `;
    return;
  }

  try {
    const result = await client.execute('getUserInfo', [{ firstName, lastName, age }], {
      diagnostics: true,
    });

    displayResult('userResult', result);
  } catch (error) {
    document.getElementById('userResult').innerHTML = `
      <div class="result error">
        <h3>❌ Error</h3>
        <pre>${error.message}</pre>
      </div>
    `;
  }
};

console.log('✅ Demo ready! Try the examples above.');
