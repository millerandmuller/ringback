import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "@vonage/auth";
import { FileClient } from "@vonage/server-client";
import { config } from "../config.js";

const fileClient = new FileClient(
  new Auth({
    applicationId: config.vonage.applicationId,
    privateKey: config.vonage.privateKey,
  }),
);

interface TranscriptionFile {
  channels?: Array<{ transcript?: Array<{ sentence?: string }> }>;
}

/**
 * Downloads a transcription file and joins its sentences into one string.
 * The temp file is removed immediately after reading — no audio or transcript
 * text is retained locally once the message it produced has been captured.
 */
export async function fetchTranscriptionText(transcriptionUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ringback-transcript-"));
  const path = join(dir, "transcript.json");
  try {
    await fileClient.downloadFile(transcriptionUrl, path);
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as TranscriptionFile;
    const sentences = (parsed.channels ?? [])
      .flatMap((channel) => channel.transcript ?? [])
      .map((entry) => entry.sentence)
      .filter((sentence): sentence is string => Boolean(sentence));
    return sentences.join(" ").trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
