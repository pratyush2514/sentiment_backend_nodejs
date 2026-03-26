import { Fathom } from "fathom-typescript";
import * as db from "../db/queries.js";
import { logger } from "../utils/logger.js";
import {
  getMeetingIdentifier,
  getMeetingShareUrl,
} from "./fathomMeetingUtils.js";
import {
  getFathomApiKey,
  invalidateFathomConnection,
  storeFathomWebhookSecret,
} from "./fathomTokenManager.js";

const log = logger.child({ service: "fathomClient" });

export class FathomApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly workspaceId?: string,
  ) {
    super(message);
    this.name = "FathomApiError";
  }
}

export interface FathomValidationResult {
  status: "valid" | "invalid" | "retryable";
  message: string;
}

function buildFathomClient(apiKey: string): Fathom {
  return new Fathom({
    security: {
      apiKeyAuth: apiKey,
    },
  });
}

/**
 * Get an authenticated Fathom SDK client for a workspace.
 */
export async function getFathomClient(
  workspaceId: string,
): Promise<Fathom> {
  const apiKey = await getFathomApiKey(workspaceId);
  if (!apiKey) {
    throw new FathomApiError(
      "No active Fathom connection for workspace",
      401,
      workspaceId,
    );
  }

  return buildFathomClient(apiKey);
}

/**
 * Validate that a Fathom API key works by listing meetings.
 */
export async function validateFathomApiKey(
  apiKey: string,
): Promise<FathomValidationResult> {
  try {
    const client = buildFathomClient(apiKey);
    await client.listMeetings({});
    return {
      status: "valid",
      message: "Fathom API key validated",
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    return {
      status: isAuthError(err) ? "invalid" : "retryable",
      message: errMsg,
    };
  }
}

export async function validateFathomConnection(
  workspaceId: string,
): Promise<boolean> {
  try {
    const client = await getFathomClient(workspaceId);
    await client.listMeetings({});
    log.info({ workspaceId }, "Fathom connection validated");
    return true;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.warn({ workspaceId, err: errMsg }, "Fathom connection validation failed");

    if (isAuthError(err)) {
      await invalidateFathomConnection(workspaceId, errMsg);
    }

    return false;
  }
}

/**
 * Register a webhook with Fathom to receive meeting data.
 */
export async function registerFathomWebhook(
  workspaceId: string,
  destinationUrl: string,
): Promise<{ webhookId: string; webhookSecret: string } | null> {
  try {
    const client = await getFathomClient(workspaceId);
    const result = await client.createWebhook({
      destinationUrl,
      triggeredFor: [
        "my_recordings",
        "my_shared_with_team_recordings",
      ],
      includeActionItems: true,
      includeSummary: true,
      includeTranscript: true,
      includeCrmMatches: false,
    });

    // The SDK may wrap the response — try multiple access patterns
    const raw = result as Record<string, unknown> | undefined;
    const inner = (raw?.result ?? raw) as Record<string, unknown> | undefined;
    const webhookId = String(inner?.id ?? inner?.webhookId ?? "");
    const webhookSecret = String(inner?.secret ?? inner?.webhookSecret ?? "");

    log.info({ workspaceId, webhookId: webhookId || "(none)", hasSecret: Boolean(webhookSecret) }, "Fathom createWebhook response processed");

    if (webhookId) {
      await storeFathomWebhookSecret(workspaceId, webhookId, webhookSecret);
    }

    // Even if we don't get an ID back, the webhook may have been created successfully
    // (some SDK versions don't return the ID). The webhook will still fire.
    return { webhookId, webhookSecret };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ workspaceId, err: errMsg }, "Failed to register Fathom webhook");
    // Webhook registration failure is non-fatal — user can configure webhooks manually in Fathom settings
    return null;
  }
}

/**
 * Fetch full meeting details via API (for supplemental data or re-fetch).
 */
export async function fetchMeetingDetails(
  workspaceId: string,
  options?: { createdAfter?: string },
): Promise<unknown[]> {
  try {
    const client = await getFathomClient(workspaceId);
    const pages = await client.listMeetings({
      createdAfter: options?.createdAfter,
      includeActionItems: true,
      includeSummary: true,
      includeTranscript: true,
    });

    const items: unknown[] = [];
    for await (const page of pages) {
      if (page?.result?.items && Array.isArray(page.result.items)) {
        items.push(...page.result.items);
      }
    }

    await db.updateFathomConnectionSyncedAt(workspaceId);
    return items;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "unknown";
    log.error({ workspaceId, err: errMsg }, "Failed to fetch meetings from Fathom");

    if (isAuthError(err)) {
      await invalidateFathomConnection(workspaceId, errMsg);
    }

    throw new FathomApiError(errMsg, undefined, workspaceId);
  }
}

export async function fetchMeetingByCallId(
  workspaceId: string,
  fathomCallId: string,
): Promise<Record<string, unknown> | null> {
  return findMeeting(workspaceId, (record) => getMeetingIdentifier(record) === fathomCallId);
}

export async function fetchMeetingByShareUrl(
  workspaceId: string,
  shareUrl: string,
): Promise<Record<string, unknown> | null> {
  return findMeeting(workspaceId, (record) => getMeetingShareUrl(record) === shareUrl);
}

async function findMeeting(
  workspaceId: string,
  predicate: (record: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | null> {
  const meetings = await fetchMeetingDetails(workspaceId);
  for (const item of meetings) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (predicate(record)) {
      return record;
    }
  }
  return null;
}

export { getMeetingIdentifier };

function isAuthError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes("401") || msg.includes("403") || msg.includes("unauthorized") || msg.includes("forbidden");
  }
  return false;
}
