-- Migration 002: Message analytics table (Phase C sentiment pipeline prep)

CREATE TABLE IF NOT EXISTS message_analytics (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        TEXT NOT NULL,
    channel_id          TEXT NOT NULL,
    message_ts          TEXT NOT NULL,
    dominant_emotion    TEXT NOT NULL
                        CHECK (dominant_emotion IN (
                            'anger','disgust','fear','joy','neutral','sadness','surprise'
                        )),
    confidence          REAL NOT NULL
                        CHECK (confidence >= 0 AND confidence <= 1),
    escalation_risk     TEXT NOT NULL
                        CHECK (escalation_risk IN ('low','medium','high')),
    themes              JSONB DEFAULT '[]',
    decision_signal     BOOLEAN DEFAULT FALSE,
    explanation         TEXT,
    raw_llm_response    JSONB NOT NULL,
    llm_provider        TEXT NOT NULL,
    llm_model           TEXT NOT NULL,
    token_usage         JSONB,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id, message_ts)
);

CREATE INDEX IF NOT EXISTS idx_analytics_channel_time
    ON message_analytics (workspace_id, channel_id, created_at);

CREATE INDEX IF NOT EXISTS idx_analytics_emotion
    ON message_analytics (dominant_emotion);

CREATE INDEX IF NOT EXISTS idx_analytics_high_risk
    ON message_analytics (escalation_risk)
    WHERE escalation_risk IN ('medium','high');
