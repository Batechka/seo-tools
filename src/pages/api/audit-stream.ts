import type { APIRoute } from 'astro';
import { runAudit } from '../../lib/auditor';
import type { AuditProgress } from '../../lib/types';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.url !== 'string' || !body.url.trim()) {
    return Response.json({ error: 'Введите адрес сайта' }, { status: 400 });
  }
  const keywords = Array.isArray(body.keywords)
    ? body.keywords.filter((item: unknown): item is string => typeof item === 'string')
    : typeof body.keywords === 'string' ? body.keywords.split(/[,;\n]/) : [];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const send = (value: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
      const onProgress = (progress: AuditProgress) => send({ type: 'progress', progress });
      runAudit(body.url, Number(body.limit || 25), keywords, { signal: request.signal, onProgress })
        .then((report) => { send({ type: 'report', report }); controller.close(); })
        .catch((error) => {
          const message = error instanceof Error
            ? error.name === 'AbortError' ? 'Аудит отменён' : error.message
            : 'Не удалось выполнить аудит';
          try { send({ type: 'error', error: message }); controller.close(); } catch { /* connection closed */ }
        });
    },
    cancel() { /* request.signal propagates disconnect to runAudit */ },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-content-type-options': 'nosniff',
    },
  });
};
