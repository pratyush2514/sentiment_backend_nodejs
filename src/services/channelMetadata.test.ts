import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSlackClient = {
  fetchChannelInfo: vi.fn(),
};

vi.mock("./slackClientFactory.js", () => ({
  getSlackClient: vi.fn().mockResolvedValue(mockSlackClient),
}));

const { deriveConversationType, resolveChannelMetadata } = await import("./channelMetadata.js");

describe("channelMetadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("derives private channels from Slack info", () => {
    expect(
      deriveConversationType({ id: "C1", is_private: true }),
    ).toBe("private_channel");
  });

  it("derives public channels from Slack info", () => {
    expect(
      deriveConversationType({ id: "C1", is_private: false }),
    ).toBe("public_channel");
  });

  it("resolves channel metadata from Slack", async () => {
    mockSlackClient.fetchChannelInfo.mockResolvedValue({
      ok: true,
      channel: {
        id: "C1",
        name: "sage_team",
        is_private: true,
      },
    });

    await expect(resolveChannelMetadata("W1", "C1")).resolves.toEqual({
      name: "sage_team",
      conversationType: "private_channel",
    });
  });

  it("returns null when Slack metadata lookup fails", async () => {
    mockSlackClient.fetchChannelInfo.mockRejectedValue(new Error("boom"));

    await expect(resolveChannelMetadata("W1", "C1")).resolves.toBeNull();
  });
});
