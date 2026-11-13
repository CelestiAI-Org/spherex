#!/usr/bin/env bash
# Poll IRSA SIA until it answers with something other than 502. Writes the status to stdout.
URL="https://irsa.ipac.caltech.edu/SIA?COLLECTION=spherex_qr&POS=circle+269.452+4.693+0.05"
for i in $(seq 1 ${1:-180}); do
  code=$(curl -s -m 60 -o /dev/null -w "%{http_code}" "$URL")
  echo "$(date -u +%H:%M:%S) $code"
  [ "$code" = "200" ] && exit 0
  sleep 60
done
exit 1
