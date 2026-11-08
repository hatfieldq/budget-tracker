import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ScopeProvider } from './scope';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ScopeProvider>
      <App />
    </ScopeProvider>
  </StrictMode>,
);
