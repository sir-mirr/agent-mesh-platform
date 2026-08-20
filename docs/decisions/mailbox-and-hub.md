# The mailbox and the mesh hub are separate — settled design

Status: **decided and implemented**, except where noted below. Supersedes the arrangement in which
`/api/v1/mailbox/in` and `/api/v1/mailbox/out` were hub routes backed by hub internals.

---

## The shape

```
   sender ──▶ mailbox            (store and forward; no idea the hub exists)
                 │
                 │  hub pulls, for identities it currently holds a lane for
                 ▼
   hub ─────▶ agent              (realtime; delivers on the mailbox's behalf)
```

Two systems, one direction of knowledge.

**The mailbox is at the edge and does not know the hub exists.** It accepts a
message for an identity, keeps it, and hands it over when asked. It has no
notion of who is online, no socket, no presence. Nothing in it imports the hub.

**The hub knows the mailbox.** When an identity is connected, the hub pulls that
identity's waiting mail and delivers it. The agent sees one stream and does not
have to ask twice.

## Why this way round

The current arrangement has the dependency backwards. `rest/inbox.ts` imports
hub presence, the hub's database handle, and three RPC handlers; the mailbox
*is* the hub, wearing a REST surface. That has two consequences worth stating
plainly:

**Mail cannot be accepted while the hub is down.** Store-and-forward exists for
exactly the window in which the other end is not there, and a mailbox that
shares the hub's lifetime is not store-and-forward. It is a queue that
disappears at the same moment its reason to exist appears.

**This one is not fixed by the decision below.** The mailbox runs in the hub's
process, so it still stops when the hub does. What the boundary buys is that the
code no longer *assumes* it — which is the prerequisite for fixing it, and not
the fix. Said plainly here because a design document that lists a benefit it has
not delivered is the same defect as a check that reports green without checking.

**A participant with no socket is a second-class case.** § 8.10 exists because
an agent driven by an application is awake only while answering. Today that
participant reaches the mesh through the hub's own port, so the hub is in the
path of a conversation that has no realtime component at all.

Inverting it makes the hub an *optimisation* — the thing that shortens the wait
when both ends happen to be present — rather than a dependency.

## Naming

One word. `inbox`, `outbox` and `mailbox` were three names for two directions of
one thing, and the routes said `inbox` where the SPEC said mailbox.

| was | is |
|---|---|
| `POST /api/v1/mailbox/in` | `POST /api/v1/mailbox/in` |
| `GET /api/v1/mailbox/history` | `GET /api/v1/mailbox/history` |
| `POST /api/v1/mailbox/out` | `POST /api/v1/mailbox/out` |
| `GET /api/v1/mailbox/out` | `GET /api/v1/mailbox/out` |
| `DELETE /api/v1/mailbox/out/{message_id}` | `DELETE /api/v1/mailbox/out/{id}` |

`in` is what has arrived for the caller; `out` is what the caller has sent and
may still recall. The direction is the caller's, consistently, which is the part
`inbox`/`outbox` kept getting wrong when a proxy was involved.

## Where a reply goes

A reply names the original sender as its recipient — that part is ordinary. The
question this design has to answer is which *channel* carries it.

**A reply to something that arrived through the mailbox goes back through the
mailbox.** The channel is a property of the conversation, not of the moment. A
correspondent who reads mail once an hour should not receive half a thread on a
socket they were briefly holding.

**Unless both ends are live on the hub**, in which case it goes over the mesh.
Both being present is the only condition under which the mailbox adds latency
and nothing else — and the hub can see both halves of that condition, which the
mailbox deliberately cannot.

That exception is the hub's decision to make, not the mailbox's, and it is made
at send time rather than recorded on the conversation. A rule evaluated at send
time follows presence; a channel written down at conversation start goes stale
the moment either side reconnects.

## What has to hold

1. **`packages/mailbox` imports nothing from `packages/hub`.** Enforced, not
   intended — a dependency that only a convention forbids is a dependency.
