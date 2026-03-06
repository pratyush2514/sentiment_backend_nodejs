import { pool } from "./pool.js";
import type {
  AnalysisStatus,
  ChannelRow,
  ChannelStatus,
  ContextDocType,
  ContextDocumentRow,
  DominantEmotion,
  EscalationRisk,
  MessageRow,
  MessageAnalyticsRow,
  ChannelStateRow,
  UserProfileRow,
  EnrichedMessageRow,
} from "../types/database.js";

// ─── Event deduplication ────────────────────────────────────────────────────

/** Returns true if the event was newly inserted (first-time seen). */
export async function markEventSeen(
  workspaceId: string,
  eventId: string,
  eventType: string,
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO slack_events (workspace_id, event_id, event_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, event_id) DO NOTHING
     RETURNING id`,
    [workspaceId, eventId, eventType],
  );
  return result.rowCount !== null && result.rowCount > 0;
}

// ─── Channels ───────────────────────────────────────────────────────────────

export async function upsertChannel(
  workspaceId: string,
  channelId: string,
  status: ChannelStatus = "pending",
): Promise<ChannelRow> {
  const result = await pool.query<ChannelRow>(
    `INSERT INTO channels (workspace_id, channel_id, status)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, channel_id) DO UPDATE
       SET updated_at = NOW()
     RETURNING *`,
    [workspaceId, channelId, status],
  );
  return result.rows[0];
}

export async function updateChannelStatus(
  workspaceId: string,
  channelId: string,
  status: ChannelStatus,
  _error?: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE channels
     SET status = $3,
         initialized_at = CASE WHEN $3 = 'ready' THEN NOW() ELSE initialized_at END,
         updated_at = NOW()
     WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId, status],
  );
}

export async function getChannel(
  workspaceId: string,
  channelId: string,
): Promise<ChannelRow | null> {
  const result = await pool.query<ChannelRow>(
    `SELECT * FROM channels WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId],
  );
  return result.rows[0] ?? null;
}

