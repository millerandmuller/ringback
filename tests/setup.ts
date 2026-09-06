import { fileURLToPath } from "node:url";

// config.ts reads these eagerly on import; tests never place a real call or
// hit a real API, so fixture values are enough to satisfy the module boundary.
process.env.VONAGE_APPLICATION_ID ??= "test-application-id";
process.env.VONAGE_PRIVATE_KEY_PATH ??= fileURLToPath(new URL("./fixtures/dummy-private-key.pem", import.meta.url));
process.env.VONAGE_NUMBER ??= "12015550100";
process.env.SERVER_BASE_URL ??= "https://ringback.test";
process.env.ANTHROPIC_API_KEY ??= "test-anthropic-key";
process.env.DATABASE_PATH ??= ":memory:";
