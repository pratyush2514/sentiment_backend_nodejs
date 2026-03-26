import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FathomParticipant } from "../types/database.js";

const dbMock = vi.hoisted(() => ({
  listMeetingChannelLinks: vi.fn(),
  getReadyChannels: vi.fn(),
  getFathomConnection: vi.fn(),
  getChannelState: vi.fn(),
  getChannelMembers: vi.fn(),
  getUserProfiles: vi.fn(),
  getFollowUpRule: vi.fn(),
  getUserProfilesByEmails: vi.fn(),
}));

vi.mock("../db/queries.js", () => dbMock);

vi.mock("../utils/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    }),
  },
}));

const {
  resolveChannelForMeeting,
  resolveParticipantsToSlackUsers,
} = await import("./meetingChannelResolver.js");

describe("meetingChannelResolver", () => {
  const participants: FathomParticipant[] = [
    {
      name: "Taylor",
      email: "taylor@client.com",
      domain: "client.com",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.listMeetingChannelLinks.mockResolvedValue([]);
    dbMock.getFathomConnection.mockResolvedValue(null);
    dbMock.getReadyChannels.mockResolvedValue([
      {
        workspace_id: "T123",
        channel_id: "C123",
        name: "client-launch",
      },
    ]);
    dbMock.getChannelState.mockResolvedValue(null);
    dbMock.getChannelMembers.mockResolvedValue([]);
    dbMock.getUserProfiles.mockResolvedValue([]);
    dbMock.getFollowUpRule.mockResolvedValue(null);
    dbMock.getUserProfilesByEmails.mockResolvedValue([]);
  });

  it("does not auto-link on title keywords alone", async () => {
    const match = await resolveChannelForMeeting("T123", {
      title: "Client launch weekly sync",
      participants,
      summary: "Launch planning and follow-up",
    });

    expect(match).toBeNull();
  });

  it("auto-links when there is an identity signal from participant email overlap", async () => {
    dbMock.getChannelMembers.mockResolvedValue([{ user_id: "U123" }]);
    dbMock.getUserProfiles.mockResolvedValue([
      {
        user_id: "U123",
        email: "taylor@client.com",
        display_name: "Taylor",
      },
    ]);

    const match = await resolveChannelForMeeting("T123", {
      title: "Client launch weekly sync",
      participants,
      summary: "Launch planning and follow-up",
    });

    expect(match).toEqual({
      channelId: "C123",
      digestEnabled: true,
      trackingEnabled: true,
      matchedBy: "content",
    });
  });

  it("resolves participant emails to Slack user ids via email lookup", async () => {
    dbMock.getUserProfilesByEmails.mockResolvedValue([
      {
        user_id: "U123",
        email: "taylor@client.com",
      },
    ]);

    const resolved = await resolveParticipantsToSlackUsers("T123", participants);

    expect(dbMock.getUserProfilesByEmails).toHaveBeenCalledWith("T123", [
      "taylor@client.com",
    ]);
    expect(resolved.get("Taylor")).toBe("U123");
  });
});
