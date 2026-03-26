import { describe, expect, it } from "vitest";
import { parseFathomSharePageHtml } from "./fathomSharePage.js";

describe("parseFathomSharePageHtml", () => {
  it("extracts meaningful meeting metadata from JSON-LD and meta tags", () => {
    const html = `
      <html>
        <head>
          <title>Sage Kick Off Call</title>
          <meta property="og:title" content="Sage Kick Off Call" />
          <meta property="og:description" content="Client wants a revised launch plan and timeline." />
          <script type="application/ld+json">
            {
              "@context": "https://schema.org",
              "name": "Sage Kick Off Call",
              "description": "Client wants a revised launch plan and timeline.",
              "startDate": "2026-03-24T10:00:00.000Z",
              "duration": "PT35M"
            }
          </script>
        </head>
        <body></body>
      </html>
    `;

    const result = parseFathomSharePageHtml(
      html,
      "https://fathom.video/share/shared-123",
    );

    expect(result).toEqual(
      expect.objectContaining({
        meetingSource: "shared_link",
        title: "Sage Kick Off Call",
        shareUrl: "https://fathom.video/share/shared-123",
        recordingStartTime: "2026-03-24T10:00:00.000Z",
        durationSeconds: 2100,
        defaultSummary: {
          markdownFormatted: "Client wants a revised launch plan and timeline.",
        },
      }),
    );
  });

  it("uses fallbackStartedAt when the page has summary content but no explicit meeting time", () => {
    const html = `
      <html>
        <head>
          <meta property="og:title" content="Impromptu call" />
          <meta property="og:description" content="Discussed the rollout blocker and next update." />
        </head>
      </html>
    `;

    const result = parseFathomSharePageHtml(
      html,
      "https://fathom.video/share/shared-456",
      {
        fallbackStartedAt: "2026-03-25T09:30:00.000Z",
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        title: "Impromptu call",
        recordingStartTime: "2026-03-25T09:30:00.000Z",
      }),
    );
  });

  it("returns null when the page has no meaningful meeting content", () => {
    const html = `
      <html>
        <head><title>Fathom</title></head>
        <body><p>Sign in to continue</p></body>
      </html>
    `;

    expect(
      parseFathomSharePageHtml(
        html,
        "https://fathom.video/share/shared-empty",
      ),
    ).toBeNull();
  });
});
