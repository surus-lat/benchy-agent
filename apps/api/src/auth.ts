import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { schema } from "@benchy/db";

const db = drizzle(env.DB, { schema });

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema,
  }),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [
    "https://app.benchy.example",
    "https://api.benchy.example",
    "http://localhost:21707",
  ],
  advanced: {
    crossSubDomainCookies: {
      enabled: true,
      domain: "benchy.example",
    },
  },
  user: {
    additionalFields: {
      orgId: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },
});
