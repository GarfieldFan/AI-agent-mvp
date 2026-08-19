FROM python:3.11-slim

WORKDIR /app

# Prevent Python from writing .pyc files, and enable unbuffered stdout/
# stderr so logs show up in real time.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# System deps needed to build psycopg2-binary and talk to Postgres.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Dependencies copied and installed before the rest of the source so this
# layer stays cached across source-only changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Runs as a non-root user (2026-08-19 security-audit fix) rather than
# root, the image's default. storage/ is where apis/documents.py and
# apis/media.py write uploads — created here (in addition to whatever
# the ./backend bind mount already has, see docker-compose.yml) so a
# fresh checkout without it yet still works. chown must happen before
# USER switches — a non-root process can't chown files it doesn't
# already own.
RUN groupadd --gid 1000 appuser \
    && useradd --uid 1000 --gid appuser --create-home appuser \
    && mkdir -p /app/storage/documents /app/storage/media \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
