FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8000 \
    FINSENTINELS_RUNTIME_DIR=/var/lib/finsentinels

WORKDIR /app

COPY requirements-api.txt requirements.txt ./
RUN python -m pip install --upgrade pip \
    && python -m pip install --no-cache-dir -r requirements-api.txt \
    && python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu "torch>=2.2,<3"

COPY . .
RUN mkdir -p /var/lib/finsentinels

EXPOSE 8000

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
