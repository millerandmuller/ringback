// Two languages are real end to end on Vonage TTS/ASR. Everything else stops
// honestly before dialing — never a fake voice reading an unsupported language.
export const SUPPORTED_LANGUAGES = ["en-US", "es-US"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export function isSupportedLanguage(language: string): language is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(language);
}

// Curated/vision-beat directory entries use these codes; named here only so the
// honest-fallback explanation can say which language, not just "this language".
const LANGUAGE_NAMES: Record<string, string> = {
  ht: "Haitian Creole",
  "pt-BR": "Portuguese",
  "bn-IN": "Bengali",
};

export function unsupportedLanguageExplanation(languageCode: string): string {
  const name = LANGUAGE_NAMES[languageCode] ?? "this language";
  return `Voice delivery is not available for ${name} yet. The message was saved. Press 1 to send it in English instead, or hang up.`;
}
