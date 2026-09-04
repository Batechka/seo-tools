import type { AuditIssue, AuditReport, PageAudit } from './types';

const makeIssue = (id: string, severity: AuditIssue['severity'], category: AuditIssue['category'], title: string, description: string, recommendation: string, url: string): AuditIssue => ({
  id, severity, category, title, description, recommendation, url,
  solutionSteps: [recommendation, 'Найдите общий шаблон или конфигурацию, из-за которой возникает проблема.', 'Внесите минимальное исправление без изменения дизайна и бизнес-логики.', 'Запустите сборку и повторно проверьте HTML, HTTP-ответ и затронутые страницы.'],
  codexPrompt: `Ты senior-разработчик и SEO-инженер. Исправь в текущем репозитории проблему «${title}» для URL ${url}. Наблюдение: ${description}. Требуемое решение: ${recommendation}. Сначала найди первопричину, затем внеси минимальное системное исправление. Не выдумывай бизнес-данные. Сохрани дизайн, маршруты и доступность. После изменений запусти сборку, перечисли изменённые файлы и объясни, как проверить результат.`,
});
const home = 'https://example-store.ru/';
const issues: AuditIssue[] = [
  makeIssue('demo-1', 'critical', 'indexing', 'Страница закрыта noindex', 'Каталог товаров исключён из индексации директивой robots.', 'Удалите noindex после проверки окружения и повторно отправьте URL на индексацию.', `${home}catalog`),
  makeIssue('demo-2', 'high', 'onpage', 'Отсутствует title', 'У страницы доставки нет собственного заголовка документа.', 'Добавьте уникальный title: «Доставка и оплата — Example Store».', `${home}delivery`),
  makeIssue('demo-3', 'high', 'indexing', 'sitemap.xml не найден', 'Карта сайта вернула HTTP 404.', 'Сформируйте XML Sitemap с каноническими URL и укажите её в robots.txt.', home),
  makeIssue('demo-4', 'medium', 'images', 'У изображений нет alt', 'У 7 карточек товаров отсутствует текстовая альтернатива.', 'Опишите товар и важную характеристику в alt без набора ключевых слов.', `${home}catalog`),
  makeIssue('demo-5', 'medium', 'performance', 'Ответ сервера можно ускорить', 'Главная страница ответила за 1380 мс.', 'Добавьте серверное кэширование и проверьте медленные запросы каталога.', home),
  makeIssue('demo-6', 'low', 'images', 'У responsive-изображения нет fallback src', 'В одном picture/srcset отсутствует обычный img src, поэтому ресурс может быть не обнаружен.', 'Добавьте стабильный HTTP(S) URL в img src, сохранив source/srcset для адаптивных вариантов.', home),
];
const demoChecks = (url: string): PageAudit['contentAnalysis']['checks'] => [
  { id: 'topic-alignment', label: 'Title, H1 и вступление согласованы', passed: true, severity: 'medium', evidence: 'Согласованность темы: 84/100.', recommendation: '', codexPrompt: '' },
  { id: 'content-depth', label: 'Тема раскрыта с достаточной полнотой', passed: true, severity: 'medium', evidence: '640 слов при ориентире 500.', recommendation: '', codexPrompt: '' },
  { id: 'heading-outline', label: 'Заголовки образуют понятную структуру', passed: true, severity: 'medium', evidence: 'Найдены H1 и тематические H2.', recommendation: '', codexPrompt: '' },
  { id: 'repetition', label: 'Нет заметного переспама', passed: true, severity: 'medium', evidence: 'Риск повторов: 12/100.', recommendation: '', codexPrompt: '' },
  { id: 'expertise', label: 'Утверждения подкреплены экспертностью', passed: false, severity: 'medium', evidence: 'Экспертность: 58/100.', recommendation: 'Добавьте реального ответственного эксперта и проверяемые источники.', codexPrompt: `Улучши экспертность страницы ${url} в текущем репозитории. Добавь только реальные сведения об ответственном эксперте и проверяемые источники. Ничего не выдумывай; если данных нет, перечисли вопросы владельцу. После изменения запусти сборку.` },
  { id: 'experience', label: 'Контент показывает реальный опыт', passed: false, severity: 'medium', evidence: 'Не хватает примеров и доказательств практического опыта.', recommendation: 'Добавьте реальные примеры, скриншоты или измеримые результаты.', codexPrompt: `Улучши сигналы реального опыта на странице ${url}. Найди исходный файл, добавь только существующие примеры, изображения или измеримые результаты. Не выдумывай кейсы и цифры. Если материалов нет, перечисли, что запросить у владельца.` },
];

