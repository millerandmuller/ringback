import type { Message, Store } from "../db/store.js";
import { isSupportedLanguage, unsupportedLanguageExplanation, type SupportedLanguage } from "../languages.js";
import { translateMessage, translateWithDeadline, type TranslateOutcome } from "../translate.js";
import { publishMessageUpdate } from "../events.js";
import { fetchTranscriptionText } from "./transcription.js";
import { placeDeliverCall, placeRingbackCall } from "./outbound.js";
import { vonage } from "./client.js";
import {
  afterConsentNcco,
  callAgainNcco,
  captureMessageByRecordingNcco,
  captureMessageNcco,
  captureNameNcco,
  confirmFlaggedSendNcco,
  directorySetupMissingNcco,
  nameKeypadListNcco,
  noSilenceCaughtNcco,
  previewTargetLanguageNcco,
  readbackNcco,
  reprompNameNcco,
  retryMessageNcco,
  sentConfirmationNcco,
  toSdkNcco,
  transcriptionFailedNcco,
  translationPendingNcco,
  translationSlowNcco,
  unsupportedLanguageNcco,
  voicemailNcco,
} from "./ncco.js";

// Live per-call scratch state. It only needs to survive the length of one phone
// call — if the process restarts mid-call the call itself drops, so losing this
// map on restart is fine (matches the "please call again" restart fallback).
interface CaptureState {
  managerId: number;
  recipientId?: number;
  messageId?: number;
  forceEnglish?: boolean;
  flaggedSendConfirmed?: boolean;
}
const captureStates = new Map<string, CaptureState>();

const LIVE_CALL_TRANSLATION_DEADLINE_MS = 8_000;
const RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes, per F12
const LOW_CONFIDENCE_THRESHOLD = 0.6;
const TRANSLATION_RETRY_INTERVAL_MS = 30_000;
const TRANSLATION_RETRY_MAX_ATTEMPTS = 20; // 20 * 30s = 10 minutes, per F7

interface SpeechBody {
  speech?: { results?: Array<{ text: string; confidence: string }> };
}
interface DtmfBody {
  dtmf?: { digits?: string };
}
type InputBody = SpeechBody & DtmfBody;

function speechText(body: InputBody): { text: string; confidence: number } | null {
  const result = body.speech?.results?.[0];
  if (!result?.text) return null;
  return { text: result.text, confidence: Number(result.confidence ?? "0") };
}

function dtmfDigits(body: InputBody): string | null {
  return body.dtmf?.digits ?? null;
}

// --- capture leg: answer -------------------------------------------------

export function handleAnswer(store: Store, body: { uuid: string; conversation_uuid: string }) {
  const manager = store.findPersonByAppUser("manager");
  // No DB write happens on this path, so it is trivially safe to repeat on a
  // redelivered answer webhook — never gated behind idempotency.
  if (!manager) return directorySetupMissingNcco();

  // Idempotent by construction rather than by an external once()-style guard:
  // a redelivered answer webhook for a call already answered must not insert
  // calls.uuid twice (it is a primary key), but should still get the same
  // opening NCCO back, not an empty body.
  if (!store.getCall(body.uuid)) {
    store.createCall({ uuid: body.uuid, message_id: null, direction: "inbound", leg: "capture", status: "started" });
    store.recordConsent(body.uuid, "en-US");
  }
  if (!captureStates.has(body.uuid)) {
    captureStates.set(body.uuid, { managerId: manager.id });
  }

  const directoryNames = store.listPeople().filter((p) => p.id !== manager.id).map((p) => p.name);
  return captureNameNcco(directoryNames);
}

/** ALL_PARTY_CONSENT_STATE only: the caller pressed a key (or timed out) after the notice. */
export function handleConsentGateInput(store: Store, uuid: string, body: InputBody) {
  const state = captureStates.get(uuid);
  if (!state) return callAgainNcco();
  if (dtmfDigits(body) !== "1") return sentConfirmationNcco();

  const directoryNames = store.listPeople().filter((p) => p.id !== state.managerId).map((p) => p.name);
  return afterConsentNcco(directoryNames);
}

