/* eslint-disable no-console */
import { pool, shutdown } from "../db/pool.js";
import { encryptToken } from "../services/tokenEncryption.js";

type RepairScope =
  | "stale-digests"
  | "dedupe-obligations"
  | "encrypt-webhook-secrets"
  | "audit-channel-links";

interface RepairArgs {
  scope: RepairScope;
  workspaceId: string | null;
  apply: boolean;
}

interface DuplicateObligationRow {
  id: string;
  workspace_id: string;
  meeting_id: string;
  dedupe_key: string;
  obligation_type: string;
  title: string;
  description: string | null;
  owner_user_id: string | null;
  owner_name: string | null;
  assignee_user_ids: string[];
  due_date: string | null;
  due_date_source: string | null;
  priority: string;
  status: string;
  follow_up_item_id: string | null;
  slack_evidence_json: unknown[];
  extraction_confidence: number;
  source_context: string | null;
  resolution_evidence: string | null;
  created_at: Date;
}

function parseArgs(argv: string[]): RepairArgs {
  let scope: RepairScope | null = null;
  let workspaceId: string | null = null;
  let all = false;
  let apply = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scope") {
      const value = argv[index + 1] as RepairScope | undefined;
      if (!value) {
        throw new Error("--scope requires a value");
      }
      scope = value;
      index += 1;
      continue;
    }
    if (arg === "--workspace") {
      workspaceId = argv[index + 1] ?? null;
      if (!workspaceId) {
        throw new Error("--workspace requires a value");
      }
      index += 1;
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!scope) {
    throw new Error("--scope is required");
  }
  if (!all && !workspaceId) {
    throw new Error("Provide either --workspace <id> or --all");
  }
  if (all && workspaceId) {
    throw new Error("Use either --workspace <id> or --all, not both");
  }

  return {
    scope,
    workspaceId,
    apply,
  };
}

function buildEncryptedSecret(secret: string): string {
  const { ciphertext, iv, tag } = encryptToken(secret);
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function priorityRank(priority: string): number {
  switch (priority) {
    case "critical":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    default:
      return 1;
  }
}

function preferLonger(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return b.length > a.length ? b : a;
}

function mergeEvidence(rows: DuplicateObligationRow[]): unknown[] {
  const seen = new Set<string>();
  const merged: unknown[] = [];

  for (const row of rows) {
    for (const evidence of row.slack_evidence_json ?? []) {
      const key = JSON.stringify(evidence);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(evidence);
      }
    }
  }

  return merged;
}

async function repairStaleDigests(args: RepairArgs): Promise<void> {
  const params: unknown[] = [];
  const filters = [
    `digest_claimed_at IS NOT NULL`,
    `digest_message_ts IS NULL`,
    `digest_claimed_at < NOW() - INTERVAL '15 minutes'`,
  ];
  if (args.workspaceId) {
    params.push(args.workspaceId);
    filters.push(`workspace_id = $${params.length}`);
  }
  const whereClause = filters.join(" AND ");

  const preview = await pool.query<{
    id: string;
    workspace_id: string;
    fathom_call_id: string;
    digest_claimed_at: Date;
  }>(
    `SELECT id, workspace_id, fathom_call_id, digest_claimed_at
     FROM meetings
     WHERE ${whereClause}
     ORDER BY digest_claimed_at ASC`,
    params,
  );

  console.log(`stale-digests: found ${preview.rows.length} stale digest claims`);
  for (const row of preview.rows.slice(0, 20)) {
    console.log(
      `  workspace=${row.workspace_id} meeting=${row.id} fathom_call_id=${row.fathom_call_id} claimed_at=${row.digest_claimed_at.toISOString()}`,
    );
  }

  if (!args.apply || preview.rows.length === 0) {
    return;
  }

  const released = await pool.query<{ id: string }>(
    `UPDATE meetings
     SET digest_claimed_at = NULL, updated_at = NOW()
     WHERE ${whereClause}
     RETURNING id`,
    params,
  );
  console.log(`stale-digests: released ${released.rowCount ?? 0} claims`);
}

