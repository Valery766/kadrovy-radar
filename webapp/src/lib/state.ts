import { useEffect } from 'react';
import { webApp } from './bridge';

/** Кнопка «Назад» в шапке MAX: показываем на всех экранах, кроме главного. */
export function useBackButton(visible: boolean, onBack: () => void): void {
  useEffect(() => {
    const w = webApp();
    if (!w?.BackButton) return;
    if (!visible) { w.BackButton.hide(); return; }
    w.BackButton.show();
    const cb = () => onBack();
    w.BackButton.onClick(cb);
    return () => { w.BackButton.offClick(cb); w.BackButton.hide(); };
  }, [visible, onBack]);
}
