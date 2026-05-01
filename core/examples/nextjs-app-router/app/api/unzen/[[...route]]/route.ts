import { getUnzenApp } from '@/lib/unzen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(request: Request): Promise<Response> {
  const app = await getUnzenApp();
  return app.fetch(request);
}

export { handle as GET, handle as POST };
