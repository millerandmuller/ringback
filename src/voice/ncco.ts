import { NCCOActions } from "@vonage/voice";
import type { DTMFSettings, NCCOAction, RecordAction, SpeechSettings, TalkAction } from "@vonage/voice";
import { config } from "../config.js";
import type { SupportedLanguage } from "../languages.js";

// The installed @vonage/voice SDK's RecordAction type predates the transcription
// object; the REST API accepts it, so it is added here rather than left untyped.
type RecordActionWithTranscription = RecordAction & {
  transcription?: {
    language?: string;
    eventUrl?: string[];
    eventMethod?: string;
  };
};

// The installed SDK types input.speech.endOnSilence as a boolean, but the real
// Voice API takes a number of seconds of silence (0.4-10.0, default 2.0) —
// verified against developer.vonage.com/en/voice/voice-api/ncco-reference#input.
interface FixedSpeechSettings extends Omit<SpeechSettings, "endOnSilence"> {
  endOnSilence?: number;
}
interface FixedInputAction {
  action: NCCOActions.INPUT;
  type: string[];
  dtmf?: DTMFSettings;
  speech?: FixedSpeechSettings;
  eventUrl?: string[];
  eventMethod?: string;
}

type Ncco = Array<TalkAction | FixedInputAction | RecordActionWithTranscription>;

const RECORDING_NOTICE: Record<SupportedLanguage, string> = {
  "en-US": "This call is recorded.",
  "es-US": "Esta llamada se graba.",
};

/** "Ringback. Message from X: ..." fully localized — every word of it is spoken
 *  in the target-language talk action, never English words inside an es-US voice. */
function messageAnnouncement(senderName: string, targetLang: SupportedLanguage, targetText: string): string {
  const templates: Record<SupportedLanguage, string> = {
    "en-US": `Ringback. Message from ${senderName}: ${targetText}`,
    "es-US": `Ringback. Mensaje de ${senderName}: ${targetText}`,
  };
  return templates[targetLang];
}

function talk(text: string, language: SupportedLanguage, bargeIn = false): TalkAction {
  return { action: NCCOActions.TALK, text, language, bargeIn };
}

function eventUrl(path: string): string[] {
  return [`${config.serverBaseUrl}${path}`];
}

function askWhoForNcco(directoryNames: string[]): Ncco {
  return [
    talk("Ringback. Who is this for?", "en-US", true),
    {
      action: NCCOActions.INPUT,
      type: ["speech"],
      speech: {
        language: "en-US",
        context: directoryNames,
        endOnSilence: 1.5,
        maxDuration: 6,
      },
      eventUrl: eventUrl("/voice/input/name"),
    },
  ];
}

/**
 * Capture leg, step 1: recording notice, then "who is this for?" with speech
 * recognition. Under ALL_PARTY_CONSENT_STATE the notice becomes a press-1
 * gate instead of continuing straight through (see handleConsentGateInput).
 */
export function captureNameNcco(directoryNames: string[]): Ncco {
  const notice = talk(RECORDING_NOTICE["en-US"], "en-US");
  if (config.allPartyConsentState) {
    return [
      notice,
      {
        action: NCCOActions.INPUT,
        type: ["dtmf"],
        dtmf: { maxDigits: 1, timeOut: 8 },
        eventUrl: eventUrl("/voice/input/consent-gate"),
      },
    ];
  }
  return [notice, ...askWhoForNcco(directoryNames)];
}

/** ALL_PARTY_CONSENT_STATE only: continuation after the caller presses 1. */
export function afterConsentNcco(directoryNames: string[]): Ncco {
  return askWhoForNcco(directoryNames);
}

/** Re-prompt once when the spoken name did not resolve to a directory entry. */
export function reprompNameNcco(): Ncco {
  return [
    talk("I could not understand that. Please say the name again.", "en-US", true),
    {
      action: NCCOActions.INPUT,
      type: ["speech"],
      speech: { language: "en-US", endOnSilence: 1.5, maxDuration: 6 },
      eventUrl: eventUrl("/voice/input/name-retry"),
    },
  ];
}

/** Second name miss: fall back to a keypad list, one digit per directory entry. */
export function nameKeypadListNcco(directoryNames: string[]): Ncco {
  const lines = directoryNames
    .map((name, i) => `Press ${i + 1} for ${name}.`)
    .join(" ");
  return [
    talk(`Please choose from the list. ${lines}`, "en-US", true),
    {
      action: NCCOActions.INPUT,
      type: ["dtmf"],
      dtmf: { maxDigits: 1, timeOut: 8 },
      eventUrl: eventUrl("/voice/input/name-keypad"),
    },
  ];
}

/** Capture leg, step 2: prompt for the message itself, speech first, record as fallback. */
export function captureMessageNcco(recipientName: string): Ncco {
  return [
    talk(`Message for ${recipientName}. Speak after the tone.`, "en-US", true),
    {
      action: NCCOActions.INPUT,
      type: ["speech"],
      speech: { language: "en-US", endOnSilence: 2, maxDuration: 30, saveAudio: true },
      eventUrl: eventUrl("/voice/input/message"),
    },
  ];
}

/** One retry of speech recognition before falling back to record + transcription. */
export function retryMessageNcco(): Ncco {
  return [
    talk("I did not catch that. Please say your message again.", "en-US", true),
    {
      action: NCCOActions.INPUT,
      type: ["speech"],
      speech: { language: "en-US", endOnSilence: 2, maxDuration: 30, saveAudio: true },
      eventUrl: eventUrl("/voice/input/message-retry"),
    },
  ];
}

