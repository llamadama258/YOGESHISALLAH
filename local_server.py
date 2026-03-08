from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import json
import os
import uvicorn
from pathlib import Path

# Load .env file
env_path = Path(".env")
if env_path.exists():
    try:
        from dotenv import load_dotenv
        load_dotenv(env_path)
    except ImportError:
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, value = line.split("=", 1)
                    os.environ.setdefault(key.strip(), value.strip())

# Initialize Featherless/OpenAI client
from openai import OpenAI

FEATHERLESS_API_KEY = os.getenv("FEATHERLESS_API_KEY", "")
FEATHERLESS_MODEL = os.getenv("FEATHERLESS_MODEL", "Qwen/Qwen2.5-7B-Instruct")

ai_client = OpenAI(
    api_key=FEATHERLESS_API_KEY,
    base_url="https://api.featherless.ai/v1"
)

print(f"Using Featherless model: {FEATHERLESS_MODEL}")

app = FastAPI()

# allow requests from file:// and localhost
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

class Message(BaseModel):
    role: str
    content: str

class GenRequest(BaseModel):
    messages: list[Message]


class AnalyzeRequest(BaseModel):
    category: str = ""
    situation: str = ""
    evidence: str = ""
    outcome: str = ""
    state: str = ""


class LetterRequest(BaseModel):
    category: str = ""
    situation: str = ""
    outcome: str = ""
    name: str = "[YOUR NAME]"
    address: str = "[YOUR ADDRESS]"

class ContractScanRequest(BaseModel):
    contract_text: str = ""
    contract_type: str = ""  # terms_of_service, lease, employment, loan, etc.

def call_ai(system_prompt: str, user_prompt: str, max_tokens: int = 4096) -> str:
    """Call Featherless AI and return the response text."""
    response = ai_client.chat.completions.create(
        model=FEATHERLESS_MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        max_tokens=max_tokens,
        temperature=float(os.getenv("TEMPERATURE", "0.7")),
    )
    return response.choices[0].message.content


