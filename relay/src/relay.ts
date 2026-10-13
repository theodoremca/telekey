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
 * charge is written. A session that fails before a transcript costs nothing;
 * audio the app streamed and then walked away from is logged as abandoned, and
 * charged only if `CHARGE_ABANDONED_AUDIO` says so.
 *
 * Audio is passed on only once the session has been configured: the first
 * `session.update` is forwarded (rebuilt, with the model fixed and voice
 * detection off) before any `append`, `commit` or `clear`, so OpenAI's
 * defaults (another model, a server that commits on silence) never apply to
 * audio TeleKey pays for. After the transcript has been handed over the
 * session is closing, and anything more the app sends is ignored: it would
 * reach OpenAI and never be charged.
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
import { createStartLimit } from "./admission";
import {
  billedSeconds,
  BYTES_PER_SECOND,
  fromClient,
  fromServer,
  IDLE_MS,
  MAX_SESSION_SECONDS,
  MAX_SESSIONS_PER_USER,
  MAX_STARTS_PER_MINUTE,
  OPENAI_LIVE_URL,
  overBudget,
  unitSeconds,
} from "./protocol";

export type Member = {
  uid: string;
  email?: string;
  /**
   * What the person could spend when they were let in, in microcents. A
   * session is stopped once its audio would cost more than this and a small
   * allowance (`overBudget`). Unset means no limit, which only the tests use.
   */
  budgetMicrocents?: number;
};

/** Who is calling, once their sign-in has been checked. */
export type Caller = { uid: string; email?: string };

export type RelayDeps = {
  /**
   * Who is calling and whether they may use this stage: the sign-in check
   * and the tester list, and nothing from the database. Or throw
   * `{ status, code, message }`. Split from `admit` so the limits on how
   * often one person may start a session can be applied before their
   * account is read.
   */
  identify(authorization: string | undefined): Promise<Caller>;
  /**
   * Whether they can pay for a session: one read of their account. Throws
   * `{ status, code, message }` (the 402 for a balance too low) or returns
   * the member with what they could spend.
   */
  admit(caller: Caller): Promise<Member>;
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
  /**
   * A session with no audio arriving for this long is closed, uncharged: from
   * connecting until the first of it, between pieces, and while waiting for
   * the transcript after a commit. Defaults to `IDLE_MS`; the tests shorten it.
   */
  idleMs?: number;
  /** Sessions one person may have open at once on this instance. */
  maxSessionsPerUser?: number;
  /** Sessions one person may begin in a minute on this instance. */
  maxStartsPerMinute?: number;
  /**
   * The longest a session may last, in seconds of audio and of wall-clock
   * time. Defaults to `MAX_SESSION_SECONDS`; the tests shorten it.
   */
  maxSessionSeconds?: number;
  /** Overrides `CHARGE_ABANDONED_AUDIO`; the tests use it to try both. */
  chargeAbandonedAudio?: boolean;
};

export type Severity = "INFO" | "WARN" | "ERROR";

/**
 * Cloud Run reads a JSON line on stdout as a log entry with its own severity,
 * which is how an ERROR here becomes one in Cloud Logging. (Cloud Logging
 * calls WARN "WARNING".)
 */
function writeLog(line: string, severity: Severity = "INFO") {
  if (severity === "INFO") {
    console.log(line);
    return;
  }
  console.log(
    JSON.stringify({ severity: severity === "WARN" ? "WARNING" : severity, message: line }),
  );
}

/**
 * Whether audio that was streamed to OpenAI and never paid for, because the
 * app closed the connection before a transcript was delivered (a cancel, or
 * an app that disconnects on purpose), is charged — the seconds only, with
 * `dictations: 0` — or only logged. On, by the owner's decision (2026-10-13):
 * Instant sends audio while you speak, so a cancelled Instant dictation pays
 * for the seconds already sent, as the Terms and the FAQ say. Without it a
 * paying user could stream for free by disconnecting before the text.
 * (`RelayDeps` can override it, which is how the tests exercise both.)
 *
 * Best effort: the write happens after the app's connection is gone, and
 * Cloud Run may hold back an instance's CPU once its last connection closes
 * (CLAUDE.md, rule 25), so the charge can land late, when the instance next
 * serves a request, or be lost if the instance is shut down first. It is a
 * deterrent, not revenue.
 */
