import * as crypto from "crypto";

type Dict = Record<string, unknown>;

const ROUTER_LOGIN_URL = "http://186.186.0.1/login";
const CHECK_API_URL = "https://ex.login.net.vn/api-connect/check";
const CONNECTIVITY_TEST_URL = "http://connectivitycheck.gstatic.com/generate_204";
const CONNECTIVITY_TIMEOUT_MS = 3000;
const EXPIRY_TIMEOUT_MS = 8000;
const RENEW_BEFORE_MS = 14 * 60_000 + 50_000; // 14m50s
const LOOP_SLEEP_MS = 10_000;
const AFTER_LOGIN_WAIT_MS = 4000;

type CaptiveState = "ONLINE" | "CAPTIVE" | "ERROR";

function md5Hex(input: string) {
  return crypto.createHash("md5").update(input, "utf8").digest("hex");
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildDeviceId() {
  return md5Hex(`${new Date().toUTCString()}${Math.floor(Math.random() * 1_000_000)}`).toUpperCase();
}

function toOctalCsv(input: string) {
  return input
    .split("")
    .map(ch => ch.charCodeAt(0).toString(8).padStart(3, "0"))
    .join(",");
}

function parseJsonSafe(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    // Some gateways return non-standard JSON with raw control chars.
    const sanitized = raw.replace(/[\u0000-\u001f]/g, "");
    return JSON.parse(sanitized);
  }
}

async function detectNetwork(): Promise<CaptiveState> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTIVITY_TIMEOUT_MS);

  try {
    const res = await fetch(CONNECTIVITY_TEST_URL, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal
    });

    if (res.status === 204) {
      return "ONLINE";
    }

    return "CAPTIVE";
  } catch {
    return "ERROR";
  } finally {
    clearTimeout(timer);
  }
}

async function checkExpiryByFetch(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXPIRY_TIMEOUT_MS);

  try {
    const res = await fetch(ROUTER_LOGIN_URL, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal
    });

    const location = res.headers.get("location") ?? "";
    if (location.includes("/status")) {
      return false; // not expired
    }

    return true; // expired/captive
  } catch {
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

function parseWifiInfoFromRouterHtml(html: string): Dict | null {
  const m = html.match(/const\s+wifiInfo\s*=\s*(\{[\s\S]*?\})\s*;\s*document\.querySelector/i);
  if (!m) {
    return null;
  }

  // wifiInfo contains octal escapes like "\\012", so avoid strict mode parser.
  const wifiInfo = new Function(`return (${m[1]});`)();
  if (!wifiInfo || typeof wifiInfo !== "object") {
    return null;
  }

  return wifiInfo as Dict;
}

function deepFindString(value: unknown, predicate: (s: string) => boolean): string | null {
  if (typeof value === "string") return predicate(value) ? value : null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = deepFindString(item, predicate);
      if (found) return found;
    }
    return null;
  }

  if (value && typeof value === "object") {
    for (const v of Object.values(value as Dict)) {
      const found = deepFindString(v, predicate);
      if (found) return found;
    }
  }

  return null;
}

