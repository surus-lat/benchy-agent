import type { ReactNode } from "react";
import { signOut, useSession } from "@/lib/auth-client";
import Login, { AuthShell } from "@/pages/login";

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
      <AuthShell>
        <div className="au-card">
          <div>
            <p className="au-eyebrow">Casi listo</p>
            <h1 className="au-h1">Tu cuenta todavía no tiene acceso</h1>
            <p className="au-lead">
              Entraste como <strong>{session.user.email}</strong>, pero ese mail todavía no está asociado a una organización. Pedí acceso para tu
              universidad o grupo, o entrá con el mail con el que te dieron acceso.
            </p>
          </div>
          <div className="au-alt">
            <a href="/#access" className="au-btn">
              Solicitar acceso para tu institución
            </a>
            <button className="au-btn ghost" onClick={() => void signOut().then(() => (window.location.href = "/login"))}>
              Entrar con otro mail
            </button>
          </div>
        </div>
      </AuthShell>
    );
  }

  return <>{children}</>;
}