// --- capture leg: name resolution (3 attempts) ---------------------------

function resolveRecipient(store: Store, state: CaptureState, spokenName: string | undefined) {
  const person = spokenName ? store.findPersonByName(spokenName) : undefined;
  return person && person.id !== state.managerId ? person : undefined;
}

export function handleNameInput(store: Store, uuid: string, body: InputBody) {
  const state = captureStates.get(uuid);
  if (!state) return callAgainNcco();

  const person = resolveRecipient(store, state, speechText(body)?.text);
  if (person) {
    state.recipientId = person.id;
    return captureMessageNcco(person.name);
  }
  return reprompNameNcco();
}

export function handleNameRetryInput(store: Store, uuid: string, body: InputBody) {
  const state = captureStates.get(uuid);
  if (!state) return callAgainNcco();

  const person = resolveRecipient(store, state, speechText(body)?.text);
  if (person) {
    state.recipientId = person.id;
    return captureMessageNcco(person.name);
  }
  const directoryNames = store.listPeople().filter((p) => p.id !== state.managerId).map((p) => p.name);
  return nameKeypadListNcco(directoryNames);
}

export function handleNameKeypadInput(store: Store, uuid: string, body: InputBody) {
  const state = captureStates.get(uuid);
  if (!state) return callAgainNcco();

  const directoryNames = store.listPeople().filter((p) => p.id !== state.managerId).map((p) => p.name);
  const digit = dtmfDigits(body);
  const chosenName = digit ? directoryNames[Number(digit) - 1] : undefined;
  const person = chosenName ? store.findPersonByName(chosenName) : undefined;
  if (person) {
    state.recipientId = person.id;
    return captureMessageNcco(person.name);
  }
  return callAgainNcco();
}

// --- capture leg: message capture (speech, one retry, record fallback) ---

export async function handleMessageInput(store: Store, uuid: string, body: InputBody) {
  const state = captureStates.get(uuid);
  if (!state?.recipientId) return callAgainNcco();

  const result = speechText(body);
  if (result && result.confidence >= LOW_CONFIDENCE_THRESHOLD) {
    return startTranslationForMessage(store, state, result.text);
  }
  return retryMessageNcco();
}

export async function handleMessageRetryInput(store: Store, uuid: string, body: InputBody) {
  const state = captureStates.get(uuid);
  if (!state?.recipientId) return callAgainNcco();

  const result = speechText(body);
  if (result?.text) {
    return startTranslationForMessage(store, state, result.text);
  }
  return captureMessageByRecordingNcco();
}

export function handleMessageRecordingCompleted(): void {
  // Informational only — the text we act on arrives via the transcription
  // callback below. No NCCO response needed; Vonage does not wait on this one.
}

export async function handleMessageTranscription(
  store: Store,
  body: { conversation_uuid: string; transcription_url?: string },
): Promise<void> {
  // The recording's own eventUrl left the call on a short hold loop; find that
  // call by conversation uuid among the calls we are still tracking.
  const entry = [...captureStates.entries()].find(([callUuid]) => callUuid === body.conversation_uuid);
  if (!entry || !body.transcription_url) return;
  const [uuid, state] = entry;
  if (!state.recipientId) return;

  const text = await fetchTranscriptionText(body.transcription_url);
  if (!text) {
    await vonage.voice.transferCallWithNCCO(uuid, toSdkNcco(transcriptionFailedNcco()));
    return;
  }

  const ncco = await startTranslationForMessage(store, state, text);
  await vonage.voice.transferCallWithNCCO(uuid, toSdkNcco(ncco));
}

// --- translation + read-back ---------------------------------------------

