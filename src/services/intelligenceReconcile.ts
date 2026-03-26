import { config } from "../config.js";
import * as db from "../db/queries.js";
import {
  enqueueBackfill,
  enqueueChannelClassify,
  enqueueLLMAnalyzeBatches,
  enqueueSummaryRollup,
} from "../queue/boss.js";
import { logger } from "../utils/logger.js";
import { computeWorkspaceHealth } from "./analyticsEngine.js";
import {
  fetchChannelTruthSnapshots,
  type ChannelTruthSnapshot,
} from "./intelligenceTruth.js";

const log = logger.child({ service: "intelligenceReconcile" });

const RECONCILE_SCOPE_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_COOLDOWN_KEYS = 1000;

let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let lastHealthComputeAt: number | null = null;
const recentScopeRuns = new Map<string, number>();

function pruneCooldowns(): void {
  if (recentScopeRuns.size <= MAX_COOLDOWN_KEYS) {
    return;
  }

  const entries = [...recentScopeRuns.entries()].sort((left, right) => left[1] - right[1]);
  for (const [key] of entries.slice(0, entries.length - MAX_COOLDOWN_KEYS)) {
    recentScopeRuns.delete(key);
  }
}

function isCoolingDown(scopeKey: string): boolean {
  const lastRunAt = recentScopeRuns.get(scopeKey);
  if (!lastRunAt) {
    return false;
  }

  const coolingDown = Date.now() - lastRunAt < RECONCILE_SCOPE_COOLDOWN_MS;
  if (!coolingDown) {
    recentScopeRuns.delete(scopeKey);
  }
  return coolingDown;
}

function rememberScope(scopeKey: string): void {
  recentScopeRuns.set(scopeKey, Date.now());
  pruneCooldowns();
}

function makeChannelScopeKey(workspaceId: string, channelId: string, action: string): string {
  return `${workspaceId}:${channelId}:${action}`;
}

function makeChannelTruthKey(workspaceId: string, channelId: string): string {
  return `${workspaceId}:${channelId}`;
}

function hasPartialSummary(snapshot: ChannelTruthSnapshot): boolean {
  return (
    snapshot.latestSummaryCompleteness === "partial" ||
    snapshot.latestSummaryCompleteness === "stale" ||
    snapshot.summaryArtifact?.completenessStatus === "partial" ||
    snapshot.summaryArtifact?.completenessStatus === "stale"
  );
}

function shouldBackfill(snapshot: ChannelTruthSnapshot, channelStatus: string): boolean {
  return (
    snapshot.ingestReadiness !== "ready" ||
    snapshot.backfillRun?.status === "failed" ||
    (channelStatus !== "ready" && snapshot.latestSummaryCompleteness === null)
  );
}

function shouldRollup(snapshot: ChannelTruthSnapshot): boolean {
  return (
    snapshot.intelligenceReadiness === "partial" ||
    snapshot.intelligenceReadiness === "stale" ||
    hasPartialSummary(snapshot)
  );
}

function groupStaleCandidates(
  candidates: Awaited<ReturnType<typeof db.getStaleAnalysisCandidates>>,
): Map<string, { workspaceId: string; channelId: string; threadTs: string | null; targetMessageTs: string[] }> {
  const grouped = new Map<string, { workspaceId: string; channelId: string; threadTs: string | null; targetMessageTs: string[] }>();

  for (const candidate of candidates) {
    const scopeKey = [
      candidate.workspace_id,
      candidate.channel_id,
      candidate.thread_ts ?? "channel",
    ].join(":");

    const existing = grouped.get(scopeKey);
    if (existing) {
      existing.targetMessageTs.push(candidate.ts);
      continue;
    }

    grouped.set(scopeKey, {
      workspaceId: candidate.workspace_id,
      channelId: candidate.channel_id,
      threadTs: candidate.thread_ts,
      targetMessageTs: [candidate.ts],
    });
  }

  return grouped;
}

async function scheduleMessageReanalysis(): Promise<number> {
  const candidates = await db.getStaleAnalysisCandidates(
    config.QUEUE_STALE_ANALYSIS_MINUTES,
    config.INTELLIGENCE_RECONCILE_SCAN_LIMIT,
  );
  if (candidates.length === 0) {
    return 0;
  }

  const grouped = groupStaleCandidates(candidates);
  let enqueued = 0;

  for (const scope of grouped.values()) {
    const actionKey = makeChannelScopeKey(scope.workspaceId, scope.channelId, `analysis:${scope.threadTs ?? "channel"}`);
    if (isCoolingDown(actionKey)) {
      continue;
    }

    const jobIds = await enqueueLLMAnalyzeBatches({
      workspaceId: scope.workspaceId,
      channelId: scope.channelId,
      triggerType: "time",
      mode: scope.threadTs ? "thread_messages" : "visible_messages",
      threadTs: scope.threadTs,
      targetMessageTs: scope.targetMessageTs,
    });

    if (jobIds.length > 0) {
      enqueued += jobIds.length;
      rememberScope(actionKey);
      log.info(
        {
          workspaceId: scope.workspaceId,
          channelId: scope.channelId,
          threadTs: scope.threadTs,
          jobCount: jobIds.length,
        },
        "Queued intelligence reanalysis for stale messages",
      );
    }
  }

  return enqueued;
}

