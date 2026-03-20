import { enqueueSummaryRollup } from "../queue/boss.js";
import { logger } from "../utils/logger.js";
import { isTsWithinAnalysisWindow } from "./analysisWindow.js";
import type { SummaryRollupRequestedBy } from "../queue/jobTypes.js";
import type { ThreadInsightRow } from "../types/database.js";

const log = logger.child({ service: "threadInsightRefresh" });

type ActivityTimestamp = string | Date | null | undefined;

export type ThreadInsightRefreshReason =
  | "fresh"
  | "outside_analysis_window"
  | "missing_insight"
  | "missing_source_coverage"
  | "stale_coverage"
  | "deduped"
  | "queued"
  | "enqueue_failed";

export interface ThreadInsightRefreshDecision {
  shouldRefresh: boolean;
  reason: Exclude<ThreadInsightRefreshReason, "deduped" | "queued" | "enqueue_failed">;
  latestActivityTs: string | null;
}

function normalizeActivityTs(
  value: ActivityTimestamp,
): string | null {
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? value : null;
  }

  if (value instanceof Date) {
    return String(value.getTime() / 1000);
  }

  return null;
}

export function decideThreadInsightRefresh(input: {
  insight: Pick<ThreadInsightRow, "source_ts_end"> | null;
  latestActivityTs: ActivityTimestamp;
  analysisWindowDays: number;
}): ThreadInsightRefreshDecision {
  const latestActivityTs = normalizeActivityTs(input.latestActivityTs);

  if (!latestActivityTs) {
    return {
      shouldRefresh: false,
      reason: "fresh",
      latestActivityTs: null,
    };
  }

  if (!isTsWithinAnalysisWindow(latestActivityTs, input.analysisWindowDays)) {
    return {
      shouldRefresh: false,
      reason: "outside_analysis_window",
      latestActivityTs,
    };
  }

  if (!input.insight) {
    return {
      shouldRefresh: true,
      reason: "missing_insight",
      latestActivityTs,
    };
  }

  if (!input.insight.source_ts_end) {
    return {
      shouldRefresh: true,
      reason: "missing_source_coverage",
      latestActivityTs,
    };
  }

  return Number.parseFloat(input.insight.source_ts_end) < Number.parseFloat(latestActivityTs)
    ? {
        shouldRefresh: true,
        reason: "stale_coverage",
        latestActivityTs,
      }
    : {
        shouldRefresh: false,
        reason: "fresh",
        latestActivityTs,
      };
}

export async function requestThreadInsightRefresh(input: {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  insight: Pick<ThreadInsightRow, "source_ts_end"> | null;
  latestActivityTs: ActivityTimestamp;
  analysisWindowDays: number;
  requestedBy: Extract<
    SummaryRollupRequestedBy,
    "state_route" | "messages_route" | "threads_route" | "alerts_route"
  >;
}): Promise<{ requested: boolean; jobId: string | null; reason: ThreadInsightRefreshReason }> {
  const decision = decideThreadInsightRefresh({
    insight: input.insight,
    latestActivityTs: input.latestActivityTs,
    analysisWindowDays: input.analysisWindowDays,
  });

  if (!decision.shouldRefresh) {
    return {
      requested: false,
      jobId: null,
      reason: decision.reason,
    };
  }

  try {
    const jobId = await enqueueSummaryRollup({
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      rollupType: "thread",
      threadTs: input.threadTs,
      requestedBy: input.requestedBy,
    });

    if (jobId) {
      log.debug(
        {
          channelId: input.channelId,
          threadTs: input.threadTs,
          requestedBy: input.requestedBy,
          reason: decision.reason,
          latestActivityTs: decision.latestActivityTs,
          jobId,
        },
        "Thread insight refresh queued",
      );
      return { requested: true, jobId, reason: "queued" };
    }

    log.debug(
      {
        channelId: input.channelId,
        threadTs: input.threadTs,
        requestedBy: input.requestedBy,
        reason: decision.reason,
        latestActivityTs: decision.latestActivityTs,
      },
      "Thread insight refresh deduped",
    );
    return { requested: false, jobId: null, reason: "deduped" };
  } catch (err) {
    log.warn(
      {
        err,
        channelId: input.channelId,
        threadTs: input.threadTs,
        requestedBy: input.requestedBy,
      },
      "Failed to request thread insight refresh",
    );
    return { requested: false, jobId: null, reason: "enqueue_failed" };
  }
}
