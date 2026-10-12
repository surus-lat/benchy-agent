import { betterAuth } from "better-auth";
import { emailOTP, magicLink } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { env, waitUntil } from "cloudflare:workers";
import { schema } from "@benchy/db";
import { db } from "./db";
import { socialProviders } from "./social-providers";
import {
  findPendingInvite,
  markInviteAccepted,
  requireInviteForSignup,
  requireInviteOrExistingUser,
} from "./invite-gate";

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
  // better-auth sends some mail (the sign-in code) after responding, so a
  // request cannot reveal which addresses are invited. On Workers that work
  // must be handed to waitUntil, or it is cut off when the response is sent.
  advanced: {
    backgroundTasks: { handler: (promise: Promise<unknown>) => waitUntil(promise) },
  },
  // Researchers should rarely have to sign in: 30-day sessions, refreshed daily.
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
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
  // Google and Microsoft, each only when its OAuth credentials are set.
  socialProviders: socialProviders(env as unknown as Record<string, unknown>),
  // A researcher invited by email can later use Google or Microsoft with the
  // same address: linking requires a verified email on both sides (Microsoft's
  // is made verifiable in social-providers.ts).
  account: {
    accountLinking: { enabled: true },
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
    // Passkeys: after the first email sign-in, a researcher can register Touch
    // ID / Face ID / Windows Hello and sign in with one tap from then on. No
    // third party involved. Passkey sign-in never creates users.
    passkey({
      rpID: new URL(env.BETTER_AUTH_URL).hostname,
      rpName: "benchy agent",
      origin: [env.BETTER_AUTH_URL, "http://localhost:21707"],
    }),
    // A 6-digit code by email — the primary sign-in. University mail filters
    // (Safe Links and similar) open links before the person does, which burns a
    // one-time magic link; a code survives that. The email also carries a link,
    // but it only pre-fills the login form: nothing is redeemed until the
    // researcher presses the button, so a scanner opening it changes nothing.
    emailOTP({
      otpLength: 6,
      expiresIn: 10 * 60,
      async sendVerificationOTP({ email, otp, type }) {
        if (type !== "sign-in") return; // the only OTP flow this app uses
        await requireInviteOrExistingUser(db, email);
        const link = `${env.BETTER_AUTH_URL}/login?${new URLSearchParams({ email, code: otp })}`;
        await env.EMAIL.send({
          to: email,
          from: { email: env.EMAIL_FROM, name: "benchy agent" },
          subject: `${otp} es tu código para ingresar a benchy`,
          text: `Tu código para ingresar a benchy agent: ${otp}\n\nO abrí este link y tocá "Ingresar": ${link}\n\nVence en 10 minutos. Si no lo pediste, ignorá este mail.`,
          html: `<p>Tu código para ingresar a benchy agent:</p><p style="font-size:28px;font-weight:600;letter-spacing:6px;font-family:monospace">${otp}</p><p>O <a href="${link}">abrí este link</a> y tocá "Ingresar".</p><p style="color:#756e66">Vence en 10 minutos. Si no lo pediste, ignorá este mail.</p>`,
        });
      },
    }),
    // Kept for links already sent; the login page now uses the code above.
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
