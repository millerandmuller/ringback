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

/** Idempotent: the Conversation user backing the board's in-app call must exist once. */
export async function ensureManagerUser(): Promise<void> {
  try {
    await vonage.users.createUser({ name: MANAGER_APP_USER, displayName: "Manager" });
  } catch (error) {
    if (error instanceof VetchError && error.response?.status === 409) return;
    throw error;
  }
}
