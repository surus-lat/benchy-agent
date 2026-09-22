import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useSession } from "@/lib/auth-client";

// Placeholder public landing. The visual design is being produced separately
// and will replace this markup; what must survive that swap is the Request
// Access form's wiring below (Turnstile token + POST /api/access-requests).

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
  }
}

const TURNSTILE_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function useTurnstile(onToken: (t: string) => void) {
  const slot = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
    if (!siteKey || !slot.current) return;

    const render = () => {
      if (!window.turnstile || !slot.current || widgetId.current) return;
      widgetId.current = window.turnstile.render(slot.current, {
        sitekey: siteKey,
        action: "request-access",
        callback: (token: string) => onToken(token),
        "expired-callback": () => onToken(""),
        "error-callback": () => onToken(""),
      });
    };

    // Remove the widget on unmount, otherwise a re-mount (React StrictMode in
    // dev, or the landing being swapped out) leaves an orphan behind.
    const removeWidget = () => {
      if (widgetId.current) {
        window.turnstile?.remove(widgetId.current);
        widgetId.current = null;
      }
    };

    if (window.turnstile) {
      render();
      return removeWidget;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SRC}"]`);
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.src = TURNSTILE_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", render);
    return () => {
      script.removeEventListener("load", render);
      removeWidget();
    };
    // onToken is stable for the life of the form; re-rendering the widget on
    // every keystroke would reset the challenge.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reset = () => window.turnstile?.reset(widgetId.current ?? undefined);
  return { slot, reset };
}

type Status = "idle" | "sending" | "sent" | "error";

export default function Landing() {
  const { data: session } = useSession();
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState("");
  const turnstile = useTurnstile(setToken);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!token) {
      setError("Please complete the verification first.");
      setStatus("error");
      return;
    }
    const form = new FormData(e.currentTarget);
    setStatus("sending");
    setError("");
    const res = await fetch("/api/access-requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orgName: form.get("orgName"),
        name: form.get("name"),
        email: form.get("email"),
        message: form.get("message"),
        turnstileToken: token,
      }),
    });
    if (res.ok) {
      setStatus("sent");
      return;
    }
    setStatus("error");
    setToken("");
    turnstile.reset();
    if (res.status === 403) setError("Verification failed. Please try again.");
    else if (res.status === 400) setError("Please check the form and try again.");
    else setError("Something went wrong. Please try again in a moment.");
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-12">
      <header className="flex items-center justify-between">
        <span className="text-lg font-semibold">Benchy</span>
        {session ? (
          <Link href="/app" className="text-sm underline">
            Open app →
          </Link>
        ) : (
          <Link href="/login" className="text-sm underline">
            Sign in
          </Link>
        )}
      </header>

      <section className="mt-16">
        <h1 className="text-3xl font-semibold tracking-tight">
          Turn domain expertise into AI benchmarks
        </h1>
        <p className="mt-3 text-muted-foreground">
          Benchy helps research groups define, generate, and score benchmarks for
          their own field. Access is by invitation, one organization at a time.
        </p>
      </section>

      <section className="mt-12 rounded-lg border p-6">
        <h2 className="text-xl font-semibold">Request access</h2>
        {status === "sent" ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Thanks — we’ve got your request. We onboard organizations progressively
            and will email you when yours is ready.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="orgName">Organization</Label>
              <Input id="orgName" name="orgName" required maxLength={200} placeholder="Stanford University" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="name">Your name</Label>
                <Input id="name" name="name" maxLength={200} placeholder="Ana Pérez" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="email">Work email</Label>
                <Input id="email" name="email" type="email" required maxLength={320} placeholder="you@university.edu" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="message">What would you benchmark?</Label>
              <Textarea id="message" name="message" maxLength={2000} rows={4} />
            </div>
            <div ref={turnstile.slot} />
            {status === "error" && (
              <p className="text-sm text-destructive">{error}</p>
            )}
            <Button type="submit" disabled={status === "sending"} className="w-full">
              {status === "sending" ? "Sending…" : "Request access"}
            </Button>
          </form>
        )}
      </section>
    </div>
  );
}
