import type { APIRoute } from 'astro';
import { runAudit } from '../../lib/auditor';
import { demoReport } from '../../lib/demo';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    if (body?.demo === true) {
      return Response.json({ ...demoReport, id: `demo-${Date.now()}`, createdAt: new Date().toISOString() });
    }
    if (typeof body?.url !== 'string' || !body.url.trim()) {
      return Response.json({ error: 'Введите адрес сайта' }, { status: 400 });
    }
    const keywords = Array.isArray(body.keywords)
      ? body.keywords.filter((item: unknown): item is string => typeof item === 'string')
      : typeof body.keywords === 'string'
        ? body.keywords.split(/[,;\n]/)
        : [];
    const report = await runAudit(body.url, Number(body.limit || 25), keywords, { signal: request.signal });
    return Response.json(report);
  } catch (error) {
    const message = error instanceof Error
      ? error.name === 'AbortError' ? 'Сайт не ответил за 12 секунд' : error.message
      : 'Не удалось выполнить аудит';
    return Response.json({ error: message }, { status: 422 });
  }
};
