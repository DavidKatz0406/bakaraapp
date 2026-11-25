/* קליטת חשבוניות ספקים מתיבת Outlook (Microsoft 365) לבקרה — ט.ש. מי-רון
 *
 * איך זה עובד:
 *  • מישהו מהמשרד לוחץ בלשונית החשבוניות "חבר את תיבת המייל". הבקרה (msApi?action=start) בודקת שהוא באמת
 *    משתמש משרד, ושולחת אותו לדף ההתחברות של מיקרוסופט. שם הוא מאשר פעם אחת קריאת מייל (Mail.Read).
 *  • מיקרוסופט מחזירה ל-msCallback קוד חד-פעמי. השרת מחליף אותו במפתח רענון בעזרת הסוד (Secret Manager),
 *    ושומר את המפתח ב-msPriv/mail. לאוסף הזה אין שום הרשאת קריאה מהאפליקציה (חוקי Firestore לא פותחים אותו).
 *  • msPoll רץ כל 5 דקות וקורא רק את התיקייה "חשבוניות" בתיבה (או את השם שהוגדר ב-invmeta/cfg.mailFolder).
 *    כל מייל חדש בתיקייה (גם מייל שנגרר אליה ידנית) הופך לחשבונית "חדשה" בבקרה:
 *      – קובץ PDF/תמונה מצורף → נשמר בחלקים (inv/{id}/parts/{i}, כמו העלאה ידנית). את הפרטים (ספק, סכום וכו')
 *        הבקרה קוראת בדפדפן כשהמשרד פותח את הלשונית.
 *      – בלי קובץ אבל עם קישור לחשבונית (חשבונית ירוקה וכד׳) → מנסים להוריד את ה-PDF מהקישור; לא הצליח → נשמר הקישור.
 *  • שום דבר לא נמחק ולא משתנה בתיבת המייל — ההרשאה היא קריאה בלבד.
 *
 * סודות (Secret Manager): MS_CLIENT_ID, MS_TENANT_ID, MS_CLIENT_SECRET — מוגדרים מהמסוף, לא נמצאים בקוד.
 */
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto");

admin.initializeApp();
const db = admin.firestore();
const FV = admin.firestore.FieldValue;

const MS_ID = defineSecret("MS_CLIENT_ID");
const MS_TENANT = defineSecret("MS_TENANT_ID");
const MS_SECRET = defineSecret("MS_CLIENT_SECRET");
const SECRETS = [MS_ID, MS_TENANT, MS_SECRET];

const REGION = "europe-west1";
const APP = "https://davidkatz0406.github.io/bakaraapp/";
const ORIGINS = ["https://davidkatz0406.github.io", "http://127.0.0.1:8123", "http://localhost:8123"];
const SCOPES = "offline_access User.Read Mail.Read";
const GRAPH = "https://graph.microsoft.com/v1.0";
const PART = 750000;               // בתים לחלק — כמו באפליקציה (מסמך Firestore עד 1MB)
const MAX = 20 * 1024 * 1024;      // קובץ עד 20MB
const PRIV = () => db.doc("msPriv/mail");
const META = () => db.doc("invmeta/mail");

const callbackUrl = () => `https://${REGION}-${process.env.GCLOUD_PROJECT}.cloudfunctions.net/msCallback`;
const sha = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const errText = e => String((e && e.message) || e).slice(0, 300);

/* ───── מי מבקש? רק משתמש משרד פעיל (כמו isOffice בחוקים) ───── */
async function officeUser(req){
  const h = req.get("Authorization") || "";
  if(!h.startsWith("Bearer ")) return null;
  let tok;
  try{ tok = await admin.auth().verifyIdToken(h.slice(7)); }catch(e){ return null; }
  if(!tok.phone_number) return null;
  const s = await db.doc("staff/" + tok.phone_number).get();
  if(!s.exists) return null;
  const d = s.data();
  if(d.active === false || d.role !== "office") return null;
  return { uid: tok.uid, name: d.name || "" };
}

