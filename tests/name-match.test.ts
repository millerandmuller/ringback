import { describe, expect, it } from "vitest";
import { matchDirectoryName } from "../src/name-match.js";

const DIRECTORY = [
  { entry: "marisol", name: "Marisol" },
  { entry: "ana", name: "Ana" },
  { entry: "priya", name: "Priya" },
  { entry: "jean", name: "Jean" },
];

function match(alternatives: string[]): string | undefined {
  return matchDirectoryName(alternatives, DIRECTORY);
}

describe("matchDirectoryName", () => {
  it("matches the name spoken cleanly", () => {
    expect(match(["Marisol"])).toBe("marisol");
  });

  it("matches through punctuation and casing", () => {
    expect(match(["marisol."])).toBe("marisol");
  });

  it("matches the word-split the recogniser actually produced on the rehearsal runs", () => {
    expect(match(["Mary Sol"])).toBe("marisol");
    expect(match(["Marysol"])).toBe("marisol");
    expect(match(["Maricel"])).toBe("marisol");
  });

  it("matches a name buried in a sentence", () => {
    expect(match(["it's for Marisol"])).toBe("marisol");
    expect(match(["for Marysol please"])).toBe("marisol");
  });

  it("reads past the first alternative when a later one is the real name", () => {
    expect(match(["merry soul", "Marisol"])).toBe("marisol");
  });

  it("matches accented directory entries without the accent", () => {
    expect(matchDirectoryName(["Ines"], [{ entry: "ines", name: "Inés" }])).toBe("ines");
  });

  it("keeps short names strict so they do not swallow each other", () => {
    expect(match(["Jean"])).toBe("jean");
    expect(match(["Ana"])).toBe("ana");
    expect(match(["Ivan"])).toBeUndefined();
  });

  it("lets an exact hit win over a near-miss on a similar name", () => {
    const similar = [
      { entry: "ana", name: "Ana" },
      { entry: "anna", name: "Anna" },
    ];
    expect(matchDirectoryName(["Ana"], similar)).toBe("ana");
  });

  it("returns undefined rather than guessing when only fuzz separates two people", () => {
    const similar = [
      { entry: "ana", name: "Ana" },
      { entry: "anna", name: "Anna" },
    ];
    expect(matchDirectoryName(["Ann"], similar)).toBeUndefined();
  });

  it("returns undefined for silence, junk and an empty directory", () => {
    expect(match([])).toBeUndefined();
    expect(match([""])).toBeUndefined();
    expect(match(["the weather is fine"])).toBeUndefined();
    expect(matchDirectoryName(["Marisol"], [])).toBeUndefined();
  });
});
