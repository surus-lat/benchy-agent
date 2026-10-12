import { createAuthClient } from "better-auth/react";
import { emailOTPClient, magicLinkClient } from "better-auth/client/plugins";
import { passkeyClient } from "@better-auth/passkey/client";

export const authClient = createAuthClient({
  // Unset in both dev and production: the API is served from the page's own
  // origin (Vite proxy in dev, Pages Function proxy in production), and the
  // client defaults to window.location.origin when baseURL is omitted.
  baseURL: import.meta.env.VITE_API_URL || undefined,
  plugins: [emailOTPClient(), passkeyClient(), magicLinkClient()],
});

export const { useSession, signIn, signOut } = authClient;
