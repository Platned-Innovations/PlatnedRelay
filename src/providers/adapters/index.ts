import { ProviderAdapter, ProviderType } from './base';
import { AzureOpenAIAdapter, OpenAIAdapter } from './openai.adapter';
import { AnthropicAdapter } from './anthropic.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { CustomAdapter } from './custom.adapter';

const ADAPTERS: Record<ProviderType, ProviderAdapter> = {
  openai: new OpenAIAdapter(),
  'azure-openai': new AzureOpenAIAdapter(),
  anthropic: new AnthropicAdapter(),
  gemini: new GeminiAdapter(),
  custom: new CustomAdapter(),
};

export const PROVIDER_TYPES = Object.keys(ADAPTERS) as ProviderType[];

export function adapterFor(type: ProviderType): ProviderAdapter {
  const a = ADAPTERS[type];
  if (!a) throw new Error(`Unsupported provider type ${type}`);
  return a;
}

export * from './base';
