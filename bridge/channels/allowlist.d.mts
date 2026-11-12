// Types for the one export the contract tests import (shared/contracts.test.ts).
// Deliberately loose: the test checks the returned object against the
// ChannelBinding schema at run time, so the type must not assume it already fits.
export function makeBinding(
  input: Record<string, unknown>,
  options?: { now?: number; newId?: () => string },
): { allow: Record<string, boolean>; [field: string]: unknown }
