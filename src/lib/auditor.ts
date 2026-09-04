import * as cheerio from 'cheerio';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { safeFetch, safeFetchDetailed, validatePublicUrl } from './security';
import { buildGroupedIssuePrompt } from './issue-planning';
import type { AuditIssue, AuditProgress, AuditReport, Category, ContentAnalysis, KeywordMetric, LinkCheck, PageAudit, RedirectHop, Severity, SitemapAudit, TopTerm } from './types';

const categoryWeights: Record<Category, number> = {
  indexing: 22, onpage: 20, content: 12, links: 10, images: 8,
  schema: 8, performance: 10, social: 4, ai: 6,
};
const severityPenalty: Record<Severity, number> = { critical: 16, high: 9, medium: 5, low: 2 };
const securityHeaderNames = ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'referrer-policy'] as const;

const clean = (value = '') => value.replace(/\s+/g, ' ').trim();
const words = (value: string) => clean(value).split(/\s+/).filter(Boolean).length;
const stopWords = new Set(`и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем сказать всех никогда сегодня можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между the and for are with that this from you your not but was has have into our they will can all use how what when where who why its it is to of in on at as by be or an a`.split(/\s+/));
const textTokens = (value: string) => (value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) || []).filter((token) => !stopWords.has(token) && !/^\d+$/.test(token));
const countPhrase = (text: string, phrase: string) => {
  const normalizedText = clean(text).toLowerCase();
  const normalizedPhrase = clean(phrase).toLowerCase();
  if (!normalizedPhrase) return 0;
  const escaped = normalizedPhrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (normalizedText.match(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu')) || []).length;
};
const topTermsFor = (text: string, wordCount: number, limit = 12): TopTerm[] => {
  const frequencies = new Map<string, number>();
  textTokens(text).forEach((token) => frequencies.set(token, (frequencies.get(token) || 0) + 1));
  return [...frequencies.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([term, count]) => ({ term, count, density: Number((count / Math.max(1, wordCount) * 100).toFixed(2)) }));
};
const readabilityFor = (text: string) => {
  const tokens = textTokens(text);
  const sentences = Math.max(1, (text.match(/[.!?]+(?:\s|$)/g) || []).length);
  const avgSentence = tokens.length / sentences;
  const longShare = tokens.filter((token) => token.length > 10).length / Math.max(1, tokens.length) * 100;
  return Math.max(0, Math.min(100, Math.round(100 - Math.max(0, avgSentence - 14) * 2.1 - longShare * 1.4)));
};
const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const scoreContentDimensions = (dimensions: ContentAnalysis['dimensions']) => clampScore(dimensions.intent * .14 + dimensions.depth * .14 + dimensions.structure * .11 + dimensions.readability * .09 + dimensions.originality * .10 + dimensions.experience * .10 + dimensions.expertise * .10 + dimensions.trust * .10 + dimensions.keywordUse * .06 + dimensions.aiReadiness * .06);
const blankContentAnalysis = (topic = ''): ContentAnalysis => ({
  score: 0, pageType: 'landing', searchIntent: 'mixed', minimumWords: 600, grade: 'F', readingTime: 0, sentenceCount: 0,
  averageSentenceWords: 0, longSentencePercent: 0, primaryTopic: topic, firstParagraph: '', outline: [], ctaFound: false,
  sourceLinks: 0, factsAndNumbers: 0, repetitionRisk: 0,
  dimensions: { intent: 0, depth: 0, structure: 0, readability: 0, originality: 0, experience: 0, expertise: 0, trust: 0, keywordUse: 0, aiReadiness: 0 },
  strengths: [], weaknesses: ['Контент страницы недоступен для анализа'], recommendations: ['Восстановите доступность HTML и повторите аудит.'], checks: [], codexPrompt: `Восстанови доступность HTML страницы ${topic}, затем повтори SEO-аудит. Не выдумывай содержимое страницы.`,
});

function analyzeContentQuality(input: {
  url: URL; title: string; headings: string[]; outline: string[]; description: string; bodyText: string; firstParagraph: string;
  wordCount: number; paragraphs: number; lists: number; tables: number; questions: number; images: number; internalLinks: number;
  externalLinks: number; authorFound: boolean; dateFound: boolean; trustSignals: number; schemas: string[]; readabilityScore: number;
  aiCitationScore: number; keywordMetrics: KeywordMetric[]; ctaFound: boolean;
}): ContentAnalysis {
  const { url, title, headings, outline, description, bodyText, firstParagraph, wordCount, paragraphs, lists, tables, questions, images, internalLinks, externalLinks, authorFound, dateFound, trustSignals, schemas, readabilityScore, aiCitationScore, keywordMetrics, ctaFound } = input;
  const path = url.pathname.toLowerCase(); const lower = bodyText.toLowerCase();
  const pageType: ContentAnalysis['pageType'] = path === '/' ? 'homepage'
    : schemas.some((type) => /Product/i.test(type)) || /\/(product|tovar|shop)\//.test(path) ? 'product'
    : schemas.some((type) => /Article|BlogPosting|NewsArticle/i.test(type)) || /\/(blog|article|news|stat|journal)\//.test(path) ? 'article'
    : schemas.some((type) => /FAQPage/i.test(type)) || /\/(faq|questions|vopros)/.test(path) ? 'faq'
    : /\/(about|o-kompanii|company)/.test(path) ? 'about'
    : /\/(contact|kontakty|contacts)/.test(path) ? 'contact'
    : /\/(catalog|category|collection|kategori)/.test(path) ? 'category'
    : /\/(service|services|uslugi|solution)/.test(path) ? 'service' : 'landing';
  const hasLocalSignals = /(?:адрес|как добраться|рядом|город|область|address|directions|near me)/i.test(bodyText) && trustSignals >= 2;
  const searchIntent: ContentAnalysis['searchIntent'] = hasLocalSignals ? 'local'
    : pageType === 'article' || pageType === 'faq' ? 'informational'
    : pageType === 'product' ? 'transactional'
    : ['service', 'category', 'landing'].includes(pageType) ? 'commercial'
    : ['about', 'contact', 'homepage'].includes(pageType) ? 'navigational' : 'mixed';
  const minimumWords = ({ homepage: 500, service: 800, landing: 600, article: 1500, product: 400, category: 400, about: 400, contact: 200, faq: 800 } as const)[pageType];
  const sentences = bodyText.split(/[.!?]+(?:\s|$)/).map(clean).filter(Boolean);
  const sentenceLengths = sentences.map(words); const sentenceCount = sentences.length;
  const averageSentenceWords = Number((sentenceLengths.reduce((sum, value) => sum + value, 0) / Math.max(1, sentenceCount)).toFixed(1));
  const longSentencePercent = Math.round(sentenceLengths.filter((value) => value > 24).length / Math.max(1, sentenceCount) * 100);
  const factsAndNumbers = (bodyText.match(/\b\d+(?:[.,]\d+)?(?:\s?%|\s?(?:₽|руб|€|\$|лет|дней|часов|км|kg|years?|days?))?\b/gi) || []).length;
  const sourceLinks = externalLinks;
  const experienceMarkers = (lower.match(/\b(?:наш опыт|мы проверили|мы протестировали|кейс|пример из практики|результат|до и после|our experience|we tested|case study|first-hand)\b/g) || []).length;
  const expertiseMarkers = (lower.match(/\b(?:исследован|источник|методолог|по данным|статистик|эксперт|сертифик|research|source|methodology|according to|expert)\b/g) || []).length;
  const primaryTerms = new Set(textTokens(`${title} ${headings[0] || ''}`).slice(0, 8));
  const introTerms = new Set(textTokens(firstParagraph).slice(0, 40));
  const topicAlignment = primaryTerms.size ? [...primaryTerms].filter((term) => introTerms.has(term)).length / primaryTerms.size : 0;
  const topFrequency = topTermsFor(bodyText, wordCount, 1)[0]?.density || 0;
  const repetitionRisk = wordCount < 150 ? 0 : clampScore(Math.max(0, (topFrequency - 2.5) * 22) + keywordMetrics.reduce((risk, item) => Math.max(risk, item.density > 3.5 ? Math.min(100, item.density * 18) : 0), 0));
  const keywordUse = keywordMetrics.length ? clampScore(keywordMetrics.reduce((sum, item) => sum + Math.min(100, (item.count ? 35 : 0) + (item.inTitle ? 20 : 0) + (item.inH1 ? 20 : 0) + (item.inFirst100Words ? 15 : 0) + (item.density > 0 && item.density <= 3.5 ? 10 : 0) - (item.density > 3.5 ? 35 : 0)), 0) / keywordMetrics.length) : 70;
  const dimensions: ContentAnalysis['dimensions'] = {
    intent: clampScore(topicAlignment * 55 + (title ? 15 : 0) + (headings.length ? 15 : 0) + ((searchIntent === 'informational' && (questions || outline.length >= 4)) || (['commercial', 'transactional', 'local'].includes(searchIntent) && ctaFound) || searchIntent === 'navigational' ? 15 : 0)),
    depth: clampScore(Math.min(72, wordCount / minimumWords * 72) + Math.min(12, outline.length * 2) + Math.min(8, lists * 3) + Math.min(8, tables * 4)),
    structure: clampScore((headings.length === 1 ? 22 : headings.length ? 12 : 0) + Math.min(28, outline.length * 4) + Math.min(22, paragraphs * 2) + Math.min(14, lists * 4) + Math.min(14, tables * 5)),
    readability: readabilityScore,
    originality: clampScore(88 - Math.max(0, topFrequency - 4) * 7),
    experience: clampScore(experienceMarkers * 16 + Math.min(28, factsAndNumbers * 3) + Math.min(18, images * 3) + (dateFound ? 12 : 0) + (authorFound ? 14 : 0)),
    expertise: clampScore((authorFound ? 24 : 0) + (dateFound ? 10 : 0) + Math.min(24, expertiseMarkers * 10) + Math.min(20, sourceLinks * 5) + Math.min(12, factsAndNumbers * 2) + (schemas.some((type) => /Article|Person|Organization|Product/i.test(type)) ? 10 : 0)),
    trust: clampScore(trustSignals / 6 * 64 + (authorFound ? 12 : 0) + (dateFound ? 8 : 0) + (url.protocol === 'https:' ? 10 : 0) + (description ? 6 : 0)),
    keywordUse,
    aiReadiness: aiCitationScore,
  };
  const weighted = scoreContentDimensions(dimensions);
  const labels: Array<[keyof ContentAnalysis['dimensions'], string]> = [['intent','соответствие интенту'],['depth','полнота темы'],['structure','структура'],['readability','читабельность'],['originality','уникальность'],['experience','реальный опыт'],['expertise','экспертность'],['trust','доверие'],['keywordUse','ключевые фразы'],['aiReadiness','AI-цитируемость']];
  const strengths = labels.filter(([key]) => dimensions[key] >= 75).sort((a, b) => dimensions[b[0]] - dimensions[a[0]]).slice(0, 4).map(([key, label]) => `${label}: ${dimensions[key]}/100`);
  const weaknesses = labels.filter(([key]) => dimensions[key] < 60).sort((a, b) => dimensions[a[0]] - dimensions[b[0]]).slice(0, 5).map(([key, label]) => `${label}: ${dimensions[key]}/100`);
  const recommendations: string[] = [];
  if (dimensions.intent < 60) recommendations.push('Уточните одну главную задачу страницы и согласуйте title, H1 и первый абзац с этим интентом.');
  if (dimensions.depth < 60) recommendations.push(`Раскройте тему до полезной полноты для типа «${pageType}»: сейчас ${wordCount} слов, ориентир — около ${minimumWords}, но добавляйте только факты и ответы.`);
  if (dimensions.structure < 60) recommendations.push('Добавьте логичные H2/H3, короткие абзацы, списки или таблицу там, где они ускоряют поиск ответа.');
  if (dimensions.experience < 55) recommendations.push('Добавьте реальные примеры, собственные наблюдения, изображения, кейс или конкретные результаты без вымышленных доказательств.');
  if (dimensions.expertise < 55) recommendations.push('Укажите автора или ответственного эксперта и подкрепите проверяемые утверждения релевантными источниками.');
  if (dimensions.trust < 60) recommendations.push('Усилите прозрачность: авторство, дата обновления, контакты, условия, политика и сведения о компании.');
  if (repetitionRisk >= 45) recommendations.push('Снизьте повторяемость ведущих терминов и точных ключей; замените шаблонные повторы конкретными подробностями.');
  if (dimensions.aiReadiness < 60) recommendations.push('Добавьте короткие самостоятельные ответы, определения, факты и структурированные сравнения, которые можно корректно процитировать.');
  const checks: ContentAnalysis['checks'] = [];
  const addCheck = (id: string, label: string, passed: boolean, evidence: string, recommendation: string, severity: Severity = 'medium') => {
    const acceptanceByCheck: Record<string, string> = {
      'topic-alignment': 'Title, H1, первый смысловой абзац и основной CTA обслуживают один user job, но не повторяют механически одну фразу.',
      'first-paragraph': 'Первый абзац без воды объясняет аудиторию, задачу и ожидаемый результат; факты соответствуют продукту.',
      'content-depth': 'Закрыты недостающие вопросы, условия, ограничения и следующий шаг; текст не увеличен только ради объёма.',
      'heading-outline': 'Один H1, последовательные H2/H3 и каждый раздел отвечает на самостоятельный вопрос.',
      paragraphs: 'Текст разбит по смыслу, нет стен текста и искусственных абзацев из одного предложения.',
      'sentence-length': 'Сложные предложения упрощены без потери фактов; списки используются для условий и последовательностей.',
      'content-format': 'Список, таблица или сравнение добавлены только там, где ускоряют понимание.',
      questions: 'Страница отвечает на реальные вопросы интента; FAQ не создан ради rich result.',
      cta: 'Следующее действие видно, однозначно и соответствует стадии спроса пользователя.',
      'internal-links': 'Добавлены только релевантные ссылки с описательными анкорами; целевые URL отвечают 200 и каноничны.',
      author: 'Указан только реальный автор/ответственный с проверяемой ролью либо подготовлен список данных, которые должен дать владелец.',
      freshness: 'Видимая дата и machine-readable дата совпадают и отражают реальную публикацию/существенное обновление.',
      trust: 'Добавлены реальные контакты, условия, политика, сведения о компании или авторство; вымышленных сигналов нет.',
      experience: 'Есть реальные примеры, процесс, ограничения, скриншоты или результаты; если материалов нет — запрошены у владельца.',
      expertise: 'Проверяемые утверждения связаны с реальным экспертом и/или первичными источниками.',
      evidence: 'Общие обещания заменены проверяемыми условиями, примерами или ограничениями без вымышленных цифр.',
      'keyword-targeting': 'Одна основная фраза назначена одной странице; употребление естественное, каннибализация проверена вручную.',
      repetition: 'Механические повторы удалены, смысл и тематическая полнота сохранены.',
      'ai-answerability': 'Ключевые ответы понятны вне контекста, содержат факты/ограничения и пригодны для корректного цитирования.',
      'visual-proof': 'Изображения показывают реальный продукт, процесс или результат, имеют корректные alt и размеры.',
      'schema-fit': 'JSON-LD соответствует типу и видимому содержанию страницы и проходит валидатор без вымышленных данных.',
    };
    const acceptance = acceptanceByCheck[id] || 'Повторная проверка подтверждает устранение наблюдаемого факта без ухудшения соседних страниц.';
    const codexPrompt = passed ? '' : `Ты senior SEO-редактор, контент-архитектор и разработчик. Исправь одну подтверждённую проблему страницы в текущем репозитории.

URL: ${url.toString()}
Тип страницы: ${pageType}
Вероятный интент: ${searchIntent}
Главная тема: ${headings[0] || title || url.pathname}
Проверка: ${label}
Наблюдаемый факт: ${evidence}
Рекомендация: ${recommendation}
Критерий готовности: ${acceptance}

1. Найди маршрут, источник контента и общий шаблон. Перепроверь сигнал в исходном HTML: автоматическая эвристика может ошибаться.
2. Сформулируй user job страницы и сравни его с title, H1, первым экраном, содержанием и CTA. Не меняй интент только ради прохождения метрики.
3. Внеси минимальное содержательное исправление. Если проблема общая для шаблона — исправь источник один раз и проверь все использующие его URL.
4. Не выдумывай ключи, частотность, факты, автора, опыт, отзывы, сертификаты, даты, цены или источники. Недостающие бизнес-данные оформи вопросами владельцу.
5. Запусти типизацию и production-сборку, затем повторно проверь HTML и соседние страницы.
6. Покажи результат: файл/шаблон → было → стало → доказательство проверки → оставшиеся ограничения.`;
    checks.push({ id, label, passed, severity, evidence, recommendation, codexPrompt });
  };
  const informational = searchIntent === 'informational'; const commercial = ['commercial', 'transactional', 'local'].includes(searchIntent);
  const suggestedInternalLinks = pageType === 'article' ? 5 : pageType === 'service' ? 3 : pageType === 'product' ? 2 : 1;
  addCheck('topic-alignment', 'Title, H1 и вступление согласованы', dimensions.intent >= 60, 'Согласованность главной темы оценена в ' + dimensions.intent + '/100.', 'Сформулируйте одну задачу страницы и согласуйте title, H1 и первый абзац без механического повторения ключа.');
  addCheck('first-paragraph', 'Есть содержательное вступление', words(firstParagraph) >= 25, 'В первом абзаце ' + words(firstParagraph) + ' слов.', 'В начале страницы кратко объясните, для кого она, какую задачу решает и что читатель получит дальше.');
  addCheck('content-depth', 'Тема раскрыта с достаточной полнотой', dimensions.depth >= 60, `${wordCount} слов при ориентире около ${minimumWords} для типа ${pageType}; полнота ${dimensions.depth}/100.`, 'Добавьте недостающие условия, примеры, ограничения, сравнения и ответы — только если они полезны пользователю.');
  addCheck('heading-outline', 'Заголовки образуют понятную структуру', outline.length >= (wordCount > 700 ? 4 : 2), 'Найдено элементов H1–H3: ' + outline.length + '.', 'Разбейте материал на смысловые разделы H2/H3, которые отвечают на отдельные вопросы пользователя.');
  addCheck('paragraphs', 'Текст разбит на удобные абзацы', wordCount < 300 || paragraphs >= Math.max(3, Math.floor(wordCount / 180)), `${wordCount} слов размещены в ${paragraphs} абзацах.`, 'Разделите длинные блоки на короткие смысловые абзацы, не дробя связанные мысли.');
  addCheck('sentence-length', 'Предложения читаются без перегрузки', longSentencePercent <= 25 && averageSentenceWords <= 22, `Средняя длина ${averageSentenceWords} слов; длинных предложений ${longSentencePercent}%.`, 'Сократите перегруженные предложения, вынесите условия в списки и объясните сложные термины.');
  addCheck('content-format', 'Для длинного материала есть списки или таблицы', wordCount < 700 || lists + tables > 0, `При ${wordCount} словах найдено списков ${lists}, таблиц ${tables}.`, 'Добавьте список, таблицу или сравнение только там, где формат ускоряет понимание и выбор.');
  addCheck('questions', 'Информационный материал отвечает на вопросы', !informational || questions >= 2 || outline.some((item) => /\?|как|что|почему|when|how|what|why/i.test(item)), `Вопросительных формулировок найдено: ${questions}.`, 'Добавьте секции с естественными вопросами аудитории и короткими точными ответами, не создавая FAQ ради разметки.');
  addCheck('cta', 'Есть понятное следующее действие', !commercial || ctaFound, ctaFound ? 'CTA найден.' : 'На коммерческой странице не найден явный CTA.', 'Добавьте конкретное следующее действие, соответствующее интенту: запросить условия, связаться, выбрать вариант или оформить заказ.');
  addCheck('internal-links', 'Достаточно контекстных внутренних ссылок', internalLinks >= suggestedInternalLinks, `Внутренних ссылок: ${internalLinks}; ориентир для типа страницы — от ${suggestedInternalLinks}.`, 'Добавьте релевантные контекстные ссылки с описательными анкорами на следующий полезный шаг.');
  addCheck('author', 'Авторство прозрачно', !['article', 'about'].includes(pageType) && wordCount < 900 || authorFound, authorFound ? 'Автор найден.' : 'Автор или ответственный эксперт не найден.', 'Укажите реального автора или владельца материала и его релевантную роль; не создавайте вымышленную персону.');
  addCheck('freshness', 'Для публикации указана дата', pageType !== 'article' || dateFound, dateFound ? 'Дата публикации/обновления найдена.' : 'У статьи не найдена дата.', 'Покажите настоящую дату публикации и обновления; обновляйте её только при содержательном изменении материала.');
  addCheck('trust', 'Есть достаточные сигналы доверия', dimensions.trust >= 60, `Доверие оценено в ${dimensions.trust}/100; явных сигналов ${trustSignals} из 6.`, 'Добавьте доступные сведения о компании, контакты, условия, политику и ответственное авторство, используя только реальные данные.');
  addCheck('experience', 'Контент показывает реальный опыт', wordCount < 400 || dimensions.experience >= 50, `Опыт оценён в ${dimensions.experience}/100; маркеров примеров ${experienceMarkers}, фактов/чисел ${factsAndNumbers}.`, 'Добавьте реальные примеры, процесс, ограничения, скриншоты, фотографии или измеримые результаты.');
  addCheck('expertise', 'Утверждения подкреплены экспертностью', wordCount < 500 || dimensions.expertise >= 50, `Экспертность ${dimensions.expertise}/100; внешних ссылок ${sourceLinks}, автор ${authorFound ? 'есть' : 'не найден'}.`, 'Укажите ответственного эксперта и добавьте релевантные первичные источники для проверяемых утверждений.');
  addCheck('evidence', 'В содержательном материале есть конкретика', wordCount < 500 || factsAndNumbers >= 3 || experienceMarkers > 0, `Фактов и числовых деталей: ${factsAndNumbers}; маркеров практического опыта: ${experienceMarkers}.`, 'Замените общие обещания конкретными условиями, примерами и проверяемыми деталями без вымышленных цифр.');
  addCheck('keyword-targeting', 'Целевые ключи используются естественно', keywordMetrics.length === 0 || keywordUse >= 60, `Оценка работы с заданными ключами: ${keywordUse}/100.`, 'Выберите одну основную фразу для страницы и естественно поддержите её в title, H1, вступлении и тексте без обязательного точного повтора.');
  addCheck('repetition', 'Нет заметного переспама', repetitionRisk < 45, `Риск повторяемости: ${repetitionRisk}/100; плотность ведущего термина ${topFrequency}%.`, 'Сократите механические повторы и добавьте конкретные подтемы, сущности и естественные формулировки.');
  addCheck('ai-answerability', 'Есть самодостаточные фрагменты для цитирования', dimensions.aiReadiness >= 60, `AI-цитируемость оценена в ${dimensions.aiReadiness}/100.`, 'Добавьте короткие определения и ответы, факты, списки или сравнения, понятные вне контекста страницы.');
  addCheck('visual-proof', 'Изображения поддерживают содержание', !['product', 'service', 'article'].includes(pageType) || images > 0, `Изображений в HTML: ${images}.`, 'Добавьте только реальные полезные изображения: товар, процесс, результат, схему или скриншот; декоративные изображения не считать доказательством.');
  const expectedSchema = pageType === 'homepage' ? /WebSite/i : pageType === 'article' ? /Article|BlogPosting|NewsArticle/i : pageType === 'product' ? /Product/i : null;
  addCheck('schema-fit', 'Структурированные данные соответствуют типу страницы', !expectedSchema || schemas.some((type) => expectedSchema.test(type)), `Обнаруженные типы Schema.org: ${schemas.join(', ') || 'нет'}; ожидаемый профиль: ${pageType}.`, 'Добавьте только подходящую для доступного rich result JSON-LD разметку с данными, которые видны на странице; для типов без поддерживаемого поискового улучшения разметка не обязательна.');
  const failedChecks = checks.filter((check) => !check.passed);
  const codexPrompt = `Ты senior SEO-редактор и разработчик. Улучши страницу ${url.toString()} по результатам аудита, работая в текущем репозитории.\n\nТип: ${pageType}. Интент: ${searchIntent}. Оценка контента: ${weighted}/100.\n\nПРОБЛЕМЫ:\n${failedChecks.map((check, index) => `${index + 1}. ${check.label}\nФакт: ${check.evidence}\nРешение: ${check.recommendation}`).join('\n\n') || 'Критичных пробелов автоматическая проверка не нашла; проведи редакторскую проверку фактов и соответствия интенту.'}\n\nСначала найди реальный файл/шаблон страницы. Не выдумывай факты, автора, опыт, отзывы, цифры, цены или источники. Если нужны бизнес-данные — составь список вопросов владельцу. Сохрани дизайн, доступность, аналитику и интент. Исправляй общий шаблон, если проблема повторяется. После изменений запусти сборку и покажи таблицу: проблема → файл → исправление → способ проверки.`;
  return { score: weighted, pageType, searchIntent, minimumWords, grade: weighted >= 90 ? 'A' : weighted >= 75 ? 'B' : weighted >= 60 ? 'C' : weighted >= 40 ? 'D' : 'F', readingTime: Math.max(1, Math.ceil(wordCount / 200)), sentenceCount, averageSentenceWords, longSentencePercent, primaryTopic: headings[0] || title || url.pathname, firstParagraph, outline, ctaFound, sourceLinks, factsAndNumbers, repetitionRisk, dimensions, strengths, weaknesses, recommendations: recommendations.slice(0, 8), checks, codexPrompt };
}
const sameSite = (a: URL, b: URL) => a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '');
const normalized = (value: string | URL) => {
  const url = new URL(value);
  url.hash = '';
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  [...url.searchParams.keys()].forEach((key) => {
    if (/^(utm_|gclid|fbclid|yclid)/i.test(key)) url.searchParams.delete(key);
  });
  return url.toString();
};

function issue(severity: Severity, category: Category, title: string, description: string, recommendation: string, url?: string): AuditIssue {
  const categorySteps: Record<Category, string[]> = {
    indexing: ['Подтвердить, должна ли страница индексироваться и какая версия URL является основной.', 'Исправить robots/canonical/HTTP-ответ или редирект в шаблоне и конфигурации сервера.', 'Перепроверить итоговый HTML и заголовки, затем обновить sitemap и отправить URL на переобход.'],
    onpage: ['Найти общий шаблон страницы и определить, затрагивает ли проблема другие URL.', 'Исправить семантическую разметку и метаданные без изменения фактов и поискового интента.', 'Проверить уникальность, доступность и серверный HTML после сборки.'],
    content: ['Определить интент страницы, целевую аудиторию и недостающую полезную информацию.', 'Переписать только проблемные фрагменты: добавить доказательства, структуру и естественную семантику без переспама.', 'Проверить читабельность, фактическую точность, авторство и отличие от других страниц.'],
    links: ['Найти источник ссылки и проверить конечный URL, редиректы и назначение анкора.', 'Исправить href/анкор либо удалить ссылку, если полезной цели нет.', 'Пройти ключевые пользовательские пути и повторно проверить внутренний граф ссылок.'],
    images: ['Определить роль каждого проблемного изображения: содержательное или декоративное.', 'Исправить alt, размеры, формат и загрузку без ухудшения качества и LCP.', 'Проверить отсутствие CLS, доступность и корректное отображение на мобильных.'],
    schema: ['Сопоставить тип Schema.org с реальным типом страницы и видимым содержанием.', 'Исправить JSON-LD и обязательные свойства, не добавляя вымышленные рейтинги, авторов или цены.', 'Провалидировать разметку и убедиться, что значения совпадают с видимым контентом.'],
    performance: ['Подтвердить проблему измерением и найти самый дорогой ресурс или участок рендера.', 'Внести минимальное изменение в сервер, шаблон или загрузку ресурсов.', 'Сравнить сборку до/после и проверить LCP, INP и CLS реальными инструментами.'],
    social: ['Определить корректные заголовок, описание и изображение для расшаривания.', 'Добавить согласованные Open Graph/Twitter теги в серверный head.', 'Проверить абсолютные URL, размеры изображения и превью в валидаторе.'],
    ai: ['Проверить доступность страницы AI-краулерам и видимость главного контента без тяжёлого JavaScript.', 'Добавить ясные определения, факты, источники, списки или таблицы там, где это помогает читателю.', 'Не обещать AI-трафик; проверить robots.txt, авторство и цитируемость содержимого.'],
  };
  const solutionSteps = [recommendation, ...categorySteps[category]].slice(0, 4);
  const base: AuditIssue = { id: randomUUID(), severity, category, title, description, recommendation, solutionSteps, codexPrompt: '', url };
  return { ...base, codexPrompt: buildGroupedIssuePrompt([base], url) };
}

async function readText(response: Response, maxBytes = 5_000_000) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('Страница больше 5 МБ и пропущена');
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error('Страница больше 5 МБ и пропущена');
  return text;
}

