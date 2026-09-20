/**
 * Starts Go signaling with the built web client, then runs the Playwright TTFB soak.
 * Usage: node scripts/run-soak.mjs
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '../..')
const web = path.resolve(__dirname, '..')
const server = path.resolve(root, 'server')

function run(cmd, args, opts = {}) {
  return spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts })
}

async function waitHttp(url, ms = 90_000) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 400))
  }
  throw new Error(`timeout waiting for ${url}`)
}

const build = run('npm', ['run', 'build'], { cwd: web })
await new Promise((resolve, reject) => {
  build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('build failed'))))
})

const go = run('go', ['run', '.', '-static', path.join(web, 'dist'), '-addr', ':8080'], {
  cwd: server,
})
await waitHttp('http://127.0.0.1:8080/')
await waitHttp('http://127.0.0.1:8080/health')

const test = run('npx', ['playwright', 'test', 'tests/ttfb-soak.spec.ts'], {
  cwd: web,
  env: { ...process.env, CHUTE_BASE_URL: 'http://127.0.0.1:8080' },
})

const code = await new Promise((resolve) => test.on('exit', resolve))
try {
  go.kill()
} catch {
  /* ignore */
}
process.exit(code ?? 1)