/* ───── מיקרוסופט: החלפת קוד / רענון ───── */
async function tokenCall(params){
  const body = new URLSearchParams({ client_id: MS_ID.value(), client_secret: MS_SECRET.value(), scope: SCOPES, ...params });
  const r = await fetch(`https://login.microsoftonline.com/${MS_TENANT.value()}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
  const j = await r.json().catch(() => ({}));
  if(!r.ok) { const e = new Error(j.error_description || j.error || ("token " + r.status)); e.code = j.error; throw e; }
  return j;
}
async function graph(at, path, opt = {}){
  const r = await fetch(path.startsWith("http") ? path : GRAPH + path, {
    ...opt, headers: { Authorization: "Bearer " + at, Prefer: 'IdType="ImmutableId"', ...(opt.headers || {}) } });
  if(!r.ok){ const t = await r.text().catch(() => ""); throw new Error("Graph " + r.status + " " + t.slice(0, 200)); }
  return opt.raw ? r : r.json();
}

/* ───── התחלת חיבור / ניתוק / בדיקה עכשיו (מהאפליקציה) ───── */
exports.msApi = onRequest({ region: REGION, cors: ORIGINS, secrets: SECRETS, memory: "512MiB", timeoutSeconds: 300 }, async (req, res) => {
  const who = await officeUser(req);
  if(!who) { res.status(403).json({ error: "רק משתמש משרד יכול לחבר את תיבת המייל" }); return; }
  const action = String(req.query.action || req.body?.action || "");
  try{
    if(action === "start"){
      const state = crypto.randomBytes(24).toString("hex");
      await db.doc("msState/" + state).set({ uid: who.uid, name: who.name, exp: Date.now() + 15 * 60e3 });
      const q = new URLSearchParams({ client_id: MS_ID.value(), response_type: "code", redirect_uri: callbackUrl(),
        response_mode: "query", scope: SCOPES, state, prompt: "select_account" });
      res.json({ url: `https://login.microsoftonline.com/${MS_TENANT.value()}/oauth2/v2.0/authorize?` + q });
      return;
    }
    if(action === "stop"){
      await PRIV().delete();
      await META().set({ ok: false, box: "", err: "", stoppedBy: who.name, stoppedAt: FV.serverTimestamp() }, { merge: true });
      res.json({ ok: true }); return;
    }
    if(action === "poll"){ const n = await pollOnce(); res.json({ ok: true, n }); return; }
    res.status(400).json({ error: "פעולה לא מוכרת" });
  }catch(e){ logger.error("msApi", action, e); res.status(500).json({ error: errText(e) }); }
});

/* ───── מיקרוסופט מחזירה לכאן אחרי האישור ───── */
exports.msCallback = onRequest({ region: REGION, secrets: SECRETS, memory: "512MiB", timeoutSeconds: 300 }, async (req, res) => {
  const back = (ok, msg) => res.redirect(APP + "?mail=" + (ok ? "ok" : "err") + (msg ? "&m=" + encodeURIComponent(String(msg).slice(0, 150)) : ""));
  try{
    if(req.query.error) { back(false, req.query.error_description || req.query.error); return; }
    const state = String(req.query.state || ""), code = String(req.query.code || "");
    if(!/^[0-9a-f]{48}$/.test(state) || !code) { back(false, "בקשה לא תקינה"); return; }
    const sref = db.doc("msState/" + state), s = await sref.get();
    await sref.delete().catch(() => {});
    if(!s.exists || s.data().exp < Date.now()) { back(false, "פג תוקף — נסה שוב מהבקרה"); return; }
    const t = await tokenCall({ grant_type: "authorization_code", code, redirect_uri: callbackUrl() });
    if(!t.refresh_token) { back(false, "מיקרוסופט לא החזירה הרשאה קבועה"); return; }
    const me = await graph(t.access_token, "/me?$select=mail,userPrincipalName,displayName");
    const box = (me.mail || me.userPrincipalName || "").toLowerCase();
    await PRIV().set({ refresh: t.refresh_token, box, by: s.data().name, at: FV.serverTimestamp(),
      cursor: new Date(Date.now() - 2 * 864e5).toISOString(), folderId: "", folderName: "" });
    await META().set({ ok: true, box, who: me.displayName || "", by: s.data().name, connectedAt: FV.serverTimestamp(), err: "" }, { merge: true });
    try{ await pollOnce(); }catch(e){ logger.warn("first poll", e); }
    back(true);
  }catch(e){ logger.error("msCallback", e); back(false, errText(e)); }
});

