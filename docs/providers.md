# Providers

Fabma doesn't ship models or take API keys as its primary path — it drives the agent CLIs you're already logged into, in parallel, one process per variant.

## Claude Code (`claude-cli`)

- Detected when `claude` is on PATH. Uses your Claude subscription/login.
- Runs `claude -p "<prompt>" --permission-mode acceptEdits --max-turns 30` in a scratch job dir (`<workspace>/.jobs/...`). `acceptEdits` only auto-allows file writes in that dir — the contract is "write ./variant.html".
- Model override → `--model` (e.g. `sonnet`, `haiku`, `opus`). Empty = your CLI default.
- Multimodal: screenshot references are placed in the job dir for it to read.

## Codex (`codex-cli`)

- Detected when `codex` is on PATH. Uses your OpenAI login.
- Runs `codex exec --sandbox workspace-write --skip-git-repo-check -C <jobdir> -o <last-message>`. The sandbox restricts writes to the job dir.
- Model override → `-m`. Empty = your Codex default (`~/.codex/config.toml`).

## Anthropic API (`anthropic-api`)

- Enabled when `ANTHROPIC_API_KEY` is set. Single `fetch` to `/v1/messages`, default model `claude-sonnet-5`, no SDK.
- References are inlined into the prompt; screenshots become image content blocks (≤4MB).

## Behavior notes

- **Concurrency**: at most `FABMA_MAX_CONCURRENCY` (default 4) provider processes run at once; extra variants queue.
- **Timeout**: `FABMA_TIMEOUT_MS` (default 10 minutes) per variant, then SIGTERM.
- **Failures**: the exit code + stderr tail land on the variant card; failed job dirs are kept under `<workspace>/.jobs/` for inspection; **Retry** reruns one variant, optionally with a different provider/model.
- **Fallbacks**: if an agent prints the design instead of writing `variant.html`, fabma extracts the largest fenced HTML block from its output.
- **Privacy**: your brief/designs go only to the provider you picked, through that provider's own CLI/API. Fabma itself makes no other network calls and serves on 127.0.0.1 only.
- **Trust model**: provider processes get an allowlisted environment (PATH/HOME/auth vars — no incidental secrets) on top of each CLI's own sandbox, and prompts mark reference files as untrusted content. Treat imported HTML from strangers with the same caution as running an agent on a strange repo; container-level isolation is on the roadmap.
