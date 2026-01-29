import mongoose, { Schema, Document } from 'mongoose';

export interface IApiKeyDocument extends Document {
  keyId: string;
  apiKey: string; // Store the actual API key (encrypted in production)
  provider: 'serpapi' | 'google_custom_search'; // API provider type
  cseId?: string; // Google Custom Search Engine ID (only for google_custom_search)
  dailyLimit: number;
  monthlyLimit: number;
  usedToday: number;
  usedThisMonth: number;
  status: 'active' | 'exhausted' | 'error' | 'paused';
  priority: number;
  lastUsed: Date;
  errorCount: number;
  successRate: number;
  monthlyResetAt: Date;
  isUserAdded: boolean; // Track if key was added by user (vs environment)
  createdAt: Date;
  updatedAt: Date;
}

const apiKeySchema = new Schema<IApiKeyDocument>({
  keyId: { type: String, required: true, unique: true },
  apiKey: { type: String, required: true }, // Store the actual key
  provider: { 
    type: String, 
    enum: ['serpapi', 'google_custom_search'],
    default: 'serpapi',
    required: true
  },
  cseId: { type: String }, // Optional CSE ID for Google Custom Search
  dailyLimit: { type: Number, default: 5000 },
  monthlyLimit: { type: Number, default: 100000 },
  usedToday: { type: Number, default: 0 },
  usedThisMonth: { type: Number, default: 0 },
  status: { 
    type: String, 
    enum: ['active', 'exhausted', 'error', 'paused'], 
    default: 'active' 
  },
  priority: { type: Number, default: 1 },
  lastUsed: { type: Date, default: Date.now },
  errorCount: { type: Number, default: 0 },
  successRate: { type: Number, default: 100, min: 0, max: 100 },
  monthlyResetAt: { type: Date, default: Date.now },
  isUserAdded: { type: Boolean, default: false }, // Track source of key
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Indexes for performance
// apiKeySchema.index({ keyId: 1 }); // Removed duplicate index
apiKeySchema.index({ status: 1 });
apiKeySchema.index({ priority: 1 });
apiKeySchema.index({ usedToday: 1 });

// Update the updatedAt field before saving
apiKeySchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

export const ApiKeyModel = mongoose.model<IApiKeyDocument>('ApiKey', apiKeySchema);
