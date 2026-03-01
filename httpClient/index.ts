import * as crypto from "crypto";
import { exec as execCb } from "child_process";
import { promisify } from "util";

type Dict = Record<string, unknown>;
type CookieStore = Map<string, string>;
type CookieJar = Map<string, CookieStore>;

const ROUTER_LOGIN_URL = "http://186.186.0.1/login";
const ROUTER_ROOT_URL = "http://186.186.0.1/";
const CHECK_API_URL = "https://ex.login.net.vn/api-connect/check";
const AWING_PORTAL_LOGIN_BASE = "http://v1.awingconnect.vn/login";
const AWING_HARDCODED_SERIAL = "CC:2D:E0:19:00:6C"; // This value is not the same as the gateway MAC nor the BSSID. It comes from the check API response of a real login session and does not change across sessions.
const CONNECTIVITY_TEST_URL = "http://connectivitycheck.gstatic.com/generate_204";
const CONNECTIVITY_TIMEOUT_MS = 3000;
const EXPIRY_TIMEOUT_MS = 8000;
const RENEW_BEFORE_MS = 14 * 60_000 + 50_000; // 14m50s
const LOOP_SLEEP_MS = 10_000;
const AFTER_LOGIN_WAIT_MS = 4000;
const SKIP_CHECK_API = process.env.AWING_SKIP_CHECK_API === "1";
const HTTP_TIMEOUT_MS = 12_000;
const HTTP_RETRY_DELAY_MS = 700;
const CHECK_API_TIMEOUT_MS = 8000;

type CaptiveState = "ONLINE" | "CAPTIVE" | "ERROR";
type ExpiryState = "ACTIVE" | "EXPIRED";

const exec = promisify(execCb);

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

function toOctalEscape(input: string) {
  return input
    .split("")
    .map(ch => `\\${ch.charCodeAt(0).toString(8).padStart(3, "0")}`)
    .join("");
}

function normalizeMac(value: string) {
  return value.replace(/-/g, ":").toUpperCase();
}

function extractSerialFromPortalLoginUrl(portalLoginUrl: string): string | null {
  try {
    const serial = new URL(portalLoginUrl).searchParams.get("serial")?.trim();
    return serial ? normalizeMac(serial) : null;
  } catch {
    return null;
  }
}

