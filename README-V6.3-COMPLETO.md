# AI DEL PALLONE — APP V6.3

Pacchetto completo basato sulla versione v119, con motore V6.3 indipendente dal mercato Betfair.

## Perimetro mercati
- Match Odds / 1X2
- Over/Under 1.5
- Over/Under 2.5
- Over/Under 3.5
- Over/Under 4.5
- O/U 0.5 escluso
- Handicap, Goal/No Goal e Correct Score esclusi

## Motore V6.3
P_model viene costruito da dati storici/modello locale; Betfair non entra nella probabilita del modello. Betfair viene usato per prezzo BACK, probabilita di mercato, liquidita e edge.

## Supabase
Il loader dei BOOK legge fino a 1000 snapshot per ciclo, sufficiente per i 750 market correnti.

## UI
Sezioni: Oggi, Consigli AI, Giocate, Bilancio, Account/Sincronizzazione, Impostazioni. Social Studio, condivisione e generazione immagini non sono esposti nella UI.

## Sicurezza
Non includere .env, private key, certificati o token nel repository/deployment.