export async function updateChannelLastEvent(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  await pool.query(
    `UPDATE channels SET last_event_at = NOW(), updated_at = NOW()
     WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId],
  );
}

export async function getStuckInitializingChannels(): Promise<ChannelRow[]> {
  const result = await pool.query<ChannelRow>(
    `SELECT * FROM channels WHERE status = 'initializing'`,
  );
  return result.rows;
}

// ─── Messages ───────────────────────────────────────────────────────────────

export async function upsertMessage(
  workspaceId: string,
  channelId: string,
  ts: string,
  userId: string,
  text: string,
  source: "realtime" | "backfill",
  threadTs?: string | null,
  subtype?: string | null,
  botId?: string | null,
): Promise<MessageRow> {
  const result = await pool.query<MessageRow>(
    `INSERT INTO messages (workspace_id, channel_id, ts, user_id, text, source, thread_ts, subtype, bot_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (workspace_id, channel_id, ts) DO UPDATE
       SET text = COALESCE(NULLIF(messages.text, ''), EXCLUDED.text),
           thread_ts = COALESCE(messages.thread_ts, EXCLUDED.thread_ts),
           source = CASE WHEN messages.source = 'realtime' THEN 'realtime' ELSE EXCLUDED.source END,
           updated_at = NOW()
     RETURNING *`,
    [workspaceId, channelId, ts, userId, text, source, threadTs ?? null, subtype ?? null, botId ?? null],
  );
  return result.rows[0];
}

export async function getMessages(
  workspaceId: string,
  channelId: string,
  options: { limit?: number; threadTs?: string | null } = {},
): Promise<MessageRow[]> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));

  if (options.threadTs) {
    const result = await pool.query<MessageRow>(
      `SELECT * FROM messages
       WHERE workspace_id = $1 AND channel_id = $2 AND thread_ts = $3
       ORDER BY ts ASC
       LIMIT $4`,
      [workspaceId, channelId, options.threadTs, limit],
    );
    return result.rows;
  }

  const result = await pool.query<MessageRow>(
    `SELECT * FROM messages
     WHERE workspace_id = $1 AND channel_id = $2
     ORDER BY ts DESC
     LIMIT $3`,
    [workspaceId, channelId, limit],
  );
  return result.rows.reverse();
}

export async function getMessageCount(
  workspaceId: string,
  channelId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM messages WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId],
  );
  return parseInt(result.rows[0].count, 10);
}

// ─── Thread edges ───────────────────────────────────────────────────────────

export async function upsertThreadEdge(
  workspaceId: string,
  channelId: string,
  threadTs: string,
  childTs: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO thread_edges (workspace_id, channel_id, thread_ts, child_ts)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, channel_id, thread_ts, child_ts) DO NOTHING`,
    [workspaceId, channelId, threadTs, childTs],
  );
}

export async function getThreads(
  workspaceId: string,
  channelId: string,
  limit = 20,
): Promise<Array<{ thread_ts: string; reply_count: number; last_activity: string }>> {
  const result = await pool.query<{
    thread_ts: string;
    reply_count: string;
    last_activity: string;
  }>(
    `SELECT thread_ts,
            COUNT(*) AS reply_count,
            MAX(child_ts) AS last_activity
     FROM thread_edges
     WHERE workspace_id = $1 AND channel_id = $2
     GROUP BY thread_ts
     ORDER BY MAX(child_ts) DESC
     LIMIT $3`,
    [workspaceId, channelId, limit],
  );
  return result.rows.map((r) => ({
    thread_ts: r.thread_ts,
    reply_count: parseInt(r.reply_count, 10),
    last_activity: r.last_activity,
  }));
}

// ─── User profiles ──────────────────────────────────────────────────────────

export async function upsertUserProfile(
  workspaceId: string,
  userId: string,
  displayName: string | null,
  realName: string | null,
  profileImage: string | null,
): Promise<UserProfileRow> {
  const result = await pool.query<UserProfileRow>(
    `INSERT INTO user_profiles (workspace_id, user_id, display_name, real_name, profile_image, fetched_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (workspace_id, user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           real_name = EXCLUDED.real_name,
           profile_image = EXCLUDED.profile_image,
           fetched_at = NOW()
     RETURNING *`,
    [workspaceId, userId, displayName, realName, profileImage],
  );
  return result.rows[0];
}

export async function getUserProfile(
  workspaceId: string,
  userId: string,
): Promise<UserProfileRow | null> {
  const result = await pool.query<UserProfileRow>(
    `SELECT * FROM user_profiles
     WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  return result.rows[0] ?? null;
}

export async function getUserProfiles(
  workspaceId: string,
  userIds: string[],
): Promise<UserProfileRow[]> {
  if (userIds.length === 0) return [];
  const result = await pool.query<UserProfileRow>(
    `SELECT * FROM user_profiles
     WHERE workspace_id = $1 AND user_id = ANY($2)`,
    [workspaceId, userIds],
  );
  return result.rows;
}

// ─── Enriched messages ──────────────────────────────────────────────────────

export async function getMessagesEnriched(
  workspaceId: string,
  channelId: string,
  options: { limit?: number; threadTs?: string | null } = {},
): Promise<EnrichedMessageRow[]> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));

  if (options.threadTs) {
    const result = await pool.query<EnrichedMessageRow>(
      `SELECT m.*, up.display_name, up.real_name
       FROM messages m
       LEFT JOIN user_profiles up
         ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id
       WHERE m.workspace_id = $1 AND m.channel_id = $2 AND m.thread_ts = $3
       ORDER BY m.ts ASC
       LIMIT $4`,
      [workspaceId, channelId, options.threadTs, limit],
    );
    return result.rows;
  }

  const result = await pool.query<EnrichedMessageRow>(
    `SELECT m.*, up.display_name, up.real_name
     FROM messages m
     LEFT JOIN user_profiles up
       ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id
     WHERE m.workspace_id = $1 AND m.channel_id = $2
     ORDER BY m.ts DESC
     LIMIT $3`,
    [workspaceId, channelId, limit],
  );
  return result.rows.reverse();
}

/** Top-level channel messages (not thread replies) with reply count */
export async function getTopLevelMessagesEnriched(
  workspaceId: string,
  channelId: string,
  limit: number = 50,
): Promise<(EnrichedMessageRow & { reply_count: number })[]> {
  const safeLimit = Math.max(1, Math.min(200, limit));
  const result = await pool.query<EnrichedMessageRow & { reply_count: string }>(
    `SELECT m.*, up.display_name, up.real_name,
            COALESCE(tc.cnt, 0) AS reply_count
     FROM messages m
     LEFT JOIN user_profiles up
       ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id
     LEFT JOIN (
       SELECT thread_ts, COUNT(*) AS cnt
       FROM thread_edges
       WHERE workspace_id = $1 AND channel_id = $2
       GROUP BY thread_ts
     ) tc ON tc.thread_ts = m.ts
     WHERE m.workspace_id = $1
       AND m.channel_id = $2
       AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
     ORDER BY m.ts DESC
     LIMIT $3`,
    [workspaceId, channelId, safeLimit],
  );
  return result.rows
    .map((r) => ({ ...r, reply_count: parseInt(String(r.reply_count), 10) }))
    .reverse();
}

/** Thread replies for a specific thread root (excluding root itself) */
export async function getThreadRepliesEnriched(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<EnrichedMessageRow[]> {
  const result = await pool.query<EnrichedMessageRow>(
    `SELECT m.*, up.display_name, up.real_name
     FROM messages m
     LEFT JOIN user_profiles up
       ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id
     WHERE m.workspace_id = $1
       AND m.channel_id = $2
       AND m.thread_ts = $3
       AND m.ts != $3
     ORDER BY m.ts ASC`,
    [workspaceId, channelId, threadTs],
  );
  return result.rows;
}

// ─── Active threads (for reconciliation) ────────────────────────────────────

export async function getActiveThreads(
  workspaceId: string,
  channelId: string,
  hoursBack: number = 24,
): Promise<Array<{ thread_ts: string; reply_count: number; last_activity: string }>> {
  const result = await pool.query<{
    thread_ts: string;
    reply_count: string;
    last_activity: string;
  }>(
    `SELECT m.thread_ts,
            COUNT(*) AS reply_count,
            MAX(m.ts) AS last_activity
     FROM messages m
     WHERE m.workspace_id = $1
       AND m.channel_id = $2
       AND m.thread_ts IS NOT NULL
       AND m.created_at > NOW() - MAKE_INTERVAL(hours => $3)
     GROUP BY m.thread_ts
     ORDER BY MAX(m.ts) DESC`,
    [workspaceId, channelId, hoursBack],
  );
  return result.rows.map((r) => ({
    thread_ts: r.thread_ts,
    reply_count: parseInt(r.reply_count, 10),
    last_activity: r.last_activity,
  }));
}

export async function getDistinctUserIds(
  workspaceId: string,
  channelId: string,
): Promise<string[]> {
  const result = await pool.query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM messages
     WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId],
  );
  return result.rows.map((r) => r.user_id);
}

export async function getReadyChannels(): Promise<ChannelRow[]> {
  const result = await pool.query<ChannelRow>(
    `SELECT * FROM channels WHERE status = 'ready'`,
  );
  return result.rows;
}

export async function updateLastReconcileAt(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  await pool.query(
    `UPDATE channel_state
     SET last_reconcile_at = NOW(), updated_at = NOW()
     WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId],
  );
}

