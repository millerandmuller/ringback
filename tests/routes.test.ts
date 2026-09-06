import type { TranslationResult } from "../src/translate.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { openDb, Store } from "../src/db/store.js";
import { registerVoiceRoutes } from "../src/voice/routes.js";

// These tests exercise the real Fastify route stack (routes.ts -> flow.ts ->
// store.ts), not flow.ts's handlers directly, so the routes.ts idempotency
// guard is actually in the loop — this is what the earlier adversarial review
// found missing from flow.test.ts's coverage.

vi.mock("../src/voice/outbound.js", () => ({
  placeDeliverCall: vi.fn(async () => ({ uuid: "deliver-uuid" })),
  placeRingbackCall: vi.fn(async () => ({ uuid: "ringback-uuid" })),
}));
vi.mock("../src/translate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/translate.js")>();
  return { ...actual, translateMessage: vi.fn(), translateWithDeadline: vi.fn() };
});
vi.mock("../src/voice/client.js", () => ({
  vonage: { voice: { transferCallWithNCCO: vi.fn() } },
  MANAGER_APP_USER: "manager",
  ensureManagerUser: vi.fn(),
}));

const { translateWithDeadline } = await import("../src/translate.js");
const { placeDeliverCall } = await import("../src/voice/outbound.js");

function talkTexts(body: any[]): string[] {
  return body.filter((a) => a.action === "talk").map((a) => a.text);
}

async function buildApp(): Promise<{ app: FastifyInstance; store: Store }> {
  const store = new Store(openDb(":memory:"));
  store.insertPerson({ name: "Lutfiya", language: "en-US", phone: null, app_user: "manager" });
  store.insertPerson({ name: "Marisol", language: "es-US", phone: "12015550111", app_user: null });
  store.insertPerson({ name: "Jean", language: "ht", phone: null, app_user: null });
  const app = Fastify();
  registerVoiceRoutes(app, store);
  await app.ready();
  return { app, store };
}

