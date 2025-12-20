import { request } from "undici";
import { CookieJar } from "tough-cookie";
import { URLSearchParams } from "url";

async function fetchWithJar(jar: CookieJar, url: string, opts: any = {}) {
  const u = new URL(url);
  const cookie = await jar.getCookieString(url);

  const res = await request(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      ...(cookie ? { cookie } : {})
    },
    maxRedirections: 5
  });

  const setCookie = res.headers["set-cookie"];
  if (setCookie) {
    const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const sc of arr) await jar.setCookie(sc, url);
  }

  const bodyText = await res.body.text();
  return { status: res.statusCode, headers: res.headers, url, bodyText };
}

async function isCaptive(jar: CookieJar) {
  const r = await fetchWithJar(jar, "http://neverssl.com/", { method: "GET" });
  // Captive thường redirect hoặc trả content khác thường.
  // Ở đây check đơn giản: nếu body có dấu hiệu portal hoặc status lạ thì coi captive.
  if (r.status >= 300 && r.status < 400) return true;
  // Bạn có thể làm chắc hơn: nếu URL cuối cùng khác host neverssl (khi follow redirect)
  return false;
}

async function loginHotspot() {
  const jar = new CookieJar();

  // 1) pre-check
  if (!(await isCaptive(jar))) {
    console.log("Already online; skip login.");
    return;
  }

  // 2) load login page (lấy cookie)
  await fetchWithJar(jar, "http://186.186.0.1/login", { method: "GET" });

  // 3) POST login y chang sniff
  const form = new URLSearchParams();
  form.set("username", "awing15-15"); // TODO
  form.set("password", "11c0227a24616139cf774fc699363978"); // TODO: hash sniff được
  form.set("dst", "http://v1.awingconnect.vn/Success");
  form.set("popup", "false");

  const r = await fetchWithJar(jar, "http://186.186.0.1/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // 2 header này khớp sniff của bạn (không bắt buộc 100% nhưng nên giữ)
      "origin": "http://v1.awingconnect.vn",
      "referer": "http://v1.awingconnect.vn/"
    },
    body: form.toString()
  });

  console.log("login POST status:", r.status);

  // 4) verify online again
  const ok = !(await isCaptive(jar));
  console.log("online after login:", ok);
}

loginHotspot().catch(console.error);
