# Mise à jour de la structure des données - Colonnes Auteur

## Date : 9 octobre 2025

## Changements effectués

La structure du fichier Excel et du JSON OpenSheet a été modifiée pour séparer le nom de l'auteur en deux colonnes distinctes :

### Ancienne structure
- `Auteur` : Une seule colonne contenant le nom complet de l'auteur

### Nouvelle structure
- `Prénom` : Prénom de l'auteur
- `Nom de Famille` : Nom de famille de l'auteur
- `Titre` : Titre de l'œuvre (inchangé)
- `Genre` : Genre(s) du livre (inchangé)

## Fichiers modifiés

### 1. `index.html`
- **Fonction `createBookElement()`** : Construction du nom complet de l'auteur à partir des colonnes `Prénom` et `Nom de Famille`
- **Fonction `getCoverURL()`** : Utilisation des colonnes séparées pour la recherche de couvertures
- **Fonction `performSearch()`** : Recherche dans les deux colonnes séparément ainsi que dans le nom complet
- **Fonction `performAISearch()`** : Envoi des données structurées avec `prenom`, `nomDeFamille` et `auteur` (nom complet) à l'API AI

### 2. `netlify/functions/ai-search.js`
- **Fonction `compactBooks()`** : Gestion des colonnes séparées avec fallback sur l'ancienne structure pour la rétrocompatibilité
- **Fonction `performFallbackSearch()`** : Construction du nom complet et recherche dans les colonnes séparées

### 3. `test-cover-search.html`
- **Fonction `getCoverURL()`** : Adaptation pour utiliser les nouvelles colonnes
- **Fonctions de test** : Mise à jour des données de test avec `Prénom` et `Nom de Famille`

## Compatibilité

Le code est conçu pour être rétrocompatible :
- Si les colonnes `Prénom` et `Nom de Famille` existent, elles sont utilisées
- Si seule la colonne `Auteur` existe (ancienne structure), elle est utilisée comme fallback
- Cela permet une transition en douceur sans casser les anciennes données

## Format attendu du JSON OpenSheet

```json
[
  {
    "Titre": "Le Petit Prince",
    "Prénom": "Antoine de",
    "Nom de Famille": "Saint-Exupéry",
    "Genre": "Fiction, Classique",
    "ISBN": "9782070415274",
    "Stock": 3
  },
  {
    "Titre": "1984",
    "Prénom": "George",
    "Nom de Famille": "Orwell",
    "Genre": "Science-fiction, Dystopie",
    "ISBN": "9780451524935",
    "Stock": 5
  }
]
```

## Tests recommandés

1. Vérifier que les livres s'affichent correctement avec le nom complet de l'auteur
2. Tester la recherche par prénom uniquement
3. Tester la recherche par nom de famille uniquement
4. Tester la recherche par nom complet
5. Vérifier que la recherche AI fonctionne correctement avec les nouvelles colonnes
6. Tester la récupération des couvertures de livres via OpenLibrary

## Notes importantes

- Les noms d'auteurs sont maintenant construits dynamiquement : `Prénom + " " + Nom de Famille`
- La recherche est plus flexible et peut trouver des livres par prénom ou nom de famille séparément
- L'API AI reçoit les deux colonnes séparées pour une meilleure précision de recherche
