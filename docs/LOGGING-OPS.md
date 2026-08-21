# Reading the logs (T-022)

Three services write one line shape. This is what the shape is, what an
operator can ask of it, and the three complaints it was built to answer.

The contract lives in `packages/log/src/index.ts`; this file is how to use it.
Where the two disagree, the code is right and this is out of date — and
`test/logging-ops.test.ts` fails when the events named here stop existing.

---

## The line

```
2026-08-22T05:00:00.000Z warn [hub] refused a send: no egress rule from 'walled' to 'open' {"ts":"2026-08-22T05:00:00.000Z","level":"warn","component":"hub","event":"send_refused","actor":"agent-a","to":"agent-b","from_group":"walled","to_group":"open","outcome":"refused","reason":"egress_denied"}
```

A sentence for a person and fields for a program, from one call, so the two
cannot drift. `ts`, `level` and `component` appear in both halves on purpose: a
parser that takes the JSON has the whole event without splitting the line first.

**Head:** `<ISO-8601 UTC> <level> [<component>] <sentence>`
**Tail:** the same event as JSON, always beginning `{"ts":"`.

To read the tail of a line, cut at the **last** occurrence of ` {"ts":"` — a
sentence is allowed to quote one.

```bash
journalctl -u agent-mesh-hub --since "10 min ago" \
  | grep '"event":"send_refused"' \
  | sed 's/^.* {"ts":/{"ts":/' | jq -r '[.ts,.actor,.to,.reason] | @tsv'
```

### Components

`hub`, `http`, `self-reminder` are processes. `store` and `mailbox` are
libraries that run inside them — a `[store]` line in `agent-mesh-hub`'s journal
was written by the hub, about a database it opened.

### Levels

| | |
|---|---|
| `error` | the service could not do what it was asked |
| `warn` | it worked as designed, and somebody should know — every refusal is here |
| `info` | lifecycle, and the outcome of one message |

`error` and `warn` go to **stderr**, `info` to **stdout**. That is what makes
`journalctl -p warning` mean *is anything wrong*, and it is why ordering is
guaranteed within a stream and not between the two.

A refusal is a `warn`, not an `error`. The mesh refusing a send it was
configured to refuse is the mesh working; it is on the list because the person
who was refused will ask.

### Fields

Four are spelled out in the type because they are what a complaint is answered
from:

| | |
|---|---|
| `id` | the thing this is about: a message id, a fingerprint, a username, an agent type |
| `actor` | whoever caused it |
| `outcome` | what became of it: `refused`, `delivered`, `queued`, `dropped`, `skipped` |
| `reason` | why, for anything that did not go through — a short token from the source |

Anything else an event has rides alongside. `error` carries an exception's
message; `detail` carries a sentence that is not a token.

---

## journald is the record

There is no second log file, and nothing here writes one. Rotation, retention
and priority filtering are systemd's, which already had them; a duplicate file
log is a second copy to keep, to rotate, and to disagree with the first.

The units under `ops/systemd/` set no `StandardOutput` or `StandardError`,
which is how both streams reach the journal with their priorities intact —
`test/logging-ops.test.ts` fails if one starts overriding them.

```bash
journalctl -u agent-mesh-hub -f                 # follow
journalctl -u agent-mesh-http -p err --since today
journalctl -u agent-mesh-self-reminder --since "1 hour ago" | grep '"level":"error"'
```

A child process's stdout is **not** rewritten on the way through. Anything a
service spawns writes into the same journal as itself, in its own shape.

---

## The counters, and why zero is an answer

Every logged event increments a counter keyed `(component, event, reason)`.
One call does both, so a line cannot happen uncounted and a counter cannot
describe an event nobody logged.

The point is the zero. *No logs* and *no problem* are the same observation
unless something says the path was there and quiet, so each process writes a
`counter_snapshot` at boot and every fifteen minutes
(`AGENT_MESH_COUNTER_SNAPSHOT_MS`), carrying `since` — the moment counting
began — and every count.

```bash
journalctl -u agent-mesh-hub | grep counter_snapshot | tail -1 \
  | sed 's/^.* {"ts":/{"ts":/' | jq '{since, counts}'
```

Without `since`, `0` and *this process started ninety seconds ago* are the same
number on a screen.

**The key cannot grow with traffic.** A `reason` that is not a short token —
anything assembled from a request, or lifted from a database's error message —
is counted as `other` while the line still carries it in full. A counter map
keyed on caller input is a memory leak whose rate the caller chooses.

### The six worth naming

| Counter | Where | What it says |
|---|---|---|
| `lease_expired` | `mailbox` | a batch was handed out again because the last caller's lease lapsed |
| `frame_dropped` | `hub`, `http`, `self-reminder` | a frame that could not be delivered or parsed, with `reason` |
| `push_failed` | `http` | a notification failed; `reason: endpoint_gone` is the 404/410 that removes the subscription |
| `audit_gap_fetch` | `http` | a reconnecting console was handed what it missed (`audit_gap_summary`, `audit_gap_skipped` are the other two endings) |
| `wal_recovered` | `store` | a store was opened carrying a write-ahead log the last process did not fold |
| `hub_disconnected` | `http` | the link to the hub went away; its rate is how often sends are answered with nothing |

