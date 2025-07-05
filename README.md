# 📚 La bibliothèque du KotArdoise

Une application web moderne pour explorer la bibliothèque avec recherche intelligente alimentée par l'IA.

## 🌟 Fonctionnalités

- 🔍 **Recherche classique** : Par titre, auteur ou ISBN
- 🤖 **Recherche IA** : Décrivez le livre que vous cherchez en langage naturel
- 📱 **Responsive** : Fonctionne parfaitement sur tous les appareils
- 📖 **Pagination** : Navigation fluide à travers la collection
- 🎨 **Design moderne** : Interface élégante avec effets visuels

## 🚀 Déploiement sur Netlify

### Méthode 1 : Déploiement via GitHub (Recommandée)

1. **Pousser vers GitHub :**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/votre-username/votre-repo.git
   git push -u origin main
   ```

2. **Connecter à Netlify :**
   - Allez sur [netlify.com](https://netlify.com)
   - Cliquez sur "New site from Git"
   - Connectez votre compte GitHub
   - Sélectionnez votre repository
   - Laissez les paramètres par défaut et cliquez "Deploy site"

3. **Configurer la clé API :**
   - Dans le dashboard Netlify, allez dans "Site settings" > "Environment variables"
   - Ajoutez une nouvelle variable :
     - **Key**: `GEMINI_API_KEY`
     - **Value**: Votre clé API Gemini
   - Redéployez le site

### Méthode 2 : Déploiement direct par glisser-déposer

1. **Zipper les fichiers :**
   - Sélectionnez tous les fichiers (index.html, netlify.toml, package.json, dossier netlify/)
   - Créez un fichier ZIP

2. **Déployer sur Netlify :**
   - Allez sur [netlify.com](https://netlify.com)
   - Faites glisser votre ZIP dans la zone "Deploy manually"

3. **Configurer la clé API :**
   - Même procédure que la méthode 1

## 🔑 Obtenir une clé API Gemini

1. Allez sur [Google AI Studio](https://makersuite.google.com/)
2. Connectez-vous avec votre compte Google
3. Cliquez sur "Get API Key"
4. Créez une nouvelle clé API
5. Copiez la clé et ajoutez-la dans les variables d'environnement Netlify

## 🛠️ Développement local

Pour tester localement avec les fonctions Netlify :

```bash
# Installer Netlify CLI
npm install -g netlify-cli

# Démarrer le serveur de développement
netlify dev
```

## 📁 Structure du projet

```
├── index.html              # Application principale
├── netlify.toml            # Configuration Netlify
├── package.json            # Métadonnées du projet
└── netlify/
    └── functions/
        └── ai-search.js    # Fonction serverless pour l'IA
```

## 🔒 Sécurité

- ✅ La clé API Gemini est stockée côté serveur
- ✅ Pas d'exposition de données sensibles
- ✅ CORS configuré correctement
- ✅ Validation des entrées

## 📱 Compatibilité

- ✅ Chrome, Firefox, Safari, Edge
- ✅ iOS Safari, Chrome Mobile
- ✅ Responsive design pour toutes tailles d'écran

## 🎯 Utilisation

1. **Recherche classique** : Tapez dans la barre de recherche principale
2. **Recherche IA** : Décrivez votre livre dans la barre avec l'icône 🤖
   - Exemple: "Un livre sur les dragons pour enfants"
   - Exemple: "Roman policier français contemporain"
3. **Réinitialiser** : Cliquez sur "🔄 Afficher tous les livres"

## 🚨 Dépannage

- **Recherche IA ne fonctionne pas** : Vérifiez que la clé API est bien configurée
- **Erreur CORS** : Assurez-vous que le site est déployé sur Netlify
- **Fonction non trouvée** : Vérifiez que le fichier `netlify.toml` est présent

## 📄 Licence

Ce projet est sous licence MIT.