/* ───── כל 5 דקות ───── */
exports.msPoll = onSchedule({ region: REGION, schedule: "every 5 minutes", timeZone: "Asia/Jerusalem", secrets: SECRETS,
  memory: "512MiB", timeoutSeconds: 300, retryCount: 0 }, async () => { await pollOnce(); });

async function pollOnce(){
  const pref = PRIV(), p = await pref.get();
  if(!p.exists || !p.data().refresh) return 0;
  const P = p.data();
  // נעילה קצרה — שלא ירוצו שתי בדיקות במקביל (מתוזמנת + "בדוק עכשיו")
  const locked = await db.runTransaction(async tx => {
    const cur = await tx.get(pref);
    if((cur.data().lock || 0) > Date.now()) return true;
    tx.update(pref, { lock: Date.now() + 4 * 60e3 }); return false;
  });
  if(locked) return 0;
  let n = 0;
  try{
    let t;
    try{ t = await tokenCall({ grant_type: "refresh_token", refresh_token: P.refresh }); }
    catch(e){
      if(e.code === "invalid_grant"){
        await META().set({ ok: false, err: "החיבור לתיבת המייל פג או בוטל — צריך לחבר מחדש מלשונית החשבוניות", last: FV.serverTimestamp() }, { merge: true });
        await pref.update({ refresh: "" });
        return 0;
      }
      throw e;
    }
    if(t.refresh_token && t.refresh_token !== P.refresh) await pref.update({ refresh: t.refresh_token });
    const at = t.access_token;

    // התיקייה
    const cfg = (await db.doc("invmeta/cfg").get()).data() || {};
    const want = String(cfg.mailFolder || "חשבוניות").trim();
    let folderId = P.folderName === want ? P.folderId : "";
    if(!folderId){
      folderId = await findFolder(at, want);
      if(!folderId){
        await META().set({ ok: true, err: `לא מצאתי בתיבה ${P.box} תיקייה בשם "${want}". צריך ליצור אותה ב-Outlook (ולהעביר אליה את מיילי החשבוניות).`, last: FV.serverTimestamp() }, { merge: true });
        return 0;
      }
      await pref.update({ folderId, folderName: want });
    }

    // הודעות שנכנסו לתיקייה (או שהשתנו בה) מאז הבדיקה הקודמת. העברה לתיקייה משנה את lastModifiedDateTime,
    // כך שגם מייל ישן שנגרר לתיקייה ייקלט. כפילויות נחסמות לפי מזהה ההודעה (msSeen).
    const since = new Date(new Date(P.cursor || Date.now() - 864e5).getTime() - 10 * 60e3).toISOString();
    let url = `/me/mailFolders/${folderId}/messages?$filter=lastModifiedDateTime ge ${since}&$orderby=lastModifiedDateTime&$top=40` +
      "&$select=id,subject,from,receivedDateTime,lastModifiedDateTime,hasAttachments,webLink";
    let cursor = P.cursor || since, pages = 0;
    const sups = (await db.collection("invsup").get()).docs.map(d => d.data()).filter(s => s.active !== false);
    while(url && pages++ < 5){
      const j = await graph(at, url);
      for(const m of j.value || []){
        if(m.lastModifiedDateTime > cursor) cursor = m.lastModifiedDateTime;
        const key = sha(m.id).slice(0, 32), seen = db.doc("msSeen/" + key);
        if((await seen.get()).exists) continue;
        try{ n += await takeMessage(at, m, key, sups); }
        catch(e){ logger.error("message", m.subject, e); continue; }   // ננסה שוב בבדיקה הבאה
        await seen.set({ at: FV.serverTimestamp(), subj: String(m.subject || "").slice(0, 120) });
      }
      url = j["@odata.nextLink"] || "";
    }
    await pref.update({ cursor });
    await META().set({ ok: true, err: "", last: FV.serverTimestamp(), ...(n ? { lastNew: FV.serverTimestamp(), lastN: n } : {}) }, { merge: true });
    return n;
  }catch(e){
    logger.error("poll", e);
    await META().set({ err: "שגיאה בקריאת המייל: " + errText(e), last: FV.serverTimestamp() }, { merge: true });
    return n;
  }finally{
    await pref.update({ lock: 0 }).catch(() => {});
  }
}

