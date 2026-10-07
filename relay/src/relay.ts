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
 * Dependencies are passed in, so the tests drive it against a fake OpenAI.
 */

import { createServer, STATUS_CODES, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import { noUnits, type Units } from "../../functions/src/pricing";
import {
  billedSeconds,
  BYTES_PER_SECOND,
  fromClient,
  fromServer,
  MAX_SESSION_SECONDS,
  OPENAI_LIVE_URL,
} from "./protocol";

export type Member = { uid: string; email?: string };

export type RelayDeps = {
  /** A signed-in user who may dictate now, or throw `{ status, code, message }`. */
  admit(authorization: string | undefined): Promise<Member>;
  /** Charge for a transcript already delivered. May not refuse; may throw. */
  charge(member: Member, units: Units): Promise<void>;
  openaiKey: string;
  /** Where OpenAI is; the tests point it at a fake. */
  upstreamUrl?: string;
  log?: (line: string) => void;
};

/** Long enough for a slow handshake, short enough to fall back to Standard in time. */
const UPSTREAM_TIMEOUT_MS = 10_000;

export function createRelay(deps: RelayDeps): Server {
  const log = deps.log ?? ((line: string) => console.log(line));
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
      const status = Number((err as { status?: number }).status ?? 500);
      const code = (err as { code?: unknown }).code;
      const message = err instanceof Error ? err.message : "Something went wrong.";
      if (status >= 500) log(`admit failed: ${message}`);
      refuse(socket, status, typeof code === "string" ? { error: message, code } : { error: message });
      return;
    }

    let upstream: Upstream;
    try {
      upstream = await openUpstream(deps.upstreamUrl ?? OPENAI_LIVE_URL, deps.openaiKey);
    } catch (err) {
      log(`upstream failed for ${member.uid}: ${(err as Error).message}`);
      refuse(socket, 502, { error: "Instant is unavailable right now.", code: "upstream" });
      return;
    }

    wss.handleUpgrade(req, socket, head, (client) => pipe(client, upstream, member));
  }

  function pipe(client: WebSocket, { socket: upstream, early, hold }: Upstream, member: Member) {
    // Audio since the last commit, and per commit until its transcript is
    // billed. Turns complete in the order they were committed.
    let pending = 0;
    let total = 0;
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
          committed.push(pending);
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

        const seconds = billedSeconds(committed.shift() ?? 0, action.event.usage);
        const units: Units = { ...noUnits(), dictations: 1, liveTranscribeSeconds: seconds };
        send(client, JSON.stringify({ ...action.event, units }));
        try {
          const charging = Date.now();
          await deps.charge(member, units);
          log(`charged ${member.uid} for ${seconds} s in ${Date.now() - charging} ms`);
        } catch (err) {
          // The words are already with the user; the books are what failed.
          const message = err instanceof Error ? err.message : String(err);
          log(`CHARGE FAILED for ${member.uid}, ${seconds} s: ${message}`);
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
    upstream.on("error", (err) => log(`upstream error for ${member.uid}: ${err.message}`));
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
      reject(new Error(`HTTP ${res.statusCode}`));
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
