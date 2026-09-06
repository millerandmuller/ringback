import { describe, expect, it } from "vitest";
import { isSupportedLanguage, unsupportedLanguageExplanation } from "../src/languages.js";

// T-04: a Haitian Creole profile stops the flow honestly before dialing.
describe("languages", () => {
  it("treats en-US and es-US as supported", () => {
    expect(isSupportedLanguage("en-US")).toBe(true);
    expect(isSupportedLanguage("es-US")).toBe(true);
  });

  it("treats ht, pt-BR and bn-IN as unsupported", () => {
    expect(isSupportedLanguage("ht")).toBe(false);
    expect(isSupportedLanguage("pt-BR")).toBe(false);
    expect(isSupportedLanguage("bn-IN")).toBe(false);
  });

  it("names the language in the honest explanation instead of a generic message", () => {
    expect(unsupportedLanguageExplanation("ht")).toContain("Haitian Creole");
    expect(unsupportedLanguageExplanation("xx")).toContain("this language");
  });

  it("never claims voice delivery works for an unsupported language", () => {
    const explanation = unsupportedLanguageExplanation("ht");
    expect(explanation).toMatch(/not available/i);
  });
});
