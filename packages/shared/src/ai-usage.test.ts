import { describe, expect, it } from "vitest";
import { modelFamilyForModel } from "./ai-usage.js";

describe("modelFamilyForModel", () => {
  it("detects claude ids in any shape", () => {
    expect(modelFamilyForModel("claude-sonnet-4-5-20250929")).toBe("claude");
    expect(modelFamilyForModel("openrouter/anthropic/claude-3.5-sonnet", "openrouter")).toBe("claude");
    expect(modelFamilyForModel("Claude-Opus-4")).toBe("claude");
  });

  it("detects gemini ids", () => {
    expect(modelFamilyForModel("gemini-2.5-pro", "google")).toBe("gemini");
    expect(modelFamilyForModel("google/gemini-flash")).toBe("gemini");
  });

  it("detects openai ids", () => {
    expect(modelFamilyForModel("gpt-5-codex", "openai")).toBe("openai");
    expect(modelFamilyForModel("o3-mini")).toBe("openai");
    expect(modelFamilyForModel("openai/gpt-4.1")).toBe("openai");
  });

  it("detects local models by prefix or provider", () => {
    expect(modelFamilyForModel("ollama/llama3.1")).toBe("local");
    expect(modelFamilyForModel("llama3", "ollama")).toBe("local");
    expect(modelFamilyForModel("qwen2.5-coder", "opencode")).toBe("local");
  });

  it("falls back to the provider when the model id is unknown", () => {
    expect(modelFamilyForModel("unknown", "anthropic")).toBe("claude");
    expect(modelFamilyForModel("unknown", "google")).toBe("gemini");
    expect(modelFamilyForModel("unknown", "openai")).toBe("openai");
    expect(modelFamilyForModel("", "xai")).toBe("other");
    expect(modelFamilyForModel(null, null)).toBe("other");
  });

  it("does not misread a bare 'o' prefix as openai", () => {
    expect(modelFamilyForModel("opus-something", "xai")).toBe("other");
  });
});