async function findFolder(at, name){
  const q = "?$filter=" + encodeURIComponent(`displayName eq '${name.replace(/'/g, "''")}'`) + "&$select=id,displayName";
  for(const base of ["/me/mailFolders", "/me/mailFolders/inbox/childFolders"]){
    const j = await graph(at, base + q).catch(() => ({ value: [] }));
    if(j.value && j.value[0]) return j.value[0].id;
  }
  return "";
}

const isPdf = (name, ct) => /\.pdf$/i.test(name || "") || /pdf/i.test(ct || "");
const isImg = (name, ct) => /^image\/(jpe?g|png)$/i.test(ct || "") || /\.(jpe?g|png)$/i.test(name || "");

async function takeMessage(at, m, key, sups){
  const from = String(m.from?.emailAddress?.address || "").toLowerCase();
  const fromName = String(m.from?.emailAddress?.name || "");
  const base = { status: "new", src: "mail", from, fromName, subj: String(m.subject || "").slice(0, 200), mid: m.id,
    mailAt: m.receivedDateTime || "", parsed: false, sup: "", supName: "", supGuess: false, hp: "", no: "", date: "",
    total: null, vat: null, site: "", siteName: "", note: "", hist: [{ s: "new", by: "מייל", t: Date.now() }] };
  const sup = from && sups.find(s => (s.emails || []).includes(from));
  if(sup){ base.sup = sup.id; base.supName = sup.name; base.hp = sup.hp || ""; }

  const files = [];
  if(m.hasAttachments){
    const j = await graph(at, `/me/messages/${m.id}/attachments`);
    for(const a of j.value || []){
      if(a["@odata.type"] !== "#microsoft.graph.fileAttachment" || !a.contentBytes) continue;
      const pdf = isPdf(a.name, a.contentType), img = isImg(a.name, a.contentType);
      if(!pdf && !img) continue;
      if(img && (a.isInline || (a.size || 0) < 30000)) continue;   // לוגו / חתימה במייל
      const bytes = Buffer.from(a.contentBytes, "base64");
      if(bytes.length > MAX) continue;
      files.push({ name: a.name || "חשבונית", mime: pdf ? "application/pdf" : (/png/i.test(a.contentType || a.name) ? "image/png" : "image/jpeg"), bytes });
    }
  }
  // מייל עם חשבונית + מסמכים נלווים (פרטי בנק, אישור ניהול ספרים, ניכוי במקור) — נכנסת רק החשבונית
  const INV_NAME = /חשבונית|חש[ -_.]?\d|\d+ ?חש|קבלה|invoice|receipt|inv[-_ ]?\d/i;
  const SIDE_DOC = /בנק|bank|ניהול ספרים|ניכוי|במקור|עוסק מורשה|תעודת|אישור/i;
  if(files.length > 1 && files.some(f => INV_NAME.test(f.name))){
    const keep = files.filter(f => !SIDE_DOC.test(f.name) || INV_NAME.test(f.name));
    if(keep.length) files.splice(0, files.length, ...keep);
  }
  let link = "";
  if(!files.length){
    // אין קובץ — מחפשים קישור לחשבונית בגוף המייל, ומנסים להוריד ממנו PDF
    const b = await graph(at, `/me/messages/${m.id}?$select=body`, { headers: { Prefer: 'IdType="ImmutableId", outlook.body-content-type="html"' } });
    const links = pickLinks(String(b.body?.content || ""));
    for(const u of links.slice(0, 3)){
      const got = await fetchPdf(u);
      if(got){ files.push({ name: got.name, mime: "application/pdf", bytes: got.bytes, link: u }); break; }
    }
    if(!files.length) link = links[0] || m.webLink || "";
  }

  if(!files.length){
    await db.doc("inv/m_" + key + "_0").set({ ...base, id: "m_" + key + "_0", link, linkOnly: true, parts: 0, parsed: true, at: FV.serverTimestamp() });
    return 1;
  }
  let k = 0;
  for(const f of files){
    const id = "m_" + key + "_" + k++;
    const n = Math.max(1, Math.ceil(f.bytes.length / PART));
    for(let i = 0; i < n; i++) await db.doc(`inv/${id}/parts/${i}`).set({ d: f.bytes.subarray(i * PART, (i + 1) * PART) });
    await db.doc("inv/" + id).set({ ...base, id, fname: f.name, mime: f.mime, parts: n, size: f.bytes.length,
      ...(f.link ? { link: f.link } : {}), ...(files.length > 1 ? { note: `קובץ ${k} מתוך ${files.length} באותו מייל` } : {}), at: FV.serverTimestamp() });
  }
  return files.length;
}

