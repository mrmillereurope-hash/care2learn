// ─── CARE2LEARN FRONTEND ──────────────────────────────────────────────────────
// Vanilla JS. No build step, no JSX, no bundler. Talks to the REST API.

const App = document.getElementById("app");
const state = {
  token: localStorage.getItem("c2l_token") || null,
  kind: localStorage.getItem("c2l_kind") || null, // 'org' | 'staff'
  courses: [],
  view: "landing",
};

// Referral link support: a ?ref=CODE param prefills the registration forms.
let referralFromUrl = "";
try {
  const _ref = new URLSearchParams(location.search).get("ref");
  if (_ref) referralFromUrl = _ref.trim().toUpperCase().slice(0, 12);
} catch {}

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

// Remembered for PIN-reminder emails sent from the company portal.
let c2lOrgName = "";
// Remembered for PIN-reminder emails the super admin sends on a company's behalf.
let c2lAdminOrgName = "";
// Where the course player / certificate "back" button returns to (staff vs individual).
let learnerReturn = renderStaffPortal;

// Opens the user's own email app with a pre-filled PIN reminder for a staff member.
function pinReminderMailto(name, email, pin, fromLabel) {
  const origin = window.location.origin;
  const subject = "Your Care2Learn login PIN";
  const body =
    `Hi ${name},\n\n` +
    `Here is your Care2Learn login PIN: ${pin}\n\n` +
    `How to log in:\n` +
    `1. Go to ${origin}\n` +
    `2. Choose "Staff Login"\n` +
    `3. Enter your email (${email}) and your PIN\n\n` +
    `Please keep this PIN private.\n\n` +
    (fromLabel ? `Thanks,\n${fromLabel}` : `Thanks`);
  const a = document.createElement("a");
  a.href = `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
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
  const shield = dark ? "#1E3A5F" : "#ffffff";
  const tick = dark ? "#22C55E" : "#1FA463";
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 100 100" style="display:inline-block;vertical-align:middle;flex:0 0 auto" aria-label="Care2Learn">'
    + '<path d="M50 14 L80 24 L80 47 C80 65 67 77 50 83 C33 77 20 65 20 47 L20 24 Z" fill="' + shield + '"/>'
    + '<path d="M37 49 L46 58 L64 37" fill="none" stroke="' + tick + '" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>'
    + '</svg>';
}

// ── Checkout return handling ──
let pendingCheckout = null; // { status, sessionId } captured from the Stripe return URL

function checkCheckoutResult() {
  const params = new URLSearchParams(location.search);
  const c = params.get("checkout");
  if (!c) return;
  const sessionId = params.get("session_id") || null;
  history.replaceState(null, "", location.pathname);
  if (c === "cancelled") { toast("Checkout cancelled — no payment was taken."); return; }
  if (c === "success") {
    pendingCheckout = { status: "success", sessionId };
    // No session id to verify (e.g. a static payment link) → acknowledge now; the webhook
    // remains the fallback. With a session id, confirmPendingCheckout() handles it precisely.
    if (!sessionId) toast("Payment received — thank you! Your account will update shortly.");
  }
}

// After returning from a successful checkout, verify it with the server and apply the
// result (credits or subscription) immediately — a reliable backup to the Stripe webhook.
async function confirmPendingCheckout() {
  if (!pendingCheckout || pendingCheckout.status !== "success" || !pendingCheckout.sessionId) return;
  const { sessionId } = pendingCheckout;
  pendingCheckout = null; // run once
  try {
    const r = await api("/checkout/confirm", "POST", { sessionId });
    if (r.mode === "subscription" && r.subscribed) {
      toast("✓ You're subscribed — unlimited course assignments are now active.");
    } else if (r.mode === "credits") {
      if (r.granted && r.added > 0) toast(`✓ Payment received — ${r.added} credit${r.added === 1 ? "" : "s"} added. You now have ${r.credits}.`);
      else toast(`✓ Payment received — your credits are up to date (${r.credits}).`);
    } else if (r.pending) {
      toast("Payment received — we're confirming it now; your balance will update in a moment.");
    } else {
      toast("Payment received — thank you!");
    }
  } catch (e) {
    // Verification couldn't run (e.g. the secret key isn't set) — don't block the dashboard.
    toast("Payment received — thank you! Your balance will update shortly.");
  }
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
  // Password reset link (?reset=TOKEN) — always show the reset page, even if a
  // stale session is present. Handled before session-resume below.
  const resetToken = new URLSearchParams(location.search).get("reset");
  if (resetToken) { renderResetPassword(resetToken); return; }
  // Super admin lives at a hidden route: /#admin
  if (location.hash === "#admin" && state.kind !== "admin") { renderAdminLogin(); return; }
  if (state.token && state.kind === "admin") {
    try { await renderAdminDash(); return; } catch (e) { clearAuth(); }
  }
  // Resume session if token present
  if (state.token && state.kind === "org") {
    try { await renderOrgDash(); return; } catch (e) { clearAuth(); }
  }
  if (state.token && state.kind === "individual") {
    try { await renderIndividualPortal(); return; } catch (e) { clearAuth(); }
  }
  if (state.token && state.kind === "staff") {
    try { await renderStaffPortal(); return; } catch (e) { clearAuth(); }
  }
  // Deep links from the marketing site: take visitors straight to sign-in / sign-up.
  // Consume the hash so a later refresh or "Back" returns to the account hub, not here.
  if (location.hash === "#login" || location.hash === "#register") {
    const wantRegister = location.hash === "#register";
    history.replaceState(null, "", location.pathname);
    wantRegister ? renderOrgRegister() : renderOrgLogin();
    return;
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
// Stripe payment link for the monthly subscription (per-learner, volume-tiered).
const STRIPE_SUB_LINK = "https://buy.stripe.com/28E00i5cT4gIdjD7sudZ603";

// Start pay-as-you-go checkout: ask the server to create a Stripe session for the
// exact amount (learners × courses × £4). If the server can't (not reachable, or the
// Stripe key isn't set yet), fall back to the fixed-price payment link.
async function startPaygCheckout(learners, courses) {
  toast("Setting up secure checkout…");
  try {
    const data = await api("/checkout/payg", "POST", { learners, courses });
    if (data && data.demo) {
      const ov = document.querySelector(".overlay"); if (ov) ov.remove();
      toast(`✓ Payment successful — ${data.added} credit${data.added === 1 ? "" : "s"} added.`);
      if (typeof learnerReturn === "function") await learnerReturn();
      return;
    }
    if (data && data.url) { window.location.href = data.url; return; }
  } catch (e) { /* fall through to the static payment link */ }
  window.open(STRIPE_PAYG_LINK, "_blank", "noopener");
}

// Build the subscription Payment Link URL, tagged with the org's id (so the Stripe
// webhook can mark the right account subscribed) and their email (pre-filled at checkout).
function subscribeUrl(orgId, email) {
  const u = new URL(STRIPE_SUB_LINK);
  if (orgId) u.searchParams.set("client_reference_id", orgId);
  if (email) u.searchParams.set("prefilled_email", email);
  return u.toString();
}
// Subscription CTA: a signed-in organisation goes straight to a tagged checkout; a
// logged-out visitor registers first, then subscribes from Settings — so the payment
// is always linked to an account and fulfils automatically via the webhook.
async function startSubscribe() {
  if (!(state.token && state.kind === "org")) { renderOrgRegister(); return; }
  toast("Setting up secure checkout…");
  try {
    const data = await api("/checkout/subscription", "POST", {});
    if (data && data.url) { window.location.href = data.url; return; }
    toast("Couldn't start the subscription checkout. Please try again.");
  } catch (e) {
    toast(e.message || "Couldn't start the subscription checkout. Please try again.");
  }
}

// Header pill showing the org's plan: a green "Subscribed" badge, or the credit balance
// (amber when empty). Always rendered; clicking opens the credits/plan modal.
function creditPillHtml(org) {
  if (org.subscription_status === "active") {
    return `<button class="cred-pill" id="credpill" title="Subscription active — unlimited course assignments" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:20px;font-size:13px;font-weight:700;cursor:pointer;background:rgba(39,174,96,.18);border:1px solid rgba(39,174,96,.5);color:#86EFAC">✓ Subscribed</button>`;
  }
  const c = org.credits || 0;
  const style = c < 1
    ? "background:rgba(230,126,34,.20);border:1px solid rgba(230,126,34,.6);color:#FCD34D"
    : "background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.22);color:#fff";
  return `<button class="cred-pill" id="credpill" title="Course credits — click to top up or subscribe" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:20px;font-size:13px;font-weight:700;cursor:pointer;${style}">💳 ${c} credit${c === 1 ? "" : "s"}</button>`;
}

// Modal: shows the balance/plan and offers a credit top-up and/or subscribing.
function showCreditsModal(me) {
  const org = me.org;
  const subscribed = org.subscription_status === "active";
  const credits = org.credits || 0;
  const each = PRICING.paygPerCourse;
  const presets = [10, 25, 50, 100];

  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:460px">
      <div class="modal-h"><div><h2>Credits &amp; plan</h2><p>${subscribed ? "Your subscription covers unlimited course assignments." : "Each credit covers one course for one carer. Credits never expire."}</p></div><button class="x" id="close">✕</button></div>
      <div style="padding:8px 22px 20px">
        <div style="margin-bottom:16px">
          ${subscribed
            ? `<span class="pill green">✓ Subscribed · Unlimited</span>`
            : `<span class="pill" style="background:#1E3A5F18;color:#5B21B6"><b>${credits}</b> credit${credits === 1 ? "" : "s"} available</span>`}
        </div>
        ${subscribed ? "" : `
          <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:8px">Top up credits</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
            ${presets.map(p => `<button class="cred-amt mini-btn" data-q="${p}">${p}</button>`).join("")}
            <input id="credqty" type="number" min="1" max="5000" value="25" style="width:88px;padding:8px 10px;border:1px solid #D5DCE4;border-radius:8px;font-size:14px">
          </div>
          <div id="credtotal" style="font-size:13px;color:#586473;margin-bottom:12px"></div>
          <button class="btn-save" id="buycred" style="width:100%">Buy credits</button>
          <div style="text-align:center;margin:14px 0 4px;color:#9AA4B2;font-size:12px">— or —</div>
        `}
        <div style="font-size:13px;font-weight:700;color:#374151;margin-bottom:6px">${subscribed ? "Subscription" : "Go unlimited"}</div>
        <p style="font-size:13px;color:#586473;line-height:1.5;margin-bottom:10px">${subscribed
          ? "You're on the monthly subscription — assign as many courses as you like."
          : `Subscribe for ${PRICING.currency}${PRICING.subscriptionPerLearnerMonth} per learner / month and stop counting credits — unlimited course assignments for your whole team.`}</p>
        ${subscribed ? "" : `<button class="mini-btn" id="gosub" style="width:100%">⭐ Subscribe for unlimited</button>`}
      </div>
    </div>
  `);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();

  if (!subscribed) {
    const qtyInput = modal.querySelector("#credqty");
    const totalEl = modal.querySelector("#credtotal");
    const refresh = () => { const n = Math.max(1, Math.floor(Number(qtyInput.value) || 0)); totalEl.innerHTML = `${n} credit${n === 1 ? "" : "s"} × ${PRICING.currency}${each} = <b>${PRICING.currency}${(n * each).toLocaleString()}</b>`; };
    qtyInput.oninput = refresh; refresh();
    modal.querySelectorAll(".cred-amt").forEach(b => b.onclick = () => { qtyInput.value = b.dataset.q; refresh(); });
    modal.querySelector("#buycred").onclick = () => { const n = Math.max(1, Math.floor(Number(qtyInput.value) || 0)); overlay.remove(); startCreditTopUp(n); };
    const gosub = modal.querySelector("#gosub");
    if (gosub) gosub.onclick = () => { overlay.remove(); startSubscribe(); };
  }
}

// Buy a specific number of credits via the dynamic checkout (tagged with the account,
// so the webhook tops up the balance automatically). Falls back to the static link.
async function startCreditTopUp(credits) {
  toast("Setting up secure checkout…");
  try {
    const data = await api("/checkout/payg", "POST", { credits });
    if (data && data.url) { window.location.href = data.url; return; }
  } catch (e) { /* fall back to the static payment link */ }
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
          <p>No commitment — buy only the courses you need, when you need them, for ${cur}${PRICING.paygPerCourse} per learner. And unlike other providers, your credits never expire.</p>
          <ul class="plan-list">
            <li><strong>Your credits never expire — ever</strong></li>
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
      : () => startSubscribe();
  }

  wrap.querySelectorAll(".plan-toggle button").forEach(b => {
    b.onclick = () => { calc.mode = b.dataset.mode; render(); };
  });
  render();
  return wrap;
}

// ─── FAQ (collapsible, toggles between organisations and care professionals) ──
const FAQ = {
  org: [
    { q: "How do I get my organisation set up?", a: "Register your organisation in a couple of minutes, then add your carers as staff and assign the courses they need. Your staff, courses, certificates and compliance all live in one dashboard." },
    { q: "How does pricing work?", a: "Two simple options: a subscription at £2 per carer per month with volume discounts as your team grows, or pay as you go at £4 per course per carer with no commitment. Use the calculator above to estimate your cost." },
    { q: "Are the courses aligned with CQC and Skills for Care requirements?", a: "Yes. Our courses cover the statutory and mandatory training expected in adult social care and include the full 16-standard Care Certificate, so you're ready for a CQC inspection." },
    { q: "How do I track compliance and certificates?", a: "Your dashboard shows each carer's progress in real time and highlights anyone whose training is due or expiring. When a carer passes, a dated certificate is generated automatically." },
    { q: "Can I manage carers and courses at any time?", a: "Absolutely. Add carers, assign or remove courses, deactivate or reactivate licences, and reset PINs whenever you need — there's no lock-in." },
    { q: "What are course credits?", a: "Credits are a prepaid balance for pay-as-you-go training: one credit covers one course for one carer. Credits never expire, so you can buy in advance and use them whenever it suits you." },
  ],
  staff: [
    { q: "How do I log in?", a: "Your manager will give you an email and a 4-digit PIN. Choose ‘Staff Login’ on the home page and enter them — that's all you need." },
    { q: "How do I complete a course?", a: "Open an assigned course, work through the short lessons at your own pace, then take the quiz at the end. You can revisit any lesson before you answer." },
    { q: "Do I get a certificate?", a: "Yes. The moment you pass, your certificate is issued instantly and you can view or download it from your portal at any time." },
    { q: "Can I learn on my phone and at my own pace?", a: "Yes. Care2Learn works on phones, tablets and computers, and your progress is saved as you go — so you can stop and pick up exactly where you left off." },
    { q: "What is the Care Certificate?", a: "It's a set of 16 standards every new carer in adult social care should meet. On Care2Learn it's broken into short modules you can complete in any order, with a certificate at the end." },
    { q: "What if I forget my PIN?", a: "No problem — ask your manager to reset it or email you a reminder. You'll receive a new PIN you can use straight away." },
  ],
};
function buildFAQ() {
  const wrap = el(`
    <div class="faq-band">
      <div class="faq-inner">
        <div class="faq-head">
          <h2>Frequently asked questions</h2>
          <p>Answers for care providers and for the carers using Care2Learn.</p>
        </div>
        <div class="faq-toggle">
          <button data-aud="org">For Organisations</button>
          <button data-aud="staff">For Care Professionals</button>
        </div>
        <div class="faq-list" id="faq-list"></div>
      </div>
    </div>`);
  let aud = "org";
  const listEl = wrap.querySelector("#faq-list");
  function render() {
    wrap.querySelectorAll(".faq-toggle button").forEach(b => b.classList.toggle("active", b.dataset.aud === aud));
    listEl.innerHTML = "";
    FAQ[aud].forEach(item => {
      const it = el(`
        <div class="faq-item">
          <button class="faq-q"><span>${esc(item.q)}</span><span class="faq-ico">+</span></button>
          <div class="faq-a"><p>${esc(item.a)}</p></div>
        </div>`);
      it.querySelector(".faq-q").onclick = () => it.classList.toggle("open");
      listEl.appendChild(it);
    });
  }
  wrap.querySelectorAll(".faq-toggle button").forEach(b => b.onclick = () => { aud = b.dataset.aud; render(); });
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
        <div class="landing-tag">Training sorted, so you can care.</div>
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
          <h2>For Care Professionals</h2>
          <p>Take your assigned courses, complete assessments, and get certificates.</p>
          <button class="btn-primary green" id="go-staff-login">Staff Login</button>
          <div class="lcard-or">Self-employed carer?</div>
          <button class="btn-secondary" id="go-ind-reg">Register as an individual</button>
        </div>
      </div>
      <div class="footer">Aligned to the Care Certificate 2026 · CQC Inspection Ready · Powered by Care2Learn</div>
    </div>
  `));
  document.getElementById("go-org-login").onclick = renderOrgLogin;
  document.getElementById("go-org-reg").onclick = renderOrgRegister;
  document.getElementById("go-staff-login").onclick = renderStaffLogin;
  document.getElementById("go-ind-reg").onclick = renderIndividualRegister;
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
      <div class="fg"><label>Referral code <span style="color:#9AA5B1;font-weight:400">(optional)</span></label><input class="inp" id="refcode" placeholder="e.g. K7Q2MP" style="text-transform:uppercase"></div>
      <button class="btn-auth" id="submit">Register Organisation</button>
      <div class="auth-alt"><button class="linkbtn" id="tologin">Already have an account? Sign in</button></div>
      <div class="auth-alt"><button class="linkbtn" id="toind">Self-employed carer? Register as an individual</button></div>
    </div></div>
  `));
  document.getElementById("back").onclick = renderLanding;
  document.getElementById("tologin").onclick = renderOrgLogin;
  document.getElementById("toind").onclick = renderIndividualRegister;
  if (referralFromUrl) document.getElementById("refcode").value = referralFromUrl;
  document.getElementById("submit").onclick = async () => {
    const errBox = document.getElementById("err");
    errBox.innerHTML = "";
    const payload = {
      name: val("name"), email: val("email"), password: val("password"),
      phone: val("phone"), cqcNumber: val("cqc"), address: val("address"),
      referralCode: val("refcode"),
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
      <div class="auth-alt"><button class="linkbtn" id="toreg">New to Care2Learn? Create an account</button></div>
      <div class="auth-alt"><button class="linkbtn" id="forgot">Forgot your password?</button></div>
    </div></div>
  `));
  document.getElementById("back").onclick = renderLanding;
  document.getElementById("submit").onclick = () => doOrgLogin(val("email"), val("password"));
  document.getElementById("demo").onclick = () => doOrgLogin("demo@care2learn.co.uk", "demo123");
  document.getElementById("toreg").onclick = renderOrgRegister;
  document.getElementById("forgot").onclick = () => renderForgotPassword(renderOrgLogin);
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

