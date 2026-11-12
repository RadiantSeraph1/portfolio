// Owner-only project dashboard API.
//   GET  /api/dashboard                         -> { projects: [...] }
//   POST /api/dashboard  { upsert: [...], delete: [ids] }
//   GET  /api/dashboard?action=github&repos=owner/a,owner/b
//                                               -> { repos: { "owner/a": {...} } } (cached 10 minutes)
//
// Needs the owner sign-in token (same as /api/sync) and the Upstash Redis connection.
// Optional: GITHUB_TOKEN (a read-only fine-grained token) to include private repos and avoid
// GitHub's low anonymous rate limit.

import { redis, pipeline, redisConfigured } from "./_redis.js";
import { isOwner } from "./_auth.js";

const PROJECTS_KEY = "dash:projects";
const GITHUB_CACHE_SECONDS = 600;
const MAX_PROJECTS = 200;
const MAX_BATCH = 50;
const ID_RE = /^[\w-]{1,64}$/;
const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const STATUSES = ["idea", "building", "live", "paused", "done"];
const PRIORITIES = ["high", "medium", "low"];

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
const httpUrl = (v) => (typeof v === "string" && /^https?:\/\/[^\s]+$/i.test(v) ? v.slice(0, 500) : "");

/** Check and normalise a project from the browser. Returns null if invalid. */
function cleanProject(p) {
  if (!p || typeof p !== "object" || typeof p.id !== "string" || !ID_RE.test(p.id)) return null;
  if (!Number.isFinite(p.updated)) return null;
  const name = str(p.name, 120).trim();
  if (!name) return null;

  const repo = str(p.repo, 201).trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$|\/$/g, "");
  const tasks = (Array.isArray(p.tasks) ? p.tasks : [])
    .slice(0, 100)
    .filter((t) => t && typeof t.text === "string" && t.text.trim())
    .map((t) => ({
      id: ID_RE.test(String(t.id)) ? String(t.id) : Math.random().toString(36).slice(2, 10),
      text: t.text.trim().slice(0, 300),
      done: Boolean(t.done),
    }));

  return {
    id: p.id,
    name,
    kind: str(p.kind, 60),
    summary: str(p.summary, 600),
    status: STATUSES.includes(p.status) ? p.status : "idea",
    priority: PRIORITIES.includes(p.priority) ? p.priority : "medium",
    progress: Math.max(0, Math.min(100, Math.round(Number(p.progress) || 0))),
    url: httpUrl(p.url),
    repo: REPO_RE.test(repo) ? repo : "",
    tags: (Array.isArray(p.tags) ? p.tags : []).map((t) => str(t, 30).trim()).filter(Boolean).slice(0, 12),
    nextAction: str(p.nextAction, 300),
    notes: str(p.notes, 20_000),
    tasks,
    created: Number.isFinite(p.created) ? Math.floor(p.created) : Math.floor(p.updated),
    updated: Math.floor(p.updated),
  };
}

async function listProjects() {
  const flat = (await redis(["HGETALL", PROJECTS_KEY])) || [];
  const projects = [];
  for (let i = 1; i < flat.length; i += 2) {
    try {
      projects.push(JSON.parse(flat[i]));
    } catch {}
  }
  return json(200, { projects });
}

