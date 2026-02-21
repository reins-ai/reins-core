import type { Result } from "../result";
import { ok, err } from "../result";
import { createLogger } from "../logger";
import { ChannelError } from "./errors";

const log = createLogger("channels:transcription");

/**
 * Default Groq API endpoint for audio transcription.
 */
const GROQ_API_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * Default Whisper model for transcription.
 */
const DEFAULT_MODEL = "whisper-large-v3-turbo";

/**
 * Options for the Groq Whisper transcription function.
 */
export interface TranscriptionOptions {
  /** Groq API key for authentication. */
  apiKey: string;
  /** Whisper model to use (default: whisper-large-v3-turbo). */
  model?: string;
  /** Optional ISO-639-1 language hint for transcription. */
  language?: string;
  /** Injectable fetch function for testing. */
  fetchFn?: typeof fetch;
}

/**
 * Transcribe an audio buffer using the Groq Whisper API.
 *
 * Sends the audio as multipart/form-data to the Groq OpenAI-compatible
 * transcription endpoint and returns the transcribed text.
 */
export async function transcribeAudio(
  buffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
  options: TranscriptionOptions,
): Promise<Result<string, ChannelError>> {
  const fetchFn = options.fetchFn ?? fetch;
  const model = options.model ?? DEFAULT_MODEL;

  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimeType }), fileName);
  formData.append("model", model);
  formData.append("response_format", "json");

  if (options.language !== undefined) {
    formData.append("language", options.language);
  }

  let response: Response;
  try {
    response = await fetchFn(GROQ_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${options.apiKey}`,
      },
      body: formData,
    });
  } catch (error) {
    return err(
      new ChannelError(
        "Transcription request failed",
        error instanceof Error ? error : undefined,
      ),
    );
  }

  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.text();
      if (body.length > 0) {
        detail = `: ${body.slice(0, 200)}`;
      }
    } catch (e) {
      // Expected: error response body may be unreadable
      log.debug("failed to read transcription error response body", { error: e instanceof Error ? e.message : String(e) });
    }

    return err(
      new ChannelError(
        `Transcription API returned status ${response.status}${detail}`,
      ),
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return err(new ChannelError("Transcription API returned invalid JSON"));
  }

  const data = body as { text?: string };
  const text = typeof data.text === "string" ? data.text : "";

  return ok(text);
}
