// CBSystem multi-tenant gateway. Deploy as Edge Function named exactly: cbs-biz
// Settings: "Verify JWT with legacy secret" OFF.  Secret required: ADMIN_KEY (30+ random characters).
// Optional secrets for payslip emails: RESEND_KEY, MAIL_FROM  (e.g. Payroll <pay@cbsystem.co.uk>)
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const ADMIN = Deno.env.get("ADMIN_KEY") ?? "";
const enc = new TextEncoder();
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const out = (o: unknown, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
const err = (m: string, s = 400) => out({ error: m }, s);

/* ---------- crypto helpers ---------- */
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function H(kind: string, v: string, salt: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode(kind + ":" + v), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 60000 }, k, 256));
}
const rnd = (n: number, al: string) =>
  [...crypto.getRandomValues(new Uint32Array(n))].map((x) => al[x % al.length]).join("");
const same = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
async function hmac(s: string) {
  const k = await crypto.subtle.importKey("raw", enc.encode("tok:" + ADMIN),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(s)));
}
async function mint(p: any) {
  const b = btoa(JSON.stringify({ ...p, exp: Date.now() + 12 * 36e5 }));
  return b + "." + await hmac(b);
}
async function check(t: any) {
  const [b, s] = String(t || "").split(".");
  if (!b || !s || !same(s, await hmac(b))) return null;
  try { const p = JSON.parse(atob(b)); return p.exp > Date.now() ? p : null; } catch { return null; }
}
const KEYAL = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", DIG = "0123456789";

/* ---------- entry ---------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (ADMIN.length < 20) return err("ADMIN_KEY secret is missing or too short", 500);
  let q: any;
  try { q = await req.json(); } catch { return err("bad request"); }
  try { return await route(q); } catch (e) { console.error(e); return err("server error", 500); }
});

async function route(q: any) {
  const a = q.a;
  if (a === "info") return info(q);
  if (["create", "list", "reset", "toggle"].includes(a)) {
    if (!same(String(q.admin || ""), ADMIN)) return err("Wrong admin key", 403);
    return adminOp(q);
  }
  if (a === "login") return login(q);

  const t = await check(q.token);
  if (!t) return err("Session expired", 401);
  const { data: biz } = await db.from("cbs_biz").select("*").eq("id", t.b).maybeSingle();
  if (!biz || !biz.active) return err("Business disabled", 403);

  switch (a) {
    case "pull": return pull(t);
    case "put": return put(t, q);
    case "del": {
      if (t.r === "s") return err("Managers only", 403);
      const id = String(q.id || "");
      if (!id || id === "cfg") return err("not allowed", 403);
      await db.from("cbs_rows").delete().eq("biz", t.b).eq("id", id);
      return out({ ok: 1 });
    }
    case "setpin": {
      if (t.r !== "o") return err("Owner only", 403);
      const pin = String(q.pin || ""), which = q.which === "owner" ? "owner" : "manager";
      if (!/^\d{6}$/.test(pin)) return err("PIN must be 6 digits");
      const other = which === "owner" ? biz.mgr_hash : biz.owner_hash;
      if (same(await H(which === "owner" ? "manager" : "owner", pin, biz.salt), other)) return err("Owner and Manager PINs must differ");
      await db.from("cbs_biz").update(which === "owner"
        ? { owner_hash: await H("owner", pin, biz.salt) }
        : { mgr_hash: await H("manager", pin, biz.salt) }).eq("id", biz.id);
      return out({ ok: 1 });
    }
    case "mail": {
      if (t.r === "s") return err("Managers only", 403);
      const k = Deno.env.get("RESEND_KEY"), from = Deno.env.get("MAIL_FROM");
      if (!k || !from) return err("Email is not set up (RESEND_KEY / MAIL_FROM secrets)", 501);
      const to = String(q.to || "");
      if (!/^[^@\s]+@[^@\s]+$/.test(to)) return err("bad email address");
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + k, "Content-Type": "application/json" },
        body: JSON.stringify({
          from, to, subject: String(q.subject || "").slice(0, 200), html: String(q.html || "").slice(0, 20000),
          attachments: q.pdf ? [{ filename: String(q.name || "payslip.pdf"), content: q.pdf }] : undefined,
        }),
      });
      return r.ok ? out({ ok: 1 }) : err("Email provider refused: " + (await r.text()).slice(0, 200), 502);
    }
  }
  return err("unknown action");
}

/* ---------- public: venue name + logo for the customer page and staff login screen ---------- */
async function info(q: any) {
  const id = String(q.b || "").toLowerCase();
  const { data: b } = await db.from("cbs_biz").select("id,name,active").eq("id", id).maybeSingle();
  if (!b || !b.active) return err("Business not found", 404);
  const { data: c } = await db.from("cbs_rows").select("data").eq("biz", id).eq("id", "cfg").maybeSingle();
  const cfg = c?.data?.cfg || {};
  return out({ id: b.id, name: cfg.venue && cfg.venue !== "My Venue" ? cfg.venue : b.name, logo: cfg.logo || "" });
}

