import { AdvancedMachineDetectionMode, MachineDetectionBehavior } from "@vonage/voice";
import { config } from "../config.js";
import type { SupportedLanguage } from "../languages.js";
import { deliverNcco, ringbackNcco, toSdkNcco } from "./ncco.js";
import { MANAGER_APP_USER, vonage } from "./client.js";

export async function placeDeliverCall(input: {
  toPhone: string;
  senderName: string;
  targetLang: SupportedLanguage;
  targetText: string;
}): Promise<{ uuid: string }> {
  const call = await vonage.voice.createOutboundCall({
    to: [{ type: "phone", number: input.toPhone }],
    from: { type: "phone", number: config.vonage.number },
    ncco: toSdkNcco(
      deliverNcco({
        senderName: input.senderName,
        targetLang: input.targetLang,
        targetText: input.targetText,
      }),
    ),
    advancedMachineDetection: {
      behavior: MachineDetectionBehavior.CONTINUE,
      mode: AdvancedMachineDetectionMode.DETECTBEEP,
    },
  });
  return { uuid: call.uuid };
}

export async function placeRingbackCall(input: {
  replyEnglishText: string;
  workerName: string;
}): Promise<{ uuid: string }> {
  const call = await vonage.voice.createOutboundCall({
    to: [{ type: "app", user: MANAGER_APP_USER }],
    from: { type: "phone", number: config.vonage.number },
    ncco: toSdkNcco(ringbackNcco(input.replyEnglishText, input.workerName)),
  });
  return { uuid: call.uuid };
}
