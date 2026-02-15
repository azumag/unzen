# Phase 1 MVP Implementation Plan

**Document Version:** 1.0
**Date:** 2026-02-07
**Status:** Planning Phase

## 1. Overview

This document outlines the implementation plan for Phase 1 MVP of the unzen core framework. The plan follows TDD (Test-Driven Development) principles and is based on industry-standard research from task #2.

### 1.1 Phase 1 Goals

Following the design document (docs/design.md), Phase 1 focuses on:

- QuickJS Wasm build and execution in Web Worker
- Server SDK: Function definition and manifest delivery endpoints
- Client SDK: Function retrieval and execution
- Fallback: Server-side execution
- Development mode (always server execution)

### 1.2 Research-Based Decisions

From task #2 research findings:

**QuickJS Wasm Library:**
- Use `quickjs-emscripten` v0.31.0 as the standard library
- Binary size: ~505KB uncompressed, ~150KB gzip
- Performance: ~35-55x slower than V8 JIT (acceptable for short functions)
- Memory management: Manual `.dispose()` calls required

**Web Worker Patterns:**
- Worker pool pattern: Compile once, share with workers
- Transferable objects for zero-copy data transfer
- postMessage for communication between main thread and workers

**Architecture:**
- Figma's LowLevelJavascriptVm interface pattern as reference
- Scope pattern and using statement for automatic cleanup

## 2. Package Structure

```
core/
├── packages/
│   ├── shared/          # Shared types and protocol definitions
│   │   ├── src/
│   │   │   ├── types.ts         # Core type definitions
│   │   │   ├── protocol.ts      # Client-server protocol
│   │   │   └── errors.ts        # Error classes
│   │   └── tests/
│   │       └── types.test.ts
│   │
│   ├── server/          # Server SDK
│   │   ├── src/
│   │   │   ├── UnzenServer.ts   # Main server class
│   │   │   ├── FunctionRegistry.ts
│   │   │   ├── ManifestBuilder.ts
│   │   │   ├── routes.ts        # HTTP endpoints
│   │   │   └── QuickJSRuntime.ts # Server-side execution
│   │   └── tests/
│   │       ├── UnzenServer.test.ts
│   │       └── QuickJSRuntime.test.ts
│   │
│   └── client/          # Client SDK
│       ├── src/
│       │   ├── UnzenClient.ts   # Main client class
│       │   ├── WorkerManager.ts # Web Worker management
│       │   ├── QuickJSWorker.ts # Worker script (inline)
│       │   └── FallbackHandler.ts
│       └── tests/
│           ├── UnzenClient.test.ts
│           └── WorkerManager.test.ts
│
└── demo/                # E2E demo application
    └── (simple Express server with client example)
```

## 3. TDD Strategy

### 3.1 Test-First Approach

Following t-wada's TDD principles:
1. **Red**: Write a failing test first
2. **Green**: Make it pass with minimal implementation
3. **Refactor**: Clean up while keeping tests green

### 3.2 Test Categories

| Category | Tool | Purpose |
|----------|------|---------|
| Unit Tests | Vitest | Test individual functions/classes in isolation |
| Integration Tests | Vitest | Test package-level interactions |
| E2E Tests | Vitest + Playwright | Test full user flows (demo app) |

### 3.3 Test Structure

Each package follows this test structure:
```
packages/{name}/
├── src/
│   └── {module}.ts
└── tests/
    └── {module}.test.ts
```

## 4. Implementation Tasks

### Task 3.1: @unzen/shared Package

**Priority:** Foundation (blocks all other tasks)
**Estimated Complexity:** Low

#### Subtasks:

| ID | Task | Test File | Status |
|----|------|-----------|--------|
| 3.1.1 | Define core types (`types.ts`) | `types.test.ts` | Pending |
| 3.1.2 | Define protocol types (`protocol.ts`) | `protocol.test.ts` | Pending |
| 3.1.3 | Define error classes (`errors.ts`) | `errors.test.ts` | Pending |
| 3.1.4 | Export public API (`index.ts`) | - | Pending |

#### Core Types to Implement:

```typescript
// types.ts
export type RuntimeType = 'quickjs' | 'moonbit';

export interface FunctionDefinition {
  name: string;
  runtime: RuntimeType;
  code: string;
  version: number;
  hash: string;
}

export interface ExecutionOptions {
  timeout?: number;
  diagnostics?: boolean;
  mode?: 'production' | 'development' | 'browser-only';
}

export interface ExecutionResult<T = unknown> {
  value: T;
  executedOn: 'browser' | 'server';
  runtime: RuntimeType;
  durationMs: number;
  cached: boolean;
}
```

