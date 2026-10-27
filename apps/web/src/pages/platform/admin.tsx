import { useCallback, useEffect, useState } from "react";
import { adminApi, type AdminOrg, type AdminUser, type AdminInvite, type AdminAccessRequest, type AdminActivity } from "./admin-data";
import { usePlatform } from "./store";

// Admin panel: org management, users, invites, access requests, and global
// activity. Only visible to users in the surus org. Internal tooling — kept
// minimal and functional.

type Tab = "orgs" | "users" | "invites" | "requests" | "activity";

const ADMIN_ORG_ID = "org_4eb2a44fdc5ef17b";

export default function AdminPage() {
  const { me } = usePlatform();
  const [tab, setTab] = useState<Tab>("orgs");

  if (!me?.org || me.org.id !== ADMIN_ORG_ID) {
    return (
      <section className="bp-page">
        <h1 className="bp-h1">Administración</h1>
        <p className="muted" style={{ marginTop: 12 }}>No tenés acceso a esta sección.</p>
      </section>
    );
  }

  return (
    <section className="bp-page" style={{ maxWidth: 1100 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 className="bp-h1">Administración</h1>
      </div>

      <div className="seg" style={{ marginBottom: 20, width: "fit-content" }}>
        {([["orgs", "Organizaciones"], ["users", "Usuarios"], ["invites", "Invitaciones"], ["requests", "Solicitudes"], ["activity", "Actividad"]] as [Tab, string][]).map(
          ([key, label]) => (
            <button key={key} className={tab === key ? "on" : ""} onClick={() => setTab(key)}>
              {label}
            </button>
          ),
        )}
      </div>

      {tab === "orgs" && <OrgsTab />}
      {tab === "users" && <UsersTab />}
      {tab === "invites" && <InvitesTab />}
      {tab === "requests" && <RequestsTab />}
      {tab === "activity" && <ActivityTab />}
    </section>
  );
}

// ---- Organizaciones ---------------------------------------------------------

function OrgsTab() {
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [creating, setCreating] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const { orgs } = await adminApi.orgs();
      setOrgs(orgs);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createOrg() {
    if (!newName.trim() || !newSlug.trim()) return;
    setCreating(true);
    try {
      await adminApi.createOrg(newName.trim(), newSlug.trim().toLowerCase());
      setNewName("");
      setNewSlug("");
      setShowForm(false);
      await load();
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <p className="muted">Cargando…</p>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button className="btn" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancelar" : "+ Nueva organización"}
        </button>
      </div>

      {showForm && (
        <div className="card-plain" style={{ padding: 20, marginBottom: 16, display: "flex", gap: 12, alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>Nombre</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Universidad Nacional de…"
              style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 14 }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={{ display: "block", fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>Slug</label>
            <input
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              placeholder="unrn"
              style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 14 }}
            />
          </div>
          <button className="btn" disabled={creating || !newName.trim() || !newSlug.trim()} onClick={createOrg}>
            {creating ? "Creando…" : "Crear"}
          </button>
        </div>
      )}

      <div className="card-plain">
        <div className="bp-row head" style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr) minmax(0,1.5fr) 5rem 6rem" }}>
          <span>Nombre</span>
          <span>Slug</span>
          <span>Dominios</span>
          <span>Usuarios</span>
          <span>Agente</span>
        </div>
        {orgs.map((o) => (
          <OrgRow key={o.id} org={o} expanded={expandedId === o.id} onToggle={() => setExpandedId(expandedId === o.id ? null : o.id)} onReload={load} />
        ))}
        {orgs.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>No hay organizaciones todavía.</div>}
      </div>
    </div>
  );
}

function OrgRow({ org, expanded, onToggle, onReload }: { org: AdminOrg; expanded: boolean; onToggle: () => void; onReload: () => Promise<void> }) {
  const [editName, setEditName] = useState(org.name);
  const [editSlug, setEditSlug] = useState(org.slug);
  const [newDomain, setNewDomain] = useState("");
  const [endpointUrl, setEndpointUrl] = useState(org.endpoint?.baseUrl ?? "");
  const [endpointKey, setEndpointKey] = useState(org.endpoint?.apiKeyRef ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (expanded) {
      setEditName(org.name);
      setEditSlug(org.slug);
      setEndpointUrl(org.endpoint?.baseUrl ?? "");
      setEndpointKey(org.endpoint?.apiKeyRef ?? "");
    }
  }, [expanded, org]);

  async function saveOrg() {
    setSaving(true);
    try {
      await adminApi.updateOrg(org.id, { name: editName.trim(), slug: editSlug.trim() });
      await onReload();
    } finally {
      setSaving(false);
    }
  }

  async function addDomain() {
    if (!newDomain.trim()) return;
    await adminApi.addDomain(org.id, newDomain.trim());
    setNewDomain("");
    await onReload();
  }

  async function removeDomain(domain: string) {
    await adminApi.removeDomain(org.id, domain);
    await onReload();
  }

  async function saveEndpoint() {
    if (!endpointUrl.trim() || !endpointKey.trim()) return;
    setSaving(true);
    try {
      await adminApi.setEndpoint(org.id, endpointUrl.trim(), endpointKey.trim());
      await onReload();
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button className="bp-row bp-row-click" style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,1fr) minmax(0,1.5fr) 5rem 6rem" }} onClick={onToggle}>
        <span className="t">{org.name}</span>
        <span className="mono" style={{ fontSize: 13 }}>{org.slug}</span>
        <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {org.domains.map((d) => (
            <span key={d} className="bp-chip" style={{ fontSize: 11 }}>{d}</span>
          ))}
          {org.domains.length === 0 && <span className="muted" style={{ fontSize: 12 }}>—</span>}
        </span>
        <span className="num">{org.userCount}</span>
        <span>
          <span className={`dot ${org.endpoint ? "valid" : ""}`} style={{ display: "inline-block", marginRight: 4 }} />
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{org.endpoint ? "✓" : "—"}</span>
        </span>
      </button>
      {expanded && (
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--line-soft)", background: "var(--surface)", display: "grid", gap: 16 }}>
          {/* Edit org */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>Nombre</label>
              <input value={editName} onChange={(e) => setEditName(e.target.value)} style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 6, fontSize: 13 }} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>Slug</label>
              <input value={editSlug} onChange={(e) => setEditSlug(e.target.value)} style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 6, fontSize: 13 }} />
            </div>
            <button className="btn-ghost" disabled={saving} onClick={saveOrg}>Guardar</button>
          </div>

          {/* Domains */}
          <div>
            <p className="eyebrow" style={{ marginBottom: 8 }}>Dominios</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
              {org.domains.map((d) => (
                <span key={d} className="bp-chip" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  {d}
                  <button onClick={() => removeDomain(d)} style={{ border: 0, background: "none", cursor: "pointer", color: "var(--fail)", fontSize: 14, lineHeight: 1, padding: 0 }}>×</button>
                </span>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                placeholder="unrn.edu.ar"
                style={{ flex: 1, padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 6, fontSize: 13, maxWidth: 260 }}
                onKeyDown={(e) => e.key === "Enter" && addDomain()}
              />
              <button className="btn-ghost" onClick={addDomain} disabled={!newDomain.trim()}>Agregar</button>
            </div>
          </div>

          {/* Agent endpoint */}
          <div>
            <p className="eyebrow" style={{ marginBottom: 8 }}>Agente</p>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
              <div style={{ flex: 2 }}>
                <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>URL base</label>
                <input value={endpointUrl} onChange={(e) => setEndpointUrl(e.target.value)} placeholder="https://agent.example.com" style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 6, fontSize: 13 }} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: "block", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>Secret ref</label>
                <input value={endpointKey} onChange={(e) => setEndpointKey(e.target.value)} placeholder="AGENT_KEY_ORG" style={{ width: "100%", padding: "6px 10px", border: "1px solid var(--line)", borderRadius: 6, fontSize: 13 }} />
              </div>
              <button className="btn-ghost" disabled={saving || !endpointUrl.trim() || !endpointKey.trim()} onClick={saveEndpoint}>Guardar</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ---- Usuarios ---------------------------------------------------------------

function UsersTab() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void adminApi.users().then(({ users }) => { setUsers(users); setLoading(false); });
  }, []);

  if (loading) return <p className="muted">Cargando…</p>;

  return (
    <div className="card-plain">
      <div className="bp-row head" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,2fr) minmax(0,1.5fr) 7rem" }}>
        <span>Nombre</span>
        <span>Email</span>
        <span>Organización</span>
        <span>Creado</span>
      </div>
      {users.map((u) => (
        <div key={u.id} className="bp-row" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,2fr) minmax(0,1.5fr) 7rem" }}>
          <span className="t">{u.name || "—"}</span>
          <span style={{ fontSize: 13 }}>{u.email}</span>
          <span style={{ fontSize: 13, color: "var(--body)" }}>{u.orgName ?? <span className="muted">Sin org</span>}</span>
          <span className="when">{new Date(u.createdAt).toLocaleDateString("es-AR")}</span>
        </div>
      ))}
      {users.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>No hay usuarios.</div>}
    </div>
  );
}

