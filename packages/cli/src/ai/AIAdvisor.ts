import { CheckResult } from '@devpulse/shared';

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TIMEOUT_MS = 15000;
const GROQ_MAX_RETRIES = 2;

const SYNC_SYSTEM_PROMPT = `
You are DevPulse, an expert environment architect.
You receive a JSON object containing:
  - diff: { added: string[], updated: { name: string, oldVersion: string, newVersion: string }[], removed: string[] }
  - localDeps: full map of current local versions
  - targetDeps: full map of desired versions
  - system: summary of installed runtimes and package managers (e.g., "pnpm available", "python 3.10 detected")

Your task is to generate a list of shell commands to sync the local environment to the target state.
For each action, return a JSON object with:
  - id: A unique identifier for this action (e.g. "update:next").
  - name: A short, descriptive title (e.g. "Update Next.js to 16.2.3").
  - reasoning: Technical logic (e.g., "Updating package.json to match target project state").
  - explanation: 1 sentence summary of the sync action.
  - fixCommand: The exact shell command (e.g. "npm install x@1.2.3" or "sed -i ... requirements.txt").
    - If a file needs editing (like Gemfile or requirements.txt), use standard non-interactive tools like 'sed', 'echo', or redirecting.
    - If a package manager command exists (npm, pip, bundle), use it.
  - risk: "safe" | "moderate" | "destructive"

Return a JSON object with a "fixes" key containing the array of actions. No preamble, no markdown.
`.trim();

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

function compressAdvice(text: string): string {
  const clean = stripCodeFences(text).trim();
  if (!clean) return clean;

  const minBullets = 5;
  const maxBullets = 10;

  const normalizedLines = clean
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^#{1,6}\s+/.test(line)); // drop markdown headings

  const bulletLike = normalizedLines
    .filter((line) => /^[-*]\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean);

  const sentencePool = clean
    .replace(/\n+/g, ' ')
    .split(/[.!?]+\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const source = bulletLike.length > 0 ? bulletLike : sentencePool;
  const compact = source
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const selected = compact.slice(0, maxBullets);
  if (selected.length < minBullets) {
    for (const sentence of sentencePool) {
      if (selected.length >= minBullets) break;
      const normalized = sentence.replace(/\s+/g, ' ').trim();
      if (!normalized) continue;
      if (selected.includes(normalized)) continue;
      selected.push(normalized);
    }
  }

  if (selected.length === 0) {
    return '- Check environment scan output and re-run with `dmx scan`.\n- Run `dmx auth` to verify API key setup.';
  }

  return selected.slice(0, maxBullets).map((line) => `- ${line}`).join('\n');
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
    fixCommand: deriveFallbackFixCommand(f),
    risk: 'moderate'
  }));
}

function deriveFallbackFixCommand(issue: CheckResult): string | undefined {
  // Package requirements discovered from package.json checks (e.g., npm_pkg:foo).
  if (issue.id.startsWith('npm_pkg:')) {
    const pkg = issue.name.replace(/^npm_pkg:/, '').trim();
    if (!pkg) return undefined;
    const version = issue.required?.trim();
    return version ? `npm install ${pkg}@${version}` : `npm install ${pkg}`;
  }

  // Missing env vars: append placeholders to local .env (non-destructive, editable).
  if (issue.category === 'env_var' || issue.id.startsWith('env-')) {
    const key = issue.required?.trim();
    if (!key) return undefined;
    return `touch .env && (grep -q '^${key}=' .env || echo '${key}=' >> .env)`;
  }

  // Common runtime/tool issues.
  if (issue.name === 'pnpm') {
    return issue.required ? `npm install -g pnpm@${issue.required.replace(/^v/, '')}` : 'npm install -g pnpm';
  }

  if (issue.name === 'node') {
    return issue.required
      ? `nvm install ${issue.required.replace(/^v/, '')} && nvm use ${issue.required.replace(/^v/, '')}`
      : 'nvm install --lts && nvm use --lts';
  }

  if (issue.name === 'docker:daemon' || issue.id.includes('docker:daemon')) {
    return "open -a Docker || (command -v colima >/dev/null && colima start) || sudo systemctl start docker";
  }

  return undefined;
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
  const name = typeof item.name === 'string' ? item.name.trim() : undefined;
  const risk = item.risk === 'safe' || item.risk === 'moderate' || item.risk === 'destructive'
    ? item.risk
    : 'moderate';

  return {
    id: item.id,
    name,
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
Give concise technical advice for this environment scan.
Be strictly concise and action-oriented.

Environment Scan Data:
${JSON.stringify(checks.map(c => ({ id: c.id, passed: c.passed, name: c.name, found: c.found, required: c.required })))}

Output format (strict):
- Return ONLY markdown bullet points (no headings, no paragraphs).
- Provide between 5 and 10 bullet points total.
- Each bullet must be one short sentence.
- Keep each bullet under 120 characters.
  `.trim();

  const text = await requestGroq([
    { role: 'system', content: ADVICE_SYSTEM_PROMPT },
    { role: 'user', content: advicePrompt }
  ]);

  if (!text) return "AI advice service is temporarily unreachable. Please retry in a moment.";
  const clean = compressAdvice(text);
  return clean || "No advice available at this time.";
}
export async function getSyncFixes(
  diff: { added: string[], updated: { name: string, oldVersion: string, newVersion: string }[], removed: string[] },
  localDeps: Record<string, string>,
  targetDeps: Record<string, string>,
  systemContext: string
): Promise<Partial<CheckResult>[]> {
  if (!getGroqApiKey()) return [];

  const userPayload = JSON.stringify({
    diff,
    localDeps,
    targetDeps,
    system: systemContext
  });

  const text = await requestGroq(
    [
      { role: 'system', content: SYNC_SYSTEM_PROMPT },
      { role: 'user', content: userPayload }
    ],
    'json_object'
  );

  if (!text) {
    console.error('getSyncFixes: Groq returned no content.');
    return [];
  }

  const parsed = parseJsonResponse<any>(text);
  if (!parsed) {
    console.error('getSyncFixes: Failed to parse JSON response:', text);
    return [];
  }

  const rawItems = Array.isArray(parsed) ? parsed : (parsed.fixes || parsed.issues || []);
  if (!Array.isArray(rawItems)) {
    console.error('getSyncFixes: AI did not return a "fixes" array:', parsed);
    return [];
  }

  return rawItems
    .map(normalizeFix)
    .filter((item): item is Partial<CheckResult> => item !== null);
}