@app.post("/generate")
async def generate(req: GenRequest):
    if not req.messages:
        return {"content": "Please ask a question."}

    # Build messages list for the AI
    messages = []
    for m in req.messages:
        messages.append({"role": m.role, "content": m.content})

    try:
        response = ai_client.chat.completions.create(
            model=FEATHERLESS_MODEL,
            messages=messages,
            max_tokens=int(os.getenv("MAX_TOKENS", "4096")),
            temperature=float(os.getenv("TEMPERATURE", "0.7")),
        )
        text = response.choices[0].message.content
        return {"content": text}
    except Exception as e:
        print(f"AI error in /generate: {e}")
        return {"content": f"Error generating response: {str(e)}"}


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    system_prompt = """You are a brilliant legal strategist with deep expertise in consumer protection, tenant rights, employment law, healthcare, education, and civil rights across all US states.

CRITICAL INSTRUCTIONS FOR STRENGTH SCORE:
You must carefully evaluate the case and assign an ACCURATE strengthScore (0-100) based on:
- Quality and quantity of evidence (documents, witnesses, records)
- Clarity and severity of the legal violation
- Applicable laws and how strongly they support the claim
- Jurisdiction-specific precedents and protections
- How clearly damages can be proven
- Whether the situation has urgency or statute of limitations concerns

Score guide:
- 90-100: Slam dunk — clear violation with strong evidence and well-established law
- 70-89: Strong case — good evidence, clear legal basis, likely to succeed
- 50-69: Moderate — some evidence, arguable legal basis, could go either way
- 30-49: Weak — limited evidence, unclear legal basis, uphill battle
- 0-29: Very weak — minimal evidence, questionable legal grounds

Do NOT default to generic scores. Analyze the SPECIFIC facts given.

Respond ONLY with a valid JSON object. No markdown, no backticks, no preamble. Pure JSON.

{
  "caseTitle": "Short title max 6 words",
  "strengthScore": 82,
  "strengthReason": "One sentence explaining why this specific score",
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
  "winProbability": {"settlement": 75, "fullWin": 45, "note": "Brief note explaining probability"},
  "settlementEstimate": {
    "lowRange": 2000,
    "highRange": 15000,
    "median": 6500,
    "basis": "Based on similar cases in this jurisdiction under the applicable statutes",
    "factors": ["Factor 1 affecting value", "Factor 2", "Factor 3"]
  },
  "statuteOfLimitations": {
    "deadline": "YYYY-MM-DD",
    "daysRemaining": 365,
    "statute": "Specific statute name and code section with limitation period",
    "warning": "Actionable warning about the deadline"
  },
  "escalationPlan": [
    {"level": 1, "action": "Step name", "description": "What to do", "timeline": "When", "status": "current|ready|standby|nuclear"}
  ]
}"""

    user_prompt = f"""Analyze this legal case thoroughly. Calculate an ACCURATE strength score based on the specific facts, evidence, and applicable laws. Do NOT guess — evaluate the real legal merits.

Category: {req.category}
State: {req.state}
Situation: {req.situation}
Evidence available: {req.evidence or 'None specified'}
Desired outcome: {req.outcome}"""

    # Try up to 2 times to get valid JSON from the AI
    for attempt in range(2):
        try:
            text = call_ai(system_prompt, user_prompt)

            # Extract JSON from response (handle markdown code blocks)
            clean = text.strip()
            if clean.startswith("```"):
                lines = clean.split("\n")
                lines = [l for l in lines if not l.strip().startswith("```")]
                clean = "\n".join(lines)

            first = clean.find("{")
            last = clean.rfind("}")
            if first != -1 and last != -1 and last > first:
                candidate = clean[first:last+1]
                parsed = json.loads(candidate)
                # Validate that strengthScore exists and is a number
                if "strengthScore" in parsed:
                    parsed["strengthScore"] = int(parsed["strengthScore"])
                    parsed["strengthScore"] = max(0, min(100, parsed["strengthScore"]))
                return parsed

            print(f"Attempt {attempt+1}: Could not find JSON in AI response, retrying...")

        except json.JSONDecodeError as e:
            print(f"Attempt {attempt+1}: JSON parse error: {e}")
        except Exception as e:
            print(f"Attempt {attempt+1}: AI error: {e}")
            break  # Don't retry on connection/auth errors

    # If both AI attempts fail, use AI for just the score as a last resort
    try:
        score_text = call_ai(
            "You are a legal expert. Return ONLY a number 0-100 representing the case strength. Nothing else, just the number.",
            f"Rate this case strength 0-100:\nCategory: {req.category}\nState: {req.state}\nSituation: {req.situation}\nEvidence: {req.evidence or 'None'}",
            max_tokens=10
        )
        score = int(''.join(c for c in score_text.strip() if c.isdigit())[:3])
        score = max(0, min(100, score))
    except Exception:
        score = 50

    fallback = _fallback_analysis(req)
    fallback["strengthScore"] = score
    fallback["strengthReason"] = "Score calculated by AI based on case facts."
    fallback["winProbability"] = {
        "settlement": int(min(95, score + 10)),
        "fullWin": int(max(5, score - 20)),
        "note": "AI-estimated based on case details"
    }
    return fallback


