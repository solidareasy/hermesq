/**
 * Contract fixtures. Each one is either a provider's published test vector, output of the provider's
 * official SDK, or a response recorded from the real endpoint. Origin is noted per entry; do not edit
 * values by hand (re-record instead).
 */

/** GitHub docs, "Validating webhook deliveries" -> "Testing the webhook payload validation". */
export const GITHUB_VECTOR = {
  secret: "It's a Secret to Everybody",
  body: 'Hello, World!',
  signature: 'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
};

/** Slack docs, "Verifying requests from Slack" worked example. */
export const SLACK_VECTOR = {
  secret: '8f742231b10e8888abcd99yyyzzz85a5',
  timestamp: '1531420618',
  body: 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c',
  signature: 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
};

/**
 * Generated with the official `stripe` Node SDK 23.1.0 (`stripe.webhooks.generateTestHeaderString`) and
 * checked with `stripe.webhooks.constructEvent` before being copied here.
 */
export const STRIPE_VECTOR = {
  secret: 'whsec_test_secret',
  timestamp: 1731200000,
  body: '{"id":"evt_1QfixtureWebhookTransfer","object":"event","api_version":"2024-06-20","created":1731200000,"type":"invoice.payment_succeeded","data":{"object":{"id":"in_1Qfixture","object":"invoice","customer":"cus_Qfixture","amount_paid":4200,"currency":"usd"}},"livemode":false}',
  header: 't=1731200000,v1=e964b688461424b4ba184ce61e48ac3fb8887baccc9ccfde2c47e2b6f12486f2',
};

export interface RecordedResponse {
  status: number;
  body: unknown;
  /** Where the response came from. */
  source: string;
}

/** OAuth token / revoke endpoint answers. */
export const OAUTH = {
  linear: {
    /** Linear developer docs, "OAuth 2.0 authentication" -> token response (field set and types; token strings replaced). */
    tokenOk: {
      status: 200,
      source: 'linear.app/developers/oauth-2-0-authentication (documented response)',
      body: {
        access_token: 'linear-access-token-docs-example',
        token_type: 'Bearer',
        expires_in: 86399,
        scope: 'read write',
        refresh_token: 'linear-refresh-token-docs-example',
      },
    },
    /** Recorded 2026-11-10: POST https://api.linear.app/oauth/token with an unknown client. */
    invalidClient: {
      status: 400,
      source: 'recorded from api.linear.app/oauth/token, 2026-11-10',
      body: { error: 'invalid_client', error_description: 'Invalid client: client is invalid' },
    },
    /** Recorded 2026-11-10: POST https://api.linear.app/oauth/revoke with an unknown token. */
    revokeUnknownToken: {
      status: 401,
      source: 'recorded from api.linear.app/oauth/revoke, 2026-11-10',
      body: { error: 'Token not found' },
    },
  },
  slack: {
    /** Slack docs, oauth.v2.access -> "token rotation enabled" response. */
    tokenOk: {
      status: 200,
      source: 'docs.slack.dev/reference/methods/oauth.v2.access (documented response, token rotation)',
      body: {
        ok: true,
        access_token: 'xoxe.xoxb-1-fixture',
        token_type: 'bot',
        scope: 'commands,incoming-webhook',
        bot_user_id: 'U0KRQLJ9H',
        app_id: 'A0KRD7HC3',
        expires_in: 43200,
        refresh_token: 'xoxe-1-fixture',
        team: { name: 'Slack Softball Team', id: 'T9TK3CUKW' },
        enterprise: { name: 'slack-sports', id: 'E12345678' },
        authed_user: { id: 'U1234', scope: 'chat:write', access_token: 'xoxe.xoxp-1234', expires_in: 43200, refresh_token: 'xoxe-1-user', token_type: 'user' },
      },
    },
    /** Recorded 2026-11-10: POST https://slack.com/api/oauth.v2.access grant_type=authorization_code, bogus code. */
    invalidCode: { status: 200, source: 'recorded from slack.com/api/oauth.v2.access, 2026-11-10', body: { ok: false, error: 'invalid_code' } },
    /** Recorded 2026-11-10: POST https://slack.com/api/oauth.v2.access grant_type=refresh_token, bogus token. */
    invalidRefreshToken: { status: 200, source: 'recorded from slack.com/api/oauth.v2.access, 2026-11-10', body: { ok: false, error: 'invalid_refresh_token' } },
    /** Recorded 2026-11-10: POST https://slack.com/api/auth.revoke with a bogus bearer token. */
    revokeInvalidAuth: { status: 200, source: 'recorded from slack.com/api/auth.revoke, 2026-11-10', body: { ok: false, error: 'invalid_auth' } },
  },
} satisfies Record<string, Record<string, RecordedResponse>>;

export function asResponse(r: RecordedResponse): Response {
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
