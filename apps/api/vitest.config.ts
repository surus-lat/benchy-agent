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
            bindings: { TEST_MIGRATIONS: migrations },
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
