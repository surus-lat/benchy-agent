import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { authClient, signIn, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Sign-in, simplest first:
//   1. Passkey (Touch ID / Face ID / Windows Hello) for anyone who saved one.
//   2. Email → 6-digit code. The email also carries a link that only fills in
//      this form; nothing is redeemed until the researcher presses "Ingresar",
//      so university mail scanners that open links cannot burn the code.
//   3. Google / Microsoft, when their OAuth credentials are configured.
// After a code sign-in, researchers without a passkey are offered one.

function appCallbackURL() {
  return `${window.location.origin}/app`;
}

function loginErrorURL() {
  return `${window.location.origin}/login`;
}

/** An error better-auth handed back on a redirect (OAuth or legacy magic link). */
function readCallbackError(): string | null {
  const params = new URLSearchParams(window.location.search);
  if (!params.get("error")) return null;
  return params.get("error_description") || "No pudimos iniciar tu sesión. Probá de nuevo.";
}

const supportsPasskeys = () => typeof window !== "undefined" && "PublicKeyCredential" in window;

type Step = "email" | "code" | "offer-passkey";

export default function Login() {
  const params = new URLSearchParams(window.location.search);
  const [email, setEmail] = useState(() => params.get("email") ?? "");
  const [code, setCode] = useState(() => params.get("code") ?? "");
  // Arriving from the email's link: go straight to the code step, pre-filled.
  const [step, setStep] = useState<Step>(() => (params.get("email") && params.get("code") ? "code" : "email"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(readCallbackError);
  const signedInHere = useRef(false);

  // A visitor who already holds a session goes straight to the app — except
  // right after signing in here, when we may first offer a passkey.
  const { data: session } = useSession();
  const [, navigate] = useLocation();
  useEffect(() => {
    if (session && !signedInHere.current) navigate("/app", { replace: true });
  }, [session, navigate]);

  // Offer saved passkeys in the email field's autofill (conditional UI).
  useEffect(() => {
    if (!supportsPasskeys()) return;
    void authClient.signIn.passkey({ autoFill: true }).then(({ error }) => {
      if (!error) window.location.href = "/app";
    });
  }, []);

  const [providers, setProviders] = useState({ google: false, microsoft: false });
  useEffect(() => {
    fetch("/api/auth-providers")
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => p && setProviders(p))
      .catch(() => {});
  }, []);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
    setBusy(false);
    if (error) return setError(error.message ?? "No pudimos enviar el código. Probá de nuevo.");
    setCode("");
    setStep("code");
  }

  async function verifyCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    signedInHere.current = true;
    const { error } = await signIn.emailOtp({ email, otp: code.trim() });
    if (error) {
      signedInHere.current = false;
      setBusy(false);
      return setError(
        /invite/i.test(error.message ?? "")
          ? "Este mail no tiene acceso todavía. Pedilo desde getbenchy.lat."
          : "El código no es válido o venció. Pedí uno nuevo.",
      );
    }
    // Offer a passkey only to researchers who do not have one yet.
    if (supportsPasskeys()) {
      const { data } = await authClient.passkey.listUserPasskeys();
      if (!data || data.length === 0) {
        setBusy(false);
        return setStep("offer-passkey");
      }
    }
    window.location.href = "/app";
  }

  async function addPasskey() {
    setBusy(true);
    setError(null);
    const { error } = await authClient.passkey.addPasskey({ name: "benchy agent" });
    if (error) {
      console.warn("passkey registration failed", error);
      setBusy(false);
      return setError("No se pudo guardar. Podés hacerlo la próxima vez.");
    }
    window.location.href = "/app";
  }

  async function passkeySignIn() {
    setError(null);
    const { error } = await authClient.signIn.passkey();
    if (error) return setError("No encontramos una passkey para este dispositivo. Ingresá con tu mail.");
    window.location.href = "/app";
  }

  if (step === "offer-passkey") {
    return (
      <div className="mx-auto mt-24 max-w-sm text-center">
        <h1 className="text-lg font-semibold">¿Querés entrar más rápido la próxima vez?</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Guardá una passkey en este dispositivo y vas a ingresar con tu huella, tu cara o el PIN de tu
          computadora, sin esperar mails.
        </p>
        <div className="mt-5 space-y-2">
          <Button className="w-full" onClick={() => void addPasskey()} disabled={busy}>
            Guardar passkey
          </Button>
          <Button variant="ghost" className="w-full" onClick={() => (window.location.href = "/app")}>
            Ahora no
          </Button>
        </div>
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mx-auto mt-24 max-w-sm">
      <h1 className="text-lg font-semibold">Ingresar a benchy agent</h1>

      {step === "email" ? (
        <form onSubmit={sendCode} className="mt-4 space-y-3">
          <Input
            type="email"
            required
            autoComplete="username webauthn"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="vos@universidad.edu"
          />
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? "Enviando…" : "Enviarme un código"}
          </Button>
        </form>
      ) : (
        <form onSubmit={verifyCode} className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Si <strong>{email}</strong> tiene acceso, te mandamos un código de 6 dígitos.
          </p>
          <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            placeholder="123456"
            className="text-center text-lg tracking-[0.4em]"
          />
          <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
            {busy ? "Ingresando…" : "Ingresar"}
          </Button>
          <button
            type="button"
            className="w-full text-center text-sm text-muted-foreground underline"
            onClick={() => {
              setStep("email");
              setError(null);
            }}
          >
            Usar otro mail o pedir un código nuevo
          </button>
        </form>
      )}

      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

      <div className="mt-4 space-y-2 border-t pt-4">
        {supportsPasskeys() && (
          <Button variant="outline" className="w-full" onClick={() => void passkeySignIn()}>
            Ingresar con passkey
          </Button>
        )}
        {providers.google && (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void signIn.social({ provider: "google", callbackURL: appCallbackURL(), errorCallbackURL: loginErrorURL() })}
          >
            Ingresar con Google
          </Button>
        )}
        {providers.microsoft && (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void signIn.social({ provider: "microsoft", callbackURL: appCallbackURL(), errorCallbackURL: loginErrorURL() })}
          >
            Ingresar con Microsoft
          </Button>
        )}
      </div>
    </div>
  );
}
