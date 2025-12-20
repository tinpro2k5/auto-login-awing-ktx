// src/portal/awing.ts
import { Page } from 'playwright'


export async function loginAwing(page: Page): Promise<void> {
  console.log('[AWING] Opening entry page...')
  await page.goto('http://186.186.0.1/login', {
    waitUntil: 'domcontentloaded',
    timeout: 15000,
  })

  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[AWING] UI login attempt ${attempt}/3`)

    // STEP 1: nút 1
    await page.waitForSelector('#logo_button', { timeout: 15000 })
    await page.click('#logo_button')

    // STEP 2: nút 2
    const realBtn = '#connectToInternet'
console.log('[AWING] Waiting for connect button to appear...')

// 1. Chờ nút xuất hiện
await page.waitForSelector(realBtn, { timeout: 20000 })

console.log('[AWING] Button appeared, waiting for UI to stabilize...')

// 2. Chờ UI ổn định (KHÔNG DOM change trong ms)
await page.evaluate(() => {
  return new Promise<void>((resolve) => {
    let timer: number | null = null

    const reset = () => {
      if (timer) clearTimeout(timer)
      timer = window.setTimeout(() => {
        observer.disconnect()
        resolve()
      }, 300) // 👈  >= countdown awing
    }

    const observer = new MutationObserver(reset)
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
    })

    // start timer lần đầu
    reset()
  })
})

console.log('[AWING] UI stable → clicking connect button')

// 3. Bấm nút (KHÔNG force)
await page.click(realBtn)


    // STEP 3: chờ xem có redirect / unlock không
    try {
      await page.waitForLoadState('networkidle', { timeout: 5000 })
    } catch {
      // ignore
    }

    // STEP 4: kiểm tra URL sau khi click
    // Success: redirect sang domain khác (https hoặc awingconnect Connecting page)
    // Fail: vẫn ở http://186.186.0.1/...
    try {
      const currentUrl = page.url()
      console.log(`[AWING] Current URL: ${currentUrl}`)

      const parsed = new URL(currentUrl)
      const isPortalIp = parsed.hostname === '186.186.0.1'
      const isAwingDomain = parsed.hostname.includes('awingconnect.vn')
      const isConnectingPage = parsed.pathname.toLowerCase().includes('connecting')

      // Nếu không còn là portal IP, hoặc đã sang domain awingconnect (connecting page) → success
      if (!isPortalIp || (isAwingDomain && isConnectingPage)) {
        console.log('[AWING] Redirected away from captive IP (or awing Connecting page) → success')
        return
      }
      
      // Vẫn ở portal, check xem có quay lại step 1 không
      const backToStart = await page.$('#logo_button')
      if (backToStart) {
        console.warn('[AWING] Still at portal, returned to start → retrying...')
        continue
      }
      
      // Vẫn ở portal nhưng không ở step 1 → có thể đang ở trang khác
      console.warn('[AWING] Still at portal but not at start page → retrying...')
      continue
      
    } catch (err: any) {
      // Context destroyed = likely successful navigation away from portal
      if (err.message?.includes('Execution context was destroyed')) {
        console.log('[AWING] Context destroyed during check → likely successful redirect')
        return
      }
      throw err
    }
  }

  throw new Error('AWING login failed after 3 UI retries')
}
