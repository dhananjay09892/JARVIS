/**
 * The npm packages the installed app needs at run time: everything that
 * bridge/ and launcher/ import. The UI is compiled into dist/ and needs none.
 *
 * scripts/package.mjs installs exactly these into the folder the Windows
 * installer wraps, at the versions package.json gives. A package the bridge
 * imports that is missing here works from source and fails in the installed
 * app, so scripts/runtime-packages.test.mjs checks this list against the
 * imports.
 */
export const RUNTIME_PACKAGES = Object.freeze([
  '@anthropic-ai/claude-agent-sdk',
  // Speaker recognition (bridge/speaker-campp.mjs), loaded on first use.
  'onnxruntime-node',
  'ws',
  'zod',
])
