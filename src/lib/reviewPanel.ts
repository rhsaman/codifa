import { create } from 'zustand'

/**
 * وضعیت پنل Review سمت راست (سبک کدکس). پنل به‌جای نگه‌داشتن snapshot،
 * فقط `messageId` را نگه می‌دارد و خودش پیام را از استور می‌خواند تا حین
 * استریم هم زنده به‌روز بماند.
 */
/** منبع دیف‌های پنل: ترن جاری، تغییرات uncommitted گیت، یا یک کامیت. */
export type ReviewSource = "turn" | "uncommitted" | "committed";

interface ReviewPanelState {
  open: boolean
  /** پیام دستیاری که دیف‌های «Last Turn» از آن خوانده می‌شود. */
  messageId: string | null
  selectedPath: string
  /** منبع فعلی دیف پنل — آیکون گیت آن را روی `uncommitted` می‌گذارد. */
  source: ReviewSource
  /** باز کردن پنل روی ترن همین پیام؛ `path` فایل انتخابی (اختیاری). */
  openReview: (messageId: string, path?: string) => void
  /** باز کردن پنل روی دیف گیت (uncommitted) — برای آیکون ⎇ هدر. */
  openGitDiff: () => void
  close: () => void
  toggle: () => void
  selectPath: (path: string) => void
  setSource: (source: ReviewSource) => void
}

export const useReviewPanel = create<ReviewPanelState>((set) => ({
  open: false,
  messageId: null,
  selectedPath: '',
  source: 'turn',
  openReview: (messageId, path) =>
    set((s) => ({
      open: true,
      messageId,
      source: 'turn',
      // اگر مسیر فایل داده شده باشد همیشه همان باز می‌شود (کلیک Review روی
      // هر کارت، همان فایل را نشان می‌دهد)؛ وگرنه انتخاب قبلی همان پیام حفظ
      // می‌شود و برای پیام جدید خالی است.
      selectedPath: path ?? (s.messageId === messageId ? s.selectedPath : ''),
    })),
  openGitDiff: () => set({ open: true, source: 'uncommitted' }),
  close: () => set({ open: false }),
  toggle: () => set((s) => ({ open: !s.open })),
  selectPath: (selectedPath) => set({ selectedPath }),
  setSource: (source) => set({ source }),
}))