async function startTranslationForMessage(store: Store, state: CaptureState, sourceText: string) {
  // A fresh message capture starts a fresh confirmation cycle — this flag
  // must never carry over from a previous message on the same call (today
  // that only matters for a re-record before ever sending, since a
  // successful send ends the call's state entirely, but resetting here keeps
  // that safety explicit rather than incidental).
  state.flaggedSendConfirmed = false;

  const recipient = store.getPerson(state.recipientId!)!;
  const targetLang = state.forceEnglish ? "en-US" : recipient.language;

  if (!state.forceEnglish && !isSupportedLanguage(targetLang)) {
    const message = store.createMessage({
      from_person_id: state.managerId,
      to_person_id: recipient.id,
      source_text: sourceText,
      source_lang: "en-US",
      target_lang: targetLang,
    });
    state.messageId = message.id;
    store.setMessageState(message.id, "unsupported language");
    publishMessageUpdate(store.getMessage(message.id)!);
    return unsupportedLanguageNcco(unsupportedLanguageExplanation(targetLang));
  }

  const effectiveTargetLang: SupportedLanguage = state.forceEnglish ? "en-US" : (targetLang as SupportedLanguage);
  const message = store.createMessage({
    from_person_id: state.managerId,
    to_person_id: recipient.id,
    source_text: sourceText,
    source_lang: "en-US",
    target_lang: effectiveTargetLang,
  });
  state.messageId = message.id;
  publishMessageUpdate(message);

  let settledAfterDeadline = false;
  const outcome = await translateWithDeadline(
    { sourceText, sourceLang: "en-US", targetLang: effectiveTargetLang },
    LIVE_CALL_TRANSLATION_DEADLINE_MS,
    (result) => {
      settledAfterDeadline = true;
      if (result.ok) applyTranslation(store, message.id, result);
    },
  );

  if (outcome.ok) {
    applyTranslation(store, message.id, outcome);
    const updated = store.getMessage(message.id)!;
    return readbackNcco(updated.back_translation!, updated.flags !== "[]");
  }

  if (!settledAfterDeadline) {
    // The deadline fired first; the request is still running in the background
    // and applyTranslation will run from its own .then() once it settles.
    store.setMessageState(message.id, "translation pending");
    publishMessageUpdate(store.getMessage(message.id)!);
    return translationPendingNcco();
  }

  store.setMessageState(message.id, "translation pending");
  publishMessageUpdate(store.getMessage(message.id)!);
  scheduleTranslationRetry(store, message.id);
  return translationSlowNcco();
}

function applyTranslation(store: Store, messageId: number, outcome: Extract<TranslateOutcome, { ok: true }>) {
  store.setTranslation(messageId, {
    target_text: outcome.data.translation,
    back_translation: outcome.data.back_translation,
    flags: outcome.data.flags,
  });
  store.setMessageState(messageId, "draft");
  publishMessageUpdate(store.getMessage(messageId)!);
}

function scheduleTranslationRetry(store: Store, messageId: number, attemptsLeft = TRANSLATION_RETRY_MAX_ATTEMPTS): void {
  if (attemptsLeft <= 0) {
    store.setMessageState(messageId, "failed");
    publishMessageUpdate(store.getMessage(messageId)!);
    return;
  }
  setTimeout(async () => {
    try {
      const message = store.getMessage(messageId);
      if (!message || message.state !== "translation pending") return;
      const outcome = await translateMessage({
        sourceText: message.source_text!,
        sourceLang: message.source_lang,
        targetLang: message.target_lang,
      });
      if (outcome.ok) {
        applyTranslation(store, messageId, outcome);
      } else {
        scheduleTranslationRetry(store, messageId, attemptsLeft - 1);
      }
    } catch (error) {
      // translateMessage() already catches its own errors and returns a typed
      // outcome; this only guards against something unexpected (e.g. a store
      // write failure) so one bad attempt can never crash the shared process.
      console.error(`Translation retry failed for message ${messageId}:`, error);
      const message = store.getMessage(messageId);
      if (message && message.state === "translation pending") {
        store.setMessageState(messageId, "failed");
        publishMessageUpdate(store.getMessage(messageId)!);
      }
    }
  }, TRANSLATION_RETRY_INTERVAL_MS).unref();
}

// --- capture leg: read-back (1 send / 2 re-record / 3 preview) -----------

/** Places the deliver call and marks the message sent. Shared by the direct
 *  send path (unflagged) and the confirm-flagged path (F2 / dossier T-01). */