export const CHARGE_ABANDONED_AUDIO = true;

/** What the app is told when OpenAI is the one that failed. */
export const UPSTREAM_MESSAGE = "TeleKey's Instant service is having trouble. Nothing was charged.";

/** What the app is told when something of TeleKey's own broke. The same as the Functions API's. */
export const UNEXPECTED_MESSAGE = "Something went wrong on TeleKey's side. Try again.";

/** What the app is told when a session sat with nothing to transcribe. */
export const IDLE_MESSAGE = "That dictation timed out waiting for audio. Nothing was charged.";

/** What the app is told when a dictation outgrew what its balance covers. */
export const OVER_BUDGET_MESSAGE =
  "That dictation is longer than Instant can take right now. Nothing was charged.";

/** What the app is told when it opens more sessions than one person needs, or begins them too fast. */
export const BUSY_MESSAGE = "Slow down a moment.";

/** What the app is told when a session reaches the longest one may be. Plain: no word about credits. */
export const TOO_LONG_MESSAGE = "That dictation is too long for Instant. Nothing was charged.";

/** Long enough for a slow handshake, short enough to fall back to Standard in time. */
const UPSTREAM_TIMEOUT_MS = 10_000;

export function createRelay(deps: RelayDeps): Server {
  const log = deps.log ?? writeLog;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const maxSessions = deps.maxSessionsPerUser ?? MAX_SESSIONS_PER_USER;
  const maxSessionSeconds = deps.maxSessionSeconds ?? MAX_SESSION_SECONDS;
  const chargeAbandoned = deps.chargeAbandonedAudio ?? CHARGE_ABANDONED_AUDIO;
  // Sessions open per person. Each is let in on the same balance, so without
  // a limit a person could open as many as they liked and have every one of
  // them stream up to that balance before any of them is charged.
  const open = new Map<string, number>();
  // How fast one person may begin them: each costs a read of their account
  // and a connection to OpenAI.
  const starts = createStartLimit(deps.maxStartsPerMinute ?? MAX_STARTS_PER_MINUTE);

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

    // The time the request began, which Cloud Run's timeout counts from.
    const began = Date.now();

    let caller: Caller;
    try {
      caller = await deps.identify(req.headers.authorization);
    } catch (err) {
      refuseAdmission(socket, err);
      return;
    }

    // Both limits are decided here, from who is calling and nothing else, so
    // a person turned away costs no read of their account and no connection to
    // OpenAI. And both are decided in one go, with nothing awaited between
    // the checks and taking the place, so sessions that arrive together
    // cannot all pass the count.
    if (!starts.allows(caller.uid)) {
      log(`session start limit reached for ${caller.uid}`);
      refuse(socket, 429, { error: BUSY_MESSAGE, code: "busy" });
      return;
    }
    if ((open.get(caller.uid) ?? 0) >= maxSessions) {
      refuse(socket, 429, { error: BUSY_MESSAGE, code: "busy" });
      return;
    }
    starts.record(caller.uid);
    open.set(caller.uid, (open.get(caller.uid) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (open.get(caller.uid) ?? 1) - 1;
      if (left > 0) open.set(caller.uid, left);
      else open.delete(caller.uid);
    };

    let member: Member;
    try {
      member = await deps.admit(caller);
    } catch (err) {
      release();
      refuseAdmission(socket, err);
      return;
    }

    let upstream: Upstream;
    try {
      upstream = await openUpstream(deps.upstreamUrl ?? OPENAI_LIVE_URL, deps.openaiKey);
    } catch (err) {
      release();
      // `HTTP 401` or `HTTP 429` here is OpenAI refusing TeleKey's key.
      log(`upstream failed for ${member.uid}: ${(err as Error).message}`, "ERROR");
      refuse(socket, 503, { error: UPSTREAM_MESSAGE, code: "upstream" });
      return;
    }

    // If the app goes away before its side is accepted, nothing else will
    // close OpenAI's side or give the place back.
    const droppedEarly = () => {
      release();
      upstream.socket.terminate();
    };
    if (socket.destroyed) {
      droppedEarly();
      return;
    }
    socket.once("close", droppedEarly);
    wss.handleUpgrade(req, socket, head, (client) => {
      socket.off("close", droppedEarly);
      client.once("close", release);
      pipe(client, upstream, member, began);
    });
  }

  /**
   * TeleKey's own refusals (sign-in, tester list, balance) carry a status
   * below 500 and a message written for people. Anything else is unexpected,
   * and its message can name environment variables or Firestore internals:
   * the app gets a fixed sentence, the log the cause.
   */
  function refuseAdmission(socket: Duplex, err: unknown) {
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
  }

  function pipe(
    client: WebSocket,
    { socket: upstream, early, hold }: Upstream,
    member: Member,
    began: number,
  ) {
    // Audio since the last commit, and per commit until its transcript is
    // billed. Turns complete in the order they were committed.
    let pending = 0;
    let total = 0;
    let billed = 0;
    const committed: number[] = [];
    // Upstream messages are handled one at a time, so a transcript held up
    // by the charge is not overtaken by whatever OpenAI sends after it.
    let queue = Promise.resolve();
    // Set once the app's `session.update` has been forwarded. Until then
    // OpenAI's own defaults are in force (another model, and a server that
    // commits on silence), so no audio and no commit or clear may reach it.
    let configured = false;
    let warnedEarly = false;
    // Set when the first transcript is processed. The session closes as soon
    // as that is charged; whatever the app sends meanwhile would reach OpenAI
    // and never be charged, so it is ignored.
    let delivered = false;
    // Who ended the session, for `abandoned` below: OpenAI saying it failed,
    // or its socket going first, is not the app walking away.
    let upstreamFailed = false;
    let upstreamEnded = false;

    const send = (socket: WebSocket, message: string) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
    };

    // A session that nobody is feeding is closed rather than left open: it
    // holds a place, an OpenAI connection and a Cloud Run instance for
    // nothing. The clock runs from connecting, restarts with each piece of
    // audio, and runs again while a committed turn waits for its transcript.
    // Nothing is charged: no transcript was delivered.
    const idleMs = deps.idleMs ?? IDLE_MS;
    let idle: ReturnType<typeof setTimeout> | undefined;
    // Set when the relay itself ends the session. A transcript that arrives
    // after that was never delivered, so it is not charged.
    let stopped = false;
    const stopIdle = () => {
      if (idle) clearTimeout(idle);
      idle = undefined;
    };
    const startIdle = () => {
      stopIdle();
      idle = setTimeout(() => {
        idle = undefined;
        log(`idle session for ${member.uid} closed after ${idleMs} ms`);
        send(client, errorEvent("idle", IDLE_MESSAGE));
        stop(1008, "idle");
      }, idleMs);
      idle.unref?.();
    };
    // However the audio arrives, a session ends at `maxSessionSeconds` from
    // the request beginning: cleanly, with a plain message, before Cloud Run
    // ends the connection without one. (The audio itself is capped at the
    // same figure below; this also covers a client that trickles it in.)
    // The dictation being delivered ends this clock, since the session closes
    // as soon as it is charged.
    let limit: ReturnType<typeof setTimeout> | undefined;
    const stopLimit = () => {
      if (limit) clearTimeout(limit);
      limit = undefined;
    };
    limit = setTimeout(
      () => {
        limit = undefined;
        log(`session for ${member.uid} ended at the ${maxSessionSeconds} s limit`);
        send(client, errorEvent("too_long", TOO_LONG_MESSAGE));
        stop(1008, "too long");
      },
      Math.max(0, maxSessionSeconds * 1000 - (Date.now() - began)),
    );
    limit.unref?.();
    /** End the session from here; the sockets' `close` events do the rest. */
    const stop = (code: number, reason: string) => {
      stopped = true;
      stopIdle();
      stopLimit();
      client.close(code, reason);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
        upstream.close();
      }
    };
    startIdle();

    client.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary || stopped || delivered) return;
      const action = fromClient(data.toString());
      if (!configured && (action.kind === "append" || action.kind === "commit" || action.kind === "clear")) {
        // Not forwarded, not counted and not a sign of life: the idle clock
        // keeps running. (The app waits for `session.updated` before it
        // streams, so only a client that is not the app gets here.)
        if (!warnedEarly) {
          warnedEarly = true;
          log(`audio from ${member.uid} arrived before session.update and was dropped`);
        }
        return;
      }
      switch (action.kind) {
        case "drop":
          return;
        case "append":
          // Nothing in it: not audio to bill or to transcribe, and not a sign
          // that anyone is dictating. Dropped, so that a stream of empty
          // appends cannot keep a session open past its idle time.
          if (action.bytes <= 0) return;
          pending += action.bytes;
          total += action.bytes;
          if (total > maxSessionSeconds * BYTES_PER_SECOND) {
            send(client, errorEvent("too_long", TOO_LONG_MESSAGE));
            stop(1008, "too long");
            return;
          }
          // Not forwarded: OpenAI is not asked to transcribe audio the
          // balance cannot pay for.
          if (overBudget(total, member.budgetMicrocents)) {
            log(
              `session for ${member.uid} stopped at ${(total / BYTES_PER_SECOND).toFixed(1)} s: ` +
                "more audio than its balance covers",
            );
            send(client, errorEvent("over_budget", OVER_BUDGET_MESSAGE));
            stop(1008, "over budget");
            return;
          }
          startIdle();
          send(upstream, action.message);
          return;
        case "commit":
          // An empty commit is still passed on (OpenAI refuses it, as it
          // would without the relay), but it takes no place in the billing
          // queue: queued as 0 bytes, it would be matched to the next real
          // transcript and bill that one nothing. Nor does it keep the
          // session alive.
          if (pending > 0) {
            committed.push(pending);
            startIdle();
          }
          pending = 0;
          send(upstream, action.message);
          return;
        case "clear":
          pending = 0;
          send(upstream, action.message);
          return;
        case "configure":
          send(upstream, action.message);
          configured = true;
          return;
      }
    });

    const fromUpstream = (raw: string) => {
      queue = queue.then(async () => {
        if (stopped) return;
        const action = fromServer(raw);
        if (action.kind === "drop") return;
        if (action.kind === "forward") {
          send(client, action.message);
          return;
        }
        if (action.kind === "failed") {
          upstreamFailed = true;
          log(`upstream error for ${member.uid}: ${action.detail}`, "ERROR");
          send(client, errorEvent("upstream", UPSTREAM_MESSAGE));
          return;
        }

        // The first transcript is the dictation. Another (OpenAI sending a
        // second, say) finds the session closing and is neither passed on nor
        // charged: it would be a charge for nothing.
        if (delivered) return;
        delivered = true;
        stopIdle();
        stopLimit();
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
    const closeAll = () => {
      stopIdle();
      stopLimit();
      closeBoth();
    };
    /**
     * The app closed the connection. If audio it streamed to OpenAI was never
     * billed and no transcript was delivered, that audio was paid for by
     * TeleKey and not by the person: a dictation dropped by the network, an
     * app that quit, a cancel. One WARN line says how much, so it can be
     * counted; whether it is also charged is `CHARGE_ABANDONED_AUDIO`.
     *
     * Not abandoned: a session the relay ended itself (idle, over budget, too
     * long), one that OpenAI failed or closed first, and one whose transcript
     * was delivered (it closes itself after the charge).
     *
     * Nothing arriving later is charged either way: a transcript that turns up
     * after the app has gone was never delivered.
     */
    const abandon = () => {
      const alreadyOver = stopped || delivered || upstreamFailed || upstreamEnded;
      stopped = true;
      const unbilled = total - billed;
      if (alreadyOver || unbilled <= 0) return;
      const seconds = unbilled / BYTES_PER_SECOND;
      log(`session for ${member.uid} abandoned after ${seconds.toFixed(1)} s of audio`, "WARN");
      if (!chargeAbandoned) return;
      billed += unbilled;
      // Seconds only: no transcript was delivered, so no dictation happened.
      const units: Units = { ...noUnits(), dictations: 0, liveTranscribeSeconds: unitSeconds(seconds) };
      void (async () => {
        try {
          await deps.charge(member, units, { liveSeconds: seconds });
          log(`charged ${member.uid} for ${seconds.toFixed(3)} s of abandoned audio`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(
            `CHARGE FAILED for ${member.uid}, ${seconds.toFixed(3)} s of abandoned audio: ${message}`,
            "ERROR",
          );
        }
      })();
    };
    client.on("close", () => {
      abandon();
      closeAll();
    });
    upstream.on("close", () => {
      upstreamEnded = true;
      closeAll();
    });
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
