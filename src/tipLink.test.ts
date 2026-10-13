import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The tip link lives twice: the app opens TIP_URL (src-tauri/src/tips.rs) and
// the website links TIP (web/data/site.ts). A Stripe link changed in one place
// only would send people to two different pages.
describe("the tip link", () => {
  const root = join(import.meta.dir, "..");
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  test("is the same in the app and on the website", () => {
    const app = read("src-tauri/src/tips.rs").match(/pub const TIP_URL: &str = "([^"]+)"/)?.[1];
    const site = read("web/data/site.ts").match(/(?:export )?const TIP\b[^=]*=\s*"([^"]+)"/)?.[1];
    expect(app).toBeTruthy();
    expect(site).toBeTruthy();
    expect(app).toBe(site);
  });
});
