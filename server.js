// ─── CARE2LEARN BACKEND SERVER ────────────────────────────────────────────────
// Pure Node.js (built-in http + node:sqlite). No external dependencies.
//   node server.js   →   http://localhost:3000

import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  db, initSchema, seedDemo, hashPassword, verifyPassword,
  genId, genToken, genPin, genPassword, genReferralCode, backfillReferralCodes,
} from "./db.js";
import { COURSES, COURSE_IDS, COURSE_MAP } from "./courses.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

initSchema();
seedDemo();
backfillReferralCodes(); // ensure freshly-seeded accounts also have referral codes

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function send(res, status, data, headers = {}) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
  });
}

function getToken(req) {
  const auth = req.headers["authorization"] || "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

function authSession(req) {
  const token = getToken(req);
  if (!token) return null;
  return db.prepare("SELECT * FROM sessions WHERE token = ?").get(token) || null;
}

// Minimal HTML escaping for values placed into email bodies.
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// The app's public base URL, for building links inside emails.
// Uses APP_URL if set, otherwise derives it from the incoming request headers
// (Render sets x-forwarded-proto / host), so reset links work on both the
// onrender.com URL and a custom domain without any extra configuration.
function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, "");
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers["host"] || ("localhost:" + PORT);
  return proto + "://" + host;
}

// ─── EMAIL (transactional) ─────────────────────────────────────────────────
// Sends mail via Resend when configured (env: RESEND_API_KEY, optionally
// EMAIL_FROM). When NOT configured, it logs the message to the server console
// so flows can be tested end-to-end before email is wired up. Never throws.
async function sendEmail({ to, subject, text, html }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM || "Care2Learn <onboarding@resend.dev>";
  if (!key) {
    console.log("\n📧 EMAIL (no email provider configured — this is what WOULD be sent):");
    console.log("   To:      " + to);
    console.log("   Subject: " + subject);
    console.log("   ----");
    console.log("   " + String(text || "").replace(/\n/g, "\n   "));
    console.log("");
    return { sent: false, reason: "not_configured" };
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, text, html: html || undefined }),
    });
    if (!r.ok) {
      const msg = await r.text().catch(() => "");
      console.error("✉️  Email send failed (" + r.status + "): " + msg.slice(0, 300));
      return { sent: false, reason: "provider_error" };
    }
    return { sent: true };
  } catch (e) {
    console.error("✉️  Email send threw: " + e.message);
    return { sent: false, reason: "exception" };
  }
}

function addYear(dateStr) {
  const d = new Date(dateStr);
  d.setFullYear(d.getFullYear() + 1);
  return d.toISOString().split("T")[0];
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24));
}

// Shape an enrolment row with derived compliance info
function shapeEnrolment(row) {
  const course = COURSE_MAP[row.course_id];
  const days = daysUntil(row.expiry_date);
  let compliance = "not_started";
  if (row.status === "completed") {
    if (days === null) compliance = "valid";
    else if (days <= 0) compliance = "expired";
    else if (days <= 30) compliance = "expiring";
    else compliance = "valid";
  } else if (row.status === "in_progress") compliance = "in_progress";
  else if (row.status === "failed") compliance = "failed";
  return {
    id: row.id,
    courseId: row.course_id,
    courseTitle: course ? course.title : row.course_id,
    courseIcon: course ? course.icon : "📘",
    courseColor: course ? course.color : "#555",
    assignedAt: row.assigned_at,
    dueDate: row.due_date,
    status: row.status,
    progress: row.progress,
    score: row.score,
    attempts: row.attempts,
    completedAt: row.completed_at,
    expiryDate: row.expiry_date,
    certId: row.cert_id,
    daysUntilExpiry: days,
    compliance,
  };
}

// ─── AUTOMATED TRAINING REMINDERS ───────────────────────────────────────────
// A lightweight daily scheduler (no external cron needed) emails learners whose
// training is expired, expiring soon, or overdue, and sends managers a periodic
// digest. Sends are throttled per-recipient so nobody is emailed more than once
// per cooldown window, and the whole feature is opt-out per organisation.
const REMINDER_HOUR = Number(process.env.REMINDER_HOUR || 8);   // hour (UTC on Render) to run the daily sweep
const REMINDER_COOLDOWN_DAYS = 7;                               // minimum gap between reminders to the same recipient

function appBase() {
  return process.env.APP_URL ? process.env.APP_URL.replace(/\/+$/, "") : "https://care2learn.co.uk";
}
function todayStr() { return new Date().toISOString().split("T")[0]; }
function daysSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity; }

// Record that a reminder was just sent (manual upsert — avoids ON CONFLICT for driver portability).
function markReminded(subjectId, kind) {
  const now = new Date().toISOString();
  const u = db.prepare("UPDATE reminder_log SET last_sent_at = ? WHERE subject_id = ? AND kind = ?").run(now, subjectId, kind);
  if (!u.changes) db.prepare("INSERT INTO reminder_log (subject_id, kind, last_sent_at) VALUES (?, ?, ?)").run(subjectId, kind, now);
}
function lastReminded(subjectId, kind) {
  const row = db.prepare("SELECT last_sent_at FROM reminder_log WHERE subject_id = ? AND kind = ?").get(subjectId, kind);
  return row ? row.last_sent_at : null;
}

// The courses that need a given learner's attention right now.
function attentionItems(staffId) {
  const today = todayStr();
  const items = [];
  for (const row of db.prepare("SELECT * FROM enrolments WHERE staff_id = ?").all(staffId)) {
    const e = shapeEnrolment(row);
    if (e.compliance === "expired") items.push({ title: e.courseTitle, reason: "Expired" });
    else if (e.compliance === "expiring") items.push({ title: e.courseTitle, reason: `Expires in ${e.daysUntilExpiry} day${e.daysUntilExpiry === 1 ? "" : "s"}` });
    else if (row.status !== "completed" && row.due_date && row.due_date < today) items.push({ title: e.courseTitle, reason: "Overdue" });
  }
  return items;
}

// A manager can nudge the same carer at most once every this many days.
const NUDGE_COOLDOWN_DAYS = 7;

// Outstanding training for a MANUAL manager nudge. Broader than attentionItems:
// includes not-started / in-progress / failed too, since the manager is choosing
// to reach out — anything that isn't completed-and-in-date is listed.
function outstandingForNudge(staffId) {
  const today = todayStr();
  const items = [];
  for (const row of db.prepare("SELECT * FROM enrolments WHERE staff_id = ?").all(staffId)) {
    const e = shapeEnrolment(row);
    if (e.compliance === "valid") continue; // already done and in date
    let reason;
    if (e.compliance === "expired") reason = "Expired — needs renewing";
    else if (e.compliance === "expiring") reason = `Expires in ${e.daysUntilExpiry} day${e.daysUntilExpiry === 1 ? "" : "s"}`;
    else if (e.compliance === "in_progress") reason = "In progress";
    else if (e.compliance === "failed") reason = "Needs another attempt";
    else if (row.due_date && row.due_date < today) reason = "Overdue";
    else if (row.due_date) { const d = daysUntil(row.due_date); reason = `Due in ${d} day${d === 1 ? "" : "s"}`; }
    else reason = "Not started";
    items.push({ title: e.courseTitle, reason });
  }
  return items;
}

async function sendStaffNudge(org, member, items) {
  const link = appBase();
  const lines = items.map((i) => `• ${i.title} — ${i.reason}`).join("\n");
  const text = `Hi ${member.name},\n\n${org.name} would like you to complete your outstanding training on Care2Learn:\n\n${lines}\n\nLog in to get started:\n${link}\n\nThank you,\n${org.name}`;
  const li = items.map((i) => `<li><b>${escapeHtml(i.title)}</b> — ${escapeHtml(i.reason)}</li>`).join("");
  const html = `<div style="font-family:'Segoe UI',system-ui,sans-serif;color:#1A1A2E;line-height:1.6;max-width:560px">
    <p>Hi ${escapeHtml(member.name)},</p>
    <p><b>${escapeHtml(org.name)}</b> would like you to complete your outstanding training on Care2Learn:</p>
    <ul>${li}</ul>
    <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 22px;background:#1B2A4A;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Log in to Care2Learn</a></p>
    <p style="color:#5A6474">Thank you,<br>${escapeHtml(org.name)}</p>
  </div>`;
  return sendEmail({ to: member.email, subject: "A reminder to complete your training", text, html });
}

// Summarise an org's active team for the manager digest.
function managerDigest(org) {
  const staff = db.prepare("SELECT * FROM staff WHERE org_id = ? AND active = 1").all(org.id);
  let compliant = 0;
  const flagged = [];
  for (const m of staff) {
    const enr = db.prepare("SELECT * FROM enrolments WHERE staff_id = ?").all(m.id).map(shapeEnrolment);
    if (enr.length && enr.every((e) => e.compliance === "valid")) compliant++;
    const items = attentionItems(m.id);
    if (items.length) flagged.push({ name: m.name, count: items.length });
  }
  return { total: staff.length, compliant, flagged };
}

async function sendStaffReminder(org, member, items) {
  const link = appBase();
  const lines = items.map((i) => `• ${i.title} — ${i.reason}`).join("\n");
  const text = `Hi ${member.name},\n\nThis is a reminder from ${org.name} that the following training needs your attention:\n\n${lines}\n\nPlease log in to Care2Learn to complete it:\n${link}\n\nThank you,\n${org.name}`;
  const li = items.map((i) => `<li><b>${escapeHtml(i.title)}</b> — ${escapeHtml(i.reason)}</li>`).join("");
  const html = `<div style="font-family:'Segoe UI',system-ui,sans-serif;color:#1A1A2E;line-height:1.6;max-width:560px">
    <p>Hi ${escapeHtml(member.name)},</p>
    <p>This is a reminder from <b>${escapeHtml(org.name)}</b> that the following training needs your attention:</p>
    <ul>${li}</ul>
    <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 22px;background:#1B2A4A;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Log in to Care2Learn</a></p>
    <p style="color:#5A6474">Thank you,<br>${escapeHtml(org.name)}</p>
  </div>`;
  return sendEmail({ to: member.email, subject: "Training reminder — action needed", text, html });
}

async function sendManagerDigest(org, digest) {
  const link = appBase();
  const flaggedTxt = digest.flagged.length
    ? digest.flagged.map((f) => `• ${f.name} — ${f.count} course${f.count === 1 ? "" : "s"} need attention`).join("\n")
    : "• Everyone is up to date — nothing needs attention right now.";
  const text = `Hi ${org.name},\n\nYour Care2Learn team training summary:\n\n• ${digest.compliant} of ${digest.total} active staff fully compliant\n• ${digest.flagged.length} staff need attention\n\n${flaggedTxt}\n\nOpen your compliance dashboard:\n${link}\n\nCare2Learn`;
  const flaggedHtml = digest.flagged.length
    ? `<ul>${digest.flagged.map((f) => `<li><b>${escapeHtml(f.name)}</b> — ${f.count} course${f.count === 1 ? "" : "s"} need attention</li>`).join("")}</ul>`
    : `<p style="color:#1A5732">Everyone is up to date — nothing needs attention right now.</p>`;
  const html = `<div style="font-family:'Segoe UI',system-ui,sans-serif;color:#1A1A2E;line-height:1.6;max-width:560px">
    <p>Hi ${escapeHtml(org.name)},</p>
    <p>Your Care2Learn team training summary:</p>
    <ul>
      <li><b>${digest.compliant}</b> of <b>${digest.total}</b> active staff fully compliant</li>
      <li><b>${digest.flagged.length}</b> staff need attention</li>
    </ul>
    ${flaggedHtml}
    <p><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 22px;background:#1B2A4A;color:#fff;border-radius:10px;text-decoration:none;font-weight:700">Open compliance dashboard</a></p>
    <p style="color:#5A6474">Care2Learn</p>
  </div>`;
  return sendEmail({ to: org.email, subject: "Your team training summary", text, html });
}

// Run the reminder sweep across every opted-in organisation.
async function runReminderJob({ force = false } = {}) {
  let staffSent = 0, mgrSent = 0;
  try {
    const orgs = db.prepare("SELECT * FROM organisations WHERE active = 1 AND reminders_enabled = 1").all();
    for (const org of orgs) {
      const staff = db.prepare("SELECT * FROM staff WHERE org_id = ? AND active = 1").all(org.id);
      for (const m of staff) {
        if (!m.email) continue;
        const items = attentionItems(m.id);
        if (!items.length) continue;
        if (!force && daysSince(lastReminded(m.id, "staff")) < REMINDER_COOLDOWN_DAYS) continue;
        await sendStaffReminder(org, m, items);
        markReminded(m.id, "staff");
        staffSent++;
      }
      const digest = managerDigest(org);
      if (org.email && digest.flagged.length) {
        if (force || daysSince(lastReminded(org.id, "manager")) >= REMINDER_COOLDOWN_DAYS) {
          await sendManagerDigest(org, digest);
          markReminded(org.id, "manager");
          mgrSent++;
        }
      }
    }
    console.log(`🔔 Reminder job complete — ${staffSent} learner reminder(s), ${mgrSent} manager digest(s).`);
  } catch (e) {
    console.error("🔔 Reminder job error: " + e.message);
  }
  return { staffSent, mgrSent };
}

