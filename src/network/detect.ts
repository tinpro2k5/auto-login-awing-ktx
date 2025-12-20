// src/network/detect.ts

const TEST_URL = 'http://connectivitycheck.gstatic.com/generate_204'
const TIMEOUT_MS = 3000

export type CaptiveState =
  | 'ONLINE'
  | 'CAPTIVE'
  | 'ERROR'

export async function detectNetwork(): Promise<CaptiveState> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(TEST_URL, {
      redirect: 'manual', // rất quan trọng
      signal: controller.signal,
    })

    // Internet OK → Google trả đúng 204
    if (res.status === 204) {
      return 'ONLINE'
    }

    // Bị redirect (30x) hoặc trả 200 HTML → captive portal
    return 'CAPTIVE'
  } catch (err: any) {
    // AbortError, DNS error, timeout...
    return 'ERROR'
  } finally {
    clearTimeout(timer)
  }
}
