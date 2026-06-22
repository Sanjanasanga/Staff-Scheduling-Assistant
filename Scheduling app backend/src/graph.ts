// Microsoft Graph integration: signs the user in (delegated OAuth auth-code
// flow via MSAL) and mirrors event create / reschedule / cancel / attendee
// changes to their real Outlook calendar. Outlook sends the invitation, update,
// and cancellation emails automatically — that is our "notify" path.
//
// Entirely optional: if MS_CLIENT_ID / MS_CLIENT_SECRET aren't configured the
// app runs in mock mode and every function here is a guarded no-op, so the rest
// of the codebase doesn't need to know whether Outlook is connected.
import {
  ConfidentialClientApplication,
  type Configuration,
  type ICachePlugin,
  type TokenCacheContext,
} from "@azure/msal-node";
import { getState, setState } from "./db.js";
import { findRoom, findUser } from "./scheduler.js";
import type { CalendarEvent } from "./types.js";

const CLIENT_ID = process.env.MS_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.MS_CLIENT_SECRET ?? "";
// "consumers" = personal Microsoft accounts; "common" = personal + work/school.
const TENANT = process.env.MS_TENANT ?? "consumers";
const REDIRECT_URI = process.env.MS_REDIRECT_URI ?? "http://localhost:4100/api/auth/callback";
// Where to send the browser back to after the sign-in round-trip.
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:5173";

// Graph resource scopes (MSAL adds openid/profile/offline_access itself).
const SCOPES = ["User.Read", "Calendars.ReadWrite"];
const GRAPH = "https://graph.microsoft.com/v1.0";
const CACHE_KEY = "msal_cache";

export function isConfigured(): boolean {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

// Persist MSAL's token cache (which holds the refresh token + account) in
// Postgres so the connection survives restarts.
const cachePlugin: ICachePlugin = {
  async beforeCacheAccess(ctx: TokenCacheContext) {
    const blob = await getState(CACHE_KEY);
    if (blob) ctx.tokenCache.deserialize(blob);
  },
  async afterCacheAccess(ctx: TokenCacheContext) {
    if (ctx.cacheHasChanged) await setState(CACHE_KEY, ctx.tokenCache.serialize());
  },
};

let cca: ConfidentialClientApplication | null = null;
function client(): ConfidentialClientApplication {
  if (!isConfigured()) throw new Error("Microsoft Graph is not configured (set MS_CLIENT_ID / MS_CLIENT_SECRET).");
  if (!cca) {
    const config: Configuration = {
      auth: {
        clientId: CLIENT_ID,
        authority: `https://login.microsoftonline.com/${TENANT}`,
        clientSecret: CLIENT_SECRET,
      },
      cache: { cachePlugin },
    };
    cca = new ConfidentialClientApplication(config);
  }
  return cca;
}

// ---- auth round-trip ------------------------------------------------------

export function frontendUrl(): string {
  return FRONTEND_URL;
}

export function authStartUrl(): Promise<string> {
  return client().getAuthCodeUrl({ scopes: SCOPES, redirectUri: REDIRECT_URI });
}

export async function completeSignIn(code: string): Promise<void> {
  await client().acquireTokenByCode({ code, scopes: SCOPES, redirectUri: REDIRECT_URI });
}

export async function connectedAccount(): Promise<string | null> {
  if (!isConfigured()) return null;
  const accounts = await client().getTokenCache().getAllAccounts();
  return accounts[0]?.username ?? null;
}

export async function isConnected(): Promise<boolean> {
  return (await connectedAccount()) !== null;
}

export async function disconnect(): Promise<void> {
  if (!isConfigured()) return;
  const cache = client().getTokenCache();
  for (const acct of await cache.getAllAccounts()) await cache.removeAccount(acct);
  await setState(CACHE_KEY, cache.serialize());
}

// Acquire a Graph access token for the connected account (refreshes silently).
async function accessToken(): Promise<string | null> {
  if (!isConfigured()) return null;
  const cache = client().getTokenCache();
  const account = (await cache.getAllAccounts())[0];
  if (!account) return null;
  const result = await client().acquireTokenSilent({ account, scopes: SCOPES });
  return result?.accessToken ?? null;
}

// ---- Graph REST helpers ---------------------------------------------------

async function graphFetch(token: string, path: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Graph ${init?.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

// Map our CalendarEvent → a Graph event body. Times are sent as UTC; attendees
// are everyone except the organizer (Graph emails them the invitation).
function toGraphEvent(event: CalendarEvent): Record<string, unknown> {
  const room = findRoom(event.roomId);
  const attendees = event.attendeeIds
    .filter((id) => id !== event.organizerId)
    .map((id) => findUser(id))
    .filter((u): u is NonNullable<typeof u> => Boolean(u))
    .map((u) => ({ emailAddress: { address: u.email, name: u.name }, type: "required" }));
  return {
    subject: event.title,
    body: { contentType: "text", content: event.agenda || "" },
    start: { dateTime: event.start.replace(/\.\d{3}Z$/, "").replace(/Z$/, ""), timeZone: "UTC" },
    end: { dateTime: event.end.replace(/\.\d{3}Z$/, "").replace(/Z$/, ""), timeZone: "UTC" },
    location: room ? { displayName: room.name } : undefined,
    attendees,
  };
}

// Create the event in Outlook; returns the Graph event id (invitations sent).
export async function createOutlookEvent(event: CalendarEvent): Promise<string | null> {
  const token = await accessToken();
  if (!token) return null;
  const created = (await graphFetch(token, "/me/events", {
    method: "POST",
    body: JSON.stringify(toGraphEvent(event)),
  })) as { id: string };
  return created.id;
}

// Patch an existing Outlook event (time / attendee changes → update emails).
export async function updateOutlookEvent(event: CalendarEvent): Promise<void> {
  const token = await accessToken();
  if (!token || !event.outlookEventId) return;
  await graphFetch(token, `/me/events/${event.outlookEventId}`, {
    method: "PATCH",
    body: JSON.stringify(toGraphEvent(event)),
  });
}

// Cancel (not just delete) so attendees receive a cancellation notice.
export async function cancelOutlookEvent(event: CalendarEvent, comment = "This meeting has been cancelled."): Promise<void> {
  const token = await accessToken();
  if (!token || !event.outlookEventId) return;
  await graphFetch(token, `/me/events/${event.outlookEventId}/cancel`, {
    method: "POST",
    body: JSON.stringify({ comment }),
  });
}
