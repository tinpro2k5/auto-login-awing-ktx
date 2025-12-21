// src/network/checkExpiry.ts
import fetch from 'node-fetch'

export async function checkExpiryByFetch(): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)

  try {
    const res = await fetch('http://186.186.0.1/login', {
      redirect: 'manual',   // 👈 QUAN TRỌNG
      signal: controller.signal,
    })

    // Case 1: redirect sang /status → còn session
    const location = res.headers.get('location')
    if (location && location.includes('/status')) {
      return false // NOT expired
    }

    // Case 2: không redirect hoặc redirect đi nơi khác → captive
    return true
  } catch {
    // timeout / network error → assume expired
    return true
  } finally {
    clearTimeout(timeout)
  }
}
