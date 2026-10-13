/**
 * Telling OpenAI's failures apart from TeleKey's own.
 *
 * The openai SDK's errors carry OpenAI's HTTP status, and passing that on
 * made a revoked or out-of-quota TeleKey key look to the app like the user's
 * own problem: a 401 reads "Session expired — sign in again", a 429 "busy".
 * Those statuses mean something only when TeleKey itself says them (its
 * sign-in check, its balance, its rate guard). When OpenAI is the one that
 * refused, the user gets a plain sentence (errors.ts), and the status goes to
 * the log. Pure: test/upstream.test.mjs.
 *
 * The messages must not contain "credit": the desktop opens the Buy credits
 * window for failures that do.
 */

import OpenAI, { type APIError } from "openai";

import { logField } from "./logfield";

export const UPSTREAM_CODE = "upstream";
export const UPSTREAM_MESSAGE =
  "TeleKey's transcription service is having trouble. Nothing was charged.";

/** The error as OpenAI's SDK raised it, or null if `err` is not one. */
export function upstreamError(err: unknown): APIError | null {
  return err instanceof OpenAI.APIError ? err : null;
}

/**
 * A log line for an OpenAI failure, or null if `err` is not one: the status
 * OpenAI answered with, its error type and code, the parameter it objected to
 * (`keywords`, `language`, `prompt`: the one clue when it refuses something
 * TeleKey built rather than the audio), and the request id to quote to
 * OpenAI. Never its message, which can quote the request (a person's
 * vocabulary, the text around their cursor) or part of a rejected key.
 */
export function describeUpstream(err: unknown): string | null {
  const upstream = upstreamError(err);
  if (!upstream) return null;
  const status =
    typeof upstream.status === "number" ? String(upstream.status) : "none (no response)";
  return [
    `status=${status}`,
    `type=${logField(upstream.type)}`,
    `code=${logField(upstream.code)}`,
    `param=${logField(upstream.param)}`,
    `request=${logField(upstream.requestID)}`,
  ].join(" ");
}
