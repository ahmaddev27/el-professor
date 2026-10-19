# The export service. The only image in this stack that is built on the host;
# every other service pulls an upstream image. deploy.sh builds it from the
# release archive before compose starts anything, and fails the release when the
# build fails.
#
# Pinned by digest so a rebuilt tag upstream cannot change what runs here. To
# move it: pull the new tag, read its digest, change this line and nothing else.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

# Hashes for every package, so a changed or substituted file fails the build.
# --no-deps because requirements.txt already lists the whole closure.
COPY requirements.txt .
RUN pip install --require-hashes --only-binary=:all: --no-deps -r requirements.txt

COPY export_service ./export_service

# Not root, and with no home directory or login shell. The compose service also
# runs the filesystem read-only; the tmpfs it mounts is the only place to write.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin export
USER 10001

EXPOSE 8080

# One worker on purpose: the rate limiter and the token cache live in memory,
# and the work is done on threads under a deadline inside the app.
CMD ["python", "-m", "uvicorn", "export_service.main:app", \
     "--host", "0.0.0.0", "--port", "8080", "--workers", "1", \
     "--no-server-header", "--no-access-log", "--limit-concurrency", "64", \
     "--timeout-keep-alive", "5"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=2).status == 200 else 1)"]
