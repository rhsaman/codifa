import { create } from 'zustand'

// Tracks the single full-screen overlay that is currently open. Every mermaid
// diagram / file-diff card registers a unique key; opening one sets `activeKey`,
// so all other open overlays (elsewhere in the chat) automatically close — only
// one full-screen view is ever visible at a time.
interface FullscreenState {
  activeKey: string | null
  open: (key: string) => void
  close: () => void
}

export const useFullscreen = create<FullscreenState>((set) => ({
  activeKey: null,
  open: (key: string) => set({ activeKey: key }),
  close: () => set({ activeKey: null }),
}))
