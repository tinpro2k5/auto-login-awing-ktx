// httpClient/probe.ts
import * as fs from "fs";
import * as path from "path";

const BASE = "http://186.186.0.1";
const OUT_DIR = path.join(process.cwd(), "probe_out");

// Keywords bạn quan tâm để tìm flow & chỗ sinh chap/session/login
const HIT_RE =
  /awingconnect|login\.net\.vn|api-connect\/check|chap[_-]?id|chap[_-]?challenge|Connecting\?sessionId|\/Success\b|\/Home\/VerifyUrl|\/Content\/GetCustomer|\/Content\/GetCampaignHtml|\/Analytic\/Send/i;

function ensureOutDir() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}

async function fetchText(url: string) {
  const started = Date.now();
  const res = await fetch(url, { redirect: "follow" });
  const text = await res.text();
  const ms = Date.now() - started;
  console.log(`GET ${url} => ${res.status} (${text.length} bytes, ${ms}ms)`);
  return { status: res.status, headers: res.headers, text };
}

function extractScriptSrc(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  return [...new Set(out)];
}

function normalizeUrl(src: string) {
  if (/^https?:\/\//i.test(src)) return src;
  if (src.startsWith("/")) return `${BASE}${src}`;
  return `${BASE}/${src}`;
}

function grepSnippets(text: string, re: RegExp, maxSnips = 12) {
  const snips: string[] = [];
  const lines = text.split(/\r?\n/);

  // 1) line-based hits (good for JSON)
  for (let i = 0; i < lines.length && snips.length < maxSnips; i++) {
    if (re.test(lines[i])) snips.push(`L${i + 1}: ${lines[i].slice(0, 260)}`);
  }

  // 2) fallback: regex window snippets (good for minified JS)
  if (snips.length < maxSnips) {
    const winRe = new RegExp(`.{0,80}(${re.source}).{0,120}`, re.flags);
    const m = text.match(winRe);
    if (m?.[0]) snips.push(`SNIP: ${m[0]}`);
  }

  return snips;
}

function saveFile(name: string, content: string) {
  ensureOutDir();
  const fp = path.join(OUT_DIR, name);
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

async function main() {
  ensureOutDir();
  console.log("=== PROBE START ===");
  console.log("BASE =", BASE);
  console.log("OUT  =", OUT_DIR);

  // 1) Fetch /login (SPA shell)
  const loginUrl = `${BASE}/login`;
  const { text: html } = await fetchText(loginUrl);
  saveFile("login.html", html);

  // 2) Fetch config & build-info (you sniffed these)
  const cfgUrl = `${BASE}/assets/config.json`;
  const biUrl = `${BASE}/build-info.json`;

  try {
    const cfg = await fetchText(cfgUrl);
    saveFile("config.json", cfg.text);
    const hits = grepSnippets(cfg.text, HIT_RE, 50);
    if (hits.length) {
      console.log("\n=== HIT in config.json ===");
      hits.forEach(h => console.log("  ", h));
    } else {
      console.log("\n(no HIT in config.json)");
    }
  } catch (e) {
    console.log("config.json fetch failed:", e);
  }

  try {
    const bi = await fetchText(biUrl);
    saveFile("build-info.json", bi.text);
    const hits = grepSnippets(bi.text, HIT_RE, 50);
    if (hits.length) {
      console.log("\n=== HIT in build-info.json ===");
      hits.forEach(h => console.log("  ", h));
    } else {
      console.log("\n(no HIT in build-info.json)");
    }
  } catch (e) {
    console.log("build-info.json fetch failed:", e);
  }

  // 3) Extract all script src from /login and fetch each
  const scripts = extractScriptSrc(html);
  console.log("\n=== scripts in /login ===");
  scripts.forEach(s => console.log(" -", s));
  saveFile("scripts.txt", scripts.join("\n"));

  // 4) Download scripts and grep for HIT keywords
  console.log("\n=== scanning scripts ===");
  let hitCount = 0;

  for (let i = 0; i < scripts.length; i++) {
    const src = scripts[i];
    const url = normalizeUrl(src);

    let jsText = "";
    try {
      const r = await fetchText(url);
      jsText = r.text;
    } catch (e) {
      console.log(`!! script fetch failed: ${url}`, e);
      continue;
    }

    const hasHit = HIT_RE.test(jsText);
    const nameSafe = `script_${String(i).padStart(2, "0")}_${path
      .basename(src)
      .replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    // always save a small preview to avoid huge writes (but save full hit bundles)
    if (hasHit) {
      hitCount++;
      const fp = saveFile(`${nameSafe}.js`, jsText);
      console.log(`\n🔥 HIT #${hitCount}: ${url}`);
      console.log("   saved:", fp);

      const snips = grepSnippets(jsText, HIT_RE, 20);
      snips.forEach(s => console.log("   ", s));

      // Also try to extract full URLs (helps to find exact endpoints)
      const urls = [...jsText.matchAll(/https?:\/\/[a-zA-Z0-9._:-]+[^\s"'\\)]+/g)]
        .slice(0, 50)
        .map(m => m[0]);
      if (urls.length) {
        console.log("   urls (first 50):");
        urls.forEach(u => console.log("    -", u));
        saveFile(`${nameSafe}.urls.txt`, urls.join("\n"));
      }

      // Optional: stop after first hit to reduce load
      // break;
    } else {
      // save a small head snippet for debugging
      saveFile(`${nameSafe}.head.txt`, jsText.slice(0, 2000));
    }
  }

  console.log("\n=== PROBE DONE ===");
  console.log("Hit bundles:", hitCount);
  console.log("Output dir:", OUT_DIR);
  console.log("Next: mở probe_out/*.js hoặc *.urls.txt để thấy endpoint chap/login nằm ở đâu.");
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