// Hourly tick that fires the daily job once, after REMINDER_HOUR.
function startReminderScheduler() {
  const TICK_MS = 60 * 60 * 1000;
  const tick = () => {
    try {
      if (new Date().getUTCHours() < REMINDER_HOUR) return;
      const today = todayStr();
      const last = db.prepare("SELECT value FROM system_state WHERE key = 'reminders_last_run'").get();
      if (last && last.value === today) return;
      // Claim today's run first so a restart mid-job can't double-send.
      const u = db.prepare("UPDATE system_state SET value = ? WHERE key = 'reminders_last_run'").run(today);
      if (!u.changes) db.prepare("INSERT INTO system_state (key, value) VALUES ('reminders_last_run', ?)").run(today);
      runReminderJob();
    } catch (e) {
      console.error("🔔 Reminder scheduler tick error: " + e.message);
    }
  };
  setInterval(tick, TICK_MS);
  console.log(`🔔 Reminder scheduler started (daily after ${String(REMINDER_HOUR).padStart(2, "0")}:00 UTC).`);
}

// ─── ROUTE HANDLERS ───────────────────────────────────────────────────────────

const routes = [];
function route(method, pattern, handler) {
  // pattern like "/api/staff/:id/enrolments"
  const keys = [];
  const regex = new RegExp("^" + pattern.replace(/:[^/]+/g, (m) => {
    keys.push(m.slice(1));
    return "([^/]+)";
  }) + "$");
  routes.push({ method, regex, keys, handler });
}

// ── PUBLIC: course catalogue ──
route("GET", "/api/courses", async (req, res) => {
  send(res, 200, { courses: COURSES });
});

route("GET", "/api/health", async (req, res) => {
  send(res, 200, { ok: true, time: new Date().toISOString() });
});

// ── PUBLIC: demo / contact-form enquiries from the marketing site ──
// Stores the enquiry so no lead is lost, and logs it to the console (visible in
// Render logs) for immediate visibility. Email delivery can be added later once
// the Resend integration is configured.
route("POST", "/api/contact", async (req, res) => {
  const b = await readBody(req);
  const name = (b.name || "").toString().trim();
  const email = (b.email || "").toString().trim();
  const org = (b.org || "").toString().trim();
  const message = (b.message || "").toString().trim();
  if (!name || !email) return send(res, 400, { error: "Please add your name and email so we can get back to you." });
  if (!/.+@.+\..+/.test(email)) return send(res, 400, { error: "That email address doesn't look right — please check it." });
  if (name.length > 200 || email.length > 200 || org.length > 200 || message.length > 4000) {
    return send(res, 400, { error: "That's a bit longer than expected — please shorten your message." });
  }
  const id = genId("ENQ");
  db.prepare(`INSERT INTO enquiries (id,name,email,org,message,created_at) VALUES (?,?,?,?,?,?)`)
    .run(id, name, email, org || null, message || null, new Date().toISOString());
  console.log(`📩 DEMO ENQUIRY — ${name} <${email}>${org ? " · " + org : ""}${message ? "\n   “" + message.slice(0, 300) + "”" : ""}`);
  send(res, 201, { ok: true });
});

// ── PUBLIC: pay-as-you-go Stripe checkout ──
// Creates a Stripe Checkout Session for the exact amount the calculator shows:
// £4 per course, per learner → quantity = learners × courses at £4 each.
// Needs the STRIPE_SECRET_KEY environment variable set (e.g. on Render).
const PAYG_PENCE_PER_COURSE_PER_LEARNER = 400; // £4 — keep in sync with PRICING.paygPerCourse in public/app.js

function createStripeCheckout(form) {
  return new Promise((resolve, reject) => {
    const body = form.toString();
    const sreq = https.request({
      hostname: "api.stripe.com",
      path: "/v1/checkout/sessions",
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.STRIPE_SECRET_KEY,
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (sres) => {
      let data = "";
      sres.on("data", (c) => (data += c));
      sres.on("end", () => {
        let json;
        try { json = JSON.parse(data); } catch { return reject(new Error("Invalid response from Stripe")); }
        if (sres.statusCode >= 200 && sres.statusCode < 300) resolve(json);
        else reject(new Error((json.error && json.error.message) || ("Stripe error " + sres.statusCode)));
      });
    });
    sreq.on("error", reject);
    sreq.write(body);
    sreq.end();
  });
}

// Retrieve a Checkout Session from Stripe (used to verify a payment when the buyer
// returns to the app, as a reliable backup to the webhook).
function retrieveStripeSession(sessionId) {
  return new Promise((resolve, reject) => {
    const sreq = https.request({
      hostname: "api.stripe.com",
      path: "/v1/checkout/sessions/" + encodeURIComponent(sessionId),
      method: "GET",
      headers: { "Authorization": "Bearer " + process.env.STRIPE_SECRET_KEY },
    }, (sres) => {
      let data = "";
      sres.on("data", (c) => (data += c));
      sres.on("end", () => {
        let json;
        try { json = JSON.parse(data); } catch { return reject(new Error("Invalid response from Stripe")); }
        if (sres.statusCode >= 200 && sres.statusCode < 300) resolve(json);
        else reject(new Error((json.error && json.error.message) || ("Stripe error " + sres.statusCode)));
      });
    });
    sreq.on("error", reject);
    sreq.end();
  });
}

route("POST", "/api/checkout/payg", async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return send(res, 503, { error: "not_configured" });

  const b = await readBody(req);

  // Two ways in: a direct credit top-up ({ credits: N }), or the landing calculator
  // ({ learners, courses }). Both buy the same £4 course-access units.
  let quantity, description, learners = null, courses = null;
  if (b.credits != null) {
    quantity = Math.floor(Number(b.credits));
    if (!Number.isFinite(quantity) || quantity < 1 || quantity > 5000)
      return send(res, 400, { error: "Please choose a valid number of credits (1–5000)." });
    description = quantity + " course credit" + (quantity === 1 ? "" : "s") + " — each covers one course for one carer";
  } else {
    learners = Math.floor(Number(b.learners));
    courses = Math.floor(Number(b.courses));
    if (!Number.isFinite(learners) || !Number.isFinite(courses) ||
        learners < 1 || courses < 1 || learners > 5000 || courses > COURSE_IDS.length) {
      return send(res, 400, { error: "Please choose a valid number of learners and courses." });
    }
    quantity = learners * courses;
    description = learners + " learner(s) × " + courses + " course(s)";
  }
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = proto + "://" + (req.headers["host"] || "localhost");

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", base + "/app?checkout=success&session_id={CHECKOUT_SESSION_ID}");
  form.set("cancel_url", base + "/app?checkout=cancelled");
  form.set("line_items[0][quantity]", String(quantity));
  form.set("line_items[0][price_data][currency]", "gbp");
  form.set("line_items[0][price_data][unit_amount]", String(PAYG_PENCE_PER_COURSE_PER_LEARNER));
  form.set("line_items[0][price_data][product_data][name]", "Care2Learn — pay-as-you-go course access");
  form.set("line_items[0][price_data][product_data][description]", description);
  if (learners != null) { form.set("metadata[learners]", String(learners)); form.set("metadata[courses]", String(courses)); }

  // If the buyer is signed in (a company or a self-employed individual), tag the session
  // with their account id and the number of credits to grant, so the Stripe webhook can
  // top up their balance automatically once payment succeeds.
  let accountId = null;
  const sess = authSession(req);
  if (sess) {
    if (sess.kind === "org") accountId = sess.subject_id;
    else if (sess.kind === "staff") {
      const st = db.prepare("SELECT org_id FROM staff WHERE id = ?").get(sess.subject_id);
      if (st) accountId = st.org_id;
    }
  }
  if (accountId) {
    form.set("client_reference_id", accountId);
    form.set("metadata[account_id]", accountId);
    form.set("metadata[credits]", String(quantity));
  }

  try {
    const session = await createStripeCheckout(form);
    if (!session.url) return send(res, 502, { error: "Stripe did not return a checkout URL." });
    send(res, 200, { url: session.url });
  } catch (e) {
    console.error("Stripe checkout error:", e.message);
    send(res, 502, { error: "Could not start checkout. Please try again." });
  }
});

// ── Reconcile a checkout the instant the buyer returns to the app ──
// A reliable backup to the webhook: we ask Stripe directly whether the session was paid,
// then apply the same effect (credits or subscription) the webhook would. Idempotent via
// grantStripeCredits, so it's safe even if the webhook also fires for the same session.
route("POST", "/api/checkout/confirm", async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return send(res, 503, { error: "not_configured" });
  const sess = authSession(req);
  if (!sess) return send(res, 401, { error: "Not authenticated." });

  // Resolve the caller's account (an organisation, or a self-employed individual's account).
  let accountId = null;
  if (sess.kind === "org") accountId = sess.subject_id;
  else if (sess.kind === "staff") {
    const st = db.prepare("SELECT org_id FROM staff WHERE id = ?").get(sess.subject_id);
    if (st) accountId = st.org_id;
  }
  if (!accountId) return send(res, 400, { error: "No account to credit." });

  const b = await readBody(req);
  const sessionId = String(b.sessionId || "").trim();
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return send(res, 400, { error: "Invalid session id." });

  let session;
  try { session = await retrieveStripeSession(sessionId); }
  catch (e) { console.error("Checkout confirm — retrieve failed:", e.message); return send(res, 502, { error: "Could not verify the payment yet. Please refresh in a moment." }); }

  const paid = session.payment_status === "paid" || session.status === "complete";
  if (!paid) return send(res, 200, { ok: true, pending: true });

  if (session.mode === "subscription") {
    if (session.client_reference_id === accountId) {
      try { markSubscriptionActive(accountId, session.subscription, session.customer); }
      catch (e) { console.error("Confirm subscription failed:", e.message); }
    }
    return send(res, 200, { ok: true, mode: "subscription", subscribed: true });
  }

  // One-off credit purchase: only honour a session that was tagged for THIS account.
  const tagged = session.metadata && session.metadata.account_id;
  const credits = parseInt((session.metadata && session.metadata.credits) || "0", 10);
  if (tagged !== accountId) return send(res, 200, { ok: true, mismatch: true });
  const before = ((db.prepare("SELECT credits FROM organisations WHERE id = ?").get(accountId)) || {}).credits || 0;
  if (Number.isFinite(credits) && credits > 0) {
    try { grantStripeCredits(session.id, accountId, credits); }
    catch (e) { console.error("Confirm credit grant failed:", e.message); }
  }
  const nowBal = ((db.prepare("SELECT credits FROM organisations WHERE id = ?").get(accountId)) || {}).credits || 0;
  send(res, 200, { ok: true, mode: "credits", granted: nowBal > before, added: Math.max(0, nowBal - before), credits: nowBal });
});

// ── Stripe webhook: auto-credit accounts when a payment succeeds ──
// Configure in Stripe → Developers → Webhooks → "Add endpoint":
//   URL:    https://<your-domain>/api/webhooks/stripe
//   Events: checkout.session.completed
// Then set STRIPE_WEBHOOK_SECRET (the "whsec_…" signing secret) on the server.

// Read the raw request body — the signature is computed over the exact bytes.
function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// Verify a Stripe-Signature header (HMAC-SHA256 over "timestamp.payload"), with replay tolerance.
function verifyStripeSignature(rawBuf, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader || !secret) return false;
  let t = null; const v1s = [];
  for (const part of String(sigHeader).split(",")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1s.push(v);
  }
  if (!t || v1s.length === 0) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(t));
  if (!Number.isFinite(age) || age > toleranceSec) return false;
  const expected = crypto.createHmac("sha256", secret).update(t + "." + rawBuf.toString("utf8"), "utf8").digest("hex");
  const expBuf = Buffer.from(expected, "hex");
  return v1s.some((v) => {
    let vBuf; try { vBuf = Buffer.from(v, "hex"); } catch { return false; }
    return vBuf.length === expBuf.length && crypto.timingSafeEqual(vBuf, expBuf);
  });
}

// Run a set of DB writes atomically (works on better-sqlite3 and node:sqlite).
function inTransaction(fn) {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { try { db.exec("ROLLBACK"); } catch {} throw e; }
}

