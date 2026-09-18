import { useState } from "react";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function Login() {
  // Read straight from the URL rather than a router hook: this component is
  // rendered by AuthGate outside any <Route>, so there are no route params
  // to read, and the invite link can land on any path.
  const [email, setEmail] = useState(
    () => new URLSearchParams(window.location.search).get("email") ?? "",
  );
  const [status, setStatus] = useState<
    "idle" | "sending" | "sent" | "error"
  >("idle");
  const [errorMessage, setErrorMessage] = useState("");

  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setStatus("sending");
    setErrorMessage("");
    const { error } = await signIn.magicLink({
      email,
      callbackURL: "/",
    });
    if (error) {
      setStatus("error");
      setErrorMessage(
        error.message ??
          "This email has no pending invite. Ask your university admin for one.",
      );
      return;
    }
    setStatus("sent");
  }

  async function handleGoogle() {
    await signIn.social({ provider: "google", callbackURL: "/" });
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
      <div className="mt-4 border-t pt-4">
        <Button variant="outline" className="w-full" onClick={handleGoogle}>
          Sign in with Google
        </Button>
      </div>
    </div>
  );
}
