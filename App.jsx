// use React globals instead of ES imports
const { useState, useEffect, useRef } = React;

// When running inside claude.ai artifacts, no API key is needed —
// requests go through the built-in proxy automatically.

// configuration: use local inference instead of Claude
const USE_LOCAL = true; // set false to use Anthropic
const LOCAL_URL = "http://127.0.0.1:5001/generate";
const LOCAL_ANALYZE = "http://127.0.0.1:5001/analyze";
const LOCAL_LETTER = "http://127.0.0.1:5001/generate-letter";
const LOCAL_EMAILS = "http://127.0.0.1:5001/generate-emails";
const LOCAL_CONTRACT_SCAN = "http://127.0.0.1:5001/contract-scan";
const API_URL = USE_LOCAL ? LOCAL_URL : "https://api.anthropic.com/v1/messages";
// store the API key in localStorage so user isn't prompted every time
let API_KEY = localStorage.getItem("sts_api_key") || "";

function ensureApiKey() {
  if (!API_KEY) {
    const key = window.prompt("Enter your Anthropic API key:");
    if (key && key.trim()) {
      API_KEY = key.trim();
      localStorage.setItem("sts_api_key", API_KEY);
    }
  }
}

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

function App() {
  const [screen, setScreen] = useState("home"); // home|intake|loading|results|cases|scanner
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
  const [contractText, setContractText] = useState("");
  const [contractType, setContractType] = useState("");
  const [contractResult, setContractResult] = useState(null);
  const [contractLoading, setContractLoading] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const [polishStep, setPolishStep] = useState(0);
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
    if (polishing) {
      const i = setInterval(() => setPolishStep(s => s + 1), 1200);
      return () => clearInterval(i);
    }
  }, [polishing]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const detectUrgency = (text) => {
    const lower = text.toLowerCase();
    return URGENCY_KEYWORDS.some(k => lower.includes(k));
  };

  const generateLetter = async () => {
    if (!activeCase && !results) return;
    const ctx = activeCase?.form || form;
    try {
      // optimistic UI
      setResults(r => ({ ...(r||{}), demandLetter: "Generating demand letter..." }));
      const resp = await fetch(LOCAL_LETTER, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: ctx.category, situation: ctx.situation, outcome: ctx.outcome, name: "[YOUR NAME]", address: "[YOUR ADDRESS]" })
      });
      if (!resp.ok) throw new Error(`Letter generation failed: ${resp.statusText}`);
      const j = await resp.json();
      const letter = j.letter || j.content || j;
      setResults(r => ({ ...(r||{}), demandLetter: letter }));
    } catch (e) {
      setError(`Failed to generate letter: ${e.message}`);
    }
  };

  const generateEmails = async () => {
    if (!activeCase && !results) return;
    const ctx = activeCase?.form || form;
    try {
      setResults(r => ({ ...(r||{}), emailSequence: [{ subject: "Generating...", body: "Please wait...", timing: "", tone: "", purpose: "" }] }));
      const resp = await fetch(LOCAL_EMAILS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: ctx.category, situation: ctx.situation, evidence: ctx.evidence, outcome: ctx.outcome, state: ctx.state })
      });
      if (!resp.ok) throw new Error(`Email generation failed: ${resp.statusText}`);
      const j = await resp.json();
      const emails = j.emailSequence || j;
      setResults(r => ({ ...(r||{}), emailSequence: emails }));
    } catch (e) {
      setError(`Failed to generate emails: ${e.message}`);
    }
  };


  const callClaude = async (messages, system, maxTokens = 3000) => {
    // if running locally we don't need API key or special headers
    let init = { method: "POST", headers: {"Content-Type": "application/json"} };
    if (!USE_LOCAL) {
      ensureApiKey();
      init.headers["anthropic-version"] = "2023-06-01";
      init.headers["anthropic-dangerous-direct-browser-access"] = "true";
      if (API_KEY) init.headers["x-api-key"] = API_KEY;
    }
    // attach body with prompt data
    init.body = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system,
      messages,
    });
    try {
      const res = await fetch(API_URL, init);
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error?.message || `API error ${res.status}`);
      // handle both Claude format (array) and local model format (string)
      let result = "";
      if (typeof data.content === "string") {
        result = data.content;
      } else if (Array.isArray(data.content)) {
        result = data.content.map(i => i.text || "").join("");
      } else {
        throw new Error("Unexpected response format from model");
      }
      return result;
    } catch (e) {
      console.error("fetch failed", e);
      throw new Error(`Failed to fetch from ${API_URL}: ${e.message || e}`);
    }
  };

  const buildCase = async () => {
    if (USE_LOCAL) {
      // quick ping to see if server is alive
      try {
        await fetch(LOCAL_ANALYZE, { method: "OPTIONS" });
      } catch (e) {
        setError(`Unable to reach local server at ${LOCAL_ANALYZE}. Make sure "python local_server.py" is running. (${e.message})`);
        setScreen("intake");
        return;
      }
    }

    setScreen("loading");
    setError("");
    try {
      if (USE_LOCAL) {
        // call local analyze endpoint for structured JSON
        const resp = await fetch(LOCAL_ANALYZE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: form.category, situation: form.situation, evidence: form.evidence, outcome: form.outcome, state: form.state })
        });
        if (!resp.ok) throw new Error(`Local analyze failed: ${resp.statusText}`);
        const parsed = await resp.json();

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
        setPolishing(true);
        setPolishStep(0);

        // Auto-generate high-quality demand letter and emails using dedicated endpoints
        const letterPromise = fetch(LOCAL_LETTER, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: form.category, situation: form.situation, outcome: form.outcome, name: "[YOUR NAME]", address: "[YOUR ADDRESS]" })
        }).then(r => r.json()).then(j => {
          const letter = j.letter || j.content || j;
          setResults(r => ({ ...(r||{}), demandLetter: letter }));
        }).catch(() => {});

        const emailsPromise = fetch(LOCAL_EMAILS, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category: form.category, situation: form.situation, evidence: form.evidence, outcome: form.outcome, state: form.state })
        }).then(r => r.json()).then(j => {
          const emails = j.emailSequence || j;
          setResults(r => ({ ...(r||{}), emailSequence: emails }));
        }).catch(() => {});

        Promise.all([letterPromise, emailsPromise]).finally(() => {
          setPolishing(false);
        });

        return;
      }

      // Non-local (Claude) path
      const prompt = `State: ${form.state || "Unknown"}\nCategory: ${form.category}\nSituation: ${form.situation}\nEvidence available: ${form.evidence || "None specified"}\nDesired outcome: ${form.outcome || "Fair resolution"}\nUrgency indicators: ${detectUrgency(form.situation) ? "YES - time sensitive language detected" : "No"}`;

      const text = await callClaude([{ role: "user", content: prompt }], SYSTEM_PROMPT, 8000);
      // parse Claude's JSON response
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
      let msg = e.message || "Something went wrong. Please try again.";
      if (msg.toLowerCase().includes("credit balance")) {
        msg += "\n\nYour Anthropic account may be out of credits. Visit https://console.anthropic.com/ to purchase more or upgrade your plan.";
      }
      setError(`Error: ${msg}`);
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
      let assistantResponse = "";
      if (USE_LOCAL) {
        // include system prompt + case context as system message
        const caseContext = (activeCase?.results?.summary || results?.summary || "");
        const systemMsg = { role: "system", content: CHAT_SYSTEM + "\n\nCase context: " + caseContext };
        const payload = { messages: [systemMsg, ...newMsgs] };
        const resp = await fetch(LOCAL_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!resp.ok) throw new Error(resp.statusText || "Local model error");
        const data = await resp.json();
        assistantResponse = data.content || String(data);
      } else {
        const caseContext = `Case context: ${JSON.stringify(activeCase?.results?.summary || results?.summary)}. Category: ${form.category}. State: ${form.state}.`;
        const text = await callClaude(
          newMsgs.map(m => ({ role: m.role, content: m.content })),
          CHAT_SYSTEM + "\n\n" + caseContext,
          1000
        );
        assistantResponse = text;
      }

      setChatMessages(m => [...m, { role: "assistant", content: assistantResponse }]);
    } catch(e) {
      setChatMessages(m => [...m, { role: "assistant", content: `Error: ${e.message}. Please try again.` }]);
    }
    setChatLoading(false);
  };

  const scanContract = async () => {
    if (!contractText.trim() || contractLoading) return;
    setContractLoading(true);
    setContractResult(null);
    try {
      const resp = await fetch(LOCAL_CONTRACT_SCAN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contract_text: contractText, contract_type: contractType })
      });
      if (!resp.ok) throw new Error(`Scan failed: ${resp.statusText}`);
      const data = await resp.json();
      setContractResult(data);
    } catch (e) {
      setError(`Contract scan failed: ${e.message}`);
    }
    setContractLoading(false);
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
    setContractResult(null);
    setContractText("");
    setContractType("");
  };

  const urgentDetected = detectUrgency(form.situation);

  // ─── SCREENS ───────────────────────────────────────────────────────────────

  // HOME
  if (screen === "home") return (
    <Shell>
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        {/* Nav */}
        <nav style={{ ...S.nav, background: "rgba(10,10,18,0.6)", borderBottom: "1px solid rgba(139,92,246,0.15)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Gavel size={20} />
            <span style={{ fontWeight: 800, fontSize: 17, letterSpacing: "-0.03em", background: "linear-gradient(135deg, #d4af37, #f0d060)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", fontFamily: "var(--font-heading)" }}>Sue the System</span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={() => setScreen("scanner")} style={S.navBtn}>🔍 Scam Scanner</button>
            {cases.length > 0 && <button onClick={() => setScreen("cases")} style={S.navBtn}>📂 My Cases ({cases.length})</button>}
          </div>
        </nav>

        {/* Hero */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "80px 24px 60px", textAlign: "center", position: "relative" }}>
          {/* Decorative gradient orbs */}
          <div style={{ position: "absolute", top: "10%", left: "15%", width: 300, height: 300, borderRadius: "50%", background: "radial-gradient(circle, rgba(139,92,246,0.15) 0%, transparent 70%)", filter: "blur(60px)", pointerEvents: "none", animation: "float 6s ease-in-out infinite" }} />
          <div style={{ position: "absolute", bottom: "20%", right: "10%", width: 250, height: 250, borderRadius: "50%", background: "radial-gradient(circle, rgba(59,130,246,0.12) 0%, transparent 70%)", filter: "blur(50px)", pointerEvents: "none", animation: "float 8s ease-in-out infinite 1s" }} />

          <div style={{ ...S.badge, position: "relative" }}>⚡ AI-Powered Legal Engine</div>
          <h1 style={{ fontSize: "clamp(48px, 9vw, 88px)", fontWeight: 900, margin: "0 0 24px", lineHeight: 0.95, letterSpacing: "-0.02em", color: "#ffffff", fontFamily: "var(--font-heading)" }}>
            They have lawyers.<br />
            <span style={{ background: "linear-gradient(135deg, #d4af37, #f0d060, #d4af37)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", filter: "drop-shadow(0 0 30px rgba(212,175,55,0.5))" }}>Now you do too.</span>
          </h1>
          <p style={{ maxWidth: 560, fontSize: 18, color: "var(--dim)", lineHeight: 1.7, marginBottom: 48 }}>
            Describe your situation. Get a demand letter, regulatory complaint, email sequence, and complete legal strategy — powered by AI. <strong style={{ color: "#d4af37" }}>100% free.</strong>
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center" }}>
            <button onClick={() => { setStep(1); setScreen("intake"); }} style={{ ...S.btn, fontSize: 16, padding: "18px 48px", borderRadius: 12, boxShadow: "0 8px 32px rgba(139,92,246,0.4), 0 0 60px rgba(139,92,246,0.15)" }}>
              ⚖️ Build My Case →
            </button>
            <button onClick={() => setScreen("scanner")} style={{ ...S.ghostBtn, fontSize: 16, padding: "18px 32px", borderRadius: 12, background: "rgba(239,68,68,0.1)", borderColor: "rgba(239,68,68,0.3)", color: "#fca5a5" }}>
              🔍 Scam Scanner
            </button>
            {cases.length > 0 && (
              <button onClick={() => setScreen("cases")} style={{ ...S.ghostBtn, fontSize: 16, padding: "18px 32px", borderRadius: 12 }}>
                📂 View Saved Cases
              </button>
            )}
          </div>

          {/* Stats */}
          <div style={{ display: "flex", gap: 48, marginTop: 72, flexWrap: "wrap", justifyContent: "center" }}>
            {[["8", "Categories"], ["5+", "Documents"], ["50", "US States"], ["$0", "Cost"]].map(([n, l]) => (
              <div key={l} style={{ textAlign: "center", animation: "fadeUp 0.5s ease" }}>
                <div style={{ fontSize: 36, fontWeight: 900, background: "linear-gradient(135deg, #d4af37, #f0d060)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", lineHeight: 1 }}>{n}</div>
                <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 6, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 600 }}>{l}</div>
              </div>
            ))}
          </div>

          {/* Categories grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, maxWidth: 860, width: "100%", marginTop: 72 }}>
            {CATEGORIES.map((c, idx) => (
              <button key={c.id} onClick={() => { setForm(f => ({ ...f, category: c.id })); setStep(1); setScreen("intake"); }}
                style={{ ...S.glassCard, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "flex-start", padding: "18px", border: "1px solid rgba(139,92,246,0.2)", animation: `fadeUp 0.4s ease ${idx * 0.05}s both`, position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 2, background: `linear-gradient(90deg, ${c.color}80, ${c.color}20)` }} />
                <span style={{ fontSize: 28, marginBottom: 8 }}>{c.icon}</span>
                <span style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, color: "#f0f0f5" }}>{c.label}</span>
                <span style={{ fontSize: 12, color: "var(--dim)", lineHeight: 1.5 }}>{c.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <footer style={{ textAlign: "center", padding: "24px", fontSize: 11, color: "#555570", borderTop: "1px solid rgba(139,92,246,0.1)" }}>
          ⚠️ Not legal advice. For informational purposes only. Consult a licensed attorney for serious matters.
        </footer>
      </div>
    </Shell>
  );

  // INTAKE WIZARD
  if (screen === "intake") return (
    <Shell>
      <div style={{ maxWidth: 720, margin: "0 auto", padding: "48px 24px", animation: "fadeUp 0.4s ease" }}>
        {/* Back + progress */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 48 }}>
          <button onClick={step === 1 ? resetToHome : () => setStep(s => s - 1)} style={{ ...S.backBtn, display: "flex", alignItems: "center", gap: 6 }}>← Back</button>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {[1, 2, 3, 4].map(i => (
              <React.Fragment key={i}>
                <div style={{
                  width: 36, height: 36, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
                  background: i < step ? "linear-gradient(135deg, #10b981, #06b6d4)" : i === step ? "linear-gradient(135deg, #8b5cf6, #3b82f6)" : "rgba(255,255,255,0.05)",
                  border: `2px solid ${i <= step ? "transparent" : "rgba(139,92,246,0.2)"}`,
                  fontSize: 13, fontWeight: 700, color: i <= step ? "#fff" : "var(--dim)",
                  boxShadow: i === step ? "0 0 20px rgba(139,92,246,0.4)" : "none",
                  transition: "all 0.3s ease"
                }}>
                  {i < step ? "✓" : i}
                </div>
                {i < 4 && <div style={{ width: 32, height: 2, borderRadius: 1, background: i < step ? "linear-gradient(90deg, #10b981, #06b6d4)" : "rgba(139,92,246,0.15)", transition: "all 0.3s" }} />}
              </React.Fragment>
            ))}
          </div>
          <span style={{ fontSize: 12, color: "var(--dim)", fontWeight: 600 }}>Step {step}/4</span>
        </div>

        {error && <div style={S.errorBox}>{error}</div>}

        {/* Step 1: Category + State */}
        {step === 1 && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <h2 style={{ ...S.stepTitle, fontSize: 32 }}>What system wronged you?</h2>
            <p style={{ color: "var(--dim)", marginBottom: 28, fontSize: 15, lineHeight: 1.6 }}>Select the category that best matches your situation.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginBottom: 32 }}>
              {CATEGORIES.map(c => (
                <button key={c.id} onClick={() => setForm(f => ({ ...f, category: c.id }))}
                  style={{
                    ...S.glassCard, cursor: "pointer", textAlign: "left", padding: 18,
                    borderColor: form.category === c.id ? c.color : "rgba(139,92,246,0.2)",
                    background: form.category === c.id ? `linear-gradient(135deg, ${c.color}25, ${c.color}10)` : "rgba(255,255,255,0.04)",
                    boxShadow: form.category === c.id ? `0 0 30px ${c.color}30, inset 0 1px 0 ${c.color}20` : "none",
                    position: "relative", overflow: "hidden"
                  }}>
                  {form.category === c.id && <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: c.color }} />}
                  <span style={{ fontSize: 28 }}>{c.icon}</span>
                  <div style={{ fontWeight: 700, fontSize: 14, marginTop: 10, color: form.category === c.id ? "#fff" : "#d0d0e0" }}>{c.label}</div>
                  <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4, lineHeight: 1.5 }}>{c.desc}</div>
                </button>
              ))}
            </div>
            <label style={S.label}>📍 Your State</label>
            <select value={form.state} onChange={e => setForm(f => ({ ...f, state: e.target.value }))} style={{ ...S.input, borderRadius: 10 }}>
              <option value="">Select state (optional but improves accuracy)</option>
              {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={() => setStep(2)} disabled={!form.category} style={{ ...S.btn, width: "100%", marginTop: 28, borderRadius: 12, fontSize: 15, padding: "16px" }}>
              Continue →
            </button>
          </div>
        )}

        {/* Step 2: Situation */}
        {step === 2 && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <h2 style={{ ...S.stepTitle, fontSize: 32 }}>What happened?</h2>
            <p style={{ color: "var(--dim)", marginBottom: 24, lineHeight: 1.7, fontSize: 15 }}>Be specific. Include dates, dollar amounts, names of companies or people, and what they said or did. <strong style={{ color: "#d4af37" }}>The more detail, the stronger your case.</strong></p>
            {urgentDetected && (
              <div style={{ ...S.urgentBox, marginBottom: 20, display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ fontSize: 18 }}>⚡</span>
                <div><strong>Urgency detected.</strong> Your description contains time-sensitive language. Include specific deadlines or dates you've been given.</div>
              </div>
            )}
            <textarea
              value={form.situation}
              onChange={e => setForm(f => ({ ...f, situation: e.target.value }))}
              placeholder={`Example: On March 1st, ${new Date().getFullYear()}, my insurance company (Blue Shield) denied my claim #12345 for an MRI that my doctor Dr. Smith ordered. They said it was "not medically necessary" even though my doctor submitted documentation showing I've had chronic back pain for 6 months...`}
              rows={8}
              style={{ ...S.input, resize: "vertical", lineHeight: 1.7, borderRadius: 12 }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
              <span style={{ fontSize: 12, color: form.situation.length < 100 ? "#fca5a5" : "#10b981", fontWeight: 600 }}>
                {form.situation.length < 100 ? `✍️ ${100 - form.situation.length} more characters recommended` : "✓ Good detail level"}
              </span>
              <span style={{ fontSize: 12, color: "var(--dim)" }}>{form.situation.length} chars</span>
            </div>
            <button onClick={() => setStep(3)} disabled={form.situation.length < 30} style={{ ...S.btn, width: "100%", marginTop: 24, borderRadius: 12, fontSize: 15, padding: "16px" }}>
              Continue →
            </button>
          </div>
        )}

        {/* Step 3: Evidence */}
        {step === 3 && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <h2 style={{ ...S.stepTitle, fontSize: 32 }}>What evidence do you have?</h2>
            <p style={{ color: "var(--dim)", marginBottom: 24, lineHeight: 1.7, fontSize: 15 }}>List any documents, photos, emails, receipts, or records. <strong style={{ color: "#d4af37" }}>Don't worry if you don't have much</strong> — we'll tell you what to gather.</p>
            <textarea
              value={form.evidence}
              onChange={e => setForm(f => ({ ...f, evidence: e.target.value }))}
              placeholder="e.g. Denial letter dated Feb 15, email chain with customer service, photos of the damage, doctor's prescription, pay stubs, lease agreement, receipts..."
              rows={5}
              style={{ ...S.input, resize: "vertical", lineHeight: 1.7, borderRadius: 12 }}
            />
            <button onClick={() => setStep(4)} style={{ ...S.btn, width: "100%", marginTop: 24, borderRadius: 12, fontSize: 15, padding: "16px" }}>
              Continue →
            </button>
            <button onClick={() => setStep(4)} style={{ ...S.ghostBtn, width: "100%", marginTop: 10, borderRadius: 12 }}>
              Skip — I'll figure this out later →
            </button>
          </div>
        )}

        {/* Step 4: Outcome */}
        {step === 4 && (
          <div style={{ animation: "fadeUp 0.3s ease" }}>
            <h2 style={{ ...S.stepTitle, fontSize: 32 }}>What outcome do you want?</h2>
            <p style={{ color: "var(--dim)", marginBottom: 24, lineHeight: 1.7, fontSize: 15 }}>Be specific. The AI will tailor your demand letter and strategy to this goal.</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 20 }}>
              {["Full refund / payment", "Claim approved", "Repairs completed", "Reinstatement", "Written apology", "Policy change"].map(o => (
                <button key={o} onClick={() => setForm(f => ({ ...f, outcome: o }))}
                  style={{
                    ...S.glassCard, cursor: "pointer", textAlign: "center", padding: "14px 16px", fontSize: 14, fontWeight: 600,
                    borderColor: form.outcome === o ? "#8b5cf6" : "rgba(139,92,246,0.2)",
                    background: form.outcome === o ? "linear-gradient(135deg, rgba(139,92,246,0.25), rgba(59,130,246,0.15))" : "rgba(255,255,255,0.04)",
                    boxShadow: form.outcome === o ? "0 0 24px rgba(139,92,246,0.25)" : "none",
                    color: form.outcome === o ? "#fff" : "#c0c0d0"
                  }}>
                  {o}
                </button>
              ))}
            </div>
            <input
              value={form.outcome}
              onChange={e => setForm(f => ({ ...f, outcome: e.target.value }))}
              placeholder="Or describe your own desired outcome..."
              style={{ ...S.input, borderRadius: 10 }}
            />
            <button onClick={buildCase} disabled={!form.outcome.trim()} style={{ ...S.btn, width: "100%", marginTop: 28, fontSize: 16, padding: "18px", borderRadius: 12, boxShadow: "0 8px 32px rgba(139,92,246,0.35)" }}>
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
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, position: "relative" }}>
        {/* Background glow */}
        <div style={{ position: "absolute", width: 400, height: 400, borderRadius: "50%", background: "radial-gradient(circle, rgba(139,92,246,0.15) 0%, transparent 70%)", filter: "blur(80px)", animation: "pulse 3s ease-in-out infinite" }} />

        <div style={{ textAlign: "center", animation: "fadeUp 0.3s ease", position: "relative" }}>
          {/* Animated spinner ring */}
          <div style={{ position: "relative", width: 80, height: 80, margin: "0 auto" }}>
            <div style={{ position: "absolute", inset: 0, border: "3px solid rgba(139,92,246,0.1)", borderRadius: "50%" }} />
            <div style={{ position: "absolute", inset: 0, border: "3px solid transparent", borderTopColor: "#8b5cf6", borderRightColor: "#3b82f6", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
            <div style={{ position: "absolute", inset: 8, border: "3px solid transparent", borderTopColor: "#06b6d4", borderRadius: "50%", animation: "spin 1.5s linear infinite reverse" }} />
            <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24 }}>⚖️</div>
          </div>

          <p style={{ fontSize: 24, fontWeight: 700, background: "linear-gradient(135deg, #c4b5fd, #818cf8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", marginBottom: 8, marginTop: 36 }}>{loadingMsgs[loadingMsg]}</p>
          <p style={{ fontSize: 14, color: "var(--dim)", marginBottom: 48 }}>Building your complete case file...</p>

          {/* Progress steps */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 320, margin: "0 auto" }}>
            {loadingMsgs.map((m, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, opacity: i <= loadingMsg ? 1 : 0.15, transition: "opacity 0.4s ease", animation: i === loadingMsg ? "fadeUp 0.3s ease" : "none" }}>
                <div style={{
                  width: 24, height: 24, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700,
                  background: i < loadingMsg ? "linear-gradient(135deg, #10b981, #06b6d4)" : i === loadingMsg ? "linear-gradient(135deg, #8b5cf6, #3b82f6)" : "rgba(255,255,255,0.05)",
                  color: i <= loadingMsg ? "#fff" : "var(--dim)",
                  boxShadow: i === loadingMsg ? "0 0 16px rgba(139,92,246,0.5)" : "none",
                  transition: "all 0.4s ease"
                }}>
                  {i < loadingMsg ? "✓" : i === loadingMsg ? "•" : ""}
                </div>
                <span style={{ fontSize: 13, color: i <= loadingMsg ? "#d0d0e0" : "var(--dim)", fontWeight: i === loadingMsg ? 600 : 400, transition: "all 0.3s" }}>{m}</span>
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
      { id: "overview", label: "Overview", icon: "📊" },
      { id: "rights", label: `Rights (${results.rights?.length || 0})`, icon: "⚖️" },
      { id: "letter", label: "Demand Letter", icon: "📝" },
      { id: "complaint", label: "Complaint", icon: "📋" },
      { id: "emails", label: `Emails (${results.emailSequence?.length || 0})`, icon: "📧" },
      { id: "counter", label: "Their Playbook", icon: "🎯" },
      { id: "settlement", label: "Settlement", icon: "💰" },
      { id: "agencies", label: "File With", icon: "🏛️" },
      { id: "evidence", label: "Evidence", icon: "🔍" },
      { id: "chat", label: "Ask AI", icon: "💬" },
    ];

    const urgencyColor = { low: "#10b981", medium: "#fbbf24", high: "#fb923c", critical: "#ef4444" }[results.urgencyLevel] || "var(--dim)";
    const scoreColor = results.strengthScore >= 70 ? "#10b981" : results.strengthScore >= 40 ? "#fbbf24" : "#ef4444";

    return (
      <Shell>
        {/* Polishing overlay — gavel animation while letter & emails generate */}
        {polishing && (
          <div style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(10,10,18,0.92)", backdropFilter: "blur(12px)",
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            animation: "fadeUp 0.3s ease"
          }}>
            {/* Swinging justice scale animation */}
            <div style={{ position: "relative", width: 160, height: 160, marginBottom: 32 }}>
              {/* Pivot point */}
              <div style={{
                position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
                width: 12, height: 12, borderRadius: "50%",
                background: "linear-gradient(135deg, #d4af37, #f0d060)",
                boxShadow: "0 0 16px rgba(212,175,55,0.6)",
                zIndex: 2
              }} />
              {/* Scale beam + pans — swings as one unit */}
              <div style={{
                position: "absolute", top: 14, left: "50%",
                transformOrigin: "0 0",
                animation: "scaleSwing 2.5s ease-in-out infinite",
              }}>
                {/* Beam */}
                <div style={{
                  position: "absolute", top: 0, left: "-60px",
                  width: 120, height: 4, borderRadius: 2,
                  background: "linear-gradient(90deg, #d4af37, #f0d060, #d4af37)",
                  boxShadow: "0 0 12px rgba(212,175,55,0.3)"
                }} />
                {/* Left chain */}
                <div style={{ position: "absolute", top: 4, left: "-55px", width: 2, height: 36, background: "linear-gradient(to bottom, #d4af37, #b8962e)", borderRadius: 1 }} />
                {/* Right chain */}
                <div style={{ position: "absolute", top: 4, left: "53px", width: 2, height: 36, background: "linear-gradient(to bottom, #d4af37, #b8962e)", borderRadius: 1 }} />
                {/* Left pan */}
                <div style={{
                  position: "absolute", top: 40, left: "-72px",
                  width: 36, height: 8, borderRadius: "0 0 50% 50%",
                  background: "linear-gradient(135deg, #d4af37, #c9a032)",
                  boxShadow: "0 4px 12px rgba(212,175,55,0.3)"
                }} />
                {/* Right pan */}
                <div style={{
                  position: "absolute", top: 40, left: "36px",
                  width: 36, height: 8, borderRadius: "0 0 50% 50%",
                  background: "linear-gradient(135deg, #d4af37, #c9a032)",
                  boxShadow: "0 4px 12px rgba(212,175,55,0.3)"
                }} />
              </div>
              {/* Pillar */}
              <div style={{
                position: "absolute", top: 16, left: "50%", transform: "translateX(-50%)",
                width: 4, height: 80, borderRadius: 2,
                background: "linear-gradient(to bottom, #d4af37, #8b6914)"
              }} />
              {/* Base */}
              <div style={{
                position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)",
                width: 56, height: 8, borderRadius: 4,
                background: "linear-gradient(135deg, #d4af37, #f0d060)",
                boxShadow: "0 4px 16px rgba(212,175,55,0.4)"
              }} />
              {/* Subtle glow */}
              <div style={{
                position: "absolute", top: "50%", left: "50%", transform: "translate(-50%,-50%)",
                width: 120, height: 120, borderRadius: "50%",
                background: "radial-gradient(circle, rgba(212,175,55,0.12) 0%, transparent 70%)",
                animation: "pulse 2s ease-in-out infinite"
              }} />
            </div>

            {/* Progress bar */}
            <div style={{ width: 280, marginBottom: 24 }}>
              <div style={{ height: 6, background: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{
                  height: "100%", borderRadius: 3,
                  background: "linear-gradient(90deg, #d4af37, #8b5cf6, #3b82f6)",
                  backgroundSize: "200% 100%",
                  animation: "shimmer 1.5s linear infinite",
                  width: `${Math.min(95, polishStep * 16)}%`,
                  transition: "width 1s ease"
                }} />
              </div>
            </div>

            <p style={{
              fontSize: 20, fontWeight: 700, marginBottom: 8,
              fontFamily: "var(--font-heading)",
              background: "linear-gradient(135deg, #d4af37, #f0d060)",
              WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent"
            }}>
              {["Crafting your demand letter...", "Building email sequence...", "Polishing legal language...", "Adding statutory citations...", "Finalizing your arsenal..."][Math.min(polishStep, 4)]}
            </p>
            <p style={{ fontSize: 13, color: "var(--dim)" }}>Making your documents attorney-quality</p>
          </div>
        )}
        <div style={{ animation: "fadeUp 0.4s ease" }}>
          {/* Top bar */}
          <div style={{ ...S.nav, position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(20px)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <button onClick={resetToHome} style={S.backBtn}>← Home</button>
              <span style={{ fontSize: 13, color: "var(--dim)" }}>|</span>
              <span style={{ fontSize: 14, fontWeight: 700, fontFamily: "var(--font-heading)" }}>{results.caseTitle || "Your Case"}</span>
              <div style={{ padding: "4px 12px", borderRadius: 20, background: `${urgencyColor}15`, border: `1px solid ${urgencyColor}40`, fontSize: 11, color: urgencyColor, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700 }}>
                {results.urgencyLevel}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setScreen("cases")} style={S.navBtn}>My Cases</button>
              <button onClick={() => { setStep(1); setScreen("intake"); setForm({ category: "", situation: "", evidence: "", outcome: "", state: "", urgency: "" }); }} style={S.navBtn}>+ New Case</button>
            </div>
          </div>

          {/* Main layout: content + laws sidebar */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 0, maxWidth: 1400, margin: "0 auto" }}>

            {/* LEFT: Main content */}
            <div style={{ padding: "32px 32px 32px 32px", borderRight: "1px solid rgba(139,92,246,0.15)" }}>

              {/* Hero stats row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 28 }}>
                {/* Strength Score */}
                <div style={{ ...S.glassCard, textAlign: "center", padding: "20px 12px", position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${scoreColor}, ${scoreColor}80)` }} />
                  <div style={{ fontSize: 36, fontWeight: 900, color: scoreColor, lineHeight: 1, textShadow: `0 0 30px ${scoreColor}60` }}>{results.strengthScore}%</div>
                  <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 6, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 600 }}>Case Strength</div>
                </div>
                {/* Settlement */}
                <div style={{ ...S.glassCard, textAlign: "center", padding: "20px 12px", position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #10b981, #10b98180)" }} />
                  <div style={{ fontSize: 36, fontWeight: 900, color: "#10b981", lineHeight: 1, textShadow: "0 0 30px rgba(16,185,129,0.6)" }}>{results.winProbability?.settlement || "—"}%</div>
                  <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 6, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 600 }}>Settlement</div>
                </div>
                {/* Full Win */}
                <div style={{ ...S.glassCard, textAlign: "center", padding: "20px 12px", position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #8b5cf6, #3b82f6)" }} />
                  <div style={{ fontSize: 36, fontWeight: 900, color: "#8b5cf6", lineHeight: 1, textShadow: "0 0 30px rgba(139,92,246,0.6)" }}>{results.winProbability?.fullWin || "—"}%</div>
                  <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 6, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 600 }}>Full Win</div>
                </div>
                {/* Urgency */}
                <div style={{ ...S.glassCard, textAlign: "center", padding: "20px 12px", position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${urgencyColor}, ${urgencyColor}80)` }} />
                  <div style={{ fontSize: 28, fontWeight: 900, color: urgencyColor, lineHeight: 1, textTransform: "capitalize", textShadow: `0 0 30px ${urgencyColor}60` }}>{results.urgencyLevel}</div>
                  <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 10, letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 600 }}>Urgency</div>
                </div>
              </div>

              {/* Summary */}
              <div style={{ ...S.glassCard, marginBottom: 24, padding: "20px 24px" }}>
                <p style={{ margin: 0, color: "#d0d0e0", lineHeight: 1.7, fontSize: 15 }}>{results.summary}</p>
                {(results.urgencyLevel === "high" || results.urgencyLevel === "critical") && results.urgencyNote && (
                  <div style={{ ...S.urgentBox, marginTop: 14 }}>⚡ {results.urgencyNote}</div>
                )}
                {results.winProbability?.note && (
                  <div style={{ marginTop: 12, fontSize: 13, color: "var(--dim)", fontStyle: "italic" }}>📌 {results.winProbability.note}</div>
                )}
              </div>

              {/* Tabs */}
              <div style={{ display: "flex", gap: 4, borderBottom: "1px solid rgba(139,92,246,0.2)", marginBottom: 28, overflowX: "auto", paddingBottom: 0 }}>
                {tabs.map(t => (
                  <button key={t.id} onClick={() => setActiveTab(t.id)}
                    style={{
                      background: activeTab === t.id ? "rgba(139,92,246,0.15)" : "none",
                      border: "none",
                      borderBottom: activeTab === t.id ? "2px solid #8b5cf6" : "2px solid transparent",
                      color: activeTab === t.id ? "#fff" : "var(--dim)",
                      padding: "12px 16px",
                      cursor: "pointer",
                      fontSize: 13,
                      fontFamily: "var(--font)",
                      whiteSpace: "nowrap",
                      transition: "all 0.2s",
                      borderRadius: "8px 8px 0 0",
                      fontWeight: activeTab === t.id ? 700 : 500,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}>
                    <span style={{ fontSize: 14 }}>{t.icon}</span> {t.label}
                  </button>
                ))}
              </div>

              {/* Tab content */}
              {activeTab === "overview" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16, animation: "fadeUp 0.3s ease" }}>
                  <h3 style={S.sectionTitle}>🚀 Next Steps</h3>
                  {results.nextSteps?.map((s, i) => (
                    <div key={i} style={{ ...S.glassCard, display: "flex", gap: 16, alignItems: "flex-start" }}>
                      <div style={{
                        width: 32, height: 32, borderRadius: 8,
                        background: s.importance === "critical" ? "linear-gradient(135deg, #ef4444, #dc2626)" : s.importance === "important" ? "linear-gradient(135deg, #fbbf24, #f59e0b)" : "rgba(255,255,255,0.1)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 14, fontWeight: 800, flexShrink: 0,
                        color: s.importance === "optional" ? "var(--dim)" : "white",
                        boxShadow: s.importance === "critical" ? "0 0 20px rgba(239,68,68,0.4)" : "none"
                      }}>{i + 1}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{s.step}</div>
                        <div style={{ fontSize: 13, color: "var(--dim)" }}>📅 {s.timeline}</div>
                      </div>
                      <div style={{
                        fontSize: 11, padding: "4px 10px", borderRadius: 6,
                        background: s.importance === "critical" ? "rgba(239,68,68,0.15)" : s.importance === "important" ? "rgba(251,191,36,0.15)" : "rgba(255,255,255,0.05)",
                        color: s.importance === "critical" ? "#fca5a5" : s.importance === "important" ? "#fcd34d" : "var(--dim)",
                        border: `1px solid ${s.importance === "critical" ? "rgba(239,68,68,0.3)" : s.importance === "important" ? "rgba(251,191,36,0.3)" : "var(--border)"}`,
                        textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 700
                      }}>{s.importance}</div>
                    </div>
                  ))}
                  <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
                    <button onClick={() => copy(`DEMAND LETTER:\n\n${results.demandLetter}\n\n---\n\nCOMPLAINT:\n\n${results.complaint}`, "all")} style={S.btn}>
                      {copied === "all" ? "✓ Copied!" : "📋 Copy All Documents"}
                    </button>
                    <button onClick={() => downloadDoc(`SUE THE SYSTEM — CASE FILE\n${"=".repeat(50)}\n\nCase: ${results.caseTitle}\nStrength: ${results.strengthScore}%\nSettlement Probability: ${results.winProbability?.settlement || "N/A"}%\nFull Win: ${results.winProbability?.fullWin || "N/A"}%\n\n${results.summary}\n\n${"=".repeat(50)}\nAPPLICABLE LAWS\n${"=".repeat(50)}\n\n${results.rights?.map(r => `• ${r.law} — ${r.title}: ${r.description}`).join("\n") || "N/A"}\n\n${"=".repeat(50)}\nDEMAND LETTER\n${"=".repeat(50)}\n\n${results.demandLetter}\n\n${"=".repeat(50)}\nREGULATORY COMPLAINT\n${"=".repeat(50)}\n\n${results.complaint}`, "case-file.txt")} style={S.ghostBtn}>
                      ⬇ Download Case File
                    </button>
                  </div>
                </div>
              )}

              {activeTab === "rights" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "fadeUp 0.3s ease" }}>
                  <h3 style={S.sectionTitle}>⚖️ Your Rights Being Violated</h3>
                  {results.rights?.map((r, i) => (
                    <div key={i} style={{ ...S.glassCard, borderLeft: `4px solid ${r.strength === "strong" ? "#8b5cf6" : r.strength === "moderate" ? "#fbbf24" : "#6b7280"}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
                        <div style={{ fontWeight: 700, fontSize: 16 }}>{r.title}</div>
                        <div style={{ display: "flex", gap: 8 }}>
                          <span style={{ fontSize: 11, color: "#a78bfa", background: "rgba(139,92,246,0.15)", padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(139,92,246,0.3)", fontWeight: 600 }}>📜 {r.law}</span>
                          <span style={{
                            fontSize: 11, padding: "4px 10px", borderRadius: 6,
                            background: r.strength === "strong" ? "rgba(16,185,129,0.15)" : r.strength === "moderate" ? "rgba(251,191,36,0.15)" : "rgba(255,255,255,0.05)",
                            border: `1px solid ${r.strength === "strong" ? "rgba(16,185,129,0.3)" : r.strength === "moderate" ? "rgba(251,191,36,0.3)" : "var(--border)"}`,
                            color: r.strength === "strong" ? "#10b981" : r.strength === "moderate" ? "#fbbf24" : "var(--dim)",
                            textTransform: "capitalize", fontWeight: 700
                          }}>{r.strength}</span>
                        </div>
                      </div>
                      <p style={{ margin: 0, fontSize: 14, color: "#b0b0c0", lineHeight: 1.7 }}>{r.description}</p>
                    </div>
                  ))}
                </div>
              )}

              {(activeTab === "letter" || activeTab === "complaint") && (
                <div style={{ animation: "fadeUp 0.3s ease" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                    <h3 style={{ ...S.sectionTitle, margin: 0 }}>{activeTab === "letter" ? "📝 Demand Letter" : "📋 Regulatory Complaint"}</h3>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button onClick={() => copy(activeTab === "letter" ? results.demandLetter : results.complaint, activeTab)} style={S.smallBtn}>
                        {copied === activeTab ? "✓ Copied" : "📋 Copy"}
                      </button>
                      <button onClick={() => downloadDoc(activeTab === "letter" ? results.demandLetter : results.complaint, `${activeTab}.txt`)} style={S.smallBtn}>⬇ Download</button>
                      {activeTab === "letter" && (
                        <button onClick={generateLetter} style={{ ...S.smallBtn, background: "linear-gradient(135deg, rgba(139,92,246,0.3), rgba(59,130,246,0.3))" }}>🔄 Regenerate with AI</button>
                      )}
                    </div>
                  </div>
                  <div style={{ ...S.glassCard, fontFamily: "'Courier New', monospace", fontSize: 13, lineHeight: 1.9, whiteSpace: "pre-wrap", color: "#d0d0e0", position: "relative" }}>
                    {activeTab === "letter" ? results.demandLetter : results.complaint}
                  </div>
                  <p style={{ fontSize: 12, color: "var(--dim)", marginTop: 12, fontStyle: "italic", display: "flex", alignItems: "center", gap: 6 }}>⚠️ Replace [BRACKETED] placeholders with your actual information before sending.</p>
                </div>
              )}

              {activeTab === "emails" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 20, animation: "fadeUp 0.3s ease" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <h3 style={S.sectionTitle}>📧 Email Escalation Sequence</h3>
                    <button onClick={generateEmails} style={{ ...S.smallBtn, background: "linear-gradient(135deg, rgba(139,92,246,0.3), rgba(59,130,246,0.3))" }}>🔄 Regenerate with AI</button>
                  </div>
                  {results.emailSequence?.map((e, i) => (
                    <div key={i} style={{ ...S.glassCard, position: "relative", overflow: "hidden" }}>
                      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: i === 0 ? "linear-gradient(90deg, #3b82f6, #8b5cf6)" : i === 1 ? "linear-gradient(90deg, #f59e0b, #ef4444)" : "linear-gradient(90deg, #ef4444, #dc2626)" }} />
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
                        <div>
                          <div style={{ display: "flex", gap: 8, marginBottom: 6 }}>
                            <span style={{ fontSize: 11, color: "#a78bfa", background: "rgba(139,92,246,0.15)", padding: "3px 10px", borderRadius: 20, fontWeight: 700, letterSpacing: "0.08em" }}>📅 {e.timing}</span>
                            <span style={{ fontSize: 11, color: "#fbbf24", background: "rgba(251,191,36,0.15)", padding: "3px 10px", borderRadius: 20, fontWeight: 700 }}>{e.tone}</span>
                          </div>
                          <div style={{ fontWeight: 800, fontSize: 16, marginTop: 4 }}>Subject: {e.subject}</div>
                          <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 4 }}>🎯 {e.purpose}</div>
                        </div>
                        <button onClick={() => copy(e.body, `email-${i}`)} style={S.smallBtn}>{copied === `email-${i}` ? "✓ Copied" : "📋 Copy"}</button>
                      </div>
                      <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 8, padding: "16px 20px", border: "1px solid rgba(255,255,255,0.05)" }}>
                        <pre style={{ margin: 0, fontSize: 13, lineHeight: 1.8, whiteSpace: "pre-wrap", color: "#c0c0d0", fontFamily: "inherit" }}>{e.body}</pre>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "counter" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16, animation: "fadeUp 0.3s ease" }}>
                  <h3 style={S.sectionTitle}>🎯 Their Likely Playbook — And Your Counter</h3>
                  {results.predictedResponses?.map((r, i) => (
                    <div key={i} style={S.glassCard}>
                      <div style={{ display: "flex", gap: 10, marginBottom: 14 }}>
                        <span style={{
                          fontSize: 11, padding: "4px 12px", borderRadius: 20, fontWeight: 700,
                          background: r.probability === "likely" ? "rgba(239,68,68,0.15)" : r.probability === "possible" ? "rgba(251,191,36,0.15)" : "rgba(255,255,255,0.05)",
                          border: `1px solid ${r.probability === "likely" ? "rgba(239,68,68,0.3)" : r.probability === "possible" ? "rgba(251,191,36,0.3)" : "var(--border)"}`,
                          color: r.probability === "likely" ? "#fca5a5" : r.probability === "possible" ? "#fcd34d" : "var(--dim)",
                          textTransform: "capitalize"
                        }}>{r.probability}</span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                        <div style={{ background: "rgba(239,68,68,0.06)", borderRadius: 8, padding: 16, border: "1px solid rgba(239,68,68,0.15)" }}>
                          <div style={{ fontSize: 11, color: "#ef4444", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 8, fontWeight: 700 }}>🗣️ They'll say</div>
                          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7, color: "#b0b0c0", fontStyle: "italic" }}>"{r.response}"</p>
                        </div>
                        <div style={{ background: "rgba(16,185,129,0.06)", borderRadius: 8, padding: 16, border: "1px solid rgba(16,185,129,0.15)" }}>
                          <div style={{ fontSize: 11, color: "#10b981", textTransform: "uppercase", letterSpacing: "0.12em", marginBottom: 8, fontWeight: 700 }}>💪 You respond</div>
                          <p style={{ margin: 0, fontSize: 14, lineHeight: 1.7 }}>{r.counter}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "settlement" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 16, animation: "fadeUp 0.3s ease" }}>
                  <h3 style={S.sectionTitle}>💰 Settlement Estimate</h3>
                  {results.settlementEstimate ? (
                    <>
                      <div style={{ ...S.glassCard, position: "relative", overflow: "hidden" }}>
                        <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #d4af37, #f59e0b)" }} />
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, marginBottom: 20 }}>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700 }}>Low End</div>
                            <div style={{ fontSize: 32, fontWeight: 900, color: "#fbbf24" }}>${(results.settlementEstimate.lowRange || 0).toLocaleString()}</div>
                          </div>
                          <div style={{ textAlign: "center", position: "relative" }}>
                            <div style={{ position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)", fontSize: 10, color: "#d4af37", background: "rgba(212,175,55,0.15)", padding: "2px 10px", borderRadius: 10, fontWeight: 800, letterSpacing: "0.1em" }}>LIKELY</div>
                            <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 6, marginTop: 6, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700 }}>Median</div>
                            <div style={{ fontSize: 42, fontWeight: 900, color: "#10b981", textShadow: "0 0 30px rgba(16,185,129,0.5)" }}>${(results.settlementEstimate.median || 0).toLocaleString()}</div>
                          </div>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 12, color: "var(--dim)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700 }}>High End</div>
                            <div style={{ fontSize: 32, fontWeight: 900, color: "#8b5cf6" }}>${(results.settlementEstimate.highRange || 0).toLocaleString()}</div>
                          </div>
                        </div>
                        {/* Range bar */}
                        <div style={{ position: "relative", height: 12, background: "rgba(255,255,255,0.06)", borderRadius: 6, overflow: "hidden", marginBottom: 16 }}>
                          <div style={{ position: "absolute", top: 0, left: "10%", right: "10%", bottom: 0, background: "linear-gradient(90deg, #fbbf24, #10b981, #8b5cf6)", borderRadius: 6, opacity: 0.7 }} />
                          <div style={{ position: "absolute", top: -4, left: "45%", width: 4, height: 20, background: "#fff", borderRadius: 2, boxShadow: "0 0 10px rgba(255,255,255,0.5)" }} />
                        </div>
                        <p style={{ margin: 0, fontSize: 14, color: "#b0b0c0", lineHeight: 1.7, fontStyle: "italic" }}>📊 {results.settlementEstimate.basis}</p>
                      </div>
                      {results.settlementEstimate.factors?.length > 0 && (
                        <div style={S.glassCard}>
                          <h4 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>📋 Factors Affecting Your Value</h4>
                          {results.settlementEstimate.factors.map((f, i) => (
                            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "10px 0", borderBottom: i < results.settlementEstimate.factors.length - 1 ? "1px solid rgba(139,92,246,0.15)" : "none" }}>
                              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#d4af37", flexShrink: 0 }} />
                              <span style={{ fontSize: 14, color: "#d0d0e0" }}>{f}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div style={{ ...S.glassCard, textAlign: "center", padding: 48 }}>
                      <div style={{ fontSize: 40, marginBottom: 12 }}>💰</div>
                      <p style={{ color: "var(--dim)" }}>Settlement estimate not available for this case.</p>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "agencies" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 14, animation: "fadeUp 0.3s ease" }}>
                  <h3 style={S.sectionTitle}>🏛️ Where to File Your Complaint</h3>
                  {results.filingAgencies?.map((a, i) => (
                    <div key={i} style={S.glassCard}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: 10 }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 16 }}>{a.name}</div>
                          <div style={{ fontSize: 13, color: "var(--dim)", marginTop: 4 }}>{a.jurisdiction} · {a.why}</div>
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {a.deadline && <span style={{ fontSize: 11, color: "#ef4444", background: "rgba(239,68,68,0.12)", padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(239,68,68,0.25)", fontWeight: 700 }}>⏰ {a.deadline}</span>}
                          {a.feeWaiver && <span style={{ fontSize: 11, color: "#10b981", background: "rgba(16,185,129,0.12)", padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(16,185,129,0.25)", fontWeight: 700 }}>✅ Fee Waiver</span>}
                        </div>
                      </div>
                      <a href={a.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: "#8b5cf6", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                        🔗 {a.url} →
                      </a>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "evidence" && (
                <div style={{ display: "flex", flexDirection: "column", gap: 12, animation: "fadeUp 0.3s ease" }}>
                  <h3 style={S.sectionTitle}>🔍 Evidence Checklist</h3>
                  <p style={{ color: "var(--dim)", fontSize: 14, marginBottom: 12 }}>Gather these before sending your demand letter to maximize leverage.</p>
                  {results.evidenceChecklist?.map((e, i) => (
                    <div key={i} style={{ ...S.glassCard, display: "flex", gap: 14, alignItems: "flex-start" }}>
                      <div style={{
                        width: 12, height: 12, borderRadius: "50%", flexShrink: 0, marginTop: 4,
                        background: e.priority === "essential" ? "#ef4444" : e.priority === "helpful" ? "#fbbf24" : "#6b7280",
                        boxShadow: e.priority === "essential" ? "0 0 10px rgba(239,68,68,0.5)" : "none"
                      }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{e.item}</div>
                        <div style={{ fontSize: 13, color: "var(--dim)", lineHeight: 1.6 }}>{e.why}</div>
                      </div>
                      <span style={{
                        fontSize: 11, padding: "4px 10px", borderRadius: 6,
                        background: e.priority === "essential" ? "rgba(239,68,68,0.12)" : e.priority === "helpful" ? "rgba(251,191,36,0.12)" : "rgba(255,255,255,0.05)",
                        border: `1px solid ${e.priority === "essential" ? "rgba(239,68,68,0.25)" : e.priority === "helpful" ? "rgba(251,191,36,0.25)" : "var(--border)"}`,
                        color: e.priority === "essential" ? "#fca5a5" : e.priority === "helpful" ? "#fcd34d" : "var(--dim)",
                        textTransform: "capitalize", whiteSpace: "nowrap", fontWeight: 700
                      }}>{e.priority}</span>
                    </div>
                  ))}
                </div>
              )}

              {activeTab === "chat" && (
                <div style={{ display: "flex", flexDirection: "column", height: "60vh", animation: "fadeUp 0.3s ease" }}>
                  <h3 style={{ ...S.sectionTitle, marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>💬 Ask Your AI Legal Advisor</h3>
                  <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12, paddingBottom: 16 }}>
                    {chatMessages.map((m, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", animation: "fadeUp 0.2s ease" }}>
                        <div style={{
                          maxWidth: "80%", padding: "14px 18px", borderRadius: 16,
                          background: m.role === "user" ? "linear-gradient(135deg, #8b5cf6, #3b82f6)" : "rgba(255,255,255,0.08)",
                          border: m.role === "assistant" ? "1px solid rgba(139,92,246,0.2)" : "none",
                          fontSize: 14, lineHeight: 1.7, color: "#f0f0f0",
                          borderBottomRightRadius: m.role === "user" ? 4 : 16,
                          borderBottomLeftRadius: m.role === "assistant" ? 4 : 16,
                          whiteSpace: "pre-wrap",
                          boxShadow: m.role === "user" ? "0 4px 12px rgba(139,92,246,0.3)" : "none",
                        }}>{m.content}</div>
                      </div>
                    ))}
                    {chatLoading && (
                      <div style={{ display: "flex", justifyContent: "flex-start" }}>
                        <div style={{ ...S.glassCard, padding: "14px 20px", fontSize: 14 }}>
                          <span style={{ animation: "pulse 1s infinite" }}>🤔 Analyzing...</span>
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
                      placeholder="Ask about your case..."
                      style={{ ...S.input, flex: 1, margin: 0, borderRadius: 12 }}
                      disabled={chatLoading}
                    />
                    <button onClick={sendChat} disabled={!chatInput.trim() || chatLoading} style={{ ...S.btn, padding: "14px 24px", whiteSpace: "nowrap", borderRadius: 12 }}>Send →</button>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                    {["What's my strongest argument?", "How do I send this letter?", "What if they ignore me?", "Do I need a lawyer?"].map(q => (
                      <button key={q} onClick={() => { setChatInput(q); }} style={{ ...S.smallBtn, fontSize: 11, borderRadius: 20 }}>{q}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* RIGHT SIDEBAR: Applicable Laws */}
            <div style={{ padding: "32px 24px", position: "sticky", top: 80, height: "calc(100vh - 80px)", overflowY: "auto" }}>
              {/* Laws Box */}
              <div style={{ ...S.glassCard, marginBottom: 16, padding: "20px", position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #8b5cf6, #3b82f6, #06b6d4)" }} />
                <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 800, letterSpacing: "-0.01em", display: "flex", alignItems: "center", gap: 8 }}>
                  📜 Applicable Laws
                </h3>
                {results.rights?.length > 0 ? results.rights.map((r, i) => (
                  <div key={i} style={{ padding: "12px 0", borderBottom: i < results.rights.length - 1 ? "1px solid rgba(139,92,246,0.15)" : "none" }}>
                    <div style={{ fontSize: 12, color: "#a78bfa", fontWeight: 700, marginBottom: 4, letterSpacing: "0.02em" }}>{r.law}</div>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{r.title}</div>
                    <div style={{ fontSize: 12, color: "var(--dim)", lineHeight: 1.5 }}>{r.description}</div>
                    <div style={{
                      fontSize: 10, marginTop: 6, padding: "2px 8px", borderRadius: 4, display: "inline-block",
                      background: r.strength === "strong" ? "rgba(16,185,129,0.15)" : r.strength === "moderate" ? "rgba(251,191,36,0.15)" : "rgba(255,255,255,0.05)",
                      color: r.strength === "strong" ? "#10b981" : r.strength === "moderate" ? "#fbbf24" : "var(--dim)",
                      fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em"
                    }}>{r.strength}</div>
                  </div>
                )) : (
                  <p style={{ fontSize: 13, color: "var(--dim)" }}>No specific laws identified yet.</p>
                )}
              </div>

              {/* Strength Gauge */}
              <div style={{ ...S.glassCard, textAlign: "center", padding: "24px 20px", marginBottom: 16, position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${scoreColor}, ${scoreColor}80)` }} />
                <svg width="120" height="120" style={{ transform: "rotate(-90deg)" }}>
                  <circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="10" />
                  <circle cx="60" cy="60" r="50" fill="none" stroke={scoreColor} strokeWidth="10"
                    strokeDasharray={`${2 * Math.PI * 50 * results.strengthScore / 100} ${2 * Math.PI * 50 * (1 - results.strengthScore / 100)}`}
                    strokeLinecap="round" style={{ transition: "stroke-dasharray 1.5s ease", filter: `drop-shadow(0 0 10px ${scoreColor}60)` }} />
                </svg>
                <div style={{ marginTop: -80, marginBottom: 36, fontSize: 28, fontWeight: 900, color: scoreColor, textShadow: `0 0 25px ${scoreColor}60` }}>{results.strengthScore}%</div>
                <div style={{ fontSize: 11, color: "var(--dim)", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700 }}>Case Strength</div>
                <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 8, lineHeight: 1.5 }}>{results.strengthReason}</div>
              </div>

              {/* Settlement Widget */}
              {results.settlementEstimate && (
                <div style={{ ...S.glassCard, padding: "20px", marginBottom: 16, position: "relative", overflow: "hidden", cursor: "pointer" }} onClick={() => setActiveTab("settlement")}>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #d4af37, #f0d060)" }} />
                  <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 800, display: "flex", alignItems: "center", gap: 8 }}>💰 Est. Value</h3>
                  <div style={{ textAlign: "center" }}>
                    <div style={{ fontSize: 28, fontWeight: 900, color: "#10b981", lineHeight: 1 }}>${(results.settlementEstimate.median || 0).toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: "var(--dim)", marginTop: 6, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 700 }}>Median</div>
                    <div style={{ fontSize: 12, color: "var(--dim)", marginTop: 6 }}>${(results.settlementEstimate.lowRange || 0).toLocaleString()} – ${(results.settlementEstimate.highRange || 0).toLocaleString()}</div>
                  </div>
                </div>
              )}

              {/* Quick Actions */}
              <div style={{ ...S.glassCard, padding: "20px", marginBottom: 16, position: "relative", overflow: "hidden" }}>
                <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #10b981, #06b6d4)" }} />
                <h3 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 800, display: "flex", alignItems: "center", gap: 8 }}>⚡ Quick Actions</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <button onClick={() => setActiveTab("letter")} style={{ ...S.sidebarBtn }}>📝 View Demand Letter</button>
                  <button onClick={() => setActiveTab("emails")} style={{ ...S.sidebarBtn }}>📧 View Email Sequence</button>
                  <button onClick={() => setActiveTab("settlement")} style={{ ...S.sidebarBtn }}>💰 Settlement Estimate</button>
                  <button onClick={() => setActiveTab("chat")} style={{ ...S.sidebarBtn }}>💬 Ask AI Advisor</button>
                  <button onClick={() => copy(`DEMAND LETTER:\n\n${results.demandLetter}\n\n---\n\nCOMPLAINT:\n\n${results.complaint}`, "sidebar-all")} style={{ ...S.sidebarBtn }}>
                    {copied === "sidebar-all" ? "✓ Copied!" : "📋 Copy All Docs"}
                  </button>
                </div>
              </div>

              {/* Filing Agencies summary */}
              {results.filingAgencies?.length > 0 && (
                <div style={{ ...S.glassCard, padding: "20px", position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: "linear-gradient(90deg, #f59e0b, #ef4444)" }} />
                  <h3 style={{ margin: "0 0 14px", fontSize: 14, fontWeight: 800, display: "flex", alignItems: "center", gap: 8 }}>🏛️ File Complaints At</h3>
                  {results.filingAgencies.map((a, i) => (
                    <div key={i} style={{ padding: "8px 0", borderBottom: i < results.filingAgencies.length - 1 ? "1px solid rgba(139,92,246,0.15)" : "none" }}>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{a.name}</div>
                      <div style={{ fontSize: 11, color: "var(--dim)", marginTop: 2 }}>{a.jurisdiction}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </Shell>
    );
  }

  // CASES
  if (screen === "cases") return (
    <Shell>
      <div style={{ maxWidth: 860, margin: "0 auto", padding: "48px 24px", animation: "fadeUp 0.4s ease" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 36 }}>
          <div>
            <button onClick={resetToHome} style={{ ...S.backBtn, marginBottom: 12 }}>← Home</button>
            <h2 style={{ margin: "0 0 6px", fontSize: 32, fontWeight: 900, letterSpacing: "-0.03em", fontFamily: "var(--font-heading)" }}>📂 My Cases</h2>
            <p style={{ margin: 0, color: "var(--dim)", fontSize: 14 }}>{cases.length} saved case{cases.length !== 1 ? "s" : ""}</p>
          </div>
          <button onClick={() => { setStep(1); setScreen("intake"); }} style={{ ...S.btn, borderRadius: 10 }}>+ New Case</button>
        </div>
        {cases.length === 0 ? (
          <div style={{ ...S.glassCard, textAlign: "center", padding: "64px 32px" }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>⚖️</div>
            <h3 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>No cases yet</h3>
            <p style={{ color: "var(--dim)", marginBottom: 24, fontSize: 15 }}>Build your first case to get started.</p>
            <button onClick={() => { setStep(1); setScreen("intake"); }} style={{ ...S.btn, borderRadius: 10 }}>Build Your First Case →</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {cases.map((c, idx) => {
              const cat = CATEGORIES.find(x => x.id === c.form.category);
              const sColor = c.results.strengthScore >= 70 ? "#10b981" : c.results.strengthScore >= 40 ? "#fbbf24" : "#ef4444";
              return (
                <button key={c.id} onClick={() => openCase(c)}
                  style={{ ...S.glassCard, textAlign: "left", cursor: "pointer", display: "flex", gap: 20, alignItems: "center", animation: `fadeUp 0.3s ease ${idx * 0.05}s both`, position: "relative", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, bottom: 0, width: 4, background: `linear-gradient(180deg, ${sColor}, ${sColor}40)` }} />
                  <div style={{ width: 48, height: 48, borderRadius: 12, background: `${cat?.color || "#8b5cf6"}20`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 24, flexShrink: 0 }}>
                    {cat?.icon || "⚖️"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{c.results.caseTitle}</div>
                    <div style={{ fontSize: 13, color: "var(--dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.form.situation.substring(0, 100)}...</div>
                    <div style={{ fontSize: 11, color: "#555570", marginTop: 6 }}>{new Date(c.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</div>
                  </div>
                  <div style={{ textAlign: "center", flexShrink: 0, padding: "8px 16px", borderRadius: 10, background: `${sColor}12`, border: `1px solid ${sColor}30` }}>
                    <div style={{ fontSize: 24, fontWeight: 900, color: sColor, lineHeight: 1 }}>{c.results.strengthScore}%</div>
                    <div style={{ fontSize: 10, color: "var(--dim)", letterSpacing: "0.12em", marginTop: 4, fontWeight: 700 }}>STRENGTH</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Shell>
  );

  // CONTRACT SCAM SCANNER
  if (screen === "scanner") return (
    <Shell>
      <div style={{ maxWidth: 900, margin: "0 auto", padding: "48px 24px", animation: "fadeUp 0.4s ease" }}>
        <button onClick={resetToHome} style={{ ...S.backBtn, marginBottom: 24 }}>← Home</button>
        <div style={{ textAlign: "center", marginBottom: 40 }}>
          <div style={{ ...S.badge }}>🔍 AI Contract Scanner</div>
          <h2 style={{ fontSize: 36, fontWeight: 900, margin: "0 0 12px", letterSpacing: "-0.03em", fontFamily: "var(--font-heading)" }}>Am I Being Scammed?</h2>
          <p style={{ color: "var(--dim)", fontSize: 16, maxWidth: 540, margin: "0 auto", lineHeight: 1.7 }}>Paste any contract, terms of service, lease, or agreement. AI will flag every predatory clause <span style={{ color: "#ef4444", fontWeight: 700 }}>in red</span> before you sign.</p>
        </div>

        {!contractResult ? (
          <div style={{ ...S.glassCard, padding: 32 }}>
            <label style={S.label}>📄 Document Type</label>
            <select value={contractType} onChange={e => setContractType(e.target.value)} style={{ ...S.input, borderRadius: 10, marginBottom: 20 }}>
              <option value="">Select type (optional)</option>
              <option value="lease">Lease / Rental Agreement</option>
              <option value="employment">Employment Contract</option>
              <option value="terms_of_service">Terms of Service</option>
              <option value="loan">Loan / Financing Agreement</option>
              <option value="insurance">Insurance Policy</option>
              <option value="nda">NDA / Non-Compete</option>
              <option value="settlement">Settlement Agreement</option>
              <option value="other">Other</option>
            </select>

            <label style={S.label}>📋 Paste the Document</label>
            <textarea
              value={contractText}
              onChange={e => setContractText(e.target.value)}
              placeholder="Paste the full contract, terms of service, lease agreement, or any document you want scanned for predatory clauses..."
              rows={14}
              style={{ ...S.input, resize: "vertical", lineHeight: 1.7, borderRadius: 12 }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10, marginBottom: 20 }}>
              <span style={{ fontSize: 12, color: contractText.length < 100 ? "#fca5a5" : "#10b981", fontWeight: 600 }}>
                {contractText.length < 100 ? `📝 ${100 - contractText.length} more characters recommended` : "✓ Enough text to analyze"}
              </span>
              <span style={{ fontSize: 12, color: "var(--dim)" }}>{contractText.length} chars</span>
            </div>
            <button onClick={scanContract} disabled={contractText.length < 50 || contractLoading}
              style={{ ...S.btn, width: "100%", fontSize: 16, padding: "18px", borderRadius: 12, boxShadow: "0 8px 32px rgba(239,68,68,0.3)", background: "linear-gradient(135deg, #ef4444 0%, #dc2626 100%)" }}>
              {contractLoading ? "🔍 Scanning for red flags..." : "🔍 Scan for Predatory Clauses"}
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {/* Verdict Header */}
            <div style={{ ...S.glassCard, textAlign: "center", padding: "32px 24px", position: "relative", overflow: "hidden" }}>
              <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 4, background: contractResult.verdict === "danger" ? "linear-gradient(90deg, #ef4444, #dc2626)" : contractResult.verdict === "caution" ? "linear-gradient(90deg, #fbbf24, #f59e0b)" : "linear-gradient(90deg, #10b981, #06b6d4)" }} />
              <div style={{ fontSize: 56, marginBottom: 8 }}>{contractResult.verdict === "danger" ? "🚨" : contractResult.verdict === "caution" ? "⚠️" : "✅"}</div>
              <div style={{
                fontSize: 28, fontWeight: 900, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8,
                color: contractResult.verdict === "danger" ? "#ef4444" : contractResult.verdict === "caution" ? "#fbbf24" : "#10b981"
              }}>{contractResult.verdict === "danger" ? "DANGER — DO NOT SIGN" : contractResult.verdict === "caution" ? "CAUTION — REVIEW CAREFULLY" : "LOOKS SAFE"}</div>
              <div style={{ fontSize: 42, fontWeight: 900, color: contractResult.verdict === "danger" ? "#ef4444" : contractResult.verdict === "caution" ? "#fbbf24" : "#10b981", marginBottom: 8 }}>{contractResult.riskScore}/100 Risk</div>
              <p style={{ margin: 0, fontSize: 15, color: "#b0b0c0", lineHeight: 1.7, maxWidth: 600, marginLeft: "auto", marginRight: "auto" }}>{contractResult.summary}</p>
            </div>

            {/* Red Flags */}
            {contractResult.redFlags?.length > 0 && (
              <div>
                <h3 style={{ ...S.sectionTitle, color: "#ef4444" }}>🚩 Red Flags ({contractResult.redFlags.length})</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {contractResult.redFlags.map((flag, i) => (
                    <div key={i} style={{ ...S.glassCard, borderLeft: `4px solid ${flag.severity === "critical" ? "#ef4444" : flag.severity === "warning" ? "#fbbf24" : "#3b82f6"}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                        <span style={{
                          fontSize: 11, padding: "4px 12px", borderRadius: 20, fontWeight: 700, textTransform: "uppercase",
                          background: flag.severity === "critical" ? "rgba(239,68,68,0.15)" : flag.severity === "warning" ? "rgba(251,191,36,0.15)" : "rgba(59,130,246,0.15)",
                          color: flag.severity === "critical" ? "#fca5a5" : flag.severity === "warning" ? "#fcd34d" : "#93c5fd",
                          border: `1px solid ${flag.severity === "critical" ? "rgba(239,68,68,0.3)" : flag.severity === "warning" ? "rgba(251,191,36,0.3)" : "rgba(59,130,246,0.3)"}`
                        }}>{flag.severity}</span>
                        {flag.law && <span style={{ fontSize: 11, color: "#a78bfa", background: "rgba(139,92,246,0.15)", padding: "4px 10px", borderRadius: 20, fontWeight: 600 }}>📜 {flag.law}</span>}
                      </div>
                      <div style={{ background: "rgba(239,68,68,0.06)", borderRadius: 8, padding: 14, marginBottom: 12, border: "1px solid rgba(239,68,68,0.15)" }}>
                        <p style={{ margin: 0, fontSize: 14, color: "#fca5a5", lineHeight: 1.6, fontStyle: "italic" }}>"{flag.clause}"</p>
                      </div>
                      <p style={{ margin: "0 0 8px", fontSize: 14, color: "#d0d0e0", lineHeight: 1.6 }}><strong>Issue:</strong> {flag.issue}</p>
                      <p style={{ margin: 0, fontSize: 13, color: "#10b981", lineHeight: 1.6 }}>💡 {flag.advice}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Green Flags */}
            {contractResult.greenFlags?.length > 0 && (
              <div>
                <h3 style={{ ...S.sectionTitle, color: "#10b981" }}>✅ Good Clauses</h3>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {contractResult.greenFlags.map((g, i) => (
                    <div key={i} style={{ ...S.glassCard, borderLeft: "4px solid #10b981" }}>
                      <p style={{ margin: "0 0 6px", fontSize: 14, color: "#a7f3d0", fontStyle: "italic" }}>"{g.clause}"</p>
                      <p style={{ margin: 0, fontSize: 13, color: "var(--dim)" }}>{g.why}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Missing + Tips grid */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {contractResult.missingProtections?.length > 0 && (
                <div style={S.glassCard}>
                  <h4 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14, color: "#fbbf24" }}>⚠️ Missing Protections</h4>
                  {contractResult.missingProtections.map((m, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 0", borderBottom: i < contractResult.missingProtections.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
                      <span style={{ color: "#fbbf24", flexShrink: 0 }}>•</span>
                      <span style={{ fontSize: 13, color: "#d0d0e0", lineHeight: 1.5 }}>{m}</span>
                    </div>
                  ))}
                </div>
              )}
              {contractResult.negotiationTips?.length > 0 && (
                <div style={S.glassCard}>
                  <h4 style={{ fontSize: 15, fontWeight: 700, marginBottom: 14, color: "#8b5cf6" }}>💬 Negotiation Tips</h4>
                  {contractResult.negotiationTips.map((t, i) => (
                    <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 0", borderBottom: i < contractResult.negotiationTips.length - 1 ? "1px solid rgba(255,255,255,0.05)" : "none" }}>
                      <span style={{ color: "#8b5cf6", flexShrink: 0 }}>{i + 1}.</span>
                      <span style={{ fontSize: 13, color: "#d0d0e0", lineHeight: 1.5 }}>{t}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Scan Again */}
            <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 16 }}>
              <button onClick={() => { setContractResult(null); setContractText(""); setContractType(""); }} style={{ ...S.btn, background: "linear-gradient(135deg, #ef4444, #dc2626)" }}>🔍 Scan Another Document</button>
              <button onClick={resetToHome} style={S.ghostBtn}>← Back to Home</button>
            </div>
          </div>
        )}
      </div>
    </Shell>
  );

  return null;
}

// expose App globally for browser script
window.App = App;
// automatically render once loaded
ReactDOM.createRoot(document.getElementById('root')).render(<App />);

// ─── SHARED COMPONENTS ─────────────────────────────────────────────────────

function Shell({ children }) {
  return (
    <div style={{
      minHeight: "100vh", background: "var(--bg)", color: "var(--text)",
      fontFamily: "var(--font)",
      overflowX: "hidden",
      maxWidth: "100vw",
      "--bg": "#0a0a12",
      "--card": "rgba(255,255,255,0.06)",
      "--border": "rgba(139,92,246,0.25)",
      "--text": "#f0f0f5",
      "--dim": "#8888a0",
      "--primary": "#8b5cf6",
      "--secondary": "#3b82f6",
      "--accent": "#06b6d4",
      "--green": "#10b981",
      "--font": "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      "--font-heading": "'Playfair Display', Georgia, 'Times New Roman', serif",
      "--gold": "#d4af37",
      "--gold-light": "#f0d060",
    }}>
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", zIndex: 0, background: "radial-gradient(ellipse at 20% 20%, rgba(139,92,246,0.12) 0%, transparent 50%), radial-gradient(ellipse at 80% 80%, rgba(59,130,246,0.08) 0%, transparent 50%), radial-gradient(ellipse at 50% 50%, rgba(6,182,212,0.05) 0%, transparent 60%)" }} />
      <div style={{ position: "relative", zIndex: 1 }}>{children}</div>
      <style>{`
        * { box-sizing: border-box; margin: 0; }
        html { scroll-behavior: smooth; }
        body { background: #0a0a12; }
        @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slideIn { from { opacity: 0; transform: translateX(-16px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.6} }
        @keyframes glow { 0%,100%{box-shadow: 0 0 20px rgba(139,92,246,0.25)} 50%{box-shadow: 0 0 40px rgba(139,92,246,0.45)} }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        @keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-6px)} }
        @keyframes scaleSwing {
          0% { transform: rotate(0deg); }
          25% { transform: rotate(18deg); }
          50% { transform: rotate(0deg); }
          75% { transform: rotate(-18deg); }
          100% { transform: rotate(0deg); }
        }
        input:focus, textarea:focus, select:focus { outline: none; border-color: #8b5cf6 !important; box-shadow: 0 0 0 3px rgba(139,92,246,0.15), 0 0 20px rgba(139,92,246,0.1); }
        textarea::placeholder, input::placeholder { color: #555570; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(139,92,246,0.35); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(139,92,246,0.55); }
        button { transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1); }
        button:hover { transform: translateY(-1px); }
        button:active { transform: translateY(0); }
        a { transition: color 0.2s; }
        a:hover { text-decoration: underline; }
        ::selection { background: rgba(139,92,246,0.3); }
      `}</style>
    </div>
  );
}

function Gavel({ size = 32 }) {
  return <span style={{ fontSize: size * 0.6, display: "inline-block" }}>⚖️</span>;
}

// ─── STYLES ────────────────────────────────────────────────────────────────

const S = {
  hero: { fontSize: "clamp(40px, 8vw, 80px)", fontWeight: 900, margin: "0 0 16px", lineHeight: 0.95, letterSpacing: "-0.03em", color: "#ffffff", textShadow: "0 0 40px rgba(139,92,246,0.5)" },
  sub: { fontSize: 16, color: "var(--dim)", lineHeight: 1.7, margin: "0 auto" },
  badge: { display: "inline-block", background: "linear-gradient(135deg, rgba(212,175,55,0.2), rgba(240,208,96,0.15))", border: "1px solid rgba(212,175,55,0.5)", borderRadius: 20, padding: "6px 16px", fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", color: "#d4af37", marginBottom: 20, animation: "glow 3s ease-in-out infinite" },
  nav: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderBottom: "1px solid rgba(139,92,246,0.2)", background: "rgba(15,12,41,0.8)", backdropFilter: "blur(10px)" },
  navBtn: { background: "rgba(139,92,246,0.15)", border: "1px solid rgba(139,92,246,0.3)", borderRadius: 8, padding: "8px 16px", color: "#a78bfa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 },
  backBtn: { background: "none", border: "none", color: "var(--dim)", fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: "4px 0", fontWeight: 500 },
  card: { background: "rgba(255,255,255,0.08)", border: "1px solid rgba(139,92,246,0.3)", borderRadius: 12, padding: "20px", backdropFilter: "blur(10px)", boxShadow: "0 4px 6px rgba(0,0,0,0.1)" },
  btn: { background: "linear-gradient(135deg, #8b5cf6 0%, #3b82f6 100%)", border: "none", borderRadius: 8, color: "white", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", padding: "14px 24px", letterSpacing: "0.02em", boxShadow: "0 4px 12px rgba(139,92,246,0.4)" },
  ghostBtn: { background: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.3)", borderRadius: 8, color: "#a78bfa", fontSize: 13, cursor: "pointer", fontFamily: "inherit", padding: "12px 20px", fontWeight: 600 },
  smallBtn: { background: "rgba(139,92,246,0.15)", border: "1px solid rgba(139,92,246,0.3)", borderRadius: 6, color: "#a78bfa", fontSize: 12, cursor: "pointer", fontFamily: "inherit", padding: "6px 12px", fontWeight: 600 },
  input: { width: "100%", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(139,92,246,0.3)", borderRadius: 8, padding: "14px 16px", color: "var(--text)", fontSize: 14, fontFamily: "inherit", transition: "all 0.2s" },
  label: { display: "block", fontSize: 11, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--dim)", marginBottom: 10, marginTop: 20, fontWeight: 600 },
  catCard: { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(139,92,246,0.3)", borderRadius: 12, padding: "14px", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "flex-start", transition: "all 0.3s", color: "var(--text)", fontFamily: "inherit" },
  optionBtn: { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(139,92,246,0.3)", borderRadius: 8, padding: "12px", cursor: "pointer", color: "var(--text)", fontFamily: "inherit", fontSize: 13, transition: "all 0.3s", textAlign: "center", fontWeight: 500 },
  stepTitle: { fontSize: 28, fontWeight: 900, margin: "0 0 12px", letterSpacing: "-0.02em", color: "#ffffff", fontFamily: "var(--font-heading)" },
  sectionTitle: { fontSize: 18, fontWeight: 700, margin: "0 0 16px", letterSpacing: "-0.01em", color: "#ffffff", fontFamily: "var(--font-heading)" },
  errorBox: { background: "rgba(239,68,68,0.15)", border: "1px solid rgba(239,68,68,0.4)", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 14, color: "#fca5a5" },
  urgentBox: { background: "rgba(251,191,36,0.15)", border: "1px solid rgba(251,191,36,0.4)", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#fcd34d", lineHeight: 1.5 },
  spinner: { width: 48, height: 48, border: "3px solid rgba(139,92,246,0.2)", borderTop: "3px solid #8b5cf6", borderRadius: "50%", margin: "0 auto", animation: "spin 0.8s linear infinite" },
  glassCard: { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(139,92,246,0.25)", borderRadius: 14, padding: "20px", backdropFilter: "blur(12px)", boxShadow: "0 8px 32px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.05)", transition: "all 0.3s ease" },
  sidebarBtn: { width: "100%", background: "rgba(139,92,246,0.1)", border: "1px solid rgba(139,92,246,0.25)", borderRadius: 8, padding: "10px 14px", color: "#c4b5fd", fontSize: 13, cursor: "pointer", fontFamily: "inherit", fontWeight: 600, textAlign: "left", transition: "all 0.2s" },
};
