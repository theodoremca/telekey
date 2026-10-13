/**
 * Who is calling. Shared by the Functions API and the Instant relay, which
 * both receive a Firebase ID token as `Authorization: Bearer …`.
 */

import { getAuth, type DecodedIdToken } from "firebase-admin/auth";

import { NOT_A_TESTER, testerProblem } from "./testers";

/** What a request needs to know about who is calling. */
export type Identity = Pick<DecodedIdToken, "uid" | "email" | "email_verified">;

export async function requireUser(authorization: string | undefined): Promise<DecodedIdToken> {
  const match = /^Bearer (.+)$/i.exec(authorization ?? "");
  if (!match) {
    throw Object.assign(new Error("Sign in to use TeleKey's key."), {
      status: 401,
    });
  }
  try {
    return await getAuth().verifyIdToken(match[1]);
  } catch {
    throw Object.assign(new Error("Session expired — sign in again."), {
      status: 401,
    });
  }
}

/**
 * A signed-in user who may use this stage. On staging that means a listed
 * tester, checked before anything is created for them: a stranger gets no
 * user document and no welcome credit. `testers` is undefined in production.
 */
export async function requireMember(
  testers: Set<string> | undefined,
  authorization: string | undefined,
  /** How the token is checked; only the tests pass their own. */
  verify: (authorization: string | undefined) => Promise<Identity> = requireUser,
): Promise<Identity> {
  const user = await verify(authorization);
  if (testers) {
    const problem = testerProblem(testers, user.email, user.email_verified);
    if (problem) {
      console.warn(`staging refused ${user.email ?? user.uid}: not a listed tester`);
      throw Object.assign(new Error(problem), { status: 403, code: NOT_A_TESTER });
    }
  }
  return user;
}
