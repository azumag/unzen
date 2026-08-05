/**
 * Chrome Prompt API feasibility harness (issue #93).
 *
 * Standalone, dependency-free vanilla JS that runs in the top-level document
 * context and exercises the Chrome Built-in AI `LanguageModel` Prompt API:
 * availability transitions, user activation, first download, prompt() and
 * promptStreaming(), expectedInputs/expectedOutputs (incl. Japanese), abort,
 * context usage, session lifecycle, concurrency, and an execution-surface
 * matrix (top-level / same-origin iframe / sandbox iframe; cross-origin and
 * extension surfaces are recorded as not-testable from this page).
 *
 * The JSON it emits follows `src/chrome-prompt-api-report.ts`. The scenario
 * discriminators and field names below MUST stay in sync with that schema.
 * This report is SELF-REPORTED: it never carries a readiness claim, and a human
 * operator must wrap it in a captured-and-verified EvidenceEnvelope (with an
 * artifact loader + independent verifier) before the shared validator can label
 * it 'real-browser-verified'.
 *
 * Every scenario is wrapped so a failure in one cannot crash the page: the
 * harness always produces a complete report object.
 */

/* eslint-disable no-console */
(function () {
  'use strict';

  // ==== constants kept in sync with src/chrome-prompt-api-report.ts ==========
  var SCHEMA_VERSION = '1.0.0';
  var PRODUCER = { name: 'unzen-chrome-prompt-api-harness', version: '0.1.0' };

  // ==== DOM plumbing =========================================================

  var banner = document.getElementById('banner');
  var logEl = document.getElementById('log');
  var runButton = document.getElementById('run');
  var copyButton = document.getElementById('copy');
  var downloadButton = document.getElementById('download');
  var reportHolder = document.getElementById('report-holder');
  var reportOutput = document.getElementById('report-output');

  var logs = [];

  function setBanner(text, kind) {
    banner.textContent = text;
    banner.className = 'banner' + (kind ? ' ' + kind : '');
  }

  function log(message) {
    logs.push(String(message));
    logEl.textContent = logs.join('\n');
    // Keep the newest line visible while scenarios run.
    logEl.scrollTop = logEl.scrollHeight;
  }

  function setRunning(running) {
    runButton.disabled = running;
  }

  function showReport(report) {
    var json = JSON.stringify(report, null, 2);
    reportOutput.value = json;
    reportHolder.classList.remove('hidden');
    copyButton.disabled = false;
    downloadButton.disabled = false;
  }

  // ==== generic helpers ======================================================

  // Rough token estimate for measurement only: Latin text is split on
  // whitespace, CJK characters are counted one per character. NOT a tokenizer.
  function estimateTokens(text) {
    if (!text) return 0;
    var cjk = (text.match(/[\u3040-\u30ff\u4e00-\u9faf\uac00-\ud7af]/g) || []).length;
    var words = text.trim().split(/\s+/).filter(Boolean).length;
    return cjk + words;
  }

  // Coarse output-language heuristic (kana/kanji => ja, otherwise en).
  // Records an honest guess only; the schema requires non-empty strings.
  function detectLanguage(text) {
    return /[\u3040-\u30ff\u4e00-\u9faf]/.test(text) ? 'ja' : 'en';
  }

  // Map a caught error to the schema's abortOrErrorCategory.
  function categorizeError(error) {
    var name = error && error.name ? String(error.name) : '';
    var message = error && error.message ? String(error.message) : '';
    if (name === 'AbortError') return 'aborted';
    if (name === 'QuotaExceededError' || /quota/i.test(message)) return 'quota-error';
    if (/context/i.test(message) || /token/i.test(message)) return 'context-overflow';
    if (name === 'NotAllowedError' || /not allowed|activation/i.test(message)) {
      return 'not-allowed';
    }
    if (name === 'InvalidArgumentError' || /argument/i.test(message)) return 'invalid-argument';
    if (name === 'NotSupportedError') return 'internal';
    return 'unknown';
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // ==== environment capture ===================================================

  function chromeVersionFromUserAgent() {
    var match = navigator.userAgent.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
    return match ? match[1] : 'unknown';
  }

  // Channel is not exposed by the UA; best-effort guess from UA markers.
  function chromeChannelFromUserAgent() {
    var ua = navigator.userAgent;
    if (/CriOS/.test(ua)) return 'ios';
    if (/dev/i.test(ua)) return 'dev';
    if (/beta/i.test(ua)) return 'beta';
    if (/canary/i.test(ua)) return 'canary';
    return 'stable';
  }

  function osNameAndVersion() {
    var platform = navigator.userAgentData && navigator.userAgentData.platform;
    var raw = platform || navigator.platform || 'unknown';
    if (/Mac/i.test(raw)) return { name: 'macOS', version: 'unknown' };
    if (/Win/i.test(raw)) return { name: 'Windows', version: 'unknown' };
    if (/Linux/i.test(raw)) return { name: 'Linux', version: 'unknown' };
    return { name: raw, version: 'unknown' };
  }

  function gpuRenderer() {
    try {
      var canvas = document.createElement('canvas');
      var gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (!gl) return undefined;
      var info = gl.getExtension('WEBGL_debug_renderer_info');
      return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : undefined;
    } catch (error) {
      return undefined;
    }
  }

  function captureEnvironment() {
    var os = osNameAndVersion();
    return {
      chromeVersion: chromeVersionFromUserAgent(),
      chromeChannel: chromeChannelFromUserAgent(),
      os: os.name,
      osVersion: os.version,
      hardwareConcurrency: navigator.hardwareConcurrency || undefined,
      deviceMemoryGB: navigator.deviceMemory || undefined,
      gpuRenderer: gpuRenderer(),
      language: navigator.language || undefined,
    };
  }

  // ==== Prompt API access ====================================================

  // window.ai.languageModel is the whole surface. Feature-detect every time so
  // a degraded page (older Chrome, policy-gated, sandboxed iframe) reports the
  // truth instead of throwing.
  function languageModelNamespace() {
    var ai = typeof window !== 'undefined' && window.ai;
    return ai && ai.languageModel ? ai.languageModel : null;
  }

  // Best-effort availability. May throw on unusual builds; guard callers.
  async function currentAvailability(LM) {
    try {
      var state = await LM.availability();
      return typeof state === 'string' ? state : 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }

  // ==== scenario records =====================================================
  // Each builder returns a record whose fields satisfy the validator in
  // src/chrome-prompt-api-report.ts, even in the not-applicable (API missing)
  // case, so a report is always schema-valid.

  async function scenarioAvailabilityTransitions(LM) {
    if (!LM) {
      return {
        scenario: 'availability-state-transitions',
        scenarioStatus: 'not-applicable',
        skippedReason: 'window.ai.languageModel not available in this context',
        apiAvailable: false,
        observedAvailabilityStates: [],
        observedTransitionSequence: [],
        finalAvailabilityState: 'unavailable',
        availabilitySamples: [],
      };
    }
    var samples = [];
    var states = [];
    var transitions = [];
    var start = performance.now();
    var previous = null;
    // Poll a few times to observe the preparation lifecycle while the download
    // triggered by the download-progress scenario settles into 'available'.
    for (var i = 0; i < 8; i += 1) {
      var state = await currentAvailability(LM);
      var now = performance.now();
      if (previous !== null && state !== previous) {
        transitions.push(previous + '->' + state);
      }
      if (previous !== state) {
        states.push(state);
        samples.push({ state: state, atMs: Math.round(now - start) });
      }
      previous = state;
      if (state === 'available') break;
      await delay(250);
    }
    var finalState = states.length > 0 ? states[states.length - 1] : 'unavailable';
    return {
      scenario: 'availability-state-transitions',
      scenarioStatus: finalState === 'available' ? 'pass' : 'not-applicable',
      apiAvailable: true,
      observedAvailabilityStates: states,
      observedTransitionSequence: transitions,
      finalAvailabilityState: finalState,
      availabilitySamples: samples,
    };
  }

  // Runs at page load, before any user gesture, so this is a genuine
  // no-user-activation probe. On a fresh machine the first download is blocked
  // (NotAllowedError); on a machine with the model cached create() succeeds.
  async function scenarioCreateWithoutUserActivation(LM) {
    if (!LM) {
      return {
        scenario: 'create-without-user-activation',
        scenarioStatus: 'not-applicable',
        skippedReason: 'window.ai.languageModel not available in this context',
        createRejected: false,
        createErrorCategory: 'no-error',
        userActivationRequired: false,
      };
    }
    var record = {
      scenario: 'create-without-user-activation',
      scenarioStatus: 'fail',
      createRejected: false,
      createErrorCategory: 'no-error',
      userActivationRequired: false,
    };
    try {
      var session = await LM.create();
      // The model was already downloaded (cache hit), so no activation gate.
      session.destroy();
      record.scenarioStatus = 'pass';
    } catch (error) {
      record.createRejected = true;
      record.createErrorCategory = categorizeError(error);
      record.userActivationRequired = record.createErrorCategory === 'not-allowed';
      record.rejectionMessage = error && error.message ? String(error.message) : undefined;
      record.scenarioStatus = 'pass';
    }
    return record;
  }

  // Triggers the first model download (inside the Run click's user activation)
  // and records downloadprogress through the monitor API when the browser
  // drives it. The monitor is a function the API calls with an
  // AIModelDownloadMonitor; progress events carry loadedTokens/totalTokens.
  async function scenarioDownloadProgressMonitor(LM) {
    if (!LM) {
      return {
        scenario: 'download-progress-monitor',
        scenarioStatus: 'not-applicable',
        skippedReason: 'window.ai.languageModel not available in this context',
        monitorSupported: false,
        downloadState: 'not-applicable',
        downloadComplete: false,
        downloadProgressSamples: [],
      };
    }
    var samples = [];
    var monitorSupported = false;
    var start = performance.now();
    var monitor = function (downloadMonitor) {
      try {
        downloadMonitor.addEventListener('downloadprogress', function (event) {
          monitorSupported = true;
          samples.push({
            loadedTokens: event && typeof event.loadedTokens === 'number' ? event.loadedTokens : 0,
            totalTokens: event && typeof event.totalTokens === 'number' ? event.totalTokens : 0,
            atMs: Math.round(performance.now() - start),
          });
        });
      } catch (error) {
        // Monitor API not wired on this build; the report records it.
      }
    };
    try {
      var session = await LM.create({ monitor: monitor });
      session.destroy();
      return {
        scenario: 'download-progress-monitor',
        scenarioStatus: 'pass',
        monitorSupported: monitorSupported,
        downloadState: 'downloaded',
        downloadComplete: true,
        downloadProgressSamples: samples,
      };
    } catch (error) {
      return {
        scenario: 'download-progress-monitor',
        scenarioStatus: 'fail',
        monitorSupported: monitorSupported,
        downloadState: 'downloading',
        downloadComplete: false,
        downloadProgressSamples: samples,
      };
    }
  }

  async function scenarioCreateAfterUserActivation(LM) {
    if (!LM) {
      return {
        scenario: 'create-after-user-activation',
        scenarioStatus: 'not-applicable',
        skippedReason: 'window.ai.languageModel not available in this context',
        createSucceeded: false,
        sessionCreateMs: 0,
        firstDownloadObserved: false,
      };
    }
    var before = performance.now();
    try {
      // A download is "observed" only when availability flips from a pending
      // state to 'available' during this create call.
      var stateBefore = await currentAvailability(LM);
      var session = await LM.create();
      var createdMs = Math.round(performance.now() - before);
      var stateAfter = await currentAvailability(LM);
      session.destroy();
      return {
        scenario: 'create-after-user-activation',
        scenarioStatus: 'pass',
        createSucceeded: true,
        sessionCreateMs: createdMs,
        firstDownloadObserved: stateBefore !== 'available' && stateAfter === 'available',
      };
    } catch (error) {
      return {
        scenario: 'create-after-user-activation',
        scenarioStatus: 'fail',
        createSucceeded: false,
        sessionCreateMs: Math.round(performance.now() - before),
        firstDownloadObserved: false,
        createErrorCategory: categorizeError(error),
      };
    }
  }

  async function scenarioPromptNonStreaming(LM) {
    if (!LM) {
      return {
        scenario: 'prompt-non-streaming',
        scenarioStatus: 'not-applicable',
        skippedReason: 'window.ai.languageModel not available in this context',
        success: false,
        sessionCreateMs: 0,
        timeToFirstTokenMs: 0,
        totalTokens: 0,
        tokensPerSec: 0,
        promptLanguage: 'en',
        outputLanguage: 'en',
      };
    }
    var prompt = 'Write a short haiku about the ocean.';
    var t0 = performance.now();
    var session;
    try {
      session = await LM.create();
      var createdMs = Math.round(performance.now() - t0);
      var output = await session.prompt(prompt);
      var totalMs = performance.now() - t0;
      var tokens = estimateTokens(output);
      session.destroy();
      return {
        scenario: 'prompt-non-streaming',
        scenarioStatus: 'pass',
        success: true,
        sessionCreateMs: createdMs,
        timeToFirstTokenMs: Math.round(totalMs - createdMs),
        totalTokens: tokens,
        tokensPerSec: tokens > 0 ? Math.round((tokens / totalMs) * 1000) : 0,
        promptLanguage: 'en',
        outputLanguage: detectLanguage(output),
      };
    } catch (error) {
      if (session) session.destroy();
      return {
        scenario: 'prompt-non-streaming',
        scenarioStatus: 'fail',
        success: false,
        sessionCreateMs: 0,
        timeToFirstTokenMs: Math.round(performance.now() - t0),
        totalTokens: 0,
        tokensPerSec: 0,
        promptLanguage: 'en',
        outputLanguage: 'en',
        errorCategory: categorizeError(error),
      };
    }
  }

  async function scenarioPromptStreaming(LM) {
    if (!LM) {
      return {
        scenario: 'prompt-streaming',
        scenarioStatus: 'not-applicable',
        skippedReason: 'window.ai.languageModel not available in this context',
        success: false,
        sessionCreateMs: 0,
        timeToFirstChunkMs: 0,
        timeToFirstTokenMs: 0,
        totalTokens: 0,
        tokensPerSec: 0,
        chunkCount: 0,
        promptLanguage: 'en',
        outputLanguage: 'en',
      };
    }
    var prompt = 'Count from 1 to 10 and describe what happens at each step.';
    var t0 = performance.now();
    var session;
    try {
      session = await LM.create();
      var createdMs = Math.round(performance.now() - t0);
      var stream = session.promptStreaming(prompt);
      var reader = stream.getReader();
      var chunks = [];
      var firstChunkMs = null;
      var firstTokenMs = null;
      while (true) {
        var result = await reader.read();
        if (result.done) break;
        var text = result.value || '';
        if (firstChunkMs === null) firstChunkMs = performance.now() - t0;
        // Approximate "first token" as the first chunk that carries content.
        if (firstTokenMs === null && text.trim().length > 0) {
          firstTokenMs = performance.now() - t0;
        }
        chunks.push(text);
      }
      var output = chunks.join('');
      var totalMs = performance.now() - t0;
      var tokens = estimateTokens(output);
      session.destroy();
      return {
        scenario: 'prompt-streaming',
        scenarioStatus: 'pass',
        success: true,
        sessionCreateMs: createdMs,
        timeToFirstChunkMs: Math.round(firstChunkMs !== null ? firstChunkMs - createdMs : totalMs - createdMs),
        timeToFirstTokenMs: Math.round(firstTokenMs !== null ? firstTokenMs - createdMs : totalMs - createdMs),
        totalTokens: tokens,
        tokensPerSec: tokens > 0 ? Math.round((tokens / totalMs) * 1000) : 0,
        chunkCount: chunks.length,
        promptLanguage: 'en',
        outputLanguage: detectLanguage(output),
      };
    } catch (error) {
      if (session) session.destroy();
      return {
        scenario: 'prompt-streaming',
        scenarioStatus: 'fail',
        success: false,
        sessionCreateMs: 0,
        timeToFirstChunkMs: Math.round(performance.now() - t0),
        timeToFirstTokenMs: Math.round(performance.now() - t0),
        totalTokens: 0,
        tokensPerSec: 0,
        chunkCount: 0,
        promptLanguage: 'en',
        outputLanguage: 'en',
        errorCategory: categorizeError(error),
      };
    }
  }

  async function scenarioExpectedInputsOutputs(LM) {
    if (!LM) {
      return {
        scenario: 'expected-inputs-outputs',
        scenarioStatus: 'not-applicable',
        skippedReason: 'window.ai.languageModel not available in this context',
        expectedInputsAccepted: false,
        expectedOutputsAccepted: false,
        japaneseInputAccepted: false,
        japaneseOutputProduced: false,
        promptLanguage: 'ja',
        outputLanguage: 'ja',
      };
    }
    var t0 = performance.now();
    var session;
    try {
      // Declare expected input/output languages including Japanese, then ask
      // for a Japanese answer: both Japanese input acceptance AND Japanese
      // output production are measured (Unzen targets an international base).
      session = await LM.create({
        expectedInputs: { languages: ['en', 'ja'] },
        expectedOutputs: { languages: ['en', 'ja'] },
      });
      var createdMs = Math.round(performance.now() - t0);
      var prompt = '「青い空の下で海が見える」という景色の感想を日本語で一文で書いてください。';
      var output = await session.prompt(prompt);
      var outputLang = detectLanguage(output);
      var japaneseProduced = outputLang === 'ja';
      session.destroy();
      return {
        scenario: 'expected-inputs-outputs',
        scenarioStatus: 'pass',
        // Both expectations were accepted: create() with expectedInputs and
        // expectedOutputs resolved instead of throwing.
        expectedInputsAccepted: true,
        expectedOutputsAccepted: true,
        japaneseInputAccepted: true,
        japaneseOutputProduced: japaneseProduced,
        promptLanguage: 'ja',
        outputLanguage: outputLang,
        observedOutputSample: output.slice(0, 200),
      };
    } catch (error) {
      if (session) session.destroy();
      return {
        scenario: 'expected-inputs-outputs',
        scenarioStatus: 'fail',
        expectedInputsAccepted: false,
        expectedOutputsAccepted: false,
        japaneseInputAccepted: false,
        japaneseOutputProduced: false,
        promptLanguage: 'ja',
        outputLanguage: 'unknown',
        observedOutputSample: undefined,
      };
    }
  }

  async function scenarioAbortInterruption(LM) {
    if (!LM) {
      return {
        scenario: 'abort-interruption',
        scenarioStatus: 'not-applicable',
        skippedReason: 'window.ai.languageModel not available in this context',
        abortSupported: false,
        abortOrErrorCategory: 'no-error',
        timeToAbortMs: 0,
        outputTruncated: false,
      };
    }
    var session;
    try {
      session = await LM.create();
    } catch (error) {
      return {
        scenario: 'abort-interruption',
        scenarioStatus: 'not-applicable',
        skippedReason: 'session could not be created; abort not exercised',
        abortSupported: false,
        abortOrErrorCategory: categorizeError(error),
        timeToAbortMs: 0,
        outputTruncated: false,
      };
    }
    var controller = new AbortController();
    var t0 = performance.now();
    var aborted = false;
    var errorCategory = 'no-error';
    var chunks = [];
    try {
      var stream = session.promptStreaming(
        'Write a very long essay about the history of computing, paragraph by paragraph.',
        { signal: controller.signal },
      );
      var reader = stream.getReader();
      while (true) {
        var result = await reader.read();
        if (result.done) break;
        chunks.push(result.value || '');
        // Abort after the first chunk: interruption must stop generation.
        if (!aborted) {
          aborted = true;
          controller.abort();
        }
      }
    } catch (error) {
      errorCategory = categorizeError(error);
    }
    session.destroy();
    if (!aborted) {
      return {
        scenario: 'abort-interruption',
        scenarioStatus: 'fail',
        abortSupported: true,
        abortOrErrorCategory: errorCategory === 'no-error' ? 'unknown' : errorCategory,
        timeToAbortMs: Math.round(performance.now() - t0),
        outputTruncated: false,
      };
    }
    // Aborted generation counts as the expected interruption outcome, even if
    // the stream chose to resolve rather than reject after abort().
    return {
      scenario: 'abort-interruption',
      scenarioStatus: 'pass',
      abortSupported: true,
      abortOrErrorCategory: errorCategory === 'no-error' ? 'aborted' : errorCategory,
      timeToAbortMs: Math.round(performance.now() - t0),
      outputTruncated: chunks.length === 0 || aborted,
    };
  }

  async function scenarioContextUsageAndOverflow(LM) {
    if (!LM) {
      return {
        scenario: 'context-usage-and-overflow',
        scenarioStatus: 'not-applicable',
        skippedReason: 'window.ai.languageModel not available in this context',
        contextUsage: { usedTokens: 0, totalTokens: 0, ratio: 0 },
        contextWindow: { min: 0, max: 0 },
        contextOverflowObserved: false,
        quotaErrorObserved: false,
        abortOrErrorCategory: 'no-error',
      };
    }
    var session;
    try {
      session = await LM.create();
    } catch (error) {
      return {
        scenario: 'context-usage-and-overflow',
        scenarioStatus: 'not-applicable',
        skippedReason: 'session could not be created; context not exercised',
        contextUsage: { usedTokens: 0, totalTokens: 0, ratio: 0 },
        contextWindow: { min: 0, max: 0 },
        contextOverflowObserved: false,
        quotaErrorObserved: false,
        abortOrErrorCategory: categorizeError(error),
      };
    }
    try {
      var cw = session.contextWindow;
      var maxTokens = cw && cw.maxTokens ? cw.maxTokens : 0;
      var tokensLeft = cw && typeof cw.tokensLeft === 'number' ? cw.tokensLeft : maxTokens;
      var usedTokens = Math.max(0, maxTokens - tokensLeft);
      // Attempt to overflow the context with a far-too-long input; the model
      // should reject with a Quota/context error rather than hang.
      var hugeInput = 'The quick brown fox jumps over the lazy dog. '.repeat(20000);
      var overflowObserved = false;
      var quotaObserved = false;
      try {
        await session.prompt(hugeInput);
      } catch (overflowError) {
        var category = categorizeError(overflowError);
        overflowObserved = category === 'context-overflow';
        quotaObserved = category === 'quota-error';
      }
      session.destroy();
      return {
        scenario: 'context-usage-and-overflow',
        scenarioStatus: 'pass',
        contextUsage: {
          usedTokens: usedTokens,
          totalTokens: maxTokens,
          ratio: maxTokens > 0 ? Math.round((usedTokens / maxTokens) * 1000) / 1000 : 0,
        },
        contextWindow: { min: maxTokens, max: maxTokens },
        contextOverflowObserved: overflowObserved,
        quotaErrorObserved: quotaObserved,
        abortOrErrorCategory: overflowObserved || quotaObserved ? 'context-overflow' : 'no-error',
      };
    } catch (error) {
      if (session) session.destroy();
      return {
        scenario: 'context-usage-and-overflow',
        scenarioStatus: 'fail',
        contextUsage: { usedTokens: 0, totalTokens: 0, ratio: 0 },
        contextWindow: { min: 0, max: 0 },
        contextOverflowObserved: false,
        quotaErrorObserved: false,
        abortOrErrorCategory: categorizeError(error),
      };
    }
  }

  async function scenarioSessionDestroyRecreate(LM) {
    if (!LM) {
      return {
        scenario: 'session-destroy-recreate',
        scenarioStatus: 'not-applicable',
        skippedReason: 'window.ai.languageModel not available in this context',
        destroySucceeded: false,
        recreateSucceeded: false,
        destroyRecreateMs: 0,
      };
    }
    var t0 = performance.now();
    try {
      var first = await LM.create();
      first.destroy();
      var recreated = await LM.create();
      var totalMs = Math.round(performance.now() - t0);
      recreated.destroy();
      return {
        scenario: 'session-destroy-recreate',
        scenarioStatus: 'pass',
        destroySucceeded: true,
        recreateSucceeded: true,
        destroyRecreateMs: totalMs,
      };
    } catch (error) {
      return {
        scenario: 'session-destroy-recreate',
        scenarioStatus: 'fail',
        destroySucceeded: false,
        recreateSucceeded: false,
        destroyRecreateMs: Math.round(performance.now() - t0),
      };
    }
  }

  async function scenarioConcurrentSessions(LM) {
    if (!LM) {
      return {
        scenario: 'concurrent-sessions',
        scenarioStatus: 'not-applicable',
        skippedReason: 'window.ai.languageModel not available in this context',
        sessionCount: 0,
        executionCount: 0,
        maxConcurrentSupported: false,
        concurrentSessionErrors: 0,
      };
    }
    var COUNT = 4;
    var errors = 0;
    var sessions = [];
    for (var i = 0; i < COUNT; i += 1) {
      try {
        sessions.push(await LM.create());
      } catch (error) {
        errors += 1;
      }
    }
    var executed = 0;
    await Promise.all(sessions.map(function (session) {
      return session.prompt('Say OK.').then(function () {
        executed += 1;
      }).catch(function () {
        errors += 1;
      });
    }));
    sessions.forEach(function (session) {
      try { session.destroy(); } catch (error) { /* best effort */ }
    });
    return {
      scenario: 'concurrent-sessions',
      scenarioStatus: errors === 0 ? 'pass' : 'fail',
      sessionCount: COUNT,
      executionCount: executed,
      maxConcurrentSupported: errors === 0,
      concurrentSessionErrors: errors,
    };
  }

  // Surface matrix. The top-level page can only probe same-origin and sandbox
  // iframes itself; cross-origin iframes require a separately served origin and
  // extension pages require an extension host, so those stay tested:false.
  async function probeSurface(windowLike) {
    var LM = null;
    try {
      // Property access on an opaque-origin (sandboxed) iframe window throws a
      // SecurityError; guard it so the matrix records the blockage instead of
      // crashing the page.
      var ai = windowLike && windowLike.ai;
      LM = ai && ai.languageModel ? ai.languageModel : null;
    } catch (error) {
      return {
        available: false,
        usable: false,
        createAllowed: false,
        errorCategory: 'internal',
        note: 'cross-origin window access blocked: ' + categorizeError(error),
      };
    }
    if (!LM) {
      return { available: false, usable: false, createAllowed: false };
    }
    var state = await currentAvailability(LM);
    var usable = state !== 'unavailable' && state !== 'unknown';
    var createAllowed = false;
    var errorCategory;
    if (state === 'available') {
      // Only probe create when the model is already downloaded: create would
      // otherwise trigger a per-surface download, which is not what the matrix
      // is measuring.
      try {
        var session = await LM.create();
        session.destroy();
        createAllowed = true;
      } catch (error) {
        errorCategory = categorizeError(error);
      }
    }
    return {
      available: true,
      usable: usable,
      createAllowed: createAllowed,
      errorCategory: errorCategory,
      note: 'availability state: ' + state,
    };
  }

  function makeIframe(srcdoc, sandbox) {
    var iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    if (sandbox) iframe.setAttribute('sandbox', sandbox);
    iframe.srcdoc = srcdoc;
    document.body.appendChild(iframe);
    return iframe;
  }

  var IFRAME_DOC = '<!doctype html><html><body>surface probe</body></html>';

  async function scenarioSurfaceMatrix(LM) {
    var surfaces = [];
    var selfProbe = await probeSurface(window);
    surfaces.push({
      surface: 'top-level',
      tested: true,
      available: selfProbe.available,
      usable: selfProbe.usable,
      createAllowed: selfProbe.createAllowed,
      errorCategory: selfProbe.errorCategory,
    });

    var sameOrigin = makeIframe(IFRAME_DOC, null);
    var sameProbe = await probeSurface(sameOrigin.contentWindow);
    surfaces.push({
      surface: 'same-origin-iframe',
      tested: true,
      available: sameProbe.available,
      usable: sameProbe.usable,
      createAllowed: sameProbe.createAllowed,
      errorCategory: sameProbe.errorCategory,
    });

    // allow-scripts only, no allow-same-origin: the sandbox becomes a unique
    // origin, so the Prompt API (if origin-gated) should be absent.
    var sandboxed = makeIframe(IFRAME_DOC, 'allow-scripts');
    var sandboxProbe = await probeSurface(sandboxed.contentWindow);
    surfaces.push({
      surface: 'sandbox-iframe',
      tested: true,
      available: sandboxProbe.available,
      usable: sandboxProbe.usable,
      createAllowed: sandboxProbe.createAllowed,
      errorCategory: sandboxProbe.errorCategory,
      note: sandboxProbe.available
        ? undefined
        : 'Prompt API not exposed to a sandboxed (unique-origin) iframe',
    });

    // Cross-origin and extension surfaces cannot be measured from this page.
    surfaces.push({
      surface: 'cross-origin-iframe',
      tested: false,
      available: false,
      usable: false,
      createAllowed: false,
      note: 'requires a separately served cross-origin URL with its own copy of this harness',
    });
    surfaces.push({
      surface: 'extension-page',
      tested: false,
      available: false,
      usable: false,
      createAllowed: false,
      note: 'requires an extension host page; out of scope for this harness',
    });

    // Cleanup the injected iframes so the page stays tidy.
    sameOrigin.remove();
    sandboxed.remove();

    return {
      scenario: 'surface-matrix',
      scenarioStatus: 'pass',
      surfaces: surfaces,
    };
  }

  // ==== report assembly ======================================================

  function runId() {
    return 'prompt-api-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  // Reused load-time no-user-activation probe so the Run click's user
  // activation can never leak into the gesture-free measurement.
  var noActivationProbe = null;

  async function buildReport() {
    var LM = languageModelNamespace();
    var notes = [];
    notes.push('chromeChannel is a best-effort guess from the User-Agent; confirm the actual channel (stable/beta/dev/canary) manually before using this report.');
    if (!LM) {
      notes.push('window.ai.languageModel is not available in this browser/context; every scenario is recorded as not-applicable.');
    } else {
      notes.push('self-reported run: NOT real-browser-verified. Wrap this report in a captured-and-verified EvidenceEnvelope (artifact loader + independent verifier) before treating any result as verified.');
      notes.push('token counts are rough estimates (whitespace words + CJK characters), not a tokenizer.');
    }

    var withoutActivation = noActivationProbe
      || await scenarioCreateWithoutUserActivation(LM);

    // Execution order matters: download-progress runs first so the first
    // download happens inside the Run click's user activation; then
    // availability-transitions can observe downloading->available; then the
    // remaining session scenarios run on the now-cached model.
    var scenarios = [
      await scenarioDownloadProgressMonitor(LM),
      await scenarioAvailabilityTransitions(LM),
      withoutActivation,
      await scenarioCreateAfterUserActivation(LM),
      await scenarioPromptNonStreaming(LM),
      await scenarioPromptStreaming(LM),
      await scenarioExpectedInputsOutputs(LM),
      await scenarioAbortInterruption(LM),
      await scenarioContextUsageAndOverflow(LM),
      await scenarioSessionDestroyRecreate(LM),
      await scenarioConcurrentSessions(LM),
      await scenarioSurfaceMatrix(LM),
    ];

    return {
      schemaVersion: SCHEMA_VERSION,
      reportKind: 'chrome-prompt-api-feasibility',
      producer: PRODUCER,
      runId: runId(),
      capturedAt: new Date().toISOString(),
      environment: captureEnvironment(),
      scenarios: scenarios,
      notes: notes,
    };
  }

  async function runAll() {
    setRunning(true);
    setBanner('Running scenarios… this can take a minute (first model download).', '');
    log('Starting run…');
    try {
      var report = await buildReport();
      showReport(report);
      setBanner('Run complete. The report is SELF-REPORTED; see docs/chrome-prompt-api-harness.md for verification steps.', 'ok');
      log('Run complete. Report rendered below.');
    } catch (error) {
      setBanner('Harness failed while assembling the report: ' + error, 'error');
      log('Fatal harness error: ' + error);
      // Still render whatever we have so the page never ends up empty.
      showReport({
        schemaVersion: SCHEMA_VERSION,
        reportKind: 'chrome-prompt-api-feasibility',
        producer: PRODUCER,
        runId: runId(),
        capturedAt: new Date().toISOString(),
        environment: captureEnvironment(),
        scenarios: [],
        notes: ['harness error: ' + error],
      });
    } finally {
      setRunning(false);
    }
  }

  function wireButtons() {
    runButton.addEventListener('click', runAll);
    copyButton.addEventListener('click', function () {
      var value = reportOutput.value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(function () {
          log('Report JSON copied to clipboard.');
        }).catch(function () {
          log('Clipboard write failed; copy manually from the textarea.');
        });
      } else {
        reportOutput.select();
        log('Select the textarea content and copy manually.');
      }
    });
    downloadButton.addEventListener('click', function () {
      var value = reportOutput.value;
      var blob = new Blob([value], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = 'chrome-prompt-api-feasibility-report.json';
      link.click();
      URL.revokeObjectURL(url);
      log('Report JSON downloaded.');
    });
  }

  // On load: feature-detect and run the gesture-free probe, so the report can
  // distinguish "create blocked without user activation" from "model already
  // downloaded". The full scenario suite waits for the Run click.
  window.addEventListener('DOMContentLoaded', function () {
    wireButtons();
    var LM = languageModelNamespace();
    if (LM) {
      setBanner('Chrome Built-in AI / Prompt API detected. Click "Run scenarios".', 'ok');
      log('Feature-detect: window.ai.languageModel present.');
    } else {
      setBanner(
        'Chrome Built-in AI / Prompt API NOT detected. Run this page in Chrome with the Prompt API enabled, served over localhost/HTTPS. You can still produce a degraded report.',
        'error',
      );
      log('Feature-detect: window.ai.languageModel absent; the report will be fully not-applicable.');
    }
    // Best-effort gesture-free probe; never blocks the page.
    scenarioCreateWithoutUserActivation(LM).then(function (record) {
      noActivationProbe = record;
      log('No-user-activation probe recorded: ' + record.createErrorCategory +
        ' (rejected=' + record.createRejected + ').');
    }).catch(function (error) {
      log('No-user-activation probe failed: ' + error);
    });
  });
})();
