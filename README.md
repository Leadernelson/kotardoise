# 📚 La bibliothèque du KotArdoise

> **Cher Ardoisien,**  
> Voici le système de gestion de la bibliothèque du Kap. Cette application a été développée pour faciliter la recherche de livres avec une interface moderne et une recherche IA intelligente.

## 🏠 Contexte du Kot

Cette application est destinée à gérer la bibliothèque commune du KotArdoise. Elle permet de :
- Rechercher facilement dans notre collection de livres
- Découvrir de nouveaux ouvrages grâce à l'IA
- Naviguer intuitivement dans la bibliothèque

## 🌟 Fonctionnalités

- 🔍 **Recherche classique** : Par titre, auteur ou ISBN
- 🤖 **Recherche IA** : Les Ardoisiens peuvent décrire le livre recherché en langage naturel
- 📱 **Responsive** : Accessible sur tout type d'appareil
- 📖 **Pagination** : Navigation fluide à travers notre collection
- 🎨 **Design moderne** : Interface élégante adaptée à l'esprit du Kot

## 🚀 Déploiement et maintenance

> **Important pour le successeur** : Le système est déjà déployé sur Netlify. Voici comment le maintenir et le mettre à jour.

### 🔄 Mise à jour du système

Si tu dois apporter des modifications :

1. **Récupérer le code existant :**
   ```bash
   git clone https://github.com/votre-username/votre-repo.git
   cd bibliotheque-kotardoise
   ```

2. **Faire tes modifications**
   - Édite les fichiers nécessaires
   - Teste localement (voir section développement)

3. **Déployer les changements :**
   ```bash
   git add .
   git commit -m "Description de tes modifications"
   git push origin main
   ```
   
   Le site se mettra automatiquement à jour sur Netlify !

### 🆕 Premier déploiement (si pas encore fait)

Si le système n'est pas encore déployé, voici la procédure complète :

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

3. **⚙️ Configurer la clé API (TRÈS IMPORTANT) :**
   - Dans le dashboard Netlify, va dans "Site settings" > "Environment variables"
   - Ajoute cette variable (demande la clé à ton prédécesseur ou crée-en une nouvelle) :
     - **Key**: `GEMINI_API_KEY`
     - **Value**: La clé API Gemini du Kot
   - Redéploie le site

### 🔄 Méthode alternative : Déploiement direct

Si GitHub pose problème, tu peux déployer directement :

1. **Zipper les fichiers :**
   - Sélectionne tous les fichiers (index.html, netlify.toml, package.json, dossier netlify/)
   - Crée un fichier ZIP

2. **Déployer sur Netlify :**
   - Va sur [netlify.com](https://netlify.com)
   - Fais glisser ton ZIP dans la zone "Deploy manually"

3. **Configurer la clé API :**
   - Même procédure que précédemment

## 🔑 Gestion de la clé API Gemini

> **Note importante** : La clé API Gemini est actuellement gratuite (juillet 2025). Il est possible qu'elle soit obsolète dans le futur.

### Si tu dois créer une nouvelle clé :

1. Va sur [Google AI Studio](https://aistudio.google.com/)
2. Connecte-toi avec le compte Google du Kot (ou crée-en une avec ton compte)
3. Clique sur "Get API Key"
4. Crée une nouvelle clé API
5. Copie la clé et ajoute-la dans les variables d'environnement Netlify

### 💡 Conseil d'Ardoisien :
- Garde précieusement cette clé API
- Transmets-la à ton successeur
- Surveille la consommation dans Google AI Studio

## 🛠️ Développement local (pour tes modifications)

Si tu veux tester tes changements avant de les déployer :

```bash
# Installer Netlify CLI (une seule fois)
npm install -g netlify-cli

# Démarrer le serveur de test local
netlify dev
```

Le site sera accessible sur `http://localhost:8888` pour tes tests.

## 📁 Structure du projet (à connaître)

```
├── index.html              # Interface principale que voient les Ardoisiens
├── netlify.toml            # Configuration Netlify (ne pas toucher)
├── package.json            # Métadonnées du projet
└── netlify/
    └── functions/
        └── ai-search.js    # Fonction qui gère la recherche IA
```

## 🎯 Guide d'utilisation pour les Ardoisiens

Explique aux autres Ardoisiens comment utiliser le système :

1. **Recherche classique** : Taper dans la barre de recherche principale
2. **Recherche IA** : Décrire le livre recherché dans la barre avec l'icône 🤖
   - Exemple: "Un livre sur les dragons pour enfants"
   - Exemple: "Roman policier français contemporain"
   - Exemple: "Livre de cuisine végétarienne"
3. **Réinitialiser** : Cliquer sur "🔄 Afficher tous les livres"

## 🚨 Dépannage (si ça ne marche plus)

### Problèmes courants et solutions :

- **❌ Recherche IA ne fonctionne pas** 
  - Vérifie que la clé API est bien configurée dans Netlify
  - Regarde les logs dans Netlify pour voir l'erreur
  
- **❌ Erreur CORS** 
  - Assure-toi que le site est bien déployé sur Netlify (pas en local)
  
- **❌ Fonction non trouvée** 
  - Vérifie que le fichier `netlify.toml` est présent
  - Redéploie le site

- **❌ Le site ne se met pas à jour**
  - Attends quelques minutes (le déploiement prend du temps)
  - Vide le cache de ton navigateur (Ctrl+F5)

### 🆘 En cas de problème majeur :
1. Contacte ton prédécesseur Ardoisien
2. Regarde les logs dans le dashboard Netlify
3. En dernier recours, redéploie tout depuis le début

## 🔒 Sécurité et bonnes pratiques

- ✅ La clé API Gemini est stockée côté serveur (invisible aux utilisateurs)
- ✅ Pas d'exposition de données sensibles
- ✅ CORS configuré correctement
- ✅ Validation des entrées utilisateur

## 📱 Compatibilité

Testé et fonctionnel sur :
- ✅ Chrome, Firefox, Safari, Edge
- ✅ iOS Safari, Chrome Mobile
- ✅ Tous les appareils (ordinateurs, tablettes, téléphones)

## 📝 Notes pour le successeur

> **Conseils d'Ardoisien à Ardoisien :**
> 
> - 📖 La base de données des livres est un fichier Google Sheets
> - 🤖 La recherche IA est gratuite pour l'instant
> - 🎨 L'interface peut être personnalisée en modifiant le CSS
> - 💾 Pense à faire des sauvegardes avant les gros changements
> - 🔄 Les mises à jour se font automatiquement via Git

## 🏆 Transmission du flambeau

Quand tu passeras le relais au prochain Ardoisien :
1. 📤 Assure-toi qu'il ait accès au repository GitHub
2. 🔑 Transmets-lui la clé API Gemini
3. 🌐 Donne-lui les accès Netlify
4. 📚 Explique-lui le fonctionnement du système
5. 🍺 Bois une bière ensemble pour célébrer la transmission !

## 📄 Licence

Ce projet est sous licence MIT - libre d'utilisation et de modification pour le bien du Kap !

---

*Développé avec ❤️ pour le kotArdoise*  
*"Une bibliothèque bien organisée fait un Kot heureux"*
