import type { ReactNode } from "react";
import { useSession } from "@/lib/auth-client";
import Login from "@/pages/login";

export function AuthGate({ children }: { children: ReactNode }) {
  const { data: session, isPending } = useSession();

  if (isPending) {
    return null;
  }

  if (!session) {
    return <Login />;
  }

  // orgId is a better-auth additionalField; the client's inferred user type
  // doesn't know about it without wiring the server type across packages.
  const { orgId } = session.user as { orgId?: string | null };

  if (!orgId) {
    return (
      <div className="mx-auto mt-24 max-w-sm text-center">
        <h1 className="text-lg font-semibold">Almost there</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account isn't linked to an organization yet. Ask your
          university admin to send you an invite for this email address.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}
