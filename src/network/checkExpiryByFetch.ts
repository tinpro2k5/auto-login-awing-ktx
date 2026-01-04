// src/network/checkExpiry.ts
// Lightweight Internet Probe - Idea #1 from current_aim.txt
// Kiểm tra trạng thái mạng bằng cách gọi trực tiếp captive portal
import fetch from 'node-fetch'

export async function checkExpiryByFetch(): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const res = await fetch('http://186.186.0.1/', {
      redirect: 'manual',
      signal: controller.signal,
    })

    const status = res.status
    const location = res.headers.get('location') || ''

    // Nếu redirect 302 đến /status → có mạng (NOT expired)
    if (status === 302 && location.includes('/status')) {
      console.log('[EXPIRY] Portal check → has internet (NOT expired)')
      return false
    }

    // Các trường hợp khác → hết session
    console.log('[EXPIRY] Portal check → no internet (expired)')
    return true
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      console.log('[PROBE] Timeout checking portal → assume expired')
    } else {
      console.log('[PROBE] Error checking portal:', err?.message || err)
    }
    return true
  } finally {
    clearTimeout(timeout)
  }
}
