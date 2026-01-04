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

    // STEP 1: nút 1 (locator auto-wait, nhanh hơn waitForSelector)
    await page.locator('#logo_button').click({ timeout: 15000 })

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
    try {
      let currentUrl = page.url()
      console.log(`[AWING] Current URL: ${currentUrl}`)

      const parsed = new URL(currentUrl)
      const isPortalIp = parsed.hostname === '186.186.0.1'
      const isAwingDomain = parsed.hostname.includes('awingconnect.vn')
      const isConnectingPage = parsed.pathname.toLowerCase().includes('connecting')
      const isSuccessPage = parsed.pathname.toLowerCase().includes('success')
      const isWelcomePage = parsed.pathname.toLowerCase().includes('welcome')

      // Case 1: Redirect sang /Success hoặc /welcome → SUCCESS
      // Đây là strong indicators, xuất hiện giữa Connecting và mywifi.vn
      if (isAwingDomain && (isSuccessPage || isWelcomePage)) {
        console.log('[AWING] ✅ At Success/Welcome page → login successful!')
        return
      }

      // Case 2: redirect sang awingconnect Connecting page
      // ⚠️ QUAN TRỌNG: Connecting page xuất hiện cả khi FAIL lẫn SUCCESS
      // - Nếu thất bại: dừng lại ở Connecting, có nút "TIẾP TỤC ĐỂ KẾT NỐI"
      // - Nếu thành công: redirect tiếp → Success → welcome → deeplink → mywifi.vn
      // → Cần đợi thêm để xem có redirect tiếp không
      if (isAwingDomain && isConnectingPage) {
        console.log('[AWING] At Connecting page, waiting to see if redirects further...')
        // Đợi ~1.5s xem có redirect tiếp không (dựa trên log, redirect xảy ra khá nhanh)
        await page.waitForTimeout(1360)

        currentUrl = page.url()
        console.log(`[AWING] URL after wait: ${currentUrl}`)

        const stillConnecting = currentUrl.toLowerCase().includes('connecting')
        if (stillConnecting) {
          // Vẫn còn ở Connecting → thất bại, cần làm lại
          console.warn('[AWING] ❌ Still at Connecting page after wait → login failed, need retry')
          // Quay lại trang login để thử lại
          await page.goto('http://186.186.0.1/login', { waitUntil: 'domcontentloaded' })
          continue
        }

        // Đã redirect đi → check xem có phải success/welcome không
        const newParsed = new URL(currentUrl)
        const newIsSuccess = newParsed.pathname.toLowerCase().includes('success')
        const newIsWelcome = newParsed.pathname.toLowerCase().includes('welcome')
        const isMyWifi = newParsed.hostname.includes('mywifi.vn')
        const isDeeplink = newParsed.hostname.includes('deeplink.awing.vn')

        if (newIsSuccess || newIsWelcome || isMyWifi || isDeeplink) {
          console.log('[AWING] ✅ Redirected to Success/Welcome/MyWifi/Deeplink → success!')
          return
        } else {
          // Redirect đi nhưng không phải các trang success expected
          console.log('[AWING] ✅ Redirected away from Connecting → likely success')
          return
        }
      }

      // Case 3: không còn ở portal IP → success
      if (!isPortalIp) {
        console.log('[AWING] ✅ Redirected away from captive IP → success')
        return
      }

      // Vẫn ở portal, check xem có quay lại step 1 không
      const backToStart = await page.$('#logo_button')
      if (backToStart) {
        console.warn('[AWING] ❌ Still at portal, returned to start → retrying...')
        continue
      }

      // Vẫn ở portal nhưng không ở step 1 → có thể đang ở trang khác
      console.warn('[AWING] ❌ Still at portal but not at start page → retrying...')
      continue

    } catch (err: any) {
      // Context destroyed = likely successful navigation away from portal
      if (err.message?.includes('Execution context was destroyed')) {
        console.log('[AWING] ✅ Context destroyed during check → likely successful redirect')
        return
      }
      throw err
    }
  }

  throw new Error('AWING login failed after 3 UI retries')
}
