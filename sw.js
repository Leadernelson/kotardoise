// Service Worker pour la mise en cache optimisée - Bibliothèque KotArdoise
const CACHE_NAME = 'kotardoise-v1.1';
const STATIC_CACHE_NAME = 'kotardoise-static-v1.1';
const API_CACHE_NAME = 'kotardoise-api-v1.1';
const IMAGE_CACHE_NAME = 'kotardoise-images-v1.1';

// Ressources à mettre en cache immédiatement
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles/main.css',
  '/styles/mobile.css',
  '/styles/advanced-animations.css',
  '/js/app.js',
  '/manifest.json'
];

// Ressources externes importantes
const EXTERNAL_RESOURCES = [
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
  'https://fonts.gstatic.com/s/inter/v12/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2'
];

// Installation du Service Worker
self.addEventListener('install', event => {
  console.log('📦 Service Worker: Installation');
  
  event.waitUntil(
    Promise.all([
      // Cache statique
      caches.open(STATIC_CACHE_NAME).then(cache => {
        console.log('📦 Mise en cache des ressources statiques');
        return cache.addAll(STATIC_ASSETS);
      }),
      
      // Cache des ressources externes
      caches.open(CACHE_NAME).then(cache => {
        console.log('📦 Mise en cache des ressources externes');
        return cache.addAll(EXTERNAL_RESOURCES);
      })
    ]).then(() => {
      console.log('✅ Service Worker installé avec succès');
      return self.skipWaiting();
    })
  );
});

// Activation du Service Worker
self.addEventListener('activate', event => {
  console.log('🔄 Service Worker: Activation');
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          // Supprimer les anciens caches
          if (cacheName !== CACHE_NAME && 
              cacheName !== STATIC_CACHE_NAME && 
              cacheName !== API_CACHE_NAME && 
              cacheName !== IMAGE_CACHE_NAME) {
            console.log('🗑️ Suppression du cache obsolète:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('✅ Service Worker activé');
      return self.clients.claim();
    })
  );
});

// Stratégies de mise en cache
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);
  
  // Ignorer les requêtes non-HTTP
  if (!request.url.startsWith('http')) {
    return;
  }
  
  // API Google Sheets - Cache First avec Network Fallback
  if (url.hostname === 'opensheet.elk.sh') {
    event.respondWith(handleAPIRequest(request));
    return;
  }
  
  // Images de couvertures - Cache First
  if (url.hostname === 'covers.openlibrary.org' || url.hostname === 'via.placeholder.com') {
    event.respondWith(handleImageRequest(request));
    return;
  }
  
  // Polices Google - Cache First
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(handleFontRequest(request));
    return;
  }
  
  // Netlify Functions - Network First
  if (url.pathname.startsWith('/.netlify/functions/')) {
    event.respondWith(handleNetlifyFunction(request));
    return;
  }
  
  // Ressources statiques - Cache First
  if (request.destination === 'style' || request.destination === 'script' || 
      request.destination === 'document') {
    event.respondWith(handleStaticRequest(request));
    return;
  }
});

// Gestion des requêtes API avec cache intelligent
async function handleAPIRequest(request) {
  const cache = await caches.open(API_CACHE_NAME);
  
  try {
    // Essayer le réseau d'abord
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // Mettre en cache la réponse réussie
      cache.put(request, networkResponse.clone());
      console.log('📡 API: Données mises à jour depuis le réseau');
      return networkResponse;
    }
    
    throw new Error('Network response not ok');
  } catch (error) {
    // Fallback vers le cache
    console.log('📦 API: Utilisation du cache (réseau indisponible)');
    const cachedResponse = await cache.match(request);
    
    if (cachedResponse) {
      return cachedResponse;
    }
    
    // Réponse d'erreur si aucun cache disponible
    return new Response(JSON.stringify({ 
      error: 'Données indisponibles', 
      offline: true 
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Gestion des images avec cache persistant
async function handleImageRequest(request) {
  const cache = await caches.open(IMAGE_CACHE_NAME);
  
  // Vérifier le cache d'abord
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    console.log('🖼️ Image servie depuis le cache');
    return cachedResponse;
  }
  
  try {
    // Télécharger depuis le réseau
    const networkResponse = await fetch(request);
    
    if (networkResponse.ok) {
      // Mettre en cache pour 7 jours
      const responseToCache = networkResponse.clone();
      cache.put(request, responseToCache);
      console.log('🖼️ Image mise en cache');
      return networkResponse;
    }
    
    throw new Error('Image not found');
  } catch (error) {
    // Image de fallback
    console.log('🖼️ Image de fallback utilisée');
    return new Response('', { 
      status: 404,
      statusText: 'Image not found' 
    });
  }
}

// Gestion des polices avec cache longue durée
async function handleFontRequest(request) {
  const cache = await caches.open(STATIC_CACHE_NAME);
  
  // Cache first pour les polices
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }
  
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    // Fallback vers police système
    return new Response('', { status: 404 });
  }
}

// Gestion des fonctions Netlify
async function handleNetlifyFunction(request) {
  try {
    // Network first pour les fonctions
    const networkResponse = await fetch(request);
    return networkResponse;
  } catch (error) {
    return new Response(JSON.stringify({ 
      error: 'Service temporairement indisponible' 
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// Gestion des ressources statiques
async function handleStaticRequest(request) {
  const cache = await caches.open(STATIC_CACHE_NAME);
  
  // Cache first pour les ressources statiques
  const cachedResponse = await cache.match(request);
  if (cachedResponse) {
    // Actualisation en arrière-plan
    fetch(request).then(response => {
      if (response.ok) {
        cache.put(request, response);
      }
    }).catch(() => {});
    
    return cachedResponse;
  }
  
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  } catch (error) {
    // Fallback vers page d'erreur
    if (request.destination === 'document') {
      return new Response(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Hors ligne</title>
          <style>
            body { 
              font-family: sans-serif; 
              text-align: center; 
              padding: 2rem;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              flex-direction: column;
            }
          </style>
        </head>
        <body>
          <h1>📚 Bibliothèque KotArdoise</h1>
          <h2>Mode hors ligne</h2>
          <p>Veuillez vérifier votre connexion internet.</p>
          <button onclick="location.reload()">Réessayer</button>
        </body>
        </html>
      `, {
        headers: { 'Content-Type': 'text/html' }
      });
    }
    
    throw error;
  }
}

// Nettoyage périodique du cache
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CLEAN_CACHE') {
    cleanOldCaches();
  }
});

// Fonction de nettoyage des caches
async function cleanOldCaches() {
  const imageCache = await caches.open(IMAGE_CACHE_NAME);
  const requests = await imageCache.keys();
  
  // Supprimer les images plus anciennes que 7 jours
  const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  
  for (const request of requests) {
    const response = await imageCache.match(request);
    if (response) {
      const cachedDate = new Date(response.headers.get('date'));
      if (cachedDate.getTime() < oneWeekAgo) {
        await imageCache.delete(request);
      }
    }
  }
  
  console.log('🧹 Cache images nettoyé');
}

// Notification de mise à jour
self.addEventListener('updatefound', () => {
  console.log('🔄 Nouvelle version disponible');
});