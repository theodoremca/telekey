/**
 * What a failed request answers with. Pure, so the contract is tested without
 * Express: test/upstream.test.mjs.
 *
 * TeleKey's own refusals set `status` (and sometimes `code`) on the error:
 * 401 from the sign-in check, 402 from the balance, 429 from the rate guard.
 * Those pass through, with their message, which is written for people.
 *
 * A failure of OpenAI's does not pass through, whatever status OpenAI
 * answered with (see upstream.ts). If OpenAI refused the request itself
 * (400, 413, 422: the recording or text, not TeleKey's key), the person is
 * told so and it is a WARN in the log. Anything else of OpenAI's is a 503
 * ("having trouble, nothing was charged") and an ERROR.
 *
 * Anything unexpected is a 500 with a fixed sentence. Its message is for the
 * log only: it can name environment variables or Firestore internals.
 *
 * None of these messages may contain "credit": the desktop opens the Buy
 * credits window for failures that do.
 */

import { describeUpstream, upstreamError, UPSTREAM_CODE, UPSTREAM_MESSAGE } from "./upstream";

export type Failure = {
  status: number;
  body: { error: string; code?: string };
  /** Written to the log instead of the error itself, when set. */
  log?: string;
  /** How loudly to log it; ERROR when unset. */
  level?: "warn" | "error";
};

/** What was sent to OpenAI, for the sentence OpenAI refusing it gets. */
export type Subject = "recording" | "text";

export const UNEXPECTED_MESSAGE = "Something went wrong on TeleKey's side. Try again.";
export const TOO_LARGE_MESSAGE = "That recording is too long to transcribe. Try a shorter one.";
export const UNREADABLE_MESSAGE = "That request could not be read.";
const REJECTED: Record<Subject, string> = {
  recording: "That recording could not be transcribed. Try a shorter one.",
  text: "That text could not be rewritten. Try something shorter.",
};
export const REJECTED_CODE = "rejected";

/** OpenAI refuses these because of what was sent, not because of TeleKey's account. */
const BAD_REQUEST = new Set([400, 413, 422]);

export function failureResponse(err: unknown, subject: Subject = "recording"): Failure {
  const upstream = upstreamError(err);
  if (upstream) {
    const detail = describeUpstream(err);
    if (typeof upstream.status === "number" && BAD_REQUEST.has(upstream.status)) {
      return {
        status: upstream.status === 413 ? 413 : 400,
        body: { error: REJECTED[subject], code: REJECTED_CODE },
        log: `OpenAI rejected the request: ${detail}`,
        level: "warn",
      };
    }
    return {
      status: 503,
      body: { error: UPSTREAM_MESSAGE, code: UPSTREAM_CODE },
      log: `OpenAI call failed: ${detail}`,
      level: "error",
    };
  }

  const raised = err as
    | { status?: number; code?: unknown; type?: unknown; expose?: unknown }
    | null
    | undefined;

  // Express's body parser: an upload over the limit, or a body it cannot read.
  if (raised?.type === "entity.too.large") {
    return { status: 413, body: { error: TOO_LARGE_MESSAGE } };
  }
  const asked = Number(raised?.status ?? 500);
  const status = Number.isInteger(asked) && asked >= 400 && asked <= 599 ? asked : 500;
  if (raised?.expose === true && status < 500) {
    return { status, body: { error: UNREADABLE_MESSAGE } };
  }

  if (status >= 500) {
    return { status, body: { error: UNEXPECTED_MESSAGE } };
  }
  const code = raised?.code;
  const message = err instanceof Error ? err.message : "Something went wrong.";
  return { status, body: typeof code === "string" ? { error: message, code } : { error: message } };
}
