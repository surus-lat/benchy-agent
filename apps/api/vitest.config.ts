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
        setupFiles: ["./test/apply-migrations.ts"],
      },
    }),
  );
});
