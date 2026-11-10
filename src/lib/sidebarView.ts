import { create } from 'zustand'

/** What the sidebar shows: the chats/projects list or the workspace file
 *  explorer. The explorer used to be a tab of the right pane; it lives here now,
 *  switched from the control at the top of the sidebar. */
export type SidebarView = 'chats' | 'files'

const STORAGE_KEY = 'coder:sidebarView'

function load(): SidebarView {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'files' ? 'files' : 'chats'
  } catch {
    return 'chats'
  }
}

interface SidebarViewState {
  view: SidebarView
  setView: (view: SidebarView) => void
}

export const useSidebarView = create<SidebarViewState>((set, get) => ({
  view: load(),
  setView: (view) => {
    if (get().view === view) return
    set({ view })
    try {
      localStorage.setItem(STORAGE_KEY, view)
    } catch {
      /* quota / private mode — the choice just won't survive a restart */
    }
  },
}))