// ─── REFERRAL PROGRAM (reward on the referred account's first purchase) ───────
const REFERRAL_CREDITS = { company: 50, individual: 14 };
function rewardForType(accountType) { return REFERRAL_CREDITS[accountType === "individual" ? "individual" : "company"]; }
function newReferralCode() {
  let code; do { code = genReferralCode(); } while (db.prepare("SELECT 1 FROM organisations WHERE referral_code = ?").get(code));
  return code;
}
// At signup: validate the code and record who referred this account — but DON'T pay out yet.
// The reward is held until the referred account makes its first purchase (anti-abuse).
// Wrapped so a referral problem can never block account creation — it just quietly no-ops.
function recordReferralIntent(code, newOrgId) {
  try {
    if (!code) return { recorded: false };
    const norm = String(code).trim().toUpperCase();
    if (!norm) return { recorded: false };
    const referrer = db.prepare("SELECT id, active FROM organisations WHERE referral_code = ?").get(norm);
    if (!referrer || referrer.id === newOrgId || referrer.active === 0) return { recorded: false };
    db.prepare("UPDATE organisations SET referred_by_code = ? WHERE id = ?").run(norm, newOrgId);
    return { recorded: true };
  } catch (e) {
    console.error("recordReferralIntent failed (registration continues):", e.message);
    return { recorded: false };
  }
}
// Pay the referrer for a referred account. Triggered by a super-admin approving the referral.
// Idempotent (one payout per referred account) and returns a reason when it can't pay.
function payReferral(orgId) {
  try {
    const acct = db.prepare("SELECT id, name, referred_by_code FROM organisations WHERE id = ?").get(orgId);
    if (!acct) return { paid: false, reason: "not_found" };
    if (!acct.referred_by_code) return { paid: false, reason: "no_referrer" };
    if (db.prepare("SELECT 1 FROM referrals WHERE referred_org_id = ?").get(orgId)) return { paid: false, reason: "already_approved" };
    const referrer = db.prepare("SELECT id, name, account_type, active, credits FROM organisations WHERE referral_code = ?").get(acct.referred_by_code);
    if (!referrer) return { paid: false, reason: "referrer_missing" };
    if (referrer.id === orgId) return { paid: false, reason: "self" };
    if (referrer.active === 0) return { paid: false, reason: "referrer_inactive" };
    const reward = rewardForType(referrer.account_type);
    inTransaction(() => {
      const bal = (referrer.credits || 0) + reward;
      db.prepare("UPDATE organisations SET credits = ? WHERE id = ?").run(bal, referrer.id);
      db.prepare("INSERT INTO credit_transactions (id,org_id,amount,balance_after,note,created_at) VALUES (?,?,?,?,?,?)")
        .run(genId("CR"), referrer.id, reward, bal, `Referral bonus — referral of ${acct.name} approved`, new Date().toISOString());
      db.prepare("INSERT INTO referrals (id,referrer_org_id,referred_org_id,code,credits,created_at) VALUES (?,?,?,?,?,?)")
        .run(genId("REF"), referrer.id, orgId, acct.referred_by_code, reward, new Date().toISOString());
      db.prepare("UPDATE organisations SET referral_status = 'approved' WHERE id = ?").run(orgId);
    });
    console.log(`🎁 REFERRAL APPROVED: ${referrer.name} earned ${reward} credits for referring ${acct.name}`);
    return { paid: true, reward, referrerId: referrer.id, referrerName: referrer.name };
  } catch (e) {
    console.error("payReferral failed:", e.message);
    return { paid: false, reason: "error" };
  }
}
// Automated payout: fires when a referred account makes its first purchase.
// Respects a super-admin decline (blocked referrals never auto-pay), and is idempotent.
function autoPayReferralOnPurchase(orgId) {
  try {
    const acct = db.prepare("SELECT referral_status FROM organisations WHERE id = ?").get(orgId);
    if (acct && acct.referral_status === "declined") return; // a super-admin blocked this referral
    payReferral(orgId); // no-op if already paid or not a referral
  } catch (e) { console.error("autoPayReferralOnPurchase failed:", e.message); }
}
function referralSummary(orgId) {
  try {
    const org = db.prepare("SELECT referral_code, account_type FROM organisations WHERE id = ?").get(orgId);
    const code = org ? org.referral_code : null;
    const rewarded = db.prepare("SELECT credits FROM referrals WHERE referrer_org_id = ?").all(orgId);
    let pending = 0;
    try {
      // Awaiting approval = signed up with my code, not yet approved (no payout row) and not declined.
      const referredCount = code ? db.prepare("SELECT COUNT(*) AS n FROM organisations WHERE referred_by_code = ?").get(code).n : 0;
      const declined = code ? db.prepare("SELECT COUNT(*) AS n FROM organisations WHERE referred_by_code = ? AND referral_status = 'declined'").get(code).n : 0;
      pending = Math.max(0, referredCount - rewarded.length - declined);
    } catch (e) { console.error("referralSummary pending count failed:", e.message); }
    return {
      code,
      rewardPerReferral: rewardForType(org ? org.account_type : "company"),
      count: rewarded.length,                                   // approved referrals (credited)
      creditsEarned: rewarded.reduce((s, r) => s + r.credits, 0),
      pending,                                                  // awaiting admin approval
    };
  } catch (e) {
    console.error("referralSummary failed:", e.message);
    return { code: null, rewardPerReferral: 0, count: 0, creditsEarned: 0, pending: 0 };
  }
}

// Grant credits for a completed checkout session — idempotent (one grant per session id).
function grantStripeCredits(sessionId, orgId, credits) {
  if (db.prepare("SELECT id FROM stripe_events WHERE id = ?").get(sessionId)) {
    console.log(`↩ Stripe session ${sessionId} already processed — skipping.`);
    return;
  }
  const now = new Date().toISOString();
  const org = db.prepare("SELECT id, credits FROM organisations WHERE id = ?").get(orgId);
  if (!org) {
    db.prepare("INSERT OR IGNORE INTO stripe_events (id,org_id,credits,created_at) VALUES (?,?,?,?)").run(sessionId, orgId, 0, now);
    console.warn(`⚠ Stripe payment ${sessionId} references unknown account ${orgId} — no credit applied.`);
    return;
  }
  const newBalance = (org.credits || 0) + credits;
  inTransaction(() => {
    db.prepare("INSERT OR IGNORE INTO stripe_events (id,org_id,credits,created_at) VALUES (?,?,?,?)").run(sessionId, orgId, credits, now);
    db.prepare("UPDATE organisations SET credits = ? WHERE id = ?").run(newBalance, orgId);
    db.prepare("INSERT INTO credit_transactions (id,org_id,amount,balance_after,note,created_at) VALUES (?,?,?,?,?,?)")
      .run(genId("CR"), orgId, credits, newBalance, `Stripe payment — ${credits} credit${credits === 1 ? "" : "s"}`, now);
  });
  console.log(`💳 STRIPE AUTO-CREDIT: +${credits} to ${orgId} → balance ${newBalance} (session ${sessionId})`);
  if (credits > 0) autoPayReferralOnPurchase(orgId);
}

// Mark an organisation as subscribed (idempotent) when a subscription checkout completes.
function markSubscriptionActive(orgId, subscriptionId, customerId) {
  const org = db.prepare("SELECT id FROM organisations WHERE id = ?").get(orgId);
  if (!org) { console.warn(`⚠ Subscription checkout references unknown account ${orgId} — ignored.`); return; }
  db.prepare("UPDATE organisations SET subscription_status = 'active', stripe_subscription_id = ?, stripe_customer_id = ?, subscription_updated_at = ? WHERE id = ?")
    .run(subscriptionId || null, customerId || null, new Date().toISOString(), orgId);
  console.log(`⭐ SUBSCRIPTION ACTIVE: ${orgId} (sub ${subscriptionId || "n/a"})`);
}
// Keep an org's subscription status in step with Stripe, matched by Stripe subscription id.
function setSubscriptionStatusBySubId(subscriptionId, status) {
  if (!subscriptionId) return;
  const org = db.prepare("SELECT id FROM organisations WHERE stripe_subscription_id = ?").get(subscriptionId);
  if (!org) return; // not one of ours, or not linked yet
  db.prepare("UPDATE organisations SET subscription_status = ?, subscription_updated_at = ? WHERE stripe_subscription_id = ?")
    .run(status, new Date().toISOString(), subscriptionId);
  console.log(`⭐ SUBSCRIPTION ${String(status).toUpperCase()}: ${org.id} (sub ${subscriptionId})`);
}

// Option-2 billing: each NEW course assignment costs 1 credit, unless the org is on an
// active subscription (then unlimited). Callers pass how many genuinely new (learner ×
// course) pairs they're about to create. Deducts + logs when charged. Returns one of:
//   { allowed:true,  mode:'subscription', charged:0 }
//   { allowed:true,  mode:'credits', charged, balance }
//   { allowed:false, needed, have }
function chargeForCourseAssignments(orgId, count) {
  const org = db.prepare("SELECT credits, subscription_status FROM organisations WHERE id = ?").get(orgId);
  const subscribed = !!org && org.subscription_status === "active";
  if (!count || count <= 0) return { allowed: true, mode: subscribed ? "subscription" : "credits", charged: 0 };
  if (subscribed) return { allowed: true, mode: "subscription", charged: 0 };
  const have = (org && org.credits) || 0;
  if (have < count) return { allowed: false, needed: count, have };
  const balance = have - count;
  db.prepare("UPDATE organisations SET credits = ? WHERE id = ?").run(balance, orgId);
  db.prepare("INSERT INTO credit_transactions (id,org_id,amount,balance_after,note,created_at) VALUES (?,?,?,?,?,?)")
    .run(genId("CR"), orgId, -count, balance, `Course assignment — ${count} credit${count === 1 ? "" : "s"}`, new Date().toISOString());
  return { allowed: true, mode: "credits", charged: count, balance };
}
function creditError(needed, have) {
  return `You need ${needed} credit${needed === 1 ? "" : "s"} to assign ${needed === 1 ? "this course" : "these courses"} (you have ${have}). Subscribe for unlimited team training, or top up your credits.`;
}

route("POST", "/api/webhooks/stripe", async (req, res) => {
  const raw = await readRawBody(req);
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn("⚠ Stripe webhook received but STRIPE_WEBHOOK_SECRET is not set — ignoring.");
    return send(res, 503, { error: "not_configured" });
  }
  if (!verifyStripeSignature(raw, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET)) {
    console.warn("⚠ Stripe webhook signature verification failed.");
    return send(res, 400, { error: "invalid signature" });
  }
  let event;
  try { event = JSON.parse(raw.toString("utf8")); } catch { return send(res, 400, { error: "invalid payload" }); }

  if (event.type === "checkout.session.completed") {
    const session = event.data && event.data.object ? event.data.object : {};
    const paid = session.payment_status === "paid" || session.status === "complete";

    if (session.mode === "subscription") {
      // Subscription paid via the Payment Link — client_reference_id carries the org id.
      const orgId = session.client_reference_id;
      if (paid && orgId) {
        try { markSubscriptionActive(orgId, session.subscription, session.customer); }
        catch (e) { console.error("Subscription activation failed:", e.message); }
      } else if (paid && !orgId) {
        console.log(`ℹ Subscription ${session.id} completed without a client_reference_id — can't link it to an account.`);
      }
    } else {
      // One-off pay-as-you-go credit purchase (existing behaviour).
      const accountId = session.metadata && session.metadata.account_id;
      const credits = parseInt((session.metadata && session.metadata.credits) || "0", 10);
      if (paid && accountId && Number.isFinite(credits) && credits > 0) {
        try { grantStripeCredits(session.id, accountId, credits); }
        catch (e) { console.error("Stripe auto-credit failed:", e.message); }
      } else if (paid && !accountId) {
        console.log(`ℹ Stripe payment ${session.id} completed without an account_id — no credits granted (untagged purchase).`);
      }
    }
  } else if (event.type === "customer.subscription.deleted") {
    const sub = event.data && event.data.object ? event.data.object : {};
    setSubscriptionStatusBySubId(sub.id, "canceled");
  } else if (event.type === "customer.subscription.updated") {
    const sub = event.data && event.data.object ? event.data.object : {};
    setSubscriptionStatusBySubId(sub.id, sub.status || "active");
  }
  // Always acknowledge so Stripe doesn't keep retrying events we've already seen.
  send(res, 200, { received: true });
});

