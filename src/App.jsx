import { useState, useEffect, useCallback } from "react";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Fill these in with your real credentials before deploying
const CONFIG = {
  AIRTABLE_API_KEY: "YOUR_AIRTABLE_API_KEY",      // From airtable.com/account
  AIRTABLE_BASE_ID: "YOUR_AIRTABLE_BASE_ID",      // From airtable.com/api
  AIRTABLE_TABLE: "Complaints",
  EMAILJS_SERVICE_ID: "YOUR_EMAILJS_SERVICE_ID",   // From emailjs.com dashboard
  EMAILJS_TEMPLATE_ID: "YOUR_EMAILJS_TEMPLATE_ID",
  EMAILJS_PUBLIC_KEY: "YOUR_EMAILJS_PUBLIC_KEY",
};

// ─── DEMO STAFF USERS ────────────────────────────────────────────────────────
const STAFF_USERS = [
  { id: 1, name: "Admin User", email: "admin@housing.org", password: "admin123", role: "admin" },
  { id: 2, name: "Case Manager", email: "case@housing.org", password: "case123", role: "staff" },
  { id: 3, name: "Housing Officer", email: "officer@housing.org", password: "officer123", role: "staff" },
];

const URGENCY_COLORS = { High: "#ef4444", Medium: "#f59e0b", Low: "#22c55e" };
const STAGES = ["New", "Acknowledged", "Under Review", "Resolved", "Escalated"];
const STAGE_COLORS = {
  New: "#3b82f6", Acknowledged: "#8b5cf6",
  "Under Review": "#f59e0b", Resolved: "#22c55e", Escalated: "#ef4444",
};

function generateId() {
  return "CMP-" + Date.now().toString(36).toUpperCase();
}
function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB");
}
function isOverdue(dueDate, stage) {
  if (stage === "Resolved") return false;
  return new Date(dueDate) < new Date();
}

