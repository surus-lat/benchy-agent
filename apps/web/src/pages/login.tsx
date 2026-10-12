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

  // Which social buttons to show: the API reports providers that have real
  // OAuth credentials configured.
  const [providers, setProviders] = useState<{ google: boolean; microsoft: boolean }>({
    google: false,
    microsoft: false,
  });
  useEffect(() => {
    fetch("/api/auth-providers")
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => p && setProviders(p))
      .catch(() => {});
  }, []);

  async function handleSocial(provider: "google" | "microsoft") {
    await signIn.social({
      provider,
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
      {(providers.google || providers.microsoft) && (
        <div className="mt-4 space-y-2 border-t pt-4">
          {providers.google && (
            <Button variant="outline" className="w-full" onClick={() => void handleSocial("google")}>
              Continue with Google
            </Button>
          )}
          {providers.microsoft && (
            <Button variant="outline" className="w-full" onClick={() => void handleSocial("microsoft")}>
              Continue with Microsoft
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
