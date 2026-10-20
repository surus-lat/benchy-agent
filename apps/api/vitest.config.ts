import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig, defineProject, mergeConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrationsPath = path.join(
    import.meta.dirname,
    "..",
    "..",
    "packages",
    "db",
    "migrations",
  );
  const migrations = await readD1Migrations(migrationsPath);

  return mergeConfig(
    {},
    defineProject({
      plugins: [
        cloudflareTest({
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            // The suite brings its own values, so it runs the same in CI and
            // on a fresh clone as with a local apps/api/.dev.vars. None is a
            // real credential: the Turnstile one is Cloudflare's always-pass
            // test secret.
            bindings: {
              TEST_MIGRATIONS: migrations,
              BETTER_AUTH_SECRET: "test-only-secret-never-used-outside-vitest",
              BETTER_AUTH_URL: "http://localhost:21707",
              TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
            },
          },
        }),
      ],
      test: {
        // Scoped to test/ so this Miniflare-backed suite never picks up
        // scripts/**/*.test.ts (those run under plain Node via
        // `test:scripts` / vitest.node.config.ts — node:crypto usage there
        // isn't meant for the Workers pool).
        include: ["test/**/*.test.ts"],
        setupFiles: ["./test/apply-migrations.ts"],
      },
    }),
  );
});
