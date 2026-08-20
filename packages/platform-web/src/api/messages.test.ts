/**
 * The send, and the receipt that used to be made of the sender's own inputs.
 *
 * `POST /api/v1/messages` answers `{ ok, message }`. This function declared the
 * flat shape instead, so every field read off the envelope came back
 * `undefined`, every one of them had a local fallback behind `||`, and the
 * screen drew a receipt of the person's own typing plus the browser's clock
 * while reporting success. The receipt agreed with itself and said nothing
 * about the send.
 *
 * So the two things pinned here are: the envelope is unwrapped, and an absent
 * envelope **throws** rather than falling back — a thrown error reaches the
 * person, a receipt of placeholders does not.
 *
 * `NO_RECEIPT`'s *value* is not load-bearing and is not pinned: `PlaygroundPage`
 * compares against the imported symbol, so the two move together and no
 * assertion here could see the string change. What is load-bearing is that the
 * thrown message is that symbol and nothing else — see `expectNoReceipt`.
 */
import { describe, it, expect, mock, afterEach } from "bun:test";
import { sendMessageApi, NO_RECEIPT, type MessageReceipt } from "./messages.ts";
import { ApiError } from "./client.ts";

const realFetch = globalThis.fetch;
/** bun:test has no global stubber, so the original goes back by hand — a
 *  forgotten restore would poison every file that runs after this one. */
const stub = (fn: unknown) => { globalThis.fetch = fn as typeof globalThis.fetch; };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const spyOn = (body: unknown, status = 201) => {
  const spy = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => json(body, status));
  stub(spy);
  return spy;
};

/** The restore this file's own comment promises, and did not have: without it
 *  the last stub installed here outlives the file. bun gives each file its own
 *  globals today, so nothing leaked — which is exactly why it stayed missing,
 *  and why the assertion at the bottom of this file checks for it rather than
 *  trusting the line above. */
afterEach(() => { globalThis.fetch = realFetch; });

/** The rejection, or `null` if it resolved — a resolve is itself a failure in
 *  most of the cases below, and this keeps that visible in the assertion. */
const refusal = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);

/**
 * The missing-receipt marker, checked the way the screen checks it.
 *
 * Not the string's value — both sides import the same symbol, so changing the
 * constant moves the assertion with it and nothing here would notice. Two
 * things do matter, and both are mutations that pass every other test in this
 * file:
 *
 * - The thrown message is the symbol **and nothing more**. `PlaygroundPage`
 *   picks its sentence with `err?.message === NO_RECEIPT` and otherwise prints
 *   `err.message` at the person, so a throw site that appends context —
 *   `` `${NO_RECEIPT}: body had no message` `` — shows an operator a slug
 *   where a sentence belongs, and fails nowhere.
 * - It is not an `ApiError`. That is the type the same catch site reads a
 *   server's refusal as, and one carrying this message is a refusal that never
 *   happened.
 */
const expectNoReceipt = (err: unknown) => {
  expect(err).toBeInstanceOf(Error);
  expect(err).not.toBeInstanceOf(ApiError);
  expect((err as Error).message).toBe(NO_RECEIPT);
};

const RECEIPT: MessageReceipt = {
  id: "msg_1755690000000_ab12cd34",
  from: "operator",
  to: "lane-a",
  ts: "2026-08-20T12:00:00.000Z",
  status: "pending",
};

