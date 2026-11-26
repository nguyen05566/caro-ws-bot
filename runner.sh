#!/usr/bin/env bash
# Chạy bot liên tục: hết runtime / max-games thì tự khởi động lại sau 10s.
# Dừng hẳn: pkill -f runner.sh && pkill -f ws_bot_ck2.py
cd "$(dirname "$0")"
while true; do
  echo "[runner] $(date '+%F %T') start bot..."
  python3 ws_bot_ck2.py "$@"
  code=$?
  echo "[runner] $(date '+%F %T') bot exited code=$code → chạy lại sau 10s"
  sleep 10
done
