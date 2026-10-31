import { env } from '../../config/env';
import { buildGroupInviteDeepLink } from './group-invite.util';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Universal-link landing page for a group invitation.
 *
 * If the app is installed the custom-scheme deep link opens it immediately;
 * otherwise the user sees explicit store buttons. Store URLs come only from
 * environment configuration — this page never fabricates an app-store link.
 */
export function renderGroupJoinLanding(rawToken: string): string {
  const token = String(rawToken ?? '').slice(0, 256);
  const deepLink = buildGroupInviteDeepLink(token);
  const ios = env.IOS_APP_STORE_URL ?? '';
  const android = env.ANDROID_PLAY_STORE_URL ?? '';
  const storeButtons = [
    ios
      ? `<a class="store" href="${escapeHtml(ios)}">Download on the App Store</a>`
      : '',
    android
      ? `<a class="store" href="${escapeHtml(android)}">Get it on Google Play</a>`
      : '',
  ].filter(Boolean).join('');
  const fallbackNote = storeButtons
    ? ''
    : `<p class="hint">App store links are not configured on this server yet. Open NetRide and enter the invitation from your Groups inbox.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Join a NetRide group ride</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           background: #EEEBE6; color: #2F3A32; min-height: 100vh;
           display: grid; place-items: center; padding: 24px; }
    .card { background: #fff; border: 1px solid #D8D2CA; border-radius: 24px;
            padding: 32px 24px; max-width: 420px; width: 100%; text-align: center;
            box-shadow: 0 20px 50px rgba(47,58,50,.12); }
    h1 { font-size: 24px; margin: 0 0 8px; letter-spacing: -0.4px; }
    p { color: #5B7760; line-height: 1.5; margin: 0 0 20px; }
    .open { display: inline-block; background: #5B7760; color: #fff; text-decoration: none;
            padding: 14px 22px; border-radius: 14px; font-weight: 700; margin-bottom: 12px; }
    .store { display: block; border: 1.5px solid #5B7760; color: #5B7760;
             text-decoration: none; padding: 13px 18px; border-radius: 14px;
             font-weight: 700; margin-top: 10px; }
    .hint { font-size: 13px; color: #7c847d; margin-top: 14px; }
    .logo { font-weight: 800; letter-spacing: -0.5px; color: #5B7760; margin-bottom: 18px; }
  </style>
</head>
<body>
  <main class="card">
    <div class="logo">NetRide</div>
    <h1>You're invited to a group ride</h1>
    <p>Coordinate pickups, share a globally optimized route and split the fare with your friends.</p>
    <a class="open" href="${escapeHtml(deepLink)}">Open in NetRide</a>
    ${storeButtons}
    ${fallbackNote}
  </main>
  <script>
    // Attempt the app deep link; if it does not take over, the page stays
    // visible with the explicit store / open buttons. Never auto-redirect to
    // a store the server has not been configured with.
    setTimeout(function () {
      try { window.location.href = ${JSON.stringify(deepLink)}; } catch (e) {}
    }, 350);
  </script>
</body>
</html>`;
}