// ── ORG: register ──
route("POST", "/api/org/register", async (req, res) => {
  const b = await readBody(req);
  if (!b.name || !b.email || !b.password)
    return send(res, 400, { error: "Name, email and password are required." });
  if (b.password.length < 6)
    return send(res, 400, { error: "Password must be at least 6 characters." });
  const exists = db.prepare("SELECT id FROM organisations WHERE email = ?").get(b.email.toLowerCase());
  if (exists) return send(res, 409, { error: "An organisation with this email already exists." });

  const id = genId("ORG");
  const { hash, salt } = hashPassword(b.password);
  db.prepare(`INSERT INTO organisations (id,name,email,password_hash,password_salt,phone,address,cqc_number,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, b.name, b.email.toLowerCase(), hash, salt, b.phone || null, b.address || null, b.cqcNumber || null, new Date().toISOString());
  db.prepare("UPDATE organisations SET referral_code = ? WHERE id = ?").run(newReferralCode(), id);
  const referral = recordReferralIntent(b.referralCode, id);

  const token = genToken();
  db.prepare("INSERT INTO sessions (token,subject_id,kind,created_at) VALUES (?,?,?,?)")
    .run(token, id, "org", new Date().toISOString());

  const org = db.prepare("SELECT id,name,email,phone,address,cqc_number,created_at FROM organisations WHERE id = ?").get(id);
  send(res, 201, { token, org, referralPending: referral.recorded });
});

// ── ORG: login ──
route("POST", "/api/org/login", async (req, res) => {
  const b = await readBody(req);
  if (!b.email || !b.password) return send(res, 400, { error: "Email and password are required." });
  const org = db.prepare("SELECT * FROM organisations WHERE email = ?").get(b.email.toLowerCase());
  if (!org) return send(res, 401, { error: "No organisation found with this email." });
  if (!verifyPassword(b.password, org.password_salt, org.password_hash))
    return send(res, 401, { error: "Incorrect password." });
  if (org.active === 0)
    return send(res, 403, { error: "This account has been deactivated. Please contact Care2Learn support." });
  if (org.account_type === "individual")
    return send(res, 403, { error: "This is a self-employed account — please use the carer login below." });

  const token = genToken();
  db.prepare("INSERT INTO sessions (token,subject_id,kind,created_at) VALUES (?,?,?,?)")
    .run(token, org.id, "org", new Date().toISOString());
  send(res, 200, {
    token,
    org: { id: org.id, name: org.name, email: org.email, phone: org.phone, address: org.address, cqc_number: org.cqc_number, created_at: org.created_at },
  });
});

// ── ORG: get own profile + dashboard summary ──
route("GET", "/api/org/me", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated as an organisation." });
  const org = db.prepare("SELECT id,name,email,phone,address,cqc_number,created_at,credits,reminders_enabled,subscription_status FROM organisations WHERE id = ?").get(s.subject_id);
  if (!org) return send(res, 404, { error: "Organisation not found." });

  const staff = db.prepare("SELECT * FROM staff WHERE org_id = ?").all(org.id);
  const activeStaff = staff.filter((x) => x.active);
  const staffIds = staff.map((x) => x.id);

  // Pull all enrolments for this org's staff
  const allEnr = staffIds.length
    ? db.prepare(`SELECT * FROM enrolments WHERE staff_id IN (${staffIds.map(() => "?").join(",")})`).all(...staffIds)
    : [];

  // Compliance: a staff member is compliant if EVERY assigned course is completed & valid
  let fullyCompliant = 0;
  let expiringSoon = 0;
  for (const member of activeStaff) {
    const mine = allEnr.filter((e) => e.staff_id === member.id);
    if (mine.length === 0) continue;
    const shaped = mine.map(shapeEnrolment);
    if (shaped.every((e) => e.compliance === "valid")) fullyCompliant++;
    if (shaped.some((e) => e.compliance === "expiring")) expiringSoon++;
  }

  // Per-course rollup
  const byCourse = COURSES.map((c) => {
    const enr = allEnr.filter((e) => e.course_id === c.id);
    const completed = enr.map(shapeEnrolment).filter((e) => e.compliance === "valid").length;
    return { courseId: c.id, title: c.title, icon: c.icon, color: c.color, assigned: enr.length, completed };
  });

  send(res, 200, {
    org,
    referral: referralSummary(org.id),
    summary: {
      activeStaff: activeStaff.length,
      totalStaff: staff.length,
      totalEnrolments: allEnr.length,
      fullyCompliant,
      expiringSoon,
    },
    byCourse,
  });
});

// ── ORG: list staff (with progress rollup) ──
route("GET", "/api/org/staff", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated as an organisation." });
  const staff = db.prepare("SELECT * FROM staff WHERE org_id = ? ORDER BY created_at DESC").all(s.subject_id);

  const result = staff.map((member) => {
    const enr = db.prepare("SELECT * FROM enrolments WHERE staff_id = ?").all(member.id).map(shapeEnrolment);
    const completed = enr.filter((e) => e.compliance === "valid").length;
    const assigned = enr.length;
    const compliant = assigned > 0 && enr.every((e) => e.compliance === "valid");
    return {
      id: member.id, name: member.name, email: member.email, role: member.role,
      pin: member.pin, startDate: member.start_date, active: !!member.active,
      assignedCount: assigned, completedCount: completed, compliant,
      enrolments: enr,
    };
  });
  send(res, 200, { staff: result });
});

// ── ORG: add staff (creates a licence) ──
route("POST", "/api/org/staff", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated as an organisation." });
  const b = await readBody(req);
  if (!b.name || !b.email) return send(res, 400, { error: "Name and email are required." });

  const id = genId("STF");
  const pin = genPin();
  db.prepare(`INSERT INTO staff (id,org_id,name,email,role,pin,start_date,active,created_at)
              VALUES (?,?,?,?,?,?,?,1,?)`)
    .run(id, s.subject_id, b.name, b.email, b.role || "Care Assistant", pin, b.startDate || new Date().toISOString().split("T")[0], new Date().toISOString());

  // Optionally assign initial courses — each costs a credit unless subscribed. The staff
  // member is always created; if credits run short, the courses are simply left unassigned.
  let note = null;
  const wanted = Array.isArray(b.courseIds) ? b.courseIds.filter((c) => COURSE_IDS.includes(c)) : [];
  if (wanted.length) {
    const charge = chargeForCourseAssignments(s.subject_id, wanted.length);
    if (charge.allowed) {
      const ins = db.prepare(`INSERT OR IGNORE INTO enrolments (id,staff_id,course_id,assigned_at,due_date,status,progress,attempts)
                              VALUES (?,?,?,?,?, 'assigned', 0, 0)`);
      inTransaction(() => { for (const cid of wanted) ins.run(genId("ENR"), id, cid, new Date().toISOString(), b.dueDate || null); });
    } else {
      note = `${b.name} was added, but their ${wanted.length} course${wanted.length === 1 ? "" : "s"} weren't assigned — you need ${charge.needed} credit${charge.needed === 1 ? "" : "s"} (you have ${charge.have}). Subscribe or top up, then assign from the staff list.`;
    }
  }

  const member = db.prepare("SELECT * FROM staff WHERE id = ?").get(id);
  send(res, 201, { staff: { ...member, active: !!member.active }, pin, note });
});

// ── ORG: bulk-create staff from a CSV import (same fields as the manual add) ──
// Accepts { rows: [{name,email,role,startDate}], courseIds? } and creates each
// staff member exactly as the single add would (auto PIN, active=1), while
// skipping rows that are invalid, duplicated in the file, or already on the team.
route("POST", "/api/org/staff/bulk", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated as an organisation." });
  const b = await readBody(req);
  const rows = Array.isArray(b.rows) ? b.rows : [];
  if (rows.length === 0) return send(res, 400, { error: "There are no rows to import." });
  if (rows.length > 1000) return send(res, 400, { error: "Please import 1000 rows or fewer at a time." });
  const courseIds = Array.isArray(b.courseIds) ? b.courseIds.filter((c) => COURSE_IDS.includes(c)) : [];

  // Existing emails on this org (lower-cased) so we never create a duplicate.
  const existing = new Set(
    db.prepare("SELECT email FROM staff WHERE org_id = ?").all(s.subject_id).map((r) => String(r.email || "").toLowerCase())
  );
  const seen = new Set(); // catches duplicates within the uploaded file itself

  const created = [];
  const skipped = [];
  const today = new Date().toISOString().split("T")[0];
  const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const insStaff = db.prepare(`INSERT INTO staff (id,org_id,name,email,role,pin,start_date,active,created_at) VALUES (?,?,?,?,?,?,?,1,?)`);
  const insEnr = db.prepare(`INSERT OR IGNORE INTO enrolments (id,staff_id,course_id,assigned_at,due_date,status,progress,attempts) VALUES (?,?,?,?,?, 'assigned', 0, 0)`);
  const createdIds = [];

  rows.forEach((row, i) => {
    const rowNum = i + 1;
    const name = String(row.name || "").trim();
    const email = String(row.email || "").trim();
    const emailLc = email.toLowerCase();
    const role = String(row.role || "").trim() || "Care Assistant";
    let startDate = String(row.startDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) startDate = today;

    if (!name || !email) { skipped.push({ row: rowNum, name, email, reason: "Missing name or email" }); return; }
    if (!emailRe.test(email)) { skipped.push({ row: rowNum, name, email, reason: "Invalid email address" }); return; }
    if (seen.has(emailLc)) { skipped.push({ row: rowNum, name, email, reason: "Duplicate email in file" }); return; }
    if (existing.has(emailLc)) { skipped.push({ row: rowNum, name, email, reason: "Already on your team" }); return; }

    const id = genId("STF");
    const pin = genPin();
    try {
      insStaff.run(id, s.subject_id, name, email, role, pin, startDate, new Date().toISOString());
      seen.add(emailLc);
      existing.add(emailLc);
      created.push({ name, email, role, pin });
      createdIds.push(id);
    } catch (e) {
      skipped.push({ row: rowNum, name, email, reason: "Could not be created" });
    }
  });

  // Assign the chosen courses to every imported staff member — each costs a credit unless
  // subscribed. Staff are always imported; if credits run short the courses are left off.
  let courseNote = null;
  if (courseIds.length && createdIds.length) {
    const count = createdIds.length * courseIds.length;
    const charge = chargeForCourseAssignments(s.subject_id, count);
    if (charge.allowed) {
      inTransaction(() => { for (const sid of createdIds) for (const cid of courseIds) insEnr.run(genId("ENR"), sid, cid, new Date().toISOString(), null); });
    } else {
      courseNote = `Staff imported, but the selected course${courseIds.length === 1 ? "" : "s"} weren't assigned — you need ${charge.needed} credits (you have ${charge.have}). Subscribe or top up, then assign from the staff list.`;
    }
  }

  console.log(`📥 BULK IMPORT: org ${s.subject_id} — created ${created.length}, skipped ${skipped.length}`);
  send(res, 200, { created, skipped, summary: { total: rows.length, created: created.length, skipped: skipped.length }, courseNote });
});

// ── ORG: update staff (deactivate/reactivate, edit) ──
route("PATCH", "/api/org/staff/:id", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ? AND org_id = ?").get(req.params.id, s.subject_id);
  if (!member) return send(res, 404, { error: "Staff member not found." });
  const b = await readBody(req);

  const name = b.name ?? member.name;
  const role = b.role ?? member.role;
  const active = b.active === undefined ? member.active : (b.active ? 1 : 0);
  db.prepare("UPDATE staff SET name = ?, role = ?, active = ? WHERE id = ?").run(name, role, active, member.id);
  const updated = db.prepare("SELECT * FROM staff WHERE id = ?").get(member.id);
  send(res, 200, { staff: { ...updated, active: !!updated.active } });
});

// ── ORG: reset a staff member's PIN ──
route("POST", "/api/org/staff/:id/reset-pin", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated as an organisation." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ? AND org_id = ?").get(req.params.id, s.subject_id);
  if (!member) return send(res, 404, { error: "Staff member not found." });
  const pin = genPin();
  db.prepare("UPDATE staff SET pin = ? WHERE id = ?").run(pin, member.id);
  send(res, 200, { ok: true, pin, staff: { id: member.id, name: member.name, email: member.email } });
});

// ── ORG: manually nudge a staff member to complete their outstanding training ──
route("POST", "/api/org/staff/:id/nudge", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated as an organisation." });
  const org = db.prepare("SELECT * FROM organisations WHERE id = ?").get(s.subject_id);
  const member = db.prepare("SELECT * FROM staff WHERE id = ? AND org_id = ?").get(req.params.id, s.subject_id);
  if (!member) return send(res, 404, { error: "Staff member not found." });
  if (!member.active) return send(res, 400, { error: "This staff member's licence is deactivated." });
  if (!member.email) return send(res, 400, { error: "This staff member has no email address on file." });

  const items = outstandingForNudge(member.id);
  if (!items.length) return send(res, 200, { sent: false, message: `${member.name} is fully up to date — nothing to nudge about.` });

  const since = daysSince(lastReminded(member.id, "nudge"));
  if (since < NUDGE_COOLDOWN_DAYS) {
    const wait = Math.max(1, Math.ceil(NUDGE_COOLDOWN_DAYS - since));
    return send(res, 200, { sent: false, message: `You nudged ${member.name} recently — you can nudge again in about ${wait} day${wait === 1 ? "" : "s"}.` });
  }

  const r = await sendStaffNudge(org, member, items);
  markReminded(member.id, "nudge");
  // Also surface an in-app notification the next time the carer opens their portal.
  // Keep only the latest unread nudge so repeat nudges don't stack up.
  db.prepare("DELETE FROM notifications WHERE staff_id = ? AND type = 'nudge' AND read_at IS NULL").run(member.id);
  db.prepare("INSERT INTO notifications (id,staff_id,type,title,body,created_at) VALUES (?,?,?,?,?,?)")
    .run(genId("NTF"), member.id, "nudge", `A reminder from ${org.name}`, "Please complete your outstanding training when you get a moment.", new Date().toISOString());
  send(res, 200, { sent: true, delivered: !!(r && r.sent), message: `Nudge sent to ${member.name}.`, courses: items.length });
});

// ── ORG: assign a course to a staff member (enrol) ──
route("POST", "/api/org/staff/:id/enrol", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ? AND org_id = ?").get(req.params.id, s.subject_id);
  if (!member) return send(res, 404, { error: "Staff member not found." });
  const b = await readBody(req);
  const courseIds = Array.isArray(b.courseIds) ? b.courseIds : (b.courseId ? [b.courseId] : []);
  if (courseIds.length === 0) return send(res, 400, { error: "Provide courseId or courseIds." });

  // Only NEW courses cost a credit; ones already assigned are free (idempotent).
  const valid = courseIds.filter((c) => COURSE_IDS.includes(c));
  const existing = new Set(db.prepare("SELECT course_id FROM enrolments WHERE staff_id = ?").all(member.id).map((r) => r.course_id));
  const toAdd = valid.filter((c) => !existing.has(c));

  const charge = chargeForCourseAssignments(s.subject_id, toAdd.length);
  if (!charge.allowed) return send(res, 402, { error: creditError(charge.needed, charge.have) });

  const ins = db.prepare(`INSERT OR IGNORE INTO enrolments (id,staff_id,course_id,assigned_at,due_date,status,progress,attempts)
                          VALUES (?,?,?,?,?, 'assigned', 0, 0)`);
  inTransaction(() => { for (const cid of toAdd) ins.run(genId("ENR"), member.id, cid, new Date().toISOString(), b.dueDate || null); });

  const enrolments = db.prepare("SELECT * FROM enrolments WHERE staff_id = ?").all(member.id).map(shapeEnrolment);
  send(res, 200, { added: toAdd.length, enrolments, mode: charge.mode, credits: charge.balance });
});

