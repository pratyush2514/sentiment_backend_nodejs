import { config } from "../config.js";
import { pool } from "./pool.js";
import type {
  AnalysisStatus,
  ChannelMemberRow,
  ChannelOverviewRow,
  ChannelRow,
  ChannelStatus,
  ConversationType,
  ContextDocType,
  ContextDocumentRow,
  DominantEmotion,
  EnrichedMessageWithAnalyticsRow,
  EscalationRisk,
  FollowUpAcknowledgmentSource,
  FollowUpDetectionMode,
  FollowUpEventRow,
  FollowUpItemRow,
  FollowUpResolutionReason,
  FollowUpResolutionScope,
  FollowUpRuleRow,
  FollowUpSeriousness,
  FollowUpWorkflowState,
  ImportanceTierOverride,
  ChannelModeOverride,
  ChannelMode,
  InteractionTone,
  MessageCandidateKind,
  CanonicalSignalSeverity,
  CanonicalSignalType,
  EvidenceType,
  IncidentFamily,
  MessageTriageRow,
  MessageRow,
  MessageAnalyticsRow,
  ChannelStateRow,
  OriginType,
  RelatedIncidentMentionRow,
  SignalStateImpact,
  StateTransition,
  RoleAssignmentRow,
  RoleReviewState,
  RoleAssignmentSource,
  SurfacePriority,
  ThreadInsightRow,
  UserRole,
  UserProfileRow,
  WorkspaceRow,
  ChannelHealthCountsRow,
} from "../types/database.js";

function toIsoTimestamp(value: string | Date | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  if (value instanceof Date) return value.toISOString();

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

// ─── Event deduplication ────────────────────────────────────────────────────

export type SlackEventReservationStatus =
  | "reserved"
  | "already_processing"
  | "already_processed";

export async function hasSeenEvent(
  workspaceId: string,
  eventId: string,
): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1
       FROM slack_events
       WHERE workspace_id = $1 AND event_id = $2
     ) AS exists`,
    [workspaceId, eventId],
  );
  return result.rows[0]?.exists ?? false;
}

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

export async function reserveSlackEvent(
  workspaceId: string,
  eventId: string,
  eventType: string,
): Promise<SlackEventReservationStatus> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query<{ processing_status: string }>(
      `SELECT processing_status
       FROM slack_events
       WHERE workspace_id = $1
         AND event_id = $2
       FOR UPDATE`,
      [workspaceId, eventId],
    );

    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO slack_events (
           workspace_id,
           event_id,
           event_type,
           processing_status,
           updated_at
         )
         VALUES ($1, $2, $3, 'processing', NOW())`,
        [workspaceId, eventId, eventType],
      );
      await client.query("COMMIT");
      return "reserved";
    }

    const status = existing.rows[0]?.processing_status;
    if (status === "processed") {
      await client.query("COMMIT");
      return "already_processed";
    }

    if (status === "failed") {
      await client.query(
        `UPDATE slack_events
         SET processing_status = 'processing',
             event_type = $3,
             last_error = NULL,
             updated_at = NOW()
         WHERE workspace_id = $1
           AND event_id = $2`,
        [workspaceId, eventId, eventType],
      );
      await client.query("COMMIT");
      return "reserved";
    }

    await client.query("COMMIT");
    return "already_processing";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeSlackEvent(
  workspaceId: string,
  eventId: string,
): Promise<void> {
  await pool.query(
    `UPDATE slack_events
     SET processing_status = 'processed',
         last_error = NULL,
         updated_at = NOW()
     WHERE workspace_id = $1
       AND event_id = $2`,
    [workspaceId, eventId],
  );
}

export async function failSlackEvent(
  workspaceId: string,
  eventId: string,
  errorMessage?: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE slack_events
     SET processing_status = 'failed',
         last_error = LEFT($3, 500),
         updated_at = NOW()
     WHERE workspace_id = $1
       AND event_id = $2`,
    [workspaceId, eventId, errorMessage ?? null],
  );
}

// ─── Channels ───────────────────────────────────────────────────────────────

export async function upsertChannel(
  workspaceId: string,
  channelId: string,
  status: ChannelStatus = "pending",
  name?: string | null,
  conversationType: ConversationType = "public_channel",
): Promise<ChannelRow> {
  const result = await pool.query<ChannelRow>(
    `INSERT INTO channels (workspace_id, channel_id, name, status, conversation_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, channel_id) DO UPDATE
       SET name = COALESCE(EXCLUDED.name, channels.name),
           conversation_type = COALESCE(EXCLUDED.conversation_type, channels.conversation_type),
           updated_at = NOW()
     RETURNING *`,
    [workspaceId, channelId, name ?? null, status, conversationType],
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

export async function getRecoverableChannels(
  staleMinutes: number,
  limit = 25,
): Promise<ChannelRow[]> {
  const result = await pool.query<ChannelRow>(
    `SELECT *
     FROM channels
     WHERE status IN ('pending', 'initializing', 'failed')
       AND updated_at < NOW() - MAKE_INTERVAL(mins => $1)
     ORDER BY updated_at ASC
     LIMIT $2`,
    [staleMinutes, limit],
  );
  return result.rows;
}

export async function getAllChannelsWithState(
  workspaceId: string,
): Promise<ChannelOverviewRow[]> {
  const result = await pool.query<ChannelOverviewRow>(
    `SELECT c.channel_id, c.name, c.conversation_type, c.status, c.initialized_at,
            c.last_event_at, c.updated_at,
            cs.running_summary, cs.sentiment_snapshot_json,
            cs.signal, cs.health, cs.signal_confidence,
            cs.risk_drivers_json, cs.attention_summary_json,
            cs.message_disposition_counts_json, cs.effective_channel_mode,
            (SELECT COUNT(*) FROM messages m
             WHERE m.workspace_id = c.workspace_id
               AND m.channel_id = c.channel_id) AS message_count
     FROM channels c
     LEFT JOIN channel_state cs
       ON cs.workspace_id = c.workspace_id AND cs.channel_id = c.channel_id
     WHERE c.workspace_id = $1
     ORDER BY c.last_event_at DESC NULLS LAST`,
    [workspaceId],
  );
  return result.rows;
}

export async function deleteChannelCascade(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM follow_up_items
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    );
    await client.query(
      `DELETE FROM follow_up_rules
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    );
    await client.query(
      `DELETE FROM message_analytics
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    );
    await client.query(
      `DELETE FROM context_documents
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    );
    await client.query(
      `DELETE FROM llm_costs
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    );
    await client.query(
      `DELETE FROM thread_edges
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    );
    await client.query(
      `DELETE FROM messages
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    );
    await client.query(
      `DELETE FROM channel_state
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    );
    await client.query(
      `DELETE FROM channels
       WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Delete ALL data for a workspace — channels, messages, analytics, roles,
 * follow-ups, costs, and the workspace record itself. Used by "Disconnect Workspace".
 */
export async function deleteWorkspaceCascade(workspaceId: string): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    // Child tables first (FK order)
    await client.query(`DELETE FROM follow_up_items   WHERE workspace_id = $1`, [workspaceId]);
    await client.query(`DELETE FROM follow_up_rules   WHERE workspace_id = $1`, [workspaceId]);
    await client.query(`DELETE FROM message_analytics  WHERE workspace_id = $1`, [workspaceId]);
    await client.query(`DELETE FROM context_documents  WHERE workspace_id = $1`, [workspaceId]);
    await client.query(`DELETE FROM llm_costs          WHERE workspace_id = $1`, [workspaceId]);
    await client.query(`DELETE FROM thread_edges       WHERE workspace_id = $1`, [workspaceId]);
    await client.query(`DELETE FROM messages           WHERE workspace_id = $1`, [workspaceId]);
    await client.query(`DELETE FROM channel_state      WHERE workspace_id = $1`, [workspaceId]);
    await client.query(`DELETE FROM channel_members    WHERE workspace_id = $1`, [workspaceId]);
    await client.query(`DELETE FROM channels           WHERE workspace_id = $1`, [workspaceId]);
    await client.query(`DELETE FROM role_assignments   WHERE workspace_id = $1`, [workspaceId]);
    await client.query(`DELETE FROM workspaces         WHERE workspace_id = $1`, [workspaceId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
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
  filesJson?: Array<{ name: string; title?: string; mimetype?: string; filetype?: string; size?: number; permalink?: string }> | null,
  linksJson?: Array<{ url: string; domain: string; label?: string; linkType: string }> | null,
): Promise<MessageRow> {
  const result = await pool.query<MessageRow>(
    `INSERT INTO messages (workspace_id, channel_id, ts, user_id, text, source, analysis_status, thread_ts, subtype, bot_id, files_json, links_json)
     VALUES (
       $1, $2, $3, $4, $5, $6,
       CASE WHEN $6 = 'backfill' THEN 'skipped' ELSE 'pending' END,
       $7, $8, $9, $10, $11
     )
     ON CONFLICT (workspace_id, channel_id, ts) DO UPDATE
       SET text = COALESCE(NULLIF(messages.text, ''), EXCLUDED.text),
           thread_ts = COALESCE(messages.thread_ts, EXCLUDED.thread_ts),
           source = CASE WHEN messages.source = 'realtime' THEN 'realtime' ELSE EXCLUDED.source END,
           files_json = COALESCE(EXCLUDED.files_json, messages.files_json),
           links_json = COALESCE(EXCLUDED.links_json, messages.links_json),
           updated_at = NOW()
     RETURNING *`,
    [workspaceId, channelId, ts, userId, text, source, threadTs ?? null, subtype ?? null, botId ?? null, filesJson ? JSON.stringify(filesJson) : null, linksJson ? JSON.stringify(linksJson) : null],
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
       ORDER BY ts::double precision ASC
       LIMIT $4`,
      [workspaceId, channelId, options.threadTs, limit],
    );
    return result.rows;
  }

  const result = await pool.query<MessageRow>(
    `SELECT * FROM messages
     WHERE workspace_id = $1 AND channel_id = $2
     ORDER BY ts::double precision DESC
     LIMIT $3`,
    [workspaceId, channelId, limit],
  );
  return result.rows.reverse();
}

export async function getMessagesByTs(
  workspaceId: string,
  channelId: string,
  messageTs: string[],
): Promise<MessageRow[]> {
  if (messageTs.length === 0) return [];

  const result = await pool.query<MessageRow>(
    `SELECT *
     FROM messages
     WHERE workspace_id = $1
       AND channel_id = $2
       AND ts = ANY($3)
     ORDER BY ts::double precision ASC`,
    [workspaceId, channelId, messageTs],
  );

  return result.rows;
}

export async function getMessageByTs(
  workspaceId: string,
  channelId: string,
  messageTs: string,
): Promise<MessageRow | null> {
  const result = await pool.query<MessageRow>(
    `SELECT *
     FROM messages
     WHERE workspace_id = $1
       AND channel_id = $2
       AND ts = $3
     LIMIT 1`,
    [workspaceId, channelId, messageTs],
  );

  return result.rows[0] ?? null;
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

export async function getChannelParticipantCounts(
  workspaceId: string,
  channelId: string,
): Promise<Array<{ user_id: string; message_count: number }>> {
  const result = await pool.query<{ user_id: string; message_count: string }>(
    `SELECT user_id, COUNT(*) AS message_count
     FROM messages
     WHERE workspace_id = $1
       AND channel_id = $2
     GROUP BY user_id
     ORDER BY COUNT(*) DESC, user_id ASC`,
    [workspaceId, channelId],
  );

  return result.rows.map((row) => ({
    user_id: row.user_id,
    message_count: parseInt(row.message_count, 10),
  }));
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
    last_activity: Date | string;
  }>(
    `SELECT m.thread_ts,
            COUNT(*) AS reply_count,
            MAX(TO_TIMESTAMP(m.ts::double precision)) AS last_activity
     FROM messages m
     WHERE m.workspace_id = $1
       AND m.channel_id = $2
       AND m.thread_ts IS NOT NULL
     GROUP BY m.thread_ts
     ORDER BY MAX(TO_TIMESTAMP(m.ts::double precision)) DESC NULLS LAST
     LIMIT $3`,
    [workspaceId, channelId, limit],
  );
  return result.rows.map((r) => ({
    thread_ts: r.thread_ts,
    reply_count: parseInt(r.reply_count, 10),
    last_activity: toIsoTimestamp(r.last_activity),
  }));
}

// ─── User profiles ──────────────────────────────────────────────────────────

export async function upsertUserProfile(
  workspaceId: string,
  userId: string,
  displayName: string | null,
  realName: string | null,
  profileImage: string | null,
  email: string | null,
  isAdmin: boolean,
  isOwner: boolean,
  isBot: boolean,
): Promise<UserProfileRow> {
  const result = await pool.query<UserProfileRow>(
    `INSERT INTO user_profiles (
       workspace_id, user_id, display_name, real_name, profile_image, email,
       is_admin, is_owner, is_bot, fetched_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (workspace_id, user_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           real_name = EXCLUDED.real_name,
           profile_image = EXCLUDED.profile_image,
           email = COALESCE(EXCLUDED.email, user_profiles.email),
           is_admin = EXCLUDED.is_admin,
           is_owner = EXCLUDED.is_owner,
           is_bot = EXCLUDED.is_bot,
           fetched_at = NOW()
     RETURNING *`,
    [workspaceId, userId, displayName, realName, profileImage, email, isAdmin, isOwner, isBot],
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

const FOLLOW_UP_COLUMNS = `,
            fu.id AS fu_id,
            fu.seriousness AS fu_seriousness,
            fu.summary AS fu_summary,
            fu.due_at AS fu_due_at,
            fu.repeated_ask_count AS fu_repeated_ask_count`;

const TRIAGE_COLUMNS = `,
            mt.candidate_kind AS mt_candidate_kind,
            mt.signal_type AS mt_signal_type,
            mt.severity AS mt_severity,
            mt.state_impact AS mt_state_impact,
            mt.evidence_type AS mt_evidence_type,
            mt.channel_mode AS mt_channel_mode,
            mt.origin_type AS mt_origin_type,
            mt.confidence AS mt_confidence,
            mt.incident_family AS mt_incident_family,
            mt.surface_priority AS mt_surface_priority,
            mt.reason_codes AS mt_reason_codes,
            mt.state_transition AS mt_state_transition,
            mt.signals_json AS mt_signals_json`;

const FOLLOW_UP_LATERAL_JOIN = `
     LEFT JOIN LATERAL (
       SELECT fui.id, fui.seriousness, fui.summary, fui.due_at, fui.repeated_ask_count
       FROM follow_up_items fui
       WHERE fui.workspace_id = m.workspace_id
         AND fui.channel_id = m.channel_id
         AND fui.requester_user_id = m.user_id
         AND fui.status = 'open'
         AND (fui.snoozed_until IS NULL OR fui.snoozed_until <= NOW())
         AND fui.source_message_ts <= m.ts
         AND (
           (
             fui.source_thread_ts IS NOT NULL
             AND COALESCE(m.thread_ts, m.ts) = fui.source_thread_ts
           )
           OR (
             fui.source_thread_ts IS NULL
             AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
           )
         )
       ORDER BY fui.source_message_ts DESC
       LIMIT 1
     ) fu ON TRUE`;

const TRIAGE_JOIN = `
     LEFT JOIN message_triage mt
       ON mt.workspace_id = m.workspace_id
      AND mt.channel_id = m.channel_id
      AND mt.message_ts = m.ts`;

export async function getMessagesEnriched(
  workspaceId: string,
  channelId: string,
  options: { limit?: number; threadTs?: string | null; participantId?: string | null } = {},
): Promise<EnrichedMessageWithAnalyticsRow[]> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));

  const analyticsColumns = `,
            ma.dominant_emotion AS ma_dominant_emotion,
            ma.interaction_tone AS ma_interaction_tone,
            ma.confidence AS ma_confidence,
            ma.escalation_risk AS ma_escalation_risk,
            ma.explanation AS ma_explanation,
            ma.themes AS ma_themes,
            ma.raw_llm_response AS ma_raw_llm_response,
            ma.message_intent AS ma_message_intent,
            ma.is_actionable AS ma_is_actionable,
            ma.is_blocking AS ma_is_blocking,
            ma.urgency_level AS ma_urgency_level`;

  const analyticsJoin = `
     LEFT JOIN message_analytics ma
       ON ma.workspace_id = m.workspace_id AND ma.channel_id = m.channel_id AND ma.message_ts = m.ts`;

  if (options.threadTs && options.participantId) {
    const result = await pool.query<EnrichedMessageWithAnalyticsRow>(
      `SELECT m.*, up.display_name, up.real_name${analyticsColumns}${FOLLOW_UP_COLUMNS}${TRIAGE_COLUMNS}
       FROM messages m
       LEFT JOIN user_profiles up
         ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id${analyticsJoin}${FOLLOW_UP_LATERAL_JOIN}${TRIAGE_JOIN}
       WHERE m.workspace_id = $1
         AND m.channel_id = $2
         AND m.thread_ts = $3
         AND m.user_id = $4
       ORDER BY m.ts::double precision ASC
       LIMIT $5`,
      [workspaceId, channelId, options.threadTs, options.participantId, limit],
    );
    return result.rows;
  }

  if (options.threadTs) {
    const result = await pool.query<EnrichedMessageWithAnalyticsRow>(
      `SELECT m.*, up.display_name, up.real_name${analyticsColumns}${FOLLOW_UP_COLUMNS}${TRIAGE_COLUMNS}
       FROM messages m
       LEFT JOIN user_profiles up
         ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id${analyticsJoin}${FOLLOW_UP_LATERAL_JOIN}${TRIAGE_JOIN}
       WHERE m.workspace_id = $1 AND m.channel_id = $2 AND m.thread_ts = $3
       ORDER BY m.ts::double precision ASC
       LIMIT $4`,
      [workspaceId, channelId, options.threadTs, limit],
    );
    return result.rows;
  }

  if (options.participantId) {
    const result = await pool.query<EnrichedMessageWithAnalyticsRow>(
      `SELECT m.*, up.display_name, up.real_name${analyticsColumns}${FOLLOW_UP_COLUMNS}${TRIAGE_COLUMNS}
       FROM messages m
       LEFT JOIN user_profiles up
         ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id${analyticsJoin}${FOLLOW_UP_LATERAL_JOIN}${TRIAGE_JOIN}
       WHERE m.workspace_id = $1
         AND m.channel_id = $2
         AND m.user_id = $3
       ORDER BY m.ts::double precision DESC
       LIMIT $4`,
      [workspaceId, channelId, options.participantId, limit],
    );
    return result.rows.reverse();
  }

  const result = await pool.query<EnrichedMessageWithAnalyticsRow>(
    `SELECT m.*, up.display_name, up.real_name${analyticsColumns}${FOLLOW_UP_COLUMNS}${TRIAGE_COLUMNS}
     FROM messages m
     LEFT JOIN user_profiles up
       ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id${analyticsJoin}${FOLLOW_UP_LATERAL_JOIN}${TRIAGE_JOIN}
     WHERE m.workspace_id = $1 AND m.channel_id = $2
     ORDER BY m.ts::double precision DESC
     LIMIT $3`,
    [workspaceId, channelId, limit],
  );
  return result.rows.reverse();
}

