/// <reference types="node" />

process.env.NODE_ENV ||= "test";
process.env.SLACK_SIGNING_SECRET ||= "test-signing-secret";
process.env.DATABASE_URL ||= "postgresql://postgres:postgres@127.0.0.1:5432/testdb";
process.env.OPENAI_API_KEY ||= "test-openai-key";
process.env.API_AUTH_TOKEN ||= "test-api-token";
