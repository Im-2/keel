#!/usr/bin/env bash
# Keeps the Mini App connected to the bot while it runs behind a free Cloudflare quick tunnel.
# Quick tunnels get a new random URL every time they start and Cloudflare can drop them at any moment,
# so this watchdog checks the tunnel every minute and, when it is dead, starts a new one, points the
# Mini App's VITE_API_BASE at it on Vercel, and redeploys the production site (stable alias unchanged).
# Usage (from the repo root): bash scripts/keep-tunnel.sh   (run it in the background)
# A named Cloudflare tunnel or a real host removes the need for this.
set -u
cd "$(dirname "$0")/.."
LOG=.tunnel.log
STATE=.tunnel-url

start_tunnel() {
  taskkill //F //IM cloudflared.exe >/dev/null 2>&1 || pkill cloudflared 2>/dev/null || true
  : > "$LOG"
  nohup cloudflared tunnel --url http://localhost:8787 >> "$LOG" 2>&1 &
  for _ in $(seq 1 30); do
    url=$(grep -o "https://[a-z0-9-]*\.trycloudflare\.com" "$LOG" | head -1)
    if [ -n "$url" ] && curl -sf -m 10 "$url/healthz" >/dev/null; then echo "$url"; return 0; fi
    sleep 3
  done
  return 1
}

redeploy() {
  local url=$1
  printf "%s" "$url" | vercel env add VITE_API_BASE production --force >/dev/null 2>&1
  printf "%s" "$url" | vercel env add VITE_API_BASE preview --force >/dev/null 2>&1
  vercel deploy --prod --yes >/dev/null 2>&1 && echo "$(date -u +%FT%TZ) redeployed Mini App -> $url"
}

fails=0
while true; do
  url=$(cat "$STATE" 2>/dev/null || true)
  if [ -n "$url" ] && curl -sf -m 15 "$url/healthz" >/dev/null; then
    fails=0
  else
    fails=$((fails + 1))
    if [ "$fails" -ge 2 ] || [ -z "$url" ]; then
      echo "$(date -u +%FT%TZ) tunnel down ($url), restarting"
      if new=$(start_tunnel); then
        echo "$new" > "$STATE"
        redeploy "$new"
        fails=0
      fi
    fi
  fi
  sleep 60
done
