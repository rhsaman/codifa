import type { CoderApi } from './coderApi'

declare global {
  interface Window {
    coder: CoderApi
  }
}

export {}
