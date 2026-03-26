import { z } from "zod/v4";
import { config } from "../config.js";
import * as db from "../db/queries.js";
import { buildChannelClassificationPrompt } from "../prompts/channelClassification.js";
import { logger } from "../utils/logger.js";
import { parseAndValidate } from "./llmHelpers.js";
import { createLLMProvider } from "./llmProviders.js";
import type {
  ChannelClassificationType,
  ChannelClassificationRow,
  ClassificationSource,
} from "../types/database.js";

const log = logger.child({ service: "channelClassifier" });

// ─── Heuristic Classification ────────────────────────────────────────────────

const CLIENT_NAME_PATTERNS = [
  /^client[-_]/i,
  /^ext[-_]/i,
  /^cust[-_]/i,
  /[-_]client$/i,
  /[-_]external$/i,
];

const SUPPORT_NAME_PATTERNS = [
  /support/i,
  /helpdesk/i,
  /tickets?/i,
  /bugs?/i,
  /issues?/i,
];

const ENGINEERING_NAME_PATTERNS = [
  /^eng[-_]/i,
  /^dev[-_]/i,
  /^infra[-_]/i,
  /^backend/i,
  /^frontend/i,
  /^platform/i,
  /^devops/i,
  /[-_]eng$/i,
  /[-_]dev$/i,
  /engineering/i,
  /development/i,
];

const OPERATIONS_NAME_PATTERNS = [
  /^ops[-_]/i,
  /^hr[-_]/i,
  /^finance/i,
  /^marketing/i,
  /^sales/i,
  /^legal/i,
  /^admin/i,
  /operations/i,
];

const SOCIAL_NAMES = new Set([
  "general", "random", "social", "watercooler", "off-topic",
  "offtopic", "fun", "memes", "chitchat", "chit-chat", "lounge",
  "team-fun", "team_fun", "coffee", "introductions", "announcements", "music", "fun-and-games", "fun_and_games",
]);

const AUTOMATION_NAME_PATTERNS = [
  /alert/i,
  /monitor/i,
  /deploy/i,
  /ci[-_]cd/i,
  /notifications?/i,
  /n8n/i,
  /github/i,
  /sentry/i,
  /datadog/i,
  /pagerduty/i,
];

export interface ClassificationResult {
  channelType: ChannelClassificationType;
  confidence: number;
  classificationSource: ClassificationSource;
  clientName: string | null;
  topics: string[];
  reasoning: string;
}

/**
 * Fast heuristic classification. Runs synchronously, no LLM call.
 * Confidence range: 0.3-0.6.
 */