// ─── Channel state ──────────────────────────────────────────────────────────

export async function upsertChannelState(
  workspaceId: string,
  channelId: string,
  updates: Partial<
    Pick<
      ChannelStateRow,
      | "running_summary"
      | "participants_json"
      | "active_threads_json"
      | "key_decisions_json"
      | "sentiment_snapshot_json"
      | "messages_since_last_llm"
    >
  >,
): Promise<void> {
  await pool.query(
    `INSERT INTO channel_state (workspace_id, channel_id,
       running_summary, participants_json, active_threads_json,
       key_decisions_json, sentiment_snapshot_json, messages_since_last_llm)
     VALUES ($1, $2, COALESCE($3, ''), COALESCE($4::jsonb, '{}'), COALESCE($5::jsonb, '[]'),
             COALESCE($6::jsonb, '[]'), COALESCE($7::jsonb, '{}'), COALESCE($8, 0))
     ON CONFLICT (workspace_id, channel_id) DO UPDATE
       SET running_summary = COALESCE($3, channel_state.running_summary),
           participants_json = COALESCE($4::jsonb, channel_state.participants_json),
           active_threads_json = COALESCE($5::jsonb, channel_state.active_threads_json),
           key_decisions_json = COALESCE($6::jsonb, channel_state.key_decisions_json),
           sentiment_snapshot_json = COALESCE($7::jsonb, channel_state.sentiment_snapshot_json),
           messages_since_last_llm = COALESCE($8, channel_state.messages_since_last_llm),
           updated_at = NOW()`,
    [
      workspaceId,
      channelId,
      updates.running_summary !== undefined ? updates.running_summary : null,
      updates.participants_json !== undefined ? JSON.stringify(updates.participants_json) : null,
      updates.active_threads_json !== undefined ? JSON.stringify(updates.active_threads_json) : null,
      updates.key_decisions_json !== undefined ? JSON.stringify(updates.key_decisions_json) : null,
      updates.sentiment_snapshot_json !== undefined ? JSON.stringify(updates.sentiment_snapshot_json) : null,
      updates.messages_since_last_llm !== undefined ? updates.messages_since_last_llm : null,
    ],
  );
}

