#!/bin/bash
# ==============================================================================
# PRIMO AVVIO SU UN MAC NUOVO O DOPO UN NUOVO DOWNLOAD: macOS blocca gli script
# scaricati da internet non firmati (Gatekeeper). Serve farlo UNA SOLA VOLTA,
# poi lo script si avvierà sempre normalmente con un doppio click.
#
# Apri il Terminale, vai nella cartella dove hai salvato questo file e lancia:
#   chmod +x betfair-bridge.command
#   xattr -d com.apple.quarantine betfair-bridge.command
#
# (il secondo comando può dare "No such xattr" se il flag non c'era già:
# va bene così, significa che non serviva.)
# ==============================================================================
set -u
CONFIG="$HOME/.ai-del-pallone/config"
CACHE="$HOME/.ai-del-pallone/bridge-cache"
CAT="$CACHE/catalogue-6h.json"
mkdir -p "$CACHE"
clear

echo "=============================================="
echo " AI DEL PALLONE — BETFAIR BRIDGE"
echo "=============================================="
echo " Mercati:"
echo "  • 1X2 (MATCH_ODDS)"
echo "  • OVER/UNDER 2.5"
echo "  • OVER/UNDER 3.5"
echo "  • GOAL/NO GOAL"
echo "  • SOLO quote BACK"
echo
echo " Più: saldo e storico scommesse reali del conto."
echo "=============================================="

[ -f "$CONFIG" ] || { echo "❌ Configurazione non trovata."; read -r -p "Invio..."; exit 2; }
source "$CONFIG"
TOKEN=$(security find-generic-password -a "$USER" -s "AI-DEL-PALLONE-BETFAIR-BRIDGE-TOKEN" -w 2>/dev/null || true)
APPKEY=$(security find-generic-password -a "$USER" -s "AI-DEL-PALLONE-BETFAIR-APPKEY" -w 2>/dev/null || true)
PASSWORD=$(security find-generic-password -a "$USER" -s "AI-DEL-PALLONE-BETFAIR-PASSWORD" -w 2>/dev/null || true)
[ -n "$TOKEN" ] && [ -n "$APPKEY" ] && [ -n "$PASSWORD" ] || { echo "❌ Credenziali mancanti nel Portachiavi."; read -r -p "Invio..."; exit 3; }
[ -f "$CERT" ] && [ -f "$KEY" ] || { echo "❌ Certificato/chiave non trovati."; read -r -p "Invio..."; exit 4; }

BETFAIR_URL="https://api.betfair.com/exchange/betting/json-rpc/v1"
ACCOUNT_URL="https://api.betfair.com/exchange/account/json-rpc/v1"

echo
echo "Quante ore di eventi vuoi scaricare da adesso (a ogni aggiornamento)?"
echo "  1) Prossime 2 ore"
echo "  2) Prossime 4 ore"
echo "  3) Prossime 12 ore"
echo "  4) Prossime 20 ore  (default — copre l'intera finestra 'oggi' 11:00-22:00)"
echo "  5) Personalizzato (scrivi tu il numero di ore)"
read -r -p "Scelta [4]: " HOURS_CHOICE
case "${HOURS_CHOICE:-4}" in
  1) HOURS=2 ;;
  2) HOURS=4 ;;
  3) HOURS=12 ;;
  4) HOURS=20 ;;
  5)
    read -r -p "Quante ore (numero intero, es. 6): " HOURS
    if ! [[ "$HOURS" =~ ^[0-9]+$ ]] || [ "$HOURS" -lt 1 ]; then
      echo "Valore non valido, uso 20 ore di default."
      HOURS=20
    fi
    ;;
  *) echo "Scelta non riconosciuta, uso 20 ore di default."; HOURS=20 ;;
esac
echo "→ Recupero eventi nelle prossime $HOURS ore, a ogni aggiornamento."

echo
echo "Vuoi che il bridge si riavvii automaticamente da solo, senza doverlo"
echo "riaprire ogni volta? Utile anche per il segnale di movimento quota"
echo "dell'app (serve almeno 45 minuti tra una sincronizzazione e l'altra)."
echo "  1) No, lancio singolo (come prima — chiude dopo un giro)"
echo "  2) Sì, ogni ora"
echo "  3) Sì, ogni 2 ore"
echo "  4) Sì, ogni 4 ore"
echo "  5) Sì, personalizzato (minuti)"
read -r -p "Scelta [1]: " LOOP_CHOICE
case "${LOOP_CHOICE:-1}" in
  1) LOOP_MIN=0 ;;
  2) LOOP_MIN=60 ;;
  3) LOOP_MIN=120 ;;
  4) LOOP_MIN=240 ;;
  5)
    read -r -p "Ogni quanti minuti (minimo 15): " LOOP_MIN
    if ! [[ "$LOOP_MIN" =~ ^[0-9]+$ ]] || [ "$LOOP_MIN" -lt 15 ]; then
      echo "Valore non valido, riavvio automatico disattivato."
      LOOP_MIN=0
    fi
    ;;
  *) LOOP_MIN=0 ;;
