import { describe, expect, test } from "bun:test";
import { effectiveModelSelection, modelChipLabel, resolveTurnModel } from "../src/chat/models";
import type { ConfiguredModel } from "../src/chat/types";

const model = (provider: ConfiguredModel["provider"], modelId: string, displayName: string): ConfiguredModel => ({
  id: `${provider}:${modelId}`,
  provider,
  modelId,
  displayName,
  apiKeyConfigured: true,
  enabled: true,
  createdAt: "",
  updatedAt: "",
});

const models = [model("openai", "gpt-5", "GPT-5"), model("anthropic", "claude-x", "Claude X"), model("ollama-internal", "qwen", "Qwen local")];

describe("model selection per chat", () => {
  test("the conversation's own selection wins over the global default; model `auto` means auto", () => {
    expect([
      effectiveModelSelection("manual", "gpt-5", "auto"),
      effectiveModelSelection("auto", "gpt-5", "manual"),
      effectiveModelSelection(undefined, undefined, "manual"),
      effectiveModelSelection(undefined, undefined, "auto"),
      effectiveModelSelection("manual", "auto", "manual"),
    ]).toEqual(["manual", "auto", "manual", "auto", "auto"]);
  });

  test("auto sends model `auto` instead of a fallback model; manual sends the pin", () => {
    expect([
      resolveTurnModel({ models, selection: "auto", provider: "openai", model: "auto" }),
      resolveTurnModel({ models, selection: "auto" }),
      resolveTurnModel({ models, selection: "manual", provider: "anthropic", model: "claude-x" }),
      resolveTurnModel({ models, selection: "manual", provider: "ollama-internal", model: "qwen" }),
      resolveTurnModel({ models, selection: "manual", provider: "openai", model: "removed-model" }),
      resolveTurnModel({ models, selection: "auto", forced: { provider: "anthropic", model: "claude-x" } }),
      resolveTurnModel({ models: [], selection: "manual" }),
    ]).toEqual([
      { provider: "openai", model: "auto", modelSelection: "auto" },
      { provider: "openai", model: "auto", modelSelection: "auto" },
      { provider: "anthropic", model: "claude-x", modelSelection: "manual" },
      { provider: "ollama", model: "qwen", modelSelection: "manual" },
      { provider: "openai", model: "gpt-5", modelSelection: "manual" },
      { provider: "anthropic", model: "claude-x", modelSelection: "manual" },
      null,
    ]);
  });

  test("the chip shows Auto, Auto → routed model, or the pinned model", () => {
    expect([
      modelChipLabel({ models, selection: "auto", provider: "openai", model: "auto" }),
      modelChipLabel({ models, selection: "auto", model: "auto", routed: { provider: "anthropic", model: "claude-x" } }),
      modelChipLabel({ models, selection: "auto", routed: { provider: "openai", model: "gpt-unlisted" } }),
      modelChipLabel({ models, selection: "manual", provider: "openai", model: "gpt-5" }),
      modelChipLabel({ models, selection: "manual", provider: "openai", model: "auto" }),
      modelChipLabel({ models: [], selection: "manual" }),
    ]).toEqual(["Auto", "Auto → Claude X", "Auto → gpt-unlisted", "GPT-5", "Auto", "No models configured"]);
  });
});