describe("sendMessageApi", () => {
  it("returns the server's receipt, unwrapped from its envelope", async () => {
    spyOn({ ok: true, message: RECEIPT });
    expect(await sendMessageApi({ to: "lane-a", text: "hello" })).toEqual(RECEIPT);
  });

  it("takes the sender and the time from the answer, never from the request", async () => {
    // The request carries neither: the route overrides `from` with the
    // authenticated login and stamps `ts` itself. Both were locally invented
    // here once — the person's own selection and the browser's clock — and a
    // receipt made of the caller's inputs cannot disagree with the caller, so
    // it never reported anything.
    spyOn({ ok: true, message: { ...RECEIPT, from: "signed-in-operator", ts: "2026-08-20T12:34:56.789Z" } });
    const receipt = await sendMessageApi({ to: "lane-a", text: "hello" });
    expect(receipt.from).toBe("signed-in-operator");
    expect(receipt.ts).toBe("2026-08-20T12:34:56.789Z");
    expect(receipt.id).toBe(RECEIPT.id);
  });

  it("throws the marker when a 201 carried no receipt", async () => {
    // `ok: true` and nothing else. The old reading treated this as success and
    // filled the fields in locally.
    spyOn({ ok: true });
    expectNoReceipt(await refusal(sendMessageApi({ to: "lane-a", text: "hello" })));
  });

  it("does not fall back to a flat body", async () => {
    // **The defect itself.** This is the shape the function used to declare, and
    // an implicit fallback to it would reproduce the whole failure: a receipt
    // that looks right, from a response the route does not send.
    spyOn({ id: "msg_1", from: "operator", to: "lane-a", ts: "2026-08-20T12:00:00Z", status: "pending" });
    expectNoReceipt(await refusal(sendMessageApi({ to: "lane-a", text: "hello" })));
  });

  it("treats an envelope with no id as no receipt at all", async () => {
    // A message object is only useful because its `id` is the one thing the
    // hub and this console can both name. Without it the row cannot be looked
    // up anywhere, so "present but unidentified" is not a weaker success.
    spyOn({ ok: true, message: {} });
    expectNoReceipt(await refusal(sendMessageApi({ to: "lane-a", text: "x" })));
    spyOn({ ok: true, message: { ...RECEIPT, id: 12345 } });
    expectNoReceipt(await refusal(sendMessageApi({ to: "lane-a", text: "x" })));
    spyOn({ ok: true, message: null });
    expectNoReceipt(await refusal(sendMessageApi({ to: "lane-a", text: "x" })));
  });

  it("carries a `failed` receipt back instead of throwing it away", async () => {
    // The route writes `failed` when the hub never accepted the message, and it
    // still answers `201` with a receipt. That receipt is the only place the
    // person is told the message will not be delivered — turning it into an
    // error, or reading it as `pending`, is the confusion the write-back in the
    // route exists to end.
    spyOn({ ok: true, message: { ...RECEIPT, status: "failed" } });
    expect((await sendMessageApi({ to: "lane-a", text: "hello" })).status).toBe("failed");
  });

  it("tells a refusal apart from a missing receipt", async () => {
    // Two different sentences on the screen, and the screen chooses between
    // them by the message alone: anything that is not `NO_RECEIPT` is printed
    // as it stands. So the assertion is the server's sentence itself, not that
    // it differs from the marker — a negative equality against one string is
    // true of almost every value, including of a wrapper this layer might add,
    // and what has to survive is the server's own words reaching the person.
    const refused = 'You are not authorized to message agent "lane-a"';
    spyOn({ error: refused }, 403);
    const err = await refusal(sendMessageApi({ to: "lane-a", text: "hello" }));
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe(refused);
    expect((err as ApiError).status).toBe(403);
  });

  it("does not read a 404 for an unknown recipient as a delivered message", async () => {
    // The route answers `404` with the registry it knows about — a field this
    // layer does not read, so it is not in the fixture pretending to be read.
    // What matters is that the answer becomes neither a receipt nor "no
    // receipt in a 201": there was no 201.
    spyOn({ error: 'Agent "ghost" not found in registry' }, 404);
    const err = await refusal(sendMessageApi({ to: "ghost", text: "hello" }));
    expect((err as ApiError).status).toBe(404);
    expect((err as ApiError).message).toBe('Agent "ghost" not found in registry');
  });

  it("posts exactly the fields the route reads", async () => {
    const spy = spyOn({ ok: true, message: RECEIPT });
    await sendMessageApi({ to: "lane-a", text: "hello" });
    const init = spy.mock.calls[0]![1]!;
    expect(init.method).toBe("POST");
    expect(String(spy.mock.calls[0]![0])).toMatch(/\/api\/v1\/messages$/);
    // No `from`: the sender is the token's, and a `from` in the body would be
    // ignored by the route while reading, to the next person, as a choice this
    // screen makes. No `reply_to` either when there is none to send.
    expect(JSON.parse(String(init.body))).toEqual({ to: "lane-a", text: "hello" });
  });

  it("threads a reply when it was given one", async () => {
    const spy = spyOn({ ok: true, message: RECEIPT });
    await sendMessageApi({ to: "lane-a", text: "hello", reply_to: "msg_0" });
    expect(JSON.parse(String(spy.mock.calls[0]![1]!.body)).reply_to).toBe("msg_0");
  });

  it("has put the real fetch back before this test began", () => {
    // The file's own guard, asserted instead of assumed. Every test above
    // installs a stub and this one installs none, so if the `afterEach` is ever
    // dropped — as it was, for as long as this file has existed — the stub from
    // the test above is still here and this fails. bun gives each file its own
    // globals today, which is why the missing restore cost nothing and stayed
    // invisible; the day a run shares them, this is what fails first, in the
    // file that caused it rather than in some later file that did nothing
    // wrong.
    expect(globalThis.fetch).toBe(realFetch);
  });
});