export async function getChannelState(
  workspaceId: string,
  channelId: string,
): Promise<ChannelStateRow | null> {
  const result = await pool.query<ChannelStateRow>(
    `SELECT * FROM channel_state WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId],
  );
  return result.rows[0] ?? null;
}

export async function incrementMessagesSinceLLM(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  await pool.query(
    `UPDATE channel_state
     SET messages_since_last_llm = messages_since_last_llm + 1,
         updated_at = NOW()
     WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId],
  );
}

// ─── LLM Analysis ──────────────────────────────────────────────────────────

export async function updateNormalizedText(
  workspaceId: string,
  channelId: string,
  ts: string,
  normalizedText: string,
): Promise<void> {
  await pool.query(
    `UPDATE messages
     SET normalized_text = $4, updated_at = NOW()
     WHERE workspace_id = $1 AND channel_id = $2 AND ts = $3`,
    [workspaceId, channelId, ts, normalizedText],
  );
}

export async function updateMessageAnalysisStatus(
  workspaceId: string,
  channelId: string,
  ts: string,
  status: AnalysisStatus,
): Promise<void> {
  await pool.query(
    `UPDATE messages
     SET analysis_status = $4, updated_at = NOW()
     WHERE workspace_id = $1 AND channel_id = $2 AND ts = $3`,
    [workspaceId, channelId, ts, status],
  );
}

