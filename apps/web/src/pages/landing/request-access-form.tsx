import { useState } from "react";
import { Link } from "wouter";
import { useTurnstile } from "./use-turnstile";
import type { AccessCopy } from "./copy";

// The landing's conversion block. Posts to the Worker's public intake
// (POST /api/access-requests), which is Turnstile-gated and never creates
// orgs or invites; the owner reviews requests with `pnpm access-requests`.

type Status = "idle" | "sending" | "sent" | "error";

export function RequestAccessForm({ t }: { t: AccessCopy }) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const turnstile = useTurnstile();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setStatus("sending");
    setError("");

    const token = await turnstile.awaitToken();
    if (!token) {
      fail(t.errors.verification);
      return;
    }

    let res: Response;
    try {
      res = await fetch("/api/access-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: form.get("email"),
          orgName: form.get("orgName"),
          turnstileToken: token,
        }),
      });
    } catch {
      fail(t.errors.generic);
      return;
    }

    if (res.ok) {
      setStatus("sent");
      return;
    }
    if (res.status === 403) fail(t.errors.verification);
    else if (res.status === 400) fail(t.errors.invalid);
    else fail(t.errors.generic);
  }

  function fail(message: string) {
    setStatus("error");
    setError(message);
    turnstile.reset();
  }

  if (status === "sent") {
    return (
      <div className="lp-form-success" role="status">
        <p className="lp-form-success-title">{t.success.title}</p>
        <p className="lp-form-success-body">{t.success.body}</p>
      </div>
    );
  }

  return (
    <form className="lp-form" onSubmit={submit} noValidate={false}>
      <label htmlFor="access-email" className="lp-sr">
        {t.emailLabel}
      </label>
      <input
        id="access-email"
        name="email"
        type="email"
        required
        maxLength={320}
        autoComplete="email"
        placeholder={t.emailLabel}
        className="lp-input"
      />
      <label htmlFor="access-org" className="lp-sr">
        {t.orgLabel}
      </label>
      <input
        id="access-org"
        name="orgName"
        type="text"
        required
        maxLength={200}
        autoComplete="organization"
        placeholder={t.orgLabel}
        className="lp-input"
      />
      <div ref={turnstile.slot} className="lp-turnstile" />
      <button type="submit" className="lp-btn lp-btn-form" disabled={status === "sending"}>
        {status === "sending" ? t.sending : t.cta}
      </button>
      {status === "error" && (
        <p className="lp-form-error" role="alert">
          {error}
        </p>
      )}
      <p className="lp-form-hint">
        {t.invitedPrompt} <Link href="/login">{t.login}</Link>
      </p>
    </form>
  );
}
