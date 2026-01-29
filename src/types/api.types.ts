// src/types/api.types.ts

export type SearchApiProvider = 'serpapi' | 'google_custom_search';

export interface ISerpApiKey {
  id: string;
  key: string;
  dailyLimit: number;
  monthlyLimit: number;
  usedToday: number;
  usedThisMonth: number;
  status: 'active' | 'exhausted' | 'error' | 'paused';
  priority: number;
  lastUsed: Date;
  errorCount: number;
  successRate: number;
  monthlyResetAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  provider?: SearchApiProvider; // New field to identify API provider
  cseId?: string; // Custom Search Engine ID for Google Custom Search
}

export interface ISearchOptions {
  domain: string;
  country: string;
  language?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  device?: 'desktop' | 'mobile' | 'tablet';
  location?: string;
  apiKey?: string;
  apiProvider?: SearchApiProvider; // API provider to use
  cseId?: string; // Custom Search Engine ID for Google Custom Search
  // New options for better accuracy
  searchEngine?: 'google' | 'bing' | 'yahoo';
  maxResults?: number; // Default 100
  includeAds?: boolean; // Track ad positions
  verificationMode?: boolean; // Enable position verification
  customParams?: Record<string, string>; // Additional SerpAPI params
}

export type PositionSource = 'serpapi_position' | 'array_index_fallback' | 'verified' | 'unknown';

export interface ISerpFeature {
  type: 'ads' | 'featured_snippet' | 'people_also_ask' | 'local_pack' | 'shopping' | 'images' | 'videos' | 'knowledge_panel' | 'related_searches' | 'other';
  position?: number;
  count?: number;
}

export interface IPositionValidation {
  originalPosition: number | null;
  verifiedPosition?: number | null;
  positionSource: PositionSource;
  confidence: number; // 0-100
  discrepancy?: number; // Difference if verified
  serpFeatures: ISerpFeature[];
  organicResultsCount: number;
  totalResultsInSerp: number; // Including ads, features, etc.
  validationMethod: 'serpapi_trusted' | 'cross_verified' | 'fallback_used' | 'unverified';
  warnings: string[];
  arrayIndexPosition?: number; // Store array index for comparison
}

export interface ISearchMetadata {
  searchTime?: string;
  searchId?: string;
  location?: string;
  device?: string;
  searchEngine?: string;
  apiKeyUsed?: string;
  processingTime?: number;
  requestTimestamp?: Date;
  responseTimestamp?: Date;
  cacheUsed?: boolean;
  rawParams?: Record<string, string>;
  apiUsage?: IApiUsageInfo; // API usage information from provider
}

export interface ISearchResult {
  keyword: string;
  domain: string;
  position: number | null;
  url: string;
  title: string;
  description: string;
  country: string;
  city: string;
  state: string;
  postalCode: string;
  totalResults: number;
  searchedResults: number;
  timestamp: Date;
  found: boolean;
  
  // Enhanced validation data
  positionValidation: IPositionValidation;
  searchMetadata: ISearchMetadata;
  
  // Raw data for debugging and verification
  rawSerpData?: {
    organic_results?: any[];
    ads?: any[];
    search_information?: any;
    search_parameters?: any;
    serpapi_pagination?: any;
    googleCustomSearch?: {
      items?: any[];
      searchInformation?: any;
      queries?: any;
    };
  };
  
  // Additional ranking context
  competitorUrls?: Array<{
    position: number;
    url: string;
    domain: string;
    title: string;
  }>;
  
  // Quality indicators
  resultQuality?: {
    positionReliability: 'high' | 'medium' | 'low';
    dataFreshness: 'realtime' | 'cached' | 'unknown';
    serpComplexity: 'simple' | 'moderate' | 'complex'; // Based on SERP features
  };
}

export interface IBulkSearchRequest {
  keywords: string[];
  domain: string;
  country: string;
  city?: string;
  state?: string;
  postalCode?: string;
  language?: string;
  device?: string;
  searchEngine?: string;
  maxResults?: number;
  verificationMode?: boolean;
}

