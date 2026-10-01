/// <reference types="vitest/config" />
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const mockTarget = `http://127.0.0.1:${process.env.MOCK_API_PORT}`

// https://vite.dev/config/
export default defineConfig({
  // '/' for Railway (FastAPI serves the build at the root); '/telomore/' for
  // the static copy on studylab.id (deploy_studylab.bat sets VITE_BASE).
  base: process.env.VITE_BASE || '/',
  plugins: [react(), tailwindcss()],
  server: {
    // Dev: forward API calls to the locally running FastAPI backend
    // (`uvicorn backend.main:app --port 8000`) so no CORS is involved.
    // Prod: FastAPI serves this build itself (backend/main.py), so the
    // frontend is same-origin and needs no proxy.
    proxy: process.env.MOCK_API_PORT
      ? // Dev mocks (frontend/dev-mocks/server.mjs): fake API + the static demo cache.
        {
          '/api': { target: mockTarget, changeOrigin: true },
          '/demo-cache': { target: mockTarget, changeOrigin: true },
        }
      : {
          '/api': {
            target: 'http://127.0.0.1:8000',
            changeOrigin: true,
          },
        },
    fs: {
      // The Docs page (pages/Docs/index.tsx) inlines the repo-root README.md
      // and docs/*.md via Vite's `?raw` import suffix, so the dev server
      // must be allowed to read outside this Vite project root (`frontend/`)
      // -- the repo root one level up. Vite's default `fs.allow` normally
      // walks up to the nearest workspace root (lockfile/.git), which would
      // already cover this, but pinning it explicitly keeps the dev server
      // working regardless of how that auto-detection behaves.
      allow: [path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')],
    },
  },
  build: {
    outDir: 'dist', // served by backend/main.py when present
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // Several job-polling page tests take 3-5 s on a loaded laptop with 50+ files in parallel.
    testTimeout: 20000,
  },
})
