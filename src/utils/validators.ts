import Joi from 'joi';

export const validateSearchRequest = (data: any) => {
  const schema = Joi.object({
    keyword: Joi.string().required().min(1).max(500).trim(),
    domain: Joi.string().required().min(1).max(255).trim(),
    country: Joi.string().required().length(2).uppercase(),
    city: Joi.string().optional().max(100).trim().allow(''),
    state: Joi.string().optional().max(50).trim().allow(''),
    postalCode: Joi.string().optional().max(20).trim().allow(''),
    language: Joi.string().optional().length(2).lowercase().default('en'),
    device: Joi.string().optional().valid('desktop', 'mobile', 'tablet').default('desktop'),
    businessName: Joi.string().optional().max(200).trim().allow(''),
    apiKey: Joi.string().optional().max(64).trim()
  });

  return schema.validate(data, { abortEarly: false });
};

export const validateBulkSearchRequest = (data: any) => {
  const schema = Joi.object({
    keywords: Joi.array()
      .items(Joi.string().min(1).max(500).trim())
      .min(1)
      // .max(100)  // REMOVED: No limit on number of keywords
      .required()
      .unique(),
    domain: Joi.string().required().min(1).max(255).trim(),
    country: Joi.string().required().length(2).uppercase(),
    city: Joi.string().optional().max(100).trim().allow(''),
    state: Joi.string().optional().max(50).trim().allow(''),
    postalCode: Joi.string().optional().max(20).trim().allow(''),
    language: Joi.string().optional().length(2).lowercase().default('en'),
    device: Joi.string().optional().valid('desktop', 'mobile', 'tablet').default('desktop'),
    businessName: Joi.string().optional().max(200).trim().allow(''),
    apiKey: Joi.string().optional().max(64).trim()
  });

  return schema.validate(data, { abortEarly: false });
};

export const validateQueryParams = (params: any) => {
  const schema = Joi.object({
    limit: Joi.number().integer().min(1).max(100).default(50),
    offset: Joi.number().integer().min(0).default(0),
    sortBy: Joi.string().valid('timestamp', 'keyword', 'domain', 'position', 'found').default('timestamp'),
    sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
    dateFrom: Joi.date().iso().optional(),
    dateTo: Joi.date().iso().min(Joi.ref('dateFrom')).optional(),
    domain: Joi.string().optional().max(255).trim(),
    keyword: Joi.string().optional().max(500).trim(),
    country: Joi.string().optional().length(2).uppercase(),
    found: Joi.boolean().optional()
  });

  return schema.validate(params, { abortEarly: false, allowUnknown: true });
};

export const validateAnalyticsRequest = (params: any) => {
  const schema = Joi.object({
    domain: Joi.string().required().min(1).max(255).trim(),
    days: Joi.number().integer().min(1).max(365).default(30),
    keyword: Joi.string().optional().max(500).trim(),
    country: Joi.string().optional().length(2).uppercase()
  });

  return schema.validate(params, { abortEarly: false });
};

export const validateExportRequest = (params: any) => {
  const schema = Joi.object({
    domain: Joi.string().optional().max(255).trim(),
    format: Joi.string().valid('csv', 'json', 'xlsx').default('csv'),
    dateFrom: Joi.date().iso().optional(),
    dateTo: Joi.date().iso().min(Joi.ref('dateFrom')).optional(),
    found: Joi.boolean().optional(),
    country: Joi.string().optional().length(2).uppercase(),
    limit: Joi.number().integer().min(1).max(10000).default(1000)
  });

  return schema.validate(params, { abortEarly: false, allowUnknown: true });
};

// Validate API key format
export const validateApiKeyFormat = (apiKey: string): boolean => {
  // Basic validation for SerpApi key format
  if (!apiKey || typeof apiKey !== 'string') {
    return false;
  }
  
  // SerpApi keys are typically 64-character hex strings
  const serpApiKeyRegex = /^[a-f0-9]{64}$/i;
  
  return serpApiKeyRegex.test(apiKey) || apiKey.length >= 32;
};

