import { CheckResult } from '@devpulse/shared';

const GROQ_MODEL = 'llama-3.3-70b-versatile';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TIMEOUT_MS = 15000;
const GROQ_MAX_RETRIES = 2;

const SYNC_SYSTEM_PROMPT = `
You are DevPulse, a senior DevOps engineer syncing a developer's local environment to a target project state.
You receive a JSON object with: diff (added/updated/removed deps), localDeps, targetDeps, system (detected runtimes and package managers).

For every entry in diff.added, diff.updated, and diff.removed, output one action object.

Each action object must have:
  - id: "added:<name>" | "updated:<name>" | "removed:<name>" — unique, no spaces
  - name: short imperative title, e.g. "Install express@4.18.2" or "Remove lodash"
  - reasoning: 1 sentence — why this change is required to match the target state
  - explanation: 1 sentence — plain English description of the sync action
  - fixCommand: a single non-interactive shell command. Use the package manager from the system field if available. Chain with && if needed. Never use interactive prompts.
  - risk: "safe" | "moderate" | "destructive"

Rules:
  - Return ONLY a JSON object with a "fixes" key containing the array. No markdown, no preamble.
  - Every diff entry must produce exactly one action. No skipping.
  - For file-based deps (Gemfile, requirements.txt), use sed or standard CLI tools — never manual editing instructions.
`.trim();

const SYSTEM_PROMPT = `
You are DevPulse, a senior DevOps engineer performing automated environment triage.
You receive a JSON array of failed environment checks. Each item has: id, name, category, severity, required, found.

For EVERY item in the array, output one JSON object with exactly these fields:
  - id: copy verbatim from input
  - reasoning: 2 sentences MAX. First sentence: state the specific technical root cause (e.g. which binary is wrong, which PATH shim is missing, which version constraint is violated). Second sentence: explain why your chosen fix command is the safest and most direct remedy given the detected tool and version.
  - explanation: exactly 1 sentence, plain English, no jargon. Must name the tool and the consequence if not fixed.
  - fixCommand: a SINGLE shell command string that runs without prompts or interaction. Chain steps with &&. If version managers (nvm, pyenv, mise) are involved, prefer them. Return null ONLY if the fix genuinely requires manual secrets or GUI interaction.
  - risk: "safe" (no system-wide side effects) | "moderate" (modifies global state, e.g. global npm install) | "destructive" (overwrites data or removes packages)

Rules:
  - Return ONLY a valid JSON array. No wrapper object, no markdown, no preamble.
  - Every input item MUST produce exactly one output item. No skipping.
  - fixCommand must be copy-pasteable into a bash terminal and succeed on the detected OS.
  - Never suggest rebooting, opening a browser, or editing files in a GUI.
`.trim();

const RETRY_SYSTEM_PROMPT = `
You are DevPulse performing automated remediation recovery.
A fix command was executed and failed. Your job is to diagnose the failure and produce a different command.

Rules:
  - Read the error output carefully. Identify the exact failure reason (permission denied, binary not found, wrong flag, network error, etc.).
  - Never suggest the same command that already failed.
  - Never suggest commands that require a GUI, browser, or user interaction.
  - Return ONLY a valid JSON object with: reasoning, explanation, fixCommand.
  - reasoning: 2 sentences. First: identify the exact cause of the failure from the error output. Second: explain why the new command avoids that cause.
  - explanation: 1 sentence, plain English.
  - fixCommand: a single bash-compatible command string, or null if human intervention is genuinely required.
  - No markdown, no code fences, no preamble.
`.trim();

const ADVICE_SYSTEM_PROMPT = `
You are DevPulse, a senior staff engineer reviewing a developer's local environment scan.
You will receive a JSON array of check results — each has: id, name, passed, found, required.

Your task: produce exactly 6 to 8 markdown bullet points of actionable advice.

Output rules (strictly enforced):
  - Start every line with "- " (dash space). No other line format.
  - No headings, no numbered lists, no blank lines between bullets, no preamble, no closing remark.
  - Each bullet: one sentence, under 110 characters including the "- " prefix.
  - Prioritise failed checks (passed: false) — lead with the highest-severity issues.
  - For each critical failure, name the tool, state the consequence, and state the remedy in one sentence.
  - For passing checks, give one forward-looking tip per stack (e.g. upcoming EOL, performance setting, security flag).
  - Never give generic advice like "keep your tools updated" — every bullet must reference a specific tool or check from the scan data.
  - Never exceed 8 bullets. Never produce fewer than 6.
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

  // Extract lines that are already bullet points — the model should produce these directly
  const bullets = clean
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/.test(line))
    .map(line => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 8);

  // If the model ignored the bullet format, fall back to sentence extraction
  if (bullets.length < 3) {
    const sentences = clean
      .replace(/^#{1,6}\s+.*/gm, '')   // strip headings
      .replace(/\n+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length > 10 && s.length < 120)
      .slice(0, 8);

    if (sentences.length === 0) return clean;
    return sentences.map(s => `- ${s}`).join('\n');
  }

  return bullets.map(b => `- ${b}`).join('\n');
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

  const advicePrompt = JSON.stringify(
    checks.map(c => ({
      id: c.id,
      name: c.name,
      passed: c.passed,
      found: c.found ?? null,
      required: c.required ?? null,
      severity: c.severity ?? null,
      category: c.category ?? null,
    }))
  );

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