// ─── AIRTABLE ────────────────────────────────────────────────────────────────
async function saveToAirtable(record) {
  if (!CONFIG.AIRTABLE_API_KEY || CONFIG.AIRTABLE_API_KEY.startsWith("YOUR")) return { skipped: true };
  const fields = {
    "Complaint ID": record.id, "Date": record.date, "Name": record.name,
    "Email": record.email, "Address": record.address, "Complaint Text": record.text,
    "Category": record.category, "Urgency": record.urgency, "Sentiment": record.sentiment,
    "Summary": record.summary, "Stage": record.stage, "Assigned Team": record.assignedTeam,
    "Due Date": record.dueDate, "Draft Acknowledgement": record.acknowledgement,
  };
  const res = await fetch(
    `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    }
  );
  return res.json();
}

async function updateAirtableStage(airtableRecordId, stage) {
  if (!CONFIG.AIRTABLE_API_KEY || CONFIG.AIRTABLE_API_KEY.startsWith("YOUR") || !airtableRecordId) return;
  await fetch(
    `https://api.airtable.com/v0/${CONFIG.AIRTABLE_BASE_ID}/${encodeURIComponent(CONFIG.AIRTABLE_TABLE)}/${airtableRecordId}`,
    {
      method: "PATCH",
      headers: { Authorization: `Bearer ${CONFIG.AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { Stage: stage } }),
    }
  );
}

// ─── EMAILJS ─────────────────────────────────────────────────────────────────
async function sendAcknowledgement(complaint) {
  if (!CONFIG.EMAILJS_PUBLIC_KEY || CONFIG.EMAILJS_PUBLIC_KEY.startsWith("YOUR")) {
    return { skipped: true };
  }
  const payload = {
    service_id: CONFIG.EMAILJS_SERVICE_ID,
    template_id: CONFIG.EMAILJS_TEMPLATE_ID,
    user_id: CONFIG.EMAILJS_PUBLIC_KEY,
    template_params: {
      to_name: complaint.name, to_email: complaint.email,
      complaint_id: complaint.id, category: complaint.category,
      due_date: formatDate(complaint.dueDate), message: complaint.acknowledgement,
    },
  };
  const res = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.ok ? { ok: true } : { error: await res.text() };
}

// ─── CLAUDE AI ───────────────────────────────────────────────────────────────
async function analyseComplaint(text) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: `You are an expert complaints analyst for UK housing associations. Analyse the complaint and return ONLY a valid JSON object with no markdown or preamble:
{
  "category": one of [Repairs, Staff Conduct, Communication Failure, Delay / Missed Service, ASB, Tenancy, Rent, Complaint Handling, Other],
  "urgency": one of [High, Medium, Low],
  "sentiment": one of [Very Angry, Frustrated, Disappointed, Neutral, Confused],
  "summary": "1 sentence plain English summary",
  "acknowledgement": "Warm professional 3-sentence acknowledgement email body, addressing tenant by first name",
  "dueDays": number (7 for High, 14 for Medium, 28 for Low),
  "keyIssues": ["issue1", "issue2", "issue3"]
}`,
      messages: [{ role: "user", content: text }],
    }),
  });
  const data = await response.json();
  const raw = data.content.map(i => i.text || "").join("");
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ─── CSV EXPORT ──────────────────────────────────────────────────────────────
function exportCSV(complaints) {
  const headers = ["ID","Date","Name","Email","Address","Category","Urgency","Sentiment","Stage","Assigned Team","Due Date","Summary","Key Issues"];
  const rows = complaints.map(c => [
    c.id, formatDate(c.date), c.name, c.email, c.address,
    c.category, c.urgency, c.sentiment, c.stage, c.assignedTeam,
    formatDate(c.dueDate), c.summary, (c.keyIssues || []).join("; "),
  ].map(v => `"${(v || "").toString().replace(/"/g, '""')}"`).join(","));
  const csv = [headers.join(","), ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url;
  a.download = `ResolvIQ_Complaints_${new Date().toISOString().split("T")[0]}.csv`;
  a.click(); URL.revokeObjectURL(url);
}

// ─── STYLES ──────────────────────────────────────────────────────────────────
const S = {
  root: { fontFamily: "'DM Serif Display', Georgia, serif", background: "#0c0e14", minHeight: "100vh", color: "#edeae4" },
  // Login
  loginWrap: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "radial-gradient(ellipse at 60% 40%, #1a1f2e 0%, #0c0e14 70%)" },
  loginCard: { background: "#14172030", border: "1px solid #2a2f3e", borderRadius: 20, padding: "48px 40px", width: 380, backdropFilter: "blur(20px)" },
  loginTitle: { fontSize: 28, color: "#c9a96e", marginBottom: 4, textAlign: "center" },
  loginSub: { fontSize: 12, color: "#6b7280", fontFamily: "'DM Sans',sans-serif", textAlign: "center", marginBottom: 32, letterSpacing: "0.1em", textTransform: "uppercase" },
  loginHint: { fontSize: 11, color: "#4b5563", fontFamily: "'DM Sans',sans-serif", marginTop: 20, textAlign: "center", lineHeight: 1.8 },
  // Header
  header: { background: "#14172099", backdropFilter: "blur(20px)", borderBottom: "1px solid #2a2f3e", padding: "16px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 },
  logoMark: { width: 36, height: 36, background: "linear-gradient(135deg,#c9a96e,#a07840)", borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, marginRight: 10 },
  logoText: { fontSize: 18, color: "#c9a96e", fontWeight: "bold", letterSpacing: "-0.5px" },
  logoSub: { fontSize: 10, color: "#6b7280", fontFamily: "'DM Sans',sans-serif", letterSpacing: "0.1em", textTransform: "uppercase" },
  userPill: { display: "flex", alignItems: "center", gap: 10, background: "#1a1f2e", border: "1px solid #2a2f3e", borderRadius: 30, padding: "6px 14px", fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: "#d1cdc8" },
  roleBadge: (role) => ({ background: role === "admin" ? "#c9a96e22" : "#3b82f622", color: role === "admin" ? "#c9a96e" : "#3b82f6", border: `1px solid ${role === "admin" ? "#c9a96e55" : "#3b82f655"}`, borderRadius: 10, padding: "1px 8px", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }),
  // Nav
  nav: { display: "flex", gap: 2, background: "#0c0e14", border: "1px solid #2a2f3e", borderRadius: 10, padding: 3 },
  navBtn: (a) => ({ padding: "7px 16px", borderRadius: 8, border: "none", background: a ? "#c9a96e" : "transparent", color: a ? "#0c0e14" : "#9ca3af", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: a ? 700 : 400, transition: "all 0.15s" }),
  // Layout
  main: { maxWidth: 1140, margin: "0 auto", padding: "28px 20px" },
  card: { background: "#14172080", border: "1px solid #2a2f3e", borderRadius: 16, padding: 26, marginBottom: 20, backdropFilter: "blur(10px)" },
  sectionTitle: { fontSize: 20, color: "#c9a96e", marginBottom: 4, fontWeight: "normal" },
  sectionSub: { fontSize: 12, color: "#6b7280", fontFamily: "'DM Sans',sans-serif", marginBottom: 22, letterSpacing: "0.02em" },
  // Form
  formGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 },
  fg: { display: "flex", flexDirection: "column", gap: 5 },
  label: { fontSize: 11, color: "#6b7280", fontFamily: "'DM Sans',sans-serif", textTransform: "uppercase", letterSpacing: "0.08em" },
  input: { background: "#0c0e1480", border: "1px solid #2a2f3e", borderRadius: 8, padding: "9px 13px", color: "#edeae4", fontFamily: "'DM Sans',sans-serif", fontSize: 13, outline: "none", width: "100%", boxSizing: "border-box" },
  textarea: { background: "#0c0e1480", border: "1px solid #2a2f3e", borderRadius: 8, padding: "9px 13px", color: "#edeae4", fontFamily: "'DM Sans',sans-serif", fontSize: 13, outline: "none", width: "100%", minHeight: 110, resize: "vertical", boxSizing: "border-box" },
  // Buttons
  btn: (variant = "primary", disabled = false) => ({
    padding: "9px 22px", border: "none", borderRadius: 9, cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: "'DM Sans',sans-serif", fontWeight: 600, fontSize: 13, transition: "all 0.15s", opacity: disabled ? 0.6 : 1,
    ...(variant === "primary" ? { background: "linear-gradient(135deg,#c9a96e,#a07840)", color: "#0c0e14" } : {}),
    ...(variant === "ghost" ? { background: "transparent", color: "#9ca3af", border: "1px solid #2a2f3e" } : {}),
    ...(variant === "danger" ? { background: "#ef444420", color: "#ef4444", border: "1px solid #ef444440" } : {}),
    ...(variant === "success" ? { background: "#22c55e20", color: "#22c55e", border: "1px solid #22c55e40" } : {}),
  }),
  // Table
  th: { textAlign: "left", padding: "9px 13px", color: "#6b7280", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", borderBottom: "1px solid #2a2f3e" },
  td: { padding: "11px 13px", borderBottom: "1px solid #14172080", verticalAlign: "middle", fontFamily: "'DM Sans',sans-serif", fontSize: 13 },
  // Pills
  pill: (color) => ({ background: color + "22", border: `1px solid ${color}55`, color, borderRadius: 20, padding: "3px 10px", fontSize: 11, fontFamily: "'DM Sans',sans-serif", display: "inline-block" }),
  // Stats
  statGrid: { display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 14, marginBottom: 24 },
  statCard: { background: "#14172080", border: "1px solid #2a2f3e", borderRadius: 12, padding: "16px 18px", backdropFilter: "blur(10px)" },
  statNum: { fontSize: 30, fontWeight: "bold", color: "#c9a96e", lineHeight: 1, marginBottom: 3 },
  statLabel: { fontSize: 10, color: "#6b7280", fontFamily: "'DM Sans',sans-serif", textTransform: "uppercase", letterSpacing: "0.08em" },
  // Analysis
  analysisBox: { background: "#0c0e1480", border: "1px solid #c9a96e33", borderRadius: 12, padding: 22, marginTop: 22 },
  metaGrid: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 18 },
  metaCard: { background: "#14172080", borderRadius: 9, padding: "13px 15px", textAlign: "center" },
  metaLabel: { fontSize: 10, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: "'DM Sans',sans-serif", marginBottom: 4 },
  metaVal: { fontSize: 14, fontWeight: 600, fontFamily: "'DM Sans',sans-serif" },
  draftBox: { background: "#14172080", borderRadius: 9, padding: 14, fontSize: 13, fontFamily: "'DM Sans',sans-serif", lineHeight: 1.75, color: "#d1cdc8", borderLeft: "3px solid #c9a96e" },
  toast: (type) => ({ position: "fixed", bottom: 24, right: 24, zIndex: 999, background: type === "success" ? "#22c55e" : type === "error" ? "#ef4444" : "#c9a96e", color: "#0c0e14", padding: "12px 20px", borderRadius: 10, fontFamily: "'DM Sans',sans-serif", fontWeight: 600, fontSize: 13, boxShadow: "0 8px 32px #00000060" }),
};

// ─── TOAST ───────────────────────────────────────────────────────────────────
function Toast({ msg, type, onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []);
  return <div style={S.toast(type)}>{msg}</div>;
}

// ─── LOGIN ───────────────────────────────────────────────────────────────────
function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  function attempt() {
    const user = STAFF_USERS.find(u => u.email === email && u.password === pass);
    if (user) onLogin(user);
    else setErr("Invalid email or password.");
  }
  return (
    <div style={S.loginWrap}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      <div style={S.loginCard}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ ...S.logoMark, margin: "0 auto 12px", width: 48, height: 48, fontSize: 24, borderRadius: 14 }}>🏠</div>
          <div style={S.loginTitle}>ResolvIQ</div>
          <div style={S.loginSub}>Housing Complaints Platform</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={S.fg}>
            <label style={S.label}>Email</label>
            <input style={S.input} value={email} onChange={e => setEmail(e.target.value)} placeholder="staff@housing.org" onKeyDown={e => e.key === "Enter" && attempt()} />
          </div>
          <div style={S.fg}>
            <label style={S.label}>Password</label>
            <input style={S.input} type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="••••••••" onKeyDown={e => e.key === "Enter" && attempt()} />
          </div>
          {err && <div style={{ color: "#ef4444", fontFamily: "'DM Sans',sans-serif", fontSize: 12 }}>{err}</div>}
          <button style={{ ...S.btn("primary"), marginTop: 8, width: "100%", padding: "11px" }} onClick={attempt}>Sign In →</button>
        </div>
        <div style={S.loginHint}>
          Demo accounts:<br />
          admin@housing.org / admin123 (Admin)<br />
          case@housing.org / case123 (Staff)
        </div>
      </div>
    </div>
  );
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState("submit");
  const [complaints, setComplaints] = useState([]);
  const [form, setForm] = useState({ name: "", email: "", address: "", text: "" });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const [toast, setToast] = useState(null);
  const [emailSending, setEmailSending] = useState(false);
  const [filterUrgency, setFilterUrgency] = useState("All");
  const [filterStage, setFilterStage] = useState("All");
  const [search, setSearch] = useState("");

  useEffect(() => {
    try { const s = localStorage.getItem("resolviq_v2"); if (s) setComplaints(JSON.parse(s)); } catch {}
  }, []);

  function save(list) { setComplaints(list); try { localStorage.setItem("resolviq_v2", JSON.stringify(list)); } catch {} }
  function showToast(msg, type = "success") { setToast({ msg, type }); }

  async function handleSubmit() {
    if (!form.name || !form.text) { setError("Please fill in your name and complaint."); return; }
    setError(""); setLoading(true); setResult(null);
    try {
      const analysis = await analyseComplaint(`Tenant: ${form.name}\nAddress: ${form.address}\nComplaint: ${form.text}`);
      const record = {
        id: generateId(), date: new Date().toISOString().split("T")[0],
        ...form, ...analysis,
        dueDate: daysFromNow(analysis.dueDays || 14),
        stage: "New",
        assignedTeam: analysis.category === "Repairs" ? "Maintenance" : analysis.category === "ASB" ? "Housing Officer" : "Customer Services",
        emailSent: false, airtableId: null,
      };
      // Save to Airtable
      try { const at = await saveToAirtable(record); if (at?.id) record.airtableId = at.id; } catch {}
      const updated = [record, ...complaints];
      save(updated); setResult(record);
      setForm({ name: "", email: "", address: "", text: "" });
      showToast("Complaint logged & analysed ✓");
    } catch (e) {
      setError("Analysis failed — check your API key or network and try again.");
    }
    setLoading(false);
  }

  async function handleSendEmail(c) {
    if (!c.email) { showToast("No email address on record", "error"); return; }
    setEmailSending(true);
    try {
      const res = await sendAcknowledgement(c);
      if (res.skipped) { showToast("EmailJS not configured — add credentials to CONFIG", "warn"); }
      else if (res.ok) {
        const updated = complaints.map(x => x.id === c.id ? { ...x, emailSent: true } : x);
        save(updated); if (selected?.id === c.id) setSelected({ ...c, emailSent: true });
        showToast("Acknowledgement email sent ✓");
      } else showToast("Email failed: " + (res.error || "unknown error"), "error");
    } catch { showToast("Email send error", "error"); }
    setEmailSending(false);
  }

  async function handleStageChange(c, stage) {
    try { await updateAirtableStage(c.airtableId, stage); } catch {}
    const updated = complaints.map(x => x.id === c.id ? { ...x, stage } : x);
    save(updated);
    if (selected?.id === c.id) setSelected({ ...c, stage });
    showToast(`Stage updated to ${stage}`);
  }

  const filtered = complaints.filter(c => {
    if (filterUrgency !== "All" && c.urgency !== filterUrgency) return false;
    if (filterStage !== "All" && c.stage !== filterStage) return false;
    if (search) { const q = search.toLowerCase(); return c.name?.toLowerCase().includes(q) || c.id?.toLowerCase().includes(q) || c.category?.toLowerCase().includes(q) || c.address?.toLowerCase().includes(q); }
    return true;
  });

  const stats = {
    total: complaints.length,
    high: complaints.filter(c => c.urgency === "High").length,
    open: complaints.filter(c => c.stage !== "Resolved").length,
    resolved: complaints.filter(c => c.stage === "Resolved").length,
    overdue: complaints.filter(c => isOverdue(c.dueDate, c.stage)).length,
  };

  if (!user) return <Login onLogin={u => { setUser(u); setView("submit"); }} />;

  return (
    <div style={S.root}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}

      {/* HEADER */}
      <header style={S.header}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={S.logoMark}>🏠</div>
          <div>
            <div style={S.logoText}>ResolvIQ</div>
            <div style={S.logoSub}>Housing Complaints Platform</div>
          </div>
        </div>
        <nav style={S.nav}>
          {(user.role === "admin" ? ["submit","dashboard","settings"] : ["submit","dashboard"]).map(v => (
            <button key={v} style={S.navBtn(view === v)} onClick={() => { setView(v); setResult(null); setSelected(null); }}>
              {v === "submit" ? "📝 Submit" : v === "dashboard" ? "📊 Dashboard" : "⚙️ Settings"}
            </button>
          ))}
        </nav>
        <div style={S.userPill}>
          <span>👤</span>
          <span>{user.name}</span>
          <span style={S.roleBadge(user.role)}>{user.role}</span>
          <button style={{ background: "none", border: "none", cursor: "pointer", color: "#6b7280", marginLeft: 4, fontSize: 13 }} onClick={() => setUser(null)}>Sign out</button>
        </div>
      </header>

      <main style={S.main}>

        {/* ── SUBMIT ── */}
        {view === "submit" && (
          <>
            <div style={S.card}>
              <div style={S.sectionTitle}>New Complaint</div>
              <div style={S.sectionSub}>AI will automatically categorise, assess urgency, and draft an acknowledgement.</div>
              <div style={S.formGrid}>
                <div style={S.fg}>
                  <label style={S.label}>Full Name *</label>
                  <input style={S.input} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Jane Smith" />
                </div>
                <div style={S.fg}>
                  <label style={S.label}>Email Address</label>
                  <input style={S.input} type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="jane@email.com" />
                </div>
                <div style={{ ...S.fg, gridColumn: "1 / -1" }}>
                  <label style={S.label}>Property Address</label>
                  <input style={S.input} value={form.address} onChange={e => setForm({ ...form, address: e.target.value })} placeholder="12 Maple Street, London, E1 2AB" />
                </div>
                <div style={{ ...S.fg, gridColumn: "1 / -1" }}>
                  <label style={S.label}>Complaint Details *</label>
                  <textarea style={S.textarea} value={form.text} onChange={e => setForm({ ...form, text: e.target.value })} placeholder="Describe the complaint in as much detail as possible..." />
                </div>
              </div>
              {error && <div style={{ color: "#ef4444", fontFamily: "'DM Sans',sans-serif", fontSize: 12, marginTop: 10 }}>{error}</div>}
              <button style={{ ...S.btn("primary", loading), marginTop: 18, display: "flex", alignItems: "center", gap: 8 }} onClick={handleSubmit} disabled={loading}>
                {loading ? "⏳ Analysing..." : "✦ Submit & Analyse with AI"}
              </button>
            </div>

            {result && (
              <div style={S.analysisBox}>
                <div style={{ fontFamily: "'DM Sans',sans-serif", fontWeight: 700, color: "#22c55e", marginBottom: 16, fontSize: 14 }}>
                  ✓ {result.id} logged successfully
                </div>
                <div style={S.metaGrid}>
                  {[
                    { label: "Category", val: result.category, color: "#c9a96e" },
                    { label: "Urgency", val: result.urgency, color: URGENCY_COLORS[result.urgency] },
                    { label: "Sentiment", val: result.sentiment, color: "#d1cdc8" },
                    { label: "Assigned To", val: result.assignedTeam, color: "#d1cdc8" },
                    { label: "Due Date", val: formatDate(result.dueDate), color: "#d1cdc8" },
                    { label: "Resolve In", val: `${result.dueDays} days`, color: "#d1cdc8" },
                  ].map(m => (
                    <div key={m.label} style={S.metaCard}>
                      <div style={S.metaLabel}>{m.label}</div>
                      <div style={{ ...S.metaVal, color: m.color }}>{m.val}</div>
                    </div>
                  ))}
                </div>
                {(result.keyIssues || []).length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
                    {result.keyIssues.map(k => <span key={k} style={S.pill("#8b5cf6")}>{k}</span>)}
                  </div>
                )}
                <div style={{ ...S.label, marginBottom: 6 }}>Draft Acknowledgement</div>
                <div style={S.draftBox}>{result.acknowledgement}</div>
                {result.email && (
                  <button style={{ ...S.btn("success"), marginTop: 12 }} onClick={() => handleSendEmail(result)} disabled={emailSending || result.emailSent}>
                    {result.emailSent ? "✓ Email Sent" : emailSending ? "Sending..." : "📧 Send Acknowledgement Email"}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {/* ── DASHBOARD ── */}
        {view === "dashboard" && (
          <>
            {/* Stats */}
            <div style={S.statGrid}>
              {[
                { label: "Total", val: stats.total, color: "#c9a96e" },
                { label: "High Urgency", val: stats.high, color: "#ef4444" },
                { label: "Open", val: stats.open, color: "#3b82f6" },
                { label: "Resolved", val: stats.resolved, color: "#22c55e" },
                { label: "Overdue", val: stats.overdue, color: "#f59e0b" },
              ].map(s => (
                <div key={s.label} style={S.statCard}>
                  <div style={{ ...S.statNum, color: s.color }}>{s.val}</div>
                  <div style={S.statLabel}>{s.label}</div>
                </div>
              ))}
            </div>

            {/* Filters + Export */}
            <div style={{ ...S.card, padding: "16px 20px" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <input style={{ ...S.input, width: 220 }} value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search name, ID, address..." />
                <select style={{ ...S.input, width: "auto" }} value={filterUrgency} onChange={e => setFilterUrgency(e.target.value)}>
                  <option>All</option>
                  {["High","Medium","Low"].map(u => <option key={u}>{u}</option>)}
                </select>
                <select style={{ ...S.input, width: "auto" }} value={filterStage} onChange={e => setFilterStage(e.target.value)}>
                  <option>All</option>
                  {STAGES.map(s => <option key={s}>{s}</option>)}
                </select>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <button style={S.btn("ghost")} onClick={() => exportCSV(complaints)}>⬇ Export CSV</button>
                </div>
              </div>
            </div>

            {/* Table */}
            <div style={S.card}>
              <div style={S.sectionTitle}>Complaints ({filtered.length})</div>
              {filtered.length === 0 ? (
                <div style={{ textAlign: "center", padding: "50px 0", color: "#4b5563", fontFamily: "'DM Sans',sans-serif" }}>
                  <div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>
                  {complaints.length === 0 ? "No complaints submitted yet." : "No complaints match your filters."}
                </div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'DM Sans',sans-serif", fontSize: 12 }}>
                    <thead>
                      <tr>
                        {["ID","Date","Name","Category","Urgency","Stage","Due","Team","Email"].map(h => (
                          <th key={h} style={S.th}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map(c => {
                        const over = isOverdue(c.dueDate, c.stage);
                        return (
                          <tr key={c.id} onClick={() => setSelected(selected?.id === c.id ? null : c)}
                            style={{ cursor: "pointer", background: selected?.id === c.id ? "#c9a96e0d" : "transparent" }}>
                            <td style={{ ...S.td, color: "#c9a96e", fontWeight: 600 }}>{c.id}</td>
                            <td style={S.td}>{formatDate(c.date)}</td>
                            <td style={S.td}>{c.name}</td>
                            <td style={S.td}>{c.category}</td>
                            <td style={S.td}><span style={S.pill(URGENCY_COLORS[c.urgency] || "#6b7280")}>{c.urgency}</span></td>
                            <td style={S.td}><span style={S.pill(STAGE_COLORS[c.stage] || "#6b7280")}>{c.stage}</span></td>
                            <td style={{ ...S.td, color: over ? "#ef4444" : "#d1cdc8" }}>{formatDate(c.dueDate)}{over ? " ⚠" : ""}</td>
                            <td style={S.td}>{c.assignedTeam}</td>
                            <td style={S.td}>{c.emailSent ? <span style={{ color: "#22c55e" }}>✓ Sent</span> : <span style={{ color: "#6b7280" }}>–</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Detail Panel */}
            {selected && (
              <div style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 }}>
                  <div>
                    <div style={S.sectionTitle}>{selected.id}</div>
                    <div style={S.sectionSub}>{selected.name}{selected.address ? " · " + selected.address : ""}{selected.email ? " · " + selected.email : ""}</div>
                  </div>
                  <button style={S.btn("ghost")} onClick={() => setSelected(null)}>✕ Close</button>
                </div>

                <div style={S.metaGrid}>
                  {[
                    { label: "Category", val: selected.category, color: "#c9a96e" },
                    { label: "Urgency", val: selected.urgency, color: URGENCY_COLORS[selected.urgency] },
                    { label: "Sentiment", val: selected.sentiment, color: "#d1cdc8" },
                  ].map(m => (
                    <div key={m.label} style={S.metaCard}>
                      <div style={S.metaLabel}>{m.label}</div>
                      <div style={{ ...S.metaVal, color: m.color }}>{m.val}</div>
                    </div>
                  ))}
                </div>

                {(selected.keyIssues || []).length > 0 && (
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
                    {selected.keyIssues.map(k => <span key={k} style={S.pill("#8b5cf6")}>{k}</span>)}
                  </div>
                )}

                <div style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: "#9ca3af", marginBottom: 12 }}>
                  <strong style={{ color: "#d1cdc8" }}>AI Summary: </strong>{selected.summary}
                </div>

                <div style={{ ...S.label, marginBottom: 5 }}>Original Complaint</div>
                <div style={{ ...S.draftBox, marginBottom: 14 }}>{selected.text}</div>

                <div style={{ ...S.label, marginBottom: 5 }}>Draft Acknowledgement</div>
                <div style={{ ...S.draftBox, marginBottom: 16 }}>{selected.acknowledgement}</div>

                <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                  <label style={S.label}>Update Stage:</label>
                  <select style={{ ...S.input, width: "auto", padding: "6px 10px" }} value={selected.stage}
                    onChange={e => handleStageChange(selected, e.target.value)}>
                    {STAGES.map(s => <option key={s}>{s}</option>)}
                  </select>
                  {selected.email && (
                    <button style={S.btn("success", emailSending || selected.emailSent)} onClick={() => handleSendEmail(selected)} disabled={emailSending || selected.emailSent}>
                      {selected.emailSent ? "✓ Email Sent" : emailSending ? "Sending..." : "📧 Send Acknowledgement"}
                    </button>
                  )}
                  <button style={S.btn("ghost")} onClick={() => exportCSV([selected])}>⬇ Export This Case</button>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── SETTINGS (admin only) ── */}
        {view === "settings" && user.role === "admin" && (
          <div style={S.card}>
            <div style={S.sectionTitle}>Integration Settings</div>
            <div style={S.sectionSub}>Configure your Airtable and EmailJS credentials. Edit the CONFIG object at the top of the source code.</div>
            {[
              { label: "Airtable API Key", val: CONFIG.AIRTABLE_API_KEY, key: "AIRTABLE_API_KEY" },
              { label: "Airtable Base ID", val: CONFIG.AIRTABLE_BASE_ID, key: "AIRTABLE_BASE_ID" },
              { label: "Airtable Table Name", val: CONFIG.AIRTABLE_TABLE, key: "AIRTABLE_TABLE" },
              { label: "EmailJS Service ID", val: CONFIG.EMAILJS_SERVICE_ID, key: "EMAILJS_SERVICE_ID" },
              { label: "EmailJS Template ID", val: CONFIG.EMAILJS_TEMPLATE_ID, key: "EMAILJS_TEMPLATE_ID" },
              { label: "EmailJS Public Key", val: CONFIG.EMAILJS_PUBLIC_KEY, key: "EMAILJS_PUBLIC_KEY" },
            ].map(f => (
              <div key={f.key} style={{ ...S.fg, marginBottom: 14 }}>
                <label style={S.label}>{f.label}</label>
                <input style={{ ...S.input, fontFamily: "monospace", fontSize: 12, color: f.val.startsWith("YOUR") ? "#ef4444" : "#22c55e" }}
                  readOnly value={f.val} />
              </div>
            ))}
            <div style={{ background: "#c9a96e18", border: "1px solid #c9a96e33", borderRadius: 10, padding: "14px 16px", fontFamily: "'DM Sans',sans-serif", fontSize: 12, color: "#c9a96e", lineHeight: 1.8 }}>
              <strong>Setup Guide:</strong><br />
              1. <strong>Airtable:</strong> Create a base called "Complaints" at airtable.com → Get API key from account settings<br />
              2. <strong>EmailJS:</strong> Sign up at emailjs.com → Create a service + template → Copy your public key<br />
              3. Replace the YOUR_... placeholders in the CONFIG object at the top of the source file
            </div>
            <div style={{ marginTop: 18 }}>
              <div style={{ ...S.label, marginBottom: 8 }}>Demo Staff Accounts</div>
              {STAFF_USERS.map(u => (
                <div key={u.id} style={{ ...S.metaCard, textAlign: "left", marginBottom: 8, display: "flex", gap: 14, alignItems: "center" }}>
                  <span style={S.roleBadge(u.role)}>{u.role}</span>
                  <span style={{ fontFamily: "'DM Sans',sans-serif", fontSize: 13, color: "#d1cdc8" }}>{u.name}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 12, color: "#6b7280" }}>{u.email} / {u.password}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
