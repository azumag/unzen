# QJS-proto E2E Demo

This demo demonstrates the complete QJS-proto framework with browser-side function execution and automatic server-side fallback.

## Features Demonstrated

1. **Spam Detection** - Text analysis function
2. **Math Operations** - Simple multiplication
3. **Array Transformations** - Doubling array values
4. **Object Manipulation** - User info transformer

## What You'll See

- ✅ Functions execute in the browser using QuickJS WebAssembly
- ✅ Automatic fallback to server if browser execution fails
- ✅ Smart caching of function code in IndexedDB
- ✅ Real-time execution statistics
- ✅ Performance metrics (execution time, cache hits, etc.)

## Running the Demo

### Prerequisites

```bash
# From the project root
npm install
npm run build
```

### Start the Demo Server

```bash
cd demo
npm install
npm run dev
```

The demo will be available at: http://localhost:3000

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser (Client)                        │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  @unzen/client                                        │   │
│  │  ├─ QuickJS Wasm Runtime                             │   │
│  │  ├─ Function Code Cache (IndexedDB)                  │   │
│  │  └─ Fallback to Server                               │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                           ↕ HTTP
┌─────────────────────────────────────────────────────────────┐
│                    Server (Node.js + Hono)                   │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  @unzen/server                                        │   │
│  │  ├─ Function Registry                                │   │
│  │  ├─ Manifest Builder                                 │   │
│  │  ├─ QuickJS Runtime (fallback)                       │   │
│  │  └─ HTTP Routes                                      │   │
│  │     ├─ GET /manifest (function metadata)             │   │
│  │     ├─ GET /code/:name (function code)               │   │
│  │     └─ POST /exec/:name (fallback execution)         │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/unzen/manifest` | GET | Returns metadata for all registered functions |
| `/unzen/code/:name` | GET | Returns function source code |
| `/unzen/exec/:name` | POST | Executes function server-side (fallback) |

## Execution Flow

1. **Client calls function**: `client.execute('spamCheck', ['Buy now!'])`
2. **Check cache**: Is function code cached in IndexedDB?
3. **Fetch if needed**: Download code from `/unzen/code/spamCheck`
4. **Execute in browser**: Run in QuickJS WebAssembly sandbox
5. **Fallback on error**: POST to `/unzen/exec/spamCheck` if browser fails

## Statistics Tracked

- **Browser Executions**: Functions executed in the browser
- **Server Fallbacks**: Functions executed on the server
- **Cache Hits**: Times function code was loaded from cache
- **Avg Execution Time**: Average time per function execution

## Testing Different Scenarios

### Force Server Fallback

To test server fallback, you can disable WebAssembly in your browser:
1. Chrome: Go to `chrome://flags/#enable-webassembly` and disable
2. Or modify the client code to force fallback

### Test Cache Performance

1. Execute a function once (cache miss)
2. Execute the same function again (cache hit - should be faster)
3. Check the "Cache Hits" statistic

### Test Error Handling

Try executing with invalid input to see error handling in action.

## Code Examples

### Server-side (server.ts)

```typescript
import { UnzenServer } from '@unzen/server';

const server = new UnzenServer({
  baseUrl: 'http://localhost:3000/unzen',
});

// Register a function
server.defineRaw('spamCheck', `(text) => {
  const spamKeywords = ['spam', 'buy now', 'click here'];
  return spamKeywords.some(kw => text.toLowerCase().includes(kw));
}`);

await server.initialize();
```

### Client-side (demo.js)

```typescript
import { UnzenClient } from '@unzen/client';

const client = new UnzenClient({
  baseUrl: 'http://localhost:3000/unzen',
});

await client.initialize();

// Execute function
const result = await client.execute('spamCheck', ['Buy now!'], {
  diagnostics: true,
});

console.log(result.value); // true
console.log(result.executedOn); // 'browser' or 'server'
console.log(result.durationMs); // execution time
```

## Notes

- Functions are sandboxed and cannot access external resources
- Memory limit: 16MB per execution
- Timeout: 50ms default (configurable)
- Function code is immutable and cacheable
