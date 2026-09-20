#!/bin/bash
set -u
CONFIG="$HOME/.ai-del-pallone/config"
CACHE="$HOME/.ai-del-pallone/bridge-cache"
CAT="$CACHE/catalogue-6h.json"
mkdir -p "$CACHE"
clear

echo "=============================================="
echo " AI DEL PALLONE — BETFAIR BRIDGE 6 ORE"
echo "=============================================="
echo " Recupera solo gli eventi che iniziano"
echo " nelle prossime 6 ore dal lancio."
echo
echo " Mercati:"
echo "  • 1X2 (MATCH_ODDS)"
echo "  • OVER/UNDER 1.5"
echo "  • OVER/UNDER 2.5"
echo "  • OVER/UNDER 3.5"
echo "  • GOAL/NO GOAL"
echo "  • SOLO quote BACK"
echo "=============================================="

[ -f "$CONFIG" ] || { echo "❌ Configurazione non trovata."; read -r -p "Invio..."; exit 2; }
source "$CONFIG"
TOKEN=$(security find-generic-password -a "$USER" -s "AI-DEL-PALLONE-BETFAIR-BRIDGE-TOKEN" -w 2>/dev/null || true)
APPKEY=$(security find-generic-password -a "$USER" -s "AI-DEL-PALLONE-BETFAIR-APPKEY" -w 2>/dev/null || true)
PASSWORD=$(security find-generic-password -a "$USER" -s "AI-DEL-PALLONE-BETFAIR-PASSWORD" -w 2>/dev/null || true)
[ -n "$TOKEN" ] && [ -n "$APPKEY" ] && [ -n "$PASSWORD" ] || { echo "❌ Credenziali mancanti nel Portachiavi."; read -r -p "Invio..."; exit 3; }
[ -f "$CERT" ] && [ -f "$KEY" ] || { echo "❌ Certificato/chiave non trovati."; read -r -p "Invio..."; exit 4; }

L=$(mktemp); C=$(mktemp); R=$(mktemp); B=$(mktemp); CATBODY=$(mktemp)
trap 'rm -f "$L" "$C" "$R" "$B" "$CATBODY" "$CAT.new"' EXIT

BETFAIR_URL="https://api.betfair.com/exchange/betting/json-rpc/v1"

# Finestra esatta: dal momento del lancio alle prossime 6 ore.
FROM=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TO=$(date -u -v+6H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '+6 hours' +"%Y-%m-%dT%H:%M:%SZ")

echo
echo "[1/3] Login Betfair..."
curl -sS -o "$L" --cert "$CERT" --key "$KEY" \
 -H "X-Application: $APPKEY" -H "Content-Type: application/x-www-form-urlencoded" \
 --data-urlencode "username=$USERNAME" --data-urlencode "password=$PASSWORD" \
 --connect-timeout 15 --max-time 30 \
 "https://identitysso-cert.betfair.it/api/certlogin" >/dev/null

grep -q '"loginStatus"[[:space:]]*:[[:space:]]*"SUCCESS"' "$L" || { echo "❌ Login Betfair fallito:"; sed -E 's/"sessionToken"[[:space:]]*:[[:space:]]*"[^"]+"/"sessionToken":"[HIDDEN]"/g' "$L"; read -r -p "Invio..."; exit 10; }
SESSION=$(sed -nE 's/.*"sessionToken"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$L")
echo "✅ Login riuscito."
echo " Finestra UTC: $FROM → $TO"

echo
echo "[2/3] Recupero mercati Betfair delle prossime 6 ore..."
Q='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listMarketCatalogue","params":{"filter":{"eventTypeIds":["1"],"marketTypeCodes":["MATCH_ODDS","OVER_UNDER_15","OVER_UNDER_25","OVER_UNDER_35","BOTH_TEAMS_TO_SCORE"],"marketStartTime":{"from":"'"$FROM"'","to":"'"$TO"'"}},"marketProjection":["EVENT","COMPETITION","MARKET_START_TIME","RUNNER_DESCRIPTION"],"sort":"FIRST_TO_START","maxResults":"1000"},"id":1}]'

curl -sS --max-time 40 \
 -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" \
 -H "Content-Type: application/json" --data "$Q" "$BETFAIR_URL" > "$C"

grep -q '"errorCode"' "$C" && { echo "❌ Errore catalogo Betfair."; cat "$C"; read -r -p "Invio..."; exit 11; }

# Conserva solo il risultato RPC e scarta eventuali mercati oltre la finestra (difesa ulteriore).
cp "$C" "$CAT"

COUNT=$(perl -MJSON::PP -0777 -e '
my $j=decode_json(join("",<>)); my $r=$j->[0]{result}||[]; print scalar(@$r);
' "$CAT" 2>/dev/null || echo 0)

if [ "$COUNT" -eq 0 ]; then
  echo "⚠️ Nessun mercato nelle prossime 6 ore."
  # Sincronizza comunque un catalogo vuoto/aggiornato, così il backend non usa il vecchio catalogo locale.
  BODY="{\"type\":\"catalogue\",\"payload\":$(cat "$CAT") }"
  H=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data "$BODY" "$BASE/api/betfair-sync")
  echo "Catalogo sincronizzato (HTTP $H)."
  read -r -p "Invio..."
  exit 0
fi

echo "✅ Mercati trovati: $COUNT"

# Salva il catalogo aggiornato su Supabase.
BODY="{\"type\":\"catalogue\",\"payload\":$(cat "$CAT") }"
H=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data "$BODY" "$BASE/api/betfair-sync")
[ "$H" = "200" ] || { echo "❌ Vercel HTTP $H durante il salvataggio del catalogue."; exit 12; }
echo "✅ Catalogo aggiornato su Supabase."

