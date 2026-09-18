import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  // Unset in both dev and production: the API is served from the page's own
  // origin (Vite proxy in dev, Pages Function proxy in production), and the
  // client defaults to window.location.origin when baseURL is omitted.
  baseURL: import.meta.env.VITE_API_URL || undefined,
  plugins: [magicLinkClient()],
});

export const { useSession, signIn, signOut } = authClient;