const page = (url: string, title: string, score: number, pageIssues: AuditIssue[], extras: Partial<PageAudit> = {}): PageAudit => ({
  url, originalUrl: url, finalUrl: url, redirected: false, redirectChain: [], status: 200, responseTime: 480, contentType: 'text/html; charset=utf-8', title, titleLength: title.length,
  description: 'Демонстрационное описание страницы интернет-магазина.', descriptionLength: 53, h1: [title], h2Count: 4,
  canonical: url, robots: '', lang: 'ru', wordCount: 640, internalLinks: 24, externalLinks: 2, brokenLinks: 0,
  images: 8, imagesMissingAlt: 0, imagesMissingDimensions: 0, schemaTypes: ['Organization', 'WebSite'],
  schemaErrors: [],
  ogComplete: true, twitterComplete: true, hreflangCount: 0, score, issues: pageIssues,
  contentAnalysis: { score: 78, pageType: url === home ? 'homepage' : url.includes('catalog') ? 'category' : 'landing', searchIntent: url.includes('catalog') ? 'commercial' : 'navigational', minimumWords: url === home ? 500 : 400, grade: 'B', readingTime: 4, sentenceCount: 38, averageSentenceWords: 16.8, longSentencePercent: 13, primaryTopic: title, firstParagraph: 'Демонстрационный первый абзац страницы.', outline: [`H1: ${title}`, 'H2: Основная информация', 'H2: Условия и ответы'], ctaFound: true, sourceLinks: 2, factsAndNumbers: 8, repetitionRisk: 12, dimensions: { intent: 84, depth: 76, structure: 82, readability: 82, originality: 78, experience: 61, expertise: 58, trust: 74, keywordUse: 79, aiReadiness: 66 }, strengths: ['соответствие интенту: 84/100', 'структура: 82/100'], weaknesses: ['экспертность: 58/100'], recommendations: ['Добавьте автора или ответственного эксперта и подкрепите проверяемые утверждения источниками.'], checks: demoChecks(url), codexPrompt: `Улучши контент страницы ${url} в текущем репозитории по результатам SEO-аудита. Сохрани интент и дизайн, добавь только реальные доказательства экспертности и опыта и не выдумывай факты, автора, отзывы или источники. После изменений запусти сборку и объясни проверку.` },
  contentScore: 78, readabilityScore: 82, paragraphs: 9, lists: 2, tables: 0, questions: 3,
  authorFound: false, dateFound: false, trustSignals: 3, aiCitationScore: 66, htmlBytes: 68400, domNodes: 742,
  scripts: 9, thirdPartyScripts: 2, stylesheets: 3, textHtmlRatio: 18.4, hasFavicon: true,
  formsMissingLabels: 0, emptyLinks: 0, headingOrderIssues: 0,
  depth: 1, incomingLinks: 5, urlParameters: [], indexable: true, cwvRisks: { lcp: 1, inp: 0, cls: 0 },
  keywordMetrics: [
    { keyword: 'товары для дома', count: url === home ? 5 : 1, density: url === home ? 0.78 : 0.19, inTitle: url === home, inDescription: true, inH1: url === home, inFirst100Words: true, inUrl: false },
    { keyword: 'доставка', count: url.endsWith('/delivery') ? 7 : 1, density: url.endsWith('/delivery') ? 1.12 : 0.16, inTitle: url.endsWith('/delivery'), inDescription: url.endsWith('/delivery'), inH1: url.endsWith('/delivery'), inFirst100Words: true, inUrl: url.endsWith('/delivery') },
  ],
  topTerms: [{ term: 'товары', count: 14, density: 2.1 }, { term: 'доставка', count: 7, density: 1.08 }, { term: 'интерьер', count: 6, density: 0.94 }],
  ...extras,
});

