/**
 * Background silent mail watcher.
 * Polls mail server silently and only outputs when a NEW unread mail arrives.
 */
let lastKnownMaxId = 248;

while (true) {
  try {
    const res = await fetch("http://localhost:3300/api/mail?agentId=platform-fe-antigravity");
    if (res.ok) {
      const messages: any[] = await res.json();
      const newMails = messages.filter((m: any) => !m.isRead && m.id > lastKnownMaxId);
      if (newMails.length > 0) {
        for (const mail of newMails) {
          console.log(`\n📬 [NEW MAIL #${mail.id}] From: ${mail.from}\n${mail.body}\n`);
        }
        lastKnownMaxId = Math.max(...messages.map((m: any) => m.id));
      }
    }
  } catch {}
  await Bun.sleep(10000);
}