# Estrae tutti i marketId del catalogo appena scaricato.
IDS=$(perl -MJSON::PP -0777 -e '
my $j=decode_json(join("",<>)); my %s; my @a=grep{defined $_ && !$s{$_}++} map{$_->{marketId}} @{$j->[0]{result}||[]}; print join(",",@a);
' "$CAT" 2>/dev/null || true)
[ -n "$IDS" ] || { echo "❌ Nessun marketId."; exit 13; }

IFS=',' read -r -a M <<< "$IDS"
N=${#M[@]}
BATCH=40
DONE=0

echo
echo "[3/3] Recupero SOLO quote BACK..."
echo " Market: $N | blocchi: $BATCH"

for ((i=0;i<N;i+=BATCH)); do
  j=$((i+BATCH)); [ "$j" -gt "$N" ] && j=$N
  X=""
  for ((k=i;k<j;k++)); do
    [ -n "$X" ] && X="$X,"
    X="$X\"${M[$k]}\""
  done

  Q='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listMarketBook","params":{"marketIds":['"$X"'],"priceProjection":{"priceData":["EX_BEST_OFFERS"]}},"id":1}]'

  curl -sS --max-time 40 \
    -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" \
    -H "Content-Type: application/json" --data "$Q" "$BETFAIR_URL" > "$R"

  grep -q '"errorCode"' "$R" && { echo "❌ Errore quote Betfair."; cat "$R"; exit 14; }

  # Mantiene SOLO availableToBack e rimuove availableToLay prima del salvataggio.
  perl -MJSON::PP -0777 - "$R" > "$B" <<'PERL'
my ($f)=@ARGV;
my $j=decode_json(do{local $/; open my $fh,"<",$f or die $!; <$fh>});
for my $rpc (@$j) {
  for my $m (@{$rpc->{result}||[]}) {
    for my $r (@{$m->{runners}||[]}) {
      if (ref($r->{ex}) eq 'HASH') {
        my $back = $r->{ex}{availableToBack};
        $r->{ex} = { availableToBack => (ref($back) eq 'ARRAY' ? $back : []) };
      }
      delete $r->{availableToLay};
    }
  }
}
print encode_json($j);
PERL

  BODY="{\"type\":\"book\",\"payload\":$(cat "$B") }"
  H=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data "$BODY" "$BASE/api/betfair-sync")
  [ "$H" = "200" ] || { echo "❌ Vercel HTTP $H durante il salvataggio delle quote."; exit 15; }

  DONE=$j
  echo "  ✅ BACK aggiornate: $DONE/$N"
done

echo
echo "=============================================="
echo " ✅ BRIDGE COMPLETATO"
echo "=============================================="
echo " Finestra: prossime 6 ore dal lancio"
echo " Mercati: 1X2 + O/U 1.5 + O/U 2.5 + O/U 3.5 + G/NG"
echo " Prezzi salvati: SOLO BACK"
echo " Mercati aggiornati: $N"
echo "=============================================="
read -r -p "Premi Invio per chiudere..."
