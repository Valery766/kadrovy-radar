/** Тонкая обёртка над MAX Bridge (window.WebApp). Вне MAX все вызовы безопасно деградируют. */
export interface MaxWebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name?: string }; chat?: { id: number; type: string }; start_param?: string };
  platform: 'ios' | 'android' | 'desktop' | 'web' | null;
  version: string;
  BackButton: { show: () => void; hide: () => void; onClick: (cb: () => void) => void; offClick: (cb: () => void) => void; isVisible: boolean };
  shareMaxContent: (p: { mid: string; chatType: 'DIALOG' | 'CHAT' } | { text?: string; link?: string }) => Promise<unknown>;
  openMaxLink: (url: string) => void;
  openLink: (url: string) => void;
  getViewportSize?: () => Promise<{ width: string; height: string }>;
  ready?: () => void;
  HapticFeedback?: { notificationOccurred: (t: 'success' | 'error' | 'warning') => Promise<unknown> };
}

declare global { interface Window { WebApp?: MaxWebApp } }

export function webApp(): MaxWebApp | null {
  return typeof window !== 'undefined' && window.WebApp ? window.WebApp : null;
}

export function insideMax(): boolean {
  const w = webApp();
  return Boolean(w && w.initData);
}

export function platform(): string {
  return webApp()?.platform ?? 'browser';
}

/** Параметр запуска: из initData (start_param) или из query ?card= при открытии в браузере. */
export function startParam(): string | null {
  const w = webApp();
  const sp = w?.initDataUnsafe?.start_param;
  if (sp) return sp;
  const q = new URLSearchParams(window.location.search).get('card');
  return q ? `card_${q}` : null;
}

export async function shareMid(mid: string, chatType: 'DIALOG' | 'CHAT' = 'DIALOG'): Promise<'shared' | 'unsupported' | 'failed'> {
  const w = webApp();
  if (!w?.shareMaxContent) return 'unsupported';
  try { await w.shareMaxContent({ mid, chatType }); return 'shared'; } catch { return 'failed'; }
}

export async function shareLink(text: string, link: string): Promise<'shared' | 'unsupported' | 'failed'> {
  const w = webApp();
  if (!w?.shareMaxContent) return 'unsupported';
  try { await w.shareMaxContent({ text, link }); return 'shared'; } catch { return 'failed'; }
}

export function haptic(kind: 'success' | 'error' | 'warning'): void {
  void webApp()?.HapticFeedback?.notificationOccurred(kind).catch(() => undefined);
}