export async function insertMessageAnalytics(row: {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  dominantEmotion: DominantEmotion;
  confidence: number;
  escalationRisk: EscalationRisk;
  themes: string[];
  decisionSignal: boolean;
  explanation: string | null;
  rawLlmResponse: Record<string, unknown>;
  llmProvider: string;
  llmModel: string;
  tokenUsage: Record<string, unknown> | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO message_analytics
       (workspace_id, channel_id, message_ts, dominant_emotion, confidence,
        escalation_risk, themes, decision_signal, explanation,
        raw_llm_response, llm_provider, llm_model, token_usage)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (workspace_id, channel_id, message_ts) DO UPDATE
       SET dominant_emotion = EXCLUDED.dominant_emotion,
           confidence = EXCLUDED.confidence,
           escalation_risk = EXCLUDED.escalation_risk,
           themes = EXCLUDED.themes,
           decision_signal = EXCLUDED.decision_signal,
           explanation = EXCLUDED.explanation,
           raw_llm_response = EXCLUDED.raw_llm_response,
           llm_provider = EXCLUDED.llm_provider,
           llm_model = EXCLUDED.llm_model,
           token_usage = EXCLUDED.token_usage`,
    [
      row.workspaceId,
      row.channelId,
      row.messageTs,
      row.dominantEmotion,
      row.confidence,
      row.escalationRisk,
      JSON.stringify(row.themes),
      row.decisionSignal,
      row.explanation,
      JSON.stringify(row.rawLlmResponse),
      row.llmProvider,
      row.llmModel,
      row.tokenUsage ? JSON.stringify(row.tokenUsage) : null,
    ],
  );
}

export async function resetLLMGatingState(
  workspaceId: string,
  channelId: string,
  cooldownSec: number,
): Promise<void> {
  await pool.query(
    `UPDATE channel_state
     SET messages_since_last_llm = 0,
         last_llm_run_at = NOW(),
         llm_cooldown_until = NOW() + MAKE_INTERVAL(secs => $3),
         updated_at = NOW()
     WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId, cooldownSec],
  );
}

export async function insertLLMCost(row: {
  workspaceId: string;
  channelId: string | null;
  llmProvider: string;
  llmModel: string;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  jobType: string | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO llm_costs
       (workspace_id, channel_id, llm_provider, llm_model,
        prompt_tokens, completion_tokens, estimated_cost_usd, job_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.workspaceId,
      row.channelId,
      row.llmProvider,
      row.llmModel,
      row.promptTokens,
      row.completionTokens,
      row.estimatedCostUsd,
      row.jobType,
    ],
  );
}

export interface AnalyticsQueryOptions {
  limit?: number;
  threadTs?: string | null;
  emotion?: string | null;
  risk?: string | null;
}

export interface EnrichedAnalyticsRow extends MessageAnalyticsRow {
  display_name: string | null;
  real_name: string | null;
  message_text: string | null;
  thread_ts: string | null;
}

export async function getMessageAnalytics(
  workspaceId: string,
  channelId: string,
  options: AnalyticsQueryOptions = {},
): Promise<EnrichedAnalyticsRow[]> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const conditions: string[] = [
    "ma.workspace_id = $1",
    "ma.channel_id = $2",
  ];
  const params: unknown[] = [workspaceId, channelId];
  let paramIndex = 3;

  if (options.threadTs) {
    conditions.push(`m.thread_ts = $${paramIndex}`);
    params.push(options.threadTs);
    paramIndex++;
  }

  if (options.emotion) {
    conditions.push(`ma.dominant_emotion = $${paramIndex}`);
    params.push(options.emotion);
    paramIndex++;
  }

  if (options.risk) {
    conditions.push(`ma.escalation_risk = $${paramIndex}`);
    params.push(options.risk);
    paramIndex++;
  }

  params.push(limit);

  const result = await pool.query<EnrichedAnalyticsRow>(
    `SELECT ma.*, m.text AS message_text, m.thread_ts,
            up.display_name, up.real_name
     FROM message_analytics ma
     LEFT JOIN messages m
       ON m.workspace_id = ma.workspace_id
       AND m.channel_id = ma.channel_id
       AND m.ts = ma.message_ts
     LEFT JOIN user_profiles up
       ON up.workspace_id = m.workspace_id
       AND up.user_id = m.user_id
     WHERE ${conditions.join(" AND ")}
     ORDER BY ma.created_at DESC
     LIMIT $${paramIndex}`,
    params,
  );
  return result.rows;
}

