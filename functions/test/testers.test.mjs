// Run with `npm test` (builds first). Pure checks of who may use staging.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { parseTesters, testerProblem } = require("../lib/testers.js");

const testers = parseTesters(
  " theodoreimonigie@gmail.com, Cynthiaobasuyi68@gmail.com;theodoremcaapple@gmail.com\nnot-an-email ",
);

test("parses commas, semicolons, spaces and new lines, and lowercases", () => {
  assert.deepEqual(
    [...testers].sort(),
    ["cynthiaobasuyi68@gmail.com", "theodoreimonigie@gmail.com", "theodoremcaapple@gmail.com"],
  );
});

test("a listed, verified email is let in, whatever its case", () => {
  assert.equal(testerProblem(testers, "TheodoreImonigie@gmail.com", true), null);
});

test("an unlisted email is refused, and the message names it", () => {
  const problem = testerProblem(testers, "stranger@example.com", true);
  assert.match(problem, /stranger@example\.com isn't a staging tester/);
  assert.match(problem, /STAGING_ALLOWED_EMAILS/);
});

test("a listed but unverified email is refused", () => {
  assert.match(testerProblem(testers, "theodoreimonigie@gmail.com", false), /isn't verified/);
  assert.match(testerProblem(testers, "theodoreimonigie@gmail.com", undefined), /isn't verified/);
});

test("an account with no email is refused", () => {
  assert.match(testerProblem(testers, undefined, true), /no email/);
});

test("an empty or missing list lets nobody in", () => {
  assert.match(testerProblem(parseTesters(""), "theodoreimonigie@gmail.com", true), /is empty/);
  assert.match(testerProblem(parseTesters(undefined), "theodoreimonigie@gmail.com", true), /is empty/);
});

test("no refusal mentions credits, so the app does not open the Buy credits window", () => {
  const messages = [
    testerProblem(testers, "stranger@example.com", true),
    testerProblem(testers, "theodoreimonigie@gmail.com", false),
    testerProblem(testers, undefined, true),
    testerProblem(parseTesters(""), "a@b.c", true),
  ];
  for (const message of messages) assert.doesNotMatch(message, /credit/i);
});
