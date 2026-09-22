import { useEffect, useRef } from "react";

// Cloudflare Turnstile for the Request Access form. The widget runs in
// interaction-only mode: it stays invisible and verifies in the background,
// only showing a challenge when it has to, so the form keeps its two-inputs-
// and-a-button shape. The token is verified server-side by the Worker.

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

/** How long a submit waits for the background challenge before giving up. */
const TOKEN_WAIT_MS = 8000;

export function useTurnstile() {
  const slot = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const token = useRef("");
  const waiters = useRef<Array<(t: string) => void>>([]);
  const enabled = useRef(false);

  useEffect(() => {
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
    if (!siteKey || !slot.current) return;
    enabled.current = true;

    const deliver = (t: string) => {
      token.current = t;
      if (t) waiters.current.splice(0).forEach((resolve) => resolve(t));
    };

    const render = () => {
      if (!window.turnstile || !slot.current || widgetId.current) return;
      widgetId.current = window.turnstile.render(slot.current, {
        sitekey: siteKey,
        action: "request-access",
        appearance: "interaction-only",
        size: "flexible",
        theme: "light",
        callback: deliver,
        "expired-callback": () => deliver(""),
        "error-callback": () => deliver(""),
      });
    };

    // Remove the widget on unmount, otherwise a re-mount (React StrictMode in
    // dev, or navigating away and back) leaves an orphan behind.
    const removeWidget = () => {
      if (widgetId.current) {
        window.turnstile?.remove(widgetId.current);
        widgetId.current = null;
      }
      token.current = "";
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
  }, []);

  /**
   * The current token, waiting briefly for the background challenge if it
   * has not finished yet. Resolves to "" when verification is unavailable or
   * times out; the caller shows the verification error in that case.
   */
  const awaitToken = () =>
    new Promise<string>((resolve) => {
      if (!enabled.current) return resolve("");
      if (token.current) return resolve(token.current);
      const timer = setTimeout(() => {
        waiters.current = waiters.current.filter((w) => w !== done);
        resolve("");
      }, TOKEN_WAIT_MS);
      const done = (t: string) => {
        clearTimeout(timer);
        resolve(t);
      };
      waiters.current.push(done);
    });

  // Tokens are single-use: after a rejected submit the widget must issue a
  // fresh one before the form can be sent again.
  const reset = () => {
    token.current = "";
    window.turnstile?.reset(widgetId.current ?? undefined);
  };

  return { slot, awaitToken, reset };
}
