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
  /** Тема мессенджера. Появилась не во всех сборках клиента, поэтому необязательное поле. */
  colorScheme?: ColorScheme;
  onEvent?: (event: string, cb: (payload: unknown) => void) => void;
  offEvent?: (event: string, cb: (payload: unknown) => void) => void;
}

export type ColorScheme = 'light' | 'dark';

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

const isScheme = (v: unknown): v is ColorScheme => v === 'light' || v === 'dark';

/** Параметр запуска MAX: клиент кладёт их в hash и дублирует в sessionStorage. */
function launchParam(key: string): string | null {
  try {
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get(key);
    return fromHash ?? window.sessionStorage.getItem(key);
  } catch { return null; }
}

/**
 * Тема оформления от MAX: поле моста или параметр запуска.
 * Если мессенджер тему не сообщает, возвращаем null — тогда MAX UI следит за
 * системной темой сам (matchMedia), в том числе при переключении на ходу.
 */
export function colorScheme(): ColorScheme | null {
  const fromBridge = webApp()?.colorScheme;
  if (isScheme(fromBridge)) return fromBridge;
  const fromLaunch = launchParam('WebAppColorScheme') ?? launchParam('WebAppTheme');
  return isScheme(fromLaunch) ? fromLaunch : null;
}

/** Подписка на смену темы в MAX. Вне MAX и на старых клиентах — пустая отписка. */
export function onColorSchemeChange(cb: (scheme: ColorScheme) => void): () => void {
  const w = webApp();
  if (!w?.onEvent || !w.offEvent) return () => undefined;
  const handler = (payload: unknown) => {
    const next = typeof payload === 'string' ? payload : (payload as { colorScheme?: unknown } | null)?.colorScheme;
    if (isScheme(next)) cb(next);
  };
  w.onEvent('themeChanged', handler);
  return () => w.offEvent?.('themeChanged', handler);
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
