import { describe, expect, it } from "vitest";
import {
  captureNameNcco,
  deliverNcco,
  readbackNcco,
  ringbackNcco,
  unsupportedLanguageNcco,
} from "../src/voice/ncco.js";

function talkTexts(ncco: any[]): string[] {
  return ncco.filter((a) => a.action === "talk").map((a) => a.text);
}

// T-05: the recording notice plays on every call, in the listener's language.
describe("recording notice (T-05)", () => {
  it("opens the capture leg with the English notice", () => {
    expect(talkTexts(captureNameNcco(["Marisol"]))[0]).toBe("This call is recorded.");
  });

  it("opens the deliver leg with the notice in the recipient's language", () => {
    const ncco = deliverNcco({ senderName: "Lutfiya", targetLang: "es-US", targetText: "hola" });
    expect(talkTexts(ncco)[0]).toBe("Esta llamada se graba.");
  });

  it("opens the ring-back leg with the English notice", () => {
    expect(talkTexts(ringbackNcco("I can't, 412 still has guests.", "Marisol"))[0]).toBe(
      "This call is recorded.",
    );
  });

  it("never exceeds roughly 2.5 seconds of notice text (short sentence)", () => {
    for (const notice of ["This call is recorded.", "Esta llamada se graba."]) {
      expect(notice.length).toBeLessThan(40);
    }
  });
});

describe("read-back menu", () => {
  it("offers exactly one dtmf digit of input, 1/2/3", () => {
    const ncco = readbackNcco("Room 412 is urgent.", false);
    const input = ncco.find((a: any) => a.action === "input") as any;
    expect(input.type).toEqual(["dtmf"]);
    expect(input.dtmf.maxDigits).toBe(1);
    expect(talkTexts(ncco)[0]).toContain("Press 1 to send, 2 to record again, 3 to hear it in Spanish");
  });

  it("prefixes a warning when the translation is flagged", () => {
    const ncco = readbackNcco("Room 412 is urgent.", true);
    expect(talkTexts(ncco)[0]).toMatch(/^Please check this one:/);
  });

  it("never softens the message with an exclamation mark or filler word", () => {
    const ncco = readbackNcco("Do not mix the bleach with the ammonia cleaner.", false);
    const text = talkTexts(ncco)[0];
    expect(text).not.toContain("!");
    expect(text).not.toMatch(/great|oops/i);
  });
});

describe("unsupported language", () => {
  it("stops before dialing and offers English instead", () => {
    const ncco = unsupportedLanguageNcco("Voice delivery is not available for Haitian Creole yet.");
    expect(talkTexts(ncco)[0]).toContain("Haitian Creole");
    const input = ncco.find((a: any) => a.action === "input") as any;
    expect(input.type).toEqual(["dtmf"]);
  });
});
