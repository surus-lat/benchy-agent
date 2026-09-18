import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { schema } from "@benchy/db";
import {
  findPendingInvite,
  markInviteAccepted,
  requireInviteForSignup,
  requireInviteOrExistingUser,
} from "./invite-gate";

const db = drizzle(env.DB, { schema });

if (!env.BETTER_AUTH_SECRET) {
  throw new Error(
    "BETTER_AUTH_SECRET is not set. Set it locally in apps/api/.dev.vars, " +
      "or in production via `wrangler secret put BETTER_AUTH_SECRET`.",
  );
}

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",
    schema,
  }),
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  // Single-origin deployment: Pages serves the SPA and proxies /api/* to this
  // Worker, so the browser only ever sees one origin (BETTER_AUTH_URL) and
  // no cross-subdomain cookie configuration is needed -- or safe -- to set.
  // Both public hostnames are trusted so a callbackURL from either is
  // accepted during the pages.dev -> getbenchy.lat cutover. The magic link
  // itself is always built from BETTER_AUTH_URL, the canonical origin.
  trustedOrigins: [
    env.BETTER_AUTH_URL,
    "https://getbenchy.lat",
    "https://benchy-agent.pages.dev",
    "http://localhost:21707",
  ],
  user: {
    additionalFields: {
      orgId: {
        type: "string",
        required: false,
        input: false,
      },
    },
  },
  socialProviders: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const invite = await requireInviteForSignup(db, user.email);
          return {
            data: {
              ...user,
              email: user.email.toLowerCase(),
              orgId: invite.orgId,
            },
          };
        },
        after: async (createdUser) => {
          const invite = await findPendingInvite(db, createdUser.email);
          if (invite) await markInviteAccepted(db, invite.id);
        },
      },
    },
  },
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => {
        await requireInviteOrExistingUser(db, email);
        await env.EMAIL.send({
          to: email,
          from: { email: env.EMAIL_FROM, name: "Benchy" },
          subject: "Sign in to Benchy",
          text: `Click to sign in: ${url}\n\nThis link expires in 5 minutes.`,
          html: `<p>Click to sign in: <a href="${url}">${url}</a></p><p>This link expires in 5 minutes.</p>`,
        });
      },
    }),
  ],
});
