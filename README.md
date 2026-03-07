# 🚄 SNCF Live Proxy

Serveur Node.js qui récupère les flux GTFS-RT SNCF open data,
les décode (protobuf → JSON) et les expose via une API REST simple.

**Données source** : [transport.data.gouv.fr](https://transport.data.gouv.fr) — 100% gratuit, sans clé API.

---

## Endpoints

| Méthode | Route | Description |
|---------|-------|-------------|
| GET | `/health` | Statut du serveur + âge du cache |
| GET | `/trains` | Tous les trains en circulation |
| GET | `/trains/:id` | Détail d'un train par ID |
| GET | `/alerts` | Perturbations actives |
| GET | `/summary` | Résumé stats + alertes |

### Filtres disponibles sur `/trains`

```
GET /trains?type=TGV
GET /trains?status=SIGNIFICANT_DELAYS
GET /trains?minDelay=10
GET /trains?limit=50
```

### Statuts possibles (`rtStatus`)

- `NO_DISRUPTION` — circulation normale
- `SIGNIFICANT_DELAYS` — retard > 5 min
- `MODIFIED_SERVICE` — arrêts ajoutés ou supprimés
- `NO_SERVICE` — train supprimé

---

## Installation locale

```bash
# Cloner le repo
git clone https://github.com/TON-USERNAME/sncf-proxy.git
cd sncf-proxy

# Installer les dépendances
npm install

# Lancer le serveur
npm start
# → http://localhost:3000
```

---

## Déploiement sur Render.com (gratuit)

1. **Crée un compte** sur [render.com](https://render.com) (gratuit)
2. **New → Web Service**
3. **Connecte ton repo GitHub** contenant ce projet
4. Remplis les champs :
   - **Name** : `sncf-proxy` (ou ce que tu veux)
   - **Environment** : `Node`
   - **Build Command** : `npm install`
   - **Start Command** : `npm start`
   - **Plan** : `Free`
5. Clique **Deploy** → Render te donne une URL du type `https://sncf-proxy-xxxx.onrender.com`
6. Teste : `https://sncf-proxy-xxxx.onrender.com/health`

---

## Variables d'environnement

Aucune requise pour fonctionner. Optionnelles :

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `3000` | Port d'écoute (Render le définit automatiquement) |

---

## Architecture

```
Navigateur (site HTML)
      ↕ JSON (fetch simple)
Serveur Node.js — ce repo
      ↕ Protobuf binaire (GTFS-RT)
transport.data.gouv.fr (SNCF open data)
      ↕
SNCF Réseau (source officielle)
```

**Cache** : les données sont mises en cache 60 secondes pour ne pas surcharger les APIs source.