// ── ORG: bulk / role-based course assignment ──
// Assign one or more courses to every active staff member, or only those in the
// selected roles. Existing enrolments are left untouched (INSERT OR IGNORE).
route("POST", "/api/org/staff/assign-courses", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated as an organisation." });
  const b = await readBody(req);
  const courseIds = (Array.isArray(b.courseIds) ? b.courseIds : []).filter((c) => COURSE_IDS.includes(c));
  if (!courseIds.length) return send(res, 400, { error: "Choose at least one course." });

  let staff = db.prepare("SELECT * FROM staff WHERE org_id = ? AND active = 1").all(s.subject_id);
  if (b.target === "roles") {
    const roles = new Set((Array.isArray(b.roles) ? b.roles : []).map((r) => String(r)));
    if (!roles.size) return send(res, 400, { error: "Choose at least one role." });
    staff = staff.filter((m) => roles.has(m.role));
  }
  if (!staff.length) return send(res, 400, { error: "There are no matching staff to assign to." });

  // Only NEW (staff × course) pairs cost a credit; ones already assigned are free.
  const pairs = [];
  for (const m of staff) {
    const existing = new Set(db.prepare("SELECT course_id FROM enrolments WHERE staff_id = ?").all(m.id).map((r) => r.course_id));
    for (const cid of courseIds) if (!existing.has(cid)) pairs.push([m.id, cid]);
  }
  const charge = chargeForCourseAssignments(s.subject_id, pairs.length);
  if (!charge.allowed) return send(res, 402, { error: creditError(charge.needed, charge.have) });

  const ins = db.prepare(`INSERT OR IGNORE INTO enrolments (id,staff_id,course_id,assigned_at,due_date,status,progress,attempts) VALUES (?,?,?,?,?, 'assigned', 0, 0)`);
  inTransaction(() => { for (const [sid, cid] of pairs) ins.run(genId("ENR"), sid, cid, new Date().toISOString(), b.dueDate || null); });

  send(res, 200, { staffAffected: staff.length, enrolmentsAdded: pairs.length, mode: charge.mode, credits: charge.balance });
});

// ── ORG: notification settings (toggle automated reminders) ──
route("POST", "/api/org/settings", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated as an organisation." });
  const b = await readBody(req);
  if (typeof b.remindersEnabled === "boolean") {
    db.prepare("UPDATE organisations SET reminders_enabled = ? WHERE id = ?").run(b.remindersEnabled ? 1 : 0, s.subject_id);
  }
  const org = db.prepare("SELECT reminders_enabled FROM organisations WHERE id = ?").get(s.subject_id);
  send(res, 200, { ok: true, remindersEnabled: !!org.reminders_enabled });
});

// ── ORG: send the manager a preview digest now (to their own inbox only) ──
// Safe to call any time — emails the manager, never the staff.
route("POST", "/api/org/reminders/preview", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated as an organisation." });
  const org = db.prepare("SELECT * FROM organisations WHERE id = ?").get(s.subject_id);
  if (!org) return send(res, 404, { error: "Organisation not found." });
  const digest = managerDigest(org);
  const r = await sendManagerDigest(org, digest);
  send(res, 200, { ok: true, sentTo: org.email, delivered: !!(r && r.sent), flagged: digest.flagged.length });
});

// ── ORG: remove an enrolment ──
route("DELETE", "/api/org/staff/:id/enrol/:courseId", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ? AND org_id = ?").get(req.params.id, s.subject_id);
  if (!member) return send(res, 404, { error: "Staff member not found." });
  db.prepare("DELETE FROM enrolments WHERE staff_id = ? AND course_id = ?").run(member.id, req.params.courseId);
  send(res, 200, { ok: true });
});

// ── STAFF: login (email + PIN) ──
// ─── SELF-EMPLOYED INDIVIDUALS ────────────────────────────────────────────────
// A self-employed carer registers as an "individual": internally an organisation
// flagged account_type='individual' with one staff record (themselves), so all the
// learner machinery (courses, certificates) and credits/admin tooling work unchanged.
// They log in with email+password and receive a STAFF session (so /api/staff/* works).

route("POST", "/api/individual/register", async (req, res) => {
  const b = await readBody(req);
  if (!b.name || !b.email || !b.password) return send(res, 400, { error: "Name, email and password are required." });
  if (b.password.length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
  const email = b.email.toLowerCase();
  if (db.prepare("SELECT id FROM organisations WHERE email = ?").get(email)) return send(res, 409, { error: "An account with this email already exists." });
  const orgId = genId("ORG");
  const { hash, salt } = hashPassword(b.password);
  db.prepare(`INSERT INTO organisations (id,name,email,password_hash,password_salt,created_at,account_type)
              VALUES (?,?,?,?,?,?, 'individual')`)
    .run(orgId, b.name, email, hash, salt, new Date().toISOString());
  db.prepare("UPDATE organisations SET referral_code = ? WHERE id = ?").run(newReferralCode(), orgId);
  const staffId = genId("STF");
  db.prepare(`INSERT INTO staff (id,org_id,name,email,role,pin,start_date,active,created_at)
              VALUES (?,?,?,?,?,?,?,1,?)`)
    .run(staffId, orgId, b.name, email, "Self-employed carer", genPin(), new Date().toISOString().split("T")[0], new Date().toISOString());
  const referral = recordReferralIntent(b.referralCode, orgId);
  const token = genToken();
  db.prepare("INSERT INTO sessions (token,subject_id,kind,created_at) VALUES (?,?,?,?)").run(token, staffId, "staff", new Date().toISOString());
  console.log(`🧑‍⚕️ INDIVIDUAL REGISTERED: ${b.name} (${email})`);
  send(res, 201, { token, accountType: "individual", staff: { id: staffId, name: b.name, email }, org: { id: orgId, name: b.name, credits: 0 }, referralPending: referral.recorded });
});

route("POST", "/api/individual/login", async (req, res) => {
  const b = await readBody(req);
  if (!b.email || !b.password) return send(res, 400, { error: "Email and password are required." });
  const org = db.prepare("SELECT * FROM organisations WHERE email = ? AND account_type = 'individual'").get((b.email || "").toLowerCase());
  if (!org) return send(res, 401, { error: "No self-employed account found with this email." });
  if (!verifyPassword(b.password, org.password_salt, org.password_hash)) return send(res, 401, { error: "Incorrect password." });
  if (org.active === 0) return send(res, 403, { error: "This account has been deactivated. Please contact Care2Learn support." });
  const staff = db.prepare("SELECT * FROM staff WHERE org_id = ? ORDER BY created_at ASC").get(org.id);
  if (!staff) return send(res, 500, { error: "Account is missing its learner record." });
  const token = genToken();
  db.prepare("INSERT INTO sessions (token,subject_id,kind,created_at) VALUES (?,?,?,?)").run(token, staff.id, "staff", new Date().toISOString());
  send(res, 200, { token, accountType: "individual", staff: { id: staff.id, name: staff.name, email: staff.email }, org: { id: org.id, name: org.name, credits: org.credits || 0 } });
});

// Individual's own profile: learner record + courses + credit balance
route("GET", "/api/individual/me", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "staff") return send(res, 401, { error: "Not authenticated." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ?").get(s.subject_id);
  if (!member) return send(res, 404, { error: "Account not found." });
  const org = db.prepare("SELECT id,name,credits,account_type FROM organisations WHERE id = ?").get(member.org_id);
  if (!org || org.account_type !== "individual") return send(res, 403, { error: "Not an individual account." });
  const enrolments = db.prepare("SELECT * FROM enrolments WHERE staff_id = ?").all(member.id).map(shapeEnrolment);
  for (const e of enrolments) {
    const course = COURSE_MAP[e.courseId];
    if (course && course.modular) {
      e.modulesCompleted = db.prepare("SELECT module_id FROM module_progress WHERE staff_id = ? AND course_id = ?").all(member.id, e.courseId).map(r => r.module_id);
    }
  }
  send(res, 200, { staff: { id: member.id, name: member.name, email: member.email, role: member.role },
                   org: { id: org.id, name: org.name, credits: org.credits || 0, accountType: org.account_type }, enrolments,
                   referral: referralSummary(org.id) });
});

// Individual self-enrols in a course — pay-as-you-go: requires (and spends) one credit
route("POST", "/api/individual/enrol", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "staff") return send(res, 401, { error: "Not authenticated." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ?").get(s.subject_id);
  if (!member) return send(res, 404, { error: "Account not found." });
  const org = db.prepare("SELECT * FROM organisations WHERE id = ?").get(member.org_id);
  if (!org || org.account_type !== "individual") return send(res, 403, { error: "Not an individual account." });
  const b = await readBody(req);
  if (!COURSE_IDS.includes(b.courseId)) return send(res, 400, { error: "Unknown course." });
  if (db.prepare("SELECT id FROM enrolments WHERE staff_id = ? AND course_id = ?").get(member.id, b.courseId))
    return send(res, 200, { ok: true, already: true, credits: org.credits || 0 });
  // Subscribed → unlimited, no credit charge.
  if (org.subscription_status === "active") {
    db.prepare(`INSERT INTO enrolments (id,staff_id,course_id,assigned_at,due_date,status,progress,attempts)
                VALUES (?,?,?,?,?, 'assigned', 0, 0)`)
      .run(genId("ENR"), member.id, b.courseId, new Date().toISOString(), null);
    return send(res, 201, { ok: true, creditUsed: false, subscribed: true, credits: org.credits || 0 });
  }
  if ((org.credits || 0) < 1)
    return send(res, 402, { error: "You need a credit to add this course. Subscribe for unlimited access, or buy credits first." });
  const newBal = org.credits - 1;
  db.prepare("UPDATE organisations SET credits = ? WHERE id = ?").run(newBal, org.id);
  db.prepare("INSERT INTO credit_transactions (id,org_id,amount,balance_after,note,created_at) VALUES (?,?,?,?,?,?)")
    .run(genId("CR"), org.id, -1, newBal, "Course enrolment: " + (COURSE_MAP[b.courseId]?.title || b.courseId), new Date().toISOString());
  db.prepare(`INSERT INTO enrolments (id,staff_id,course_id,assigned_at,due_date,status,progress,attempts)
              VALUES (?,?,?,?,?, 'assigned', 0, 0)`)
    .run(genId("ENR"), member.id, b.courseId, new Date().toISOString(), null);
  send(res, 201, { ok: true, creditUsed: true, credits: newBal });
});

// ─── ACCOUNT SECURITY: self-service password / PIN, admin reset, payments feed ─

// Organisation changes its own login password (must supply the current one).
route("POST", "/api/org/change-password", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated." });
  const b = await readBody(req);
  if (!b.currentPassword || !b.newPassword) return send(res, 400, { error: "Enter your current and new password." });
  if (b.newPassword.length < 6) return send(res, 400, { error: "New password must be at least 6 characters." });
  const org = db.prepare("SELECT * FROM organisations WHERE id = ?").get(s.subject_id);
  if (!org) return send(res, 404, { error: "Account not found." });
  if (!verifyPassword(b.currentPassword, org.password_salt, org.password_hash)) return send(res, 401, { error: "Your current password is incorrect." });
  const { hash, salt } = hashPassword(b.newPassword);
  db.prepare("UPDATE organisations SET password_hash = ?, password_salt = ? WHERE id = ?").run(hash, salt, org.id);
  console.log(`🔒 PASSWORD CHANGED (self-service): ${org.name} (${org.email})`);
  send(res, 200, { ok: true });
});

// Self-employed individual changes its own login password (authenticated via its staff session).
route("POST", "/api/individual/change-password", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "staff") return send(res, 401, { error: "Not authenticated." });
  const member = db.prepare("SELECT org_id FROM staff WHERE id = ?").get(s.subject_id);
  if (!member) return send(res, 404, { error: "Account not found." });
  const org = db.prepare("SELECT * FROM organisations WHERE id = ?").get(member.org_id);
  if (!org || org.account_type !== "individual") return send(res, 403, { error: "Not an individual account." });
  const b = await readBody(req);
  if (!b.currentPassword || !b.newPassword) return send(res, 400, { error: "Enter your current and new password." });
  if (b.newPassword.length < 6) return send(res, 400, { error: "New password must be at least 6 characters." });
  if (!verifyPassword(b.currentPassword, org.password_salt, org.password_hash)) return send(res, 401, { error: "Your current password is incorrect." });
  const { hash, salt } = hashPassword(b.newPassword);
  db.prepare("UPDATE organisations SET password_hash = ?, password_salt = ? WHERE id = ?").run(hash, salt, org.id);
  console.log(`🔒 PASSWORD CHANGED (self-service): ${org.name} (individual)`);
  send(res, 200, { ok: true });
});

