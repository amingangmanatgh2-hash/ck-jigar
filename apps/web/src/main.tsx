import 'vazirmatn/Vazirmatn-Variable-font-face.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyLocale, localeStore } from './lib/i18n';
import { applyTheme, getTheme } from './lib/theme';
import { bootstrapSession } from './state/session';
import './styles.css';

applyLocale(localeStore.get());
applyTheme(getTheme());
void bootstrapSession();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
