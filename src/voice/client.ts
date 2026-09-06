import { Auth } from "@vonage/auth";
import { Vonage } from "@vonage/server-sdk";
import { VetchError } from "@vonage/vetch";
import { config } from "../config.js";

export const vonage = new Vonage(
  new Auth({
    applicationId: config.vonage.applicationId,
    privateKey: config.vonage.privateKey,
    apiKey: config.vonage.apiKey,
    apiSecret: config.vonage.apiSecret,
  }),
);

export const MANAGER_APP_USER = "manager";

/**
 * Idempotent: the Conversation user backing the board's in-app call must exist once.
 * Vonage reports an existing name as HTTP 400 with code "user:error:duplicate-name"
 * (not 409), so both are treated as "already there" — otherwise every restart of the
 * server after the first would crash before listening.
 */
export async function ensureManagerUser(): Promise<void> {
  try {
    await vonage.users.createUser({ name: MANAGER_APP_USER, displayName: "Manager" });
  } catch (error) {
    if (error instanceof VetchError && (await isDuplicateUserError(error))) return;
    throw error;
  }
}

async function isDuplicateUserError(error: VetchError): Promise<boolean> {
  const status = error.response?.status;
  if (status === 409) return true;
  if (status !== 400) return false;
  try {
    const body = await error.response?.clone().text();
    return typeof body === "string" && body.includes("duplicate-name");
  } catch {
    return false;
  }
}