function pickLinks(html){
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi; let m;
  while((m = re.exec(html))){
    const u = m[1].replace(/&amp;/g, "&"), txt = m[2].replace(/<[^>]+>/g, " ");
    if(!/^https:\/\//i.test(u) || /unsubscribe|facebook|instagram|linkedin|twitter|whatsapp|wa\.me|mailto|google\.com\/maps|waze/i.test(u)) continue;
    const score = (/חשבונית|קבלה|מסמך|לצפייה|להורדה|הורד|צפה|invoice|receipt|document|download|view|pdf/i.test(txt) ? 2 : 0)
                + (/invoice|doc|pdf|download|file|receipt|greeninvoice|icount|ezcount|morning|rivhit|sumit|invoice4u/i.test(u) ? 1 : 0);
    if(score) out.push({ u, score });
  }
  return [...new Set(out.sort((a, b) => b.score - a.score).map(x => x.u))];
}

async function fetchPdf(u){
  try{
    const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 15000);
    const r = await fetch(u, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 (invoice fetch)" } });
    clearTimeout(tm);
    if(!r.ok || !/pdf/i.test(r.headers.get("content-type") || "")) return null;
    const len = +(r.headers.get("content-length") || 0); if(len > MAX) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if(bytes.length > MAX || bytes.subarray(0, 5).toString() !== "%PDF-") return null;
    const cd = r.headers.get("content-disposition") || "", nm = (cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i) || [])[1];
    return { bytes, name: nm ? decodeURIComponent(nm) : "חשבונית.pdf" };
  }catch(e){ return null; }
}

