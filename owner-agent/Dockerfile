# Mirrors backend/Dockerfile. No libpq-dev/build-essential — this service
# has no DB driver (see main.py's module docstring: it never talks to
# Postgres directly, only to backend's already-authenticated REST API).
FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Runs as a non-root user (2026-08-19 security-audit fix) — logs/ is
# where logging_.py writes runs.jsonl (bind-mounted over at runtime, see
# docker-compose.yml, but created here too for a fresh checkout). chown
# must happen before USER switches.
RUN groupadd --gid 1000 appuser \
    && useradd --uid 1000 --gid appuser --create-home appuser \
    && mkdir -p /app/logs \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 8100

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100", "--reload"]
