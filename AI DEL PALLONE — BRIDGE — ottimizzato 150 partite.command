#!/bin/bash
set -u
clear
echo "========================================================"
echo " AI DEL PALLONE — BETFAIR BRIDGE"
echo " Mac → Betfair Exchange → Vercel/Supabase"
echo "========================================================"
echo

CONFIG="$HOME/.ai-del-pallone/config"

if [ ! -f "$CONFIG" ]; then
  echo "❌ Configurazione non trovata: $CONFIG"
  read -r -p "Invio per chiudere..."
  exit 2
fi

source "$CONFIG"

BRIDGE_TOKEN=$(security find-generic-password -a "$USER" -s "AI-DEL-PALLONE-BETFAIR-BRIDGE-TOKEN" -w 2>/dev/null || true)
APPKEY=$(security find-generic-password -a "$USER" -s "AI-DEL-PALLONE-BETFAIR-APPKEY" -w 2>/dev/null || true)
PASSWORD=$(security find-generic-password -a "$USER" -s "AI-DEL-PALLONE-BETFAIR-PASSWORD" -w 2>/dev/null || true)

if [ -z "$BRIDGE_TOKEN" ]; then
  echo "❌ Token bridge non trovato nel Portachiavi."
  read -r -p "Invio per chiudere..."
  exit 3
fi

if [ -z "$APPKEY" ]; then
  echo "❌ Application Key non trovata nel Portachiavi."
  read -r -p "Invio per chiudere..."
  exit 4
fi

if [ -z "$PASSWORD" ]; then
  echo "❌ Password Betfair non trovata nel Portachiavi."
  read -r -p "Invio per chiudere..."
  exit 5
fi