// ─── FORGOT / RESET PASSWORD (self-service) ───────────────────────────────────
// Step 1: request a reset link by email. backFn returns to the relevant login.
function renderForgotPassword(backFn) {
  backFn = backFn || renderLanding;
  App.innerHTML = "";
  App.appendChild(el(`
    <div class="auth-page"><div class="auth-card">
      <button class="back-sm" id="back">← Back to login</button>
      <div class="auth-logo" style="display:flex;align-items:center;gap:8px">${logoMark(22, true)}<span>Care2Learn</span></div>
      <div class="auth-title">Reset your password</div>
      <div class="auth-sub">Enter the email address for your account and we'll send you a link to set a new password.</div>
      <div id="err"></div>
      <div id="ok"></div>
      <div class="fg"><label>Email Address</label><input class="inp" id="email" type="email" placeholder="you@email.com"></div>
      <button class="btn-auth" id="submit">Send reset link</button>
    </div></div>
  `));
  document.getElementById("back").onclick = backFn;
  const submit = document.getElementById("submit");
  const go = async () => {
    const errBox = document.getElementById("err"); const okBox = document.getElementById("ok");
    errBox.innerHTML = ""; okBox.innerHTML = "";
    const email = val("email");
    if (!email) { errBox.innerHTML = `<div class="err">Please enter your email address.</div>`; return; }
    submit.disabled = true; submit.textContent = "Sending…";
    try {
      const r = await api("/forgot-password", "POST", { email });
      okBox.innerHTML = `<div class="ok-banner">${esc(r.message || "If that email has an account, we've sent a reset link.")}</div>`;
      submit.textContent = "Link sent";
    } catch (e) {
      errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`;
      submit.disabled = false; submit.textContent = "Send reset link";
    }
  };
  submit.onclick = go;
  document.getElementById("email").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
}

// Step 2: arrived via the emailed link (?reset=TOKEN). Validate, then set a new password.
async function renderResetPassword(token) {
  App.innerHTML = `<div class="spin">Checking your reset link…</div>`;
  let valid = false;
  try { const r = await api("/reset-password/check", "POST", { token }); valid = !!r.valid; } catch (e) { valid = false; }

  const stripParam = () => { try { history.replaceState(null, "", location.pathname); } catch (e) {} };

  if (!valid) {
    stripParam();
    App.innerHTML = "";
    App.appendChild(el(`
      <div class="auth-page"><div class="auth-card">
        <div class="auth-logo" style="display:flex;align-items:center;gap:8px">${logoMark(22, true)}<span>Care2Learn</span></div>
        <div class="auth-title">Link expired or invalid</div>
        <div class="auth-sub">This password reset link has expired or has already been used. Reset links are valid for 60 minutes and can be used once.</div>
        <button class="btn-auth" id="again">Request a new link</button>
        <div class="auth-alt"><button class="linkbtn" id="tologin">Back to login</button></div>
      </div></div>
    `));
    document.getElementById("again").onclick = () => renderForgotPassword(renderLanding);
    document.getElementById("tologin").onclick = renderLanding;
    return;
  }

  App.innerHTML = "";
  App.appendChild(el(`
    <div class="auth-page"><div class="auth-card">
      <div class="auth-logo" style="display:flex;align-items:center;gap:8px">${logoMark(22, true)}<span>Care2Learn</span></div>
      <div class="auth-title">Choose a new password</div>
      <div class="auth-sub">Enter a new password for your account. It must be at least 6 characters.</div>
      <div id="err"></div>
      <div class="fg"><label>New password</label><input class="inp" id="pw1" type="password" placeholder="New password"></div>
      <div class="fg"><label>Confirm new password</label><input class="inp" id="pw2" type="password" placeholder="Re-enter new password"></div>
      <button class="btn-auth" id="submit">Set new password</button>
    </div></div>
  `));
  const submit = document.getElementById("submit");
  const go = async () => {
    const errBox = document.getElementById("err"); errBox.innerHTML = "";
    const pw1 = val("pw1"); const pw2 = val("pw2");
    if (pw1.length < 6) { errBox.innerHTML = `<div class="err">Password must be at least 6 characters.</div>`; return; }
    if (pw1 !== pw2) { errBox.innerHTML = `<div class="err">The two passwords don't match.</div>`; return; }
    submit.disabled = true; submit.textContent = "Saving…";
    try {
      const r = await api("/reset-password", "POST", { token, newPassword: pw1 });
      stripParam();
      const backFn = r.accountType === "individual" ? renderIndividualLogin : renderOrgLogin;
      App.innerHTML = "";
      App.appendChild(el(`
        <div class="auth-page"><div class="auth-card">
          <div class="auth-logo" style="display:flex;align-items:center;gap:8px">${logoMark(22, true)}<span>Care2Learn</span></div>
          <div class="auth-title">Password updated</div>
          <div class="ok-banner">Your password has been changed. You can now sign in with your new password.</div>
          <button class="btn-auth" id="tologin">Go to login</button>
        </div></div>
      `));
      document.getElementById("tologin").onclick = backFn;
    } catch (e) {
      errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`;
      submit.disabled = false; submit.textContent = "Set new password";
    }
  };
  submit.onclick = go;
  document.getElementById("pw2").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
}

// ─── ORG DASHBOARD ────────────────────────────────────────────────────────────
let orgTab = "overview";
// Shared "Refer & earn" card — used by both the organisation dashboard and the individual portal.
function referralCard(referral, opts) {
  opts = opts || {};
  const reward = referral.rewardPerReferral || 0;
  const code = referral.code || "—";
  const link = `${location.origin}${location.pathname}?ref=${encodeURIComponent(code)}`;
  const who = opts.audience || "people you know";
  const singular = opts.singular || "person";
  const wrap = el(`
    <div>
      <div class="refer-hero">
        <div class="refer-hero-badge">🎁 Refer &amp; earn</div>
        <div class="refer-hero-title">Earn ${reward} free credits for every ${esc(singular)} you refer</div>
        <div class="refer-hero-sub">Share your code with ${esc(who)}. When someone you refer makes their first credit purchase, ${reward} course credits land in your balance — automatically, with no limit on how many you can earn.</div>
      </div>
      <div class="refer-grid">
        <div class="refer-box">
          <div class="refer-box-l">Your referral code</div>
          <div class="refer-code">${esc(code)}</div>
          <button class="mini-btn" id="copycode">📋 Copy code</button>
        </div>
        <div class="refer-box">
          <div class="refer-box-l">Your invite link</div>
          <div class="refer-link">${esc(link)}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="mini-btn" id="copylink">🔗 Copy link</button>
            <button class="mini-btn" id="emaillink">✉️ Share by email</button>
          </div>
        </div>
      </div>
      <div class="refer-stats">
        <div class="refer-stat"><div class="refer-stat-n" style="color:#1E3A5F">${referral.count || 0}</div><div class="refer-stat-l">Credited referrals</div></div>
        <div class="refer-stat"><div class="refer-stat-n" style="color:#1FA463">${referral.creditsEarned || 0}</div><div class="refer-stat-l">Credits earned</div></div>
        <div class="refer-stat"><div class="refer-stat-n" style="color:#1E3A5F">${reward}</div><div class="refer-stat-l">Credits per referral</div></div>
      </div>
      ${referral.pending ? `<div class="refer-pending">⏳ <b>${referral.pending}</b> signed up with your code and ${referral.pending === 1 ? "will earn" : "will each earn"} you ${reward} credits on their first purchase.</div>` : ""}
      <div class="refer-how">
        <div class="refer-how-t">How it works</div>
        <ol class="refer-how-list">
          <li>Share your code or invite link with ${esc(who)}.</li>
          <li>They enter your code when they sign up for Care2Learn.</li>
          <li>When they make their first credit purchase, you receive ${reward} credits — automatically.</li>
        </ol>
        <div class="refer-terms-line">By taking part you agree to the <button class="linkbtn" id="refterms">Referral Programme Terms &amp; Conditions</button>.</div>
      </div>
    </div>`);
  const copy = (text, msg) => { try { navigator.clipboard.writeText(text); toast(msg); } catch { toast(text); } };
  wrap.querySelector("#copycode").onclick = () => copy(code, "Referral code copied.");
  wrap.querySelector("#copylink").onclick = () => copy(link, "Invite link copied.");
  wrap.querySelector("#refterms").onclick = () => showReferralTerms();
  wrap.querySelector("#emaillink").onclick = () => {
    const subject = encodeURIComponent("Join me on Care2Learn");
    const bodyTxt = encodeURIComponent(`Hi,\n\nI use Care2Learn for care training and thought you'd find it useful too.\n\nUse my referral code ${code} when you sign up, or just follow this link:\n${link}\n\nThanks!`);
    window.location.href = `mailto:?subject=${subject}&body=${bodyTxt}`;
  };
  return wrap;
}

// Referral Programme Terms & Conditions — shown in a modal from the Refer & earn card
// (used by both organisation accounts and individual/self-employed carer accounts).
function showReferralTerms() {
  const updated = "28 June 2026";
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal terms-modal">
      <div class="modal-h">
        <div><h2>Referral Programme Terms &amp; Conditions</h2><p>Care2Learn “Refer &amp; Earn” · Last updated ${updated}</p></div>
        <button class="x" id="close">✕</button>
      </div>
      <div class="terms-doc">
        <p class="terms-intro">These terms govern the Care2Learn “Refer &amp; Earn” referral programme (the “Programme”). They apply to everyone who takes part, whether you hold an <b>organisation account</b> (a care business or other company) or an <b>individual account</b> (a self-employed carer). By sharing your referral code or invite link, or otherwise taking part, you agree to these terms.</p>

        <h3>1. Who can take part</h3>
        <ul>
          <li>You must hold an active Care2Learn account in good standing.</li>
          <li>Each account has one unique referral code, issued automatically.</li>
          <li>You may not refer yourself, and you may not use the Programme to obtain credits on your own account through additional or duplicate sign-ups.</li>
          <li>The person or organisation you refer (the “Referred Account”) must be <b>new</b> to Care2Learn and must not already hold, or previously have held, a Care2Learn account.</li>
        </ul>

        <h3>2. How to refer someone</h3>
        <ul>
          <li>Share your referral code or personal invite link with care businesses or carers you know who would genuinely benefit from Care2Learn.</li>
          <li>The Referred Account must enter your referral code <b>when they register</b>. A code cannot be added to an account after sign-up, and only one referral code may be applied per Referred Account.</li>
          <li>Only the first valid referral code entered by a Referred Account will be recognised.</li>
        </ul>

        <h3>3. How you earn a reward</h3>
        <ul>
          <li>A referral becomes eligible for a reward only once the Referred Account makes its <b>first credit purchase</b>. Signing up alone does not earn a reward — this protects the Programme against misuse.</li>
          <li>When that first purchase is made, the reward is added to your credit balance automatically, subject to these terms and to the checks in section 5.</li>
          <li>You earn <b>one reward per Referred Account</b>. You cannot earn more than once for the same account, even if it makes further purchases.</li>
          <li>There is <b>no limit</b> on the number of different people or organisations you can refer, or on the total number of credits you can earn.</li>
        </ul>

        <h3>4. Reward amounts</h3>
        <p>The reward is paid in Care2Learn course credits and is based on the account type of the person making the referral (you):</p>
        <ul>
          <li><b>Organisation accounts (care businesses / companies):</b> 50 course credits per successful referral.</li>
          <li><b>Individual accounts (self-employed carers):</b> 14 course credits per successful referral.</li>
        </ul>
        <p>The current reward rate that applies to your account is always shown on your “Refer &amp; Earn” page. Care2Learn may change the reward rate at any time; the rate shown on your dashboard at the time the Referred Account makes its first purchase is the rate that applies.</p>

        <h3>5. Reviews, fair use and anti-abuse</h3>
        <ul>
          <li>Care2Learn may review any referral before or after a reward is credited and may decline, withhold, or reverse a reward where these terms are not met.</li>
          <li>We may decline rewards and/or suspend or remove a participant from the Programme if we reasonably suspect abuse. This includes (without limitation): self-referral; creating fake, duplicate or automated accounts; sign-ups that are not genuine; spam or unsolicited bulk messaging; impersonating Care2Learn; or any attempt to manipulate the Programme.</li>
          <li>Where a referral is declined, no reward will be credited for that Referred Account.</li>
          <li>Care2Learn’s decision on the eligibility of any referral is final.</li>
        </ul>

        <h3>6. About course credits</h3>
        <ul>
          <li>One course credit covers one course for one learner.</li>
          <li>Credits earned through the Programme do not expire.</li>
          <li>Credits have no cash value. They cannot be exchanged for money, transferred to another account, or refunded, and they may only be used within Care2Learn.</li>
        </ul>

        <h3>7. Closed, suspended or inactive accounts</h3>
        <ul>
          <li>If your account is closed, suspended or made inactive, you may stop being eligible to earn or use referral rewards, and unused credits may be forfeited.</li>
          <li>If a Referred Account is closed, suspended, or found to be ineligible, any related reward may be withheld or reversed.</li>
        </ul>

        <h3>8. How you may share your code</h3>
        <ul>
          <li>You may only share your code and link with people who would reasonably expect to hear from you and who may have a genuine interest in Care2Learn.</li>
          <li>You must not send spam or unsolicited bulk communications, post your code on unrelated or misleading channels, bid on or advertise against Care2Learn brand terms, or suggest that you represent or speak for Care2Learn.</li>
        </ul>

        <h3>9. Tax</h3>
        <p>You are responsible for determining and meeting any tax or reporting obligations that may arise from taking part in the Programme or receiving rewards. This is particularly relevant for businesses and self-employed individuals. Care2Learn does not provide tax advice.</p>

        <h3>10. Changes to or withdrawal of the Programme</h3>
        <p>Care2Learn may change these terms, change the rewards, or suspend or end the Programme at any time. Where changes are material, we will take reasonable steps to make participants aware. Continuing to take part after a change takes effect means you accept the updated terms. Rewards already validly credited to your balance before a change will not be removed solely because the Programme changes.</p>

        <h3>11. General</h3>
        <p>The Programme is provided on an “as is” basis. Nothing in these terms limits or excludes any rights you have under applicable law, including your statutory rights as a consumer, or any liability that cannot lawfully be limited or excluded. To the extent permitted by law, Care2Learn is not liable for any indirect or unforeseeable loss arising from the Programme.</p>

        <h3>12. Governing law</h3>
        <p>These terms and any dispute relating to the Programme are governed by the laws of England and Wales, and are subject to the non-exclusive jurisdiction of the courts of England and Wales.</p>

        <h3>13. Contact</h3>
        <p>If you have any questions about the Programme or these terms, please contact us via the in-app <b>Feedback</b> option or at <a href="mailto:support@care2learn.co.uk">support@care2learn.co.uk</a>.</p>
      </div>
      <div class="terms-foot">
        <button class="btn-save" id="termsok" style="background:#1E3A5F">Got it</button>
      </div>
    </div>
  `);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();
  modal.querySelector("#termsok").onclick = () => overlay.remove();
}

async function renderOrgDash() {
  await confirmPendingCheckout();
  const me = await api("/org/me");
  const org = me.org;
  c2lOrgName = org.name;

  App.innerHTML = "";
  App.appendChild(el(`
    <div>
      <div class="dash-hdr">
        <div class="dash-brand"><span class="dash-logo">${logoMark(26, false)}</span><div><div class="dash-org">${esc(org.name)}</div><div class="dash-sub">Care2Learn · Organisation Portal</div></div></div>
        <nav class="dash-nav" id="nav"></nav>
        <div class="dash-actions">
          ${creditPillHtml(org)}
          <button class="feedback-btn" id="feedback">💬 Feedback</button>
          <button class="logout" id="logout">Log Out</button>
        </div>
      </div>
      <div class="body" id="dashbody"></div>
    </div>
  `));

  const nav = document.getElementById("nav");
  [["overview","📊 Overview"],["staff","👥 Staff & Licences"],["compliance","✅ Compliance"],["refer","🎁 Refer & Earn"],["settings","⚙️ Settings"]].forEach(([k,label]) => {
    const b = el(`<button class="nav-btn ${orgTab===k?"active":""}">${label}</button>`);
    b.onclick = () => { orgTab = k; paintOrgTab(org); };
    nav.appendChild(b);
  });
  document.getElementById("logout").onclick = async () => { await api("/logout","POST").catch(()=>{}); clearAuth(); renderLanding(); };
  document.getElementById("feedback").onclick = () => openFeedbackModal("Organisation portal");
  const credpill = document.getElementById("credpill");
  if (credpill) credpill.onclick = () => showCreditsModal(me);

  await paintOrgTab(org);
}

async function paintOrgTab(org) {
  // refresh active nav
  const navs = document.querySelectorAll("#nav .nav-btn");
  const keys = ["overview","staff","compliance","refer","settings"];
  navs.forEach((b,i)=> b.classList.toggle("active", keys[i]===orgTab));

  const body = document.getElementById("dashbody");
  body.innerHTML = `<div class="spin">Loading…</div>`;

  if (orgTab === "overview") {
    const me = await api("/org/me");
    body.innerHTML = "";
    const hour = new Date().getHours();
    body.appendChild(el(`<div class="hero"><h1>Good ${hour<12?"morning":hour<18?"afternoon":"evening"}! 👋</h1><p>Training compliance overview for ${esc(me.org.name)}.</p></div>`));
    if (me.org && me.org.credits > 0) {
      body.appendChild(el(`<div style="background:#1E3A5F10;border:1px solid #1E3A5F25;border-radius:12px;padding:12px 16px;margin-bottom:18px;display:flex;align-items:center;gap:10px">
        <span style="font-size:20px">💳</span>
        <span style="font-size:14px;color:#4A3A6B"><b style="color:#1E3A5F">${me.org.credits}</b> course credit${me.org.credits === 1 ? "" : "s"} available — each one covers one course for one staff member.</span>
      </div>`));
    }
    const m = me.summary;
    body.appendChild(el(`
      <div class="metrics">
        <div class="metric"><div class="metric-i">👥</div><div class="metric-v" style="color:#1E3A5F">${m.activeStaff}</div><div class="metric-l">Active Staff</div></div>
        <div class="metric"><div class="metric-i">✅</div><div class="metric-v" style="color:#1FA463">${m.fullyCompliant}</div><div class="metric-l">Fully Compliant</div></div>
        <div class="metric"><div class="metric-i">⚠️</div><div class="metric-v" style="color:#E0902E">${m.expiringSoon}</div><div class="metric-l">Expiring ≤30 days</div></div>
        <div class="metric"><div class="metric-i">📋</div><div class="metric-v" style="color:#9B59B6">${m.totalEnrolments}</div><div class="metric-l">Course Assignments</div></div>
      </div>
    `));
    body.appendChild(el(`<div class="sec-title">Compliance by Course</div>`));
    const grid = el(`<div class="cc-grid"></div>`);
    me.byCourse.forEach(c => {
      const total = m.activeStaff || 1;
      const pct = Math.round((c.completed / total) * 100);
      const color = pct >= 80 ? "#1FA463" : pct >= 50 ? "#E0902E" : "#E5484D";
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
    const assignBtn = staff.length ? `<button class="btn-add" id="assign" style="background:#fff;color:#1E3A5F;border:1px solid #D5DCE4">📚 Assign courses</button>` : "";
    const sh = el(`<div class="sh"><h2>Staff &amp; Licences</h2><div style="display:flex;gap:8px;flex-wrap:wrap">${assignBtn}<button class="btn-add" id="import" style="background:#fff;color:#1E3A5F;border:1px solid #D5DCE4">⬆ Import CSV</button><button class="btn-add" id="add">+ Add Staff Member</button></div></div>`);
    body.appendChild(sh);
    const formSlot = el(`<div id="formslot"></div>`);
    body.appendChild(formSlot);

    document.getElementById("add").onclick = () => showAddStaffForm(formSlot);
    document.getElementById("import").onclick = () => showBulkImportForm();
    const assignEl = document.getElementById("assign");
    if (assignEl) assignEl.onclick = () => showAssignCourses();

    if (staff.length === 0) {
      const empty = el(`<div class="table"><div class="empty">
        <div style="font-size:15px;font-weight:700;color:#1E3A5F;margin-bottom:4px">No staff yet</div>
        <div style="margin-bottom:16px">Add your first care professional, or import your whole team from a spreadsheet in one go.</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
          <button class="btn-add" id="empty-add">+ Add Staff Member</button>
          <button class="btn-add" id="empty-import" style="background:#fff;color:#1E3A5F;border:1px solid #D5DCE4">⬆ Import CSV</button>
        </div>
      </div></div>`);
      body.appendChild(empty);
      empty.querySelector("#empty-add").onclick = () => showAddStaffForm(formSlot);
      empty.querySelector("#empty-import").onclick = () => showBulkImportForm();
    } else {
      const table = el(`<div class="table"><div class="thead"><span>Name</span><span>Role</span><span>Progress</span><span>Status</span><span>PIN</span><span>Actions</span></div></div>`);
      staff.forEach(s => {
        const statusPill = !s.active ? `<span class="pill grey">Inactive</span>`
          : s.compliant ? `<span class="pill green">✓ Compliant</span>`
          : s.assignedCount === 0 ? `<span class="pill grey">No courses</span>`
          : `<span class="pill amber">In Progress</span>`;
        const row = el(`
          <div class="trow">
            <div class="trow-top">
              <span><div class="t-name">${esc(s.name)}</div><div class="t-email">${esc(s.email)}</div></span>
              <span class="t-role">${esc(s.role)}</span>
            </div>
            <div class="trow-meta">
              <span><b style="color:${s.completedCount===s.assignedCount&&s.assignedCount>0?"#1FA463":"#E0902E"}">${s.completedCount}</b>/${s.assignedCount}</span>
              <span>${statusPill}</span>
              <span><span class="trow-pin-label">PIN </span><span class="t-pin trow-pin-val">${esc(s.pin)}</span></span>
            </div>
            <span class="row-actions">
              <button class="abtn" data-act="view">Manage</button>
              ${s.active && s.assignedCount > 0 && !s.compliant ? `<button class="abtn" data-act="nudge">Nudge</button>` : ""}
              ${s.active ? `<button class="abtn danger" data-act="deact">Deactivate</button>` : `<button class="abtn" data-act="react">Reactivate</button>`}
            </span>
          </div>
        `);
        row.querySelector('[data-act="view"]').onclick = () => openStaffModal(s.id);
        const nudge = row.querySelector('[data-act="nudge"]');
        if (nudge) nudge.onclick = async () => {
          nudge.disabled = true; const t = nudge.textContent; nudge.textContent = "Sending…";
          try { const r = await api(`/org/staff/${s.id}/nudge`, "POST"); toast(r.message + (r.sent && !r.delivered ? " (Email isn't set up yet, so it was logged on the server.)" : "")); }
          catch (e) { toast(e.message); }
          nudge.disabled = false; nudge.textContent = t;
        };
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
      row.appendChild(el(`<span style="margin-left:auto;width:auto"><b style="color:${validCount===state.courses.length?"#1FA463":"#E0902E"}">${validCount}/${state.courses.length}</b></span>`));
      matrix.appendChild(row);
    });
    if (active.length === 0) matrix.appendChild(el(`<div class="empty">No active staff to report on.</div>`));
    body.appendChild(matrix);
    body.appendChild(el(`<div class="legend"><span class="cell ok">✓</span>Valid <span class="cell amber">⚠</span>Expiring <span class="cell prog">◐</span>In progress <span class="cell red">✗</span>Expired/Failed <span class="cell none">○</span>Assigned <span class="cell none">—</span>Not assigned</div>`));
  }

  if (orgTab === "refer") {
    const me = await api("/org/me");
    body.innerHTML = "";
    body.appendChild(el(`<h2 style="margin-bottom:18px">Refer &amp; earn</h2>`));
    body.appendChild(referralCard(me.referral || {}, { audience: "other care businesses", singular: "care business" }));
    return;
  }

  if (orgTab === "settings") {
    const me = await api("/org/me");
    const o = me.org;
    body.innerHTML = "";
    body.appendChild(el(`<h2 style="margin-bottom:18px">Organisation Settings</h2>`));
    body.appendChild(el(`
      <div>
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
        <div style="padding:0 20px 16px">
          ${o.subscription_status === "active"
            ? `<span class="pill green">✓ Subscribed</span><p style="font-size:13px;color:#586473;line-height:1.6;margin-top:8px">Your monthly subscription is active — all ${state.courses.length} mandatory courses, unlimited staff licences, assignments, certificates and CQC reporting are included.</p>`
            : `<span class="pill" style="background:#1E3A5F18;color:#1A5276">Pay as you go</span><p style="font-size:13px;color:#586473;line-height:1.6;margin:8px 0 12px">Subscribe for just ${PRICING.currency}${PRICING.subscriptionPerLearnerMonth} per learner / month to cover your whole team — every mandatory course included, with volume discounts as you grow.</p><button class="mini-btn" id="subscribe">⭐ Subscribe</button>`
          }
        </div>
      </div>
      <div class="scard" style="margin-top:16px"><h3>Notifications</h3>
        <div style="padding:0 20px 16px">
          <label style="display:flex;align-items:flex-start;gap:10px;font-size:14px;color:#1E3A5F;cursor:pointer">
            <input type="checkbox" id="remtoggle" ${o.reminders_enabled ? "checked" : ""} style="margin-top:3px">
            <span>Automatically email staff when their training is due, expiring or overdue — and send me a summary of who needs attention.</span>
          </label>
          <div style="margin-top:12px"><button class="mini-btn" id="rempreview">✉️ Send me a preview</button></div>
          <p style="font-size:12px;color:#8E99A8;margin-top:10px">Each person is emailed at most once a week, and only when something needs attention. The preview goes to your inbox only (${esc(o.email)}).</p>
        </div>
      </div>
      <div class="scard" style="margin-top:16px"><h3>Security</h3><div style="padding:0 20px 16px"><p style="font-size:13px;color:#586473;margin-bottom:10px">Change the password you use to sign in.</p><button class="mini-btn" id="orgchgpw">🔒 Change password</button></div></div>
      </div>
    `));
    document.getElementById("orgchgpw").onclick = () => openChangePassword("/org/change-password");
    const subBtn = document.getElementById("subscribe");
    if (subBtn) subBtn.onclick = () => startSubscribe();
    const remToggle = document.getElementById("remtoggle");
    if (remToggle) remToggle.onchange = async () => {
      try { await api("/org/settings", "POST", { remindersEnabled: remToggle.checked }); toast(remToggle.checked ? "Reminders turned on." : "Reminders turned off."); }
      catch (e) { remToggle.checked = !remToggle.checked; toast(e.message); }
    };
    const remPreview = document.getElementById("rempreview");
    if (remPreview) remPreview.onclick = async () => {
      remPreview.disabled = true; const t = remPreview.textContent; remPreview.textContent = "Sending…";
      try { const r = await api("/org/reminders/preview", "POST"); toast(r.delivered ? `Preview sent to ${r.sentTo}.` : `Preview generated — email isn't set up yet, so it was logged on the server.`); }
      catch (e) { toast(e.message); }
      remPreview.disabled = false; remPreview.textContent = t;
    };
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
            ${["Care Assistant","Senior Carer","Team Leader","Deputy Manager","Registered Manager","Support Carer","Nurse","Other"].map(r=>`<option>${r}</option>`).join("")}
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
      const resp = await api("/org/staff", "POST", payload);
      slot.innerHTML = "";
      toast(resp.note ? `✓ Licence created (PIN ${resp.pin}). ${resp.note}` : `✓ Licence created. Login PIN: ${resp.pin}`);
      paintOrgTab(null);
    } catch (e) { errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
}

