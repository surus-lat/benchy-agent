// Admin org impersonation: when set, all API calls include X-Admin-Org
// so the Worker resolves the impersonated org's workspace and data.

const STORAGE_KEY = "admin-impersonate-org";

export function getImpersonateOrg(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getImpersonateOrgName(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY + ":name");
  } catch {
    return null;
  }
}

export function setImpersonateOrg(orgId: string | null, orgName?: string) {
  try {
    if (orgId) {
      localStorage.setItem(STORAGE_KEY, orgId);
      if (orgName) localStorage.setItem(STORAGE_KEY + ":name", orgName);
    } else {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY + ":name");
    }
  } catch {
    // private browsing
  }
  // Force reload so all data refetches with the new org context.
  window.location.reload();
}

/** Extra headers to inject into every fetch when impersonating. */
export function impersonateHeaders(): Record<string, string> {
  const org = getImpersonateOrg();
  return org ? { "x-admin-org": org } : {};
}
