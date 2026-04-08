/**
 * Environment variable masking utilities.
 *
 * Note: Env file PARSING is handled by the production EnvParser scanner.
 * This module only handles value masking for sensitive keys before cloud storage.
 */

const SENSITIVE_PATTERNS = /KEY|SECRET|PASSWORD|TOKEN|AUTH|CREDENTIAL|PRIVATE|PWD|PASS|CERT/i;

/**
 * Masks sensitive environment variable values.
 * - Matches KEY, SECRET, TOKEN, PASSWORD, AUTH, CREDENTIAL, etc.
 * - Replaces value with ****<last4> if value is long enough, otherwise ****.
 * - Non-sensitive keys are kept as-is.
 */
export function maskEnvVariables(
  env: Record<string, string>
): Record<string, string> {
  const masked: Record<string, string> = {};

  for (const [key, value] of Object.entries(env)) {
    if (!value?.trim()) {
      masked[key] = value;
      continue;
    }

    if (SENSITIVE_PATTERNS.test(key)) {
      masked[key] = value.length > 4 ? `****${value.slice(-4)}` : '****';
    } else {
      masked[key] = value;
    }
  }

  return masked;
}
