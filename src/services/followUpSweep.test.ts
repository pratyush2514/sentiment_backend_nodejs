import { describe, expect, it } from "vitest";
import { shouldQuietlyConclude } from "./followUpSweep.js";
import type { FollowUpItemWithContextRow } from "../db/queries.js";

function buildItem(
  overrides: Partial<FollowUpItemWithContextRow> = {},
): FollowUpItemWithContextRow {
  const now = new Date();
  return {
    id: "item-1",
    workspace_id: "W1",
    channel_id: "C1",
    source_message_ts: "1710000000.000100",
    source_thread_ts: null,
    requester_user_id: "U1",
    status: "open",
    workflow_state: "awaiting_primary",
    seriousness: "low",
    seriousness_score: 2,
    detection_mode: "heuristic",
    reason_codes: ["request_language"],
    summary: "Needs a reply.",
    due_at: new Date(now.getTime() - 60 * 60 * 1000),
    primary_responder_ids: ["U2"],
    escalation_responder_ids: ["U3"],
    last_alerted_at: null,
    alert_count: 0,
    last_request_ts: "1710000000.000100",
    repeated_ask_count: 1,
    acknowledged_at: null,
    acknowledged_by_user_id: null,
    acknowledgment_source: null,
    engaged_at: null,
    escalated_at: null,
    ignored_score: 0,
    resolved_via_escalation: false,
    primary_missed_sla: false,
    visibility_after: now,
    last_responder_user_id: null,
    last_responder_message_ts: null,
    next_expected_response_at: new Date(now.getTime() + 60 * 60 * 1000),
    resolved_at: null,
    resolved_message_ts: null,
    resolution_reason: null,
    resolution_scope: null,
    resolved_by_user_id: null,
    last_engagement_at: null,
    dismissed_at: null,
    metadata_json: {},
    snoozed_until: null,
    last_dm_refs: [],
    created_at: now,
    updated_at: now,
    channel_name: "test",
    conversation_type: "public_channel",
    requester_display_name: "Test User",
    requester_real_name: "Test User",
    source_message_text: "Can you take a look?",
    ...overrides,
  };
}

describe("shouldQuietlyConclude", () => {
  it("waits for the low-priority silent-close threshold", () => {
    const item = buildItem({ seriousness: "low" });
    expect(
      shouldQuietlyConclude(item, 23.9, { lowHours: 24, mediumHours: 72 }),
    ).toBe(false);
    expect(
      shouldQuietlyConclude(item, 24, { lowHours: 24, mediumHours: 72 }),
    ).toBe(true);
  });

  it("allows medium follow-ups to age out only after at least one overdue cycle", () => {
    const item = buildItem({ seriousness: "medium", alert_count: 0 });
    expect(
      shouldQuietlyConclude(item, 71.9, { lowHours: 24, mediumHours: 72 }),
    ).toBe(false);

    expect(
      shouldQuietlyConclude(
        { ...item, alert_count: 1 },
        72,
        { lowHours: 24, mediumHours: 72 },
      ),
    ).toBe(true);
  });

  it("keeps llm-detected items surfaced through the grace window", () => {
    const item = buildItem({ seriousness: "low", detection_mode: "llm" });
    expect(
      shouldQuietlyConclude(item, 48, { lowHours: 24, mediumHours: 72 }),
    ).toBe(false);
  });

  it("keeps repeated or urgent asks open", () => {
    expect(
      shouldQuietlyConclude(
        buildItem({ repeated_ask_count: 2 }),
        48,
        { lowHours: 24, mediumHours: 72 },
      ),
    ).toBe(false);

    expect(
      shouldQuietlyConclude(
        buildItem({ reason_codes: ["request_language", "urgency_language"] }),
        48,
        { lowHours: 24, mediumHours: 72 },
      ),
    ).toBe(false);
  });

  it("does not quietly conclude high-priority items", () => {
    expect(
      shouldQuietlyConclude(
        buildItem({ seriousness: "high", alert_count: 2 }),
        120,
        { lowHours: 24, mediumHours: 72 },
      ),
    ).toBe(false);
  });
});