// Carer (staff) changes their own 4-digit PIN (must supply the current one).
route("POST", "/api/staff/change-pin", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "staff") return send(res, 401, { error: "Not authenticated." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ?").get(s.subject_id);
  if (!member) return send(res, 404, { error: "Account not found." });
  const b = await readBody(req);
  const newPin = String(b.newPin || "").trim();
  if (!b.currentPin || !newPin) return send(res, 400, { error: "Enter your current and new PIN." });
  if (!/^\d{4}$/.test(newPin)) return send(res, 400, { error: "Your new PIN must be 4 digits." });
  if (String(member.pin) !== String(b.currentPin)) return send(res, 401, { error: "Your current PIN is incorrect." });
  db.prepare("UPDATE staff SET pin = ? WHERE id = ?").run(newPin, member.id);
  console.log(`🔒 PIN CHANGED (self-service): ${member.name}`);
  send(res, 200, { ok: true });
});

// ── FORGOT PASSWORD: request a reset link (companies + individuals) ──
// Always responds identically whether or not the email exists, so the form
// can't be used to discover which emails have accounts.
route("POST", "/api/forgot-password", async (req, res) => {
  const b = await readBody(req);
  const email = String(b.email || "").trim().toLowerCase();
  const generic = { ok: true, message: "If that email has a Care2Learn account, we've sent a link to reset the password. Please check your inbox (and spam folder)." };
  if (!email) return send(res, 400, { error: "Please enter your email address." });
  try {
    const org = db.prepare("SELECT id, name, email, active FROM organisations WHERE email = ?").get(email);
    if (org && org.active !== 0) {
      // Light anti-spam: at most one reset email per account per 60 seconds.
      const recent = db.prepare("SELECT created_at FROM password_resets WHERE org_id = ? ORDER BY created_at DESC LIMIT 1").get(org.id);
      const tooSoon = recent && (Date.now() - new Date(recent.created_at).getTime() < 60 * 1000);
      if (!tooSoon) {
        // Invalidate any earlier unused tokens, then issue one fresh single-use token.
        db.prepare("DELETE FROM password_resets WHERE org_id = ? AND used_at IS NULL").run(org.id);
        const token = genToken();
        const now = new Date();
        const expires = new Date(now.getTime() + 60 * 60 * 1000); // 60 minutes
        db.prepare("INSERT INTO password_resets (token, org_id, created_at, expires_at, used_at) VALUES (?,?,?,?,NULL)")
          .run(token, org.id, now.toISOString(), expires.toISOString());
        const link = baseUrl(req) + "/?reset=" + encodeURIComponent(token);
        const text =
          "Hi " + org.name + ",\n\n" +
          "We received a request to reset the password for your Care2Learn account (" + org.email + ").\n\n" +
          "Use the link below to choose a new password. It expires in 60 minutes and can only be used once:\n\n" +
          link + "\n\n" +
          "If you didn't request this, you can safely ignore this email — your password won't change.\n\n" +
          "Thanks,\nThe Care2Learn team";
        const html =
          "<div style=\"font-family:'Segoe UI',system-ui,sans-serif;color:#1A1A2E;line-height:1.6\">" +
          "<p>Hi " + escapeHtml(org.name) + ",</p>" +
          "<p>We received a request to reset the password for your Care2Learn account (" + escapeHtml(org.email) + ").</p>" +
          "<p>Use the button below to choose a new password. It expires in 60 minutes and can only be used once.</p>" +
          "<p><a href=\"" + escapeHtml(link) + "\" style=\"display:inline-block;padding:12px 22px;background:#1B2A4A;color:#ffffff;border-radius:10px;text-decoration:none;font-weight:700\">Reset my password</a></p>" +
          "<p style=\"color:#5A6474;font-size:13px\">Or paste this link into your browser:<br><a href=\"" + escapeHtml(link) + "\">" + escapeHtml(link) + "</a></p>" +
          "<p style=\"color:#5A6474;font-size:13px\">If you didn't request this, you can safely ignore this email — your password won't change.</p>" +
          "<p>Thanks,<br>The Care2Learn team</p></div>";
        await sendEmail({ to: org.email, subject: "Reset your Care2Learn password", text, html });
        console.log("🔑 PASSWORD RESET requested: " + org.email);
      }
    }
  } catch (e) {
    console.error("forgot-password failed (responding generically):", e.message);
  }
  send(res, 200, generic); // always the same response
});

// ── Validate a reset token (lets the reset page show a friendly state up front) ──
route("POST", "/api/reset-password/check", async (req, res) => {
  const b = await readBody(req);
  const token = String(b.token || "").trim();
  const row = token ? db.prepare("SELECT expires_at, used_at FROM password_resets WHERE token = ?").get(token) : null;
  const valid = !!row && !row.used_at && new Date(row.expires_at).getTime() > Date.now();
  send(res, 200, { valid });
});

// ── RESET PASSWORD: set a new password using a valid one-time token ──
route("POST", "/api/reset-password", async (req, res) => {
  const b = await readBody(req);
  const token = String(b.token || "").trim();
  const newPassword = String(b.newPassword || "");
  if (!token) return send(res, 400, { error: "This reset link is invalid." });
  if (newPassword.length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
  const row = db.prepare("SELECT * FROM password_resets WHERE token = ?").get(token);
  if (!row || row.used_at) return send(res, 400, { error: "This reset link has already been used or is invalid. Please request a new one." });
  if (new Date(row.expires_at).getTime() <= Date.now()) return send(res, 400, { error: "This reset link has expired. Please request a new one." });
  const org = db.prepare("SELECT id, name, email, account_type FROM organisations WHERE id = ?").get(row.org_id);
  if (!org) return send(res, 404, { error: "Account not found." });
  const { hash, salt } = hashPassword(newPassword);
  inTransaction(() => {
    db.prepare("UPDATE organisations SET password_hash = ?, password_salt = ? WHERE id = ?").run(hash, salt, org.id);
    db.prepare("UPDATE password_resets SET used_at = ? WHERE token = ?").run(new Date().toISOString(), token);
    // Security: drop any other outstanding reset tokens for this account.
    db.prepare("DELETE FROM password_resets WHERE org_id = ? AND used_at IS NULL").run(org.id);
    // Security: sign out existing sessions for this account so a reset locks out anyone else.
    if (org.account_type === "individual") {
      db.prepare("DELETE FROM sessions WHERE kind = 'staff' AND subject_id IN (SELECT id FROM staff WHERE org_id = ?)").run(org.id);
    } else {
      db.prepare("DELETE FROM sessions WHERE kind = 'org' AND subject_id = ?").run(org.id);
    }
  });
  console.log("🔒 PASSWORD RESET completed: " + org.email);
  send(res, 200, { ok: true, accountType: org.account_type === "individual" ? "individual" : "company" });
});

// Super admin resets a company or individual's login password → returns a new temporary one to share.
route("POST", "/api/admin/orgs/:id/reset-password", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const org = db.prepare("SELECT id, name, email FROM organisations WHERE id = ?").get(req.params.id);
  if (!org) return send(res, 404, { error: "Account not found." });
  const password = genPassword();
  const { hash, salt } = hashPassword(password);
  db.prepare("UPDATE organisations SET password_hash = ?, password_salt = ? WHERE id = ?").run(hash, salt, org.id);
  console.log(`🔑 PASSWORD RESET by admin: ${org.name} (${org.email})`);
  send(res, 200, { ok: true, password, email: org.email });
});

// Super admin: recent Stripe payments (auto-credit top-ups) across all accounts.
route("GET", "/api/admin/payments", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const rows = db.prepare(`
    SELECT ct.id, ct.org_id, ct.amount, ct.balance_after, ct.note, ct.created_at,
           o.name AS org_name, o.account_type
    FROM credit_transactions ct
    LEFT JOIN organisations o ON o.id = ct.org_id
    WHERE ct.note LIKE 'Stripe payment%'
    ORDER BY ct.created_at DESC
    LIMIT 100
  `).all();
  const pencePer = PAYG_PENCE_PER_COURSE_PER_LEARNER;
  const payments = rows.map(r => ({
    id: r.id, orgId: r.org_id, orgName: r.org_name || "(deleted account)",
    accountType: r.account_type || "company",
    credits: r.amount, amountPence: r.amount * pencePer, note: r.note, createdAt: r.created_at,
  }));
  const totalPence = payments.reduce((s, p) => s + p.amountPence, 0);
  const totalCredits = payments.reduce((s, p) => s + p.credits, 0);
  send(res, 200, { payments, totalPence, totalCredits, count: payments.length });
});

// Super-admin oversight of the referral programme — every referred account with its approval state.
route("GET", "/api/admin/referrals", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const referred = db.prepare(`SELECT id, name, account_type, created_at, referred_by_code, referral_status, credits
                               FROM organisations
                               WHERE referred_by_code IS NOT NULL AND referred_by_code != ''
                               ORDER BY created_at DESC`).all();
  const rewardedRows = db.prepare("SELECT referred_org_id, credits, created_at FROM referrals").all();
  const rewardedMap = new Map(rewardedRows.map(r => [r.referred_org_id, r]));
  // "Has paid" signal: the referred account has completed a real card payment.
  const purchasers = new Set(db.prepare("SELECT DISTINCT org_id FROM credit_transactions WHERE amount > 0 AND note LIKE 'Stripe payment%'").all().map(r => r.org_id));
  let pendingCount = 0, approvedCount = 0, declinedCount = 0;
  const referrals = referred.map(a => {
    const referrer = db.prepare("SELECT id, name, account_type, active FROM organisations WHERE referral_code = ?").get(a.referred_by_code);
    const paid = rewardedMap.get(a.id);
    const status = paid ? "approved" : (a.referral_status === "declined" ? "declined" : "pending");
    if (status === "approved") approvedCount++; else if (status === "declined") declinedCount++; else pendingCount++;
    return {
      referredId: a.id, referredName: a.name, referredType: a.account_type || "company", joinedAt: a.created_at,
      referredCredits: a.credits || 0, hasPurchased: purchasers.has(a.id),
      referrerId: referrer ? referrer.id : null, referrerName: referrer ? referrer.name : "(unknown)",
      referrerType: referrer ? (referrer.account_type || "company") : null,
      referrerActive: referrer ? referrer.active !== 0 : false, code: a.referred_by_code,
      status,
      credits: paid ? paid.credits : (referrer ? rewardForType(referrer.account_type) : 0),
      approvedAt: paid ? paid.created_at : null,
    };
  });
  send(res, 200, {
    summary: {
      totalReferred: referred.length,
      pendingCount, approvedCount, declinedCount,
      creditsAwarded: rewardedRows.reduce((s, r) => s + r.credits, 0),
    },
    referrals,
  });
});

// Super-admin approves a pending referral — credits the referrer.
route("POST", "/api/admin/referrals/:referredId/approve", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const acct = db.prepare("SELECT id FROM organisations WHERE id = ?").get(req.params.referredId);
  if (!acct) return send(res, 404, { error: "Referred account not found." });
  const result = payReferral(req.params.referredId);
  if (!result.paid) {
    const messages = {
      already_approved: "This referral has already been approved.",
      no_referrer: "This account didn't sign up with a referral code.",
      referrer_missing: "The referring account no longer exists.",
      referrer_inactive: "The referring account is deactivated, so it can't be credited.",
      self: "An account can't refer itself.",
      not_found: "Referred account not found.",
      error: "Something went wrong approving this referral.",
    };
    return send(res, 400, { error: messages[result.reason] || "Could not approve this referral.", reason: result.reason });
  }
  send(res, 200, { ok: true, reward: result.reward, referrerName: result.referrerName });
});

// Super-admin declines a pending referral — no payout.
route("POST", "/api/admin/referrals/:referredId/decline", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const acct = db.prepare("SELECT id FROM organisations WHERE id = ?").get(req.params.referredId);
  if (!acct) return send(res, 404, { error: "Referred account not found." });
  if (db.prepare("SELECT 1 FROM referrals WHERE referred_org_id = ?").get(req.params.referredId)) {
    return send(res, 400, { error: "This referral has already been approved and can't be declined." });
  }
  db.prepare("UPDATE organisations SET referral_status = 'declined' WHERE id = ?").run(req.params.referredId);
  send(res, 200, { ok: true });
});

route("POST", "/api/staff/login", async (req, res) => {
  const b = await readBody(req);
  if (!b.email || !b.pin) return send(res, 400, { error: "Email and PIN are required." });
  const member = db.prepare("SELECT * FROM staff WHERE email = ? AND pin = ? AND active = 1").get(b.email, String(b.pin));
  if (!member) return send(res, 401, { error: "Incorrect email or PIN, or your licence is inactive." });
  const memberOrg = db.prepare("SELECT active FROM organisations WHERE id = ?").get(member.org_id);
  if (!memberOrg || memberOrg.active === 0)
    return send(res, 403, { error: "This account has been deactivated. Please contact your organisation." });

  const token = genToken();
  db.prepare("INSERT INTO sessions (token,subject_id,kind,created_at) VALUES (?,?,?,?)")
    .run(token, member.id, "staff", new Date().toISOString());
  const org = db.prepare("SELECT id,name FROM organisations WHERE id = ?").get(member.org_id);
  send(res, 200, {
    token,
    staff: { id: member.id, name: member.name, email: member.email, role: member.role, startDate: member.start_date, pin: member.pin },
    org,
  });
});