describe("idempotency: legitimate re-entry vs. true duplicates", () => {
  let app: FastifyInstance;
  let store: Store;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ app, store } = await buildApp());
    vi.mocked(translateWithDeadline).mockImplementation(async (_input, _deadline, onSettled) => {
      const result = {
        ok: true as const,
        data: {
          translation: "Room 412 es urgente.",
          back_translation: "Room 412 is urgent.",
          target_lang: "es-US",
          flags: [],
          notes: "",
        },
      };
      onSettled(result);
      return result;
    });
  });

  it("press 2 to re-record: the second /voice/input/message visit is processed, not swallowed", async () => {
    await app.inject({ method: "POST", url: "/voice/answer", payload: { uuid: "c1", conversation_uuid: "c1" } });
    await app.inject({
      method: "POST",
      url: "/voice/input/name",
      payload: { uuid: "c1", timestamp: "2026-01-01T00:00:00.000Z", speech: { results: [{ text: "Marisol", confidence: "0.9" }] } },
    });
    await app.inject({
      method: "POST",
      url: "/voice/input/message",
      payload: { uuid: "c1", timestamp: "2026-01-01T00:00:01.000Z", speech: { results: [{ text: "first attempt", confidence: "0.9" }] } },
    });
    // Press 2: re-record.
    await app.inject({
      method: "POST",
      url: "/voice/input/readback",
      payload: { uuid: "c1", timestamp: "2026-01-01T00:00:02.000Z", dtmf: { digits: "2" } },
    });
    // Second, distinct visit to /voice/input/message — different timestamp.
    const second = await app.inject({
      method: "POST",
      url: "/voice/input/message",
      payload: { uuid: "c1", timestamp: "2026-01-01T00:00:03.000Z", speech: { results: [{ text: "corrected message", confidence: "0.9" }] } },
    });

    expect(second.statusCode).toBe(200);
    expect(second.body.length).toBeGreaterThan(0);
    const ncco = JSON.parse(second.body);
    expect(talkTexts(ncco)[0]).toContain("Press 1 to send");

    const messages = store.listMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].source_text).toBe("corrected message");
  });

  it("a true duplicate delivery (identical timestamp) of /voice/input/message IS swallowed", async () => {
    await app.inject({ method: "POST", url: "/voice/answer", payload: { uuid: "c2", conversation_uuid: "c2" } });
    await app.inject({
      method: "POST",
      url: "/voice/input/name",
      payload: { uuid: "c2", timestamp: "2026-01-01T00:00:00.000Z", speech: { results: [{ text: "Marisol", confidence: "0.9" }] } },
    });
    const payload = { uuid: "c2", timestamp: "2026-01-01T00:00:01.000Z", speech: { results: [{ text: "one message", confidence: "0.9" }] } };
    const first = await app.inject({ method: "POST", url: "/voice/input/message", payload });
    const redelivered = await app.inject({ method: "POST", url: "/voice/input/message", payload });

    expect(first.statusCode).toBe(200);
    expect(first.body.length).toBeGreaterThan(0);
    expect(redelivered.statusCode).toBe(200);
    expect(redelivered.body).toBe("");

    expect(store.listMessages()).toHaveLength(1);
  });

  it("a duplicate with NO timestamp fails safe (blocked), never double-processed", async () => {
    await app.inject({ method: "POST", url: "/voice/answer", payload: { uuid: "c2b", conversation_uuid: "c2b" } });
    await app.inject({
      method: "POST",
      url: "/voice/input/name",
      payload: { uuid: "c2b", speech: { results: [{ text: "Marisol", confidence: "0.9" }] } },
    });
    const payload = { uuid: "c2b", speech: { results: [{ text: "one message", confidence: "0.9" }] } };
    const first = await app.inject({ method: "POST", url: "/voice/input/message", payload });
    const secondNoTimestamp = await app.inject({ method: "POST", url: "/voice/input/message", payload });

    expect(first.statusCode).toBe(200);
    expect(first.body.length).toBeGreaterThan(0);
    // Without a timestamp to distinguish a duplicate from a legitimate second
    // visit, the guard fails toward safety and blocks the second hit outright
    // rather than risk double-processing (see onceInput's doc comment).
    expect(secondNoTimestamp.statusCode).toBe(200);
    expect(secondNoTimestamp.body).toBe("");
    expect(store.listMessages()).toHaveLength(1);
  });

  it("press 3 then 1: the second /voice/input/readback visit sends, not swallowed", async () => {
    await app.inject({ method: "POST", url: "/voice/answer", payload: { uuid: "c3", conversation_uuid: "c3" } });
    await app.inject({
      method: "POST",
      url: "/voice/input/name",
      payload: { uuid: "c3", timestamp: "2026-01-01T00:00:00.000Z", speech: { results: [{ text: "Marisol", confidence: "0.9" }] } },
    });
    await app.inject({
      method: "POST",
      url: "/voice/input/message",
      payload: { uuid: "c3", timestamp: "2026-01-01T00:00:01.000Z", speech: { results: [{ text: "a message", confidence: "0.9" }] } },
    });
    // Press 3: preview.
    await app.inject({
      method: "POST",
      url: "/voice/input/readback",
      payload: { uuid: "c3", timestamp: "2026-01-01T00:00:02.000Z", dtmf: { digits: "3" } },
    });
    // Press 1: send — second distinct visit to the same route.
    const sendResponse = await app.inject({
      method: "POST",
      url: "/voice/input/readback",
      payload: { uuid: "c3", timestamp: "2026-01-01T00:00:03.000Z", dtmf: { digits: "1" } },
    });

    expect(sendResponse.statusCode).toBe(200);
    expect(sendResponse.body.length).toBeGreaterThan(0);
    expect(placeDeliverCall).toHaveBeenCalledTimes(1);
    expect(store.listMessages()[0].state).toBe("sent");
  });

  it("/voice/answer redelivered for the same call uuid replays the same NCCO, not an empty body", async () => {
    const first = await app.inject({ method: "POST", url: "/voice/answer", payload: { uuid: "c4", conversation_uuid: "c4" } });
    const redelivered = await app.inject({ method: "POST", url: "/voice/answer", payload: { uuid: "c4", conversation_uuid: "c4" } });

    expect(first.statusCode).toBe(200);
    expect(redelivered.statusCode).toBe(200);
    expect(redelivered.body.length).toBeGreaterThan(0);
    expect(talkTexts(JSON.parse(redelivered.body))[0]).toBe("This call is recorded.");
  });

  it("/voice/answer redelivered while the directory isn't set up replays the same error NCCO, not an empty body", async () => {
    const store = new Store(openDb(":memory:"));
    const app = Fastify();
    registerVoiceRoutes(app, store);
    await app.ready();
    // No manager seeded — this is the "directory not set up yet" path, which
    // never writes to calls.uuid and so must stay repeatable on redelivery.

    const first = await app.inject({ method: "POST", url: "/voice/answer", payload: { uuid: "c5", conversation_uuid: "c5" } });
    const redelivered = await app.inject({ method: "POST", url: "/voice/answer", payload: { uuid: "c5", conversation_uuid: "c5" } });

    expect(first.body.length).toBeGreaterThan(0);
    expect(redelivered.body.length).toBeGreaterThan(0);
    expect(talkTexts(JSON.parse(redelivered.body))[0]).toContain("directory is not set up");
  });
});

