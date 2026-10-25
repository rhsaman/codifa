import { createServer } from 'node:http'

// Stub router for the live UI harness (`?scenario=settings&tab=marketplaces&sidecar=<port>`).
//
// The real marketplace browse goes out to the sidecar's GET /plugins/marketplace
// and an install to POST /plugins/install; the harness has neither, so this
// answers both — and RECORDS the install body, which is what lets a driver
// assert that a row installed from the Skills tab arrives with `kind: "skills"`.
const CATALOGUES = {
  'anthropics/claude-plugins-official': Array.from({ length: 6 }, (_, i) => ({
    name: `plugin-${i}`,
    description: `Plugin number ${i}`,
    repo: 'anthropics/claude-plugins-official',
    repo_path: `plugins/plugin-${i}`,
  })),
  'anthropics/skills': Array.from({ length: 4 }, (_, i) => ({
    name: `alpha-skill-${i}`,
    description: `Skill number ${i}`,
    repo: 'anthropics/skills',
    repo_path: `plugins/alpha-skill-${i}`,
  })),
  'anthropics/claude-plugins-community': Array.from({ length: 3 }, (_, i) => ({
    name: `connector-${i}`,
    description: `Connector number ${i}`,
    repo: 'anthropics/claude-plugins-community',
    repo_path: `plugins/connector-${i}`,
  })),
}

/** Every install body the UI sent, in order — the assertion surface. */
const installs = []

const json = (res, value, code = 200) => {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(body)
}

createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*',
    })
    return res.end()
  }
  if (url.pathname === '/health') return json(res, { ok: true })
  if (url.pathname === '/__installs') return json(res, installs)
  if (url.pathname === '/plugins/install') {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        installs.push(JSON.parse(raw))
      } catch {
        installs.push({ parse_error: raw })
      }
      json(res, {
        installed: 'created',
        slug: 'stub',
        source: 'stub',
        skills: ['Stub Skill'],
        mcp: [],
        plugin: { name: 'Stub Row', slug: 'stub', fa_keywords: ['تست'] },
      })
    })
    return
  }
  if (url.pathname === '/plugins/marketplace') {
    const repo = url.searchParams.get('repo') ?? ''
    const rows = CATALOGUES[repo]
    if (!rows) return json(res, { error: `no catalogue for ${repo}` }, 404)
    return json(res, { name: repo, description: '', source: repo, count: rows.length, plugins: rows })
  }
  // The lists a post-install refresh reads.
  if (url.pathname === '/skills') return json(res, { skills: [] })
  if (url.pathname === '/plugins/skills') return json(res, { skills: [] })
  if (url.pathname === '/plugins/mcp') return json(res, { mcp: [] })
  if (url.pathname === '/plugins') return json(res, { plugins: [] })
  if (url.pathname === '/mcp') return json(res, { mcpServers: {}, builtins: [] })
  return json(res, {})
}).listen(Number(process.env.STUB_PORT ?? 5211), '127.0.0.1', () => {
  console.log(`market stub on ${process.env.STUB_PORT ?? 5211}`)
})
