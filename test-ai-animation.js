// Test de l'animation de chargement IA

console.log('🧪 Test de l\'animation de chargement IA...');

function testAILoadingAnimation() {
  const aiSearchInput = document.getElementById('ai-search');
  const aiSearchLoader = document.getElementById('ai-search-loader');
  
  if (!aiSearchInput || !aiSearchLoader) {
    console.error('❌ Éléments de recherche IA non trouvés');
    return;
  }
  
  console.log('✅ Éléments de recherche IA trouvés');
  
  // Test de simulation de recherche
  console.log('🔄 Simulation de recherche IA...');
  
  // Activer l'animation
  aiSearchInput.disabled = true;
  aiSearchInput.classList.add('searching');
  aiSearchInput.placeholder = 'Recherche IA en cours...';
  aiSearchLoader.style.display = 'block';
  
  console.log('✅ Animation de chargement activée');
  
  // Désactiver après 3 secondes pour test
  setTimeout(() => {
    aiSearchInput.disabled = false;
    aiSearchInput.classList.remove('searching');
    aiSearchInput.placeholder = 'Décrivez le livre que vous cherchez...';
    aiSearchLoader.style.display = 'none';
    
    console.log('✅ Animation de chargement désactivée');
    console.log('🎉 Test d\'animation terminé avec succès !');
  }, 3000);
}

// Fonction pour tester manuellement
window.testAILoadingAnimation = testAILoadingAnimation;

console.log('🧪 Utilisez window.testAILoadingAnimation() pour tester l\'animation');
console.log('🔍 Ou tapez une recherche dans le champ IA pour voir l\'animation en action');
