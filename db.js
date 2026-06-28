// ─── DATABASE LAYER ───────────────────────────────────────────────────────────
// Uses better-sqlite3 when available (installed via npm for hosting), and falls
// back to Node's built-in node:sqlite for quick local runs.

import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Where the database file lives. On a host like Render, set the DATA_DIR
// environment variable to your persistent disk's mount path (e.g. /var/data)
// so all data survives restarts and redeploys. Locally it defaults to ./data.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "care2learn.db");

// Prefer better-sqlite3 (stable, installed via npm); fall back to the built-in
// node:sqlite if it isn't present (e.g. running locally without npm install).
let db;
try {
  const { default: Database } = await import("better-sqlite3");
  db = new Database(DB_PATH);
} catch (e) {
  const { DatabaseSync } = await import("node:sqlite");
  db = new DatabaseSync(DB_PATH);
}
export { db };

// ─── SCHEMA ───────────────────────────────────────────────────────────────────
export function initSchema() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS organisations (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      phone         TEXT,
      address       TEXT,
      cqc_number    TEXT,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL,
      role       TEXT NOT NULL,
      pin        TEXT NOT NULL,
      start_date TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE
    );

    -- A course assignment: an org assigns a staff member to a course.
    CREATE TABLE IF NOT EXISTS enrolments (
      id          TEXT PRIMARY KEY,
      staff_id    TEXT NOT NULL,
      course_id   TEXT NOT NULL,
      assigned_at TEXT NOT NULL,
      due_date    TEXT,
      status      TEXT NOT NULL DEFAULT 'assigned', -- assigned | in_progress | completed | failed
      progress    INTEGER NOT NULL DEFAULT 0,        -- 0-100, slide progress
      score       INTEGER,                            -- last quiz score %
      attempts    INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      expiry_date  TEXT,
      cert_id      TEXT,
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE,
      UNIQUE (staff_id, course_id)
    );

    -- Sessions for simple token auth
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,   -- org id or staff id
      kind       TEXT NOT NULL,   -- 'org' | 'staff'
      created_at TEXT NOT NULL
    );

    -- Per-module completion for modular courses (e.g. the Care Certificate)
    CREATE TABLE IF NOT EXISTS module_progress (
      staff_id     TEXT NOT NULL,
      course_id    TEXT NOT NULL,
      module_id    TEXT NOT NULL,
      score        INTEGER,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (staff_id, course_id, module_id),
      FOREIGN KEY (staff_id) REFERENCES staff(id) ON DELETE CASCADE
    );

    -- Product feedback: compliments, bugs and feature requests
    CREATE TABLE IF NOT EXISTS feedback (
      id             TEXT PRIMARY KEY,
      created_at     TEXT NOT NULL,
      kind           TEXT NOT NULL,   -- 'compliment' | 'bug' | 'feature'
      message        TEXT NOT NULL,
      submitter_kind TEXT,            -- 'org' | 'staff'
      submitter_id   TEXT,
      submitter_name TEXT,
      org_id         TEXT,
      context        TEXT
    );

    -- Prepaid course-credit top-ups (a ledger of every adjustment to a company's balance)
    CREATE TABLE IF NOT EXISTS credit_transactions (
      id            TEXT PRIMARY KEY,
      org_id        TEXT NOT NULL,
      amount        INTEGER NOT NULL,   -- positive = credits added, negative = adjustment/spend
      balance_after INTEGER NOT NULL,
      note          TEXT,
      created_at    TEXT NOT NULL,
      FOREIGN KEY (org_id) REFERENCES organisations(id) ON DELETE CASCADE
    );
  `);

  // Migrations on the organisations table (idempotent — safe to re-run).
  const orgCols = db.prepare("PRAGMA table_info(organisations)").all();
  if (!orgCols.some((c) => c.name === "credits")) {
    db.exec("ALTER TABLE organisations ADD COLUMN credits INTEGER NOT NULL DEFAULT 0");
  }
  if (!orgCols.some((c) => c.name === "active")) {
    db.exec("ALTER TABLE organisations ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
  }
}

// ─── PASSWORD HASHING (pbkdf2, built-in) ──────────────────────────────────────
export function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, "sha512").toString("hex");
  return { hash, salt };
}
export function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  // constant-time compare
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(expectedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function genId(prefix) {
  return (prefix ? prefix + "-" : "") + crypto.randomBytes(5).toString("hex").toUpperCase();
}
export function genToken() {
  return crypto.randomBytes(32).toString("hex");
}
export function genPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// ─── SEED DEMO DATA ───────────────────────────────────────────────────────────
export function seedDemo() {
  const existing = db.prepare("SELECT id FROM organisations WHERE email = ?").get("demo@care2learn.co.uk");
  if (existing) return; // already seeded

  const now = new Date().toISOString();
  const orgId = "ORG-DEMO001";
  const { hash, salt } = hashPassword("demo123");

  db.prepare(`INSERT INTO organisations (id,name,email,password_hash,password_salt,phone,address,cqc_number,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(orgId, "Sunrise Care Ltd", "demo@care2learn.co.uk", hash, salt,
         "0121 456 7890", "12 Care Lane, Birmingham B1 1CC", "1-123456789", "2024-01-15T09:00:00.000Z");

  const staff = [
    { id: "STF-DEMO001", name: "Sarah Johnson",  email: "sarah@demo.com",  role: "Senior Carer",   pin: "1234", start: "2024-02-01" },
    { id: "STF-DEMO002", name: "Marcus Williams", email: "marcus@demo.com", role: "Care Assistant", pin: "5678", start: "2024-03-15" },
    { id: "STF-DEMO003", name: "Priya Patel",    email: "priya@demo.com",  role: "Team Leader",    pin: "9012", start: "2023-11-01" },
  ];
  const insStaff = db.prepare(`INSERT INTO staff (id,org_id,name,email,role,pin,start_date,active,created_at)
                               VALUES (?,?,?,?,?,?,?,1,?)`);
  for (const s of staff) insStaff.run(s.id, orgId, s.name, s.email, s.role, s.pin, s.start, now);

  // Enrolments: Priya has completed several; Sarah has one in progress; Marcus assigned but not started.
  const insEnr = db.prepare(`INSERT INTO enrolments
    (id,staff_id,course_id,assigned_at,due_date,status,progress,score,attempts,completed_at,expiry_date,cert_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);

  const addYear = (d) => { const x = new Date(d); x.setFullYear(x.getFullYear() + 1); return x.toISOString().split("T")[0]; };

  // Helper: a date N months ago from today
  const monthsAgo = (n) => { const d = new Date(); d.setMonth(d.getMonth() - n); return d.toISOString().split("T")[0]; };

  // Priya — completed recently (so certs are currently valid)
  const priyaDone = [
    { course: "safeguarding",     score: 92, date: monthsAgo(2) },
    { course: "fire-safety",      score: 88, date: monthsAgo(2) },
    { course: "infection-control",score: 85, date: monthsAgo(1) },
    { course: "health-safety",    score: 78, date: monthsAgo(11) }, // ~1 month until expiry → "expiring"
  ];
  for (const e of priyaDone) {
    insEnr.run(genId("ENR"), "STF-DEMO003", e.course, "2025-01-05T09:00:00Z", null,
               "completed", 100, e.score, 1, e.date + "T10:00:00Z", addYear(e.date), genId("CERT"));
  }
  // Priya — assigned but not done
  insEnr.run(genId("ENR"), "STF-DEMO003", "medication", "2025-06-01T09:00:00Z", "2025-12-31",
             "assigned", 0, null, 0, null, null, null);

  // Sarah — in progress
  insEnr.run(genId("ENR"), "STF-DEMO001", "safeguarding", "2025-05-01T09:00:00Z", "2025-12-31",
             "in_progress", 60, null, 0, null, null, null);
  insEnr.run(genId("ENR"), "STF-DEMO001", "fire-safety", "2025-05-01T09:00:00Z", "2025-12-31",
             "assigned", 0, null, 0, null, null, null);

  // Marcus — assigned, not started
  insEnr.run(genId("ENR"), "STF-DEMO002", "safeguarding", "2025-05-10T09:00:00Z", "2026-01-31",
             "assigned", 0, null, 0, null, null, null);
  insEnr.run(genId("ENR"), "STF-DEMO002", "manual-handling", "2025-05-10T09:00:00Z", "2026-01-31",
             "assigned", 0, null, 0, null, null, null);

  console.log("✓ Demo data seeded (Sunrise Care Ltd, 3 staff, enrolments).");
}
