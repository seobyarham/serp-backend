import mongoose, { Schema, Document } from 'mongoose';

export interface ISearchResultDocument extends Document {
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
  processingTime?: number;
  apiKeyUsed?: string;
  businessName?: string;
}

const searchResultSchema = new Schema<ISearchResultDocument>({
  keyword: { type: String, required: true, trim: true },
  domain: { type: String, required: true, trim: true },
  position: { type: Number, default: null, min: 1 },
  url: { type: String, default: '', trim: true },
  title: { type: String, default: '', trim: true },
  description: { type: String, default: '', trim: true },
  country: { type: String, required: true, uppercase: true },
  city: { type: String, default: '', trim: true },
  state: { type: String, default: '', trim: true },
  postalCode: { type: String, default: '', trim: true },
  totalResults: { type: Number, default: 0, min: 0 },
  searchedResults: { type: Number, default: 0, min: 0 },
  timestamp: { type: Date, default: Date.now },
  found: { type: Boolean, default: false },
  processingTime: { type: Number, default: null },
  apiKeyUsed: { type: String, default: null },
  businessName: { type: String, default: '', trim: true }
});

// Indexes for efficient querying
searchResultSchema.index({ keyword: 1, domain: 1 });
searchResultSchema.index({ timestamp: -1 });
searchResultSchema.index({ domain: 1, timestamp: -1 });
searchResultSchema.index({ position: 1 });
searchResultSchema.index({ found: 1 });
searchResultSchema.index({ country: 1 });
searchResultSchema.index({ keyword: 'text', domain: 'text' });

// Compound indexes for complex queries
searchResultSchema.index({ domain: 1, keyword: 1, timestamp: -1 });
searchResultSchema.index({ found: 1, position: 1 });

export const SearchResultModel = mongoose.model<ISearchResultDocument>('SearchResult', searchResultSchema);