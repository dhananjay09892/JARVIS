// Types for scripts/bundle-secrets.mjs, imported by vite.config.ts.
export declare const SECRET_ENV_VARS: readonly string[]
export declare const KEY_PATTERNS: readonly { name: string; re: RegExp }[]
export declare function secretsInEnv(env: Record<string, string | undefined>): string[]
export declare function buildRefusal(env: Record<string, string | undefined>): string | null
export declare function parseDotenv(text: string): Record<string, string>
export declare function scanText(
  text: string,
  values?: Record<string, string | undefined>,
): { kind: 'value' | 'pattern'; name: string }[]
export declare function secretValues(
  ...envs: Record<string, string | undefined>[]
): Record<string, string>