// ---- Invitaciones -----------------------------------------------------------

function InvitesTab() {
  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newOrgId, setNewOrgId] = useState("");
  const [newDays, setNewDays] = useState(7);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ invites }, { orgs }] = await Promise.all([adminApi.invites(), adminApi.orgs()]);
      setInvites(invites);
      setOrgs(orgs);
      if (orgs.length > 0 && !newOrgId) setNewOrgId(orgs[0].id);
    } finally {
      setLoading(false);
    }
  }, [newOrgId]);

  useEffect(() => { void load(); }, [load]);

  async function createInvite() {
    if (!newEmail.trim() || !newOrgId) return;
    setCreating(true);
    try {
      await adminApi.createInvite(newOrgId, newEmail.trim(), newDays);
      setNewEmail("");
      setShowForm(false);
      await load();
    } finally {
      setCreating(false);
    }
  }

  if (loading) return <p className="muted">Cargando…</p>;

  const statusBadge = (s: string) => {
    const cls = s === "pending" ? "draft" : s === "accepted" ? "valid" : "error";
    const label = s === "pending" ? "Pendiente" : s === "accepted" ? "Aceptada" : "Expirada";
    return <span className={`badge ${cls}`}>{label}</span>;
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <button className="btn" onClick={() => setShowForm(!showForm)}>
          {showForm ? "Cancelar" : "+ Nueva invitación"}
        </button>
      </div>

      {showForm && (
        <div className="card-plain" style={{ padding: 20, marginBottom: 16, display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ flex: 2, minWidth: 200 }}>
            <label style={{ display: "block", fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>Email</label>
            <input
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="investigador@universidad.edu"
              style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 14 }}
            />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={{ display: "block", fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>Organización</label>
            <select
              value={newOrgId}
              onChange={(e) => setNewOrgId(e.target.value)}
              style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 14, background: "#fff" }}
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
          <div style={{ width: 100 }}>
            <label style={{ display: "block", fontSize: 13, color: "var(--muted)", marginBottom: 4 }}>Días</label>
            <input
              type="number"
              value={newDays}
              onChange={(e) => setNewDays(Math.max(1, Math.min(90, Number(e.target.value) || 7)))}
              min={1}
              max={90}
              style={{ width: "100%", padding: "8px 12px", border: "1px solid var(--line)", borderRadius: 8, fontSize: 14 }}
            />
          </div>
          <button className="btn" disabled={creating || !newEmail.trim() || !newOrgId} onClick={createInvite}>
            {creating ? "Creando…" : "Crear"}
          </button>
        </div>
      )}

      <div className="card-plain">
        <div className="bp-row head" style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,1.5fr) 6rem 7rem 7rem" }}>
          <span>Email</span>
          <span>Organización</span>
          <span>Estado</span>
          <span>Creada</span>
          <span>Expira</span>
        </div>
        {invites.map((i) => (
          <div key={i.id} className="bp-row" style={{ gridTemplateColumns: "minmax(0,2fr) minmax(0,1.5fr) 6rem 7rem 7rem" }}>
            <span style={{ fontSize: 13 }}>{i.email}</span>
            <span style={{ fontSize: 13, color: "var(--body)" }}>{i.orgName ?? "—"}</span>
            {statusBadge(i.status)}
            <span className="when">{new Date(i.createdAt).toLocaleDateString("es-AR")}</span>
            <span className="when">{new Date(i.expiresAt).toLocaleDateString("es-AR")}</span>
          </div>
        ))}
        {invites.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>No hay invitaciones.</div>}
      </div>
    </div>
  );
}

