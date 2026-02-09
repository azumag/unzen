/**
 * Sandbox Security Hardening - Shared between server and client
 *
 * This module provides the security initialization code that must run
 * inside every QuickJS context BEFORE any user code executes.
 *
 * Security layers:
 * 1. Cut constructor chains on ALL 4 Function subclasses (Function, AsyncFunction,
 *    GeneratorFunction, AsyncGeneratorFunction) to prevent sandbox escape via
 *    prototype chain traversal (e.g., ({}).constructor.constructor → Function)
 * 2. Remove dangerous globals (eval, Function, Proxy, Reflect, WeakRef, FinalizationRegistry)
 * 3. Freeze built-in prototypes to prevent prototype pollution
 *
 * This code is shared between:
 * - Server (quickjs-runtime.ts): Server-side fallback execution
 * - Client (quickjs-worker.ts): Browser-side QuickJS Wasm execution
 *
 * IMPORTANT: This is the #1 existential risk for sandbox security (C1 finding).
 * Any changes must be reviewed with extreme care.
 *
 * @module @unzen/shared/sandbox-security
 */

/**
 * JavaScript code string that removes unsafe globals and hardens a QuickJS context.
 *
 * Must be executed via evalCode() in a fresh QuickJS context before user code.
 * This is a string constant (not a function) because it runs inside QuickJS,
 * not in the host JavaScript environment.
 *
 * What it does:
 * 1. Captures references to all 4 Function-derived prototypes via IIFE
 * 2. Sets .constructor = undefined (non-writable, non-configurable) on each
 * 3. Freezes each prototype to prevent re-adding .constructor
 * 4. Removes eval, Function, Proxy, Reflect, WeakRef, FinalizationRegistry from globalThis
 * 5. Freezes Object, Array, String, Number, Boolean, RegExp prototypes
 */
export const SANDBOX_SECURITY_INIT = `
  // CRITICAL: Cut constructor chains on Function and all Function subclasses
  // BEFORE removing Function from globalThis. After globalThis.Function = undefined,
  // we can't access Function.prototype anymore.
  //
  // Without this, any object can reach Function via prototype chain traversal:
  //   ({}).constructor → Object → Object.constructor → Function
  //   [].constructor → Array → Array.constructor → Function
  //   (async function(){}).constructor → AsyncFunction (extends Function)
  //   (function*(){}).constructor → GeneratorFunction (extends Function)
  //
  // We must cut constructor on ALL Function-derived prototypes.
  // This is the #1 existential risk for sandbox security (C1 finding + gemini review).
  (function() {
    var FuncProto = Function.prototype;

    // Also cut AsyncFunction, GeneratorFunction, and AsyncGeneratorFunction
    // constructor chains. These inherit from Function but have their own
    // prototype objects with .constructor pointing back to themselves.
    // Missing any of these allows sandbox escape (gemini review finding).
    var AsyncFuncProto = (async function(){}).constructor.prototype;
    var GenFuncProto = (function*(){}).constructor.prototype;
    var AsyncGenFuncProto = (async function*(){}).constructor.prototype;

    // Cut all four constructor chains — these are the complete set of
    // Function subclasses in JavaScript (ES2018+)
    var protos = [FuncProto, AsyncFuncProto, GenFuncProto, AsyncGenFuncProto];
    for (var i = 0; i < protos.length; i++) {
      Object.defineProperty(protos[i], 'constructor', {
        value: undefined, writable: false, configurable: false
      });
      Object.freeze(protos[i]);
    }
  })();

  Object.defineProperty(globalThis, 'eval', {
    value: undefined, writable: false, configurable: false
  });
  Object.defineProperty(globalThis, 'Function', {
    value: undefined, writable: false, configurable: false
  });
  // Block Proxy/Reflect/WeakRef/FinalizationRegistry to prevent sandbox escape.
  // Proxy can intercept property access to reconstruct blocked APIs.
  // Reflect provides low-level object manipulation bypassing frozen prototypes.
  // WeakRef/FinalizationRegistry can observe GC timing (side-channel).
  Object.defineProperty(globalThis, 'Proxy', {
    value: undefined, writable: false, configurable: false
  });
  Object.defineProperty(globalThis, 'Reflect', {
    value: undefined, writable: false, configurable: false
  });
  if (typeof WeakRef !== 'undefined') {
    Object.defineProperty(globalThis, 'WeakRef', {
      value: undefined, writable: false, configurable: false
    });
  }
  if (typeof FinalizationRegistry !== 'undefined') {
    Object.defineProperty(globalThis, 'FinalizationRegistry', {
      value: undefined, writable: false, configurable: false
    });
  }
  // Block WebAssembly if present (defense-in-depth).
  // QuickJS doesn't expose WebAssembly natively, but guard against future changes.
  if (typeof WebAssembly !== 'undefined') {
    Object.defineProperty(globalThis, 'WebAssembly', {
      value: undefined, writable: false, configurable: false
    });
  }
  // Freeze built-in prototypes to prevent prototype pollution attacks.
  // Phase 2 (WebWorker + QuickJS Wasm) provides 4-layer isolation.
  Object.freeze(Object.prototype);
  Object.freeze(Array.prototype);
  Object.freeze(String.prototype);
  Object.freeze(Number.prototype);
  Object.freeze(Boolean.prototype);
  Object.freeze(RegExp.prototype);
  // Freeze additional built-in prototypes (gemini review finding).
  // QuickJS supports these ES2015+ built-ins.
  if (typeof Promise !== 'undefined') Object.freeze(Promise.prototype);
  if (typeof Map !== 'undefined') Object.freeze(Map.prototype);
  if (typeof Set !== 'undefined') Object.freeze(Set.prototype);
  if (typeof Date !== 'undefined') Object.freeze(Date.prototype);
  if (typeof Error !== 'undefined') Object.freeze(Error.prototype);
  if (typeof Symbol !== 'undefined') Object.freeze(Symbol.prototype);
`;