async function scheduleBackfillRepair(
  channels: Array<{
    workspace_id: string;
    channel_id: string;
    status: string;
  }>,
  truthSnapshots: Map<string, ChannelTruthSnapshot>,
): Promise<number> {
  let enqueued = 0;

  for (const channel of channels) {
    const scopeKey = makeChannelScopeKey(channel.workspace_id, channel.channel_id, "backfill");
    if (isCoolingDown(scopeKey)) {
      continue;
    }

    const snapshot = truthSnapshots.get(makeChannelTruthKey(channel.workspace_id, channel.channel_id));
    if (!snapshot || !shouldBackfill(snapshot, channel.status)) {
      continue;
    }

    const jobId = await enqueueBackfill(
      channel.workspace_id,
      channel.channel_id,
      "intelligence_reconcile",
    );

    if (jobId) {
      enqueued += 1;
      rememberScope(scopeKey);
      log.info(
        {
          workspaceId: channel.workspace_id,
          channelId: channel.channel_id,
          jobId,
          ingestReadiness: snapshot.ingestReadiness,
          backfillStatus: snapshot.backfillRun?.status ?? null,
        },
        "Queued backfill repair from intelligence reconciliation",
      );
    }
  }

  return enqueued;
}

async function scheduleSummaryRepair(
  channels: Awaited<ReturnType<typeof db.getReadyChannels>>,
  truthSnapshots: Map<string, ChannelTruthSnapshot>,
): Promise<number> {
  let enqueued = 0;

  for (const channel of channels) {
    const scopeKey = makeChannelScopeKey(channel.workspace_id, channel.channel_id, "summary");
    if (isCoolingDown(scopeKey)) {
      continue;
    }

    const snapshot = truthSnapshots.get(makeChannelTruthKey(channel.workspace_id, channel.channel_id));
    if (!snapshot || !shouldRollup(snapshot)) {
      continue;
    }

    const jobId = await enqueueSummaryRollup({
      workspaceId: channel.workspace_id,
      channelId: channel.channel_id,
      rollupType: "channel",
      requestedBy: "manual",
    });

    if (jobId) {
      enqueued += 1;
      rememberScope(scopeKey);
      log.info(
        {
          workspaceId: channel.workspace_id,
          channelId: channel.channel_id,
          jobId,
          intelligenceReadiness: snapshot.intelligenceReadiness,
          summaryCompleteness: snapshot.latestSummaryCompleteness,
        },
        "Queued summary repair from intelligence reconciliation",
      );
    }
  }

  return enqueued;
}

