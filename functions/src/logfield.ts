/**
 * A value that is safe to write to a log, for fields whose content OpenAI
 * chooses (an error's type and code). No dependencies, so the relay (which
 * bundles it) and the Functions API share it.
 *
 * OpenAI's error *messages* are never logged at all: they can quote the
 * request, and the request is a person's vocabulary and the text around their
 * cursor. A type or a code is a short identifier (`insufficient_quota`); a
 * value that is anything else is not one, and is logged as `-`.
 */

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;

export function logField(value: unknown): string {
  return typeof value === "string" && IDENTIFIER.test(value) ? value : "-";
}
