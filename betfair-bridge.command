#!/bin/bash
set -u
clear
echo "========================================================"
echo " AI DEL PALLONE — BETFAIR BRIDGE"
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

TMP_LOGIN="$(mktemp)"; TMP_CAT="$(mktemp)"; TMP_BOOK="$(mktemp)"
trap 'rm -f "$TMP_LOGIN" "$TMP_CAT" "$TMP_BOOK"' EXIT

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
FROM=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TO=$(date -u -v+48H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '+48 hours' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
PAYLOAD='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listMarketCatalogue","params":{"filter":{"eventTypeIds":["1"],"marketTypeCodes":["MATCH_ODDS"],"marketStartTime":{"from":"'"$FROM"'","to":"'"$TO"'"}},"marketProjection":["EVENT","COMPETITION","MARKET_START_TIME","RUNNER_DESCRIPTION"],"maxResults":"200"},"id":1}]'
curl -sS --max-time 40 \
  -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" -H "Content-Type: application/json" \
  --data "$PAYLOAD" "https://api.betfair.com/exchange/betting/json-rpc/v1" > "$TMP_CAT"
if grep -q '"errorCode"' "$TMP_CAT"; then echo "❌ Errore mercati:"; cat "$TMP_CAT"; read -r -p "Invio per chiudere..."; exit 11; fi

echo "Mercati ricevuti. Invio catalogo a Vercel..."
CAT_BODY="{\"type\":\"catalogue\",\"payload\":$(cat "$TMP_CAT") }"
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
  -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json" \
  --data "$CAT_BODY" "$BASE/api/betfair-sync")
if [ "$HTTP" != "200" ]; then echo "❌ Vercel ha rifiutato il catalogo. HTTP $HTTP"; read -r -p "Invio per chiudere..."; exit 12; fi
echo "✅ Catalogo salvato."

echo
echo "[3/4] Recupero quote BACK/LAY..."
IDS=$(grep -o '"marketId"[[:space:]]*:[[:space:]]*"1\.[0-9]*"' "$TMP_CAT" | sed -E 's/.*"(1\.[0-9]+)"/"\1"/' | sort -u | head -80 | paste -sd, -)
if [ -z "$IDS" ]; then echo "⚠️ Nessun marketId trovato."; read -r -p "Invio per chiudere..."; exit 13; fi
BOOK_PAYLOAD='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listMarketBook","params":{"marketIds":['"$IDS"'],"priceProjection":{"priceData":["EX_BEST_OFFERS","EX_TRADED"],"exBestOffersOverrides":{"bestPricesDepth":3,"rollupModel":"STAKE","rollupLimit":0.0}}},"id":1}]'
curl -sS --max-time 40 \
  -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" -H "Content-Type: application/json" \
  --data "$BOOK_PAYLOAD" "https://api.betfair.com/exchange/betting/json-rpc/v1" > "$TMP_BOOK"
if grep -q '"errorCode"' "$TMP_BOOK"; then echo "❌ Errore quote:"; cat "$TMP_BOOK"; read -r -p "Invio per chiudere..."; exit 14; fi

echo "Quote ricevute. Invio a Vercel..."
# Invia il market book completo; l'API server lo associa ai marketId contenuti nella risposta.
BOOK_BODY="{\"type\":\"book\",\"payload\":$(cat "$TMP_BOOK") }"
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
  -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json" \
  --data "$BOOK_BODY" "$BASE/api/betfair-sync")
if [ "$HTTP" != "200" ]; then echo "❌ Vercel ha rifiutato le quote. HTTP $HTTP"; read -r -p "Invio per chiudere..."; exit 15; fi

echo "✅ Quote salvate."
echo
echo "[4/4] Bridge completato."
echo "Mercati sincronizzati: fino a 200 cataloghi / 80 market book."
echo "Il servizio è in sola lettura: NON piazza scommesse."
echo
echo "Per aggiornare nuovamente i dati, esegui di nuovo questo file."
echo
echo "Non condividere password, private key o session token."
read -r -p "Premi Invio per chiudere..."
