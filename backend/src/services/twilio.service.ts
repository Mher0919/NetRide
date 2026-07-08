// backend/src/services/twilio.service.ts
//
// Thin wrapper around Twilio for the masked-call path. Two public
// surfaces, each with a single responsibility:
//
//   1. mintAccessToken(userId, tripId) — generates a short-lived Voice
//      Client access token scoped to a single trip. The token is what
//      the Flutter Voice SDK uses to register as `identity = userId`
//      so Twilio knows who is joining the conference.
//
//   2. connectToConference({...}) — issues the TwiML that the Voice
//      SDK's outbound dial runs through. We respond with <Client><Conference>
//      so both legs land in the same named conference without ever
//      exchanging real phone numbers.
//
// Real phone numbers stay on the server. The client only ever sees
// the conference name (`trip-{id}`) and a JWT that expires in 5 minutes.
import twilio from 'twilio';
import { env } from '../config/env';

const CALL_TOKEN_TTL_SECONDS = 5 * 60; // 5 minutes — enough for one call

export interface CallToken {
  token: string;
  identity: string;
  conferenceName: string;
  expiresAt: number; // unix seconds
}

export class TwilioService {
  /**
   * Returns false when Twilio credentials are missing. Callers should
   * surface a friendly error to the user rather than crashing the
   * request — chat still works without calls.
   */
  static isConfigured(): boolean {
    return Boolean(
      env.TWILIO_ACCOUNT_SID &&
        env.TWILIO_API_KEY &&
        env.TWILIO_API_SECRET,
    );
  }

  /**
   * Build a per-user, per-trip conference name. Both legs of the call
   * derive the same name from the same tripId so Twilio puts them in
   * the same room.
   */
  static conferenceNameFor(tripId: string): string {
    return `trip-${tripId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 60)}`;
  }

  static mintAccessToken(userId: string, tripId: string): CallToken {
    if (!this.isConfigured()) {
      throw new Error(
        'Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_API_KEY and TWILIO_API_SECRET.',
      );
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const accessToken = new AccessToken(
      env.TWILIO_ACCOUNT_SID!,
      env.TWILIO_API_KEY!,
      env.TWILIO_API_SECRET!,
      {
        identity: userId,
        ttl: CALL_TOKEN_TTL_SECONDS,
      },
    );

    const grant = new VoiceGrant({
      outgoingApplicationSid: env.TWILIO_TWIML_APP_SID ?? '',
      incomingAllow: true,
    });
    accessToken.addGrant(grant);

    const now = Math.floor(Date.now() / 1000);
    return {
      token: accessToken.toJwt(),
      identity: userId,
      conferenceName: this.conferenceNameFor(tripId),
      expiresAt: now + CALL_TOKEN_TTL_SECONDS,
    };
  }

  /**
   * TwiML returned to Twilio when the Voice SDK places an outbound
   * call. The "to" parameter on the SDK side is ignored — we route
   * every call into the conference room for the trip.
   */
  static conferenceTwiML(conferenceName: string): string {
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const dial = response.dial();
    dial.conference(
      {
        // `startConferenceOnEnter: true` keeps the room alive even if
        // one party hangs up first, which prevents the other side from
        // being kicked out mid-sentence.
        startConferenceOnEnter: true,
        endConferenceOnExit: false,
        // Mute on entry means the callee doesn't blast the caller with
        // background noise before they pick up; the caller can unmute
        // once the callee joins.
        muted: false,
        // `beep: false` skips the Twilio join-tone (off by default).
        beep: 'false' as any,
      },
      conferenceName,
    );
    return response.toString();
  }

  /**
   * Server-initiated call leg: dial the driver's or rider's real phone
   * number and drop them into the conference. Used as a graceful
   * fallback when one side doesn't have Voice SDK support. Both numbers
   * stay on the server; we never return them to the other party.
   */
  static async callIntoConference(
    toPhoneNumber: string,
    conferenceName: string,
    callerId?: string,
  ): Promise<{ sid: string; status: string }> {
    if (!this.isConfigured()) {
      throw new Error('Twilio is not configured.');
    }
    const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    const call = await client.calls.create({
      to: toPhoneNumber,
      from: callerId ?? env.TWILIO_CALLER_ID ?? '',
      twiml: this.conferenceTwiML(conferenceName),
    });
    return { sid: call.sid, status: call.status };
  }
}

export const twilioService = TwilioService;