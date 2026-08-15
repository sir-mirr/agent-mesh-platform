/**
 * Registering people as mesh identities (SPEC § 10.1, § 10.3).
 *
 * A person signs in here, and until now that was the whole of their existence:
 * a row in this server's own `agent_registry`, and a string in the `proxy_for`
 * list handed to the hub at connect. The hub had no record of them. It routed
 * their messages, stored their name in `messages.from_agent`, and could not
 * have said whether that name belonged to anyone.
 *
 * So a person is provisioned like any other participant, as type `human`. The
 * type is seeded at `requires_key = 0` (§ 10.3): they authenticate here by
 * session token and hold no key, which is the reason `proxy_for` exists.
 *
 * This goes over the hub's REST route rather than writing `agents.db`
 * directly. The hub owns that schema and applies the rules — the identity
 * pattern, the type registry, the refusal to re-register a soft-deleted
 * identity. Writing the row from this side would be a second implementation of
 * checks that already exist, and the one place they are stated.
 */

const HUB_WS_URL =
  process.env.AGENT_MESH_HUB_URL ??
  process.env.HUB_URL ??
  'ws://127.0.0.1:3100/ws'

/** `ws://host:port/ws` → `http://host:port`. The hub serves both on one port. */
function restBase(): string {
  const explicit = process.env.AGENT_MESH_HUB_REST_URL?.trim()
  if (explicit) return explicit.replace(/\/+$/, '')
  try {
    const u = new URL(HUB_WS_URL)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    return u.origin
  } catch {
    return 'http://127.0.0.1:3100'
  }
}

/** The hub's rule (SPEC § 10.1). Checked here only to report it usefully. */
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/

export interface ProvisionOutcome {
  ok: boolean
  reason?: string
}

/**
 * Register one person as a mesh identity. Idempotent: the route upserts, so a
 * re-approval or a restart re-sends the same row harmlessly.
 *
 * Never throws. A person who cannot be provisioned is still a web user here —
 * they simply are not a mesh participant yet — and failing their approval
 * because the hub was briefly unreachable would be the wrong trade. The
 * reconnect backfill retries.
 */
/**
 * Register this server's own identity, with the grant that lets it speak for
 * people (SPEC § 8.2).
 *
 * It has to register itself because nothing else does: the identity was
 * previously expected to be inserted by hand, so a fresh deployment had an http
 * server that could not connect until someone noticed. And it has to carry
 * `can_proxy`, because the entitlement check reads it from the row rather than
 * trusting what the socket claims — the grant is the thing being checked, so it
 * cannot come from the party being checked. That it is self-asserted here is a
 * consequence of the hub being unauthenticated, recorded in docs/deferred.md
 * rather than pretended away.
 */
export async function provisionSelf(identity: string): Promise<ProvisionOutcome> {
  return post({
    identity,
    type: 'service',
    description: 'Agent Mesh Web UI',
    can_proxy: true,
  })
}

export async function provisionHuman(identity: string): Promise<ProvisionOutcome> {
  // A person's identity is their GitHub login verbatim, which is also the
  // `github_login` this server sends as `from` (SPEC § 8.2). Nothing is
  // normalised: § 10.1 compares identities case-sensitively for exactly this
  // reason, so the two halves cannot drift. A login the rule still rejects —
  // one that starts with a hyphen, say — is reported rather than mangled to fit.
  if (!IDENTITY_RE.test(identity)) {
    return { ok: false, reason: `"${identity}" is not a valid mesh identity (must match ${IDENTITY_RE})` }
  }

  return post({ identity, type: 'human', description: 'Web user' })
}

async function post(body: Record<string, unknown>): Promise<ProvisionOutcome> {
  let res: Response
  try {
    res = await fetch(`${restBase()}/api/v1/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    })
  } catch (err) {
    return { ok: false, reason: `hub unreachable: ${err instanceof Error ? err.message : String(err)}` }
  }

  if (res.ok) return { ok: true }

  let detail = `HTTP ${res.status}`
  try {
    const parsed = await res.json() as { error?: string }
    if (parsed?.error) detail = `${detail}: ${parsed.error}`
  } catch {}
  return { ok: false, reason: detail }
}

/**
 * Provision every approved web user. Run on each hub connect, which is both the
 * backfill for people approved before this existed and the retry for anyone the
 * hub was down for.
 */
export async function provisionAllHumans(identities: readonly string[]): Promise<void> {
  if (identities.length === 0) return

  const failures: string[] = []
  for (const identity of identities) {
    const outcome = await provisionHuman(identity)
    if (!outcome.ok) failures.push(`${identity} (${outcome.reason})`)
  }

  const registered = identities.length - failures.length
  if (registered > 0) console.log(`[http-server] registered ${registered} person(s) as mesh identities`)
  // Loudly: an unregistered person still sends and receives, so this does not
  // announce itself as a failure anywhere else.
  if (failures.length > 0) {
    console.warn(`[http-server] could not register ${failures.length} person(s): ${failures.join(', ')}`)
  }
}
