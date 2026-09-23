import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { signIn, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const NO_INVITE_FALLBACK =
  "This email has no pending invite. Ask your university admin for one.";

/**
 * Where better-auth should send the browser when a flow finishes.
 *
 * Absolute on purpose: better-auth resolves a relative `callbackURL` against
 * its own `baseURL`, and while that is the same origin as this page today, an
 * absolute URL keeps that true if the topology ever changes again. Success
 * lands in the app; failures land back on the sign-in page, whose error slot
 * reads the query parameters below.
 */
function appCallbackURL() {
  return `${window.location.origin}/app`;
}

function loginErrorURL() {
  return `${window.location.origin}/login`;
}

/**
 * The failure better-auth handed back on the redirect, if any.
 *
 * Both failing paths that can reach this page — the OAuth callback
 * (`/callback/:id`) and magic-link verification — redirect to the error
 * callback with the same two query parameters in better-auth 1.7.5: `error`
 * carries a machine-readable code, and `error_description` the human message
 * from the API error, which for an uninvited signup is the invite gate's own
 * text. `error_description` is only set when the failing endpoint had a
 * message to pass on, hence the fallback.
 */
function readCallbackError(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.get("error")) return null;
  return params.get("error_description") || NO_INVITE_FALLBACK;
}

export default function Login() {
  // Read straight from the URL rather than a router hook: this component is
  // rendered both by the /login and /accept-invite routes and by AuthGate
  // (for a signed-out visitor under /app), so the query string is the one
  // source that is always present.
  const [callbackError] = useState(readCallbackError);
  const [email, setEmail] = useState(
    () => new URLSearchParams(window.location.search).get("email") ?? "",
  );
  const [status, setStatus] = useState<
    "idle" | "sending" | "sent" | "error"
  >(callbackError ? "error" : "idle");
  const [errorMessage, setErrorMessage] = useState(callbackError ?? "");

  // "Log in" is the only way into the app from the landing, so a visitor who
  // already holds a session is sent straight through instead of being shown
  // a form they don't need. AuthGate only renders this page when there is no
  // session, so this cannot loop.
  const { data: session } = useSession();
  const [, navigate] = useLocation();
  useEffect(() => {
    if (session) navigate("/app", { replace: true });
  }, [session, navigate]);

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMessage("");
    const { error } = await signIn.magicLink({
      email,
      callbackURL: appCallbackURL(),
      // A rejected click comes back to the sign-in page, which reads the
      // `error` / `error_description` query parameters above.
      errorCallbackURL: loginErrorURL(),
    });
    if (error) {
      setStatus("error");
      setErrorMessage(error.message ?? NO_INVITE_FALLBACK);
      return;
    }
    setStatus("sent");
  }

  async function handleGoogle() {
    // Unlike the magic-link call there is no response to inspect — the browser
    // leaves for Google and comes back through the API's OAuth callback — so
    // the rejection can only surface as a query parameter on the redirect.
    // `errorCallbackURL` is what decides where that redirect goes; without it
    // an uninvited person dead-ends on the API origin and sees nothing.
    await signIn.social({
      provider: "google",
      callbackURL: appCallbackURL(),
      errorCallbackURL: loginErrorURL(),
    });
  }

  if (status === "sent") {
    return (
      <div className="mx-auto mt-24 max-w-sm text-center">
        <h1 className="text-lg font-semibold">Check your email</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We sent a sign-in link to {email}.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-sm">
      <h1 className="text-lg font-semibold">Sign in to Benchy</h1>
      <form onSubmit={handleMagicLink} className="mt-4 space-y-3">
        <Input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@university.edu"
        />
        <Button type="submit" disabled={status === "sending"} className="w-full">
          {status === "sending" ? "Sending..." : "Send magic link"}
        </Button>
      </form>
      {status === "error" && (
        <p className="mt-3 text-sm text-destructive">{errorMessage}</p>
      )}
      {/* Google stays off until a real OAuth client exists; the API still has
          the provider configured with placeholder credentials, so showing
          the button would only produce an error. Flip VITE_ENABLE_GOOGLE
          to "true" once GOOGLE_CLIENT_ID/SECRET are real. */}
      {import.meta.env.VITE_ENABLE_GOOGLE === "true" && (
        <div className="mt-4 border-t pt-4">
          <Button variant="outline" className="w-full" onClick={handleGoogle}>
            Sign in with Google
          </Button>
        </div>
      )}
    </div>
  );
}