2. **The mailbox answers with the hub stopped.** Accepting and storing mail is
   the case it exists for. **Not yet true** — see the decision below; the
   mailbox shares the hub's process. Listed here because this is the list of
   what has to hold, and leaving it off would make the list agree with the
   implementation by shortening the requirements.
3. **Delivery is at-least-once and unchanged** (§ 8.10.1). Moving the code does
   not move the lease, the acknowledgement or the redelivery.
4. **The hub pulls; the mailbox never pushes.** The mailbox has no address to
   push to, by construction.

## Decided: a package, in the hub's process

Not a fourth service. The boundary is a compile-time one, enforced by
`test/mailbox-boundary.test.ts`, and both halves run where they ran before.

**What this does buy.** The dependency points one way, so the mailbox can be
read, tested and reasoned about without the hub in the picture, and the routes
stop reaching into presence and RPC handlers to do their work. A later promotion
to its own process is mechanical exactly because nothing has to be untangled
first.

**What it does not buy**, and this is the part worth keeping in view: the
mailbox stops when the hub stops. The first argument above is why the split is
worth making, and it is not yet true. Anyone reading this to decide whether mail
survives a hub restart should read it as *no*.

The honest way to hold that is not to soften the argument but to leave it
standing and mark it unmet. It is the reason to take the next step, and softening
it would remove the reason while keeping the appearance of having addressed it.

---

## Where this stands

| | |
|---|---|
| Naming, routes, capability | done — `mailbox/in`, `mailbox/out`, `mailbox.read.depth` |
| Boundary, enforced | done — `test/mailbox-boundary.test.ts` |
| `mesh.receive` (lease, ack, redelivery) | in the package |
| `mesh.send`, persistence half | in the package |
| Reply routing (§ 8.2a) | in the package; presence passed in — **and now held by a shared scenario**, contracts v0.22.0 |
| `mesh.fetch_messages` (history) | **still in the hub** |
| A process of its own | **not done, and not planned** — see the decision above |

**History has not moved, and the reason is thin: nothing forced it.** It reads
the same table through the same store and would go across as easily as the
others. It is listed rather than quietly omitted, because a table of what is
done is the first place an honest reader looks and the last place anybody
updates.

~~**The reply rule is held by unit tests and two mutations, not by a shared
scenario.**~~ **Closed** — `E2E-REPLY-001`, contracts v0.22.0. What follows is why
it took a vocabulary change. Stating the interesting case to both runners needs a step that holds
a socket open across later steps — a reply to mail with the *recipient* live and
the *sender* not — and the scenario vocabulary has no way to say that. Adding
one is a contract change worth making deliberately rather than in passing, and
until it happens this is a clause one implementation checks alone, which § 17.3
is explicit is not enough.

`client-claude` proposed the shape when this was raised (mail #242), and it is
recorded here rather than re-derived later:

```
{ do: "connect",      identity: "a", hold: true }
{ do: "send",         from: "b", to: "a", … }
{ do: "expectPushed", identity: "a", count: 1 }   // since the last check
{ do: "disconnect",   identity: "a" }
```

Three things in it are not obvious, and each is a mistake already made once
somewhere in this work:

**Disconnecting is the scenario's to say, not the runner's.** The case worth
stating is a reply to mail with the recipient live and the sender *not*, so
absence has to be expressible. A runner that tidies up implicitly at the end can
never produce that state in the middle. Automatic cleanup still belongs there,
but as hygiene rather than as an assertion — a socket left open changes presence
for the next scenario, and on a shared mesh that moves every `delivered` /
`pending` verdict after it.

**A held socket needs a named window.** `expectDelivered` today is unambiguous
because the window is the connect itself; on a socket being held, "how many"
means nothing without "since when". `expectPushed` clearing its counter fixes
the window at *since the last check*. A cumulative count would make every
expectation depend on the steps above it, so inserting one step would falsify
everything below — which is exactly why step numbers were kept out of the
mutation manifest.

**The listener attaches on socket open, not after the connect response.** The
hub may push before the response is written, and attaching later misses the
delivery under test.
