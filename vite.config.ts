import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { buildRefusal } from './scripts/bundle-secrets.mjs'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // Keys behind the bridge (plan 25 phase 4, Q22). Vite copies every VITE_*
  // value into the JavaScript it builds, so a provider key set here would ship
  // in dist/ and in the Windows installer. `npm run dev` may still read them
  // for the browser-direct demo; a build refuses to start. loadEnv reads the
  // same .env files Vite does, plus VITE_* variables from the shell.
  if (command === 'build') {
    const refusal = buildRefusal({ ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env })
    if (refusal) throw new Error(refusal)
  }
  return {
    plugins: [react()],
    server: {
      // Honour PORT so a second instance can run alongside the first. The bridge
      // only accepts sockets from localhost:5173-5199, so stay inside that range
      // or set JARVIS_ALLOWED_ORIGINS to match.
      port: Number(process.env.PORT) || 5173,
    },
    optimizeDeps: {
      // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
      // Vite's dependency pre-bundler rewrites that initialisation and the
      // language table ends up empty — the symptom is
      // `Invalid language identifier: "en". Should be one of: .` at generate()
      // time, long after the model has loaded successfully. Serving these
      // untouched fixes it.
      exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
    },
  }
})
