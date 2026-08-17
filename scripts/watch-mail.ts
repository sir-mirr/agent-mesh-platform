/**
 * Background silent mail watcher for platform-fe-antigravity.
 */
console.log("🟢 [watch-mail] Started monitoring mailbox (http://localhost:3300/api/mail)...");

let lastKnownMaxId = 0;

// 1. Initialize with current highest ID on server
try {
  const initRes = await fetch("http://localhost:3300/api/mail?agentId=platform-fe-antigravity");
  if (initRes.ok) {
    const list: any[] = await initRes.json();
    if (list.length > 0) {
      lastKnownMaxId = Math.max(...list.map((m: any) => m.id));
      console.log(`🟢 [watch-mail] Initialized with latest message #${lastKnownMaxId}`);
    }
  }
} catch (e: any) {
  console.error("🔴 [watch-mail] Failed to connect to mail server:", e.message);
}

// 2. Poll every 5s silently and print only when a higher ID message arrives
while (true) {
  try {
    const res = await fetch("http://localhost:3300/api/mail?agentId=platform-fe-antigravity");
    if (res.ok) {
      const messages: any[] = await res.json();
      const newMails = messages.filter((m: any) => m.id > lastKnownMaxId);
      if (newMails.length > 0) {
        for (const mail of newMails) {
          console.log(`\n📬 [NEW MAIL #${mail.id}] From: ${mail.from}\n${mail.body}\n`);
        }
        lastKnownMaxId = Math.max(...messages.map((m: any) => m.id));
      }
    }
  } catch {}
  await Bun.sleep(5000);
}