def _fallback_analysis(req: AnalyzeRequest) -> dict:
    """Fallback when AI response can't be parsed."""
    score = 50
    if req.evidence and len(req.evidence.strip()) > 10:
        score += 15
    if any(w in (req.outcome or "").lower() for w in ["money", "refund", "compens", "repair", "settle"]):
        score += 10
    strength = max(5, min(95, score))

    return {
        "caseTitle": f"{req.category or 'Case'} Claim",
        "strengthScore": int(strength),
        "strengthReason": "Automated estimate based on provided facts and available evidence.",
        "urgencyLevel": "medium",
        "urgencyNote": "",
        "summary": (req.situation or "").strip()[:240],
        "rights": [{"title": "Right to Remedy", "description": "Right to a remedy for harm", "law": "State law", "strength": "moderate"}],
        "evidenceChecklist": [{"item": "Documentation of incident", "why": "Establishes timeline and facts", "priority": "essential"}],
        "demandLetter": f"[YOUR NAME]\n[YOUR ADDRESS]\n[DATE]\n\n[RECIPIENT NAME]\n[RECIPIENT ADDRESS]\n\nRe: Demand for Resolution - {req.category}\n\nDear [RECIPIENT NAME],\n\nI am writing regarding the following: {req.situation}\n\nI request: {req.outcome}. Please respond within 14 days.\n\nSincerely,\n[YOUR NAME]",
        "complaint": f"Complaint: {req.situation}\nRequested relief: {req.outcome}",
        "emailSequence": [{"subject": "Request for Resolution", "body": "Please contact me within 5 business days to resolve this matter.", "timing": "Day 1", "tone": "Professional", "purpose": "Initial outreach"}],
        "predictedResponses": [{"response": "We deny liability.", "counter": "Provide evidence and cite the relevant law.", "probability": "possible"}],
        "filingAgencies": [{"name": "State Attorney General", "jurisdiction": "State", "url": "https://www.atg.state", "deadline": "", "why": "Consumer protection", "feeWaiver": False}],
        "nextSteps": [{"step": "Gather documents", "timeline": "This week", "importance": "critical"}],
        "winProbability": {"settlement": int(min(90, strength + 10)), "fullWin": int(max(10, strength - 20)), "note": "Estimated"},
        "settlementEstimate": {
            "lowRange": 1000,
            "highRange": 10000,
            "median": 4000,
            "basis": "General estimate based on category and jurisdiction",
            "factors": ["Evidence strength", "Applicable state laws", "Documented damages"]
        },
        "statuteOfLimitations": {
            "deadline": "2026-06-01",
            "daysRemaining": 365,
            "statute": "Check your state's specific statute of limitations for this category",
            "warning": "Consult an attorney to confirm the exact deadline for your case"
        },
        "escalationPlan": [
            {"level": 1, "action": "Demand Letter", "description": "Send formal demand letter via certified mail", "timeline": "Week 1", "status": "current"},
            {"level": 2, "action": "Regulatory Complaint", "description": "File complaint with relevant state agency", "timeline": "Week 3", "status": "ready"},
            {"level": 3, "action": "Small Claims Court", "description": "File in small claims court if under the limit", "timeline": "Month 2", "status": "standby"},
            {"level": 4, "action": "State Attorney General", "description": "File consumer protection complaint with state AG", "timeline": "Month 3", "status": "standby"},
            {"level": 5, "action": "Federal Complaint", "description": "File with relevant federal agency if applicable", "timeline": "Month 4", "status": "standby"},
            {"level": 6, "action": "Media Pressure", "description": "Draft press release and contact consumer reporters", "timeline": "Month 5", "status": "nuclear"},
            {"level": 7, "action": "Social Media Campaign", "description": "Prepare public accountability campaign", "timeline": "Month 6", "status": "nuclear"}
        ]
    }


@app.post("/generate-letter")
async def generate_letter(req: LetterRequest):
    system_prompt = """You are an expert legal document writer. Write formal, attorney-quality demand letters that are firm, professional, and cite relevant laws. Always include placeholders: [YOUR NAME], [YOUR ADDRESS], [DATE], [RECIPIENT NAME], [RECIPIENT ADDRESS]. Give a 14-day deadline and state consequences of non-compliance."""

    user_prompt = f"""Write a formal demand letter for this case:

Category: {req.category}
Situation: {req.situation}
Requested outcome: {req.outcome}
Sender name: {req.name}
Sender address: {req.address}

Write the complete letter now. Be specific about legal violations and remedies."""

    try:
        letter = call_ai(system_prompt, user_prompt)
        return {"letter": letter}
    except Exception as e:
        print(f"AI error in /generate-letter: {e}")
        # Fallback template
        letter = f"{req.name}\n{req.address}\n[DATE]\n\n[RECIPIENT NAME]\n[RECIPIENT ADDRESS]\n\nRe: Demand for Resolution - {req.category}\n\nDear [RECIPIENT NAME],\n\n{req.situation}\n\nI demand: {req.outcome}. Please respond within 14 days. If you fail to respond, I will consider further legal action.\n\nSincerely,\n{req.name}"
        return {"letter": letter}


