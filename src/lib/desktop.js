// Единый мост к десктопной обёртке: работает и с Tauri (Rust), и с Electron
const tauri = window.__TAURI__;

export const desktop = tauri?.core
  ? {
      isDesktop: true,
      kind: 'tauri',
      getActivity: () => tauri.core.invoke('get_activity'),
      notify: (title, body) => tauri.core.invoke('notify', { title, body }),
      setBadge: (count) => tauri.core.invoke('set_badge', { count }),
      setInCall: (active) => tauri.core.invoke('call_state', { active }),
    }
  : window.chatDesktop
    ? { ...window.chatDesktop, kind: 'electron' }
    : null;
