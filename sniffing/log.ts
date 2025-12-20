import { chromium, Page } from "playwright";
import fs from "fs";

function attachFullSniffer(page: Page) {
  const KEYWORDS =
    /login|portal|auth|session|status|verify|customer|campaign|connecting|success|chap|radius|logout|keepalive|heartbeat|ttl|expire|token|context/i;

  const startedAt = Date.now();
  const now = () => `${((Date.now() - startedAt) / 1000).toFixed(3)}s`;

  const seen = new Set<string>();
  const short = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + "…" : s);

  // 0) Console + page errors (JS fail cũng làm UI "quay mãi")
  page.on("console", msg => {
    const type = msg.type();
    if (type === "error" || type === "warning") {
      console.log(`[${now()}][CONSOLE:${type}]`, msg.text());
    }
  });

  page.on("pageerror", err => {
    console.log(`[${now()}][PAGEERROR]`, err.message);
  });

  // 1) Request (log payload + headers subset)
  page.on("request", req => {
    const rt = req.resourceType();
    const url = req.url();
    const method = req.method();

    const interesting =
      rt === "document" ||
      rt === "xhr" ||
      rt === "fetch" ||
      KEYWORDS.test(url);

    if (!interesting) return;

    console.log(`[${now()}][REQ]`, rt, method, url);

    // Post body (when exists)
    const post = req.postData();
    if (post) console.log(`         postData:`, short(post, 1200));

    // A small header subset for debugging (avoid printing secrets too much)
    const h = req.headers();
    const subset: Record<string, string | undefined> = {
      "content-type": h["content-type"],
      "origin": h["origin"],
      "referer": h["referer"],
      "x-requested-with": h["x-requested-with"],
      "user-agent": h["user-agent"]
    };
    console.log(`         hdr:`, subset);
  });

  // 2) Request failed (DNS/timeouts/cert/blocked)
  page.on("requestfailed", req => {
    console.log(
      `[${now()}][FAIL]`,
      req.resourceType(),
      req.method(),
      req.url(),
      "->",
      req.failure()?.errorText
    );
  });

  // 3) Response (status, location, set-cookie, json preview, small text preview)
  page.on("response", async res => {
    const req = res.request();
    const rt = req.resourceType();
    const url = res.url();
    const status = res.status();
    const headers = res.headers();

    const ct = (headers["content-type"] || "").toLowerCase();
    const isJson = ct.includes("application/json");
    const isText =
      ct.includes("text/") || ct.includes("application/javascript") || ct.includes("application/xml");

    const interesting =
      rt === "document" ||
      rt === "xhr" ||
      rt === "fetch" ||
      status >= 400 ||
      isJson ||
      KEYWORDS.test(url);

    if (!interesting) return;

    console.log(`[${now()}][RES]`, rt, status, url);

    if (headers["location"]) {
      console.log(`         location:`, headers["location"]);
    }
    if (headers["set-cookie"]) {
      console.log(`         set-cookie: (present)`);
    }

    // Avoid double-reading huge bodies; only sample if looks small/interesting
    const key = `${status}|${url}`;
    if (seen.has(key)) return;
    seen.add(key);

    if (isJson) {
      try {
        const data: any = await res.json();
        console.log(`         json keys:`, Object.keys(data ?? {}));

        // common fields preview
        const previewKeys = [
          "result",
          "code",
          "msg",
          "message",
          "status",
          "authenticated",
          "ttl",
          "expires_in",
          "expireAt",
          "locked",
          "cooldown",
          "remaining"
        ];
        const preview: any = {};
        for (const k of previewKeys) {
          if (data && typeof data === "object" && k in data) preview[k] = data[k];
        }
        if (Object.keys(preview).length) {
          console.log(`         json preview:`, preview);
        }
      } catch (e: any) {
        console.log(`         (json parse failed)`, e?.message ?? "");
      }
      return;
    }

    // For document/html/text responses, sample a small snippet (helpful for "hold" pages)
    if (rt === "document" || (isText && status >= 200 && status < 400)) {
      try {
        const text = await res.text();
        const snippet = short(text.replace(/\s+/g, " "), 500);
        console.log(`         text snippet:`, snippet);
      } catch {
        // ignore
      }
    }
  });

  // 4) Main-frame navigations (final URLs)
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) {
      console.log(`[${now()}][NAV]`, frame.url());
    }
  });

  // 5) Document redirect chain (301/302/307/308) per navigation step
  page.on("requestfinished", async req => {
    if (req.resourceType() !== "document") return;
    const resp = await req.response();
    if (!resp) return;
    const status = resp.status();
    const loc = resp.headers()["location"];
    if (status >= 300 && status < 400) {
      console.log(`[${now()}][DOC-REDIR]`, status, req.url(), "->", loc);
    } else {
      console.log(`[${now()}][DOC]`, status, req.url());
    }
  });
}

(async () => {
  const harPath = `captive-${Date.now()}.har`;

  const browser = await chromium.launch({
    headless: false
  });

  // HAR = đầy đủ nhất (request/response/headers/timings/redirects…)
  const context = await browser.newContext({
    recordHar: {
      path: harPath,
      content: "embed", // include response bodies when possible
      mode: "full"
    }
  });

  const page = await context.newPage();
  attachFullSniffer(page);

  // Mở trang "mồi" captive; bạn có thể đổi thành URL portal trực tiếp nếu muốn
  await page.goto("http://186.186.0.1/login", { waitUntil: "domcontentloaded" });

  console.log("\n=== Browser opened ===");
  console.log("👉 Bạn hãy tự bấm nút login/confirm như bình thường.");
  console.log("👉 Quan sát log trong terminal.");
  console.log("👉 Khi xong, QUAY LẠI terminal bấm Enter để kết thúc và lưu HAR.\n");

  // Wait for Enter in terminal
  await new Promise<void>(resolve => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => resolve());
  });

  // Dump cookies for debugging
  const cookies = await context.cookies();
  fs.writeFileSync(`cookies-${Date.now()}.json`, JSON.stringify(cookies, null, 2), "utf8");

  await context.close(); // important: flush HAR
  await browser.close();

  console.log("\n=== Saved ===");
  console.log("HAR:", harPath);
  console.log("Cookies: cookies-*.json");
})();
