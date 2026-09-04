import type { AuditIssue, AuditReport } from './types';

const severityLabels = { critical: 'Критично', high: 'Высокий', medium: 'Средний', low: 'Низкий' } as const;
const categoryLabels = {
  indexing: 'Индексация', onpage: 'On-page SEO', content: 'Контент', links: 'Внутренние ссылки',
  images: 'Изображения', schema: 'Schema.org', performance: 'Скорость и UX', social: 'Соцсети', ai: 'AI-поиск',
} as const;

const unique = <T>(items: T[]) => [...new Set(items)];

export function issueGroupKey(item: AuditIssue) {
  return `${item.severity}|${item.category}|${item.title.trim().toLocaleLowerCase('ru-RU')}`;
}

export function groupAuditIssues(items: AuditIssue[]) {
  return [...items.reduce((groups, item) => {
    const key = issueGroupKey(item);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
    return groups;
  }, new Map<string, AuditIssue[]>()).values()];
}

function urlsFor(group: AuditIssue[]) {
  return unique(group.map((item) => item.url).filter((url): url is string => Boolean(url)));
}

export function buildGroupedIssuePrompt(group: AuditIssue[], siteUrl = '') {
  const first = group[0];
  if (!first) return '';
  const urls = urlsFor(group);
  const observations = unique(group.map((item) => item.description)).slice(0, 8);
  const recommendations = unique(group.map((item) => item.recommendation)).slice(0, 5);
  const scope = urls.length > 1
    ? `Проблема повторяется на ${urls.length} URL. Сначала найди общую первопричину в layout, компоненте, генераторе метаданных, CMS-модели или конфигурации.`
    : 'Проверь, является ли проблема локальной для страницы или вызвана общим шаблоном.';

  return `Ты senior SEO-инженер, контент-архитектор и разработчик. Работаешь в текущем репозитории сайта.

ЦЕЛЬ
Исправить первопричину проблемы «${first.title}», а не повторять одно и то же изменение вручную на каждой странице.

КОНТЕКСТ
Сайт: ${siteUrl || first.url || 'определи по проекту'}
Приоритет: ${severityLabels[first.severity]}
Направление: ${categoryLabels[first.category]}
${scope}

ЗАТРОНУТЫЕ URL (${urls.length || 1})
${urls.length ? urls.slice(0, 50).map((url) => `- ${url}`).join('\n') : `- ${siteUrl || 'определи по маршрутам проекта'}`}

НАБЛЮДАЕМЫЕ ФАКТЫ
${observations.map((item) => `- ${item}`).join('\n')}

ОЖИДАЕМЫЙ РЕЗУЛЬТАТ
${recommendations.map((item) => `- ${item}`).join('\n')}

ПОРЯДОК РАБОТЫ
1. Составь инвентарь затронутых маршрутов и найди общий источник данных или шаблон. Не считай HTML-эвристику доказательством: перепроверь факт в исходном и отрендеренном HTML.
2. Зафиксируй короткий план до изменений: первопричина → файлы → критерий готовности → риск регрессии.
3. Исправь общий источник. Точечные исключения делай только когда у страниц действительно разные интенты или бизнес-требования.
4. Не выдумывай ключи, частотность, автора, опыт, контакты, отзывы, цены, даты, рейтинги и Schema.org. Если нужны данные владельца, вынеси их отдельным списком.
5. Сохрани маршруты, дизайн, доступность и аналитику. Для контента разведи поисковые интенты и не увеличивай текст ради числа слов.
6. Запусти типизацию, тесты и production-сборку. Затем повторно проверь каждый URL, общий шаблон, sitemap/robots/canonical и мобильную версию, если они затронуты.
7. В финале покажи таблицу: URL/шаблон → было → стало → проверка. Отдельно перечисли то, что требует Search Console, Wordstat, полевых CWV или решения владельца.

КРИТЕРИЙ ГОТОВНОСТИ
Проблема исчезла на всех затронутых URL, соседние страницы не сломаны, а повторный аудит подтверждает результат.`;
}