// ─── BULK CSV IMPORT (organisations only) ─────────────────────────────────────
// Parse a CSV string into a 2-D array (handles quoted fields and commas).
function parseCSV(text) {
  text = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows = []; let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ""));
}
// Build a CSV file from a 2-D array and trigger a download.
function csvDownload(filename, rows) {
  const cell = (v) => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const text = rows.map(r => r.map(cell).join(",")).join("\n");
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function showBulkImportForm() {
  // Existing emails, for a friendly heads-up in the preview (server re-checks too).
  let existing = new Set();
  try { const { staff } = await api("/org/staff"); existing = new Set(staff.map(s => String(s.email || "").toLowerCase())); } catch (e) {}

  let parsedRows = []; // [{name,email,role,startDate}]
  const courseChecks = state.courses.map(c =>
    `<label class="chk" data-cid="${c.id}"><input type="checkbox" value="${c.id}"> ${c.icon} ${esc(c.title)}</label>`
  ).join("");

  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:780px">
      <div class="modal-h"><div><h2>Import staff from CSV</h2><p>Bulk-add care professionals using the same details as adding them by hand.</p></div><button class="x" id="close">✕</button></div>
      <div id="ibody" style="padding:14px 22px 20px">
        <div class="ok-banner" style="margin-bottom:14px">Your file needs a <b>name</b> and <b>email</b> column. <b>role</b> and <b>start_date</b> (YYYY-MM-DD) are optional. <button class="linkbtn" id="tmpl">Download a blank template</button></div>
        <div id="ierr"></div>
        <div class="fg"><label>Choose your CSV file</label><input class="inp" id="csvfile" type="file" accept=".csv,text/csv"></div>
        <div id="preview"></div>
        <div id="courseg" class="hidden">
          <label style="display:block;font-size:13px;font-weight:600;color:#374151;margin:12px 0 6px">Assign courses to everyone imported (optional)</label>
          <div class="chk-grid">${courseChecks}</div>
        </div>
        <div class="form-actions" style="margin-top:12px"><button class="btn-cancel" id="cancel">Cancel</button><button class="btn-save" id="doimport" disabled>Import</button></div>
      </div>
    </div>
  `);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const close = () => overlay.remove();
  modal.querySelector("#close").onclick = close;
  modal.querySelector("#cancel").onclick = close;
  modal.querySelectorAll(".chk").forEach(lbl => { const cb = lbl.querySelector("input"); cb.onchange = () => lbl.classList.toggle("on", cb.checked); });

  modal.querySelector("#tmpl").onclick = () => csvDownload("care2learn-staff-template.csv", [
    ["name", "email", "role", "start_date"],
    ["Jane Smith", "jane@example.com", "Care Assistant", "2026-01-15"],
    ["Mohammed Ali", "mo@example.com", "Senior Carer", "2026-02-01"],
  ]);

  const importBtn = modal.querySelector("#doimport");
  const preview = modal.querySelector("#preview");
  const courseg = modal.querySelector("#courseg");

  function colIndex(headers, names) {
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i].toLowerCase().replace(/[^a-z]/g, "");
      if (names.includes(h)) return i;
    }
    return -1;
  }

  modal.querySelector("#csvfile").onchange = (ev) => {
    const file = ev.target.files && ev.target.files[0];
    const ierr = modal.querySelector("#ierr"); ierr.innerHTML = "";
    preview.innerHTML = ""; importBtn.disabled = true; parsedRows = []; courseg.classList.add("hidden");
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const grid = parseCSV(reader.result);
      if (grid.length < 2) { ierr.innerHTML = `<div class="err">That file has no data rows. Use the template as a guide.</div>`; return; }
      const headers = grid[0].map(h => String(h).trim());
      const iName = colIndex(headers, ["name", "fullname"]);
      const iEmail = colIndex(headers, ["email", "emailaddress"]);
      const iRole = colIndex(headers, ["role", "jobrole", "job"]);
      const iStart = colIndex(headers, ["startdate", "start", "date"]);
      if (iName < 0 || iEmail < 0) { ierr.innerHTML = `<div class="err">Couldn't find a <b>name</b> and <b>email</b> column — please use the template headers.</div>`; return; }
      parsedRows = grid.slice(1).map(r => ({
        name: (r[iName] || "").trim(),
        email: (r[iEmail] || "").trim(),
        role: iRole >= 0 ? (r[iRole] || "").trim() : "",
        startDate: iStart >= 0 ? (r[iStart] || "").trim() : "",
      }));
      renderPreview();
    };
    reader.onerror = () => { ierr.innerHTML = `<div class="err">Couldn't read that file.</div>`; };
    reader.readAsText(file);
  };

  function renderPreview() {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const seen = new Set(); let ready = 0;
    const rowsHtml = parsedRows.map((r) => {
      const lc = r.email.toLowerCase();
      let status, cls;
      if (!r.name || !r.email) { status = "Missing name/email"; cls = "bad"; }
      else if (!emailRe.test(r.email)) { status = "Invalid email"; cls = "bad"; }
      else if (seen.has(lc)) { status = "Duplicate in file"; cls = "warn"; }
      else if (existing.has(lc)) { status = "Already on team"; cls = "warn"; }
      else { status = "Ready"; cls = "ok"; ready++; }
      if (r.email) seen.add(lc);
      return `<tr><td>${esc(r.name || "—")}</td><td>${esc(r.email || "—")}</td><td>${esc(r.role || "Care Assistant")}</td><td><span class="csv-tag ${cls}">${status}</span></td></tr>`;
    });
    const more = parsedRows.length > 50 ? `<div class="est-sub" style="margin-top:6px">…and ${parsedRows.length - 50} more rows</div>` : "";
    preview.innerHTML =
      `<div class="csv-sum">${ready} ready to import · ${parsedRows.length - ready} will be skipped</div>` +
      `<div class="csv-wrap"><table class="csv-preview"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th></tr></thead><tbody>${rowsHtml.slice(0, 50).join("")}</tbody></table></div>` + more;
    importBtn.disabled = ready === 0;
    courseg.classList.toggle("hidden", ready === 0);
  }

  importBtn.onclick = async () => {
    const courseIds = [...modal.querySelectorAll("#courseg .chk input:checked")].map(c => c.value);
    importBtn.disabled = true; importBtn.textContent = "Importing…";
    let result;
    try { result = await api("/org/staff/bulk", "POST", { rows: parsedRows, courseIds }); }
    catch (e) { modal.querySelector("#ierr").innerHTML = `<div class="err">${esc(e.message)}</div>`; importBtn.disabled = false; importBtn.textContent = "Import"; return; }
    renderResults(result);
  };

  function renderResults(result) {
    const { created, skipped, summary } = result;
    const createdRows = created.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td class="mono">${esc(c.pin)}</td></tr>`).join("");
    const skippedRows = skipped.map(s => `<tr><td>${esc(s.name || "—")}</td><td>${esc(s.email || "—")}</td><td>${esc(s.reason)}</td></tr>`).join("");
    modal.querySelector(".modal-h h2").textContent = "Import complete";
    modal.querySelector(".modal-h p").textContent = `${summary.created} added · ${summary.skipped} skipped`;
    const region = modal.querySelector("#ibody");
    region.innerHTML =
      `<div class="ok-banner" style="margin-bottom:14px"><b>${summary.created}</b> staff added, each with a login PIN below.${summary.skipped ? ` <b>${summary.skipped}</b> skipped.` : ""}</div>` +
      (result.courseNote ? `<div class="ok-banner" style="margin-bottom:14px;background:#E0902E18;border-color:#E0902E44;color:#7D5310">${esc(result.courseNote)}</div>` : "") +
      (created.length ? `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px"><b style="font-size:14px">New login PINs</b><button class="mini-btn" id="dlpins">⬇ Download PINs (CSV)</button></div><div class="csv-wrap"><table class="csv-preview"><thead><tr><th>Name</th><th>Email</th><th>PIN</th></tr></thead><tbody>${createdRows}</tbody></table></div>` : "") +
      (skipped.length ? `<div style="margin-top:14px"><b style="font-size:14px">Skipped rows</b><div class="csv-wrap"><table class="csv-preview"><thead><tr><th>Name</th><th>Email</th><th>Reason</th></tr></thead><tbody>${skippedRows}</tbody></table></div></div>` : "") +
      `<div class="form-actions" style="margin-top:14px"><button class="btn-save" id="done">Done</button></div>`;
    const dl = region.querySelector("#dlpins");
    if (dl) dl.onclick = () => csvDownload("care2learn-new-pins.csv", [["name", "email", "pin"], ...created.map(c => [c.name, c.email, c.pin])]);
    region.querySelector("#done").onclick = () => { overlay.remove(); paintOrgTab(null); };
  }
}

