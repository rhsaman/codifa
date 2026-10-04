/** Device presets for the in-app virtual browser. The list mirrors Chrome
 *  DevTools' standard emulated-device list 1:1 — source: devtools-frontend
 *  front_end/models/emulation/EmulatedDevices.ts. Phones, tablets and
 *  foldables use the portrait (vertical) size; notebooks use their default
 *  landscape (horizontal) size; Nest Hub Max is landscape-only. Sizes are
 *  CSS pixels of the shared Chromium viewport. The extra `desktop` entry
 *  is the session's plain default viewport, not a Chrome device. */

export type PresetGroup = 'mobile' | 'foldable' | 'tablet_desktop' | 'smart_display'

export interface ViewportPreset {
  id: string
  label: string
  width: number
  height: number
  group: PresetGroup
}

export const PRESET_GROUP_LABELS: Record<PresetGroup, string> = {
  mobile: 'Mobile',
  foldable: 'Foldables',
  tablet_desktop: 'Tablets & Desktops',
  smart_display: 'Smart Displays',
}

export const PRESET_GROUP_ORDER: PresetGroup[] = ['mobile', 'foldable', 'tablet_desktop', 'smart_display']

/** Ungrouped default: the session's plain desktop viewport. */
const DESKTOP: ViewportPreset = {
  id: 'desktop',
  label: 'Desktop',
  width: 1280,
  height: 800,
  group: 'tablet_desktop',
}

export const VIEWPORT_PRESETS: ViewportPreset[] = [
  DESKTOP,
  { id: 'ipad-mini', label: 'iPad Mini', width: 768, height: 1024, group: 'tablet_desktop' },
  { id: 'ipad-pro-13', label: 'iPad Pro 13"', width: 1032, height: 1376, group: 'tablet_desktop' },
  { id: 'surface-pro-7', label: 'Surface Pro 7', width: 912, height: 1368, group: 'tablet_desktop' },
  { id: 'surface-pro-10', label: 'Surface Pro 10', width: 960, height: 1440, group: 'tablet_desktop' },
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, group: 'mobile' },
  { id: 'iphone-xr', label: 'iPhone XR', width: 414, height: 896, group: 'mobile' },
  { id: 'iphone-12-pro', label: 'iPhone 12 Pro', width: 390, height: 844, group: 'mobile' },
  { id: 'iphone-14', label: 'iPhone 14', width: 390, height: 844, group: 'mobile' },
  { id: 'iphone-14-plus', label: 'iPhone 14 Plus', width: 428, height: 926, group: 'mobile' },
  { id: 'iphone-14-pro', label: 'iPhone 14 Pro', width: 393, height: 852, group: 'mobile' },
  { id: 'iphone-14-pro-max', label: 'iPhone 14 Pro Max', width: 430, height: 932, group: 'mobile' },
  { id: 'iphone-15', label: 'iPhone 15', width: 393, height: 852, group: 'mobile' },
  { id: 'iphone-15-plus', label: 'iPhone 15 Plus', width: 430, height: 932, group: 'mobile' },
  { id: 'iphone-15-pro', label: 'iPhone 15 Pro', width: 393, height: 852, group: 'mobile' },
  { id: 'iphone-15-pro-max', label: 'iPhone 15 Pro Max', width: 430, height: 932, group: 'mobile' },
  { id: 'iphone-16e', label: 'iPhone 16e', width: 390, height: 844, group: 'mobile' },
  { id: 'iphone-16', label: 'iPhone 16', width: 393, height: 852, group: 'mobile' },
  { id: 'iphone-16-plus', label: 'iPhone 16 Plus', width: 430, height: 932, group: 'mobile' },
  { id: 'iphone-16-pro', label: 'iPhone 16 Pro', width: 402, height: 874, group: 'mobile' },
  { id: 'iphone-16-pro-max', label: 'iPhone 16 Pro Max', width: 440, height: 956, group: 'mobile' },
  { id: 'pixel-7', label: 'Pixel 7', width: 412, height: 915, group: 'mobile' },
  { id: 'pixel-8', label: 'Pixel 8', width: 412, height: 915, group: 'mobile' },
  { id: 'pixel-8-pro', label: 'Pixel 8 Pro', width: 448, height: 997, group: 'mobile' },
  { id: 'pixel-8a', label: 'Pixel 8a', width: 412, height: 915, group: 'mobile' },
  { id: 'pixel-9', label: 'Pixel 9', width: 412, height: 924, group: 'mobile' },
  { id: 'pixel-9-pro', label: 'Pixel 9 Pro', width: 427, height: 952, group: 'mobile' },
  { id: 'pixel-9-pro-xl', label: 'Pixel 9 Pro XL', width: 448, height: 997, group: 'mobile' },
  { id: 'pixel-10', label: 'Pixel 10', width: 412, height: 924, group: 'mobile' },
  { id: 'galaxy-s8-plus', label: 'Samsung Galaxy S8+', width: 360, height: 740, group: 'mobile' },
  { id: 'galaxy-s20-ultra', label: 'Samsung Galaxy S20 Ultra', width: 412, height: 915, group: 'mobile' },
  { id: 'galaxy-a51-71', label: 'Samsung Galaxy A51/71', width: 412, height: 914, group: 'mobile' },
  { id: 'galaxy-a55', label: 'Samsung Galaxy A55', width: 360, height: 800, group: 'mobile' },
  { id: 'pixel-9-pro-fold', label: 'Pixel 9 Pro Fold', width: 412, height: 922, group: 'foldable' },
  { id: 'galaxy-z-fold-6', label: 'Galaxy Z Fold 6', width: 412, height: 968, group: 'foldable' },
  { id: 'galaxy-z-fold-5', label: 'Galaxy Z Fold 5', width: 344, height: 882, group: 'foldable' },
  { id: 'surface-duo', label: 'Surface Duo', width: 540, height: 720, group: 'foldable' },
  { id: 'zenbook-fold', label: 'Asus Zenbook Fold', width: 853, height: 1280, group: 'foldable' },
  { id: 'galaxy-tab-s4', label: 'Galaxy Tab S4', width: 712, height: 1138, group: 'mobile' },
  { id: 'jiophone-2', label: 'JioPhone 2', width: 240, height: 320, group: 'mobile' },
  { id: 'moto-g4', label: 'Moto G4', width: 360, height: 640, group: 'mobile' },
  { id: 'moto-g-power', label: 'Moto G Power', width: 412, height: 823, group: 'mobile' },
  { id: 'facebook-android', label: 'Facebook on Android', width: 412, height: 892, group: 'mobile' },
  { id: 'laptop-touch', label: 'Laptop with touch', width: 1280, height: 950, group: 'tablet_desktop' },
  { id: 'laptop-hidpi', label: 'Laptop with HiDPI screen', width: 1440, height: 900, group: 'tablet_desktop' },
  { id: 'laptop-mdpi', label: 'Laptop with MDPI screen', width: 1280, height: 800, group: 'tablet_desktop' },
  { id: 'nest-hub-max', label: 'Nest Hub Max', width: 1280, height: 800, group: 'smart_display' },
]

/** The preset matching the current viewport, or null when it is custom. */
export function presetForViewport(width: number, height: number): ViewportPreset | null {
  return VIEWPORT_PRESETS.find((p) => p.width === width && p.height === height) ?? null
}
