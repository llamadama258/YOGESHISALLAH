import { useState, useEffect, useRef } from "react";

// When running inside claude.ai artifacts, no API key is needed —
// requests go through the built-in proxy automatically.

const API_URL = "https://api.anthropic.com/v1/messages";

const US_STATES = ["Alabama","Alaska","Arizona","Arkansas","California","Colorado","Connecticut","Delaware","Florida","Georgia","Hawaii","Idaho","Illinois","Indiana","Iowa","Kansas","Kentucky","Louisiana","Maine","Maryland","Massachusetts","Michigan","Minnesota","Mississippi","Missouri","Montana","Nebraska","Nevada","New Hampshire","New Jersey","New Mexico","New York","North Carolina","North Dakota","Ohio","Oklahoma","Oregon","Pennsylvania","Rhode Island","South Carolina","South Dakota","Tennessee","Texas","Utah","Vermont","Virginia","Washington","West Virginia","Wisconsin","Wyoming","Washington D.C."];

const CATEGORIES = [
  { id: "insurance", label: "Insurance Denial", icon: "🏥", color: "#e74c3c", desc: "Health, auto, home, life insurance claim denials or bad faith practices" },
  { id: "landlord", label: "Landlord / Housing", icon: "🏠", color: "#e67e22", desc: "Repairs ignored, illegal eviction, deposit theft, habitability issues" },
  { id: "employer", label: "Employer / Wages", icon: "💼", color: "#f39c12", desc: "Unpaid wages, wrongful termination, discrimination, harassment" },
  { id: "school", label: "Education", icon: "🎓", color: "#27ae60", desc: "IEP violations, discrimination, unfair discipline, denied accommodations" },
  { id: "billing", label: "Medical Billing", icon: "🧾", color: "#16a085", desc: "Surprise bills, billing errors, balance billing, insurance disputes" },
  { id: "government", label: "Government Agency", icon: "🏛️", color: "#2980b9", desc: "Benefits denied, permits refused, discrimination by public agencies" },
  { id: "consumer", label: "Consumer / Product", icon: "📦", color: "#8e44ad", desc: "Defective products, warranty violations, fraud, deceptive practices" },
  { id: "utility", label: "Utilities / Services", icon: "⚡", color: "#c0392b", desc: "Wrongful shutoffs, billing fraud, service provider disputes" },
];

const URGENCY_KEYWORDS = ["evict", "foreclos", "terminat", "shutoff", "deadline", "court", "lawsuit", "sue", "attorney", "30 days", "notice", "summons", "hearing"];

const SYSTEM_PROMPT = `You are a brilliant legal strategist. Help ordinary people fight institutions that wronged them. Deep expertise in consumer protection, tenant rights, employment, healthcare, education, civil rights across all US states.

Respond ONLY with a valid JSON object. No markdown, no backticks, no preamble. Pure JSON.

{
  "caseTitle": "Short title max 6 words",
  "strengthScore": 82,
  "strengthReason": "One sentence",
  "urgencyLevel": "low|medium|high|critical",
  "urgencyNote": "Time-sensitive risk if high/critical, else empty string",
  "summary": "2 sentence plain English summary",
  "rights": [
    {"title": "Right name", "description": "Specific violation", "law": "Specific law e.g. Fair Housing Act §804(b)", "strength": "strong|moderate|weak"}
  ],
  "evidenceChecklist": [
    {"item": "What to gather", "why": "Why it matters", "priority": "essential|helpful|optional"}
  ],
  "demandLetter": "Full attorney-quality demand letter. Use [YOUR NAME], [YOUR ADDRESS], [DATE], [RECIPIENT NAME], [RECIPIENT ADDRESS]. Cite laws. 14-day deadline. Consequences of non-compliance.",
  "complaint": "Full regulatory complaint ready to file with agency name, violation codes, facts, requested relief.",
  "emailSequence": [
    {"subject": "Subject", "body": "Full email", "timing": "Day 1", "tone": "Firm", "purpose": "Goal"}
  ],
  "predictedResponses": [
    {"response": "What they say", "counter": "How to respond", "probability": "likely|possible|unlikely"}
  ],
  "filingAgencies": [
    {"name": "Agency", "jurisdiction": "Federal|State|Local", "url": "https://...", "deadline": "deadline or empty", "why": "jurisdiction reason", "feeWaiver": true}
  ],
  "nextSteps": [
    {"step": "Action", "timeline": "When", "importance": "critical|important|optional"}
  ],
  "winProbability": {"settlement": 75, "fullWin": 45, "note": "Brief note"}
}`;

const CHAT_SYSTEM = `You are a legal advisor helping someone with their specific case. Be direct, practical, and empowering. Answer questions about their legal situation, strategy, what to say to the other party, how to escalate, what evidence matters, and next steps. Keep answers concise but thorough. Use plain English. Never be wishy-washy — give real actionable advice while noting you're not their attorney of record.`;

// Storage helpers
const saveCase = (c) => {
  try {
    const all = JSON.parse(localStorage.getItem("sts_cases") || "[]");
    const updated = [c, ...all.filter(x => x.id !== c.id)].slice(0, 20);
    localStorage.setItem("sts_cases", JSON.stringify(updated));
  } catch {}
};
const loadCases = () => {
  try { return JSON.parse(localStorage.getItem("sts_cases") || "[]"); } catch { return []; }
};

