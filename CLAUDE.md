# BuildAI — Claude Code Configuration

Multi-agent orchestration for the BuildAI platform. Specialized agents handle specific domains — route tasks to the right agent for best results.

## Agent Roster

| Agent | Trigger keywords | Domain |
|-------|-----------------|--------|
| `backend-engineer` | API route, endpoint, service, FastAPI, Python, Pydantic, httpx, Render, aerial, renders.py, roofing.py | `/backend/` |
| `frontend-engineer` | component, page, React, Next.js, TypeScript, Tailwind, hook, carousel, viewer, dashboard | `/frontend/src/` |
| `database-architect` | schema, table, migration, RLS, Supabase, query, SQL, storage, bucket | Supabase |
| `security-auditor` | security, vulnerability, injection, auth, secrets, audit, CVE, XSS | Cross-cutting |
| `render-engineer` | render, image generation, Gemini, Pollinations, exterior view, room render, base64, carousel | Renders pipeline |
| `ui-designer` | design, layout, color, spacing, visual, UI, component styling, dark mode, loading state | Visual layer |
| `test-engineer` | test, pytest, spec, assertion, mock, coverage, integration test | Tests |

## Routing Rules

**Use a single agent** when the task clearly belongs to one domain.

**Use parallel agents** (spawn in one message) when a feature touches multiple domains. Example: new endpoint + UI to display it → spawn `backend-engineer` + `frontend-engineer` simultaneously.

**Always run `security-auditor`** before merging:
- New FastAPI endpoints that accept user input
- File upload handlers
- Auth flow changes
- Any code that calls external HTTP with user-supplied data

## Task Examples → Agent Mapping

```
"Add a new endpoint for permit status" → backend-engineer
"Fix the satellite viewer height bug" → frontend-engineer  
"Add RLS policy for new permits table" → database-architect
"Check the photo upload for injection risks" → security-auditor
"Fix renders not loading" → render-engineer
"Make the metrics cards look better" → ui-designer
"Write tests for the aerial report endpoint" → test-engineer

"Add permit filing feature (API + UI)" → backend-engineer + frontend-engineer (parallel)
"New AI feature end-to-end" → backend-engineer + frontend-engineer + security-auditor (parallel)
```

## Mandatory Behaviors (All Agents)

- **Read before editing** — always read a file before modifying it
- **No secrets in code** — never hardcode API keys, passwords, or tokens
- **No shell=True with user input** — all subprocess calls use argument lists
- **Validate at boundaries** — Pydantic for backend inputs, TypeScript types for API responses
- **Import asyncio** — every Python file using `asyncio.gather()` must import asyncio at top
- **Commit often** — after each meaningful change, commit with descriptive message
- **Push after backend changes** — Render auto-deploys from GitHub; changes don't go live until pushed

## BuildAI Stack Summary

```
Frontend:  Next.js 16 (Turbopack) → Vercel
Backend:   FastAPI (Python 3.11) → Render free tier
Database:  Supabase (Postgres 15) with RLS
Auth:      Supabase Auth (JWT)
AI (text): Gemini 2.0 Flash → Groq → Anthropic (fallback chain)
AI (img):  Gemini image gen → HuggingFace → Replicate → Pollinations URL
Search:    Tavily
Satellite: Esri World Imagery (free, no key)
```

## Critical Known Issues / Gotchas

- **Render cold starts**: 75 s warmup on free tier — frontend has 90 s default timeout + retry
- **Pollinations from Render**: cloud IPs blocked — never download server-side; return URL for browser or use Gemini instead
- **Esri tile format**: use `format=png` not `format=png32` (invalid)
- **Flex height**: `height: '100%'` resolves to 0 when parent is `height: auto` — always use `display: flex; flex-direction: column` on parent + `flex: 1 1 0; minHeight: 0` on child
- **asyncio.gather imports**: `import asyncio` must be explicit — it's NOT auto-imported
- **Gemini image gen**: returns `inline_data.data` (already base64, no re-encoding needed)
- **Photo multipart**: validate file type by magic bytes not Content-Type header

## Security Posture

- Supabase RLS on all tables (service-role key only in backend)
- JWT verification on authenticated endpoints  
- Input validation via Pydantic at all API boundaries
- No shell interpolation of user input
- No raw SQL string construction — always use Supabase client parameterized queries
- Image uploads validated by magic bytes (JPEG: `\xff\xd8`, PNG: `\x89PNG`, WebP: offset 8-12 `WEBP`)
