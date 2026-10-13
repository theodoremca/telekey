// Just enough of Firestore for the ledger and the API's routes, in memory:
// documents by path, snapshots with `get`, queries ordered by a field, and
// transactions whose writes land when the callback returns. Every document
// it hands back is counted in `reads`, which is what Firestore bills for.
//
// Not a test file (no `.test.`), so `node --test test/*.test.mjs` skips it.

/**
 * @param {Record<string, Record<string, unknown>>} seed documents by path,
 *   e.g. "staging-users/u1".
 */
export function fakeDb(seed = {}) {
  const store = new Map(Object.entries(seed));
  const reads = { docs: 0, paths: [] };
  let autoId = 0;

  const count = (path) => {
    reads.docs += 1;
    reads.paths.push(path);
  };
  const snapshot = (path) => ({
    id: path.split("/").at(-1),
    exists: store.has(path),
    get: (field) => store.get(path)?.[field],
    data: () => ({ ...store.get(path) }),
  });
  const write = (path, data, options) =>
    store.set(path, options?.merge ? { ...store.get(path), ...data } : data);
  const ref = (path) => ({
    path,
    get: async () => {
      count(path);
      return snapshot(path);
    },
    set: async (data, options) => write(path, data, options),
    collection: (name) => ({ doc: (id = `auto${++autoId}`) => ref(`${path}/${name}/${id}`) }),
  });

  return {
    store,
    reads,
    resetReads() {
      reads.docs = 0;
      reads.paths = [];
    },
    usage: () =>
      [...store.entries()].filter(([path]) => path.includes("/usage/")).map(([, data]) => data),
    collection: (name) => ({
      doc: (id) => ref(`${name}/${id}`),
      orderBy: (field) => ({
        get: async () => {
          const docs = [...store.keys()]
            .filter((path) => path.startsWith(`${name}/`) && path.split("/").length === 2)
            .sort((a, b) => Number(store.get(a)[field]) - Number(store.get(b)[field]))
            .map((path) => {
              count(path);
              return snapshot(path);
            });
          return { docs };
        },
      }),
    }),
    async runTransaction(callback) {
      const writes = [];
      const tx = {
        get: async (target) => {
          count(target.path);
          return snapshot(target.path);
        },
        update(target, data) {
          if (!store.has(target.path)) throw new Error(`NOT_FOUND ${target.path}`);
          writes.push(() => write(target.path, data, { merge: true }));
        },
        set(target, data, options) {
          writes.push(() => write(target.path, data, options));
        },
      };
      const result = await callback(tx);
      for (const apply of writes) apply();
      return result;
    },
  };
}
