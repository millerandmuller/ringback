import type { FastifyInstance } from "fastify";
import type { Store } from "../db/store.js";
import {
  handleAnswer,
  handleCallStatusEvent,
  handleConfirmFlaggedInput,
  handleConsentGateInput,
  handleMachineDetectionEvent,
  handleMessageInput,
  handleMessageRecordingCompleted,
  handleMessageRetryInput,
  handleMessageTranscription,
  handleNameInput,
  handleNameKeypadInput,
  handleNameRetryInput,
  handleReadbackInput,
  handleReplyInput,
  handleUnsupportedOfferInput,
} from "./flow.js";

/** For events that can only ever legitimately happen once per call (answering,
 *  a given status transition): dedupe on the call uuid (+ tag) alone. */
function once(store: Store, uuid: string | undefined, tag: string): boolean {
  if (!uuid) return true;
  return store.markEventOnce(uuid, tag);
}

/**
 * Input webhooks can legitimately fire more than once on the same route within
 * one call — pressing 2 to re-record revisits `/voice/input/message`, pressing
 * 3 then 1 revisits `/voice/input/readback`. Deduping on (uuid, tag) alone, as
 * `once()` does, would treat that legitimate second visit as a duplicate and
 * silently swallow it. Vonage's documented input webhook payload (dtmf and
 * speech results) always carries a `timestamp` field, and it is reasonable to
 * expect it stays identical across a true redelivery of the same event while
 * differing between two distinct real events — folding it into the key blocks
 * genuine duplicates without blocking legitimate re-entry.
 *
 * If a payload is ever missing `timestamp` (not expected per Vonage's docs,
 * but not something this code should trust blindly), fail toward safety: fall
 * back to the plain per-(uuid, tag) key, which blocks BOTH a true duplicate
 * and a second legitimate visit. A rare swallowed re-entry in a case the docs
 * say should not occur is a far smaller cost than the alternative — dedup
 * silently disabled, so a genuine duplicate delivery double-places a real
 * outbound call or double-translates a reply.
 */
function onceInput(store: Store, uuid: string | undefined, tag: string, timestamp: string | undefined): boolean {
  if (!uuid) return true;
  const key = timestamp ? `${tag}:${timestamp}` : tag;
  return store.markEventOnce(uuid, key);
}

export function registerVoiceRoutes(app: FastifyInstance, store: Store): void {
  app.post("/voice/answer", async (req, reply) => {
    const body = req.body as { uuid: string; conversation_uuid: string };
    // handleAnswer is idempotent by construction (checks for an existing call
    // row before inserting) so a redelivery gets the correct opening NCCO
    // again, not an empty body — a route-level guard here would otherwise
    // swallow a legitimate retry of the "directory not set up" error NCCO,
    // since that path never writes to calls.uuid in the first place.
    reply.send(handleAnswer(store, body));
  });

  app.post("/voice/event", async (req, reply) => {
    const body = req.body as {
      uuid: string;
      call_uuid?: string;
      status: string;
      sub_state?: string;
    };
    if (!once(store, body.uuid, `event:${body.status}:${body.sub_state ?? ""}`)) {
      reply.code(200).send();
      return;
    }

    const voicemailNcco = await handleMachineDetectionEvent(store, body);
    if (voicemailNcco) {
      reply.send(voicemailNcco);
      return;
    }

    handleCallStatusEvent(store, body);
    reply.code(200).send();
  });

  app.post("/voice/input/name", async (req, reply) => {
    const body = req.body as { uuid: string; timestamp?: string };
    if (!onceInput(store, body.uuid, "input:name", body.timestamp)) return reply.code(200).send();
    reply.send(handleNameInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/name-retry", async (req, reply) => {
    const body = req.body as { uuid: string; timestamp?: string };
    if (!onceInput(store, body.uuid, "input:name-retry", body.timestamp)) return reply.code(200).send();
    reply.send(handleNameRetryInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/name-keypad", async (req, reply) => {
    const body = req.body as { uuid: string; timestamp?: string };
    if (!onceInput(store, body.uuid, "input:name-keypad", body.timestamp)) return reply.code(200).send();
    reply.send(handleNameKeypadInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/consent-gate", async (req, reply) => {
    const body = req.body as { uuid: string; timestamp?: string };
    if (!onceInput(store, body.uuid, "input:consent-gate", body.timestamp)) return reply.code(200).send();
    reply.send(handleConsentGateInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/message", async (req, reply) => {
    const body = req.body as { uuid: string; timestamp?: string };
    if (!onceInput(store, body.uuid, "input:message", body.timestamp)) return reply.code(200).send();
    reply.send(await handleMessageInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/message-retry", async (req, reply) => {
    const body = req.body as { uuid: string; timestamp?: string };
    if (!onceInput(store, body.uuid, "input:message-retry", body.timestamp)) return reply.code(200).send();
    reply.send(await handleMessageRetryInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/message-recording", async (_req, reply) => {
    handleMessageRecordingCompleted();
    reply.code(200).send();
  });

  app.post("/voice/input/message-transcription", async (req, reply) => {
    const body = req.body as {
      conversation_uuid: string;
      transcription_url?: string;
      recording_uuid?: string;
    };
    // No `timestamp` field on this callback; a real recording only ever
    // completes transcription once, so dedupe on its own uuid is sufficient.
    const dedupeKey = body.recording_uuid ?? "transcription";
    if (!once(store, body.conversation_uuid, dedupeKey)) {
      return reply.code(200).send();
    }
    await handleMessageTranscription(store, body);
    reply.code(200).send();
  });

  app.post("/voice/input/readback", async (req, reply) => {
    const body = req.body as { uuid: string; timestamp?: string };
    if (!onceInput(store, body.uuid, "input:readback", body.timestamp)) return reply.code(200).send();
    reply.send(await handleReadbackInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/confirm-flagged", async (req, reply) => {
    const body = req.body as { uuid: string; timestamp?: string };
    if (!onceInput(store, body.uuid, "input:confirm-flagged", body.timestamp)) return reply.code(200).send();
    reply.send(await handleConfirmFlaggedInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/unsupported-offer", async (req, reply) => {
    const body = req.body as { uuid: string; timestamp?: string };
    if (!onceInput(store, body.uuid, "input:unsupported-offer", body.timestamp)) return reply.code(200).send();
    reply.send(await handleUnsupportedOfferInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/reply", async (req, reply) => {
    const body = req.body as { uuid: string; timestamp?: string };
    if (!onceInput(store, body.uuid, "input:reply", body.timestamp)) return reply.code(200).send();
    // An NCCO comes back only when nothing usable was captured: it re-prompts the
    // worker instead of letting the call end silently on her.
    const ncco = await handleReplyInput(store, req.body as any);
    if (ncco) return reply.send(ncco);
    reply.code(200).send();
  });
}
