export interface Theme {
  id: string
  name: string
  blurb?: string
  vars: Record<string, string>
  /** Accent swatches for the workspace color picker — always drawn from the
   *  theme's own palette so a custom workspace color harmonizes with it. */
  workspaceColors: string[]
}

export const DEFAULT_THEME = 'catppuccin'

export const THEMES: Theme[] = [
  {
    id: 'claude',
    name: 'Claude',
    blurb: 'claude.ai dark',
    vars: {
      '--bg': '#262624',
      '--bg-alt': '#1f1e1d',
      '--bg-panel': '#2d2d2b',
      '--bg-input': '#333331',
      '--bg-hover': '#3a3a37',
      '--border': '#3d3d3a',
      '--text': '#f0eee6',
      '--text-dim': '#b8b6ac',
      '--accent': '#da7a5a',
      '--accent-dim': '#3a3734',
      '--on-accent': '#1f1e1d',
      '--danger': '#ea6c70',
      '--success': '#46a758',
      '--link': '#e88d67',
      '--thinking': '#e8c468',
    },
    workspaceColors: [
      '#e5484d', // red
      '#e8c468', // yellow
      '#46a758', // green
      '#6bb8a8', // teal
      '#e88d67', // orange
      '#d97757', // terracotta
      '#a78bfa', // purple
      '#f0eee6', // cream
    ],
  },
  {
    id: 'tokyonight',
    name: 'Tokyo Night',
    blurb: 'tokyonight.nvim',
    vars: {
      '--bg': '#1a1b26',
      '--bg-alt': '#16161e',
      '--bg-panel': '#292e42',
      '--bg-input': '#292e42',
      '--bg-hover': '#283457',
      '--border': '#3b4261',
      '--text': '#c0caf5',
      '--text-dim': '#a9b1d6',
      '--accent': '#7aa2f7',
      '--accent-dim': '#3b4261',
      '--on-accent': '#16161e',
      '--danger': '#f7768e',
      '--success': '#9ece6a',
      '--link': '#7aa2f7',
      '--thinking': '#e0af68',
    },
    workspaceColors: [
      '#f7768e', // red
      '#e0af68', // yellow
      '#9ece6a', // green
      '#73daca', // teal
      '#7aa2f7', // blue
      '#bb9af7', // purple
      '#ff9e64', // orange
      '#c0caf5', // light
    ],
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin Mocha',
    blurb: 'catppuccin/nvim mocha',
    vars: {
      '--bg': '#1e1e2e',
      '--bg-alt': '#181825',
      '--bg-panel': '#313244',
      '--bg-input': '#45475a',
      '--bg-hover': '#45475a',
      '--border': '#45475a',
      '--text': '#cdd6f4',
      '--text-dim': '#bac2de',
      '--accent': '#89b4fa',
      '--accent-dim': '#45475a',
      '--on-accent': '#11111b',
      '--danger': '#f38ba8',
      '--success': '#a6e3a1',
      '--link': '#89b4fa',
      '--thinking': '#f9e2af',
    },
    workspaceColors: [
      '#f38ba8', // red
      '#fab387', // peach
      '#f9e2af', // yellow
      '#a6e3a1', // green
      '#94e2d5', // teal
      '#89b4fa', // blue
      '#cba6f7', // mauve
      '#f5c2e7', // pink
    ],
  },
  {
    id: 'catppuccin-macchiato',
    name: 'Catppuccin Macchiato',
    blurb: 'catppuccin/nvim macchiato',
    vars: {
      '--bg': '#24273a',
      '--bg-alt': '#1e2030',
      '--bg-panel': '#363a4f',
      '--bg-input': '#494d64',
      '--bg-hover': '#494d64',
      '--border': '#494d64',
      '--text': '#cad3f5',
      '--text-dim': '#b8c0e0',
      '--accent': '#8aadf4',
      '--accent-dim': '#494d64',
      '--on-accent': '#181926',
      '--danger': '#ed8796',
      '--success': '#a6da95',
      '--link': '#8aadf4',
      '--thinking': '#eed49f',
    },
    workspaceColors: [
      '#ed8796', // red
      '#f5a97f', // peach
      '#eed49f', // yellow
      '#a6da95', // green
      '#8bd5ca', // teal
      '#8aadf4', // blue
      '#c6a0f6', // mauve
      '#f5bde6', // pink
    ],
  },
  {
    id: 'catppuccin-frappe',
    name: 'Catppuccin Frappé',
    blurb: 'catppuccin/nvim frappé',
    vars: {
      '--bg': '#303446',
      '--bg-alt': '#292c3c',
      '--bg-panel': '#414559',
      '--bg-input': '#51576d',
      '--bg-hover': '#51576d',
      '--border': '#51576d',
      '--text': '#c6d0f5',
      '--text-dim': '#c6d0f5',
      '--accent': '#8caaee',
      '--accent-dim': '#51576d',
      '--on-accent': '#232634',
      '--danger': '#e78284',
      '--success': '#a6d189',
      '--link': '#8caaee',
      '--thinking': '#e5c890',
    },
    workspaceColors: [
      '#e78284', // red
      '#ef9f76', // peach
      '#e5c890', // yellow
      '#a6d189', // green
      '#81c8be', // teal
      '#8caaee', // blue
      '#ca9ee6', // mauve
      '#f4b8e4', // pink
    ],
  },
  {
    id: 'catppuccin-latte',
    name: 'Catppuccin Latte',
    blurb: 'catppuccin/nvim latte (light)',
    vars: {
      '--bg': '#eff1f5',
      '--bg-alt': '#e6e9ef',
      '--bg-panel': '#ccd0da',
      '--bg-input': '#bcc0cc',
      '--bg-hover': '#bcc0cc',
      '--border': '#bcc0cc',
      '--text': '#3d4057',
      '--text-dim': '#40435a',
      '--accent': '#1e66f5',
      '--accent-dim': '#bcc0cc',
      '--on-accent': '#f4f6fb',
      '--danger': '#d20f39',
      '--success': '#2c7d1a',
      '--link': '#1a5cd6',
      '--thinking': '#8f6200',
    },
    workspaceColors: [
      '#d20f39', // red
      '#fe640b', // peach
      '#df8e1d', // yellow
      '#40a02b', // green
      '#179299', // teal
      '#1e66f5', // blue
      '#8839ef', // mauve
      '#ea76cb', // pink
    ],
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    blurb: 'gruvbox.nvim dark',
    vars: {
      '--bg': '#282828',
      '--bg-alt': '#1d2021',
      '--bg-panel': '#3c3836',
      '--bg-input': '#3c3836',
      '--bg-hover': '#504945',
      '--border': '#504945',
      '--text': '#ebdbb2',
      '--text-dim': '#d5c4a1',
      '--accent': '#fe8019',
      '--accent-dim': '#3c3836',
      '--on-accent': '#282828',
      '--danger': '#ff6a5c',
      '--success': '#b8bb26',
      '--link': '#83a598',
      '--thinking': '#fabd2f',
    },
    workspaceColors: [
      '#fb4934', // red
      '#fabd2f', // yellow
      '#b8bb26', // green
      '#8ec07c', // aqua
      '#83a598', // blue
      '#d3869b', // purple
      '#fe8019', // orange
      '#ebdbb2', // cream
    ],
  },
  {
    id: 'dracula',
    name: 'Dracula',
    blurb: 'dracula/nvim',
    vars: {
      '--bg': '#282a36',
      '--bg-alt': '#21222c',
      '--bg-panel': '#282a36',
      '--bg-input': '#21222c',
      '--bg-hover': '#44475a',
      '--border': '#44475a',
      '--text': '#f8f8f2',
      '--text-dim': '#b4b9d0',
      '--accent': '#bd93f9',
      '--accent-dim': '#44475a',
      '--on-accent': '#282a36',
      '--danger': '#ff5555',
      '--success': '#50fa7b',
      '--link': '#8be9fd',
      '--thinking': '#f1fa8c',
    },
    workspaceColors: [
      '#ff5555', // red
      '#f1fa8c', // yellow
      '#50fa7b', // green
      '#8be9fd', // cyan
      '#bd93f9', // purple
      '#ff79c6', // pink
      '#ffb86c', // orange
      '#f8f8f2', // white
    ],
  },
  {
    id: 'nord',
    name: 'Nord',
    blurb: 'nordic.nvim',
    vars: {
      '--bg': '#2e3440',
      '--bg-alt': '#3b4252',
      '--bg-panel': '#3b4252',
      '--bg-input': '#434c5e',
      '--bg-hover': '#3b4252',
      '--border': '#434c5e',
      '--text': '#d8dee9',
      '--text-dim': '#b8c4d8',
      '--accent': '#88c0d0',
      '--accent-dim': '#434c5e',
      '--on-accent': '#2e3440',
      '--danger': '#e88a91',
      '--success': '#a3be8c',
      '--link': '#81a1c1',
      '--thinking': '#ebcb8b',
    },
    workspaceColors: [
      '#bf616a', // red
      '#ebcb8b', // yellow
      '#a3be8c', // green
      '#88c0d0', // cyan
      '#81a1c1', // blue
      '#b48ead', // purple
      '#d08770', // orange
      '#d8dee9', // light
    ],
  },
  {
    id: 'rose-pine',
    name: 'Rose Pine',
    blurb: 'rose-pine/nvim',
    vars: {
      '--bg': '#191724',
      '--bg-alt': '#21202e',
      '--bg-panel': '#1f1d2e',
      '--bg-input': '#26233a',
      '--bg-hover': '#403d52',
      '--border': '#524f67',
      '--text': '#e0def4',
      '--text-dim': '#b0abc8',
      '--accent': '#ebbcba',
      '--accent-dim': '#403d52',
      '--on-accent': '#191724',
      '--danger': '#eb6f92',
      '--success': '#9ccfd8',
      '--link': '#4a9bc0',
      '--thinking': '#f6c177',
    },
    workspaceColors: [
      '#eb6f92', // red
      '#f6c177', // yellow
      '#9ccfd8', // teal
      '#31748f', // blue
      '#c4a7e7', // purple
      '#ebbcba', // rose
      '#6e6a86', // muted
      '#e0def4', // light
    ],
  },
  {
    id: 'one-dark',
    name: 'One Dark',
    blurb: 'onedark.nvim',
    vars: {
      '--bg': '#282c34',
      '--bg-alt': '#21252b',
      '--bg-panel': '#2c313a',
      '--bg-input': '#3e4451',
      '--bg-hover': '#3e4451',
      '--border': '#4b5263',
      '--text': '#abb2bf',
      '--text-dim': '#b4bcc9',
      '--accent': '#61afef',
      '--accent-dim': '#4b5263',
      '--on-accent': '#282c34',
      '--danger': '#e9858e',
      '--success': '#98c379',
      '--link': '#61afef',
      '--thinking': '#e5c07b',
    },
    workspaceColors: [
      '#e06c75', // red
      '#e5c07b', // yellow
      '#98c379', // green
      '#56b6c2', // cyan
      '#61afef', // blue
      '#c678dd', // purple
      '#d19a66', // orange
      '#abb2bf', // light
    ],
  },
  {
    id: 'monokai',
    name: 'Monokai',
    blurb: 'monokai.nvim',
    vars: {
      '--bg': '#272822',
      '--bg-alt': '#272822',
      '--bg-panel': '#272822',
      '--bg-input': '#49483e',
      '--bg-hover': '#49483e',
      '--border': '#49483e',
      '--text': '#f8f8f2',
      '--text-dim': '#c0bca8',
      '--accent': '#66d9ef',
      '--accent-dim': '#49483e',
      '--on-accent': '#272822',
      '--danger': '#ff5590',
      '--success': '#a6e22e',
      '--link': '#66d9ef',
      '--thinking': '#e6db74',
    },
    workspaceColors: [
      '#f92672', // red
      '#e6db74', // yellow
      '#a6e22e', // green
      '#66d9ef', // cyan
      '#ae81ff', // purple
      '#fd971f', // orange
      '#f8f8f2', // white
      '#75715e', // gray
    ],
  },
  {
    id: 'kanagawa',
    name: 'Kanagawa',
    blurb: 'kanagawa.nvim wave',
    vars: {
      '--bg': '#1f1f28',
      '--bg-alt': '#181820',
      '--bg-panel': '#2a2a37',
      '--bg-input': '#363646',
      '--bg-hover': '#363646',
      '--border': '#54546d',
      '--text': '#dcd7ba',
      '--text-dim': '#b0a9c4',
      '--accent': '#7e9cd8',
      '--accent-dim': '#363646',
      '--on-accent': '#1f1f28',
      '--danger': '#e05e5c',
      '--success': '#7fa172',
      '--link': '#7fb4ca',
      '--thinking': '#dca561',
    },
    workspaceColors: [
      '#c34043', // red
      '#dca561', // yellow
      '#76946a', // green
      '#6a9589', // teal
      '#7e9cd8', // blue
      '#957fb8', // purple
      '#7fb4ca', // cyan
      '#dcd7ba', // light
    ],
  },
  {
    id: 'everforest',
    name: 'Everforest',
    blurb: 'everforest.nvim dark',
    vars: {
      '--bg': '#2d353b',
      '--bg-alt': '#272e33',
      '--bg-panel': '#343f44',
      '--bg-input': '#3d484d',
      '--bg-hover': '#475258',
      '--border': '#475258',
      '--text': '#d3c6aa',
      '--text-dim': '#b3c0b7',
      '--accent': '#83c092',
      '--accent-dim': '#475258',
      '--on-accent': '#2d353b',
      '--danger': '#e67e80',
      '--success': '#a7c080',
      '--link': '#7fbbb3',
      '--thinking': '#dbbc7f',
    },
    workspaceColors: [
      '#e67e80', // red
      '#dbbc7f', // yellow
      '#a7c080', // green
      '#83c092', // teal
      '#7fbbb3', // blue
      '#d699b6', // purple
      '#e69875', // orange
      '#d3c6aa', // light
    ],
  },
]

export function themeById(id: string): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

let injected = false
export function injectThemeStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const css = THEMES.map((t) => {
    const vars = Object.entries(t.vars)
      .map(([k, v]) => `${k}:${v};`)
      .join('')
    return `[data-theme="${t.id}"]{${vars}}`
  }).join('\n')
  const el = document.createElement('style')
  el.id = 'coder-theme-styles'
  el.textContent = css
  document.head.appendChild(el)
}
