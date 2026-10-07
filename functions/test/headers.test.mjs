// Run with `npm test` (builds first). Reading the app's headers as it sent them.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { headerText, parseList, parsePrompt, MAX_PROMPT_BYTES } = require("../lib/headers.js");

/** Send raw bytes as a header to a real Node server, as reqwest does. */
function throughNode(headerBytes) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      res.end();
      server.close();
      resolve(req.headers["x-telekey-keywords"]);
    });
    server.listen(0, "127.0.0.1", () => {
      const socket = connect(server.address().port, "127.0.0.1", () => {
        socket.write(
          Buffer.concat([
            Buffer.from("GET / HTTP/1.1\r\nHost: x\r\nx-telekey-keywords: "),
            headerBytes,
            Buffer.from("\r\nConnection: close\r\n\r\n"),
          ]),
        );
      });
      socket.on("error", reject);
      socket.on("data", () => socket.end());
    });
  });
}

test("an accented word survives Node's header decoding", async () => {
  const sent = Buffer.from(JSON.stringify(["Zoë", "Zürich", "Đorđe", "東京"]), "utf8");
  const received = await throughNode(sent);
  // What the server used to pass on:
  assert.notDeepEqual(JSON.parse(received), ["Zoë", "Zürich", "Đorđe", "東京"]);
  assert.deepEqual(parseList(received), ["Zoë", "Zürich", "Đorđe", "東京"]);
});

test("plain ASCII is unchanged, so older apps are unaffected", () => {
  assert.deepEqual(parseList('["Kubernetes","TeleKey"]'), ["Kubernetes", "TeleKey"]);
  assert.equal(headerText("en"), "en");
  assert.deepEqual(parseList(undefined), []);
  assert.deepEqual(parseList("not json"), []);
  assert.deepEqual(parseList('[1, "ok"]'), ["ok"]);
});

test("the prompt arrives as base64 of UTF-8", () => {
  const text = "Dictating into Slack — #eng. Text near the cursor: “Zoë said…”";
  assert.equal(parsePrompt(Buffer.from(text, "utf8").toString("base64")), text);
  assert.equal(parsePrompt(undefined), undefined);
  assert.equal(parsePrompt(""), undefined);
});

test("a long prompt is cut to the cap on a whole character", () => {
  const text = "é".repeat(MAX_PROMPT_BYTES); // two bytes each
  const kept = parsePrompt(Buffer.from(text, "utf8").toString("base64"));
  assert.ok(Buffer.byteLength(kept, "utf8") <= MAX_PROMPT_BYTES);
  assert.ok(!kept.includes("�"), "no half a character at the end");
  assert.equal(kept.length, MAX_PROMPT_BYTES / 2);
});
