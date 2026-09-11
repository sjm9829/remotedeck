import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite config for the RemoteDeck dev client.
//
// ENV VARS:
//   VITE_REMOTEDECK_BASE  – Vite base path for static assets when served under a
//                           reverse-proxy sub-path, e.g. '/remotedeck/'.
//                           Default: '/' (served from root).
//   VITE_REMOTEDECK_MODE  – Auth mode for the browser client:
//                           'same-origin' : auth handled by reverse proxy
//                                           (Workbench); no token input shown.
//                                           (default; fail-safe when unset/invalid)
//                           'direct'      : enter API base URL + token in the UI.
//                                           Must be set explicitly.
//
// When building for deployment behind Workbench (same-origin is the default):
//   VITE_REMOTEDECK_BASE=/remotedeck/ npm run build
//
// For standalone dev server (direct mode requires explicit setting):
//   VITE_REMOTEDECK_MODE=direct npm run dev
//
// Credentials are held in memory only — never written to localStorage,
// sessionStorage, or the URL.
export default defineConfig({
  base: process.env.VITE_REMOTEDECK_BASE ?? '/',
  plugins: [react()],
  build: { outDir: 'dist' },
});
