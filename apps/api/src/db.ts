import { drizzle } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import { schema } from "@benchy/db";

export const db = drizzle(env.DB, { schema });
