import crypto from "crypto";

function parseOctalEscapedBytes(s: string): Buffer {
  const nums = [...s.matchAll(/\\([0-7]{1,3})/g)].map(m => parseInt(m[1], 8) & 0xff);
  return Buffer.from(nums);
}

function chapMD5(chapId: number, chapChallenge: Buffer, password: string) {
  const idBuf = Buffer.from([chapId & 0xff]);
  const pwdBuf = Buffer.from(password, "utf8");
  return crypto
    .createHash("md5")
    .update(Buffer.concat([idBuf, pwdBuf, chapChallenge]))
    .digest("hex");
}

// match cả object-literal và JSON
function extractField(html: string, key: string): string | null {
  const re1 = new RegExp(String.raw`${key}\s*:\s*"([^"]+)"`, "i");          // chap_id:"..."
  const re2 = new RegExp(String.raw`"${key}"\s*:\s*"([^"]+)"`, "i");        // "chap_id":"..."
  return html.match(re1)?.[1] ?? html.match(re2)?.[1] ?? null;
}

function extractChapFromHtml(html: string) {
  const chapIdRaw = extractField(html, "chap_id");
  const chapChRaw = extractField(html, "chap_challenge");

  if (!chapIdRaw || !chapChRaw) return null;

  // chap_id của bạn đang dạng "\374" => octal 1 byte
  const chapId =
    chapIdRaw.startsWith("\\") ? (parseInt(chapIdRaw.slice(1), 8) & 0xff) : (parseInt(chapIdRaw, 10) & 0xff);

  const chapChallengeBytes = chapChRaw.includes("\\")
    ? parseOctalEscapedBytes(chapChRaw)
    : /^[0-9a-f]+$/i.test(chapChRaw) && chapChRaw.length % 2 === 0
      ? Buffer.from(chapChRaw, "hex")
      : chapChRaw.includes(",")
        ? Buffer.from(chapChRaw.split(",").map(x => parseInt(x.trim(), 10) & 0xff))
        : Buffer.from(chapChRaw, "utf8");

  return { chapId, chapChallengeBytes, chapIdRaw, chapChRaw };
}

async function main() {
  const username = "awing15-15";
  const passwordPlain = "awing15-15";

  const r1 = await fetch("http://186.186.0.1/login");
  const html = await r1.text();

  const chap = extractChapFromHtml(html);
  if (!chap) {
    console.error("❌ Không tìm thấy chap. Debug: vị trí chap_id =", html.toLowerCase().indexOf("chap_id"));
    console.error("Debug head:", html.slice(0, 800));
    return;
  }

  console.log("chapIdRaw =", chap.chapIdRaw);
  console.log("chapId =", chap.chapId);
  console.log("chapChallengeRaw head =", chap.chapChRaw.slice(0, 60));
  console.log("chapChallenge bytes =", chap.chapChallengeBytes.length);

  const hash = chapMD5(chap.chapId, chap.chapChallengeBytes, passwordPlain);
  console.log("chap hash =", hash);

  const form = new URLSearchParams({
    username,
    password: hash,
    dst: "http://v1.awingconnect.vn/Success",
    popup: "false"
  });

  const r2 = await fetch("http://186.186.0.1/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://v1.awingconnect.vn",
      referer: "http://v1.awingconnect.vn/"
    },
    body: form.toString(),
    redirect: "manual"
  });

  console.log("POST status =", r2.status, "location =", r2.headers.get("location"));

  const vr = await fetch("http://neverssl.com/", { redirect: "manual" });
  console.log("verify =", vr.status, vr.headers.get("location"));
}

main().catch(console.error);
