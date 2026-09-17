AI DEL PALLONE — MARKET BOOK FIX v2

Correzione definitiva del parsing del market book:
Betfair sta restituendo un array di envelope JSON-RPC, ciascuno con un campo
result che contiene i marketBook. Ora il parser estrae result da ogni elemento
dell'array prima di cercare marketId.

Il resto del pacchetto è invariato.