```typescript
// errors.ts
export class UnzenError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = 'UnzenError';
  }
}

export class UnzenRuntimeError extends UnzenError {
  constructor(message: string) {
    super(message, 'RUNTIME_ERROR');
    this.name = 'UnzenRuntimeError';
  }
}

export class UnzenFunctionError extends UnzenError {
  constructor(message: string) {
    super(message, 'FUNCTION_ERROR');
    this.name = 'UnzenFunctionError';
  }
}

export class UnzenNetworkError extends UnzenError {
  constructor(message: string) {
    super(message, 'NETWORK_ERROR');
    this.name = 'UnzenNetworkError';
  }
}
```

```typescript
// protocol.ts
export interface ManifestRequest {}
export interface ManifestResponse {
  functions: Record<string, FunctionManifestEntry>;
}

export interface FunctionManifestEntry {
  runtime: RuntimeType;
  hash: string;
  version: number;
  codeUrl: string;
}

export interface ExecutionRequest {
  args: unknown[];
}

export interface ExecutionResponse {
  result: unknown;
  error?: string;
}
```

---

### Task 3.2: @unzen/server Package

**Priority:** High (after shared)
**Estimated Complexity:** Medium

#### Subtasks:

| ID | Task | Test File | Status |
|----|------|-----------|--------|
| 3.2.1 | Implement `FunctionRegistry` | `FunctionRegistry.test.ts` | Pending |
| 3.2.2 | Implement `ManifestBuilder` | `ManifestBuilder.test.ts` | Pending |
| 3.2.3 | Implement `QuickJSRuntime` (server-side) | `QuickJSRuntime.test.ts` | Pending |
| 3.2.4 | Implement HTTP routes (`routes.ts`) | `routes.test.ts` | Pending |
| 3.2.5 | Implement `UnzenServer` main class | `UnzenServer.test.ts` | Pending |
| 3.2.6 | Create Hono middleware | - | Pending |

#### API Design:

```typescript
// UnzenServer.ts
export class UnzenServer {
  private registry: FunctionRegistry;

  define<T extends unknown[]>(
    name: string,
    fn: (...args: T) => unknown
  ): UnzenFunction;

  middleware(): MiddlewareHandler;  // Hono middleware

  getFunction(name: string): FunctionDefinition | undefined;
}

export interface UnzenFunction {
  name: string;
  call(...args: unknown[]): Promise<unknown>;
}
```

#### HTTP Endpoints:

| Endpoint | Method | Response |
|----------|--------|----------|
| `/unzen/manifest` | GET | `ManifestResponse` |
| `/unzen/code/:name` | GET | Function code (string) |
| `/unzen/exec/:name` | POST | `ExecutionResponse` |

---

### Task 3.3: @unzen/client Package

**Priority:** High (after shared)
**Estimated Complexity:** High (Web Worker complexity)

#### Subtasks:

| ID | Task | Test File | Status |
|----|------|-----------|--------|
| 3.3.1 | Implement `QuickJSWorker` (inline worker script) | `QuickJSWorker.test.ts` | Pending |
| 3.3.2 | Implement `WorkerManager` (pool pattern) | `WorkerManager.test.ts` | Pending |
| 3.3.3 | Implement `FallbackHandler` | `FallbackHandler.test.ts` | Pending |
| 3.3.4 | Implement `UnzenClient` main class | `UnzenClient.test.ts` | Pending |
| 3.3.5 | Add development mode support | - | Pending |

#### API Design:

```typescript
// UnzenClient.ts
export interface UnzenClientOptions {
  endpoint: string;
  mode?: 'production' | 'development' | 'browser-only';
  workerCount?: number;
}

export class UnzenClient {
  constructor(options: UnzenClientOptions);

  call<T = unknown>(
    name: string,
    ...args: unknown[]
  ): Promise<T>;

  callWithDiagnostics(
    name: string,
    ...args: unknown[]
  ): Promise<ExecutionResult>;

  dispose(): Promise<void>;  // Cleanup workers
}
```

#### Worker Communication Protocol:

```typescript
// Main → Worker messages
interface WorkerRequest {
  id: string;
  type: 'init' | 'execute';
  functionName?: string;
  functionCode?: string;
  args?: unknown[];
}

// Worker → Main messages
interface WorkerResponse {
  id: string;
  type: 'result' | 'error';
  result?: unknown;
  error?: string;
}
```

