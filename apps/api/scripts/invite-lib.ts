import { randomBytes } from "node:crypto";

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function generateInviteToken(): string {
  return randomBytes(32).toString("hex");
}

export function generateId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

export function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}
