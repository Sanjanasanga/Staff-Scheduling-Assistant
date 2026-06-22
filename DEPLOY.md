# Deploy a live demo (one public URL)

The app deploys as **one web service + a Postgres database**. The backend serves
the built frontend and the API together, and **self-initializes the database on
first boot** (creates tables, loads demo data) — no manual setup step.

## Render (free, recommended)

1. **Push this project to a GitHub repo** (see below if it isn't one yet).
2. Go to <https://render.com> → sign up (free) → **New → Blueprint**.
3. **Connect your GitHub repo.** Render reads [`render.yaml`](render.yaml) and
   proposes a web service + a free Postgres database. Click **Apply**.
4. Wait for the first build/deploy (~3–5 min). Render gives you a public URL like
   **`https://cos-scheduler.onrender.com`** — that's the link to share.

Notes:
- The free web service **sleeps after ~15 min idle**, so the first hit after a
  while takes ~30–60s to wake. Open it once before the interview to warm it.
- `DATABASE_URL` is injected by Render from the Postgres instance; SSL is handled
  automatically (the app enables SSL for non-local databases).
- The free Postgres instance expires after ~30 days — fine for an interview.

## Turn the project into a GitHub repo

`gh` is already authenticated on this machine. From the project root
(`scheduling-app/`):

```bash
git init -b main
git add -A
git commit -m "Chief of Staff scheduling assistant"
gh repo create cos-scheduling-assistant --private --source=. --push
```

That prints the repo URL (the **code** link). Use `--public` instead of
`--private` if you want it openly viewable. To let the interviewer see a private
repo, add them: `gh repo edit --add-collaborator <their-github-username>` (or via
the repo's *Settings → Collaborators*).

## Run it locally instead

```bash
./run.sh            # installs, sets up the DB, starts both servers
# → frontend http://localhost:5173   backend http://localhost:4100
```