---

### Task 3.4: QuickJS Wasm Integration

**Priority:** Critical (blocks client execution)
**Estimated Complexity:** Medium

#### Subtasks:

| ID | Task | Test File | Status |
|----|------|-----------|--------|
| 3.4.1 | Bundle quickjs-emscripten for browser | - | Pending |
| 3.4.2 | Create QuickJS sandbox wrapper | `QuickJSSandbox.test.ts` | Pending |
| 3.4.3 | Implement memory management (dispose) | - | Pending |
| 3.4.4 | Add timeout/interrupt handling | - | Pending |

#### Dependencies:

```json
{
  "dependencies": {
    "quickjs-emscripten": "^0.31.0"
  }
}
```

#### Sandbox Constraints:

- Memory limit: 16MB
- Stack size: 256KB
- Execution timeout: 50ms
- Blocked APIs: `eval`, `Function`, `fetch`, `XMLHttpRequest`

---

### Task 3.5: Demo Application

**Priority:** Medium (after packages are functional)
**Estimated Complexity:** Low

#### Subtasks:

| ID | Task | Description | Status |
|----|------|-------------|--------|
| 3.5.1 | Create Express server with UnzenServer | Basic demo server | Pending |
| 3.5.2 | Create HTML demo page | Simple spam check example | Pending |
| 3.5.3 | Add E2E tests | Verify full flow works | Pending |

#### Demo Functions:

1. **spamCheck**: Simple regex-based validation
2. **calculateFibonacci**: Demonstrates performance difference

---

## 5. Implementation Order

Based on dependencies and TDD principles:

```
Phase 1.1: Foundation (Week 1)
├── Task 3.1: @unzen/shared (all types, errors, protocols)
└── Task 3.2.1-2: FunctionRegistry, ManifestBuilder

Phase 1.2: Server (Week 2)
├── Task 3.2.3: QuickJSRuntime (server-side)
├── Task 3.2.4: HTTP routes
└── Task 3.2.5-6: UnzenServer, middleware

Phase 1.3: Client (Week 3-4)
├── Task 3.4: QuickJS Wasm integration
├── Task 3.3.1: QuickJSWorker
├── Task 3.3.2: WorkerManager
├── Task 3.3.3: FallbackHandler
└── Task 3.3.4-5: UnzenClient, dev mode

Phase 1.4: Integration (Week 5)
├── Task 3.5: Demo application
├── E2E tests
└── Documentation updates
```

## 6. Acceptance Criteria

Each subtask is considered complete when:

1. **Tests Pass**: All tests for the module pass (`npm test`)
2. **Type Safety**: No `any` types without justification
3. **Code Coverage**: >90% coverage for new code
4. **Documentation**: Code is self-documenting with JSDoc comments
5. **Review Passes**: Self-review + gemini-cli review + codex cli review pass

## 7. Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Web Worker complexity | Start with single worker, add pooling later |
| QuickJS memory leaks | Strict disposal pattern with tests |
| Browser compatibility | Test in Chrome, Firefox, Safari early |
| Performance regression | Benchmark each component |
| quickjs-emscripten API changes | Pin to v0.31.0, document any workarounds |

## 8. Dependencies

### External Dependencies (to be added):

```json
// packages/server/package.json
{
  "dependencies": {
    "@unzen/shared": "workspace:*",
    "hono": "^4.0.0"
  },
  "devDependencies": {
    "quickjs-emscripten": "^0.31.0"  // For server-side execution
  }
}

// packages/client/package.json
{
  "dependencies": {
    "@unzen/shared": "workspace:*",
    "quickjs-emscripten": "^0.31.0"
  }
}
```

### Internal Dependencies:

```
@unzen/server → @unzen/shared
@unzen/client → @unzen/shared
demo → @unzen/server + @unzen/client
```

## 9. Success Metrics

Phase 1 MVP is successful when:

1. ✅ A user can define a function in `server.ts`
2. ✅ The function code is served via HTTP endpoints
3. ✅ The client can fetch and execute the function in QuickJS Wasm
4. ✅ Fallback to server execution works when Wasm fails
5. ✅ Development mode allows server-side debugging
6. ✅ Demo app demonstrates the full flow end-to-end

## 10. Next Steps

After this plan is approved:

1. Create task breakdown for implementation phase
2. Begin with Task 3.1 (@unzen/shared) using TDD
3. Update this document as implementation progresses
4. Track progress in task system

---

**Change Log:**
- 2026-02-07: Initial plan created based on research from task #2