@app.post("/generate-emails")
async def generate_emails(req: AnalyzeRequest):
    system_prompt = """You are an expert at writing escalation email sequences for legal disputes. Write professional, firm emails that progressively escalate.

Respond ONLY with a valid JSON array. No markdown, no backticks, no preamble. Pure JSON array.

Each object must have: "subject", "body", "timing", "tone", "purpose"."""

    user_prompt = f"""Generate a sequence of 3 escalation emails for this case:

Category: {req.category}
State: {req.state}
Situation: {req.situation}
Evidence: {req.evidence}
Desired outcome: {req.outcome}

Email 1: Professional initial outreach (Day 1)
Email 2: Firm follow-up with deadline (Day 7)
Email 3: Final notice with legal consequences (Day 14)

Return ONLY the JSON array."""

    try:
        text = call_ai(system_prompt, user_prompt)

        # Clean up markdown code blocks if present
        clean = text.strip()
        if clean.startswith("```"):
            lines = clean.split("\n")
            lines = [l for l in lines if not l.strip().startswith("```")]
            clean = "\n".join(lines)

        first = clean.find("[")
        last = clean.rfind("]")
        if first != -1 and last != -1 and last > first:
            candidate = clean[first:last+1]
            emails = json.loads(candidate)
            return {"emailSequence": emails}

        print(f"Warning: Could not parse email JSON, returning fallback")
        return {"emailSequence": _fallback_emails()}
    except Exception as e:
        print(f"AI error in /generate-emails: {e}")
        return {"emailSequence": _fallback_emails()}


def _fallback_emails():
    return [
        {"subject": "Request for Resolution", "body": "Hello,\n\nI am writing to request resolution of the matter described above. Please contact me within 5 business days.", "timing": "Day 1", "tone": "Professional", "purpose": "Initial outreach"},
        {"subject": "Follow-up: Request for Resolution", "body": "This is a follow-up to my previous request. We expect a response within 7 days.", "timing": "Day 7", "tone": "Firm", "purpose": "Follow-up"},
        {"subject": "Final Notice before Further Action", "body": "This is the final notice. If we do not hear from you in 14 days, we will escalate to the appropriate agencies and consider legal action.", "timing": "Day 14", "tone": "Firm", "purpose": "Final notice"}
    ]


@app.post("/contract-scan")
async def contract_scan(req: ContractScanRequest):
    system_prompt = """You are a consumer protection attorney who specializes in identifying predatory, unfair, and deceptive clauses in contracts, terms of service, leases, loan agreements, and other legal documents.

Analyze the provided document and flag every problematic clause.

Respond ONLY with a valid JSON object. No markdown, no backticks, no preamble. Pure JSON.

{
  "verdict": "safe|caution|danger",
  "riskScore": 72,
  "summary": "One paragraph overall assessment",
  "redFlags": [
    {
      "clause": "Exact quote or paraphrase of the problematic text",
      "issue": "Why this is problematic in plain English",
      "severity": "critical|warning|info",
      "law": "Relevant consumer protection law if applicable",
      "advice": "What to do about it — negotiate, refuse, or watch out"
    }
  ],
  "greenFlags": [
    {
      "clause": "Quote of a fair/good clause",
      "why": "Why this is good for you"
    }
  ],
  "missingProtections": [
    "Important clause or protection that SHOULD be in this contract but isn't"
  ],
  "negotiationTips": [
    "Specific thing you could ask to change before signing"
  ]
}"""

    user_prompt = f"""Scan this {req.contract_type or 'contract'} for predatory, unfair, or deceptive clauses. Flag everything problematic.

Document text:
---
{req.contract_text[:8000]}
---

Analyze every clause. Be thorough and specific."""

    for attempt in range(2):
        try:
            text = call_ai(system_prompt, user_prompt)
            clean = text.strip()
            if clean.startswith("```"):
                lines = clean.split("\n")
                lines = [l for l in lines if not l.strip().startswith("```")]
                clean = "\n".join(lines)

            first = clean.find("{")
            last = clean.rfind("}")
            if first != -1 and last != -1 and last > first:
                candidate = clean[first:last+1]
                parsed = json.loads(candidate)
                return parsed

            print(f"Contract scan attempt {attempt+1}: Could not find JSON")
        except json.JSONDecodeError as e:
            print(f"Contract scan attempt {attempt+1}: JSON parse error: {e}")
        except Exception as e:
            print(f"Contract scan attempt {attempt+1}: AI error: {e}")
            break

    return {
        "verdict": "caution",
        "riskScore": 50,
        "summary": "Unable to fully analyze the document. Please try again or paste a shorter section.",
        "redFlags": [],
        "greenFlags": [],
        "missingProtections": ["Could not analyze — try again"],
        "negotiationTips": ["Have a lawyer review before signing"]
    }


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=5001)
