# Quant service — Step 1.2 stub image (BE-004). QN-005 replaces with the real build.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1
WORKDIR /app
COPY services/quant/main.py .

EXPOSE 5000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:5000/healthz')" || exit 1

CMD ["python", "main.py"]
