/**
 * Who is answerable for an identity, and how they proved it (SPEC § 11.3).
 *
 * **Ownership is delegation, not sovereignty.** The tenant owns its
 * identities; an agent operator is the person answerable for one day to day.
 * So a tenant admin reaching inside their own tenant is the boundary working
 * rather than a violation, and an agent whose owner leaves is reassigned
 * without anyone editing a table by hand.
 *
 * Owners are plural on purpose. One owner means the owner leaving strands the
 * agent, and the recovery is exactly the manual intervention this exists to
 * remove.
 *
 * ## The claim has to cross a gap
 *
 * The person is in a browser session; the agent is a process on some host with
 * a CLI. A pairing code closes that gap and needs no infrastructure that does
 * not already exist: the operator asks for a code while logged in, types it
 * into the CLI, and the CLI redeems it.
 *
 * That is the device authorization grant with the roles reversed. Its
 * properties are what make it good enough — short-lived, single-use, only ever
 * entered on a host the operator already controls, and a stolen code buys one
 * name-claim inside its window rather than an account.
 *
 * **Redemption records the address it came from.** That is the observed half
 * of § 8.11 arriving at the strongest possible moment: the one time we know
 * the agent's host and the person vouching for it in the same transaction.
 */

import type { Database } from "bun:sqlite";

export const DEFAULT_TENANT = "default";

/** Long enough that guessing inside the window is hopeless, short enough to read aloud. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I/O/0/1
const CODE_GROUPS = 3;
const CODE_GROUP_LEN = 4;

export interface Owner {
  identity: string;
  owner: string;
  tenant: string;
  granted_at: string;
  granted_by: string;
}

export interface PairingCode {
  code: string;
  tenant: string;
  identity: string;
  issued_by: string;
  issued_at: string;
  expires_at: string;
  redeemed_at: string | null;
  redeemed_from: string | null;
}

export function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_owners (
      tenant     TEXT NOT NULL,
      identity   TEXT NOT NULL,
      owner      TEXT NOT NULL,
      granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      granted_by TEXT NOT NULL,
      PRIMARY KEY (tenant, identity, owner)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_owners_owner
      ON agent_owners(tenant, owner);
  `);
  // Redeemed rows are kept, not deleted. "Who claimed this agent, when, and
  // from where" is the provenance of an ownership claim — deleting the code
  // after use would throw away the only record of how the claim was made.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code          TEXT PRIMARY KEY,
      tenant        TEXT NOT NULL,
      identity      TEXT NOT NULL,
      issued_by     TEXT NOT NULL,
      issued_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at    DATETIME NOT NULL,
      redeemed_at   DATETIME,
      redeemed_from TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_pairing_codes_identity
      ON pairing_codes(tenant, identity, issued_at DESC);
  `);
}

/** `ABCD-EFGH-JKLM`. Grouped so a person reading one aloud does not lose their place. */
function generateCode(random: () => number): string {
  const groups: string[] = [];
  for (let g = 0; g < CODE_GROUPS; g++) {
    let s = "";
    for (let i = 0; i < CODE_GROUP_LEN; i++) {
      s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
    }
    groups.push(s);
  }
  return groups.join("-");
}

export interface IssueOptions {
  tenant?: string;
  identity: string;
  issuedBy: string;
  ttlSeconds: number;
  /** Injected so a test can produce a known code; production passes nothing. */
  random?: () => number;
}

export function issueCode(db: Database, opts: IssueOptions): PairingCode {
  const code = generateCode(opts.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32));
  const tenant = opts.tenant ?? DEFAULT_TENANT;
  // The sign belongs to the number, not to a `'+'` glued in front of it.
  // `'+' || -1` is `'+-1 seconds'`, which SQLite rejects — and the column
  // takes `NULL`, so a code with no expiry at all would have been written by
  // a `datetime()` that quietly returned nothing. Found by a test that asked
  // for an already-expired code, which is the only caller that ever passes a
  // negative.
  db.prepare(
    `INSERT INTO pairing_codes (code, tenant, identity, issued_by, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', ? || ' seconds'))`,
  ).run(code, tenant, opts.identity, opts.issuedBy, `${opts.ttlSeconds >= 0 ? "+" : ""}${opts.ttlSeconds}`);
  return db.prepare(`SELECT * FROM pairing_codes WHERE code = ?`).get(code) as PairingCode;
}

