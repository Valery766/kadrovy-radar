import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MaxUI } from '@maxhub/max-ui';
import '@maxhub/max-ui/dist/styles.css';
import './styles.css';
import { App } from './App';
import { colorScheme, onColorSchemeChange, webApp, type ColorScheme } from './lib/bridge';

const w = webApp();
const platform = w?.platform === 'ios' ? 'ios' : 'android';

/**
 * Тему задаёт MAX. Если мессенджер её не сообщает (или мы открыты в браузере),
 * оставляем colorScheme пустым: MAX UI сам следит за системной темой и
 * переключается на лету. Фон вне обёртки берём из color-scheme документа.
 */
function Root() {
  const [scheme, setScheme] = useState<ColorScheme | null>(() => colorScheme());
  useEffect(() => onColorSchemeChange(setScheme), []);
  useEffect(() => { document.documentElement.style.colorScheme = scheme ?? 'light dark'; }, [scheme]);
  return (
    <MaxUI platform={platform} colorScheme={scheme ?? undefined}>
      <App />
    </MaxUI>
  );
}

createRoot(document.getElementById('root')!).render(<Root />);
w?.ready?.();
