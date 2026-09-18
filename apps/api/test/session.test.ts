import { exports } from "cloudflare:workers";
import { it } from "vitest";

it("returns an empty session when signed out", async ({ expect }) => {
  const response = await exports.default.fetch(
    "https://example.com/api/auth/get-session",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toBeNull();
});
