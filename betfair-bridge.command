#!/bin/bash
set -u
clear
echo "========================================================"
echo " AI DEL PALLONE — BETFAIR BRIDGE V160"
echo " Mac → Betfair Exchange → Vercel/Supabase"
echo "========================================================"
echo
read -r -p "Vercel URL (es. https://ai-del-pallone-nok7.vercel.app): " BASE
BASE="${BASE%/}"
read -r -p "BETFAIR_BRIDGE_TOKEN: " BRIDGE_TOKEN
read -r -p "Betfair Application Key: " APPKEY
read -r -p "Username Betfair: " USERNAME
read -r -s -p "Password Betfair: " PASSWORD
echo
read -r -p "Certificato .crt (trascinalo qui): " CERT
CERT="${CERT#\'}"; CERT="${CERT%\'}"; CERT="${CERT#\"}"; CERT="${CERT%\"}"
read -r -p "Chiave privata .key (trascinala qui): " KEY
KEY="${KEY#\'}"; KEY="${KEY%\'}"; KEY="${KEY#\"}"; KEY="${KEY%\"}"

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then echo "❌ Certificato/chiave non trovati."; read -r -p "Invio per chiudere..."; exit 2; fi

TMP_LOGIN="$(mktemp)"; TMP_CAT="$(mktemp)"; TMP_IDS="$(mktemp)"; TMP_CHUNK_DIR="$(mktemp -d)"
trap 'rm -f "$TMP_LOGIN" "$TMP_CAT" "$TMP_IDS"; rm -rf "$TMP_CHUNK_DIR"' EXIT

FROM=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TO=$(date -u -v+48H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '+48 hours' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

PAYLOAD='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listMarketCatalogue","params":{"filter":{"eventTypeIds":["1"],"marketTypeCodes":["MATCH_ODDS","OVER_UNDER_25","OVER_UNDER_35"],"marketStartTime":{"from":"'"$FROM"'","to":"'"$TO"'"}},"marketProjection":["EVENT","COMPETITION","MARKET_START_TIME","RUNNER_DESCRIPTION"],"maxResults":"200"},"id":1}]'

echo
echo "[1/4] Login Betfair..."
curl -sS -o "$TMP_LOGIN" -w "%{http_code}" \
  --cert "$CERT" --key "$KEY" \
  -H "X-Application: $APPKEY" -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "username=$USERNAME" --data-urlencode "password=$PASSWORD" \
  --connect-timeout 15 --max-time 30 \
  "https://identitysso-cert.betfair.it/api/certlogin" >/dev/null
if ! grep -q '"loginStatus"[[:space:]]*:[[:space:]]*"SUCCESS"' "$TMP_LOGIN"; then
  echo "❌ Login Betfair fallito:"; sed -E 's/"sessionToken"[[:space:]]*:[[:space:]]*"[^"]+"/"sessionToken":"[HIDDEN]"/g' "$TMP_LOGIN"; read -r -p "Invio per chiudere..."; exit 10
fi
SESSION=$(sed -nE 's/.*"sessionToken"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$TMP_LOGIN")
echo "✅ Login riuscito."

echo
echo "[2/4] Recupero mercati calcio delle prossime 48 ore..."
curl -sS --max-time 40 \
  -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" -H "Content-Type: application/json" \
  --data "$PAYLOAD" "https://api.betfair.com/exchange/betting/json-rpc/v1" > "$TMP_CAT"
if grep -q '"errorCode"' "$TMP_CAT"; then echo "❌ Errore mercati:"; cat "$TMP_CAT"; read -r -p "Invio per chiudere..."; exit 11; fi

CAT_BODY="{\"type\":\"catalogue\",\"payload\":$(cat "$TMP_CAT") }"
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
  -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json" \
  --data "$CAT_BODY" "$BASE/api/betfair-sync")
if [ "$HTTP" != "200" ]; then echo "❌ Vercel ha rifiutato il catalogo. HTTP $HTTP"; read -r -p "Invio per chiudere..."; exit 12; fi
echo "✅ Catalogo salvato."

echo
echo "[3/4] Recupero quote BACK/LAY per tutti i mercati trovati..."
grep -o '"marketId"[[:space:]]*:[[:space:]]*"1\.[0-9]*"' "$TMP_CAT" | sed -E 's/.*"(1\.[0-9]+)"/\1/' | sort -u | head -200 > "$TMP_IDS"
COUNT=$(wc -l < "$TMP_IDS" | tr -d ' ')
if [ "$COUNT" -eq 0 ]; then echo "⚠️ Nessun marketId trovato."; read -r -p "Invio per chiudere..."; exit 13; fi

echo "Mercati trovati: $COUNT. Betfair consente massimo 40 marketId per richiesta: li sincronizzo a blocchi."

split -l 40 "$TMP_IDS" "$TMP_CHUNK_DIR/chunk-" >/dev/null 2>&1 || true
CHUNKS=0
for FILE in "$TMP_CHUNK_DIR"/chunk-*; do
  [ -f "$FILE" ] || continue
  IDS=$(paste -sd, "$FILE")
  BOOK_PAYLOAD='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listMarketBook","params":{"marketIds":['"$(printf '"%s"' ${IDS//,/ } | sed 's/ /,/g')"'],"priceProjection":{"priceData":["EX_BEST_OFFERS","EX_TRADED"],"exBestOffersOverrides":{"bestPricesDepth":3,"rollupModel":"STAKE","rollupLimit":0.0}}},"id":1}]'
  curl -sS --max-time 40 \
    -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" -H "Content-Type: application/json" \
    --data "$BOOK_PAYLOAD" "https://api.betfair.com/exchange/betting/json-rpc/v1" > "$TMP_CHUNK_DIR/book.json"
  if grep -q '"errorCode"' "$TMP_CHUNK_DIR/book.json"; then
    echo "❌ Errore quote nel blocco $((CHUNKS+1)):"; cat "$TMP_CHUNK_DIR/book.json"; read -r -p "Invio per chiudere..."; exit 14
  fi
  BOOK_BODY="{\"type\":\"book\",\"payload\":$(cat "$TMP_CHUNK_DIR/book.json") }"
  HTTP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
    -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json" \
    --data "$BOOK_BODY" "$BASE/api/betfair-sync")
  if [ "$HTTP" != "200" ]; then echo "❌ Vercel ha rifiutato il blocco quote. HTTP $HTTP"; read -r -p "Invio per chiudere..."; exit 15; fi
  CHUNKS=$((CHUNKS+1))
  echo "  ✅ blocco $CHUNKS sincronizzato ($(wc -l < "$FILE" | tr -d ' ') mercati)"
done

echo
echo "[4/4] Bridge completato."
echo "Catalogo: MATCH_ODDS + OVER_UNDER_25 + OVER_UNDER_35."
echo "Mercati sincronizzati: fino a 200, quote richieste a blocchi da 40."
echo "Il servizio è in sola lettura: NON piazza scommesse."
echo
echo "Riesegui questo file prima dell'analisi se vuoi una fotografia aggiornata delle quote."
echo "Non condividere password, private key o session token."
read -r -p "Premi Invio per chiudere..."