// Validate domain format
export const validateDomainFormat = (domain: string): boolean => {
  if (!domain || typeof domain !== 'string') {
    return false;
  }
  
  // Remove protocol if present
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
  
  // Basic domain validation regex
  const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9](?:\.[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])*$/;
  
  return domainRegex.test(cleanDomain);
};

// Validate keyword format
export const validateKeywordFormat = (keyword: string): boolean => {
  if (!keyword || typeof keyword !== 'string') {
    return false;
  }
  
  const trimmed = keyword.trim();
  
  // Check length
  if (trimmed.length < 1 || trimmed.length > 500) {
    return false;
  }
  
  // Check for valid characters (allow letters, numbers, spaces, and common punctuation)
  const keywordRegex = /^[a-zA-Z0-9\s\-_.,!?'"()&+]*$/;
  
  return keywordRegex.test(trimmed);
};

// Validate country code
export const validateCountryCode = (country: string): boolean => {
  if (!country || typeof country !== 'string' || country.length !== 2) {
    return false;
  }
  
  // List of valid country codes supported by most search engines
  const validCountries = [
    'US', 'CA', 'GB', 'AU', 'DE', 'FR', 'ES', 'IT', 'NL', 'SE', 'NO', 'DK', 'FI',
    'JP', 'KR', 'CN', 'IN', 'BR', 'MX', 'AR', 'CL', 'CO', 'PE', 'ZA', 'EG',
    'NG', 'KE', 'GH', 'RU', 'PL', 'CZ', 'HU', 'RO', 'GR', 'PT', 'BE', 'AT',
    'CH', 'IE', 'SG', 'MY', 'TH', 'ID', 'PH', 'VN', 'PK', 'BD', 'LK', 'NP',
    'AE', 'SA', 'IL', 'TR', 'UA', 'BY', 'LT', 'LV', 'EE', 'HR', 'SI', 'SK',
    'BG', 'RS', 'BA', 'MK', 'AL', 'MT', 'CY', 'LU', 'IS', 'MD', 'AM', 'GE',
    'AZ', 'KZ', 'UZ', 'TM', 'KG', 'TJ', 'AF', 'IQ', 'IR', 'LB', 'JO', 'SY',
    'YE', 'OM', 'QA', 'BH', 'KW', 'LY', 'DZ', 'TN', 'MA', 'SD', 'ET', 'UG',
    'TZ', 'KE', 'RW', 'MW', 'ZM', 'ZW', 'BW', 'NA', 'MZ', 'MG', 'MU', 'SC'
  ];
  
  return validCountries.includes(country.toUpperCase());
};

// Middleware for validating API key addition
export const validateApiKey = (req: any, res: any, next: any) => {
  const schema = Joi.object({
    apiKey: Joi.string().required().min(32).max(64).trim(),
    dailyLimit: Joi.number().integer().min(1).max(50000).default(250),
    monthlyLimit: Joi.number().integer().min(1).max(500000).default(250)
  });

  const { error, value } = schema.validate(req.body, { abortEarly: false });

  if (error) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: error.details.map((detail: any) => detail.message)
    });
  }

  // Additional API key format validation
  if (!validateApiKeyFormat(value.apiKey)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid API key format'
    });
  }

  req.body = value;
  next();
};

// Middleware for validating API key updates
export const validateKeyUpdate = (req: any, res: any, next: any) => {
  const schema = Joi.object({
    dailyLimit: Joi.number().integer().min(1).max(50000).optional(),
    monthlyLimit: Joi.number().integer().min(1).max(500000).optional(),
    priority: Joi.number().integer().min(1).max(100).optional()
  }).min(1); // At least one field must be provided

  const { error, value } = schema.validate(req.body, { abortEarly: false });

  if (error) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: error.details.map((detail: any) => detail.message)
    });
  }

  req.body = value;
  next();
};