function formatPortalLoginUrlForLog(portalLoginUrl: string): string {
  try {
    const u = new URL(portalLoginUrl);
    const params = Array.from(u.searchParams.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    return params ? `${u.origin}${u.pathname}?${params}` : `${u.origin}${u.pathname}`;
  } catch {
    return portalLoginUrl;
  }
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

function parseJsonMaybe(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return parseJsonSafe(trimmed);
  } catch {
    return null;
  }
}

function getErrorCode(err: any): string {
  return String(err?.cause?.code ?? err?.code ?? err?.cause?.name ?? err?.name ?? "");
}

function isTransientNetworkError(err: any): boolean {
  const code = getErrorCode(err);
  return (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "AbortError"
  );
}

function getCookieStore(jar: CookieJar, origin: string): CookieStore {
  let store = jar.get(origin);
  if (!store) {
    store = new Map<string, string>();
    jar.set(origin, store);
  }
  return store;
}

function setCookiesFromResponse(jar: CookieJar, url: string, res: Response) {
  const origin = new URL(url).origin;
  const store = getCookieStore(jar, origin);

  const all = typeof (res.headers as any).getSetCookie === "function"
    ? ((res.headers as any).getSetCookie() as string[])
    : (() => {
        const one = res.headers.get("set-cookie");
        return one ? [one] : [];
      })();

  for (const raw of all) {
    const first = raw.split(";")[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (!name) continue;
    store.set(name, value);
  }
}

function buildCookieHeader(jar: CookieJar, url: string): string | null {
  const origin = new URL(url).origin;
  const store = jar.get(origin);
  if (!store || store.size === 0) return null;

  return Array.from(store.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function fetchWithCookies(
  url: string,
  init: RequestInit,
  jar: CookieJar,
  timeoutMs: number = HTTP_TIMEOUT_MS
): Promise<Response> {
  const cookie = buildCookieHeader(jar, url);
  const headers = new Headers(init.headers ?? {});
  if (cookie) {
    headers.set("cookie", cookie);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    setCookiesFromResponse(jar, url, res);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithCookiesRetry(
  url: string,
  init: RequestInit,
  jar: CookieJar,
  label: string,
  retries: number,
  timeoutMs: number = HTTP_TIMEOUT_MS
): Promise<Response> {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const res = await fetchWithCookies(url, init, jar, timeoutMs);

      if (res.status >= 500 && attempt <= retries) {
        console.warn(`[HTTP] ${label} status ${res.status}, retry ${attempt}/${retries}`);
        await sleep(HTTP_RETRY_DELAY_MS * attempt);
        continue;
      }

      return res;
    } catch (err) {
      if (attempt <= retries && isTransientNetworkError(err)) {
        console.warn(`[HTTP] ${label} failed (${getErrorCode(err)}), retry ${attempt}/${retries}`);
        await sleep(HTTP_RETRY_DELAY_MS * attempt);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`[HTTP] ${label} failed after retries`);
}

async function getBssidWindows(): Promise<string | null> {
  try {
    const { stdout } = await exec("netsh wlan show interfaces");
    const m = stdout.match(/^\s*BSSID\s*:\s*([0-9a-fA-F:-]{17})\s*$/m);
    if (!m) return null;
    return normalizeMac(m[1]);
  } catch {
    return null;
  }
}

function escapeRegExp(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function getGatewayMacWindows(host: string): Promise<string | null> {
  try {
    const hostRe = escapeRegExp(host);
    const lineRe = new RegExp(`^\\s*${hostRe}\\s+([0-9a-fA-F-]{17})\\s+\\w+\\s*$`, "m");

    let arpOut = "";
    try {
      const { stdout } = await exec(`arp -a ${host}`);
      arpOut = stdout;
    } catch {
      arpOut = "";
    }

    let m = arpOut.match(lineRe);
    if (m?.[1]) {
      return normalizeMac(m[1]);
    }

    try {
      await exec(`ping -n 1 -w 700 ${host}`);
      const { stdout } = await exec(`arp -a ${host}`);
      m = stdout.match(lineRe);
      if (m?.[1]) {
        return normalizeMac(m[1]);
      }
    } catch {
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

async function checkExpiryByFetch(): Promise<ExpiryState> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EXPIRY_TIMEOUT_MS);

  try {
    const res = await fetch(ROUTER_ROOT_URL, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal
    });

    const status = res.status;
    const location = res.headers.get("location") ?? "";
    if (status >= 300 && status < 400 && location.includes("/status")) {
      return "ACTIVE";
    }

    return "EXPIRED";
  } catch {
    return "EXPIRED";
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

async function resolvePortalLoginUrlViaCheckApi(wifiInfo: Dict) {
  const wifiInfoForCheck: Dict = {
    ...wifiInfo,
    chap_id: typeof wifiInfo["chap_id"] === "string" ? toOctalCsv(String(wifiInfo["chap_id"])) : wifiInfo["chap_id"],
    chap_challenge:
      typeof wifiInfo["chap_challenge"] === "string"
        ? toOctalCsv(String(wifiInfo["chap_challenge"]))
        : wifiInfo["chap_challenge"]
  };

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_API_TIMEOUT_MS);

  const checkRes = await fetch(CHECK_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      referer: "http://186.186.0.1/"
    },
    body: JSON.stringify(checkPayload),
    signal: controller.signal
  }).finally(() => clearTimeout(timer));

  const checkText = await checkRes.text();
  const checkJson = parseJsonSafe(checkText);
  return pickPortalLoginUrl(checkJson);
}

async function resolvePortalLoginUrlFallback(wifiInfo: Dict): Promise<string | null> {
  const serialFromHardcoded = normalizeMac(AWING_HARDCODED_SERIAL);
  const serialFromEnv = process.env.AWING_SERIAL?.trim();
  const serialFromEnvNormalized = serialFromEnv ? normalizeMac(serialFromEnv) : null;
  const serialFromBssid = serialFromHardcoded || serialFromEnvNormalized ? null : await getBssidWindows();
  const serialFromGateway = serialFromHardcoded || serialFromEnvNormalized || serialFromBssid ? null : await getGatewayMacWindows("186.186.0.1");
  const serial = serialFromHardcoded ?? serialFromEnvNormalized ?? serialFromBssid ?? serialFromGateway;
  if (!serial) {
    return null;
  }

  if (serialFromHardcoded) {
    console.log("    fallback serial source: hardcoded");
  } else if (serialFromEnvNormalized) {
    console.log("    fallback serial source: AWING_SERIAL env");
  } else if (serialFromBssid) {
    console.log("    fallback serial source: Wi-Fi BSSID");
  } else if (serialFromGateway) {
    console.log("    fallback serial source: gateway ARP");
  } else {
    console.log("    fallback serial source: unknown");
  }

  const clientMacRaw = String(wifiInfo["mac"] ?? "").trim();
  const clientIp = String(wifiInfo["ip"] ?? "").trim();
  const chapIdRaw = String(wifiInfo["chap_id"] ?? "");
  const chapChallengeRaw = String(wifiInfo["chap_challenge"] ?? "");

  if (!clientMacRaw || !clientIp || !chapIdRaw || !chapChallengeRaw) {
    return null;
  }

  const chapIdEsc = toOctalEscape(chapIdRaw);
  const chapChallengeEsc = toOctalEscape(chapChallengeRaw);

  const qs = new URLSearchParams({
    serial,
    client_mac: normalizeMac(clientMacRaw),
    client_ip: clientIp,
    userurl: "",
    login_url: ROUTER_LOGIN_URL,
    chap_id: chapIdEsc,
    chap_challenge: chapChallengeEsc
  });

  return `${AWING_PORTAL_LOGIN_BASE}?${qs.toString()}`;
}

async function resolvePortalLoginUrl(wifiInfo: Dict): Promise<string> {
  if (!SKIP_CHECK_API) {
    try {
      const viaApi = await resolvePortalLoginUrlViaCheckApi(wifiInfo);
      if (viaApi) {
        console.log("    portal login source: check API");
        return viaApi;
      }
      console.warn("    check API returned no portal URL, trying fallback...");
    } catch (err: any) {
      const code = err?.cause?.code || err?.code || "";
      console.warn(`    check API failed (${code || "unknown error"}), trying fallback...`);
    }
  } else {
    console.log("    skip check API (AWING_SKIP_CHECK_API=1), using fallback...");
  }

  const fallback = await resolvePortalLoginUrlFallback(wifiInfo);
  if (fallback) {
    console.log("    portal login source: fallback");
    return fallback;
  }

  throw new Error("Cannot resolve portal login URL (check API failed and fallback serial unavailable). Set AWING_SERIAL=AA:BB:CC:DD:EE:FF");
}

async function warmupPortalContext(portalOrigin: string, portalLoginUrl: string, jar: CookieJar) {
  const ts = Date.now();
  try {
    await fetchWithCookiesRetry(`${portalOrigin}/translation/vie.json?v=${ts}`, {
      method: "GET",
      redirect: "follow",
      headers: {
        referer: portalLoginUrl
      }
    }, jar, "Warmup translation", 1, 10_000);
  } catch (err: any) {
    console.warn(`[HTTP] Warmup translation failed (${getErrorCode(err) || "unknown"})`);
  }
}

async function performLoginOnce(): Promise<boolean> {
  const jar: CookieJar = new Map();

  console.log("[1] GET router login page...");
  const routerRes = await fetchWithCookies(ROUTER_LOGIN_URL, {
    method: "GET",
    redirect: "follow"
  }, jar);
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

  console.log("[2] Resolve portal login URL...");
  const portalLoginUrl = await resolvePortalLoginUrl(wifiInfo);
  console.log("    portal login:", formatPortalLoginUrlForLog(portalLoginUrl));

  console.log("[3] Open portal login page...");
  await fetchWithCookiesRetry(portalLoginUrl, {
    method: "GET",
    redirect: "follow",
    headers: {
      referer: "http://186.186.0.1/"
    }
  }, jar, "Open portal login page", 1, 15_000);

  console.log("[4] Call Home/VerifyUrl to get contentAuthenForm...");
  const portalOrigin = new URL(portalLoginUrl).origin;
  await warmupPortalContext(portalOrigin, portalLoginUrl, jar);
  await sleep(250);

  const callVerify = async (label: string) => {
    try {
      const res = await fetchWithCookiesRetry(`${portalOrigin}/Home/VerifyUrl`, {
        method: "POST",
        headers: {
          accept: "application/json, text/javascript, */*; q=0.01",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          origin: portalOrigin,
          referer: portalLoginUrl,
          "x-requested-with": "XMLHttpRequest"
        }
      }, jar, label, 2, 15_000);

      const text = await res.text();
      return { res, text, json: parseJsonMaybe(text), errCode: "" };
    } catch (err: any) {
      return {
        res: null,
        text: "",
        json: null,
        errCode: getErrorCode(err) || "unknown"
      };
    }
  };

  let verify = await callVerify("Home/VerifyUrl");
  let verifyRes = verify.res;
  let verifyText = verify.text;
  let verifyJson = verify.json;

  if (!verifyJson) {
    if (verify.errCode) {
      console.warn(`[HTTP] Home/VerifyUrl error (${verify.errCode}), reloading context...`);
    }
    await sleep(400);
    await fetchWithCookiesRetry(portalLoginUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        referer: "http://186.186.0.1/"
      }
    }, jar, "Reload portal login page", 1, 12_000);

    await warmupPortalContext(portalOrigin, portalLoginUrl, jar);
    await sleep(250);

    verify = await callVerify("Home/VerifyUrl (retry pass)");
    verifyRes = verify.res;
    verifyText = verify.text;
    verifyJson = verify.json;
  }

  if (!verifyJson) {
    const preview = verifyText.slice(0, 200).replace(/\s+/g, " ");
    const status = verifyRes?.status ?? 0;
    const errCode = verify.errCode ? ` code=${verify.errCode}` : "";
    throw new Error(`VerifyUrl did not return valid JSON (status ${status}${errCode}). preview: ${preview}`);
  }

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
  const loginRes = await fetchWithCookiesRetry(action, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: portalOrigin,
      referer: `${portalOrigin}/`
    },
    body,
    redirect: "manual"
  }, jar, "Submit router login form", 1, 10_000);
  console.log("    login POST status:", loginRes.status, "location:", loginRes.headers.get("location"));

  console.log("[6] Verify connectivity...");
  const state = await detectNetwork();
  console.log("    connectivity state:", state);

  try {
    const v2 = await fetchWithCookies("http://186.186.0.1/status", {
      method: "GET",
      redirect: "manual"
    }, jar);
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
    try {
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
          const expiry = await checkExpiryByFetch();
          console.log("[EXPIRY] Fetch /login ->", expiry);

          if (expiry === "EXPIRED") {
            console.log("[MAIN] Session expired -> login now");
            const success = await runLoginFlow();
            if (success) {
              t0 = Date.now();
            }
          } else if (expiry === "ACTIVE") {
            console.log("[MAIN] Session still active -> wait 5s and recheck");
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
        console.log("[MAIN] Captive detected -> cross-check router session...");
        const expiry = await checkExpiryByFetch();

        if (expiry === "EXPIRED") {
          const success = await runLoginFlow();
          if (success) {
            t0 = Date.now();
          }
        } else {
          console.log(`[MAIN] Captive probe looks false-positive (${expiry}), skip login this round`);
        }
      }

      if (state === "ERROR") {
        console.log("[MAIN] Network check error, will retry...");
      }
    } catch (err) {
      console.warn("[MAIN] Loop iteration error:", err);
    }

    await sleep(LOOP_SLEEP_MS);
  }
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});

