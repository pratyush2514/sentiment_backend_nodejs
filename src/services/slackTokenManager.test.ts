import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRow } from "../types/database.js";

vi.mock("../config.js", () => ({
  config: {
    NODE_ENV: "test",
    SLACK_CLIENT_ID: "client-id",
    SLACK_CLIENT_SECRET: "client-secret",
    SLACK_BOT_TOKEN: "",
    SLACK_BOT_USER_ID: "",
    SLACK_TOKEN_REFRESH_BUFFER_MINUTES: 10,
    SLACK_TOKEN_REFRESH_LOOKAHEAD_MINUTES: 15,
  },
}));

vi.mock("../utils/logger.js", () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      success: vi.fn(),
    }),
  },
}));

vi.mock("../db/queries.js", () => ({
  getWorkspaceBotCredentials: vi.fn(),
  updateWorkspaceRotatedBotToken: vi.fn(),
  recordWorkspaceTokenRefreshFailure: vi.fn(),
  listExpiringWorkspaceIds: vi.fn().mockResolvedValue([]),
}));

vi.mock("../db/pool.js", () => ({
  pool: {
    connect: vi.fn(),
  },
}));

vi.mock("./tokenEncryption.js", () => ({
  decryptToken: vi.fn((ciphertext: Buffer) => ciphertext.toString("utf8")),
  encryptToken: vi.fn((plaintext: string) => ({
    ciphertext: Buffer.from(plaintext, "utf8"),
    iv: Buffer.from(`iv:${plaintext}`, "utf8"),
    tag: Buffer.from(`tag:${plaintext}`, "utf8"),
  })),
}));

const db = await import("../db/queries.js");
const { pool } = await import("../db/pool.js");
const {
  deriveWorkspaceTokenRotationStatus,
  getUsableBotToken,
  refreshWorkspaceBotToken,
  SlackTokenRotationError,
} = await import("./slackTokenManager.js");

function makeWorkspaceRow(
  overrides: Partial<WorkspaceRow> = {},
): WorkspaceRow {
  return {
    workspace_id: "T123",
    team_name: "Sage",
    bot_token_encrypted: Buffer.from("xoxb-access", "utf8"),
    bot_token_iv: Buffer.from("iv-access", "utf8"),
    bot_token_tag: Buffer.from("tag-access", "utf8"),
    bot_refresh_token_encrypted: Buffer.from("xoxe-refresh", "utf8"),
    bot_refresh_token_iv: Buffer.from("iv-refresh", "utf8"),
    bot_refresh_token_tag: Buffer.from("tag-refresh", "utf8"),
    bot_token_expires_at: new Date(Date.now() + 60 * 60 * 1000),
    last_token_refresh_at: null,
    last_token_refresh_error: null,
    last_token_refresh_error_at: null,
    bot_user_id: "U123",
    installed_by: "U999",
    installed_at: new Date(),
    scopes: ["channels:history"],
    install_status: "active",
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("deriveWorkspaceTokenRotationStatus", () => {
  it("marks active workspaces without refresh tokens as legacy installs", () => {
    const status = deriveWorkspaceTokenRotationStatus(
      makeWorkspaceRow({
        bot_refresh_token_encrypted: null,
        bot_refresh_token_iv: null,
        bot_refresh_token_tag: null,
      }),
    );

    expect(status).toBe("legacy_reinstall_required");
  });
});

describe("getUsableBotToken", () => {
  it("returns the current token when it is still safely valid", async () => {
    vi.mocked(db.getWorkspaceBotCredentials).mockResolvedValue(
      makeWorkspaceRow(),
    );

    const result = await getUsableBotToken("T123");

    expect(result.botToken).toBe("xoxb-access");
    expect(result.botUserId).toBe("U123");
    expect(result.tokenRotationStatus).toBe("ready");
  });

  it("fails explicitly for legacy installs without refresh tokens", async () => {
    vi.mocked(db.getWorkspaceBotCredentials).mockResolvedValue(
      makeWorkspaceRow({
        bot_refresh_token_encrypted: null,
        bot_refresh_token_iv: null,
        bot_refresh_token_tag: null,
      }),
    );

    await expect(getUsableBotToken("T123")).rejects.toMatchObject({
      code: "legacy_reinstall_required",
    });
  });
});

describe("refreshWorkspaceBotToken", () => {
  function mockLockedClient(row: WorkspaceRow) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM workspaces")) {
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const release = vi.fn();
    vi.mocked(pool.connect).mockResolvedValue({
      query,
      release,
    } as never);
    return { query, release };
  }

  it("rotates access and refresh tokens on successful refresh", async () => {
    const row = makeWorkspaceRow({
      bot_token_expires_at: new Date(Date.now() + 30 * 1000),
    });
    mockLockedClient(row);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          access_token: "xoxb-new",
          refresh_token: "xoxe-new",
          expires_in: 3600,
          bot_user_id: "U777",
        }),
      }),
    );

    const result = await refreshWorkspaceBotToken("T123", {
      reason: "proactive",
    });

    expect(result.botToken).toBe("xoxb-new");
    expect(result.botUserId).toBe("U777");
    expect(db.updateWorkspaceRotatedBotToken).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "T123",
        botUserId: "U777",
      }),
    );
  });

  it("records refresh failures without corrupting stored credentials", async () => {
    mockLockedClient(
      makeWorkspaceRow({
        bot_token_expires_at: new Date(Date.now() + 30 * 1000),
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: false,
          error: "invalid_refresh_token",
        }),
      }),
    );

    await expect(
      refreshWorkspaceBotToken("T123", { reason: "auth_failure" }),
    ).rejects.toBeInstanceOf(SlackTokenRotationError);

    expect(db.recordWorkspaceTokenRefreshFailure).toHaveBeenCalledWith(
      "T123",
      expect.stringContaining("invalid_refresh_token"),
    );
    expect(db.updateWorkspaceRotatedBotToken).not.toHaveBeenCalled();
  });
});