async function saveProjects(request) {
  const body = await request.json().catch(() => null);
  if (!body) return json(400, { error: "Invalid request." });

  const upserts = (Array.isArray(body.upsert) ? body.upsert : []).slice(0, MAX_BATCH).map(cleanProject).filter(Boolean);
  const deletes = (Array.isArray(body.delete) ? body.delete : []).filter((id) => typeof id === "string" && ID_RE.test(id)).slice(0, MAX_BATCH);

  const commands = [];
  const accepted = [];
  if (upserts.length) {
    const ids = upserts.map((p) => p.id);
    const [existing, count] = await pipeline([["HMGET", PROJECTS_KEY, ...ids], ["HLEN", PROJECTS_KEY]]);
    let total = Number(count || 0);
    upserts.forEach((p, i) => {
      let storedUpdated = 0;
      try {
        storedUpdated = existing[i] ? JSON.parse(existing[i]).updated : 0;
      } catch {}
      if (p.updated < storedUpdated) return; // a newer edit from another device wins
      if (!existing[i]) {
        if (total >= MAX_PROJECTS) return;
        total++;
      }
      commands.push(["HSET", PROJECTS_KEY, p.id, JSON.stringify(p)]);
      accepted.push(p.id);
    });
  }
  if (deletes.length) commands.push(["HDEL", PROJECTS_KEY, ...deletes]);

  await pipeline(commands);
  return json(200, { ok: true, accepted });
}

async function github(path) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "radiant-dashboard" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function repoInfo(repo) {
  try {
    const [info, commits, pulls] = await Promise.all([
      github(`/repos/${repo}`),
      github(`/repos/${repo}/commits?per_page=1`),
      github(`/repos/${repo}/pulls?state=open&per_page=100`),
    ]);
    const c = commits?.[0];
    return {
      url: info.html_url,
      private: Boolean(info.private),
      language: info.language || "",
      stars: info.stargazers_count || 0,
      pushedAt: info.pushed_at,
      // GitHub counts open PRs as issues too.
      openIssues: Math.max(0, (info.open_issues_count || 0) - (pulls?.length || 0)),
      openPrs: pulls?.length || 0,
      lastCommit: c
        ? {
            message: String(c.commit?.message || "").split("\n")[0].slice(0, 200),
            date: c.commit?.author?.date || c.commit?.committer?.date || "",
            url: c.html_url,
          }
        : null,
    };
  } catch (err) {
    const error =
      err.status === 404
        ? "Repository not found (private repos need GITHUB_TOKEN)."
        : err.status === 403 || err.status === 429
          ? "GitHub rate limit reached. Add GITHUB_TOKEN for a higher limit."
          : "Couldn't reach GitHub.";
    return { error };
  }
}

async function githubStatus(request) {
  const repos = [
    ...new Set(
      (new URL(request.url).searchParams.get("repos") || "")
        .split(",")
        .map((r) => r.trim())
        .filter((r) => REPO_RE.test(r))
    ),
  ].slice(0, 30);
  if (!repos.length) return json(200, { repos: {} });

  const cached = await redis(["MGET", ...repos.map((r) => `dash:gh:${r.toLowerCase()}`)]);
  const result = {};
  const missing = [];
  repos.forEach((r, i) => {
    try {
      if (cached?.[i]) result[r] = JSON.parse(cached[i]);
      else missing.push(r);
    } catch {
      missing.push(r);
    }
  });

  const fresh = await Promise.all(missing.map(repoInfo));
  const commands = [];
  missing.forEach((r, i) => {
    result[r] = fresh[i];
    // Cache errors briefly so a typo doesn't hammer GitHub, successes for 10 minutes.
    commands.push(["SET", `dash:gh:${r.toLowerCase()}`, JSON.stringify(fresh[i]), "EX", fresh[i].error ? 120 : GITHUB_CACHE_SECONDS]);
  });
  await pipeline(commands);
  return json(200, { repos: result });
}

async function handle(request, method) {
  if (!redisConfigured) return json(503, { error: "Storage isn't connected yet." });
  if (!isOwner(request)) return json(401, { error: "Please sign in." });

  try {
    const action = new URL(request.url).searchParams.get("action");
    if (method === "GET" && action === "github") return await githubStatus(request);
    if (method === "GET") return await listProjects();
    if (method === "POST") return await saveProjects(request);
    return json(405, { error: "Method not allowed." });
  } catch (err) {
    console.error("dashboard error:", err?.message);
    return json(502, { error: "The dashboard storage had a problem. Please try again." });
  }
}

export const GET = (request) => handle(request, "GET");
export const POST = (request) => handle(request, "POST");
