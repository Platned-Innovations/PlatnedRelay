import { ModelCapabilities, ProviderType } from './adapters/base';

export interface Pricing {
  /** USD per 1M input tokens (uncached). */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
  /** USD per 1M cache-read input tokens. */
  cachedInput?: number;
  /** USD per 1M cache-write input tokens. */
  cacheWrite?: number;
  /** Flat USD per request (some APIs). */
  perRequest?: number;
}

export interface PresetModel {
  id: string;
  name: string;
  type?: 'chat' | 'embedding';
  tier: 'cheap' | 'standard' | 'strong';
  contextWindow?: number;
  maxOutputTokens?: number;
  pricing: Pricing;
  capabilities?: ModelCapabilities;
}

export interface ProviderPreset {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  docsUrl?: string;
  /** Hints for the admin UI. */
  needsApiKey: boolean;
  configHints?: string[];
  config?: Record<string, unknown>;
  models: PresetModel[];
}

const chat = (caps: ModelCapabilities = {}): ModelCapabilities => ({ tools: true, streaming: true, json: true, sampling: true, ...caps });
const claude = (id: string, name: string, tier: PresetModel['tier'], input: number, output: number, cached: number, ctx = 1_000_000, max = 128_000): PresetModel => ({
  id, name, tier, contextWindow: ctx, maxOutputTokens: max,
  pricing: { input, output, cachedInput: cached, cacheWrite: +(input * 1.25).toFixed(4) },
  capabilities: chat({ vision: true, reasoning: true, sampling: false }),
});

/**
 * Built-in provider templates. Prices are list prices known at build time and are
 * DEFAULTS ONLY - always verify against the provider's pricing page and edit them
 * in Models → Pricing (changes are versioned in pricing history).
 */