export interface IFailedSearch {
  keyword: string;
  error: string;
  errorType: 'quota_exceeded' | 'rate_limited' | 'invalid_request' | 'timeout' | 'network_error' | 'parse_error' | 'unknown';
  timestamp: Date;
  retryCount?: number;
  apiKeyUsed?: string;
}

export interface IBulkSearchResult {
  totalProcessed: number;
  successful: ISearchResult[];
  failed: IFailedSearch[];
  processingTime: number;
  keyUsageStats: {
    total: number;
    active: number;
    exhausted: number;
    totalUsageToday: number;
    remainingCapacity: number;
  };
  qualityMetrics?: {
    highConfidenceResults: number;
    mediumConfidenceResults: number;
    lowConfidenceResults: number;
    verifiedPositions: number;
    fallbackPositions: number;
  };
}

export interface IProcessingProgress {
  total: number;
  processed: number;
  successful: number;
  failed: number;
  currentBatch: number;
  totalBatches: number;
  keyStats: {
    total: number;
    active: number;
    exhausted: number;
    totalUsageToday: number;
    remainingCapacity: number;
  };
  retryAttempt?: number;
  currentKeyword?: string;
  failedKeywords?: string[];
  estimatedTimeRemaining?: number; // milliseconds
  averageProcessingTime?: number; // milliseconds per keyword
  startTime?: Date;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  errors?: string[];
  warnings?: string[]; // Position accuracy warnings, etc.
  keyStats?: {
    total: number;
    active: number;
    exhausted: number;
    totalUsageToday: number;
    remainingCapacity: number;
    usagePercentage: number;
  };
  metadata?: {
    processingTime?: number;
    timestamp?: Date;
    apiVersion?: string;
    positionVerification?: boolean;
  };
}

export interface IApiKeyTestResult {
  valid: boolean;
  message: string;
  details?: {
    error?: string;
    errorType?: 'quota_exceeded' | 'rate_limited' | 'unauthorized' | 'invalid_key' | 'unknown';
    errorMessage?: string;
    totalResults?: number;
    responseTime?: number;
    testKeyword?: string;
    testDomain?: string;
    serpApiResponse?: any;
  };
}

export interface IApiKeyAddResult {
  success: boolean;
  message: string;
  keyId?: string;
  testResult?: IApiKeyTestResult;
}

export interface IApiKeyUpdateResult {
  success: boolean;
  message: string;
  updatedKey?: {
    id: string;
    dailyLimit?: number;
    monthlyLimit?: number;
    priority?: number;
  };
}

export interface IApiKeyRemoveResult {
  success: boolean;
  message: string;
  removedKeyId?: string;
}

export interface IKeyHealthStatus {
  id: string;
  status: 'active' | 'exhausted' | 'error' | 'paused';
  usedToday: number;
  dailyLimit: number;
  usagePercentage: number;
  remainingRequests: number;
  successRate: number;
  errorCount: number;
  lastUsed: string; // ISO string
  priority: number;
  healthStatus: 'healthy' | 'warning' | 'critical' | 'exhausted';
  usedThisMonth: number;
  monthlyLimit: number;
  monthlyUsagePercentage: number;
  estimatedDailyExhaustion?: string | null;
}

export interface IApiUsageInfo {
  used: number;
  remaining: number;
  limit: number;
  resetDate?: string;
  percentageUsed: number;
  provider?: 'valueserp' | 'serpapi' | 'google_custom_search' | 'unknown';
}

export interface IPoolStats {
  total: number;
  active: number;
  exhausted: number;
  paused: number;
  totalUsageToday: number;
  totalCapacity: number;
  hasEnvironmentKeys: boolean;
  usagePercentage: number;
  remainingCapacity: number;
  estimatedTimeToExhaustion?: string;
  criticalKeys: number;
  warningKeys: number;
  totalUsageThisMonth: number;
  totalMonthlyCapacity: number;
  monthlyUsagePercentage: number;
}

