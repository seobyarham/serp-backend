// src/services/serpApiPoolManager.ts
import fetch from 'node-fetch';
import { logger } from '../utils/logger';
import { ApiKeyModel } from '../models/ApiKey';
import { SearchResultModel } from '../models/SearchResult';
import {
  ISerpApiKey,
  ISearchOptions,
  ISearchResult,
  ISerpApiResponse,
  ISerpApiOrganicResult,
  IPositionValidation,
  ISerpFeature,
  ISearchMetadata,
  IDomainMatchResult,
  SerpApiError,
  ApiKeyExhaustedError,
  AllKeysExhaustedError,
  IApiKeyTestResult,
  IApiKeyAddResult,
  IApiKeyUpdateResult,
  IApiKeyRemoveResult,
  IKeyHealthStatus,
  IPoolStats,
  IApiUsageInfo,
  PositionSource,
  SearchApiProvider,
  IGoogleCustomSearchResponse,
  IGoogleCustomSearchItem
} from '../types/api.types';

export class SerpApiPoolManager {
  private static instance: SerpApiPoolManager;
  private apiKeys: ISerpApiKey[] = [];
  private currentKeyIndex = 0;
  private rotationStrategy: 'round-robin' | 'priority' | 'least-used' = 'priority';
  private isInitialized = false;
  private keyUsageLock = new Map<string, boolean>();

  private constructor() {}

  public static getInstance(): SerpApiPoolManager {
    if (!SerpApiPoolManager.instance) {
      SerpApiPoolManager.instance = new SerpApiPoolManager();
    }
    return SerpApiPoolManager.instance;
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.info('SerpApi Pool Manager already initialized');
      return;
    }

    await this.loadApiKeys();
    await this.checkAndResetMonthlyUsage();
    this.rotationStrategy = (process.env.SERPAPI_ROTATION_STRATEGY as any) || 'priority';
    this.isInitialized = true;
    
    logger.info(`SerpApi Pool Manager initialized with ${this.apiKeys.length} keys using ${this.rotationStrategy} strategy`);
    
