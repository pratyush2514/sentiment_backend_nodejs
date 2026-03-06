import { config } from "../config.js";
import {
  CONTEXT_LAYER_SUMMARY_PCT,
  CONTEXT_LAYER_DECISIONS_PCT,
  CONTEXT_LAYER_DOCUMENTS_PCT,
  CONTEXT_LAYER_MESSAGES_PCT,
} from "../constants.js";
import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import { createEmbeddingProvider } from "./embeddingProvider.js";
import { sanitizeForExternalUse } from "./privacyFilter.js";
import { estimateTokens, truncateToTokens } from "./summarizer.js";

const log = logger.child({ module: "contextAssembler" });

export interface AssembledContext {
  runningSummary: string;
  keyDecisions: string[];
  relevantDocuments: string[];
  recentMessages: Array<{ userId: string; text: string; ts: string }>;
  totalTokens: number;
}

/**
 * Assembles context for an LLM analysis call, respecting a configurable token budget.
 *
 * 4-layer assembly with surplus redistribution:
 * - Layer 1 (30%): Running summary from channel_state
 * - Layer 2 (10%): Key decisions from channel_state
 * - Layer 3 (35%): pgvector-matched context_documents
 * - Layer 4 (25%): Recent messages
 *
 * If a layer underflows, its surplus flows to the next layer.
 * If embeddings are unavailable, Layer 3 budget flows entirely to Layer 4.
 */
export async function assembleContext(
  workspaceId: string,
  channelId: string,
  targetText: string,
  recentMessages: Array<{ userId: string; text: string; ts: string }>,
): Promise<AssembledContext> {
  const totalBudget = config.CONTEXT_TOKEN_BUDGET;
  const state = await db.getChannelState(workspaceId, channelId);

  // ─── Layer 1: Running Summary (30%) ─────────────────────────────────────
  const layer1Budget = Math.floor(totalBudget * CONTEXT_LAYER_SUMMARY_PCT);
  const rawSummary = state?.running_summary ?? "";
  const summary = truncateToTokens(rawSummary, layer1Budget);
  const summaryTokens = estimateTokens(summary);
  let surplus = layer1Budget - summaryTokens;

  // ─── Layer 2: Key Decisions (10% + surplus) ─────────────────────────────
  const layer2Budget = Math.floor(totalBudget * CONTEXT_LAYER_DECISIONS_PCT) + surplus;
  const decisions = state?.key_decisions_json ?? [];
  const decisionsText = decisions.map((d) => `- ${d}`).join("\n");
  const truncatedDecisions = truncateToTokens(decisionsText, layer2Budget);
  const decisionsTokens = estimateTokens(truncatedDecisions);
  surplus = layer2Budget - decisionsTokens;

  // Parse back the truncated decisions
  const finalDecisions = truncatedDecisions
    ? truncatedDecisions.split("\n").map((line) => line.replace(/^- /, "")).filter(Boolean)
    : [];

  // ─── Layer 3: pgvector Matches (35% + surplus) ─────────────────────────
  const layer3Budget = Math.floor(totalBudget * CONTEXT_LAYER_DOCUMENTS_PCT) + surplus;
  const relevantDocuments: string[] = [];

  const embeddingProvider = createEmbeddingProvider();
  const sanitizedTarget = sanitizeForExternalUse(targetText);
  const safeTargetText = sanitizedTarget.action === "skipped" ? "" : sanitizedTarget.action === "redacted" ? sanitizedTarget.text : targetText;
  if (embeddingProvider && safeTargetText.trim()) {
    try {
      const embeddingResult = await embeddingProvider.embed(safeTargetText);
      const docs = await db.searchContextDocuments(
        workspaceId,
        channelId,
        embeddingResult.embedding,
        5,
      );

      let usedTokens = 0;
      for (const doc of docs) {
        const docTokens = doc.token_count || estimateTokens(doc.content);
        if (usedTokens + docTokens > layer3Budget) break;
        relevantDocuments.push(doc.content);
        usedTokens += docTokens;
      }
      surplus = layer3Budget - usedTokens;
    } catch (err) {
      log.warn({ err }, "pgvector search failed, skipping Layer 3");
      surplus = layer3Budget; // Full budget flows to Layer 4
    }
  } else {
    // No embedding provider or empty target — full Layer 3 budget to Layer 4
    surplus = layer3Budget;
  }

  // ─── Layer 4: Recent Messages (25% + surplus) ──────────────────────────
  const layer4Budget = Math.floor(totalBudget * CONTEXT_LAYER_MESSAGES_PCT) + surplus;
  const packedMessages: Array<{ userId: string; text: string; ts: string }> = [];
  let msgTokens = 0;

  // Pack messages from most recent (they're already in chronological order)
  // Iterate from newest to oldest, then reverse at the end
  const reversed = [...recentMessages].reverse();
  for (const msg of reversed) {
    const tokenCost = estimateTokens(`[${msg.userId}] ${msg.text}`);
    if (msgTokens + tokenCost > layer4Budget) break;
    packedMessages.unshift(msg);
    msgTokens += tokenCost;
  }

  const totalTokens = summaryTokens + decisionsTokens +
    relevantDocuments.reduce((acc, d) => acc + estimateTokens(d), 0) +
    msgTokens;

  log.debug({
    channelId,
    summaryTokens,
    decisionsTokens,
    docsCount: relevantDocuments.length,
    messagesCount: packedMessages.length,
    totalTokens,
    budget: totalBudget,
  }, "Context assembled");

  return {
    runningSummary: summary,
    keyDecisions: finalDecisions,
    relevantDocuments,
    recentMessages: packedMessages,
    totalTokens,
  };
}
