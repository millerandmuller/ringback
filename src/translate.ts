import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  BadRequestError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config.js";

const anthropic = new Anthropic({ apiKey: config.anthropic.apiKey });

const TranslationSchema = z.object({
  translation: z.string(),
  back_translation: z.string(),
  target_lang: z.string(),
  // Flags are problem codes only (deterministic gate: any flag forces a second confirmation
  // before sending). Things that were preserved correctly are NOT flags; they belong in notes.
  flags: z.array(
    z.enum(["dropped_negation", "untranslated_term", "uncertain_number_or_time", "low_confidence"]),
  ),
  notes: z.string(),
});

export type TranslationResult = z.infer<typeof TranslationSchema>;

const SYSTEM_PROMPT = `You are a translation engine inside a voice relay between a manager and a
frontline worker who do not share a language. Every message you translate is read aloud on a
phone call, so precision matters more than fluency.

Rules:
- Translate the source text exactly into the target language. Preserve negations ("do not",
  "never"), quantities, chemical and product names, and proper nouns exactly — do not soften,
  summarize, or add pleasantries.
- Also produce a back-translation: translate your own translation back into the source
  language, so the sender can verify what will actually be said before it is spoken aloud.
- "flags" lists PROBLEMS only, using these codes: "dropped_negation" (a negation could not be
  preserved exactly), "untranslated_term" (a product, chemical or proper name had to be left in
  the source language or is uncertain), "uncertain_number_or_time" (a number, room, quantity or
  time could be misread in the target language in a way it could not be in the source),
  "low_confidence" (you are not confident the meaning survives). Do NOT flag things you
  preserved correctly, and do not flag an ambiguity that exists identically in the source text.
  For a clean, faithful translation return an empty array — that is the normal case.
- "notes" is one short sentence for a human reviewer (this is where "negation preserved" or a
  regional word choice belongs), or an empty string if there is nothing to add.
- Never add commentary, greetings, or explanation inside "translation" or "back_translation"
  themselves — only the exact spoken content.`;

export type TranslateFailureReason = "timeout" | "rate_limit" | "connection" | "bad_request" | "unknown";

export type TranslateOutcome =
  | { ok: true; data: TranslationResult }
  | { ok: false, reason: TranslateFailureReason; error: unknown };

export async function translateMessage(input: {
  sourceText: string;
  sourceLang: string;
  targetLang: string;
}): Promise<TranslateOutcome> {
  try {
    const message = await anthropic.beta.messages.parse(
      {
        model: config.anthropic.model,
        max_tokens: 1024,
        output_config: { effort: "low" },
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `Source language: ${input.sourceLang}\nTarget language: ${input.targetLang}\nSource text: ${input.sourceText}`,
          },
        ],
        output_format: betaZodOutputFormat(TranslationSchema),
      },
      { timeout: 15_000 },
    );

    if (!message.parsed_output) {
      return { ok: false, reason: "unknown", error: new Error("No parsed_output on response") };
    }

    return { ok: true, data: message.parsed_output };
  } catch (error) {
    if (error instanceof RateLimitError) return { ok: false, reason: "rate_limit", error };
    if (error instanceof APIConnectionTimeoutError) return { ok: false, reason: "timeout", error };
    if (error instanceof APIConnectionError) return { ok: false, reason: "connection", error };
    if (error instanceof BadRequestError) return { ok: false, reason: "bad_request", error };
    return { ok: false, reason: "unknown", error };
  }
}

/**
 * Races the translation against the live-call deadline (8s — the brief's threshold for
 * keeping a caller on hold before the call flow must move on). The underlying request keeps
 * its own 15s SDK timeout and is not aborted on a live-call timeout; onSettled lets the
 * caller apply whatever comes back after the deadline has already passed (translation pending
 * -> resolved in the background, matching the retry policy in F7).
 */
export function translateWithDeadline(
  input: { sourceText: string; sourceLang: string; targetLang: string },
  deadlineMs: number,
  onSettled: (outcome: TranslateOutcome) => void,
): Promise<TranslateOutcome | { ok: false; reason: "deadline_exceeded"; error: null }> {
  const promise = translateMessage(input);
  promise.then(onSettled);

  return Promise.race([
    promise,
    new Promise<{ ok: false; reason: "deadline_exceeded"; error: null }>((resolve) =>
      setTimeout(() => resolve({ ok: false, reason: "deadline_exceeded", error: null }), deadlineMs),
    ),
  ]);
}