esac
if [ "$LOOP_MIN" -gt 0 ]; then
  echo "→ Il bridge si riavvierà da solo ogni $LOOP_MIN minuti."
  echo "  Per fermarlo in qualunque momento: Ctrl+C, oppure chiudi questa finestra."
else
  echo "→ Lancio singolo: lo script farà un giro e poi si fermerà."
fi

# Un'unica sincronizzazione completa (login, saldo/storico conto, mercati, quote BACK).
# Ritorna 0 se tutto è andato a buon fine, diverso da 0 su un errore di quel giro — non
# interrompe MAI il processo con "exit": in modalità ciclo continuo un giro fallito non
# deve fermare tutti i successivi, solo essere segnalato.
run_one_sync(){
  local L C R B FUNDS_F CLEARED_F CURRENT_F FROM TO SESSION COUNT IDS N BATCH DONE

  L=$(mktemp); C=$(mktemp); R=$(mktemp); B=$(mktemp)
  FUNDS_F=$(mktemp); CLEARED_F=$(mktemp); CURRENT_F=$(mktemp)
  # Pulizia di QUESTO giro, sempre, anche in caso di return anticipato.
  trap 'rm -f "$L" "$C" "$R" "$B" "$FUNDS_F" "$CLEARED_F" "$CURRENT_F"' RETURN

  FROM=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  TO=$(date -u -v+"${HOURS}"H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "+${HOURS} hours" +"%Y-%m-%dT%H:%M:%SZ")

  echo
  echo "[1/4] Login Betfair..."
  curl -sS -o "$L" --cert "$CERT" --key "$KEY" \
   -H "X-Application: $APPKEY" -H "Content-Type: application/x-www-form-urlencoded" \
   --data-urlencode "username=$USERNAME" --data-urlencode "password=$PASSWORD" \
   --connect-timeout 15 --max-time 30 \
   "https://identitysso-cert.betfair.it/api/certlogin" >/dev/null

  if ! grep -q '"loginStatus"[[:space:]]*:[[:space:]]*"SUCCESS"' "$L"; then
    echo "❌ Login Betfair fallito:"
    sed -E 's/"sessionToken"[[:space:]]*:[[:space:]]*"[^"]+"/"sessionToken":"[HIDDEN]"/g' "$L"
    return 10
  fi
  SESSION=$(sed -nE 's/.*"sessionToken"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$L")
  echo "✅ Login riuscito."
  echo " Finestra UTC: $FROM → $TO"

  # --- Dati del conto reale: saldo e storico scommesse -----------------------
  echo
  echo "[2/4] Recupero saldo e storico scommesse dal conto Betfair..."

  QF='[{"jsonrpc":"2.0","method":"AccountAPING/v1.0/getAccountFunds","params":{},"id":1}]'
  curl -sS --max-time 20 -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" \
    -H "Content-Type: application/json" --data "$QF" "$ACCOUNT_URL" > "$FUNDS_F"
  if grep -q '"errorCode"' "$FUNDS_F"; then
    echo "  ⚠️ Saldo non recuperato (non blocca il resto)."
  else
    BODY="{\"type\":\"funds\",\"payload\":$(cat "$FUNDS_F") }"
    H=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 20 -X POST \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      --data "$BODY" "$BASE/api/betfair-account-sync")
    [ "$H" = "200" ] && echo "  ✅ Saldo sincronizzato." || echo "  ⚠️ Saldo: Vercel HTTP $H."
  fi

  CLEARED_FROM=$(date -u -v-90d +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '90 days ago' +"%Y-%m-%dT%H:%M:%SZ")
  QC='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listClearedOrders","params":{"betStatus":"SETTLED","settledDateRange":{"from":"'"$CLEARED_FROM"'"},"groupBy":"BET","includeItemDescription":true,"recordCount":1000},"id":1}]'
  curl -sS --max-time 30 -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" \
    -H "Content-Type: application/json" --data "$QC" "$BETFAIR_URL" > "$CLEARED_F"
  if grep -q '"errorCode"' "$CLEARED_F"; then
    echo "  ⚠️ Storico scommesse non recuperato (non blocca il resto)."
  else
    BODY="{\"type\":\"clearedOrders\",\"payload\":$(cat "$CLEARED_F") }"
    H=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      --data "$BODY" "$BASE/api/betfair-account-sync")
    [ "$H" = "200" ] && echo "  ✅ Storico scommesse sincronizzato (ultimi 90 giorni)." || echo "  ⚠️ Storico: Vercel HTTP $H."
  fi

  QO='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listCurrentOrders","params":{},"id":1}]'
  curl -sS --max-time 20 -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" \
    -H "Content-Type: application/json" --data "$QO" "$BETFAIR_URL" > "$CURRENT_F"
  if grep -q '"errorCode"' "$CURRENT_F"; then
    echo "  ⚠️ Scommesse aperte non recuperate (non blocca il resto)."
  else
    BODY="{\"type\":\"currentOrders\",\"payload\":$(cat "$CURRENT_F") }"
    H=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 20 -X POST \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      --data "$BODY" "$BASE/api/betfair-account-sync")
    [ "$H" = "200" ] && echo "  ✅ Scommesse aperte sincronizzate." || echo "  ⚠️ Aperte: Vercel HTTP $H."
  fi

  echo
  echo "[3/4] Recupero mercati Betfair delle prossime $HOURS ore..."
  Q='[{"jsonrpc":"2.0","method":"SportsAPING/v1.0/listMarketCatalogue","params":{"filter":{"eventTypeIds":["1"],"marketTypeCodes":["MATCH_ODDS","OVER_UNDER_25","OVER_UNDER_35","BOTH_TEAMS_TO_SCORE"],"marketStartTime":{"from":"'"$FROM"'","to":"'"$TO"'"}},"marketProjection":["EVENT","COMPETITION","MARKET_START_TIME","RUNNER_DESCRIPTION"],"sort":"FIRST_TO_START","maxResults":"1000"},"id":1}]'

  curl -sS --max-time 40 \
   -H "X-Application: $APPKEY" -H "X-Authentication: $SESSION" \
   -H "Content-Type: application/json" --data "$Q" "$BETFAIR_URL" > "$C"

  if grep -q '"errorCode"' "$C"; then
    echo "❌ Errore catalogo Betfair."; cat "$C"
    return 11
  fi

  cp "$C" "$CAT"

  COUNT=$(perl -MJSON::PP -0777 -e '
my $j=decode_json(join("",<>)); my $r=$j->[0]{result}||[]; print scalar(@$r);
' "$CAT" 2>/dev/null || echo 0)

  if [ "$COUNT" -eq 0 ]; then
    echo "⚠️ Nessun mercato nelle prossime $HOURS ore."
    BODY="{\"type\":\"catalogue\",\"payload\":$(cat "$CAT") }"
    H=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
      --data "$BODY" "$BASE/api/betfair-sync")
    echo "Catalogo sincronizzato (HTTP $H)."
    echo "✅ Saldo e storico scommesse comunque sincronizzati sopra."
    return 0
  fi

  echo "✅ Mercati trovati: $COUNT"

  BODY="{\"type\":\"catalogue\",\"payload\":$(cat "$CAT") }"
  H=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 30 -X POST \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
    --data "$BODY" "$BASE/api/betfair-sync")
  if [ "$H" != "200" ]; then echo "❌ Vercel HTTP $H durante il salvataggio del catalogue."; return 12; fi
  echo "✅ Catalogo aggiornato su Supabase."

  IDS=$(perl -MJSON::PP -0777 -e '
my $j=decode_json(join("",<>)); my %s; my @a=grep{defined $_ && !$s{$_}++} map{$_->{marketId}} @{$j->[0]{result}||[]}; print join(",",@a);
' "$CAT" 2>/dev/null || true)
  if [ -z "$IDS" ]; then echo "❌ Nessun marketId."; return 13; fi

  IFS=',' read -r -a M <<< "$IDS"
  N=${#M[@]}
  BATCH=40
  DONE=0

  echo
  echo "[4/4] Recupero SOLO quote BACK..."
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

    if grep -q '"errorCode"' "$R"; then echo "❌ Errore quote Betfair."; cat "$R"; return 14; fi

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
    if [ "$H" != "200" ]; then echo "❌ Vercel HTTP $H durante il salvataggio delle quote."; return 15; fi

    DONE=$j
    echo "  ✅ BACK aggiornate: $DONE/$N"
  done

  echo
  echo " Mercati aggiornati: $N"
  return 0
}

RUN_COUNT=0
while true; do
  RUN_COUNT=$((RUN_COUNT+1))
  echo
  echo "=============================================="
  echo " GIRO #$RUN_COUNT — $(date '+%H:%M:%S')"
  echo "=============================================="

  run_one_sync
  RC=$?

  echo
  if [ "$RC" -eq 0 ]; then
    echo "✅ Giro #$RUN_COUNT completato."
  else
    echo "⚠️ Giro #$RUN_COUNT terminato con un errore (codice $RC) — vedi sopra. Il resto continua comunque."
  fi

  if [ "$LOOP_MIN" -eq 0 ]; then
    echo "=============================================="
    read -r -p "Premi Invio per chiudere..."
    break
  fi

  NEXT=$(date -v+"${LOOP_MIN}"M +"%H:%M:%S" 2>/dev/null || date -d "+${LOOP_MIN} minutes" +"%H:%M:%S")
  echo " Prossimo aggiornamento alle $NEXT (tra $LOOP_MIN minuti)."
  echo " Ctrl+C per fermare, oppure chiudi questa finestra."
  echo "=============================================="
  sleep "$((LOOP_MIN*60))"
done
