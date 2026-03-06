import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import { config } from "../config.js";
import { LLM_TEMPERATURE, LLM_MAX_TOKENS } from "../constants.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ module: "llmProviders" });

export interface LLMRawResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

export interface LLMProvider {
  readonly name: "openai" | "gemini";
  chat(
    systemPrompt: string,
    userPrompt: string,
    model: string,
  ): Promise<LLMRawResult>;
}

// ─── OpenAI Provider ─────────────────────────────────────────────────────────

class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  private client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async chat(
    systemPrompt: string,
    userPrompt: string,
    model: string,
  ): Promise<LLMRawResult> {
    const response = await this.client.chat.completions.create({
      model,
      temperature: LLM_TEMPERATURE,
      max_tokens: LLM_MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const choice = response.choices[0];
    if (!choice?.message?.content) {
      throw new Error("OpenAI returned empty response");
    }

    return {
      content: choice.message.content,
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      model: response.model,
    };
  }
}

// ─── Gemini Provider ─────────────────────────────────────────────────────────

class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  private client: GoogleGenerativeAI;

  constructor(apiKey: string) {
    this.client = new GoogleGenerativeAI(apiKey);
  }

  async chat(
    systemPrompt: string,
    userPrompt: string,
    model: string,
  ): Promise<LLMRawResult> {
    const genModel = this.client.getGenerativeModel({
      model,
      generationConfig: {
        temperature: LLM_TEMPERATURE,
        maxOutputTokens: LLM_MAX_TOKENS,
        responseMimeType: "application/json",
      },
      systemInstruction: systemPrompt,
    });

    const result = await genModel.generateContent(userPrompt);
    const response = result.response;
    const text = response.text();

    if (!text) {
      throw new Error("Gemini returned empty response");
    }

    const usage = response.usageMetadata;

    return {
      content: text,
      promptTokens: usage?.promptTokenCount ?? 0,
      completionTokens: usage?.candidatesTokenCount ?? 0,
      model,
    };
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

let cachedProvider: LLMProvider | null = null;

export function createLLMProvider(): LLMProvider {
  if (cachedProvider) return cachedProvider;

  if (config.LLM_PROVIDER === "gemini") {
    if (!config.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is required when LLM_PROVIDER=gemini");
    }
    cachedProvider = new GeminiProvider(config.GEMINI_API_KEY);
  } else {
    if (!config.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when LLM_PROVIDER=openai");
    }
    cachedProvider = new OpenAIProvider(config.OPENAI_API_KEY);
  }

  log.info({ provider: config.LLM_PROVIDER, model: config.LLM_MODEL }, "LLM provider initialized");
  return cachedProvider;
}

/** Reset cached provider (for testing) */
export function resetProvider(): void {
  cachedProvider = null;
}