// ─── Context documents (pgvector) ───────────────────────────────────────────

export async function insertContextDocument(row: {
  workspaceId: string;
  channelId: string;
  docType: ContextDocType;
  content: string;
  tokenCount: number;
  embedding: number[] | null;
  sourceTsStart: string | null;
  sourceTsEnd: string | null;
  sourceThreadTs: string | null;
  messageCount: number;
}): Promise<void> {
  await pool.query(
    `INSERT INTO context_documents
       (workspace_id, channel_id, doc_type, content, token_count, embedding,
        source_ts_start, source_ts_end, source_thread_ts, message_count)
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9, $10)`,
    [
      row.workspaceId,
      row.channelId,
      row.docType,
      row.content,
      row.tokenCount,
      row.embedding ? `[${row.embedding.join(",")}]` : null,
      row.sourceTsStart,
      row.sourceTsEnd,
      row.sourceThreadTs,
      row.messageCount,
    ],
  );
}

export async function searchContextDocuments(
  workspaceId: string,
  channelId: string,
  queryEmbedding: number[],
  limit: number,
): Promise<ContextDocumentRow[]> {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;
  const result = await pool.query<ContextDocumentRow>(
    `SELECT id, workspace_id, channel_id, doc_type, content, token_count,
            source_ts_start, source_ts_end, source_thread_ts, message_count, created_at
     FROM context_documents
     WHERE workspace_id = $1 AND channel_id = $2 AND embedding IS NOT NULL
     ORDER BY embedding <=> $3::vector
     LIMIT $4`,
    [workspaceId, channelId, embeddingStr, limit],
  );
  return result.rows;
}

export async function getLatestContextDocument(
  workspaceId: string,
  channelId: string,
  docType: ContextDocType,
): Promise<ContextDocumentRow | null> {
  const result = await pool.query<ContextDocumentRow>(
    `SELECT * FROM context_documents
     WHERE workspace_id = $1 AND channel_id = $2 AND doc_type = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId, channelId, docType],
  );
  return result.rows[0] ?? null;
}

export async function getMessagesSinceTs(
  workspaceId: string,
  channelId: string,
  sinceTs: string,
  limit: number = 200,
): Promise<MessageRow[]> {
  const safeLimit = Math.max(1, Math.min(500, limit));
  const result = await pool.query<MessageRow>(
    `SELECT * FROM messages
     WHERE workspace_id = $1 AND channel_id = $2 AND ts > $3
       AND (thread_ts IS NULL OR thread_ts = ts)
     ORDER BY ts ASC
     LIMIT $4`,
    [workspaceId, channelId, sinceTs, safeLimit],
  );
  return result.rows;
}

// ─── Rollup state ───────────────────────────────────────────────────────────

export async function incrementMessagesSinceRollup(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  await pool.query(
    `UPDATE channel_state
     SET messages_since_last_rollup = messages_since_last_rollup + 1,
         updated_at = NOW()
     WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId],
  );
}

export async function resetRollupState(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  await pool.query(
    `UPDATE channel_state
     SET messages_since_last_rollup = 0,
         last_rollup_at = NOW(),
         updated_at = NOW()
     WHERE workspace_id = $1 AND channel_id = $2`,
    [workspaceId, channelId],
  );
}

export async function getThreadReplyCount(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM thread_edges
     WHERE workspace_id = $1 AND channel_id = $2 AND thread_ts = $3`,
    [workspaceId, channelId, threadTs],
  );
  return parseInt(result.rows[0].count, 10);
}

export async function getDailyLLMCost(workspaceId: string): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total
     FROM llm_costs
     WHERE workspace_id = $1 AND created_at >= CURRENT_DATE`,
    [workspaceId],
  );
  return parseFloat(result.rows[0].total);
}

// ─── Analytics aggregation ──────────────────────────────────────────────────

