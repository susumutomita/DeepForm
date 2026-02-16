<div align="center">

<img src="https://img.shields.io/badge/AI-Depth_Interview-81a2be?style=for-the-badge" alt="AI Depth Interview">
<img src="https://img.shields.io/badge/spec.json-Export-8c9440?style=for-the-badge" alt="spec.json Export">
<img src="https://img.shields.io/badge/Open_Source-Free-b5bd68?style=for-the-badge" alt="Open Source">

# DeepForm

**From vague idea to deployable spec — in one sitting.**

AI-powered depth interviews that extract requirements non-engineers miss,
then generate production-ready PRDs and implementation specs.

[Live Demo](https://deepform.exe.xyz) · [Product Hunt](https://www.producthunt.com/products/deepform) · [GitHub](https://github.com/susumutomita/DeepForm) · [日本語](./README.ja.md)

<a href="https://www.producthunt.com/products/deepform?embed=true&utm_source=badge-featured&utm_medium=badge&utm_campaign=badge-deepform" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1079622&theme=neutral&t=1771207729948" alt="DeepForm - AI depth interviews that turn vague ideas into specs | Product Hunt" width="250" height="54" /></a>

</div>

---

## The Problem

AI can build a PoC in minutes. But shipping requires more:

- Edge cases nobody thought of
- Security & availability requirements
- Acceptance criteria engineers can actually implement
- Validation that users truly have this problem

**Non-engineers can't see what's missing. DeepForm bridges that gap.**

## How It Works

```
Your idea → AI Depth Interview → Facts → Hypotheses → PRD → spec.json
                                                              ↓
                                              Claude Code / Cursor / Any Agent
```

### 5 Steps

| Step | What happens | Output |
|------|-------------|--------|
| **1. AI Depth Interview** | AI interviewer probes for concrete examples, frequency, severity, workarounds | Structured conversation |
| **2. Fact Extraction** | Extract facts, pains, frequencies with source evidence | Evidence-linked facts |
| **3. Hypothesis Generation** | Generate hypotheses with supporting facts, counter-evidence, unknowns | Falsifiable hypotheses |
| **4. PRD Generation** | MVP-scoped PRD with testable acceptance criteria (ISO 25010) | PRD.md |
| **5. Spec Export** | API specs, DB schema, test cases | spec.json |

### Campaign Mode

Share an interview link with your users to collect feedback at scale:

1. Create a campaign from any interview
2. Share the link — respondents go through the same AI interview
3. View aggregated pain points, common facts, and keyword analysis in real-time
4. Use AI cross-analysis to find patterns across all responses

## Key Differentiators

- **Evidence-linked specs** — Every requirement traces back to actual user statements
- **Counter-evidence on hypotheses** — Prevents confirmation bias with falsification patterns
- **Purpose-built interview AI** — Not generic chat; specialized depth interview techniques
- **Campaign interviews** — Collect and aggregate feedback from multiple users
- **Agent-ready export** — `spec.json` drops directly into coding agents
- **Production readiness check** — ISO/IEC 25010 quality checklist before you ship

## Quick Start

### Use the hosted version

Visit [deepform.exe.xyz](https://deepform.exe.xyz) and sign in with GitHub.

### Self-host

```bash
git clone https://github.com/susumutomita/DeepForm.git
cd DeepForm
make start
```

Requires [Bun](https://bun.sh) runtime. Set `ANTHROPIC_API_KEY` for Claude API access.

### From spec.json to working app

Once DeepForm generates your spec, hand it to a coding agent:

| Agent | How |
|-------|-----|
| **Claude Code** | Place PRD.md in repo root → `claude` |
| **Cursor** | Paste spec.json into Composer |
| **Any agent** | spec.json is standard JSON |

## Architecture

```
frontend/              Vite + TypeScript (vanilla)
  src/
    main.ts            Entry point & routing
    api.ts             Typed API client
    interview.ts       Core interview & analysis flow
    campaign-analytics.ts  Campaign results dashboard
    shared.ts          Campaign respondent interview
    sessions.ts        Session list management
    auth.ts            GitHub OAuth login
    i18n.ts            JA / EN / ES
    ui.ts              UI utilities

src/                   Hono + TypeScript server
  app.ts               Hono app with middleware
  llm.ts               Claude API client (API key / OAuth / gateway)
  db/
    index.ts           Kysely database setup + migrations
    migrations/        Schema migrations (001–003)
  routes/
    auth.ts            GitHub OAuth + exe.dev auth
    analytics.ts       Page view tracking
    billing.ts         Stripe webhook handler
    feedback.ts        User feedback
    sessions/
      crud.ts          Session CRUD
      interview.ts     AI interview (streaming)
      analysis.ts      Facts / hypotheses / PRD / spec / readiness
      campaigns.ts     Campaign management
      pipeline.ts      Full analysis pipeline (SSE)
  middleware/
    auth.ts            Auth middleware (GitHub OAuth + proxy headers)
    analytics.ts       Request analytics
```

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Server**: [Hono](https://hono.dev) + TypeScript
- **Frontend**: Vite + TypeScript (vanilla, no framework)
- **Database**: SQLite via [Kysely](https://kysely.dev) (WAL mode)
- **AI**: Claude API (Anthropic)
- **Auth**: GitHub OAuth + exe.dev proxy headers
- **Payments**: Stripe (optional, disabled by default)
- **i18n**: Japanese / English / Spanish

## Contributing

```bash
make install           # Install dependencies
make dev               # Start dev server (hot reload)
make before-commit     # Run lint + typecheck + test (317 tests)
```

See [CLAUDE.md](./CLAUDE.md) for development guidelines.

## License

See [LICENSE](./LICENSE).

---

<div align="center">

**Built with Claude AI**

*Open source. Self-hostable. Free.*

</div>
