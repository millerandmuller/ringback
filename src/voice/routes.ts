import type { FastifyInstance } from "fastify";
import type { Store } from "../db/store.js";
import {
  handleAnswer,
  handleCallStatusEvent,
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

/** Every input/event webhook carries a call uuid; duplicates are a documented
 *  Vonage behavior, so each state-mutating step is only ever applied once. */
function once(store: Store, uuid: string | undefined, tag: string): boolean {
  if (!uuid) return true;
  return store.markEventOnce(uuid, tag);
}

export function registerVoiceRoutes(app: FastifyInstance, store: Store): void {
  app.post("/voice/answer", async (req, reply) => {
    const body = req.body as { uuid: string; conversation_uuid: string };
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
    const body = req.body as { uuid: string };
    if (!once(store, body.uuid, "input:name")) return reply.code(200).send();
    reply.send(handleNameInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/name-retry", async (req, reply) => {
    const body = req.body as { uuid: string };
    if (!once(store, body.uuid, "input:name-retry")) return reply.code(200).send();
    reply.send(handleNameRetryInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/name-keypad", async (req, reply) => {
    const body = req.body as { uuid: string };
    if (!once(store, body.uuid, "input:name-keypad")) return reply.code(200).send();
    reply.send(handleNameKeypadInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/consent-gate", async (req, reply) => {
    const body = req.body as { uuid: string };
    if (!once(store, body.uuid, "input:consent-gate")) return reply.code(200).send();
    reply.send(handleConsentGateInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/message", async (req, reply) => {
    const body = req.body as { uuid: string };
    if (!once(store, body.uuid, "input:message")) return reply.code(200).send();
    reply.send(await handleMessageInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/message-retry", async (req, reply) => {
    const body = req.body as { uuid: string };
    if (!once(store, body.uuid, "input:message-retry")) return reply.code(200).send();
    reply.send(await handleMessageRetryInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/message-recording", async (_req, reply) => {
    handleMessageRecordingCompleted();
    reply.code(200).send();
  });

  app.post("/voice/input/message-transcription", async (req, reply) => {
    const body = req.body as { conversation_uuid: string; transcription_url?: string };
    if (!once(store, body.conversation_uuid, "input:message-transcription")) {
      return reply.code(200).send();
    }
    await handleMessageTranscription(store, body);
    reply.code(200).send();
  });

  app.post("/voice/input/readback", async (req, reply) => {
    const body = req.body as { uuid: string };
    if (!once(store, body.uuid, "input:readback")) return reply.code(200).send();
    reply.send(await handleReadbackInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/unsupported-offer", async (req, reply) => {
    const body = req.body as { uuid: string };
    if (!once(store, body.uuid, "input:unsupported-offer")) return reply.code(200).send();
    reply.send(await handleUnsupportedOfferInput(store, body.uuid, req.body as any));
  });

  app.post("/voice/input/reply", async (req, reply) => {
    const body = req.body as { uuid: string };
    if (!once(store, body.uuid, "input:reply")) return reply.code(200).send();
    await handleReplyInput(store, req.body as any);
    reply.code(200).send();
  });
}