export async function getMessagesEnrichedByTs(
  workspaceId: string,
  channelId: string,
  messageTs: string[],
): Promise<EnrichedMessageWithAnalyticsRow[]> {
  if (messageTs.length === 0) return [];

  const result = await pool.query<EnrichedMessageWithAnalyticsRow>(
    `SELECT m.*, up.display_name, up.real_name,
            ma.dominant_emotion AS ma_dominant_emotion,
            ma.interaction_tone AS ma_interaction_tone,
            ma.confidence AS ma_confidence,
            ma.escalation_risk AS ma_escalation_risk,
            ma.explanation AS ma_explanation,
            ma.themes AS ma_themes,
            ma.raw_llm_response AS ma_raw_llm_response,
            ma.message_intent AS ma_message_intent,
            ma.is_actionable AS ma_is_actionable,
            ma.is_blocking AS ma_is_blocking,
            ma.urgency_level AS ma_urgency_level,
            fu.id AS fu_id,
            fu.seriousness AS fu_seriousness,
            fu.summary AS fu_summary,
            fu.due_at AS fu_due_at,
            fu.repeated_ask_count AS fu_repeated_ask_count,
            mt.candidate_kind AS mt_candidate_kind,
            mt.signal_type AS mt_signal_type,
            mt.severity AS mt_severity,
            mt.state_impact AS mt_state_impact,
            mt.evidence_type AS mt_evidence_type,
            mt.channel_mode AS mt_channel_mode,
            mt.origin_type AS mt_origin_type,
            mt.confidence AS mt_confidence,
            mt.incident_family AS mt_incident_family,
            mt.surface_priority AS mt_surface_priority,
            mt.reason_codes AS mt_reason_codes,
            mt.state_transition AS mt_state_transition
     FROM messages m
     LEFT JOIN user_profiles up
       ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id
     LEFT JOIN message_analytics ma
       ON ma.workspace_id = m.workspace_id AND ma.channel_id = m.channel_id AND ma.message_ts = m.ts
     LEFT JOIN message_triage mt
       ON mt.workspace_id = m.workspace_id AND mt.channel_id = m.channel_id AND mt.message_ts = m.ts
     LEFT JOIN LATERAL (
       SELECT fui.id, fui.seriousness, fui.summary, fui.due_at, fui.repeated_ask_count
       FROM follow_up_items fui
       WHERE fui.workspace_id = m.workspace_id
         AND fui.channel_id = m.channel_id
         AND fui.requester_user_id = m.user_id
         AND fui.status = 'open'
         AND (fui.snoozed_until IS NULL OR fui.snoozed_until <= NOW())
         AND fui.source_message_ts <= m.ts
         AND (
           (
             fui.source_thread_ts IS NOT NULL
             AND COALESCE(m.thread_ts, m.ts) = fui.source_thread_ts
           )
           OR (
             fui.source_thread_ts IS NULL
             AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
           )
         )
       ORDER BY fui.source_message_ts DESC
       LIMIT 1
     ) fu ON TRUE
     WHERE m.workspace_id = $1
       AND m.channel_id = $2
       AND m.ts = ANY($3)
     ORDER BY m.ts::double precision ASC`,
    [workspaceId, channelId, messageTs],
  );

  return result.rows;
}

