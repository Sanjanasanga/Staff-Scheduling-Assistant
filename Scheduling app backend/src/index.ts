import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import path from "node:path";
import { existsSync } from "node:fs";
import { parseCommand, type Intent } from "./nlp.js";
import { handle, type AssistantResponse } from "./assistant.js";
import { events, holidays, rooms, users } from "./store.js";
import { hydrate, persistEvents } from "./store.js";
import { applySchema, ensureSeeded, migrate } from "./db.js";
import { aiParseCommand, isAiConfigured, type ChatTurn } from "./ai.js";
import {
  authStartUrl,
  cancelOutlookEvent,
  completeSignIn,
  connectedAccount,
  createOutlookEvent,
  disconnect,
  frontendUrl,
  isConfigured,
  isConnected,
  updateOutlookEvent,
} from "./graph.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    store: "postgres",
    outlook: { configured: isConfigured(), connected: await isConnected().catch(() => false) },
    ai: { configured: isAiConfigured() },
    events: events.filter((e) => e.status === "confirmed").length,
  });
});

// Directory metadata for the UI (people, rooms, holiday calendar).
app.get("/api/directory", (_req, res) => {
  res.json({ users, rooms, holidays });
});

// Full event list (confirmed only by default) for the calendar panel.
app.get("/api/events", (req, res) => {
  const all = String(req.query.all ?? "") === "true";
  res.json(all ? events : events.filter((e) => e.status === "confirmed"));
});

// ---- Outlook (Microsoft Graph) auth + sync --------------------------------

// Outlook connection status for the UI.
app.get("/api/auth/status", async (_req, res, next) => {
  try {
    res.json({ configured: isConfigured(), connected: await isConnected(), account: await connectedAccount() });
  } catch (err) {
    next(err);
  }
});

// Kick off the sign-in round-trip (top-level browser navigation lands here).
app.get("/api/auth/login", async (_req, res, next) => {
  try {
    if (!isConfigured()) {
      res.status(400).send("Microsoft Graph isn't configured. Set MS_CLIENT_ID / MS_CLIENT_SECRET and restart.");
      return;
    }
    res.redirect(await authStartUrl());
  } catch (err) {
    next(err);
  }
});

// Microsoft redirects back here with an auth code; exchange it, then bounce to the UI.
app.get("/api/auth/callback", async (req, res, next) => {
  try {
    const code = String(req.query.code ?? "");
    if (!code) {
      res.status(400).send(`Sign-in failed: ${String(req.query.error_description ?? "no auth code returned")}`);
      return;
    }
    await completeSignIn(code);
    res.redirect(`${frontendUrl()}/?outlook=connected`);
  } catch (err) {
    next(err);
  }
});

app.post("/api/auth/logout", async (_req, res, next) => {
  try {
    await disconnect();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Mirror a just-applied local change to the real Outlook calendar. Best-effort:
// Postgres is the source of truth, so a Graph failure is reported but doesn't
// roll back the command. Returns a note to surface in the chat, if any.
async function syncToOutlook(intent: Intent, response: AssistantResponse): Promise<string | null> {
  if (!(await isConnected().catch(() => false))) return null;
  try {
    if (response.createdEvent) {
      response.createdEvent.outlookEventId = await createOutlookEvent(response.createdEvent);
      return `📅 Added to your Outlook calendar — invitations sent by Outlook.`;
    }
    if (response.cancelledEvent) {
      await cancelOutlookEvent(response.cancelledEvent);
      return `📅 Removed from Outlook — cancellation notices sent.`;
    }
    if (response.updatedEvent && (intent === "reschedule" || intent === "add_participant" || intent === "remove_participant")) {
      if (response.updatedEvent.outlookEventId) await updateOutlookEvent(response.updatedEvent);
      else response.updatedEvent.outlookEventId = await createOutlookEvent(response.updatedEvent);
      return `📅 Updated in Outlook — change notices sent to attendees.`;
    }
  } catch (err) {
    return `⚠️ Saved locally, but Outlook sync failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
}

// The single conversational endpoint: parse → execute → persist → sync → reply.
app.post("/api/command", async (req, res, next) => {
  try {
    const text = String(req.body?.text ?? "").trim();
    if (!text) {
      res.status(400).json({ error: "Empty command." });
      return;
    }
    const mode = String(req.body?.mode ?? "rule");
    const history: ChatTurn[] = Array.isArray(req.body?.history)
      ? req.body.history
          .filter((t: unknown): t is ChatTurn => !!t && (t as ChatTurn).role !== undefined)
          .map((t: ChatTurn) => ({ role: t.role === "assistant" ? "assistant" : "user", text: String(t.text ?? "") }))
      : [];

    let intent: string;
    let response: AssistantResponse;

    if (mode === "ai" && isAiConfigured()) {
      try {
        const { command, directReply } = await aiParseCommand(text, history);
        intent = command.intent;
        response = directReply ? { reply: directReply } : handle(command);
      } catch (aiErr) {
        intent = "unknown";
        response = {
          reply: `⚠️ AI mode hit an error: ${aiErr instanceof Error ? aiErr.message : "unknown"}. Try again, or switch to **Rules**.`,
        };
      }
    } else if (mode === "ai") {
      intent = "unknown";
      response = {
        reply:
          "🤖 AI mode isn't configured yet — set **ANTHROPIC_API_KEY** in the backend `.env` and restart the server. " +
          "I'll keep using the rule-based engine until then.",
      };
    } else {
      const parsed = parseCommand(text);
      intent = parsed.intent;
      response = handle(parsed);
    }

    const mutated = Boolean(response.createdEvent || response.updatedEvent || response.cancelledEvent);
    if (mutated) {
      const note = await syncToOutlook(intent as Intent, response);
      if (note) response.notifications = [...(response.notifications ?? []), note];
      await persistEvents(); // after sync so outlookEventId is saved too
    }
    res.json({ ...response, intent });
  } catch (err) {
    next(err);
  }
});

// Single-service deploy: serve the built frontend from the backend so the whole
// app lives at one URL. In local dev the frontend runs on Vite and `dist` does
// not exist, so this block is skipped.
const distDir = process.env.FRONTEND_DIST || path.resolve(process.cwd(), "..", "Scheduling app frontend", "dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  // SPA fallback: any non-API GET returns index.html.
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.sendFile(path.join(distDir, "index.html"));
  });
  console.log(`[cos-scheduler] serving frontend from ${distDir}`);
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[cos-scheduler] error:", err);
  res.status(500).json({ error: err instanceof Error ? err.message : "Internal Server Error" });
});

const port = Number(process.env.PORT) || 4100;

// Boot: create the schema if missing, apply migrations, seed if empty, load the
// calendar into memory, then serve. This lets a fresh deploy self-initialize its
// database with no separate setup step.
applySchema()
  .then(migrate)
  .then(ensureSeeded)
  .then(hydrate)
  .then(() => {
    app.listen(port, () => {
      const mode = isConfigured() ? "Outlook configured" : "Outlook mock mode";
      console.log(`[cos-scheduler] API listening on http://localhost:${port} (postgres-backed · ${mode})`);
    });
  })
  .catch((err) => {
    console.error(
      "[cos-scheduler] startup failed. Is Postgres reachable (DATABASE_URL)?\n",
      err instanceof Error ? err.message : err,
    );
    process.exit(1);
  });