function schemaDetails($: cheerio.CheerioAPI) {
  const found = new Set<string>();
  const errors = new Set<string>();
  $('script[type="application/ld+json"]').each((_, node) => {
    try {
      const data = JSON.parse($(node).text());
      const root = Array.isArray(data) ? data : [data];
      const hasContext = root.some((item) => item && typeof item === 'object' && String((item as Record<string, unknown>)['@context'] || '').includes('schema.org'));
      if (!hasContext) errors.add('JSON-LD: отсутствует @context https://schema.org');
      const required: Record<string, string[]> = {
        Product: ['name'], Article: ['headline', 'datePublished', 'author'], BlogPosting: ['headline', 'datePublished', 'author'],
        Organization: ['name'], LocalBusiness: ['name', 'address'], BreadcrumbList: ['itemListElement'],
        Event: ['name', 'startDate', 'location'], JobPosting: ['title', 'datePosted', 'hiringOrganization'], VideoObject: ['name', 'thumbnailUrl', 'uploadDate'],
      };
      const walk = (value: unknown, inheritedContext = hasContext) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) return value.forEach((item) => walk(item, inheritedContext));
        const record = value as Record<string, unknown>;
        const type = record['@type'];
        const types = typeof type === 'string' ? [type] : Array.isArray(type) ? type.filter((item): item is string => typeof item === 'string') : [];
        types.forEach((item) => {
          found.add(item);
          (required[item] || []).forEach((field) => { if (record[field] == null || record[field] === '') errors.add(`${item}: отсутствует ${field}`); });
        });
        Object.values(record).forEach((item) => walk(item, inheritedContext || Boolean(record['@context'])));
      };
      walk(data);
    } catch {
      found.add('Невалидный JSON-LD');
      errors.add('JSON-LD содержит невалидный JSON');
    }
  });
  return { types: [...found], errors: [...errors] };
}

