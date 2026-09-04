import type { APIRoute } from 'astro';
import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import type { AuditReport } from '../../lib/types';
import { groupAuditIssues } from '../../lib/issue-planning';

export const prerender = false;

const labels = {
  critical: 'Критично', high: 'Высокий', medium: 'Средний', low: 'Низкий',
  indexing: 'Индексация', onpage: 'On-page', content: 'Контент', links: 'Ссылки', images: 'Изображения',
  schema: 'Schema.org', performance: 'Скорость', social: 'Соцсети', ai: 'AI-поиск',
} as const;

export const POST: APIRoute = async ({ request }) => {
  try {
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 8_000_000) return Response.json({ error: 'Отчёт слишком большой для PDF-экспорта' }, { status: 413 });
    const report = await request.json() as AuditReport;
    if (!report?.url || !Array.isArray(report.issues)) return Response.json({ error: 'Некорректные данные отчёта' }, { status: 400 });
    const doc = new PDFDocument({ size: 'A4', margin: 46, info: { Title: `SEO-аудит ${report.url}`, Author: 'SiteScan' } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    const regular = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(existsSync);
    const bold = ['C:/Windows/Fonts/arialbd.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'].find(existsSync);
    if (regular) doc.registerFont('Regular', regular);
    if (bold) doc.registerFont('Bold', bold);
    const font = regular ? 'Regular' : 'Helvetica';
    const fontBold = bold ? 'Bold' : 'Helvetica-Bold';
    const width = doc.page.width - 92;
    const ensure = (needed = 80) => { if (doc.y + needed > doc.page.height - 46) doc.addPage(); };
    const rule = () => doc.moveTo(46, doc.y).lineTo(46 + width, doc.y).strokeColor('#D9DDD6').lineWidth(0.7).stroke().moveDown(0.7);

    doc.rect(0, 0, doc.page.width, 146).fill('#151714');
    doc.fillColor('#B9F54A').font(fontBold).fontSize(11).text('SITESCAN / SEO REPORT', 46, 40);
    doc.fillColor('#FFFFFF').font(fontBold).fontSize(27).text('Технический SEO-аудит', 46, 68);
    doc.fillColor('#B8BDB5').font(font).fontSize(10).text(report.url, 46, 108, { width: 360, ellipsis: true });
    doc.fillColor('#151714').font(fontBold).fontSize(44).text(String(report.score), 457, 54, { width: 80, align: 'right' });
    doc.fillColor('#B9F54A').font(fontBold).fontSize(44).text(String(report.score), 457, 54, { width: 80, align: 'right' });
    doc.fillColor('#B8BDB5').font(font).fontSize(9).text('ИЗ 100', 457, 104, { width: 80, align: 'right' });
    doc.x = 46; doc.y = 174;
    doc.fillColor('#151714').font(fontBold).fontSize(15).text('Резюме', 46, doc.y, { width });
    doc.moveDown(0.7).font(font).fontSize(10).fillColor('#4C514A')
      .text(`Проверено страниц: ${report.pagesScanned}  •  Время: ${(report.duration / 1000).toFixed(1)} сек.  •  Оценка: ${report.grade}`, 46, doc.y, { width });
    const issueGroups = groupAuditIssues(report.issues);
    doc.moveDown(0.5).text(`Критично: ${report.totals.critical}  •  Высокий приоритет: ${report.totals.high}  •  Средний: ${report.totals.medium}  •  Низкий: ${report.totals.low}  •  Групп причин: ${issueGroups.length}`, 46, doc.y, { width });
    doc.moveDown(1.2); rule();
    doc.fillColor('#151714').font(fontBold).fontSize(15).text('Оценки по направлениям', 46, doc.y, { width });
    doc.moveDown(0.8);
    Object.entries(report.categoryScores).forEach(([category, score]) => {
      ensure(28);
      const y = doc.y;
      doc.fillColor('#4C514A').font(font).fontSize(9).text(labels[category as keyof typeof labels] || category, 46, y, { width: 130 });
      doc.roundedRect(188, y + 2, 290, 7, 3).fill('#E7EAE4');
      doc.roundedRect(188, y + 2, 290 * score / 100, 7, 3).fill(score >= 75 ? '#6FAE18' : score >= 50 ? '#E3A51B' : '#D84B3E');
      doc.fillColor('#151714').font(fontBold).text(String(score), 490, y - 1, { width: 45, align: 'right' });
      doc.y = y + 22;
    });
    doc.x = 46;
    doc.moveDown(0.5); rule();
    doc.fillColor('#151714').font(fontBold).fontSize(15).text('Контент и семантика', 46, doc.y, { width });
    doc.moveDown(0.7).fillColor('#4C514A').font(font).fontSize(9)
      .text(`Качество контента: ${report.contentSummary?.averageContentScore ?? 0}/100  •  Читабельность: ${report.contentSummary?.averageReadability ?? 0}/100  •  AI-цитируемость: ${report.contentSummary?.averageAiCitationScore ?? 0}/100  •  Тонких страниц: ${report.contentSummary?.thinPages ?? 0}`, 46, doc.y, { width });
    if (report.keywordSummary?.length) {
      doc.moveDown(0.8);
      report.keywordSummary.forEach((item) => {
        ensure(34);
        const rowY = doc.y;
        const metrics = `вхождений ${item.totalCount}  •  страницы ${item.pageCoverage}%  •  плотность ${item.averageDensity}%  •  title ${item.titleCoverage}%  •  H1 ${item.h1Coverage}%`;
        const keywordHeight = doc.font(fontBold).fontSize(9).heightOfString(item.keyword, { width: 180 });
        const metricsHeight = doc.font(font).fontSize(9).heightOfString(metrics, { width: 299 });
        doc.fillColor('#151714').font(fontBold).text(item.keyword, 46, rowY, { width: 180 });
        doc.fillColor('#4C514A').font(font).text(metrics, 236, rowY, { width: 299 });
        doc.x = 46; doc.y = rowY + Math.max(keywordHeight, metricsHeight) + 8;
      });
    } else {
      doc.moveDown(0.5).fillColor('#777D74').font(font).fontSize(8).text('Целевые ключевые фразы не были заданы.', 46, doc.y, { width });
    }
    if (report.searchConsole?.length) {
      const clicks = report.searchConsole.reduce((sum, row) => sum + row.clicks, 0);
      const impressions = report.searchConsole.reduce((sum, row) => sum + row.impressions, 0);
      doc.moveDown(0.8).fillColor('#151714').font(fontBold).fontSize(10).text(`Search Console CSV: ${Math.round(clicks)} кликов · ${Math.round(impressions)} показов · ${impressions ? (clicks / impressions * 100).toFixed(2) : 0}% CTR`, 46, doc.y, { width });
      [...report.searchConsole].sort((a, b) => b.impressions - a.impressions).slice(0, 15).forEach((row) => {
        ensure(25); doc.fillColor('#4C514A').font(font).fontSize(8).text(row.key, 46, doc.y, { width: 300, ellipsis: true });
        doc.fillColor('#151714').font(fontBold).text(`${row.clicks} / ${row.impressions} · ${(row.ctr * 100).toFixed(2)}% · поз. ${row.position.toFixed(1)}`, 356, doc.y - 9, { width: 179, align: 'right' }); doc.x = 46; doc.moveDown(0.5);
      });
    }
    doc.moveDown(0.7); rule();
    doc.fillColor('#151714').font(fontBold).fontSize(15).text('Полный анализ контента по страницам', 46, doc.y, { width });
    doc.moveDown(0.7).fillColor('#777D74').font(font).fontSize(8).text('Баллы основаны на наблюдаемых HTML-сигналах и требуют редакторской проверки фактов, опыта и оригинальности.', 46, doc.y, { width });
    report.pages.forEach((page, index) => {
      const analysis = page.contentAnalysis;
      if (!analysis) return;
      ensure(130);
      doc.moveDown(0.7).fillColor('#151714').font(fontBold).fontSize(10).text(`${index + 1}. ${analysis.score}/100 (${analysis.grade}) · ${analysis.pageType} · ${analysis.searchIntent}`, 46, doc.y, { width });
      doc.moveDown(0.2).fillColor('#4C514A').font(font).fontSize(8).text(page.url, 46, doc.y, { width, ellipsis: true });
      doc.moveDown(0.3).text(`Интент ${analysis.dimensions.intent} · полнота ${analysis.dimensions.depth} · структура ${analysis.dimensions.structure} · читаемость ${analysis.dimensions.readability} · уникальность ${analysis.dimensions.originality}`, 46, doc.y, { width });
      doc.moveDown(0.2).text(`Опыт ${analysis.dimensions.experience} · экспертность ${analysis.dimensions.expertise} · доверие ${analysis.dimensions.trust} · ключи ${analysis.dimensions.keywordUse} · AI ${analysis.dimensions.aiReadiness}`, 46, doc.y, { width });
      doc.moveDown(0.2).text(`${page.wordCount} слов (ориентир ${analysis.minimumWords}) · ${analysis.readingTime} мин · длинных предложений ${analysis.longSentencePercent}% · риск повторов ${analysis.repetitionRisk}/100`, 46, doc.y, { width });
      if (analysis.recommendations.length) doc.moveDown(0.3).fillColor('#151714').text(analysis.recommendations.map((item, itemIndex) => `${itemIndex + 1}. ${item}`).join('\n'), 46, doc.y, { width, lineGap: 1 });
      doc.moveDown(0.5); rule();
    });
    doc.fillColor('#151714').font(fontBold).fontSize(15).text('Архитектура и обход', 46, doc.y, { width });
    doc.moveDown(0.7).fillColor('#4C514A').font(font).fontSize(9)
      .text(`Индексируемые: ${report.crawlInsights?.indexablePages ?? 0}/${report.pagesScanned}  •  Редиректы: ${report.crawlInsights?.redirectedPages ?? 0}  •  Сиротские: ${report.crawlInsights?.orphanPages ?? 0}  •  Глубже 3 кликов: ${report.crawlInsights?.deepPages ?? 0}`, 46, doc.y, { width });
    doc.moveDown(0.45).text(`Средний ответ: ${report.crawlInsights?.averageResponseTime ?? 0} мс  •  p95: ${report.crawlInsights?.p95ResponseTime ?? 0} мс  •  Эффективность обхода: ${report.crawlInsights?.crawlEfficiency ?? 0}%  •  URL с параметрами: ${report.crawlInsights?.parameterizedUrls ?? 0}`, 46, doc.y, { width });
    doc.moveDown(0.8).fillColor('#151714').font(fontBold).fontSize(10).text('Карты сайта', 46, doc.y, { width });
    (report.sitemaps || []).forEach((item) => {
      ensure(26); doc.fillColor(item.status >= 400 || !item.status ? '#C53228' : '#4C514A').font(fontBold).fontSize(8).text(`${item.status || 'ERR'} · ${item.type.toUpperCase()} · ${item.urls} URL`, 46, doc.y, { width: 150 });
      doc.fillColor('#4C514A').font(font).text(`${item.url}${item.lastmodCount ? ` · lastmod ${item.lastmodCount}` : ''}${item.invalidLastmod ? ` · ошибок дат ${item.invalidLastmod}` : ''}${item.futureLastmod ? ` · будущих ${item.futureLastmod}` : ''}${item.suspiciousUniformLastmod ? ' · одинаковые даты' : ''}`, 200, doc.y - 9, { width: 335, ellipsis: true }); doc.x = 46; doc.moveDown(0.5);
    });
    const unavailableLinks = (report.linkChecks || []).filter((item) => !item.ok);
    doc.moveDown(0.45).fillColor('#151714').font(fontBold).fontSize(10).text(`Проверка ссылок: ${report.linkChecks?.length || 0} проверено, ${unavailableLinks.length} недоступно`, 46, doc.y, { width });
    unavailableLinks.slice(0, 20).forEach((item) => { ensure(24); doc.fillColor('#C53228').font(fontBold).fontSize(8).text(String(item.status || 'ERR'), 46, doc.y, { width: 42 }); doc.fillColor('#4C514A').font(font).text(item.url, 92, doc.y - 9, { width: 443, ellipsis: true }); doc.x = 46; doc.moveDown(0.5); });
    doc.moveDown(0.5); rule();
    doc.fillColor('#151714').font(fontBold).fontSize(15).text('Что исправить в первую очередь', 46, doc.y, { width });
    doc.moveDown(0.8);
    issueGroups.forEach((group, index) => {
      const item = group[0]!;
      const urls = [...new Set(group.map((issue) => issue.url).filter((url): url is string => Boolean(url)))];
      const recommendations = [...new Set(group.map((issue) => issue.recommendation))];
      const observations = [...new Set(group.map((issue) => issue.description))];
      const urlText = urls.length > 1 ? `Затронуто URL: ${urls.length}\n${urls.slice(0, 20).map((url) => `- ${url}`).join('\n')}${urls.length > 20 ? `\n- и ещё ${urls.length - 20}` : ''}` : urls[0] || '';
      const bodyHeight = doc.font(font).fontSize(9).heightOfString(observations.join('\n'), { width, lineGap: 1 })
        + doc.heightOfString(`Решение: ${recommendations.join(' ')}`, { width, lineGap: 1 })
        + doc.fontSize(7.5).heightOfString(urlText, { width, lineGap: 1 }) + 58;
      ensure(Math.min(bodyHeight, doc.page.height - 92));
      const color = item.severity === 'critical' ? '#C53228' : item.severity === 'high' ? '#D77016' : item.severity === 'medium' ? '#A27A10' : '#637060';
      doc.fillColor(color).font(fontBold).fontSize(8).text(`${index + 1}. ${(labels[item.severity] || item.severity).toUpperCase()} / ${labels[item.category] || item.category}${group.length > 1 ? ` / ${group.length} URL` : ''}`, 46, doc.y, { width });
      doc.moveDown(0.28).fillColor('#151714').font(fontBold).fontSize(11).text(item.title, 46, doc.y, { width });
      doc.moveDown(0.25).fillColor('#4C514A').font(font).fontSize(9).text(observations.join('\n'), 46, doc.y, { width, lineGap: 1 });
      doc.moveDown(0.25).fillColor('#151714').font(font).fontSize(9).text(`Решение: ${recommendations.join(' ')}`, 46, doc.y, { width, lineGap: 1 });
      if (item.solutionSteps?.length) {
        doc.moveDown(0.25).fillColor('#4C514A').font(font).fontSize(8).text(item.solutionSteps.map((step, stepIndex) => `${stepIndex + 1}. ${step}`).join('\n'), 46, doc.y, { width, lineGap: 1 });
      }
      if (urlText) doc.moveDown(0.2).fillColor('#777D74').fontSize(7.5).text(urlText, 46, doc.y, { width, lineGap: 1 });
      doc.moveDown(0.75); rule();
    });
    ensure(70);
    doc.fillColor('#151714').font(fontBold).fontSize(15).text('Проверенные страницы', 46, doc.y, { width });
    doc.moveDown(0.7);
    report.pages.forEach((page) => {
      ensure(30);
      doc.fillColor('#151714').font(fontBold).fontSize(9).text(`${page.score}/100`, 46, doc.y, { width: 50 });
      doc.fillColor('#4C514A').font(font).text(page.url, 100, doc.y - 10, { width: 340, ellipsis: true });
      doc.fillColor('#777D74').fontSize(8).text(`контент ${page.contentScore ?? 0} · глубина ${page.depth ?? '—'} · ${page.incomingLinks ?? 0} ссылок`, 390, doc.y - 10, { width: 145, align: 'right' }); doc.x = 46;
      doc.moveDown(0.6);
    });
    doc.end();
    const pdf = await done;
    const host = new URL(report.url).hostname.replace(/[^a-z0-9.-]/gi, '-');
    return new Response(new Uint8Array(pdf), {
      headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="seo-audit-${host}.pdf"`, 'cache-control': 'no-store' },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Не удалось создать PDF' }, { status: 500 });
  }
};
