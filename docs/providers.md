# Providers

Relay talks to providers over HTTPS with its own adapters (no vendor SDKs), so every provider is metered, streamed and error-handled the same way. Requests and responses are normalised to the OpenAI Chat Completions format.

| Adapter type | Used for | Auth |
|---|---|---|
| `openai` | OpenAI and every OpenAI-compatible API | `Authorization: Bearer <apiKey>` (+ optional headers) |
| `azure-openai` | Azure OpenAI deployments | `api-key` header |
| `anthropic` | Anthropic Messages API | `x-api-key`, `anthropic-version` |
| `gemini` | Google Gemini API (AI Studio) | `x-goog-api-key` |
| `custom` | Any other HTTP API via templates | Configurable |

## Presets

| Preset | Type | Base URL |
|---|---|---|
| OpenAI | openai | `https://api.openai.com/v1` |
| Anthropic | anthropic | `https://api.anthropic.com` |
| Google Gemini | gemini | `https://generativelanguage.googleapis.com/v1beta` |
| Azure OpenAI | azure-openai | `https://<resource>.openai.azure.com` |
| DeepSeek | openai | `https://api.deepseek.com/v1` |
| Mistral | openai | `https://api.mistral.ai/v1` |
| Groq | openai | `https://api.groq.com/openai/v1` |
| xAI | openai | `https://api.x.ai/v1` |
| Together, Fireworks, OpenRouter, Perplexity | openai | their `/v1` endpoints |
| Cohere | openai | `https://api.cohere.ai/compatibility/v1` |
| Azure AI Foundry | openai | `https://<resource>.services.ai.azure.com/openai/v1` |
| AWS Bedrock (API key) | openai | `https://bedrock-runtime.<region>.amazonaws.com/openai/v1` |
| Ollama / vLLM / LM Studio (local) | openai | `http://<host>:11434/v1`, `:8000/v1`, `:1234/v1` |
| Custom OpenAI-compatible | openai | anything |
| Custom HTTP (templated) | custom | anything |

Presets OpenAI, Anthropic, Gemini, DeepSeek, Mistral, Groq, xAI and Ollama come with a starter model catalog and default prices. Other presets start empty: use **Discover models** (lists upstream models) and add the ones you want.

## Common settings

- **API key**: encrypted at rest; leave blank on edit to keep the current one.
- **Secret headers**: JSON object of extra headers that must be kept secret (encrypted).
- **Config (JSON)**: non-secret options:
  - `headers`: extra non-secret headers
  - `organization`: OpenAI organization id
  - `streamUsage`: `false` for OpenAI-compatible servers that reject `stream_options` (Relay then estimates streaming usage)
  - `anthropicVersion`, `betas` (Anthropic)
  - `apiVersion`, `v1` (Azure OpenAI)
- **Timeout** (ms) and **max retries** per provider.

## Azure OpenAI

- Base URL: `https://<resource>.openai.azure.com`
- Each Relay model's **upstream model id is the deployment name**.
- `config.apiVersion` defaults to `2024-10-21`. Set `"v1": true` to use the newer `/openai/v1` API, where the upstream id is the model name.

## Local models

Point an `openai` provider at your local server (Ollama `http://ollama:11434/v1`, vLLM, LM Studio, TGI with OpenAI API). Set model prices to `0` or to an internal chargeback rate to track internal cost. No API key is needed.

## Custom HTTP adapter

For in-house or non-OpenAI APIs. In `config.custom`:

```json
{
  "custom": {
    "path": "/generate",
    "method": "POST",
    "headers": { "Authorization": "Bearer {{apiKey}}" },
    "bodyTemplate": {
      "model": "{{model}}",
      "messages": "{{messages}}",
      "max_new_tokens": "{{max_tokens}}",
      "temperature": "{{temperature}}"
    },
    "responseMapping": {
      "content": "output.text",
      "inputTokens": "usage.input_tokens",
      "outputTokens": "usage.output_tokens",
      "finishReason": "stop_reason"
    }
  }
}
```

- A template value that is exactly `"{{var}}"` is replaced with the raw value (array, number, object); otherwise the variable is interpolated as text. Missing values are dropped.
- Variables: `model`, `messages` (OpenAI array), `prompt` (flattened `role: text` lines), `system`, `last_user`, `max_tokens`, `temperature`, `top_p`, `stop`, `tools`, `user`; `apiKey` is available in headers only.
- Paths use dots and brackets: `choices[0].message.content`.
- If token paths are missing, Relay estimates tokens (~4 characters per token) and flags the usage record as estimated.
- Streaming requests are served by calling the API once and replaying the result as SSE.

If your API speaks the OpenAI protocol, prefer the **Custom OpenAI-compatible** preset: you get native streaming and tool calls.

## Adding a new adapter (developers)

Implement `ProviderAdapter` (`src/providers/adapters/base.ts`): `chat`, `chatStream` (yield OpenAI chunks then a final `{usage}`), optionally `embeddings` and `listModels`. Register it in `src/providers/adapters/index.ts` and add a preset in `src/providers/presets.ts`. Throw `ProviderError` with `retryable` set correctly so retries and fallback work.
