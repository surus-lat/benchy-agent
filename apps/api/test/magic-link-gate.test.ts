import { env } from "cloudflare:workers";
import { beforeEach, it } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { schema } from "@benchy/db";
import { auth } from "../src/auth";

const db = drizzle(env.DB, { schema });

beforeEach(async () => {
  await db.delete(schema.invites);
  await db.delete(schema.user);
  await db.delete(schema.orgs);
});

it("refuses to send a magic link to an uninvited address", async ({
  expect,
}) => {
  await expect(
    auth.api.signInMagicLink({
      body: { email: "stranger@example.com" },
      // The endpoint is declared `requireHeaders: true`; without this the
      // call rejects with "Headers is required" before ever reaching our
      // gate, which would make this test pass for the wrong reason.
      headers: new Headers(),
    }),
  ).rejects.toThrow(/no pending invite/i);
});
