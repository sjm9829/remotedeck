import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import '@xterm/xterm/css/xterm.css';
import './App.css';
import { initTheme } from './theme.js';

// Light / dark, following the Workbench app (theme.ts).
initTheme();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root element not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
