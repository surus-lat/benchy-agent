import { createAuthClient } from "better-auth/client";
import { magicLinkClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_API_URL,
  plugins: [magicLinkClient()],
});

export const { useSession, signIn, signOut } = authClient;
