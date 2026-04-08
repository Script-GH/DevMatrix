import { CheckResult } from '@devpulse/shared';

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TIMEOUT_MS = 15000;
const GROQ_MAX_RETRIES = 2;

const SYSTEM_PROMPT = `
You are DevPulse, an expert dev environment diagnostician.
You receive a JSON array of environment check failures.
For EACH issue, return a JSON object with these fields:
  - id: (same as input)
  - reasoning: A "thought process" block (3-4 sentences) explaining your technical logic. 
    Explain what you're checking, why it likely failed, and why your proposed fix is the best approach.
  - explanation: 1 sentence, plain English summary for the user.
  - fixCommand: the exact shell command(s) to fix it, semicolon-separated.
    If you are not certain of the exact command, return null.
  - risk: "safe" | "moderate" | "destructive"

Return ONLY a valid JSON array. No preamble, no markdown fences.
`.trim();

const RETRY_SYSTEM_PROMPT = `
You are DevPulse, an expert dev environment diagnostician.
You are helping recover from a failed shell remediation.
Return ONLY valid JSON. No markdown, no code fences.
`.trim();

const ADVICE_SYSTEM_PROMPT = `
You are DevPulse, a senior environment architect.
Generate concise, practical, markdown-formatted guidance.
`.trim();

type ChatMessage = { role: 'system' | 'user'; content: string };

function getGroqApiKey(): string | null {
  return process.env.GROQ_API_KEY || null;
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
}

function parseJsonResponse<T>(text: string): T | null {
  try {
    return JSON.parse(stripCodeFences(text)) as T;
  } catch {
    return null;
  }
}

function normalizeNetworkError(err: unknown): string {
  if (!err || typeof err !== 'object') return 'Unknown network error';
  const maybeErr = err as any;
  const causeCode = maybeErr?.cause?.code;
  if (causeCode === 'UND_ERR_CONNECT_TIMEOUT') return 'Connection timeout while reaching Groq API';
  if (causeCode === 'UND_ERR_HEADERS_TIMEOUT') return 'Timed out waiting for Groq API response headers';
  return maybeErr?.message || 'Unknown network error';
}

async function requestGroq(messages: ChatMessage[], responseFormat?: 'json_object'): Promise<string | null> {
  const apiKey = getGroqApiKey();
  if (!apiKey) return null;

  for (let attempt = 1; attempt <= GROQ_MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          temperature: 0.1,
          ...(responseFormat ? { response_format: { type: responseFormat } } : {})
        }),
        signal: AbortSignal.timeout(GROQ_TIMEOUT_MS)
      });

      if (!response.ok) {
        const body = await response.text();
        console.error(`Groq API request failed (${response.status}) [attempt ${attempt}/${GROQ_MAX_RETRIES}]:`, body);
        if (attempt === GROQ_MAX_RETRIES) return null;
        continue;
      }

      const data = await response.json();
      const text = data?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim().length > 0) return text;
      console.error(`Groq API returned empty content [attempt ${attempt}/${GROQ_MAX_RETRIES}]`);
      if (attempt === GROQ_MAX_RETRIES) return null;
    } catch (err) {
      console.error(`Groq API network error [attempt ${attempt}/${GROQ_MAX_RETRIES}]:`, normalizeNetworkError(err));
      if (attempt === GROQ_MAX_RETRIES) return null;
    }
  }

  return null;
}

function fallbackFixes(failures: CheckResult[], explanation: string): Partial<CheckResult>[] {
  return failures.map((f) => ({
    id: f.id,
    explanation,
    fixCommand: undefined,
    risk: 'moderate'
  }));
}

function normalizeFix(item: any): Partial<CheckResult> | null {
  if (!item || typeof item !== 'object') return null;
  if (!item.id || typeof item.id !== 'string') return null;

  const explanation = typeof item.explanation === 'string' && item.explanation.trim()
    ? item.explanation.trim()
    : 'AI generated a fix recommendation for this issue.';

  const fixCommand = typeof item.fixCommand === 'string' && item.fixCommand.trim()
    ? item.fixCommand.trim()
    : undefined;

  const reasoning = typeof item.reasoning === 'string' ? item.reasoning.trim() : undefined;
  const risk = item.risk === 'safe' || item.risk === 'moderate' || item.risk === 'destructive'
    ? item.risk
    : 'moderate';

  return {
    id: item.id,
    explanation,
    fixCommand,
    reasoning,
    risk
  };
}