async function encryptWebhookSecrets(args: RepairArgs): Promise<void> {
  const params: unknown[] = [];
  const filters = [`webhook_secret IS NOT NULL`];
  if (args.workspaceId) {
    params.push(args.workspaceId);
    filters.push(`workspace_id = $${params.length}`);
  }

  const result = await pool.query<{
    workspace_id: string;
    webhook_id: string | null;
    webhook_secret: string;
  }>(
    `SELECT workspace_id, webhook_id, webhook_secret
     FROM fathom_connections
     WHERE ${filters.join(" AND ")}
     ORDER BY workspace_id ASC`,
    params,
  );

  const legacyRows = result.rows.filter((row) => row.webhook_secret.split(":").length !== 3);
  console.log(`encrypt-webhook-secrets: found ${legacyRows.length} plaintext/legacy secrets`);
  for (const row of legacyRows.slice(0, 20)) {
    console.log(`  workspace=${row.workspace_id} webhook_id=${row.webhook_id ?? "(missing)"}`);
  }

  if (!args.apply || legacyRows.length === 0) {
    return;
  }

  for (const row of legacyRows) {
    const encrypted = buildEncryptedSecret(row.webhook_secret);
    await pool.query(
      `UPDATE fathom_connections
       SET webhook_secret = $2, updated_at = NOW()
       WHERE workspace_id = $1`,
      [row.workspace_id, encrypted],
    );
  }

  console.log(`encrypt-webhook-secrets: encrypted ${legacyRows.length} secrets`);
}

async function auditChannelLinks(args: RepairArgs): Promise<void> {
  const params: unknown[] = [];
  const filters = [
    `(link_type = 'pattern' OR domain_pattern IS NOT NULL OR title_pattern IS NOT NULL OR recorder_email_pattern IS NOT NULL)`,
  ];
  if (args.workspaceId) {
    params.push(args.workspaceId);
    filters.push(`workspace_id = $${params.length}`);
  }

  const result = await pool.query<{
    id: string;
    workspace_id: string;
    channel_id: string;
    link_type: string;
    domain_pattern: string | null;
    title_pattern: string | null;
    recorder_email_pattern: string | null;
    digest_enabled: boolean;
    tracking_enabled: boolean;
    priority: number;
  }>(
    `SELECT id, workspace_id, channel_id, link_type, domain_pattern, title_pattern,
            recorder_email_pattern, digest_enabled, tracking_enabled, priority
     FROM meeting_channel_links
     WHERE ${filters.join(" AND ")}
     ORDER BY workspace_id ASC, priority DESC, created_at ASC`,
    params,
  );

  console.log(`audit-channel-links: found ${result.rows.length} review candidates`);
  for (const row of result.rows) {
    console.log(
      [
        `  workspace=${row.workspace_id}`,
        `channel=${row.channel_id}`,
        `link_type=${row.link_type}`,
        `priority=${row.priority}`,
        `domain=${row.domain_pattern ?? "-"}`,
        `title=${row.title_pattern ?? "-"}`,
        `recorder=${row.recorder_email_pattern ?? "-"}`,
        `digest=${row.digest_enabled}`,
        `tracking=${row.tracking_enabled}`,
      ].join(" "),
    );
  }
}

function choosePrimary(rows: DuplicateObligationRow[]): DuplicateObligationRow {
  return [...rows].sort((left, right) => {
    const leftFollowUp = left.follow_up_item_id ? 1 : 0;
    const rightFollowUp = right.follow_up_item_id ? 1 : 0;
    if (leftFollowUp !== rightFollowUp) {
      return rightFollowUp - leftFollowUp;
    }
    return left.created_at.getTime() - right.created_at.getTime();
  })[0];
}

