export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Category = 'indexing' | 'onpage' | 'content' | 'links' | 'images' | 'schema' | 'performance' | 'social' | 'ai';

export interface AuditIssue {
  id: string;
  severity: Severity;
  category: Category;
  title: string;
  description: string;
  recommendation: string;
  solutionSteps: string[];
  codexPrompt: string;
  url?: string;
}

export interface KeywordMetric {
  keyword: string;
  count: number;
  density: number;
  inTitle: boolean;
  inDescription: boolean;
  inH1: boolean;
  inFirst100Words: boolean;
  inUrl: boolean;
}

export interface TopTerm {
  term: string;
  count: number;
  density: number;
}

export interface DuplicateGroup {
  value: string;
  urls: string[];
}

export interface RedirectHop {
  from: string;
  to: string;
  status: number;
}

export interface LinkCheck {
  url: string;
  kind: 'internal' | 'external';
  status: number;
  ok: boolean;
  responseTime: number;
  redirectChain: RedirectHop[];
  sourceUrls: string[];
  error?: string;
}

export interface SitemapAudit {
  url: string;
  status: number;
  type: 'urlset' | 'index' | 'unknown';
  urls: number;
  invalidUrls: number;
  lastmodCount?: number;
  invalidLastmod?: number;
  futureLastmod?: number;
  suspiciousUniformLastmod?: boolean;
  changefreqCount?: number;
  priorityCount?: number;
  error?: string;
}

export interface AuditProgress {
  phase: 'prepare' | 'sitemaps' | 'crawl' | 'links' | 'analyze' | 'complete';
  message: string;
  crawled: number;
  discovered: number;
  checkedLinks: number;
  totalLinks: number;
  currentUrl?: string;
}

export interface SearchConsoleRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface ContentAnalysis {
  score: number;
  pageType: 'homepage' | 'article' | 'product' | 'category' | 'service' | 'about' | 'contact' | 'faq' | 'landing';
  searchIntent: 'informational' | 'commercial' | 'transactional' | 'navigational' | 'local' | 'mixed';
  minimumWords: number;
  grade: string;
  readingTime: number;
  sentenceCount: number;
  averageSentenceWords: number;
  longSentencePercent: number;
  primaryTopic: string;
  firstParagraph: string;
  outline: string[];
  ctaFound: boolean;
  sourceLinks: number;
  factsAndNumbers: number;
  repetitionRisk: number;
  dimensions: {
    intent: number;
    depth: number;
    structure: number;
    readability: number;
    originality: number;
    experience: number;
    expertise: number;
    trust: number;
    keywordUse: number;
    aiReadiness: number;
  };
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
  checks: Array<{
    id: string;
    label: string;
    passed: boolean;
    severity: Severity;
    evidence: string;
    recommendation: string;
    codexPrompt: string;
  }>;
  codexPrompt: string;
}

export interface PageAudit {
  url: string;
  originalUrl: string;
  finalUrl: string;
  redirected: boolean;
  redirectChain: RedirectHop[];
  status: number;
  responseTime: number;
  contentType: string;
  title: string;
  titleLength: number;
  description: string;
  descriptionLength: number;
  h1: string[];
  h2Count: number;
  canonical: string;
  robots: string;
  xRobots?: string;
  lang: string;
  wordCount: number;
  internalLinks: number;
  outgoingInternalUrls?: string[];
  externalLinks: number;
  brokenLinks: number;
  images: number;
  imagesMissingAlt: number;
  imagesMissingDimensions: number;
  responsiveImagesMissingFallback?: number;
  unstableImageUrls?: number;
  genericImageFilenames?: number;
  videos?: number;
  videosMissingPoster?: number;
  videoSchemaFound?: boolean;
  schemaTypes: string[];
  schemaErrors: string[];
  ogComplete: boolean;
  twitterComplete: boolean;
  hreflangCount: number;
  hreflangs?: Array<{ lang: string; url: string }>;
  hreflangErrors?: number;
  contentAnalysis: ContentAnalysis;
  contentScore: number;
  readabilityScore: number;
  paragraphs: number;
  lists: number;
  tables: number;
  questions: number;
  authorFound: boolean;
  dateFound: boolean;
  publishedDate?: string;
  modifiedDate?: string;
  invalidDates?: number;
  jsAppShellRisk?: boolean;
  unversionedAssets?: number;
  snippetControls?: string[];
  securityHeaders?: Record<string, boolean>;
  trustSignals: number;
  aiCitationScore: number;
  htmlBytes: number;
  domNodes: number;
  scripts: number;
  thirdPartyScripts: number;
  stylesheets: number;
  textHtmlRatio: number;
  hasFavicon: boolean;
  formsMissingLabels: number;
  emptyLinks: number;
  headingOrderIssues: number;
  depth: number;
  incomingLinks: number;
  urlParameters: string[];
  indexable: boolean;
  cwvRisks: { lcp: number; inp: number; cls: number };
  keywordMetrics: KeywordMetric[];
  topTerms: TopTerm[];
  score: number;
  issues: AuditIssue[];
}

export interface AuditReport {
  id: string;
  url: string;
  origin: string;
  createdAt: string;
  duration: number;
  score: number;
  grade: string;
  pagesScanned: number;
  crawlLimit: number;
  totals: { critical: number; high: number; medium: number; low: number; issues: number };
  categoryScores: Record<Category, number>;
  targetKeywords: string[];
  keywordSummary: Array<{
    keyword: string;
    totalCount: number;
    pageCoverage: number;
    averageDensity: number;
    titleCoverage: number;
    h1Coverage: number;
    descriptionCoverage: number;
  }>;
  topTerms: Array<TopTerm & { pages: number }>;
  contentSummary: {
    averageContentScore: number;
    averageReadability: number;
    thinPages: number;
    pagesWithoutAuthor: number;
    pagesWithoutTrustSignals: number;
    averageAiCitationScore: number;
    averageDimensions: ContentAnalysis['dimensions'];
    weakIntentPages: number;
    lowExperiencePages: number;
    highRepetitionPages: number;
  };
  duplicates: { titles: DuplicateGroup[]; descriptions: DuplicateGroup[]; h1: DuplicateGroup[]; content: DuplicateGroup[] };
  crawl: { discovered: number; crawled: number; sitemapUrls: number; blockedByRobots: number; brokenInternal: number };
  sitemaps: SitemapAudit[];
  linkChecks: LinkCheck[];
  searchConsole?: SearchConsoleRow[];
  crawlInsights: {
    statusGroups: { ok: number; redirects: number; clientErrors: number; serverErrors: number; failed: number };
    averageResponseTime: number;
    p95ResponseTime: number;
    indexablePages: number;
    nonIndexablePages: number;
    redirectedPages: number;
    orphanPages: number;
    deepPages: number;
    parameterizedUrls: number;
    sitemapProblemUrls: number;
    maxDepth: number;
    crawlEfficiency: number;
  };
  anchorTexts: Array<{ text: string; count: number; targets: number }>;
  technical: {
    https: boolean;
    robotsFound: boolean;
    robotsStatus: number;
    robotsText?: string;
    sitemapFound: boolean;
    sitemapStatus: number;
    llmsFound: boolean;
    aiBotsBlocked: string[];
    securityHeaders: Record<string, boolean>;
  };
  issues: AuditIssue[];
  pages: PageAudit[];
}
