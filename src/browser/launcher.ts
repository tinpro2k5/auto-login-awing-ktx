import { chromium, Browser, Page } from 'playwright'

export async function launchBrowser(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({
    headless: false, // QUAN TRỌNG: debug mode
    slowMo: 200,     // nhìn cho rõ
  })

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  })

  // Block tài nguyên nặng, nhưng giữ stylesheet nội bộ để UI không mất nút
await context.route('**/*', route => {
  const req = route.request()
  const type = req.resourceType()
  const url = req.url()

  const isPortal = url.startsWith('http://186.186.0.1/') ||
                   url.includes('awingconnect')

  // Giữ stylesheet nội bộ
  if (type === 'stylesheet' && isPortal) {
    return route.continue()
  }

  // Block tài nguyên nặng
  if (type === 'image' || type === 'font' || type === 'media') {
    return route.abort()
  }

  // Block analytics
  if (
    url.includes('analytics') ||
    url.includes('gtag') ||
    url.includes('facebook') ||
    url.includes('doubleclick')
  ) {
    return route.abort()
  }

  route.continue()
})

  const page = await context.newPage()
  return { browser, page }
}