export const demoReport: AuditReport = {
  id: 'demo-report', url: home, origin: home, createdAt: new Date().toISOString(), duration: 6840,
  score: 68, grade: 'C', pagesScanned: 3, crawlLimit: 25,
  totals: { critical: 1, high: 2, medium: 2, low: 1, issues: 6 },
  categoryScores: { indexing: 42, onpage: 66, content: 92, links: 88, images: 74, schema: 91, performance: 71, social: 96, ai: 80 },
  targetKeywords: ['товары для дома', 'доставка'],
  keywordSummary: [
    { keyword: 'товары для дома', totalCount: 7, pageCoverage: 100, averageDensity: 0.39, titleCoverage: 33, h1Coverage: 33, descriptionCoverage: 100 },
    { keyword: 'доставка', totalCount: 9, pageCoverage: 100, averageDensity: 0.48, titleCoverage: 33, h1Coverage: 33, descriptionCoverage: 33 },
  ],
  topTerms: [
    { term: 'товары', count: 38, density: 1.98, pages: 3 }, { term: 'доставка', count: 18, density: 0.94, pages: 3 },
    { term: 'интерьер', count: 15, density: 0.78, pages: 2 }, { term: 'оплата', count: 11, density: 0.57, pages: 2 },
  ],
  contentSummary: { averageContentScore: 78, averageReadability: 82, thinPages: 0, pagesWithoutAuthor: 0, pagesWithoutTrustSignals: 0, averageAiCitationScore: 66, averageDimensions: { intent: 84, depth: 76, structure: 82, readability: 82, originality: 78, experience: 61, expertise: 58, trust: 74, keywordUse: 79, aiReadiness: 66 }, weakIntentPages: 0, lowExperiencePages: 1, highRepetitionPages: 0 },
  duplicates: { titles: [], descriptions: [], h1: [], content: [] },
  crawl: { discovered: 46, crawled: 3, sitemapUrls: 0, blockedByRobots: 2, brokenInternal: 0 },
  sitemaps: [{ url: `${home}sitemap.xml`, status: 404, type: 'unknown', urls: 0, invalidUrls: 0, error: 'HTTP 404' }],
  linkChecks: [
    { url: `${home}catalog`, kind: 'internal', status: 200, ok: true, responseTime: 240, redirectChain: [], sourceUrls: [home] },
    { url: 'https://social.example/store', kind: 'external', status: 200, ok: true, responseTime: 510, redirectChain: [], sourceUrls: [home] },
  ],
  crawlInsights: {
    statusGroups: { ok: 3, redirects: 0, clientErrors: 0, serverErrors: 0, failed: 0 },
    averageResponseTime: 780, p95ResponseTime: 1380, indexablePages: 2, nonIndexablePages: 1,
    redirectedPages: 0, orphanPages: 0, deepPages: 0, parameterizedUrls: 0, sitemapProblemUrls: 0,
    maxDepth: 2, crawlEfficiency: 7,
  },
  anchorTexts: [{ text: 'каталог', count: 14, targets: 1 }, { text: 'доставка и оплата', count: 7, targets: 1 }, { text: 'подробнее', count: 5, targets: 4 }],
  technical: {
    https: true, robotsFound: true, robotsStatus: 200, sitemapFound: false, sitemapStatus: 404, llmsFound: false,
    aiBotsBlocked: [], securityHeaders: { 'strict-transport-security': true, 'content-security-policy': false, 'x-content-type-options': true, 'referrer-policy': true },
  },
  issues,
  pages: [
    page(home, 'Example Store — товары для дома', 82, issues.filter((item) => item.url === home), { depth: 0, incomingLinks: 18, outgoingInternalUrls: [`${home}catalog`], responseTime: 1380, cwvRisks: { lcp: 2, inp: 0, cls: 0 } }),
    page(`${home}catalog`, 'Каталог товаров — Example Store', 44, issues.filter((item) => item.url?.endsWith('/catalog')), { robots: 'noindex, follow', imagesMissingAlt: 7, indexable: false, depth: 1, incomingLinks: 12, outgoingInternalUrls: [home] }),
    page(`${home}delivery`, '', 61, issues.filter((item) => item.url?.endsWith('/delivery')), { titleLength: 0, depth: 2, incomingLinks: 4, outgoingInternalUrls: [home] }),
  ],
};
