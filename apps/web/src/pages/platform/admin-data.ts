// Data layer for the admin panel (/app/admin). All calls go through the
// Worker's /api/admin/* routes, gated to the surus org.

import { ApiError } from "../app/api";

// ---- Types ------------------------------------------------------------------

export type AdminOrg = {
  id: string;
  name: string;
  slug: string;
  brandColor: string | null;
  brandColorSecondary: string | null;
  brandTagline: string | null;
  brandLogoUrl: string | null;
  createdAt: string;
  domains: string[];
  endpoint: { baseUrl: string; apiKeyRef: string } | null;
  userCount: number;
};

export type AdminUser = {
  id: string;
  name: string;
  email: string;
  orgId: string | null;
  orgName: string | null;
  createdAt: string;
};

export type AdminInvite = {
  id: string;
  orgId: string;
  orgName: string | null;
  email: string;
  status: "pending" | "accepted" | "expired";
  createdAt: string;
  expiresAt: string;
};

export type AdminAccessRequest = {
  id: string;
  orgName: string;
  email: string;
  name: string | null;
  message: string | null;
  status: "pending" | "invited" | "declined";
  createdAt: string;
};

export type AdminActivity = {
  id: string;
  orgId: string;
  orgName: string | null;
  who: string;
  userId: string | null;
  bench: string | null;
  kind: string;
  detail: string;
  createdAt: string;
};

// ---- API call helper --------------------------------------------------------

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, credentials: "same-origin" });
  } catch {
    throw new ApiError("NETWORK", 0);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `HTTP_${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ---- API --------------------------------------------------------------------

export const adminApi = {
  // Organizations
  orgs: () => call<{ orgs: AdminOrg[] }>("/api/admin/orgs"),
  createOrg: (name: string, slug: string) =>
    call<{ id: string; name: string; slug: string }>("/api/admin/orgs", json({ name, slug })),
  updateOrg: (id: string, data: Record<string, unknown>) =>
    call<{ ok: boolean }>(`/api/admin/orgs/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    }),

  // Domains
  orgDomains: (orgId: string) =>
    call<{ domains: { domain: string; createdAt: string }[] }>(`/api/admin/orgs/${orgId}/domains`),
  addDomain: (orgId: string, domain: string) =>
    call<{ domain: string }>(`/api/admin/orgs/${orgId}/domains`, json({ domain })),
  removeDomain: (orgId: string, domain: string) =>
    call<{ ok: boolean }>(`/api/admin/orgs/${orgId}/domains/${encodeURIComponent(domain)}`, { method: "DELETE" }),

  // Endpoint
  orgEndpoint: (orgId: string) =>
    call<{ endpoint: { baseUrl: string; apiKeyRef: string; createdAt: string } | null }>(`/api/admin/orgs/${orgId}/endpoint`),
  setEndpoint: (orgId: string, baseUrl: string, apiKeyRef: string) =>
    call<{ ok: boolean }>(`/api/admin/orgs/${orgId}/endpoint`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl, apiKeyRef }),
    }),

  // Users
  users: () => call<{ users: AdminUser[] }>("/api/admin/users"),

  // Invites
  invites: () => call<{ invites: AdminInvite[] }>("/api/admin/invites"),
  createInvite: (orgId: string, email: string, expiresInDays = 7) =>
    call<{ id: string; email: string; token: string; expiresAt: string }>("/api/admin/invites", json({ orgId, email, expiresInDays })),

  // Access Requests
  accessRequests: () => call<{ accessRequests: AdminAccessRequest[] }>("/api/admin/access-requests"),
  updateAccessRequest: (id: string, status: "invited" | "declined") =>
    call<{ ok: boolean }>(`/api/admin/access-requests/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    }),

  // Activity
  activity: (limit = 100) => call<{ activity: AdminActivity[] }>(`/api/admin/activity?limit=${limit}`),
};