export const PRESETS: ProviderPreset[] = [
  {
    id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', needsApiKey: true, docsUrl: 'https://platform.openai.com/docs/pricing',
    models: [
      { id: 'gpt-5', name: 'GPT-5', tier: 'strong', contextWindow: 400_000, maxOutputTokens: 128_000, pricing: { input: 1.25, output: 10, cachedInput: 0.125 }, capabilities: chat({ vision: true, reasoning: true, sampling: false }) },
      { id: 'gpt-5-mini', name: 'GPT-5 mini', tier: 'standard', contextWindow: 400_000, maxOutputTokens: 128_000, pricing: { input: 0.25, output: 2, cachedInput: 0.025 }, capabilities: chat({ vision: true, reasoning: true, sampling: false }) },
      { id: 'gpt-5-nano', name: 'GPT-5 nano', tier: 'cheap', contextWindow: 400_000, maxOutputTokens: 128_000, pricing: { input: 0.05, output: 0.4, cachedInput: 0.005 }, capabilities: chat({ vision: true, reasoning: true, sampling: false }) },
      { id: 'gpt-4.1', name: 'GPT-4.1', tier: 'strong', contextWindow: 1_047_576, maxOutputTokens: 32_768, pricing: { input: 2, output: 8, cachedInput: 0.5 }, capabilities: chat({ vision: true }) },
      { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', tier: 'standard', contextWindow: 1_047_576, maxOutputTokens: 32_768, pricing: { input: 0.4, output: 1.6, cachedInput: 0.1 }, capabilities: chat({ vision: true }) },
      { id: 'gpt-4.1-nano', name: 'GPT-4.1 nano', tier: 'cheap', contextWindow: 1_047_576, maxOutputTokens: 32_768, pricing: { input: 0.1, output: 0.4, cachedInput: 0.025 }, capabilities: chat({ vision: true }) },
      { id: 'gpt-4o', name: 'GPT-4o', tier: 'standard', contextWindow: 128_000, maxOutputTokens: 16_384, pricing: { input: 2.5, output: 10, cachedInput: 1.25 }, capabilities: chat({ vision: true }) },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', tier: 'cheap', contextWindow: 128_000, maxOutputTokens: 16_384, pricing: { input: 0.15, output: 0.6, cachedInput: 0.075 }, capabilities: chat({ vision: true }) },
      { id: 'o3', name: 'o3', tier: 'strong', contextWindow: 200_000, maxOutputTokens: 100_000, pricing: { input: 2, output: 8, cachedInput: 0.5 }, capabilities: chat({ vision: true, reasoning: true, sampling: false }) },
      { id: 'o4-mini', name: 'o4-mini', tier: 'standard', contextWindow: 200_000, maxOutputTokens: 100_000, pricing: { input: 1.1, output: 4.4, cachedInput: 0.275 }, capabilities: chat({ vision: true, reasoning: true, sampling: false }) },
      { id: 'text-embedding-3-small', name: 'Embedding 3 small', type: 'embedding', tier: 'cheap', pricing: { input: 0.02, output: 0 } },
      { id: 'text-embedding-3-large', name: 'Embedding 3 large', type: 'embedding', tier: 'standard', pricing: { input: 0.13, output: 0 } },
    ],
  },
  {
    id: 'anthropic', name: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', needsApiKey: true, docsUrl: 'https://www.anthropic.com/pricing',
    configHints: ['anthropicVersion (default 2023-06-01)', 'betas (comma separated anthropic-beta header)'],
    models: [
      claude('claude-opus-5-5', 'Claude Opus 5.5', 'strong', 4, 20, 0.2),
      claude('claude-sonnet-5-5', 'Claude Sonnet 5.5', 'standard', 2, 10, 0.2),
      claude('claude-haiku-5-5', 'Claude Haiku 5.5', 'cheap', 0.1, 0.5, 0.01),
      claude('claude-fable-5-1', 'Claude Fable 5.1', 'strong', 10, 50, 0.25),
      { ...claude('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'standard', 3, 15, 0.3), capabilities: chat({ vision: true, reasoning: true }) },
      { ...claude('claude-haiku-4-5', 'Claude Haiku 4.5', 'cheap', 1, 5, 0.1, 200_000, 64_000), capabilities: chat({ vision: true }) },
    ],
  },
  {
    id: 'gemini', name: 'Google Gemini', type: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', needsApiKey: true, docsUrl: 'https://ai.google.dev/pricing',
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tier: 'strong', contextWindow: 1_048_576, maxOutputTokens: 65_536, pricing: { input: 1.25, output: 10, cachedInput: 0.31 }, capabilities: chat({ vision: true, reasoning: true }) },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', tier: 'standard', contextWindow: 1_048_576, maxOutputTokens: 65_536, pricing: { input: 0.3, output: 2.5, cachedInput: 0.075 }, capabilities: chat({ vision: true, reasoning: true }) },
      { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', tier: 'cheap', contextWindow: 1_048_576, maxOutputTokens: 65_536, pricing: { input: 0.1, output: 0.4, cachedInput: 0.025 }, capabilities: chat({ vision: true }) },
      { id: 'gemini-embedding-001', name: 'Gemini Embedding', type: 'embedding', tier: 'cheap', pricing: { input: 0.15, output: 0 } },
    ],
  },
  {
    id: 'azure-openai', name: 'Azure OpenAI', type: 'azure-openai', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com', needsApiKey: true,
    configHints: ['Model ID = deployment name', 'apiVersion (default 2024-10-21)', 'v1: true to use the /openai/v1 API'],
    config: { apiVersion: '2024-10-21' },
    models: [],
  },
  {
    id: 'deepseek', name: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', needsApiKey: true, docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', tier: 'cheap', contextWindow: 128_000, maxOutputTokens: 8_192, pricing: { input: 0.28, output: 0.42, cachedInput: 0.028 }, capabilities: chat() },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', tier: 'standard', contextWindow: 128_000, maxOutputTokens: 64_000, pricing: { input: 0.28, output: 0.42, cachedInput: 0.028 }, capabilities: chat({ reasoning: true, tools: false }) },
    ],
  },
  {
    id: 'mistral', name: 'Mistral AI', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', needsApiKey: true, config: { streamUsage: false },
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large', tier: 'strong', contextWindow: 128_000, pricing: { input: 2, output: 6 }, capabilities: chat() },
      { id: 'mistral-small-latest', name: 'Mistral Small', tier: 'cheap', contextWindow: 128_000, pricing: { input: 0.1, output: 0.3 }, capabilities: chat() },
      { id: 'mistral-embed', name: 'Mistral Embed', type: 'embedding', tier: 'cheap', pricing: { input: 0.1, output: 0 } },
    ],
  },
  {
    id: 'groq', name: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsApiKey: true,
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', tier: 'standard', contextWindow: 131_072, pricing: { input: 0.59, output: 0.79 }, capabilities: chat() },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', tier: 'cheap', contextWindow: 131_072, pricing: { input: 0.05, output: 0.08 }, capabilities: chat() },
    ],
  },
  {
    id: 'xai', name: 'xAI', type: 'openai', baseUrl: 'https://api.x.ai/v1', needsApiKey: true,
    models: [
      { id: 'grok-4', name: 'Grok 4', tier: 'strong', contextWindow: 256_000, pricing: { input: 3, output: 15, cachedInput: 0.75 }, capabilities: chat({ vision: true, reasoning: true }) },
      { id: 'grok-3-mini', name: 'Grok 3 mini', tier: 'cheap', contextWindow: 131_072, pricing: { input: 0.3, output: 0.5, cachedInput: 0.075 }, capabilities: chat({ reasoning: true }) },
    ],
  },
  { id: 'together', name: 'Together AI', type: 'openai', baseUrl: 'https://api.together.xyz/v1', needsApiKey: true, models: [] },
  { id: 'fireworks', name: 'Fireworks AI', type: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', needsApiKey: true, models: [] },
  { id: 'openrouter', name: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsApiKey: true, models: [] },
  { id: 'perplexity', name: 'Perplexity', type: 'openai', baseUrl: 'https://api.perplexity.ai', needsApiKey: true, models: [] },
  { id: 'cohere', name: 'Cohere (OpenAI compatibility)', type: 'openai', baseUrl: 'https://api.cohere.ai/compatibility/v1', needsApiKey: true, models: [] },
  { id: 'azure-ai-foundry', name: 'Azure AI Foundry (OpenAI-compatible)', type: 'openai', baseUrl: 'https://YOUR-RESOURCE.services.ai.azure.com/openai/v1', needsApiKey: true, models: [] },
  {
    id: 'bedrock', name: 'AWS Bedrock (OpenAI-compatible, API key)', type: 'openai', baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', needsApiKey: true,
    configHints: ['Use a Bedrock API key; change the region in the base URL'], models: [],
  },
  {
    id: 'ollama', name: 'Ollama (local)', type: 'openai', baseUrl: 'http://localhost:11434/v1', needsApiKey: false,
    models: [{ id: 'llama3.1:8b', name: 'Llama 3.1 8B (local)', tier: 'cheap', contextWindow: 131_072, pricing: { input: 0, output: 0 }, capabilities: chat() }],
  },
  { id: 'vllm', name: 'vLLM (self-hosted)', type: 'openai', baseUrl: 'http://localhost:8000/v1', needsApiKey: false, models: [] },
  { id: 'lmstudio', name: 'LM Studio (local)', type: 'openai', baseUrl: 'http://localhost:1234/v1', needsApiKey: false, models: [] },
  { id: 'openai-compatible', name: 'Custom OpenAI-compatible API', type: 'openai', baseUrl: 'https://your-endpoint/v1', needsApiKey: false, models: [] },
  {
    id: 'custom', name: 'Custom HTTP API (templated)', type: 'custom', baseUrl: 'https://your-endpoint', needsApiKey: false,
    config: {
      custom: {
        path: '/generate',
        method: 'POST',
        headers: { Authorization: 'Bearer {{apiKey}}' },
        bodyTemplate: { model: '{{model}}', messages: '{{messages}}', max_tokens: '{{max_tokens}}', temperature: '{{temperature}}' },
        responseMapping: { content: 'output.text', inputTokens: 'usage.input_tokens', outputTokens: 'usage.output_tokens', finishReason: 'stop_reason' },
      },
    },
    models: [],
  },
];

export function presetById(id?: string) {
  return PRESETS.find((p) => p.id === id);
}