export type RedeemOutcome =
  | { ok: true; identity: string; owner: string }
  | { ok: false; reason: "unknown" | "expired" | "already-redeemed" };

/**
 * Spend a code and record the ownership it proves.
 *
 * **One statement decides it.** Reading the row and then updating it leaves a
 * window in which two redemptions both see an unspent code, and the second
 * would claim an ownership the first already took — `changes` is the answer,
 * the same way a recall re-decides in one statement (§ 9.2.1).
 *
 * The distinction between `expired` and `already-redeemed` is worth the extra
 * read on the failure path: one says ask for another code, the other says
 * somebody else already used this one, and those call for different reactions.
 */
export function redeem(
  db: Database,
  code: string,
  owner: string,
  observedFrom: string | null,
): RedeemOutcome {
  const spend = db
    .prepare(
      `UPDATE pairing_codes
          SET redeemed_at = datetime('now'), redeemed_from = ?
        WHERE code = ? AND redeemed_at IS NULL AND expires_at > datetime('now')`,
    )
    .run(observedFrom, code);

  if (spend.changes === 0) {
    const row = db.prepare(`SELECT redeemed_at FROM pairing_codes WHERE code = ?`).get(code) as
      | { redeemed_at: string | null }
      | undefined;
    if (!row) return { ok: false, reason: "unknown" };
    return { ok: false, reason: row.redeemed_at ? "already-redeemed" : "expired" };
  }

  const row = db.prepare(`SELECT tenant, identity, issued_by FROM pairing_codes WHERE code = ?`)
    .get(code) as { tenant: string; identity: string; issued_by: string };

  db.prepare(
    `INSERT INTO agent_owners (tenant, identity, owner, granted_by)
     VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).run(row.tenant, row.identity, owner, `pairing:${row.issued_by}`);

  return { ok: true, identity: row.identity, owner };
}

export function owners(db: Database, identity: string, tenant = DEFAULT_TENANT): Owner[] {
  return db
    .prepare(
      `SELECT tenant, identity, owner, granted_at, granted_by
         FROM agent_owners WHERE tenant = ? AND identity = ? ORDER BY granted_at`,
    )
    .all(tenant, identity) as Owner[];
}

export function ownedBy(db: Database, owner: string, tenant = DEFAULT_TENANT): string[] {
  return (
    db
      .prepare(`SELECT identity FROM agent_owners WHERE tenant = ? AND owner = ? ORDER BY identity`)
      .all(tenant, owner) as Array<{ identity: string }>
  ).map((r) => r.identity);
}

export function isOwner(db: Database, owner: string, identity: string, tenant = DEFAULT_TENANT): boolean {
  return !!db
    .prepare(`SELECT 1 FROM agent_owners WHERE tenant = ? AND identity = ? AND owner = ? LIMIT 1`)
    .get(tenant, identity, owner);
}

/** Assign directly — the tenant admin's path, when an owner has left. */
export function assign(
  db: Database,
  o: { tenant?: string; identity: string; owner: string; grantedBy: string },
): void {
  db.prepare(
    `INSERT INTO agent_owners (tenant, identity, owner, granted_by)
     VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).run(o.tenant ?? DEFAULT_TENANT, o.identity, o.owner, o.grantedBy);
}

export function unassign(
  db: Database,
  o: { tenant?: string; identity: string; owner: string },
): boolean {
  return (
    db
      .prepare(`DELETE FROM agent_owners WHERE tenant = ? AND identity = ? AND owner = ?`)
      .run(o.tenant ?? DEFAULT_TENANT, o.identity, o.owner).changes > 0
  );
}

