// Google and Microsoft sign-in. Each provider is enabled only when its real
// OAuth credentials are configured as Worker secrets, and the login page asks
// GET /api/auth-providers which ones to show. Signup through either still
// passes the invite gate (databaseHooks.user.create in auth.ts).

type Secrets = Record<string, unknown>;

function credential(env: Secrets, name: string): string | null {
  const v = env[name];
  return typeof v === "string" && v.length > 0 && v !== "placeholder" ? v : null;
}

/**
 * The email to trust from a Microsoft ID token, or null.
 *
 * With the multi-tenant ("common") endpoint, Microsoft's `email` claim is
 * whatever the account's tenant typed in — unverified. Trusting it lets
 * anyone with their own Entra tenant claim a researcher's invite or account
 * ("nOAuth"). Two values are safe:
 *   - `email`, only when `xms_edov` says Microsoft verified its domain;
 *   - `preferred_username`, the sign-in name (UPN), which a tenant can only
 *     issue on a domain it has proven it owns. For university accounts it is
 *     almost always the institutional address.
 */
export function microsoftVerifiedEmail(profile: Record<string, unknown>): string | null {
  const isEmail = (v: unknown): v is string => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
  if (profile.xms_edov === true && isEmail(profile.email)) return profile.email.toLowerCase();
  if (isEmail(profile.preferred_username)) return profile.preferred_username.toLowerCase();
  return null;
}

export function socialProviders(env: Secrets) {
  const providers: Record<string, unknown> = {};

  const googleId = credential(env, "GOOGLE_CLIENT_ID");
  const googleSecret = credential(env, "GOOGLE_CLIENT_SECRET");
  if (googleId && googleSecret) {
    providers.google = { clientId: googleId, clientSecret: googleSecret, prompt: "select_account" };
  }

  const msId = credential(env, "MICROSOFT_CLIENT_ID");
  const msSecret = credential(env, "MICROSOFT_CLIENT_SECRET");
  if (msId && msSecret) {
    providers.microsoft = {
      clientId: msId,
      clientSecret: msSecret,
      tenantId: "common", // any university's Microsoft 365, plus personal accounts
      prompt: "select_account",
      disableProfilePhoto: true,
      mapProfileToUser(profile: Record<string, unknown>) {
        const email = microsoftVerifiedEmail(profile);
        if (email) return { email, emailVerified: true };
        // No verifiable address. Replacing the unverified claim (not merely
        // flagging it) matters: the invite gate matches on email, so leaving
        // it in place would let a spoofed claim redeem a real invite. This
        // address can match no invite and no account.
        return { email: `unverified-${String(profile.oid ?? "unknown")}@invalid.invalid`, emailVerified: false };
      },
    };
  }

  return providers;
}

/** Which buttons the login page should show. */
export function enabledProviders(env: Secrets) {
  const p = socialProviders(env);
  return { google: "google" in p, microsoft: "microsoft" in p };
}