---

## Correlation

**A message has an id both sides already hold.** `client_message_id` going in,
the hub's message id coming back, and every line about it carries the id in
`id`. Nothing else is needed to answer a complaint about one message.

**Everything else uses `x-request-id`.** The http server takes the one the
caller sends, makes one when it does not, echoes it back in the response
header, and puts it on every line that request writes — including lines written
from deep inside a failure. A client that records the header beside its own
account of what happened has an exact pairing.

```bash
journalctl -u agent-mesh-http | grep '"request_id":"console-42"'
```

The value is bounded before it is believed: it is written into a record an
operator reads, so anything that is not a short token is replaced rather than
refused. The caller is not the problem, and failing an unfamiliar client over a
field that exists to help somebody read a log would be a poor trade.

**The fallback** for a caller that sends nothing is what it always was — pair on
UTC time, endpoint and actor. It is a guess across two clocks, which is why the
header exists.

---

## Three complaints

Each of these is answered from the client's own bundle and the server log,
without asking anybody to reproduce anything.

### A. "My message was never delivered"

The id is in the sender's bundle. Ask the hub what it did with it:

```bash
journalctl -u agent-mesh-hub | grep '"id":"<message-id>"'
```

One of these answers:

| `event` | Reading |
|---|---|
| `send_refused` | it never entered the mesh; `reason` says which rule |
| `send_delivered` | handed to a live socket at that moment |
| `send_queued` | stored; `reason: recipient_offline` or `delivery_failed` |
| `pending_delivery` | replayed when the recipient reconnected |
| `frame_dropped` | the socket dropped the frame, so the row stayed pending |
| *nothing at all* | it never reached the hub — look at the sender's side |

`send_persist_failed` is the one case where the sender was told to retry.

**Nothing at all, for a message sent from the web UI**, is most often the link
rather than the message. The http server answers `null` to every send while its
hub socket is down, and a `null` there is indistinguishable from a hub that
refused — so ask the sender's side which it was:

```bash
journalctl -u agent-mesh-http | grep '"event":"hub_disconnected"'
```

| `event` | Reading |
|---|---|
| `hub_disconnected` | the link was up and went away; `retry_in_ms` says when the next dial was due, and the next `hub_connected` closes the outage |
| `hub_dial_failed` | there was never a link — `detail` carries what the socket constructor said. This one does not fix itself; it is configuration |
| `self_provision_failed` | the link is up but this server has no row on the hub, so § 8.2 refuses every message it sends on a person's behalf |

The last is the quiet one: the socket is connected, the sends leave, and each is
refused at the far end for an entitlement the sender never saw fail.

### B. "I cannot sign in"

```bash
journalctl -u agent-mesh-http | grep '"event":"sign_in_refused"'
```

`reason` is the repair:

| `reason` | Repair |
|---|---|
| `missing_fields` | the client sent a body without a username or a password |
| `bad_credentials` | wrong password, or no such account — deliberately not distinguished |
| `must_change_password` | the account is signed in and must change its password before anything else |

If there is no line at all, nothing reached this server: look at the client, the
proxy, and whether the request went to the host you think it did.

`bad_credentials` covers both halves on purpose. Distinguishing them in the
answer is account enumeration; distinguishing them in a log is the same
enumeration one step later, in a file more people can read.

### C. "I got no notification"

```bash
journalctl -u agent-mesh-http | grep -E '"event":"push_(skipped|failed|queued|not_attempted)"'
```

| `event` / `reason` | Reading |
|---|---|
| `push_skipped` · `not_configured` | this deployment holds no VAPID keys |
| `push_skipped` · `already_watching` | they had the conversation open — a notification would be the same message twice |
| `push_skipped` · `no_device_registered` | nobody has registered a device for them |
| `push_failed` · `endpoint_gone` | the browser had unsubscribed; the subscription was removed |
| `push_failed` · `push_service_error` | the push service refused; the subscription was kept |
| `push_not_attempted` | this server threw before asking any device |
| `push_queued` | it was handed to every registered device — the rest is the browser's |

---

## Adding a line

- **One call.** `log.warn(sentence, event, fields)`. The counter is not a
  second API to keep in step.
- **The sentence is built here.** Never interpolate anything that arrived from
  an unauthenticated request into it — a name with a newline in it is how a
  caller writes its own log line. Put it in a field, where `JSON.stringify`
  escapes it, and bound its length.
- **`reason` is a token from the source**, matching
  `/^[a-z0-9][a-z0-9_.:-]{0,63}$/`. Anything else is counted as `other`.
- **A refusal names what, who and why**: `id`, `actor`, `reason`.
- **The normal path is quiet.** No banners. A line per message outcome is not a
  banner; a line saying a socket opened, with no identity on it, is.
- **Pin it with a mutation** if an operator would be stuck without it. A log
  line nothing holds drifts, and `scripts/mutation-check.ts` is where the
  holding is written down.