function analyzeHtml(url: URL, response: Response, html: string, responseTime: number, targetKeywords: string[], requestedUrl = url, redirectChain: RedirectHop[] = []): { page: PageAudit; links: string[]; externalLinks: string[]; anchors: Array<{ text: string; target: string }> } {
  const $ = cheerio.load(html);
  const htmlBytes = Buffer.byteLength(html);
  const domNodes = $('*').length;
  const scripts = $('script[src], script:not([src])').length;
  const thirdPartyScripts = $('script[src]').filter((_, node) => {
    try { return !sameSite(url, new URL($(node).attr('src') || '', url)); } catch { return false; }
  }).length;
  const stylesheets = $('link[rel="stylesheet"]').length;
  const hasFavicon = $('link[rel~="icon"]').length > 0;
  const faviconHref = $('link[rel~="icon"]').first().attr('href') || '';
  const formsMissingLabels = $('input:not([type="hidden"]), select, textarea').filter((_, node) => {
    const id = $(node).attr('id');
    return !$(node).attr('aria-label') && !$(node).attr('aria-labelledby') && !$(node).closest('label').length && !(id && $(`label[for="${id}"]`).length);
  }).length;
  const emptyLinks = $('a[href]').filter((_, node) => !clean($(node).text()) && !$(node).attr('aria-label') && !$(node).find('img[alt]').length).length;
  const genericAnchors = $('a[href]').filter((_, node) => /^(подробнее|читать далее|здесь|перейти|нажмите|click here|read more|learn more)$/i.test(clean($(node).text()))).length;
  const insecureInternalLinks = $('a[href^="http://"]').filter((_, node) => {
    try { return sameSite(url, new URL($(node).attr('href') || '')); } catch { return false; }
  }).length;
  const externalBlankWithoutRel = $('a[target="_blank"]').filter((_, node) => !/noopener|noreferrer/i.test($(node).attr('rel') || '')).length;
  const imagesLongAlt = $('img[alt]').filter((_, node) => ($(node).attr('alt') || '').length > 125).length;
  const imagesWithoutLazy = $('img').slice(2).filter((_, node) => !/lazy/i.test($(node).attr('loading') || '')).length;
  const aboveFoldLazyImages = $('img').slice(0, 2).filter((_, node) => /lazy/i.test($(node).attr('loading') || '')).length;
  const responsiveImagesMissingFallback = $('img[srcset]').filter((_, node) => !clean($(node).attr('src'))).length
    + $('picture').filter((_, node) => !$(node).find('img[src]').length).length;
  const unstableImageUrls = $('img[src]').filter((_, node) => /^(?:data:|blob:)/i.test($(node).attr('src') || '')).length;
  const genericImageFilenames = $('img[src]').filter((_, node) => {
    const src = ($(node).attr('src') || '').split(/[?#]/)[0] || '';
    const file = src.split('/').pop() || '';
    return /^(?:img|image|photo|pic|dsc|screenshot|untitled)[-_ ]?\d*\.(?:jpe?g|png|webp|gif|avif)$/i.test(file);
  }).length;
  const videos = $('video, iframe[src*="youtube.com" i], iframe[src*="youtu.be" i], iframe[src*="vimeo.com" i]').length;
  const videosMissingPoster = $('video').filter((_, node) => !clean($(node).attr('poster'))).length;
  const unversionedAssets = $('script[src], link[rel="stylesheet"][href]').filter((_, node) => {
    const raw = $(node).attr('src') || $(node).attr('href') || '';
    try {
      const asset = new URL(raw, url);
      if (!sameSite(url, asset)) return false;
      const file = asset.pathname.split('/').pop() || '';
      return !/[._-][a-f0-9]{8,}(?:\.|-)/i.test(file) && !asset.searchParams.has('v') && !asset.searchParams.has('ver');
    } catch { return false; }
  }).length;
  let previousHeading = 0;
  let headingOrderIssues = 0;
  $('h1,h2,h3,h4,h5,h6').each((_, node) => {
    const level = Number(node.tagName.slice(1));
    if (previousHeading && level > previousHeading + 1) headingOrderIssues++;
    previousHeading = level;
  });
  $('script,style,noscript,svg,template').remove();
  const title = clean($('title').first().text());
  const description = clean($('meta[name="description" i]').attr('content'));
  const headings = $('h1').map((_, node) => clean($(node).text())).get().filter(Boolean);
  const canonicalRaw = $('link[rel="canonical" i]').attr('href') || '';
  let canonical = '';
  try { canonical = canonicalRaw ? new URL(canonicalRaw, url).toString() : ''; } catch { canonical = canonicalRaw; }
  const robots = clean($('meta[name="robots" i]').attr('content')).toLowerCase();
  const lang = clean($('html').attr('lang'));
  const bodyText = clean($('main').text() || $('body').text());
  const pageWordCount = words(bodyText);
  const first100Words = clean(bodyText).split(/\s+/).slice(0, 100).join(' ');
  const firstParagraph = clean($('main p, article p, body p').first().text()).slice(0, 600);
  const outline = $('h1,h2,h3').map((_, node) => `${node.tagName.toUpperCase()}: ${clean($(node).text())}`).get().filter((value) => value.length > 4).slice(0, 40);
  const ctaFound = $('a,button').filter((_, node) => /(?:купить|заказать|получить|оставить заявку|связаться|начать|попробовать|скачать|buy|order|get started|contact|try|download)/i.test(clean($(node).text()))).length > 0;
  const allLinks: string[] = [];
  const allExternalLinks: string[] = [];
  const anchors: Array<{ text: string; target: string }> = [];
  let internalLinks = 0;
  let externalLinks = 0;
  $('a[href]').each((_, node) => {
    const href = $(node).attr('href');
    if (!href || /^(mailto:|tel:|javascript:|#)/i.test(href)) return;
    try {
      const target = new URL(href, url);
      if (!['http:', 'https:'].includes(target.protocol)) return;
      if (sameSite(url, target)) { internalLinks++; allLinks.push(normalized(target)); anchors.push({ text: clean($(node).text()) || '[без текста]', target: normalized(target) }); }
      else { externalLinks++; allExternalLinks.push(normalized(target)); }
    } catch { /* malformed href */ }
  });
  const images = $('img').length;
  const imagesMissingAlt = $('img:not([alt])').length;
  const imagesMissingDimensions = $('img').filter((_, node) => !$(node).attr('width') || !$(node).attr('height')).length;
  const schema = schemaDetails(cheerio.load(html));
  const schemas = schema.types;
  const ogComplete = Boolean($('meta[property="og:title"]').attr('content') && $('meta[property="og:description"]').attr('content') && $('meta[property="og:image"]').attr('content'));
  const twitterComplete = Boolean($('meta[name="twitter:card"]').attr('content') && ($('meta[name="twitter:title"]').attr('content') || $('meta[property="og:title"]').attr('content')));
  const hreflangs: Array<{ lang: string; url: string }> = [];
  let hreflangErrors = 0;
  const seenHreflangs = new Set<string>();
  $('link[rel="alternate"][hreflang]').each((_, node) => {
    const lang = clean($(node).attr('hreflang')).toLowerCase();
    const href = clean($(node).attr('href'));
    if (!lang || !href || seenHreflangs.has(lang)) { hreflangErrors++; return; }
    seenHreflangs.add(lang);
    try { hreflangs.push({ lang, url: normalized(new URL(href, url)) }); } catch { hreflangErrors++; }
  });
  const hreflangCount = hreflangs.length;
  const paragraphs = $('main p, article p').length || $('body p').length;
  const lists = $('main ul, main ol, article ul, article ol').length || $('body ul, body ol').length;
  const tables = $('main table, article table').length || $('body table').length;
  const questions = (bodyText.match(/\?/g) || []).length;
  const authorFound = Boolean($('meta[name="author"]').attr('content') || $('[rel="author"], [class*="author" i], [itemprop="author"]').length);
  const dateFound = Boolean($('time[datetime], meta[property="article:published_time"], [itemprop="datePublished"]').length);
  const publishedDate = clean($('meta[property="article:published_time"]').attr('content') || $('[itemprop="datePublished"]').first().attr('content') || $('[itemprop="datePublished"]').first().attr('datetime') || $('time[datetime]').first().attr('datetime'));
  const modifiedDate = clean($('meta[property="article:modified_time"]').attr('content') || $('[itemprop="dateModified"]').first().attr('content') || $('[itemprop="dateModified"]').first().attr('datetime'));
  const datedValues = [publishedDate, modifiedDate].filter(Boolean);
  const invalidDates = datedValues.filter((value) => !Number.isFinite(Date.parse(value))).length;
  const trustSignals = [
    $('a[href^="mailto:"]').length > 0 || /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(bodyText),
    $('a[href^="tel:"]').length > 0,
    $('a[href*="about" i], a[href*="o-komp" i], a[href*="about-us" i]').length > 0,
    $('a[href*="contact" i], a[href*="kontact" i], a[href*="kontakty" i]').length > 0,
    $('a[href*="privacy" i], a[href*="politic" i], a[href*="policy" i]').length > 0,
    authorFound,
  ].filter(Boolean).length;
  const readabilityScore = readabilityFor(bodyText);
  const aiCitationScore = Math.max(0, Math.min(100, Math.round(
    (headings.length ? 12 : 0) + Math.min(18, $('h2,h3').length * 3) + Math.min(18, lists * 6) + Math.min(18, tables * 9) +
    Math.min(12, questions * 2) + (authorFound ? 10 : 0) + (dateFound ? 6 : 0) + (pageWordCount >= 350 ? 6 : 0)
  )));
  let contentScore = Math.max(0, Math.min(100, Math.round(
    Math.min(30, pageWordCount / 20) + Math.min(14, paragraphs * 2) + Math.min(12, $('h2,h3').length * 2) +
    readabilityScore * .18 + (trustSignals >= 2 ? 12 : trustSignals * 4) + (authorFound ? 8 : 0) + (dateFound ? 6 : 0)
  )));
  const keywordMetrics: KeywordMetric[] = targetKeywords.map((keyword) => {
    const count = countPhrase(bodyText, keyword);
    return {
      keyword, count, density: Number((count * Math.max(1, words(keyword)) / Math.max(1, pageWordCount) * 100).toFixed(2)),
      inTitle: title.toLowerCase().includes(keyword.toLowerCase()), inDescription: description.toLowerCase().includes(keyword.toLowerCase()),
      inH1: headings.some((heading) => heading.toLowerCase().includes(keyword.toLowerCase())),
      inFirst100Words: first100Words.toLowerCase().includes(keyword.toLowerCase()), inUrl: decodeURIComponent(url.pathname).toLowerCase().includes(keyword.toLowerCase().replace(/\s+/g, '-')),
    };
  });
  const topTerms = topTermsFor(bodyText, pageWordCount);
  const contentAnalysis = analyzeContentQuality({ url, title, headings, outline, description, bodyText, firstParagraph, wordCount: pageWordCount, paragraphs, lists, tables, questions, images, internalLinks, externalLinks, authorFound, dateFound, trustSignals, schemas, readabilityScore, aiCitationScore, keywordMetrics, ctaFound });
  contentScore = contentAnalysis.score;
  const viewport = $('meta[name="viewport" i]').attr('content') || '';
  const xRobots = clean(response.headers.get('x-robots-tag') || '').toLowerCase();
  const combinedRobots = `${robots},${xRobots}`;
  const hasRobotsDirective = (source: string, directive: string) => source.split(/[,\s]+/).map((item) => item.trim().split(':')[0]?.trim()).includes(directive);
  const snippetControls = ['nosnippet', 'max-snippet', 'max-image-preview', 'max-video-preview', 'noimageindex'].filter((directive) => new RegExp(`(?:^|[,\\s])${directive}(?:\\s*:|[,\\s]|$)`, 'i').test(combinedRobots));
  const charsetFound = Boolean($('meta[charset], meta[http-equiv="content-type" i]').length || /charset\s*=/i.test(response.headers.get('content-type') || ''));
  const metaRefresh = $('meta[http-equiv="refresh" i]').attr('content') || '';
  const redirected = redirectChain.length > 0 || response.redirected || normalized(requestedUrl) !== normalized(url);
  const urlParameters = [...url.searchParams.keys()];
  const indexable = response.status < 400 && !/noindex/.test(`${robots} ${xRobots}`);
  const jsAppShellRisk = pageWordCount < 80 && scripts >= 5 && Boolean($('#app, #root, #__next, #__nuxt').length) && clean($('noscript').text()).length < 80;
  const cwvRisks = {
    lcp: Number(responseTime > 1000) + Number(aboveFoldLazyImages > 0) + Number(stylesheets > 8) + Number(htmlBytes > 500_000),
    inp: Number(scripts > 20) + Number(thirdPartyScripts > 8) + Number(domNodes > 1800),
    cls: Number(imagesMissingDimensions > 0) + Number(!/width=device-width/i.test(viewport)),
  };
  const pageIssues: AuditIssue[] = [];
  const add = (severity: Severity, category: Category, heading: string, detail: string, fix: string) => pageIssues.push(issue(severity, category, heading, detail, fix, url.toString()));

  if (response.status >= 400) add('critical', 'indexing', `HTTP ${response.status}`, 'Страница отвечает ошибкой и не может нормально участвовать в поиске.', 'Исправьте адрес, восстановите страницу или настройте релевантный 301-редирект.');
  if (redirected) add('medium', 'indexing', 'URL перенаправляется', `Запрошен ${requestedUrl.toString()}, конечный адрес: ${url.toString()}.`, 'Обновите внутренние ссылки и sitemap на конечный URL; оставьте один прямой серверный 301 без цепочки.');
  if (!title) add('high', 'onpage', 'Отсутствует title', 'Поиску и пользователю непонятна основная тема страницы.', 'Добавьте уникальный, конкретный title длиной примерно 30–60 символов.');
  else if (title.length < 30 || title.length > 60) add('medium', 'onpage', 'Неоптимальная длина title', `Сейчас ${title.length} символов; сниппет может быть слабым или обрезаться.`, 'Сформулируйте уникальный title в диапазоне примерно 30–60 символов без переспама.');
  if (!description) add('medium', 'onpage', 'Нет meta description', 'Поисковик будет формировать описание сниппета самостоятельно.', 'Добавьте полезное описание страницы примерно 120–160 символов.');
  else if (description.length < 70 || description.length > 170) add('low', 'onpage', 'Неоптимальная длина description', `Сейчас ${description.length} символов.`, 'Сделайте описание конкретным и удерживайте его примерно в диапазоне 120–160 символов.');
  if (!headings.length) add('high', 'onpage', 'Нет заголовка H1', 'На странице отсутствует главный смысловой заголовок.', 'Добавьте один описательный H1, совпадающий с интентом страницы.');
  else if (headings.length > 1) add('medium', 'onpage', 'Несколько H1', `Найдено H1: ${headings.length}.`, 'Оставьте один главный H1, остальные уровни оформите как H2/H3.');
  if (!canonical) add('medium', 'indexing', 'Не указан canonical', 'Поиску сложнее выбрать основную версию среди дублей URL.', 'Добавьте абсолютный self-referencing canonical на индексируемую страницу.');
  if (hasRobotsDirective(robots, 'noindex')) add('high', 'indexing', 'Страница закрыта noindex', 'Поисковикам явно запрещено индексировать эту страницу. Это может быть намеренно.', 'Если страница должна находиться в поиске, удалите директиву noindex; иначе оставьте её и исключите URL из sitemap.');
  if (hasRobotsDirective(xRobots, 'noindex')) add('high', 'indexing', 'X-Robots-Tag запрещает индексацию', `Сервер отправляет: ${xRobots}. Это может быть намеренно.`, 'Если страница должна находиться в поиске, удалите noindex из HTTP-заголовка; иначе исключите URL из sitemap.');
  if (hasRobotsDirective(robots, 'index') && hasRobotsDirective(xRobots, 'noindex') || hasRobotsDirective(robots, 'noindex') && hasRobotsDirective(xRobots, 'index')) add('high', 'indexing', 'Конфликт robots-директив', 'Meta robots и X-Robots-Tag дают противоположные указания index/noindex.', 'Оставьте одно согласованное правило индексации на уровне HTML и сервера.');
  if (metaRefresh) add('high', 'indexing', 'Используется meta refresh', `Найдено перенаправление или обновление: ${metaRefresh}.`, 'Замените meta refresh на серверный HTTP 301/302, если это редирект.');
  if (/nosnippet|(?:^|[,\s])max-snippet\s*:\s*0/i.test(combinedRobots)) add('medium', 'indexing', 'Сниппеты полностью отключены', `Директивы robots: ${combinedRobots.replace(/^,|,$/g, '')}. Поисковик не сможет показывать текстовый сниппет страницы.`, 'Если ограничение не намеренное, удалите nosnippet или max-snippet:0; если данные чувствительные, ограничьте только конкретный фрагмент через data-nosnippet.');
  if (/max-image-preview\s*:\s*none/i.test(combinedRobots)) add('low', 'images', 'Превью изображений запрещены', 'Директива max-image-preview:none запрещает поиску крупные и стандартные превью изображений.', 'Если запрет не является политикой публикации, разрешите large image preview через max-image-preview:large.');
  if (!lang) add('low', 'onpage', 'Не задан язык документа', 'Браузерам и вспомогательным технологиям сложнее определить язык.', 'Добавьте атрибут lang к элементу html, например lang="ru".');
  if (!/width=device-width/i.test(viewport)) add('high', 'performance', 'Нет мобильного viewport', 'Страница может отображаться как десктопная на телефонах.', 'Добавьте meta viewport с width=device-width, initial-scale=1.');
  if (pageWordCount < 180) add('medium', 'content', 'Мало содержательного текста', `Найдено около ${pageWordCount} слов — возможен тонкий контент.`, 'Раскройте задачу пользователя: добавьте факты, примеры, условия, ответы и доказательства опыта.');
  if (readabilityScore < 45 && pageWordCount > 150) add('medium', 'content', 'Текст трудно читать', `Эвристическая оценка читабельности: ${readabilityScore}/100. Вероятны длинные предложения и сложные слова.`, 'Сократите предложения, разбейте большие абзацы, объясните термины и добавьте подзаголовки.');
  if (pageWordCount > 500 && paragraphs < 4) add('medium', 'content', 'Текст плохо разбит на абзацы', `${pageWordCount} слов размещены всего в ${paragraphs} абзацах.`, 'Разбейте материал на короткие смысловые абзацы и секции.');
  if (pageWordCount > 700 && !authorFound) add('medium', 'content', 'Не указан автор', 'У объёмного материала не найдено явного авторства.', 'Добавьте имя автора, ссылку на профиль и релевантный опыт — особенно для экспертных тем.');
  if (trustSignals < 2) add('medium', 'content', 'Мало сигналов доверия', `Найдено явных сигналов доверия: ${trustSignals} из 6.`, 'Добавьте контакты, страницу о компании, политику конфиденциальности, авторство и реальные доказательства опыта.');
  if (contentAnalysis.dimensions.intent < 50) add('high', 'content', 'Контент слабо соответствует интенту', `Согласованность title, H1, первого абзаца и действия страницы оценена в ${contentAnalysis.dimensions.intent}/100.`, 'Выберите одну главную задачу пользователя и согласуйте с ней заголовки, вступление, содержание и CTA.');
  if (contentAnalysis.dimensions.depth < 50 && pageWordCount >= 180) add('medium', 'content', 'Тема раскрыта недостаточно полно', `Для типа «${contentAnalysis.pageType}» полнота оценена в ${contentAnalysis.dimensions.depth}/100: ${pageWordCount} слов при ориентире около ${contentAnalysis.minimumWords}.`, 'Добавьте недостающие условия, примеры, сравнения, ответы и доказательства; не увеличивайте текст ради объёма.');
  if (contentAnalysis.repetitionRisk >= 45) add('high', 'content', 'Высокий риск повторов и переспама', `Эвристический риск повторяемости: ${contentAnalysis.repetitionRisk}/100.`, 'Уберите механические повторы ведущих терминов и точных ключей, заменив их конкретикой и естественными формулировками.');
  if (contentAnalysis.dimensions.experience < 35 && pageWordCount >= 400) add('medium', 'content', 'Не видно реального опыта', 'В объёмном тексте почти нет примеров, собственных наблюдений, кейсов, изображений или конкретных результатов.', 'Добавьте только реальные доказательства опыта: примеры, процесс, ограничения, скриншоты, фото или измеримые результаты.');
  if (internalLinks === 0) add('high', 'links', 'Нет внутренних ссылок', 'Страница изолирована от структуры сайта.', 'Добавьте контекстные ссылки на связанные разделы и понятный путь продолжения.');
  if (imagesMissingAlt) add('medium', 'images', 'У изображений нет alt', `${imagesMissingAlt} из ${images} изображений без текстовой альтернативы.`, 'Добавьте содержательный alt важным изображениям; декоративным задайте пустой alt.');
  if (imagesLongAlt) add('low', 'images', 'Слишком длинные alt', `Изображений с alt длиннее 125 символов: ${imagesLongAlt}.`, 'Сократите alt до ясного описания изображения; подробности оставьте в тексте страницы.');
  if (imagesWithoutLazy > 3) add('low', 'performance', 'Ниже первого экрана нет lazy loading', `У ${imagesWithoutLazy} изображений после первых двух не найден loading="lazy".`, 'Добавьте lazy loading изображениям ниже первого экрана, не откладывая вероятный LCP-элемент.');
  if (imagesMissingDimensions) add('low', 'performance', 'Не зарезервировано место под изображения', `${imagesMissingDimensions} изображений без width/height — это риск CLS.`, 'Укажите width и height или aspect-ratio для стабильной раскладки.');
  if (responsiveImagesMissingFallback) add('high', 'images', 'У responsive-изображений нет fallback src', `Найдено ${responsiveImagesMissingFallback} img/srcset или picture без рабочего img src. Google Images может не обнаружить такой ресурс.`, 'У каждого responsive-изображения оставьте обычный <img src="…"> как fallback, а srcset/source используйте дополнительно.');
  if (unstableImageUrls) add('medium', 'images', 'Изображения используют data/blob URL', `Найдено ${unstableImageUrls} изображений без стабильного HTTP(S)-адреса.`, 'Для индексируемых содержательных изображений используйте стабильные доступные URL; data/blob оставьте только для служебной графики.');
  if (genericImageFilenames >= 3) add('low', 'images', 'Неинформативные имена файлов изображений', `Общих имён вроде image1.jpg найдено: ${genericImageFilenames}.`, 'Переименуйте важные изображения по их реальному содержанию и обновите ссылки, не набивая имя ключевыми словами.');
  if (videos && !schemas.some((type) => /VideoObject/i.test(type))) add('low', 'schema', 'Видео без VideoObject', `На странице найдено видео или видеовстраивание (${videos}), но нет VideoObject JSON-LD.`, 'Если видео является основным содержанием страницы, добавьте правдивый VideoObject с name, description, thumbnailUrl, uploadDate и доступным contentUrl/embedUrl.');
  if (videosMissingPoster) add('low', 'images', 'У HTML-видео нет poster', `Видео без явной обложки: ${videosMissingPoster}.`, 'Добавьте стабильный доступный poster/thumbnail и используйте тот же образ в VideoObject и Open Graph, если он соответствует видео.');
  if (schemas.includes('Невалидный JSON-LD')) add('high', 'schema', 'Ошибка в JSON-LD', 'Один из блоков структурированных данных содержит невалидный JSON.', 'Исправьте синтаксис и проверьте блок в Schema Markup Validator.');
  if (schema.errors.length && !schemas.includes('Невалидный JSON-LD')) add('medium', 'schema', 'Неполная разметка Schema.org', schema.errors.slice(0, 4).join('; '), 'Добавьте обязательные свойства, правильный @context и проверьте данные в Schema Markup Validator.');
  const retiredGoogleFeatures = schemas.filter((type) => /^(?:CourseInfo|ClaimReview|Occupation|LearningResource|SpecialAnnouncement|Vehicle)$/i.test(type));
  if (retiredGoogleFeatures.length) add('low', 'schema', 'Разметка больше не даёт отдельный Google rich result', `Типы ${retiredGoogleFeatures.join(', ')} больше не поддерживаются Google как отдельные улучшения результатов. Schema.org-разметка при этом может оставаться полезной другим потребителям.`, 'Не удаляйте семантически верные данные автоматически; уберите лишь код и ожидания, созданные исключительно ради устаревшего Google rich result.');
  if (schemas.some((type) => /^FAQPage$/i.test(type))) add('low', 'schema', 'FAQ rich result Google прекращён', 'FAQPage может оставаться семантически корректной разметкой, но с мая 2026 года Google больше не показывает отдельный FAQ rich result.', 'Не создавайте FAQPage ради расширенного сниппета; оставьте её только если она точно описывает видимый FAQ и нужна другим потребителям данных.');
  if (url.pathname === '/' && !schemas.some((type) => /^WebSite$/i.test(type))) add('low', 'schema', 'Название сайта не задано через WebSite', 'На главной странице не найден WebSite JSON-LD — основной структурированный сигнал для site name в Google.', 'Добавьте на главную WebSite с реальными name и url; alternateName указывайте только если бренд действительно использует этот вариант.');
  if (invalidDates) add('medium', 'content', 'Некорректная дата публикации или обновления', `Не удалось разобрать дат: ${invalidDates}.`, 'Используйте валидную дату ISO 8601 и показывайте пользователю ту же дату, что передаёте в метаданных/Schema.org.');
  if (datedValues.some((value) => Number.isFinite(Date.parse(value)) && Date.parse(value) > Date.now() + 86_400_000)) add('high', 'content', 'Дата контента находится в будущем', `Найдены будущие даты: ${datedValues.filter((value) => Date.parse(value) > Date.now() + 86_400_000).join(', ')}.`, 'Исправьте источник даты в CMS или шаблоне; не обновляйте dateModified без реального существенного изменения материала.');
  if (publishedDate && modifiedDate && Number.isFinite(Date.parse(publishedDate)) && Number.isFinite(Date.parse(modifiedDate)) && Date.parse(modifiedDate) < Date.parse(publishedDate)) add('medium', 'content', 'dateModified раньше datePublished', `Опубликовано: ${publishedDate}; обновлено: ${modifiedDate}.`, 'Исправьте маппинг дат в CMS и синхронизируйте видимые даты, Open Graph и Schema.org.');
  if (jsAppShellRisk) add('high', 'indexing', 'Главный контент зависит от JavaScript', `В исходном HTML около ${pageWordCount} слов, найден корневой app-контейнер и ${scripts} скриптов. Это эвристический риск пустого app shell.`, 'Отдавайте основной контент и SEO-метаданные сервером или пререндерингом; затем сравните исходный и отрендеренный HTML в URL Inspection.');
  if (unversionedAssets >= 6) add('low', 'performance', 'Статические ресурсы без видимой версии', `Локальных JS/CSS без хеша или параметра версии: ${unversionedAssets}. Агрессивный кэш краулеров может задержать обновление ресурсов.`, 'Добавьте content hash к именам собираемых JS/CSS и настройте immutable caching для версионированных файлов.');
  if (!ogComplete) add('low', 'social', 'Неполные Open Graph теги', 'При публикации ссылки превью может выглядеть случайно.', 'Добавьте og:title, og:description и og:image с абсолютным URL.');
  if (responseTime > 2500) add('high', 'performance', 'Медленный ответ сервера', `HTML получен за ${responseTime} мс. Это не измерение Core Web Vitals, но заметный серверный риск.`, 'Проверьте TTFB, кэширование, backend и CDN; затем измерьте CWV полевыми данными.');
  else if (responseTime > 1000) add('medium', 'performance', 'Ответ сервера можно ускорить', `HTML получен за ${responseTime} мс.`, 'Проверьте кэширование HTML, серверные запросы и близость CDN.');
  if (cwvRisks.lcp >= 2) add('medium', 'performance', 'Высокий риск LCP', `Найдено факторов риска: ${cwvRisks.lcp} (ответ сервера, ранние изображения, CSS или тяжёлый HTML). Это эвристика, не полевое измерение.`, 'Проверьте LCP в PageSpeed Insights/Search Console, не загружайте LCP-изображение лениво и ускорьте критический путь.');
  if (cwvRisks.inp >= 2) add('medium', 'performance', 'Высокий риск INP', `Найдено факторов риска: ${cwvRisks.inp} (скрипты, сторонний код или крупный DOM). Это эвристика, не полевое измерение.`, 'Измерьте INP по полевым данным, сократите длинные задачи JavaScript и отложите сторонние скрипты.');
  if (!url.protocol.startsWith('https')) add('critical', 'indexing', 'Страница работает без HTTPS', 'Незащищённый протокол снижает доверие и создаёт риск дублей.', 'Переведите сайт на HTTPS и настройте постоянный редирект с HTTP.');
  if (url.toString().length > 115) add('low', 'onpage', 'Слишком длинный URL', `Длина адреса: ${url.toString().length} символов.`, 'Сократите путь, уберите лишние параметры и оставьте понятные смысловые сегменты.');
  if (urlParameters.length > 3) add('medium', 'indexing', 'Слишком много параметров URL', `Параметров в адресе: ${urlParameters.length} (${urlParameters.slice(0, 5).join(', ')}).`, 'Закройте фасетные и служебные комбинации от индексации, задайте canonical и оставьте в sitemap только чистые URL.');
  if (!charsetFound) add('low', 'onpage', 'Не указана кодировка документа', 'В head не найден meta charset.', 'Добавьте <meta charset="UTF-8"> в начале head.');
  if (canonical && (() => { try { return new URL(canonical).hostname !== url.hostname; } catch { return false; } })()) add('high', 'indexing', 'Canonical ведёт на другой домен', `Указан canonical: ${canonical}.`, 'Проверьте, что междоменный canonical задан намеренно и целевая страница эквивалентна.');
  if (canonical.startsWith('http://') && url.protocol === 'https:') add('high', 'indexing', 'Canonical использует HTTP', `HTTPS-страница указывает на небезопасную версию: ${canonical}.`, 'Замените canonical на абсолютный HTTPS-адрес.');
  if (headingOrderIssues) add('medium', 'onpage', 'Нарушена иерархия заголовков', `Найдено скачков уровней заголовков: ${headingOrderIssues}.`, 'Выстраивайте структуру последовательно: H1 → H2 → H3 без пропусков уровней.');
  if (formsMissingLabels) add('medium', 'onpage', 'У полей формы нет подписей', `Полей без label или aria-label: ${formsMissingLabels}.`, 'Свяжите каждое поле с видимой подписью label или доступным именем.');
  if (emptyLinks) add('medium', 'links', 'Есть ссылки без понятного текста', `Ссылок без текста или доступного имени: ${emptyLinks}.`, 'Добавьте осмысленный анкор или aria-label; изображения-ссылки должны иметь alt.');
  if (genericAnchors > 3) add('low', 'links', 'Слишком много общих анкоров', `Анкоры вроде «подробнее» или «здесь» используются ${genericAnchors} раз.`, 'Замените часть анкоров на текст, который объясняет содержание целевой страницы.');
  if (insecureInternalLinks) add('medium', 'links', 'Внутренние ссылки ведут на HTTP', `Небезопасных внутренних ссылок: ${insecureInternalLinks}.`, 'Обновите ссылки на HTTPS, чтобы не создавать лишние редиректы и mixed-content риски.');
  if (externalBlankWithoutRel) add('low', 'links', 'Внешние ссылки _blank без rel', `Ссылок без noopener/noreferrer: ${externalBlankWithoutRel}.`, 'Добавьте rel="noopener noreferrer" к внешним ссылкам, открывающим новую вкладку.');
  if (url.pathname === '/' && !hasFavicon) add('low', 'onpage', 'Не найден favicon на главной', 'В head главной страницы нет link rel="icon".', 'Добавьте favicon поддерживаемого формата и проверьте его доступность для Googlebot-Image.');
  if (hreflangCount && !hreflangs.some((item) => normalized(item.url) === normalized(url))) add('medium', 'onpage', 'В hreflang нет ссылки на текущую страницу', `Найдено языковых вариантов: ${hreflangCount}, но отсутствует self-reference для ${url.toString()}.`, 'Добавьте текущую страницу в набор hreflang и используйте тот же полный набор взаимных ссылок на всех языковых версиях.');
  if (hreflangErrors) add('medium', 'onpage', 'Ошибки в hreflang', `Пустых, повторяющихся или некорректных hreflang-ссылок: ${hreflangErrors}.`, 'Исправьте коды/URL, удалите дубли одного языка и оставьте абсолютные канонические адреса языковых версий.');
  if (url.pathname === '/' && faviconHref && (() => {
    try { return !/\.(?:bmp|gif|ico|png|jpe?g|ppm|tiff?)(?:$|[?#])/i.test(new URL(faviconHref, url).toString()); } catch { return true; }
  })()) add('medium', 'onpage', 'Формат favicon не поддерживается Google Search', `Указан favicon: ${faviconHref}. В актуальном списке Google Search поддерживаются BMP, GIF, ICO, PNG, JPEG, PPM и TIFF.`, 'Экспортируйте квадратный favicon минимум 48×48 в PNG или ICO, сохраните стабильный URL и оставьте link rel="icon" на главной.');
  if (domNodes > 1800) add('medium', 'performance', 'Слишком большой DOM', `В HTML найдено ${domNodes} элементов.`, 'Упростите вложенность и отложите рендеринг тяжёлых повторяющихся блоков.');
  if (scripts > 30) add('medium', 'performance', 'Слишком много скриптов', `На странице найдено ${scripts} блоков script, из них сторонних: ${thirdPartyScripts}.`, 'Удалите ненужные интеграции, объедините код и загружайте второстепенные скрипты отложенно.');
  if (htmlBytes > 500_000) add('medium', 'performance', 'Слишком тяжёлый HTML', `Размер HTML: ${Math.round(htmlBytes / 1024)} КБ.`, 'Уберите избыточную разметку и встроенные данные, используйте пагинацию или серверную выборку.');
  if (htmlBytes > 100_000 && !response.headers.get('content-encoding')) add('medium', 'performance', 'HTML передаётся без видимого сжатия', 'Для крупного ответа не найден Content-Encoding gzip или br.', 'Включите Brotli или gzip на сервере/CDN и проверьте заголовки реального ответа.');
  keywordMetrics.forEach((metric) => {
    if (pageWordCount >= 150 && metric.count >= 5 && metric.density > 3.5) add('high', 'content', `Возможен переспам: «${metric.keyword}»`, `Плотность точного вхождения: ${metric.density}%.`, 'Перепишите повторяющиеся фразы естественно, используйте синонимы и раскрывайте тему вместо повторов.');
    else if (metric.count > 0 && !metric.inTitle && !metric.inH1) add('low', 'content', `Ключ не поддержан title/H1: «${metric.keyword}»`, 'Фраза есть в тексте, но отсутствует в title и H1.', 'Если эта страница действительно целевая для запроса, естественно отразите тему в title или H1.');
  });

  const score = Math.max(0, Math.round(100 - pageIssues.reduce((sum, item) => sum + severityPenalty[item.severity], 0)));
  return {
    page: {
      url: url.toString(), originalUrl: requestedUrl.toString(), finalUrl: url.toString(), redirected, redirectChain,
      status: response.status, responseTime, contentType: response.headers.get('content-type') || '',
      title, titleLength: title.length, description, descriptionLength: description.length, h1: headings,
      h2Count: $('h2').length, canonical, robots, xRobots, lang, wordCount: pageWordCount, internalLinks,
      outgoingInternalUrls: [...new Set(allLinks)],
      externalLinks, brokenLinks: 0, images, imagesMissingAlt, imagesMissingDimensions,
      responsiveImagesMissingFallback, unstableImageUrls, genericImageFilenames, videos, videosMissingPoster, videoSchemaFound: schemas.some((type) => /VideoObject/i.test(type)),
      schemaTypes: schemas, schemaErrors: schema.errors, ogComplete, twitterComplete, hreflangCount, hreflangs, hreflangErrors, contentAnalysis,
      contentScore, readabilityScore, paragraphs, lists, tables, questions, authorFound, dateFound, trustSignals, aiCitationScore,
      publishedDate, modifiedDate, invalidDates, jsAppShellRisk, unversionedAssets, snippetControls,
      securityHeaders: Object.fromEntries(securityHeaderNames.map((name) => [name, Boolean(response.headers.get(name))])),
      htmlBytes, domNodes, scripts, thirdPartyScripts, stylesheets, textHtmlRatio: Number((Buffer.byteLength(bodyText) / Math.max(1, htmlBytes) * 100).toFixed(2)),
      hasFavicon, formsMissingLabels, emptyLinks, headingOrderIssues, depth: -1, incomingLinks: 0,
      urlParameters, indexable, cwvRisks, keywordMetrics, topTerms, score, issues: pageIssues,
    },
    links: [...new Set(allLinks)],
    externalLinks: [...new Set(allExternalLinks)],
    anchors,
  };
}

async function fetchOptional(url: URL, signal?: AbortSignal) {
  try {
    const started = Date.now();
    const response = await safeFetch(url, { signal });
    return { response, text: await readText(response, 2_000_000), time: Date.now() - started };
  } catch {
    return { response: null, text: '', time: 0 };
  }
}

async function readSitemapResponse(response: Response, url: URL) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > 10_000_000) throw new Error('Sitemap больше 10 МБ и пропущен');
  const isGzip = url.pathname.endsWith('.gz') || /gzip/i.test(response.headers.get('content-type') || '') || buffer[0] === 0x1f && buffer[1] === 0x8b;
  return (isGzip ? gunzipSync(buffer) : buffer).toString('utf8');
}

async function collectSitemaps(roots: URL[], origin: URL, signal?: AbortSignal, onProgress?: (progress: AuditProgress) => void) {
  const queue = [...new Map(roots.map((url) => [url.toString(), url])).values()];
  const visited = new Set<string>();
  const pageUrls = new Set<string>();
  const audits: SitemapAudit[] = [];
  let invalidUrls = 0;
  while (queue.length && visited.size < 25) {
    if (signal?.aborted) throw new DOMException('Аудит отменён', 'AbortError');
    const current = queue.shift()!;
    if (visited.has(current.toString())) continue;
    visited.add(current.toString());
    onProgress?.({ phase: 'sitemaps', message: `Читаем sitemap ${visited.size}…`, crawled: 0, discovered: pageUrls.size, checkedLinks: 0, totalLinks: 0, currentUrl: current.toString() });
    try {
      const response = await safeFetch(current, { signal });
      const text = await readSitemapResponse(response, current);
      const $xml = cheerio.load(text, { xmlMode: true });
      const type: SitemapAudit['type'] = $xml('sitemapindex').length ? 'index' : $xml('urlset').length ? 'urlset' : 'unknown';
      let validForMap = 0;
      let invalidForMap = 0;
      let lastmodCount = 0;
      let invalidLastmod = 0;
      let futureLastmod = 0;
      const lastmodFrequency = new Map<string, number>();
      const entries = $xml(type === 'index' ? 'sitemap' : 'url');
      entries.each((_, node) => {
        const lastmod = clean($xml(node).children('lastmod').first().text());
        if (!lastmod) return;
        lastmodCount++;
        lastmodFrequency.set(lastmod, (lastmodFrequency.get(lastmod) || 0) + 1);
        const parsed = Date.parse(lastmod);
        if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(lastmod) || !Number.isFinite(parsed)) invalidLastmod++;
        else if (parsed > Date.now() + 86_400_000) futureLastmod++;
      });
      const mostCommonLastmod = Math.max(0, ...lastmodFrequency.values());
      const suspiciousUniformLastmod = lastmodCount >= 5 && mostCommonLastmod / lastmodCount >= .8;
      $xml('loc').each((_, node) => {
        try {
          const candidate = new URL(clean($xml(node).text()));
          if (!sameSite(origin, candidate)) return;
          validForMap++;
          if (type === 'index' || /\.xml(?:\.gz)?$/i.test(candidate.pathname)) queue.push(candidate);
          else pageUrls.add(normalized(candidate));
        } catch { invalidUrls++; invalidForMap++; }
      });
      audits.push({
        url: current.toString(), status: response.status, type, urls: validForMap, invalidUrls: invalidForMap,
        lastmodCount, invalidLastmod, futureLastmod, suspiciousUniformLastmod,
        changefreqCount: $xml('changefreq').length, priorityCount: $xml('priority').length,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      audits.push({ url: current.toString(), status: 0, type: 'unknown', urls: 0, invalidUrls: 0, error: error instanceof Error ? error.message : 'Не удалось загрузить sitemap' });
    }
  }
  return { pageUrls, audits, invalidUrls };
}

function robotsAllowed(text: string, candidate: URL, userAgent = 'SiteScan') {
  type Group = { agents: string[]; rules: Array<{ allow: boolean; pattern: string }> };
  const groups: Group[] = [];
  let group: Group | null = null;
  let hasRules = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line || !line.includes(':')) continue;
    const [rawKey, ...rest] = line.split(':');
    const key = rawKey!.trim().toLowerCase();
    const value = rest.join(':').trim();
    if (key === 'user-agent') {
      if (!group || hasRules) { group = { agents: [], rules: [] }; groups.push(group); hasRules = false; }
      group.agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && group) {
      hasRules = true;
      if (value) group.rules.push({ allow: key === 'allow', pattern: value });
    }
  }
  const agent = userAgent.toLowerCase();
  const matching = groups.filter((item) => item.agents.some((value) => value === '*' || agent.includes(value))).map((item) => ({ item, specificity: Math.max(...item.agents.filter((value) => value === '*' || agent.includes(value)).map((value) => value === '*' ? 0 : value.length)) }));
  const specificity = Math.max(-1, ...matching.map((item) => item.specificity));
  const rules = matching.filter((item) => item.specificity === specificity).flatMap((item) => item.item.rules);
  const escapeRegex = (value: string) => value.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const path = `${candidate.pathname}${candidate.search}`;
  const winner = rules.filter((rule) => new RegExp(`^${escapeRegex(rule.pattern).replace(/\\\$$/, '$')}`).test(path)).sort((a, b) => b.pattern.replace(/\*/g, '').length - a.pattern.replace(/\*/g, '').length || Number(b.allow) - Number(a.allow))[0];
  return winner ? winner.allow : true;
}

function parseRobotsSitemaps(text: string, origin: URL) {
  return text.split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim()).filter((line) => /^sitemap\s*:/i.test(line)).flatMap((line) => {
    try { return [new URL(line.replace(/^sitemap\s*:/i, '').trim(), origin)]; } catch { return []; }
  });
}

interface RunAuditOptions {
  signal?: AbortSignal;
  onProgress?: (progress: AuditProgress) => void;
  maxLinkChecks?: number;
}

export async function runAudit(input: string, requestedLimit = 25, keywords: string[] = [], options: RunAuditOptions = {}): Promise<AuditReport> {
  const started = Date.now();
  const { signal, onProgress } = options;
  const emit = (progress: AuditProgress) => onProgress?.(progress);
  emit({ phase: 'prepare', message: 'Проверяем адрес и базовые файлы…', crawled: 0, discovered: 0, checkedLinks: 0, totalLinks: 0 });
  const entry = await validatePublicUrl(input);
  const origin = new URL(entry.origin);
  const crawlLimit = Math.min(100, Math.max(1, Math.round(requestedLimit || 25)));
  const targetKeywords = [...new Set(keywords.map(clean).filter(Boolean).slice(0, 10))];
  const llmsSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(2500)]) : AbortSignal.timeout(2500);
  const [robotsData, llmsData] = await Promise.all([
    fetchOptional(new URL('/robots.txt', origin), signal),
    fetchOptional(new URL('/llms.txt', origin), llmsSignal),
  ]);
  const robotsFound = Boolean(robotsData.response?.ok && /text|plain/i.test(robotsData.response.headers.get('content-type') || 'text/plain'));
  const sitemapRoots = [new URL('/sitemap.xml', origin), ...(robotsFound ? parseRobotsSitemaps(robotsData.text, origin) : [])];
  const sitemapResult = await collectSitemaps(sitemapRoots, origin, signal, onProgress);
  const sitemaps = sitemapResult.audits;
  const sitemapFound = sitemaps.some((item) => item.status >= 200 && item.status < 300 && item.type !== 'unknown');
  const queue: string[] = [normalized(entry)];
  const sitemapUrlSet = sitemapResult.pageUrls;
  const invalidSitemapUrls = sitemapResult.invalidUrls;
  const sitemapUrls = sitemapUrlSet.size;
  queue.push(...[...sitemapUrlSet].slice(0, crawlLimit * 3));
  const visited = new Set<string>();
  const pages: PageAudit[] = [];
  const linkGraph = new Map<string, string[]>();
  const linkSources = new Map<string, { kind: LinkCheck['kind']; sources: Set<string> }>();
  const collectedAnchors: Array<{ text: string; target: string }> = [];
  let blockedByRobots = 0;
  const allowed = (candidate: URL) => !robotsFound || robotsAllowed(robotsData.text, candidate);

  while (queue.length && pages.length < crawlLimit) {
    if (signal?.aborted) throw new DOMException('Аудит отменён', 'AbortError');
    const batch: string[] = [];
    while (queue.length && batch.length < 4 && pages.length + batch.length < crawlLimit) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      const parsed = new URL(current);
      if (!sameSite(origin, parsed) || /\.(?:pdf|jpe?g|png|gif|webp|svg|zip|xml|json|mp4|mp3)$/i.test(parsed.pathname)) continue;
      if (!allowed(parsed)) { blockedByRobots++; continue; }
      visited.add(current);
      batch.push(current);
    }
    if (!batch.length) continue;
    emit({ phase: 'crawl', message: `Сканируем страницы: ${pages.length}/${crawlLimit}`, crawled: pages.length, discovered: new Set([...visited, ...queue]).size, checkedLinks: 0, totalLinks: 0, currentUrl: batch[0] });
    const results = await Promise.all(batch.map(async (current) => {
      try {
        const pageStarted = Date.now();
        const { response, chain } = await safeFetchDetailed(current, { signal });
        const responseTime = Date.now() - pageStarted;
        const type = response.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml\+xml/i.test(type)) return null;
        const html = await readText(response);
        return analyzeHtml(new URL(response.url || current), response, html, responseTime, targetKeywords, new URL(current), chain);
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : 'Не удалось загрузить страницу';
        const item = issue('critical', 'indexing', 'Страница недоступна', message, 'Проверьте доступность URL, DNS, TLS и настройки сервера.', current);
        const page: PageAudit = { url: current, originalUrl: current, finalUrl: current, redirected: false, redirectChain: [], status: 0, responseTime: 0, contentType: '', title: '', titleLength: 0, description: '', descriptionLength: 0, h1: [], h2Count: 0, canonical: '', robots: '', lang: '', wordCount: 0, internalLinks: 0, externalLinks: 0, brokenLinks: 0, images: 0, imagesMissingAlt: 0, imagesMissingDimensions: 0, schemaTypes: [], schemaErrors: [], ogComplete: false, twitterComplete: false, hreflangCount: 0, contentAnalysis: blankContentAnalysis(current), contentScore: 0, readabilityScore: 0, paragraphs: 0, lists: 0, tables: 0, questions: 0, authorFound: false, dateFound: false, trustSignals: 0, aiCitationScore: 0, htmlBytes: 0, domNodes: 0, scripts: 0, thirdPartyScripts: 0, stylesheets: 0, textHtmlRatio: 0, hasFavicon: false, formsMissingLabels: 0, emptyLinks: 0, headingOrderIssues: 0, depth: -1, incomingLinks: 0, urlParameters: [...new URL(current).searchParams.keys()], indexable: false, cwvRisks: { lcp: 0, inp: 0, cls: 0 }, keywordMetrics: targetKeywords.map((keyword) => ({ keyword, count: 0, density: 0, inTitle: false, inDescription: false, inH1: false, inFirst100Words: false, inUrl: false })), topTerms: [], score: 0, issues: [item] };
        return { page, links: [], externalLinks: [], anchors: [] };
      }
    }));
    results.filter((result): result is NonNullable<typeof result> => Boolean(result)).forEach((result) => {
      pages.push(result.page);
      linkGraph.set(normalized(result.page.url), result.links);
      collectedAnchors.push(...result.anchors);
      result.links.forEach((link) => { const current = linkSources.get(link) || { kind: 'internal' as const, sources: new Set<string>() }; current.sources.add(result.page.url); linkSources.set(link, current); });
      result.externalLinks.forEach((link) => { const current = linkSources.get(link) || { kind: 'external' as const, sources: new Set<string>() }; current.sources.add(result.page.url); linkSources.set(link, current); });
      result.links.forEach((link) => { if (!visited.has(link) && queue.length < crawlLimit * 8) queue.push(link); });
    });
  }

  const siteIssues: AuditIssue[] = [];
  if (!sitemapFound) siteIssues.push(issue(pages.length > 1 ? 'medium' : 'low', 'indexing', 'sitemap.xml не найден', 'Карта сайта отсутствует или не похожа на валидный XML Sitemap. Для небольшого сайта это не блокирует индексацию, если страницы доступны по ссылкам.', 'Если сайт содержит несколько важных страниц, сформируйте sitemap.xml только с каноническими индексируемыми URL и отправьте её в панели вебмастеров.', origin.toString()));
  if (invalidSitemapUrls) siteIssues.push(issue('medium', 'indexing', 'Некорректные URL в sitemap', `Не удалось разобрать адресов: ${invalidSitemapUrls}.`, 'Удалите повреждённые loc, используйте абсолютные HTTPS-URL и провалидируйте XML Sitemap.', origin.toString()));
  const sitemapInvalidLastmod = sitemaps.reduce((sum, item) => sum + (item.invalidLastmod || 0), 0);
  const sitemapFutureLastmod = sitemaps.reduce((sum, item) => sum + (item.futureLastmod || 0), 0);
  const sitemapEntries = sitemaps.filter((item) => item.type === 'urlset').reduce((sum, item) => sum + item.urls, 0);
  const sitemapLastmod = sitemaps.filter((item) => item.type === 'urlset').reduce((sum, item) => sum + (item.lastmodCount || 0), 0);
  if (sitemapInvalidLastmod) siteIssues.push(issue('medium', 'indexing', 'Некорректный lastmod в sitemap', `Невалидных дат ISO 8601: ${sitemapInvalidLastmod}.`, 'Исправьте генератор sitemap: передавайте реальную дату существенного обновления в формате ISO 8601.', origin.toString()));
  if (sitemapFutureLastmod) siteIssues.push(issue('high', 'indexing', 'Будущий lastmod в sitemap', `URL с датой более чем на сутки в будущем: ${sitemapFutureLastmod}.`, 'Исправьте часовой пояс и источник даты в CMS; lastmod должен отражать реальное последнее существенное изменение.', origin.toString()));
  if (sitemapEntries >= 5 && sitemapLastmod === 0) siteIssues.push(issue('low', 'indexing', 'В sitemap нет lastmod', `В URL-картах найдено ${sitemapEntries} адресов без lastmod.`, 'Добавьте lastmod из фактической даты существенного изменения контента; не подставляйте время каждого запуска генератора.', origin.toString()));
  if (sitemaps.some((item) => item.suspiciousUniformLastmod)) siteIssues.push(issue('medium', 'indexing', 'lastmod выглядит автоматически перезаписанным', 'В одной из карт сайта 80% или больше URL имеют полностью одинаковую дату. Это эвристика — для массовой публикации значение может быть корректным.', 'Сверьте lastmod с историей изменений CMS и обновляйте дату только при существенном изменении каждой конкретной страницы.', origin.toString()));
  const ignoredSitemapHints = sitemaps.reduce((sum, item) => sum + (item.changefreqCount || 0) + (item.priorityCount || 0), 0);
  if (ignoredSitemapHints) siteIssues.push(issue('low', 'indexing', 'Sitemap использует changefreq/priority', `Найдено ${ignoredSitemapHints} значений changefreq/priority; Bing их игнорирует и ориентируется на точный lastmod.`, 'Не полагайтесь на changefreq/priority. Поддерживайте правдивый lastmod и отправляйте срочные изменения через IndexNow там, где это уместно.', origin.toString()));
  const aiBots = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'PerplexityBot'];
  const aiBotsBlocked = robotsFound ? aiBots.filter((bot) => new RegExp(`user-agent:\\s*${bot}[\\s\\S]{0,400}?disallow:\\s*/`, 'i').test(robotsData.text)) : [];
  if (aiBotsBlocked.length) siteIssues.push(issue('medium', 'ai', 'AI-краулеры заблокированы', `Полностью заблокированы: ${aiBotsBlocked.join(', ')}.`, 'Оставьте блокировку только если она соответствует вашей политике публикации и лицензирования.', origin.toString()));
  const pageByUrl = new Map(pages.map((page) => [normalized(page.url), page]));
  const linksToCheck = [...linkSources.entries()].slice(0, Math.min(500, Math.max(25, options.maxLinkChecks || crawlLimit * 8)));
  const linkChecks: LinkCheck[] = [];
  for (let index = 0; index < linksToCheck.length; index += 8) {
    if (signal?.aborted) throw new DOMException('Аудит отменён', 'AbortError');
    const batch = linksToCheck.slice(index, index + 8);
    emit({ phase: 'links', message: `Проверяем ссылки: ${index}/${linksToCheck.length}`, crawled: pages.length, discovered: visited.size + queue.length, checkedLinks: index, totalLinks: linksToCheck.length });
    const checked = await Promise.all(batch.map(async ([url, meta]): Promise<LinkCheck> => {
      const knownPage = pageByUrl.get(url);
      if (knownPage) return { url, kind: meta.kind, status: knownPage.status, ok: knownPage.status > 0 && knownPage.status < 400, responseTime: knownPage.responseTime, redirectChain: knownPage.redirectChain, sourceUrls: [...meta.sources] };
      const startedLink = Date.now();
      try {
        let detail = await safeFetchDetailed(url, { method: 'HEAD', signal });
        if ([403, 405].includes(detail.response.status)) detail = await safeFetchDetailed(url, { method: 'GET', headers: { range: 'bytes=0-2048' }, signal });
        const status = detail.response.status;
        return { url, kind: meta.kind, status, ok: status > 0 && (status < 400 || status === 401 || status === 403), responseTime: Date.now() - startedLink, redirectChain: detail.chain, sourceUrls: [...meta.sources] };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { url, kind: meta.kind, status: 0, ok: false, responseTime: Date.now() - startedLink, redirectChain: [], sourceUrls: [...meta.sources], error: error instanceof Error ? error.message : 'Не удалось проверить ссылку' };
      }
    }));
    linkChecks.push(...checked);
  }
  const brokenBySource = new Map<string, LinkCheck[]>();
  linkChecks.filter((item) => !item.ok).forEach((item) => item.sourceUrls.forEach((source) => {
    const current = brokenBySource.get(source) || []; current.push(item); brokenBySource.set(source, current);
  }));
  brokenBySource.forEach((broken, source) => {
    const sourcePage = pageByUrl.get(normalized(source)); if (!sourcePage) return;
    const internalCount = broken.filter((item) => item.kind === 'internal').length;
    const externalCount = broken.length - internalCount;
    sourcePage.brokenLinks = broken.length;
    sourcePage.issues.push(issue(internalCount ? 'high' : 'medium', 'links', 'Найдены недоступные ссылки', `Недоступно ссылок: ${broken.length} (внутренних ${internalCount}, внешних ${externalCount}).`, `Исправьте, замените или удалите ссылки: ${broken.slice(0, 3).map((item) => item.url).join(', ')}`, sourcePage.url));
    sourcePage.score = Math.max(0, sourcePage.score - severityPenalty[internalCount ? 'high' : 'medium']);
  });

  const incoming = new Map<string, number>();
  linkGraph.forEach((targets) => [...new Set(targets)].forEach((target) => incoming.set(target, (incoming.get(target) || 0) + 1)));
  const depths = new Map<string, number>();
  const crawlRoot = pages[0] ? normalized(pages[0].url) : normalized(entry);
  depths.set(crawlRoot, 0);
  const depthQueue = [crawlRoot];
  while (depthQueue.length) {
    const source = depthQueue.shift()!;
    const nextDepth = (depths.get(source) || 0) + 1;
    (linkGraph.get(source) || []).forEach((target) => {
      if (!pageByUrl.has(target) || (depths.has(target) && (depths.get(target) || 0) <= nextDepth)) return;
      depths.set(target, nextDepth); depthQueue.push(target);
    });
  }
  pages.forEach((page, index) => {
    const key = normalized(page.url);
    page.incomingLinks = incoming.get(key) || 0;
    page.depth = depths.get(key) ?? -1;
    const listedInSitemap = sitemapUrlSet.has(normalized(page.originalUrl)) || sitemapUrlSet.has(key);
    if (listedInSitemap && index > 0 && page.incomingLinks === 0) {
      page.issues.push(issue('high', 'links', 'Сиротская страница в sitemap', 'URL присутствует в sitemap, но на него не найдено внутренних ссылок среди просканированных страниц.', 'Добавьте страницу в логичную структуру навигации и контекстную перелинковку либо удалите её из sitemap.', page.url));
      page.score = Math.max(0, page.score - severityPenalty.high);
    }
    if (page.depth > 3) {
      page.issues.push(issue('medium', 'links', 'Страница слишком глубоко в структуре', `Минимальная глубина от главной: ${page.depth} переходов.`, 'Добавьте ссылку из релевантного раздела, хлебные крошки или улучшите иерархию каталога.', page.url));
      page.score = Math.max(0, page.score - severityPenalty.medium);
    }
    const missingReciprocals = (page.hreflangs || []).filter((alternate) => {
      const target = pageByUrl.get(normalized(alternate.url));
      return target && !(target.hreflangs || []).some((back) => normalized(back.url) === key);
    });
    if (missingReciprocals.length) {
      page.issues.push(issue('medium', 'onpage', 'hreflang не взаимный', `${missingReciprocals.length} просканированных языковых версий не ссылаются обратно на эту страницу.`, 'Сделайте набор hreflang взаимным: каждая языковая версия должна перечислять себя и остальные канонические версии.', page.url));
      page.score = Math.max(0, page.score - severityPenalty.medium);
    }
  });
  const sitemapProblemPages = pages.filter((page) => sitemapUrlSet.has(normalized(page.originalUrl)) && (!page.indexable || page.redirected || page.status >= 400));
  if (sitemapProblemPages.length) siteIssues.push(issue('high', 'indexing', 'Проблемные URL в sitemap', `Найдено ${sitemapProblemPages.length} неиндексируемых, ошибочных или перенаправляемых URL среди проверенных.`, 'Оставьте в sitemap только канонические индексируемые URL с прямым ответом HTTP 200.', sitemapProblemPages[0]?.originalUrl));
  const parameterGroups = new Map<string, Set<string>>();
  pages.filter((page) => page.urlParameters.length).forEach((page) => {
    const parsed = new URL(page.url); const variants = parameterGroups.get(parsed.pathname) || new Set<string>();
    variants.add(parsed.search); parameterGroups.set(parsed.pathname, variants);
  });
  const parameterTraps = [...parameterGroups.entries()].filter(([, variants]) => variants.size >= 3);
  if (parameterTraps.length) siteIssues.push(issue('high', 'indexing', 'Возможная ловушка URL-параметров', `Для ${parameterTraps.length} путей найдено по 3 и более комбинаций параметров.`, 'Определите полезные фасеты, остальные комбинации закройте от обхода и индексации; настройте canonical и ссылки без служебных параметров.', origin.toString()));

  const duplicateGroups = (selector: (page: PageAudit) => string) => {
    const groups = new Map<string, { value: string; urls: string[] }>();
    pages.forEach((page) => {
      const value = clean(selector(page));
      if (!value) return;
      const key = value.toLowerCase();
      const group = groups.get(key) || { value, urls: [] };
      group.urls.push(page.url); groups.set(key, group);
    });
    return [...groups.values()].filter((group) => group.urls.length > 1);
  };
  const duplicates = {
    titles: duplicateGroups((page) => page.title),
    descriptions: duplicateGroups((page) => page.description),
    h1: duplicateGroups((page) => page.h1[0] || ''),
    content: [] as Array<{ value: string; urls: string[] }>,
  };
  for (let index = 0; index < pages.length; index++) {
    const first = pages[index];
    if (!first || first.wordCount < 180) continue;
    for (let secondIndex = index + 1; secondIndex < pages.length; secondIndex++) {
      const second = pages[secondIndex];
      if (!second || second.wordCount < 180) continue;
      const firstTerms = new Set(first.topTerms.slice(0, 10).map((item) => item.term));
      const secondTerms = new Set(second.topTerms.slice(0, 10).map((item) => item.term));
      const intersection = [...firstTerms].filter((term) => secondTerms.has(term)).length;
      const union = new Set([...firstTerms, ...secondTerms]).size;
      const similarity = union ? intersection / union : 0;
      if (similarity >= 0.78) {
        duplicates.content.push({ value: `Возможная схожесть ${Math.round(similarity * 100)}%`, urls: [first.url, second.url] });
        for (const page of [first, second]) {
          page.contentAnalysis.dimensions.originality = Math.min(page.contentAnalysis.dimensions.originality, Math.max(20, Math.round(100 - similarity * 80)));
          page.contentAnalysis.strengths = page.contentAnalysis.strengths.filter((item) => !item.startsWith('уникальность:'));
          page.contentAnalysis.weaknesses = [...new Set([...page.contentAnalysis.weaknesses, `уникальность: ${page.contentAnalysis.dimensions.originality}/100`])].slice(0, 6);
          page.contentAnalysis.recommendations = [...new Set([...page.contentAnalysis.recommendations, 'Сравните страницу с похожими URL: разделите интенты, добавьте уникальные данные или объедините дубли.'])].slice(0, 8);
          page.contentAnalysis.score = scoreContentDimensions(page.contentAnalysis.dimensions); page.contentScore = page.contentAnalysis.score;
          page.contentAnalysis.grade = page.contentScore >= 90 ? 'A' : page.contentScore >= 75 ? 'B' : page.contentScore >= 60 ? 'C' : page.contentScore >= 40 ? 'D' : 'F';
        }
      }
      if (duplicates.content.length >= 20) break;
    }
    if (duplicates.content.length >= 20) break;
  }
  duplicates.titles.forEach((group) => siteIssues.push(issue('high', 'onpage', 'Дублирующиеся title', `Одинаковый title найден на ${group.urls.length} страницах: «${group.value}».`, 'Сделайте title уникальным под интент каждой страницы.', group.urls[0])));
  duplicates.descriptions.forEach((group) => siteIssues.push(issue('medium', 'onpage', 'Дублирующиеся description', `Одинаковое описание найдено на ${group.urls.length} страницах.`, 'Напишите уникальные описания с конкретной ценностью каждой страницы.', group.urls[0])));
  duplicates.h1.forEach((group) => siteIssues.push(issue('medium', 'onpage', 'Дублирующиеся H1', `Одинаковый H1 найден на ${group.urls.length} страницах: «${group.value}».`, 'Уточните главный заголовок каждой страницы под её отдельную задачу.', group.urls[0])));
  duplicates.content.forEach((group) => siteIssues.push(issue('medium', 'content', 'Возможно похожий контент', `У страниц совпадает большая часть ведущих терминов: ${group.urls.join(' и ')}.`, 'Сравните страницы вручную, объедините дубли или добавьте уникальную ценность и отдельный поисковый интент.', group.urls[0])));
  const templateRiskUrls = new Set(duplicates.content.flatMap((group) => group.urls));
  if (pages.length >= 8 && templateRiskUrls.size >= Math.max(6, Math.ceil(pages.length * .35))) siteIssues.push(issue('high', 'content', 'Риск масштабированных шаблонных страниц', `У ${templateRiskUrls.size} из ${pages.length} страниц ведущая терминология очень похожа. Это эвристика для ручной проверки, а не доказательство нарушения.`, 'Проверьте, не созданы ли страницы только под варианты запросов. Объедините одинаковые интенты и оставьте отдельные URL лишь там, где есть самостоятельная польза, факты или опыт.', [...templateRiskUrls][0]));

  const keywordSummary = targetKeywords.map((keyword) => {
    const metrics = pages.flatMap((page) => page.keywordMetrics.filter((metric) => metric.keyword === keyword));
    const pagesWithKeyword = metrics.filter((metric) => metric.count > 0);
    const competingPages = pages.filter((page) => page.keywordMetrics.some((metric) => metric.keyword === keyword && (metric.inTitle || metric.inH1)));
    if (!pagesWithKeyword.length) siteIssues.push(issue('high', 'content', `Ключевая фраза не найдена: «${keyword}»`, 'Точное вхождение не найдено ни на одной проверенной странице.', 'Проверьте, соответствует ли фраза сайту, и создайте или доработайте отдельную релевантную страницу.', origin.toString()));
    if (competingPages.length > 1) siteIssues.push(issue('high', 'content', `Возможна каннибализация: «${keyword}»`, `Фраза поддержана title или H1 сразу на ${competingPages.length} страницах: ${competingPages.slice(0, 5).map((page) => page.url).join(', ')}. Это сигнал для ручной проверки интентов, а не доказательство конкуренции URL.`, 'Назначьте одну основную страницу под интент, остальные разведите по отдельным задачам, объедините или настройте осмысленную перелинковку.', competingPages[0]?.url));
    return {
      keyword, totalCount: metrics.reduce((sum, metric) => sum + metric.count, 0),
      pageCoverage: Math.round(pagesWithKeyword.length / Math.max(1, pages.length) * 100),
      averageDensity: Number((pagesWithKeyword.reduce((sum, metric) => sum + metric.density, 0) / Math.max(1, pagesWithKeyword.length)).toFixed(2)),
      titleCoverage: Math.round(metrics.filter((metric) => metric.inTitle).length / Math.max(1, pages.length) * 100),
      h1Coverage: Math.round(metrics.filter((metric) => metric.inH1).length / Math.max(1, pages.length) * 100),
      descriptionCoverage: Math.round(metrics.filter((metric) => metric.inDescription).length / Math.max(1, pages.length) * 100),
    };
  });
  const siteTerms = new Map<string, { count: number; pages: number }>();
  pages.forEach((page) => page.topTerms.forEach((term) => {
    const current = siteTerms.get(term.term) || { count: 0, pages: 0 };
    current.count += term.count; current.pages++; siteTerms.set(term.term, current);
  }));
  const totalWords = pages.reduce((sum, page) => sum + page.wordCount, 0);
  const topTerms = [...siteTerms.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 20)
    .map(([term, data]) => ({ term, count: data.count, pages: data.pages, density: Number((data.count / Math.max(1, totalWords) * 100).toFixed(2)) }));
  const anchorMap = new Map<string, { count: number; targets: Set<string> }>();
  collectedAnchors.forEach(({ text, target }) => {
    const key = text.toLowerCase(); const current = anchorMap.get(key) || { count: 0, targets: new Set<string>() };
    current.count++; current.targets.add(target); anchorMap.set(key, current);
  });
  const anchorTexts = [...anchorMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 20)
    .map(([text, data]) => ({ text, count: data.count, targets: data.targets.size }));
  const allIssues = [...siteIssues, ...pages.flatMap((page) => page.issues)];
  const uniqueIssues = [...new Map(allIssues.map((item) => [`${item.title}|${item.url}`, item])).values()];
  const categoryScores = Object.fromEntries(Object.keys(categoryWeights).map((key) => {
    const category = key as Category;
    const penalties = uniqueIssues.filter((item) => item.category === category).reduce((sum, item) => sum + severityPenalty[item.severity], 0);
    return [category, Math.max(0, Math.round(100 - penalties / Math.max(1, Math.sqrt(pages.length))))];
  })) as Record<Category, number>;
  const totals = {
    critical: uniqueIssues.filter((item) => item.severity === 'critical').length,
    high: uniqueIssues.filter((item) => item.severity === 'high').length,
    medium: uniqueIssues.filter((item) => item.severity === 'medium').length,
    low: uniqueIssues.filter((item) => item.severity === 'low').length,
    issues: uniqueIssues.length,
  };
  const weightedScore = Math.round(Object.entries(categoryWeights).reduce((sum, [category, weight]) => sum + categoryScores[category as Category] * weight / 100, 0));
  const score = pages.length === 0 || pages.every((page) => page.status === 0)
    ? 0
    : totals.critical > 0
      ? Math.min(55, weightedScore)
      : totals.high > 0
        ? Math.min(84, weightedScore)
        : weightedScore;
  emit({ phase: 'analyze', message: 'Собираем оценки и рекомендации…', crawled: pages.length, discovered: visited.size + queue.length, checkedLinks: linkChecks.length, totalLinks: linksToCheck.length });
  const responseTimes = pages.filter((page) => page.responseTime > 0).map((page) => page.responseTime).sort((a, b) => a - b);
  const percentileIndex = Math.max(0, Math.ceil(responseTimes.length * .95) - 1);
  const crawlInsights: AuditReport['crawlInsights'] = {
    statusGroups: {
      ok: pages.filter((page) => page.status >= 200 && page.status < 300).length,
      redirects: pages.filter((page) => page.redirected || page.status >= 300 && page.status < 400).length,
      clientErrors: pages.filter((page) => page.status >= 400 && page.status < 500).length,
      serverErrors: pages.filter((page) => page.status >= 500).length,
      failed: pages.filter((page) => page.status === 0).length,
    },
    averageResponseTime: Math.round(responseTimes.reduce((sum, time) => sum + time, 0) / Math.max(1, responseTimes.length)),
    p95ResponseTime: responseTimes[percentileIndex] || 0,
    indexablePages: pages.filter((page) => page.indexable).length,
    nonIndexablePages: pages.filter((page) => !page.indexable).length,
    redirectedPages: pages.filter((page) => page.redirected).length,
    orphanPages: pages.filter((page, index) => index > 0 && sitemapUrlSet.has(normalized(page.originalUrl)) && page.incomingLinks === 0).length,
    deepPages: pages.filter((page) => page.depth > 3).length,
    parameterizedUrls: pages.filter((page) => page.urlParameters.length > 0).length,
    sitemapProblemUrls: sitemapProblemPages.length + invalidSitemapUrls,
    maxDepth: Math.max(0, ...pages.map((page) => page.depth)),
    crawlEfficiency: Math.round(pages.length / Math.max(1, new Set([...visited, ...queue]).size) * 100),
  };
  const report: AuditReport = {
    id: randomUUID(), url: entry.toString(), origin: origin.toString(), createdAt: new Date().toISOString(),
    duration: Date.now() - started, score, grade: score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 40 ? 'D' : 'F',
    pagesScanned: pages.length, crawlLimit, totals, categoryScores,
    targetKeywords, keywordSummary, topTerms,
    contentSummary: {
      averageContentScore: Math.round(pages.reduce((sum, page) => sum + page.contentScore, 0) / Math.max(1, pages.length)),
      averageReadability: Math.round(pages.reduce((sum, page) => sum + page.readabilityScore, 0) / Math.max(1, pages.length)),
      thinPages: pages.filter((page) => page.wordCount < 180).length,
      pagesWithoutAuthor: pages.filter((page) => page.wordCount > 700 && !page.authorFound).length,
      pagesWithoutTrustSignals: pages.filter((page) => page.trustSignals < 2).length,
      averageAiCitationScore: Math.round(pages.reduce((sum, page) => sum + page.aiCitationScore, 0) / Math.max(1, pages.length)),
      averageDimensions: Object.fromEntries((['intent','depth','structure','readability','originality','experience','expertise','trust','keywordUse','aiReadiness'] as const).map((key) => [key, Math.round(pages.reduce((sum, page) => sum + page.contentAnalysis.dimensions[key], 0) / Math.max(1, pages.length))])) as ContentAnalysis['dimensions'],
      weakIntentPages: pages.filter((page) => page.contentAnalysis.dimensions.intent < 60).length,
      lowExperiencePages: pages.filter((page) => page.contentAnalysis.dimensions.experience < 55).length,
      highRepetitionPages: pages.filter((page) => page.contentAnalysis.repetitionRisk >= 45).length,
    },
    duplicates,
    crawl: { discovered: new Set([...visited, ...queue]).size, crawled: pages.length, sitemapUrls, blockedByRobots, brokenInternal: linkChecks.filter((item) => item.kind === 'internal' && !item.ok).length },
    sitemaps,
    linkChecks,
    crawlInsights,
    anchorTexts,
    technical: {
      https: entry.protocol === 'https:', robotsFound, robotsStatus: robotsData.response?.status || 0, robotsText: robotsFound ? robotsData.text.slice(0, 200_000) : '',
      sitemapFound, sitemapStatus: sitemaps[0]?.status || 0, llmsFound: Boolean(llmsData.response?.ok), aiBotsBlocked,
      securityHeaders: pages[0]?.securityHeaders || Object.fromEntries(securityHeaderNames.map((name) => [name, false])),
    },
    issues: uniqueIssues.sort((a, b) => ['critical', 'high', 'medium', 'low'].indexOf(a.severity) - ['critical', 'high', 'medium', 'low'].indexOf(b.severity)),
    pages,
  };
  emit({ phase: 'complete', message: 'Аудит завершён', crawled: pages.length, discovered: visited.size + queue.length, checkedLinks: linkChecks.length, totalLinks: linksToCheck.length });
  return report;
}
