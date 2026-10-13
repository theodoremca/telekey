/**
 * The credit packs, read from Firestore at most once in a while.
 *
 * Packs change when someone runs `scripts/seed-packs.cjs`, a few times a
 * year, yet every `/me` (the website and the app poll it) and every checkout
 * used to read the whole collection. They are now kept in memory for
 * `ttlMs` per server instance.
 *
 * NOTE for whoever changes the packs: a running instance does not know until
 * its copy expires, so a changed or added pack can take up to five minutes
 * (`PACKS_TTL_MS`) to show in `/me` on every instance, or happens at once on a
 * redeploy. Asking for a pack that is not in the copy (checkout) reloads once
 * before saying it does not exist, so a new pack can be bought sooner than it
 * is listed. A price that was *changed* in place shows up only when the copy
 * expires; an instance keeps checking out the old Stripe price until then.
 *
 * Concurrent callers share one read. A failed read is not kept: the next call
 * tries again, but a list that was loaded once is never thrown away for want
 * of a reload, since the old packs are still right far more often than not
 * (the website would otherwise lose its pack buttons during a Firestore blip):
 * it is served stale, with a warning, and tried again after `retryMs`. Only
 * a cold start with Firestore down has nothing to serve and fails. An empty
 * list is kept only briefly, so setting the packs up for the first time is not
 * hidden for minutes. Pure (the loader and clock are passed in):
 * test/packs.test.mjs.
 */

export type Pack = {
  id: string;
  name: string;
  cents: number;
  stripePriceId: string;
};

export const PACKS_TTL_MS = 5 * 60_000;
export const EMPTY_PACKS_TTL_MS = 30_000;
/** After a failed reload, how long the last good list is served before trying again. */
export const FAILED_RELOAD_RETRY_MS = 30_000;
/**
 * The least time between reloads asked for by a pack that is not in the list.
 * Without it anyone signed in could make every checkout with a made-up id read
 * the collection.
 */
export const MISS_RELOAD_MIN_MS = 10_000;

export function createPackCache(
  load: () => Promise<Pack[]>,
  now: () => number = () => Date.now(),
  ttlMs: number = PACKS_TTL_MS,
  emptyTtlMs: number = EMPTY_PACKS_TTL_MS,
  retryMs: number = FAILED_RELOAD_RETRY_MS,
  missReloadMinMs: number = MISS_RELOAD_MIN_MS,
) {
  let kept: { packs: Pack[]; until: number } | undefined;
  let loading: Promise<Pack[]> | undefined;
  /** When a read was last begun, whether or not it worked; never before the first. */
  let lastTriedAt = Number.NEGATIVE_INFINITY;

  /** Read the packs now (sharing a read already under way), and keep the result. */
  function reload(): Promise<Pack[]> {
    if (!loading) {
      lastTriedAt = now();
      loading = load()
        .then(
          (packs) => {
            kept = { packs, until: now() + (packs.length > 0 ? ttlMs : emptyTtlMs) };
            return packs;
          },
          (err: unknown) => {
            if (!kept) throw err;
            console.warn(
              `packs: reload failed, serving the last list: ${err instanceof Error ? err.message : String(err)}`,
            );
            kept = { packs: kept.packs, until: now() + retryMs };
            return kept.packs;
          },
        )
        .finally(() => {
          loading = undefined;
        });
    }
    return loading;
  }

  async function list(): Promise<Pack[]> {
    if (kept && kept.until > now()) return kept.packs;
    return reload();
  }

  return {
    list,
    async find(id: string): Promise<Pack | undefined> {
      const named = (packs: Pack[]) => packs.find((pack) => pack.id === id);
      const listed = await list();
      const hit = named(listed);
      if (hit) return hit;
      // Not there: the packs may have changed since the copy was made. Look
      // once more, unless a read has only just been made.
      // A read under way is as new as it gets: wait for it, which also keeps
      // callers that missed together from answering before it lands.
      if (loading) return named(await loading);
      // Or one finished since this call took its copy.
      if (kept && kept.packs !== listed) return named(kept.packs);
      if (now() - lastTriedAt < missReloadMinMs) return undefined;
      return named(await reload());
    },
  };
}