/** Fallback when speech recognition on the message itself comes back empty. */
export function captureMessageByRecordingNcco(): Ncco {
  return [
    talk("I did not catch that. Please speak your message after the tone.", "en-US", true),
    {
      action: NCCOActions.RECORD,
      endOnSilence: 3,
      timeOut: 30,
      beepStart: true,
      eventUrl: eventUrl("/voice/input/message-recording"),
      transcription: {
        language: "en-US",
        eventUrl: eventUrl("/voice/input/message-transcription"),
      },
    },
  ];
}

/** Read-back: speak the back-translation, offer 1 send / 2 re-record / 3 hear target language. */
export function readbackNcco(backTranslation: string, flagged: boolean): Ncco {
  const warning = flagged ? "Please check this one: " : "";
  return [
    talk(
      `${warning}You are about to send: ${backTranslation}. Press 1 to send, 2 to record again, 3 to hear it in Spanish.`,
      "en-US",
      true,
    ),
    {
      action: NCCOActions.INPUT,
      type: ["dtmf"],
      dtmf: { maxDigits: 1, timeOut: 8 },
      eventUrl: eventUrl("/voice/input/readback"),
    },
  ];
}

/**
 * A flagged translation blocks an immediate send (F2 / dossier T-01): the first
 * press of 1 on a flagged read-back leads here instead of dialing, asking for a
 * second, explicit confirmation before anything goes out.
 */
export function confirmFlaggedSendNcco(backTranslation: string): Ncco {
  return [
    talk(
      `Please check this one again: ${backTranslation}. Press 1 to confirm and send, or 2 to record again.`,
      "en-US",
      true,
    ),
    {
      action: NCCOActions.INPUT,
      type: ["dtmf"],
      dtmf: { maxDigits: 1, timeOut: 8 },
      eventUrl: eventUrl("/voice/input/confirm-flagged"),
    },
  ];
}

/** Press 3: play the outgoing Spanish text, then return to the same 1/2/3 prompt. */
export function previewTargetLanguageNcco(targetText: string, backTranslation: string, flagged: boolean): Ncco {
  return [talk(targetText, "es-US"), ...readbackNcco(backTranslation, flagged)];
}

/** Manager hears the message was sent; the capture call ends naturally after this. */
export function sentConfirmationNcco(): Ncco {
  return [talk("Message sent.", "en-US")];
}

export function noSilenceCaughtNcco(): Ncco {
  return [talk("I did not catch that. Press 1 if you understood, or hang up and call back later.", "en-US")];
}

export function callAgainNcco(): Ncco {
  return [talk("Please call again.", "en-US")];
}

export function transcriptionFailedNcco(): Ncco {
  return [talk("I still could not understand that. Please call again.", "en-US")];
}

export function translationPendingNcco(): Ncco {
  return [
    talk(
      "Translating your message. This one will show up on the board when it is ready.",
      "en-US",
    ),
  ];
}

export function translationSlowNcco(): Ncco {
  return [
    talk(
      "Translation is taking longer than usual. I have saved your message and will keep trying.",
      "en-US",
    ),
  ];
}

export function directorySetupMissingNcco(): Ncco {
  return [talk("The directory is not set up yet.", "en-US")];
}

export function unsupportedLanguageNcco(explanation: string): Ncco {
  return [
    talk(explanation, "en-US", true),
    {
      action: NCCOActions.INPUT,
      type: ["dtmf"],
      dtmf: { maxDigits: 1, timeOut: 8 },
      eventUrl: eventUrl("/voice/input/unsupported-offer"),
    },
  ];
}

/** Deliver leg: recording notice + message in the worker's language, then dtmf-or-speech reply capture. */
export function deliverNcco(input: {
  senderName: string;
  targetLang: SupportedLanguage;
  targetText: string;
}): Ncco {
  const notice = RECORDING_NOTICE[input.targetLang];
  const instructionByLang: Record<SupportedLanguage, string> = {
    "en-US": "Press 1 if you understood, or speak your response after the tone.",
    "es-US": "Marca 1 si entendiste, o habla tu respuesta después del tono.",
  };
  return [
    talk(notice, input.targetLang),
    talk(messageAnnouncement(input.senderName, input.targetLang, input.targetText), input.targetLang),
    talk(instructionByLang[input.targetLang], input.targetLang, true),
    {
      action: NCCOActions.INPUT,
      type: ["dtmf", "speech"],
      dtmf: { maxDigits: 1, timeOut: 20 },
      speech: { language: input.targetLang, endOnSilence: 2, maxDuration: 20, saveAudio: true },
      eventUrl: eventUrl("/voice/input/reply"),
    },
  ];
}

/** Played into a live deliver call once a machine/beep is detected, replacing the interactive NCCO. */
export function voicemailNcco(input: { senderName: string; targetLang: SupportedLanguage; targetText: string }): Ncco {
  const notice = RECORDING_NOTICE[input.targetLang];
  return [
    talk(notice, input.targetLang),
    talk(messageAnnouncement(input.senderName, input.targetLang, input.targetText), input.targetLang),
  ];
}

/** Ring-back leg: the manager's browser rings with the worker's reply read out. */
export function ringbackNcco(replyEnglishText: string, workerName: string): Ncco {
  return [talk(RECORDING_NOTICE["en-US"], "en-US"), talk(`${workerName} replied: ${replyEnglishText}`, "en-US")];
}

/**
 * Boundary cast into the SDK's own NCCOAction[] type, needed only because that
 * type still declares input.speech.endOnSilence as a boolean (see above) while
 * the JSON this module builds is correct for the real Voice API.
 */
export function toSdkNcco(ncco: Ncco): NCCOAction[] {
  return ncco as unknown as NCCOAction[];
}