export interface SentimentTrendBucket {
  bucket: string;
  total: number;
  emotions: Record<string, number>;
  avgConfidence: number;
  highRiskCount: number;
}

export async function getSentimentTrends(
  workspaceId: string,
  options: {
    channelId?: string | null;
    granularity: "hourly" | "daily";
    from?: string | null;
    to?: string | null;
    limit?: number;
  },
): Promise<SentimentTrendBucket[]> {
  const trunc = options.granularity === "hourly" ? "hour" : "day";
  const limit = Math.max(1, Math.min(365, options.limit ?? 30));
  const conditions: string[] = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  let idx = 2;

  if (options.channelId) {
    conditions.push(`channel_id = $${idx}`);
    params.push(options.channelId);
    idx++;
  }
  if (options.from) {
    conditions.push(`created_at >= $${idx}::timestamptz`);
    params.push(options.from);
    idx++;
  }
  if (options.to) {
    conditions.push(`created_at <= $${idx}::timestamptz`);
    params.push(options.to);
    idx++;
  }
  params.push(limit);

  const where = conditions.join(" AND ");
  const result = await pool.query<{
    bucket: Date;
    total: string;
    avg_confidence: string;
    high_risk_count: string;
    emotions_json: Record<string, string>;
  }>(
    `SELECT
       date_trunc('${trunc}', created_at) AS bucket,
       COUNT(*) AS total,
       AVG(confidence) AS avg_confidence,
       SUM(CASE WHEN escalation_risk = 'high' THEN 1 ELSE 0 END) AS high_risk_count,
       jsonb_object_agg(dominant_emotion, emotion_count) AS emotions_json
     FROM (
       SELECT created_at, confidence, escalation_risk, dominant_emotion,
              COUNT(*) OVER (PARTITION BY date_trunc('${trunc}', created_at), dominant_emotion) AS emotion_count
       FROM message_analytics
       WHERE ${where}
     ) sub
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT $${idx}`,
    params,
  );

  return result.rows.map((r) => ({
    bucket: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
    total: parseInt(String(r.total), 10),
    emotions: Object.fromEntries(
      Object.entries(r.emotions_json ?? {}).map(([k, v]) => [k, parseInt(String(v), 10)]),
    ),
    avgConfidence: parseFloat(String(r.avg_confidence)),
    highRiskCount: parseInt(String(r.high_risk_count), 10),
  }));
}

export interface CostBreakdownRow {
  day: string;
  llmProvider: string;
  llmModel: string;
  jobType: string | null;
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCostUsd: number;
}

