import { createRoot } from 'react-dom/client';
import { MaxUI } from '@maxhub/max-ui';
import '@maxhub/max-ui/dist/styles.css';
import './styles.css';
import { App } from './App';
import { webApp } from './lib/bridge';

const w = webApp();
const platform = w?.platform === 'ios' ? 'ios' : 'android';
const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;

createRoot(document.getElementById('root')!).render(
  <MaxUI platform={platform} colorScheme={prefersDark ? 'dark' : 'light'}>
    <App />
  </MaxUI>,
);
w?.ready?.();
