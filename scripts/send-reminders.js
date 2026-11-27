// Runs daily on GitHub Actions: reads every user's items from Firestore and emails each user a digest
// of dates that are 5 days away or closer (down to the day itself).
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore(), auth = admin.auth();

const DAYS_BEFORE = 5;
const nowIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
const left = d => Math.round((new Date(d + "T00:00:00Z") - new Date(nowIST + "T00:00:00Z")) / 864e5);
const inr = n => "₹" + Number(n || 0).toLocaleString("en-IN");
const words = n => n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`;
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const who = r => [r.holder && `Policy holder: ${r.holder}`, r.number && `Policy no: ${r.number}`].filter(Boolean).join(" | ");
const shouldSend = n => n >= 0 && n <= DAYS_BEFORE;

const events = it => [
  it.due && { k: "Premium due", d: it.due, extra: it.prem ? inr(it.prem) : "" },
  it.exp && { k: it.kind === "document" ? "Expires" : "Insurance expires", d: it.exp, extra: "" },
  it.mat && { k: "Matures", d: it.mat, extra: "" }
].filter(Boolean);

(async () => {
  const snap = await db.collectionGroup("items").get();
  const byUser = {};
  snap.forEach(doc => {
    const uid = doc.ref.parent.parent.id, it = doc.data();
    events(it).forEach(e => { const n = left(e.d); if (shouldSend(n)) (byUser[uid] ||= []).push({ n, name: it.name, provider: it.provider, holder: it.holder, number: it.number, k: e.k, d: e.d, extra: e.extra }); });
  });

  const uids = Object.keys(byUser);
  if (!uids.length) return console.log("Nothing to send today.");
  const mail = nodemailer.createTransport({ service: "gmail", auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  const link = process.env.APP_URL ? `<p><a href="${esc(process.env.APP_URL)}">Open your tracker</a></p>` : "";

  for (const uid of uids) {
    const prefs = await db.doc(`users/${uid}`).get();
    if (prefs.exists && prefs.data().emailReminders === false) continue;
    let email;
    try { ({ email } = await auth.getUser(uid)); } catch { continue; }
    if (!email) continue;

    const rows = byUser[uid].sort((a, b) => a.n - b.n);
    const text = `Upcoming dates:\n\n${rows.map(r => `- ${r.name}${who(r) ? " [" + who(r) + "]" : ""}: ${r.k.toLowerCase()}${r.extra ? " (" + r.extra + ")" : ""} ${words(r.n)} - ${r.d}`).join("\n")}\n`;
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px"><h2 style="margin:0 0 12px">Upcoming dates</h2>
      <table style="width:100%;border-collapse:collapse">${rows.map(r => `<tr><td style="padding:10px 0;border-bottom:1px solid #e3e8ee"><b>${esc(r.name)}</b>${r.provider ? ` <span style="color:#667">(${esc(r.provider)})</span>` : ""}${who(r) ? `<br><span style="color:#667;font-size:13px">${esc(who(r))}</span>` : ""}<br>${esc(r.k)}${r.extra ? ` &middot; ${esc(r.extra)}` : ""}</td><td style="padding:10px 0;border-bottom:1px solid #e3e8ee;text-align:right;white-space:nowrap;color:${r.n <= 1 ? "#b4232a" : "#a65f00"}"><b>${words(r.n)}</b><br><span style="color:#667;font-size:13px">${esc(r.d)}</span></td></tr>`).join("")}</table>${link}</div>`;
    if (process.env.DRY_RUN) { console.log(`[dry run] to ${email}\n${text}`); continue; }
    await mail.sendMail({ from: `Policy Tracker <${process.env.GMAIL_USER}>`, to: email, subject: `${rows.length} date${rows.length === 1 ? "" : "s"} coming up: ${rows[0].name} ${words(rows[0].n)}`, text, html });
    console.log(`Sent ${rows.length} item(s) to ${email}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