/* ───── התראות לטלפון: הזמנת רכש חדשה (טל, שרון, דוד) ─────
 *  • משתמש משרד לוחץ בבקרה במסך "הזמנות פתוחות" על "🔔 הפעל התראות". הטלפון נרשם להתראות (Web Push),
 *    והמנוי נשמר ב-push/{טלפון}.subs (רק המשתמש עצמו כותב, לפי חוקי Firestore).
 *  • סקריפט הרכש (Google Apps Script) קורא ל-notifyOrder כשנרשמת הזמנה חדשה, עם סוד משותף בכותרת X-Notify-Secret.
 *  • נשלחת התראה לכל משתמש משרד פעיל שהפעיל התראות. מנוי שפג תוקפו (404/410) נמחק.
 * סודות (Secret Manager): NOTIFY_SECRET (משותף עם הסקריפט), VAPID_PUBLIC, VAPID_PRIVATE.
 */
const webpush = require("web-push");
const NOTIFY_SECRET = defineSecret("NOTIFY_SECRET");
const VAPID_PUBLIC = defineSecret("VAPID_PUBLIC");
const VAPID_PRIVATE = defineSecret("VAPID_PRIVATE");
const money = n => "₪" + Math.round(Number(n) || 0).toLocaleString("he-IL");
const sameSecret = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** הטקסט של ההתראה (מיוצא לבדיקות) */
function orderMessage(o){
  if(o.kind === "approved") return {   // טל אישר בבקרה — שרון יכולה להעביר לספק
    title: "✅ טל אישר — " + String(o.project || "").slice(0, 60),
    body: [String(o.user || "").slice(0, 40), o.total ? money(o.total) + " כולל מע״מ" : "", "לטיפול שרון"].filter(Boolean).join(" · "),
    tag: "appr-" + String(o.oid || "").slice(0, 40),
    url: APP + "?go=orders"
  };
  const tags = [o.needsApproval ? "ממתינה לאישור טל" : "", o.urgent ? "⚡ דחוף" : ""].filter(Boolean);
  return {
    title: "🛒 הזמנה חדשה — " + String(o.project || "ללא פרויקט").slice(0, 60),
    body: [String(o.user || "").slice(0, 40), o.total ? money(o.total) + " כולל מע״מ" : "", ...tags].filter(Boolean).join(" · "),
    tag: "order-" + String(o.oid || "").slice(0, 40),
    url: APP + "?go=orders"
  };
}
exports.orderMessage = orderMessage;

/** שולח לכל המנויים של משתמשי משרד פעילים. מחזיר {sent, failed, removed} */
async function pushToOffice(msg){
  const snap = await db.collection("push").get();
  let sent = 0, failed = 0, removed = 0;
  for(const d of snap.docs){
    const s = await db.doc("staff/" + d.id).get();
    const st = s.exists ? s.data() : null;
    if(!st || st.active === false || st.role !== "office") continue;
    const subs = d.data().subs || {};
    for(const [k, sub] of Object.entries(subs)){
      try{
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, JSON.stringify(msg), { TTL: 86400, urgency: "high" });
        sent++;
      }catch(e){
        if(e.statusCode === 404 || e.statusCode === 410){ await d.ref.update({ ["subs." + k]: FV.delete() }).catch(() => {}); removed++; }
        else { failed++; logger.warn("push", d.id, e.statusCode, errText(e)); }
      }
    }
  }
  return { sent, failed, removed };
}

exports.notifyOrder = onRequest({ region: REGION, secrets: [NOTIFY_SECRET, VAPID_PUBLIC, VAPID_PRIVATE], memory: "256MiB", timeoutSeconds: 60 }, async (req, res) => {
  if(req.method !== "POST" || !sameSecret(req.get("X-Notify-Secret") || "", NOTIFY_SECRET.value())) { res.status(403).json({ error: "forbidden" }); return; }
  try{
    webpush.setVapidDetails("https://davidkatz0406.github.io/bakaraapp/", VAPID_PUBLIC.value(), VAPID_PRIVATE.value());
    const o = req.body || {};
    const r = await pushToOffice(orderMessage(o));
    logger.info("notifyOrder", o.oid, r);
    res.json({ ok: true, ...r });
  }catch(e){ logger.error("notifyOrder", e); res.status(500).json({ error: errText(e) }); }
});
