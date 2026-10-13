/**
 * The Instant relay: a WebSocket in front of OpenAI's live transcription, for
 * dictations paid for with TeleKey credits.
 *
 * The app cannot be handed TeleKey's OpenAI key, and OpenAI's short-lived
 * client keys let the client change the session (a dearer model, or minutes
 * TeleKey cannot count). So the app connects here with its sign-in, and the
 * relay connects to OpenAI with the key and passes a dictation through,
 * counting the audio as it goes.
 *
 * It charges once per transcript, straight after handing it over — not
 * before, which cost a third of a second of the speed Instant is for. Then it
 * sends `telekey.charged` and closes; the app waits for that in the
 * background, so the connection (and with it Cloud Run's CPU) lasts until the
 * charge is written. A session that fails before a transcript costs nothing.
 *
 * OpenAI's failures are TeleKey's to carry, not the user's: a key OpenAI has
 * revoked, or a quota it has used up, reaches the app as a plain 503 / error
 * event ("having trouble, nothing was charged"), never as OpenAI's own status
 * or wording, and is logged at ERROR with what OpenAI said.
 *
 * Dependencies are passed in, so the tests drive it against a fake OpenAI.
 */

import { createServer, STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { logField } from "../../functions/src/logfield";
import { noUnits, type Exact, type Units } from "../../functions/src/pricing";
import {
  billedSeconds,
  BYTES_PER_SECOND,
  fromClient,
  fromServer,
  MAX_SESSION_SECONDS,
  OPENAI_LIVE_URL,
  unitSeconds,
} from "./protocol";

export type Member = { uid: string; email?: string };

export type RelayDeps = {
  /** A signed-in user who may dictate now, or throw `{ status, code, message }`. */
  admit(authorization: string | undefined): Promise<Member>;
  /**
   * Charge for a transcript already delivered. `units` is in whole seconds,
   * as the app counts; `exact` is the fractional figure to price. May not
   * refuse; may throw.
   */
  charge(member: Member, units: Units, exact: Exact): Promise<void>;
  openaiKey: string;
  /** Where OpenAI is; the tests point it at a fake. */
  upstreamUrl?: string;
  /** Where log lines go; `ERROR` marks what someone should look at. */
  log?: (line: string, severity?: Severity) => void;
};

export type Severity = "INFO" | "ERROR";

/**
 * Cloud Run reads a JSON line on stdout as a log entry with its own severity,
 * which is how an ERROR here becomes one in Cloud Logging.
 */
function writeLog(line: string, severity: Severity = "INFO") {
  console.log(severity === "ERROR" ? JSON.stringify({ severity, message: line }) : line);
}

/** What the app is told when OpenAI is the one that failed. */
export const UPSTREAM_MESSAGE = "TeleKey's Instant service is having trouble. Nothing was charged.";

/** What the app is told when something of TeleKey's own broke. The same as the Functions API's. */
export const UNEXPECTED_MESSAGE = "Something went wrong on TeleKey's side. Try again.";

/** Long enough for a slow handshake, short enough to fall back to Standard in time. */
const UPSTREAM_TIMEOUT_MS = 10_000;

export function createRelay(deps: RelayDeps): Server {
  const log = deps.log ?? writeLog;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void accept(req, socket, head);
  });

  async function accept(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const path = new URL(req.url ?? "/", "http://relay").pathname;
    if (path !== "/v1/realtime") {
      refuse(socket, 404, { error: "Not found" });
      return;
    }

    let member: Member;
    try {
      member = await deps.admit(req.headers.authorization);
    } catch (err) {
      // TeleKey's own refusals (sign-in, tester list, balance) carry a status
      // below 500 and a message written for people. Anything else is
      // unexpected, and its message can name environment variables or
      // Firestore internals: the app gets a fixed sentence, the log the cause.
      const asked = Number((err as { status?: number }).status ?? 500);
      const status = Number.isInteger(asked) && asked >= 400 && asked <= 599 ? asked : 500;
      if (status >= 500) {
        log(`admit failed: ${err instanceof Error ? err.message : String(err)}`, "ERROR");
        refuse(socket, status, { error: UNEXPECTED_MESSAGE });
        return;
      }
      const code = (err as { code?: unknown }).code;
      const message = err instanceof Error ? err.message : "Something went wrong.";
      refuse(socket, status, typeof code === "string" ? { error: message, code } : { error: message });
      return;
    }

    let upstream: Upstream;
    try {
      upstream = await openUpstream(deps.upstreamUrl ?? OPENAI_LIVE_URL, deps.openaiKey);
    } catch (err) {
      // `HTTP 401` or `HTTP 429` here is OpenAI refusing TeleKey's key.
      log(`upstream failed for ${member.uid}: ${(err as Error).message}`, "ERROR");
      refuse(socket, 503, { error: UPSTREAM_MESSAGE, code: "upstream" });
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => pipe(client, upstream, member));
  }

  function pipe(client: WebSocket, { socket: upstream, early, hold }: Upstream, member: Member) {
    // Audio since the last commit, and per commit until its transcript is
    // billed. Turns complete in the order they were committed.
    let pending = 0;
    let total = 0;
    let billed = 0;
    const committed: number[] = [];
    // Upstream messages are handled one at a time, so a transcript held up
    // by the charge is not overtaken by whatever OpenAI sends after it.
    let queue = Promise.resolve();

    const send = (socket: WebSocket, message: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    };

    client.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) return;
      const action = fromClient(data.toString());
      switch (action.kind) {
        case "drop":
          return;
        case "append":
          pending += action.bytes;
          total += action.bytes;
          if (total > MAX_SESSION_SECONDS * BYTES_PER_SECOND) {
            send(client, errorEvent("too_long", "That dictation is too long for Instant."));
            client.close(1008, "too long");
            return;
          }
          send(upstream, action.message);
          return;
        case "commit":
          // An empty commit is still passed on (OpenAI refuses it, as it
          // would without the relay), but it takes no place in the billing
          // queue: queued as 0 bytes, it would be matched to the next real
          // transcript and bill that one nothing.
          if (pending > 0) committed.push(pending);
          pending = 0;
          send(upstream, action.message);
          return;
        case "clear":
          pending = 0;
          send(upstream, action.message);
          return;
        case "configure":
          send(upstream, action.message);
          return;
      }
    });

    const fromUpstream = (raw: string) => {
      queue = queue.then(async () => {
        const action = fromServer(raw);
        if (action.kind === "drop") return;
        if (action.kind === "forward") {
          send(client, action.message);
          return;
        }
        if (action.kind === "failed") {
          log(`upstream error for ${member.uid}: ${action.detail}`, "ERROR");
          send(client, errorEvent("upstream", UPSTREAM_MESSAGE));
          return;
        }

        // Charged to the byte; the app is told the nearest whole second.
        // Never less than the audio streamed and not yet billed: a session
        // ends after its one transcript, and every byte sent on was paid for
        // upstream, whatever the client did with commits and clears.
        const bytes = Math.max(committed.shift() ?? 0, total - billed);
        billed += bytes;
        const seconds = billedSeconds(bytes, action.event.usage);
        const units: Units = {
          ...noUnits(),
          dictations: 1,
          liveTranscribeSeconds: unitSeconds(seconds),
        };
        send(client, JSON.stringify({ ...action.event, units }));
        try {
          const charging = Date.now();
          await deps.charge(member, units, { liveSeconds: seconds });
          log(
            `charged ${member.uid} for ${seconds.toFixed(3)} s in ${Date.now() - charging} ms`,
          );
        } catch (err) {
          // The words are already with the user; the books are what failed.
          const message = err instanceof Error ? err.message : String(err);
          log(`CHARGE FAILED for ${member.uid}, ${seconds.toFixed(3)} s: ${message}`, "ERROR");
        }
        send(client, JSON.stringify({ type: "telekey.charged" }));
        client.close(1000, "done");
      });
    };
    // OpenAI speaks first (`session.created`), before the app's socket
    // existed; what it said meanwhile was held, and goes first.
    for (const raw of early.splice(0)) fromUpstream(raw);
    upstream.off("message", hold);
    upstream.on("message", (data: RawData) => fromUpstream(data.toString()));

    const closeBoth = () => {
      for (const socket of [client, upstream]) {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      }
    };
    client.on("close", closeBoth);
    upstream.on("close", closeBoth);
    client.on("error", (err) => log(`client error for ${member.uid}: ${err.message}`));
    upstream.on("error", (err) =>
      log(`upstream socket error for ${member.uid}: ${err.message}`, "ERROR"),
    );
  }

  return server;
}

