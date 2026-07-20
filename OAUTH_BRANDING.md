# OAuth Branding & Redirect Configuration (REQUIRED)

The Google OAuth consent screen label — the text users see as
**"Logging in for <name>"** — is **not** controlled by application code.
It is determined by the Google Cloud OAuth client / consent screen that is
wired into the Supabase project used by NetRide.

Both the Rider and Driver Flutter apps delegate sign-in to Supabase Auth
(`supabase.auth.signInWithOAuth`), which federates Google. The consent-screen
product name therefore comes from the **Supabase Auth → Providers → Google**
configuration, which references a Google Cloud OAuth 2.0 client whose
**OAuth consent screen → App name** must be set to **`NetRide`**.

## Required Supabase / Google Cloud settings

1. **Google Cloud Console → APIs & Services → OAuth consent screen**
   - App name: `NetRide`
   - User support email / developer contact: a NetRide address
   - Authorized domains: include the Supabase project domain

2. **Google Cloud Console → Credentials → OAuth 2.0 Client ID** (the one used
   by Supabase for sign-in, NOT the `GMAIL_CLIENT_ID` in `backend/.env`, which
   is only for outbound email sending)
   - Make sure this is the client ID configured in Supabase.

3. **Supabase Dashboard → Authentication → Providers → Google**
   - Client ID / Secret: the Google client from step 2.
   - Ensure the **Authorized redirect URI** includes the NetRide mobile
     callback:
       `io.supabase.netride://login-callback/`
   - After this is set, the consent screen will read **"Logging in for NetRide"**
     instead of a blank label or a Supabase/Supabase-project identifier.

## Why the wrong label appeared

- The consent "app name" was whatever the linked Google OAuth client was
  registered as (or fell back to the Supabase project identifier) rather than
  `NetRide`.
- The `GMAIL_CLIENT_ID` in `backend/.env` (`672761115284-...apps.googleusercontent.com`)
  is **only** for sending email via the Gmail API and must NOT be confused with
  the sign-in client. It is unrelated to the consent-screen branding.

## Application-side guarantees (code)

- Both apps call `AuthService.getAppName()` (backend `GET /api/auth/config`,
  returns `{ "app_name": "NetRide" }`) and use
  `authScreenLaunchMode: LaunchMode.inAppBrowserView` so the sign-in experience
  stays inside the app where NetRide branding is shown consistently.
- The redirect URI is identical across Rider and Driver apps:
  `io.supabase.netride://login-callback/`.
- No application name string is sent to Google from code; the canonical name is
  centralized in `backend/src/modules/auth/auth.controller.ts → getPublicConfig`.

## Verification checklist

- [ ] Google Cloud OAuth consent screen app name = `NetRide`
- [ ] Supabase Google provider uses that client ID
- [ ] Supabase authorized redirect URI includes `io.supabase.netride://login-callback/`
- [ ] Rider + Driver apps build and the consent screen shows "Logging in for NetRide"
