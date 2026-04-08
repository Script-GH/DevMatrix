import { CheckResult } from '@devpulse/shared';

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

export async function getAIFixes(issues: CheckResult[]): Promise<Partial<CheckResult>[]> {
  const failures = issues.filter(i => !i.passed);
  if (failures.length === 0) return [];

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
      return failures.map(f => ({
          id: f.id,
          explanation: "GEMINI_API_KEY not found in environment. Cannot generate AI explanation.",
          fixCommand: undefined,
          risk: "moderate"
      }));
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: SYSTEM_PROMPT }]
      },
      contents: [{
        role: 'user',
        parts: [{ text: JSON.stringify(failures.map(f => ({
          id: f.id,
          name: f.name,
          category: f.category,
          required: f.required,
          found: f.found
        }))) }]
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    })
  });

  const data = await response.json();
  if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) {
      console.error("Failed to parse Gemini response", data);
      return [];
  }
  const text = data.candidates[0].content.parts[0].text;
  try {
     return JSON.parse(text); 
  } catch (err) {
     console.error("Gemini returned invalid JSON:", text);
     return [];
  }
}

export async function getRemedyForError(issue: CheckResult, errorOutput: string): Promise<Partial<CheckResult> | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const retryPrompt = `
You are DevPulse, an expert dev environment diagnostician.
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

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: retryPrompt }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    })
  });

  const data = await response.json();
  if (!data?.candidates?.[0]?.content?.parts?.[0]?.text) return null;
  
  try {
      return JSON.parse(data.candidates[0].content.parts[0].text);
  } catch (err) {
      return null;
  }
}