    // Log detailed key status
    this.apiKeys.forEach(key => {
      logger.info(`API Key ${key.id}: Status=${key.status}, UsedToday=${key.usedToday}/${key.dailyLimit}, Priority=${key.priority}`);
    });
  }

  private async loadApiKeys(): Promise<void> {
    const keys: ISerpApiKey[] = [];
    let keyIndex = 1;

    // Step 1: Load keys from environment variables (SERPAPI_KEY_1, SERPAPI_KEY_2, etc.)
    while (process.env[`SERPAPI_KEY_${keyIndex}`] || keyIndex === 1) {
      const key = process.env[`SERPAPI_KEY_${keyIndex}`] || (process.env.SERPAPI_KEY || '').trim();
      // Skip placeholder values and empty keys
      if (key && 
          key.length > 10 && 
          key !== 'your_serpapi_key_here' && 
          key !== 'your_first_actual_key' &&
          key !== 'your_second_actual_key' &&
          key !== 'your_third_actual_key' &&
          key !== 'paste_your_actual_key_here' &&
          !key.includes('your_second_serpapi_key_here') &&
          !key.includes('your_third_serpapi_key_here') &&
          !key.includes('CHANGE_ME') &&
          !key.includes('replace_with')) {
        keys.push({
          id: `serpapi_${keyIndex}`,
          key,
          provider: 'serpapi',
          dailyLimit: parseInt(process.env[`SERPAPI_DAILY_LIMIT_${keyIndex}`] || process.env.SERPAPI_DAILY_LIMIT || '5000'),
          monthlyLimit: parseInt(process.env[`SERPAPI_MONTHLY_LIMIT_${keyIndex}`] || process.env.SERPAPI_MONTHLY_LIMIT || '100000'),
          usedToday: 0,
          usedThisMonth: 0,
          status: 'active',
          priority: keyIndex,
          lastUsed: new Date(),
          errorCount: 0,
          successRate: 100,
          monthlyResetAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        });
        logger.info(`Loaded environment API key ${keyIndex} (SerpAPI) with daily limit: ${keys[keys.length - 1].dailyLimit}`);
      }
      keyIndex++;
      if (keyIndex > 100) break; // Safety limit
    }

    if (keys.length === 0) {
      logger.warn('⚠️ No valid SerpApi keys found in environment variables. Please set SERPAPI_KEY_1, SERPAPI_KEY_2, etc.');
      logger.warn('⚠️ The system will work with user-provided API keys from the database.');
    }

    // Step 2: Load user-added keys from database
    try {
      const userAddedKeys = await ApiKeyModel.find({ isUserAdded: true });
      logger.info(`📦 Found ${userAddedKeys.length} user-added API keys in database`);
      
      for (const dbKey of userAddedKeys) {
        // Check if key is not already loaded from environment
        const isDuplicate = keys.some(k => k.key === dbKey.apiKey);
        if (!isDuplicate) {
          const keyConfig: ISerpApiKey = {
            id: dbKey.keyId,
            key: dbKey.apiKey,
            provider: dbKey.provider || 'serpapi',
            cseId: dbKey.cseId,
            dailyLimit: dbKey.dailyLimit,
            monthlyLimit: dbKey.monthlyLimit,
            usedToday: dbKey.usedToday,
            usedThisMonth: dbKey.usedThisMonth,
            status: dbKey.status === 'exhausted' ? 'active' : dbKey.status,
            priority: dbKey.priority,
            lastUsed: dbKey.lastUsed,
            errorCount: dbKey.errorCount,
            successRate: dbKey.successRate,
            monthlyResetAt: dbKey.monthlyResetAt,
            createdAt: dbKey.createdAt,
            updatedAt: dbKey.updatedAt
          };
          keys.push(keyConfig);
          logger.info(`✅ Loaded user-added ${dbKey.provider} key: ${dbKey.keyId} (Daily: ${dbKey.usedToday}/${dbKey.dailyLimit}, Monthly: ${dbKey.usedThisMonth}/${dbKey.monthlyLimit})`);
        } else {
          logger.debug(`⏩ Skipping duplicate key from database: ${dbKey.keyId}`);
        }
      }
    } catch (error) {
      logger.error('❌ Failed to load user-added keys from database:', error);
    }

    // Step 3: Load/update existing usage data from database for environment keys
    for (const keyConfig of keys) {
      // Skip if already loaded from database
      if (keyConfig.id.startsWith('user_')) continue;
      
      try {
        const existingKey = await ApiKeyModel.findOne({ keyId: keyConfig.id });
        if (existingKey) {
          keyConfig.usedToday = existingKey.usedToday;
          keyConfig.usedThisMonth = existingKey.usedThisMonth;
          keyConfig.status = existingKey.status === 'exhausted' ? 'active' : existingKey.status;
          keyConfig.errorCount = existingKey.errorCount;
          keyConfig.successRate = existingKey.successRate;
          keyConfig.lastUsed = existingKey.lastUsed;
          logger.debug(`Restored usage data for key ${keyConfig.id}: ${keyConfig.usedToday}/${keyConfig.dailyLimit}`);
        } else {
          // Create new database entry for environment key
          await ApiKeyModel.create({
            keyId: keyConfig.id,
            apiKey: keyConfig.key,
            provider: keyConfig.provider || 'serpapi',
            cseId: keyConfig.cseId,
            dailyLimit: keyConfig.dailyLimit,
            monthlyLimit: keyConfig.monthlyLimit,
            usedToday: 0,
            usedThisMonth: 0,
            status: 'active',
            priority: keyConfig.priority,
            errorCount: 0,
            successRate: 100,
            monthlyResetAt: new Date(),
            isUserAdded: false
          });
          logger.debug(`Created database entry for environment key: ${keyConfig.id}`);
        }
      } catch (error) {
        logger.warn(`Failed to load existing data for key ${keyConfig.id}:`, error);
      }
    }

    this.apiKeys = keys;
    const totalCapacity = keys.reduce((sum, k) => sum + k.dailyLimit, 0);
    const serpApiKeys = keys.filter(k => k.provider === 'serpapi').length;
    const googleKeys = keys.filter(k => k.provider === 'google_custom_search').length;
    
    logger.info(`✅ Loaded ${keys.length} total API keys (${serpApiKeys} SerpAPI, ${googleKeys} Google Custom Search) with total daily capacity: ${totalCapacity.toLocaleString()}`);
  }

  public async trackKeyword(keyword: string, options: ISearchOptions): Promise<ISearchResult> {
    if (!this.isInitialized) {
      throw new Error('SerpApi Pool Manager not initialized. Call initialize() first.');
    }

    const startTime = Date.now();

    // If a specific API key is provided, use it directly
    if (options.apiKey) {
      const tempKeyConfig: ISerpApiKey = {
        id: 'user-provided-key',
        key: options.apiKey,
        dailyLimit: 100,
        monthlyLimit: 1000,
        usedToday: 0,
        usedThisMonth: 0,
        status: 'active',
        priority: 0,
        lastUsed: new Date(),
        errorCount: 0,
        successRate: 100,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      try {
        logger.debug(`Using provided API key for keyword: "${keyword}"`);
        const result = await this.makeRequest(tempKeyConfig, keyword, options);
        result.searchMetadata.processingTime = Date.now() - startTime;
        return result;
      } catch (error) {
        throw new SerpApiError(
          `Failed to use provided API key: ${(error as Error).message}`,
          'invalid_request',
          undefined,
          { providedKey: true }
        );
      }
    }

    let lastError: Error | null = null;
    const maxRetries = Math.min(this.apiKeys.length, parseInt(process.env.SERPAPI_MAX_RETRIES || '3'));

    logger.debug(`Starting keyword tracking: "${keyword}" for domain: ${options.domain}`);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const keyConfig = await this.getNextAvailableKey();

      if (!keyConfig) {
        throw new AllKeysExhaustedError(
          'All SerpApi keys exhausted or unavailable. Please check your API key limits.',
          this.apiKeys.length,
          this.apiKeys.filter(k => k.status === 'exhausted').length
        );
      }

      // Lock this key during usage
      if (this.keyUsageLock.get(keyConfig.id)) {
        logger.debug(`Key ${keyConfig.id} is locked, trying next available key`);
        continue;
      }

      this.keyUsageLock.set(keyConfig.id, true);

      try {
        logger.debug(`Using API key ${keyConfig.id} (attempt ${attempt + 1}/${maxRetries})`);
        const result = await this.makeRequest(keyConfig, keyword, options);
        
        // Add processing metadata
        result.searchMetadata.processingTime = Date.now() - startTime;
        result.searchMetadata.apiKeyUsed = keyConfig.id;

        // Update usage stats
        await this.updateKeyUsage(keyConfig.id, true);

        // Save result to database
        await this.saveSearchResult(result);

        logger.info(`✅ Keyword "${keyword}" tracked successfully with key ${keyConfig.id} in ${result.searchMetadata.processingTime}ms - Position: ${result.position || 'Not Found'} (Confidence: ${result.positionValidation.confidence}%)`);
        return result;

      } catch (error) {
        lastError = error as Error;
        logger.warn(`❌ Error with key ${keyConfig.id} for keyword "${keyword}": ${(error as Error).message}`);

        if (this.isQuotaExceeded(error)) {
          await this.markKeyExhausted(keyConfig.id);
          logger.warn(`Key ${keyConfig.id} quota exceeded, marking as exhausted`);
        } else if (this.isRateLimited(error)) {
          await this.pauseKey(keyConfig.id, 60000);
          logger.warn(`Key ${keyConfig.id} rate limited, pausing for 1 minute`);
        } else {
          await this.updateKeyUsage(keyConfig.id, false);
        }
      } finally {
        this.keyUsageLock.delete(keyConfig.id);
      }
    }

    throw new SerpApiError(
      `Failed to track keyword "${keyword}" after ${maxRetries} attempts. Last error: ${lastError?.message}`,
      'unknown',
      undefined,
      { keyword, attempts: maxRetries, lastError: lastError?.message }
    );
  }

  private async getNextAvailableKey(provider: SearchApiProvider = 'serpapi'): Promise<ISerpApiKey | null> {
    const availableKeys = this.apiKeys.filter(key =>
      key.status === 'active' &&
      key.provider === provider &&
      key.usedToday < key.dailyLimit &&
      key.usedThisMonth < key.monthlyLimit &&
      !this.keyUsageLock.get(key.id)
    );

    if (availableKeys.length === 0) {
      logger.warn(`No available ${provider} API keys found`);
      return null;
    }

    let selectedKey: ISerpApiKey;

    switch (this.rotationStrategy) {
      case 'priority':
        selectedKey = availableKeys.sort((a, b) => a.priority - b.priority)[0];
        break;

      case 'least-used':
        selectedKey = availableKeys.sort((a, b) => a.usedToday - b.usedToday)[0];
        break;

      case 'round-robin':
      default:
        selectedKey = availableKeys[this.currentKeyIndex % availableKeys.length];
        this.currentKeyIndex = (this.currentKeyIndex + 1) % availableKeys.length;
        break;
    }

    logger.debug(`Selected key ${selectedKey.id} using ${this.rotationStrategy} strategy (${selectedKey.usedToday}/${selectedKey.dailyLimit} used)`);
    return selectedKey;
  }

  private async makeRequest(keyConfig: ISerpApiKey, keyword: string, options: ISearchOptions): Promise<ISearchResult> {
    const requestStartTime = Date.now();
    
    // Check which API provider to use
    const provider = options.apiProvider || keyConfig.provider || 'serpapi';
    
    if (provider === 'google_custom_search') {
      return this.makeGoogleCustomSearchRequest(keyword, options);
    } else {
      return this.makeSerpApiRequest(keyConfig, keyword, options, requestStartTime);
    }
  }

  private async makeSerpApiRequest(keyConfig: ISerpApiKey, keyword: string, options: ISearchOptions, requestStartTime: number): Promise<ISearchResult> {
    const params = new URLSearchParams({
      engine: options.searchEngine || 'google',
      q: keyword.trim(),
      api_key: keyConfig.key,
      gl: options.country.toLowerCase(),
      hl: options.language || 'en',
      num: String(options.maxResults || 120),
      start: '0',
      device: options.device || 'desktop',
      safe: 'off',
      filter: '0',
      no_cache: 'true'
    });

    // Add location parameters - works WITH or WITHOUT city/state/country
    // If city/state/country provided → use location-based ranking
    // If NOT provided → keyword-only ranking (accurate regardless of location)
    const locationParts: string[] = [];
    
    if (options.city && options.city.trim()) {
      locationParts.push(options.city.trim());
    }
    
    if (options.state && options.state.trim()) {
      locationParts.push(options.state.trim());
    }
    
    if (options.country && options.country.trim()) {
      // Convert country code to full name for SerpAPI location parameter
      const countryMap: Record<string, string> = {
        'US': 'United States',
        'UK': 'United Kingdom',
        'CA': 'Canada',
        'AU': 'Australia',
        'NZ': 'New Zealand',
        'IE': 'Ireland',
        'IN': 'India',
        'DE': 'Germany',
        'FR': 'France',
        'ES': 'Spain',
        'IT': 'Italy',
        'BR': 'Brazil',
        'MX': 'Mexico',
        'AR': 'Argentina',
        'CL': 'Chile',
        'CO': 'Colombia',
        'PE': 'Peru',
        'JP': 'Japan',
        'CN': 'China',
        'KR': 'South Korea',
        'SG': 'Singapore',
        'MY': 'Malaysia',
        'TH': 'Thailand',
        'PH': 'Philippines',
        'ID': 'Indonesia',
        'VN': 'Vietnam',
        'ZA': 'South Africa',
        'NG': 'Nigeria',
        'KE': 'Kenya',
        'EG': 'Egypt',
        'SA': 'Saudi Arabia',
        'AE': 'United Arab Emirates',
        'IL': 'Israel',
        'TR': 'Turkey',
        'RU': 'Russia',
        'PL': 'Poland',
        'NL': 'Netherlands',
        'BE': 'Belgium',
        'SE': 'Sweden',
        'NO': 'Norway',
        'DK': 'Denmark',
        'FI': 'Finland',
        'CH': 'Switzerland',
        'AT': 'Austria',
        'PT': 'Portugal',
        'GR': 'Greece',
        'CZ': 'Czech Republic',
        'RO': 'Romania',
        'HU': 'Hungary'
      };
      
      const countryCode = options.country.toUpperCase().trim();
      const countryName = countryMap[countryCode] || options.country;
      locationParts.push(countryName);
    }
    
    // Only add location parameter if we have location data
    // Otherwise, SerpAPI will use keyword-only ranking (works globally)
    if (locationParts.length > 0) {
      const locationString = locationParts.join(', ');
      params.append('location', locationString);
      logger.info(`📍 Location-based search: "${locationString}"`);
    } else {
      logger.info(`🌍 Keyword-only search: No location specified (global results)`);
    }

    if (options.postalCode) {
      const existingLocation = params.get('location');
      if (existingLocation) {
        params.set('location', `${existingLocation} ${options.postalCode.trim()}`);
      } else {
        params.set('location', `${options.postalCode.trim()}`);
      }
    }

    // Add custom parameters if provided
    if (options.customParams) {
      Object.entries(options.customParams).forEach(([key, value]) => {
        params.append(key, value);
      });
    }

    const url = `https://serpapi.com/search?${params.toString()}`;
    const timeout = parseInt(process.env.REQUEST_TIMEOUT || '30000');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const hasLocation = params.get('location') !== null;
      logger.info(`🔍 Making SerpAPI request:
        Keyword: "${params.get('q')}"
        Search Type: ${hasLocation ? '📍 Location-based' : '🌍 Keyword-only (global)'}
        ${hasLocation ? `Location: "${params.get('location')}"` : ''}
        Country (gl): ${params.get('gl')}
        Results requested: ${params.get('num')}
        Device: ${params.get('device')}`);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'SERP-Tracker/2.0 (Professional SERP Tracking Tool)'
        },
        signal: controller.signal
      });

      const responseTime = Date.now();
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new SerpApiError(
          `HTTP ${response.status}: ${errorText || response.statusText}`,
          response.status === 429 ? 'rate_limited' : response.status === 401 ? 'invalid_request' : 'network_error',
          response.status,
          { url, errorText }
        );
      }

      // Extract API usage information from response headers (common in ValueSERP and SerpAPI)
      const apiUsage = this.extractApiUsageFromHeaders(response.headers);
      if (apiUsage) {
        logger.info(`📊 API Usage Info: ${apiUsage.used}/${apiUsage.limit} used (${apiUsage.remaining} remaining, ${apiUsage.percentageUsed}%)`);
      }

      const data: ISerpApiResponse = await response.json();

      if ((data as any).error) {
        throw new SerpApiError(
          `SerpApi Error: ${(data as any).error}`,
          'parse_error',
          undefined,
          { serpApiError: (data as any).error }
        );
      }

      // Validate position field coverage
      if (data.organic_results && data.organic_results.length > 0) {
        const resultsWithPosition = data.organic_results.filter(r => r.position && r.position > 0);
        const positionPercentage = (resultsWithPosition.length / data.organic_results.length) * 100;
        
        logger.debug(`📊 Position field coverage: ${resultsWithPosition.length}/${data.organic_results.length} (${positionPercentage.toFixed(1)}%)`);
        
        if (resultsWithPosition.length === 0) {
          logger.error('❌ CRITICAL: SerpAPI is NOT returning position fields! Check your API plan.');
          logger.error(`Sample result structure: ${JSON.stringify(data.organic_results[0], null, 2)}`);
        }
      }

      if (!data.search_information) {
        throw new SerpApiError(
          'Invalid response from SerpApi: missing search information',
          'parse_error',
          undefined,
          { data }
        );
      }

      return this.parseSearchResults(keyword, data, options, {
        requestTimestamp: new Date(requestStartTime),
        responseTimestamp: new Date(responseTime),
        processingTime: responseTime - requestStartTime,
        apiKeyUsed: keyConfig.id,
        apiUsage: apiUsage || undefined // Include API usage information
      });

    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as any).name === 'AbortError') {
        throw new SerpApiError(`Request timeout after ${timeout}ms`, 'timeout', undefined, { timeout });
      }
      throw error;
    }
  }

  private async makeGoogleCustomSearchRequest(
    keyword: string,
    options: ISearchOptions
  ): Promise<ISearchResult> {
    const keyConfig = await this.getNextAvailableKey('google_custom_search');
    if (!keyConfig || keyConfig.provider !== 'google_custom_search') {
      throw new SerpApiError('No Google Custom Search API key available', 'invalid_request');
    }

    if (!keyConfig.cseId) {
      throw new SerpApiError('Google Custom Search Engine ID (CSE ID) is required', 'invalid_request');
    }

    const timeout = parseInt(process.env.REQUEST_TIMEOUT || '30000');
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const requestStartTime = Date.now();

      // Build Google Custom Search API URL
      const params = new URLSearchParams({
        key: keyConfig.key,
        cx: keyConfig.cseId,
        q: keyword,
        num: Math.min(options.maxResults || 10, 10).toString(), // Google Custom Search max is 10 per request
        gl: options.country.toLowerCase(), // Country code
        hl: options.language?.toLowerCase() || 'en', // Language
        safe: 'off'
      });

      // Add location parameters if available
      if (options.city) {
        params.set('q', `${keyword} ${options.city}${options.state ? ', ' + options.state : ''}`);
      }

      const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;
      
      logger.info(`🔍 Requesting Google Custom Search for "${keyword}" (country: ${options.country})`);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'Accept': 'application/json'
        }
      });

      clearTimeout(timeoutId);
      const responseTime = Date.now();

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new SerpApiError(
          `HTTP ${response.status}: ${errorText || response.statusText}`,
          response.status === 429 ? 'rate_limited' : response.status === 403 ? 'invalid_request' : 'network_error',
          response.status,
          { url, errorText }
        );
      }

      const data: IGoogleCustomSearchResponse = await response.json();

      if (data.error) {
        throw new SerpApiError(
          `Google Custom Search Error: ${data.error.message}`,
          'parse_error',
          data.error.code,
          { googleError: data.error }
        );
      }

      if (!data.searchInformation) {
        throw new SerpApiError(
          'Invalid response from Google Custom Search: missing search information',
          'parse_error',
          undefined,
          { data }
        );
      }

      return this.parseGoogleCustomSearchResults(keyword, data, options, {
        requestTimestamp: new Date(requestStartTime),
        responseTimestamp: new Date(responseTime),
        processingTime: responseTime - requestStartTime,
        apiKeyUsed: keyConfig.id
      });

    } catch (error) {
      clearTimeout(timeoutId);
      if ((error as any).name === 'AbortError') {
        throw new SerpApiError(`Request timeout after ${timeout}ms`, 'timeout', undefined, { timeout });
      }
      throw error;
    }
  }

  private parseSearchResults(
    keyword: string, 
    data: ISerpApiResponse, 
    options: ISearchOptions,
    requestMetadata: Partial<ISearchMetadata>
  ): ISearchResult {
    const organicResults = data.organic_results || [];
    
    // Extract and clean the target domain from user input
    const cleanDomain = this.extractDomain(options.domain);
    
    logger.info(`🎯🎯🎯 PARSING SEARCH RESULTS 🎯🎯🎯`);
    logger.info(`  Target domain (raw): "${options.domain}"`);
    logger.info(`  Target domain (cleaned): "${cleanDomain}"`);
    logger.info(`  Keyword: "${keyword}"`);
    logger.info(`  Total organic results: ${organicResults.length}`);
    
    if (!cleanDomain) {
      logger.error(`❌ CRITICAL: No domain provided or domain extraction failed!`);
      logger.error(`  options.domain = "${options.domain}"`);
    }
    
    const searchInfo = data.search_information || {};

    let position: number | null = null;
    let url = '';
    let title = '';
    let description = '';
    let foundMatch = false;
    let positionSource: PositionSource = 'unknown';
    let arrayIndexPosition: number | undefined;
    const warnings: string[] = [];

    logger.debug(`🔍 Parsing ${organicResults.length} organic results for domain: ${cleanDomain}`);
    logger.info(`🎯 TARGET DOMAIN (cleaned): "${cleanDomain}" (from original: "${options.domain}")`);
    logger.info(`📋 SERP returned ${organicResults.length} organic results`);
    
    // Enhanced debug logging - Check position field coverage
    const resultsWithPosition = organicResults.filter(r => r.position && r.position > 0);
    logger.debug(`� Results with position field: ${resultsWithPosition.length}/${organicResults.length}`);

    if (organicResults.length > 0 && organicResults.length <= 10) {
      logger.debug(`📋 All results with positions:`);
      organicResults.forEach((r: ISerpApiOrganicResult, idx: number) => {
        logger.debug(`  [Array:${idx + 1}] [Pos:${r.position || 'MISSING'}] ${this.extractDomain(r.link || '')} - ${r.title?.substring(0, 50)}`);
      });
    } else if (organicResults.length > 0) {
      logger.debug(`📋 First 5 results with positions:`);
      organicResults.slice(0, 5).forEach((r: ISerpApiOrganicResult, idx: number) => {
        logger.debug(`  [Array:${idx + 1}] [Pos:${r.position || 'MISSING'}] ${this.extractDomain(r.link || '')} - ${r.title?.substring(0, 50)}`);
      });
    }
    
    // Detect SERP features
    const serpFeatures = this.detectSerpFeatures(data);
    logger.debug(`📋 SERP Features detected: ${serpFeatures.map(f => `${f.type}(${f.count || 1})`).join(', ')}`);

    // Log target domain for debugging
    logger.info(`🎯 Target domain: "${cleanDomain}" (from options.domain: "${options.domain}")`);
    
    // Log ALL organic results with their domains for debugging
    logger.info(`📋 All ${organicResults.length} organic results:`);
    organicResults.forEach((r: ISerpApiOrganicResult, idx: number) => {
      const resultDomain = this.extractDomain(r.link || '');
      logger.info(`  [${idx + 1}] Pos:${r.position || 'N/A'} | Domain: "${resultDomain}" | URL: ${r.link}`);
    });

    // Search through organic results for domain match - Find best match with position field
    let bestMatch: {
      result: ISerpApiOrganicResult;
      index: number;
      domainMatch: IDomainMatchResult;
    } | null = null;

    logger.info(`🔍 STARTING DOMAIN SEARCH - Target: "${cleanDomain}"`);

    for (let i = 0; i < organicResults.length; i++) {
      const result = organicResults[i];
      if (!result.link) {
        logger.debug(`⚠️ Skipping result ${i + 1}: no link field`);
        continue;
      }

      // Extract domain from result URL
      const resultDomain = this.extractDomain(result.link);
      
      // Compare domains - THIS IS THE CRITICAL PART
      const domainMatch = this.domainsMatch(resultDomain, cleanDomain);
      
      // Log EVERY comparison for debugging
      logger.info(`🔍 [${i + 1}] Comparing:
        Result URL: ${result.link}
        Extracted domain: "${resultDomain}"
        Target domain: "${cleanDomain}"
        Match result: ${domainMatch.matched ? '✅ MATCHED' : '❌ NO MATCH'}
        Match type: ${domainMatch.matchType}
        Confidence: ${domainMatch.confidence}%
        Position field: ${result.position || 'MISSING'}`);
      
      if (domainMatch.matched) {
        logger.info(`✅ ✅ ✅ MATCH FOUND at array index ${i + 1}!
          Domain: "${resultDomain}"
          URL: ${result.link}
          Match type: ${domainMatch.matchType}
          Confidence: ${domainMatch.confidence}%
          SerpAPI position: ${result.position || 'MISSING'}
          Title: ${result.title}`);
        
        // Select best match based on:
        // 1. Highest confidence
        // 2. Has valid position field
        // 3. First match if equal
        if (!bestMatch || 
            domainMatch.confidence > bestMatch.domainMatch.confidence ||
            (domainMatch.confidence === bestMatch.domainMatch.confidence && result.position && !bestMatch.result.position)) {
          
          bestMatch = { result, index: i, domainMatch };
          
          logger.info(`✅ SELECTED AS BEST MATCH:
            Previous best confidence: ${bestMatch ? bestMatch.domainMatch.confidence : 'none'}%
            New confidence: ${domainMatch.confidence}%
            Has position field: ${!!result.position}`);
        }
        
        // If we found an exact match with valid position, we can stop
        if (domainMatch.matchType === 'exact' && result.position && result.position > 0) {
          logger.info(`✅ Found EXACT match with valid position ${result.position}, stopping search`);
          break;
        }
      }
    }

    logger.info(`🔍 DOMAIN SEARCH COMPLETE - Best match: ${bestMatch ? `✅ FOUND (confidence: ${bestMatch.domainMatch.confidence}%)` : '❌ NOT FOUND'}`);

    if (bestMatch) {
      const { result, index, domainMatch } = bestMatch;
      foundMatch = true;
      arrayIndexPosition = index + 1;
      
      if (result.position && result.position > 0) {
        position = result.position;
        positionSource = 'serpapi_position';
        
        // Position verification logging
        logger.info(`✅ Position verification:`);
        logger.info(`   - SerpAPI position field: ${position}`);
        logger.info(`   - Array index position: ${arrayIndexPosition}`);
        logger.info(`   - Difference: ${Math.abs(position - arrayIndexPosition)}`);
        logger.info(`   - SERP features count: ${serpFeatures.length}`);
        
        const positionDifference = Math.abs(position - arrayIndexPosition);
        if (positionDifference > 3) {
          warnings.push(`Large discrepancy: SerpAPI position ${position} vs array index ${arrayIndexPosition}. This indicates SERP features affecting position.`);
          logger.warn(`⚠️ Position discrepancy detected: SerpAPI=${position}, ArrayIndex=${arrayIndexPosition}, Difference=${positionDifference}`);
        }
      } else {
        // Position field is missing - use SERP feature offset calculation
        const serpFeatureOffset = this.calculateSerpFeatureOffset(data, index);
        const adjustedPosition = arrayIndexPosition + serpFeatureOffset;
        
        position = adjustedPosition;
        positionSource = 'array_index_fallback';
        
        warnings.push(`SerpAPI position field missing. Using array index ${arrayIndexPosition} + SERP feature offset ${serpFeatureOffset} = estimated position ${position}.`);
        logger.warn(`⚠️ WARNING: SerpAPI position field missing! Using calculated position:`);
        logger.warn(`   - Array index: ${arrayIndexPosition}`);
        logger.warn(`   - SERP feature offset: ${serpFeatureOffset}`);
        logger.warn(`   - Estimated position: ${position}`);
        logger.error(`❌ CRITICAL: SerpAPI position field missing for ${this.extractDomain(result.link)}! Result data: ${JSON.stringify(result, null, 2)}`);
      }
      
      url = result.link;
      title = result.title || '';
      description = result.snippet || result.rich_snippet?.top?.detected_extensions?.description || '';
      
      logger.info(`✅ MATCH FOUND! Domain: ${this.extractDomain(result.link)} (Match type: ${domainMatch.matchType}, Confidence: ${domainMatch.confidence}%) | Position: ${position} | Source: ${positionSource} | URL: ${url}`);
    }


    if (!foundMatch) {
      logger.warn(`❌ Domain ${cleanDomain} NOT found in ${organicResults.length} results`);
      logger.warn(`📋 ALL result domains for debugging:`);
      organicResults.forEach((r: ISerpApiOrganicResult, idx: number) => {
        const resultDomain = this.extractDomain(r.link || '');
        logger.warn(`   [${idx + 1}] Pos:${r.position || 'N/A'} | "${resultDomain}" | ${r.link}`);
      });
      
      // Also check if we should have requested more results
      if (organicResults.length >= 90) {
        logger.error(`⚠️ CRITICAL: Received ${organicResults.length} results (near max). Domain may be ranked beyond visible results. Consider increasing maxResults.`);
      }
    }

    // Calculate position confidence
    const confidence = this.calculatePositionConfidence(
      positionSource,
      foundMatch,
      serpFeatures,
      organicResults.length,
      warnings
    );

    // Build position validation object
    const positionValidation: IPositionValidation = {
      originalPosition: position,
      positionSource,
      confidence,
      serpFeatures,
      organicResultsCount: organicResults.length,
      totalResultsInSerp: this.calculateTotalSerpResults(data),
      validationMethod: positionSource === 'serpapi_position' ? 'serpapi_trusted' : 
                        positionSource === 'array_index_fallback' ? 'fallback_used' : 'unverified',
      warnings,
      arrayIndexPosition
    };

    // Enhanced verification mode
    if (options.verificationMode && foundMatch && position) {
      const verificationResult = this.verifyPosition(position, arrayIndexPosition, serpFeatures, organicResults.length);
      positionValidation.verifiedPosition = verificationResult.verifiedPosition;
      positionValidation.discrepancy = verificationResult.discrepancy;
      if (verificationResult.warning) {
        positionValidation.warnings.push(verificationResult.warning);
      }
    }

    // Build search metadata
    const searchMetadata: ISearchMetadata = {
      searchTime: data.search_metadata?.total_time_taken?.toString(),
      searchId: data.search_metadata?.id,
      location: data.search_parameters?.location || options.city || options.state || options.country,
      device: options.device || 'desktop',
      searchEngine: options.searchEngine || 'google',
      cacheUsed: false,
      rawParams: Object.fromEntries(new URLSearchParams({
        q: keyword,
        gl: options.country,
        hl: options.language || 'en',
        num: String(options.maxResults || 100)
      })),
      ...requestMetadata
    };

    // Collect competitor URLs (top 10)
    const competitorUrls = organicResults
      .slice(0, 10)
      .filter(r => r.link && r.position)
      .map(r => ({
        position: r.position,
        url: r.link,
        domain: this.extractDomain(r.link),
        title: r.title || ''
      }));

    // Determine result quality
    const resultQuality = {
      positionReliability: confidence >= 90 ? 'high' as const : confidence >= 70 ? 'medium' as const : 'low' as const,
      dataFreshness: 'realtime' as const,
      serpComplexity: serpFeatures.length > 3 ? 'complex' as const : serpFeatures.length > 1 ? 'moderate' as const : 'simple' as const
    };

    return {
      keyword: keyword.trim(),
      domain: options.domain,
      position,
      url,
      title,
      description,
      country: options.country.toUpperCase(),
      city: options.city?.trim() || '',
      state: options.state?.trim() || '',
      postalCode: options.postalCode?.trim() || '',
      totalResults: this.parseTotalResults(searchInfo.total_results),
      searchedResults: organicResults.length,
      timestamp: new Date(),
      found: foundMatch,
      positionValidation,
      searchMetadata,
      rawSerpData: {
        organic_results: organicResults,
        ads: data.ads,
        search_information: data.search_information,
        search_parameters: data.search_parameters,
        serpapi_pagination: data.serpapi_pagination
      },
      competitorUrls,
      resultQuality
    };
  }

  private parseGoogleCustomSearchResults(
    keyword: string,
    data: IGoogleCustomSearchResponse,
    options: ISearchOptions,
    requestMetadata: Partial<ISearchMetadata>
  ): ISearchResult {
    const items = data.items || [];
    const searchInfo = data.searchInformation;

    logger.info(`📊 Google Custom Search returned ${items.length} results for "${keyword}"`);

    // Clean and normalize target domain
    const cleanDomain = this.extractDomain(options.domain);
    
    // Log target domain for debugging
    logger.info(`🎯 Target domain: "${cleanDomain}" (from options.domain: "${options.domain}")`);
    
    // Log ALL results with their domains for debugging
    logger.info(`📋 All ${items.length} Google Custom Search results:`);
    items.forEach((item: IGoogleCustomSearchItem, idx: number) => {
      const resultDomain = this.extractDomain(item.link || '');
      logger.info(`  [${idx + 1}] Domain: "${resultDomain}" | URL: ${item.link}`);
    });

    // Search through items for domain match
    let bestMatch: {
      item: IGoogleCustomSearchItem;
      index: number;
      domainMatch: IDomainMatchResult;
    } | null = null;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.link) {
        const resultDomain = this.extractDomain(item.link);
        const domainMatch = this.domainsMatch(resultDomain, cleanDomain);
        
        // Only log when we find a match to reduce noise
        if (domainMatch.matched) {
          logger.info(`🔍 Found match at index ${i + 1}: "${resultDomain}" vs "${cleanDomain}" (type: ${domainMatch.matchType}, confidence: ${domainMatch.confidence}%)`);
          bestMatch = { item, index: i, domainMatch };
          break; // Take first match
        }
      }
    }

    let position: number | null = null;
    let url = '';
    let title = '';
    let description = '';
    let foundMatch = false;
    let positionSource: PositionSource = 'unknown';
    let confidence = 0;
    const warnings: string[] = [];

    if (bestMatch) {
      foundMatch = true;
      position = bestMatch.index + 1; // Google Custom Search uses 0-based index
      positionSource = 'array_index_fallback';
      url = bestMatch.item.link || '';
      title = bestMatch.item.title || '';
      description = bestMatch.item.snippet || '';
      confidence = bestMatch.domainMatch.confidence;

      logger.info(`✅ Match found at position ${position} (array index ${bestMatch.index})`);
      logger.info(`   Match type: ${bestMatch.domainMatch.matchType}, Confidence: ${confidence}%`);
      logger.info(`   URL: ${url}`);
      logger.info(`   Title: ${title.substring(0, 60)}...`);
    } else {
      logger.warn(`❌ Domain "${cleanDomain}" NOT FOUND in Google Custom Search results`);
      logger.warn(`   Searched through ${items.length} results`);
      logger.warn(`   Consider checking: domain spelling, location targeting, or expanding search results`);
    }

    // Calculate position with any SERP feature adjustments (Google Custom Search typically has fewer features)
    const serpFeatures: ISerpFeature[] = []; // Google Custom Search doesn't provide SERP features in the same way
    const arrayIndexPosition: number | undefined = bestMatch ? bestMatch.index + 1 : undefined;

    // Build position validation object
    const positionValidation: IPositionValidation = {
      originalPosition: position,
      positionSource,
      confidence,
      serpFeatures,
      organicResultsCount: items.length,
      totalResultsInSerp: items.length,
      validationMethod: 'fallback_used',
      warnings,
      arrayIndexPosition
    };

    // Build search metadata
    const searchMetadata: ISearchMetadata = {
      searchTime: searchInfo.searchTime?.toString(),
      searchId: undefined,
      location: options.city || options.state || options.country,
      device: options.device || 'desktop',
      searchEngine: options.searchEngine || 'google',
      cacheUsed: false,
      rawParams: Object.fromEntries(new URLSearchParams({
        q: keyword,
        gl: options.country,
        hl: options.language || 'en',
        num: String(options.maxResults || 10)
      })),
      ...requestMetadata
    };

    // Collect competitor URLs (top 10)
    const competitorUrls = items
      .slice(0, 10)
      .map((item, idx) => ({
        position: idx + 1,
        url: item.link || '',
        domain: this.extractDomain(item.link || ''),
        title: item.title || ''
      }));

    // Determine result quality
    const resultQuality = {
      positionReliability: confidence >= 90 ? 'high' as const : confidence >= 70 ? 'medium' as const : 'low' as const,
      dataFreshness: 'realtime' as const,
      serpComplexity: 'simple' as const // Google Custom Search has simpler SERP
    };

    return {
      keyword: keyword.trim(),
      domain: options.domain,
      position,
      url,
      title,
      description,
      country: options.country.toUpperCase(),
      city: options.city?.trim() || '',
      state: options.state?.trim() || '',
      postalCode: options.postalCode?.trim() || '',
      totalResults: parseInt(searchInfo.totalResults || '0'),
      searchedResults: items.length,
      timestamp: new Date(),
      found: foundMatch,
      positionValidation,
      searchMetadata,
      rawSerpData: {
        googleCustomSearch: {
          items: items,
          searchInformation: data.searchInformation,
          queries: data.queries
        }
      },
      competitorUrls,
      resultQuality
    };
  }

  private detectSerpFeatures(data: ISerpApiResponse): ISerpFeature[] {
    const features: ISerpFeature[] = [];

    if (data.ads && data.ads.length > 0) {
      features.push({
        type: 'ads',
        count: data.ads.length,
        position: 1 // Ads typically appear at top
      });
    }

    if (data.answer_box) {
      features.push({ type: 'featured_snippet', position: 1 });
    }

    if (data.knowledge_graph) {
      features.push({ type: 'knowledge_panel' });
    }

    if (data.local_results) {
      features.push({
        type: 'local_pack',
        count: Array.isArray(data.local_results) ? data.local_results.length : 1
      });
    }

    if (data.inline_images && data.inline_images.length > 0) {
      features.push({ type: 'images', count: data.inline_images.length });
    }

    if (data.inline_videos && data.inline_videos.length > 0) {
      features.push({ type: 'videos', count: data.inline_videos.length });
    }

    if (data.related_searches && data.related_searches.length > 0) {
      features.push({ type: 'related_searches', count: data.related_searches.length });
    }

    if (data.top_stories) {
      features.push({ type: 'other', count: 1 });
    }

    // Check for PAA (People Also Ask) in organic results
    const organicResults = data.organic_results || [];
    const paaCount = organicResults.filter(r => 
      r.title?.toLowerCase().includes('people also ask') || 
      (r as any).type === 'people_also_ask'
    ).length;
    
    if (paaCount > 0) {
      features.push({ type: 'people_also_ask', count: paaCount });
    }

    return features;
  }

  /**
   * Calculate position offset caused by SERP features (ads, snippets, etc.)
   * This adjusts array index to approximate actual SERP position
   */
  private calculateSerpFeatureOffset(data: ISerpApiResponse, arrayIndex: number): number {
    let offset = 0;
    
    // Count ads at the top (typically 3-4 ads above organic results)
    if (data.ads && data.ads.length > 0) {
      offset += data.ads.length;
      logger.debug(`  + ${data.ads.length} ad positions`);
    }
    
    // Featured snippet takes position 0/1
    if (data.answer_box) {
      offset += 1;
      logger.debug(`  + 1 featured snippet position`);
    }
    
    // Local pack typically shows 3 results
    if (data.local_results) {
      const localCount = Array.isArray(data.local_results) ? data.local_results.length : 3;
      offset += localCount;
      logger.debug(`  + ${localCount} local pack positions`);
    }
    
    // People Also Ask boxes (can appear anywhere, but often near top)
    const organicResults = data.organic_results || [];
    let paaCount = 0;
    for (let i = 0; i < arrayIndex && i < organicResults.length; i++) {
      const result = organicResults[i];
      if (result.title?.toLowerCase().includes('people also ask') || (result as any).type === 'people_also_ask') {
        paaCount++;
      }
    }
    if (paaCount > 0) {
      offset += paaCount;
      logger.debug(`  + ${paaCount} PAA boxes before position ${arrayIndex + 1}`);
    }
    
    // Knowledge panel (usually on right side, but can affect mobile positions)
    if (data.knowledge_graph) {
      // Knowledge panels don't typically offset position, but log it
      logger.debug(`  (Knowledge panel present but doesn't offset position)`);
    }
    
    logger.info(`📊 SERP Feature Offset Calculation: Array index ${arrayIndex + 1} + ${offset} features = Estimated position ${arrayIndex + 1 + offset}`);
    
    return offset;
  }

  private calculateTotalSerpResults(data: ISerpApiResponse): number {
    let total = (data.organic_results || []).length;
    
    if (data.ads) total += data.ads.length;
    if (data.inline_images) total += data.inline_images.length;
    if (data.inline_videos) total += data.inline_videos.length;
    if (data.answer_box) total += 1;
    if (data.knowledge_graph) total += 1;
    if (data.local_results) {
      total += Array.isArray(data.local_results) ? data.local_results.length : 1;
    }
    
    return total;
  }

  private calculatePositionConfidence(
    positionSource: PositionSource,
    found: boolean,
    serpFeatures: ISerpFeature[],
    organicCount: number,
    warnings: string[]
  ): number {
    if (!found) return 0;

    let confidence = 100;

    // Reduce confidence based on position source
    if (positionSource === 'array_index_fallback') {
      confidence -= 30; // Major penalty for using array index
    } else if (positionSource === 'unknown') {
      confidence -= 50;
    }

    // Reduce confidence based on SERP complexity
    const complexityPenalty = Math.min(serpFeatures.length * 5, 20);
    confidence -= complexityPenalty;

    // Reduce confidence if few organic results
    if (organicCount < 10) {
      confidence -= 10;
    }

    // Reduce confidence for warnings
    confidence -= Math.min(warnings.length * 5, 15);

    return Math.max(0, Math.round(confidence));
  }

  private verifyPosition(
    position: number | null,
    arrayIndexPosition: number | undefined,
    serpFeatures: ISerpFeature[],
    organicCount: number
  ): {
    verifiedPosition: number | null;
    discrepancy?: number;
    warning?: string;
  } {
    if (!position || !arrayIndexPosition) {
      return { verifiedPosition: position };
    }

    const discrepancy = Math.abs(position - arrayIndexPosition);

    // Expected discrepancy based on SERP features
    const expectedDiscrepancy = serpFeatures.reduce((sum, feature) => {
      if (feature.type === 'ads') return sum + (feature.count || 1);
      if (feature.type === 'featured_snippet') return sum + 1;
      if (feature.type === 'local_pack') return sum + 1;
      return sum;
    }, 0);

    if (discrepancy <= expectedDiscrepancy + 2) {
      // Position is verified as reasonable
      return { verifiedPosition: position, discrepancy };
    } else {
      // Significant discrepancy detected
      return {
        verifiedPosition: position,
        discrepancy,
        warning: `Significant position discrepancy: ${discrepancy} positions difference (expected ~${expectedDiscrepancy} based on SERP features)`
      };
    }
  }

  private parseTotalResults(totalResults: any): number {
    if (typeof totalResults === 'number') {
      return totalResults;
    }
    
    if (typeof totalResults === 'string') {
      return parseInt(totalResults.replace(/[^\d]/g, '') || '0') || 0;
    }
    
    return 0;
  }

  private extractDomain(url: string): string {
    try {
      if (!url || typeof url !== 'string') {
        logger.debug(`⚠️ extractDomain: empty or invalid URL`);
        return '';
      }
      
      const originalUrl = url;
      
      // Remove protocol (http://, https://, etc.)
      let domain = url.replace(/^[a-z]+:\/\//i, '');
      
      // Remove www, www1, www2, m, mobile, etc. prefixes
      domain = domain.replace(/^(www\d*|m|mobile)\./i, '');
      
      // Remove port number
      domain = domain.split(':')[0];
      
      // Get just the domain part (before path, query, hash)
      domain = domain.split('/')[0].split('?')[0].split('#')[0];
      
      // Clean and lowercase
      domain = domain.toLowerCase().trim();
      
      // Remove trailing dots
      domain = domain.replace(/\.+$/, '');
      
      logger.debug(`extractDomain: "${originalUrl}" → "${domain}"`);
      
      return domain;
    } catch (error) {
      logger.warn(`⚠️ Error extracting domain from "${url}":`, error);
      // Fallback extraction
      try {
        const fallback = String(url)
          .replace(/^[a-z]+:\/\//i, '')
          .replace(/^(www\d*|m|mobile)\./i, '')
          .split('/')[0]
          .split('?')[0]
          .split('#')[0]
          .toLowerCase()
          .trim();
        logger.debug(`extractDomain fallback: "${url}" → "${fallback}"`);
        return fallback;
      } catch (e) {
        logger.error(`❌ Critical error extracting domain from "${url}"`, e);
        return '';
      }
    }
  }

  private domainsMatch(domain1: string, domain2: string): IDomainMatchResult {
    if (!domain1 || !domain2) {
      logger.debug(`❌ domainsMatch: one or both domains empty - d1="${domain1}", d2="${domain2}"`);
      return {
        matched: false,
        matchType: 'none',
        domain1: domain1 || '',
        domain2: domain2 || '',
        confidence: 0
      };
    }
    
    const d1 = domain1.toLowerCase().trim();
    const d2 = domain2.toLowerCase().trim();
    
    logger.debug(`🔍 domainsMatch: comparing "${d1}" vs "${d2}"`);
    
    // 1. Exact match (100% confidence)
    if (d1 === d2) {
      logger.debug(`✅ domainsMatch: EXACT MATCH - "${d1}" === "${d2}"`);
      return {
        matched: true,
        matchType: 'exact',
        domain1: d1,
        domain2: d2,
        confidence: 100
      };
    }
    
    // 2. Normalize by removing common prefixes
    const normalize = (d: string) => {
      return d
        .replace(/^(www\d*|m|mobile)\./i, '')
        .replace(/\/$/, '')
        .toLowerCase()
        .trim();
    };
    
    const n1 = normalize(d1);
    const n2 = normalize(d2);
    
    logger.debug(`🔍 domainsMatch: normalized - "${n1}" vs "${n2}"`);
    
    if (n1 === n2) {
      logger.debug(`✅ domainsMatch: NORMALIZED MATCH - "${n1}" === "${n2}" (from "${d1}" and "${d2}")`);
      return {
        matched: true,
        matchType: 'normalized',
        domain1: d1,
        domain2: d2,
        normalizedDomain1: n1,
        normalizedDomain2: n2,
        confidence: 95
      };
    }
    
    // 3. Singularize for plural/singular matching
    const singularize = (d: string) => {
      return d
        .replace(/ies$/, 'y')    // companies -> company
        .replace(/es$/, '')       // boxes -> box
        .replace(/s$/, '');       // cats -> cat
    };
    
    const s1 = singularize(n1);
    const s2 = singularize(n2);
    
    if (s1 === s2 && (s1 !== n1 || s1 !== n2)) {
      logger.debug(`✅ domainsMatch: SINGULAR_PLURAL MATCH - "${s1}" (from "${n1}" and "${n2}")`);
      return {
        matched: true,
        matchType: 'normalized',
        domain1: d1,
        domain2: d2,
        normalizedDomain1: n1,
        normalizedDomain2: n2,
        confidence: 93
      };
    }
    
    // 4. Check for subdomain match (e.g., blog.example.com should match example.com)
    const parts1 = n1.split('.');
    const parts2 = n2.split('.');
    
    const getMainDomain = (parts: string[]) => {
      if (parts.length >= 2) {
        return parts.slice(-2).join('.');
      }
      return parts.join('.');
    };
    
    const main1 = getMainDomain(parts1);
    const main2 = getMainDomain(parts2);
    
    logger.debug(`🔍 domainsMatch: main domains - "${main1}" vs "${main2}"`);
    
    if (main1 === main2 && main1.length > 0) {
      // Check if one is a subdomain of the other
      const isSubdomain = n1.endsWith(`.${n2}`) || n2.endsWith(`.${n1}`) || n1.includes(`.${n2}`) || n2.includes(`.${n1}`);
      
      logger.debug(`✅ domainsMatch: ${isSubdomain ? 'SUBDOMAIN' : 'MAIN_DOMAIN'} MATCH - main="${main1}" (from "${n1}" and "${n2}")`);
      
      return {
        matched: true,
        matchType: isSubdomain ? 'subdomain' : 'main_domain',
        domain1: d1,
        domain2: d2,
        normalizedDomain1: n1,
        normalizedDomain2: n2,
        confidence: isSubdomain ? 85 : 90
      };
    }
    
    // 5. Check if one domain contains the other (partial match)
    if (n1.includes(n2) || n2.includes(n1)) {
      logger.debug(`⚠️ domainsMatch: PARTIAL MATCH - "${n1}" contains "${n2}" or vice versa`);
      return {
        matched: true,
        matchType: 'subdomain',
        domain1: d1,
        domain2: d2,
        normalizedDomain1: n1,
        normalizedDomain2: n2,
        confidence: 75
      };
    }
    
    // No match
    logger.debug(`❌ domainsMatch: NO MATCH - "${d1}" vs "${d2}"`);
    
    return {
      matched: false,
      matchType: 'none',
      domain1: d1,
      domain2: d2,
      normalizedDomain1: n1,
      normalizedDomain2: n2,
      confidence: 0
    };
  }

  private async updateKeyUsage(keyId: string, success: boolean): Promise<void> {
    const keyConfig = this.apiKeys.find(k => k.id === keyId);
    if (!keyConfig) {
      logger.warn(`Key ${keyId} not found for usage update`);
      return;
    }

    const previousUsage = keyConfig.usedToday;

    if (success) {
      keyConfig.usedToday++;
      keyConfig.usedThisMonth++;
      keyConfig.successRate = Math.min(100, (keyConfig.successRate * 0.95) + (100 * 0.05));
    } else {
      keyConfig.errorCount++;
      keyConfig.successRate = Math.max(0, (keyConfig.successRate * 0.95) + (0 * 0.05));
    }

    keyConfig.lastUsed = new Date();
    keyConfig.updatedAt = new Date();

    if (keyConfig.usedToday >= keyConfig.dailyLimit) {
      keyConfig.status = 'exhausted';
      logger.warn(`Key ${keyId} has reached daily limit: ${keyConfig.usedToday}/${keyConfig.dailyLimit}`);
    }

    setImmediate(async () => {
      try {
        await ApiKeyModel.findOneAndUpdate(
          { keyId },
          {
            usedToday: keyConfig.usedToday,
            usedThisMonth: keyConfig.usedThisMonth,
            status: keyConfig.status,
            errorCount: keyConfig.errorCount,
            successRate: Math.round(keyConfig.successRate * 100) / 100,
            lastUsed: keyConfig.lastUsed,
            updatedAt: keyConfig.updatedAt
          },
          { upsert: true }
        );
        
        if (success && keyConfig.usedToday !== previousUsage) {
          logger.debug(`Updated key ${keyId} usage: ${keyConfig.usedToday}/${keyConfig.dailyLimit}`);
        }
      } catch (error) {
        logger.error('Failed to update key usage in database:', error);
      }
    });
  }

  private async markKeyExhausted(keyId: string): Promise<void> {
    const keyConfig = this.apiKeys.find(k => k.id === keyId);
    if (keyConfig && keyConfig.status !== 'exhausted') {
      keyConfig.status = 'exhausted';
      await this.updateKeyUsage(keyId, false);
      logger.warn(`🚫 Key ${keyId} marked as exhausted`);
    }
  }

  private async pauseKey(keyId: string, duration: number): Promise<void> {
    const keyConfig = this.apiKeys.find(k => k.id === keyId);
    if (keyConfig) {
      const previousStatus = keyConfig.status;
      keyConfig.status = 'paused';
      logger.info(`⏸️ Key ${keyId} paused for ${duration}ms`);
      
      setTimeout(() => {
        if (keyConfig.status === 'paused') {
          keyConfig.status = previousStatus === 'exhausted' ? 'exhausted' : 'active';
          logger.info(`▶️ Key ${keyId} resumed (status: ${keyConfig.status})`);
        }
      }, duration);
    }
  }

  private async saveSearchResult(result: ISearchResult): Promise<void> {
    try {
      await SearchResultModel.create(result);
      logger.debug(`Saved search result: ${result.keyword} -> ${result.position || 'Not Found'} (Confidence: ${result.positionValidation.confidence}%)`);
    } catch (error) {
      logger.error('Failed to save search result to database:', error);
    }
  }

  private isQuotaExceeded(error: any): boolean {
    const message = error?.message?.toLowerCase() || '';
    return message.includes('quota') || 
           message.includes('limit') || 
           message.includes('exceeded') ||
           message.includes('usage limit') ||
           message.includes('monthly searches used up') ||
           message.includes('daily searches used up');
  }

  private isRateLimited(error: any): boolean {
    const message = error?.message?.toLowerCase() || '';
    return message.includes('rate') || 
           message.includes('too many') || 
           message.includes('429') ||
           message.includes('rate limit') ||
           message.includes('requests per second');
  }

  public getKeyStats(): IPoolStats {
    const totalUsageToday = this.apiKeys.reduce((sum, k) => sum + k.usedToday, 0);
    const totalCapacity = this.apiKeys.reduce((sum, k) => sum + k.dailyLimit, 0);
    const remainingCapacity = totalCapacity - totalUsageToday;
    const usagePercentage = totalCapacity > 0 ? Math.round((totalUsageToday / totalCapacity) * 100) : 0;
    
    const criticalKeys = this.apiKeys.filter(k => 
      (k.usedToday / k.dailyLimit) >= 0.9 && k.status === 'active'
    ).length;
    
    const warningKeys = this.apiKeys.filter(k => 
      (k.usedToday / k.dailyLimit) >= 0.75 && (k.usedToday / k.dailyLimit) < 0.9 && k.status === 'active'
    ).length;

    let estimatedTimeToExhaustion: string | undefined;
    if (remainingCapacity > 0 && totalUsageToday > 0) {
      const hoursElapsed = new Date().getHours() + (new Date().getMinutes() / 60);
      if (hoursElapsed > 0) {
        const currentRate = totalUsageToday / hoursElapsed;
        const hoursToExhaustion = remainingCapacity / currentRate;
        
        if (hoursToExhaustion < 24) {
          estimatedTimeToExhaustion = hoursToExhaustion < 1 
            ? `${Math.round(hoursToExhaustion * 60)} minutes`
            : `${Math.round(hoursToExhaustion)} hours`;
        }
      }
    }

    return {
      total: this.apiKeys.length,
      active: this.apiKeys.filter(k => k.status === 'active' && k.usedThisMonth < k.monthlyLimit).length,
      exhausted: this.apiKeys.filter(k => k.status === 'exhausted' || k.usedThisMonth >= k.monthlyLimit).length,
      paused: this.apiKeys.filter(k => k.status === 'paused').length,
      totalUsageToday,
      totalCapacity,
      hasEnvironmentKeys: this.apiKeys.length > 0,
      usagePercentage,
      remainingCapacity,
      estimatedTimeToExhaustion,
      criticalKeys,
      warningKeys,
      totalUsageThisMonth: this.apiKeys.reduce((sum, k) => sum + k.usedThisMonth, 0),
      totalMonthlyCapacity: this.apiKeys.reduce((sum, k) => sum + k.monthlyLimit, 0),
      monthlyUsagePercentage: totalCapacity > 0 ? Math.round((this.apiKeys.reduce((sum, k) => sum + k.usedThisMonth, 0) / this.apiKeys.reduce((sum, k) => sum + k.monthlyLimit, 0)) * 100) : 0
    };
  }

  public getDetailedKeyStats(): IKeyHealthStatus[] {
    return this.apiKeys.map(key => {
      const usagePercentage = Math.round((key.usedToday / key.dailyLimit) * 100);
      const remainingRequests = key.dailyLimit - key.usedToday;
      
      let healthStatus: 'healthy' | 'warning' | 'critical' | 'exhausted';
      if (key.status === 'exhausted') {
        healthStatus = 'exhausted';
      } else if (usagePercentage >= 90) {
        healthStatus = 'critical';
      } else if (usagePercentage >= 75) {
        healthStatus = 'warning';
      } else {
        healthStatus = 'healthy';
      }

      const monthlyUsagePercentage = Math.round((key.usedThisMonth / key.monthlyLimit) * 100);

      return {
        id: key.id,
        status: key.status,
        usedToday: key.usedToday,
        dailyLimit: key.dailyLimit,
        usagePercentage,
        remainingRequests,
        successRate: key.successRate,
        errorCount: key.errorCount,
        lastUsed: key.lastUsed?.toISOString() || new Date().toISOString(),
        priority: key.priority,
        healthStatus,
        usedThisMonth: key.usedThisMonth,
        monthlyLimit: key.monthlyLimit,
        monthlyUsagePercentage,
        estimatedDailyExhaustion: this.estimateExhaustionTime(key)
      };
    });
  }

  private estimateExhaustionTime(key: ISerpApiKey): string | null {
    const remainingRequests = key.dailyLimit - key.usedToday;
    if (remainingRequests <= 0 || key.usedToday === 0) {
      return null;
    }

    const hoursElapsed = new Date().getHours() + (new Date().getMinutes() / 60);
    if (hoursElapsed === 0) return null;

    const currentRate = key.usedToday / hoursElapsed;
    const hoursToExhaustion = remainingRequests / currentRate;
    
    if (hoursToExhaustion < 1) {
      return `${Math.round(hoursToExhaustion * 60)} minutes`;
    } else if (hoursToExhaustion < 24) {
      return `${Math.round(hoursToExhaustion)} hours`;
    } else {
      return null;
    }
  }

  public async resetDailyUsage(): Promise<void> {
    logger.info('🔄 Starting daily usage reset...');
    
    let resetCount = 0;
    for (const key of this.apiKeys) {
      if (key.usedToday > 0 || key.status === 'exhausted') {
        key.usedToday = 0;
        key.status = 'active';
        key.errorCount = 0;
        resetCount++;
      }
    }

    try {
      await ApiKeyModel.updateMany({}, {
        usedToday: 0,
        status: 'active',
        errorCount: 0
      });
      
      logger.info(`✅ Daily usage reset completed for ${resetCount} API keys`);
    } catch (error) {
      logger.error('❌ Failed to reset daily usage in database:', error);
    }
  }

  public async resetMonthlyUsage(): Promise<void> {
    logger.info('🔄 Starting monthly usage reset (SerpAPI monthly limit refresh)...');
    
    for (const key of this.apiKeys) {
      if (key.usedThisMonth > 0 || key.status === 'exhausted') {
        key.usedThisMonth = 0;
        if (key.status === 'exhausted' && key.usedToday < key.dailyLimit) {
          key.status = 'active';
        }
        key.errorCount = 0;
        logger.debug(`Reset monthly usage for key ${key.id}`);
      }
    }

    try {
      await ApiKeyModel.updateMany({}, {
        usedThisMonth: 0,
        $set: {
          monthlyResetAt: new Date()
        }
      });
      
      logger.info(`✅ Monthly usage reset completed for ${this.apiKeys.length} API keys`);
    } catch (error) {
      logger.error('❌ Failed to reset monthly usage in database:', error);
    }
  }

  public async checkAndResetMonthlyUsage(): Promise<void> {
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    
    for (const key of this.apiKeys) {
      try {
        const existingKey = await ApiKeyModel.findOne({ keyId: key.id });
        if (existingKey && existingKey.monthlyResetAt) {
          const lastReset = new Date(existingKey.monthlyResetAt);
          const lastResetMonth = lastReset.getMonth();
          const lastResetYear = lastReset.getFullYear();
          
          if (currentMonth !== lastResetMonth || currentYear !== lastResetYear) {
            logger.info(`🗓️ Monthly reset needed for key ${key.id} (last reset: ${lastReset.toISOString()})`);
            await this.resetMonthlyUsage();
            break;
          }
        } else {
          await this.resetMonthlyUsage();
          break;
        }
      } catch (error) {
        logger.warn(`Failed to check monthly reset for key ${key.id}:`, error);
      }
    }
  }

  public async testAllKeys(): Promise<void> {
    logger.info('🧪 Testing all API keys...');
    
    for (const key of this.apiKeys) {
      try {
        logger.info(`Testing key ${key.id}...`);
        const result = await this.makeRequest(key, 'test query', {
          domain: 'example.com',
          country: 'US'
        });
        logger.info(`✅ Key ${key.id} is working (Position confidence: ${result.positionValidation.confidence}%)`);
      } catch (error) {
        logger.error(`❌ Key ${key.id} failed test: ${(error as Error).message}`);
        key.status = 'error';
      }
    }
  }

  public async testUserApiKey(apiKey: string): Promise<IApiKeyTestResult> {
    try {
      logger.info(`🧪 Testing user-provided API key...`);
      
      const tempKey: ISerpApiKey = {
        id: 'temp_user_key',
        key: apiKey.trim(),
        dailyLimit: 250,
        monthlyLimit: 250,
        usedToday: 0,
        usedThisMonth: 0,
        status: 'active',
        priority: 999,
        lastUsed: new Date(),
        errorCount: 0,
        successRate: 100,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await this.makeRequest(tempKey, 'test query', {
        domain: 'example.com',
        country: 'US'
      });

      logger.info(`✅ User API key test successful`);
      return {
        valid: true,
        message: 'API key is valid and working',
        details: {
          totalResults: result.totalResults || 0,
          responseTime: result.searchMetadata.processingTime,
          testKeyword: 'test query',
          testDomain: 'example.com',
          serpApiResponse: {
            organicResultsCount: result.searchedResults,
            positionConfidence: result.positionValidation.confidence
          }
        }
      };

    } catch (error) {
      const errorMessage = (error as Error).message;
      logger.error(`❌ User API key test failed: ${errorMessage}`);
      
      if (this.isQuotaExceeded(error)) {
        return {
          valid: false,
          message: 'API key has reached its quota limit',
          details: { errorType: 'quota_exceeded', errorMessage }
        };
      } else if (this.isRateLimited(error)) {
        return {
          valid: false,
          message: 'API key is being rate limited',
          details: { errorType: 'rate_limited', errorMessage }
        };
      } else if (errorMessage.includes('401') || errorMessage.includes('unauthorized')) {
        return {
          valid: false,
          message: 'Invalid API key',
          details: { errorType: 'unauthorized', errorMessage }
        };
      } else {
        return {
          valid: false,
          message: `API key test failed: ${errorMessage}`,
          details: {
            errorType: 'unknown',
            errorMessage,
            testKeyword: 'test query',
            testDomain: 'example.com'
          }
        };
      }
    }
  }

  public async addApiKey(apiKey: string, dailyLimit?: number, monthlyLimit?: number): Promise<IApiKeyAddResult> {
    try {
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 32) {
        return {
          success: false,
          message: 'Invalid API key format. Key must be at least 32 characters long.'
        };
      }

      const trimmedKey = apiKey.trim();

      const existingUserKey = this.apiKeys.find(k => 
        k.key === trimmedKey && 
        k.id.startsWith('user_serpapi_')
      );
      
      if (existingUserKey) {
        return {
          success: false,
          message: 'API key already exists in the pool',
          keyId: existingUserKey.id
        };
      }

      const existingEnvKey = this.apiKeys.find(k => 
        k.key === trimmedKey && 
        k.id.startsWith('serpapi_')
      );

      if (existingEnvKey) {
        logger.info(`ℹ️ API key already exists as environment key ${existingEnvKey.id}, but adding as user key`);
      }

      if (!existingEnvKey) {
        logger.info(`🧪 Testing new API key before adding to pool...`);
        const testResult = await this.testUserApiKey(trimmedKey);
        
        if (!testResult.valid) {
          if (testResult.message.toLowerCase().includes('rate limit') || 
              testResult.message.toLowerCase().includes('too many requests')) {
            return {
              success: false,
              message: 'Unable to validate API key due to rate limiting. Try again in a few minutes, or add the key directly to backend .env file.',
              testResult
            };
          }
          
          return {
            success: false,
            message: `Invalid API key: ${testResult.message}`,
            testResult
          };
        }
        logger.info(`✅ API key validation successful`);
      } else {
        logger.info(`⏩ Skipping validation - key already validated as environment key`);
      }

      const timestamp = Date.now();
      const keyId = `user_serpapi_${timestamp}`;
      
      const newKey: ISerpApiKey = {
        id: keyId,
        key: trimmedKey,
        provider: 'serpapi',
        dailyLimit: dailyLimit || 250,
        monthlyLimit: monthlyLimit || 250,
        usedToday: 0,
        usedThisMonth: 0,
        status: 'active',
        priority: this.apiKeys.length + 1,
        lastUsed: new Date(),
        errorCount: 0,
        successRate: 100,
        createdAt: new Date(),
        updatedAt: new Date(),
        monthlyResetAt: new Date()
      };

      this.apiKeys.push(newKey);

      // Save to database with the actual API key and isUserAdded flag
      await ApiKeyModel.create({
        keyId: newKey.id,
        apiKey: trimmedKey, // Store the actual API key
        provider: 'serpapi',
        dailyLimit: newKey.dailyLimit,
        monthlyLimit: newKey.monthlyLimit,
        usedToday: 0,
        usedThisMonth: 0,
        status: 'active',
        priority: newKey.priority,
        errorCount: 0,
        successRate: 100,
        monthlyResetAt: new Date(),
        isUserAdded: true // Mark as user-added key
      });

      logger.info(`✅ Successfully added new API key: ${keyId} (Daily: ${newKey.dailyLimit}, Monthly: ${newKey.monthlyLimit})`);
      
      return {
        success: true,
        message: existingEnvKey 
          ? 'API key added successfully (Note: This key also exists in environment variables)'
          : 'API key added successfully',
        keyId: keyId
      };

    } catch (error) {
      const errorMessage = (error as Error).message;
      logger.error('❌ Failed to add API key:', error);
      
      if (errorMessage.toLowerCase().includes('rate limit') || 
          errorMessage.toLowerCase().includes('too many requests') ||
          errorMessage.toLowerCase().includes('429')) {
        return {
          success: false,
          message: 'Unable to validate API key due to rate limiting. Try again in a few minutes, or add the key directly to backend .env file.'
        };
      }
      
      return {
        success: false,
        message: `Failed to add API key: ${errorMessage}`
      };
    }
  }

  public async removeApiKey(keyId: string): Promise<IApiKeyRemoveResult> {
    try {
      const keyIndex = this.apiKeys.findIndex(k => k.id === keyId);
      if (keyIndex === -1) {
        return {
          success: false,
          message: 'API key not found'
        };
      }

      this.apiKeys.splice(keyIndex, 1);
      await ApiKeyModel.deleteOne({ keyId: keyId });

      logger.info(`✅ Successfully removed API key: ${keyId}`);
      return {
        success: true,
        message: 'API key removed successfully',
        removedKeyId: keyId
      };

    } catch (error) {
      logger.error('❌ Failed to remove API key:', error);
      return {
        success: false,
        message: `Failed to remove API key: ${(error as Error).message}`
      };
    }
  }

  public async updateApiKey(keyId: string, updates: Partial<{ dailyLimit: number; monthlyLimit: number; priority: number }>): Promise<IApiKeyUpdateResult> {
    try {
      const key = this.apiKeys.find(k => k.id === keyId);
      if (!key) {
        return {
          success: false,
          message: 'API key not found'
        };
      }

      if (updates.dailyLimit !== undefined) key.dailyLimit = updates.dailyLimit;
      if (updates.monthlyLimit !== undefined) key.monthlyLimit = updates.monthlyLimit;
      if (updates.priority !== undefined) key.priority = updates.priority;
      key.updatedAt = new Date();

      const updateData: any = { updatedAt: new Date() };
      if (updates.dailyLimit !== undefined) updateData.dailyLimit = updates.dailyLimit;
      if (updates.monthlyLimit !== undefined) updateData.monthlyLimit = updates.monthlyLimit;
      if (updates.priority !== undefined) updateData.priority = updates.priority;

      await ApiKeyModel.updateOne({ keyId: keyId }, updateData);

      logger.info(`✅ Successfully updated API key: ${keyId}`);
      return {
        success: true,
        message: 'API key updated successfully',
        updatedKey: {
          id: keyId,
          dailyLimit: updates.dailyLimit,
          monthlyLimit: updates.monthlyLimit,
          priority: updates.priority
        }
      };

    } catch (error) {
      logger.error('❌ Failed to update API key:', error);
      return {
        success: false,
        message: `Failed to update API key: ${(error as Error).message}`
      };
    }
  }

  public async refreshStats(): Promise<void> {
    logger.debug('📊 Refreshing API pool statistics...');
  }

  /**
   * Add a Google Custom Search API key
   */
  public async addGoogleCustomSearchKey(apiKey: string, cseId: string, dailyLimit?: number): Promise<IApiKeyAddResult> {
    try {
      if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length < 20) {
        return {
          success: false,
          message: 'Invalid Google API key format. Key must be at least 20 characters long.'
        };
      }

      if (!cseId || typeof cseId !== 'string') {
        return {
          success: false,
          message: 'Custom Search Engine ID (CSE ID) is required for Google Custom Search.'
        };
      }

      const trimmedKey = apiKey.trim();
      const trimmedCseId = cseId.trim();

      const existingKey = this.apiKeys.find(k => 
        k.key === trimmedKey && 
        k.provider === 'google_custom_search'
      );
      
      if (existingKey) {
        return {
          success: false,
          message: 'Google Custom Search API key already exists in the pool',
          keyId: existingKey.id
        };
      }

      // Test the key
      logger.info(`🧪 Testing Google Custom Search API key...`);
      const testResult = await this.testGoogleCustomSearchKey(trimmedKey, trimmedCseId);
      
      if (!testResult.valid) {
        return {
          success: false,
          message: `Invalid Google Custom Search API key: ${testResult.message}`,
          testResult
        };
      }
      logger.info(`✅ Google Custom Search API key validation successful`);

      const timestamp = Date.now();
      const keyId = `user_google_cse_${timestamp}`;
      
      const newKey: ISerpApiKey = {
        id: keyId,
        key: trimmedKey,
        provider: 'google_custom_search',
        cseId: trimmedCseId,
        dailyLimit: dailyLimit || 100, // Google Custom Search free tier: 100/day
        monthlyLimit: 0, // Not applicable for Google Custom Search
        usedToday: 0,
        usedThisMonth: 0,
        status: 'active',
        priority: this.apiKeys.length + 1,
        lastUsed: new Date(),
        errorCount: 0,
        successRate: 100,
        createdAt: new Date(),
        updatedAt: new Date(),
        monthlyResetAt: new Date()
      };

      this.apiKeys.push(newKey);

      // Save to database with the actual API key and isUserAdded flag
      await ApiKeyModel.create({
        keyId: newKey.id,
        apiKey: trimmedKey, // Store the actual API key
        provider: 'google_custom_search',
        cseId: trimmedCseId, // Store the CSE ID
        dailyLimit: newKey.dailyLimit,
        monthlyLimit: newKey.monthlyLimit,
        usedToday: 0,
        usedThisMonth: 0,
        status: 'active',
        priority: newKey.priority,
        errorCount: 0,
        successRate: 100,
        monthlyResetAt: new Date(),
        isUserAdded: true // Mark as user-added key
      });

      logger.info(`✅ Successfully added Google Custom Search API key: ${keyId} (Daily: ${newKey.dailyLimit})`);
      
      return {
        success: true,
        message: 'Google Custom Search API key added successfully',
        keyId: keyId
      };

    } catch (error) {
      const errorMessage = (error as Error).message;
      logger.error('❌ Failed to add Google Custom Search API key:', error);
      
      return {
        success: false,
        message: `Failed to add Google Custom Search API key: ${errorMessage}`
      };
    }
  }

  /**
   * Test a Google Custom Search API key
   */
  private async testGoogleCustomSearchKey(apiKey: string, cseId: string): Promise<IApiKeyTestResult> {
    try {
      const params = new URLSearchParams({
        key: apiKey,
        cx: cseId,
        q: 'test query',
        num: '1'
      });

      const url = `https://www.googleapis.com/customsearch/v1?${params.toString()}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          valid: false,
          message: `API request failed: ${response.status} ${errorText}`,
          details: { errorMessage: errorText }
        };
      }

      const data: IGoogleCustomSearchResponse = await response.json();

      if (data.searchInformation) {
        return {
          valid: true,
          message: 'Google Custom Search API key is valid and working',
          details: {
            totalResults: parseInt(data.searchInformation.totalResults || '0'),
            responseTime: data.searchInformation.searchTime,
            testKeyword: 'test query'
          }
        };
      }

      return {
        valid: false,
        message: 'Invalid response from Google Custom Search API',
        details: { errorMessage: 'No search information in response' }
      };

    } catch (error) {
      const errorMessage = (error as Error).message;
      logger.error(`❌ Google Custom Search API key test failed: ${errorMessage}`);
      
      return {
        valid: false,
        message: `API key test failed: ${errorMessage}`,
        details: { errorMessage }
      };
    }
  }

  /**
   * Extract API usage information from response headers
   * Supports ValueSERP, SerpAPI, and other providers
   */
  private extractApiUsageFromHeaders(headers: any): IApiUsageInfo | null {
    try {
      // Check for various header formats used by different providers
      const usageHeaders = {
        used: headers.get('x-searches-used') || headers.get('x-api-usage-used') || headers.get('x-usage-used'),
        remaining: headers.get('x-searches-remaining') || headers.get('x-api-usage-remaining') || headers.get('x-usage-remaining'),
        limit: headers.get('x-monthly-limit') || headers.get('x-api-limit') || headers.get('x-usage-limit'),
        reset: headers.get('x-reset-date') || headers.get('x-usage-reset')
      };

      // ValueSERP specific: X-API-Usage header (format: "used/limit")
      const apiUsageHeader = headers.get('x-api-usage');
      if (apiUsageHeader && typeof apiUsageHeader === 'string') {
        const match = apiUsageHeader.match(/(\d+)\/(\d+)/);
        if (match) {
          const used = parseInt(match[1], 10);
          const limit = parseInt(match[2], 10);
          const remaining = limit - used;
          const percentageUsed = Math.round((used / limit) * 100);

          return {
            used,
            remaining,
            limit,
            percentageUsed,
            provider: 'valueserp'
          };
        }
      }

      // Try individual headers
      if (usageHeaders.used && usageHeaders.limit) {
        const used = parseInt(usageHeaders.used, 10);
        const limit = parseInt(usageHeaders.limit, 10);
        const remaining = usageHeaders.remaining ? parseInt(usageHeaders.remaining, 10) : (limit - used);
        const percentageUsed = Math.round((used / limit) * 100);

        return {
          used,
          remaining,
          limit,
          resetDate: usageHeaders.reset || undefined,
          percentageUsed,
          provider: 'unknown'
        };
      }

      // Check response body for account info (some APIs include it)
      return null;
    } catch (error) {
      logger.warn('Failed to extract API usage from headers:', error);
      return null;
    }
  }
}