/* ---------- admin (needs ADMIN_KEY) ---------- */
async function adminOp(q: any) {
  if (q.a === "list") {
    const { data } = await db.from("cbs_biz").select("id,name,active,created_at").order("created_at", { ascending: false });
    return out({ list: data || [] });
  }
  if (q.a === "create") {
    const name = String(q.name || "").trim().slice(0, 80);
    const id = String(q.id || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 38);
    if (!name || !/^[a-z0-9][a-z0-9-]{1,37}$/.test(id)) return err("Name needed, and id must be 2-38 letters, digits or hyphens");
    const { data: ex } = await db.from("cbs_biz").select("id").eq("id", id).maybeSingle();
    if (ex) return err("That id is already used");
    const key = rnd(32, KEYAL), owner = rnd(6, DIG);
    let mgr = rnd(6, DIG);
    while (mgr === owner) mgr = rnd(6, DIG);
    const salt = rnd(24, "abcdef0123456789");
    const { error } = await db.from("cbs_biz").insert({
      id, name, salt,
      key_hash: await H("key", key, salt),
      owner_hash: await H("owner", owner, salt),
      mgr_hash: await H("manager", mgr, salt),
    });
    if (error) throw error;
    return out({ id, name, key, owner, manager: mgr });
  }
  const id = String(q.id || "").toLowerCase();
  const { data: b } = await db.from("cbs_biz").select("*").eq("id", id).maybeSingle();
  if (!b) return err("Business not found", 404);
  if (q.a === "toggle") {
    await db.from("cbs_biz").update({ active: !!q.active }).eq("id", id);
    return out({ ok: 1 });
  }
  if (q.a === "reset") {
    let value: string, patch: any;
    if (q.what === "key") { value = rnd(32, KEYAL); patch = { key_hash: await H("key", value, b.salt) }; }
    else if (q.what === "owner") { value = rnd(6, DIG); patch = { owner_hash: await H("owner", value, b.salt) }; }
    else if (q.what === "manager") { value = rnd(6, DIG); patch = { mgr_hash: await H("manager", value, b.salt) }; }
    else return err("bad request");
    await db.from("cbs_biz").update({ ...patch, fails: 0, locked_until: null }).eq("id", id);
    return out({ id, what: q.what, value });
  }
  return err("unknown action");
}

