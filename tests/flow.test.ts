import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, Store } from "../src/db/store.js";

vi.mock("../src/voice/outbound.js", () => ({
  placeDeliverCall: vi.fn(async () => ({ uuid: "deliver-uuid" })),
  placeRingbackCall: vi.fn(async () => ({ uuid: "ringback-uuid" })),
}));
vi.mock("../src/translate.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/translate.js")>();
  return {
    ...actual,
    translateMessage: vi.fn(),
    translateWithDeadline: vi.fn(),
  };
});
vi.mock("../src/voice/client.js", () => ({
  vonage: { voice: { transferCallWithNCCO: vi.fn() } },
  MANAGER_APP_USER: "manager",
  ensureManagerUser: vi.fn(),
}));

const { translateMessage, translateWithDeadline } = await import("../src/translate.js");
const { placeRingbackCall } = await import("../src/voice/outbound.js");
const flow = await import("../src/voice/flow.js");

function freshStore(): Store {
  const db = openDb(":memory:");
  return new Store(db);
}

describe("deliver leg reply handling (T-02, T-03)", () => {
  let store: Store;
  let managerId: number;
  let workerId: number;

  beforeEach(() => {
    vi.clearAllMocks();
    store = freshStore();
    managerId = store.insertPerson({ name: "Lutfiya", language: "en-US", phone: null, app_user: "manager" }).id;
    workerId = store.insertPerson({ name: "Marisol", language: "es-US", phone: "12015550111", app_user: null }).id;
  });

  function seedSentMessage() {
    const message = store.createMessage({
      from_person_id: managerId,
      to_person_id: workerId,
      source_text: "Room 412 is a rush.",
      source_lang: "en-US",
      target_lang: "es-US",
    });
    store.setMessageState(message.id, "sent");
    store.createCall({ uuid: "deliver-uuid", message_id: message.id, direction: "outbound", leg: "deliver", status: "answered" });
    return message;
  }

  it("T-02: dtmf 1 sets the message to understood", async () => {
    const message = seedSentMessage();
    await flow.handleReplyInput(store, { uuid: "deliver-uuid", dtmf: { digits: "1" } });
    expect(store.getMessage(message.id)!.state).toBe("understood");
  });

  it("T-02: a bare timeout (no dtmf, no speech) never marks the message understood", async () => {
    const message = seedSentMessage();
    await flow.handleReplyInput(store, { uuid: "deliver-uuid" });
    expect(store.getMessage(message.id)!.state).not.toBe("understood");
    expect(store.getMessage(message.id)!.state).toBe("sent");
  });

  it("T-03: a spoken reply is translated and delivered back to the manager", async () => {
    const message = seedSentMessage();
    vi.mocked(translateMessage).mockResolvedValue({
      ok: true,
      data: {
        translation: "I can't, 412 still has guests.",
        back_translation: "No puedo, la 412 todavia tiene huespedes.",
        target_lang: "en-US",
        flags: [],
        notes: "",
      },
    });

    await flow.handleReplyInput(store, {
      uuid: "deliver-uuid",
      speech: { results: [{ text: "No puedo, la 412 todavia tiene huespedes.", confidence: "0.92" }] },
    });

    const updated = store.getMessage(message.id)!;
    expect(updated.state).toBe("replied");
    expect(updated.reply_translation).toBe("I can't, 412 still has guests.");
    expect(placeRingbackCall).toHaveBeenCalledWith(
      expect.objectContaining({ replyEnglishText: "I can't, 412 still has guests.", workerName: "Marisol" }),
    );
  });
});

