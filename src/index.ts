// src/index.ts
import { detectNetwork } from './network/detect'
import { launchBrowser } from './browser/launcher'
import { checkExpiryByFetch } from './network/checkExpiryByFetch'
import { loginAwing } from './portal/awing'

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms))
}

const RENEW_BEFORE_MS = 14 * 60_000 + 50_000 // 14m50s

async function checkExpiry(): Promise<boolean> {
  const { browser, page } = await launchBrowser()
  try {
    await page.goto('http://186.186.0.1/login', {
      waitUntil: 'domcontentloaded',
      timeout: 10000,
    })
    await page.waitForTimeout(300)
    const url = page.url()
    const isStatus = url.includes('/status')
    
    return !isStatus // true = expired/captive, false = still active
  } catch {
    return true // assume expired on error
  } finally {
    await browser.close()
  }
}

async function runLoginFlow(): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[MAIN] Login attempt ${attempt}/3`)

    const { browser, page } = await launchBrowser()

    try {
      await loginAwing(page)
    } catch (e) {
      console.warn('[MAIN] Login flow error:', e)
    } finally {
      await browser.close()
    }

    await sleep(4000)

    const after = await detectNetwork()
    if (after === 'ONLINE') {
      console.log('[MAIN] Internet unlocked successfully')
      return true
    }

    console.warn('[MAIN] Still captive, retrying...')
  }

  console.error('[MAIN] Failed after 3 attempts')
  return false
}

async function main() {
  console.log('[MAIN] Starting awing auto-login')

  let t0: number | null = null

  while (true) {
    const state = await detectNetwork()

    if (state === 'ONLINE') {
      if (t0 === null) {
        t0 = Date.now()
        console.log('[MAIN] Initial online state, timer started')
      }

      const elapsed = Date.now() - t0
      const remaining = RENEW_BEFORE_MS - elapsed

      if (remaining <= 0) {
        console.log('[MAIN] 14:50 reached → checking expiry...')
        
        const expired = await checkExpiryByFetch()
        console.log('[EXPIRY] Fetch /login → expired =', expired)

        
        if (expired) {
          console.log('[MAIN] Session expired → login now')
          const success = await runLoginFlow()
          if (success) {
            t0 = Date.now() // reset timer
          }
        } else {
          console.log('[MAIN] Not expired yet → wait 5s and recheck')
          await sleep(5000)
          continue
        }
      } else {
        const remainingSec = Math.floor(remaining / 1000)
        console.log(`[MAIN] Internet OK, renew in ${remainingSec}s`)
        await sleep(Math.min(60_000, remaining))
        continue
      }
    }

    if (state === 'CAPTIVE') {
      console.log('[MAIN] Captive detected')
      const success = await runLoginFlow()
      if (success) {
        t0 = Date.now() // reset timer
      }
    }

    await sleep(10_000)
  }
}

main().catch(err => {
  console.error('[FATAL]', err)
  process.exit(1)
})
