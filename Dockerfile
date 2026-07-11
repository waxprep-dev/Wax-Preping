FROM python:3.12-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ ./app/

# DEBUG: Show exactly what ended up in the image
RUN echo "=== WORKDIR ===" && pwd && ls -la && echo "=== app/ ===" && ls -la app/ && echo "=== app/__init__.py ===" && cat app/__init__.py && echo "=== app/main.py ===" && ls -la app/main.py

RUN python -c "import sys; sys.path.insert(0, '/app'); import app.main; print('BUILD: app.main imported OK')"

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
