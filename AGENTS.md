# Repository Instructions

## Required Skill Loading Policy

- Always load `$refactor` at the start of every new chat in this repository unless the user is asking for something clearly unrelated to project work.
- Always load `$refactor-observability-and-booking` for any chat that pertains to this project's booking domain, observability foundation, provider boundaries, sweeper behavior, booking orchestration, booking schema or value sets, `api_logs`, or `exception_logs`.
- Always load `$illuminate-ui-design-and-css` for any chat involving Illuminate frontend design, CSS, styling, UI implementation, component design, page building, layout work, responsive behavior, or frontend refactors affecting the public site or Lean Admin UI.
- If multiple of these apply, load all relevant skills and state the order briefly.

## Backend Diagnosability

When developing backend:
Treat diagnosability as a hard requirement, not an optional cleanup item.

For every new endpoint, auth check, permission gate, feature flag, external integration, and non-trivial branch:
1. Add structured logs before and after the decision point.
2. Log the exact branch taken, the evaluated config or feature-flag state, and the concrete deny or failure reason.
3. Ensure all error responses (`401`, `403`, `404`, `409`, `422`, `500`, including top-level handler failures) preserve the same response envelope and include CORS headers where applicable.
4. Add or update tests that verify both behavior and the logging or diagnostic path for the important failure modes.
5. When debugging an existing issue, add temporary logs first, fix second, and tell me exactly which runtime variables or config values must be set and in which deployment environment.

Do not leave auth or permission failures as vague `Unauthorized`, `Forbidden`, or browser-only CORS symptoms. Make the runtime path explicit in logs.

## Skills

A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and file path so you can open the source for full instructions when using a specific skill.

### Available Skills

