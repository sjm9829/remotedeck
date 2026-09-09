import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Minimal Vite config for the dev client. API base/token are entered in-app and
// kept in memory only; no credentials are persisted to localStorage.
export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
});