// ─── BULK / ROLE-BASED COURSE ASSIGNMENT (organisations only) ─────────────────
async function showAssignCourses() {
  let staff = [], me = null;
  try { const r = await api("/org/staff"); staff = (r.staff || []).filter(s => s.active); me = await api("/org/me"); }
  catch (e) { toast("Couldn't load staff."); return; }
  if (!staff.length) { toast("Add staff before assigning courses."); return; }
  const subscribed = !!me && me.org && me.org.subscription_status === "active";
  const credits = (me && me.org && me.org.credits) || 0;

  const roleCounts = {};
  staff.forEach(s => { const r = s.role || "Care Assistant"; roleCounts[r] = (roleCounts[r] || 0) + 1; });
  const roles = Object.keys(roleCounts).sort();

  const courseChecks = state.courses.map(c =>
    `<label class="chk" data-cid="${c.id}"><input type="checkbox" value="${c.id}"> ${c.icon} ${esc(c.title)}</label>`
  ).join("");
  const roleChecks = roles.map(r =>
    `<label class="chk"><input type="checkbox" class="rolecb" value="${esc(r)}"> ${esc(r)} <span style="color:#8E99A8;font-weight:600">(${roleCounts[r]})</span></label>`
  ).join("");

  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:680px">
      <div class="modal-h"><div><h2>Assign courses</h2><p>Add courses to your whole team, or just certain roles. Anyone already assigned a course keeps their existing progress.</p></div><button class="x" id="close">✕</button></div>
      <div style="padding:14px 22px 20px">
        <div id="aerr"></div>
        <label style="display:block;font-size:13px;font-weight:600;color:#374151;margin-bottom:6px">Courses to assign</label>
        <div class="chk-grid" id="coursegrid">${courseChecks}</div>
        <label style="display:block;font-size:13px;font-weight:600;color:#374151;margin:14px 0 8px">Who should get them?</label>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:#1E3A5F;cursor:pointer"><input type="radio" name="target" value="all" checked> Everyone (${staff.length} active staff)</label>
          <label style="display:flex;align-items:center;gap:8px;font-size:14px;color:#1E3A5F;cursor:pointer"><input type="radio" name="target" value="roles"> Only certain roles</label>
        </div>
        <div id="roleg" class="hidden" style="margin-top:10px"><div class="chk-grid">${roleChecks}</div></div>
        <div class="csv-sum" id="count" style="margin-top:14px"></div>
        <div class="form-actions" style="margin-top:6px"><button class="btn-cancel" id="cancel">Cancel</button><button class="btn-save" id="assign">Assign</button></div>
      </div>
    </div>
  `);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  const close = () => overlay.remove();
  modal.querySelector("#close").onclick = close;
  modal.querySelector("#cancel").onclick = close;
  modal.querySelectorAll(".chk").forEach(lbl => { const cb = lbl.querySelector("input"); cb.onchange = () => lbl.classList.toggle("on", cb.checked); });

  const roleg = modal.querySelector("#roleg");
  const countEl = modal.querySelector("#count");
  const targetVal = () => modal.querySelector("input[name=target]:checked").value;
  const chosenCourses = () => [...modal.querySelectorAll("#coursegrid input:checked")].map(c => c.value);
  const chosenRoles = () => [...modal.querySelectorAll(".rolecb:checked")].map(c => c.value);
  const affected = () => { if (targetVal() === "all") return staff.length; const set = new Set(chosenRoles()); return staff.filter(s => set.has(s.role || "Care Assistant")).length; };
  // How many genuinely new (staff × course) assignments the current selection would create.
  const newPairCount = () => {
    const courses = chosenCourses(); if (!courses.length) return 0;
    const set = new Set(chosenRoles());
    const targetStaff = targetVal() === "all" ? staff : staff.filter(s => set.has(s.role || "Care Assistant"));
    let n = 0;
    for (const m of targetStaff) { const have = new Set((m.enrolments || []).map(e => e.courseId)); for (const cid of courses) if (!have.has(cid)) n++; }
    return n;
  };
  function refreshCount() {
    const nC = chosenCourses().length, nS = affected();
    if (!nC || !nS) { countEl.textContent = "Choose courses and who should receive them."; countEl.style.color = ""; return; }
    const newPairs = newPairCount();
    if (subscribed) {
      countEl.innerHTML = `Will assign ${nC} course${nC === 1 ? "" : "s"} to ${nS} staff member${nS === 1 ? "" : "s"} · <b>included in your subscription</b>`;
      countEl.style.color = "";
    } else {
      const short = newPairs > credits;
      countEl.innerHTML = `Will assign ${nC} course${nC === 1 ? "" : "s"} to ${nS} staff member${nS === 1 ? "" : "s"} · <b>${newPairs} credit${newPairs === 1 ? "" : "s"}</b>${newPairs > 0 ? ` (you have ${credits})` : ""}${short ? " — not enough" : ""}`;
      countEl.style.color = short ? "#B91C1C" : "";
    }
  }
  modal.querySelectorAll("input[name=target]").forEach(r => r.onchange = () => { roleg.classList.toggle("hidden", targetVal() !== "roles"); refreshCount(); });
  modal.querySelectorAll("input[type=checkbox]").forEach(cb => cb.addEventListener("change", refreshCount));
  refreshCount();

  modal.querySelector("#assign").onclick = async () => {
    const courseIds = chosenCourses(), target = targetVal(), roles2 = chosenRoles();
    const err = modal.querySelector("#aerr"); err.innerHTML = "";
    if (!courseIds.length) { err.innerHTML = `<div class="err">Choose at least one course.</div>`; return; }
    if (target === "roles" && !roles2.length) { err.innerHTML = `<div class="err">Choose at least one role.</div>`; return; }
    const btn = modal.querySelector("#assign"); btn.disabled = true; btn.textContent = "Assigning…";
    try {
      const r = await api("/org/staff/assign-courses", "POST", { courseIds, target, roles: roles2 });
      overlay.remove();
      toast(r.mode === "subscription"
        ? `✓ Assigned to ${r.staffAffected} staff · ${r.enrolmentsAdded} new (included in your subscription).`
        : `✓ Assigned to ${r.staffAffected} staff · ${r.enrolmentsAdded} new · ${r.enrolmentsAdded} credit${r.enrolmentsAdded === 1 ? "" : "s"} used${typeof r.credits === "number" ? `, ${r.credits} left` : ""}.`);
      paintOrgTab(null);
    } catch (e) { err.innerHTML = `<div class="err">${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = "Assign"; }
  };
}

