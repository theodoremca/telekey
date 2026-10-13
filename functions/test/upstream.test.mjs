// Run with `npm test` (builds first). OpenAI's failures are not the user's:
// a revoked or exhausted TeleKey key must not read as "sign in again".
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const OpenAI = require("openai");
const {
  failureResponse,
  REJECTED_CODE,
  TOO_LARGE_MESSAGE,
  UNEXPECTED_MESSAGE,
  UNREADABLE_MESSAGE,
} = require("../lib/errors.js");
const { describeUpstream, UPSTREAM_MESSAGE } = require("../lib/upstream.js");
const { logField } = require("../lib/logfield.js");

const KEY = "sk-proj-AbCd1234EfGh5678IjKl9012MnOp3456";

/** An error as the openai SDK throws it for an HTTP failure. */
function openai(status, code, message) {
  return OpenAI.APIError.generate(
    status,
    { error: { message, type: "invalid_request_error", code } },
    undefined,
    new Headers({ "x-request-id": "req_abc123" }),
  );
}

/** One of TeleKey's own refusals, as auth.ts and ledger.ts throw them. */
function teleKey(message, status, code) {
  return Object.assign(new Error(message), code ? { status, code } : { status });
}

test("OpenAI refusing TeleKey's key is a 503, not a 401", () => {
  const failure = failureResponse(
    openai(401, "invalid_api_key", `Incorrect API key provided: ${KEY}.`),
  );
  assert.equal(failure.status, 503);
  assert.deepEqual(failure.body, { error: UPSTREAM_MESSAGE, code: "upstream" });
  assert.equal(UPSTREAM_MESSAGE, "TeleKey's transcription service is having trouble. Nothing was charged.");
});

test("OpenAI's quota running out is a 503, not a 402 or a 429", () => {
  for (const [status, code] of [
    [402, "billing_hard_limit_reached"],
    [429, "insufficient_quota"],
    [429, "rate_limit_exceeded"],
    [403, "unsupported_country_region_territory"],
    [404, "model_not_found"],
    [409, "conflict"],
    [500, "server_error"],
    [502, undefined],
    [504, undefined],
  ]) {
    const failure = failureResponse(openai(status, code, "Something OpenAI said."));
    assert.equal(failure.status, 503, `${status} ${code}`);
    assert.equal(failure.body.code, "upstream");
    assert.equal(failure.level, "error", `${status} ${code}`);
  }
});

test("OpenAI refusing the recording itself says so, and is a warning, not an outage", () => {
  const sentence = "That recording could not be transcribed. Try a shorter one.";
  for (const [status, code, expected] of [
    [400, "invalid_value", 400],
    [400, "audio_too_short", 400],
    [422, "unprocessable_entity", 400],
    [413, undefined, 413],
  ]) {
    const failure = failureResponse(openai(status, code, "Audio file might be corrupted."));
    assert.equal(failure.status, expected, `${status} ${code}`);
    assert.deepEqual(failure.body, { error: sentence, code: REJECTED_CODE });
    assert.equal(failure.level, "warn", `${status} ${code}`);
    assert.match(failure.log, new RegExp(`status=${status}`));
    assert.ok(!/credit/i.test(failure.body.error));
    // OpenAI's own words do not reach the person.
    assert.ok(!JSON.stringify(failure.body).includes("corrupted"));
  }
});

test("a rewrite OpenAI refuses is described as a rewrite", () => {
  const failure = failureResponse(openai(400, "invalid_value", "Bad input."), "text");
  assert.equal(failure.status, 400);
  assert.equal(failure.body.error, "That text could not be rewritten. Try something shorter.");
  assert.ok(!/credit/i.test(failure.body.error));
});

test("a connection that never reached OpenAI is a 503 too", () => {
  const failure = failureResponse(new OpenAI.APIConnectionError({ message: "Connection error." }));
  assert.equal(failure.status, 503);
  assert.match(failure.log, /status=none/);
});

test("the messages say what happened without opening the Buy credits window", () => {
  // The desktop opens that window for any failure whose text mentions credit.
  for (const message of [UPSTREAM_MESSAGE, UNEXPECTED_MESSAGE, TOO_LARGE_MESSAGE, UNREADABLE_MESSAGE]) {
    assert.ok(!/credit/i.test(message), message);
  }
  assert.ok(!/openai|\bkey\b|quota|sign in/i.test(UPSTREAM_MESSAGE));
});

test("the log line carries OpenAI's status, type, code, parameter and request id, and nothing it said", () => {
  const failure = failureResponse(
    openai(401, "invalid_api_key", `Incorrect API key provided: ${KEY}.`),
  );
  assert.equal(
    failure.log,
    "OpenAI call failed: status=401 type=invalid_request_error code=invalid_api_key param=- request=req_abc123",
  );
  assert.ok(!failure.log.includes(KEY));
  assert.ok(!failure.log.includes("AbCd1234"));
  assert.ok(!JSON.stringify(failure.body).includes("sk-"));
});

test("OpenAI's message text is never logged, because it can quote the request", () => {
  // A 400 that echoes the vocabulary and screen text the dictation sent.
  const quoted = 'Invalid keyword "Zoë Hartwell" in prompt "Dictating into Mail - draft to my landlord".';
  for (const status of [400, 422, 500]) {
    const failure = failureResponse(openai(status, "invalid_value", quoted));
    assert.ok(!failure.log.includes("Hartwell"), failure.log);
    assert.ok(!failure.log.includes("landlord"), failure.log);
    assert.ok(!failure.log.includes("message"), failure.log);
  }
  assert.ok(!describeUpstream(openai(400, "x", quoted)).includes("Hartwell"));
});

