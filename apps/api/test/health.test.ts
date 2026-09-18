import { exports } from "cloudflare:workers";
import { it } from "vitest";

it("returns ok from /health", async ({ expect }) => {
  const response = await exports.default.fetch(
    "https://example.com/health",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});