// ---- Solicitudes de acceso ---------------------------------------------------

function RequestsTab() {
  const [requests, setRequests] = useState<AdminAccessRequest[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { accessRequests } = await adminApi.accessRequests();
      setRequests(accessRequests);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function updateStatus(id: string, status: "invited" | "declined") {
    await adminApi.updateAccessRequest(id, status);
    await load();
  }

  if (loading) return <p className="muted">Cargando…</p>;

  const statusBadge = (s: string) => {
    const cls = s === "pending" ? "draft" : s === "invited" ? "valid" : "error";
    const label = s === "pending" ? "Pendiente" : s === "invited" ? "Invitado" : "Rechazado";
    return <span className={`badge ${cls}`}>{label}</span>;
  };

  return (
    <div className="card-plain">
      <div className="bp-row head" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,2fr) minmax(0,1fr) 6rem minmax(0,10rem)" }}>
        <span>Organización</span>
        <span>Email</span>
        <span>Nombre</span>
        <span>Estado</span>
        <span>Acciones</span>
      </div>
      {requests.map((r) => (
        <div key={r.id} className="bp-row" style={{ gridTemplateColumns: "minmax(0,1.5fr) minmax(0,2fr) minmax(0,1fr) 6rem minmax(0,10rem)" }}>
          <span className="t">{r.orgName}</span>
          <span style={{ fontSize: 13 }}>{r.email}</span>
          <span style={{ fontSize: 13 }}>{r.name ?? "—"}</span>
          {statusBadge(r.status)}
          <span style={{ display: "flex", gap: 6 }}>
            {r.status === "pending" && (
              <>
                <button className="btn-ghost" style={{ fontSize: 12, padding: "4px 10px" }} onClick={() => updateStatus(r.id, "invited")}>
                  Invitar
                </button>
                <button className="btn-ghost" style={{ fontSize: 12, padding: "4px 10px", color: "var(--fail)" }} onClick={() => updateStatus(r.id, "declined")}>
                  Rechazar
                </button>
              </>
            )}
          </span>
        </div>
      ))}
      {requests.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>No hay solicitudes.</div>}
    </div>
  );
}

