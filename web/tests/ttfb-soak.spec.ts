import { test, expect, type Page } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

/**
 * Two-browser soak: prove pre-warm lands ICE quickly and sender TTFB < 200ms
 * once the pipe is hot (architecture premise).
 */
test('pre-warmed LAN transfer hits TTFB under 200ms', async ({ browser }) => {
  const host = await browser.newContext()
  const guest = await browser.newContext()
  const hostPage = await host.newPage()
  const guestPage = await guest.newPage()

  hostPage.on('pageerror', (e) => console.error('host pageerror', e))
  guestPage.on('pageerror', (e) => console.error('guest pageerror', e))

  await hostPage.goto('/')
  await expect(hostPage.getByRole('link', { name: 'Chute home' })).toBeVisible()
  await hostPage.getByRole('button', { name: 'Create a room' }).click()
  await expect(hostPage.locator('a.url')).toBeVisible({ timeout: 15_000 })

  const shareUrl = (await hostPage.locator('a.url').getAttribute('href')) || ''
  expect(shareUrl).toContain('/r/')

  await guestPage.goto(shareUrl)

  await expect(hostPage.getByText(/Connected — pipe is hot/)).toBeVisible({ timeout: 60_000 })
  await expect(guestPage.getByText(/Connected — pipe is hot/)).toBeVisible({ timeout: 60_000 })

  const hostMetrics = await readMetrics(hostPage)
  expect(hostMetrics.lastIceReadyMs).not.toBeNull()
  expect(hostMetrics.lastIceReadyMs!).toBeLessThan(5000)

  const tmp = path.join(os.tmpdir(), `chute-soak-${Date.now()}.bin`)
  fs.writeFileSync(tmp, Buffer.alloc(512 * 1024, 0xab))

  const [fileChooser] = await Promise.all([
    hostPage.waitForEvent('filechooser'),
    hostPage.getByRole('button', { name: 'Choose files', exact: true }).click(),
  ])
  await fileChooser.setFiles(tmp)

  await expect
    .poll(async () => {
      const m = await readMetrics(hostPage)
      const send = [...m.samples].reverse().find((s) => s.direction === 'send' && s.ttfbMs !== null)
      return send?.ttfbMs ?? null
    }, { timeout: 45_000 })
    .not.toBeNull()

  const after = await readMetrics(hostPage)
  const send = [...after.samples].reverse().find((s) => s.direction === 'send' && s.ttfbMs !== null)
  expect(send).toBeTruthy()
  expect(send!.ttfbMs!).toBeLessThan(200)

  await expect(guestPage.getByRole('link', { name: 'Download' })).toBeVisible({
    timeout: 60_000,
  })

  fs.unlinkSync(tmp)
  await host.close()
  await guest.close()
})

async function readMetrics(page: Page) {
  return page.evaluate(() => {
    if (!window.__chuteMetrics) return { samples: [], lastIceReadyMs: null, lastIcePath: null }
    return window.__chuteMetrics()
  })
}
