'use client';

import { useEffect, useMemo, useState } from 'react';
import type {
  DiagnosticResult,
  UnzenClient as UnzenClientType,
} from '@unzen/client/browser';

type BrowserClientModule = typeof import('@unzen/client/browser');
const clientModuleUrl = '/unzen/client.js';

export function UnzenDemo() {
  const [client, setClient] = useState<UnzenClientType | null>(null);
  const [result, setResult] = useState<DiagnosticResult | null>(null);

  const schema = useMemo(
    () => ({
      type: 'object',
      required: ['email'],
    }),
    []
  );

  useEffect(() => {
    let active = true;
    let instance: UnzenClientType | undefined;

    async function load() {
      const mod = (await import(
        /* webpackIgnore: true */ clientModuleUrl
      )) as BrowserClientModule;

      instance = new mod.UnzenClient({
        endpoint: '/api/unzen',
        mode: 'production',
        workerUrl: '/unzen/worker.js',
      });

      if (active) {
        setClient(instance);
      }
    }

    void load();

    return () => {
      active = false;
      instance?.dispose();
    };
  }, []);

  async function validate() {
    if (!client) return;

    const response = await client.callWithDiagnostics(
      'jsonSchemaValidate',
      schema,
      { email: 'a@example.com' }
    );
    setResult(response);
  }

  return (
    <section>
      <button type="button" onClick={validate} disabled={!client}>
        Run validation
      </button>
      <pre data-testid="unzen-result">
        {result ? JSON.stringify(result, null, 2) : 'Client loading...'}
      </pre>
    </section>
  );
}