export function classifyChannelHeuristic(
  channelName: string,
  options?: {
    hasClientUsers?: boolean;
    botMessageRatio?: number;
    externalDomains?: string[];
    channelDescription?: string | null;
  },
): ClassificationResult {
  const name = channelName.toLowerCase();
  const hasClients = options?.hasClientUsers ?? false;
  const botRatio = options?.botMessageRatio ?? 0;
  const externalDomains = options?.externalDomains ?? [];
  const desc = options?.channelDescription?.toLowerCase() ?? "";

  // Strongest signal: automation channels (high bot ratio)
  if (botRatio > 0.75 || AUTOMATION_NAME_PATTERNS.some((p) => p.test(name))) {
    return {
      channelType: "automated",
      confidence: botRatio > 0.75 ? 0.6 : 0.45,
      classificationSource: "heuristic",
      clientName: null,
      topics: [],
      reasoning: botRatio > 0.75
        ? `${Math.round(botRatio * 100)}% bot messages`
        : `Channel name matches automation pattern`,
    };
  }

  // Strong signal: explicit client presence or external domains
  if (hasClients || externalDomains.length > 0) {
    const isSupport = SUPPORT_NAME_PATTERNS.some((p) => p.test(name)) || desc.includes("support");
    return {
      channelType: isSupport ? "client_support" : "client_delivery",
      confidence: hasClients ? 0.55 : 0.45,
      classificationSource: "heuristic",
      clientName: null,
      topics: [],
      reasoning: hasClients
        ? "Channel has client role users assigned"
        : `External domain(s) detected: ${externalDomains.slice(0, 3).join(", ")}`,
    };
  }

  // Name pattern matching
  if (CLIENT_NAME_PATTERNS.some((p) => p.test(name))) {
    return {
      channelType: "client_delivery",
      confidence: 0.4,
      classificationSource: "heuristic",
      clientName: null,
      topics: [],
      reasoning: "Channel name matches client pattern",
    };
  }

  if (SUPPORT_NAME_PATTERNS.some((p) => p.test(name))) {
    return {
      channelType: "client_support",
      confidence: 0.4,
      classificationSource: "heuristic",
      clientName: null,
      topics: [],
      reasoning: "Channel name matches support pattern",
    };
  }

  if (SOCIAL_NAMES.has(name)) {
    return {
      channelType: "internal_social",
      confidence: 0.55,
      classificationSource: "heuristic",
      clientName: null,
      topics: [],
      reasoning: "Channel name is a known social/casual channel",
    };
  }

  if (ENGINEERING_NAME_PATTERNS.some((p) => p.test(name))) {
    return {
      channelType: "internal_engineering",
      confidence: 0.45,
      classificationSource: "heuristic",
      clientName: null,
      topics: [],
      reasoning: "Channel name matches engineering pattern",
    };
  }

  if (OPERATIONS_NAME_PATTERNS.some((p) => p.test(name))) {
    return {
      channelType: "internal_operations",
      confidence: 0.4,
      classificationSource: "heuristic",
      clientName: null,
      topics: [],
      reasoning: "Channel name matches operations pattern",
    };
  }

  // Default: unclassified with low confidence
  return {
    channelType: "unclassified",
    confidence: 0.3,
    classificationSource: "heuristic",
    clientName: null,
    topics: [],
    reasoning: "No strong signals from channel name or metadata",
  };
}

// ─── LLM Classification Schema ──────────────────────────────────────────────

const ClassificationOutputSchema = z.object({
  channel_type: z.enum([
    "client_delivery",
    "client_support",
    "internal_engineering",
    "internal_operations",
    "internal_social",
    "automated",
  ]),
  client_name: z.string().nullable(),
  topics: z.array(z.string()).max(10).default([]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(500),
});

/**
 * LLM-powered classification. Async, uses infrastructure budget pool.
 * Confidence range: 0.5-0.95.
 */
export async function classifyChannelLLM(
  workspaceId: string,
  channelId: string,
): Promise<ClassificationResult | null> {
  if (!config.CLASSIFICATION_LLM_ENABLED) return null;

  try {
    // Gather context
    const [channel, channelState, members, recentMessages] = await Promise.all([
      db.getChannel(workspaceId, channelId),
      db.getChannelState(workspaceId, channelId),
      db.getChannelMembers(workspaceId, channelId),
      db.getMessages(workspaceId, channelId, { limit: 40 }),
    ]);

    if (!channel) return null;

    // Get member profiles for domain analysis
    const memberUserIds = members.map((m) => m.user_id);
    const profiles = memberUserIds.length > 0
      ? await db.getUserProfiles(workspaceId, memberUserIds)
      : [];

    const allDomains = new Set<string>();
    const externalDomains: string[] = [];
    for (const p of profiles) {
      if (p.email) {
        const domain = p.email.split("@")[1]?.toLowerCase();
        if (domain) {
          allDomains.add(domain);
          // Simple heuristic: if multiple domains exist, non-majority ones are "external"
        }
      }
    }

    // Find the most common domain (likely the workspace's primary domain)
    const domainCounts = new Map<string, number>();
    for (const p of profiles) {
      if (p.email) {
        const domain = p.email.split("@")[1]?.toLowerCase();
        if (domain) domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
      }
    }
    let primaryDomain = "";
    let maxCount = 0;
    for (const [d, c] of domainCounts) {
      if (c > maxCount) { primaryDomain = d; maxCount = c; }
    }
    for (const d of allDomains) {
      if (d !== primaryDomain && !isGenericDomain(d)) {
        externalDomains.push(d);
      }
    }

    // Count bot messages
    let botCount = 0;
    const messageTexts: string[] = [];
    for (const msg of recentMessages) {
      if (msg.subtype === "bot_message" || msg.bot_id) {
        botCount++;
      }
      const speaker = msg.user_id ?? "Unknown";
      messageTexts.push(`${speaker}: ${(msg.text ?? "").slice(0, 200)}`);
    }
    const botRatio = recentMessages.length > 0 ? botCount / recentMessages.length : 0;

    const { system, user } = buildChannelClassificationPrompt({
      channelName: channel.name ?? channelId,
      channelDescription: null, // ChannelRow doesn't store description; would need Slack API call
      channelTopic: null,
      memberCount: members.length,
      memberDomains: [...allDomains],
      externalDomains,
      recentMessages: messageTexts,
      existingSummary: channelState?.running_summary ?? null,
      botMessageRatio: botRatio,
    });

    const provider = createLLMProvider();
    const rawResult = await provider.chat(system, user, config.LLM_MODEL);

    const parsed = parseAndValidate(rawResult.content, ClassificationOutputSchema);
    if (!parsed.success) {
      log.warn(
        { workspaceId, channelId, error: parsed.error },
        "LLM classification parse failed",
      );
      return null;
    }

    const result = parsed.data;

    return {
      channelType: result.channel_type,
      confidence: Math.min(result.confidence, 0.95), // Cap at 0.95 for LLM
      classificationSource: "llm",
      clientName: result.client_name,
      topics: result.topics,
      reasoning: result.reasoning,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ workspaceId, channelId, err: errMsg }, "LLM channel classification failed");
    return null;
  }
}