async function sendMessage(store: Store, uuid: string, message: Message) {
  const worker = store.getPerson(message.to_person_id)!;
  const manager = store.getPerson(message.from_person_id)!;
  if (!worker.phone) {
    store.setMessageState(message.id, "failed");
    publishMessageUpdate(store.getMessage(message.id)!);
    return sentConfirmationNcco();
  }
  const deliverCall = await placeDeliverCall({
    toPhone: worker.phone,
    senderName: manager.name,
    targetLang: message.target_lang as SupportedLanguage,
    targetText: message.target_text!,
  });
  store.createCall({
    uuid: deliverCall.uuid,
    message_id: message.id,
    direction: "outbound",
    leg: "deliver",
    status: "started",
  });
  store.recordConsent(deliverCall.uuid, message.target_lang);
  store.setMessageState(message.id, "sent");
  publishMessageUpdate(store.getMessage(message.id)!);
  captureStates.delete(uuid);
  return sentConfirmationNcco();
}

export async function handleReadbackInput(store: Store, uuid: string, body: InputBody) {
  const state = captureStates.get(uuid);
  if (!state?.messageId) return callAgainNcco();
  const message = store.getMessage(state.messageId)!;
  const digit = dtmfDigits(body);
  const flagged = message.flags !== "[]";

  // Vonage can deliver the same input webhook twice within a second; a second "1"
  // must never place a second delivery call.
  if (digit === "1" && message.state !== "draft") {
    return sentConfirmationNcco();
  }

  if (digit === "1") {
    if (flagged && !state.flaggedSendConfirmed) {
      return confirmFlaggedSendNcco(message.back_translation ?? "");
    }
    return sendMessage(store, uuid, message);
  }

  if (digit === "2") {
    const worker = store.getPerson(message.to_person_id)!;
    return captureMessageNcco(worker.name);
  }

  if (digit === "3") {
    return previewTargetLanguageNcco(message.target_text ?? "", message.back_translation ?? "", flagged);
  }

  return noSilenceCaughtNcco();
}

// --- capture leg: second confirmation for a flagged translation (F2 / T-01) --

export async function handleConfirmFlaggedInput(store: Store, uuid: string, body: InputBody) {
  const state = captureStates.get(uuid);
  if (!state?.messageId) return callAgainNcco();
  const message = store.getMessage(state.messageId)!;
  const digit = dtmfDigits(body);

  if (digit === "1") {
    state.flaggedSendConfirmed = true;
    return sendMessage(store, uuid, message);
  }

  if (digit === "2") {
    const worker = store.getPerson(message.to_person_id)!;
    return captureMessageNcco(worker.name);
  }

  return noSilenceCaughtNcco();
}

// --- capture leg: unsupported-language offer to send in English ----------

export async function handleUnsupportedOfferInput(store: Store, uuid: string, body: InputBody) {
  const state = captureStates.get(uuid);
  if (!state?.messageId) return callAgainNcco();
  if (dtmfDigits(body) !== "1") return sentConfirmationNcco();

  state.forceEnglish = true;
  const message = store.getMessage(state.messageId)!;
  return startTranslationForMessage(store, state, message.source_text ?? "");
}

// --- deliver leg: reply capture -------------------------------------------

export async function handleReplyInput(store: Store, body: InputBody & { uuid?: string }): Promise<void> {
  const uuid = body.uuid;
  if (!uuid) return;
  const call = store.getCall(uuid);
  if (!call?.message_id) return;
  const message = store.getMessage(call.message_id)!;
  const worker = store.getPerson(message.to_person_id)!;

  const digit = dtmfDigits(body);
  if (digit === "1") {
    store.setMessageState(message.id, "understood");
    publishMessageUpdate(store.getMessage(message.id)!);
    return;
  }

  const spoken = speechText(body);
  if (spoken?.text) {
    const outcome = await translateMessage({
      sourceText: spoken.text,
      sourceLang: message.target_lang,
      targetLang: "en-US",
    });
    const replyEnglish = outcome.ok ? outcome.data.translation : spoken.text;
    store.setReply(message.id, spoken.text, replyEnglish);
    store.setMessageState(message.id, "replied");
    publishMessageUpdate(store.getMessage(message.id)!);
    const ringback = await placeRingbackCall({ replyEnglishText: replyEnglish, workerName: worker.name });
    store.createCall({
      uuid: ringback.uuid,
      message_id: message.id,
      direction: "outbound",
      leg: "ringback",
      status: "started",
    });
    store.recordConsent(ringback.uuid, "en-US");
  }
  // Silence after the tone: no state change, per the fallback table.
}