// ── STAFF: my dashboard (assigned courses + progress) ──
route("GET", "/api/staff/me", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "staff") return send(res, 401, { error: "Not authenticated as staff." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ?").get(s.subject_id);
  if (!member) return send(res, 404, { error: "Staff not found." });
  const org = db.prepare("SELECT id,name FROM organisations WHERE id = ?").get(member.org_id);
  const enrolments = db.prepare("SELECT * FROM enrolments WHERE staff_id = ?").all(member.id).map(shapeEnrolment);
  // Attach completed module ids (for modular courses such as the Care Certificate)
  const modRows = db.prepare("SELECT course_id, module_id FROM module_progress WHERE staff_id = ?").all(member.id);
  for (const e of enrolments) e.modulesCompleted = modRows.filter(m => m.course_id === e.courseId).map(m => m.module_id);

  const notifications = db.prepare("SELECT id,type,title,body,created_at FROM notifications WHERE staff_id = ? AND read_at IS NULL ORDER BY created_at DESC").all(member.id);

  send(res, 200, {
    staff: { id: member.id, name: member.name, email: member.email, role: member.role, startDate: member.start_date, pin: member.pin },
    org,
    enrolments,
    notifications,
  });
});

// ── STAFF: mark notifications as read (dismiss) ──
route("POST", "/api/staff/notifications/read", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "staff") return send(res, 401, { error: "Not authenticated as staff." });
  const b = await readBody(req);
  const now = new Date().toISOString();
  if (Array.isArray(b.ids) && b.ids.length) {
    const ph = b.ids.map(() => "?").join(",");
    db.prepare(`UPDATE notifications SET read_at = ? WHERE staff_id = ? AND id IN (${ph})`).run(now, s.subject_id, ...b.ids);
  } else {
    db.prepare("UPDATE notifications SET read_at = ? WHERE staff_id = ? AND read_at IS NULL").run(now, s.subject_id);
  }
  send(res, 200, { ok: true });
});

// ── STAFF: update slide progress for a course ──
route("POST", "/api/staff/progress", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "staff") return send(res, 401, { error: "Not authenticated as staff." });
  const b = await readBody(req);
  if (!b.courseId) return send(res, 400, { error: "courseId is required." });
  const enr = db.prepare("SELECT * FROM enrolments WHERE staff_id = ? AND course_id = ?").get(s.subject_id, b.courseId);
  if (!enr) return send(res, 404, { error: "You are not enrolled on this course." });

  const progress = Math.max(0, Math.min(100, Number(b.progress) || 0));
  const status = enr.status === "completed" ? "completed" : (progress > 0 ? "in_progress" : "assigned");
  db.prepare("UPDATE enrolments SET progress = ?, status = ? WHERE id = ?").run(progress, status, enr.id);
  send(res, 200, { ok: true, enrolment: shapeEnrolment(db.prepare("SELECT * FROM enrolments WHERE id = ?").get(enr.id)) });
});

// ── STAFF: submit a quiz attempt ──
route("POST", "/api/staff/quiz", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "staff") return send(res, 401, { error: "Not authenticated as staff." });
  const b = await readBody(req);
  if (!b.courseId || typeof b.score !== "number")
    return send(res, 400, { error: "courseId and numeric score are required." });
  const enr = db.prepare("SELECT * FROM enrolments WHERE staff_id = ? AND course_id = ?").get(s.subject_id, b.courseId);
  if (!enr) return send(res, 404, { error: "You are not enrolled on this course." });

  const score = Math.max(0, Math.min(100, Math.round(b.score)));
  const passed = score >= 70;
  const attempts = enr.attempts + 1;

  if (passed) {
    const completedAt = new Date().toISOString();
    const expiry = addYear(completedAt);
    const certId = enr.cert_id || genId("CERT");
    db.prepare(`UPDATE enrolments SET status='completed', progress=100, score=?, attempts=?, completed_at=?, expiry_date=?, cert_id=? WHERE id=?`)
      .run(score, attempts, completedAt, expiry, certId, enr.id);
  } else {
    db.prepare(`UPDATE enrolments SET status='failed', score=?, attempts=? WHERE id=?`)
      .run(score, attempts, enr.id);
  }
  const updated = db.prepare("SELECT * FROM enrolments WHERE id = ?").get(enr.id);
  send(res, 200, { passed, score, enrolment: shapeEnrolment(updated) });
});

// ── STAFF: mark one module of a modular course complete ──
route("POST", "/api/staff/module-complete", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "staff") return send(res, 401, { error: "Not authenticated as staff." });
  const b = await readBody(req);
  if (!b.courseId || !b.moduleId) return send(res, 400, { error: "courseId and moduleId are required." });
  const course = COURSE_MAP[b.courseId];
  if (!course || !Array.isArray(course.modules) || !course.modules.length)
    return send(res, 400, { error: "Not a modular course." });
  if (!course.modules.some(m => m.id === b.moduleId)) return send(res, 400, { error: "Unknown module." });
  const enr = db.prepare("SELECT * FROM enrolments WHERE staff_id = ? AND course_id = ?").get(s.subject_id, b.courseId);
  if (!enr) return send(res, 404, { error: "You are not enrolled on this course." });

  const score = (typeof b.score === "number") ? Math.max(0, Math.min(100, Math.round(b.score))) : null;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO module_progress (staff_id, course_id, module_id, score, completed_at)
              VALUES (?,?,?,?,?)
              ON CONFLICT(staff_id, course_id, module_id) DO UPDATE SET score=excluded.score, completed_at=excluded.completed_at`)
    .run(s.subject_id, b.courseId, b.moduleId, score, now);

  const done = db.prepare("SELECT module_id, score FROM module_progress WHERE staff_id = ? AND course_id = ?").all(s.subject_id, b.courseId);
  const total = course.modules.length;
  const allDone = done.length >= total;
  const progress = Math.round((done.length / total) * 100);

  if (allDone) {
    const avg = Math.round(done.reduce((a, d) => a + (d.score || 0), 0) / total);
    const expiry = addYear(now);
    const certId = enr.cert_id || genId("CERT");
    db.prepare(`UPDATE enrolments SET status='completed', progress=100, score=?, completed_at=?, expiry_date=?, cert_id=? WHERE id=?`)
      .run(avg, now, expiry, certId, enr.id);
  } else {
    db.prepare("UPDATE enrolments SET status='in_progress', progress=? WHERE id=?").run(progress, enr.id);
  }
  send(res, 200, {
    ok: true, allDone, progress,
    completed: done.map(d => d.module_id),
    enrolment: shapeEnrolment(db.prepare("SELECT * FROM enrolments WHERE id = ?").get(enr.id)),
  });
});

// ── Logout (any) ──
route("POST", "/api/logout", async (req, res) => {
  const token = getToken(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
  send(res, 200, { ok: true });
});

// ── Feedback: compliments, bugs and feature requests (from org or staff) ──
route("POST", "/api/feedback", async (req, res) => {
  const s = authSession(req);
  const b = await readBody(req);
  const kind = ["compliment", "bug", "feature"].includes(b.kind) ? b.kind : null;
  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (!kind) return send(res, 400, { error: "kind must be compliment, bug or feature." });
  if (message.length < 3) return send(res, 400, { error: "Please add a little more detail." });
  if (message.length > 4000) return send(res, 400, { error: "Message is too long (max 4000 characters)." });

  let submitterKind = null, submitterId = null, submitterName = null, orgId = null;
  if (s) {
    submitterKind = s.kind;
    submitterId = s.subject_id;
    if (s.kind === "org") {
      const o = db.prepare("SELECT id,name FROM organisations WHERE id = ?").get(s.subject_id);
      if (o) { submitterName = o.name; orgId = o.id; }
    } else if (s.kind === "staff") {
      const m = db.prepare("SELECT name,org_id FROM staff WHERE id = ?").get(s.subject_id);
      if (m) { submitterName = m.name; orgId = m.org_id; }
    }
  }
  const id = genId("FB");
  const context = typeof b.context === "string" ? b.context.slice(0, 200) : null;
  db.prepare(`INSERT INTO feedback (id,created_at,kind,message,submitter_kind,submitter_id,submitter_name,org_id,context)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, new Date().toISOString(), kind, message, submitterKind, submitterId, submitterName, orgId, context);
  console.log(`📨 FEEDBACK [${kind}] from ${submitterName || "unknown"} (${submitterKind || "anonymous"}${orgId ? ", org " + orgId : ""}): ${message.replace(/\s+/g, " ").slice(0, 300)}`);
  send(res, 200, { ok: true, id });
});

// ─── SUPER ADMIN ──────────────────────────────────────────────────────────────
// A single super-admin. Credentials come from the ADMIN_EMAIL + ADMIN_PASSWORD
// environment variables, so there is exactly one admin and no extra DB account.
function authAdmin(req) {
  const s = authSession(req);
  return s && s.kind === "admin" ? s : null;
}

route("POST", "/api/admin/login", async (req, res) => {
  const adminEmail = (process.env.ADMIN_EMAIL || "").toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD || "";
  if (!adminEmail || !adminPassword)
    return send(res, 503, { error: "Super admin is not set up yet. Set ADMIN_EMAIL and ADMIN_PASSWORD on the server, then redeploy." });
  const b = await readBody(req);
  if (!b.email || !b.password) return send(res, 400, { error: "Email and password are required." });
  if (b.email.toLowerCase() !== adminEmail || b.password !== adminPassword)
    return send(res, 401, { error: "Incorrect super admin email or password." });
  const token = genToken();
  db.prepare("INSERT INTO sessions (token,subject_id,kind,created_at) VALUES (?,?,?,?)")
    .run(token, "SUPERADMIN", "admin", new Date().toISOString());
  send(res, 200, { token, admin: { email: adminEmail } });
});

// All companies + summary stats
route("GET", "/api/admin/orgs", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const orgs = db.prepare("SELECT id,name,email,phone,cqc_number,created_at,credits,active,account_type FROM organisations ORDER BY created_at DESC").all();
  const result = orgs.map((o) => {
    const staff = db.prepare("SELECT id,active FROM staff WHERE org_id = ?").all(o.id);
    const ids = staff.map((s) => s.id);
    const allEnr = ids.length ? db.prepare(`SELECT * FROM enrolments WHERE staff_id IN (${ids.map(() => "?").join(",")})`).all(...ids) : [];
    let fullyCompliant = 0;
    for (const m of staff.filter((s) => s.active)) {
      const mine = allEnr.filter((e) => e.staff_id === m.id).map(shapeEnrolment);
      if (mine.length && mine.every((e) => e.compliance === "valid")) fullyCompliant++;
    }
    return { id: o.id, name: o.name, email: o.email, phone: o.phone, cqcNumber: o.cqc_number, createdAt: o.created_at,
             staffCount: staff.length, activeStaff: staff.filter((s) => s.active).length, enrolments: allEnr.length, fullyCompliant, credits: o.credits || 0, active: o.active !== 0, accountType: o.account_type || 'company' };
  });
  const totals = { organisations: orgs.length, staff: result.reduce((a, r) => a + r.staffCount, 0), enrolments: result.reduce((a, r) => a + r.enrolments, 0), credits: result.reduce((a, r) => a + r.credits, 0) };
  send(res, 200, { totals, orgs: result });
});

// One company + its staff (full detail)
route("GET", "/api/admin/orgs/:id", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const org = db.prepare("SELECT id,name,email,phone,address,cqc_number,created_at,credits,active,account_type FROM organisations WHERE id = ?").get(req.params.id);
  if (!org) return send(res, 404, { error: "Company not found." });
  const staff = db.prepare("SELECT * FROM staff WHERE org_id = ? ORDER BY created_at DESC").all(org.id).map((member) => {
    const enr = db.prepare("SELECT * FROM enrolments WHERE staff_id = ?").all(member.id).map(shapeEnrolment);
    return { id: member.id, name: member.name, email: member.email, role: member.role, pin: member.pin,
             startDate: member.start_date, active: !!member.active,
             assignedCount: enr.length, completedCount: enr.filter((e) => e.compliance === "valid").length,
             compliant: enr.length > 0 && enr.every((e) => e.compliance === "valid"), enrolments: enr };
  });
  const transactions = db.prepare("SELECT id,amount,balance_after,note,created_at FROM credit_transactions WHERE org_id = ? ORDER BY created_at DESC LIMIT 12").all(org.id);
  send(res, 200, { org: { id: org.id, name: org.name, email: org.email, phone: org.phone, address: org.address, cqcNumber: org.cqc_number, createdAt: org.created_at, credits: org.credits || 0, active: org.active !== 0, accountType: org.account_type || 'company' }, staff, transactions });
});

// Add credits (prepaid course assignments) to a company's balance
route("POST", "/api/admin/orgs/:id/credits", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const org = db.prepare("SELECT id, credits FROM organisations WHERE id = ?").get(req.params.id);
  if (!org) return send(res, 404, { error: "Company not found." });
  const b = await readBody(req);
  const amount = Math.trunc(Number(b.amount));
  if (!Number.isFinite(amount) || amount === 0) return send(res, 400, { error: "Enter a non-zero whole number of credits." });
  const current = org.credits || 0;
  const newBalance = current + amount;
  if (newBalance < 0) return send(res, 400, { error: `That would take the balance below zero (current balance is ${current}).` });
  const note = ((typeof b.note === "string" ? b.note.trim() : "") || null);
  const now = new Date().toISOString();
  const tx = { id: genId("CR"), org_id: org.id, amount, balance_after: newBalance, note: note ? note.slice(0, 200) : null, created_at: now };
  db.prepare("UPDATE organisations SET credits = ? WHERE id = ?").run(newBalance, org.id);
  db.prepare("INSERT INTO credit_transactions (id,org_id,amount,balance_after,note,created_at) VALUES (?,?,?,?,?,?)")
    .run(tx.id, tx.org_id, tx.amount, tx.balance_after, tx.note, tx.created_at);
  console.log(`💳 CREDITS ${amount > 0 ? "+" + amount : amount} to org ${org.id} → balance ${newBalance}${tx.note ? " (" + tx.note + ")" : ""}`);
  if (amount > 0) autoPayReferralOnPurchase(org.id);
  send(res, 200, { ok: true, credits: newBalance, transaction: tx });
});