export async function getAIFixes(issues: CheckResult[]): Promise<Partial<CheckResult>[]> {
  const failures = issues.filter((i) => !i.passed);
  if (failures.length === 0) return [];

  if (!getGroqApiKey()) {
    return fallbackFixes(failures, "GROQ_API_KEY not found in environment. Please run 'dmx auth'.");
  }

  const userPayload = JSON.stringify(failures.map((f) => ({
    id: f.id,
    name: f.name,
    category: f.category,
    severity: f.severity,
    required: f.required,
    found: f.found
  })));

  const text = await requestGroq(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPayload }
    ],
    'json_object'
  );

  if (!text) {
    return fallbackFixes(failures, 'AI service is temporarily unreachable. You can still use scan results and retry fixes later.');
  }

  const parsed = parseJsonResponse<any>(text);
  if (!parsed) {
    console.error('Groq returned invalid JSON:', text);
    return fallbackFixes(failures, 'AI response format was invalid. You can still proceed with manual fixes.');
  }

  const rawItems = Array.isArray(parsed) ? parsed : (parsed.issues || parsed.fixes || []);
  if (!Array.isArray(rawItems)) {
    return fallbackFixes(failures, 'AI did not return structured fixes. You can still proceed with manual fixes.');
  }

  const normalized = rawItems
    .map(normalizeFix)
    .filter((item): item is Partial<CheckResult> => item !== null);

  if (normalized.length === 0) {
    return fallbackFixes(failures, 'AI did not generate actionable fix commands for this run.');
  }

  return normalized;
}

export async function getRemedyForError(issue: CheckResult, errorOutput: string): Promise<Partial<CheckResult> | null> {
  if (!getGroqApiKey()) return null;

  const retryPrompt = `
The previous fix command for issue '${issue.id}' FAILED.
Original fixCommand: ${issue.fixCommand}
Error Output:
${errorOutput}

Analyze the error. Return a JSON object with:
  - reasoning: Detailed technical analysis of the error and your logic for the new approach.
  - explanation: 1 sentence summary of the new fix.
  - fixCommand: the NEW exact shell command to fix the issue. Return null if it cannot be fixed automatically.
  
Return ONLY a valid JSON object. No preamble, no markdown.
  `.trim();

  const text = await requestGroq(
    [
      { role: 'system', content: RETRY_SYSTEM_PROMPT },
      { role: 'user', content: retryPrompt }
    ],
    'json_object'
  );
  if (!text) return null;

  const parsed = parseJsonResponse<any>(text);
  if (!parsed || typeof parsed !== 'object') return null;
  return normalizeFix({ id: issue.id, ...parsed });
}

export async function getTechnicalAdvice(checks: CheckResult[]): Promise<string> {
  if (!getGroqApiKey()) return "Authentication required. Please run 'dmx auth'.";

  const advicePrompt = `
Analyze the following environment scan results and provide a high-level "Technical Situation Report".
Don't just list the failures. Provide context on how these components interact and what the architectural impact is.
Suggest best practices (e.g., using specific tools, workflow changes, or infrastructure settings).

Environment Scan Data:
${JSON.stringify(checks.map(c => ({ id: c.id, passed: c.passed, name: c.name, found: c.found, required: c.required })))}

Return a concise, markdown-formatted report with 2-3 sections:
1. Architectural Risk Assessment
2. Strategic Recommendations
3. Quick Wins (optional)

Keep the tone professional and expert.
  `.trim();

  const text = await requestGroq([
    { role: 'system', content: ADVICE_SYSTEM_PROMPT },
    { role: 'user', content: advicePrompt }
  ]);

  if (!text) return "AI advice service is temporarily unreachable. Please retry in a moment.";
  const clean = stripCodeFences(text).trim();
  return clean || "No advice available at this time.";
}
