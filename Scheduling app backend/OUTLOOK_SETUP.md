# Connecting a real Outlook calendar (Microsoft Graph)

The backend mirrors event **create / reschedule / cancel / attendee** changes to a
real Outlook calendar via Microsoft Graph. Outlook then sends the invitation,
update, and cancellation **emails automatically** — that's the "notify" path.

Without the `MS_*` env vars the app runs in **mock mode** (everything works,
nothing is written to a real calendar). These steps switch it to live mode with
a **personal Microsoft account** (outlook.com).

---

## 1. Create a personal Microsoft account (skip if you have one)

Go to <https://signup.live.com> and create an `@outlook.com` address. This is the
mailbox/calendar the assistant will write to.

## 2. Register an app in Microsoft Entra ID

1. Open <https://entra.microsoft.com> → **Applications → App registrations** →
   **New registration** (sign in with the account from step 1).
2. **Name:** `CoS Scheduling Assistant`
3. **Supported account types:** *Personal Microsoft accounts only*
   (or *…any organizational directory and personal Microsoft accounts*).
4. **Redirect URI:** platform **Web**, value:
   ```
   http://localhost:4100/api/auth/callback
   ```
5. Click **Register**, then copy the **Application (client) ID** → this is
   `MS_CLIENT_ID`.

## 3. Create a client secret

App → **Certificates & secrets → New client secret** → add → **copy the
`Value`** immediately (not the Secret ID) → this is `MS_CLIENT_SECRET`.
(The value is only shown once.)

## 4. Add the Graph permission

App → **API permissions → Add a permission → Microsoft Graph → Delegated
permissions** → add:

- `Calendars.ReadWrite`
- `offline_access`
- `User.Read` (usually present by default)

No admin consent needed — you consent yourself at sign-in.

## 5. Configure the backend

Create `Scheduling app backend/.env` (copy from `.env.example`):

```bash
DATABASE_URL=postgresql://<your-os-user>@localhost:5432/cos_scheduler
MS_CLIENT_ID=<application (client) id from step 2>
MS_CLIENT_SECRET=<secret value from step 3>
MS_TENANT=consumers                 # personal accounts. Use "common" if you chose the mixed option in step 2.
MS_REDIRECT_URI=http://localhost:4100/api/auth/callback
FRONTEND_URL=http://localhost:5173
```

Apply the (idempotent) DB migration if you seeded before this feature:

```bash
npm run dev      # boot once — it auto-adds the new column/table; no data loss
```

## 6. Connect

1. Open the UI at <http://localhost:5173>.
2. Top bar now shows **Connect Outlook** → click it → sign in → **Accept** the
   consent screen.
3. You're redirected back; the bar shows **Outlook: you@outlook.com**.

`/api/health` and `/api/auth/status` will report `connected: true`.

## 7. Test it

- **See an event land on your calendar (no email needed):**
  `Block a 60-minute working session tomorrow at 2pm` → appears on your Outlook
  calendar immediately.
- **Test invitations:** the seeded attendees use placeholder `@example.com`
  addresses, so invites to them will bounce. To send a real invite, edit one
  person's email in `src/seedData.ts` to an inbox you control, run
  `npm run db:setup`, then `Schedule 'Hello' with <that person> tomorrow at 3pm,
  agenda: test` — Outlook emails the invitation.

---

## Notes & troubleshooting

- **Source of truth is still Postgres.** Outlook is a best-effort mirror; if a
  Graph call fails the command still succeeds locally and the chat shows a
  `⚠️ Outlook sync failed: …` note.
- **`unauthorized_client` / `AADSTS50194`** → the app's *Supported account types*
  doesn't include personal accounts, or `MS_TENANT` doesn't match (use
  `consumers` for personal-only, `common` for mixed).
- **Redirect mismatch (`AADSTS50011`)** → `MS_REDIRECT_URI` must match the
  registered Web redirect URI **exactly**.
- **Disconnect** from the top bar clears the stored token (the MSAL cache lives
  in the `app_state` table).
