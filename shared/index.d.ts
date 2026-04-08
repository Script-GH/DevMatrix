export type Severity = 'critical' | 'warning' | 'info';
export type Category = 'runtime' | 'package_manager' | 'env_var' | 'tool' | 'config';
export type RiskLevel = 'safe' | 'moderate' | 'destructive';

export interface CheckResult {
  id: string;
  name: string;
  category: Category;
  severity: Severity;
  required: string | null;
  found: string | null;
  passed: boolean;
  statusLabel?: string;    // e.g. "outdated", "missing", "ok"
  explanation?: string;    // filled by AI
  fixCommand?: string;     // filled by AI
  risk?: RiskLevel;        // filled by AI
}

export interface HealthReport {
  score: number;           // 0–100, weighted
  timestamp: string;
  projectPath: string;
  detectedStacks: string[];
  checks: CheckResult[];
  summary: string;         // AI-generated one-paragraph summary
}
