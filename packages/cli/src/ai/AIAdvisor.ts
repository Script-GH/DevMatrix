import { CheckResult } from '@devpulse/shared';

const SYSTEM_PROMPT = `
You are DevPulse, an expert dev environment diagnostician.
You receive a JSON array of environment check failures.
For EACH issue, return a JSON object with these fields:
  - id: (same as input)
  - explanation: 1-2 sentences, plain English, no jargon. 
    Say WHY it matters for THIS project specifically.
  - fixCommand: the exact shell command(s) to fix it, 
    semicolon-separated if multiple steps.
    If you are not certain of the exact command, return null.
  - risk: "safe" | "moderate" | "destructive"
    safe = no data loss possible
    moderate = changes global state (e.g. global npm install)  
    destructive = could break other projects

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
