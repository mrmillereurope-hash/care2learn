// ─── CARE2LEARN FRONTEND ──────────────────────────────────────────────────────
// Vanilla JS. No build step, no JSX, no bundler. Talks to the REST API.

const App = document.getElementById("app");
const state = {
  token: localStorage.getItem("c2l_token") || null,
  kind: localStorage.getItem("c2l_kind") || null, // 'org' | 'staff'
  courses: [],
  view: "landing",
};

// ── API helper ──
async function api(path, method = "GET", body) {
  const headers = { "Content-Type": "application/json" };
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  const res = await fetch("/api" + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error(data.error || ("Request failed (" + res.status + ")"));
  return data;
}

function setAuth(token, kind) {
  state.token = token; state.kind = kind;
  localStorage.setItem("c2l_token", token);
  localStorage.setItem("c2l_kind", kind);
}
function clearAuth() {
  state.token = null; state.kind = null;
  localStorage.removeItem("c2l_token");
  localStorage.removeItem("c2l_kind");
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstChild;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
function toast(msg) {
  const t = el(`<div class="toast">${esc(msg)}</div>`);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Brand logo (shield + tick). dark=true gives a navy shield for light backgrounds. ──
function logoMark(size, dark) {
  const shield = dark ? "#1B2A4A" : "#ffffff";
  const tick = dark ? "#22C55E" : "#16A34A";
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 100 100" style="display:inline-block;vertical-align:middle;flex:0 0 auto" aria-label="Care2Learn">'
    + '<path d="M50 14 L80 24 L80 47 C80 65 67 77 50 83 C33 77 20 65 20 47 L20 24 Z" fill="' + shield + '"/>'
    + '<path d="M37 49 L46 58 L64 37" fill="none" stroke="' + tick + '" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';
}

// ── Checkout return handling ──
function checkCheckoutResult() {
  const c = new URLSearchParams(location.search).get("checkout");
  if (!c) return;
  history.replaceState(null, "", location.pathname);
  if (c === "success") toast("Payment received — thank you! We'll email you with access details shortly.");
  else if (c === "cancelled") toast("Checkout cancelled — no payment was taken.");
}

// ── Boot ──
async function boot() {
  checkCheckoutResult();
  App.innerHTML = `<div class="spin">Loading Care2Learn…</div>`;
  try {
    const { courses } = await api("/courses");
    state.courses = courses;
  } catch (e) {
    App.innerHTML = `<div class="spin">Could not reach the server.<br>Make sure it is running: <code>node server.js</code></div>`;
    return;
  }
  // Resume session if token present
  if (state.token && state.kind === "org") {
    try { await renderOrgDash(); return; } catch (e) { clearAuth(); }
  }
  if (state.token && state.kind === "staff") {
    try { await renderStaffPortal(); return; } catch (e) { clearAuth(); }
  }
  renderLanding();
}

// ─── LANDING ──────────────────────────────────────────────────────────────────
// ── Pricing model for the cost calculator. EDIT THESE to change your prices. ──
const PRICING = {
  currency: "£",
  subscriptionPerLearnerMonth: 2, // Subscription: £2 per learner per month (before discount)
  subDiscountPerStep: 10,         // ...discounted 10%...
  subDiscountStepUsers: 50,       // ...for every 50 learners...
  subDiscountMax: 50,             // ...up to a maximum of 50% off.
  paygPerCourse: 4,               // Pay as you go: £4 per course, per learner
};
// Subscription volume discount (%) for a given number of learners.
function subDiscountPct(users) {
  const steps = Math.floor(users / PRICING.subDiscountStepUsers);
  return Math.min(PRICING.subDiscountMax, steps * PRICING.subDiscountPerStep);
}
// Format a value given in pence as £X or £X.XX.
function fmtMoney(pence) {
  const pounds = pence / 100;
  const opts = Number.isInteger(pounds) ? {} : { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  return PRICING.currency + pounds.toLocaleString(undefined, opts);
}

// Stripe payment link used as a fallback if server-side checkout is unavailable.
const STRIPE_PAYG_LINK = "https://buy.stripe.com/3cIfZg48PeVm93ncMOdZ602";

// Start pay-as-you-go checkout: ask the server to create a Stripe session for the
// exact amount (learners × courses × £4). If the server can't (not reachable, or the
// Stripe key isn't set yet), fall back to the fixed-price payment link.
async function startPaygCheckout(learners, courses) {
  toast("Setting up secure checkout…");
  try {
    const res = await fetch("/api/checkout/payg", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ learners, courses }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.url) { window.location.href = data.url; return; }
    }
  } catch (e) { /* fall through to the static link */ }
  window.open(STRIPE_PAYG_LINK, "_blank", "noopener");
}

// Build the interactive pricing calculator for the landing page.
function buildCalculator() {
  const courseCount = state.courses.length;
  const cur = PRICING.currency;
  const calc = { mode: "sub", learners: 30, courses: Math.min(3, courseCount) };

  const wrap = el(`
    <div class="plan-band">
      <div class="plan">
        <div class="plan-head">
          <h2>Flexible pricing that grows with you</h2>
          <p>Subscriptions suit small to large organisations. Running a micro business or working solo? Pay as you go gives you total flexibility.</p>
        </div>
        <div class="plan-toggle">
          <button data-mode="sub">Subscription <span>Most popular</span></button>
          <button data-mode="payg">Pay as you go</button>
        </div>
        <div class="plan-card" id="plan-card"></div>
      </div>
    </div>
  `);

  function render() {
    wrap.querySelectorAll(".plan-toggle button").forEach(b => b.classList.toggle("active", b.dataset.mode === calc.mode));
    const card = wrap.querySelector("#plan-card");

    if (calc.mode === "sub") {
      const disc = subDiscountPct(calc.learners);
      const perPence = Math.round(PRICING.subscriptionPerLearnerMonth * 100 * (1 - disc / 100));
      const monthlyPence = calc.learners * perPence;
      const yearlyPence = monthlyPence * 12;
      card.innerHTML = `
        <div class="plan-left">
          <h3>Subscribe & save</h3>
          <p>The most cost-effective way to keep your whole team compliant — one low monthly price per learner covers every mandatory course, with bigger discounts as your team grows.</p>
          <ul class="plan-list">
            <li>Just ${cur}${PRICING.subscriptionPerLearnerMonth} per learner / month</li>
            <li>Volume discounts — up to ${PRICING.subDiscountMax}% off</li>
            <li>All ${courseCount} mandatory courses included</li>
            <li>Unlimited certificates, renewals and reporting</li>
          </ul>
        </div>
        <div class="plan-right">
          <div class="est">
            <div class="est-title">Estimate your training costs</div>
            <div class="est-row"><span>Number of learners</span><b id="v-learn">${calc.learners}</b></div>
            <input type="range" id="s-learn" min="1" max="500" value="${calc.learners}">
            <div class="est-disc" id="v-disc">${disc > 0 ? disc + "% volume discount applied" : ""}</div>
            <div class="est-perlearner">Your estimated cost <span>(billed monthly)</span></div>
            <div class="est-cost"><span class="est-cost-v" id="v-total">${fmtMoney(monthlyPence)}</span><span class="est-cost-u">/ month</span></div>
            <div class="est-sub" id="v-sub">${fmtMoney(yearlyPence)} per year · ${fmtMoney(perPence)} per learner / month</div>
            <button class="btn-primary plan-cta" id="plan-cta">Get started</button>
          </div>
        </div>`;
      const sl = card.querySelector("#s-learn");
      sl.oninput = () => {
        calc.learners = +sl.value;
        const d = subDiscountPct(calc.learners);
        const pp = Math.round(PRICING.subscriptionPerLearnerMonth * 100 * (1 - d / 100));
        const mp = calc.learners * pp, yp = mp * 12;
        card.querySelector("#v-learn").textContent = calc.learners + (calc.learners >= 500 ? "+" : "");
        card.querySelector("#v-disc").textContent = d > 0 ? d + "% volume discount applied" : "";
        card.querySelector("#v-total").textContent = fmtMoney(mp);
        card.querySelector("#v-sub").textContent = fmtMoney(yp) + " per year · " + fmtMoney(pp) + " per learner / month";
      };
    } else {
      const total = calc.learners * calc.courses * PRICING.paygPerCourse;
      card.innerHTML = `
        <div class="plan-left">
          <h3>Pay as you go</h3>
          <p>No commitment — buy only the courses you need, when you need them, for ${cur}${PRICING.paygPerCourse} per learner. And unlike other providers, your courses never expire.</p>
          <ul class="plan-list">
            <li><strong>Your courses never expire — ever</strong></li>
            <li>No subscription or commitment</li>
            <li>${cur}${PRICING.paygPerCourse} per course, per learner</li>
            <li>Instant access, top up anytime</li>
          </ul>
        </div>
        <div class="plan-right">
          <div class="est">
            <div class="est-title">Estimate your training costs</div>
            <div class="est-row"><span>Number of learners</span><b id="v-learn">${calc.learners}</b></div>
            <input type="range" id="s-learn" min="1" max="500" value="${calc.learners}">
            <div class="est-row" style="margin-top:14px"><span>Number of courses</span><b id="v-course">${calc.courses}</b></div>
            <input type="range" id="s-course" min="1" max="${courseCount}" value="${calc.courses}">
            <div class="est-perlearner" style="margin-top:14px">Your estimated cost <span>(one-off)</span></div>
            <div class="est-cost"><span class="est-cost-v" id="v-total">${cur}${total.toLocaleString()}</span></div>
            <div class="est-sub" id="v-break">${calc.learners} learners × ${calc.courses} courses × ${cur}${PRICING.paygPerCourse}</div>
            <button class="btn-primary plan-cta" id="plan-cta">Buy now</button>
          </div>
        </div>`;
      const sl = card.querySelector("#s-learn");
      const sc = card.querySelector("#s-course");
      const upd = () => {
        calc.learners = +sl.value; calc.courses = +sc.value;
        const t = calc.learners * calc.courses * PRICING.paygPerCourse;
        card.querySelector("#v-learn").textContent = calc.learners + (calc.learners >= 500 ? "+" : "");
        card.querySelector("#v-course").textContent = calc.courses;
        card.querySelector("#v-total").textContent = cur + t.toLocaleString();
        card.querySelector("#v-break").textContent = calc.learners + " learners × " + calc.courses + " courses × " + cur + PRICING.paygPerCourse;
      };
      sl.oninput = upd; sc.oninput = upd;
    }
    card.querySelector("#plan-cta").onclick = (calc.mode === "payg")
      ? () => startPaygCheckout(calc.learners, calc.courses)
      : renderOrgRegister;
  }

  wrap.querySelectorAll(".plan-toggle button").forEach(b => {
    b.onclick = () => { calc.mode = b.dataset.mode; render(); };
  });
  render();
  return wrap;
}

function renderLanding() {
  App.innerHTML = "";
  App.appendChild(el(`
    <div>
      <div class="landing-hero">
        <div class="landing-logo">${logoMark(54, false)}</div>
        <div class="landing-title">Care2Learn</div>
        <div class="landing-tag">Skills for Care · Mandatory Training</div>
        <p class="landing-desc">The complete e-learning platform for social care. Register your organisation, assign mandatory courses to staff, and track every learner's progress and compliance in real time.</p>
        <div class="landing-stats">
          <div><span class="lstat-n">${state.courses.length}</span><span class="lstat-l">Courses</span></div>
          <div><span class="lstat-n">70%</span><span class="lstat-l">Pass Mark</span></div>
          <div><span class="lstat-n">1yr</span><span class="lstat-l">Certificate Validity</span></div>
          <div><span class="lstat-n">CQC</span><span class="lstat-l">Audit Ready</span></div>
        </div>
      </div>
      <div class="landing-cards">
        <div class="lcard">
          <div class="lcard-icon">🏢</div>
          <h2>For Organisations</h2>
          <p>Register your care business, add staff, assign courses, and monitor compliance across your team.</p>
          <button class="btn-primary" id="go-org-login">Organisation Login</button>
          <button class="btn-secondary" id="go-org-reg">Register Your Organisation</button>
        </div>
        <div class="lcard">
          <div class="lcard-icon">👤</div>
          <h2>For Care Workers</h2>
          <p>Access the courses your manager has assigned, complete assessments, and download your certificates.</p>
          <button class="btn-primary green" id="go-staff-login">Staff Login</button>
        </div>
      </div>
      <div id="calc-slot"></div>
      <div class="footer">Aligned to the Care Certificate 2026 · CQC Inspection Ready · Powered by Care2Learn</div>
    </div>
  `));
  document.getElementById("go-org-login").onclick = renderOrgLogin;
  document.getElementById("go-org-reg").onclick = renderOrgRegister;
  document.getElementById("go-staff-login").onclick = renderStaffLogin;
  document.getElementById("calc-slot").appendChild(buildCalculator());
}

// ─── ORG REGISTER ─────────────────────────────────────────────────────────────
function renderOrgRegister() {
  App.innerHTML = "";
  App.appendChild(el(`
    <div class="auth-page"><div class="auth-card">
      <button class="back-sm" id="back">← Back</button>
      <div class="auth-logo" style="display:flex;align-items:center;gap:8px">${logoMark(22, true)}<span>Care2Learn</span></div>
      <div class="auth-title">Register Your Organisation</div>
      <div class="auth-sub">Create your account to start managing staff training.</div>
      <div id="err"></div>
      <div class="fg"><label>Organisation Name *</label><input class="inp" id="name" placeholder="e.g. Sunrise Care Ltd"></div>
      <div class="fg"><label>Email Address *</label><input class="inp" id="email" type="email" placeholder="admin@yourorg.com"></div>
      <div class="fg"><label>Password *</label><input class="inp" id="password" type="password" placeholder="At least 6 characters"></div>
      <div class="fg"><label>Phone Number</label><input class="inp" id="phone" placeholder="01234 567890"></div>
      <div class="fg"><label>CQC Registration Number</label><input class="inp" id="cqc" placeholder="1-XXXXXXXXX"></div>
      <div class="fg"><label>Address</label><input class="inp" id="address" placeholder="123 High Street, Town"></div>
      <button class="btn-auth" id="submit">Register Organisation</button>
    </div></div>
  `));
  document.getElementById("back").onclick = renderLanding;
  document.getElementById("submit").onclick = async () => {
    const errBox = document.getElementById("err");
    errBox.innerHTML = "";
    const payload = {
      name: val("name"), email: val("email"), password: val("password"),
      phone: val("phone"), cqcNumber: val("cqc"), address: val("address"),
    };
    try {
      const { token } = await api("/org/register", "POST", payload);
      setAuth(token, "org");
      await renderOrgDash();
    } catch (e) { errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

// ─── ORG LOGIN ────────────────────────────────────────────────────────────────
function renderOrgLogin() {
  App.innerHTML = "";
  App.appendChild(el(`
    <div class="auth-page"><div class="auth-card">
      <button class="back-sm" id="back">← Back</button>
      <div class="auth-logo" style="display:flex;align-items:center;gap:8px">${logoMark(22, true)}<span>Care2Learn</span></div>
      <div class="auth-title">Organisation Login</div>
      <div id="err"></div>
      <div class="fg"><label>Email Address</label><input class="inp" id="email" type="email" placeholder="admin@yourorg.com"></div>
      <div class="fg"><label>Password</label><input class="inp" id="password" type="password" placeholder="Your password"></div>
      <button class="btn-auth" id="submit">Sign In</button>
      <button class="btn-demo" id="demo">🎯 Try Demo Account</button>
    </div></div>
  `));
  document.getElementById("back").onclick = renderLanding;
  document.getElementById("submit").onclick = () => doOrgLogin(val("email"), val("password"));
  document.getElementById("demo").onclick = () => doOrgLogin("demo@care2learn.co.uk", "demo123");
}
async function doOrgLogin(email, password) {
  const errBox = document.getElementById("err");
  if (errBox) errBox.innerHTML = "";
  try {
    const { token } = await api("/org/login", "POST", { email, password });
    setAuth(token, "org");
    await renderOrgDash();
  } catch (e) { if (errBox) errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ─── STAFF LOGIN ──────────────────────────────────────────────────────────────
function renderStaffLogin() {
  App.innerHTML = "";
  App.appendChild(el(`
    <div class="auth-page"><div class="auth-card">
      <button class="back-sm" id="back">← Back</button>
      <div class="auth-logo" style="display:flex;align-items:center;gap:8px">${logoMark(22, true)}<span>Care2Learn</span></div>
      <div class="auth-title">Staff Login</div>
      <div class="auth-sub">Use the email and PIN provided by your manager.</div>
      <div id="err"></div>
      <div class="fg"><label>Email Address</label><input class="inp" id="email" type="email" placeholder="your.name@email.com"></div>
      <div class="fg"><label>4-Digit PIN</label><input class="inp" id="pin" type="password" maxlength="4" placeholder="••••"></div>
      <button class="btn-auth" id="submit">Sign In</button>
      <button class="btn-demo" id="demo">🎯 Try Demo (Priya · 9012)</button>
    </div></div>
  `));
  document.getElementById("back").onclick = renderLanding;
  document.getElementById("submit").onclick = () => doStaffLogin(val("email"), val("pin"));
  document.getElementById("demo").onclick = () => doStaffLogin("priya@demo.com", "9012");
}
async function doStaffLogin(email, pin) {
  const errBox = document.getElementById("err");
  if (errBox) errBox.innerHTML = "";
  try {
    const { token } = await api("/staff/login", "POST", { email, pin });
    setAuth(token, "staff");
    await renderStaffPortal();
  } catch (e) { if (errBox) errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

function val(id) { const e = document.getElementById(id); return e ? e.value.trim() : ""; }

// ─── ORG DASHBOARD ────────────────────────────────────────────────────────────
let orgTab = "overview";
async function renderOrgDash() {
  const me = await api("/org/me");
  const org = me.org;

  App.innerHTML = "";
  App.appendChild(el(`
    <div>
      <div class="dash-hdr">
        <div class="dash-brand"><span class="dash-logo">${logoMark(26, false)}</span><div><div class="dash-org">${esc(org.name)}</div><div class="dash-sub">Care2Learn · Organisation Portal</div></div></div>
        <nav class="dash-nav" id="nav"></nav>
        <button class="feedback-btn" id="feedback">💬 Feedback</button>
        <button class="logout" id="logout">Log Out</button>
      </div>
      <div class="body" id="dashbody"></div>
    </div>
  `));

  const nav = document.getElementById("nav");
  [["overview","📊 Overview"],["staff","👥 Staff & Licences"],["compliance","✅ Compliance"],["settings","⚙️ Settings"]].forEach(([k,label]) => {
    const b = el(`<button class="nav-btn ${orgTab===k?"active":""}">${label}</button>`);
    b.onclick = () => { orgTab = k; paintOrgTab(org); };
    nav.appendChild(b);
  });
  document.getElementById("logout").onclick = async () => { await api("/logout","POST").catch(()=>{}); clearAuth(); renderLanding(); };
  document.getElementById("feedback").onclick = () => openFeedbackModal("Organisation portal");

  await paintOrgTab(org);
}

async function paintOrgTab(org) {
  // refresh active nav
  const navs = document.querySelectorAll("#nav .nav-btn");
  const keys = ["overview","staff","compliance","settings"];
  navs.forEach((b,i)=> b.classList.toggle("active", keys[i]===orgTab));

  const body = document.getElementById("dashbody");
  body.innerHTML = `<div class="spin">Loading…</div>`;

  if (orgTab === "overview") {
    const me = await api("/org/me");
    body.innerHTML = "";
    const hour = new Date().getHours();
    body.appendChild(el(`<div class="hero"><h1>Good ${hour<12?"morning":hour<18?"afternoon":"evening"}! 👋</h1><p>Training compliance overview for ${esc(me.org.name)}.</p></div>`));
    const m = me.summary;
    body.appendChild(el(`
      <div class="metrics">
        <div class="metric"><div class="metric-i">👥</div><div class="metric-v" style="color:#2980B9">${m.activeStaff}</div><div class="metric-l">Active Staff</div></div>
        <div class="metric"><div class="metric-i">✅</div><div class="metric-v" style="color:#27AE60">${m.fullyCompliant}</div><div class="metric-l">Fully Compliant</div></div>
        <div class="metric"><div class="metric-i">⚠️</div><div class="metric-v" style="color:#E67E22">${m.expiringSoon}</div><div class="metric-l">Expiring ≤30 days</div></div>
        <div class="metric"><div class="metric-i">📋</div><div class="metric-v" style="color:#9B59B6">${m.totalEnrolments}</div><div class="metric-l">Course Assignments</div></div>
      </div>
    `));
    body.appendChild(el(`<div class="sec-title">Compliance by Course</div>`));
    const grid = el(`<div class="cc-grid"></div>`);
    me.byCourse.forEach(c => {
      const total = m.activeStaff || 1;
      const pct = Math.round((c.completed / total) * 100);
      const color = pct >= 80 ? "#27AE60" : pct >= 50 ? "#E67E22" : "#E74C3C";
      grid.appendChild(el(`
        <div class="cc">
          <div class="cc-top"><span style="font-size:22px">${c.icon}</span><div style="flex:1"><div class="cc-name">${esc(c.title)}</div><div class="cc-frac" style="color:${color}">${c.completed}/${c.assigned||total}</div></div></div>
          <div class="cc-bar"><div class="cc-fill" style="width:${pct}%;background:${color}"></div></div>
        </div>
      `));
    });
    body.appendChild(grid);
  }

  if (orgTab === "staff") {
    const { staff } = await api("/org/staff");
    body.innerHTML = "";
    const sh = el(`<div class="sh"><h2>Staff & Licences</h2><button class="btn-add" id="add">+ Add Staff Member</button></div>`);
    body.appendChild(sh);
    const formSlot = el(`<div id="formslot"></div>`);
    body.appendChild(formSlot);

    document.getElementById("add").onclick = () => showAddStaffForm(formSlot);

    if (staff.length === 0) {
      body.appendChild(el(`<div class="table"><div class="empty">No staff yet. Click "Add Staff Member" to create your first licence.</div></div>`));
    } else {
      const table = el(`<div class="table"><div class="thead"><span>Name</span><span>Role</span><span>Progress</span><span>Status</span><span>PIN</span><span>Actions</span></div></div>`);
      staff.forEach(s => {
        const statusPill = !s.active ? `<span class="pill grey">Inactive</span>`
          : s.compliant ? `<span class="pill green">✓ Compliant</span>`
          : s.assignedCount === 0 ? `<span class="pill grey">No courses</span>`
          : `<span class="pill amber">In Progress</span>`;
        const row = el(`
          <div class="trow">
            <span><div class="t-name">${esc(s.name)}</div><div class="t-email">${esc(s.email)}</div></span>
            <span class="t-role">${esc(s.role)}</span>
            <span><b style="color:${s.completedCount===s.assignedCount&&s.assignedCount>0?"#27AE60":"#E67E22"}">${s.completedCount}</b>/${s.assignedCount}</span>
            <span>${statusPill}</span>
            <span class="t-pin">${esc(s.pin)}</span>
            <span class="row-actions">
              <button class="abtn" data-act="view">Manage</button>
              ${s.active ? `<button class="abtn danger" data-act="deact">Deactivate</button>` : `<button class="abtn" data-act="react">Reactivate</button>`}
            </span>
          </div>
        `);
        row.querySelector('[data-act="view"]').onclick = () => openStaffModal(s.id);
        const deact = row.querySelector('[data-act="deact"]');
        if (deact) deact.onclick = async () => { await api(`/org/staff/${s.id}`,"PATCH",{active:false}); toast(`${s.name}'s licence deactivated.`); paintOrgTab(org); };
        const react = row.querySelector('[data-act="react"]');
        if (react) react.onclick = async () => { await api(`/org/staff/${s.id}`,"PATCH",{active:true}); toast(`${s.name}'s licence reactivated.`); paintOrgTab(org); };
        table.appendChild(row);
      });
      body.appendChild(table);
    }
  }

  if (orgTab === "compliance") {
    const { staff } = await api("/org/staff");
    body.innerHTML = "";
    const ch = el(`<div class="sh"><h2>Compliance Report</h2><button class="btn-add" id="dlpdf">⬇ Download PDF</button></div>`);
    body.appendChild(ch);
    document.getElementById("dlpdf").onclick = () => downloadComplianceReport();
    const active = staff.filter(s => s.active);
    const matrix = el(`<div class="matrix"></div>`);
    const head = el(`<div class="mh"><span>Staff Member</span></div>`);
    state.courses.forEach(c => head.appendChild(el(`<span title="${esc(c.title)}">${c.icon}</span>`)));
    head.appendChild(el(`<span style="margin-left:auto;width:auto">Overall</span>`));
    matrix.appendChild(head);

    active.forEach(s => {
      const row = el(`<div class="mr"><span class="m-name">${esc(s.name)}</span></div>`);
      let validCount = 0;
      state.courses.forEach(c => {
        const enr = s.enrolments.find(e => e.courseId === c.id);
        let cls = "none", sym = "—";
        if (enr) {
          if (enr.compliance === "valid") { cls = "ok"; sym = "✓"; validCount++; }
          else if (enr.compliance === "expiring") { cls = "amber"; sym = "⚠"; validCount++; }
          else if (enr.compliance === "expired") { cls = "red"; sym = "✗"; }
          else if (enr.compliance === "in_progress") { cls = "prog"; sym = "◐"; }
          else if (enr.compliance === "failed") { cls = "red"; sym = "✗"; }
          else { cls = "none"; sym = "○"; }
        }
        const cell = el(`<span style="width:30px;text-align:center"><span class="cell ${cls}">${sym}</span></span>`);
        if (enr) cell.title = enr.courseTitle + " — " + enr.compliance + (enr.expiryDate ? " (until " + fmtDate(enr.expiryDate) + ")" : "");
        row.appendChild(cell);
      });
      row.appendChild(el(`<span style="margin-left:auto;width:auto"><b style="color:${validCount===state.courses.length?"#27AE60":"#E67E22"}">${validCount}/${state.courses.length}</b></span>`));
      matrix.appendChild(row);
    });
    if (active.length === 0) matrix.appendChild(el(`<div class="empty">No active staff to report on.</div>`));
    body.appendChild(matrix);
    body.appendChild(el(`<div class="legend"><span class="cell ok">✓</span>Valid <span class="cell amber">⚠</span>Expiring <span class="cell prog">◐</span>In progress <span class="cell red">✗</span>Expired/Failed <span class="cell none">○</span>Assigned <span class="cell none">—</span>Not assigned</div>`));
  }

  if (orgTab === "settings") {
    const me = await api("/org/me");
    const o = me.org;
    body.innerHTML = "";
    body.appendChild(el(`<h2 style="margin-bottom:18px">Organisation Settings</h2>`));
    body.appendChild(el(`
      <div class="scard">
        <div class="srow"><label>Organisation Name</label><span>${esc(o.name)}</span></div>
        <div class="srow"><label>Email Address</label><span>${esc(o.email)}</span></div>
        <div class="srow"><label>Phone Number</label><span>${esc(o.phone||"Not provided")}</span></div>
        <div class="srow"><label>CQC Number</label><span>${esc(o.cqc_number||"Not provided")}</span></div>
        <div class="srow"><label>Address</label><span>${esc(o.address||"Not provided")}</span></div>
        <div class="srow"><label>Registered Since</label><span>${fmtDate(o.created_at)}</span></div>
        <div class="srow"><label>Organisation ID</label><span class="mono">${esc(o.id)}</span></div>
      </div>
      <div class="scard" style="margin-top:16px">
        <h3>Subscription</h3>
        <div style="padding:0 20px 16px"><span class="pill" style="background:#2980B918;color:#1A5276">Standard Plan</span><p style="font-size:13px;color:#5A6474;line-height:1.6;margin-top:8px">Unlimited staff licences · All ${state.courses.length} mandatory courses · Course assignment · Progress tracking · Certificate generation · CQC compliance report</p></div>
      </div>
    `));
  }
}

// ── Add staff form ──
function showAddStaffForm(slot) {
  slot.innerHTML = "";
  const courseChecks = state.courses.map(c =>
    `<label class="chk" data-cid="${c.id}"><input type="checkbox" value="${c.id}"> ${c.icon} ${esc(c.title)}</label>`
  ).join("");
  const form = el(`
    <div class="cardform">
      <h3>Add New Staff Member</h3>
      <div id="aerr"></div>
      <div class="row2">
        <div class="fg"><label>Full Name *</label><input class="inp" id="a-name" placeholder="Jane Smith"></div>
        <div class="fg"><label>Email Address *</label><input class="inp" id="a-email" type="email" placeholder="jane@email.com"></div>
      </div>
      <div class="row2">
        <div class="fg"><label>Job Role</label>
          <select class="inp" id="a-role">
            ${["Care Assistant","Senior Carer","Team Leader","Deputy Manager","Registered Manager","Support Worker","Nurse","Other"].map(r=>`<option>${r}</option>`).join("")}
          </select>
        </div>
        <div class="fg"><label>Start Date</label><input class="inp" id="a-start" type="date" value="${new Date().toISOString().split("T")[0]}"></div>
      </div>
      <label style="display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px">Assign Courses (optional)</label>
      <div class="chk-grid">${courseChecks}</div>
      <div class="form-actions"><button class="btn-cancel" id="a-cancel">Cancel</button><button class="btn-save" id="a-save">Create Licence</button></div>
    </div>
  `);
  slot.appendChild(form);

  form.querySelectorAll(".chk").forEach(lbl => {
    const cb = lbl.querySelector("input");
    cb.onchange = () => lbl.classList.toggle("on", cb.checked);
  });
  document.getElementById("a-cancel").onclick = () => slot.innerHTML = "";
  document.getElementById("a-save").onclick = async () => {
    const errBox = document.getElementById("aerr");
    errBox.innerHTML = "";
    const courseIds = [...form.querySelectorAll(".chk input:checked")].map(c => c.value);
    const payload = {
      name: val("a-name"), email: val("a-email"),
      role: document.getElementById("a-role").value,
      startDate: val("a-start"), courseIds,
    };
    if (!payload.name || !payload.email) { errBox.innerHTML = `<div class="err">Name and email are required.</div>`; return; }
    try {
      const { pin } = await api("/org/staff", "POST", payload);
      slot.innerHTML = "";
      toast(`✓ Licence created. Login PIN: ${pin}`);
      paintOrgTab(null);
    } catch (e) { errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

// ── Staff management modal (assign/remove courses, view progress) ──
async function openStaffModal(staffId) {
  const { staff } = await api("/org/staff");
  const s = staff.find(x => x.id === staffId);
  if (!s) return;

  const assignedIds = s.enrolments.map(e => e.courseId);
  const available = state.courses.filter(c => !assignedIds.includes(c.id));

  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal">
      <div class="modal-h">
        <div><h2>${esc(s.name)}</h2><p>${esc(s.role)} · PIN ${esc(s.pin)}</p></div>
        <button class="x" id="close">✕</button>
      </div>
      <div class="info-row"><span>📧 ${esc(s.email)}</span><span>📅 Since ${fmtDate(s.startDate)}</span><span>${s.completedCount}/${s.assignedCount} completed</span></div>

      <div style="padding:18px 22px 6px"><b style="font-size:15px">Assigned Courses</b></div>
      <div id="assigned"></div>

      <div style="padding:14px 22px 6px;border-top:1px solid #F0F2F5;margin-top:8px"><b style="font-size:15px">Assign a New Course</b></div>
      <div style="padding:0 22px 18px" id="assign-slot"></div>
    </div>
  `);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();

  const assignedBox = modal.querySelector("#assigned");
  if (s.enrolments.length === 0) {
    assignedBox.appendChild(el(`<div style="padding:8px 22px;color:#7A8599;font-size:13px;font-style:italic">No courses assigned yet.</div>`));
  } else {
    s.enrolments.forEach(e => {
      const c = state.courses.find(x => x.id === e.courseId) || {};
      let badge;
      if (e.compliance === "valid") badge = `<span class="pill green">✓ ${e.score}% · valid to ${fmtDate(e.expiryDate)}</span>`;
      else if (e.compliance === "expiring") badge = `<span class="pill amber">⚠ expires ${fmtDate(e.expiryDate)}</span>`;
      else if (e.compliance === "expired") badge = `<span class="pill red">✗ expired ${fmtDate(e.expiryDate)}</span>`;
      else if (e.compliance === "in_progress") badge = `<span class="pill amber">◐ ${e.progress}% complete</span>`;
      else if (e.compliance === "failed") badge = `<span class="pill red">✗ failed (${e.score}%)</span>`;
      else badge = `<span class="pill grey">○ assigned</span>`;
      const row = el(`
        <div class="crow">
          <span class="crow-icon">${c.icon||"📘"}</span>
          <div style="flex:1"><div class="crow-name">${esc(e.courseTitle)}</div><div class="crow-meta">${badge}</div>
            <div class="mini-bar"><div class="mini-fill" style="width:${e.progress}%;background:${c.color||"#2980B9"}"></div></div>
          </div>
          <button class="abtn danger" data-remove="${e.courseId}">Remove</button>
        </div>
      `);
      row.querySelector("[data-remove]").onclick = async () => {
        await api(`/org/staff/${s.id}/enrol/${e.courseId}`, "DELETE");
        overlay.remove();
        toast("Course removed.");
        paintOrgTab(null);
        openStaffModal(s.id);
      };
      assignedBox.appendChild(row);
    });
  }

  const assignSlot = modal.querySelector("#assign-slot");
  if (available.length === 0) {
    assignSlot.appendChild(el(`<div style="color:#7A8599;font-size:13px;font-style:italic">All courses assigned.</div>`));
  } else {
    const sel = el(`<select class="inp" style="margin-bottom:10px">${available.map(c=>`<option value="${c.id}">${c.icon} ${esc(c.title)}</option>`).join("")}</select>`);
    const btn = el(`<button class="btn-save" style="width:100%">Assign Course</button>`);
    assignSlot.appendChild(sel);
    assignSlot.appendChild(btn);
    btn.onclick = async () => {
      await api(`/org/staff/${s.id}/enrol`, "POST", { courseId: sel.value });
      overlay.remove();
      toast("Course assigned.");
      paintOrgTab(null);
      openStaffModal(s.id);
    };
  }
}

// ─── STAFF PORTAL ─────────────────────────────────────────────────────────────
let staffTab = "courses";
// ── Feedback modal (compliments, bugs, feature requests) ──
function openFeedbackModal(context) {
  let kind = "compliment";
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:520px">
      <div class="modal-h">
        <div><h2>Send feedback</h2><p>Compliments, bugs, or features you'd like to see in Care2Learn</p></div>
        <button class="x" id="close">✕</button>
      </div>
      <div style="padding:18px 22px 22px">
        <div class="fb-kinds" id="fbkinds">
          <button class="fb-kind active" data-kind="compliment">👍 Compliment</button>
          <button class="fb-kind" data-kind="bug">🐞 Bug</button>
          <button class="fb-kind" data-kind="feature">💡 Feature</button>
        </div>
        <textarea id="fbmsg" class="fb-msg" rows="5" placeholder="Tell us what's on your mind…"></textarea>
        <div id="fberr" class="fb-err" style="display:none"></div>
        <button class="fb-send" id="fbsend">Send feedback</button>
        <p class="fb-note">Your name and role are included so the Care2Learn team can follow up if needed.</p>
      </div>
    </div>
  `);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();

  const kindsWrap = modal.querySelector("#fbkinds");
  kindsWrap.querySelectorAll(".fb-kind").forEach(btn => {
    btn.onclick = () => {
      kind = btn.dataset.kind;
      kindsWrap.querySelectorAll(".fb-kind").forEach(b => b.classList.toggle("active", b === btn));
    };
  });

  const send = modal.querySelector("#fbsend");
  const err = modal.querySelector("#fberr");
  send.onclick = async () => {
    const message = modal.querySelector("#fbmsg").value.trim();
    if (message.length < 3) { err.textContent = "Please add a little more detail."; err.style.display = "block"; return; }
    err.style.display = "none";
    send.disabled = true; send.textContent = "Sending…";
    try { await api("/feedback", "POST", { kind, message, context: context || "" }); }
    catch (e) { /* offline/demo — still acknowledge the submission */ }
    modal.innerHTML = `
      <div style="padding:46px 28px;text-align:center">
        <div style="font-size:56px;margin-bottom:10px">🙏</div>
        <h2 style="font-size:21px;font-weight:800;color:#1B2A4A;margin-bottom:8px">Thank you!</h2>
        <p style="font-size:14px;color:#5A6474;line-height:1.6;max-width:340px;margin:0 auto 22px">Your feedback has been sent to the Care2Learn team. We read every message.</p>
        <button class="fb-send" id="fbdone" style="max-width:200px;margin:0 auto">Done</button>
      </div>`;
    modal.querySelector("#fbdone").onclick = () => overlay.remove();
  };
  setTimeout(() => modal.querySelector("#fbmsg")?.focus(), 50);
}

async function renderStaffPortal() {
  const me = await api("/staff/me");
  App.innerHTML = "";
  App.appendChild(el(`
    <div>
      <div class="dash-hdr">
        <div class="dash-brand"><span class="dash-logo">👤</span><div><div class="dash-org">${esc(me.staff.name)}</div><div class="dash-sub">${esc(me.staff.role)} · ${esc(me.org.name)}</div></div></div>
        <nav class="dash-nav" id="snav"></nav>
        <button class="feedback-btn" id="feedback">💬 Feedback</button>
        <button class="logout" id="logout">Log Out</button>
      </div>
      <div class="body" id="sbody"></div>
    </div>
  `));
  const nav = document.getElementById("snav");
  [["courses","📚 My Courses"],["certificates","🏆 Certificates"],["profile","👤 Profile"]].forEach(([k,label]) => {
    const b = el(`<button class="nav-btn ${staffTab===k?"active":""}">${label}</button>`);
    b.onclick = () => { staffTab = k; paintStaffTab(); };
    nav.appendChild(b);
  });
  document.getElementById("logout").onclick = async () => { await api("/logout","POST").catch(()=>{}); clearAuth(); renderLanding(); };
  document.getElementById("feedback").onclick = () => openFeedbackModal("Staff portal");
  await paintStaffTab();
}

async function paintStaffTab() {
  const navs = document.querySelectorAll("#snav .nav-btn");
  const keys = ["courses","certificates","profile"];
  navs.forEach((b,i)=> b.classList.toggle("active", keys[i]===staffTab));

  const me = await api("/staff/me");
  const body = document.getElementById("sbody");
  body.innerHTML = "";

  const enrolments = me.enrolments;
  const valid = enrolments.filter(e => e.compliance === "valid" || e.compliance === "expiring");
  const doneCount = valid.length;
  const total = enrolments.length;

  if (staffTab === "courses") {
    body.appendChild(el(`<div class="hero"><h1>Welcome back, ${esc(me.staff.name.split(" ")[0])}! 👋</h1><p>You've completed <b style="color:#27AE60">${doneCount} of ${total}</b> assigned course${total===1?"":"s"}.</p></div>`));

    const expiring = enrolments.filter(e => e.compliance === "expiring");
    if (expiring.length) {
      body.appendChild(el(`<div class="alert">⚠️ <b>${expiring.length} certificate${expiring.length>1?"s":""} expiring within 30 days.</b> Please renew to stay compliant.</div>`));
    }

    if (total === 0) {
      body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">No courses have been assigned to you yet. Your manager will assign your mandatory training.</div>`));
    } else {
      body.appendChild(el(`<div class="obar-wrap"><div class="obar-l"><span>Overall Progress</span><span>${Math.round((doneCount/total)*100)}%</span></div><div class="obar"><div class="obar-f" style="width:${(doneCount/total)*100}%"></div></div></div>`));
      const grid = el(`<div class="sc-grid"></div>`);
      enrolments.forEach(e => {
        const c = state.courses.find(x => x.id === e.courseId) || {};
        let badge = "", cta = "Start Course →";
        if (e.compliance === "valid") { badge = `<span class="sc-badge" style="background:rgba(255,255,255,.25)">✓ Valid</span>`; }
        else if (e.compliance === "expiring") { badge = `<span class="sc-badge" style="background:rgba(230,126,34,.4)">⚠ Expiring</span>`; }
        else if (e.compliance === "expired") { badge = `<span class="sc-badge" style="background:rgba(231,76,60,.4)">Expired</span>`; cta = "Renew Now"; }
        else if (e.compliance === "in_progress") { badge = `<span class="sc-badge" style="background:rgba(255,255,255,.25)">◐ ${e.progress}%</span>`; cta = "Continue →"; }
        else if (e.compliance === "failed") { badge = `<span class="sc-badge" style="background:rgba(231,76,60,.4)">Retake</span>`; cta = "Retake →"; }

        const card = el(`
          <div class="sc">
            <div class="sc-top" style="background:${c.color||"#1B2A4A"}"><span style="font-size:32px">${c.icon||"📘"}</span>${badge}</div>
            <div class="sc-body">
              <div style="font-size:10px;font-weight:700;color:#2980B9;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Mandatory</div>
              <div class="sc-title">${esc(e.courseTitle)}</div>
              <div class="sc-meta">⏱ ${c.duration||""} · ${c.modules ? c.modules.length + " modules" : (c.quiz||[]).length + " questions"}${e.dueDate?` · due ${fmtDate(e.dueDate)}`:""}</div>
              ${e.compliance==="in_progress" ? `<div class="obar-mini" style="margin-bottom:11px"><div class="obar-mini-f" style="width:${e.progress}%;background:${c.color}"></div></div>` : ""}
              ${(e.compliance==="valid"||e.compliance==="expiring")
                ? `<div class="sc-done"><div class="sc-score" style="color:${c.color||"#2980B9"}">${e.score}%</div><div class="sc-exp">Expires ${fmtDate(e.expiryDate)}</div></div>`
                : `<button class="sc-cta" style="background:${c.color||"#2980B9"}">${cta}</button>`}
            </div>
          </div>
        `);
        card.onclick = () => (c.modules ? openCareCertificate(e.courseId, me) : openCoursePlayer(e.courseId, me));
        grid.appendChild(card);
      });
      body.appendChild(grid);
    }
  }

  if (staffTab === "certificates") {
    body.appendChild(el(`<h2 style="margin-bottom:18px">My Certificates</h2>`));
    const certs = enrolments.filter(e => e.certId && (e.compliance==="valid"||e.compliance==="expiring"||e.compliance==="expired"));
    if (certs.length === 0) {
      body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">No certificates yet. Complete a course to earn one.</div>`));
    } else {
      const grid = el(`<div class="sc-grid"></div>`);
      certs.forEach(e => {
        const c = state.courses.find(x => x.id === e.courseId) || {};
        const pillCls = e.compliance==="valid"?"green":e.compliance==="expiring"?"amber":"red";
        const card = el(`
          <div class="scard" style="border-top:4px solid ${c.color}">
            <div style="padding:18px">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px"><span style="font-size:32px">${c.icon}</span><span class="pill ${pillCls}">${e.compliance==="valid"?"✓ Valid":e.compliance==="expiring"?"⚠ Expiring":"Expired"}</span></div>
              <div style="font-size:15px;font-weight:800;margin-bottom:12px">${esc(e.courseTitle)}</div>
              <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;font-size:13px">
                <div><div class="cm-l">Score</div><div style="font-weight:700;color:${c.color}">${e.score}%</div></div>
                <div><div class="cm-l">Completed</div><div style="font-weight:700">${fmtDate(e.completedAt)}</div></div>
                <div><div class="cm-l">Valid Until</div><div style="font-weight:700">${fmtDate(e.expiryDate)}</div></div>
                <div><div class="cm-l">Cert ID</div><div class="mono">${esc(e.certId)}</div></div>
              </div>
              <button class="btn-out" style="width:100%;border-color:${c.color};color:${c.color}" data-cert="${e.courseId}">View Certificate</button>
            </div>
          </div>
        `);
        card.querySelector("[data-cert]").onclick = () => showCertificate(e, me);
        grid.appendChild(card);
      });
      body.appendChild(grid);
    }
  }

  if (staffTab === "profile") {
    body.appendChild(el(`<h2 style="margin-bottom:18px">My Profile</h2>`));
    body.appendChild(el(`
      <div class="scard">
        <div class="srow"><label>Full Name</label><span>${esc(me.staff.name)}</span></div>
        <div class="srow"><label>Email Address</label><span>${esc(me.staff.email)}</span></div>
        <div class="srow"><label>Job Role</label><span>${esc(me.staff.role)}</span></div>
        <div class="srow"><label>Organisation</label><span>${esc(me.org.name)}</span></div>
        <div class="srow"><label>Start Date</label><span>${fmtDate(me.staff.startDate)}</span></div>
        <div class="srow"><label>Login PIN</label><span class="mono">${esc(me.staff.pin)}</span></div>
      </div>
      <div class="scard" style="margin-top:16px">
        <h3>Training Summary</h3>
        <div class="srow"><label>Courses Completed</label><span style="color:#27AE60;font-weight:700">${doneCount} / ${total}</span></div>
        <div class="srow"><label>Compliance</label><span class="pill ${doneCount===total&&total>0?"green":"amber"}">${doneCount===total&&total>0?"✓ Fully Compliant":"In Progress"}</span></div>
      </div>
    `));
  }
}

// ─── COURSE PLAYER ────────────────────────────────────────────────────────────
// ─── COURSE PLAYER ────────────────────────────────────────────────────────────

// Render the visual for a slide based on its `visual` type
function renderSlideVisual(slide, course) {
  const c = course.color;
  const v = slide.visual || "icon";
  const d = slide.visualData || {};

  if (v === "stat" && d.stats) {
    return `<div class="vstat"><div class="vstat-icon">${course.icon}</div><div class="vstat-row">${
      d.stats.map(s => `<div class="vstat-card"><div class="vstat-n" style="color:${c}">${esc(s.n)}</div><div class="vstat-l">${esc(s.l)}</div></div>`).join("")
    }</div></div>`;
  }
  if (v === "grid" && d.items) {
    return `<div class="vgrid">${
      d.items.map((it, i) => `<div class="vgrid-item" style="border-left-color:${c}"><span class="vgrid-num" style="color:${c}">${i+1}</span>${esc(it)}</div>`).join("")
    }</div>`;
  }
  if (v === "flow" && d.steps) {
    return `<div class="vflow">${
      d.steps.map((s, i) => `<div class="vflow-step"><span class="vflow-num" style="background:${c}">${i+1}</span>${esc(s)}</div>${i < d.steps.length-1 ? `<div class="vflow-arr">↓</div>` : ""}`).join("")
    }</div>`;
  }
  if (v === "pillars" && d.items) {
    return `<div class="vpillars">${
      d.items.map(it => `<div class="vpillar" style="border-top-color:${c}">${esc(it)}</div>`).join("")
    }</div>`;
  }
  if (v === "compare" && d.left && d.right) {
    const col = (side, bg) => `<div class="vcol"><div class="vcol-h" style="background:${bg}">${esc(side.title)}</div><ul class="vcol-items">${side.items.map(i=>`<li>${esc(i)}</li>`).join("")}</ul></div>`;
    return `<div class="vcompare">${col(d.left, c)}${col(d.right, "#5A6474")}</div>`;
  }
  if (v === "cycle" && d.items) {
    return `<div class="vcycle">${
      d.items.map((it, i) => `<span class="vcycle-item" style="border-color:${c}">${esc(it)}</span>${i < d.items.length-1 ? `<span class="vcycle-arr">→</span>` : ""}`).join("")
    }</div>`;
  }
  // fallback
  return `<div class="svis-emoji">${course.icon}</div>`;
}

async function openCoursePlayer(courseId, me, opts) {
  const course = state.courses.find(c => c.id === courseId);
  if (!course) return;
  const enr = (me.enrolments || []).find(e => e.courseId === courseId);
  const alreadyStarted = enr && enr.progress > 0 && enr.status !== "completed";

  // stage: "intro" | "slides" | "quiz"
  let stage = (opts && opts.stage) || "intro";
  let slideIdx = 0;
  let inQuiz = false;

  function render() {
    App.innerHTML = "";
    const wrap = el(`<div></div>`);

    // ── INTRO SCREEN ──
    if (stage === "intro") {
      wrap.appendChild(el(`
        <div class="player-hdr" style="background:${course.color}">
          <button class="back-btn" id="pback">← Back to my courses</button>
          <div class="player-title"><span>${course.icon}</span><span>${esc(course.title)}</span></div>
          <div class="player-prog"></div>
        </div>
      `));
      const intro = el(`<div class="intro"></div>`);
      const card = el(`
        <div class="intro-card">
          <div class="intro-top" style="background:linear-gradient(135deg,${course.color},${course.color}cc)">
            <div class="intro-icon">${course.icon}</div>
            <div class="intro-title">${esc(course.title)}</div>
            <div class="intro-summary">${esc(course.summary || "")}</div>
            <div class="intro-meta">
              <div class="intro-meta-item"><span class="intro-meta-n">${course.slides.length}</span><span class="intro-meta-l">Sections</span></div>
              <div class="intro-meta-item"><span class="intro-meta-n">${course.quiz.length}</span><span class="intro-meta-l">Questions</span></div>
              <div class="intro-meta-item"><span class="intro-meta-n">⏱ ${esc(course.duration||"")}</span><span class="intro-meta-l">Duration</span></div>
              <div class="intro-meta-item"><span class="intro-meta-n">70%</span><span class="intro-meta-l">To pass</span></div>
            </div>
          </div>
          <div class="intro-body">
            ${alreadyStarted ? `<div class="intro-resume">You're ${enr.progress}% through this course — your progress is saved.</div>` : ""}
            <h3>📋 What you'll learn</h3>
            <ul class="obj-list">${
              (course.objectives||[]).map(o => `<li><span class="obj-check" style="background:${course.color}">✓</span>${esc(o)}</li>`).join("")
            }</ul>
            <button class="intro-start" id="startbtn" style="background:${course.color}">${alreadyStarted ? "Resume Course →" : "Begin Course →"}</button>
          </div>
        </div>
      `);
      intro.appendChild(card);
      wrap.appendChild(intro);
      App.appendChild(wrap);
      document.getElementById("pback").onclick = () => renderStaffPortal();
      document.getElementById("startbtn").onclick = () => { stage = "slides"; slideIdx = 0; render(); };
      return;
    }

    // ── HEADER (slides + quiz) ──
    wrap.appendChild(el(`
      <div class="player-hdr" style="background:${course.color}">
        <button class="back-btn" id="pback">← Back</button>
        <div class="player-title"><span>${course.icon}</span><span>${esc(course.title)}</span></div>
        <div class="player-prog">${inQuiz ? "Assessment" : `Section ${slideIdx+1} of ${course.slides.length}`}</div>
      </div>
    `));

    if (!inQuiz) {
      // progress bar instead of plain dots
      const pct = Math.round(((slideIdx) / course.slides.length) * 100);
      const dots = el(`<div class="dots"></div>`);
      course.slides.forEach((_, i) => dots.appendChild(el(`<div class="dot" style="background:${i <= slideIdx ? course.color : "#E0E0E0"}"></div>`)));
      wrap.appendChild(dots);

      const s = course.slides[slideIdx];
      const pbody = el(`<div class="pbody"></div>`);
      pbody.appendChild(el(`
        <div class="slide">
          <div class="svis">${renderSlideVisual(s, course)}</div>
          <div>
            <div style="font-size:11px;font-weight:700;color:${course.color};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Section ${slideIdx+1}</div>
            <h2 style="color:${course.color}">${esc(s.heading)}</h2>
            <p class="slide-body-txt">${esc(s.body)}</p>
            <ul class="plist">${s.points.map(p => `<li><span class="pdot" style="background:${course.color}"></span>${esc(p)}</li>`).join("")}</ul>
          </div>
        </div>
      `));
      const nav = el(`<div class="snav"></div>`);
      if (slideIdx > 0) { const b = el(`<button class="btn-out" style="border-color:${course.color};color:${course.color}">← Previous</button>`); b.onclick = () => { slideIdx--; render(); }; nav.appendChild(b); }
      else { const b = el(`<button class="btn-out" style="border-color:#BDC3C7;color:#7A8599">← Overview</button>`); b.onclick = () => { stage = "intro"; render(); }; nav.appendChild(b); }
      nav.appendChild(el(`<div style="flex:1"></div>`));
      if (slideIdx < course.slides.length-1) { const b = el(`<button class="btn-go" style="background:${course.color}">Next →</button>`); b.onclick = async () => { slideIdx++; await saveProgress(); render(); }; nav.appendChild(b); }
      else { const b = el(`<button class="btn-go" style="background:${course.color}">📝 Start Assessment</button>`); b.onclick = async () => { inQuiz = true; await saveProgress(100); render(); }; nav.appendChild(b); }
      pbody.appendChild(nav);
      wrap.appendChild(pbody);
    } else {
      wrap.appendChild(renderQuiz(course, me, () => { openCoursePlayer(courseId, me, { stage: "slides" }); }));
    }

    App.appendChild(wrap);
    document.getElementById("pback").onclick = () => renderStaffPortal();
  }

  async function saveProgress(force) {
    const pct = force != null ? force : Math.round(((slideIdx+1) / (course.slides.length+1)) * 100);
    try { await api("/staff/progress", "POST", { courseId, progress: pct }); } catch (e) {}
  }

  render();
}

// ── Modular player (Care Certificate) ──
async function openCareCertificate(courseId, me) {
  const course = state.courses.find(c => c.id === courseId);
  if (!course || !Array.isArray(course.modules)) return openCoursePlayer(courseId, me);
  const enr = (me.enrolments || []).find(e => e.courseId === courseId) || { courseId, courseTitle: course.title };
  const completed = new Set(enr.modulesCompleted || []);

  function renderMenu() {
    App.innerHTML = "";
    const wrap = el(`<div></div>`);
    const total = course.modules.length;
    const doneCount = course.modules.filter(m => completed.has(m.id)).length;
    const pct = Math.round((doneCount / total) * 100);
    wrap.appendChild(el(`
      <div class="player-hdr" style="background:${course.color}">
        <button class="back-btn" id="pback">← Back to my courses</button>
        <div class="player-title"><span>${course.icon}</span><span>${esc(course.title)}</span></div>
        <div class="player-prog">${doneCount}/${total} complete</div>
      </div>`));
    const menu = el(`<div class="cc-menu"></div>`);
    menu.appendChild(el(`
      <div class="cc-head">
        <h2>${esc(course.title)}</h2>
        <p>${esc(course.summary)}</p>
        <div class="cc-prog"><div class="cc-prog-f" style="width:${pct}%;background:${course.color}"></div></div>
        <div class="cc-prog-l">${doneCount} of ${total} modules complete${doneCount === total ? " — all done! 🎉" : ""}</div>
      </div>`));
    if (doneCount === total) {
      const certBox = el(`<div class="cc-cert"><b>🎓 Care Certificate complete!</b><p>You've finished all 16 standards.</p></div>`);
      menu.appendChild(certBox);
      if (enr.certId) {
        const cb = el(`<button class="intro-start" style="background:${course.color};max-width:300px;margin:0 auto 6px">View Certificate →</button>`);
        cb.onclick = () => printCertificate(enr, me);
        menu.appendChild(cb);
      }
    }
    const list = el(`<div class="cc-mods"></div>`);
    course.modules.forEach((m, i) => {
      const isDone = completed.has(m.id);
      const item = el(`
        <button class="cc-mod ${isDone ? "done" : ""}" style="--c:${course.color}">
          <span class="cc-num" style="background:${isDone ? course.color : "#E0E6ED"};color:${isDone ? "#fff" : "#5A6474"}">${isDone ? "✓" : i + 1}</span>
          <span class="cc-mod-body"><span class="cc-mod-title">${esc(m.title)}</span><span class="cc-mod-sum">${esc(m.summary || "")}</span></span>
          <span class="cc-mod-cta" style="color:${course.color}">${isDone ? "Review" : "Start"} →</span>
        </button>`);
      item.onclick = () => openModule(i);
      list.appendChild(item);
    });
    menu.appendChild(list);
    wrap.appendChild(menu);
    App.appendChild(wrap);
    document.getElementById("pback").onclick = () => renderStaffPortal();
  }

  function openModule(idx) {
    const m = course.modules[idx];
    let slideIdx = 0, inQuiz = false;
    function render() {
      App.innerHTML = "";
      const wrap = el(`<div></div>`);
      wrap.appendChild(el(`
        <div class="player-hdr" style="background:${course.color}">
          <button class="back-btn" id="mback">← Modules</button>
          <div class="player-title"><span>${course.icon}</span><span>${esc(m.title)}</span></div>
          <div class="player-prog">${inQuiz ? "Quiz" : `Step ${slideIdx + 1} of ${m.slides.length}`}</div>
        </div>`));
      if (!inQuiz) {
        const dots = el(`<div class="dots"></div>`);
        m.slides.forEach((_, i) => dots.appendChild(el(`<div class="dot" style="background:${i <= slideIdx ? course.color : "#E0E0E0"}"></div>`)));
        wrap.appendChild(dots);
        const s = m.slides[slideIdx];
        const pbody = el(`<div class="pbody"></div>`);
        pbody.appendChild(el(`
          <div class="slide">
            <div class="svis">${renderSlideVisual(s, course)}</div>
            <div>
              <div style="font-size:11px;font-weight:700;color:${course.color};text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">${esc(m.title)}</div>
              <h2 style="color:${course.color}">${esc(s.heading)}</h2>
              <p class="slide-body-txt">${esc(s.body)}</p>
              <ul class="plist">${s.points.map(p => `<li><span class="pdot" style="background:${course.color}"></span>${esc(p)}</li>`).join("")}</ul>
            </div>
          </div>`));
        const nav = el(`<div class="snav"></div>`);
        if (slideIdx > 0) { const b = el(`<button class="btn-out" style="border-color:${course.color};color:${course.color}">← Previous</button>`); b.onclick = () => { slideIdx--; render(); }; nav.appendChild(b); }
        else { const b = el(`<button class="btn-out" style="border-color:#BDC3C7;color:#7A8599">← Modules</button>`); b.onclick = () => renderMenu(); nav.appendChild(b); }
        nav.appendChild(el(`<div style="flex:1"></div>`));
        if (slideIdx < m.slides.length - 1) { const b = el(`<button class="btn-go" style="background:${course.color}">Next →</button>`); b.onclick = () => { slideIdx++; render(); }; nav.appendChild(b); }
        else { const b = el(`<button class="btn-go" style="background:${course.color}">📝 Take the quiz</button>`); b.onclick = () => { inQuiz = true; render(); }; nav.appendChild(b); }
        pbody.appendChild(nav);
        wrap.appendChild(pbody);
      } else {
        wrap.appendChild(renderModuleQuiz(course, m,
          () => { slideIdx = 0; inQuiz = false; render(); },
          async (score) => {
            completed.add(m.id);
            enr.modulesCompleted = [...completed];
            try {
              const r = await api("/staff/module-complete", "POST", { courseId, moduleId: m.id, score });
              if (r && r.enrolment) Object.assign(enr, r.enrolment, { modulesCompleted: [...completed] });
            } catch (e) { /* offline/demo: keep the optimistic local completion */ }
            renderMenu();
          }));
      }
      App.appendChild(wrap);
      document.getElementById("mback").onclick = () => renderMenu();
    }
    render();
  }

  renderMenu();
}

// Compact per-module quiz: pass is two-thirds correct. Calls onPass(score) or onRetry().
function renderModuleQuiz(course, module, onRetry, onPass) {
  const wrap = el(`<div class="pbody"></div>`);
  const quiz = module.quiz;
  const passNeed = Math.max(1, Math.ceil(quiz.length * 0.66));
  let cur = 0, selected = null, answered = false, correct = 0;
  function paint() {
    if (cur >= quiz.length) return showResult();
    wrap.innerHTML = "";
    const q = quiz[cur];
    const inner = el(`<div class="quiz"></div>`);
    inner.appendChild(el(`<div class="qbar"><div class="qbar-f" style="width:${(cur / quiz.length) * 100}%;background:${course.color}"></div></div>`));
    inner.appendChild(el(`<div class="qmeta"><span style="color:${course.color};font-weight:700">Question ${cur + 1} of ${quiz.length}</span><span style="color:#7A8599">Pass: ${passNeed} of ${quiz.length}</span></div>`));
    inner.appendChild(el(`<div class="qq">${esc(q.q)}</div>`));
    const opts = el(`<div class="qopts"></div>`);
    q.options.forEach((opt, i) => {
      let cls = "qopt";
      if (answered) { if (i === q.answer) cls += " correct"; else if (i === selected) cls += " wrong"; }
      const b = el(`<button class="${cls}"><span class="qletter">${["A", "B", "C", "D"][i]}</span>${esc(opt)}</button>`);
      if (answered && i === q.answer) { b.style.borderColor = course.color; b.style.background = course.color + "15"; }
      b.onclick = () => { if (answered) return; selected = i; answered = true; if (i === q.answer) correct++; paint(); };
      opts.appendChild(b);
    });
    inner.appendChild(opts);
    if (answered) {
      inner.appendChild(el(`<div class="qexp" style="border-left:3px solid ${course.color}"><b style="color:${selected === q.answer ? course.color : "#E74C3C"}">${selected === q.answer ? "✓ Correct!" : "✗ Incorrect"}</b><p>${esc(q.explanation || "")}</p></div>`));
      const nb = el(`<button class="qnext" style="background:${course.color}">${cur + 1 >= quiz.length ? "See result" : "Next →"}</button>`);
      nb.onclick = () => { cur++; selected = null; answered = false; paint(); };
      inner.appendChild(nb);
    }
    wrap.appendChild(inner);
  }
  function showResult() {
    wrap.innerHTML = "";
    const score = Math.round((correct / quiz.length) * 100);
    const passed = correct >= passNeed;
    const box = el(`<div class="quiz" style="text-align:center">
      <div style="font-size:54px;margin-bottom:6px">${passed ? "🎉" : "📘"}</div>
      <h2 style="color:${passed ? course.color : "#E67E22"};margin-bottom:6px">${passed ? "Module complete!" : "Not quite there"}</h2>
      <p style="color:#5A6474;margin-bottom:4px">You scored ${correct} of ${quiz.length} (${score}%).</p>
      <p style="color:#7A8599;font-size:13px;margin-bottom:20px">${passed ? "This module is now ticked off." : `You need ${passNeed} of ${quiz.length} to pass.`}</p>
    </div>`);
    const btn = el(`<button class="qnext" style="background:${passed ? course.color : "#E67E22"};max-width:320px;margin:0 auto">${passed ? "Back to modules →" : "Try again"}</button>`);
    btn.onclick = () => { if (passed) onPass(score); else onRetry(); };
    box.appendChild(btn);
    wrap.appendChild(box);
  }
  paint();
  return wrap;
}

// ── Quiz ──
function renderQuiz(course, me, onRestart) {
  const wrap = el(`<div class="pbody"></div>`);
  const quiz = course.quiz;
  let cur = 0, selected = null, answered = false, correct = 0;
  const results = [];

  function paint() {
    wrap.innerHTML = "";
    const q = quiz[cur];
    const inner = el(`<div class="quiz"></div>`);
    inner.appendChild(el(`<div class="qbar"><div class="qbar-f" style="width:${(cur/quiz.length)*100}%;background:${course.color}"></div></div>`));
    inner.appendChild(el(`<div class="qmeta"><span style="color:${course.color};font-weight:700">Question ${cur+1} of ${quiz.length}</span><span style="color:#7A8599">Score: ${correct}</span></div>`));
    inner.appendChild(el(`<div class="qq">${esc(q.q)}</div>`));
    const opts = el(`<div class="qopts"></div>`);
    q.options.forEach((opt,i) => {
      let cls = "qopt";
      if (answered) { if (i===q.answer) cls+=" correct"; else if (i===selected) cls+=" wrong"; }
      const b = el(`<button class="${cls}"><span class="qletter">${["A","B","C","D"][i]}</span>${esc(opt)}</button>`);
      if (answered && i===q.answer) { b.style.borderColor=course.color; b.style.background=course.color+"15"; }
      b.onclick = () => {
        if (answered) return;
        selected = i; answered = true;
        if (i===q.answer) correct++;
        results.push(i===q.answer);
        paint();
      };
      opts.appendChild(b);
    });
    inner.appendChild(opts);
    if (answered) {
      inner.appendChild(el(`<div class="qexp" style="border-left:3px solid ${course.color}"><b style="color:${selected===q.answer?course.color:"#E74C3C"}">${selected===q.answer?"✓ Correct!":"✗ Incorrect"}</b><p>${esc(q.explanation)}</p></div>`));
      const nb = el(`<button class="qnext" style="background:${course.color}">${cur+1>=quiz.length?"View Results":"Next →"}</button>`);
      nb.onclick = async () => {
        if (cur+1 >= quiz.length) { await finish(); }
        else { cur++; selected=null; answered=false; paint(); }
      };
      inner.appendChild(nb);
    }
    wrap.appendChild(inner);
  }

  async function finish() {
    const score = Math.round((results.filter(Boolean).length / quiz.length) * 100);
    let passed = score >= 70;
    let enrolment = null;
    try {
      const r = await api("/staff/quiz", "POST", { courseId: course.id, score });
      passed = r.passed;
      enrolment = r.enrolment;
    } catch (e) {}
    wrap.innerHTML = "";
    const done = el(`
      <div class="qdone">
        <div style="font-size:56px;margin-bottom:12px">${passed?"🏆":"📚"}</div>
        <h2 style="color:${passed?course.color:"#E74C3C"};margin-bottom:8px">${passed?"Competency Confirmed!":"Additional Study Required"}</h2>
        <div class="qscore-box" style="border-color:${passed?course.color:"#E74C3C"}"><span class="qbig" style="color:${passed?course.color:"#E74C3C"}">${score}%</span><span style="color:#7A8599;font-size:14px">${results.filter(Boolean).length} of ${quiz.length} correct</span></div>
        <p style="color:#5A6474;font-size:14px;line-height:1.7;max-width:400px;margin:0 auto">${passed?"You have demonstrated competency. Your certificate has been issued and your progress saved — your manager can now see this course as complete.":"You scored below the 70% pass mark. Review the course sections and try the assessment again."}</p>
      </div>
    `);
    if (!passed) {
      const rb = el(`<button class="btn-retry" style="border-color:${course.color};color:${course.color}">Retake Assessment</button>`);
      rb.onclick = onRestart;
      done.appendChild(rb);
    } else {
      if (enrolment && enrolment.certId) {
        const vc = el(`<button class="btn-go" style="background:${course.color};margin:18px auto 0">🏆 View Your Certificate</button>`);
        vc.onclick = () => showCertificate(enrolment, me);
        done.appendChild(vc);
      }
      const bb = el(`<button class="btn-retry" style="border-color:${course.color};color:${course.color}">Back to My Courses</button>`);
      bb.onclick = () => renderStaffPortal();
      done.appendChild(bb);
    }
    wrap.appendChild(done);
  }

  paint();
  return wrap;
}

// ── Certificate modal ──
// ── Print the certificate via a hidden iframe (no pop-up window required) ──
function printCertificate(enr, me) {
  const c = state.courses.find(x => x.id === enr.courseId) || {};
  const color = c.color || "#1B2A4A";
  const doc =
'<!DOCTYPE html><html><head><meta charset="utf-8">' +
'<title>Certificate — ' + esc(enr.courseTitle) + ' — ' + esc(me.staff.name) + '</title>' +
'<style>' +
'@page{size:A4 portrait;margin:14mm;}' +
'*{box-sizing:border-box;margin:0;padding:0;}' +
'body{font-family:"Segoe UI",system-ui,sans-serif;color:#1A1A2E;padding:10px;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
'.sheet{border:3px solid ' + color + ';border-radius:14px;overflow:hidden;max-width:760px;margin:0 auto;}' +
'.top{background:' + color + ';color:#fff;padding:24px 32px;display:flex;justify-content:space-between;align-items:center;}' +
'.brand{font-size:22px;font-weight:900;display:flex;align-items:center;gap:8px;}' +
'.badge{font-size:12px;opacity:.85;letter-spacing:1px;}' +
'.bodyc{padding:40px 40px 30px;text-align:center;}' +
'.icon{font-size:64px;margin-bottom:10px;}' +
'.sm{font-size:14px;color:#7A8599;margin:6px 0;}' +
'.name{font-size:34px;font-weight:900;margin:6px 0;}' +
'.course{font-size:24px;font-weight:800;color:' + color + ';margin:6px 0;}' +
'.meta{display:flex;justify-content:center;gap:38px;margin:28px 0 18px;flex-wrap:wrap;}' +
'.ml{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#7A8599;font-weight:700;}' +
'.mv{font-size:16px;font-weight:800;margin-top:3px;}' +
'.strip{margin-top:6px;padding:14px;background:' + color + '14;border-radius:8px;display:flex;justify-content:space-between;font-size:12px;color:#5A6474;}' +
'.foot{text-align:center;font-size:11px;color:#9AA5B1;margin-top:16px;}' +
'</style></head><body>' +
'<div class="sheet">' +
'<div class="top"><div class="brand">' + logoMark(22, false) + ' Care2Learn</div><div class="badge">Skills for Care · Mandatory Training</div></div>' +
'<div class="bodyc">' +
'<div class="icon">' + (c.icon || "📘") + '</div>' +
'<div class="sm">This certifies that</div>' +
'<div class="name">' + esc(me.staff.name) + '</div>' +
'<div class="sm">has successfully completed</div>' +
'<div class="course">' + esc(enr.courseTitle) + '</div>' +
'<div class="sm">on behalf of <strong>' + esc(me.org.name) + '</strong></div>' +
'<div class="meta">' +
'<div><div class="ml">Score</div><div class="mv" style="color:' + color + '">' + enr.score + '%</div></div>' +
'<div><div class="ml">Completed</div><div class="mv">' + fmtDate(enr.completedAt) + '</div></div>' +
'<div><div class="ml">Valid Until</div><div class="mv">' + fmtDate(enr.expiryDate) + '</div></div>' +
'<div><div class="ml">Certificate ID</div><div class="mv" style="font-family:monospace">' + esc(enr.certId) + '</div></div>' +
'</div>' +
'<div class="strip"><span>Aligned to the Care Certificate 2026</span><span>Pass mark: 70% · Achieved: ' + enr.score + '%</span></div>' +
'</div></div>' +
'<div class="foot">Issued by Care2Learn · Verify with Certificate ID ' + esc(enr.certId) + '</div>' +
'</body></html>';

  printViaIframe(doc);
}

// ── Shared: print/save any HTML document via a hidden iframe (no pop-up needed) ──
function printViaIframe(html) {
  const old = document.getElementById("c2l-print-frame");
  if (old) old.remove();

  const frame = document.createElement("iframe");
  frame.id = "c2l-print-frame";
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.left = "-9999px";
  frame.style.top = "0";
  frame.style.width = "900px";
  frame.style.height = "1200px";
  frame.style.border = "0";
  document.body.appendChild(frame);

  let printed = false;
  const triggerPrint = function () {
    if (printed) return;
    printed = true;
    try {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    } catch (e) {
      try { window.print(); } catch (e2) {}
    }
    setTimeout(function () { if (frame && frame.parentNode) frame.parentNode.removeChild(frame); }, 3000);
  };

  const fdoc = frame.contentWindow.document;
  fdoc.open();
  fdoc.write(html);
  fdoc.close();
  frame.onload = function () { setTimeout(triggerPrint, 150); };
  setTimeout(triggerPrint, 500);
}

// ── Compliance status → printable label + colours ──
function compStatusStyle(compliance) {
  switch (compliance) {
    case "valid":       return { label: "Valid",         fg: "#15803D", bg: "#16A34A1A" };
    case "expiring":    return { label: "Expiring soon", fg: "#9A6700", bg: "#E67E221A" };
    case "expired":     return { label: "Expired",       fg: "#B91C1C", bg: "#E74C3C1A" };
    case "in_progress": return { label: "In progress",   fg: "#1D4E89", bg: "#2980B91A" };
    case "failed":      return { label: "Failed",        fg: "#B91C1C", bg: "#E74C3C1A" };
    default:            return { label: "Not started",   fg: "#4B5563", bg: "#9CA3AF1A" };
  }
}

// ── Build + print the organisation's compliance report as a PDF ──
async function downloadComplianceReport() {
  toast("Preparing compliance report…");
  let me, staffResp;
  try {
    me = await api("/org/me");
    staffResp = await api("/org/staff");
  } catch (e) {
    toast("Could not build the report — please try again.");
    return;
  }
  const org = me.org;
  const sum = me.summary;
  const active = staffResp.staff.filter(s => s.active);

  const now = new Date();
  const generated = now.toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });

  const sumCard = (n, l) => '<div class="sum"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';

  const staffBlocks = active.map(s => {
    const rows = (s.enrolments || []).map(e => {
      const st = compStatusStyle(e.compliance);
      return '<tr>'
        + '<td>' + esc(e.courseTitle) + '</td>'
        + '<td><span class="badge" style="color:' + st.fg + ';background:' + st.bg + '">' + st.label + '</span></td>'
        + '<td>' + (e.score != null ? e.score + '%' : '—') + '</td>'
        + '<td>' + (e.completedAt ? fmtDate(e.completedAt) : '—') + '</td>'
        + '<td>' + (e.expiryDate ? fmtDate(e.expiryDate) : '—') + '</td>'
        + '</tr>';
    }).join("");
    const overall = (s.assignedCount > 0 && s.compliant)
      ? '<span class="badge" style="color:#15803D;background:#16A34A1A">Fully compliant</span>'
      : (s.assignedCount === 0
        ? '<span class="badge" style="color:#4B5563;background:#9CA3AF1A">No courses assigned</span>'
        : '<span class="badge" style="color:#9A6700;background:#E67E221A">Action required</span>');
    const table = (s.enrolments && s.enrolments.length)
      ? '<table><thead><tr><th>Course</th><th>Status</th><th>Score</th><th>Completed</th><th>Expires</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div class="none">No courses assigned.</div>';
    return '<div class="staff">'
      + '<div class="staff-h"><div><span class="staff-name">' + esc(s.name) + '</span> <span class="staff-role">· ' + esc(s.role) + '</span></div>' + overall + '</div>'
      + table + '</div>';
  }).join("");

  const doc =
'<!DOCTYPE html><html><head><meta charset="utf-8">'
+ '<title>Compliance Report — ' + esc(org.name) + '</title>'
+ '<style>'
+ '@page{size:A4 portrait;margin:14mm;}'
+ '*{box-sizing:border-box;margin:0;padding:0;}'
+ 'body{font-family:"Segoe UI",system-ui,sans-serif;color:#1A1A2E;font-size:12px;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}'
+ '.hd{background:#0D1B2A;color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;border-radius:8px;}'
+ '.hd .l{display:flex;align-items:center;gap:11px;}'
+ '.hd .ttl{font-size:18px;font-weight:700;}'
+ '.hd .sub{font-size:11px;color:#9FB0C4;}'
+ '.hd .org{font-size:13px;font-weight:700;text-align:right;}'
+ '.meta{display:flex;justify-content:space-between;margin:14px 2px;font-size:11px;color:#5A6474;}'
+ '.sumrow{display:flex;gap:10px;margin-bottom:18px;}'
+ '.sum{flex:1;border:1px solid #E5E7EB;border-radius:8px;padding:10px;text-align:center;}'
+ '.sum .n{font-size:22px;font-weight:800;}'
+ '.sum .l{font-size:9px;color:#7A8599;text-transform:uppercase;letter-spacing:.4px;margin-top:2px;}'
+ '.staff{margin-bottom:14px;page-break-inside:avoid;}'
+ '.staff-h{display:flex;justify-content:space-between;align-items:center;background:#F0F4F8;padding:8px 12px;border-radius:6px;margin-bottom:6px;}'
+ '.staff-name{font-weight:700;font-size:13px;}'
+ '.staff-role{color:#7A8599;font-size:11px;}'
+ 'table{width:100%;border-collapse:collapse;}'
+ 'th{text-align:left;color:#7A8599;font-weight:600;padding:5px 8px;border-bottom:1px solid #E5E7EB;text-transform:uppercase;font-size:9px;letter-spacing:.3px;}'
+ 'td{padding:6px 8px;border-bottom:1px solid #F0F2F5;font-size:11px;}'
+ '.badge{display:inline-block;padding:2px 9px;border-radius:10px;font-size:10px;font-weight:700;}'
+ '.none{padding:8px 12px;color:#7A8599;font-style:italic;font-size:11px;}'
+ '.legend{margin-top:6px;font-size:10px;color:#7A8599;line-height:1.6;}'
+ '.foot{margin-top:18px;padding-top:10px;border-top:1px solid #E5E7EB;text-align:center;font-size:10px;color:#9AA5B1;}'
+ '</style></head><body>'
+ '<div class="hd"><div class="l">' + logoMark(26, false) + '<div><div class="ttl">Care2Learn</div><div class="sub">Training Compliance Report</div></div></div><div class="org">' + esc(org.name) + (org.cqc_number ? '<br><span style="font-weight:400;color:#9FB0C4">CQC ' + esc(org.cqc_number) + '</span>' : '') + '</div></div>'
+ '<div class="meta"><span>Mandatory training compliance across all active staff</span><span>Generated: ' + esc(generated) + '</span></div>'
+ '<div class="sumrow">'
+ sumCard(sum.activeStaff, "Active staff")
+ sumCard(sum.fullyCompliant, "Fully compliant")
+ sumCard(sum.expiringSoon, "Expiring &le;30 days")
+ sumCard(sum.totalEnrolments, "Course assignments")
+ '</div>'
+ (active.length ? staffBlocks : '<div class="none">No active staff to report on.</div>')
+ '<div class="legend"><b>Status key:</b> Valid = completed and in date · Expiring soon = within 30 days of expiry · Expired = renewal overdue · In progress = started, assessment not yet passed · Not started = assigned but not begun.</div>'
+ '<div class="foot">Confidential · Generated by Care2Learn for ' + esc(org.name) + ' on ' + esc(generated) + '</div>'
+ '</body></html>';

  printViaIframe(doc);
}

function showCertificate(enr, me) {
  const c = state.courses.find(x => x.id === enr.courseId) || {};
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="cert">
      <div class="cert-hdr" style="background:linear-gradient(135deg,${c.color},${c.color}cc)">
        <div class="cert-logo" style="display:flex;align-items:center;gap:8px">${logoMark(22, false)}<span>Care2Learn</span></div>
        <div class="cert-badge">Skills for Care · Mandatory Training</div>
      </div>
      <div class="cert-body">
        <div class="cert-icon">${c.icon}</div>
        <div class="cert-sm">This certifies that</div>
        <div class="cert-name">${esc(me.staff.name)}</div>
        <div class="cert-sm">has successfully completed</div>
        <div class="cert-course" style="color:${c.color}">${esc(enr.courseTitle)}</div>
        <div class="cert-sm">on behalf of <b>${esc(me.org.name)}</b></div>
        <div class="cert-meta">
          <div><div class="cm-l">Score</div><div class="cm-v" style="color:${c.color}">${enr.score}%</div></div>
          <div><div class="cm-l">Completed</div><div class="cm-v">${fmtDate(enr.completedAt)}</div></div>
          <div><div class="cm-l">Valid Until</div><div class="cm-v">${fmtDate(enr.expiryDate)}</div></div>
          <div><div class="cm-l">Cert ID</div><div class="cm-v mono">${esc(enr.certId)}</div></div>
        </div>
        <div style="padding:12px;background:${c.color}18;border-radius:8px;display:flex;justify-content:space-between;font-size:11px;color:#5A6474"><span>Aligned to the Care Certificate 2026</span><span>Pass mark: 70% · Achieved: ${enr.score}%</span></div>
      </div>
      <div class="cert-actions">
        <button class="btn-cancel" style="flex:1" id="cert-close">Close</button>
        <button class="btn-save" style="flex:1;background:${c.color}" id="cert-print">🖨️ Print / Save as PDF</button>
      </div>
    </div>
  `);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#cert-close").onclick = () => overlay.remove();
  modal.querySelector("#cert-print").onclick = () => printCertificate(enr, me);
}

// ── Go ──
boot();
