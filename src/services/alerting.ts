import { logger } from "../utils/logger.js";
import type { MessageAnalysis, ThreadAnalysis } from "./emotionAnalyzer.js";

const alertLog = logger.child({ module: "alerting", severity: "alert" });

interface AlertContext {
  workspaceId: string;
  channelId: string;
  messageTs?: string;
  threadTs?: string;
}

/**
 * Checks analysis results against alert thresholds and emits structured log events.
 * MVP: alerts are structured pino log entries; future phases can add Slack/webhook delivery.
 */
export function checkAndAlert(
  analysis: MessageAnalysis | ThreadAnalysis,
  context: AlertContext,
): void {
  // Alert 1: High escalation risk
  if (analysis.escalation_risk === "high") {
    alertLog.warn(
      {
        alertType: "high_escalation_risk",
        ...context,
        emotion: analysis.dominant_emotion,
        confidence: analysis.confidence,
        explanation: analysis.explanation,
      },
      "High escalation risk detected",
    );
  }

  // Alert 2: High-confidence anger
  if (analysis.dominant_emotion === "anger" && analysis.confidence > 0.85) {
    alertLog.warn(
      {
        alertType: "high_confidence_anger",
        ...context,
        confidence: analysis.confidence,
        explanation: analysis.explanation,
      },
      "High-confidence anger detected",
    );
  }

  // Alert 3: Sarcasm masking anger — surface tone hides real frustration
  if (
    analysis.sarcasm_detected &&
    analysis.intended_emotion === "anger" &&
    analysis.confidence > 0.8
  ) {
    alertLog.warn(
      {
        alertType: "sarcasm_masked_anger",
        ...context,
        surfaceEmotion: analysis.dominant_emotion,
        intendedEmotion: analysis.intended_emotion,
        confidence: analysis.confidence,
        explanation: analysis.explanation,
      },
      "Sarcasm detected masking anger — escalation risk may be underestimated by surface tone",
    );
  }

  // Alert 4: Deteriorating thread sentiment (thread analysis only)
  if ("sentiment_trajectory" in analysis && analysis.sentiment_trajectory === "deteriorating") {
    alertLog.warn(
      {
        alertType: "deteriorating_sentiment",
        ...context,
        threadSentiment: analysis.thread_sentiment,
        summary: analysis.summary,
      },
      "Deteriorating thread sentiment detected",
    );
  }
}

/**
 * Emits a budget exceeded alert.
 */
export function alertBudgetExceeded(
  workspaceId: string,
  dailyCost: number,
  budget: number,
): void {
  alertLog.warn(
    {
      alertType: "budget_exceeded",
      workspaceId,
      dailyCostUsd: dailyCost,
      budgetUsd: budget,
    },
    "Daily LLM budget exceeded, skipping analysis",
  );
}
