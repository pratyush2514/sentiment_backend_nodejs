import { config } from "../config.js";
import { logger } from "../utils/logger.js";
import { computeRiskScore } from "./riskHeuristic.js";
import type { ChannelStateRow } from "../types/database.js";

const log = logger.child({ module: "llmGate" });

export type TriggerType = "risk" | "threshold" | "time" | "manual";

/**
 * Evaluates whether an LLM analysis should be triggered.
 * Returns the trigger type if any condition fires, or null to skip.
 *
 * Thread replies are only auto-analyzed when they are genuinely risky.
 * Routine thread motion should be summarized at the thread level instead of
 * paying for per-message LLM analysis.
 *
 * Does NOT handle enqueuing or state reset — caller is responsible for that.
 */
export function evaluateLLMGate(
  normalizedText: string,
  channelState: ChannelStateRow,
  threadTs?: string | null,
): TriggerType | null {
  const isThread = !!threadTs;
  const inCooldown = isInCooldown(channelState);

  // Trigger 1: High risk score (bypass cooldowns and applies to both channel + thread messages)
  const riskScore = computeRiskScore(normalizedText);
  if (riskScore >= config.LLM_RISK_THRESHOLD) {
    log.info(
      { riskScore, threshold: config.LLM_RISK_THRESHOLD, channelId: channelState.channel_id, isThread },
      "LLM gate triggered: risk score",
    );
    return "risk";
  }

  // Threads should usually wait for rollups/turning points instead of getting
  // threshold/time based per-message analysis.
  if (isThread) {
    return null;
  }

  // If we're in a cooldown period, normal thresholds (message count/time) skip
  if (inCooldown) return null;

  // Trigger 2: Message count threshold
  if (channelState.messages_since_last_llm >= config.LLM_MSG_THRESHOLD && !inCooldown) {
    log.info(
      {
        messageCount: channelState.messages_since_last_llm,
        threshold: config.LLM_MSG_THRESHOLD,
        channelId: channelState.channel_id,
        isThread,
      },
      "LLM gate triggered: message threshold",
    );
    return "threshold";
  }

  // Trigger 3: Time since last LLM run
  if (channelState.messages_since_last_llm > 0 && !inCooldown) {
    const lastRun = channelState.last_llm_run_at;
    if (lastRun) {
      const elapsedMin = (Date.now() - new Date(lastRun).getTime()) / 60_000;
      if (elapsedMin >= config.LLM_TIME_THRESHOLD_MIN) {
        log.info(
          {
            elapsedMin: Math.round(elapsedMin),
            threshold: config.LLM_TIME_THRESHOLD_MIN,
            channelId: channelState.channel_id,
            isThread,
          },
          "LLM gate triggered: time threshold",
        );
        return "time";
      }
    }
  }

  return null;
}

function isInCooldown(channelState: ChannelStateRow): boolean {
  if (!channelState.llm_cooldown_until) return false;
  return new Date(channelState.llm_cooldown_until).getTime() > Date.now();
}
