# Local model files

**Three ways to get a local model running — all reachable from either
the Setup wizard (`/setup`) or the dashboard's Model settings ("Local
models (bundled Ollama)" section — the exact same UI, available any
time, not just during first-run setup):**
1. **Pick a suggested model** — downloads straight into this project's
   own bundled Ollama service with a couple of clicks, nothing to put in
   this folder at all.
2. **Paste a URL** (2026-09-09) — e.g. a HuggingFace GGUF direct-download
   link. The BACKEND fetches it server-side straight into this folder,
   with a real byte-level progress bar — this is the one that matters
   for a remote/EC2-style deployment, where you have no shell access to
   drop a file in yourself, and no reasonable way to upload a multi-GB
   file through your own browser/connection.
3. **Drop a `.gguf` file into this folder yourself** (if you already
   have shell/file access to wherever this app runs) — either way, once
   a file is here, the app tries Ollama's own default import first, and
   if that doesn't produce a working model, offers an AI-drafted
   suggestion to fix it (see the root `AGENTS.md`'s "Modelfile
   automation" section for the full design). No manual server-starting
   involved with any of the three.

This folder is mounted read-write into the backend and read-only into
the bundled `ollama` service (2026-09-09) — the backend needs to write a
freshly-downloaded file, Ollama only ever needs to read one to import it.

This folder is ALSO where you'd keep model files for the fully manual
path below — running a runtime Ollama doesn't cover (llama.cpp, vLLM, LM
Studio, anything else that speaks an OpenAI-compatible API) yourself,
and pointing this app at it via the "Custom endpoint" block. Neither
`docker-compose.yml`'s own build steps nor any service other than
`ollama` reads this folder automatically — see "Why this folder itself
isn't a bundled service" below for the full distinction.

## Quick start: run your own model and point this app at it

1. Download a model file into this folder, e.g.:
   ```
   models/your-model.Q4_K_M.gguf
   ```
2. Start your own OpenAI-compatible inference server pointed at it. This
   app already knows how to talk to any server that speaks the same
   `/v1/chat/completions` + `/v1/models` shape OpenAI's API does — for
   example, `llama.cpp`'s `llama-server`:
   ```
   llama-server -m models/your-model.Q4_K_M.gguf --port 8080
   ```
   (vLLM, LM Studio, and text-generation-webui's OpenAI-compatible mode
   all work the same way — just point them at a file in this folder.)
3. In the dashboard (`/dashboard`, admin/owner), open **AI & knowledge
   base → Model settings** and use the "Custom endpoint" block: set the
   base URL to `http://localhost:8080/v1` (a plain `localhost`/`127.0.0.1`
   address is fine — the backend automatically rewrites it to reach your
   host machine from inside its own container), click **Test
   connection**, then pick your model from the chat/vision/embedding
   dropdowns.

That's it — no restart, no env var, no code change. This is the exact
same "custom" provider mechanism already used for any self-hosted
backend (see `backend/providers/custom.py` and `AppSettings.custom_base_url`
in the root `AGENTS.md`'s "AI provider is swappable" section) — this
folder just gives your model file a consistent home.

## The `LOCAL_MODELS_DIR` env var

The root `.env` has a `LOCAL_MODELS_DIR` variable (defaults to
`./models`, i.e. this folder) purely for **your own convenience** when
scripting your own inference server's startup command — e.g.:

```bash
llama-server -m "$LOCAL_MODELS_DIR/your-model.gguf" --port 8080
```

No service in `docker-compose.yml` substitutes or reads this variable —
it exists so you have one place to change the path if you move your
model files, not because anything here is wired to it.

## Why this folder itself isn't a bundled service

**Ollama specifically IS now bundled** (2026-09-09, `docker-compose.yml`'s
`ollama` service) — its own API already does real "pick a model, it
downloads" model management (`POST /api/pull`), so the setup wizard
automates that path fully, downloading straight into Ollama's own
named volume, not this folder. This folder — and the manual "run your
own server, point this app at it" flow above — stays for every OTHER
runtime (llama.cpp, vLLM, LM Studio, ...), since none of them expose an
equivalent built-in model manager this app could safely automate the
same way. Bundling one of those in too would mean this app's own
compose stack taking on GPU passthrough/driver/memory-management
concerns that vary a lot machine-to-machine, for a runtime with no
"just pull a model over HTTP" mechanism to hook into — the manual path
above is the right tradeoff for those, at least for now.
