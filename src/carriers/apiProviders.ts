import type { ApiProvider } from './types.js';
import { upsApi } from './api/ups.js';
import { fedexApi } from './api/fedex.js';

// Carriers that have an official-API provider a user can opt into with their own
// keys. Without keys, these carriers fall back to their scraper module.

const apis: Record<string, ApiProvider> = {
  ups: upsApi,
  fedex: fedexApi,
};

export const API_CARRIERS = Object.keys(apis);

export function hasApiProvider(code: string): boolean {
  return code in apis;
}

export function getApiProvider(code: string): ApiProvider | undefined {
  return apis[code];
}