// --- deliver leg: machine detection / voicemail (F12) ---------------------

export async function handleMachineDetectionEvent(
  store: Store,
  body: { call_uuid?: string; uuid?: string; status: string; sub_state?: string },
) {
  const uuid = body.call_uuid ?? body.uuid;
  if (!uuid || body.status !== "machine") return null;
  if (body.sub_state !== "beep_start" && body.sub_state !== "beep_timeout") return null;

  const call = store.getCall(uuid);
  if (!call?.message_id) return null;
  const message = store.getMessage(call.message_id)!;
  // Guard against re-firing: a call can report both beep_start and
  // beep_timeout, and each is its own event, so without this check both would
  // independently transition the message and each schedule its own retry —
  // ringing the worker twice for one voicemail. Only "sent" -> "left on
  // voicemail" is a valid transition; a second AMD event for the same call
  // finds the message already past "sent" and is treated as a no-op.
  if (message.state !== "sent") return null;
  const manager = store.getPerson(message.from_person_id)!;

  store.setMessageState(message.id, "left on voicemail");
  publishMessageUpdate(store.getMessage(message.id)!);
  scheduleDeliverRetry(store, message.id);

  return voicemailNcco({
    senderName: manager.name,
    targetLang: message.target_lang as SupportedLanguage,
    targetText: message.target_text ?? "",
  });
}

function scheduleDeliverRetry(store: Store, messageId: number): void {
  setTimeout(async () => {
    try {
      const message = store.getMessage(messageId);
      if (!message || message.state !== "left on voicemail") return;
      const worker = store.getPerson(message.to_person_id)!;
      const manager = store.getPerson(message.from_person_id)!;
      if (!worker.phone) return;
      const call = await placeDeliverCall({
        toPhone: worker.phone,
        senderName: manager.name,
        targetLang: message.target_lang as SupportedLanguage,
        targetText: message.target_text ?? "",
      });
      store.createCall({ uuid: call.uuid, message_id: messageId, direction: "outbound", leg: "deliver", status: "started" });
      store.recordConsent(call.uuid, message.target_lang);
    } catch (error) {
      // The single Node process backing the whole demo must survive a failed
      // retry (e.g. a rejected outbound call) — degrade this one message
      // instead of leaving an unhandled rejection that can crash the process.
      console.error(`Voicemail retry failed for message ${messageId}:`, error);
      const message = store.getMessage(messageId);
      if (message && message.state === "left on voicemail") {
        store.setMessageState(messageId, "failed");
        publishMessageUpdate(store.getMessage(messageId)!);
      }
    }
  }, RETRY_DELAY_MS).unref();
}

// --- generic call status bookkeeping --------------------------------------

const UNANSWERED_TERMINAL_STATUSES = new Set(["busy", "cancelled", "failed", "rejected", "timeout", "unanswered"]);

export function handleCallStatusEvent(store: Store, body: { uuid: string; status: string }): void {
  const call = store.getCall(body.uuid);
  store.updateCallStatus(body.uuid, body.status);

  if (call?.leg !== "deliver" || !call.message_id) return;
  if (!UNANSWERED_TERMINAL_STATUSES.has(body.status)) return;

  const message = store.getMessage(call.message_id);
  if (message?.state !== "sent") return;

  store.setMessageState(message.id, "left on voicemail");
  publishMessageUpdate(store.getMessage(message.id)!);
  scheduleDeliverRetry(store, message.id);
}