// SerpAPI specific response types for better type safety
export interface ISerpApiOrganicResult {
  position: number;
  title: string;
  link: string;
  displayed_link?: string;
  snippet?: string;
  snippet_highlighted_words?: string[];
  sitelinks?: any;
  rich_snippet?: any;
  cached_page_link?: string;
  related_pages_link?: string;
  source?: string;
  date?: string;
  thumbnail?: string;
}

export interface ISerpApiResponse {
  search_metadata: {
    id: string;
    status: string;
    json_endpoint: string;
    created_at: string;
    processed_at: string;
    google_url: string;
    raw_html_file: string;
    total_time_taken: number;
  };
  search_parameters: {
    engine: string;
    q: string;
    google_domain?: string;
    gl?: string;
    hl?: string;
    location?: string;
    device?: string;
    num?: string;
  };
  search_information: {
    query_displayed?: string;
    total_results?: number | string;
    time_taken_displayed?: number;
    organic_results_state?: string;
  };
  organic_results?: ISerpApiOrganicResult[];
  ads?: any[];
  inline_images?: any[];
  inline_videos?: any[];
  related_searches?: any[];
  pagination?: any;
  serpapi_pagination?: any;
  answer_box?: any;
  knowledge_graph?: any;
  local_results?: any;
  top_stories?: any;
  tweets?: any;
}

// Google Custom Search API response types
export interface IGoogleCustomSearchItem {
  kind: string;
  title: string;
  htmlTitle: string;
  link: string;
  displayLink: string;
  snippet: string;
  htmlSnippet: string;
  cacheId?: string;
  formattedUrl: string;
  htmlFormattedUrl: string;
  pagemap?: any;
}

export interface IGoogleCustomSearchResponse {
  kind: string;
  url: {
    type: string;
    template: string;
  };
  queries: {
    request: Array<{
      title: string;
      totalResults: string;
      searchTerms: string;
      count: number;
      startIndex: number;
      inputEncoding: string;
      outputEncoding: string;
      safe: string;
      cx: string;
    }>;
    nextPage?: Array<{
      title: string;
      totalResults: string;
      searchTerms: string;
      count: number;
      startIndex: number;
      inputEncoding: string;
      outputEncoding: string;
      safe: string;
      cx: string;
    }>;
  };
  context?: {
    title: string;
  };
  searchInformation: {
    searchTime: number;
    formattedSearchTime: string;
    totalResults: string;
    formattedTotalResults: string;
  };
  items?: IGoogleCustomSearchItem[];
  error?: {
    code: number;
    message: string;
    errors?: Array<{
      domain: string;
      reason: string;
      message: string;
    }>;
  };
}

export interface IDomainMatchResult {
  matched: boolean;
  matchType: 'exact' | 'normalized' | 'subdomain' | 'main_domain' | 'none';
  domain1: string;
  domain2: string;
  normalizedDomain1?: string;
  normalizedDomain2?: string;
  confidence: number; // 0-100
}

// Error types for better error handling
export class SerpApiError extends Error {
  constructor(
    message: string,
    public errorType: 'quota_exceeded' | 'rate_limited' | 'invalid_request' | 'timeout' | 'network_error' | 'parse_error' | 'unknown',
    public statusCode?: number,
    public details?: any
  ) {
    super(message);
    this.name = 'SerpApiError';
  }
}

export class ApiKeyExhaustedError extends Error {
  constructor(
    message: string,
    public keyId: string,
    public usedToday: number,
    public dailyLimit: number
  ) {
    super(message);
    this.name = 'ApiKeyExhaustedError';
  }
}

export class AllKeysExhaustedError extends Error {
  constructor(
    message: string,
    public totalKeys: number,
    public exhaustedKeys: number
  ) {
    super(message);
    this.name = 'AllKeysExhaustedError';
  }
}