/* ---------- login ---------- */
async function fail(b: any, msg: string) {
  const f = (b.fails || 0) + 1;
  await db.from("cbs_biz").update(f >= 8
    ? { fails: 0, locked_until: new Date(Date.now() + 10 * 60e3).toISOString() }
    : { fails: f }).eq("id", b.id);
  return err(msg, 403);
}
async function login(q: any) {
  const id = String(q.b || "").toLowerCase();
  const { data: b } = await db.from("cbs_biz").select("*").eq("id", id).maybeSingle();
  if (!b || !b.active) return err("Business not found or disabled", 403);
  // Wrong staff key is reported separately and does not count towards the PIN lock-out.
  if (!same(await H("key", String(q.key || "").trim().toUpperCase(), b.salt), b.key_hash)) return err("Wrong staff key", 403);
  if (b.locked_until && new Date(b.locked_until) > new Date()) return err("Too many wrong PINs. Try again in 10 minutes.", 429);
  const pin = String(q.pin || "");
  let r = "", user: any = null, sid = "";
  if (q.role === "o" || q.role === "m") {
    const ok = same(await H(q.role === "o" ? "owner" : "manager", pin, b.salt), q.role === "o" ? b.owner_hash : b.mgr_hash);
    if (!ok) return fail(b, "Wrong PIN");
    r = q.role;
    user = q.role === "o" ? { id: "owner", name: "Owner", role: "m", owner: 1 } : { id: "mgr", name: "Manager", role: "m" };
    sid = user.id;
  } else {
    const { data: rows } = await db.from("cbs_rows").select("data").eq("biz", id).eq("tbl", "staff").eq("data->>lid", String(q.id || ""));
    const s = (rows || []).map((x: any) => x.data).find((d: any) => d.pin && String(d.pin) === pin);
    if (!s) return fail(b, "Wrong ID or PIN");
    r = s.role === "m" ? "m" : "s";
    sid = s.id;
    user = { ...s, pin: undefined };
  }
  if (b.fails) await db.from("cbs_biz").update({ fails: 0 }).eq("id", id);
  return out({ token: await mint({ b: id, r, sid }), user, name: b.name });
}

/* ---------- data ---------- */
async function pull(t: any) {
  let rows: any[] = [];
  for (let i = 0; ; i += 1000) {
    const { data, error } = await db.from("cbs_rows").select("id,tbl,data").eq("biz", t.b).order("id").range(i, i + 999);
    if (error) throw error;
    rows = rows.concat(data);
    if (data.length < 1000) break;
  }
  if (t.r !== "s") return out({ rows });
  // Ordinary staff only get: the shared config, everyone's holidays (reason hidden), and their own records. No PINs.
  const mine = rows.filter((r) => {
    if (r.tbl === "cfg" || r.tbl === "hol") return true;
    if (r.tbl === "staff") return r.id === t.sid;
    return r.data?.sid === t.sid;
  }).map((r) => {
    if (r.tbl === "staff") return { ...r, data: { ...r.data, pin: undefined } };
    if (r.tbl === "hol" && r.data?.sid !== t.sid) return { ...r, data: { ...r.data, reason: "" } };
    return r;
  });
  return out({ rows: mine });
}

async function put(t: any, q: any) {
  const r = q.row;
  if (!r || typeof r !== "object" || typeof r.id !== "string" || !r.id || r.id.length > 64 ||
      typeof r.t !== "string" || !/^[a-z]{2,8}$/.test(r.t)) return err("bad row");
  if (JSON.stringify(r).length > 400000) return err("row too large");
  const { data: old } = await db.from("cbs_rows").select("tbl,data").eq("biz", t.b).eq("id", r.id).maybeSingle();
  if (t.r === "s") {
    // Staff may only ADD their own clock events and pending holiday requests.
    if (old) return err("Not allowed", 403);
    if (!["clk", "hol"].includes(r.t) || r.sid !== t.sid) return err("Not allowed", 403);
    if (r.t === "hol" && r.st !== "p") return err("Not allowed", 403);
    if (r.t === "clk") {
      if (!["in", "out"].includes(r.type)) return err("bad row");
      r.ts = Date.now(); // server time, so phone clocks can't be changed to fake hours
    }
  } else if (t.r !== "o") {
    if (r.t === "cfg") return err("Owner only", 403);
    if (r.t === "staff" && (r.role === "m" || old?.data?.role === "m")) return err("Owner only", 403);
  }
  const { error } = await db.from("cbs_rows").upsert(
    { biz: t.b, id: r.id, tbl: r.t, data: r, updated_at: new Date().toISOString() }, { onConflict: "biz,id" });
  if (error) throw error;
  return out({ ok: 1 });
}
