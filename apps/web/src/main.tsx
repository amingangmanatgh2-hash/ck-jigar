import 'vazirmatn/Vazirmatn-Variable-font-face.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyLocale, localeStore } from './lib/i18n';
import { recoverFromStaleChunks, registerServiceWorker } from './lib/pwa';
import { applyTheme, getTheme } from './lib/theme';
import { bootstrapSession } from './state/session';
import './styles.css';

applyLocale(localeStore.get());
applyTheme(getTheme());
recoverFromStaleChunks();
registerServiceWorker();
void bootstrapSession();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
