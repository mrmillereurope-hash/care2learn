// ─── CARE2LEARN BACKEND SERVER ────────────────────────────────────────────────
// Pure Node.js (built-in http + node:sqlite). No external dependencies.
//   node server.js   →   http://localhost:3000

import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  db, initSchema, seedDemo, hashPassword, verifyPassword,
  genId, genToken, genPin,
} from "./db.js";
import { COURSES, COURSE_IDS, COURSE_MAP } from "./courses.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

initSchema();
seedDemo();

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

route("POST", "/api/checkout/payg", async (req, res) => {
  if (!process.env.STRIPE_SECRET_KEY) return send(res, 503, { error: "not_configured" });

  const b = await readBody(req);
  const learners = Math.floor(Number(b.learners));
  const courses = Math.floor(Number(b.courses));
  if (!Number.isFinite(learners) || !Number.isFinite(courses) ||
      learners < 1 || courses < 1 || learners > 5000 || courses > COURSE_IDS.length) {
    return send(res, 400, { error: "Please choose a valid number of learners and courses." });
  }
  const quantity = learners * courses;
  const proto = req.headers["x-forwarded-proto"] || "https";
  const base = proto + "://" + (req.headers["host"] || "localhost");

  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", base + "/?checkout=success");
  form.set("cancel_url", base + "/?checkout=cancelled");
  form.set("line_items[0][quantity]", String(quantity));
  form.set("line_items[0][price_data][currency]", "gbp");
  form.set("line_items[0][price_data][unit_amount]", String(PAYG_PENCE_PER_COURSE_PER_LEARNER));
  form.set("line_items[0][price_data][product_data][name]", "Care2Learn — pay-as-you-go course access");
  form.set("line_items[0][price_data][product_data][description]", learners + " learner(s) × " + courses + " course(s)");
  form.set("metadata[learners]", String(learners));
  form.set("metadata[courses]", String(courses));

  try {
    const session = await createStripeCheckout(form);
    if (!session.url) return send(res, 502, { error: "Stripe did not return a checkout URL." });
    send(res, 200, { url: session.url });
  } catch (e) {
    console.error("Stripe checkout error:", e.message);
    send(res, 502, { error: "Could not start checkout. Please try again." });
  }
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

  const token = genToken();
  db.prepare("INSERT INTO sessions (token,subject_id,kind,created_at) VALUES (?,?,?,?)")
    .run(token, id, "org", new Date().toISOString());

  const org = db.prepare("SELECT id,name,email,phone,address,cqc_number,created_at FROM organisations WHERE id = ?").get(id);
  send(res, 201, { token, org });
});

// ── ORG: login ──
route("POST", "/api/org/login", async (req, res) => {
  const b = await readBody(req);
  if (!b.email || !b.password) return send(res, 400, { error: "Email and password are required." });
  const org = db.prepare("SELECT * FROM organisations WHERE email = ?").get(b.email.toLowerCase());
  if (!org) return send(res, 401, { error: "No organisation found with this email." });
  if (!verifyPassword(b.password, org.password_salt, org.password_hash))
    return send(res, 401, { error: "Incorrect password." });

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
  const org = db.prepare("SELECT id,name,email,phone,address,cqc_number,created_at FROM organisations WHERE id = ?").get(s.subject_id);
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

  // Optionally assign initial courses
  if (Array.isArray(b.courseIds)) {
    const ins = db.prepare(`INSERT OR IGNORE INTO enrolments (id,staff_id,course_id,assigned_at,due_date,status,progress,attempts)
                            VALUES (?,?,?,?,?, 'assigned', 0, 0)`);
    for (const cid of b.courseIds) {
      if (COURSE_IDS.includes(cid)) ins.run(genId("ENR"), id, cid, new Date().toISOString(), b.dueDate || null);
    }
  }

  const member = db.prepare("SELECT * FROM staff WHERE id = ?").get(id);
  send(res, 201, { staff: { ...member, active: !!member.active }, pin });
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

// ── ORG: assign a course to a staff member (enrol) ──
route("POST", "/api/org/staff/:id/enrol", async (req, res) => {
  const s = authSession(req);
  if (!s || s.kind !== "org") return send(res, 401, { error: "Not authenticated." });
  const member = db.prepare("SELECT * FROM staff WHERE id = ? AND org_id = ?").get(req.params.id, s.subject_id);
  if (!member) return send(res, 404, { error: "Staff member not found." });
  const b = await readBody(req);
  const courseIds = Array.isArray(b.courseIds) ? b.courseIds : (b.courseId ? [b.courseId] : []);
  if (courseIds.length === 0) return send(res, 400, { error: "Provide courseId or courseIds." });

  const ins = db.prepare(`INSERT OR IGNORE INTO enrolments (id,staff_id,course_id,assigned_at,due_date,status,progress,attempts)
                          VALUES (?,?,?,?,?, 'assigned', 0, 0)`);
  let added = 0;
  for (const cid of courseIds) {
    if (!COURSE_IDS.includes(cid)) continue;
    const r = ins.run(genId("ENR"), member.id, cid, new Date().toISOString(), b.dueDate || null);
    if (r.changes > 0) added++;
  }
  const enrolments = db.prepare("SELECT * FROM enrolments WHERE staff_id = ?").all(member.id).map(shapeEnrolment);
  send(res, 200, { added, enrolments });
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
route("POST", "/api/staff/login", async (req, res) => {
  const b = await readBody(req);
  if (!b.email || !b.pin) return send(res, 400, { error: "Email and PIN are required." });
  const member = db.prepare("SELECT * FROM staff WHERE email = ? AND pin = ? AND active = 1").get(b.email, String(b.pin));
  if (!member) return send(res, 401, { error: "Incorrect email or PIN, or your licence is inactive." });

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

  send(res, 200, {
    staff: { id: member.id, name: member.name, email: member.email, role: member.role, startDate: member.start_date, pin: member.pin },
    org,
    enrolments,
  });
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
  let filePath = path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath);
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
});
