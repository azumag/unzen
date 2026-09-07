/** Test-only, opt-in phase tracing. Never logs request bodies or exception text. */
export type MiniflarePhase = 'compile' | 'startup' | 'request-verification' | 'dispose';
let nextSample = 0;

export function createMiniflarePhaseTimer(suite: 'adapters' | 'engine') {
  const enabled = process.env.UNZEN_MINIFLARE_TIMING === '1';
  const sample = ++nextSample;
  return async function measure<T>(phase: MiniflarePhase, operation: () => T | Promise<T>): Promise<T> {
    if (!enabled) return await operation();
    const started = performance.now();
    const emit = (status: 'started' | 'passed' | 'failed') => {
      try {
        console.info(JSON.stringify({
          event: 'unzen_miniflare_phase', suite, sample, phase, status,
          ...(status === 'started' ? {} : { elapsedMs: Math.round((performance.now() - started) * 100) / 100 }),
        }));
      } catch {
        // Instrumentation must never change the tested operation's outcome.
      }
    };
    // Emit before awaiting so an interrupted/timeout run identifies its last phase.
    emit('started');
    try {
      const value = await operation();
      emit('passed');
      return value;
    } catch (error) {
      emit('failed');
      throw error;
    }
  };
}