function pickPortalLoginUrl(checkData: unknown): string | null {
  const direct = deepFindString(checkData, s => /https?:\/\/[^\s"']*awingconnect\.vn\/login\?/i.test(s));
  if (direct) return direct;

  return deepFindString(checkData, s => /https?:\/\/[^\s"']*\/login\?serial=/i.test(s));
}

function decodeHtmlAttr(v: string): string {
  return v
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function getAttr(tag: string, attr: string): string | null {
  const re = new RegExp(`${attr}\\s*=\\s*["']([^"']*)["']`, "i");
  const m = tag.match(re);
  return m ? decodeHtmlAttr(m[1]) : null;
}

function parseAuthForm(contentAuthenForm: string) {
  const formTag = contentAuthenForm.match(/<form\b[^>]*>/i)?.[0] ?? "";
  const action = getAttr(formTag, "action") ?? ROUTER_LOGIN_URL;

  const fields: Record<string, string> = {};
  const inputTags = contentAuthenForm.match(/<input\b[^>]*>/gi) ?? [];
  for (const tag of inputTags) {
    const name = getAttr(tag, "name");
    if (!name) continue;
    fields[name] = getAttr(tag, "value") ?? "";
  }

  return { action, fields };
}

function findContentAuthenForm(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const walk = (value: unknown): string | null => {
    if (Array.isArray(value)) {
      for (const item of value) {
        const hit = walk(item);
        if (hit) return hit;
      }
      return null;
    }

    if (value && typeof value === "object") {
      const obj = value as Dict;
      const direct = obj["contentAuthenForm"];
      if (typeof direct === "string" && direct.includes("<form") && direct.includes("name=\"password\"")) {
        return direct;
      }

      for (const v of Object.values(obj)) {
        const hit = walk(v);
        if (hit) return hit;
      }
    }

    return null;
  };

  return walk(payload);
}

async function performLoginOnce(): Promise<boolean> {
  console.log("[1] GET router login page...");
  const routerRes = await fetch(ROUTER_LOGIN_URL);
  const routerHtml = await routerRes.text();
  const wifiInfo = parseWifiInfoFromRouterHtml(routerHtml);
  if (!wifiInfo) {
    if (/you are logged in|\/status/i.test(routerHtml)) {
      console.log("    already online (router says logged in), skip login");
      return true;
    }
    throw new Error("Cannot parse wifiInfo from router login HTML");
  }

  const chapId = String(wifiInfo["chap_id"] ?? "");
  const chapChallenge = String(wifiInfo["chap_challenge"] ?? "");
  console.log("    chap_id:", chapId);
  console.log("    chap_challenge head:", chapChallenge.slice(0, 30));

  // Match browser flow (portal JS: Rn(...).replaceAll(' ',','))
  const wifiInfoForCheck: Dict = {
    ...wifiInfo,
    chap_id: typeof wifiInfo["chap_id"] === "string" ? toOctalCsv(String(wifiInfo["chap_id"])) : wifiInfo["chap_id"],
    chap_challenge:
      typeof wifiInfo["chap_challenge"] === "string"
        ? toOctalCsv(String(wifiInfo["chap_challenge"]))
        : wifiInfo["chap_challenge"]
  };

  console.log("[2] Resolve portal login URL via check API...");
  const deviceId = buildDeviceId();
  const checkPayload = {
    device: {
      deviceId,
      userId: 0,
      deviceName: "MyDevice",
      os: "",
      osVersion: "",
      appVersion: "",
      network: "WiFi",
      type: "",
      status: "",
      createdAt: null,
      updatedAt: null,
      deletedAt: null,
      expiredAt: null
    },
    wifiInfo: {
      ...wifiInfoForCheck,
      route: "/login",
      "is-captive": false
    }
  };

  const checkRes = await fetch(CHECK_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      referer: "http://186.186.0.1/"
    },
    body: JSON.stringify(checkPayload)
  });

  const checkText = await checkRes.text();
  const checkJson = parseJsonSafe(checkText);
  const portalLoginUrl = pickPortalLoginUrl(checkJson);
  if (!portalLoginUrl) {
    throw new Error(`Cannot find portal login URL in check response: ${JSON.stringify(checkJson).slice(0, 600)}`);
  }
  console.log("    portal login:", portalLoginUrl);

  console.log("[3] Open portal login page...");
  await fetch(portalLoginUrl, { redirect: "follow" });

  console.log("[4] Call Home/VerifyUrl to get contentAuthenForm...");
  const portalOrigin = new URL(portalLoginUrl).origin;
  const verifyRes = await fetch(`${portalOrigin}/Home/VerifyUrl`, {
    method: "POST",
    headers: {
      referer: portalLoginUrl,
      "x-requested-with": "XMLHttpRequest"
    }
  });

  const verifyJson = await verifyRes.json();
  const contentAuthenForm = findContentAuthenForm(verifyJson);
  if (!contentAuthenForm) {
    throw new Error("Cannot find contentAuthenForm in VerifyUrl response");
  }

  const { action, fields } = parseAuthForm(contentAuthenForm);
  if (!fields.username || !fields.password) {
    throw new Error(`contentAuthenForm missing username/password: ${JSON.stringify(fields)}`);
  }

  console.log("    auth form action:", action);
  console.log("    auth username:", fields.username);
  console.log("    auth password(hash):", fields.password);

  console.log("[5] Submit router login form...");
  const body = new URLSearchParams(fields).toString();
  const loginRes = await fetch(action, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: portalOrigin,
      referer: `${portalOrigin}/`
    },
    body,
    redirect: "manual"
  });
  console.log("    login POST status:", loginRes.status, "location:", loginRes.headers.get("location"));

  console.log("[6] Verify connectivity...");
  const state = await detectNetwork();
  console.log("    connectivity state:", state);

  try {
    const v2 = await fetch("http://186.186.0.1/status", { redirect: "manual" });
    console.log("    /status:", v2.status, "location:", v2.headers.get("location"));
  } catch (e) {
    console.log("    /status check failed:", e);
  }

  return state === "ONLINE";
}

async function runLoginFlow(): Promise<boolean> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[MAIN] Login attempt ${attempt}/3`);

    try {
      const immediate = await performLoginOnce();
      if (immediate) {
        console.log("[MAIN] Internet unlocked successfully");
        return true;
      }
    } catch (err) {
      console.warn("[MAIN] Login flow error:", err);
    }

    await sleep(AFTER_LOGIN_WAIT_MS);

    const after = await detectNetwork();
    if (after === "ONLINE") {
      console.log("[MAIN] Internet unlocked successfully");
      return true;
    }

    console.warn("[MAIN] Still captive, retrying...");
  }

  console.error("[MAIN] Failed after 3 attempts");
  return false;
}

async function main() {
  console.log("[MAIN] Starting awing auto-login (httpClient loop mode)");

  let t0: number | null = null;

  while (true) {
    const state = await detectNetwork();

    if (state === "ONLINE") {
      if (t0 === null) {
        t0 = Date.now();
        console.log("[MAIN] Initial online state, timer started");
      }

      const elapsed = Date.now() - t0;
      const remaining = RENEW_BEFORE_MS - elapsed;

      if (remaining <= 0) {
        console.log("[MAIN] 14:50 reached -> checking expiry...");
        const expired = await checkExpiryByFetch();
        console.log("[EXPIRY] Fetch /login -> expired =", expired);

        if (expired) {
          console.log("[MAIN] Session expired -> login now");
          const success = await runLoginFlow();
          if (success) {
            t0 = Date.now();
          }
        } else {
          console.log("[MAIN] Not expired yet -> wait 5s and recheck");
          await sleep(5000);
          continue;
        }
      } else {
        const remainingSec = Math.floor(remaining / 1000);
        console.log(`[MAIN] Internet OK, renew in ${remainingSec}s`);
        await sleep(Math.min(60_000, remaining));
        continue;
      }
    }

    if (state === "CAPTIVE") {
      console.log("[MAIN] Captive detected");
      const success = await runLoginFlow();
      if (success) {
        t0 = Date.now();
      }
    }

    if (state === "ERROR") {
      console.log("[MAIN] Network check error, will retry...");
    }

    await sleep(LOOP_SLEEP_MS);
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});

