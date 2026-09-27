import { create } from 'zustand'

/**
 * وضعیت پنل Review سمت راست (سبک کدکس). پنل به‌جای نگه‌داشتن snapshot،
 * فقط `messageId` را نگه می‌دارد و خودش پیام را از استور می‌خواند تا حین
 * استریم هم زنده به‌روز بماند.
 */
interface ReviewPanelState {
  open: boolean
  /** پیام دستیاری که دیف‌های «Last Turn» از آن خوانده می‌شود. */
  messageId: string | null
  selectedPath: string
  /** باز کردن پنل روی ترن همین پیام؛ `path` فایل انتخابی (اختیاری). */
  openReview: (messageId: string, path?: string) => void
  close: () => void
  toggle: () => void
  selectPath: (path: string) => void
}

export const useReviewPanel = create<ReviewPanelState>((set) => ({
  open: false,
  messageId: null,
  selectedPath: '',
  openReview: (messageId, path) =>
    set((s) => ({
      open: true,
      messageId,
      // اگر فایل درخواستی عوض شده باشد، انتخاب قبلی همان پیام حفظ می‌شود؛
      // در غیر این‌صورت فایل کلیک‌شده اولین انتخاب است.
      selectedPath:
        s.messageId === messageId && s.selectedPath ? s.selectedPath : (path ?? ''),
    })),
  close: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
  selectPath: (selectedPath) => set({ selectedPath }),
}))