// ---- Actividad ---------------------------------------------------------------

function ActivityTab() {
  const [activity, setActivity] = useState<AdminActivity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void adminApi.activity(200).then(({ activity }) => { setActivity(activity); setLoading(false); });
  }, []);

  if (loading) return <p className="muted">Cargando…</p>;

  return (
    <div className="card-plain">
      <div className="bp-row head" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,2fr) minmax(0,1.5fr) minmax(0,1fr) 7rem" }}>
        <span>Quién</span>
        <span>Detalle</span>
        <span>Benchmark</span>
        <span>Organización</span>
        <span>Cuándo</span>
      </div>
      {activity.map((a) => (
        <div key={a.id} className="bp-row" style={{ gridTemplateColumns: "minmax(0,1fr) minmax(0,2fr) minmax(0,1.5fr) minmax(0,1fr) 7rem" }}>
          <span className="t" style={{ fontSize: 13 }}>{a.who}</span>
          <span style={{ fontSize: 13, color: "var(--body)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.detail}</span>
          <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{a.bench ?? "—"}</span>
          <span style={{ fontSize: 12, color: "var(--body)" }}>{a.orgName ?? "—"}</span>
          <span className="when">{new Date(a.createdAt).toLocaleDateString("es-AR")}</span>
        </div>
      ))}
      {activity.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "var(--muted)" }}>No hay actividad registrada.</div>}
    </div>
  );
}
