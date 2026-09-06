import { readFileSync } from "node:fs";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} — see .env.example`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  serverBaseUrl: requireEnv("SERVER_BASE_URL").replace(/\/$/, ""),
  databasePath: process.env.DATABASE_PATH ?? "./ringback.db",
  allPartyConsentState: process.env.ALL_PARTY_CONSENT_STATE === "true",

  vonage: {
    applicationId: requireEnv("VONAGE_APPLICATION_ID"),
    privateKey: readFileSync(requireEnv("VONAGE_PRIVATE_KEY_PATH")),
    number: requireEnv("VONAGE_NUMBER"),
    // Regional API host the browser Client SDK must call directly (e.g. https://api-us-3.vonage.com).
    // The generic api-us host redirects to the account's home region, and a redirect inside a
    // CORS request fails in the browser ("Failed to fetch"). Optional: unset = SDK default.
    clientApiUrl: process.env.VONAGE_CLIENT_API_URL || null,
    apiKey: process.env.VONAGE_API_KEY,
    apiSecret: process.env.VONAGE_API_SECRET,
  },

  anthropic: {
    apiKey: requireEnv("ANTHROPIC_API_KEY"),
    model: "claude-opus-5",
  },
};
