// Stub for ../lib/store used by SSR tests that render components depending on
// useStore (e.g. LiveWorkingStatus). Returns a fixed snapshot so the component
// renders deterministically without a real store/Electron backend.
export function useStore<T>(selector: (s: any) => T): T {
  const state = {
    isThinking: true,
    activeChatId: 'c1',
    chats: [
      {
        id: 'c1',
        messages: [
          {
            role: 'assistant',
            streaming: true,
            createdAt: Date.now(),
            toolActivity: [{ status: 'running', tool: 'Bash' }],
          },
        ],
      },
    ],
  }
  return selector(state)
}

export const store = {
  getState: () => ({}),
  setState: () => {},
  subscribe: () => () => {},
}
