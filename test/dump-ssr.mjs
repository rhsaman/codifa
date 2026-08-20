;(globalThis).window = {
  addEventListener: () => {},
  coder: new Proxy({}, { get: (_t, prop) => { if (prop === 'then') return undefined; return async () => {} } }),
}
const { renderToString } = await import('react-dom/server')
const { ReadingMode } = await import('../src/components/ReadingMode')
const message = {
  id: 'm1',
  role: 'assistant',
  content: '## بخش الف\n\nمتن الف\n\n## بخش ب\n\nمتن ب',
  createdAt: Date.now(),
}
const html = renderToString(<ReadingMode message={message} onClose={() => {}} />)
console.log(html)