export async function getCostBreakdown(
  workspaceId: string,
  options: {
    from?: string | null;
    to?: string | null;
    limit?: number;
  } = {},
): Promise<CostBreakdownRow[]> {
  const limit = Math.max(1, Math.min(365, options.limit ?? 30));
  const conditions: string[] = ["workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  let idx = 2;

  if (options.from) {
    conditions.push(`created_at >= $${idx}::timestamptz`);
    params.push(options.from);
    idx++;
  }
  if (options.to) {
    conditions.push(`created_at <= $${idx}::timestamptz`);
    params.push(options.to);
    idx++;
  }
  params.push(limit);

  const where = conditions.join(" AND ");
  const result = await pool.query<{
    day: Date;
    llm_provider: string;
    llm_model: string;
    job_type: string | null;
    total_requests: string;
    total_prompt_tokens: string;
    total_completion_tokens: string;
    total_cost_usd: string;
  }>(
    `SELECT
       date_trunc('day', created_at)::date AS day,
       llm_provider, llm_model, job_type,
       COUNT(*) AS total_requests,
       SUM(prompt_tokens) AS total_prompt_tokens,
       SUM(completion_tokens) AS total_completion_tokens,
       SUM(estimated_cost_usd) AS total_cost_usd
     FROM llm_costs
     WHERE ${where}
     GROUP BY 1, 2, 3, 4
     ORDER BY day DESC
     LIMIT $${idx}`,
    params,
  );

  return result.rows.map((r) => ({
    day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
    llmProvider: r.llm_provider,
    llmModel: r.llm_model,
    jobType: r.job_type,
    totalRequests: parseInt(String(r.total_requests), 10),
    totalPromptTokens: parseInt(String(r.total_prompt_tokens), 10),
    totalCompletionTokens: parseInt(String(r.total_completion_tokens), 10),
    totalCostUsd: parseFloat(String(r.total_cost_usd)),
  }));
}

export interface AnalyticsOverview {
  totalMessages: number;
  totalAnalyses: number;
  emotionDistribution: Record<string, number>;
  highRiskCount: number;
  totalCostUsd: number;
  costTodayUsd: number;
  activeChannels: number;
}

export async function getAnalyticsOverview(
  workspaceId: string,
): Promise<AnalyticsOverview> {
  const [msgResult, analyticsResult, emotionResult, riskResult, costResult, todayCostResult, channelResult] =
    await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM messages WHERE workspace_id = $1`,
        [workspaceId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM message_analytics WHERE workspace_id = $1`,
        [workspaceId],
      ),
      pool.query<{ dominant_emotion: string; count: string }>(
        `SELECT dominant_emotion, COUNT(*) AS count FROM message_analytics
         WHERE workspace_id = $1 GROUP BY dominant_emotion`,
        [workspaceId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM message_analytics
         WHERE workspace_id = $1 AND escalation_risk = 'high'`,
        [workspaceId],
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM llm_costs
         WHERE workspace_id = $1`,
        [workspaceId],
      ),
      pool.query<{ total: string }>(
        `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total FROM llm_costs
         WHERE workspace_id = $1 AND created_at >= CURRENT_DATE`,
        [workspaceId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM channels
         WHERE workspace_id = $1 AND status = 'ready'`,
        [workspaceId],
      ),
    ]);

  const emotionDistribution: Record<string, number> = {};
  for (const row of emotionResult.rows) {
    emotionDistribution[row.dominant_emotion] = parseInt(row.count, 10);
  }

  return {
    totalMessages: parseInt(msgResult.rows[0].count, 10),
    totalAnalyses: parseInt(analyticsResult.rows[0].count, 10),
    emotionDistribution,
    highRiskCount: parseInt(riskResult.rows[0].count, 10),
    totalCostUsd: parseFloat(costResult.rows[0].total),
    costTodayUsd: parseFloat(todayCostResult.rows[0].total),
    activeChannels: parseInt(channelResult.rows[0].count, 10),
  };
}

export interface ChannelSummaryData {
  runningSummary: string;
  keyDecisions: string[];
  totalRollups: number;
  latestRollupAt: Date | null;
  totalMessages: number;
  totalAnalyses: number;
  sentimentSnapshot: Record<string, unknown>;
}

export async function getChannelSummary(
  workspaceId: string,
  channelId: string,
): Promise<ChannelSummaryData | null> {
  const state = await getChannelState(workspaceId, channelId);
  if (!state) return null;

  const [rollupResult, msgResult, analyticsResult] = await Promise.all([
    pool.query<{ count: string; latest: Date | null }>(
      `SELECT COUNT(*) AS count, MAX(created_at) AS latest
       FROM context_documents
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM messages
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    ),
    pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM message_analytics
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    ),
  ]);

  return {
    runningSummary: state.running_summary ?? "",
    keyDecisions: (state.key_decisions_json ?? []) as string[],
    totalRollups: parseInt(rollupResult.rows[0].count, 10),
    latestRollupAt: rollupResult.rows[0].latest,
    totalMessages: parseInt(msgResult.rows[0].count, 10),
    totalAnalyses: parseInt(analyticsResult.rows[0].count, 10),
    sentimentSnapshot: (state.sentiment_snapshot_json ?? {}) as Record<string, unknown>,
  };
}