export async function runIntelligenceReconcileOnce(): Promise<void> {
  const [recoverableChannels, readyChannels, staleCandidates] = await Promise.all([
    db.getRecoverableChannels(config.QUEUE_STALE_CHANNEL_MINUTES, config.INTELLIGENCE_RECONCILE_SCAN_LIMIT),
    db.getReadyChannels(),
    db.getStaleAnalysisCandidates(
      config.QUEUE_STALE_ANALYSIS_MINUTES,
      config.INTELLIGENCE_RECONCILE_SCAN_LIMIT,
    ),
  ]);
  const readyChannelScan = readyChannels.slice(0, config.INTELLIGENCE_RECONCILE_SCAN_LIMIT);

  const channelGroups = new Map<string, string[]>();
  const addChannel = (workspaceId: string, channelId: string) => {
    const key = workspaceId.trim();
    const bucket = channelGroups.get(key) ?? [];
    bucket.push(channelId);
    channelGroups.set(key, bucket);
  };

  for (const channel of recoverableChannels) {
    addChannel(channel.workspace_id, channel.channel_id);
  }
  for (const channel of readyChannelScan) {
    addChannel(channel.workspace_id, channel.channel_id);
  }
  for (const candidate of staleCandidates) {
    addChannel(candidate.workspace_id, candidate.channel_id);
  }

  if (channelGroups.size === 0 && staleCandidates.length === 0) {
    log.debug("No intelligence repair work detected");
    return;
  }

  const truthSnapshots = new Map<string, ChannelTruthSnapshot>();
  for (const [workspaceId, channelIds] of channelGroups.entries()) {
    const snapshots = await fetchChannelTruthSnapshots(workspaceId, channelIds);
    for (const [channelId, snapshot] of snapshots.entries()) {
      truthSnapshots.set(makeChannelTruthKey(workspaceId, channelId), snapshot);
    }
  }

  const backfillRepairCandidates = [
    ...recoverableChannels,
    ...readyChannelScan,
  ];

  const backfillCount = await scheduleBackfillRepair(backfillRepairCandidates, truthSnapshots);
  const analysisCount = await scheduleMessageReanalysis();
  const summaryCount = await scheduleSummaryRepair(
    readyChannelScan,
    truthSnapshots,
  );

  // Weekly reclassification: re-classify channels whose classification is stale
  // (older than 7 days) and not human-overridden
  let reclassifyCount = 0;
  const RECLASSIFY_STALE_DAYS = 7;
  const staleThreshold = new Date(Date.now() - RECLASSIFY_STALE_DAYS * 24 * 60 * 60 * 1000);

  for (const channel of readyChannelScan) {
    const scopeKey = makeChannelScopeKey(channel.workspace_id, channel.channel_id, "reclassify");
    if (isCoolingDown(scopeKey)) continue;

    try {
      const classification = await db.getChannelClassification(channel.workspace_id, channel.channel_id);

      // Skip human overrides — respect manual decisions
      if (classification?.classification_source === "human_override") continue;

      // Skip recently classified channels
      if (classification?.classified_at && new Date(classification.classified_at) > staleThreshold) continue;

      // Enqueue reclassification
      await enqueueChannelClassify(channel.workspace_id, channel.channel_id, "reconcile");
      reclassifyCount++;
      rememberScope(scopeKey);
    } catch (err) {
      log.debug({ channelId: channel.channel_id, err: err instanceof Error ? err.message : "unknown" }, "Channel reclassification failed (non-fatal)");
    }
  }

  // Periodic health recomputation (every ~6 hours)
  // Uses a simple in-memory timestamp to avoid computing too often
  const HEALTH_RECOMPUTE_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const now = Date.now();
  if (!lastHealthComputeAt || now - lastHealthComputeAt > HEALTH_RECOMPUTE_INTERVAL_MS) {
    try {
      // Get unique workspace IDs from the channels we just scanned
      const workspaceIds = new Set(readyChannelScan.map((c) => c.workspace_id));
      for (const wsId of workspaceIds) {
        await computeWorkspaceHealth(wsId);
      }
      lastHealthComputeAt = now;
      log.info({ workspaceCount: workspaceIds.size }, "Periodic health recomputation complete");
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : "unknown" }, "Health recomputation failed");
    }
  }

  // Recovery: find messages suppressed with "channel_not_ready" where channel is now ready.
  // This catches any messages missed by the backfill completion recovery (race conditions,
  // older backfills before the recovery code was added, etc.)
  let suppressedRecoveryCount = 0;
  try {
    const suppressed = await db.getSuppressedMessagesInReadyChannels(undefined, 200);
    if (suppressed.length > 0) {
      // Group by channel for batch recovery
      const byChannel = new Map<string, { workspaceId: string; timestamps: string[] }>();
      for (const row of suppressed) {
        const existing = byChannel.get(row.channel_id);
        if (existing) {
          existing.timestamps.push(row.message_ts);
        } else {
          byChannel.set(row.channel_id, { workspaceId: row.workspace_id, timestamps: [row.message_ts] });
        }
      }

      for (const [channelId, { workspaceId, timestamps }] of byChannel) {
        const recovered = await db.markSuppressedMessagesRecovered(workspaceId, channelId, timestamps);
        suppressedRecoveryCount += recovered;
      }

      if (suppressedRecoveryCount > 0) {
        log.info(
          { suppressedFound: suppressed.length, recovered: suppressedRecoveryCount },
          "Recovered channel_not_ready suppressed messages during reconciliation",
        );
      }
    }
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : "unknown" },
      "Non-fatal: suppressed message recovery failed during reconciliation",
    );
  }

  if (backfillCount > 0 || analysisCount > 0 || summaryCount > 0 || reclassifyCount > 0 || suppressedRecoveryCount > 0) {
    log.info(
      {
        backfillCount,
        analysisCount,
        summaryCount,
        reclassifyCount,
        suppressedRecoveryCount,
      },
      "Intelligence reconciliation queued repair work",
    );
  }

  // Always prune cooldown map at end of each cycle to prevent unbounded growth
  pruneCooldowns();
}

function scheduleNextTick(): void {
  const intervalMs = config.INTELLIGENCE_RECONCILE_INTERVAL_MS;
  reconcileTimer = setTimeout(() => {
    runIntelligenceReconcileOnce()
      .catch((err) => {
        log.warn({ err }, "Intelligence reconciliation loop iteration failed");
      })
      .finally(() => {
        if (reconcileTimer !== null) {
          scheduleNextTick();
        }
      });
  }, intervalMs);
  reconcileTimer.unref();
}

export function startIntelligenceReconcileLoop(): void {
  if (reconcileTimer) {
    log.warn("Intelligence reconciliation loop already running");
    return;
  }

  log.info(
    { intervalMs: config.INTELLIGENCE_RECONCILE_INTERVAL_MS },
    "Starting intelligence reconciliation loop",
  );
  scheduleNextTick();
}

export function stopIntelligenceReconcileLoop(): void {
  if (!reconcileTimer) {
    return;
  }

  clearTimeout(reconcileTimer);
  reconcileTimer = null;
  log.info("Intelligence reconciliation loop stopped");
}
