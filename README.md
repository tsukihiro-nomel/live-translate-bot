# Discord Live Translate + OBS Overlay (WebSocket)

Bot Discord qui rejoint un vocal, capte **qui parle** via l'identité Discord, fait une **transcription (STT)** puis une **traduction** (2 agents IA), et envoie le résultat à un **overlay OBS** via WebSocket (Browser Source).

## ✨ Ce que ça fait (résumé)
- **Une bulle par speaker** (avatar + pseudo + traduction).
- Bottom-left stack, style pastel lisible.
- Les bulles **apparaissent**, restent un peu, puis **disparaissent** après un délai d'inactivité.
- **Pas de stockage** : traitement en RAM (côté bot). (Côté OpenAI, on envoie `store:false` sur la traduction.)

## 1) Installation

### Prérequis
- Node.js **20+**
- Un bot Discord (token + client id)
- Une clé OpenAI (OPENAI_API_KEY)

### Setup
```bash
cd live-translate-bot
cp .env.example .env
# remplis .env
npm install

# (recommandé) déployer les slash commands
npm run deploy-commands

# lancer
npm start
```

## 2) Commandes
- `/live on` : démarre le live dans TON vocal actuel
- `/live off` : stop
- `/live target <langue>` : ex `fr`, `en`, `ja`…
- `/live overlaytoken <token>` : change le token overlay
- `/live glossary add <source> <target>` : ajoute une règle de glossaire
- `/live glossary list` : liste
- `/live glossary remove <source>` : supprime

## 3) OBS Overlay
Dans OBS → **Browser Source**
- URL : `http://localhost:3000/overlay?token=TON_TOKEN`
- Width/Height : selon ta scène (ex 1920x1080)
- Coche : *Refresh browser when scene becomes active* (pratique)

## 4) Notes importantes
- Discord envoie l'audio en Opus; le bot décode en PCM et envoie des petits WAV à l'API STT.
- La limite de taille fichier côté STT est très haute pour nos segments (mais on coupe quand même à MAX_PHRASE_SECONDS).
- Si tu veux réduire les coûts :
  - `INTERIM_TRANSLATE_EVERY_MS=0` (défaut) → on traduit surtout le **final**
  - VAD / segmentation → on évite d'envoyer du silence

## 5) Docker (optionnel)
```bash
docker compose -f docker/docker-compose.yml up -d --build
```

---

Made for the "poisson Babel" Discord + OBS vibe 🐟🫧
