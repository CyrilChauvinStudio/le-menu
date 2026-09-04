# Le Menu — application pour téléphone (hébergée sur GitHub Pages)

Voici l'appli « Le Menu » prête à installer sur ton téléphone, avec son icône.
On la publie gratuitement via GitHub Pages.

## 1. Créer le dépôt et déposer les fichiers (méthode sans ligne de commande)

1. Va sur https://github.com → connecte-toi → bouton **New** (nouveau dépôt).
2. Nom du dépôt : par exemple `le-menu`. Coche **Public**. Clique **Create repository**.
3. Sur la page du dépôt vide, clique le lien **« uploading an existing file »**
   (ou : Add file → Upload files).
4. Glisse **le contenu** de ce dossier (les fichiers eux-mêmes : `index.html`,
   `app.js`, `manifest.webmanifest`, `service-worker.js`, les `icon-*.png`,
   `apple-touch-icon-180.png`, `.nojekyll`) — **pas** un dossier qui les contient.
   `index.html` doit se retrouver à la racine du dépôt.
5. En bas, clique **Commit changes**.

## 2. Activer GitHub Pages

1. Dans le dépôt : onglet **Settings** → menu de gauche **Pages**.
2. Section **Build and deployment** → Source : **Deploy from a branch**.
3. Branch : **main**, dossier **/ (root)** → **Save**.
4. Patiente ~1 minute, recharge la page : GitHub affiche l'adresse de ton appli,
   du type `https://TON-PSEUDO.github.io/le-menu/`.

## 3. Installer sur le téléphone

Ouvre cette adresse sur ton téléphone :
- **iPhone (Safari)** : bouton Partager → « Sur l'écran d'accueil ».
- **Android (Chrome)** : menu ⋮ → « Installer l'application ».

L'icône « le menu » se pose sur l'écran d'accueil ; l'appli s'ouvre en plein écran.

## 4. Coller ta clé (obligatoire pour générer)

Cette appli autonome appelle l'IA directement avec **ta** clé Anthropic.

1. Crée une clé sur https://console.anthropic.com (rubrique **API Keys**).
2. Dans l'appli : onglet **Réglages** → colle-la dans **Clé API Anthropic**.

La clé reste **uniquement sur ton téléphone**. Le dépôt étant public, n'y mets
jamais ta clé : elle se saisit dans l'appli, pas dans le code.
Chaque génération de semaine coûte quelques centimes de crédits Anthropic.

## Variante ligne de commande (facultatif)

    git init
    git add .
    git commit -m "Le Menu"
    git branch -M main
    git remote add origin https://github.com/TON-PSEUDO/le-menu.git
    git push -u origin main

Puis active Pages comme à l'étape 2.

## Contenu du dossier
- `index.html`, `app.js` — l'application
- `manifest.webmanifest`, `service-worker.js` — installation + hors-ligne
- `icon-*.png`, `apple-touch-icon-180.png` — les icônes
- `.nojekyll` — évite que GitHub retraite les fichiers
