<div align="center">

<img src="https://img.shields.io/badge/AI-Depth_Interview-81a2be?style=for-the-badge" alt="AI Depth Interview">
<img src="https://img.shields.io/badge/spec.json-Export-8c9440?style=for-the-badge" alt="spec.json Export">
<img src="https://img.shields.io/badge/exe.dev-Powered-de935f?style=for-the-badge" alt="exe.dev Powered">

# DeepForm

**From vague idea to deployable spec — in one sitting.**

AI-powered depth interviews that extract requirements non-engineers miss,
then generate production-ready PRDs and implementation specs.

[Live Demo](https://deepform.exe.xyz:8000) · [日本語](./README.ja.md)

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
                                              exe.dev + Shelley / Claude Code / Cursor
```

### 5 Steps

| Step | What happens | Output |
|------|-------------|--------|
| **1. AI Depth Interview** | AI interviewer probes for concrete examples, frequency, severity, workarounds | Structured conversation |
| **2. Fact Extraction** | Extract facts, pains, frequencies with source evidence | Evidence-linked facts |
| **3. Hypothesis Generation** | Generate hypotheses with supporting facts, counter-evidence, unknowns | Falsifiable hypotheses |
| **4. PRD Generation** | MVP-scoped PRD with testable acceptance criteria (ISO 25010) | PRD.md |
| **5. Spec Export** | API specs, DB schema, test cases | spec.json |

## Key Differentiators

- **Evidence-linked specs** — Every requirement traces back to actual user statements
- **Counter-evidence on hypotheses** — Prevents confirmation bias with falsification patterns
- **Purpose-built interview AI** — Not generic chat; specialized depth interview logic
- **Agent-ready export** — `spec.json` drops directly into coding agents

## Quick Start

### Use the hosted version

Visit [deepform.exe.xyz:8000](https://deepform.exe.xyz:8000) and sign in with your exe.dev account.

### Self-host on exe.dev

```bash
# SSH into your exe.dev VM
ssh your-vm.exe.xyz

# Clone and setup
git clone https://github.com/susumutomita/DeepForm.git
cd DeepForm
npm install
cd frontend && npm install && npx vite build && cd ..

# Start
npx tsx src/index.ts
```

### From spec.json to working app

Once DeepForm generates your spec, hand it to a coding agent:

| Agent | How |
|-------|-----|
| **exe.dev + Shelley** ⭐ | Paste spec.json → Shelley builds & deploys on your VM |
| **Claude Code** | Place PRD.md in repo root → `claude` |
| **Cursor** | Paste spec.json into Composer |
| **Any agent** | spec.json is standard JSON |

## Architecture

```
frontend/          Vite + TypeScript (vanilla)
  src/
    main.ts        Entry point
    api.ts         Typed API client
    auth.ts        exe.dev Login integration
    i18n.ts        JA / EN / ES
    interview.ts   Core interview & analysis flow
    sessions.ts    Session list management
    shared.ts      Shared & campaign interviews
    ui.ts          UI utilities
    pages/         Legal pages (privacy, terms, security)

src/               Hono + TypeScript server
  index.ts         Entry point
  app.ts           Hono app with middleware
  db.ts            SQLite (node:sqlite)
  llm.ts           Claude API client
  routes/
    auth.ts        exe.dev auth endpoints
    sessions.ts    Session CRUD & AI pipeline
  middleware/
    auth.ts        X-ExeDev-* header auth
```

## Auth: Login with exe.dev

DeepForm uses [Login with exe](https://exe.dev/docs/login-with-exe.md) — zero OAuth setup required.

The exe.dev HTTPS proxy adds `X-ExeDev-UserID` and `X-ExeDev-Email` headers automatically. No passwords, no cookies, no client secrets.

## Tech Stack

- **Runtime**: Node.js 22+ (experimental `node:sqlite`)
- **Server**: [Hono](https://hono.dev) + TypeScript
- **Frontend**: Vite + TypeScript (vanilla, no framework)
- **Database**: SQLite (WAL mode)
- **AI**: Claude API (Anthropic)
- **Auth**: exe.dev proxy headers
- **Hosting**: [exe.dev](https://exe.dev)

## Roadmap

- [ ] **Production readiness check** — AI-guided checklist for non-functional requirements (security, ops, legal)
- [ ] **exe.dev deep integration** — "Deploy to exe.dev" button with spec.json pre-loaded
- [ ] **Campaign analytics** — Aggregate insights from multiple user interviews
- [ ] **Export to GitHub Issues** — Convert PRD into actionable issues

## Contributing

See [CLAUDE.md](./CLAUDE.md) for development guidelines.

```bash
# Development
cd frontend && npx vite          # Frontend dev server (port 5173)
npx tsx --watch src/index.ts     # Backend dev server (port 8000)

# Checks
npx biome check src/             # Lint
npx tsc --noEmit                 # Type check
npx vitest run                   # Tests
cd frontend && npx vite build    # Build
```

## License

See [LICENSE](./LICENSE).

---

<div align="center">

**Built with Claude AI × [exe.dev](https://exe.dev)**

*DeepForm is an [exe.dev](https://exe.dev) showcase project — demonstrating how AI agents can go from idea to production on exe.dev VMs.*

</div>
