// src/network/checkExpiry.ts
// Lightweight Internet Probe - Idea #1 from current_aim.txt
// Sử dụng neverssl.com để kiểm tra internet nhẹ nhàng, không trigger MAC lock
import fetch from 'node-fetch'

export async function checkExpiryByFetch(): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5000)

  try {
    const res = await fetch('http://neverssl.com/', {
      redirect: 'manual',   // Không tự động follow redirect
      signal: controller.signal,
    })

    const status = res.status
    const location = res.headers.get('location') || ''

    // ONLINE nếu:
    // - status 200/204/301/302 nhưng KHÔNG redirect vào domain portal
    if ([200, 204, 301, 302].includes(status)) {
      // Kiểm tra xem có bị redirect sang portal không
      const portalDomains = ['186.186.0.1', 'awingconnect.vn', 'v1.awingconnect.vn']
      const isRedirectToPortal = portalDomains.some(domain => location.includes(domain))

      if (!isRedirectToPortal) {
        // Không redirect sang portal → internet thật sự → NOT expired
        return false
      }
      // Redirect sang portal → captive → expired
      return true
    }

    // CAPTIVE / OFFLINE nếu:
    // - status 403/451/511 (511 hay dùng cho captive) hoặc 429
    if ([403, 451, 511, 429].includes(status)) {
      return true // expired/captive
    }

    // Các status code khác → assume expired
    return true
  } catch (err) {
    // timeout / DNS fail / network error → assume expired/captive
    console.log('[PROBE] Error during lightweight probe:', err)
    return true
  } finally {
    clearTimeout(timeout)
  }
}
