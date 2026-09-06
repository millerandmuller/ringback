// M0 verification: proves the Vonage application + linked number can place a real
// outbound call, before any of the Ringback call-flow code is built on top of it.
// No webhook infrastructure needed — the NCCO is inline, not fetched from an answer_url.
import { readFileSync } from "node:fs";
import { Auth } from "@vonage/auth";
import { Vonage } from "@vonage/server-sdk";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} in .env — see .env.example`);
    process.exit(1);
  }
  return value;
}

const applicationId = requireEnv("VONAGE_APPLICATION_ID");
const privateKeyPath = requireEnv("VONAGE_PRIVATE_KEY_PATH");
const fromNumber = requireEnv("VONAGE_NUMBER");
const toNumber = requireEnv("M0_TEST_DESTINATION");

let privateKey: Buffer;
try {
  privateKey = readFileSync(privateKeyPath);
} catch {
  console.error(
    `Could not read private key at ${privateKeyPath}. This is the .key file Vonage ` +
      `offered for download when the application was created — it is never shown again ` +
      `on the dashboard. Point VONAGE_PRIVATE_KEY_PATH at it.`,
  );
  process.exit(1);
}

const vonage = new Vonage(
  new Auth({
    applicationId,
    privateKey,
  }),
);

console.log(`Calling ${toNumber} from ${fromNumber} via application ${applicationId}...`);

try {
  const call = await vonage.voice.createOutboundCall({
    to: [{ type: "phone", number: toNumber }],
    from: { type: "phone", number: fromNumber },
    ncco: [
      {
        action: "talk",
        text: "This is a Ringback test call. If you can hear this, outbound calling works.",
        language: "en-US",
      },
    ],
  });

  console.log("Call created:", call);
  console.log(
    `\nIf your phone rings and speaks the message, M0 is proven. ` +
      `Call uuid ${call.uuid ?? "(none returned)"}, status "${call.status ?? "unknown"}".`,
  );
} catch (error) {
  console.error("Outbound call failed:", error);
  console.error(
    "\nCommon causes: number not linked to this application, trial account cannot dial " +
      "an unverified destination, private key does not match the application's public key, " +
      "or insufficient balance.",
  );
  process.exit(1);
}
