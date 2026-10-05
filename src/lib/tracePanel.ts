import { create } from 'zustand'

/** فیلتر فعال پنل لاگ چت جاری: همه یا یک نوع خاص (مثل لنگ‌اسمیت). */
export type TraceTab = 'all' | 'llm' | 'prompt' | 'tool'

interface TracePanelState {
  open: boolean
  tab: TraceTab
  /** باز کردن پنل لاگ چت جاری — برای آیکون اپ‌بار کنار گیت‌دیف. */
  openTraces: (tab?: TraceTab) => void
  close: () => void
  toggle: () => void
  setTab: (tab: TraceTab) => void
}

export const useTracePanel = create<TracePanelState>((set) => ({
  open: false,
  tab: 'all',
  openTraces: (tab) => set((s) => ({ open: true, tab: tab ?? s.tab })),
  close: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
  setTab: (tab) => set({ tab }),
}))
