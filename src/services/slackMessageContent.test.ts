import { describe, expect, it } from "vitest";
import {
  extractSlackMessageText,
  hasSlackMessageBody,
} from "./slackMessageContent.js";

describe("extractSlackMessageText", () => {
  it("collects text from attachments and blocks when top-level text is empty", () => {
    const text = extractSlackMessageText({
      text: "",
      attachments: [
        {
          title: "Build failed",
          pretext: "CI notification",
          fields: [{ title: "Owner", value: "Platform" }],
        },
      ],
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "Deploy blocked" },
          elements: [
            {
              type: "rich_text_section",
              elements: [
                {
                  type: "link",
                  url: "https://example.com/run/123",
                },
              ],
            },
          ],
        },
      ],
    });

    expect(text).toBe(
      [
        "Build failed",
        "CI notification",
        "Owner",
        "Platform",
        "Deploy blocked",
        "<https://example.com/run/123>",
      ].join("\n"),
    );
  });

  it("deduplicates repeated text fragments", () => {
    const text = extractSlackMessageText({
      text: "Same",
      attachments: [{ text: "Same" }],
      blocks: [{ text: { type: "plain_text", text: "Same" } }],
    });

    expect(text).toBe("Same");
  });
});

describe("hasSlackMessageBody", () => {
  it("returns true for block-only messages", () => {
    expect(
      hasSlackMessageBody({
        blocks: [{ text: { type: "mrkdwn", text: "Workflow alert" } }],
      }),
    ).toBe(true);
  });

  it("returns true for file-only messages", () => {
    expect(
      hasSlackMessageBody({
        files: [{ id: "F1", name: "incident.log" }],
      }),
    ).toBe(true);
  });
});
