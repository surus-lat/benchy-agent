import { d1Execute, extractResultRows } from "./d1";

// Lists Request Access submissions from the production database, so the owner
// never depends on the notification email arriving. Approve one by minting an
// invite: `pnpm invite --org "<Org>" --email <email>` (that marks it invited).

const showAll = process.argv.includes("--all");

function main() {
  const where = showAll ? "" : "WHERE status = 'pending'";
  const rows = extractResultRows(
    d1Execute(
      `SELECT orgName, email, name, message, status, datetime(createdAt, 'unixepoch') AS createdAt ` +
        `FROM accessRequests ${where} ORDER BY createdAt DESC`,
    ),
    "listing access requests",
  );

  if (rows.length === 0) {
    console.log(showAll ? "No access requests." : "No pending access requests. (--all shows every status)");
    return;
  }

  for (const r of rows) {
    console.log(`${r.createdAt}  [${r.status}]  ${r.orgName}  <${r.email}>  ${r.name ?? ""}`);
    if (r.message) console.log(`    ${String(r.message).replace(/\s+/g, " ").slice(0, 200)}`);
  }
  console.log(`\n${rows.length} request(s). Approve one with: pnpm invite --org "<Org>" --email <email>`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
