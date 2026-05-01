import { UnzenServer } from '@unzen/server';
import { Hono } from 'hono';

const baseUrl =
  process.env.NEXT_PUBLIC_UNZEN_BASE_URL ?? 'http://localhost:3000/api/unzen';

const server = new UnzenServer({ baseUrl });

server.defineRaw(
  'jsonSchemaValidate',
  `function run(schema, data) {
  function validate(schema, value, path) {
    const errors = [];

    if (schema.type === 'object') {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [path + ': expected object'];
      }

      for (const key of schema.required ?? []) {
        if (value[key] === undefined) {
          errors.push(path + '.' + key + ': required');
        }
      }
    }

    return errors;
  }

  const errors = validate(schema, data, '$');
  return { valid: errors.length === 0, errors };
}`,
  { timeout: 500 }
);

let appPromise: Promise<Hono> | undefined;

export function getUnzenApp(): Promise<Hono> {
  appPromise ??= (async () => {
    await server.initialize();

    const app = new Hono();
    const unzenMiddleware = server.middleware() as unknown as Hono;
    app.route('/api/unzen', unzenMiddleware);
    return app;
  })();

  return appPromise;
}
