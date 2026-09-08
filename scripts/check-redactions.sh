#!/usr/bin/env bash
# Refuses to let known-private material into this repository.
#
# Run before every push. A pattern here is something that was removed once and must stay
# removed — re-introducing it is nearly always a blind copy from the closed repo, not a
# decision anyone made.
set -euo pipefail
cd "$(dirname "$0")/.."

patterns=(
  '0x56590444217a36A6F1a5e18F7C801BC2Fdc2d98a'   # treasury Safe owner
  '0xBA617EEab7B34202eC4047315056163E52FA3218'   # adversarial funding wallet
  '0xf474A1cb'                                    # facilitator gas signer
  'has been exposed'                              # never publish that a live key is compromised
  'awaiting rotation'
  'workers\.dev'                                  # internal origins
  '\.railway\.app'
  '\.vercel\.app'
  'discord\.com/api/webhooks'
  '(^|[^a-z])(indexer|proxy)/src'                 # private package paths
  'web/src'
)

failed=0
for pattern in "${patterns[@]}"; do
  if hits=$(grep -rniE "$pattern" . \
      --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=lib \
      --exclude=.redactions --exclude=check-redactions.sh 2>/dev/null); then
    echo "REFUSED: '$pattern' is present"
    echo "$hits" | sed 's/^/  /'
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo
  echo "This material was removed deliberately. If a copy from the closed repository put it"
  echo "back, re-apply the redaction rather than publishing it."
  exit 1
fi
echo "check-redactions: clean"