echo "✅ Configurazione trovata."
echo "✅ Credenziali Portachiavi trovate."

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
echo "[2/4] Recupero 150 partite e mercati necessari delle prossime 36 ore..."
FROM=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TO=$(date -u -v+36H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '+36 hours' +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

# Selezioniamo prima 150 PARTITE uniche tramite MATCH_ODDS.
MATCH_PAYLOAD='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listMarketCatalogue","params":{"filter":{"eventTypeIds":["1"],"marketTypeCodes":["MATCH_ODDS"],"marketStartTime":{"from":"'"$FROM"'","to":"'"$TO"'"}},"marketProjection":["EVENT","COMPETITION","MARKET_START_TIME","RUNNER_DESCRIPTION"],"sort":"FIRST_TO_START","maxResults":"150"},"id":1}]'

curl -sS --max-time 40 \
  -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" -H "Content-Type: application/json" \
  --data "$MATCH_PAYLOAD" "https://api.betfair.com/exchange/betting/json-rpc/v1" > "$TMP_CAT"

if grep -q '"errorCode"' "$TMP_CAT"; then
  echo "❌ Errore recupero partite:"
  cat "$TMP_CAT"
  read -r -p "Invio per chiudere..."
  exit 11
fi

EVENT_IDS_JSON=$(perl -MJSON::PP -0777 -e '
  my $j = decode_json(join("", <>));
  my %seen;
  my @ids;
  for my $x (@{$j->[0]{result} || []}) {
    my $id = $x->{event}{id};
    next unless defined $id && length $id;
    next if $seen{$id}++;
    push @ids, "$id";
  }
  print encode_json(\@ids);
' "$TMP_CAT" 2>/dev/null || true)

MATCH_COUNT=$(perl -MJSON::PP -e '
  my $a = decode_json(join("", <>));
  print scalar(@$a);
' <<< "$EVENT_IDS_JSON" 2>/dev/null || echo 0)

if [ "$MATCH_COUNT" -eq 0 ]; then
  echo "⚠️ Nessuna partita trovata nelle prossime 36 ore."
  read -r -p "Invio per chiudere..."
  exit 13
fi

echo "✅ Partite uniche individuate: $MATCH_COUNT"

TMP_CAT_ALL="$(mktemp)"
trap 'rm -f "$TMP_LOGIN" "$TMP_CAT" "$TMP_BOOK" "$TMP_CAT_ALL"' EXIT
cp "$TMP_CAT" "$TMP_CAT_ALL"

# Recuperiamo gli altri 4 mercati solo per gli eventi già selezionati.
for MARKET_TYPE in OVER_UNDER_15 OVER_UNDER_25 OVER_UNDER_35 OVER_UNDER_45; do
  OU_PAYLOAD='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listMarketCatalogue","params":{"filter":{"eventTypeIds":["1"],"eventIds":'"$EVENT_IDS_JSON"',"marketTypeCodes":["'"$MARKET_TYPE"'"],"marketStartTime":{"from":"'"$FROM"'","to":"'"$TO"'"}},"marketProjection":["EVENT","COMPETITION","MARKET_START_TIME","RUNNER_DESCRIPTION"],"maxResults":"150"},"id":1}]'

  curl -sS --max-time 40 \
    -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" -H "Content-Type: application/json" \
    --data "$OU_PAYLOAD" "https://api.betfair.com/exchange/betting/json-rpc/v1" > "$TMP_BOOK"

  if grep -q '"errorCode"' "$TMP_BOOK"; then
    echo "❌ Errore recupero $MARKET_TYPE:"
    cat "$TMP_BOOK"
    read -r -p "Invio per chiudere..."
    exit 11
  fi

  perl -MJSON::PP -0777 - "$TMP_CAT_ALL" "$TMP_BOOK" > "${TMP_CAT_ALL}.new" <<'PERL'
my ($out, $add) = @ARGV;
my $a = decode_json(do { local $/; open my $fh, "<", $out or die $!; <$fh> });
my $b = decode_json(do { local $/; open my $fh, "<", $add or die $!; <$fh> });
push @{$a->[0]{result}}, @{$b->[0]{result} || []};
print encode_json($a);
PERL

  if [ "$?" -ne 0 ]; then
    echo "❌ Errore nell'unione del catalogo."
    read -r -p "Invio per chiudere..."
    exit 11
  fi

  mv "${TMP_CAT_ALL}.new" "$TMP_CAT_ALL"
  echo "  ✅ $MARKET_TYPE recuperato."
done

cp "$TMP_CAT_ALL" "$TMP_CAT"

echo "Mercati ricevuti. Invio catalogo completo a Vercel..."
CAT_BODY="{\"type\":\"catalogue\",\"payload\":$(cat "$TMP_CAT") }"
HTTP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
  -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json" \
  --data "$CAT_BODY" "$BASE/api/betfair-sync")
if [ "$HTTP" != "200" ]; then
  echo "❌ Vercel ha rifiutato il catalogo. HTTP $HTTP"
  read -r -p "Invio per chiudere..."
  exit 12
fi
echo "✅ Catalogo salvato."

echo
echo "[3/4] Recupero quote BACK/LAY..."

# 150 partite × massimo 5 mercati = massimo 750 market ID.
IDS=$(perl -MJSON::PP -0777 -e '
  my $j = decode_json(join("", <>));
  my %seen;
  my @ids;
  for my $x (@{$j->[0]{result} || []}) {
    my $id = $x->{marketId};
    next unless defined $id && length $id;
    next if $seen{$id}++;
    push @ids, $id;
  }
  print join(",", @ids);
' "$TMP_CAT" 2>/dev/null || true)

if [ -z "$IDS" ]; then
  echo "⚠️ Nessun marketId trovato."
  read -r -p "Invio per chiudere..."
  exit 13
fi

IFS=',' read -r -a MARKET_ARRAY <<< "$IDS"
TOTAL=${#MARKET_ARRAY[@]}
BATCH=10
COUNT=0

echo "Market trovati: $TOTAL. Quote a blocchi di $BATCH."

for ((START=0; START<TOTAL; START+=BATCH)); do
  END=$((START+BATCH))
  if [ "$END" -gt "$TOTAL" ]; then END=$TOTAL; fi

  BATCH_IDS=""
  for ((I=START; I<END; I++)); do
    if [ -n "$BATCH_IDS" ]; then BATCH_IDS="$BATCH_IDS,"; fi
    BATCH_IDS="$BATCH_IDS\"${MARKET_ARRAY[$I]}\""
  done

  BOOK_PAYLOAD='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listMarketBook","params":{"marketIds":['"$BATCH_IDS"'],"priceProjection":{"priceData":["EX_BEST_OFFERS"],"exBestOffersOverrides":{"bestPricesDepth":1,"rollupModel":"STAKE","rollupLimit":0.0}}},"id":1}]'

  curl -sS --max-time 40 \
    -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" -H "Content-Type: application/json" \
    --data "$BOOK_PAYLOAD" "https://api.betfair.com/exchange/betting/json-rpc/v1" > "$TMP_BOOK"

  if grep -q '"errorCode"' "$TMP_BOOK"; then
    echo "❌ Errore quote nel blocco $((START/BATCH+1)):"
    cat "$TMP_BOOK"
    read -r -p "Invio per chiudere..."
    exit 14
  fi

  COUNT=$((COUNT + END - START))
  echo "  ✅ Quote ricevute: $COUNT/$TOTAL. Invio a Vercel..."

  BOOK_BODY="{\"type\":\"book\",\"payload\":$(cat "$TMP_BOOK") }"
  HTTP=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
    -H "Authorization: Bearer $BRIDGE_TOKEN" -H "Content-Type: application/json" \
    --data "$BOOK_BODY" "$BASE/api/betfair-sync")

  if [ "$HTTP" != "200" ]; then
    echo "❌ Vercel ha rifiutato le quote nel blocco $((START/BATCH+1)). HTTP $HTTP"
    read -r -p "Invio per chiudere..."
    exit 15
  fi
done

echo "✅ Quote ricevute e salvate."
echo
echo "[4/4] Bridge completato."
echo "Partite sincronizzate: fino a 150 eventi / fino a 750 market (5 mercati per partita), quote a blocchi di 10."
echo "Il servizio è in sola lettura: NON piazza scommesse."
echo
echo "Per aggiornare nuovamente i dati, esegui di nuovo questo file."
echo
echo "Non condividere password, private key o session token."
read -r -p "Premi Invio per chiudere..."