describe("unsupported language stops before dialing (T-04)", () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = freshStore();
    store.insertPerson({ name: "Lutfiya", language: "en-US", phone: null, app_user: "manager" });
    store.insertPerson({ name: "Jean", language: "ht", phone: null, app_user: null });
  });

  it("never calls translate and stops the flow honestly for an unsupported language", async () => {
    const answerNcco = flow.handleAnswer(store, { uuid: "capture-uuid", conversation_uuid: "capture-uuid" });
    expect(answerNcco).toBeTruthy();

    flow.handleNameInput(store, "capture-uuid", {
      speech: { results: [{ text: "Jean", confidence: "0.9" }] },
    });

    const ncco = await flow.handleMessageInput(store, "capture-uuid", {
      speech: { results: [{ text: "Please pick up your radio.", confidence: "0.9" }] },
    });

    expect(translateMessage).not.toHaveBeenCalled();
    expect(translateWithDeadline).not.toHaveBeenCalled();

    const talk = (ncco as any[]).find((a) => a.action === "talk");
    expect(talk.text).toContain("Haitian Creole");

    const messages = store.listMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].state).toBe("unsupported language");
  });
});

describe("name capture survives what the recogniser actually returns", () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = freshStore();
    store.insertPerson({ name: "Lutfiya", language: "en-US", phone: null, app_user: "manager" });
    store.insertPerson({ name: "Marisol", language: "es-US", phone: "12015550111", app_user: null });
    flow.handleAnswer(store, { uuid: "capture-uuid", conversation_uuid: "capture-uuid" });
  });

  it("resolves the recipient from a mangled alternative instead of falling to the keypad", () => {
    const ncco = flow.handleNameInput(store, "capture-uuid", {
      speech: { results: [{ text: "Mary Sol", confidence: "0.71" }] },
    });
    const talk = (ncco as any[]).find((action) => action.action === "talk");
    expect(talk.text).toContain("Message for Marisol");
  });

  it("reads past the first alternative to find the name", () => {
    const ncco = flow.handleNameInput(store, "capture-uuid", {
      speech: {
        results: [
          { text: "merry soul", confidence: "0.55" },
          { text: "Marisol", confidence: "0.51" },
        ],
      },
    });
    const talk = (ncco as any[]).find((action) => action.action === "talk");
    expect(talk.text).toContain("Message for Marisol");
  });

  it("keeps the directory hints on the re-prompt, which is where a second miss comes from", () => {
    const ncco = flow.handleNameInput(store, "capture-uuid", {
      speech: { results: [{ text: "the weather is fine", confidence: "0.9" }] },
    });
    const input = (ncco as any[]).find((action) => action.action === "input");
    expect(input.speech.context).toEqual(["Marisol"]);
  });
});

describe("the deliver leg never ends on silence without asking again", () => {
  let store: Store;

  beforeEach(() => {
    vi.clearAllMocks();
    store = freshStore();
    const manager = store.insertPerson({ name: "Lutfiya", language: "en-US", phone: null, app_user: "manager" });
    const worker = store.insertPerson({ name: "Marisol", language: "es-US", phone: "12015550111", app_user: null });
    const message = store.createMessage({
      from_person_id: manager.id,
      to_person_id: worker.id,
      source_text: "Room 412 is a rush.",
      source_lang: "en-US",
      target_lang: "es-US",
    });
    store.setMessageState(message.id, "sent");
    store.createCall({ uuid: "deliver-uuid", message_id: message.id, direction: "outbound", leg: "deliver", status: "answered" });
  });

  it("re-prompts in the worker's language when nothing was captured", async () => {
    const ncco = await flow.handleReplyInput(store, { uuid: "deliver-uuid" });
    const talk = (ncco as any[]).find((action) => action.action === "talk");
    expect(talk.language).toBe("es-US");
    expect(talk.text).toContain("Marca 1");
    const input = (ncco as any[]).find((action) => action.action === "input");
    expect(input.type).toEqual(["dtmf", "speech"]);
  });

  it("asks only once, so a redelivered empty webhook cannot loop the call", async () => {
    expect(await flow.handleReplyInput(store, { uuid: "deliver-uuid" })).not.toBeNull();
    expect(await flow.handleReplyInput(store, { uuid: "deliver-uuid" })).toBeNull();
  });

  it("still accepts the digit after the second prompt", async () => {
    await flow.handleReplyInput(store, { uuid: "deliver-uuid" });
    await flow.handleReplyInput(store, { uuid: "deliver-uuid", dtmf: { digits: "1" } });
    expect(store.listMessages()[0].state).toBe("understood");
  });
});
