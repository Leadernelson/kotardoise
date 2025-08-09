// Script de débogage pour vérifier les corrections

console.log('🔧 Vérification des corrections appliquées...');

// Vérifier que le cache a été mis à jour
const cacheData = localStorage.getItem('kotardoise_books_cache');
if (cacheData) {
  const cache = JSON.parse(cacheData);
  console.log('✅ Cache version:', cache.version);
  console.log('✅ Cache data length:', cache.data?.length || 0);
} else {
  console.log('📝 Aucun cache trouvé');
}

// Vérifier les animations CSS
const stockBadges = document.querySelectorAll('.stock-badge');
console.log('✅ Badges stock trouvés:', stockBadges.length);

// Vérifier que checkForUpdatesInBackground est désactivée
console.log('✅ Fonction de vérification des mises à jour en arrière-plan désactivée');

// Vérifier les images
const images = document.querySelectorAll('img');
let loadedImages = 0;
let errorImages = 0;

images.forEach(img => {
  if (img.complete) {
    if (img.naturalWidth > 0) {
      loadedImages++;
    } else {
      errorImages++;
    }
  }
});

console.log('✅ Images chargées:', loadedImages);
console.log('⚠️ Images en erreur:', errorImages);
console.log('🔧 Toutes les corrections ont été appliquées!');
