import { chromium, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";

function attachFullSniffer(page: Page) {
  const KEYWORDS =
    /login|portal|auth|session|status|verify|customer|campaign|connecting|success|chap|radius|logout|keepalive|heartbeat|ttl|expire|token|context/i;

  // Endpoints that must be dumped in full body (request + response)
  const FULL_DUMP_RE =
    /\/Home\/VerifyUrl|\/Content\/GetCustomer|\/Content\/GetCampaignHtml|\/Analytic\/Send|\/api-login\/account|186\.186\.0\.1\/login/i;

  const startedAt = Date.now();
  const now = () => `${((Date.now() - startedAt) / 1000).toFixed(3)}s`;

  const seen = new Set<string>();
  const short = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + "..." : s);

  const dumpDir = path.join(process.cwd(), "sniffing", `dump-${Date.now()}`);
  fs.mkdirSync(dumpDir, { recursive: true });
  let dumpSeq = 0;

  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 140);
  const writeDump = (prefix: string, payload: unknown) => {
    const file = path.join(dumpDir, `${String(++dumpSeq).padStart(4, "0")}_${safe(prefix)}.json`);
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
    return file;
  };

  // 0) Console + page errors
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

    const interesting = rt === "document" || rt === "xhr" || rt === "fetch" || KEYWORDS.test(url);
    const focusEndpoint = FULL_DUMP_RE.test(url);

    if (!interesting) return;

    console.log(`[${now()}][REQ]`, rt, method, url);

    const post = req.postData();
    if (post) console.log("         postData:", short(post, 1200));

    const h = req.headers();
    const subset: Record<string, string | undefined> = {
      "content-type": h["content-type"],
      origin: h["origin"],
      referer: h["referer"],
      "x-requested-with": h["x-requested-with"],
      "user-agent": h["user-agent"]
    };
    console.log("         hdr:", subset);

    if (focusEndpoint) {
      const file = writeDump(`req_${method}_${url}`, {
        ts: new Date().toISOString(),
        elapsed: now(),
        kind: "request",
        resourceType: rt,
        method,
        url,
        headers: h,
        postData: post ?? null
      });
      console.log(`         dump: ${file}`);
    }
  });

  // 2) Request failed
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

  // 3) Response (status, location, set-cookie, json preview, text snippet)
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
      rt === "document" || rt === "xhr" || rt === "fetch" || status >= 400 || isJson || KEYWORDS.test(url);
    const focusEndpoint = FULL_DUMP_RE.test(url);

    if (!interesting) return;

    console.log(`[${now()}][RES]`, rt, status, url);

    if (headers["location"]) {
      console.log("         location:", headers["location"]);
    }
    if (headers["set-cookie"]) {
      console.log("         set-cookie: (present)");
    }

    const key = `${status}|${url}`;
    if (!focusEndpoint) {
      if (seen.has(key)) return;
      seen.add(key);
    }

    if (focusEndpoint) {
      try {
        const bodyText = await res.text();

        const responseDump: {
          ts: string;
          elapsed: string;
          kind: string;
          resourceType: string;
          method: string;
          url: string;
          status: number;
          requestHeaders: Record<string, string>;
          responseHeaders: Record<string, string>;
          requestPostData: string | null;
          bodyText: string;
          bodyJson?: unknown;
        } = {
          ts: new Date().toISOString(),
          elapsed: now(),
          kind: "response",
          resourceType: rt,
          method: req.method(),
          url,
          status,
          requestHeaders: req.headers(),
          responseHeaders: headers,
          requestPostData: req.postData() ?? null,
          bodyText
        };

        try {
          responseDump.bodyJson = JSON.parse(bodyText);
        } catch {
          // keep raw body
        }

        const file = writeDump(`res_${status}_${req.method()}_${url}`, responseDump);
        console.log(`         dump: ${file}`);

        if (responseDump.bodyJson && typeof responseDump.bodyJson === "object") {
          console.log("         json keys:", Object.keys(responseDump.bodyJson as Record<string, unknown>));
        } else {
          const snippet = short(bodyText.replace(/\s+/g, " "), 500);
          console.log("         text snippet:", snippet);
        }
      } catch (e: any) {
        console.log("         (dump failed)", e?.message ?? "");
      }
      return;
    }

    if (isJson) {
      try {
        const data: any = await res.json();
        console.log("         json keys:", Object.keys(data ?? {}));

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
          console.log("         json preview:", preview);
        }
      } catch (e: any) {
        console.log("         (json parse failed)", e?.message ?? "");
      }
      return;
    }

    if (rt === "document" || (isText && status >= 200 && status < 400)) {
      try {
        const text = await res.text();
        const snippet = short(text.replace(/\s+/g, " "), 500);
        console.log("         text snippet:", snippet);
      } catch {
        // ignore
      }
    }
  });

  // 4) Main-frame navigations
  page.on("framenavigated", frame => {
    if (frame === page.mainFrame()) {
      console.log(`[${now()}][NAV]`, frame.url());
    }
  });

  // 5) Document redirect chain
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

  console.log(`Dump dir: ${dumpDir}`);
}

(async () => {
  const harPath = `captive-${Date.now()}.har`;

  const browser = await chromium.launch({
    headless: false
  });

  const context = await browser.newContext({
    recordHar: {
      path: harPath,
      content: "embed",
      mode: "full"
    }
  });

  const page = await context.newPage();
  attachFullSniffer(page);

  await page.goto("http://186.186.0.1/login", { waitUntil: "domcontentloaded" });

  console.log("\n=== Browser opened ===");
  console.log("Tu bam login/confirm binh thuong.");
  console.log("Quan sat log trong terminal.");
  console.log("Xong thi quay lai terminal bam Enter de ket thuc va luu HAR.\n");

  await new Promise<void>(resolve => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", () => resolve());
  });

  const cookies = await context.cookies();
  fs.writeFileSync(`cookies-${Date.now()}.json`, JSON.stringify(cookies, null, 2), "utf8");

  await context.close();
  await browser.close();

  console.log("\n=== Saved ===");
  console.log("HAR:", harPath);
  console.log("Cookies: cookies-*.json");
})();

