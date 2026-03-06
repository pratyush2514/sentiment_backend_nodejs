import OpenAI from "openai";
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

const log = logger.child({ module: "embeddingProvider" });

export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
  model: string;
}

export interface EmbeddingProvider {
  readonly name: string;
  embed(text: string): Promise<EmbeddingResult>;
  embedBatch(texts: string[]): Promise<EmbeddingResult[]>;
}

// ─── OpenAI Embedding Provider ──────────────────────────────────────────────

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai-embedding";
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.client = new OpenAI({ apiKey });
    this.model = model;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
    });

    const data = response.data[0];
    return {
      embedding: data.embedding,
      tokenCount: response.usage.prompt_tokens,
      model: response.model,
    };
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (texts.length === 0) return [];

    // OpenAI supports batch embedding natively (up to 2048 inputs)
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });

    const tokensPerItem = Math.ceil(response.usage.prompt_tokens / texts.length);

    return response.data.map((d) => ({
      embedding: d.embedding,
      tokenCount: tokensPerItem,
      model: response.model,
    }));
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

let cachedProvider: EmbeddingProvider | null = null;
let warned = false;

/**
 * Creates an embedding provider. Returns null if OPENAI_API_KEY is not set.
 * Embeddings always use OpenAI (text-embedding-3-small) regardless of LLM_PROVIDER
 * to maintain uniform 1536-dim vectors in pgvector.
 */
export function createEmbeddingProvider(): EmbeddingProvider | null {
  if (cachedProvider) return cachedProvider;

  if (!config.OPENAI_API_KEY) {
    if (!warned) {
      log.warn("OPENAI_API_KEY not set — embeddings disabled. Context retrieval will use summary + recent messages only.");
      warned = true;
    }
    return null;
  }

  cachedProvider = new OpenAIEmbeddingProvider(
    config.OPENAI_API_KEY,
    config.EMBEDDING_MODEL,
  );

  log.info({ model: config.EMBEDDING_MODEL }, "Embedding provider initialized");
  return cachedProvider;
}

/** Reset cached provider (for testing) */
export function resetEmbeddingProvider(): void {
  cachedProvider = null;
  warned = false;
}
