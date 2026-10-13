export interface CreditPack {
  id: string;
  name: string;
  cents: number;
}

export interface HostedAccount {
  email: string | null;
  balanceCents: number;
  packs: CreditPack[];
}

/**
 * An error from the hosted API, keeping its status and machine-readable code
 * so a page can react to a particular refusal ("not_a_tester" on staging).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Staging refused this email because it is not on the testers list. */
export function isNotATester(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === "not_a_tester";
}

function apiBase(): string {
  const base = process.env.NEXT_PUBLIC_TELEKEY_API_BASE;
  if (!base) {
    throw new Error("Hosted API is not configured");
  }
  return base.replace(/\/$/, "");
}

export async function fetchAccount(idToken: string): Promise<HostedAccount> {
  const response = await fetch(`${apiBase()}/me`, {
    headers: { authorization: `Bearer ${idToken}` },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    email?: string | null;
    balanceCents?: number;
    packs?: CreditPack[];
  };
  if (!response.ok) {
    throw new ApiError(body.error ?? "Could not load the account", response.status, body.code ?? null);
  }
  return {
    email: body.email ?? null,
    balanceCents: body.balanceCents ?? 0,
    packs: body.packs ?? [],
  };
}

export async function startCheckout(
  idToken: string,
  packId: string,
): Promise<string> {
  const response = await fetch(`${apiBase()}/createCheckoutSession`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${idToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ packId }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    url?: string;
  };
  if (!response.ok || !body.url) {
    throw new ApiError(body.error ?? "Could not start checkout", response.status, body.code ?? null);
  }
  return body.url;
}

/**
 * How a balance is written. `balanceCents` is whole cents and can be below
 * zero: Instant is charged after the text is delivered, and a charge dearer
 * than the estimate is taken in full. `$${(cents / 100).toFixed(2)}` wrote
 * that as "$-0.03"; this writes "-$0.03" and `owedNote` says it is owed.
 *
 * The desktop app has its own copy (src/settings/money.ts). The test beside it
 * (src/settings/money.test.ts) holds the two to the same answers.
 */
function splitCents(cents: number): { text: string; owing: boolean } {
  const text = (Math.abs(cents) / 100).toFixed(2);
  // A fraction of a cent below zero rounds to "0.00"; "-$0.00" would claim a
  // debt that is not there, so only a visible amount counts as owed.
  return { text, owing: cents < 0 && text !== "0.00" };
}

/** "$5.00", and "-$0.03" for a balance below zero. */
export function money(cents: number): string {
  const { text, owing } = splitCents(cents);
  return owing ? `-$${text}` : `$${text}`;
}

/** What to tell someone whose balance is below zero, or null when it is not. */
export function owedNote(cents: number): string | null {
  const { text, owing } = splitCents(cents);
  return owing ? `You owe $${text} — your next purchase covers it first.` : null;
}
