import { useEffect, useState } from "react";
import { authClient, signOut } from "@/lib/auth-client";
import { usePlatform } from "./store";

// Account: name (stored on the user; the agent greets researchers by it),
// sign-in methods, interface language, sign out.

export default function Account() {
  const { me } = usePlatform();
  const [name, setName] = useState("");
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [passkeys, setPasskeys] = useState<number | null>(null);
  const [googleLinked, setGoogleLinked] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [passkeyMsg, setPasskeyMsg] = useState<string | null>(null);
  const [lang, setLang] = useState<"es" | "en">(() => {
    try {
      return (localStorage.getItem("benchy-lang") as "es" | "en") ?? "es";
    } catch {
      return "es";
    }
  });

  useEffect(() => {
    if (me) setName(me.user.name);
  }, [me]);
  useEffect(() => {
    void authClient.passkey.listUserPasskeys().then(({ data }) => setPasskeys(data?.length ?? 0));
    void authClient.listAccounts().then(({ data }) => setGoogleLinked(!!data?.some((a: { providerId: string }) => a.providerId === "google")));
    void fetch("/api/auth-providers")
      .then((r) => r.json())
      .then((p: { google: boolean }) => setGoogleEnabled(p.google))
      .catch(() => {});
  }, []);

  async function saveName() {
    setSaved("saving");
    const { error } = await authClient.updateUser({ name: name.trim() });
    setSaved(error ? "error" : "saved");
  }

  async function addPasskey() {
    setPasskeyMsg(null);
    const { error } = await authClient.passkey.addPasskey({ name: "benchy agent" });
    if (error) return setPasskeyMsg("No se pudo guardar la passkey en este dispositivo.");
    const { data } = await authClient.passkey.listUserPasskeys();
    setPasskeys(data?.length ?? 0);
    setPasskeyMsg("Passkey guardada.");
  }

  return (
    <section className="bp-page" style={{ maxWidth: 720, display: "flex", flexDirection: "column", gap: 16 }}>
      <h1 className="bp-h1" style={{ fontSize: "clamp(24px,3vw,30px)" }}>Cuenta</h1>

      <div className="card-plain" style={{ padding: "20px 22px", display: "grid", gap: 14 }}>
        <label className="bp-field">
          Nombre
          <span style={{ display: "flex", gap: 8 }}>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved("idle");
              }}
              placeholder="Cómo querés que te llame el agente"
              spellCheck={false}
              style={{ flex: 1 }}
            />
            <button className="btn-ghost" onClick={() => void saveName()} disabled={saved === "saving" || name.trim() === (me?.user.name ?? "")}>
              {saved === "saving" ? "Guardando…" : saved === "saved" ? "Guardado" : "Guardar"}
            </button>
          </span>
          {saved === "error" && <span style={{ color: "var(--fail)" }}>No se pudo guardar.</span>}
        </label>
        <div className="bp-field">
          Correo
          <span className="v">{me?.user.email}</span>
        </div>
        <div className="bp-field">
          Organización
          <span className="v">{me?.org?.name ?? "—"}</span>
        </div>
      </div>

      <div className="card-plain">
        <p className="eyebrow" style={{ margin: 0, padding: "14px 22px", borderBottom: "1px solid var(--line-soft)" }}>Formas de ingresar</p>
        <div className="bp-method">
          <span style={{ fontSize: 15 }}>Código por correo</span>
          <span style={{ fontSize: 13, color: "var(--ok-ink)" }}>Activo</span>
        </div>
        <div className="bp-method">
          <span style={{ fontSize: 15 }}>
            Passkey
            {passkeys ? <span className="muted" style={{ fontSize: 13 }}> · {passkeys} guardada{passkeys === 1 ? "" : "s"}</span> : null}
          </span>
          <button className="btn-ghost" onClick={() => void addPasskey()}>
            {passkeys ? "Agregar otra" : "Agregar passkey"}
          </button>
        </div>
        {passkeyMsg && <p className="body" style={{ margin: 0, padding: "0 22px 12px", fontSize: 13 }}>{passkeyMsg}</p>}
        <div className="bp-method">
          <span style={{ fontSize: 15 }}>Google</span>
          <span style={{ fontSize: 13 }} className={googleLinked ? "" : "muted"}>
            {googleLinked ? <span style={{ color: "var(--ok-ink)" }}>Vinculada</span> : googleEnabled ? "Disponible al ingresar" : "No habilitado"}
          </span>
        </div>
      </div>

      <div className="card-plain" style={{ padding: "14px 22px", display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <span style={{ fontSize: 15 }}>Idioma de la interfaz</span>
        <div className="seg" role="group">
          <button className={lang === "es" ? "on" : ""} onClick={() => setLang("es")}>
            Español
          </button>
          <button
            disabled
            title="Próximamente"
            className={lang === "en" ? "on" : ""}
            onClick={() => {
              setLang("en");
              try {
                localStorage.setItem("benchy-lang", "en");
              } catch {
                // ignore
              }
            }}
          >
            English · pronto
          </button>
        </div>
      </div>

      <button className="pill" style={{ alignSelf: "flex-start", padding: "8px 18px" }} onClick={() => void signOut().then(() => (location.href = "/"))}>
        Salir
      </button>
    </section>
  );
}