test("a type or code that is not a plain identifier is not logged", () => {
  const odd = OpenAI.APIError.generate(
    400,
    { error: { message: "m", type: "invalid request: my private words", code: "x".repeat(200) } },
    undefined,
    new Headers({ "x-request-id": "req_abc123" }),
  );
  assert.equal(
    describeUpstream(odd),
    "status=400 type=- code=- param=- request=req_abc123",
  );
});

test("the parameter OpenAI objected to is logged, so a refusal of TeleKey's own request can be traced", () => {
  // A vocabulary word or language OpenAI will not take fails every dictation
  // with "try a shorter one"; the parameter name is the only clue in the log.
  const refused = OpenAI.APIError.generate(
    400,
    { error: { message: "m", type: "invalid_request_error", code: "invalid_value", param: "language" } },
    undefined,
    new Headers({ "x-request-id": "req_abc123" }),
  );
  assert.equal(
    describeUpstream(refused),
    "status=400 type=invalid_request_error code=invalid_value param=language request=req_abc123",
  );
});

test("TeleKey's own 401, 402 and 429 are passed through as they were", () => {
  const signedOut = failureResponse(teleKey("Session expired — sign in again.", 401));
  assert.equal(signedOut.status, 401);
  assert.deepEqual(signedOut.body, { error: "Session expired — sign in again." });
  assert.equal(signedOut.log, undefined);

  const broke = failureResponse(teleKey("Out of credits — buy more in TeleKey.", 402, "out_of_credits"));
  assert.equal(broke.status, 402);
  assert.deepEqual(broke.body, {
    error: "Out of credits — buy more in TeleKey.",
    code: "out_of_credits",
  });

  const busy = failureResponse(teleKey("Slow down a moment.", 429));
  assert.equal(busy.status, 429);

  const refused = failureResponse(teleKey("x@y.z is not on the list.", 403, "not_a_tester"));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.code, "not_a_tester");
});

test("anything unexpected is a 500 with a fixed sentence, never its own message", () => {
  assert.equal(failureResponse(new Error("boom")).status, 500);
  assert.equal(failureResponse("a string").status, 500);
  assert.equal(failureResponse(undefined).status, 500);
  assert.equal(failureResponse(undefined).body.error, "Something went wrong on TeleKey's side. Try again.");
  assert.equal(UNEXPECTED_MESSAGE, "Something went wrong on TeleKey's side. Try again.");
  assert.equal(failureResponse(teleKey("odd", Number.NaN)).status, 500);
  assert.equal(failureResponse(teleKey("odd", 200)).status, 500);
});

test("a 500 does not leak environment variable names or database internals", () => {
  const leaks = [
    // functions/src/index.ts requiredEnv
    teleKey("Missing STRIPE_SECRET_KEY_PRODUCTION in functions/.env", 500),
    // A Firestore failure
    Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index. projects/telekey-app/databases/(default)"), {
      code: 9,
    }),
    // A thrown error that happens to carry a string code
    Object.assign(new Error("connect ECONNREFUSED 10.0.0.4:5432"), { code: "ECONNREFUSED" }),
    // A 5xx a library raised with its own status
    teleKey("upstream gateway says: db password rejected", 502),
  ];
  for (const err of leaks) {
    const failure = failureResponse(err);
    assert.ok(failure.status >= 500);
    assert.deepEqual(failure.body, { error: UNEXPECTED_MESSAGE });
    assert.ok(!/STRIPE|index|ECONN|password|projects/.test(JSON.stringify(failure.body)));
  }
  // The real error is for the log: no `log` is set, so the caller logs the error itself.
  assert.equal(failureResponse(leaks[0]).log, undefined);
});

test("an upload over the body limit, and a body that cannot be read, get plain JSON answers", () => {
  const tooLarge = Object.assign(new Error("request entity too large"), {
    status: 413,
    statusCode: 413,
    type: "entity.too.large",
    expose: true,
  });
  assert.deepEqual(failureResponse(tooLarge), {
    status: 413,
    body: { error: TOO_LARGE_MESSAGE },
  });
  const malformed = Object.assign(new SyntaxError("Unexpected token } in JSON at position 17"), {
    status: 400,
    type: "entity.parse.failed",
    expose: true,
  });
  const failure = failureResponse(malformed);
  assert.equal(failure.status, 400);
  assert.deepEqual(failure.body, { error: UNREADABLE_MESSAGE });
});

test("only the SDK's own errors count as OpenAI's", () => {
  assert.equal(describeUpstream(teleKey("Session expired", 401)), null);
  assert.equal(describeUpstream(new Error("boom")), null);
  assert.equal(describeUpstream(null), null);
  assert.ok(describeUpstream(openai(500, "server_error", "oops")));
});

test("log fields are plain identifiers or nothing", () => {
  assert.equal(logField("insufficient_quota"), "insufficient_quota");
  assert.equal(logField("req_abc123"), "req_abc123");
  assert.equal(logField("rate-limit.exceeded:v2"), "rate-limit.exceeded:v2");
  assert.equal(logField(`bad key ${KEY}.`), "-");
  assert.equal(logField("a b"), "-");
  assert.equal(logField("x".repeat(65)), "-");
  assert.equal(logField(""), "-");
  assert.equal(logField(undefined), "-");
  assert.equal(logField(null), "-");
  assert.equal(logField(42), "-");
  assert.equal(logField(["req_1"]), "-");
});
