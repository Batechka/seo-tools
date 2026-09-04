import type { APIRoute } from 'astro';
import { validatePublicUrl } from '../../lib/security';

export const prerender = false;

const numericValue = (audit: any) => typeof audit?.numericValue === 'number' ? audit.numericValue : null;

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    if (typeof body?.url !== 'string') return Response.json({ error: 'Укажите URL страницы' }, { status: 400 });
    const target = await validatePublicUrl(body.url);
    const strategy = body.strategy === 'desktop' ? 'desktop' : 'mobile';
    const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    endpoint.searchParams.set('url', target.toString());
    endpoint.searchParams.set('strategy', strategy);
    for (const category of ['performance', 'accessibility', 'best-practices', 'seo']) endpoint.searchParams.append('category', category);
    if (process.env.PAGESPEED_API_KEY) endpoint.searchParams.set('key', process.env.PAGESPEED_API_KEY);

    const response = await fetch(endpoint, { signal: AbortSignal.timeout(90_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `PageSpeed вернул HTTP ${response.status}`);
    const lighthouse = data.lighthouseResult;
    const audits = lighthouse?.audits || {};
    const categories = lighthouse?.categories || {};
    return Response.json({
      url: lighthouse?.finalUrl || target.toString(), strategy, fetchedAt: lighthouse?.fetchTime || new Date().toISOString(),
      scores: Object.fromEntries(Object.entries(categories).map(([key, value]: [string, any]) => [key, Math.round((value?.score || 0) * 100)])),
      metrics: {
        fcp: numericValue(audits['first-contentful-paint']),
        lcp: numericValue(audits['largest-contentful-paint']),
        tbt: numericValue(audits['total-blocking-time']),
        cls: numericValue(audits['cumulative-layout-shift']),
        speedIndex: numericValue(audits['speed-index']),
      },
      opportunities: Object.values(audits).filter((audit: any) => audit?.details?.type === 'opportunity' && (audit.numericValue || 0) > 0).sort((a: any, b: any) => (b.numericValue || 0) - (a.numericValue || 0)).slice(0, 8).map((audit: any) => ({ title: audit.title, description: audit.description, savingsMs: Math.round(audit.numericValue || 0) })),
      screenshot: typeof audits['final-screenshot']?.details?.data === 'string' ? audits['final-screenshot'].details.data : '',
      source: 'PageSpeed Insights / Lighthouse lab data',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось получить данные PageSpeed';
    return Response.json({ error: message }, { status: 422 });
  }
};
