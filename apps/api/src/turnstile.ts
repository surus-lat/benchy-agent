const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileVerdict = {
  ok: boolean;
  errorCodes: string[];
  hostname?: string;
};

export async function verifyTurnstile(opts: {
  secret: string;
  token: string;
  remoteip?: string;
}): Promise<TurnstileVerdict> {
  const body = new URLSearchParams({ secret: opts.secret, response: opts.token });
  if (opts.remoteip) body.set("remoteip", opts.remoteip);

  const res = await fetch(SITEVERIFY, { method: "POST", body });
  if (!res.ok) return { ok: false, errorCodes: [`http-${res.status}`] };

  const data = (await res.json()) as {
    success?: boolean;
    "error-codes"?: string[];
    hostname?: string;
  };
  return {
    ok: data.success === true,
    errorCodes: data["error-codes"] ?? [],
    hostname: data.hostname,
  };
}
