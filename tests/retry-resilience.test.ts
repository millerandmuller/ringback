import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, Store } from "../src/db/store.js";

vi.mock("../src/voice/outbound.js", () => ({
  placeDeliverCall: vi.fn(),
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

const { placeDeliverCall } = await import("../src/voice/outbound.js");
const { translateMessage } = await import("../src/translate.js");
const flow = await import("../src/voice/flow.js");

function freshStore(): Store {
  return new Store(openDb(":memory:"));
}

describe("background retry timers survive a rejected outbound call (P1)", () => {
  let unhandledRejections: unknown[];
  let onUnhandledRejection: (reason: unknown) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    unhandledRejections = [];
    onUnhandledRejection = (reason) => unhandledRejections.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", onUnhandledRejection);
    vi.useRealTimers();
  });

  it("a rejected voicemail retry degrades the message to failed instead of crashing the process", async () => {
    const store = freshStore();
    const managerId = store.insertPerson({ name: "Lutfiya", language: "en-US", phone: null, app_user: "manager" }).id;
    const workerId = store.insertPerson({ name: "Marisol", language: "es-US", phone: "12015550111", app_user: null }).id;
    const message = store.createMessage({
      from_person_id: managerId,
      to_person_id: workerId,
      source_text: "hi",
      source_lang: "en-US",
      target_lang: "es-US",
    });
    store.setMessageState(message.id, "sent");
    store.createCall({ uuid: "d1", message_id: message.id, direction: "outbound", leg: "deliver", status: "answered" });

    vi.mocked(placeDeliverCall).mockRejectedValue(
      new Error("Vonage API error: trial account cannot call unverified numbers"),
    );

    await flow.handleMachineDetectionEvent(store, { call_uuid: "d1", status: "machine", sub_state: "beep_start" });
    expect(store.getMessage(message.id)!.state).toBe("left on voicemail");

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    // Let the rejected promise's catch handler's own awaits settle.
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getMessage(message.id)!.state).toBe("failed");
    expect(unhandledRejections).toHaveLength(0);
  });

  it("a rejected translation retry degrades the message to failed instead of crashing the process", async () => {
    const store = freshStore();
    store.insertPerson({ name: "Lutfiya", language: "en-US", phone: null, app_user: "manager" });
    store.insertPerson({ name: "Marisol", language: "es-US", phone: "12015550111", app_user: null });

    vi.mocked(translateMessage).mockRejectedValue(new Error("unexpected store failure"));
    // scheduleTranslationRetry (internal) is only reached when the deadline's
    // own promise settles (via onSettled) before the deadline timer fires,
    // and settles with a failure — drive it through the real capture-leg path
    // that schedules it, with onSettled invoked synchronously with a failure.
    const { translateWithDeadline } = await import("../src/translate.js");
    vi.mocked(translateWithDeadline).mockImplementation(async (_input, _deadline, onSettled) => {
      const result = { ok: false as const, reason: "connection" as const, error: new Error("boom") };
      onSettled(result);
      return result;
    });

    flow.handleAnswer(store, { uuid: "t1", conversation_uuid: "t1" });
    flow.handleNameInput(store, "t1", { speech: { results: [{ text: "Marisol", confidence: "0.9" }] } });
    await flow.handleMessageInput(store, "t1", { speech: { results: [{ text: "a message", confidence: "0.9" }] } });

    const pendingMessages = store.listMessages().filter((m) => m.state === "translation pending");
    expect(pendingMessages.length).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(0);

    const updated = store.getMessage(pendingMessages[0].id)!;
    expect(updated.state).toBe("failed");
    expect(unhandledRejections).toHaveLength(0);
  });
});

describe("machine-detection double-fire no longer double-schedules a retry (P2)", () => {
  it("beep_start then beep_timeout for the same call places at most one retry call", async () => {
    vi.useFakeTimers();
    const store = freshStore();
    const managerId = store.insertPerson({ name: "Lutfiya", language: "en-US", phone: null, app_user: "manager" }).id;
    const workerId = store.insertPerson({ name: "Marisol", language: "es-US", phone: "12015550111", app_user: null }).id;
    const message = store.createMessage({
      from_person_id: managerId,
      to_person_id: workerId,
      source_text: "hi",
      source_lang: "en-US",
      target_lang: "es-US",
    });
    store.setMessageState(message.id, "sent");
    store.createCall({ uuid: "d2", message_id: message.id, direction: "outbound", leg: "deliver", status: "answered" });

    vi.mocked(placeDeliverCall).mockResolvedValue({ uuid: "retry-uuid" });

    await flow.handleMachineDetectionEvent(store, { call_uuid: "d2", status: "machine", sub_state: "beep_start" });
    const second = await flow.handleMachineDetectionEvent(store, {
      call_uuid: "d2",
      status: "machine",
      sub_state: "beep_timeout",
    });
    expect(second).toBeNull();

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(0);

    expect(placeDeliverCall).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
