from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import pipeline
import json
import uvicorn

app = FastAPI()

# allow requests from file:// and localhost
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Use better free models - Flan-T5-Large for better quality
# chat generator (fallback)
try:
    chat_generator = pipeline("text-generation", "gpt2")
except Exception as e:
    print(f"GPT-2 failed to load: {e}")
    chat_generator = None

# analyzer: instruction-tuned text2text model for structured outputs
# Using flan-t5-large instead of base for much better quality
try:
    print("Loading Flan-T5-Large model (this may take a minute first time)...")
    analyzer = pipeline("text2text-generation", "google/flan-t5-large")
    print("Model loaded successfully!")
except Exception as e:
    print(f"flan-t5-large model failed to load: {e}")
    print("Falling back to flan-t5-base...")
    try:
        analyzer = pipeline("text2text-generation", "google/flan-t5-base")
    except:
        print("Falling back to GPT-2 text-generation for analysis (lower quality)")
        analyzer = None

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

@app.post("/generate")
async def generate(req: GenRequest):
    # Accept conversation messages. If an instruction model is available, use it
    if not req.messages:
        return {"content": "Please ask a question."}

    # Build prompt: include any system message + last user message
    system_parts = [m.content for m in req.messages if m.role == "system"]
    system_ctx = "\n".join(system_parts)
    user_question = req.messages[-1].content

    if analyzer is not None:
        prompt = f"""
You are a helpful legal advisor. Answer the user's question directly and concisely. Use the case context below when relevant.

Case context:
{system_ctx}

Question: {user_question}

Answer:
"""
        out = analyzer(prompt, max_length=256)
        text = out[0]["generated_text"].strip()
        return {"content": text}
    else:
        # fallback to GPT-2 style completion
        prompt = f"Q: {user_question}\nA: Based on legal guidelines, "
        out = chat_generator(prompt, max_length=200, do_sample=True, temperature=0.8, top_p=0.9)
        response = out[0]["generated_text"]
        if "A: " in response:
            response = response.split("A: ")[-1].strip()
        sentences = response.split(". ")
        if len(sentences) > 1 and len(sentences[-1]) < 10:
            response = ". ".join(sentences[:-1]) + "."
        return {"content": response}


@app.post("/analyze")
async def analyze(req: AnalyzeRequest):
    # Build a clear instruction to return strict JSON
    prompt = f"""
Analyze this case and RETURN ONLY A SINGLE VALID JSON OBJECT with the keys:
caseTitle,strengthScore,strengthReason,urgencyLevel,urgencyNote,summary,rights,evidenceChecklist,demandLetter,complaint,emailSequence,predictedResponses,filingAgencies,nextSteps,winProbability

Case details:
Category: {req.category}
State: {req.state}
Situation: {req.situation}
Evidence: {req.evidence}
Desired outcome: {req.outcome}

Produce short, factual values. strengthScore must be an integer 0-100. demandLetter should be a full letter including [YOUR NAME], [YOUR ADDRESS], [DATE], [RECIPIENT NAME], [RECIPIENT ADDRESS].
"""

    # If instruction-tuned model available, use it
    if analyzer is not None:
        out = analyzer(prompt, max_length=1024, do_sample=True, temperature=0.7)
        text = out[0]["generated_text"]
    else:
        # fallback: simple heuristic analyzer
        text = None

    # Try to extract JSON from model output
    if text:
        first = text.find("{")
        last = text.rfind("}")
        if first != -1 and last != -1 and last > first:
            candidate = text[first:last+1]
            try:
                parsed = json.loads(candidate)
                return parsed
            except Exception:
                pass

    # Fallback heuristic when model isn't available or JSON parse fails
    # Simple scoring: base 50, +15 if evidence present, +10 if outcome is monetary, -10 if vague
    score = 50
    if req.evidence and req.evidence.strip() and len(req.evidence.strip()) > 10:
        score += 15
    if any(w in (req.outcome or "").lower() for w in ["money","refund","compens","repair","settle"]):
        score += 10
    if len((req.situation or "").split()) < 8:
        score -= 10

    strength = max(5, min(95, score))

    parsed = {
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
        "filingAgencies": [{"name": "State Attorney General", "jurisdiction": "State", "url": "https://www.atg.state", "deadline": "", "why": "Consumer protection" , "feeWaiver": False}],
        "nextSteps": [{"step": "Gather documents", "timeline": "This week", "importance": "critical"}],
        "winProbability": {"settlement": int(min(90, strength+10)), "fullWin": int(max(10, strength-20)), "note": "Estimated"}
    }

    return parsed


@app.post("/generate-letter")
async def generate_letter(req: LetterRequest):
    # Attempt to produce a polished demand letter
    prompt = f"""
Write a formal demand letter using the details below. Include [YOUR NAME], [YOUR ADDRESS], [DATE], [RECIPIENT NAME], [RECIPIENT ADDRESS]. Use a firm professional tone and give a 14-day deadline. Be concise but include legal remedies if they don't comply.

Category: {req.category}
Situation: {req.situation}
Requested outcome: {req.outcome}
Sender name: {req.name}
Sender address: {req.address}
"""

    if analyzer is not None:
        out = analyzer(prompt, max_length=512)
        text = out[0]["generated_text"]
        # If the model echoes the prompt, try to strip up to start of letter
        if "[YOUR NAME]" in text:
            # assume model returned letter directly
            return {"letter": text}
        return {"letter": text}
    else:
        # fallback simple templated letter
        letter = f"{req.name}\n{req.address}\n[DATE]\n\n[RECIPIENT NAME]\n[RECIPIENT ADDRESS]\n\nRe: Demand for Resolution - {req.category}\n\nDear [RECIPIENT NAME],\n\n{req.situation}\n\nI demand: {req.outcome}. Please respond within 14 days. If you fail to respond, I will consider further legal action.\n\nSincerely,\n{req.name}"
        return {"letter": letter}


@app.post("/generate-emails")
async def generate_emails(req: AnalyzeRequest):
    prompt = f"""
Generate a JSON array named emailSequence of 3 email objects suitable for this case. Each object should have: subject, body, timing, tone, purpose.

Case details:
Category: {req.category}
State: {req.state}
Situation: {req.situation}
Evidence: {req.evidence}
Desired outcome: {req.outcome}

Return ONLY valid JSON for the array.
"""

    if analyzer is not None:
        out = analyzer(prompt, max_length=512)
        text = out[0]["generated_text"]
        # try parse JSON
        first = text.find("[")
        last = text.rfind("]")
        if first != -1 and last != -1 and last > first:
            candidate = text[first:last+1]
            try:
                emails = json.loads(candidate)
                return {"emailSequence": emails}
            except Exception:
                pass

    # fallback simple sequence
    emails = [
        {"subject": "Request for Resolution", "body": "Hello,\n\nI am writing to request resolution of the matter described above. Please contact me within 5 business days.", "timing": "Day 1", "tone": "Professional", "purpose": "Initial outreach"},
        {"subject": "Follow-up: Request for Resolution", "body": "This is a follow-up to my previous request. We expect a response within 7 days.", "timing": "Day 7", "tone": "Firm", "purpose": "Follow-up"},
        {"subject": "Final Notice before Further Action", "body": "This is the final notice. If we do not hear from you in 14 days, we will escalate to the appropriate agencies and consider legal action.", "timing": "Day 14", "tone": "Firm", "purpose": "Final notice"}
    ]
    return {"emailSequence": emails}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=5001)