/** An open connection to OpenAI, and what it has said before anyone listened. */
type Upstream = {
  socket: WebSocket;
  early: string[];
  /** The listener that fills `early`, removed once the app is connected. */
  hold: (data: RawData) => void;
};

/**
 * Connect to OpenAI before accepting the app, so a failure is a clean HTTP
 * status. Messages are held from the first moment: OpenAI sends
 * `session.created` as soon as it connects, before the app's socket is up.
 */
function openUpstream(url: string, key: string): Promise<Upstream> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    const early: string[] = [];
    const hold = (data: RawData) => {
      early.push(data.toString());
    };
    socket.on("message", hold);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out"));
    }, UPSTREAM_TIMEOUT_MS);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve({ socket, early, hold });
    });
    socket.once("unexpected-response", (_req, res) => {
      clearTimeout(timer);
      socket.terminate();
      // Status and OpenAI's request id only; the body is never read or logged.
      const request = logField(res.headers["x-request-id"]);
      reject(new Error(`HTTP ${res.statusCode} request=${request}`));
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** An `error` event in OpenAI's shape, so the app handles both alike. */
function errorEvent(code: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type: "telekey_error", code, message } });
}

/** Answer an upgrade request with an HTTP error the app can read. */
function refuse(socket: Duplex, status: number, body: Record<string, unknown>) {
  const json = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? "Error"}\r\n` +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(json)}\r\n` +
      "Connection: close\r\n\r\n" +
      json,
  );
}
