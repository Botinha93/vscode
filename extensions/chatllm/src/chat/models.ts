import type { Provider } from "./types";

export interface ModelDescriptor {
  id: string;
  name: string;
  family: string;
  detail?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  imageInput?: boolean;
}

const KNOWN_MODELS: Record<Provider, ModelDescriptor[]> = {
  openai: [
    { id: "gpt-4o",           name: "GPT-4o",            family: "gpt-4o",      detail: "OpenAI", maxInputTokens: 128_000, maxOutputTokens: 16_384, toolCalling: true,  imageInput: true  },
    { id: "gpt-4o-mini",      name: "GPT-4o mini",       family: "gpt-4o-mini", detail: "OpenAI", maxInputTokens: 128_000, maxOutputTokens: 16_384, toolCalling: true,  imageInput: true  },
    { id: "gpt-4-turbo",      name: "GPT-4 Turbo",       family: "gpt-4",       detail: "OpenAI", maxInputTokens: 128_000, maxOutputTokens:  4_096, toolCalling: true,  imageInput: true  },
    { id: "gpt-4.1",          name: "GPT-4.1",           family: "gpt-4.1",     detail: "OpenAI", maxInputTokens: 1_000_000, maxOutputTokens: 32_768, toolCalling: true, imageInput: true },
    { id: "gpt-4.1-mini",     name: "GPT-4.1 mini",      family: "gpt-4.1",     detail: "OpenAI", maxInputTokens: 1_000_000, maxOutputTokens: 32_768, toolCalling: true, imageInput: true },
    { id: "o1",               name: "o1",                family: "o1",          detail: "OpenAI reasoning", maxInputTokens: 200_000, maxOutputTokens: 100_000, toolCalling: false },
    { id: "o1-mini",          name: "o1 mini",           family: "o1",          detail: "OpenAI reasoning", maxInputTokens: 128_000, maxOutputTokens:  65_536, toolCalling: false },
    { id: "o3",               name: "o3",                family: "o3",          detail: "OpenAI reasoning", maxInputTokens: 200_000, maxOutputTokens: 100_000, toolCalling: true  },
    { id: "o3-mini",          name: "o3 mini",           family: "o3",          detail: "OpenAI reasoning", maxInputTokens: 200_000, maxOutputTokens: 100_000, toolCalling: true  },
  ],
  openrouter: [
    { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet",    family: "claude-3.5", detail: "OpenRouter \u00b7 Anthropic", maxInputTokens: 200_000, maxOutputTokens: 8_192, toolCalling: true, imageInput: true },
    { id: "anthropic/claude-3.5-haiku",  name: "Claude 3.5 Haiku",     family: "claude-3.5", detail: "OpenRouter \u00b7 Anthropic", maxInputTokens: 200_000, maxOutputTokens: 8_192, toolCalling: true, imageInput: true },
    { id: "anthropic/claude-3-opus",     name: "Claude 3 Opus",        family: "claude-3",   detail: "OpenRouter \u00b7 Anthropic", maxInputTokens: 200_000, maxOutputTokens: 4_096, toolCalling: true, imageInput: true },
    { id: "openai/gpt-4o",               name: "GPT-4o",               family: "gpt-4o",     detail: "OpenRouter \u00b7 OpenAI",    maxInputTokens: 128_000, maxOutputTokens: 16_384, toolCalling: true, imageInput: true },
    { id: "openai/gpt-4o-mini",          name: "GPT-4o mini",          family: "gpt-4o-mini",detail: "OpenRouter \u00b7 OpenAI",    maxInputTokens: 128_000, maxOutputTokens: 16_384, toolCalling: true, imageInput: true },
    { id: "meta-llama/llama-3.1-405b-instruct", name: "Llama 3.1 405B", family: "llama-3.1", detail: "OpenRouter \u00b7 Meta",      maxInputTokens: 131_072, maxOutputTokens: 4_096,  toolCalling: true },
    { id: "meta-llama/llama-3.1-70b-instruct",  name: "Llama 3.1 70B",  family: "llama-3.1", detail: "OpenRouter \u00b7 Meta",      maxInputTokens: 131_072, maxOutputTokens: 4_096,  toolCalling: true },
    { id: "mistralai/mistral-large",     name: "Mistral Large",        family: "mistral",    detail: "OpenRouter \u00b7 Mistral",   maxInputTokens: 128_000, maxOutputTokens: 4_096,  toolCalling: true },
    { id: "deepseek/deepseek-chat",      name: "DeepSeek Chat",        family: "deepseek",   detail: "OpenRouter \u00b7 DeepSeek",  maxInputTokens: 64_000,  maxOutputTokens: 8_192,  toolCalling: true },
    { id: "qwen/qwen-2.5-72b-instruct",  name: "Qwen 2.5 72B",         family: "qwen",       detail: "OpenRouter \u00b7 Alibaba",   maxInputTokens: 32_000,  maxOutputTokens: 4_096,  toolCalling: true },
  ],
  google: [
    { id: "gemini-2.0-flash-exp",  name: "Gemini 2.0 Flash (exp)", family: "gemini-2.0", detail: "Google", maxInputTokens: 1_048_576, maxOutputTokens: 8_192, toolCalling: true, imageInput: true },
    { id: "gemini-1.5-pro",        name: "Gemini 1.5 Pro",         family: "gemini-1.5", detail: "Google", maxInputTokens: 2_097_152, maxOutputTokens: 8_192, toolCalling: true, imageInput: true },
    { id: "gemini-1.5-flash",      name: "Gemini 1.5 Flash",       family: "gemini-1.5", detail: "Google", maxInputTokens: 1_048_576, maxOutputTokens: 8_192, toolCalling: true, imageInput: true },
    { id: "gemini-1.5-flash-8b",   name: "Gemini 1.5 Flash 8B",    family: "gemini-1.5", detail: "Google", maxInputTokens: 1_048_576, maxOutputTokens: 8_192, toolCalling: true, imageInput: true },
  ],
  ollama: [],
  llamacpp: [],
  lmstudio: [],
  custom: [],
};

export function listKnownModels(provider: Provider): ModelDescriptor[] {
  return KNOWN_MODELS[provider] ?? [];
}

export function findKnownModel(provider: Provider, modelId: string): ModelDescriptor | undefined {
  return KNOWN_MODELS[provider]?.find(m => m.id === modelId);
}

export function describeModel(provider: Provider, modelId: string): ModelDescriptor {
  return (
    findKnownModel(provider, modelId) ?? {
      id: modelId,
      name: modelId,
      family: modelId,
      detail: provider,
      maxInputTokens: 32_000,
      maxOutputTokens: 4_096,
      toolCalling: true,
    }
  );
}

export const ALL_PROVIDERS: Provider[] = ["openai", "openrouter", "google", "ollama", "llamacpp", "lmstudio", "custom"];
