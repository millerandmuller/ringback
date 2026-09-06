/**
 * Matching a spoken name against the directory.
 *
 * An en-US recogniser rarely returns a Spanish or Haitian first name verbatim:
 * "Marisol" comes back as "Mary Sol", "Marysol", "Maricel", often only in the
 * second or third alternative. Comparing the single best alternative for exact
 * equality (what the first version did) therefore missed the name on every
 * live run and pushed the caller into the keypad fallback.
 *
 * Pure and I/O-free on purpose: the whole point is that it can be tested
 * against real recogniser output without a call.
 */

/** Lowercase, strip accents and punctuation, collapse whitespace. */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Same as normalize() with spaces removed, so "mary sol" and "marisol" compare. */
function despace(value: string): string {
  return normalize(value).replace(/\s/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length];
}

/** Short names tolerate less fuzz: one edit on "Ana", two on "Marisol". */
function editBudget(name: string): number {
  return despace(name).length <= 4 ? 1 : 2;
}

/** A directory name spoken inside a longer phrase ("it is for Marisol"). */
function containsAsWord(haystack: string, needle: string): boolean {
  const padded = ` ${normalize(haystack)} `;
  const target = normalize(needle);
  if (!target) return false;
  return padded.includes(` ${target} `);
}

interface Candidate<T> {
  entry: T;
  name: string;
}

/**
 * Tiers are tried in order across ALL alternatives before falling to the next
 * tier, so a confident exact hit in alternative 3 beats a fuzzy hit in
 * alternative 1. Two different people matching in the same tier is treated as
 * ambiguous and returns undefined — the caller then re-prompts or offers the
 * keypad, which is always better than dialing the wrong worker.
 */
export function matchDirectoryName<T>(
  alternatives: string[],
  directory: Array<{ entry: T; name: string }>,
): T | undefined {
  const spoken = alternatives.map((text) => text ?? "").filter((text) => text.trim().length > 0);
  if (spoken.length === 0 || directory.length === 0) return undefined;

  const tiers: Array<(text: string, candidate: Candidate<T>) => boolean> = [
    // 1. The recogniser returned the name as-is.
    (text, candidate) => normalize(text) === normalize(candidate.name),
    // 2. The name is a word inside a longer utterance.
    (text, candidate) => containsAsWord(text, candidate.name),
    // 3. Word-boundary noise only: "Mary Sol" vs "Marisol".
    (text, candidate) => despace(text) === despace(candidate.name),
    // 4. A near miss on the whole utterance ("Marysol", "Maricel").
    (text, candidate) => levenshtein(despace(text), despace(candidate.name)) <= editBudget(candidate.name),
    // 5. A near miss on one word of a longer utterance ("for Marysol please").
    (text, candidate) =>
      normalize(text)
        .split(" ")
        .some((word) => levenshtein(word, despace(candidate.name)) <= editBudget(candidate.name)),
  ];

  for (const matches of tiers) {
    for (const text of spoken) {
      const hits = directory.filter((candidate) => matches(text, candidate));
      if (hits.length === 1) return hits[0].entry;
      if (hits.length > 1) return undefined; // ambiguous — never guess a recipient
    }
  }
  return undefined;
}