describe("flagged translation blocks immediate send (F2 / dossier T-01)", () => {
  let app: FastifyInstance;
  let store: Store;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ app, store } = await buildApp());
  });

  async function driveToReadback(flags: TranslationResult["flags"]) {
    vi.mocked(translateWithDeadline).mockImplementation(async (_input, _deadline, onSettled) => {
      const result = {
        ok: true as const,
        data: {
          translation: "No mezcle el blanqueador con el amoniaco.",
          back_translation: "Do not mix the bleach with the ammonia.",
          target_lang: "es-US",
          flags,
          notes: "",
        },
      };
      onSettled(result);
      return result;
    });
    await app.inject({ method: "POST", url: "/voice/answer", payload: { uuid: "f1", conversation_uuid: "f1" } });
    await app.inject({
      method: "POST",
      url: "/voice/input/name",
      payload: { uuid: "f1", timestamp: "t0", speech: { results: [{ text: "Marisol", confidence: "0.9" }] } },
    });
    await app.inject({
      method: "POST",
      url: "/voice/input/message",
      payload: { uuid: "f1", timestamp: "t1", speech: { results: [{ text: "Do not mix the bleach with the ammonia.", confidence: "0.9" }] } },
    });
  }

  it("press 1 on a flagged read-back asks for confirmation instead of sending", async () => {
    await driveToReadback(["dropped_negation"]);

    const firstPress = await app.inject({
      method: "POST",
      url: "/voice/input/readback",
      payload: { uuid: "f1", timestamp: "t2", dtmf: { digits: "1" } },
    });

    expect(placeDeliverCall).not.toHaveBeenCalled();
    expect(store.listMessages()[0].state).not.toBe("sent");
    const ncco = JSON.parse(firstPress.body);
    expect(talkTexts(ncco)[0]).toMatch(/press 1 to confirm and send/i);
  });

  it("a second press of 1 (via the confirm route) actually sends", async () => {
    await driveToReadback(["dropped_negation"]);
    await app.inject({
      method: "POST",
      url: "/voice/input/readback",
      payload: { uuid: "f1", timestamp: "t2", dtmf: { digits: "1" } },
    });
    const confirmed = await app.inject({
      method: "POST",
      url: "/voice/input/confirm-flagged",
      payload: { uuid: "f1", timestamp: "t3", dtmf: { digits: "1" } },
    });

    expect(confirmed.statusCode).toBe(200);
    expect(placeDeliverCall).toHaveBeenCalledTimes(1);
    expect(store.listMessages()[0].state).toBe("sent");
  });

  it("an unflagged read-back sends on the first press of 1, no confirmation step", async () => {
    await driveToReadback([]);
    await app.inject({
      method: "POST",
      url: "/voice/input/readback",
      payload: { uuid: "f1", timestamp: "t2", dtmf: { digits: "1" } },
    });

    expect(placeDeliverCall).toHaveBeenCalledTimes(1);
    expect(store.listMessages()[0].state).toBe("sent");
  });
});

describe("deliver-leg NCCO is fully localized (no English words in an es-US talk action)", () => {
  it("the 'Ringback. Message from...' announcement is entirely in Spanish for an es-US recipient", async () => {
    const { deliverNcco } = await import("../src/voice/ncco.js");
    const ncco = deliverNcco({ senderName: "Lutfiya", targetLang: "es-US", targetText: "la habitación 412 es urgente" });
    const announcement = talkTexts(ncco as any[])[1];
    expect(announcement).toContain("Mensaje de Lutfiya");
    expect(announcement).not.toMatch(/\bMessage from\b/);
  });

  it("the announcement stays in English for an en-US recipient", async () => {
    const { deliverNcco } = await import("../src/voice/ncco.js");
    const ncco = deliverNcco({ senderName: "Lutfiya", targetLang: "en-US", targetText: "room 412 is urgent" });
    const announcement = talkTexts(ncco as any[])[1];
    expect(announcement).toContain("Message from Lutfiya");
  });
});

describe("machine-detection guard against double-scheduling a retry (F12)", () => {
  let app: FastifyInstance;
  let store: Store;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ app, store } = await buildApp());
  });

  it("beep_start followed by beep_timeout for the same call only transitions once", async () => {
    const message = store.createMessage({
      from_person_id: 1,
      to_person_id: 2,
      source_text: "hi",
      source_lang: "en-US",
      target_lang: "es-US",
    });
    store.setMessageState(message.id, "sent");
    store.createCall({ uuid: "m1", message_id: message.id, direction: "outbound", leg: "deliver", status: "answered" });

    const first = await app.inject({
      method: "POST",
      url: "/voice/event",
      payload: { uuid: "m1", call_uuid: "m1", status: "machine", sub_state: "beep_start" },
    });
    const second = await app.inject({
      method: "POST",
      url: "/voice/event",
      payload: { uuid: "m1", call_uuid: "m1", status: "machine", sub_state: "beep_timeout" },
    });

    expect(first.statusCode).toBe(200);
    expect(first.body.length).toBeGreaterThan(0);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe("");
    expect(store.getMessage(message.id)!.state).toBe("left on voicemail");
  });
});