/**
 * Full classification orchestrator: heuristic first, LLM upgrade if needed.
 */
export async function classifyChannel(
  workspaceId: string,
  channelId: string,
  options?: { forceLLM?: boolean },
): Promise<ChannelClassificationRow> {
  // Check for existing human override
  const existing = await db.getChannelClassification(workspaceId, channelId);
  if (existing?.classification_source === "human_override") {
    log.debug({ workspaceId, channelId }, "Skipping classification — human override in place");
    return existing;
  }

  // Get channel info for heuristic
  const channel = await db.getChannel(workspaceId, channelId);
  const followUpRule = await db.getFollowUpRule(workspaceId, channelId);

  const heuristic = classifyChannelHeuristic(channel?.name ?? channelId, {
    hasClientUsers: (followUpRule?.client_user_ids ?? []).length > 0,
  });

  // Persist heuristic immediately (fast path)
  const persisted = await db.upsertChannelClassification(workspaceId, channelId, {
    channelType: heuristic.channelType,
    confidence: heuristic.confidence,
    classificationSource: heuristic.classificationSource,
    clientName: heuristic.clientName,
    topicsJson: heuristic.topics,
    reasoning: heuristic.reasoning,
  });

  log.info(
    {
      workspaceId,
      channelId,
      channelName: channel?.name,
      channelType: heuristic.channelType,
      confidence: heuristic.confidence,
      source: "heuristic",
    },
    "Channel classified (heuristic)",
  );

  // If heuristic confidence is low or forceLLM, try LLM upgrade
  if (options?.forceLLM || heuristic.confidence < 0.7) {
    const llmResult = await classifyChannelLLM(workspaceId, channelId);
    if (llmResult && llmResult.confidence > heuristic.confidence) {
      const upgraded = await db.upsertChannelClassification(workspaceId, channelId, {
        channelType: llmResult.channelType,
        confidence: llmResult.confidence,
        classificationSource: llmResult.classificationSource,
        clientName: llmResult.clientName,
        topicsJson: llmResult.topics,
        reasoning: llmResult.reasoning,
      });

      log.info(
        {
          workspaceId,
          channelId,
          channelName: channel?.name,
          channelType: llmResult.channelType,
          confidence: llmResult.confidence,
          previousType: heuristic.channelType,
          previousConfidence: heuristic.confidence,
          source: "llm",
        },
        "Channel classification upgraded via LLM",
      );

      return upgraded;
    }
  }

  return persisted;
}

function isGenericDomain(domain: string): boolean {
  const generic = new Set([
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
    "icloud.com", "protonmail.com", "me.com", "live.com",
  ]);
  return generic.has(domain.toLowerCase());
}
