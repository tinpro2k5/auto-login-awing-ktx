# Auto Login AWING KTX

Auto-login tool for AWING captive portal.

Current repo has 2 implementations:
- `httpClient/index.ts`: primary implementation (no browser, loop mode, auto renew).
- `playwright/*`: UI automation flow (kept as alternative/debug path).

## Requirements
- Node.js 18+
- npm
- Windows is recommended for fallback serial detection (`netsh`, `arp`) in `httpClient`.

## Install
```bash
npm install
```

## Run

Primary runner (recommended):
```bash
npx ts-node httpClient/index.ts
```

Alternative runner (Playwright flow):
```bash
npx ts-node playwright/index.ts
```

## How `httpClient` Works
1. Detect internet/captive state using:
   - `http://connectivitycheck.gstatic.com/generate_204`
2. Run forever in loop mode:
   - If `ONLINE`: start timer and renew check around `14m50s`
   - If `CAPTIVE`: run login flow immediately
3. Login flow:
   - Read `wifiInfo` from `http://186.186.0.1/login`
   - Resolve AWING portal login URL:
     - First try check API: `https://ex.login.net.vn/api-connect/check`
     - Fallback build URL from local params/serial
   - Call `Home/VerifyUrl`, parse `contentAuthenForm`
   - Submit form to `http://186.186.0.1/login`
4. Verify network again after login.

## Environment Variables
- `AWING_SKIP_CHECK_API=1`
  - Skip `ex.login.net.vn` and use fallback portal URL resolver directly.
- `AWING_SERIAL=AA:BB:CC:DD:EE:FF`
  - Force `serial` for fallback URL building.
  - Useful when auto-detected serial is wrong.

PowerShell example:
```powershell
$env:AWING_SKIP_CHECK_API='1'
$env:AWING_SERIAL='CC:2D:E0:19:00:6C'
npx ts-node httpClient/index.ts
```

## Common Issues
- `ENOTFOUND ex.login.net.vn`
  - Captive DNS cannot resolve external domain.
  - Use `AWING_SKIP_CHECK_API=1`.

- `Home/VerifyUrl` status `500`
  - Portal backend/context issue or wrong `serial`.
  - Try forcing `AWING_SERIAL`.

- `ECONNRESET` / `AbortError`
  - Transient captive backend/network instability.
  - Current code already has retries and request timeouts.

- Stuck in captive loop
  - Check whether `serial` is valid for your AP.
  - Verify router page still exposes valid `chap_id` and `chap_challenge`.

## Project Layout
- `httpClient/index.ts`: main runtime loop and HTTP login flow
- `playwright/index.ts`: browser-based fallback flow
- `sniffing/`: captured traffic logs and request/response dumps
- `probe_out/`: probe artifacts used during reverse engineering

## Notes
- This tool is tightly coupled to current AWING captive behavior.
- If portal API/flow changes, update parsers and fallback URL builder first.
