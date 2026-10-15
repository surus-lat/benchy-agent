import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import type { ReactNode } from "react";
import { authClient, signIn, useSession } from "@/lib/auth-client";
import "./login.css";

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

/** The page around every sign-in screen: the lockup, and a way back to request access. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="au">
      <header className="au-top">
        <a href="/" className="au-lockup" aria-label="benchy agent">
          <img src="/brand/pip-mark.svg" alt="" />
          <span className="name">benchy</span>
          <span className="suffix">agent</span>
        </a>
        <a href="/#access" className="au-top-link">
          Solicitar acceso
        </a>
      </header>
      <main className="au-main">{children}</main>
    </div>
  );
}

function Pip() {
  return (
    <span className="au-pip" aria-hidden="true">
      [<span className="d" />]
    </span>
  );
}

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
      <AuthShell>
        <div className="au-card center">
          <Pip />
          <div>
            <h1 className="au-h1">¿Querés entrar más rápido la próxima vez?</h1>
            <p className="au-lead">
              Guardá una passkey en este dispositivo y vas a ingresar con tu huella, tu cara o el PIN de tu computadora, sin esperar mails.
            </p>
          </div>
          <div className="au-alt" style={{ width: "100%" }}>
            <button className="au-btn" onClick={() => void addPasskey()} disabled={busy}>
              Guardar passkey
            </button>
            <button className="au-btn quiet" onClick={() => (window.location.href = "/app")}>
              Ahora no
            </button>
          </div>
          {error && (
            <p className="au-error" role="alert" style={{ width: "100%" }}>
              {error}
            </p>
          )}
        </div>
      </AuthShell>
    );
  }

  const invited = window.location.pathname === "/accept-invite";
  return (
    <AuthShell>
      <div className="au-card">
        {step === "email" ? (
          <>
            <div>
              <p className="au-eyebrow">{invited ? "Tu acceso" : "Ingresar"}</p>
              <h1 className="au-h1">{invited ? "Te damos la bienvenida a benchy agent" : "Entrá a benchy agent"}</h1>
              <p className="au-lead">Con tu mail institucional: te mandamos un código de 6 dígitos para entrar, sin contraseña.</p>
            </div>
            <form onSubmit={sendCode} className="au-form">
              <label className="au-label" htmlFor="au-email">
                Mail
              </label>
              <input
                id="au-email"
                className="au-input"
                type="email"
                required
                autoComplete="username webauthn"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vos@universidad.edu"
              />
              <button type="submit" disabled={busy} className="au-btn">
                {busy ? "Enviando…" : "Enviarme un código"}
              </button>
            </form>
          </>
        ) : (
          <>
            <div>
              <p className="au-eyebrow">Código</p>
              <h1 className="au-h1">Revisá tu mail</h1>
              <p className="au-lead">
                Si <strong>{email}</strong> tiene acceso, te mandamos un código de 6 dígitos. El mail también trae un link que lo completa acá.
              </p>
            </div>
            <form onSubmit={verifyCode} className="au-form">
              <label className="au-label" htmlFor="au-code">
                Código
              </label>
              <input
                id="au-code"
                className="au-input code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="000000"
              />
              <button type="submit" disabled={busy || code.length !== 6} className="au-btn">
                {busy ? "Ingresando…" : "Ingresar"}
              </button>
            </form>
            <button
              type="button"
              className="au-link"
              style={{ alignSelf: "center" }}
              onClick={() => {
                setStep("email");
                setError(null);
              }}
            >
              Usar otro mail o pedir un código nuevo
            </button>
          </>
        )}

        {error && (
          <p className="au-error" role="alert">
            {error}
          </p>
        )}

        {(supportsPasskeys() || providers.google || providers.microsoft) && (
          <>
            <div className="au-or">o</div>
            <div className="au-alt">
              {supportsPasskeys() && (
                <button className="au-btn ghost" onClick={() => void passkeySignIn()}>
                  Ingresar con passkey
                </button>
              )}
              {providers.google && (
                <button
                  className="au-btn ghost"
                  onClick={() => void signIn.social({ provider: "google", callbackURL: appCallbackURL(), errorCallbackURL: loginErrorURL() })}
                >
                  Ingresar con Google
                </button>
              )}
              {providers.microsoft && (
                <button
                  className="au-btn ghost"
                  onClick={() => void signIn.social({ provider: "microsoft", callbackURL: appCallbackURL(), errorCallbackURL: loginErrorURL() })}
                >
                  Ingresar con Microsoft
                </button>
              )}
            </div>
          </>
        )}

        <p className="au-foot">
          ¿Todavía no tenés acceso? <a href="/#access">Solicitalo</a>
        </p>
      </div>
    </AuthShell>
  );
}
