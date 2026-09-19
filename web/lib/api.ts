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
    email?: string | null;
    balanceCents?: number;
    packs?: CreditPack[];
  };
  if (!response.ok) {
    throw new Error(body.error ?? "Could not load the account");
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
    url?: string;
  };
  if (!response.ok || !body.url) {
    throw new Error(body.error ?? "Could not start checkout");
  }
  return body.url;
}

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