export default function App() {
  const [screen, setScreen] = useState("home"); // home|intake|loading|results|cases|chat
  const [step, setStep] = useState(1); // intake steps 1-4
  const [form, setForm] = useState({ category: "", situation: "", evidence: "", outcome: "", state: "", urgency: "" });
  const [results, setResults] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [cases, setCases] = useState(loadCases());
  const [copied, setCopied] = useState(null);
  const [loadingMsg, setLoadingMsg] = useState(0);
  const [error, setError] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [activeCase, setActiveCase] = useState(null);
  const chatEndRef = useRef(null);

  const loadingMsgs = [
    "Analyzing your legal rights...",
    "Identifying violated statutes...",
    "Drafting demand letter...",
    "Building email sequence...",
    "Predicting their response...",
    "Locating filing agencies...",
    "Assembling your case file...",
    "Loading your ammunition...",
  ];

  useEffect(() => {
    if (screen === "loading") {
      const i = setInterval(() => setLoadingMsg(m => (m + 1) % loadingMsgs.length), 1600);
      return () => clearInterval(i);
    }
  }, [screen]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const detectUrgency = (text) => {
    const lower = text.toLowerCase();
    return URGENCY_KEYWORDS.some(k => lower.includes(k));
  };


  const callClaude = async (messages, system, maxTokens = 3000) => {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        system,
        messages,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message || `API error ${res.status}`);
    return data.content.map(i => i.text || "").join("");
  };

  const buildCase = async () => {
    setScreen("loading");
    setError("");
    try {
      const prompt = `State: ${form.state || "Unknown"}
Category: ${form.category}
Situation: ${form.situation}
Evidence available: ${form.evidence || "None specified"}
Desired outcome: ${form.outcome || "Fair resolution"}
Urgency indicators: ${detectUrgency(form.situation) ? "YES - time sensitive language detected" : "No"}`;

      const text = await callClaude([{ role: "user", content: prompt }], SYSTEM_PROMPT, 8000);
      const firstBrace = text.indexOf("{");
      const lastBrace = text.lastIndexOf("}");
      if (firstBrace === -1 || lastBrace === -1) throw new Error("Model response was incomplete. Please try again.");
      const clean = text.slice(firstBrace, lastBrace + 1);
      const parsed = JSON.parse(clean);

      const newCase = {
        id: Date.now().toString(),
        createdAt: new Date().toISOString(),
        form: { ...form },
        results: parsed,
      };

      saveCase(newCase);
      setCases(loadCases());
      setResults(parsed);
      setActiveCase(newCase);
      setChatMessages([{
        role: "assistant",
        content: `I've analyzed your case. You have a **${parsed.strengthScore}% strength score** — ${parsed.strengthReason}\n\n${parsed.summary}\n\nWhat questions do you have about your case or next steps?`
      }]);
      setActiveTab("overview");
      setScreen("results");
    } catch (e) {
      setError(`Error: ${e.message || "Something went wrong. Please try again."}`);
      setScreen("intake");
    }
  };

  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = { role: "user", content: chatInput };
    const newMsgs = [...chatMessages, userMsg];
    setChatMessages(newMsgs);
    setChatInput("");
    setChatLoading(true);
    try {
      const caseContext = `Case context: ${JSON.stringify(activeCase?.results?.summary || results?.summary)}. Category: ${form.category}. State: ${form.state}.`;
      const text = await callClaude(
        newMsgs.map(m => ({ role: m.role, content: m.content })),
        CHAT_SYSTEM + "\n\n" + caseContext,
        1000
      );
      setChatMessages(m => [...m, { role: "assistant", content: text }]);
    } catch(e) {
      setChatMessages(m => [...m, { role: "assistant", content: `Error: ${e.message}. Please try again.` }]);
    }
    setChatLoading(false);
  };

  const copy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  const downloadDoc = (content, filename) => {
    const blob = new Blob([content], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
  };

  const openCase = (c) => {
    setActiveCase(c);
    setResults(c.results);
    setForm(c.form);
    setChatMessages([{
      role: "assistant",
      content: `I've loaded your case. Strength score: **${c.results.strengthScore}%**. ${c.results.summary}\n\nWhat would you like to know?`
    }]);
    setActiveTab("overview");
    setScreen("results");
  };

  const resetToHome = () => {
    setScreen("home");
    setStep(1);
    setForm({ category: "", situation: "", evidence: "", outcome: "", state: "", urgency: "" });
    setResults(null);
    setError("");
  };

  const urgentDetected = detectUrgency(form.situation);

  // ─── SCREENS ───────────────────────────────────────────────────────────────

  // HOME
  if (screen === "home") return (
    <Shell>
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        {/* Nav */}
        <nav style={S.nav}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Gavel size={20} />
            <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: "-0.02em" }}>Sue the System</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {cases.length > 0 && <button onClick={() => setScreen("cases")} style={S.navBtn}>My Cases ({cases.length})</button>}
          </div>
        </nav>

        {/* Hero */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "60px 24px", textAlign: "center" }}>
          <div style={S.badge}>AI-Powered Legal Engine</div>
          <h1 style={{ ...S.hero, fontSize: "clamp(52px, 10vw, 96px)", marginBottom: 20 }}>
            They have lawyers.<br /><span style={{ color: "var(--red)" }}>Now you do too.</span>
          </h1>
          <p style={{ ...S.sub, maxWidth: 540, fontSize: 18, marginBottom: 48 }}>
            Paste your situation. Get a demand letter, regulatory complaint, email sequence, and legal strategy — in seconds. Free.
          </p>
          <button onClick={() => { setStep(1); setScreen("intake"); }} style={{ ...S.btn, fontSize: 16, padding: "18px 48px" }}>
            Build My Case →
          </button>
          {cases.length > 0 && (
            <button onClick={() => setScreen("cases")} style={{ ...S.ghostBtn, marginTop: 12 }}>
              View saved cases ({cases.length})
            </button>
          )}

          {/* Stats */}
          <div style={{ display: "flex", gap: 48, marginTop: 64, flexWrap: "wrap", justifyContent: "center" }}>
            {[["8", "Categories Covered"], ["5+", "Documents Generated"], ["50", "States Supported"], ["0", "Lawyers Needed"]].map(([n, l]) => (
              <div key={l} style={{ textAlign: "center" }}>
                <div style={{ fontSize: 32, fontWeight: 900, color: "var(--red)", lineHeight: 1 }}>{n}</div>
                <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4, letterSpacing: "0.1em", textTransform: "uppercase" }}>{l}</div>
              </div>
            ))}
          </div>

          {/* Categories preview */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10, maxWidth: 820, width: "100%", marginTop: 64 }}>
            {CATEGORIES.map(c => (
              <button key={c.id} onClick={() => { setForm(f => ({ ...f, category: c.id })); setStep(1); setScreen("intake"); }}
                style={{ ...S.catCard, borderColor: `${c.color}30` }}>
                <span style={{ fontSize: 24 }}>{c.icon}</span>
                <span style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>{c.label}</span>
              </button>
            ))}
          </div>
        </div>

        <footer style={{ textAlign: "center", padding: "20px", fontSize: 11, color: "var(--dim)", borderTop: "1px solid var(--border)" }}>
          Not legal advice. For informational purposes only. Consult a licensed attorney for serious matters.
        </footer>
      </div>
    </Shell>
  );

  // INTAKE WIZARD
  if (screen === "intake") return (
    <Shell>
      <div style={{ maxWidth: 700, margin: "0 auto", padding: "40px 24px", animation: "fadeUp 0.4s ease" }}>
        {/* Back + progress */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 40 }}>
          <button onClick={step === 1 ? resetToHome : () => setStep(s => s - 1)} style={S.backBtn}>← Back</button>
          <div style={{ display: "flex", gap: 6 }}>
            {[1, 2, 3, 4].map(i => (
              <div key={i} style={{ width: 32, height: 4, borderRadius: 2, background: i <= step ? "var(--red)" : "var(--border)", transition: "background 0.3s" }} />
            ))}
          </div>
          <span style={{ fontSize: 12, color: "var(--dim)" }}>Step {step} of 4</span>
        </div>

        {error && <div style={S.errorBox}>{error}</div>}

        {/* Step 1: Category + State */}
        {step === 1 && (
          <div>
            <h2 style={S.stepTitle}>What system wronged you?</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10, marginBottom: 32 }}>
              {CATEGORIES.map(c => (
                <button key={c.id} onClick={() => setForm(f => ({ ...f, category: c.id }))}
                  style={{ ...S.catCard, borderColor: form.category === c.id ? c.color : "var(--border)", background: form.category === c.id ? `${c.color}18` : "var(--card)", textAlign: "left", padding: 16 }}>
                  <span style={{ fontSize: 28 }}>{c.icon}</span>
                  <div style={{ fontWeight: 700, fontSize: 13, marginTop: 8 }}>{c.label}</div>
                  <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 4, lineHeight: 1.4 }}>{c.desc}</div>
                </button>
              ))}
            </div>
            <label style={S.label}>Your State</label>
            <select value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))} style={S.input}>
              <option value="">Select state (optional but improves accuracy)</option>
              {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={() => setStep(2)} disabled={!form.category} style={{ ...S.btn, width: "100%", marginTop: 24 }}>
              Continue →
            </button>
          </div>
        )}

        {/* Step 2: Situation */}
        {step === 2 && (
          <div>
            <h2 style={S.stepTitle}>What happened?</h2>
            <p style={{ color: "var(--dim)", marginBottom: 24, lineHeight: 1.6 }}>Be specific. Include dates, dollar amounts, names of companies or people, and what they said or did. The more detail, the stronger your case.</p>
            {urgentDetected && (
              <div style={S.urgentBox}>
                ⚡ <strong>Urgency detected.</strong> Your description contains time-sensitive language. Make sure to include specific deadlines or dates you've been given.
              </div>
            )}
            <textarea
              value={form.situation}
              onChange={e => setForm(f => ({ ...f, situation: e.target.value }))}
              placeholder={`Example: On March 1st, ${new Date().getFullYear()}, my insurance company (Blue Shield) denied my claim #12345 for an MRI that my doctor Dr. Smith ordered. They said it was "not medically necessary" even though my doctor submitted documentation showing I've had chronic back pain for 6 months. I've appealed twice and been denied both times...`}
              rows={8}
              style={{ ...S.input, resize: "vertical", lineHeight: 1.7 }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
              <span style={{ fontSize: 12, color: form.situation.length < 100 ? "var(--red)" : "var(--dim)" }}>
                {form.situation.length < 100 ? `${100 - form.situation.length} more characters recommended` : "✓ Good detail"}
              </span>
              <span style={{ fontSize: 12, color: "var(--dim)" }}>{form.situation.length} chars</span>
            </div>
            <button onClick={() => setStep(3)} disabled={form.situation.length < 30} style={{ ...S.btn, width: "100%", marginTop: 24 }}>
              Continue →
            </button>
          </div>
        )}

        {/* Step 3: Evidence */}
        {step === 3 && (
          <div>
            <h2 style={S.stepTitle}>What evidence do you have?</h2>
            <p style={{ color: "var(--dim)", marginBottom: 24, lineHeight: 1.6 }}>List any documents, photos, emails, receipts, or records you already have. Don't worry if you don't have much — we'll tell you what to gather.</p>
            <textarea
              value={form.evidence}
              onChange={e => setForm(f => ({ ...f, evidence: e.target.value }))}
              placeholder="e.g. Denial letter dated Feb 15, email chain with customer service, photos of the damage, doctor's prescription, pay stubs, lease agreement, receipts..."
              rows={5}
              style={{ ...S.input, resize: "vertical", lineHeight: 1.7 }}
            />
            <button onClick={() => setStep(4)} style={{ ...S.btn, width: "100%", marginTop: 24 }}>
              Continue →
            </button>
            <button onClick={() => setStep(4)} style={{ ...S.ghostBtn, width: "100%", marginTop: 8 }}>
              Skip — I'll figure this out later
            </button>
          </div>
        )}

        {/* Step 4: Outcome */}
        {step === 4 && (
          <div>
            <h2 style={S.stepTitle}>What outcome do you want?</h2>
            <p style={{ color: "var(--dim)", marginBottom: 24, lineHeight: 1.6 }}>Be specific and realistic. The AI will factor this into your demand letter and strategy.</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
              {["Full refund / payment", "Claim approved", "Repairs completed", "Reinstatement", "Written apology", "Policy change"].map(o => (
                <button key={o} onClick={() => setForm(f => ({ ...f, outcome: o }))}
                  style={{ ...S.optionBtn, borderColor: form.outcome === o ? "var(--red)" : "var(--border)", background: form.outcome === o ? "rgba(192,57,43,0.15)" : "var(--card)" }}>
                  {o}
                </button>
              ))}
            </div>
            <input
              value={form.outcome}
              onChange={e => setForm(f => ({ ...f, outcome: e.target.value }))}
              placeholder="Or describe your own desired outcome..."
              style={S.input}
            />
            <button onClick={buildCase} disabled={!form.outcome.trim()} style={{ ...S.btn, width: "100%", marginTop: 24, fontSize: 16, padding: "18px" }}>
              ⚖️ Build My Case →
            </button>
          </div>
        )}
      </div>
    </Shell>
  );

  // LOADING
  if (screen === "loading") return (
    <Shell>
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <div style={{ textAlign: "center", animation: "fadeUp 0.3s ease" }}>
          <div style={S.spinner} />
          <p style={{ fontSize: 22, color: "var(--red)", fontStyle: "italic", marginBottom: 8, marginTop: 32 }}>{loadingMsgs[loadingMsg]}</p>
          <p style={{ fontSize: 14, color: "var(--dim)" }}>Building your complete case file...</p>
          <div style={{ marginTop: 40, display: "flex", flexDirection: "column", gap: 8, maxWidth: 300 }}>
            {loadingMsgs.map((m, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, opacity: i <= loadingMsg ? 1 : 0.2, transition: "opacity 0.3s" }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: i < loadingMsg ? "var(--green)" : i === loadingMsg ? "var(--red)" : "var(--border)", transition: "background 0.3s" }} />
                <span style={{ fontSize: 13, color: i <= loadingMsg ? "var(--text)" : "var(--dim)" }}>{m}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Shell>
  );

  // RESULTS
  if (screen === "results" && results) {
    const tabs = [
      { id: "overview", label: "Overview" },
      { id: "rights", label: `Rights (${results.rights?.length || 0})` },
      { id: "letter", label: "Demand Letter" },
      { id: "complaint", label: "Complaint" },
      { id: "emails", label: `Emails (${results.emailSequence?.length || 0})` },
      { id: "counter", label: "Their Playbook" },
      { id: "agencies", label: "File With" },
      { id: "evidence", label: "Evidence" },
      { id: "chat", label: "💬 Ask AI" },
    ];

    const urgencyColor = { low: "var(--green)", medium: "#f39c12", high: "#e67e22", critical: "var(--red)" }[results.urgencyLevel] || "var(--dim)";

    return (
      <Shell>
        <div style={{ animation: "fadeUp 0.4s ease" }}>
          {/* Top bar */}
          <div style={{ ...S.nav, position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button onClick={resetToHome} style={S.backBtn}>← Home</button>
              <span style={{ fontSize: 13, color: "var(--dim)" }}>/</span>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{results.caseTitle || "Your Case"}</span>
              <div style={{ padding: "3px 10px", borderRadius: 20, background: `${urgencyColor}20`, border: `1px solid ${urgencyColor}50`, fontSize: 11, color: urgencyColor, textTransform: "uppercase", letterSpacing: "0.1em" }}>
                {results.urgencyLevel} urgency
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setScreen("cases")} style={S.navBtn}>My Cases</button>
              <button onClick={() => { setStep(1); setScreen("intake"); setForm({ category: "", situation: "", evidence: "", outcome: "", state: "", urgency: "" }); }} style={S.navBtn}>New Case</button>
            </div>
          </div>

          <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px" }}>
            {/* Case header */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 20, marginBottom: 32, alignItems: "start" }}>
              <div>
                <h2 style={{ margin: "0 0 8px", fontSize: 26, fontWeight: 900, letterSpacing: "-0.02em" }}>{results.caseTitle}</h2>
                <p style={{ margin: 0, color: "var(--dim)", lineHeight: 1.6, fontSize: 14 }}>{results.summary}</p>
                {results.urgencyLevel === "high" || results.urgencyLevel === "critical" ? (
                  <div style={{ ...S.urgentBox, marginTop: 12 }}>⚡ {results.urgencyNote}</div>
                ) : null}
              </div>
              {/* Strength meter */}
              <div style={{ textAlign: "center", minWidth: 100 }}>
                <svg width="100" height="100" style={{ transform: "rotate(-90deg)" }}>
                  <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="8" />
                  <circle cx="50" cy="50" r="40" fill="none" stroke="var(--red)" strokeWidth="8"
                    strokeDasharray={`${2 * Math.PI * 40 * results.strengthScore / 100} ${2 * Math.PI * 40 * (1 - results.strengthScore / 100)}`}
                    strokeLinecap="round" style={{ transition: "stroke-dasharray 1s ease" }} />
                </svg>
                <div style={{ marginTop: -70, marginBottom: 24, fontSize: 22, fontWeight: 900, color: "var(--red)" }}>{results.strengthScore}%</div>
                <div style={{ fontSize: 10, color: "var(--dim)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Case Strength</div>
              </div>
            </div>

            {/* Win probability */}
            {results.winProbability && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginBottom: 32 }}>
                {[
                  { label: "Settlement likely", val: results.winProbability.settlement + "%", color: "var(--green)" },
                  { label: "Full win possible", val: results.winProbability.fullWin + "%", color: "var(--red)" },
                  { label: "Strength score", val: results.strengthScore + "%", color: "#f39c12" },
                ].map(s => (
                  <div key={s.label} style={{ ...S.card, textAlign: "center", padding: "16px 12px" }}>
                    <div style={{ fontSize: 24, fontWeight: 900, color: s.color }}>{s.val}</div>
                    <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 4, letterSpacing: "0.08em", textTransform: "uppercase" }}>{s.label}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Tabs */}
            <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--border)", marginBottom: 24, overflowX: "auto", paddingBottom: 1 }}>
              {tabs.map(t => (
                <button key={t.id} onClick={() => setActiveTab(t.id)}
                  style={{ background: "none", border: "none", borderBottom: activeTab === t.id ? "2px solid var(--red)" : "2px solid transparent", color: activeTab === t.id ? "var(--text)" : "var(--dim)", padding: "10px 14px", cursor: "pointer", fontSize: 13, fontFamily: "var(--font)", whiteSpace: "nowrap", transition: "all 0.2s" }}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            {activeTab === "overview" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <h3 style={S.sectionTitle}>Next Steps</h3>
                {results.nextSteps?.map((s, i) => (
                  <div key={i} style={{ ...S.card, display: "flex", gap: 16, alignItems: "flex-start" }}>
                    <div style={{ width: 28, height: 28, borderRadius: "50%", background: s.importance === "critical" ? "var(--red)" : s.importance === "important" ? "#f39c12" : "var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0, color: s.importance === "optional" ? "var(--dim)" : "white" }}>{i + 1}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 2 }}>{s.step}</div>
                      <div style={{ fontSize: 12, color: "var(--dim)" }}>{s.timeline}</div>
                    </div>
                    <div style={{ fontSize: 11, padding: "3px 8px", borderRadius: 3, background: s.importance === "critical" ? "rgba(192,57,43,0.2)" : "var(--card)", color: s.importance === "critical" ? "var(--red)" : "var(--dim)", border: "1px solid var(--border)", textTransform: "uppercase", letterSpacing: "0.08em" }}>{s.importance}</div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
                  <button onClick={() => copy(`DEMAND LETTER:\n\n${results.demandLetter}\n\n---\n\nCOMPLAINT:\n\n${results.complaint}`, "all")} style={S.btn}>
                    {copied === "all" ? "✓ Copied!" : "Copy All Documents"}
                  </button>
                  <button onClick={() => downloadDoc(`SUE THE SYSTEM — CASE FILE\n${"=".repeat(50)}\n\nCase: ${results.caseTitle}\nStrength: ${results.strengthScore}%\n\n${results.summary}\n\n${"=".repeat(50)}\nDEMAND LETTER\n${"=".repeat(50)}\n\n${results.demandLetter}\n\n${"=".repeat(50)}\nREGULATORY COMPLAINT\n${"=".repeat(50)}\n\n${results.complaint}`, "case-file.txt")} style={S.ghostBtn}>
                    Download Case File
                  </button>
                </div>
              </div>
            )}

            {activeTab === "rights" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <h3 style={S.sectionTitle}>Your Rights Being Violated</h3>
                {results.rights?.map((r, i) => (
                  <div key={i} style={{ ...S.card, borderLeft: `3px solid ${r.strength === "strong" ? "var(--red)" : r.strength === "moderate" ? "#f39c12" : "var(--dim)"}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 6 }}>
                      <div style={{ fontWeight: 700, fontSize: 15 }}>{r.title}</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <span style={{ fontSize: 11, color: "var(--red)", background: "rgba(192,57,43,0.1)", padding: "3px 8px", borderRadius: 3, border: "1px solid rgba(192,57,43,0.2)" }}>{r.law}</span>
                        <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 3, background: "var(--card)", border: "1px solid var(--border)", color: "var(--dim)", textTransform: "capitalize" }}>{r.strength}</span>
                      </div>
                    </div>
                    <p style={{ margin: 0, fontSize: 14, color: "var(--dim)", lineHeight: 1.6 }}>{r.description}</p>
                  </div>
                ))}
              </div>
            )}

            {(activeTab === "letter" || activeTab === "complaint") && (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <h3 style={{ ...S.sectionTitle, margin: 0 }}>{activeTab === "letter" ? "Demand Letter" : "Regulatory Complaint"}</h3>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => copy(activeTab === "letter" ? results.demandLetter : results.complaint, activeTab)} style={S.smallBtn}>
                      {copied === activeTab ? "✓ Copied" : "Copy"}
                    </button>
                    <button onClick={() => downloadDoc(activeTab === "letter" ? results.demandLetter : results.complaint, `${activeTab}.txt`)} style={S.smallBtn}>Download</button>
                  </div>
                </div>
                <div style={{ ...S.card, fontFamily: "'Courier New', monospace", fontSize: 13, lineHeight: 1.9, whiteSpace: "pre-wrap", color: "#ddd", position: "relative" }}>
                  {activeTab === "letter" ? results.demandLetter : results.complaint}
                </div>
                <p style={{ fontSize: 12, color: "var(--dim)", marginTop: 10, fontStyle: "italic" }}>Replace [BRACKETED] placeholders with your actual information before sending.</p>
              </div>
            )}

            {activeTab === "emails" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
                <h3 style={S.sectionTitle}>Email Sequence</h3>
                {results.emailSequence?.map((e, i) => (
                  <div key={i} style={S.card}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
                      <div>
                        <span style={{ fontSize: 11, color: "var(--red)", textTransform: "uppercase", letterSpacing: "0.1em" }}>{e.timing} · {e.tone}</span>
                        <div style={{ fontWeight: 700, fontSize: 15, marginTop: 4 }}>Subject: {e.subject}</div>
                        <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 2 }}>Goal: {e.purpose}</div>
                      </div>
                      <button onClick={() => copy(e.body, `email-${i}`)} style={S.smallBtn}>{copied === `email-${i}` ? "✓" : "Copy"}</button>
                    </div>
                    <pre style={{ margin: 0, fontSize: 13, lineHeight: 1.8, whiteSpace: "pre-wrap", color: "#ccc", fontFamily: "inherit" }}>{e.body}</pre>
                  </div>
                ))}
              </div>
            )}

            {activeTab === "counter" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                <h3 style={S.sectionTitle}>Their Likely Playbook — And Your Counter</h3>
                {results.predictedResponses?.map((r, i) => (
                  <div key={i} style={S.card}>
                    <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                      <span style={{ fontSize: 11, padding: "3px 10px", borderRadius: 20, background: r.probability === "likely" ? "rgba(192,57,43,0.2)" : "var(--card)", border: "1px solid var(--border)", color: r.probability === "likely" ? "var(--red)" : "var(--dim)", textTransform: "capitalize" }}>{r.probability}</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                      <div>
                        <div style={{ fontSize: 11, color: "var(--dim)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>They'll say</div>
                        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#aaa", fontStyle: "italic" }}>"{r.response}"</p>
                      </div>
                      <div style={{ borderLeft: "2px solid var(--red)", paddingLeft: 16 }}>
                        <div style={{ fontSize: 11, color: "var(--red)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 8 }}>You respond</div>
                        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>{r.counter}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeTab === "agencies" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <h3 style={S.sectionTitle}>Where to File Your Complaint</h3>
                {results.filingAgencies?.map((a, i) => (
                  <div key={i} style={S.card}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 8 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15 }}>{a.name}</div>
                        <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 2 }}>{a.jurisdiction} · {a.why}</div>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        {a.deadline && <span style={{ fontSize: 11, color: "var(--red)", background: "rgba(192,57,43,0.1)", padding: "3px 8px", borderRadius: 3, border: "1px solid rgba(192,57,43,0.2)" }}>Deadline: {a.deadline}</span>}
                        {a.feeWaiver && <span style={{ fontSize: 11, color: "var(--green)", background: "rgba(39,174,96,0.1)", padding: "3px 8px", borderRadius: 3, border: "1px solid rgba(39,174,96,0.2)" }}>Fee Waiver Available</span>}
                      </div>
                    </div>
                    <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "var(--red)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {a.url} →
                    </a>
                  </div>
                ))}
              </div>
            )}

            {activeTab === "evidence" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <h3 style={S.sectionTitle}>Evidence Checklist</h3>
                <p style={{ color: "var(--dim)", fontSize: 14, marginBottom: 8 }}>Gather these before sending your demand letter to maximize your leverage.</p>
                {results.evidenceChecklist?.map((e, i) => (
                  <div key={i} style={{ ...S.card, display: "flex", gap: 14, alignItems: "flex-start" }}>
                    <div style={{ width: 10, height: 10, borderRadius: "50%", background: e.priority === "essential" ? "var(--red)" : e.priority === "helpful" ? "#f39c12" : "var(--dim)", flexShrink: 0, marginTop: 5 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3 }}>{e.item}</div>
                      <div style={{ fontSize: 13, color: "var(--dim)", lineHeight: 1.5 }}>{e.why}</div>
                    </div>
                    <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 3, background: "var(--bg)", border: "1px solid var(--border)", color: "var(--dim)", textTransform: "capitalize", whiteSpace: "nowrap" }}>{e.priority}</span>
                  </div>
                ))}
              </div>
            )}

            {activeTab === "chat" && (
              <div style={{ display: "flex", flexDirection: "column", height: "60vh" }}>
                <h3 style={{ ...S.sectionTitle, marginBottom: 16 }}>Ask Your AI Legal Advisor</h3>
                <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingBottom: 16 }}>
                  {chatMessages.map((m, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                      <div style={{
                        maxWidth: "80%", padding: "12px 16px", borderRadius: 12,
                        background: m.role === "user" ? "var(--red)" : "var(--card)",
                        border: m.role === "assistant" ? "1px solid var(--border)" : "none",
                        fontSize: 14, lineHeight: 1.7, color: "var(--text)",
                        borderBottomRightRadius: m.role === "user" ? 2 : 12,
                        borderBottomLeftRadius: m.role === "assistant" ? 2 : 12,
                        whiteSpace: "pre-wrap",
                      }}>{m.content}</div>
                    </div>
                  ))}
                  {chatLoading && (
                    <div style={{ display: "flex", justifyContent: "flex-start" }}>
                      <div style={{ ...S.card, padding: "12px 16px", fontSize: 14 }}>
                        <span style={{ animation: "pulse 1s infinite" }}>Thinking...</span>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: "auto" }}>
                  <input
                    value={chatInput}
                    onChange={e => setChatInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendChat()}
                    placeholder="Ask about your case... e.g. 'Should I send the letter certified mail?'"
                    style={{ ...S.input, flex: 1, margin: 0 }}
                    disabled={chatLoading}
                  />
                  <button onClick={sendChat} disabled={!chatInput.trim() || chatLoading} style={{ ...S.btn, padding: "14px 20px", whiteSpace: "nowrap" }}>Send →</button>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  {["What's my strongest legal argument?", "How do I send this letter?", "What if they ignore me?", "Do I need a lawyer?"].map(q => (
                    <button key={q} onClick={() => { setChatInput(q); }} style={{ ...S.smallBtn, fontSize: 11 }}>{q}</button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  // CASES
  if (screen === "cases") return (
    <Shell>
      <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 24px", animation: "fadeUp 0.4s ease" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 32 }}>
          <div>
            <button onClick={resetToHome} style={S.backBtn}>← Home</button>
            <h2 style={{ margin: "12px 0 4px", fontSize: 28, fontWeight: 900 }}>My Cases</h2>
            <p style={{ margin: 0, color: "var(--dim)", fontSize: 14 }}>{cases.length} saved case{cases.length !== 1 ? "s" : ""}</p>
          </div>
          <button onClick={() => { setStep(1); setScreen("intake"); }} style={S.btn}>+ New Case</button>
        </div>
        {cases.length === 0 ? (
          <div style={{ ...S.card, textAlign: "center", padding: 48 }}>
            <p style={{ color: "var(--dim)", marginBottom: 20 }}>No cases yet. Build your first case to get started.</p>
            <button onClick={() => { setStep(1); setScreen("intake"); }} style={S.btn}>Build Your First Case →</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {cases.map(c => {
              const cat = CATEGORIES.find(x => x.id === c.form.category);
              return (
                <button key={c.id} onClick={() => openCase(c)}
                  style={{ ...S.card, textAlign: "left", cursor: "pointer", display: "flex", gap: 16, alignItems: "center", transition: "border-color 0.2s" }}>
                  <span style={{ fontSize: 28 }}>{cat?.icon || "⚖️"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 3 }}>{c.results.caseTitle}</div>
                    <div style={{ fontSize: 12, color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.form.situation.substring(0, 80)}...</div>
                    <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 4 }}>{new Date(c.createdAt).toLocaleDateString()}</div>
                  </div>
                  <div style={{ textAlign: "center", flexShrink: 0 }}>
                    <div style={{ fontSize: 20, fontWeight: 900, color: "var(--red)" }}>{c.results.strengthScore}%</div>
                    <div style={{ fontSize: 10, color: "var(--dim)", letterSpacing: "0.1em" }}>STRENGTH</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Shell>
  );

  return null;
}

// ─── SHARED COMPONENTS ─────────────────────────────────────────────────────

function Shell({ children }) {
  return (
    <div style={{
      minHeight: "100vh", background: "var(--bg)", color: "var(--text)",
      fontFamily: "var(--font)",
      "--bg": "#080808",
      "--card": "rgba(255,255,255,0.04)",
      "--border": "rgba(255,255,255,0.08)",
      "--text": "#e8e0d0",
      "--dim": "#666",
      "--red": "#c0392b",
      "--green": "#27ae60",
      "--font": "'Georgia', 'Times New Roman', serif",
    }}>
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, background: "radial-gradient(ellipse at 15% 50%, rgba(192,57,43,0.06) 0%, transparent 55%), radial-gradient(ellipse at 85% 20%, rgba(192,57,43,0.04) 0%, transparent 50%)" }} />
      <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
      <style>{`
        * { box-sizing: border-box; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        input:focus, textarea:focus, select:focus { outline: none; border-color: rgba(192,57,43,0.6) !important; }
        textarea::placeholder, input::placeholder { color: #333; }
        ::-webkit-scrollbar { width: 5px; height: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }
        button:hover { filter: brightness(1.1); }
        a:hover { text-decoration: underline; }
      `}</style>
    </div>
  );
}

function Gavel({ size = 32 }) {
  return <span style={{ fontSize: size * 0.6, display: "inline-block" }}>⚖️</span>;
}

// ─── STYLES ────────────────────────────────────────────────────────────────

const S = {
  hero: { fontSize: "clamp(40px, 8vw, 80px)", fontWeight: 900, margin: "0 0 16px", lineHeight: 0.95, letterSpacing: "-0.03em", color: "#f0e8d8" },
  sub: { fontSize: 16, color: "#888", lineHeight: 1.7, margin: "0 auto" },
  badge: { display: "inline-block", background: "rgba(192,57,43,0.15)", border: "1px solid rgba(192,57,43,0.4)", borderRadius: 2, padding: "4px 14px", fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase", color: "#c0392b", marginBottom: 20 },
  nav: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(8,8,8,0.9)" },
  navBtn: { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4, padding: "7px 14px", color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "Georgia, serif" },
  backBtn: { background: "none", border: "none", color: "#666", fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", padding: "4px 0" },
  card: { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "20px" },
  btn: { background: "#c0392b", border: "none", borderRadius: 4, color: "white", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "Georgia, serif", padding: "14px 24px", letterSpacing: "0.02em", transition: "all 0.2s" },
  ghostBtn: { background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, color: "#888", fontSize: 13, cursor: "pointer", fontFamily: "Georgia, serif", padding: "12px 20px" },
  smallBtn: { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 3, color: "#888", fontSize: 12, cursor: "pointer", fontFamily: "Georgia, serif", padding: "6px 12px" },
  input: { width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, padding: "14px 16px", color: "#e8e0d0", fontSize: 14, fontFamily: "Georgia, serif", transition: "border-color 0.2s", display: "block" },
  label: { display: "block", fontSize: 11, letterSpacing: "0.2em", textTransform: "uppercase", color: "#666", marginBottom: 10, marginTop: 20 },
  catCard: { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6, padding: "14px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "flex-start", transition: "all 0.2s", color: "#e8e0d0", fontFamily: "Georgia, serif" },
  optionBtn: { background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 4, padding: "12px", cursor: "pointer", color: "#e8e0d0", fontFamily: "Georgia, serif", fontSize: 13, transition: "all 0.2s", textAlign: "center" },
  stepTitle: { fontSize: 28, fontWeight: 900, margin: "0 0 12px", letterSpacing: "-0.02em" },
  sectionTitle: { fontSize: 18, fontWeight: 700, margin: "0 0 16px", letterSpacing: "-0.01em" },
  errorBox: { background: "rgba(192,57,43,0.15)", border: "1px solid rgba(192,57,43,0.4)", borderRadius: 4, padding: "12px 16px", marginBottom: 20, fontSize: 14, color: "#e74c3c" },
  urgentBox: { background: "rgba(243,156,18,0.1)", border: "1px solid rgba(243,156,18,0.3)", borderRadius: 4, padding: "12px 16px", fontSize: 13, color: "#f39c12", lineHeight: 1.5 },
  spinner: { width: 48, height: 48, border: "2px solid rgba(192,57,43,0.2)", borderTop: "2px solid #c0392b", borderRadius: "50%", margin: "0 auto", animation: "spin 0.8s linear infinite" },
};