export function buildMasterAuditPrompt(report: AuditReport) {
  const groups = groupAuditIssues(report.issues).slice(0, 30);
  const groupedTasks = groups.map((group, index) => {
    const first = group[0]!;
    const urls = urlsFor(group);
    const samples = urls.slice(0, 8);
    return `${index + 1}. [${severityLabels[first.severity]} / ${categoryLabels[first.category]}] ${first.title}
Охват: ${urls.length || 1} URL${samples.length ? ` — ${samples.join(', ')}` : ''}
Факт: ${first.description}
Результат: ${first.recommendation}`;
  }).join('\n\n');

  return `Ты независимый senior SEO-аудитор, SEO-инженер, контент-архитектор и разработчик. Проведи полный цикл AUDIT → PLAN → FIX → REAUDIT в текущем репозитории.

ИСХОДНЫЕ ДАННЫЕ
Сайт: ${report.url}
Оценка SiteScan: ${report.score}/100
Проверено страниц: ${report.pagesScanned} из лимита ${report.crawlLimit}
Найдено сигналов: ${report.totals.issues}; уникальных групп первопричин: ${groups.length}
Приоритеты: критичных ${report.totals.critical}, высоких ${report.totals.high}, средних ${report.totals.medium}, низких ${report.totals.low}
Архитектура: индексируемых ${report.crawlInsights.indexablePages}, неиндексируемых ${report.crawlInsights.nonIndexablePages}, сиротских ${report.crawlInsights.orphanPages}, глубже 3 кликов ${report.crawlInsights.deepPages}, редиректов ${report.crawlInsights.redirectedPages}, URL с параметрами ${report.crawlInsights.parameterizedUrls}
Контент: средняя оценка ${report.contentSummary.averageContentScore}/100, слабый интент у ${report.contentSummary.weakIntentPages}, низкий опыт у ${report.contentSummary.lowExperiencePages}, высокий риск повторов у ${report.contentSummary.highRepetitionPages}

ЗАДАЧИ, СГРУППИРОВАННЫЕ ПО ПЕРВОПРИЧИНЕ
${groupedTasks || 'Автоматический аудит не нашёл ошибок. Проведи ручную проверку интента, фактов, шаблонных повторов и бизнес-ограничений.'}

ОБЯЗАТЕЛЬНЫЙ ПРОЦЕСС
1. INVENTORY: собери все индексируемые URL из manifest/роутов, sitemap, навигации, footer и внутреннего crawl. Сопоставь наборы и не называй аудит полным, если проверен только сэмпл.
2. INTENT MAP: для каждой страницы зафиксируй primary query, secondary queries, интент, user job и назначение. Не меняй семантику без реальных данных Wordstat/Search Console; гипотезы помечай как гипотезы.
3. CANNIBALIZATION: сравни title, H1, вступление, содержание, FAQ и анкоры. Разведи разные задачи; объединяй только реально одинаковые интенты.
4. ACTION PLAN: до правок сгруппируй проблемы по общему layout, компоненту, данным, CMS или серверной конфигурации. Порядок: индексирование → HTTP/canonical/robots/sitemap → интенты и дубли → контент → ссылки → schema/images/social → производительность.
5. FIX: исправляй первопричину один раз в общем источнике. Не выдумывай факты, опыт, авторов, отзывы, цены, даты, рейтинги, контакты и структурированные данные.
6. REAUDIT: пересобери проект, повторно обойди все индексируемые страницы и сравни BEFORE/AFTER. Проверь HTML, заголовки, ссылки, structured data, viewport 360/390/768/1024/1440 и консоль браузера.
7. REPORT: дай таблицу «группа проблемы → охват → первопричина → файлы → исправление → доказательство». Отдельно укажи ограничения, требующие production, Search Console, Wordstat, логов или полевых CWV.

ПРАВИЛА
- SiteScan использует объяснимые эвристики: подтверждай каждый сигнал в коде и реальном HTML.
- Не создавай страницы и текст только ради ключей или минимального числа слов.
- Для коммерческих инструментов сначала проверяй соответствие интерфейса интенту, затем SEO-текст.
- Не останавливайся после анализа: реализуй все безопасные исправления, для которых достаточно данных.
- Готово только когда повторная проверка подтверждает закрытие критичных и высоких проблем без регрессий.`;
}