async function repairDuplicateObligations(args: RepairArgs): Promise<void> {
  const params: unknown[] = [];
  const filters = ["TRUE"];
  if (args.workspaceId) {
    params.push(args.workspaceId);
    filters.push(`workspace_id = $${params.length}`);
  }

  const groups = await pool.query<{
    workspace_id: string;
    meeting_id: string;
    base_key: string;
    duplicate_count: string;
  }>(
    `SELECT workspace_id,
            meeting_id,
            regexp_replace(dedupe_key, ':[0-9a-f-]{36}$', '') AS base_key,
            COUNT(*) AS duplicate_count
     FROM meeting_obligations
     WHERE ${filters.join(" AND ")}
     GROUP BY workspace_id, meeting_id, regexp_replace(dedupe_key, ':[0-9a-f-]{36}$', '')
     HAVING COUNT(*) > 1
     ORDER BY workspace_id ASC, meeting_id ASC`,
    params,
  );

  console.log(`dedupe-obligations: found ${groups.rows.length} duplicate groups`);
  for (const group of groups.rows.slice(0, 20)) {
    console.log(
      `  workspace=${group.workspace_id} meeting=${group.meeting_id} base_key=${group.base_key} duplicates=${group.duplicate_count}`,
    );
  }

  if (!args.apply || groups.rows.length === 0) {
    return;
  }

  for (const group of groups.rows) {
    const rowsResult = await pool.query<DuplicateObligationRow>(
      `SELECT *
       FROM meeting_obligations
       WHERE workspace_id = $1
         AND meeting_id = $2
         AND regexp_replace(dedupe_key, ':[0-9a-f-]{36}$', '') = $3
       ORDER BY created_at ASC`,
      [group.workspace_id, group.meeting_id, group.base_key],
    );

    const rows = rowsResult.rows;
    if (rows.length <= 1) {
      continue;
    }

    const primary = choosePrimary(rows);
    const duplicates = rows.filter((row) => row.id !== primary.id);
    const allRows = [primary, ...duplicates];
    const followUpIds = Array.from(
      new Set(
        allRows
          .map((row) => row.follow_up_item_id)
          .filter((followUpId): followUpId is string => Boolean(followUpId)),
      ),
    );
    const mergedEvidence = mergeEvidence(allRows);
    const mergedPriority = [...allRows].sort(
      (left, right) => priorityRank(right.priority) - priorityRank(left.priority),
    )[0]?.priority ?? primary.priority;
    const mergedConfidence = Math.max(
      ...allRows.map((row) => row.extraction_confidence ?? 0),
    );
    const mergedDescription = allRows.reduce<string | null>(
      (best, row) => preferLonger(best, row.description),
      primary.description,
    );
    const mergedSourceContext = allRows.reduce<string | null>(
      (best, row) => preferLonger(best, row.source_context),
      primary.source_context,
    );
    const mergedOwnerUserId =
      primary.owner_user_id ??
      duplicates.find((row) => row.owner_user_id)?.owner_user_id ??
      null;
    const mergedOwnerName =
      primary.owner_name ??
      duplicates.find((row) => row.owner_name)?.owner_name ??
      null;
    const mergedDueDate =
      primary.due_date ??
      duplicates.find((row) => row.due_date)?.due_date ??
      null;
    const mergedDueDateSource =
      primary.due_date_source ??
      duplicates.find((row) => row.due_date_source)?.due_date_source ??
      null;
    const chosenFollowUpId = primary.follow_up_item_id ?? followUpIds[0] ?? null;
    const duplicateIds = duplicates.map((row) => row.id);
    const allIds = allRows.map((row) => row.id);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE meeting_obligations
         SET dedupe_key = $2,
             description = $3,
             owner_user_id = $4,
             owner_name = $5,
             due_date = $6,
             due_date_source = $7,
             priority = $8,
             follow_up_item_id = $9,
             slack_evidence_json = $10::jsonb,
             extraction_confidence = $11,
             source_context = $12,
             updated_at = NOW()
         WHERE id = $1`,
        [
          primary.id,
          group.base_key,
          mergedDescription,
          mergedOwnerUserId,
          mergedOwnerName,
          mergedDueDate,
          mergedDueDateSource,
          mergedPriority,
          chosenFollowUpId,
          JSON.stringify(mergedEvidence),
          mergedConfidence,
          mergedSourceContext,
        ],
      );

      if (followUpIds.length > 0) {
        await client.query(
          `UPDATE follow_up_items
           SET meeting_obligation_id = $1, updated_at = NOW()
           WHERE meeting_obligation_id = ANY($2::uuid[])`,
          [primary.id, allIds],
        );
      }

      if (duplicateIds.length > 0) {
        await client.query(
          `DELETE FROM meeting_obligations WHERE id = ANY($1::uuid[])`,
          [duplicateIds],
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  console.log(`dedupe-obligations: repaired ${groups.rows.length} duplicate groups`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(
    `Running Fathom repair scope=${args.scope} mode=${args.apply ? "apply" : "dry-run"} target=${args.workspaceId ?? "all"}`,
  );

  switch (args.scope) {
    case "stale-digests":
      await repairStaleDigests(args);
      return;
    case "encrypt-webhook-secrets":
      await encryptWebhookSecrets(args);
      return;
    case "audit-channel-links":
      await auditChannelLinks(args);
      return;
    case "dedupe-obligations":
      await repairDuplicateObligations(args);
      return;
    default:
      throw new Error(`Unsupported scope: ${args.scope satisfies never}`);
  }
}

main()
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdown();
  });