- `backend-diagnosability`: Enforce diagnosable backend changes with structured logging, explicit branch and failure reasons, consistent error envelopes, and tests for both behavior and diagnostics. Use when Codex implements or reviews backend endpoints, auth checks, permission gates, feature flags, external integrations, non-trivial branching, or debugging work where runtime path clarity matters. (file: `/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/.codex/skills/backend-diagnosability/SKILL.md`)
- `freeze-expected-results`: Analyze a codebase and freeze production user-facing end-to-end scenarios into a dated markdown document, with iterative refinement, grouping, critique, and contradiction checking before future product changes. Use when Codex must extract current expected user outcomes from the full project or from a specified domain or component, document them precisely, and pause future implementation work until freeze contradictions or additions are reviewed with the user. (file: `/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/.codex/skills/freeze-expected-results/SKILL.md`)
- `refactor`: Enforce project-specific refactoring discipline for this coaching-business production system. Use when Codex is handling a system-wide reshaping, local refactor, bug fix, feature addition, or improvement and must preserve production-visible outcomes, apply strict sequencing, compare against expected results, reinforce the current business-modeling and observability architecture, and simplify aggressively instead of layering patchwork on top of legacy structure. (file: `/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/.codex/skills/refactor/SKILL.md`)
- `refactor-observability-and-booking`: Enforce the staged replacement refactor workflow for this project's observability foundation and booking-domain model. Use when Codex must plan, review, or implement a major refactor touching observability wrappers, `api_logs`, `exception_logs`, booking schema or value sets, booking orchestration, sweeper behavior, provider boundaries, or final cleanup or verification across those areas, and must do the work in strict sequence instead of a mixed all-at-once rewrite. (file: `/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/.codex/skills/refactor-observability-and-booking/SKILL.md`)
- `test-lean`: Apply this project's lean pre-launch automated testing policy. Use when Codex adds, updates, reviews, or decides whether to write automated tests for backend work in V1, especially for booking flows, provider boundaries, cron side effects, observability logging, and bug-fix regressions. (file: `/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/.codex/skills/test-lean/SKILL.md`)
- `ui-automated-e2e-test`: Design, scope, implement, run, and report lean automated end-to-end UI tests for web applications from project-specific docs supplied in the chat. Use when Codex must read frozen scenarios, test plans, acceptance docs, architecture notes, or constraints, decide what belongs in a small P0 or P1 browser suite versus manual coverage, propose the automation scope for approval, and then execute Playwright-first UI automation with deterministic setup, strong business assertions, and concise review artifacts. (file: `/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/.codex/skills/ui-automated-e2e-test/SKILL.md`)
- `illuminate-ui-design-and-css`: Apply the Illuminate design system and CSS conventions to new or existing pages, components, and websites. Use when Codex must design, restyle, or extend public-facing marketing or booking pages, or internal admin and backoffice screens, so they match the project's Illuminate visual language, variant rules, color tokens, typography, layout patterns, and interaction behavior. (file: `/Users/Yair/Documents/Business2025/Website/yairb_website_2026_claude/.codex/skills/illuminate-ui-design-and-css/SKILL.md`)
- `chatgpt-apps`: Build, scaffold, refactor, and troubleshoot ChatGPT Apps SDK applications that combine an MCP server and widget UI. Use when Codex needs to design tools, register UI resources, wire the MCP Apps bridge or ChatGPT compatibility APIs, apply Apps SDK metadata or CSP or domain settings, or produce a docs-aligned project scaffold. Prefer a docs-first workflow by invoking the `openai-docs` skill or OpenAI developer docs MCP tools before generating code. (file: `/Users/Yair/.codex/skills/chatgpt-apps/SKILL.md`)
- `cloudflare-deploy`: Deploy applications and infrastructure to Cloudflare using Workers, Pages, and related platform services. Use when the user asks to deploy, host, publish, or set up a project on Cloudflare. (file: `/Users/Yair/.codex/skills/cloudflare-deploy/SKILL.md`)
- `figma`: Use the Figma MCP server to fetch design context, screenshots, variables, and assets from Figma, and to translate Figma nodes into production code. Trigger when a task involves Figma URLs, node IDs, design-to-code implementation, or Figma MCP setup and troubleshooting. (file: `/Users/Yair/.codex/skills/figma/SKILL.md`)
- `figma-implement-design`: Translate Figma nodes into production-ready code with 1:1 visual fidelity using the Figma MCP workflow. Trigger when the user provides Figma URLs or node IDs, or asks to implement designs or components that must match Figma specs. Requires a working Figma MCP server connection. (file: `/Users/Yair/.codex/skills/figma-implement-design/SKILL.md`)
- `imagegen`: Use when the user asks to generate or edit images via the OpenAI Image API. Run the bundled CLI (`scripts/image_gen.py`) and require `OPENAI_API_KEY` for live calls. (file: `/Users/Yair/.codex/skills/imagegen/SKILL.md`)
- `openai-docs`: Use when the user asks how to build with OpenAI products or APIs and needs up-to-date official documentation with citations. Prioritize OpenAI docs tools and restrict any fallback browsing to official OpenAI domains. (file: `/Users/Yair/.codex/skills/openai-docs/SKILL.md`)
- `pdf`: Use when tasks involve reading, creating, or reviewing PDF files where rendering and layout matter. Prefer visual checks by rendering pages and use Python tools such as `reportlab`, `pdfplumber`, and `pypdf` for generation and extraction. (file: `/Users/Yair/.codex/skills/pdf/SKILL.md`)
- `screenshot`: Use when the user explicitly asks for a desktop or system screenshot, or when tool-specific capture capabilities are unavailable and an OS-level capture is needed. (file: `/Users/Yair/.codex/skills/screenshot/SKILL.md`)
- `security-best-practices`: Perform language and framework specific security best-practice reviews and suggest improvements. Trigger only when the user explicitly requests security best practices guidance, a security review or report, or secure-by-default coding help. Trigger only for supported languages: Python, JavaScript or TypeScript, and Go. (file: `/Users/Yair/.codex/skills/security-best-practices/SKILL.md`)
- `sora`: Use when the user asks to generate, remix, poll, list, download, or delete Sora videos via the OpenAI video API using the bundled CLI (`scripts/sora.py`). Requires `OPENAI_API_KEY` and Sora API access. (file: `/Users/Yair/.codex/skills/sora/SKILL.md`)
- `speech`: Use when the user asks for text-to-speech narration or voiceover, accessibility reads, audio prompts, or batch speech generation via the OpenAI Audio API. Run the bundled CLI (`scripts/text_to_speech.py`) with built-in voices and require `OPENAI_API_KEY` for live calls. (file: `/Users/Yair/.codex/skills/speech/SKILL.md`)
- `spreadsheet`: Use when tasks involve creating, editing, analyzing, or formatting spreadsheets (`.xlsx`, `.csv`, `.tsv`) using Python (`openpyxl`, `pandas`), especially when formulas, references, and formatting need to be preserved and verified. (file: `/Users/Yair/.codex/skills/spreadsheet/SKILL.md`)
- `transcribe`: Transcribe audio files to text with optional diarization and known-speaker hints. Use when a user asks to transcribe speech from audio or video, extract text from recordings, or label speakers in interviews or meetings. (file: `/Users/Yair/.codex/skills/transcribe/SKILL.md`)
- `skill-creator`: Guide for creating effective skills. Use when users want to create a new skill or update an existing skill that extends Codex's capabilities with specialized knowledge, workflows, or tool integrations. (file: `/Users/Yair/.codex/skills/.system/skill-creator/SKILL.md`)
- `skill-installer`: Install Codex skills into `$CODEX_HOME/skills` from a curated list or a GitHub repo path. Use when a user asks to list installable skills, install a curated skill, or install a skill from another repo. (file: `/Users/Yair/.codex/skills/.system/skill-installer/SKILL.md`)

### How To Use Skills

- Discovery: The list above is the skills available in this session. Skill bodies live on disk at the listed paths.
- Trigger rules: If the user names a skill with `$skill-name` or plain text, or the task clearly matches a skill's description above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned, except for the required skill loading policy above.
- Missing or blocked: If a named skill is not in the list or the path cannot be read, say so briefly and continue with the best fallback.
- How to use a skill:
  1. After deciding to use a skill, open its `SKILL.md`. Read only enough to follow the workflow.
  2. When `SKILL.md` references relative paths, resolve them relative to the skill directory listed above first.
  3. If `SKILL.md` points to extra folders such as `references/`, load only the specific files needed for the request.
  4. If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.
  5. If `assets/` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill or skills you're using and why in one short line.
  - If you skip an obvious skill, say why.
- Context hygiene:
  - Keep context small: summarize long sections instead of pasting them.
  - Only load extra files when needed.
  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless blocked.
  - When variants exist, pick only the relevant reference files and note that choice.
- Safety and fallback: If a skill cannot be applied cleanly, state the issue, pick the next-best approach, and continue.