// ── Staff management modal (assign/remove courses, view progress) ──
async function openStaffModal(staffId) {
  const { staff } = await api("/org/staff");
  const s = staff.find(x => x.id === staffId);
  if (!s) return;

  const assignedIds = s.enrolments.map(e => e.courseId);
  const available = state.courses.filter(c => !assignedIds.includes(c.id));
  const hasOutstanding = s.enrolments.some(e => e.compliance !== "valid");

  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal">
      <div class="modal-h">
        <div><h2>${esc(s.name)}</h2><p>${esc(s.role)} · PIN ${esc(s.pin)}</p></div>
        <button class="x" id="close">✕</button>
      </div>
      <div class="info-row"><span>📧 ${esc(s.email)}</span><span>📅 Since ${fmtDate(s.startDate)}</span><span>${s.completedCount}/${s.assignedCount} completed</span></div>

      <div style="padding:14px 22px 4px"><b style="font-size:15px">Login PIN</b></div>
      <div style="padding:2px 22px 12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="pin-chip">PIN <b id="pinval">${esc(s.pin)}</b></span>
        <button class="mini-btn" id="resetpin">🔑 Reset PIN</button>
        <button class="mini-btn" id="remindpin">✉️ Email reminder</button>
        ${hasOutstanding ? `<button class="mini-btn" id="nudgebtn">📣 Nudge to complete</button>` : ""}
      </div>

      <div style="padding:14px 22px 6px;border-top:1px solid #F4F7FA"><b style="font-size:15px">Assigned Courses</b></div>
      <div id="assigned"></div>

      <div style="padding:14px 22px 6px;border-top:1px solid #F4F7FA;margin-top:8px"><b style="font-size:15px">Assign a New Course</b></div>
      <div style="padding:0 22px 18px" id="assign-slot"></div>
    </div>
  `);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();

  modal.querySelector("#remindpin").onclick = () => pinReminderMailto(s.name, s.email, s.pin, c2lOrgName);
  const nudgeBtn = modal.querySelector("#nudgebtn");
  if (nudgeBtn) nudgeBtn.onclick = async () => {
    nudgeBtn.disabled = true; const t = nudgeBtn.textContent; nudgeBtn.textContent = "Sending…";
    try { const r = await api(`/org/staff/${s.id}/nudge`, "POST"); toast(r.message + (r.sent && !r.delivered ? " (Logged on the server — email isn't set up yet.)" : "")); }
    catch (e) { toast(e.message); }
    nudgeBtn.disabled = false; nudgeBtn.textContent = t;
  };
  modal.querySelector("#resetpin").onclick = async () => {
    if (!confirm(`Reset ${s.name}'s PIN? Their current PIN will stop working immediately.`)) return;
    let r; try { r = await api(`/org/staff/${s.id}/reset-pin`, "POST"); } catch (e) { toast(e.message); return; }
    s.pin = r.pin;
    const pv = modal.querySelector("#pinval"); if (pv) pv.textContent = r.pin;
    const hdrPin = modal.querySelector(".modal-h p"); if (hdrPin) hdrPin.innerHTML = `${esc(s.role)} · PIN ${esc(r.pin)}`;
    toast(`New PIN for ${s.name}: ${r.pin}`);
    if (confirm(`New PIN is ${r.pin}. Email it to ${s.name} now?`)) pinReminderMailto(s.name, s.email, r.pin, c2lOrgName);
  };

  const assignedBox = modal.querySelector("#assigned");
  if (s.enrolments.length === 0) {
    assignedBox.appendChild(el(`<div style="padding:8px 22px;color:#8E99A8;font-size:13px;font-style:italic">No courses assigned yet.</div>`));
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
            <div class="mini-bar"><div class="mini-fill" style="width:${e.progress}%;background:${c.color||"#1E3A5F"}"></div></div>
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
    assignSlot.appendChild(el(`<div style="color:#8E99A8;font-size:13px;font-style:italic">All courses assigned.</div>`));
  } else {
    const sel = el(`<select class="inp" style="margin-bottom:10px">${available.map(c=>`<option value="${c.id}">${c.icon} ${esc(c.title)}</option>`).join("")}</select>`);
    const btn = el(`<button class="btn-save" style="width:100%">Assign Course</button>`);
    assignSlot.appendChild(sel);
    assignSlot.appendChild(btn);
    btn.onclick = async () => {
      try { await api(`/org/staff/${s.id}/enrol`, "POST", { courseId: sel.value }); }
      catch (e) { toast(e.message); return; }
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
        <h2 style="font-size:21px;font-weight:800;color:#1E3A5F;margin-bottom:8px">Thank you!</h2>
        <p style="font-size:14px;color:#586473;line-height:1.6;max-width:340px;margin:0 auto 22px">Your feedback has been sent to the Care2Learn team. Every piece of feedback helps us to improve.</p>
        <button class="fb-send" id="fbdone" style="max-width:200px;margin:0 auto">Done</button>
      </div>`;
    modal.querySelector("#fbdone").onclick = () => overlay.remove();
  };
  setTimeout(() => modal.querySelector("#fbmsg")?.focus(), 50);
}

// ═══════════════════════════════════════════════════════════════════════════
//  SUPER ADMIN PORTAL  (hidden — reached at /#admin)
// ═══════════════════════════════════════════════════════════════════════════
let adminTab = "companies";

function renderAdminLogin(errMsg) {
  App.innerHTML = "";
  App.appendChild(el(`
    <div class="auth-page"><div class="auth-card">
      <button class="back-sm" id="back">← Back to site</button>
      <div class="auth-logo" style="display:flex;align-items:center;gap:8px">${logoMark(22, true)}<span>Care2Learn</span></div>
      <div style="margin:6px 0 12px"><span class="admin-badge">Super Admin</span></div>
      <div class="auth-title">Super Admin Login</div>
      <div id="err">${errMsg ? `<div class="err">${esc(errMsg)}</div>` : ""}</div>
      <div class="fg"><label>Email</label><input class="inp" id="ae" type="email" placeholder="you@care2learn.co.uk"></div>
      <div class="fg"><label>Password</label><input class="inp" id="ap" type="password" placeholder="Your password"></div>
      <button class="btn-auth" id="asubmit" style="background:#1E3A5F">Sign In</button>
    </div></div>
  `));
  document.getElementById("back").onclick = () => { location.hash = ""; renderLanding(); };
  document.getElementById("asubmit").onclick = () => doAdminLogin(val("ae"), val("ap"));
  document.getElementById("ap").onkeydown = (e) => { if (e.key === "Enter") doAdminLogin(val("ae"), val("ap")); };
}

async function doAdminLogin(email, password) {
  const errBox = document.getElementById("err");
  if (errBox) errBox.innerHTML = "";
  try {
    const { token } = await api("/admin/login", "POST", { email, password });
    setAuth(token, "admin");
    location.hash = "#admin";
    await renderAdminDash();
  } catch (e) { if (errBox) errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

function adminHeader() {
  const hdr = el(`
    <div class="dash-hdr">
      <div class="dash-brand"><span class="dash-logo">${logoMark(26, false)}</span><div><div class="dash-org">Care2Learn <span class="admin-badge">Super Admin</span></div><div class="dash-sub">Platform administration</div></div></div>
      <nav class="dash-nav" id="anav"></nav>
      <div class="dash-actions">
        <button class="logout" id="alogout">Log Out</button>
      </div>
    </div>`);
  return hdr;
}
function wireAdminLogout() {
  document.getElementById("alogout").onclick = async () => { await api("/logout", "POST").catch(() => {}); clearAuth(); location.hash = ""; renderLanding(); };
}

async function renderAdminDash() {
  App.innerHTML = `<div class="spin">Loading…</div>`;
  let data;
  try { data = await api("/admin/orgs"); }
  catch (e) { clearAuth(); renderAdminLogin(e.message); return; }
  App.innerHTML = "";
  const wrap = el(`<div></div>`);
  wrap.appendChild(adminHeader());
  wrap.appendChild(el(`<div class="body" id="abody"></div>`));
  App.appendChild(wrap);
  const nav = document.getElementById("anav");
  [["companies", "🏢 Accounts"], ["payments", "💷 Payments"], ["referrals", "🎁 Referrals"], ["feedback", "💬 Feedback"], ["enquiries", "📩 Enquiries"]].forEach(([k, label]) => {
    const b = el(`<button class="nav-btn ${adminTab === k ? "active" : ""}">${label}</button>`);
    b.onclick = () => { adminTab = k; paintAdminTab(data); };
    nav.appendChild(b);
  });
  wireAdminLogout();
  paintAdminTab(data);
}

function paintAdminTab(data) {
  const tabs = ["companies", "payments", "referrals", "feedback", "enquiries"];
  document.querySelectorAll("#anav .nav-btn").forEach((b, i) => b.classList.toggle("active", tabs[i] === adminTab));
  const body = document.getElementById("abody");
  body.innerHTML = "";
  if (adminTab === "companies") return paintAdminCompanies(body, data);
  if (adminTab === "payments") return paintAdminPayments(body);
  if (adminTab === "referrals") return paintAdminReferrals(body);
  if (adminTab === "feedback") return paintAdminFeedback(body);
  return paintAdminEnquiries(body);
}

function adminOrgRow(o) {
  const initials = (o.name || "?").split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase() || "?";
  const row = el(`
    <button class="org-row${o.active ? "" : " inactive"}">
      <span class="org-ava">${esc(initials)}</span>
      <span class="org-row-body">
        <span class="org-row-name">${esc(o.name)}${o.accountType === "individual" ? ` <span class="ind-badge">Individual</span>` : ""}${o.active ? "" : ` <span class="off-badge">Inactive</span>`}</span>
        <span class="org-row-meta">${esc(o.email)}${o.cqcNumber ? " · CQC " + esc(o.cqcNumber) : ""} · joined ${fmtDate(o.createdAt)}</span>
      </span>
      <span class="org-row-stats">
        <span class="org-stat"><span class="org-stat-n">${o.activeStaff}</span><span class="org-stat-l">${o.accountType === "individual" ? "Learner" : "Staff"}</span></span>
        <span class="org-stat"><span class="org-stat-n">${o.fullyCompliant}</span><span class="org-stat-l">Compliant</span></span>
        <span class="org-stat"><span class="org-stat-n">${o.enrolments}</span><span class="org-stat-l">Courses</span></span>
        <span class="org-stat"><span class="org-stat-n" style="color:#1E3A5F">${o.credits || 0}</span><span class="org-stat-l">Credits</span></span>
      </span>
    </button>`);
  row.onclick = () => renderAdminOrg(o.id);
  return row;
}

function paintAdminCompanies(body, data) {
  const t = data.totals;
  const companies = data.orgs.filter(o => o.accountType !== "individual");
  const individuals = data.orgs.filter(o => o.accountType === "individual");
  body.appendChild(el(`
    <div>
      <h1 style="margin:0 0 4px">Accounts</h1>
      <p style="color:#586473;margin-bottom:18px">Every organisation and self-employed carer on Care2Learn. Tap one to view and support it.</p>
      <div class="astats">
        <div class="metric"><div class="metric-i">🏢</div><div class="metric-v" style="color:#1E3A5F">${companies.length}</div><div class="metric-l">Companies</div></div>
        <div class="metric"><div class="metric-i">🧑‍⚕️</div><div class="metric-v" style="color:#1E3A5F">${individuals.length}</div><div class="metric-l">Self-employed</div></div>
        <div class="metric"><div class="metric-i">👥</div><div class="metric-v" style="color:#1E3A5F">${t.staff}</div><div class="metric-l">Learners</div></div>
        <div class="metric"><div class="metric-i">💳</div><div class="metric-v" style="color:#1FA463">${t.credits || 0}</div><div class="metric-l">Total Credits</div></div>
      </div>
    </div>`));

  const cHead = el(`<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:6px 0 12px"><h2 style="margin:0">🏢 Companies (${companies.length})</h2><button class="btn-primary" id="newco" style="width:auto;padding:9px 16px;background:#1E3A5F">+ New Company</button></div>`);
  body.appendChild(cHead);
  cHead.querySelector("#newco").onclick = () => openAdminNewCompany(() => renderAdminDash());
  if (!companies.length) body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">No companies have registered yet.</div>`));
  else { const g = el(`<div class="org-grid"></div>`); companies.forEach(o => g.appendChild(adminOrgRow(o))); body.appendChild(g); }

  const iHead = el(`<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:28px 0 12px"><h2 style="margin:0">🧑‍⚕️ Self-employed carers (${individuals.length})</h2><button class="btn-primary" id="newind" style="width:auto;padding:9px 16px;background:#1E3A5F">+ New carer</button></div>`);
  body.appendChild(iHead);
  iHead.querySelector("#newind").onclick = () => openAdminNewIndividual(() => renderAdminDash());
  if (!individuals.length) body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">No self-employed carers have registered yet. They sign up from the home page.</div>`));
  else { const g = el(`<div class="org-grid"></div>`); individuals.forEach(o => g.appendChild(adminOrgRow(o))); body.appendChild(g); }
}

async function paintAdminPayments(body) {
  body.appendChild(el(`<div><h1 style="margin:0 0 4px">Payments</h1><p style="color:#586473;margin-bottom:16px">Card payments received via Stripe — each one automatically tops up the account's credit balance.</p></div>`));
  let data;
  try { data = await api("/admin/payments"); }
  catch (e) { body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">${esc(e.message)}</div>`)); return; }
  const pounds = (p) => "£" + (p / 100).toLocaleString(undefined, Number.isInteger(p / 100) ? {} : { minimumFractionDigits: 2 });
  body.appendChild(el(`<div class="astats">
    <div class="metric"><div class="metric-i">💷</div><div class="metric-v" style="color:#1FA463">${pounds(data.totalPence || 0)}</div><div class="metric-l">Total received</div></div>
    <div class="metric"><div class="metric-i">💳</div><div class="metric-v" style="color:#1E3A5F">${data.totalCredits || 0}</div><div class="metric-l">Credits sold</div></div>
    <div class="metric"><div class="metric-i">🧾</div><div class="metric-v" style="color:#1E3A5F">${data.count || 0}</div><div class="metric-l">Payments</div></div>
  </div>`));
  if (!data.payments || !data.payments.length) { body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">No payments yet. When a company or carer buys credits, it'll appear here automatically.</div>`)); return; }
  const table = el(`<div class="pay-table"></div>`);
  table.appendChild(el(`<div class="pay-row pay-head"><span>Date</span><span>Account</span><span style="text-align:right">Credits</span><span style="text-align:right">Amount</span></div>`));
  data.payments.forEach(p => {
    const row = el(`<button class="pay-row">
      <span class="pay-date">${fmtDate(p.createdAt)}</span>
      <span class="pay-acct">${esc(p.orgName)}${p.accountType === "individual" ? ` <span class="ind-badge">Individual</span>` : ""}</span>
      <span style="text-align:right;font-weight:700;color:#1E3A5F">+${p.credits}</span>
      <span style="text-align:right;font-weight:800;color:#1FA463">${pounds(p.amountPence)}</span>
    </button>`);
    if (p.orgId) row.onclick = () => renderAdminOrg(p.orgId);
    table.appendChild(row);
  });
  body.appendChild(table);
}

async function paintAdminReferrals(body) {
  body.appendChild(el(`<div><h1 style="margin:0 0 4px">Referrals</h1><p style="color:#586473;margin-bottom:16px">Referrers are credited automatically when a referred account makes its first purchase. You can also <strong>approve</strong> a referral to pay it early, or <strong>decline</strong> one to block it from ever paying out.</p></div>`));
  let data;
  try { data = await api("/admin/referrals"); }
  catch (e) { body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">${esc(e.message)}</div>`)); return; }
  const s = data.summary || {};
  body.appendChild(el(`<div class="astats">
    <div class="metric"><div class="metric-i">⏳</div><div class="metric-v" style="color:#C7892B">${s.pendingCount || 0}</div><div class="metric-l">Pending review</div></div>
    <div class="metric"><div class="metric-i">🎁</div><div class="metric-v" style="color:#1FA463">${s.approvedCount || 0}</div><div class="metric-l">Credited</div></div>
    <div class="metric"><div class="metric-i">🚫</div><div class="metric-v" style="color:#8A94A0">${s.declinedCount || 0}</div><div class="metric-l">Declined</div></div>
    <div class="metric"><div class="metric-i">💳</div><div class="metric-v" style="color:#1E3A5F">${s.creditsAwarded || 0}</div><div class="metric-l">Credits awarded</div></div>
    <div class="metric"><div class="metric-i">👥</div><div class="metric-v" style="color:#1E3A5F">${s.totalReferred || 0}</div><div class="metric-l">Total referred</div></div>
  </div>`));
  if (!data.referrals || !data.referrals.length) { body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">No referrals yet. When someone signs up using another account's referral code, it'll appear here.</div>`)); return; }
  const refresh = () => { const b = document.getElementById("abody"); if (b) { b.innerHTML = ""; paintAdminReferrals(b); } };
  const table = el(`<div class="ref-atable"></div>`);
  data.referrals.forEach(r => {
    const badge = r.referredType === "individual" ? ` <span class="ind-badge">Individual</span>` : "";
    const rbadge = r.referrerType === "individual" ? ` <span class="ind-badge">Individual</span>` : "";
    let pill;
    if (r.status === "approved") pill = `<span class="ref-pill ref-pill-paid">✓ Credited</span>`;
    else if (r.status === "declined") pill = `<span class="ref-pill ref-pill-declined">✕ Declined</span>`;
    else pill = `<span class="ref-pill ref-pill-pending">⏳ Pending</span>`;
    const purchaseTag = r.status === "approved" ? "" : (r.hasPurchased ? ` · <span style="color:#1FA463;font-weight:700">✓ has purchased</span>` : ` · <span style="color:#9AA5B1">no purchase yet</span>`);
    const creditedTag = r.status === "approved" && r.approvedAt ? " · credited " + fmtDate(r.approvedAt) : "";
    const row = el(`<div class="ref-arow">
      <div class="ref-amain">
        <div class="ref-aname${r.referredId ? " clickable" : ""}">${esc(r.referredName)}${badge}</div>
        <div class="ref-ameta">Referred by <span class="ref-aref">${esc(r.referrerName)}</span>${rbadge} · code ${esc(r.code)} · joined ${fmtDate(r.joinedAt)}${creditedTag}${purchaseTag}</div>
      </div>
      <div class="ref-aright">
        ${pill}
        <span class="ref-acredits" style="color:${r.status === "approved" ? "#1FA463" : "#9AA5B1"}">+${r.credits}</span>
        <span class="ref-aactions"></span>
      </div>
    </div>`);
    if (r.referredId) { const n = row.querySelector(".ref-aname"); n.onclick = () => renderAdminOrg(r.referredId); }
    if (r.referrerId) { const n = row.querySelector(".ref-aref"); n.onclick = () => renderAdminOrg(r.referrerId); }
    const actions = row.querySelector(".ref-aactions");
    const addApprove = (label) => {
      const b = el(`<button class="mini-btn success">${label}</button>`);
      b.onclick = async () => {
        b.disabled = true;
        try { const res = await api("/admin/referrals/" + r.referredId + "/approve", "POST"); toast(`Approved — ${res.referrerName} credited +${res.reward}.`); refresh(); }
        catch (e) { toast(e.message); b.disabled = false; }
      };
      actions.appendChild(b);
    };
    const addDecline = () => {
      const b = el(`<button class="mini-btn danger">Decline</button>`);
      b.onclick = async () => {
        b.disabled = true;
        try { await api("/admin/referrals/" + r.referredId + "/decline", "POST"); toast("Referral declined — it won't pay out."); refresh(); }
        catch (e) { toast(e.message); b.disabled = false; }
      };
      actions.appendChild(b);
    };
    if (r.status === "pending") { addApprove("Approve"); addDecline(); }
    else if (r.status === "declined") { addApprove("Approve anyway"); }
    table.appendChild(row);
  });
  body.appendChild(table);
}

async function paintAdminEnquiries(body) {
  body.appendChild(el(`<div><h1 style="margin-bottom:4px">Enquiries</h1><p style="color:#586473;margin-bottom:16px">Demo requests and messages sent from the public website's contact form.</p></div>`));
  let data;
  try { data = await api("/admin/enquiries"); }
  catch (e) { body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">${esc(e.message)}</div>`)); return; }
  const c = data.counts || {};
  body.appendChild(el(`<div class="astats">
    <div class="metric"><div class="metric-i">📨</div><div class="metric-v">${c.total || 0}</div><div class="metric-l">Total</div></div>
    <div class="metric"><div class="metric-i">🔵</div><div class="metric-v" style="color:#1E3A5F">${c.open || 0}</div><div class="metric-l">To follow up</div></div>
    <div class="metric"><div class="metric-i">✅</div><div class="metric-v" style="color:#1FA463">${c.handled || 0}</div><div class="metric-l">Handled</div></div>
  </div>`));
  if (!data.enquiries.length) {
    body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">No enquiries yet. Demo requests from the website will appear here.</div>`));
    return;
  }
  const list = el(`<div></div>`);
  const subject = encodeURIComponent("Care2Learn — your demo request");
  data.enquiries.forEach((q) => {
    const done = !!q.handled_at;
    const mailto = `mailto:${esc(q.email)}?subject=${subject}`;
    const item = el(`
      <div class="fb-item" style="border-left:4px solid ${done ? "#1FA463" : "#1E3A5F"};${done ? "opacity:.7" : ""}">
        <div class="fb-item-h">
          <span class="fb-item-kind">${done ? "✅ Handled" : "🔵 To follow up"}</span>
          <span>${fmtDate(q.created_at)}</span>
        </div>
        <div style="font-size:15px;color:#1E3A5F;font-weight:700;margin-bottom:2px">${esc(q.name)}${q.org ? ` <span style="font-weight:400;color:#586473">· ${esc(q.org)}</span>` : ""}</div>
        <div style="font-size:13px;margin-bottom:8px"><a href="${mailto}" class="linkbtn" style="text-decoration:none">${esc(q.email)}</a></div>
        ${q.message ? `<div style="font-size:14px;color:#1E3A5F;line-height:1.5;margin-bottom:10px">${esc(q.message)}</div>` : `<div style="font-size:13px;color:#9AA5B1;margin-bottom:10px">(no message left)</div>`}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="mini-btn ${done ? "" : "success"}" data-act="toggle">${done ? "↩︎ Reopen" : "✓ Mark handled"}</button>
          <a class="mini-btn" href="${mailto}" style="text-decoration:none">✉️ Reply by email</a>
          <button class="mini-btn danger" data-act="delete">Delete</button>
        </div>
      </div>`);
    item.querySelector('[data-act="toggle"]').onclick = async (ev) => {
      ev.target.disabled = true;
      try { await api("/admin/enquiries/" + q.id, "PATCH", { handled: !done }); paintAdminTab(); }
      catch (e) { toast(e.message); ev.target.disabled = false; }
    };
    item.querySelector('[data-act="delete"]').onclick = async (ev) => {
      if (!confirm("Delete this enquiry permanently?")) return;
      ev.target.disabled = true;
      try { await api("/admin/enquiries/" + q.id, "DELETE"); toast("Enquiry deleted."); paintAdminTab(); }
      catch (e) { toast(e.message); ev.target.disabled = false; }
    };
    list.appendChild(item);
  });
  body.appendChild(list);
}

async function paintAdminFeedback(body) {
  body.appendChild(el(`<div><h1 style="margin-bottom:4px">Feedback</h1><p style="color:#586473;margin-bottom:16px">Compliments, bugs and feature requests from companies and their staff.</p></div>`));
  let data;
  try { data = await api("/admin/feedback"); } catch (e) { body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">${esc(e.message)}</div>`)); return; }
  const c = data.counts || {};
  body.appendChild(el(`<div class="astats">
    <div class="metric"><div class="metric-i">👍</div><div class="metric-v" style="color:#1FA463">${c.compliment || 0}</div><div class="metric-l">Compliments</div></div>
    <div class="metric"><div class="metric-i">🐞</div><div class="metric-v" style="color:#E5484D">${c.bug || 0}</div><div class="metric-l">Bugs</div></div>
    <div class="metric"><div class="metric-i">💡</div><div class="metric-v" style="color:#1E3A5F">${c.feature || 0}</div><div class="metric-l">Feature Requests</div></div>
  </div>`));
  if (!data.feedback.length) { body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">No feedback yet.</div>`)); return; }
  const list = el(`<div></div>`);
  const label = { compliment: "👍 Compliment", bug: "🐞 Bug", feature: "💡 Feature" };
  data.feedback.forEach(f => {
    const who = f.submitter_name ? `${esc(f.submitter_name)} (${esc(f.submitter_kind || "—")})` : "Anonymous";
    list.appendChild(el(`
      <div class="fb-item ${esc(f.kind)}">
        <div class="fb-item-h"><span class="fb-item-kind">${label[f.kind] || esc(f.kind)}</span><span>${fmtDate(f.created_at)}</span></div>
        <div style="font-size:14px;color:#1E3A5F;line-height:1.5;margin-bottom:6px">${esc(f.message)}</div>
        <div style="font-size:12px;color:#9AA5B1">From ${who}${f.context ? " · " + esc(f.context) : ""}</div>
      </div>`));
  });
  body.appendChild(list);
}

async function renderAdminOrg(orgId) {
  App.innerHTML = `<div class="spin">Loading…</div>`;
  let data;
  try { data = await api(`/admin/orgs/${orgId}`); }
  catch (e) { toast(e.message); return renderAdminDash(); }
  const { org, staff } = data;
  const transactions = data.transactions || [];
  c2lAdminOrgName = org.name;
  App.innerHTML = "";
  const wrap = el(`<div></div>`);
  wrap.appendChild(adminHeader());
  const body = el(`<div class="body"></div>`);
  const back = el(`<button class="feedback-btn" style="margin-bottom:14px">← All companies</button>`);
  back.onclick = () => renderAdminDash();
  body.appendChild(back);
  const infoCard = el(`
    <div style="background:#fff;border:1px solid #E7ECF2;border-radius:14px;padding:20px;margin-bottom:14px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="min-width:0">
          <h1 style="margin-bottom:8px">${esc(org.name)} ${org.accountType === "individual" ? `<span class="ind-badge">Individual</span> ` : ""}${org.active ? `<span class="on-badge">Active</span>` : `<span class="off-badge">Inactive</span>`}</h1>
          <div class="info-row" style="border:none;border-radius:0;padding:0;background:none">
            <span>📧 ${esc(org.email)}</span>
            ${org.phone ? `<span>📞 ${esc(org.phone)}</span>` : ""}
            ${org.cqcNumber ? `<span>🏥 CQC ${esc(org.cqcNumber)}</span>` : ""}
            <span>📅 Joined ${fmtDate(org.createdAt)}</span>
          </div>
          ${org.address ? `<div style="font-size:13px;color:#8E99A8;margin-top:8px">${esc(org.address)}</div>` : ""}
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:stretch;flex-shrink:0">
          <button class="mini-btn" id="resetpw">🔑 Reset password</button>
          <button class="mini-btn ${org.active ? "danger" : ""}" id="togglecompany">${org.active ? "Deactivate" : "Reactivate"}</button>
        </div>
      </div>
      ${org.active ? "" : `<div style="margin-top:12px;background:#FEF2F2;border:1px solid #FCA5A5;border-radius:8px;padding:8px 12px;font-size:12px;color:#B91C1C">This company is deactivated — it and its staff cannot log in.</div>`}
    </div>`);
  body.appendChild(infoCard);
  infoCard.querySelector("#togglecompany").onclick = async () => {
    const deact = org.active;
    if (deact && !confirm(`Deactivate ${org.name}? They and their staff will be unable to log in until you reactivate them.`)) return;
    try { await api(`/admin/orgs/${orgId}`, "PATCH", { active: !org.active }); } catch (e) { toast(e.message); return; }
    toast(deact ? `${org.name} deactivated.` : `${org.name} reactivated.`);
    renderAdminOrg(orgId);
  };
  infoCard.querySelector("#resetpw").onclick = () => openAdminResetPassword(orgId, org.name, org.email);
  const creditsCard = el(`
    <div style="background:#fff;border:1px solid #E7ECF2;border-radius:14px;padding:18px 20px;margin-bottom:14px;display:flex;align-items:center;gap:18px;flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <div style="font-size:12px;font-weight:700;color:#8E99A8;text-transform:uppercase;letter-spacing:.5px">Course credits</div>
        <div style="font-size:34px;font-weight:900;color:#1E3A5F;line-height:1.1;margin-top:2px">${org.credits}</div>
        <div style="font-size:12px;color:#9AA5B1;margin-top:2px">1 credit = 1 course assigned to 1 learner</div>
      </div>
      <button class="btn-primary" id="addcredits" style="width:auto;padding:10px 18px;background:#1E3A5F">+ Add credits</button>
    </div>`);
  body.appendChild(creditsCard);
  creditsCard.querySelector("#addcredits").onclick = () => openAdminCredits(orgId, org.credits, () => renderAdminOrg(orgId));
  if (transactions.length) {
    const hist = el(`<div style="background:#fff;border:1px solid #E7ECF2;border-radius:12px;padding:14px 16px;margin-bottom:18px"></div>`);
    hist.appendChild(el(`<div style="font-size:12px;font-weight:700;color:#8E99A8;margin-bottom:6px;text-transform:uppercase;letter-spacing:.3px">Recent top-ups</div>`));
    transactions.slice(0, 5).forEach(t => {
      hist.appendChild(el(`<div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:6px 0;border-bottom:1px solid #F4F6F8">
        <span style="color:#1E3A5F">${t.amount > 0 ? "+" : ""}${t.amount} credits${t.note ? " · " + esc(t.note) : ""}</span>
        <span style="color:#9AA5B1;white-space:nowrap">${fmtDate(t.created_at)} · bal ${t.balance_after}</span>
      </div>`));
    });
    body.appendChild(hist);
  }
  const sh = el(`<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px"><h2 style="margin:0">Staff (${staff.length})</h2></div>`);
  const addBtn = el(`<button class="btn-primary" style="width:auto;padding:9px 16px">+ Add Staff</button>`);
  addBtn.onclick = () => openAdminAddStaff(orgId, () => renderAdminOrg(orgId));
  sh.appendChild(addBtn);
  body.appendChild(sh);
  if (!staff.length) body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">No staff yet. Use “Add Staff” to create the first licence.</div>`));
  else {
    const grid = el(`<div class="sc-grid"></div>`);
    staff.forEach(s => {
      const statusColor = !s.active ? "#94A3B8" : s.compliant ? "#1FA463" : "#E0902E";
      const statusText = !s.active ? "Inactive" : s.compliant ? "Compliant" : "In progress";
      const card = el(`
        <div class="sc" style="cursor:pointer">
          <div class="sc-top" style="background:#1E3A5F"><span style="font-size:28px">👤</span><span class="sc-badge" style="background:${statusColor}66">${statusText}</span></div>
          <div class="sc-body">
            <div class="sc-title">${esc(s.name)}</div>
            <div class="sc-meta">${esc(s.role)} · PIN ${esc(s.pin)}</div>
            <div class="sc-meta" style="margin-top:4px">${s.completedCount}/${s.assignedCount} courses complete</div>
          </div>
        </div>`);
      card.onclick = () => openAdminStaffModal(orgId, s, () => renderAdminOrg(orgId));
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }
  wrap.appendChild(body);
  App.appendChild(wrap);
  wireAdminLogout();
}

function openAdminAddStaff(orgId, onAdded) {
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:480px">
      <div class="modal-h"><div><h2>Add Staff</h2><p>Create a new staff licence for this company</p></div><button class="x" id="close">✕</button></div>
      <div style="padding:18px 22px 22px">
        <div id="aserr"></div>
        <div class="fg"><label>Full name *</label><input class="inp" id="asn" placeholder="Jane Smith"></div>
        <div class="fg"><label>Email *</label><input class="inp" id="ase" type="email" placeholder="jane@email.com"></div>
        <div class="fg"><label>Role</label><input class="inp" id="asr" placeholder="Care Assistant"></div>
        <button class="btn-auth" id="asadd">Create licence</button>
      </div>
    </div>`);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();
  modal.querySelector("#asadd").onclick = async () => {
    const name = val("asn"), email = val("ase"), role = val("asr") || "Care Assistant";
    const errBox = modal.querySelector("#aserr"); errBox.innerHTML = "";
    if (!name || !email) { errBox.innerHTML = `<div class="err">Name and email are required.</div>`; return; }
    try {
      const { pin } = await api(`/admin/orgs/${orgId}/staff`, "POST", { name, email, role });
      modal.innerHTML = `<div style="padding:40px 28px;text-align:center">
        <div style="font-size:50px;margin-bottom:8px">✅</div>
        <h2 style="font-size:20px;font-weight:800;margin-bottom:6px">${esc(name)} added</h2>
        <p style="color:#586473;font-size:14px;margin-bottom:6px">Their login PIN is</p>
        <div style="font-size:30px;font-weight:900;letter-spacing:4px;color:#1E3A5F;margin-bottom:18px">${esc(pin)}</div>
        <button class="btn-auth" id="asdone" style="max-width:200px;margin:0 auto">Done</button></div>`;
      modal.querySelector("#asdone").onclick = () => { overlay.remove(); onAdded && onAdded(); };
    } catch (e) { errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  setTimeout(() => modal.querySelector("#asn")?.focus(), 50);
}

function openAdminResetPassword(orgId, name, email) {
  if (!confirm(`Reset the login password for ${name}? Their current password stops working immediately.`)) return;
  api(`/admin/orgs/${orgId}/reset-password`, "POST").then(r => {
    const overlay = el(`<div class="overlay"></div>`);
    const modal = el(`
      <div class="modal" style="max-width:440px">
        <div class="modal-h"><div><h2>New password</h2><p>Share this with ${esc(name)} — it replaces their old one.</p></div><button class="x" id="close">✕</button></div>
        <div style="padding:22px;text-align:center">
          <div style="font-size:30px;font-weight:900;letter-spacing:3px;color:#1E3A5F;margin-bottom:16px">${esc(r.password)}</div>
          <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
            <button class="mini-btn" id="copy">📋 Copy</button>
            <button class="mini-btn" id="emailit">✉️ Email it</button>
          </div>
          <p class="fb-note">They can change it themselves any time from their account settings.</p>
        </div>
      </div>`);
    overlay.appendChild(modal); document.body.appendChild(overlay);
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    modal.querySelector("#close").onclick = () => overlay.remove();
    modal.querySelector("#copy").onclick = () => { try { navigator.clipboard.writeText(r.password); toast("Password copied."); } catch { toast(r.password); } };
    modal.querySelector("#emailit").onclick = () => {
      const subj = encodeURIComponent("Your Care2Learn password has been reset");
      const bdy = encodeURIComponent(`Hi ${name},\n\nYour Care2Learn login password has been reset to:\n\n${r.password}\n\nPlease sign in at ${window.location.origin} and change it from your account settings.\n\nThanks,\nThe Care2Learn team`);
      window.location.href = `mailto:${email}?subject=${subj}&body=${bdy}`;
    };
  }).catch(e => toast(e.message));
}

// Self-service "change password" for organisations and self-employed carers.
function openChangePassword(endpoint) {
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:420px">
      <div class="modal-h"><div><h2>Change password</h2><p>Choose a new password for your account</p></div><button class="x" id="close">✕</button></div>
      <div style="padding:18px 22px 22px">
        <div id="cperr"></div>
        <div class="fg"><label>Current password</label><input class="inp" id="cpcur" type="password" placeholder="Current password"></div>
        <div class="fg"><label>New password</label><input class="inp" id="cpnew" type="password" placeholder="At least 6 characters"></div>
        <div class="fg"><label>Confirm new password</label><input class="inp" id="cpconf" type="password" placeholder="Re-enter new password"></div>
        <button class="btn-auth" id="cpsave">Update password</button>
      </div>
    </div>`);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();
  modal.querySelector("#cpsave").onclick = async () => {
    const errBox = modal.querySelector("#cperr"); errBox.innerHTML = "";
    const cur = val("cpcur"), nw = val("cpnew"), cf = val("cpconf");
    if (!cur || !nw) { errBox.innerHTML = `<div class="err">Enter your current and new password.</div>`; return; }
    if (nw.length < 6) { errBox.innerHTML = `<div class="err">New password must be at least 6 characters.</div>`; return; }
    if (nw !== cf) { errBox.innerHTML = `<div class="err">New passwords don't match.</div>`; return; }
    try { await api(endpoint, "POST", { currentPassword: cur, newPassword: nw }); overlay.remove(); toast("Password updated."); }
    catch (e) { errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  setTimeout(() => modal.querySelector("#cpcur")?.focus(), 50);
}

// Self-service "change PIN" for carers.
function openChangePin() {
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:420px">
      <div class="modal-h"><div><h2>Change PIN</h2><p>Choose a new 4-digit login PIN</p></div><button class="x" id="close">✕</button></div>
      <div style="padding:18px 22px 22px">
        <div id="cperr"></div>
        <div class="fg"><label>Current PIN</label><input class="inp" id="cpcur" type="password" maxlength="4" inputmode="numeric" placeholder="••••"></div>
        <div class="fg"><label>New PIN</label><input class="inp" id="cpnew" type="password" maxlength="4" inputmode="numeric" placeholder="4 digits"></div>
        <div class="fg"><label>Confirm new PIN</label><input class="inp" id="cpconf" type="password" maxlength="4" inputmode="numeric" placeholder="Re-enter new PIN"></div>
        <button class="btn-auth" id="cpsave">Update PIN</button>
      </div>
    </div>`);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();
  modal.querySelector("#cpsave").onclick = async () => {
    const errBox = modal.querySelector("#cperr"); errBox.innerHTML = "";
    const cur = val("cpcur"), nw = val("cpnew"), cf = val("cpconf");
    if (!/^\d{4}$/.test(nw)) { errBox.innerHTML = `<div class="err">Your new PIN must be 4 digits.</div>`; return; }
    if (nw !== cf) { errBox.innerHTML = `<div class="err">New PINs don't match.</div>`; return; }
    try { await api("/staff/change-pin", "POST", { currentPin: cur, newPin: nw }); overlay.remove(); toast("PIN updated."); }
    catch (e) { errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  setTimeout(() => modal.querySelector("#cpcur")?.focus(), 50);
}

function openAdminCredits(orgId, currentBalance, onChange) {
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:460px">
      <div class="modal-h"><div><h2>Add credits</h2><p>Top up this company's course-credit balance</p></div><button class="x" id="close">✕</button></div>
      <div style="padding:18px 22px 22px">
        <div style="background:#1E3A5F10;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:14px;color:#586473">Current balance: <b style="color:#1E3A5F;font-size:18px">${currentBalance}</b> credits</div>
        <div id="acerr"></div>
        <div class="fg"><label>Credits to add</label><input class="inp" id="acamt" type="number" inputmode="numeric" placeholder="e.g. 50"></div>
        <div class="fg"><label>Note (optional)</label><input class="inp" id="acnote" placeholder="e.g. Invoice #1024 paid"></div>
        <button class="btn-auth" id="acadd" style="background:#1E3A5F">Add credits</button>
        <p class="fb-note">Enter a negative number to make a correction. Every change is recorded.</p>
      </div>
    </div>`);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();
  modal.querySelector("#acadd").onclick = async () => {
    const amount = parseInt(val("acamt"), 10);
    const errBox = modal.querySelector("#acerr"); errBox.innerHTML = "";
    if (!Number.isFinite(amount) || amount === 0) { errBox.innerHTML = `<div class="err">Enter a non-zero whole number.</div>`; return; }
    try {
      const r = await api(`/admin/orgs/${orgId}/credits`, "POST", { amount, note: val("acnote") });
      toast(`Balance updated to ${r.credits} credits.`);
      overlay.remove(); onChange && onChange();
    } catch (e) { errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  setTimeout(() => modal.querySelector("#acamt")?.focus(), 50);
}

function openAdminNewCompany(onCreated) {
  const genPw = () => Math.random().toString(36).slice(2, 6) + "-" + Math.random().toString(36).slice(2, 6);
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:520px">
      <div class="modal-h"><div><h2>New Company</h2><p>Create an organisation account on Care2Learn</p></div><button class="x" id="close">✕</button></div>
      <div style="padding:18px 22px 22px">
        <div id="ncerr"></div>
        <div class="fg"><label>Company name *</label><input class="inp" id="ncname" placeholder="Sunrise Care Ltd"></div>
        <div class="fg"><label>Login email *</label><input class="inp" id="ncemail" type="email" placeholder="manager@sunrisecare.co.uk"></div>
        <div class="fg"><label>Temporary password *</label>
          <div style="display:flex;gap:8px">
            <input class="inp" id="ncpw" placeholder="At least 6 characters" style="flex:1">
            <button class="mini-btn" id="ncgen" type="button">Generate</button>
          </div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <div class="fg" style="flex:1;min-width:140px"><label>Phone</label><input class="inp" id="ncphone" placeholder="Optional"></div>
          <div class="fg" style="flex:1;min-width:140px"><label>CQC number</label><input class="inp" id="nccqc" placeholder="Optional"></div>
        </div>
        <div class="fg"><label>Address</label><input class="inp" id="ncaddr" placeholder="Optional"></div>
        <div class="fg"><label>Opening course credits</label><input class="inp" id="nccredits" type="number" inputmode="numeric" placeholder="0"></div>
        <button class="btn-auth" id="nccreate" style="background:#1E3A5F">Create company</button>
        <p class="fb-note">You'll see the login details next so you can share them with the company.</p>
      </div>
    </div>`);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();
  modal.querySelector("#ncgen").onclick = () => { modal.querySelector("#ncpw").value = genPw(); };
  modal.querySelector("#nccreate").onclick = async () => {
    const name = val("ncname"), email = val("ncemail"), password = val("ncpw");
    const errBox = modal.querySelector("#ncerr"); errBox.innerHTML = "";
    if (!name || !email || !password) { errBox.innerHTML = `<div class="err">Name, email and password are required.</div>`; return; }
    if (password.length < 6) { errBox.innerHTML = `<div class="err">Password must be at least 6 characters.</div>`; return; }
    const payload = { name, email, password, phone: val("ncphone"), address: val("ncaddr"), cqcNumber: val("nccqc") };
    const credits = parseInt(val("nccredits"), 10); if (Number.isFinite(credits) && credits > 0) payload.credits = credits;
    let r; try { r = await api("/admin/orgs", "POST", payload); } catch (e) { errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    modal.innerHTML = `<div style="padding:34px 28px;text-align:center">
      <div style="font-size:50px;margin-bottom:8px">🎉</div>
      <h2 style="font-size:20px;font-weight:800;margin-bottom:10px">${esc(name)} created</h2>
      <div style="background:#F6F8FB;border-radius:12px;padding:16px;text-align:left;font-size:14px;max-width:360px;margin:0 auto 18px">
        <div style="margin-bottom:6px"><b>Login email:</b> ${esc(email)}</div>
        <div><b>Password:</b> ${esc(password)}</div>
      </div>
      <p style="color:#8E99A8;font-size:13px;max-width:340px;margin:0 auto 18px">Share these with the company. They can change the password after logging in.</p>
      <button class="btn-auth" id="ncdone" style="max-width:200px;margin:0 auto;background:#1E3A5F">Done</button></div>`;
    modal.querySelector("#ncdone").onclick = () => { overlay.remove(); onCreated && onCreated(); };
  };
  setTimeout(() => modal.querySelector("#ncname")?.focus(), 50);
}

function openAdminNewIndividual(onCreated) {
  const genPw = () => Math.random().toString(36).slice(2, 6) + "-" + Math.random().toString(36).slice(2, 6);
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:480px">
      <div class="modal-h"><div><h2>New self-employed carer</h2><p>Create an individual carer account on Care2Learn</p></div><button class="x" id="close">✕</button></div>
      <div style="padding:18px 22px 22px">
        <div id="nierr"></div>
        <div class="fg"><label>Carer's full name *</label><input class="inp" id="niname" placeholder="Jordan Smith"></div>
        <div class="fg"><label>Login email *</label><input class="inp" id="niemail" type="email" placeholder="jordan@email.com"></div>
        <div class="fg"><label>Temporary password *</label>
          <div style="display:flex;gap:8px">
            <input class="inp" id="nipw" placeholder="At least 6 characters" style="flex:1">
            <button class="mini-btn" id="nigen" type="button">Generate</button>
          </div>
        </div>
        <div class="fg"><label>Opening course credits</label><input class="inp" id="nicredits" type="number" inputmode="numeric" placeholder="0"></div>
        <button class="btn-auth" id="nicreate" style="background:#1E3A5F">Create carer</button>
        <p class="fb-note">You'll see the login details next so you can share them with the carer.</p>
      </div>
    </div>`);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();
  modal.querySelector("#nigen").onclick = () => { modal.querySelector("#nipw").value = genPw(); };
  modal.querySelector("#nicreate").onclick = async () => {
    const name = val("niname"), email = val("niemail"), password = val("nipw");
    const errBox = modal.querySelector("#nierr"); errBox.innerHTML = "";
    if (!name || !email || !password) { errBox.innerHTML = `<div class="err">Name, email and password are required.</div>`; return; }
    if (password.length < 6) { errBox.innerHTML = `<div class="err">Password must be at least 6 characters.</div>`; return; }
    const payload = { name, email, password };
    const credits = parseInt(val("nicredits"), 10); if (Number.isFinite(credits) && credits > 0) payload.credits = credits;
    let r; try { r = await api("/admin/individuals", "POST", payload); } catch (e) { errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    modal.innerHTML = `<div style="padding:34px 28px;text-align:center">
      <div style="font-size:50px;margin-bottom:8px">🎉</div>
      <h2 style="font-size:20px;font-weight:800;margin-bottom:10px">${esc(name)} created</h2>
      <div style="background:#F6F8FB;border-radius:12px;padding:16px;text-align:left;font-size:14px;max-width:360px;margin:0 auto 18px">
        <div style="margin-bottom:6px"><b>Login email:</b> ${esc(email)}</div>
        <div><b>Password:</b> ${esc(password)}</div>
      </div>
      <p style="color:#8E99A8;font-size:13px;max-width:360px;margin:0 auto 18px">Share these with the carer. On the home page they tap “Register as an individual” → “Already registered? Log in”, then sign in and can change their password.</p>
      <button class="btn-auth" id="nidone" style="max-width:200px;margin:0 auto;background:#1E3A5F">Done</button></div>`;
    modal.querySelector("#nidone").onclick = () => { overlay.remove(); onCreated && onCreated(); };
  };
  setTimeout(() => modal.querySelector("#niname")?.focus(), 50);
}

function openAdminStaffModal(orgId, staff, onChange) {
  const assignedIds = staff.enrolments.map(e => e.courseId);
  const available = state.courses.filter(c => !assignedIds.includes(c.id));
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal">
      <div class="modal-h">
        <div><h2>${esc(staff.name)}</h2><p>${esc(staff.role)} · PIN ${esc(staff.pin)} · ${esc(staff.email)}</p></div>
        <button class="x" id="close">✕</button>
      </div>
      <div style="padding:14px 22px"><span class="pill" style="background:${staff.active ? "#1FA46318" : "#94A3B818"};color:${staff.active ? "#15803D" : "#64748B"}">${staff.active ? "Active licence" : "Inactive licence"}</span>
        <button class="mini-btn" id="toggle" style="margin-left:8px">${staff.active ? "Deactivate" : "Reactivate"}</button></div>
      <div style="padding:0 22px 8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span class="pin-chip">PIN <b id="apinval">${esc(staff.pin)}</b></span>
        <button class="mini-btn" id="aresetpin">🔑 Reset PIN</button>
        <button class="mini-btn" id="aremindpin">✉️ Email reminder</button>
      </div>
      <div style="padding:6px 22px 4px;border-top:1px solid #F4F7FA"><b style="font-size:15px">Assigned Courses (${staff.enrolments.length})</b></div>
      <div id="assigned" style="padding:0 22px"></div>
      <div style="padding:14px 22px 6px;border-top:1px solid #F4F7FA;margin-top:8px"><b style="font-size:15px">Assign a Course</b></div>
      <div style="padding:0 22px 20px" id="assign-slot"></div>
    </div>`);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();

  modal.querySelector("#aremindpin").onclick = () => pinReminderMailto(staff.name, staff.email, staff.pin, c2lAdminOrgName);
  modal.querySelector("#aresetpin").onclick = async () => {
    if (!confirm(`Reset ${staff.name}'s PIN? Their current PIN will stop working immediately.`)) return;
    let r; try { r = await api(`/admin/orgs/${orgId}/staff/${staff.id}/reset-pin`, "POST"); } catch (e) { toast(e.message); return; }
    staff.pin = r.pin;
    const pv = modal.querySelector("#apinval"); if (pv) pv.textContent = r.pin;
    toast(`New PIN for ${staff.name}: ${r.pin}`);
    if (confirm(`New PIN is ${r.pin}. Email it to ${staff.name} now?`)) pinReminderMailto(staff.name, staff.email, r.pin, c2lAdminOrgName);
  };

  const assignedBox = modal.querySelector("#assigned");
  if (!staff.enrolments.length) assignedBox.appendChild(el(`<div style="color:#94A3B8;font-size:13px;padding:8px 0">No courses assigned yet.</div>`));
  staff.enrolments.forEach(e => {
    const status = e.compliance === "valid" ? "✓ Complete" : e.compliance === "expiring" ? "Expiring" : e.compliance === "expired" ? "Expired" : e.compliance === "failed" ? "Failed" : e.progress ? e.progress + "%" : "Not started";
    const row = el(`<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #F4F6F8">
      <span style="flex:1;font-size:14px;color:#1E3A5F">${esc(e.courseTitle)}</span>
      <span class="pill" style="background:#EEF2F6;color:#586473;font-size:11px">${status}</span>
      <button class="mini-btn danger">Remove</button></div>`);
    row.querySelector("button").onclick = async () => {
      await api(`/admin/orgs/${orgId}/staff/${staff.id}/enrol/${e.courseId}`, "DELETE").catch(() => {});
      toast(`Removed ${e.courseTitle}.`); overlay.remove(); onChange && onChange();
    };
    assignedBox.appendChild(row);
  });

  const slot = modal.querySelector("#assign-slot");
  if (!available.length) slot.appendChild(el(`<div style="color:#94A3B8;font-size:13px">All courses are already assigned.</div>`));
  else {
    const grid = el(`<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px"></div>`);
    available.forEach(c => {
      const b = el(`<button class="mini-btn" style="border-color:${c.color};color:${c.color}">+ ${esc(c.title)}</button>`);
      b.onclick = async () => {
        await api(`/admin/orgs/${orgId}/staff/${staff.id}/enrol`, "POST", { courseId: c.id }).catch(() => {});
        toast(`Assigned ${c.title}.`); overlay.remove(); onChange && onChange();
      };
      grid.appendChild(b);
    });
    slot.appendChild(grid);
  }

  modal.querySelector("#toggle").onclick = async () => {
    await api(`/admin/orgs/${orgId}/staff/${staff.id}`, "PATCH", { active: !staff.active }).catch(() => {});
    toast(staff.active ? "Licence deactivated." : "Licence reactivated."); overlay.remove(); onChange && onChange();
  };
}

// ─── SELF-EMPLOYED INDIVIDUAL: register / login / portal ──────────────────────
function renderIndividualRegister() {
  App.innerHTML = "";
  App.appendChild(el(`
    <div class="auth-page"><div class="auth-card">
      <button class="back-sm" id="back">← Back</button>
      <div class="auth-logo" style="display:flex;align-items:center;gap:8px">${logoMark(22, true)}<span>Care2Learn</span></div>
      <div class="auth-title">Register as an individual</div>
      <div class="auth-sub">For self-employed carers. Buy credits, take your mandatory courses and re-validate each year — then download your certificates.</div>
      <div id="err"></div>
      <div class="fg"><label>Your Name</label><input class="inp" id="name" placeholder="Jane Smith"></div>
      <div class="fg"><label>Email Address</label><input class="inp" id="email" type="email" placeholder="you@email.com"></div>
      <div class="fg"><label>Password</label><input class="inp" id="pw" type="password" placeholder="At least 6 characters"></div>
      <div class="fg"><label>Referral code <span style="color:#9AA5B1;font-weight:400">(optional)</span></label><input class="inp" id="refcode" placeholder="e.g. K7Q2MP" style="text-transform:uppercase"></div>
      <button class="btn-auth" id="submit">Create my account</button>
      <div class="auth-alt">Already registered? <button class="linkbtn" id="tologin">Log in</button></div>
    </div></div>
  `));
  document.getElementById("back").onclick = renderLanding;
  if (referralFromUrl) document.getElementById("refcode").value = referralFromUrl;
  document.getElementById("tologin").onclick = renderIndividualLogin;
  document.getElementById("submit").onclick = doIndividualRegister;
}
async function doIndividualRegister() {
  const errBox = document.getElementById("err"); if (errBox) errBox.innerHTML = "";
  const name = val("name"), email = val("email"), password = val("pw"), referralCode = val("refcode");
  if (!name || !email || !password) { if (errBox) errBox.innerHTML = `<div class="err">Name, email and password are required.</div>`; return; }
  if (password.length < 6) { if (errBox) errBox.innerHTML = `<div class="err">Password must be at least 6 characters.</div>`; return; }
  try {
    const { token } = await api("/individual/register", "POST", { name, email, password, referralCode });
    setAuth(token, "individual");
    await renderIndividualPortal();
  } catch (e) { if (errBox) errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

function renderIndividualLogin() {
  App.innerHTML = "";
  App.appendChild(el(`
    <div class="auth-page"><div class="auth-card">
      <button class="back-sm" id="back">← Back</button>
      <div class="auth-logo" style="display:flex;align-items:center;gap:8px">${logoMark(22, true)}<span>Care2Learn</span></div>
      <div class="auth-title">Self-employed carer login</div>
      <div class="auth-sub">Log in with the email and password you registered with.</div>
      <div id="err"></div>
      <div class="fg"><label>Email Address</label><input class="inp" id="email" type="email" placeholder="you@email.com"></div>
      <div class="fg"><label>Password</label><input class="inp" id="pw" type="password" placeholder="Your password"></div>
      <button class="btn-auth" id="submit">Sign In</button>
      <div class="auth-alt">New here? <button class="linkbtn" id="toreg">Register as an individual</button></div>
      <div class="auth-alt"><button class="linkbtn" id="forgot">Forgot your password?</button></div>
    </div></div>
  `));
  document.getElementById("back").onclick = renderLanding;
  document.getElementById("toreg").onclick = renderIndividualRegister;
  document.getElementById("submit").onclick = doIndividualLogin;
  document.getElementById("forgot").onclick = () => renderForgotPassword(renderIndividualLogin);
}
async function doIndividualLogin() {
  const errBox = document.getElementById("err"); if (errBox) errBox.innerHTML = "";
  try {
    const { token } = await api("/individual/login", "POST", { email: val("email"), password: val("pw") });
    setAuth(token, "individual");
    await renderIndividualPortal();
  } catch (e) { if (errBox) errBox.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

async function renderIndividualPortal() {
  learnerReturn = renderIndividualPortal;
  let me;
  try { me = await api("/individual/me"); } catch (e) { clearAuth(); return renderLanding(); }
  const enrolments = me.enrolments;
  const credits = me.org.credits || 0;
  const valid = enrolments.filter(e => e.compliance === "valid" || e.compliance === "expiring").length;
  App.innerHTML = "";
  App.appendChild(el(`
    <div>
      <div class="dash-hdr">
        <div class="dash-brand"><span class="dash-logo">👤</span><div><div class="dash-org">${esc(me.staff.name)}</div><div class="dash-sub">Self-employed carer · Care2Learn</div></div></div>
        <div class="dash-actions">
          <button class="feedback-btn" id="feedback">💬 Feedback</button>
          <button class="logout" id="logout">Log Out</button>
        </div>
      </div>
      <div class="body" id="ibody"></div>
    </div>
  `));
  document.getElementById("logout").onclick = async () => { await api("/logout","POST").catch(()=>{}); clearAuth(); renderLanding(); };
  document.getElementById("feedback").onclick = () => openFeedbackModal("Individual portal");
  const body = document.getElementById("ibody");

  const creditCard = el(`
    <div class="ind-credits">
      <div>
        <div class="ind-credits-l">Course credits</div>
        <div class="ind-credits-n">${credits}</div>
        <div class="ind-credits-sub">1 credit = 1 course · credits never expire</div>
      </div>
      <button class="btn-buy" id="buy">＋ Buy credits</button>
    </div>`);
  body.appendChild(creditCard);
  creditCard.querySelector("#buy").onclick = () => openBuyCredits();

  body.appendChild(el(`<div class="ind-row"><h2 style="margin:0">My courses</h2><button class="mini-btn" id="addcourse">＋ Add a course</button></div>`));
  body.querySelector("#addcourse").onclick = () => openAddIndividualCourse(me, credits);

  if (!enrolments.length) {
    body.appendChild(el(`<div class="empty" style="background:#fff;border-radius:12px">You haven't added any courses yet. Buy a credit, then tap “Add a course” to begin your training.</div>`));
  } else {
    body.appendChild(el(`<div class="obar-wrap"><div class="obar-l"><span>Overall Progress</span><span>${Math.round((valid/enrolments.length)*100)}%</span></div><div class="obar"><div class="obar-f" style="width:${(valid/enrolments.length)*100}%"></div></div></div>`));
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
          <div class="sc-top" style="background:${c.color||"#1E3A5F"}"><span style="font-size:32px">${c.icon||"📘"}</span>${badge}</div>
          <div class="sc-body">
            <div style="font-size:10px;font-weight:700;color:#1E3A5F;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Mandatory</div>
            <div class="sc-title">${esc(e.courseTitle)}</div>
            <div class="sc-meta">⏱ ${c.duration||""} · ${c.modules ? c.modules.length + " modules" : (c.quiz||[]).length + " questions"}</div>
            ${e.compliance==="in_progress" ? `<div class="obar-mini" style="margin-bottom:11px"><div class="obar-mini-f" style="width:${e.progress}%;background:${c.color}"></div></div>` : ""}
            ${(e.compliance==="valid"||e.compliance==="expiring")
              ? `<div class="sc-done"><div class="sc-score" style="color:${c.color||"#1E3A5F"}">${e.score}%</div><div class="sc-exp">Expires ${fmtDate(e.expiryDate)}</div></div>`
              : `<button class="sc-cta" style="background:${c.color||"#1E3A5F"}">${cta}</button>`}
          </div>
        </div>`);
      card.onclick = () => (c.modules ? openCareCertificate(e.courseId, me) : openCoursePlayer(e.courseId, me));
      grid.appendChild(card);
    });
    body.appendChild(grid);
  }

  const certs = enrolments.filter(e => e.certId && (e.compliance==="valid"||e.compliance==="expiring"||e.compliance==="expired"));
  if (certs.length) {
    body.appendChild(el(`<h2 style="margin:26px 0 14px">My certificates</h2>`));
    const cgrid = el(`<div class="sc-grid"></div>`);
    certs.forEach(e => {
      const c = state.courses.find(x => x.id === e.courseId) || {};
      const item = el(`
        <div class="sc" style="cursor:pointer">
          <div class="sc-top" style="background:${c.color||"#1E3A5F"}"><span style="font-size:32px">🏆</span></div>
          <div class="sc-body">
            <div class="sc-title">${esc(e.courseTitle)}</div>
            <div class="sc-meta">Passed ${e.score}% · expires ${fmtDate(e.expiryDate)}</div>
            <button class="sc-cta" style="background:${c.color||"#1E3A5F"}">View certificate →</button>
          </div>
        </div>`);
      item.onclick = () => printCertificate(e, me);
      cgrid.appendChild(item);
    });
    body.appendChild(cgrid);
  }

  body.appendChild(el(`<h2 style="margin:26px 0 14px">🎁 Refer &amp; earn</h2>`));
  body.appendChild(referralCard(me.referral || {}, { audience: "other self-employed carers", singular: "self-employed carer" }));

  body.appendChild(el(`<h2 style="margin:26px 0 12px">Account</h2>`));
  const acct = el(`
    <div class="scard">
      <div class="srow"><label>Name</label><span>${esc(me.staff.name)}</span></div>
      <div class="srow"><label>Email</label><span>${esc(me.staff.email)}</span></div>
      <div style="padding:12px 20px 16px"><button class="mini-btn" id="indchgpw">🔒 Change password</button></div>
    </div>`);
  body.appendChild(acct);
  acct.querySelector("#indchgpw").onclick = () => openChangePassword("/individual/change-password");
}

function openBuyCredits() {
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:440px">
      <div class="modal-h"><div><h2>Buy credits</h2><p>1 credit = 1 course · £${PRICING.paygPerCourse} each</p></div><button class="x" id="close">✕</button></div>
      <div style="padding:18px 22px 22px">
        <div class="fg"><label>How many credits?</label><input class="inp" id="qty" type="number" inputmode="numeric" value="1" min="1"></div>
        <div id="qtysum" style="font-size:14px;color:#586473;margin:-4px 0 14px"></div>
        <button class="btn-auth" id="checkout">Continue to secure payment</button>
        <p class="fb-note">You'll be taken to our secure Stripe checkout. Credits are added to your account once payment is confirmed.</p>
      </div>
    </div>`);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();
  const sum = modal.querySelector("#qtysum");
  const upd = () => { const n = Math.max(1, parseInt(val("qty")||"1",10)||1); sum.textContent = `${n} credit${n>1?"s":""} · £${n*PRICING.paygPerCourse} total`; };
  modal.querySelector("#qty").oninput = upd; upd();
  modal.querySelector("#checkout").onclick = () => {
    const n = Math.max(1, parseInt(val("qty")||"1",10)||1);
    overlay.remove();
    startPaygCheckout(1, n); // 1 learner × n courses = n credits
  };
}

async function openAddIndividualCourse(me, credits) {
  const taken = me.enrolments.map(e => e.courseId);
  const available = state.courses.filter(c => !taken.includes(c.id));
  const overlay = el(`<div class="overlay"></div>`);
  const modal = el(`
    <div class="modal" style="max-width:540px">
      <div class="modal-h"><div><h2>Add a course</h2><p>You have <b>${credits}</b> credit${credits===1?"":"s"} · each course uses 1 credit</p></div><button class="x" id="close">✕</button></div>
      <div id="addlist" style="padding:8px 14px 18px;max-height:60vh;overflow:auto"></div>
    </div>`);
  overlay.appendChild(modal); document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  modal.querySelector("#close").onclick = () => overlay.remove();
  const list = modal.querySelector("#addlist");
  if (!available.length) { list.appendChild(el(`<div style="padding:14px;color:#8E99A8">You've already added every available course.</div>`)); return; }
  available.forEach(c => {
    const row = el(`
      <div class="addrow">
        <div class="addrow-ic" style="background:${c.color||"#1E3A5F"}">${c.icon||"📘"}</div>
        <div style="flex:1;min-width:0"><div class="addrow-t">${esc(c.title)}</div><div class="addrow-m">⏱ ${c.duration||""} · ${c.modules ? c.modules.length+" modules" : (c.quiz||[]).length+" questions"}</div></div>
        <button class="mini-btn">Add</button>
      </div>`);
    row.querySelector("button").onclick = async () => {
      try {
        await api("/individual/enrol", "POST", { courseId: c.id });
        overlay.remove();
        toast(`“${c.title}” added.`);
        renderIndividualPortal();
      } catch (e) {
        if (/credit/i.test(e.message)) {
          overlay.remove();
          if (confirm(`${e.message}\n\nBuy credits now?`)) openBuyCredits();
        } else { toast(e.message); }
      }
    };
    list.appendChild(row);
  });
}

async function renderStaffPortal() {
  learnerReturn = renderStaffPortal;
  const me = await api("/staff/me");
  App.innerHTML = "";
  App.appendChild(el(`
    <div>
      <div class="dash-hdr">
        <div class="dash-brand"><span class="dash-logo">👤</span><div><div class="dash-org">${esc(me.staff.name)}</div><div class="dash-sub">${esc(me.staff.role)} · ${esc(me.org.name)}</div></div></div>
        <nav class="dash-nav" id="snav"></nav>
        <div class="dash-actions">
          <button class="feedback-btn" id="feedback">💬 Feedback</button>
          <button class="logout" id="logout">Log Out</button>
        </div>
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
  if (me.notifications && me.notifications.length) showStaffNotifications(me.notifications);
}

function showStaffNotifications(list) {
  const sbody = document.getElementById("sbody");
  if (!sbody || !list || !list.length) return;
  const hasNudge = list.some(n => n.type === "nudge");
  const rows = list.map(n =>
    `<div style="margin-top:2px"><span style="font-weight:700">${esc(n.title)}</span>${n.body ? ` — <span>${esc(n.body)}</span>` : ""}</div>`
  ).join("");
  const ids = list.map(n => n.id);

  const wrap = el(`
    <div style="max-width:1200px;margin:18px auto -6px;padding:0 24px">
      <div style="display:flex;align-items:flex-start;gap:12px;background:#FEF6E7;border:1px solid #EBC76E;border-left:4px solid #E6A817;border-radius:10px;padding:13px 16px;color:#5A4A1A">
        <div style="font-size:20px;line-height:1.3">📣</div>
        <div style="flex:1;font-size:14px;line-height:1.5">${rows}</div>
        ${hasNudge ? `<button id="nb-view" class="mini-btn" style="white-space:nowrap">View my courses</button>` : ""}
        <button id="nb-close" aria-label="Dismiss" style="background:none;border:none;font-size:18px;color:#9A8A5A;cursor:pointer;line-height:1;padding:0 2px">✕</button>
      </div>
    </div>
  `);
  sbody.parentNode.insertBefore(wrap, sbody);

  let marked = false;
  const markRead = () => { if (marked) return; marked = true; api("/staff/notifications/read", "POST", { ids }).catch(() => {}); };
  const closeBtn = wrap.querySelector("#nb-close");
  if (closeBtn) closeBtn.onclick = () => { markRead(); wrap.remove(); };
  const viewBtn = wrap.querySelector("#nb-view");
  if (viewBtn) viewBtn.onclick = () => { markRead(); wrap.remove(); staffTab = "courses"; paintStaffTab(); };
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
    body.appendChild(el(`<div class="hero"><h1>Welcome back, ${esc(me.staff.name.split(" ")[0])}! 👋</h1><p>You've completed <b style="color:#1FA463">${doneCount} of ${total}</b> assigned course${total===1?"":"s"}.</p></div>`));

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
            <div class="sc-top" style="background:${c.color||"#1E3A5F"}"><span style="font-size:32px">${c.icon||"📘"}</span>${badge}</div>
            <div class="sc-body">
              <div style="font-size:10px;font-weight:700;color:#1E3A5F;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Mandatory</div>
              <div class="sc-title">${esc(e.courseTitle)}</div>
              <div class="sc-meta">⏱ ${c.duration||""} · ${c.modules ? c.modules.length + " modules" : (c.quiz||[]).length + " questions"}${e.dueDate?` · due ${fmtDate(e.dueDate)}`:""}</div>
              ${e.compliance==="in_progress" ? `<div class="obar-mini" style="margin-bottom:11px"><div class="obar-mini-f" style="width:${e.progress}%;background:${c.color}"></div></div>` : ""}
              ${(e.compliance==="valid"||e.compliance==="expiring")
                ? `<div class="sc-done"><div class="sc-score" style="color:${c.color||"#1E3A5F"}">${e.score}%</div><div class="sc-exp">Expires ${fmtDate(e.expiryDate)}</div></div>`
                : `<button class="sc-cta" style="background:${c.color||"#1E3A5F"}">${cta}</button>`}
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
      <div>
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
        <div class="srow"><label>Courses Completed</label><span style="color:#1FA463;font-weight:700">${doneCount} / ${total}</span></div>
        <div class="srow"><label>Compliance</label><span class="pill ${doneCount===total&&total>0?"green":"amber"}">${doneCount===total&&total>0?"✓ Fully Compliant":"In Progress"}</span></div>
      </div>
      <div class="scard" style="margin-top:16px"><h3>Security</h3><div style="padding:0 20px 16px"><p style="font-size:13px;color:#586473;margin-bottom:10px">Change the 4-digit PIN you use to sign in.</p><button class="mini-btn" id="chgpin">🔒 Change PIN</button></div></div>
      </div>
    `));
    document.getElementById("chgpin").onclick = () => openChangePin();
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
    return `<div class="vcompare">${col(d.left, c)}${col(d.right, "#586473")}</div>`;
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
      document.getElementById("pback").onclick = () => learnerReturn();
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
      else { const b = el(`<button class="btn-out" style="border-color:#BDC3C7;color:#8E99A8">← Overview</button>`); b.onclick = () => { stage = "intro"; render(); }; nav.appendChild(b); }
      nav.appendChild(el(`<div style="flex:1"></div>`));
      if (slideIdx < course.slides.length-1) { const b = el(`<button class="btn-go" style="background:${course.color}">Next →</button>`); b.onclick = async () => { slideIdx++; await saveProgress(); render(); }; nav.appendChild(b); }
      else { const b = el(`<button class="btn-go" style="background:${course.color}">📝 Start Assessment</button>`); b.onclick = async () => { inQuiz = true; await saveProgress(100); render(); }; nav.appendChild(b); }
      pbody.appendChild(nav);
      wrap.appendChild(pbody);
    } else {
      wrap.appendChild(renderQuiz(course, me, () => { openCoursePlayer(courseId, me, { stage: "slides" }); }));
    }

    App.appendChild(wrap);
    document.getElementById("pback").onclick = () => learnerReturn();
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
          <span class="cc-num" style="background:${isDone ? course.color : "#E0E6ED"};color:${isDone ? "#fff" : "#586473"}">${isDone ? "✓" : i + 1}</span>
          <span class="cc-mod-body"><span class="cc-mod-title">${esc(m.title)}</span><span class="cc-mod-sum">${esc(m.summary || "")}</span></span>
          <span class="cc-mod-cta" style="color:${course.color}">${isDone ? "Review" : "Start"} →</span>
        </button>`);
      item.onclick = () => openModule(i);
      list.appendChild(item);
    });
    menu.appendChild(list);
    wrap.appendChild(menu);
    App.appendChild(wrap);
    document.getElementById("pback").onclick = () => learnerReturn();
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
        else { const b = el(`<button class="btn-out" style="border-color:#BDC3C7;color:#8E99A8">← Modules</button>`); b.onclick = () => renderMenu(); nav.appendChild(b); }
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
    inner.appendChild(el(`<div class="qmeta"><span style="color:${course.color};font-weight:700">Question ${cur + 1} of ${quiz.length}</span><span style="color:#8E99A8">Pass: ${passNeed} of ${quiz.length}</span></div>`));
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
      inner.appendChild(el(`<div class="qexp" style="border-left:3px solid ${course.color}"><b style="color:${selected === q.answer ? course.color : "#E5484D"}">${selected === q.answer ? "✓ Correct!" : "✗ Incorrect"}</b><p>${esc(q.explanation || "")}</p></div>`));
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
      <h2 style="color:${passed ? course.color : "#E0902E"};margin-bottom:6px">${passed ? "Module complete!" : "Not quite there"}</h2>
      <p style="color:#586473;margin-bottom:4px">You scored ${correct} of ${quiz.length} (${score}%).</p>
      <p style="color:#8E99A8;font-size:13px;margin-bottom:20px">${passed ? "This module is now ticked off." : `You need ${passNeed} of ${quiz.length} to pass.`}</p>
    </div>`);
    const btn = el(`<button class="qnext" style="background:${passed ? course.color : "#E0902E"};max-width:320px;margin:0 auto">${passed ? "Back to modules →" : "Try again"}</button>`);
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
    inner.appendChild(el(`<div class="qmeta"><span style="color:${course.color};font-weight:700">Question ${cur+1} of ${quiz.length}</span><span style="color:#8E99A8">Score: ${correct}</span></div>`));
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
      inner.appendChild(el(`<div class="qexp" style="border-left:3px solid ${course.color}"><b style="color:${selected===q.answer?course.color:"#E5484D"}">${selected===q.answer?"✓ Correct!":"✗ Incorrect"}</b><p>${esc(q.explanation)}</p></div>`));
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
        <h2 style="color:${passed?course.color:"#E5484D"};margin-bottom:8px">${passed?"Competency Confirmed!":"Additional Study Required"}</h2>
        <div class="qscore-box" style="border-color:${passed?course.color:"#E5484D"}"><span class="qbig" style="color:${passed?course.color:"#E5484D"}">${score}%</span><span style="color:#8E99A8;font-size:14px">${results.filter(Boolean).length} of ${quiz.length} correct</span></div>
        <p style="color:#586473;font-size:14px;line-height:1.7;max-width:400px;margin:0 auto">${passed?"You have demonstrated competency. Your certificate has been issued and your progress saved — your manager can now see this course as complete.":"You scored below the 70% pass mark. Review the course sections and try the assessment again."}</p>
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
      bb.onclick = () => learnerReturn();
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
  const color = c.color || "#1E3A5F";
  const doc =
'<!DOCTYPE html><html><head><meta charset="utf-8">' +
'<title>Certificate — ' + esc(enr.courseTitle) + ' — ' + esc(me.staff.name) + '</title>' +
'<style>' +
'@page{size:A4 portrait;margin:14mm;}' +
'*{box-sizing:border-box;margin:0;padding:0;}' +
'body{font-family:"Segoe UI",system-ui,sans-serif;color:#1E3A5F;padding:10px;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
'.sheet{border:3px solid ' + color + ';border-radius:14px;overflow:hidden;max-width:760px;margin:0 auto;}' +
'.top{background:' + color + ';color:#fff;padding:24px 32px;display:flex;justify-content:space-between;align-items:center;}' +
'.brand{font-size:22px;font-weight:900;display:flex;align-items:center;gap:8px;}' +
'.badge{font-size:12px;opacity:.85;letter-spacing:1px;}' +
'.bodyc{padding:40px 40px 30px;text-align:center;}' +
'.icon{font-size:64px;margin-bottom:10px;}' +
'.sm{font-size:14px;color:#8E99A8;margin:6px 0;}' +
'.name{font-size:34px;font-weight:900;margin:6px 0;}' +
'.course{font-size:24px;font-weight:800;color:' + color + ';margin:6px 0;}' +
'.meta{display:flex;justify-content:center;gap:38px;margin:28px 0 18px;flex-wrap:wrap;}' +
'.ml{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#8E99A8;font-weight:700;}' +
'.mv{font-size:16px;font-weight:800;margin-top:3px;}' +
'.strip{margin-top:6px;padding:14px;background:' + color + '14;border-radius:8px;display:flex;justify-content:space-between;font-size:12px;color:#586473;}' +
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
    case "valid":       return { label: "Valid",         fg: "#15803D", bg: "#1FA4631A" };
    case "expiring":    return { label: "Expiring soon", fg: "#9A6700", bg: "#E0902E1A" };
    case "expired":     return { label: "Expired",       fg: "#B91C1C", bg: "#E5484D1A" };
    case "in_progress": return { label: "In progress",   fg: "#1D4E89", bg: "#1E3A5F1A" };
    case "failed":      return { label: "Failed",        fg: "#B91C1C", bg: "#E5484D1A" };
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
      ? '<span class="badge" style="color:#15803D;background:#1FA4631A">Fully compliant</span>'
      : (s.assignedCount === 0
        ? '<span class="badge" style="color:#4B5563;background:#9CA3AF1A">No courses assigned</span>'
        : '<span class="badge" style="color:#9A6700;background:#E0902E1A">Action required</span>');
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
+ 'body{font-family:"Segoe UI",system-ui,sans-serif;color:#1E3A5F;font-size:12px;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}'
+ '.hd{background:#0D1B2A;color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;border-radius:8px;}'
+ '.hd .l{display:flex;align-items:center;gap:11px;}'
+ '.hd .ttl{font-size:18px;font-weight:700;}'
+ '.hd .sub{font-size:11px;color:#9FB0C4;}'
+ '.hd .org{font-size:13px;font-weight:700;text-align:right;}'
+ '.meta{display:flex;justify-content:space-between;margin:14px 2px;font-size:11px;color:#586473;}'
+ '.sumrow{display:flex;gap:10px;margin-bottom:18px;}'
+ '.sum{flex:1;border:1px solid #E5E7EB;border-radius:8px;padding:10px;text-align:center;}'
+ '.sum .n{font-size:22px;font-weight:800;}'
+ '.sum .l{font-size:9px;color:#8E99A8;text-transform:uppercase;letter-spacing:.4px;margin-top:2px;}'
+ '.staff{margin-bottom:14px;page-break-inside:avoid;}'
+ '.staff-h{display:flex;justify-content:space-between;align-items:center;background:#F4F7FA;padding:8px 12px;border-radius:6px;margin-bottom:6px;}'
+ '.staff-name{font-weight:700;font-size:13px;}'
+ '.staff-role{color:#8E99A8;font-size:11px;}'
+ 'table{width:100%;border-collapse:collapse;}'
+ 'th{text-align:left;color:#8E99A8;font-weight:600;padding:5px 8px;border-bottom:1px solid #E5E7EB;text-transform:uppercase;font-size:9px;letter-spacing:.3px;}'
+ 'td{padding:6px 8px;border-bottom:1px solid #F4F7FA;font-size:11px;}'
+ '.badge{display:inline-block;padding:2px 9px;border-radius:10px;font-size:10px;font-weight:700;}'
+ '.none{padding:8px 12px;color:#8E99A8;font-style:italic;font-size:11px;}'
+ '.legend{margin-top:6px;font-size:10px;color:#8E99A8;line-height:1.6;}'
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
        <div style="padding:12px;background:${c.color}18;border-radius:8px;display:flex;justify-content:space-between;font-size:11px;color:#586473"><span>Aligned to the Care Certificate 2026</span><span>Pass mark: 70% · Achieved: ${enr.score}%</span></div>
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