/** Top-level channel messages (not thread replies) with reply count and analytics */
export async function getTopLevelMessagesEnriched(
  workspaceId: string,
  channelId: string,
  limit: number = 50,
  escalationRisk?: string[],
): Promise<(EnrichedMessageWithAnalyticsRow & { reply_count: number })[]> {
  const safeLimit = Math.max(1, Math.min(200, limit));
  const params: unknown[] = [workspaceId, channelId];
  let riskFilter = "";

  if (escalationRisk && escalationRisk.length > 0) {
    params.push(escalationRisk);
    riskFilter = `AND ma.escalation_risk = ANY($${params.length})`;
  }

  params.push(safeLimit);

  const result = await pool.query<EnrichedMessageWithAnalyticsRow & { reply_count: string }>(
    `SELECT m.*, up.display_name, up.real_name,
            COALESCE(tc.cnt, 0) AS reply_count,
            ma.dominant_emotion AS ma_dominant_emotion,
            ma.interaction_tone AS ma_interaction_tone,
            ma.confidence AS ma_confidence,
            ma.escalation_risk AS ma_escalation_risk,
            ma.explanation AS ma_explanation,
            ma.themes AS ma_themes,
            ma.raw_llm_response AS ma_raw_llm_response,
            ma.message_intent AS ma_message_intent,
            ma.is_actionable AS ma_is_actionable,
            ma.is_blocking AS ma_is_blocking,
            ma.urgency_level AS ma_urgency_level,
            fu.id AS fu_id,
            fu.seriousness AS fu_seriousness,
            fu.summary AS fu_summary,
            fu.due_at AS fu_due_at,
            fu.repeated_ask_count AS fu_repeated_ask_count,
            mt.candidate_kind AS mt_candidate_kind,
            mt.signal_type AS mt_signal_type,
            mt.severity AS mt_severity,
            mt.state_impact AS mt_state_impact,
            mt.evidence_type AS mt_evidence_type,
            mt.channel_mode AS mt_channel_mode,
            mt.origin_type AS mt_origin_type,
            mt.confidence AS mt_confidence,
            mt.incident_family AS mt_incident_family,
            mt.surface_priority AS mt_surface_priority,
            mt.reason_codes AS mt_reason_codes,
            mt.state_transition AS mt_state_transition
     FROM messages m
     LEFT JOIN user_profiles up
       ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id
     LEFT JOIN (
       SELECT thread_ts, COUNT(*) AS cnt
       FROM thread_edges
       WHERE workspace_id = $1 AND channel_id = $2
       GROUP BY thread_ts
     ) tc ON tc.thread_ts = m.ts
     LEFT JOIN message_analytics ma
       ON ma.workspace_id = m.workspace_id AND ma.channel_id = m.channel_id AND ma.message_ts = m.ts
     LEFT JOIN message_triage mt
       ON mt.workspace_id = m.workspace_id AND mt.channel_id = m.channel_id AND mt.message_ts = m.ts
     LEFT JOIN LATERAL (
       SELECT fui.id, fui.seriousness, fui.summary, fui.due_at, fui.repeated_ask_count
       FROM follow_up_items fui
       WHERE fui.workspace_id = m.workspace_id
         AND fui.channel_id = m.channel_id
         AND fui.requester_user_id = m.user_id
         AND fui.status = 'open'
         AND (fui.snoozed_until IS NULL OR fui.snoozed_until <= NOW())
         AND fui.source_message_ts <= m.ts
         AND (
           (
             fui.source_thread_ts IS NOT NULL
             AND COALESCE(m.thread_ts, m.ts) = fui.source_thread_ts
           )
           OR (
             fui.source_thread_ts IS NULL
             AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
           )
         )
       ORDER BY fui.source_message_ts DESC
       LIMIT 1
     ) fu ON TRUE
     WHERE m.workspace_id = $1
       AND m.channel_id = $2
       AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
       ${riskFilter}
     ORDER BY m.ts::double precision DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows
    .map((r) => ({ ...r, reply_count: parseInt(String(r.reply_count), 10) }))
    .reverse();
}

export async function getTopLevelMessagesAroundTsEnriched(
  workspaceId: string,
  channelId: string,
  focusTs: string,
  before: number = 2,
  after: number = 4,
): Promise<EnrichedMessageWithAnalyticsRow[]> {
  const safeBefore = Math.max(0, Math.min(10, before));
  const safeAfter = Math.max(0, Math.min(12, after));

  const result = await pool.query<EnrichedMessageWithAnalyticsRow>(
    `WITH ordered_messages AS (
       SELECT m.*, up.display_name, up.real_name,
              ma.dominant_emotion AS ma_dominant_emotion,
              ma.interaction_tone AS ma_interaction_tone,
              ma.confidence AS ma_confidence,
              ma.escalation_risk AS ma_escalation_risk,
              ma.explanation AS ma_explanation,
              ma.themes AS ma_themes,
              ma.raw_llm_response AS ma_raw_llm_response,
              ma.message_intent AS ma_message_intent,
              ma.is_actionable AS ma_is_actionable,
              ma.is_blocking AS ma_is_blocking,
              ma.urgency_level AS ma_urgency_level,
            fu.id AS fu_id,
            fu.seriousness AS fu_seriousness,
            fu.summary AS fu_summary,
            fu.due_at AS fu_due_at,
            fu.repeated_ask_count AS fu_repeated_ask_count,
            mt.candidate_kind AS mt_candidate_kind,
            mt.signal_type AS mt_signal_type,
            mt.severity AS mt_severity,
            mt.state_impact AS mt_state_impact,
            mt.evidence_type AS mt_evidence_type,
            mt.channel_mode AS mt_channel_mode,
            mt.origin_type AS mt_origin_type,
            mt.confidence AS mt_confidence,
            mt.incident_family AS mt_incident_family,
            mt.surface_priority AS mt_surface_priority,
            mt.reason_codes AS mt_reason_codes,
            mt.state_transition AS mt_state_transition,
              ROW_NUMBER() OVER (ORDER BY m.ts::double precision ASC) AS row_num
       FROM messages m
       LEFT JOIN user_profiles up
         ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id
       LEFT JOIN message_analytics ma
         ON ma.workspace_id = m.workspace_id AND ma.channel_id = m.channel_id AND ma.message_ts = m.ts
       LEFT JOIN message_triage mt
         ON mt.workspace_id = m.workspace_id AND mt.channel_id = m.channel_id AND mt.message_ts = m.ts
       LEFT JOIN LATERAL (
         SELECT fui.id, fui.seriousness, fui.summary, fui.due_at, fui.repeated_ask_count
         FROM follow_up_items fui
         WHERE fui.workspace_id = m.workspace_id
           AND fui.channel_id = m.channel_id
           AND fui.requester_user_id = m.user_id
           AND fui.status = 'open'
           AND (fui.snoozed_until IS NULL OR fui.snoozed_until <= NOW())
           AND fui.source_message_ts <= m.ts
           AND (
             (
               fui.source_thread_ts IS NOT NULL
               AND COALESCE(m.thread_ts, m.ts) = fui.source_thread_ts
             )
             OR (
               fui.source_thread_ts IS NULL
               AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
             )
           )
         ORDER BY fui.source_message_ts DESC
         LIMIT 1
       ) fu ON TRUE
       WHERE m.workspace_id = $1
         AND m.channel_id = $2
         AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
     ),
     focus AS (
       SELECT row_num
       FROM ordered_messages
       WHERE ts = $3
       LIMIT 1
     )
     SELECT *
     FROM ordered_messages
     WHERE row_num BETWEEN
       GREATEST(1, COALESCE((SELECT row_num FROM focus), 1) - $4)
       AND
       COALESCE((SELECT row_num FROM focus), 1) + $5
     ORDER BY row_num ASC`,
    [workspaceId, channelId, focusTs, safeBefore, safeAfter],
  );

  return result.rows;
}

export interface WorkspaceTopLevelMessageRow extends EnrichedMessageWithAnalyticsRow {
  channel_name: string | null;
  conversation_type: ConversationType;
  reply_count: number;
}

export async function getRecentWorkspaceTopLevelMessagesEnriched(
  workspaceId: string,
  limit: number = 120,
): Promise<WorkspaceTopLevelMessageRow[]> {
  const safeLimit = Math.max(1, Math.min(250, limit));
  const result = await pool.query<WorkspaceTopLevelMessageRow & { reply_count: string }>(
    `SELECT m.*, up.display_name, up.real_name,
            c.name AS channel_name,
            c.conversation_type,
            COALESCE(tc.cnt, 0) AS reply_count,
            ma.dominant_emotion AS ma_dominant_emotion,
            ma.interaction_tone AS ma_interaction_tone,
            ma.confidence AS ma_confidence,
            ma.escalation_risk AS ma_escalation_risk,
            ma.explanation AS ma_explanation,
            ma.themes AS ma_themes,
            ma.raw_llm_response AS ma_raw_llm_response,
            ma.message_intent AS ma_message_intent,
            ma.is_actionable AS ma_is_actionable,
            ma.is_blocking AS ma_is_blocking,
            ma.urgency_level AS ma_urgency_level,
            fu.id AS fu_id,
            fu.seriousness AS fu_seriousness,
            fu.summary AS fu_summary,
            fu.due_at AS fu_due_at,
            fu.repeated_ask_count AS fu_repeated_ask_count,
            mt.candidate_kind AS mt_candidate_kind,
            mt.signal_type AS mt_signal_type,
            mt.severity AS mt_severity,
            mt.state_impact AS mt_state_impact,
            mt.evidence_type AS mt_evidence_type,
            mt.channel_mode AS mt_channel_mode,
            mt.origin_type AS mt_origin_type,
            mt.confidence AS mt_confidence,
            mt.incident_family AS mt_incident_family,
            mt.surface_priority AS mt_surface_priority,
            mt.reason_codes AS mt_reason_codes,
            mt.state_transition AS mt_state_transition
     FROM messages m
     INNER JOIN channels c
       ON c.workspace_id = m.workspace_id
      AND c.channel_id = m.channel_id
     LEFT JOIN user_profiles up
       ON up.workspace_id = m.workspace_id
      AND up.user_id = m.user_id
     LEFT JOIN (
       SELECT thread_ts, channel_id, workspace_id, COUNT(*) AS cnt
       FROM thread_edges
       WHERE workspace_id = $1
       GROUP BY workspace_id, channel_id, thread_ts
     ) tc
       ON tc.workspace_id = m.workspace_id
      AND tc.channel_id = m.channel_id
      AND tc.thread_ts = m.ts
     LEFT JOIN message_analytics ma
       ON ma.workspace_id = m.workspace_id
      AND ma.channel_id = m.channel_id
      AND ma.message_ts = m.ts
     LEFT JOIN message_triage mt
       ON mt.workspace_id = m.workspace_id
      AND mt.channel_id = m.channel_id
      AND mt.message_ts = m.ts
     LEFT JOIN LATERAL (
       SELECT fui.id, fui.seriousness, fui.summary, fui.due_at, fui.repeated_ask_count
       FROM follow_up_items fui
       WHERE fui.workspace_id = m.workspace_id
         AND fui.channel_id = m.channel_id
         AND fui.requester_user_id = m.user_id
         AND fui.status = 'open'
         AND (fui.snoozed_until IS NULL OR fui.snoozed_until <= NOW())
         AND fui.source_message_ts <= m.ts
         AND (
           (
             fui.source_thread_ts IS NOT NULL
             AND COALESCE(m.thread_ts, m.ts) = fui.source_thread_ts
           )
           OR (
             fui.source_thread_ts IS NULL
             AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
           )
         )
       ORDER BY fui.source_message_ts DESC
       LIMIT 1
     ) fu ON TRUE
     WHERE m.workspace_id = $1
       AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
     ORDER BY m.ts::double precision DESC
     LIMIT $2`,
    [workspaceId, safeLimit],
  );

  return result.rows.map((row) => ({
    ...row,
    reply_count: parseInt(String(row.reply_count), 10),
  }));
}

/** Thread replies for a specific thread root (excluding root itself) */
export async function getThreadRepliesEnriched(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<EnrichedMessageWithAnalyticsRow[]> {
  const result = await pool.query<EnrichedMessageWithAnalyticsRow>(
    `SELECT m.*, up.display_name, up.real_name,
            ma.dominant_emotion AS ma_dominant_emotion,
            ma.interaction_tone AS ma_interaction_tone,
            ma.confidence AS ma_confidence,
            ma.escalation_risk AS ma_escalation_risk,
            ma.explanation AS ma_explanation,
            ma.themes AS ma_themes,
            ma.raw_llm_response AS ma_raw_llm_response,
            ma.message_intent AS ma_message_intent,
            ma.is_actionable AS ma_is_actionable,
            ma.is_blocking AS ma_is_blocking,
            ma.urgency_level AS ma_urgency_level,
            fu.id AS fu_id,
            fu.seriousness AS fu_seriousness,
            fu.summary AS fu_summary,
            fu.due_at AS fu_due_at,
            fu.repeated_ask_count AS fu_repeated_ask_count,
            mt.candidate_kind AS mt_candidate_kind,
            mt.signal_type AS mt_signal_type,
            mt.severity AS mt_severity,
            mt.state_impact AS mt_state_impact,
            mt.evidence_type AS mt_evidence_type,
            mt.channel_mode AS mt_channel_mode,
            mt.origin_type AS mt_origin_type,
            mt.confidence AS mt_confidence,
            mt.incident_family AS mt_incident_family,
            mt.surface_priority AS mt_surface_priority,
            mt.reason_codes AS mt_reason_codes,
            mt.state_transition AS mt_state_transition
     FROM messages m
     LEFT JOIN user_profiles up
       ON up.workspace_id = m.workspace_id AND up.user_id = m.user_id
     LEFT JOIN message_analytics ma
       ON ma.workspace_id = m.workspace_id AND ma.channel_id = m.channel_id AND ma.message_ts = m.ts
     LEFT JOIN message_triage mt
       ON mt.workspace_id = m.workspace_id AND mt.channel_id = m.channel_id AND mt.message_ts = m.ts
     LEFT JOIN LATERAL (
       SELECT fui.id, fui.seriousness, fui.summary, fui.due_at, fui.repeated_ask_count
       FROM follow_up_items fui
       WHERE fui.workspace_id = m.workspace_id
         AND fui.channel_id = m.channel_id
         AND fui.requester_user_id = m.user_id
         AND fui.status = 'open'
         AND (fui.snoozed_until IS NULL OR fui.snoozed_until <= NOW())
         AND fui.source_message_ts <= m.ts
         AND COALESCE(m.thread_ts, m.ts) = fui.source_thread_ts
       ORDER BY fui.source_message_ts DESC
       LIMIT 1
     ) fu ON TRUE
     WHERE m.workspace_id = $1
       AND m.channel_id = $2
       AND m.thread_ts = $3
       AND m.ts != $3
     ORDER BY m.ts::double precision ASC`,
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
    last_activity: Date | string;
  }>(
    `SELECT m.thread_ts,
            COUNT(*) AS reply_count,
            MAX(TO_TIMESTAMP(m.ts::double precision)) AS last_activity
     FROM messages m
     WHERE m.workspace_id = $1
       AND m.channel_id = $2
       AND m.thread_ts IS NOT NULL
     GROUP BY m.thread_ts
     HAVING MAX(TO_TIMESTAMP(m.ts::double precision)) > NOW() - MAKE_INTERVAL(hours => $3)
     ORDER BY MAX(TO_TIMESTAMP(m.ts::double precision)) DESC NULLS LAST`,
    [workspaceId, channelId, hoursBack],
  );
  return result.rows.map((r) => ({
    thread_ts: r.thread_ts,
    reply_count: parseInt(r.reply_count, 10),
    last_activity: toIsoTimestamp(r.last_activity),
  }));
}

export async function getLatestThreadAnalysis(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<{
  summary: string | null;
  sentimentTrajectory: "improving" | "stable" | "deteriorating" | null;
  threadSentiment: string | null;
} | null> {
  const result = await pool.query<{ raw_llm_response: Record<string, unknown> | null }>(
    `SELECT ma.raw_llm_response
     FROM message_analytics ma
     INNER JOIN messages m
       ON m.workspace_id = ma.workspace_id
      AND m.channel_id = ma.channel_id
      AND m.ts = ma.message_ts
     WHERE ma.workspace_id = $1
       AND ma.channel_id = $2
       AND m.thread_ts = $3
     ORDER BY m.ts::double precision DESC, ma.created_at DESC
     LIMIT 1`,
    [workspaceId, channelId, threadTs],
  );

  const raw = result.rows[0]?.raw_llm_response;
  if (!raw) return null;

  const sentimentTrajectory =
    raw.sentiment_trajectory === "improving" ||
    raw.sentiment_trajectory === "stable" ||
    raw.sentiment_trajectory === "deteriorating"
      ? raw.sentiment_trajectory
      : null;

  return {
    summary: typeof raw.summary === "string" ? raw.summary : null,
    sentimentTrajectory,
    threadSentiment: typeof raw.thread_sentiment === "string" ? raw.thread_sentiment : null,
  };
}

export async function upsertMessageTriage(row: {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  candidateKind: MessageCandidateKind;
  signalType: CanonicalSignalType;
  severity: CanonicalSignalSeverity;
  surfacePriority: SurfacePriority;
  candidateScore: number;
  stateTransition?: StateTransition | null;
  stateImpact: SignalStateImpact;
  evidenceType: EvidenceType;
  channelMode: ChannelMode;
  originType: OriginType;
  confidence: number;
  incidentFamily: IncidentFamily;
  reasonCodes: string[];
  signals: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `INSERT INTO message_triage (
       workspace_id, channel_id, message_ts, candidate_kind, surface_priority,
       candidate_score, state_transition, signal_type, severity, state_impact,
       evidence_type, channel_mode, origin_type, confidence, incident_family,
       reason_codes, signals_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (workspace_id, channel_id, message_ts) DO UPDATE
       SET candidate_kind = EXCLUDED.candidate_kind,
           surface_priority = EXCLUDED.surface_priority,
           candidate_score = EXCLUDED.candidate_score,
           state_transition = EXCLUDED.state_transition,
           signal_type = EXCLUDED.signal_type,
           severity = EXCLUDED.severity,
           state_impact = EXCLUDED.state_impact,
           evidence_type = EXCLUDED.evidence_type,
           channel_mode = EXCLUDED.channel_mode,
           origin_type = EXCLUDED.origin_type,
           confidence = EXCLUDED.confidence,
           incident_family = EXCLUDED.incident_family,
           reason_codes = EXCLUDED.reason_codes,
           signals_json = EXCLUDED.signals_json,
           updated_at = NOW()`,
    [
      row.workspaceId,
      row.channelId,
      row.messageTs,
      row.candidateKind,
      row.surfacePriority,
      row.candidateScore,
      row.stateTransition ?? null,
      row.signalType,
      row.severity,
      row.stateImpact,
      row.evidenceType,
      row.channelMode,
      row.originType,
      row.confidence,
      row.incidentFamily,
      JSON.stringify(row.reasonCodes),
      JSON.stringify(row.signals),
    ],
  );
}

export async function getMessageTriageBatch(
  workspaceId: string,
  channelId: string,
  messageTs: string[],
): Promise<MessageTriageRow[]> {
  if (messageTs.length === 0) return [];

  const result = await pool.query<MessageTriageRow>(
    `SELECT *
     FROM message_triage
     WHERE workspace_id = $1
       AND channel_id = $2
       AND message_ts = ANY($3)`,
    [workspaceId, channelId, messageTs],
  );

  return result.rows;
}

export async function getRelatedIncidentMentions(
  workspaceId: string,
  channelId: string,
  windowDays: number,
  limit: number = 5,
): Promise<RelatedIncidentMentionRow[]> {
  const safeLimit = Math.max(1, Math.min(20, limit));
  const result = await pool.query<RelatedIncidentMentionRow>(
    `SELECT
       m.ts AS message_ts,
       mt.signals_json ->> 'relatedIncidentSourceChannelName' AS source_channel_name,
       source.channel_id AS source_channel_id,
       m.text AS message_text,
       TO_TIMESTAMP(m.ts::double precision)::timestamptz::text AS detected_at,
       COALESCE(
         NULLIF(mt.signals_json ->> 'relatedIncidentBlocksLocalWork', '')::boolean,
         false
       ) AS blocks_local_work,
       COALESCE(mt.signals_json ->> 'relatedIncidentFamily', mt.incident_family, 'none') AS incident_family
     FROM message_triage mt
     INNER JOIN messages m
       ON m.workspace_id = mt.workspace_id
      AND m.channel_id = mt.channel_id
      AND m.ts = mt.message_ts
     LEFT JOIN channels source
       ON source.workspace_id = mt.workspace_id
      AND LOWER(source.name) = LOWER(mt.signals_json ->> 'relatedIncidentSourceChannelName')
     WHERE mt.workspace_id = $1
       AND mt.channel_id = $2
       AND mt.signals_json ->> 'relatedIncidentKind' = 'referenced_external_incident'
       AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(days => $3)
     ORDER BY m.ts::double precision DESC
     LIMIT $4`,
    [workspaceId, channelId, windowDays, safeLimit],
  );

  return result.rows.map((row) => ({
    ...row,
    source_channel_name: row.source_channel_name ?? null,
    source_channel_id: row.source_channel_id ?? null,
    message_text: row.message_text,
    detected_at: row.detected_at ?? null,
    blocks_local_work: Boolean(row.blocks_local_work),
    incident_family: row.incident_family ?? "none",
  }));
}

export async function upsertThreadInsight(row: {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  summary: string;
  primaryIssue: string;
  threadState: ThreadInsightRow["thread_state"];
  emotionalTemperature: ThreadInsightRow["emotional_temperature"];
  operationalRisk: ThreadInsightRow["operational_risk"];
  surfacePriority: SurfacePriority;
  crucialMoments: ThreadInsightRow["crucial_moments_json"];
  openQuestions: string[];
  lastMeaningfulChangeTs?: string | null;
  sourceTsEnd?: string | null;
  rawLlmResponse: Record<string, unknown>;
  llmProvider: string;
  llmModel: string;
  tokenUsage: Record<string, unknown> | null;
}): Promise<void> {
  await pool.query(
    `INSERT INTO thread_insights (
       workspace_id, channel_id, thread_ts, summary, primary_issue, thread_state,
       emotional_temperature, operational_risk, surface_priority, crucial_moments_json,
       open_questions_json, last_meaningful_change_ts, source_ts_end, raw_llm_response,
       llm_provider, llm_model, token_usage
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT (workspace_id, channel_id, thread_ts) DO UPDATE
       SET summary = EXCLUDED.summary,
           primary_issue = EXCLUDED.primary_issue,
           thread_state = EXCLUDED.thread_state,
           emotional_temperature = EXCLUDED.emotional_temperature,
           operational_risk = EXCLUDED.operational_risk,
           surface_priority = EXCLUDED.surface_priority,
           crucial_moments_json = EXCLUDED.crucial_moments_json,
           open_questions_json = EXCLUDED.open_questions_json,
           last_meaningful_change_ts = EXCLUDED.last_meaningful_change_ts,
           source_ts_end = EXCLUDED.source_ts_end,
           raw_llm_response = EXCLUDED.raw_llm_response,
           llm_provider = EXCLUDED.llm_provider,
           llm_model = EXCLUDED.llm_model,
           token_usage = EXCLUDED.token_usage,
           updated_at = NOW()`,
    [
      row.workspaceId,
      row.channelId,
      row.threadTs,
      row.summary,
      row.primaryIssue,
      row.threadState,
      row.emotionalTemperature,
      row.operationalRisk,
      row.surfacePriority,
      JSON.stringify(row.crucialMoments),
      JSON.stringify(row.openQuestions),
      row.lastMeaningfulChangeTs ?? null,
      row.sourceTsEnd ?? null,
      JSON.stringify(row.rawLlmResponse),
      row.llmProvider,
      row.llmModel,
      row.tokenUsage ? JSON.stringify(row.tokenUsage) : null,
    ],
  );
}

export async function getThreadInsight(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<ThreadInsightRow | null> {
  const result = await pool.query<ThreadInsightRow>(
    `SELECT *
     FROM thread_insights
     WHERE workspace_id = $1
       AND channel_id = $2
       AND thread_ts = $3
     LIMIT 1`,
    [workspaceId, channelId, threadTs],
  );
  return result.rows[0] ?? null;
}

export async function getThreadInsightsBatch(
  workspaceId: string,
  channelId: string,
  threadTs: string[],
): Promise<ThreadInsightRow[]> {
  if (threadTs.length === 0) return [];

  const result = await pool.query<ThreadInsightRow>(
    `SELECT *
     FROM thread_insights
     WHERE workspace_id = $1
       AND channel_id = $2
       AND thread_ts = ANY($3)`,
    [workspaceId, channelId, threadTs],
  );

  return result.rows;
}

export async function getRecentThreadInsights(
  workspaceId: string,
  limit: number = 25,
): Promise<Array<ThreadInsightRow & {
  channel_name: string | null;
  conversation_type: ConversationType | null;
}>> {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const result = await pool.query<ThreadInsightRow & {
    channel_name: string | null;
    conversation_type: ConversationType | null;
  }>(
    `SELECT ti.*,
            c.name AS channel_name,
            c.conversation_type
     FROM thread_insights ti
     LEFT JOIN channels c
       ON c.workspace_id = ti.workspace_id
      AND c.channel_id = ti.channel_id
     WHERE ti.workspace_id = $1
       AND ti.surface_priority IN ('medium', 'high')
     ORDER BY ti.updated_at DESC
     LIMIT $2`,
    [workspaceId, safeLimit],
  );

  return result.rows;
}

export async function getLatestThreadRollupSummary(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<string | null> {
  const raw = await getLatestThreadRollup(workspaceId, channelId, threadTs);
  return raw?.summary ?? null;
}

export async function getLatestThreadRollup(
  workspaceId: string,
  channelId: string,
  threadTs: string,
): Promise<{ summary: string; openQuestions: string[] } | null> {
  const result = await pool.query<{ content: string }>(
    `SELECT content
     FROM context_documents
     WHERE workspace_id = $1
       AND channel_id = $2
       AND doc_type = 'thread_rollup'
       AND source_thread_ts = $3
     ORDER BY created_at DESC
     LIMIT 1`,
    [workspaceId, channelId, threadTs],
  );

  const content = result.rows[0]?.content;
  if (!content) return null;

  // Support both JSON (new) and plain text (legacy) formats
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "object" && parsed !== null && typeof parsed.summary === "string") {
      return {
        summary: parsed.summary,
        openQuestions: Array.isArray(parsed.openQuestions) ? parsed.openQuestions : [],
      };
    }
  } catch {
    // Legacy plain text format
  }

  return { summary: content, openQuestions: [] };
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

// ─── Channel health counts (composite health scoring) ───────────────────────

export async function getChannelHealthCounts(
  workspaceId: string,
  channelId?: string,
): Promise<ChannelHealthCountsRow[]> {
  const params: Array<string | number> = [
    workspaceId,
    config.SUMMARY_WINDOW_DAYS,
  ];
  let channelFilter = "";
  if (channelId) {
    params.push(channelId);
    channelFilter = `AND c.channel_id = $3`;
  }
  const result = await pool.query<ChannelHealthCountsRow>(
    `SELECT
       c.channel_id,
       COALESCE(fur.analysis_window_days, $2::int) AS analysis_window_days,
       (SELECT COUNT(*) FROM follow_up_items fui
        WHERE fui.workspace_id = c.workspace_id AND fui.channel_id = c.channel_id
          AND fui.status = 'open'
          AND fui.workflow_state IN ('awaiting_primary', 'acknowledged_waiting', 'escalated')
          AND (fui.snoozed_until IS NULL OR fui.snoozed_until <= NOW())
          AND COALESCE(fui.visibility_after, fui.created_at) <= NOW()
       ) AS open_alert_count,
       (SELECT COUNT(*) FROM follow_up_items fui
        WHERE fui.workspace_id = c.workspace_id AND fui.channel_id = c.channel_id
          AND fui.status = 'open' AND fui.seriousness = 'high'
          AND fui.workflow_state IN ('awaiting_primary', 'acknowledged_waiting', 'escalated')
          AND (fui.snoozed_until IS NULL OR fui.snoozed_until <= NOW())
          AND COALESCE(fui.visibility_after, fui.created_at) <= NOW()
       ) AS high_severity_alert_count,
       (SELECT COUNT(*) FROM message_triage mt
        JOIN messages m
          ON m.workspace_id = mt.workspace_id
         AND m.channel_id = mt.channel_id
         AND m.ts = mt.message_ts
       WHERE mt.workspace_id = c.workspace_id
          AND mt.channel_id = c.channel_id
          AND mt.signal_type = 'operational_incident'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS automation_incident_count,
       (SELECT COUNT(*) FROM message_triage mt
        JOIN messages m
          ON m.workspace_id = mt.workspace_id
         AND m.channel_id = mt.channel_id
         AND m.ts = mt.message_ts
        WHERE mt.workspace_id = c.workspace_id
          AND mt.channel_id = c.channel_id
          AND mt.signal_type = 'operational_incident'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(hours => 24)
       ) AS automation_incident_24h_count,
       (SELECT COUNT(*) FROM message_triage mt
        JOIN messages m
          ON m.workspace_id = mt.workspace_id
         AND m.channel_id = mt.channel_id
         AND m.ts = mt.message_ts
        WHERE mt.workspace_id = c.workspace_id
          AND mt.channel_id = c.channel_id
          AND mt.signal_type = 'operational_incident'
          AND mt.severity = 'high'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS critical_automation_incident_count,
       (SELECT COUNT(*) FROM message_triage mt
        JOIN messages m
          ON m.workspace_id = mt.workspace_id
         AND m.channel_id = mt.channel_id
         AND m.ts = mt.message_ts
        WHERE mt.workspace_id = c.workspace_id
          AND mt.channel_id = c.channel_id
          AND mt.signal_type = 'operational_incident'
          AND mt.severity = 'high'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(hours => 24)
       ) AS critical_automation_incident_24h_count,
       (SELECT COUNT(*) FROM message_triage mt
        JOIN messages m
          ON m.workspace_id = mt.workspace_id
         AND m.channel_id = mt.channel_id
         AND m.ts = mt.message_ts
        WHERE mt.workspace_id = c.workspace_id
          AND mt.channel_id = c.channel_id
          AND mt.signal_type = 'human_risk'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS human_risk_signal_count,
       (SELECT COUNT(*) FROM message_triage mt
        JOIN messages m
          ON m.workspace_id = mt.workspace_id
         AND m.channel_id = mt.channel_id
         AND m.ts = mt.message_ts
        WHERE mt.workspace_id = c.workspace_id
          AND mt.channel_id = c.channel_id
          AND mt.signal_type = 'request'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS request_signal_count,
       (SELECT COUNT(*) FROM message_triage mt
        JOIN messages m
          ON m.workspace_id = mt.workspace_id
         AND m.channel_id = mt.channel_id
         AND m.ts = mt.message_ts
        WHERE mt.workspace_id = c.workspace_id
          AND mt.channel_id = c.channel_id
          AND mt.signal_type = 'decision'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS decision_signal_count,
       (SELECT COUNT(*) FROM message_triage mt
        JOIN messages m
          ON m.workspace_id = mt.workspace_id
         AND m.channel_id = mt.channel_id
         AND m.ts = mt.message_ts
        WHERE mt.workspace_id = c.workspace_id
          AND mt.channel_id = c.channel_id
          AND mt.signal_type = 'resolution'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS resolution_signal_count,
       (SELECT COUNT(*) FROM message_analytics ma
        JOIN messages m
          ON m.workspace_id = ma.workspace_id
         AND m.channel_id = ma.channel_id
         AND m.ts = ma.message_ts
        WHERE ma.workspace_id = c.workspace_id AND ma.channel_id = c.channel_id
          AND ma.escalation_risk IN ('medium', 'high')
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS flagged_message_count,
       (SELECT COUNT(*) FROM message_analytics ma
        JOIN messages m
          ON m.workspace_id = ma.workspace_id
         AND m.channel_id = ma.channel_id
         AND m.ts = ma.message_ts
       WHERE ma.workspace_id = c.workspace_id AND ma.channel_id = c.channel_id
          AND ma.escalation_risk = 'high'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS high_risk_message_count
       ,
       (SELECT COUNT(*) FROM thread_insights ti
        WHERE ti.workspace_id = c.workspace_id
          AND ti.channel_id = c.channel_id
          AND CASE
            WHEN ti.source_ts_end IS NOT NULL THEN TO_TIMESTAMP(ti.source_ts_end::double precision)
            ELSE ti.updated_at
          END >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
          AND (
            ti.thread_state IN ('blocked', 'escalated')
            OR ti.operational_risk IN ('medium', 'high')
            OR ti.surface_priority = 'high'
            OR (
              ti.thread_state = 'waiting_external'
              AND jsonb_array_length(ti.open_questions_json) > 0
              AND ti.surface_priority <> 'none'
            )
          )
       ) AS attention_thread_count
       ,
       (SELECT COUNT(*) FROM thread_insights ti
        WHERE ti.workspace_id = c.workspace_id
          AND ti.channel_id = c.channel_id
          AND ti.thread_state = 'blocked'
          AND CASE
            WHEN ti.source_ts_end IS NOT NULL THEN TO_TIMESTAMP(ti.source_ts_end::double precision)
            ELSE ti.updated_at
          END >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS blocked_thread_count
       ,
       (SELECT COUNT(*) FROM thread_insights ti
        WHERE ti.workspace_id = c.workspace_id
          AND ti.channel_id = c.channel_id
          AND ti.thread_state = 'escalated'
          AND CASE
            WHEN ti.source_ts_end IS NOT NULL THEN TO_TIMESTAMP(ti.source_ts_end::double precision)
            ELSE ti.updated_at
          END >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS escalated_thread_count
       ,
       (SELECT COUNT(*) FROM thread_insights ti
        WHERE ti.workspace_id = c.workspace_id
          AND ti.channel_id = c.channel_id
          AND ti.operational_risk IN ('medium', 'high')
          AND CASE
            WHEN ti.source_ts_end IS NOT NULL THEN TO_TIMESTAMP(ti.source_ts_end::double precision)
            ELSE ti.updated_at
          END >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS risky_thread_count
       ,
       (SELECT COUNT(*) FROM messages m
        WHERE m.workspace_id = c.workspace_id
          AND m.channel_id = c.channel_id
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS total_message_count,
       (SELECT COUNT(*) FROM messages m
        WHERE m.workspace_id = c.workspace_id
          AND m.channel_id = c.channel_id
          AND m.analysis_status = 'skipped'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS skipped_message_count,
       (SELECT COUNT(*) FROM message_triage mt
        JOIN messages m
          ON m.workspace_id = mt.workspace_id
         AND m.channel_id = mt.channel_id
         AND m.ts = mt.message_ts
        WHERE mt.workspace_id = c.workspace_id
          AND mt.channel_id = c.channel_id
          AND mt.signal_type = 'context'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS context_only_message_count,
       (SELECT COUNT(*) FROM message_triage mt
        JOIN messages m
          ON m.workspace_id = mt.workspace_id
         AND m.channel_id = mt.channel_id
         AND m.ts = mt.message_ts
        WHERE mt.workspace_id = c.workspace_id
          AND mt.channel_id = c.channel_id
          AND mt.signal_type = 'ignore'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS ignored_message_count,
       (SELECT COUNT(*) FROM messages m
        WHERE m.workspace_id = c.workspace_id
          AND m.channel_id = c.channel_id
          AND m.analysis_status IN ('pending', 'processing')
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS inflight_message_count,
       (SELECT COUNT(*) FROM message_analytics ma
        JOIN messages m
          ON m.workspace_id = ma.workspace_id
         AND m.channel_id = ma.channel_id
         AND m.ts = ma.message_ts
        WHERE ma.workspace_id = c.workspace_id AND ma.channel_id = c.channel_id
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS total_analyzed_count,
       (SELECT COUNT(*) FROM message_analytics ma
        JOIN messages m
          ON m.workspace_id = ma.workspace_id
         AND m.channel_id = ma.channel_id
         AND m.ts = ma.message_ts
        WHERE ma.workspace_id = c.workspace_id AND ma.channel_id = c.channel_id
          AND ma.dominant_emotion = 'anger'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS anger_count,
       (SELECT COUNT(*) FROM message_analytics ma
        JOIN messages m
          ON m.workspace_id = ma.workspace_id
         AND m.channel_id = ma.channel_id
         AND m.ts = ma.message_ts
        WHERE ma.workspace_id = c.workspace_id AND ma.channel_id = c.channel_id
          AND ma.dominant_emotion = 'joy'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS joy_count,
       (SELECT COUNT(*) FROM message_analytics ma
        JOIN messages m
          ON m.workspace_id = ma.workspace_id
         AND m.channel_id = ma.channel_id
         AND m.ts = ma.message_ts
        WHERE ma.workspace_id = c.workspace_id AND ma.channel_id = c.channel_id
          AND ma.dominant_emotion = 'sadness'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS sadness_count,
       (SELECT COUNT(*) FROM message_analytics ma
        JOIN messages m
          ON m.workspace_id = ma.workspace_id
         AND m.channel_id = ma.channel_id
         AND m.ts = ma.message_ts
        WHERE ma.workspace_id = c.workspace_id AND ma.channel_id = c.channel_id
          AND ma.dominant_emotion = 'neutral'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS neutral_count,
       (SELECT COUNT(*) FROM message_analytics ma
        JOIN messages m
          ON m.workspace_id = ma.workspace_id
         AND m.channel_id = ma.channel_id
         AND m.ts = ma.message_ts
        WHERE ma.workspace_id = c.workspace_id AND ma.channel_id = c.channel_id
          AND ma.dominant_emotion = 'fear'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS fear_count,
       (SELECT COUNT(*) FROM message_analytics ma
        JOIN messages m
          ON m.workspace_id = ma.workspace_id
         AND m.channel_id = ma.channel_id
         AND m.ts = ma.message_ts
        WHERE ma.workspace_id = c.workspace_id AND ma.channel_id = c.channel_id
          AND ma.dominant_emotion = 'surprise'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS surprise_count,
       (SELECT COUNT(*) FROM message_analytics ma
        JOIN messages m
          ON m.workspace_id = ma.workspace_id
         AND m.channel_id = ma.channel_id
         AND m.ts = ma.message_ts
        WHERE ma.workspace_id = c.workspace_id AND ma.channel_id = c.channel_id
          AND ma.dominant_emotion = 'disgust'
          AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
            days => COALESCE(fur.analysis_window_days, $2::int)
          )
       ) AS disgust_count
     FROM channels c
     LEFT JOIN follow_up_rules fur
       ON fur.workspace_id = c.workspace_id
      AND fur.channel_id = c.channel_id
     WHERE c.workspace_id = $1 ${channelFilter}`,
    params,
  );
  return result.rows;
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
      | "signal"
      | "health"
      | "signal_confidence"
      | "risk_drivers_json"
      | "attention_summary_json"
      | "message_disposition_counts_json"
      | "effective_channel_mode"
      | "sentiment_snapshot_json"
      | "messages_since_last_llm"
    >
  >,
): Promise<void> {
  await pool.query(
    `INSERT INTO channel_state (workspace_id, channel_id,
       running_summary, participants_json, active_threads_json,
       key_decisions_json, signal, health, signal_confidence, risk_drivers_json,
       attention_summary_json, message_disposition_counts_json, effective_channel_mode,
       sentiment_snapshot_json, messages_since_last_llm)
     VALUES ($1, $2, COALESCE($3, ''), COALESCE($4::jsonb, '{}'), COALESCE($5::jsonb, '[]'),
             COALESCE($6::jsonb, '[]'), $7, $8, $9, COALESCE($10::jsonb, '[]'),
             $11::jsonb, $12::jsonb, $13, COALESCE($14::jsonb, '{}'), COALESCE($15, 0))
     ON CONFLICT (workspace_id, channel_id) DO UPDATE
       SET running_summary = COALESCE($3, channel_state.running_summary),
           participants_json = COALESCE($4::jsonb, channel_state.participants_json),
           active_threads_json = COALESCE($5::jsonb, channel_state.active_threads_json),
           key_decisions_json = COALESCE($6::jsonb, channel_state.key_decisions_json),
           signal = COALESCE($7, channel_state.signal),
           health = COALESCE($8, channel_state.health),
           signal_confidence = COALESCE($9, channel_state.signal_confidence),
           risk_drivers_json = COALESCE($10::jsonb, channel_state.risk_drivers_json),
           attention_summary_json = COALESCE($11::jsonb, channel_state.attention_summary_json),
           message_disposition_counts_json = COALESCE($12::jsonb, channel_state.message_disposition_counts_json),
           effective_channel_mode = COALESCE($13, channel_state.effective_channel_mode),
           sentiment_snapshot_json = COALESCE($14::jsonb, channel_state.sentiment_snapshot_json),
           messages_since_last_llm = COALESCE($15, channel_state.messages_since_last_llm),
           updated_at = NOW()`,
    [
      workspaceId,
      channelId,
      updates.running_summary !== undefined ? updates.running_summary : null,
      updates.participants_json !== undefined ? JSON.stringify(updates.participants_json) : null,
      updates.active_threads_json !== undefined ? JSON.stringify(updates.active_threads_json) : null,
      updates.key_decisions_json !== undefined ? JSON.stringify(updates.key_decisions_json) : null,
      updates.signal !== undefined ? updates.signal : null,
      updates.health !== undefined ? updates.health : null,
      updates.signal_confidence !== undefined ? updates.signal_confidence : null,
      updates.risk_drivers_json !== undefined ? JSON.stringify(updates.risk_drivers_json) : null,
      updates.attention_summary_json !== undefined ? JSON.stringify(updates.attention_summary_json) : null,
      updates.message_disposition_counts_json !== undefined ? JSON.stringify(updates.message_disposition_counts_json) : null,
      updates.effective_channel_mode !== undefined ? updates.effective_channel_mode : null,
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

export async function incrementMessageCounters(
  workspaceId: string,
  channelId: string,
): Promise<void> {
  await pool.query(
    `UPDATE channel_state
     SET messages_since_last_llm = messages_since_last_llm + 1,
         messages_since_last_rollup = messages_since_last_rollup + 1,
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

export async function replaceMessageContent(input: {
  workspaceId: string;
  channelId: string;
  ts: string;
  userId: string;
  text: string;
  threadTs?: string | null;
  subtype?: string | null;
  botId?: string | null;
  filesJson?: Array<{
    name: string;
    title?: string;
    mimetype?: string;
    filetype?: string;
    size?: number;
    permalink?: string;
  }> | null;
  linksJson?: Array<{
    url: string;
    domain: string;
    label?: string;
    linkType: string;
  }> | null;
}): Promise<MessageRow | null> {
  const result = await pool.query<MessageRow>(
    `UPDATE messages
     SET user_id = $4,
         text = $5,
         thread_ts = COALESCE($6, thread_ts),
         subtype = $7,
         bot_id = $8,
         files_json = $9,
         links_json = $10,
         normalized_text = NULL,
         analysis_status = 'pending',
         updated_at = NOW()
     WHERE workspace_id = $1
       AND channel_id = $2
       AND ts = $3
     RETURNING *`,
    [
      input.workspaceId,
      input.channelId,
      input.ts,
      input.userId,
      input.text,
      input.threadTs ?? null,
      input.subtype ?? null,
      input.botId ?? null,
      input.filesJson ? JSON.stringify(input.filesJson) : null,
      input.linksJson ? JSON.stringify(input.linksJson) : null,
    ],
  );

  return result.rows[0] ?? null;
}

export async function markMessageDeleted(
  workspaceId: string,
  channelId: string,
  ts: string,
): Promise<MessageRow | null> {
  const result = await pool.query<MessageRow>(
    `UPDATE messages
     SET text = '[message deleted]',
         normalized_text = '[message deleted]',
         files_json = NULL,
         links_json = NULL,
         analysis_status = 'skipped',
         updated_at = NOW()
     WHERE workspace_id = $1
       AND channel_id = $2
       AND ts = $3
     RETURNING *`,
    [workspaceId, channelId, ts],
  );

  return result.rows[0] ?? null;
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

export async function markChannelBackfillMessagesSkipped(
  workspaceId: string,
  channelId: string,
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `WITH updated AS (
       UPDATE messages m
       SET analysis_status = 'skipped',
           updated_at = NOW()
       WHERE m.workspace_id = $1
         AND m.channel_id = $2
         AND m.source = 'backfill'
         AND m.analysis_status IN ('pending', 'processing', 'failed')
         AND NOT EXISTS (
           SELECT 1
           FROM message_analytics ma
           WHERE ma.workspace_id = m.workspace_id
             AND ma.channel_id = m.channel_id
             AND ma.message_ts = m.ts
         )
       RETURNING 1
     )
     SELECT COUNT(*)::int AS count FROM updated`,
    [workspaceId, channelId],
  );

  return Number(result.rows[0]?.count ?? 0);
}

export async function deleteMessageAnalytics(
  workspaceId: string,
  channelId: string,
  ts: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM message_analytics
     WHERE workspace_id = $1
       AND channel_id = $2
       AND message_ts = $3`,
    [workspaceId, channelId, ts],
  );
}

export interface StaleAnalysisCandidate {
  workspace_id: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  analysis_status: AnalysisStatus;
  updated_at: Date;
}

export async function getStaleAnalysisCandidates(
  staleMinutes: number,
  limit = 50,
): Promise<StaleAnalysisCandidate[]> {
  const result = await pool.query<StaleAnalysisCandidate>(
    `SELECT m.workspace_id, m.channel_id, m.ts, m.thread_ts, m.analysis_status, m.updated_at
     FROM messages m
     INNER JOIN channels c
       ON c.workspace_id = m.workspace_id
      AND c.channel_id = m.channel_id
     LEFT JOIN message_analytics ma
       ON ma.workspace_id = m.workspace_id
      AND ma.channel_id = m.channel_id
      AND ma.message_ts = m.ts
     WHERE c.status = 'ready'
       AND ma.id IS NULL
       AND m.analysis_status IN ('pending', 'processing', 'failed')
       AND m.updated_at < NOW() - MAKE_INTERVAL(mins => $1)
     ORDER BY m.updated_at ASC
     LIMIT $2`,
    [staleMinutes, limit],
  );

  return result.rows;
}

export async function markStaleBackfillMessagesSkipped(
  staleMinutes: number,
  limit = 200,
): Promise<Array<{ workspace_id: string; channel_id: string; skipped_count: number }>> {
  const result = await pool.query<{
    workspace_id: string;
    channel_id: string;
    skipped_count: string;
  }>(
    `WITH targets AS (
       SELECT m.workspace_id, m.channel_id, m.ts
       FROM messages m
       INNER JOIN channels c
         ON c.workspace_id = m.workspace_id
        AND c.channel_id = m.channel_id
       LEFT JOIN message_analytics ma
         ON ma.workspace_id = m.workspace_id
        AND ma.channel_id = m.channel_id
        AND ma.message_ts = m.ts
       WHERE c.status = 'ready'
         AND m.source = 'backfill'
         AND ma.id IS NULL
         AND m.analysis_status IN ('pending', 'processing', 'failed')
         AND m.updated_at < NOW() - MAKE_INTERVAL(mins => $1)
       ORDER BY m.updated_at ASC
       LIMIT $2
     ),
     updated AS (
       UPDATE messages m
       SET analysis_status = 'skipped',
           updated_at = NOW()
       FROM targets t
       WHERE m.workspace_id = t.workspace_id
         AND m.channel_id = t.channel_id
         AND m.ts = t.ts
       RETURNING m.workspace_id, m.channel_id
     )
     SELECT workspace_id, channel_id, COUNT(*)::int AS skipped_count
     FROM updated
     GROUP BY workspace_id, channel_id`,
    [staleMinutes, limit],
  );

  return result.rows.map((row) => ({
    workspace_id: row.workspace_id,
    channel_id: row.channel_id,
    skipped_count: Number(row.skipped_count),
  }));
}

export async function getUnresolvedMessageTs(
  workspaceId: string,
  channelId: string,
  options: { limit?: number; threadTs?: string | null; hoursBack?: number } = {},
): Promise<string[]> {
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const maxHoursBack = 30 * 24;
  const safeHoursBack = Math.max(
    1,
    Math.min(maxHoursBack, options.hoursBack ?? maxHoursBack),
  );

  const params: unknown[] = [workspaceId, channelId];
  let threadFilter = "";
  if (options.threadTs) {
    params.push(options.threadTs);
    threadFilter = `AND m.thread_ts = $${params.length}`;
  }
  params.push(safeHoursBack);
  const hoursBackParam = params.length;
  params.push(limit);

  const result = await pool.query<{ ts: string }>(
    `SELECT m.ts
     FROM messages m
     LEFT JOIN message_analytics ma
       ON ma.workspace_id = m.workspace_id
      AND ma.channel_id = m.channel_id
      AND ma.message_ts = m.ts
     WHERE m.workspace_id = $1
       AND m.channel_id = $2
       ${threadFilter}
       AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(hours => $${hoursBackParam})
       AND (
         m.analysis_status IN ('pending', 'processing', 'failed')
         OR (
           m.analysis_status = 'completed'
           AND ma.message_ts IS NULL
         )
       )
     ORDER BY m.ts::double precision DESC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((row) => row.ts);
}

export async function insertMessageAnalytics(row: {
  workspaceId: string;
  channelId: string;
  messageTs: string;
  dominantEmotion: DominantEmotion;
  interactionTone?: string | null;
  confidence: number;
  escalationRisk: EscalationRisk;
  themes: string[];
  decisionSignal: boolean;
  explanation: string | null;
  rawLlmResponse: Record<string, unknown>;
  llmProvider: string;
  llmModel: string;
  tokenUsage: Record<string, unknown> | null;
  messageIntent?: string | null;
  isActionable?: boolean | null;
  isBlocking?: boolean;
  urgencyLevel?: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO message_analytics
       (workspace_id, channel_id, message_ts, dominant_emotion, interaction_tone, confidence,
        escalation_risk, themes, decision_signal, explanation,
        raw_llm_response, llm_provider, llm_model, token_usage,
        message_intent, is_actionable, is_blocking, urgency_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     ON CONFLICT (workspace_id, channel_id, message_ts) DO UPDATE
       SET dominant_emotion = EXCLUDED.dominant_emotion,
           interaction_tone = EXCLUDED.interaction_tone,
           confidence = EXCLUDED.confidence,
           escalation_risk = EXCLUDED.escalation_risk,
           themes = EXCLUDED.themes,
           decision_signal = EXCLUDED.decision_signal,
           explanation = EXCLUDED.explanation,
           raw_llm_response = EXCLUDED.raw_llm_response,
           llm_provider = EXCLUDED.llm_provider,
           llm_model = EXCLUDED.llm_model,
           token_usage = EXCLUDED.token_usage,
           message_intent = EXCLUDED.message_intent,
           is_actionable = EXCLUDED.is_actionable,
           is_blocking = EXCLUDED.is_blocking,
           urgency_level = EXCLUDED.urgency_level`,
    [
      row.workspaceId,
      row.channelId,
      row.messageTs,
      row.dominantEmotion,
      row.interactionTone ?? null,
      row.confidence,
      row.escalationRisk,
      JSON.stringify(row.themes),
      row.decisionSignal,
      row.explanation,
      JSON.stringify(row.rawLlmResponse),
      row.llmProvider,
      row.llmModel,
      row.tokenUsage ? JSON.stringify(row.tokenUsage) : null,
      row.messageIntent ?? null,
      row.isActionable ?? null,
      row.isBlocking ?? false,
      row.urgencyLevel ?? "none",
    ],
  );
}

export async function getMessageAnalyticsBatch(
  workspaceId: string,
  messageTimestamps: string[],
): Promise<
  Pick<
    MessageAnalyticsRow,
    "message_ts" | "message_intent" | "is_actionable" | "is_blocking" | "urgency_level"
  >[]
> {
  if (messageTimestamps.length === 0) return [];
  const { rows } = await pool.query(
    `SELECT message_ts, message_intent, is_actionable, is_blocking, urgency_level
     FROM message_analytics
     WHERE workspace_id = $1 AND message_ts = ANY($2::text[])`,
    [workspaceId, messageTimestamps],
  );
  return rows;
}

export async function getFollowUpBySourceTs(
  workspaceId: string,
  channelId: string,
  sourceMessageTs: string,
): Promise<FollowUpItemRow | null> {
  const { rows } = await pool.query(
    `SELECT * FROM follow_up_items
     WHERE workspace_id = $1 AND channel_id = $2 AND source_message_ts = $3 AND status != 'dismissed'
     LIMIT 1`,
    [workspaceId, channelId, sourceMessageTs],
  );
  return rows[0] ?? null;
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
  offset?: number;
  threadTs?: string | null;
  emotion?: string | null;
  risk?: "low" | "medium" | "high" | "flagged" | null;
}

export interface EnrichedAnalyticsRow extends MessageAnalyticsRow {
  user_id: string | null;
  display_name: string | null;
  real_name: string | null;
  message_text: string | null;
  thread_ts: string | null;
  message_at: Date | string | null;
  author_flagged_count: number;
  total_count: number;
}

export async function getMessageAnalytics(
  workspaceId: string,
  channelId: string,
  options: AnalyticsQueryOptions = {},
): Promise<EnrichedAnalyticsRow[]> {
  const limit = Math.max(1, Math.min(100, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);
  const analysisWindowDays = await getEffectiveAnalysisWindowDays(
    workspaceId,
    channelId,
  );
  const windowStartTs = String(
    (Date.now() - analysisWindowDays * 86_400_000) / 1000,
  );
  const baseConditions: string[] = [
    "ma.workspace_id = $1",
    "ma.channel_id = $2",
    `m.ts::double precision >= $3::double precision`,
  ];
  const params: unknown[] = [workspaceId, channelId, windowStartTs];
  let paramIndex = 4;

  if (options.threadTs) {
    baseConditions.push(`m.thread_ts = $${paramIndex}`);
    params.push(options.threadTs);
    paramIndex++;
  }

  if (options.emotion) {
    baseConditions.push(`ma.dominant_emotion = $${paramIndex}`);
    params.push(options.emotion);
    paramIndex++;
  }

  let outerRiskFilter = "";
  if (options.risk === "flagged") {
    outerRiskFilter = `WHERE base.escalation_risk IN ('medium', 'high')`;
  } else if (options.risk) {
    outerRiskFilter = `WHERE base.escalation_risk = $${paramIndex}`;
    params.push(options.risk);
    paramIndex++;
  }

  params.push(limit);
  paramIndex++;
  params.push(offset);

  const result = await pool.query<EnrichedAnalyticsRow>(
    `WITH base AS (
       SELECT
         ma.*,
         m.user_id,
         m.text AS message_text,
         m.thread_ts,
         TO_TIMESTAMP(m.ts::double precision) AS message_at,
         up.display_name,
         up.real_name,
         SUM(
           CASE
             WHEN ma.escalation_risk IN ('medium', 'high') THEN 1
             ELSE 0
           END
         ) OVER (PARTITION BY m.user_id)::int AS author_flagged_count
       FROM message_analytics ma
       LEFT JOIN messages m
         ON m.workspace_id = ma.workspace_id
         AND m.channel_id = ma.channel_id
         AND m.ts = ma.message_ts
       LEFT JOIN user_profiles up
         ON up.workspace_id = m.workspace_id
         AND up.user_id = m.user_id
       WHERE ${baseConditions.join(" AND ")}
     )
     SELECT
       base.*,
       COUNT(*) OVER()::int AS total_count
     FROM base
     ${outerRiskFilter}
     ORDER BY
       CASE base.escalation_risk
         WHEN 'high' THEN 0
         WHEN 'medium' THEN 1
         WHEN 'low' THEN 2
         ELSE 3
       END,
       base.message_at DESC NULLS LAST,
       base.created_at DESC
     LIMIT $${paramIndex - 1}
     OFFSET $${paramIndex}`,
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
  minSourceTs?: string | null,
  maxSourceStartTs?: string | null,
): Promise<ContextDocumentRow[]> {
  const embeddingStr = `[${queryEmbedding.join(",")}]`;
  const result = await pool.query<ContextDocumentRow>(
    `SELECT id, workspace_id, channel_id, doc_type, content, token_count,
            source_ts_start, source_ts_end, source_thread_ts, message_count, created_at
     FROM context_documents
     WHERE workspace_id = $1
       AND channel_id = $2
       AND embedding IS NOT NULL
       AND (
         $5::double precision IS NULL
         OR (
           source_ts_start IS NOT NULL
           AND source_ts_end IS NOT NULL
           AND source_ts_start::double precision >= $5::double precision
           AND source_ts_end::double precision >= $5::double precision
         )
       )
       AND (
         $6::double precision IS NULL
         OR (
           source_ts_start IS NOT NULL
           AND source_ts_start::double precision <= $6::double precision
         )
       )
     ORDER BY embedding <=> $3::vector
     LIMIT $4`,
    [
      workspaceId,
      channelId,
      embeddingStr,
      limit,
      minSourceTs ?? null,
      maxSourceStartTs ?? null,
    ],
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
     WHERE workspace_id = $1 AND channel_id = $2 AND ts::double precision > $3::double precision
       AND (thread_ts IS NULL OR thread_ts = ts)
     ORDER BY ts::double precision ASC
     LIMIT $4`,
    [workspaceId, channelId, sinceTs, safeLimit],
  );
  return result.rows;
}

export async function getMessagesPageAfterTs(
  workspaceId: string,
  channelId: string,
  afterTs: string | null,
  limit: number = 500,
): Promise<MessageRow[]> {
  const safeLimit = Math.max(1, Math.min(1000, limit));

  if (afterTs) {
    const result = await pool.query<MessageRow>(
      `SELECT * FROM messages
       WHERE workspace_id = $1
         AND channel_id = $2
         AND ts::double precision > $3::double precision
       ORDER BY ts::double precision ASC
       LIMIT $4`,
      [workspaceId, channelId, afterTs, safeLimit],
    );
    return result.rows;
  }

  const result = await pool.query<MessageRow>(
    `SELECT * FROM messages
     WHERE workspace_id = $1
       AND channel_id = $2
     ORDER BY ts::double precision ASC
     LIMIT $3`,
    [workspaceId, channelId, safeLimit],
  );
  return result.rows;
}

/**
 * Fetch messages within a sliding time window (last N days).
 * Used for generating time-bounded summaries that reflect recent activity.
 * Pages through results using afterTs cursor for batch processing.
 */
export async function getMessagesInWindow(
  workspaceId: string,
  channelId: string,
  windowDays: number,
  afterTs: string | null,
  limit: number = 500,
): Promise<MessageRow[]> {
  const safeLimit = Math.max(1, Math.min(1000, limit));
  const windowStartEpoch = String((Date.now() - windowDays * 86_400_000) / 1000);
  const effectiveAfterTs = afterTs && parseFloat(afterTs) > parseFloat(windowStartEpoch)
    ? afterTs
    : windowStartEpoch;

  const result = await pool.query<MessageRow>(
    `SELECT * FROM messages
     WHERE workspace_id = $1
       AND channel_id = $2
       AND ts::double precision > $3::double precision
     ORDER BY ts::double precision ASC
     LIMIT $4`,
    [workspaceId, channelId, effectiveAfterTs, safeLimit],
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

export async function getRecentThreadReplyCount(
  workspaceId: string,
  channelId: string,
  threadTs: string,
  minutesBack: number,
): Promise<number> {
  const safeMinutesBack = Math.max(1, Math.min(60, minutesBack));
  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM messages
     WHERE workspace_id = $1
       AND channel_id = $2
       AND thread_ts = $3
       AND ts != $3
       AND TO_TIMESTAMP(ts::double precision) >= NOW() - MAKE_INTERVAL(mins => $4)`,
    [workspaceId, channelId, threadTs, safeMinutesBack],
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

export interface ChannelSparklineRow {
  channelId: string;
  sparkline: number[];
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
  const conditions: string[] = ["ma.workspace_id = $1"];
  const params: unknown[] = [workspaceId];
  let idx = 2;

  if (options.channelId) {
    conditions.push(`ma.channel_id = $${idx}`);
    params.push(options.channelId);
    idx++;
  }
  if (options.from) {
    conditions.push(`TO_TIMESTAMP(m.ts::double precision) >= $${idx}::timestamptz`);
    params.push(options.from);
    idx++;
  }
  if (options.to) {
    conditions.push(`TO_TIMESTAMP(m.ts::double precision) <= $${idx}::timestamptz`);
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
    anger_count: string;
    disgust_count: string;
    fear_count: string;
    joy_count: string;
    neutral_count: string;
    sadness_count: string;
    surprise_count: string;
  }>(
    `SELECT
       date_trunc('${trunc}', TO_TIMESTAMP(m.ts::double precision)) AS bucket,
       COUNT(*) AS total,
       AVG(ma.confidence) AS avg_confidence,
       SUM(CASE WHEN ma.escalation_risk = 'high' THEN 1 ELSE 0 END) AS high_risk_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'anger') AS anger_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'disgust') AS disgust_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'fear') AS fear_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'joy') AS joy_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'neutral') AS neutral_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'sadness') AS sadness_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'surprise') AS surprise_count
     FROM message_analytics ma
     INNER JOIN messages m
       ON m.workspace_id = ma.workspace_id
      AND m.channel_id = ma.channel_id
      AND m.ts = ma.message_ts
     WHERE ${where}
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT $${idx}`,
    params,
  );

  return result.rows.map((r) => ({
    bucket: r.bucket instanceof Date ? r.bucket.toISOString() : String(r.bucket),
    total: parseInt(String(r.total), 10),
    emotions: {
      anger: parseInt(String(r.anger_count), 10),
      disgust: parseInt(String(r.disgust_count), 10),
      fear: parseInt(String(r.fear_count), 10),
      joy: parseInt(String(r.joy_count), 10),
      neutral: parseInt(String(r.neutral_count), 10),
      sadness: parseInt(String(r.sadness_count), 10),
      surprise: parseInt(String(r.surprise_count), 10),
    },
    avgConfidence: Number.parseFloat(String(r.avg_confidence ?? 0)) || 0,
    highRiskCount: parseInt(String(r.high_risk_count), 10),
  }));
}

export async function getChannelSentimentSparklines(
  workspaceId: string,
  channelIds: string[],
  limit = 7,
): Promise<ChannelSparklineRow[]> {
  const uniqueChannelIds = Array.from(new Set(channelIds)).filter(
    (channelId) => channelId.length > 0,
  );
  if (uniqueChannelIds.length === 0) {
    return [];
  }

  const safeLimit = Math.max(1, Math.min(30, limit));
  const result = await pool.query<{
    channel_id: string;
    bucket: Date;
    anger_count: string;
    disgust_count: string;
    fear_count: string;
    joy_count: string;
    neutral_count: string;
    sadness_count: string;
    surprise_count: string;
  }>(
    `SELECT
       ma.channel_id,
       date_trunc('day', TO_TIMESTAMP(m.ts::double precision)) AS bucket,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'anger') AS anger_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'disgust') AS disgust_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'fear') AS fear_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'joy') AS joy_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'neutral') AS neutral_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'sadness') AS sadness_count,
       COUNT(*) FILTER (WHERE ma.dominant_emotion = 'surprise') AS surprise_count
     FROM message_analytics ma
     INNER JOIN messages m
       ON m.workspace_id = ma.workspace_id
      AND m.channel_id = ma.channel_id
      AND m.ts = ma.message_ts
     WHERE ma.workspace_id = $1
       AND ma.channel_id = ANY($2)
       AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(days => $3)
     GROUP BY ma.channel_id, bucket
     ORDER BY ma.channel_id, bucket DESC`,
    [workspaceId, uniqueChannelIds, safeLimit],
  );

  const sparklineMap = new Map<string, number[]>();

  for (const row of result.rows) {
    const sparkline = sparklineMap.get(row.channel_id) ?? [];
    if (sparkline.length >= safeLimit) {
      continue;
    }

    const positive = parseInt(row.joy_count, 10) || 0;
    const negative =
      (parseInt(row.anger_count, 10) || 0) +
      (parseInt(row.disgust_count, 10) || 0) +
      (parseInt(row.sadness_count, 10) || 0) +
      (parseInt(row.fear_count, 10) || 0);
    const neutral =
      (parseInt(row.neutral_count, 10) || 0) +
      (parseInt(row.surprise_count, 10) || 0);
    const total = positive + negative + neutral;

    sparkline.push(total > 0 ? (positive * 1.0 + neutral * 0.5) / total : 0.5);
    sparklineMap.set(row.channel_id, sparkline);
  }

  return uniqueChannelIds.map((channelId) => ({
    channelId,
    sparkline: [...(sparklineMap.get(channelId) ?? [])].reverse(),
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
  avgSentiment: number;
  highRiskCount: number;
  openFollowUpCount: number;
  highSeverityFollowUpCount: number;
  flaggedMessageCount: number;
  totalCostUsd: number;
  costTodayUsd: number;
  activeChannels: number;
  teamHealth: number;
}

export interface UserSentimentSummary {
  userId: string;
  totalMessages: number;
  negativeCount: number;
  dominantEmotion: string;
  avgConfidence: number;
  frustrationScore: number; // 0-100, higher = more frustrated
}

/**
 * Per-user sentiment breakdown for a channel.
 * Returns frustration score based on negative emotion ratio + escalation involvement.
 */
export async function getUserSentimentSummaries(
  workspaceId: string,
  channelId: string,
): Promise<UserSentimentSummary[]> {
  const result = await pool.query<{
    user_id: string;
    total: string;
    negative_count: string;
    dominant_emotion: string;
    avg_confidence: number;
    high_risk_count: string;
  }>(
    `SELECT
       m.user_id,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE ma.dominant_emotion IN ('anger', 'sadness', 'fear', 'disgust')) AS negative_count,
       MODE() WITHIN GROUP (ORDER BY ma.dominant_emotion) AS dominant_emotion,
       ROUND(AVG(ma.confidence)::numeric, 2) AS avg_confidence,
       COUNT(*) FILTER (WHERE ma.escalation_risk = 'high') AS high_risk_count
     FROM message_analytics ma
     JOIN messages m
       ON m.workspace_id = ma.workspace_id
      AND m.channel_id = ma.channel_id
      AND m.ts = ma.message_ts
     WHERE ma.workspace_id = $1
       AND ma.channel_id = $2
     GROUP BY m.user_id`,
    [workspaceId, channelId],
  );

  return result.rows.map((r) => {
    const total = parseInt(r.total, 10);
    const negCount = parseInt(r.negative_count, 10);
    const highRisk = parseInt(r.high_risk_count, 10);
    // Frustration = (negative ratio * 70) + (high risk involvement * 30), capped at 100
    const negativeRatio = total > 0 ? negCount / total : 0;
    const riskPenalty = Math.min(30, highRisk * 10);
    const frustrationScore = Math.round(Math.min(100, negativeRatio * 70 + riskPenalty));

    return {
      userId: r.user_id,
      totalMessages: total,
      negativeCount: negCount,
      dominantEmotion: r.dominant_emotion,
      avgConfidence: Number(r.avg_confidence),
      frustrationScore,
    };
  });
}

export async function getAnalyticsOverview(
  workspaceId: string,
): Promise<AnalyticsOverview> {
  const recentWindowSql = `NOW() - INTERVAL '24 hours'`;
  const [
    msgResult,
    analyticsResult,
    emotionResult,
    riskResult,
    costResult,
    todayCostResult,
    channelResult,
    channelHealthResult,
    followUpResult,
    highSeverityFollowUpResult,
    flaggedMessageResult,
  ] =
    await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE workspace_id = $1
           AND TO_TIMESTAMP(ts::double precision) >= ${recentWindowSql}`,
        [workspaceId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM message_analytics ma
         INNER JOIN messages m
           ON m.workspace_id = ma.workspace_id
          AND m.channel_id = ma.channel_id
          AND m.ts = ma.message_ts
         WHERE ma.workspace_id = $1
           AND TO_TIMESTAMP(m.ts::double precision) >= ${recentWindowSql}`,
        [workspaceId],
      ),
      pool.query<{ dominant_emotion: string; count: string }>(
        `SELECT ma.dominant_emotion, COUNT(*) AS count
         FROM message_analytics ma
         INNER JOIN messages m
           ON m.workspace_id = ma.workspace_id
          AND m.channel_id = ma.channel_id
          AND m.ts = ma.message_ts
         WHERE ma.workspace_id = $1
           AND TO_TIMESTAMP(m.ts::double precision) >= ${recentWindowSql}
         GROUP BY ma.dominant_emotion`,
        [workspaceId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM message_analytics ma
         INNER JOIN messages m
           ON m.workspace_id = ma.workspace_id
          AND m.channel_id = ma.channel_id
          AND m.ts = ma.message_ts
         WHERE ma.workspace_id = $1
           AND ma.escalation_risk = 'high'
           AND TO_TIMESTAMP(m.ts::double precision) >= ${recentWindowSql}`,
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
      pool.query<{
        attention_count: string;
        at_risk_count: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE cs.health = 'attention') AS attention_count,
           COUNT(*) FILTER (WHERE cs.health = 'at-risk') AS at_risk_count
         FROM channels c
         LEFT JOIN channel_state cs
           ON cs.workspace_id = c.workspace_id
          AND cs.channel_id = c.channel_id
         WHERE c.workspace_id = $1
           AND c.status = 'ready'`,
        [workspaceId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM follow_up_items
         WHERE workspace_id = $1
           AND status = 'open'
           AND created_at >= ${recentWindowSql}`,
        [workspaceId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM follow_up_items
         WHERE workspace_id = $1
           AND status = 'open'
           AND seriousness = 'high'
           AND created_at >= ${recentWindowSql}
           AND (snoozed_until IS NULL OR snoozed_until <= NOW())`,
        [workspaceId],
      ),
      pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count
         FROM message_analytics ma
         INNER JOIN messages m
           ON m.workspace_id = ma.workspace_id
          AND m.channel_id = ma.channel_id
          AND m.ts = ma.message_ts
         WHERE ma.workspace_id = $1
           AND ma.escalation_risk IN ('medium', 'high')
           AND TO_TIMESTAMP(m.ts::double precision) >= ${recentWindowSql}`,
        [workspaceId],
      ),
    ]);

  const emotionDistribution: Record<string, number> = {};
  for (const row of emotionResult.rows) {
    emotionDistribution[row.dominant_emotion] = parseInt(row.count, 10);
  }

  const totalEmotions = Object.values(emotionDistribution).reduce((sum, count) => sum + count, 0);
  const weightedEmotionTotal =
    (emotionDistribution.anger ?? 0) * 0 +
    (emotionDistribution.disgust ?? 0) * 0.1 +
    (emotionDistribution.fear ?? 0) * 0.2 +
    (emotionDistribution.joy ?? 0) * 1 +
    (emotionDistribution.neutral ?? 0) * 0.55 +
    (emotionDistribution.sadness ?? 0) * 0.25 +
    (emotionDistribution.surprise ?? 0) * 0.6;
  const avgSentiment =
    totalEmotions === 0
      ? 0.5
      : Math.round((weightedEmotionTotal / totalEmotions) * 100) / 100;

  const atRiskChannelCount = parseInt(channelHealthResult.rows[0]?.at_risk_count ?? "0", 10);
  const attentionChannelCount = parseInt(
    channelHealthResult.rows[0]?.attention_count ?? "0",
    10,
  );
  const openFollowUpCount = parseInt(followUpResult.rows[0].count, 10);
  const highSeverityFollowUpCount = parseInt(highSeverityFollowUpResult.rows[0].count, 10);
  const flaggedMessageCount = parseInt(flaggedMessageResult.rows[0].count, 10);

  const channelPenalty = Math.min(60, atRiskChannelCount * 25 + attentionChannelCount * 10);
  const alertPenalty = Math.min(
    25,
    highSeverityFollowUpCount * 6 +
      Math.max(0, openFollowUpCount - highSeverityFollowUpCount) * 2,
  );
  const flagPenalty = Math.min(15, flaggedMessageCount * 1.5);
  const teamHealth = Math.round(
    Math.max(0, Math.min(100, 100 - channelPenalty - alertPenalty - flagPenalty)),
  );

  return {
    totalMessages: parseInt(msgResult.rows[0].count, 10),
    totalAnalyses: parseInt(analyticsResult.rows[0].count, 10),
    emotionDistribution,
    avgSentiment,
    highRiskCount: parseInt(riskResult.rows[0].count, 10),
    openFollowUpCount,
    highSeverityFollowUpCount,
    flaggedMessageCount,
    totalCostUsd: parseFloat(costResult.rows[0].total),
    costTodayUsd: parseFloat(todayCostResult.rows[0].total),
    activeChannels: parseInt(channelResult.rows[0].count, 10),
    teamHealth,
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

export interface ParticipantSignalRow {
  user_id: string;
  dominant_emotion: DominantEmotion;
  escalation_risk: EscalationRisk;
  message_ts: string;
  rn: number;
}

export async function getRecentParticipantSignals(
  workspaceId: string,
  channelId: string,
  limitPerUser: number = 6,
): Promise<ParticipantSignalRow[]> {
  const safeLimit = Math.max(2, Math.min(12, limitPerUser));
  const result = await pool.query<ParticipantSignalRow>(
    `SELECT ranked.user_id,
            ranked.dominant_emotion,
            ranked.escalation_risk,
            ranked.message_ts,
            ranked.rn
     FROM (
       SELECT m.user_id,
              ma.dominant_emotion,
              ma.escalation_risk,
              ma.message_ts,
              ROW_NUMBER() OVER (
                PARTITION BY m.user_id
                ORDER BY m.ts::double precision DESC, ma.created_at DESC
              ) AS rn
       FROM message_analytics ma
       INNER JOIN messages m
         ON m.workspace_id = ma.workspace_id
        AND m.channel_id = ma.channel_id
        AND m.ts = ma.message_ts
       WHERE ma.workspace_id = $1
         AND ma.channel_id = $2
     ) ranked
     WHERE ranked.rn <= $3
     ORDER BY ranked.user_id ASC, ranked.rn ASC`,
    [workspaceId, channelId, safeLimit],
  );
  return result.rows;
}

export interface RoleInferenceSignalRow {
  user_id: string;
  display_name: string | null;
  real_name: string | null;
  profile_image: string | null;
  email: string | null;
  is_admin: boolean;
  is_owner: boolean;
  is_bot: boolean;
  message_count: number;
  reply_count: number;
  follow_up_request_count: number;
  follow_up_resolution_count: number;
  decision_signal_count: number;
  high_risk_count: number;
  channel_count: number;
  last_message_ts: string | null;
}

export async function getRoleInferenceSignals(
  workspaceId: string,
): Promise<RoleInferenceSignalRow[]> {
  const result = await pool.query<{
    user_id: string;
    display_name: string | null;
    real_name: string | null;
    profile_image: string | null;
    email: string | null;
    is_admin: boolean;
    is_owner: boolean;
    is_bot: boolean;
    message_count: string;
    reply_count: string;
    follow_up_request_count: string;
    follow_up_resolution_count: string;
    decision_signal_count: string;
    high_risk_count: string;
    channel_count: string;
    last_message_ts: string | null;
  }>(
    `WITH users AS (
       SELECT DISTINCT workspace_id, user_id
       FROM messages
       WHERE workspace_id = $1
       UNION
       SELECT DISTINCT workspace_id, user_id
       FROM user_profiles
       WHERE workspace_id = $1
     ),
     message_stats AS (
       SELECT user_id,
              COUNT(*)::int AS message_count,
              COUNT(*) FILTER (WHERE thread_ts IS NOT NULL AND thread_ts <> ts)::int AS reply_count,
              COUNT(DISTINCT channel_id)::int AS channel_count,
              MAX(ts) AS last_message_ts
       FROM messages
       WHERE workspace_id = $1
       GROUP BY user_id
     ),
     request_stats AS (
       SELECT requester_user_id AS user_id,
              COUNT(*)::int AS follow_up_request_count
       FROM follow_up_items
       WHERE workspace_id = $1
       GROUP BY requester_user_id
     ),
     resolution_stats AS (
       SELECT m.user_id,
              COUNT(*)::int AS follow_up_resolution_count
       FROM follow_up_items fui
       INNER JOIN messages m
         ON m.workspace_id = fui.workspace_id
        AND m.channel_id = fui.channel_id
        AND m.ts = fui.resolved_message_ts
       WHERE fui.workspace_id = $1
         AND fui.status = 'resolved'
       GROUP BY m.user_id
     ),
     analytics_stats AS (
       SELECT m.user_id,
              COUNT(*) FILTER (WHERE ma.decision_signal)::int AS decision_signal_count,
              COUNT(*) FILTER (WHERE ma.escalation_risk = 'high')::int AS high_risk_count
       FROM message_analytics ma
       INNER JOIN messages m
         ON m.workspace_id = ma.workspace_id
        AND m.channel_id = ma.channel_id
        AND m.ts = ma.message_ts
       WHERE ma.workspace_id = $1
       GROUP BY m.user_id
     )
     SELECT u.user_id,
            up.display_name,
            up.real_name,
            up.profile_image,
            up.email,
            COALESCE(up.is_admin, FALSE) AS is_admin,
            COALESCE(up.is_owner, FALSE) AS is_owner,
            COALESCE(up.is_bot, FALSE) AS is_bot,
            COALESCE(ms.message_count, 0) AS message_count,
            COALESCE(ms.reply_count, 0) AS reply_count,
            COALESCE(rs.follow_up_request_count, 0) AS follow_up_request_count,
            COALESCE(res.follow_up_resolution_count, 0) AS follow_up_resolution_count,
            COALESCE(ast.decision_signal_count, 0) AS decision_signal_count,
            COALESCE(ast.high_risk_count, 0) AS high_risk_count,
            COALESCE(ms.channel_count, 0) AS channel_count,
            ms.last_message_ts
     FROM users u
     LEFT JOIN user_profiles up
       ON up.workspace_id = u.workspace_id
      AND up.user_id = u.user_id
     LEFT JOIN message_stats ms
       ON ms.user_id = u.user_id
     LEFT JOIN request_stats rs
       ON rs.user_id = u.user_id
     LEFT JOIN resolution_stats res
       ON res.user_id = u.user_id
     LEFT JOIN analytics_stats ast
       ON ast.user_id = u.user_id
     ORDER BY COALESCE(ms.message_count, 0) DESC, u.user_id ASC`,
    [workspaceId],
  );

  return result.rows.map((row) => ({
    ...row,
    message_count: parseInt(row.message_count, 10),
    reply_count: parseInt(row.reply_count, 10),
    follow_up_request_count: parseInt(row.follow_up_request_count, 10),
    follow_up_resolution_count: parseInt(row.follow_up_resolution_count, 10),
    decision_signal_count: parseInt(row.decision_signal_count, 10),
    high_risk_count: parseInt(row.high_risk_count, 10),
    channel_count: parseInt(row.channel_count, 10),
  }));
}

export async function listRoleAssignments(
  workspaceId: string,
): Promise<RoleAssignmentRow[]> {
  const result = await pool.query<RoleAssignmentRow>(
    `SELECT *
     FROM role_assignments
     WHERE workspace_id = $1
     ORDER BY updated_at DESC, user_id ASC`,
    [workspaceId],
  );
  return result.rows;
}

export async function listConfirmedRoleAssignments(
  workspaceId: string,
): Promise<RoleAssignmentRow[]> {
  const result = await pool.query<RoleAssignmentRow>(
    `SELECT *
     FROM role_assignments
     WHERE workspace_id = $1
       AND review_state = 'confirmed'
     ORDER BY updated_at DESC, user_id ASC`,
    [workspaceId],
  );
  return result.rows;
}

export async function upsertRoleAssignment(input: {
  workspaceId: string;
  userId: string;
  role: UserRole;
  source: RoleAssignmentSource;
  reviewState: RoleReviewState;
  confidence: number;
  reasons: string[];
  displayLabel?: string | null;
}): Promise<RoleAssignmentRow> {
  const result = await pool.query<RoleAssignmentRow>(
    `INSERT INTO role_assignments (
       workspace_id, user_id, role, source, review_state, confidence, reasons_json, display_label
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     ON CONFLICT (workspace_id, user_id, role) DO UPDATE
       SET source = EXCLUDED.source,
           review_state = EXCLUDED.review_state,
           confidence = EXCLUDED.confidence,
           reasons_json = EXCLUDED.reasons_json,
           display_label = COALESCE(EXCLUDED.display_label, role_assignments.display_label),
           updated_at = NOW()
     RETURNING *`,
    [
      input.workspaceId,
      input.userId,
      input.role,
      input.source,
      input.reviewState,
      input.confidence,
      JSON.stringify(input.reasons),
      input.displayLabel ?? null,
    ],
  );

  return result.rows[0];
}

export async function clearRoleAssignmentsForUser(
  workspaceId: string,
  userId: string,
): Promise<void> {
  await pool.query(
    `DELETE FROM role_assignments
     WHERE workspace_id = $1
       AND user_id = $2
       AND source = 'manual'`,
    [workspaceId, userId],
  );
}

// ─── Channel members ────────────────────────────────────────────────────────

export async function syncChannelMembers(
  workspaceId: string,
  channelId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) {
    await pool.query(
      `DELETE FROM channel_members WHERE workspace_id = $1 AND channel_id = $2`,
      [workspaceId, channelId],
    );
    return;
  }

  await pool.query(
    `DELETE FROM channel_members
     WHERE workspace_id = $1 AND channel_id = $2
       AND user_id != ALL($3::text[])`,
    [workspaceId, channelId, userIds],
  );

  const values: string[] = [];
  const params: unknown[] = [workspaceId, channelId];
  let paramIdx = 3;
  for (const userId of userIds) {
    values.push(`($1, $2, $${paramIdx})`);
    params.push(userId);
    paramIdx += 1;
  }

  await pool.query(
    `INSERT INTO channel_members (workspace_id, channel_id, user_id)
     VALUES ${values.join(", ")}
     ON CONFLICT (workspace_id, channel_id, user_id)
       DO UPDATE SET fetched_at = NOW()`,
    params,
  );
}

export async function getChannelMembers(
  workspaceId: string,
  channelId: string,
): Promise<ChannelMemberRow[]> {
  const result = await pool.query<ChannelMemberRow>(
    `SELECT * FROM channel_members
     WHERE workspace_id = $1 AND channel_id = $2
     ORDER BY created_at ASC`,
    [workspaceId, channelId],
  );
  return result.rows;
}

export interface ChannelMemberWithProfileRow {
  user_id: string;
  display_name: string | null;
  real_name: string | null;
  profile_image: string | null;
  email: string | null;
  is_bot: boolean;
  fetched_at: Date;
}

export async function getChannelMembersWithProfiles(
  workspaceId: string,
  channelId: string,
): Promise<ChannelMemberWithProfileRow[]> {
  const result = await pool.query<ChannelMemberWithProfileRow>(
    `SELECT cm.user_id,
            up.display_name,
            up.real_name,
            up.profile_image,
            up.email,
            COALESCE(up.is_bot, false) AS is_bot,
            cm.fetched_at
     FROM channel_members cm
     LEFT JOIN user_profiles up
       ON up.workspace_id = cm.workspace_id AND up.user_id = cm.user_id
     WHERE cm.workspace_id = $1 AND cm.channel_id = $2
     ORDER BY up.display_name ASC NULLS LAST, cm.user_id ASC`,
    [workspaceId, channelId],
  );
  return result.rows;
}

export async function getRoleAssignmentsForUsers(
  workspaceId: string,
  userIds: string[],
): Promise<RoleAssignmentRow[]> {
  if (userIds.length === 0) return [];
  const result = await pool.query<RoleAssignmentRow>(
    `SELECT *
     FROM role_assignments
     WHERE workspace_id = $1
       AND user_id = ANY($2::text[])
       AND review_state = 'confirmed'
     ORDER BY user_id ASC`,
    [workspaceId, userIds],
  );
  return result.rows;
}

export interface FollowUpRuleWithChannelRow extends FollowUpRuleRow {
  channel_name: string | null;
}

function normalizeAnalysisWindowDays(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return config.SUMMARY_WINDOW_DAYS;
  }

  return Math.max(1, Math.min(30, Math.trunc(value as number)));
}

export async function getEffectiveAnalysisWindowDays(
  workspaceId: string,
  channelId: string,
): Promise<number> {
  const result = await pool.query<{ analysis_window_days: number | null }>(
    `SELECT COALESCE(analysis_window_days, $3::int) AS analysis_window_days
     FROM follow_up_rules
     WHERE workspace_id = $1
       AND channel_id = $2`,
    [workspaceId, channelId, config.SUMMARY_WINDOW_DAYS],
  );
  return normalizeAnalysisWindowDays(result.rows[0]?.analysis_window_days);
}

export async function getFollowUpRule(
  workspaceId: string,
  channelId: string,
): Promise<FollowUpRuleRow | null> {
  const result = await pool.query<FollowUpRuleRow>(
    `SELECT *
     FROM follow_up_rules
     WHERE workspace_id = $1
       AND channel_id = $2`,
    [workspaceId, channelId],
  );
  return result.rows[0] ?? null;
}

export async function listFollowUpRules(
  workspaceId: string,
): Promise<FollowUpRuleWithChannelRow[]> {
  const result = await pool.query<FollowUpRuleWithChannelRow>(
    `SELECT fur.*, c.name AS channel_name
     FROM follow_up_rules fur
     LEFT JOIN channels c
       ON c.workspace_id = fur.workspace_id
      AND c.channel_id = fur.channel_id
     WHERE fur.workspace_id = $1
     ORDER BY c.name ASC NULLS LAST, fur.channel_id ASC`,
    [workspaceId],
  );
  return result.rows;
}

export async function listConversationPolicies(
  workspaceId: string,
): Promise<FollowUpRuleWithChannelRow[]> {
  const [channels, rules] = await Promise.all([
    getAllChannelsWithState(workspaceId),
    listFollowUpRules(workspaceId),
  ]);

  const ruleMap = new Map(rules.map((rule) => [rule.channel_id, rule]));

  return channels.map((channel) => {
    const rule = ruleMap.get(channel.channel_id);
    return {
      id: rule?.id ?? "",
      workspace_id: workspaceId,
      channel_id: channel.channel_id,
      channel_name: channel.name ?? null,
      conversation_type: rule?.conversation_type ?? channel.conversation_type,
      enabled: rule?.enabled ?? true,
      sla_hours: rule?.sla_hours ?? 48,
      analysis_window_days: rule?.analysis_window_days ?? config.SUMMARY_WINDOW_DAYS,
      owner_user_ids: rule?.owner_user_ids ?? [],
      client_user_ids: rule?.client_user_ids ?? [],
      senior_user_ids: rule?.senior_user_ids ?? [],
      importance_tier_override: rule?.importance_tier_override ?? "auto",
      channel_mode_override: rule?.channel_mode_override ?? "auto",
      slack_notifications_enabled: rule?.slack_notifications_enabled ?? true,
      muted: rule?.muted ?? false,
      privacy_opt_in: rule?.privacy_opt_in ?? false,
      created_at: rule?.created_at ?? new Date(0),
      updated_at: rule?.updated_at ?? new Date(0),
    };
  });
}

export async function upsertFollowUpRule(input: {
  workspaceId: string;
  channelId: string;
  enabled: boolean;
  slaHours: number;
  analysisWindowDays: number;
  ownerUserIds: string[];
  clientUserIds: string[];
  seniorUserIds?: string[];
  importanceTierOverride?: ImportanceTierOverride;
  channelModeOverride?: ChannelModeOverride;
  slackNotificationsEnabled?: boolean;
  muted?: boolean;
  privacyOptIn?: boolean;
  conversationType?: ConversationType;
}): Promise<FollowUpRuleRow> {
  const result = await pool.query<FollowUpRuleRow>(
    `INSERT INTO follow_up_rules (
       workspace_id,
       channel_id,
       conversation_type,
       enabled,
       sla_hours,
       analysis_window_days,
       owner_user_ids,
       client_user_ids,
       senior_user_ids,
       importance_tier_override,
       channel_mode_override,
       slack_notifications_enabled,
       muted,
       privacy_opt_in
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)
     ON CONFLICT (workspace_id, channel_id) DO UPDATE
       SET conversation_type = EXCLUDED.conversation_type,
           enabled = EXCLUDED.enabled,
           sla_hours = EXCLUDED.sla_hours,
           analysis_window_days = EXCLUDED.analysis_window_days,
           owner_user_ids = EXCLUDED.owner_user_ids,
           client_user_ids = EXCLUDED.client_user_ids,
           senior_user_ids = EXCLUDED.senior_user_ids,
           importance_tier_override = EXCLUDED.importance_tier_override,
           channel_mode_override = EXCLUDED.channel_mode_override,
           slack_notifications_enabled = EXCLUDED.slack_notifications_enabled,
           muted = EXCLUDED.muted,
           privacy_opt_in = EXCLUDED.privacy_opt_in,
           updated_at = NOW()
     RETURNING *`,
    [
      input.workspaceId,
      input.channelId,
      input.conversationType ?? "public_channel",
      input.enabled,
      input.slaHours,
      input.analysisWindowDays,
      JSON.stringify(input.ownerUserIds),
      JSON.stringify(input.clientUserIds),
      JSON.stringify(input.seniorUserIds ?? []),
      input.importanceTierOverride ?? "auto",
      input.channelModeOverride ?? "auto",
      input.slackNotificationsEnabled ?? true,
      input.muted ?? false,
      input.privacyOptIn ?? false,
    ],
  );
  return result.rows[0];
}

export interface FollowUpItemWithContextRow extends FollowUpItemRow {
  channel_name: string | null;
  conversation_type: string | null;
  requester_display_name: string | null;
  requester_real_name: string | null;
  source_message_text: string | null;
}

function serializeStringArray(values: string[] | null | undefined): string {
  return JSON.stringify([...(values ?? []).filter((value) => typeof value === "string" && value.length > 0)]);
}

export async function recordFollowUpEvent(input: {
  followUpItemId: string;
  workspaceId: string;
  channelId: string;
  eventType:
    | "created"
    | "acknowledged"
    | "escalated"
    | "resolved"
    | "reopened"
    | "snoozed"
    | "dismissed"
    | "expired";
  workflowState?: FollowUpWorkflowState | null;
  actorUserId?: string | null;
  messageTs?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query<FollowUpEventRow>(
    `INSERT INTO follow_up_events (
       follow_up_item_id,
       workspace_id,
       channel_id,
       event_type,
       workflow_state,
       actor_user_id,
       message_ts,
       metadata_json
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.followUpItemId,
      input.workspaceId,
      input.channelId,
      input.eventType,
      input.workflowState ?? null,
      input.actorUserId ?? null,
      input.messageTs ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
}

export async function getOpenFollowUpForRequesterContext(
  workspaceId: string,
  channelId: string,
  requesterUserId: string,
  threadTs: string | null,
): Promise<FollowUpItemRow | null> {
  const result = await pool.query<FollowUpItemRow>(
    `SELECT *
     FROM follow_up_items
     WHERE workspace_id = $1
       AND channel_id = $2
       AND requester_user_id = $3
       AND status = 'open'
       AND workflow_state <> 'resolved'
       AND workflow_state <> 'dismissed'
       AND workflow_state <> 'expired'
       AND (snoozed_until IS NULL OR snoozed_until <= NOW())
       AND (
         ($4::text IS NOT NULL AND source_thread_ts = $4)
         OR ($4::text IS NULL AND source_thread_ts IS NULL)
       )
     ORDER BY updated_at DESC
     LIMIT 1`,
    [workspaceId, channelId, requesterUserId, threadTs],
  );
  return result.rows[0] ?? null;
}

export async function getOpenFollowUpBySourceMessage(
  workspaceId: string,
  channelId: string,
  sourceMessageTs: string,
): Promise<FollowUpItemRow | null> {
  const result = await pool.query<FollowUpItemRow>(
    `SELECT *
     FROM follow_up_items
     WHERE workspace_id = $1
       AND channel_id = $2
       AND source_message_ts = $3
       AND status = 'open'
       AND workflow_state <> 'dismissed'
       AND workflow_state <> 'expired'
     LIMIT 1`,
    [workspaceId, channelId, sourceMessageTs],
  );
  return result.rows[0] ?? null;
}

export async function getFollowUpItem(
  workspaceId: string,
  itemId: string,
): Promise<FollowUpItemRow | null> {
  const result = await pool.query<FollowUpItemRow>(
    `SELECT *
     FROM follow_up_items
     WHERE workspace_id = $1
       AND id = $2
     LIMIT 1`,
    [workspaceId, itemId],
  );

  return result.rows[0] ?? null;
}

export async function listOpenFollowUpsForResolutionContext(
  workspaceId: string,
  channelId: string,
  threadTs: string | null,
  replyTs: string,
): Promise<FollowUpItemRow[]> {
  const result = await pool.query<FollowUpItemRow>(
    `SELECT *
     FROM follow_up_items
     WHERE workspace_id = $1
       AND channel_id = $2
       AND status = 'open'
       AND workflow_state <> 'dismissed'
       AND workflow_state <> 'expired'
       AND (snoozed_until IS NULL OR snoozed_until <= NOW())
       AND source_message_ts::double precision < $4::double precision
       AND (
         ($3::text IS NOT NULL AND source_thread_ts = $3)
         OR ($3::text IS NULL AND source_thread_ts IS NULL)
         OR ($3::text IS NOT NULL AND source_message_ts = $3 AND source_thread_ts IS NULL)
       )
     ORDER BY due_at ASC, created_at ASC`,
    [workspaceId, channelId, threadTs, replyTs],
  );
  return result.rows;
}

export async function listOpenFollowUpsForChannelResolution(
  workspaceId: string,
  channelId: string,
  replyTs: string,
): Promise<FollowUpItemRow[]> {
  const result = await pool.query<FollowUpItemRow>(
    `SELECT *
     FROM follow_up_items
     WHERE workspace_id = $1
       AND channel_id = $2
       AND status = 'open'
       AND workflow_state <> 'dismissed'
       AND workflow_state <> 'expired'
       AND (snoozed_until IS NULL OR snoozed_until <= NOW())
       AND source_message_ts::double precision < $3::double precision
     ORDER BY COALESCE(last_request_ts, source_message_ts)::double precision DESC, created_at DESC`,
    [workspaceId, channelId, replyTs],
  );
  return result.rows;
}

/**
 * Find all open follow-ups for a specific source message (used for reaction-based resolution).
 */
export async function listOpenFollowUpsBySourceMessage(
  workspaceId: string,
  channelId: string,
  sourceMessageTs: string,
): Promise<FollowUpItemRow[]> {
  const result = await pool.query<FollowUpItemRow>(
    `SELECT *
     FROM follow_up_items
     WHERE workspace_id = $1
       AND channel_id = $2
       AND source_message_ts = $3
       AND status = 'open'
       AND workflow_state <> 'dismissed'
       AND workflow_state <> 'expired'`,
    [workspaceId, channelId, sourceMessageTs],
  );
  return result.rows;
}

export async function listOpenFollowUpsByResponderMessage(
  workspaceId: string,
  channelId: string,
  responderMessageTs: string,
): Promise<FollowUpItemRow[]> {
  const result = await pool.query<FollowUpItemRow>(
    `SELECT *
     FROM follow_up_items
     WHERE workspace_id = $1
       AND channel_id = $2
       AND status = 'open'
       AND workflow_state IN ('acknowledged_waiting', 'escalated')
       AND last_responder_message_ts = $3`,
    [workspaceId, channelId, responderMessageTs],
  );

  return result.rows;
}

export async function listResolvedFollowUpsByResolvedMessage(
  workspaceId: string,
  channelId: string,
  resolvedMessageTs: string,
): Promise<FollowUpItemRow[]> {
  const result = await pool.query<FollowUpItemRow>(
    `SELECT *
     FROM follow_up_items
     WHERE workspace_id = $1
       AND channel_id = $2
       AND status = 'resolved'
       AND resolved_message_ts = $3
       AND resolution_reason IN ('reply', 'requester_ack')`,
    [workspaceId, channelId, resolvedMessageTs],
  );

  return result.rows;
}

/**
 * Auto-expire stale follow-up items that have been open longer than maxAgeMs.
 * Records resolution_reason: "expired" in metadata_json for audit trail.
 */
export async function expireStaleFollowUpItems(
  maxAgeMs: number,
): Promise<number> {
  const result = await pool.query(
    `UPDATE follow_up_items
     SET status = 'resolved',
         workflow_state = 'expired',
         resolution_reason = 'expired',
         resolution_scope = 'system',
         resolved_by_user_id = NULL,
         last_engagement_at = COALESCE(last_engagement_at, NOW()),
         resolved_at = NOW(),
         updated_at = NOW()
     WHERE status = 'open'
       AND created_at < NOW() - make_interval(secs => $1 / 1000.0)`,
    [maxAgeMs],
  );
  return result.rowCount ?? 0;
}

export async function createFollowUpItem(input: {
  workspaceId: string;
  channelId: string;
  sourceMessageTs: string;
  sourceThreadTs: string | null;
  requesterUserId: string;
  seriousness: FollowUpSeriousness;
  seriousnessScore: number;
  detectionMode: FollowUpDetectionMode;
  reasonCodes: string[];
  summary: string;
  dueAt: Date;
  workflowState?: FollowUpWorkflowState;
  primaryResponderIds?: string[];
  escalationResponderIds?: string[];
  visibilityAfter?: Date | null;
  nextExpectedResponseAt?: Date | null;
  metadata?: Record<string, unknown>;
}): Promise<FollowUpItemRow> {
  const result = await pool.query<FollowUpItemRow>(
    `INSERT INTO follow_up_items (
       workspace_id,
       channel_id,
       source_message_ts,
       source_thread_ts,
       requester_user_id,
       seriousness,
       seriousness_score,
       detection_mode,
       reason_codes,
       summary,
       due_at,
       workflow_state,
       primary_responder_ids,
       escalation_responder_ids,
       visibility_after,
       next_expected_response_at,
       last_request_ts,
       metadata_json
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9::jsonb, $10, $11, $12, $13::jsonb, $14::jsonb, $15, $16, $3, $17::jsonb
     )
     ON CONFLICT (workspace_id, channel_id, source_message_ts) DO UPDATE
       SET seriousness = EXCLUDED.seriousness,
           seriousness_score = EXCLUDED.seriousness_score,
           detection_mode = EXCLUDED.detection_mode,
           reason_codes = EXCLUDED.reason_codes,
           summary = EXCLUDED.summary,
           due_at = EXCLUDED.due_at,
           workflow_state = CASE
             WHEN follow_up_items.status = 'open' THEN EXCLUDED.workflow_state
             ELSE follow_up_items.workflow_state
           END,
           primary_responder_ids = EXCLUDED.primary_responder_ids,
           escalation_responder_ids = EXCLUDED.escalation_responder_ids,
           visibility_after = COALESCE(EXCLUDED.visibility_after, follow_up_items.visibility_after),
           next_expected_response_at = COALESCE(EXCLUDED.next_expected_response_at, follow_up_items.next_expected_response_at),
           metadata_json = EXCLUDED.metadata_json,
           updated_at = NOW()
     RETURNING *`,
    [
      input.workspaceId,
      input.channelId,
      input.sourceMessageTs,
      input.sourceThreadTs,
      input.requesterUserId,
      input.seriousness,
      input.seriousnessScore,
      input.detectionMode,
      JSON.stringify(input.reasonCodes),
      input.summary,
      input.dueAt,
      input.workflowState ?? "pending_reply_window",
      serializeStringArray(input.primaryResponderIds),
      serializeStringArray(input.escalationResponderIds),
      input.visibilityAfter ?? null,
      input.nextExpectedResponseAt ?? null,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return result.rows[0];
}

export async function bumpFollowUpItem(input: {
  itemId: string;
  lastRequestTs: string;
  seriousness: FollowUpSeriousness;
  seriousnessScore: number;
  reasonCodes: string[];
  summary: string;
  dueAt?: Date | null;
  workflowState?: FollowUpWorkflowState;
  visibilityAfter?: Date | null;
  nextExpectedResponseAt?: Date | null;
}): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET repeated_ask_count = repeated_ask_count + 1,
         last_request_ts = $2,
         seriousness = $3,
         seriousness_score = $4,
         reason_codes = $5::jsonb,
         summary = $6,
         due_at = COALESCE($7, due_at),
         workflow_state = COALESCE($8, workflow_state),
         visibility_after = COALESCE($9, visibility_after),
         next_expected_response_at = COALESCE($10, next_expected_response_at),
         resolved_at = NULL,
         resolved_message_ts = NULL,
         resolution_reason = NULL,
         resolution_scope = NULL,
         resolved_by_user_id = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [
      input.itemId,
      input.lastRequestTs,
      input.seriousness,
      input.seriousnessScore,
      JSON.stringify(input.reasonCodes),
      input.summary,
      input.dueAt ?? null,
      input.workflowState ?? null,
      input.visibilityAfter ?? null,
      input.nextExpectedResponseAt ?? null,
    ],
  );
}

export async function reopenFollowUpItem(input: {
  itemId: string;
  lastRequestTs: string;
  seriousness: FollowUpSeriousness;
  seriousnessScore: number;
  reasonCodes: string[];
  summary: string;
  workflowState: FollowUpWorkflowState;
  dueAt: Date;
  visibilityAfter?: Date | null;
  nextExpectedResponseAt?: Date | null;
}): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET status = 'open',
         workflow_state = $3,
         seriousness = $4,
         seriousness_score = $5,
         reason_codes = $6::jsonb,
         summary = $7,
         due_at = $8,
         visibility_after = COALESCE($9, visibility_after),
         next_expected_response_at = COALESCE($10, next_expected_response_at),
         last_request_ts = $2,
         repeated_ask_count = repeated_ask_count + 1,
         acknowledged_at = NULL,
         acknowledged_by_user_id = NULL,
         acknowledgment_source = NULL,
         escalated_at = CASE WHEN $3 = 'escalated' THEN NOW() ELSE NULL END,
         resolved_at = NULL,
         resolved_message_ts = NULL,
         resolution_reason = NULL,
         resolution_scope = NULL,
         resolved_by_user_id = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [
      input.itemId,
      input.lastRequestTs,
      input.workflowState,
      input.seriousness,
      input.seriousnessScore,
      JSON.stringify(input.reasonCodes),
      input.summary,
      input.dueAt,
      input.visibilityAfter ?? null,
      input.nextExpectedResponseAt ?? null,
    ],
  );
}

export async function promoteFollowUpVisibility(
  itemId: string,
  workflowState: FollowUpWorkflowState,
): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET workflow_state = $2,
         visibility_after = COALESCE(visibility_after, NOW()),
         updated_at = NOW()
     WHERE id = $1`,
    [itemId, workflowState],
  );
}

export async function acknowledgeFollowUpItem(input: {
  itemId: string;
  dueAt: Date;
  acknowledgedAt: Date;
  acknowledgedByUserId?: string | null;
  acknowledgmentSource: FollowUpAcknowledgmentSource;
  responderMessageTs?: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET workflow_state = 'acknowledged_waiting',
         acknowledged_at = $2,
         acknowledged_by_user_id = $3,
         acknowledgment_source = $4,
         engaged_at = COALESCE(engaged_at, $2),
         last_engagement_at = $2,
         last_responder_user_id = COALESCE($3, last_responder_user_id),
         last_responder_message_ts = COALESCE($5, last_responder_message_ts),
         due_at = $6,
         next_expected_response_at = $6,
         ignored_score = 0,
         snoozed_until = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [
      input.itemId,
      input.acknowledgedAt,
      input.acknowledgedByUserId ?? null,
      input.acknowledgmentSource,
      input.responderMessageTs ?? null,
      input.dueAt,
    ],
  );
}

export async function escalateFollowUpItem(input: {
  itemId: string;
  dueAt?: Date | null;
  primaryMissedSla?: boolean;
}): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET workflow_state = 'escalated',
         escalated_at = COALESCE(escalated_at, NOW()),
         primary_missed_sla = COALESCE($3, primary_missed_sla),
         due_at = COALESCE($2, due_at),
         next_expected_response_at = COALESCE($2, next_expected_response_at),
         updated_at = NOW()
     WHERE id = $1`,
    [input.itemId, input.dueAt ?? null, input.primaryMissedSla ?? null],
  );
}

export async function markFollowUpWaiting(input: {
  itemId: string;
  dueAt?: Date | null;
  acknowledgedByUserId?: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET workflow_state = 'acknowledged_waiting',
         acknowledged_at = NOW(),
         acknowledged_by_user_id = COALESCE($3, acknowledged_by_user_id),
         acknowledgment_source = 'manual',
         due_at = COALESCE($2, due_at),
         next_expected_response_at = COALESCE($2, next_expected_response_at),
         updated_at = NOW()
     WHERE id = $1`,
    [input.itemId, input.dueAt ?? null, input.acknowledgedByUserId ?? null],
  );
}

export async function incrementFollowUpIgnoredScore(
  itemId: string,
): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET ignored_score = ignored_score + 1,
         updated_at = NOW()
     WHERE id = $1`,
    [itemId],
  );
}

export async function resolveFollowUpItem(
  input: {
    itemId: string;
    resolvedMessageTs?: string | null;
    resolutionReason: FollowUpResolutionReason;
    resolutionScope: FollowUpResolutionScope;
    resolvedByUserId?: string | null;
    lastEngagementAt?: Date | null;
    resolvedViaEscalation?: boolean;
    primaryMissedSla?: boolean;
  },
): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET status = 'resolved',
         workflow_state = CASE
           WHEN $3 = 'expired' THEN 'expired'
           ELSE 'resolved'
         END,
         resolved_message_ts = $2,
         resolution_reason = $3,
         resolution_scope = $4,
         resolved_by_user_id = $5,
         last_engagement_at = COALESCE($6, last_engagement_at),
         last_responder_user_id = COALESCE($5, last_responder_user_id),
         last_responder_message_ts = COALESCE($2, last_responder_message_ts),
         resolved_via_escalation = COALESCE($7, resolved_via_escalation),
         primary_missed_sla = COALESCE($8, primary_missed_sla),
         snoozed_until = NULL,
         resolved_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [
      input.itemId,
      input.resolvedMessageTs ?? null,
      input.resolutionReason,
      input.resolutionScope,
      input.resolvedByUserId ?? null,
      input.lastEngagementAt ?? null,
      input.resolvedViaEscalation ?? null,
      input.primaryMissedSla ?? null,
    ],
  );
}

export async function resolveFollowUpItemManually(
  itemId: string,
  resolvedByUserId?: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET status = 'resolved',
         workflow_state = 'resolved',
         resolved_message_ts = NULL,
         resolution_reason = 'manual_done',
         resolution_scope = 'manual',
         resolved_by_user_id = $2,
         last_engagement_at = COALESCE(last_engagement_at, NOW()),
         snoozed_until = NULL,
         resolved_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [itemId, resolvedByUserId ?? null],
  );
}

export async function dismissFollowUpItem(
  itemId: string,
  dismissedByUserId?: string | null,
): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET status = 'dismissed',
         workflow_state = 'dismissed',
         resolution_reason = 'manual_dismissed',
         resolution_scope = 'manual',
         resolved_by_user_id = $2,
         last_engagement_at = COALESCE(last_engagement_at, NOW()),
         snoozed_until = NULL,
         dismissed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [itemId, dismissedByUserId ?? null],
  );
}

export async function snoozeFollowUpItem(
  itemId: string,
  snoozedUntil: Date,
): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET snoozed_until = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [itemId, snoozedUntil],
  );
}

export async function clearFollowUpSnooze(itemId: string): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET snoozed_until = NULL,
         updated_at = NOW()
     WHERE id = $1`,
    [itemId],
  );
}

export async function updateFollowUpSeverity(
  itemId: string,
  seriousness: FollowUpSeriousness,
  seriousnessScore: number,
  summary: string,
): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET seriousness = $2,
         seriousness_score = $3,
         summary = $4,
         updated_at = NOW()
     WHERE id = $1`,
    [itemId, seriousness, seriousnessScore, summary],
  );
}

export interface DmRef {
  userId: string;
  dmChannelId: string;
  messageTs: string;
}

export async function markFollowUpAlerted(
  itemId: string,
  dmRefs?: DmRef[],
): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET last_alerted_at = NOW(),
         alert_count = alert_count + 1,
         last_dm_refs = $2::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [itemId, JSON.stringify(dmRefs ?? [])],
  );
}

export async function getFollowUpDmRefs(itemId: string): Promise<DmRef[]> {
  const result = await pool.query<{ last_dm_refs: DmRef[] }>(
    `SELECT last_dm_refs FROM follow_up_items WHERE id = $1`,
    [itemId],
  );
  return result.rows[0]?.last_dm_refs ?? [];
}

export async function clearFollowUpDmRefs(itemId: string): Promise<void> {
  await pool.query(
    `UPDATE follow_up_items
     SET last_dm_refs = '[]'::jsonb,
         updated_at = NOW()
     WHERE id = $1`,
    [itemId],
  );
}

export async function listOpenFollowUpItems(
  workspaceId: string,
  limit: number = 50,
): Promise<FollowUpItemWithContextRow[]> {
  const safeLimit = Math.max(1, Math.min(200, limit));
  const result = await pool.query<FollowUpItemWithContextRow>(
    `SELECT fui.*, c.name AS channel_name, c.conversation_type,
            up.display_name AS requester_display_name,
            up.real_name AS requester_real_name, m.text AS source_message_text
     FROM follow_up_items fui
     LEFT JOIN channels c
       ON c.workspace_id = fui.workspace_id
      AND c.channel_id = fui.channel_id
     LEFT JOIN user_profiles up
       ON up.workspace_id = fui.workspace_id
      AND up.user_id = fui.requester_user_id
     LEFT JOIN messages m
       ON m.workspace_id = fui.workspace_id
      AND m.channel_id = fui.channel_id
      AND m.ts = fui.source_message_ts
     WHERE fui.workspace_id = $1
       AND fui.status = 'open'
       AND fui.workflow_state IN ('awaiting_primary', 'acknowledged_waiting', 'escalated')
       AND (fui.snoozed_until IS NULL OR fui.snoozed_until <= NOW())
       AND COALESCE(fui.visibility_after, fui.created_at) <= NOW()
     ORDER BY fui.seriousness_score DESC, fui.due_at ASC
     LIMIT $2`,
    [workspaceId, safeLimit],
  );
  return result.rows;
}

export async function listVisiblePendingFollowUpItems(
  limit: number = 100,
): Promise<FollowUpItemWithContextRow[]> {
  const safeLimit = Math.max(1, Math.min(500, limit));
  const result = await pool.query<FollowUpItemWithContextRow>(
    `SELECT fui.*, c.name AS channel_name, c.conversation_type,
            up.display_name AS requester_display_name,
            up.real_name AS requester_real_name, m.text AS source_message_text
     FROM follow_up_items fui
     LEFT JOIN channels c
       ON c.workspace_id = fui.workspace_id
      AND c.channel_id = fui.channel_id
     LEFT JOIN user_profiles up
       ON up.workspace_id = fui.workspace_id
      AND up.user_id = fui.requester_user_id
     LEFT JOIN messages m
       ON m.workspace_id = fui.workspace_id
      AND m.channel_id = fui.channel_id
      AND m.ts = fui.source_message_ts
     WHERE fui.status = 'open'
       AND fui.workflow_state = 'pending_reply_window'
       AND c.status = 'ready'
       AND COALESCE(fui.visibility_after, fui.created_at) <= NOW()
       AND (fui.snoozed_until IS NULL OR fui.snoozed_until <= NOW())
     ORDER BY fui.created_at ASC
     LIMIT $1
     FOR UPDATE OF fui SKIP LOCKED`,
    [safeLimit],
  );
  return result.rows;
}

export async function listDueFollowUpItems(
  limit: number = 100,
  repeatThresholdMs: number = 21600000,
): Promise<FollowUpItemWithContextRow[]> {
  const safeLimit = Math.max(1, Math.min(500, limit));
  const result = await pool.query<FollowUpItemWithContextRow>(
    `SELECT fui.*, c.name AS channel_name, c.conversation_type,
            up.display_name AS requester_display_name,
            up.real_name AS requester_real_name, m.text AS source_message_text
     FROM follow_up_items fui
     LEFT JOIN channels c
       ON c.workspace_id = fui.workspace_id
      AND c.channel_id = fui.channel_id
     LEFT JOIN user_profiles up
       ON up.workspace_id = fui.workspace_id
      AND up.user_id = fui.requester_user_id
     LEFT JOIN messages m
       ON m.workspace_id = fui.workspace_id
      AND m.channel_id = fui.channel_id
      AND m.ts = fui.source_message_ts
     WHERE fui.status = 'open'
       AND fui.workflow_state IN ('awaiting_primary', 'acknowledged_waiting', 'escalated')
       AND c.status = 'ready'
       AND (fui.snoozed_until IS NULL OR fui.snoozed_until <= NOW())
       AND COALESCE(fui.visibility_after, fui.created_at) <= NOW()
       AND fui.due_at <= NOW()
       AND (fui.last_alerted_at IS NULL OR fui.last_alerted_at < NOW() - make_interval(secs => $2 / 1000.0))
     ORDER BY fui.last_alerted_at ASC NULLS FIRST, fui.due_at ASC
     LIMIT $1
     FOR UPDATE OF fui SKIP LOCKED`,
    [safeLimit, repeatThresholdMs],
  );
  return result.rows;
}

export async function listRecentlyResolvedFollowUpItems(
  workspaceId: string,
  limit: number = 25,
): Promise<FollowUpItemWithContextRow[]> {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const result = await pool.query<FollowUpItemWithContextRow>(
    `SELECT fui.*, c.name AS channel_name, c.conversation_type,
            up.display_name AS requester_display_name,
            up.real_name AS requester_real_name, m.text AS source_message_text
     FROM follow_up_items fui
     LEFT JOIN channels c
       ON c.workspace_id = fui.workspace_id
      AND c.channel_id = fui.channel_id
     LEFT JOIN user_profiles up
       ON up.workspace_id = fui.workspace_id
      AND up.user_id = fui.requester_user_id
     LEFT JOIN messages m
       ON m.workspace_id = fui.workspace_id
      AND m.channel_id = fui.channel_id
      AND m.ts = fui.source_message_ts
     WHERE fui.workspace_id = $1
       AND fui.status = 'resolved'
       AND fui.resolved_at >= NOW() - INTERVAL '24 hours'
     ORDER BY fui.resolved_at DESC
     LIMIT $2`,
    [workspaceId, safeLimit],
  );

  return result.rows;
}

export interface FollowUpCandidateMessageRow {
  workspace_id: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  user_id: string;
  text: string;
  normalized_text: string | null;
}

export async function listRecentMessagesMissingFollowUps(options: {
  workspaceId?: string;
  requesterUserId?: string;
  channelId?: string;
  limit?: number;
  hoursBack?: number;
} = {}): Promise<FollowUpCandidateMessageRow[]> {
  const safeLimit = Math.max(1, Math.min(1000, options.limit ?? 500));
  const maxHoursBack = 30 * 24;
  const safeHoursBack = options.hoursBack == null
    ? null
    : Math.max(1, Math.min(maxHoursBack, options.hoursBack));

  const result = await pool.query<FollowUpCandidateMessageRow>(
    `SELECT m.workspace_id, m.channel_id, m.ts, m.thread_ts, m.user_id, m.text, m.normalized_text
     FROM messages m
     LEFT JOIN follow_up_rules fur
       ON fur.workspace_id = m.workspace_id
      AND fur.channel_id = m.channel_id
     WHERE ($1::text IS NULL OR m.workspace_id = $1)
       AND ($2::text IS NULL OR m.user_id = $2)
       AND ($3::text IS NULL OR m.channel_id = $3)
       AND COALESCE(m.bot_id, '') = ''
       AND COALESCE(m.subtype, '') <> 'bot_message'
       AND LENGTH(BTRIM(COALESCE(m.text, ''))) > 0
       AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
         hours => CASE
           WHEN $4::int IS NULL THEN COALESCE(fur.analysis_window_days, $5::int) * 24
           ELSE LEAST(COALESCE(fur.analysis_window_days, $5::int) * 24, $4::int)
         END
       )
       AND NOT EXISTS (
         SELECT 1
         FROM follow_up_items fui
         WHERE fui.workspace_id = m.workspace_id
           AND fui.channel_id = m.channel_id
           AND fui.requester_user_id = m.user_id
           AND fui.status = 'open'
           AND fui.source_message_ts <= m.ts
           AND (
             (
               fui.source_thread_ts IS NOT NULL
               AND COALESCE(m.thread_ts, m.ts) = fui.source_thread_ts
             )
             OR (
               fui.source_thread_ts IS NULL
               AND (m.thread_ts IS NULL OR m.thread_ts = m.ts)
             )
           )
       )
     ORDER BY m.ts::double precision DESC
     LIMIT $6`,
    [
      options.workspaceId ?? null,
      options.requesterUserId ?? null,
      options.channelId ?? null,
      safeHoursBack,
      maxHoursBack,
      safeLimit,
    ],
  );

  return result.rows;
}

export interface RecentSentimentAlertRow {
  channel_id: string;
  channel_name: string | null;
  conversation_type: string | null;
  message_ts: string;
  thread_ts: string | null;
  user_id: string | null;
  display_name: string | null;
  real_name: string | null;
  dominant_emotion: DominantEmotion;
  interaction_tone: InteractionTone | null;
  escalation_risk: EscalationRisk;
  explanation: string | null;
  message_text: string | null;
  created_at: Date;
}

export async function getRecentSentimentAlerts(
  workspaceId: string,
  limit: number = 25,
): Promise<RecentSentimentAlertRow[]> {
  const safeLimit = Math.max(1, Math.min(100, limit));
  const result = await pool.query<RecentSentimentAlertRow>(
    `SELECT ma.channel_id,
            c.name AS channel_name,
            c.conversation_type,
            ma.message_ts,
            m.thread_ts,
            m.user_id,
            up.display_name,
            up.real_name,
            ma.dominant_emotion,
            ma.interaction_tone,
            ma.escalation_risk,
            ma.explanation,
            m.text AS message_text,
            ma.created_at
     FROM message_analytics ma
     LEFT JOIN messages m
       ON m.workspace_id = ma.workspace_id
      AND m.channel_id = ma.channel_id
      AND m.ts = ma.message_ts
     LEFT JOIN user_profiles up
       ON up.workspace_id = m.workspace_id
      AND up.user_id = m.user_id
     LEFT JOIN channels c
       ON c.workspace_id = ma.workspace_id
      AND c.channel_id = ma.channel_id
     LEFT JOIN follow_up_rules fur
       ON fur.workspace_id = ma.workspace_id
      AND fur.channel_id = ma.channel_id
     WHERE ma.workspace_id = $1
       AND ma.escalation_risk IN ('medium', 'high')
       AND m.ts IS NOT NULL
       AND TO_TIMESTAMP(m.ts::double precision) >= NOW() - MAKE_INTERVAL(
         days => COALESCE(fur.analysis_window_days, $3::int)
       )
     ORDER BY ma.created_at DESC
     LIMIT $2`,
    [workspaceId, safeLimit, config.SUMMARY_WINDOW_DAYS],
  );
  return result.rows;
}

// ─── Workspaces ─────────────────────────────────────────────────────────────

export async function upsertWorkspace(input: {
  workspaceId: string;
  teamName: string | null;
  botTokenEncrypted: Buffer;
  botTokenIv: Buffer;
  botTokenTag: Buffer;
  botRefreshTokenEncrypted?: Buffer | null;
  botRefreshTokenIv?: Buffer | null;
  botRefreshTokenTag?: Buffer | null;
  botTokenExpiresAt?: Date | null;
  botUserId: string | null;
  installedBy: string | null;
  scopes: string[] | null;
}): Promise<WorkspaceRow> {
  const result = await pool.query<WorkspaceRow>(
    `INSERT INTO workspaces (
       workspace_id, team_name, bot_token_encrypted, bot_token_iv, bot_token_tag,
       bot_refresh_token_encrypted, bot_refresh_token_iv, bot_refresh_token_tag,
       bot_token_expires_at, bot_user_id, installed_by, scopes
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     ON CONFLICT (workspace_id) DO UPDATE
       SET team_name           = COALESCE(EXCLUDED.team_name, workspaces.team_name),
           bot_token_encrypted = EXCLUDED.bot_token_encrypted,
           bot_token_iv        = EXCLUDED.bot_token_iv,
           bot_token_tag       = EXCLUDED.bot_token_tag,
           bot_refresh_token_encrypted = EXCLUDED.bot_refresh_token_encrypted,
           bot_refresh_token_iv        = EXCLUDED.bot_refresh_token_iv,
           bot_refresh_token_tag       = EXCLUDED.bot_refresh_token_tag,
           bot_token_expires_at        = EXCLUDED.bot_token_expires_at,
           bot_user_id         = COALESCE(EXCLUDED.bot_user_id, workspaces.bot_user_id),
           installed_by        = COALESCE(EXCLUDED.installed_by, workspaces.installed_by),
           scopes              = COALESCE(EXCLUDED.scopes, workspaces.scopes),
           last_token_refresh_error = NULL,
           last_token_refresh_error_at = NULL,
           install_status      = 'active',
           installed_at        = NOW(),
           updated_at          = NOW()
     RETURNING *`,
    [
      input.workspaceId,
      input.teamName,
      input.botTokenEncrypted,
      input.botTokenIv,
      input.botTokenTag,
      input.botRefreshTokenEncrypted ?? null,
      input.botRefreshTokenIv ?? null,
      input.botRefreshTokenTag ?? null,
      input.botTokenExpiresAt ?? null,
      input.botUserId,
      input.installedBy,
      input.scopes,
    ],
  );
  return result.rows[0];
}

export async function getWorkspaceBotCredentials(
  workspaceId: string,
): Promise<
  Pick<
    WorkspaceRow,
    | "workspace_id"
    | "team_name"
    | "bot_token_encrypted"
    | "bot_token_iv"
    | "bot_token_tag"
    | "bot_refresh_token_encrypted"
    | "bot_refresh_token_iv"
    | "bot_refresh_token_tag"
    | "bot_token_expires_at"
    | "bot_user_id"
    | "install_status"
    | "last_token_refresh_at"
    | "last_token_refresh_error"
    | "last_token_refresh_error_at"
  > | null
> {
  const result = await pool.query<WorkspaceRow>(
    `SELECT workspace_id,
            team_name,
            bot_token_encrypted,
            bot_token_iv,
            bot_token_tag,
            bot_refresh_token_encrypted,
            bot_refresh_token_iv,
            bot_refresh_token_tag,
            bot_token_expires_at,
            bot_user_id,
            install_status,
            last_token_refresh_at,
            last_token_refresh_error,
            last_token_refresh_error_at
     FROM workspaces
     WHERE workspace_id = $1`,
    [workspaceId],
  );
  return result.rows[0] ?? null;
}

export async function updateWorkspaceRotatedBotToken(input: {
  workspaceId: string;
  botTokenEncrypted: Buffer;
  botTokenIv: Buffer;
  botTokenTag: Buffer;
  botRefreshTokenEncrypted: Buffer;
  botRefreshTokenIv: Buffer;
  botRefreshTokenTag: Buffer;
  botTokenExpiresAt: Date | null;
  botUserId?: string | null;
}): Promise<void> {
  await pool.query(
    `UPDATE workspaces
     SET bot_token_encrypted = $2,
         bot_token_iv = $3,
         bot_token_tag = $4,
         bot_refresh_token_encrypted = $5,
         bot_refresh_token_iv = $6,
         bot_refresh_token_tag = $7,
         bot_token_expires_at = $8,
         bot_user_id = COALESCE($9, bot_user_id),
         last_token_refresh_at = NOW(),
         last_token_refresh_error = NULL,
         last_token_refresh_error_at = NULL,
         install_status = 'active',
         updated_at = NOW()
     WHERE workspace_id = $1`,
    [
      input.workspaceId,
      input.botTokenEncrypted,
      input.botTokenIv,
      input.botTokenTag,
      input.botRefreshTokenEncrypted,
      input.botRefreshTokenIv,
      input.botRefreshTokenTag,
      input.botTokenExpiresAt,
      input.botUserId ?? null,
    ],
  );
}

export async function recordWorkspaceTokenRefreshFailure(
  workspaceId: string,
  errorMessage: string,
): Promise<void> {
  await pool.query(
    `UPDATE workspaces
     SET last_token_refresh_error = LEFT($2, 500),
         last_token_refresh_error_at = NOW(),
         updated_at = NOW()
     WHERE workspace_id = $1`,
    [workspaceId, errorMessage],
  );
}

export async function listExpiringWorkspaceIds(
  windowMinutes: number,
  limit: number = 100,
): Promise<string[]> {
  const safeLimit = Math.max(1, Math.min(500, limit));
  const result = await pool.query<{ workspace_id: string }>(
    `SELECT workspace_id
     FROM workspaces
     WHERE install_status = 'active'
       AND bot_refresh_token_encrypted IS NOT NULL
       AND bot_token_expires_at IS NOT NULL
       AND bot_token_expires_at <= NOW() + MAKE_INTERVAL(mins => $1)
     ORDER BY bot_token_expires_at ASC
     LIMIT $2`,
    [windowMinutes, safeLimit],
  );
  return result.rows.map((row) => row.workspace_id);
}

export async function getWorkspaceStatus(
  workspaceId: string,
): Promise<{
  installed: boolean;
  botUserId: string | null;
  scopes: string[];
  tokenRotationStatus: string;
  botTokenExpiresAt: string | null;
  lastTokenRefreshAt: string | null;
  lastTokenRefreshError: string | null;
  lastTokenRefreshErrorAt: string | null;
}> {
  const result = await pool.query<{
    bot_user_id: string | null;
    install_status: string;
    scopes: string[] | null;
    bot_refresh_token_encrypted: Buffer | null;
    bot_token_expires_at: Date | null;
    last_token_refresh_at: Date | null;
    last_token_refresh_error: string | null;
    last_token_refresh_error_at: Date | null;
  }>(
    `SELECT
       bot_user_id,
       install_status,
       scopes,
       bot_refresh_token_encrypted,
       bot_token_expires_at,
       last_token_refresh_at,
       last_token_refresh_error,
       last_token_refresh_error_at
     FROM workspaces
     WHERE workspace_id = $1`,
    [workspaceId],
  );
  if (result.rowCount === 0 || !result.rows[0]) {
    return {
      installed: false,
      botUserId: null,
      scopes: [],
      tokenRotationStatus: "expired_or_invalid",
      botTokenExpiresAt: null,
      lastTokenRefreshAt: null,
      lastTokenRefreshError: null,
      lastTokenRefreshErrorAt: null,
    };
  }
  const row = result.rows[0];
  const hasRefreshToken = Boolean(row.bot_refresh_token_encrypted);
  const expiresAt = row.bot_token_expires_at ? row.bot_token_expires_at.getTime() : null;
  const isExpired = expiresAt !== null && expiresAt <= Date.now();
  const tokenRotationStatus =
    row.install_status !== "active"
      ? "expired_or_invalid"
      : !hasRefreshToken
        ? "legacy_reinstall_required"
        : isExpired
          ? "expired_or_invalid"
          : row.last_token_refresh_error
            ? "refresh_failed"
            : "ready";
  return {
    installed: row.install_status === "active",
    botUserId: row.bot_user_id,
    scopes: row.scopes ?? [],
    tokenRotationStatus,
    botTokenExpiresAt: row.bot_token_expires_at?.toISOString() ?? null,
    lastTokenRefreshAt: row.last_token_refresh_at?.toISOString() ?? null,
    lastTokenRefreshError: row.last_token_refresh_error ?? null,
    lastTokenRefreshErrorAt: row.last_token_refresh_error_at?.toISOString() ?? null,
  };
}

export async function deactivateWorkspace(workspaceId: string): Promise<void> {
  await pool.query(
    `UPDATE workspaces SET install_status = 'uninstalled', updated_at = NOW() WHERE workspace_id = $1`,
    [workspaceId],
  );
}
