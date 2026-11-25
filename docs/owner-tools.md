# Owner-only tools

Both need you to be signed in with the same password as **Sync chats** in the AI chat (`OWNER_PASSWORD`).
Visitors never see them.

## Claude in the AI chat

- Add `ANTHROPIC_API_KEY` in Vercel (Sensitive, Production) and redeploy. Optional: `CLAUDE_MODEL` to change
  the first Claude model (default `claude-opus-5-5`).
- After signing in, the model picker lists **Claude** models. They are used **only when you pick one**:
  never on Auto and never as a fallback for another model, so they only spend your Anthropic credits when
  you ask for them. If Claude is overloaded or fails, the chat falls back to the free providers and says so
  under the reply.
- Claude can search the web (with sources) and can prepare downloadable files like the other models.
  It has a larger context window than the free models (40 messages / 60,000 characters).
- Owner requests are not rate-limited. Visitors keep the per-IP limit.
- Links like `/ai?prompt=...&model=claude` fill the message box and pick Claude (used by the dashboard).

## Project dashboard (`/dashboard`)

- Your private list of projects: status, priority, progress, next action, tasks and notes. Edits save
  automatically and sync between devices (stored in the same Upstash database as chat sync).
- **Import from portfolio** reads the project cards from the homepage.
- Each project with a GitHub repo shows last push, last commit, open PRs and issues (cached for 10 minutes).
  Optional: `GITHUB_TOKEN` (a read-only fine-grained token) to include private repos and avoid GitHub's low
  anonymous rate limit.
- **Ask Claude about this** opens the chat with Claude selected and a project briefing filled in.