// Create a new company (organisation) from the admin portal
route("POST", "/api/admin/orgs", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const b = await readBody(req);
  if (!b.name || !b.email || !b.password) return send(res, 400, { error: "Company name, email and password are required." });
  if (b.password.length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
  const email = b.email.toLowerCase();
  if (db.prepare("SELECT id FROM organisations WHERE email = ?").get(email)) return send(res, 409, { error: "A company with this email already exists." });
  const id = genId("ORG");
  const { hash, salt } = hashPassword(b.password);
  db.prepare(`INSERT INTO organisations (id,name,email,password_hash,password_salt,phone,address,cqc_number,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, b.name, email, hash, salt, b.phone || null, b.address || null, b.cqcNumber || null, new Date().toISOString());
  db.prepare("UPDATE organisations SET referral_code = ? WHERE id = ?").run(newReferralCode(), id);
  const startCredits = Math.trunc(Number(b.credits));
  if (Number.isFinite(startCredits) && startCredits > 0) {
    db.prepare("UPDATE organisations SET credits = ? WHERE id = ?").run(startCredits, id);
    db.prepare("INSERT INTO credit_transactions (id,org_id,amount,balance_after,note,created_at) VALUES (?,?,?,?,?,?)")
      .run(genId("CR"), id, startCredits, startCredits, "Opening balance", new Date().toISOString());
  }
  const org = db.prepare("SELECT id,name,email,phone,address,cqc_number,created_at,credits,active FROM organisations WHERE id = ?").get(id);
  console.log(`🏢 COMPANY CREATED: ${b.name} (${email}) by super admin`);
  send(res, 201, { org: { id: org.id, name: org.name, email: org.email, phone: org.phone, address: org.address, cqcNumber: org.cqc_number, createdAt: org.created_at, credits: org.credits, active: org.active !== 0 } });
});

// Super admin creates a self-employed carer (individual) account.
route("POST", "/api/admin/individuals", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const b = await readBody(req);
  if (!b.name || !b.email || !b.password) return send(res, 400, { error: "Name, email and password are required." });
  if (b.password.length < 6) return send(res, 400, { error: "Password must be at least 6 characters." });
  const email = b.email.toLowerCase();
  if (db.prepare("SELECT id FROM organisations WHERE email = ?").get(email)) return send(res, 409, { error: "An account with this email already exists." });
  const orgId = genId("ORG");
  const { hash, salt } = hashPassword(b.password);
  db.prepare(`INSERT INTO organisations (id,name,email,password_hash,password_salt,created_at,account_type)
              VALUES (?,?,?,?,?,?, 'individual')`)
    .run(orgId, b.name, email, hash, salt, new Date().toISOString());
  db.prepare("UPDATE organisations SET referral_code = ? WHERE id = ?").run(newReferralCode(), orgId);
  const staffId = genId("STF");
  db.prepare(`INSERT INTO staff (id,org_id,name,email,role,pin,start_date,active,created_at)
              VALUES (?,?,?,?,?,?,?,1,?)`)
    .run(staffId, orgId, b.name, email, "Self-employed carer", genPin(), new Date().toISOString().split("T")[0], new Date().toISOString());
  const startCredits = Math.trunc(Number(b.credits));
  if (Number.isFinite(startCredits) && startCredits > 0) {
    db.prepare("UPDATE organisations SET credits = ? WHERE id = ?").run(startCredits, orgId);
    db.prepare("INSERT INTO credit_transactions (id,org_id,amount,balance_after,note,created_at) VALUES (?,?,?,?,?,?)")
      .run(genId("CR"), orgId, startCredits, startCredits, "Opening balance", new Date().toISOString());
  }
  const org = db.prepare("SELECT id,name,email,created_at,credits,active FROM organisations WHERE id = ?").get(orgId);
  console.log(`🧑‍⚕️ INDIVIDUAL CREATED: ${b.name} (${email}) by super admin`);
  send(res, 201, { org: { id: org.id, name: org.name, email: org.email, createdAt: org.created_at, credits: org.credits, active: org.active !== 0, accountType: "individual" } });
});

// Update a company — deactivate/reactivate or edit details
route("PATCH", "/api/admin/orgs/:id", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const org = db.prepare("SELECT * FROM organisations WHERE id = ?").get(req.params.id);
  if (!org) return send(res, 404, { error: "Company not found." });
  const b = await readBody(req);
  const name = b.name ?? org.name;
  const phone = b.phone ?? org.phone;
  const address = b.address ?? org.address;
  const cqc = b.cqcNumber ?? org.cqc_number;
  const active = b.active === undefined ? org.active : (b.active ? 1 : 0);
  db.prepare("UPDATE organisations SET name=?, phone=?, address=?, cqc_number=?, active=? WHERE id=?").run(name, phone, address, cqc, active, org.id);
  if (b.active !== undefined && (active === 0) !== (org.active === 0))
    console.log(`🏢 COMPANY ${active ? "REACTIVATED" : "DEACTIVATED"}: ${org.name} (${org.id})`);
  const u = db.prepare("SELECT id,name,email,phone,address,cqc_number,created_at,credits,active FROM organisations WHERE id = ?").get(org.id);
  send(res, 200, { org: { id: u.id, name: u.name, email: u.email, phone: u.phone, address: u.address, cqcNumber: u.cqc_number, createdAt: u.created_at, credits: u.credits, active: u.active !== 0 } });
});

// Reset a staff member's PIN on a company's behalf
route("POST", "/api/admin/orgs/:id/staff/:sid/reset-pin", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ? AND org_id = ?").get(req.params.sid, req.params.id);
  if (!member) return send(res, 404, { error: "Staff member not found." });
  const pin = genPin();
  db.prepare("UPDATE staff SET pin = ? WHERE id = ?").run(pin, member.id);
  send(res, 200, { ok: true, pin, staff: { id: member.id, name: member.name, email: member.email } });
});

// Add a staff member to a company on its behalf
route("POST", "/api/admin/orgs/:id/staff", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const org = db.prepare("SELECT id FROM organisations WHERE id = ?").get(req.params.id);
  if (!org) return send(res, 404, { error: "Company not found." });
  const b = await readBody(req);
  if (!b.name || !b.email) return send(res, 400, { error: "Name and email are required." });
  const id = genId("STF"); const pin = genPin();
  db.prepare(`INSERT INTO staff (id,org_id,name,email,role,pin,start_date,active,created_at) VALUES (?,?,?,?,?,?,?,1,?)`)
    .run(id, org.id, b.name, b.email, b.role || "Care Assistant", pin, b.startDate || new Date().toISOString().split("T")[0], new Date().toISOString());
  if (Array.isArray(b.courseIds)) {
    const ins = db.prepare(`INSERT OR IGNORE INTO enrolments (id,staff_id,course_id,assigned_at,due_date,status,progress,attempts) VALUES (?,?,?,?,?, 'assigned', 0, 0)`);
    for (const cid of b.courseIds) if (COURSE_IDS.includes(cid)) ins.run(genId("ENR"), id, cid, new Date().toISOString(), b.dueDate || null);
  }
  const member = db.prepare("SELECT * FROM staff WHERE id = ?").get(id);
  send(res, 201, { staff: { ...member, active: !!member.active }, pin });
});

// Update a staff member (active toggle / edit) on a company's behalf
route("PATCH", "/api/admin/orgs/:id/staff/:sid", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ? AND org_id = ?").get(req.params.sid, req.params.id);
  if (!member) return send(res, 404, { error: "Staff member not found." });
  const b = await readBody(req);
  const name = b.name ?? member.name, role = b.role ?? member.role;
  const active = b.active === undefined ? member.active : (b.active ? 1 : 0);
  db.prepare("UPDATE staff SET name=?, role=?, active=? WHERE id=?").run(name, role, active, member.id);
  const u = db.prepare("SELECT * FROM staff WHERE id=?").get(member.id);
  send(res, 200, { staff: { ...u, active: !!u.active } });
});

// Assign course(s) to a staff member on a company's behalf
route("POST", "/api/admin/orgs/:id/staff/:sid/enrol", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ? AND org_id = ?").get(req.params.sid, req.params.id);
  if (!member) return send(res, 404, { error: "Staff member not found." });
  const b = await readBody(req);
  const courseIds = Array.isArray(b.courseIds) ? b.courseIds : (b.courseId ? [b.courseId] : []);
  if (!courseIds.length) return send(res, 400, { error: "Provide courseId or courseIds." });
  const ins = db.prepare(`INSERT OR IGNORE INTO enrolments (id,staff_id,course_id,assigned_at,due_date,status,progress,attempts) VALUES (?,?,?,?,?, 'assigned', 0, 0)`);
  let added = 0;
  for (const cid of courseIds) { if (!COURSE_IDS.includes(cid)) continue; const r = ins.run(genId("ENR"), member.id, cid, new Date().toISOString(), b.dueDate || null); if (r.changes > 0) added++; }
  const enr = db.prepare("SELECT * FROM enrolments WHERE staff_id = ?").all(member.id).map(shapeEnrolment);
  send(res, 200, { added, enrolments: enr });
});

// Remove an enrolment on a company's behalf
route("DELETE", "/api/admin/orgs/:id/staff/:sid/enrol/:courseId", async (req, res) => {
  if (!authAdmin(req)) return send(res, 401, { error: "Not authenticated as super admin." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ? AND org_id = ?").get(req.params.sid, req.params.id);
  if (!member) return send(res, 404, { error: "Staff member not found." });
  db.prepare("DELETE FROM enrolments WHERE staff_id = ? AND course_id = ?").run(member.id, req.params.courseId);
  send(res, 200, { ok: true });
});

// ── Feedback inbox: all feedback. Open to the super admin session, or via ?key=ADMIN_KEY. ──
route("GET", "/api/admin/feedback", async (req, res) => {
  const isAdmin = !!authAdmin(req);
  if (!isAdmin) {
    const adminKey = process.env.ADMIN_KEY;
    const provided = new URL(req.url, `http://${req.headers.host}`).searchParams.get("key");
    if (!adminKey) return send(res, 503, { error: "Sign in to the super admin portal, or set ADMIN_KEY to use the export URL." });
    if (provided !== adminKey) return send(res, 401, { error: "Invalid or missing key." });
  }
  const rows = db.prepare("SELECT * FROM feedback ORDER BY created_at DESC").all();
  const counts = rows.reduce((a, r) => { a[r.kind] = (a[r.kind] || 0) + 1; return a; }, {});
  send(res, 200, { total: rows.length, counts, feedback: rows });
});

// ─── STATIC FILE SERVING ──────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

// Work out where the front-end files (index.html, app.js) actually live.
// Normally that's the /public folder, but if the files were uploaded loose
// (a common mix-up when uploading to GitHub), fall back to the app's own folder
// so the site still works.
const PUBLIC_DIR = fs.existsSync(path.join(__dirname, "public", "index.html"))
  ? path.join(__dirname, "public")
  : __dirname;
console.log("Serving front-end files from:", PUBLIC_DIR);

function serveStatic(req, res, urlPath) {
  // Public marketing landing lives at "/"; the application shell lives at "/app".
  // Anything else is treated as a real file path (app.js, images, etc.).
  let rel;
  if (urlPath === "/") rel = "home.html";
  else if (urlPath === "/app" || urlPath === "/app/") rel = "index.html";
  else rel = urlPath;
  let filePath = path.join(PUBLIC_DIR, rel);
  // prevent path traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return send(res, 403, { error: "Forbidden" });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback to index.html
      fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
        if (e2) return send(res, 404, { error: "index.html was not found on the server. Make sure index.html and app.js were uploaded (ideally inside a 'public' folder)." });
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // CORS (handy for local testing)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  // API routes
  if (pathname.startsWith("/api/")) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.regex);
      if (m) {
        req.params = {};
        r.keys.forEach((k, i) => (req.params[k] = decodeURIComponent(m[i + 1])));
        try {
          return await r.handler(req, res);
        } catch (e) {
          console.error("Handler error:", e);
          return send(res, 500, { error: "Internal server error", detail: String(e.message) });
        }
      }
    }
    return send(res, 404, { error: "API route not found: " + req.method + " " + pathname });
  }

  // Static
  serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`\n  ╭──────────────────────────────────────────────╮`);
  console.log(`  │   Care2Learn backend running                 │`);
  console.log(`  │   http://localhost:${PORT}                       │`);
  console.log(`  │                                              │`);
  console.log(`  │   Demo org:  demo@care2learn.co.uk / demo123 │`);
  console.log(`  │   Demo staff: priya@demo.com / PIN 9012      │`);
  console.log(`  ╰──────────────────────────────────────────────╯\n`);
  startReminderScheduler();
});
