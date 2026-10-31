import { env } from '../../config/env';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Public referral landing page: shows the code and opens the app. */
export function renderReferralLanding(rawCode: string): string {
  const code = String(rawCode ?? '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 10);
  const deepLink = `netride://referral?code=${encodeURIComponent(code)}`;
  const ios = env.IOS_APP_STORE_URL ?? '';
  const android = env.ANDROID_PLAY_STORE_URL ?? '';
  const stores = [
    ios ? `<a class="store" href="${esc(ios)}">Download on the App Store</a>` : '',
    android ? `<a class="store" href="${esc(android)}">Get it on Google Play</a>` : '',
  ].filter(Boolean).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Join NetRide</title>
<style>
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#EEEBE6;color:#2F3A32;min-height:100vh;display:grid;place-items:center;padding:24px}
.card{background:#fff;border:1px solid #D8D2CA;border-radius:24px;padding:32px 24px;max-width:420px;width:100%;text-align:center;box-shadow:0 20px 50px rgba(47,58,50,.12)}
h1{font-size:24px;margin:0 0 8px}p{color:#5B7760;line-height:1.5;margin:0 0 18px}
.code{font-size:26px;font-weight:800;letter-spacing:5px;color:#5B7760;background:#F7F4EF;border:1.5px solid #5B7760;border-radius:14px;padding:12px;margin-bottom:18px}
.open{display:inline-block;background:#5B7760;color:#fff;text-decoration:none;padding:14px 22px;border-radius:14px;font-weight:700;margin-bottom:12px}
.store{display:block;border:1.5px solid #5B7760;color:#5B7760;text-decoration:none;padding:13px 18px;border-radius:14px;font-weight:700;margin-top:10px}
.logo{font-weight:800;letter-spacing:-0.5px;color:#5B7760;margin-bottom:18px}
</style></head><body><main class="card">
<div class="logo">NetRide</div>
<h1>You're invited to NetRide</h1>
<p>Use this referral code when you sign up — you and your friend both earn ride credits.</p>
<div class="code">${esc(code)}</div>
<a class="open" href="${esc(deepLink)}">Open in NetRide</a>
${stores || '<p style="font-size:13px;color:#7c847d">App store links are not configured on this server yet.</p>'}
</main>
<script>setTimeout(function(){try{window.location.href=${JSON.stringify(deepLink)}}catch(e){}},350)</script>
</body></html>`;
}
