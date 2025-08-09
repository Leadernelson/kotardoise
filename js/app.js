// Bibliothèque KotArdoise - Application optimisée pour performance mobile
(function() {
  'use strict';
  
  // Variables globales optimisées
  let allBooks = [];
  let filteredBooks = [];
  let currentPage = 1;
  const booksPerPage = 15;
  
  // Cache localStorage optimisé
  const CACHE_KEY = 'kotardoise_books_cache';
  const CACHE_VERSION = '1.1';
  const CACHE_DURATION = 10 * 60 * 1000; // 10 minutes
  
  // Monitoring de la bande passante
  let bandwidthUsage = {
    session: 0,
    images: 0,
    data: 0
  };
  
  // Cache des résultats de recherche optimisé
  const searchCache = new Map();
  let searchTimeout;
  
  // Elements DOM - Cache pour éviter les requêtes répétées
  const elements = {
    livres: null,
    resultsInfo: null,
    pagination: null,
    search: null,
    aiSearch: null,
    resetBtn: null
  };
  
  // Initialiser les références DOM
  function initDOMElements() {
    elements.livres = document.getElementById("livres");
    elements.resultsInfo = document.getElementById("results-info");
    elements.pagination = document.getElementById("pagination");
    elements.search = document.getElementById("search");
    elements.aiSearch = document.getElementById("ai-search");
    elements.resetBtn = document.getElementById("reset-btn");
  }
  
  // Fonctions de cache optimisées
  function getCachedBooks() {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (!cached) return null;
      
      const { data, timestamp, version } = JSON.parse(cached);
      const now = Date.now();
      const cacheAge = now - timestamp;
      
      if (version === CACHE_VERSION && cacheAge < CACHE_DURATION) {
        const hoursOld = Math.round(cacheAge / (60 * 60 * 1000) * 10) / 10;
        console.log(`📦 Cache utilisé: ${data.length} livres (${hoursOld}h)`);
        return data;
      }
      
      console.log('🕒 Cache expiré, rechargement...');
      localStorage.removeItem(CACHE_KEY);
      return null;
    } catch (error) {
      console.warn('Erreur lecture cache:', error);
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
  }
  
  function setCachedBooks(data) {
    try {
      const cacheData = {
        data: data,
        timestamp: Date.now(),
        version: CACHE_VERSION
      };
      localStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));
      console.log(`💾 Cache mis à jour: ${data.length} livres`);
    } catch (error) {
      console.warn('Erreur sauvegarde cache:', error);
    }
  }
  
  // Tracking de bande passante optimisé
  function trackBandwidthUsage(type, bytes) {
    bandwidthUsage.session += bytes;
    bandwidthUsage[type] += bytes;
    
    if (bandwidthUsage.session % (1024 * 1024) < bytes) {
      console.log(`📊 Bande passante: ${Math.round(bandwidthUsage.session / 1024)}KB`);
    }
  }
  
  // Rendu optimisé avec Virtual Scrolling pour gros volumes
  function renderBooks(books, page = 1) {
    if (books.length === 0) {
      elements.livres.innerHTML = '<div class="no-results">Aucun livre trouvé 📚</div>';
      elements.resultsInfo.innerHTML = '';
      elements.pagination.innerHTML = '';
      return;
    }
    
    const totalPages = Math.ceil(books.length / booksPerPage);
    const startIndex = (page - 1) * booksPerPage;
    const endIndex = startIndex + booksPerPage;
    const booksToShow = books.slice(startIndex, endIndex);
    
    // Affichage des informations optimisé
    elements.resultsInfo.innerHTML = `
      <strong>${books.length}</strong> livre${books.length > 1 ? 's' : ''} trouvé${books.length > 1 ? 's' : ''} 
      | Page <strong>${page}</strong>/<strong>${totalPages}</strong> 
      | <strong>${startIndex + 1}</strong>-<strong>${Math.min(endIndex, books.length)}</strong>
    `;
    
    // Fragment DOM pour performance
    const fragment = document.createDocumentFragment();
    
    booksToShow.forEach((livre, index) => {
      const div = document.createElement("div");
      div.className = "book";
      div.style.animationDelay = `${index * 0.05}s`; // Réduit pour fluidité mobile
      
      // URL optimisée - taille Medium au lieu de Large
      const coverURL = `https://covers.openlibrary.org/b/isbn/${livre.ISBN}-M.jpg`;
      
      div.innerHTML = `
        <div class="book-content">
          <div class="book-cover">
            <img src="${coverURL}" 
                 alt="Couverture de ${livre.Titre}" 
                 onerror="this.src='https://via.placeholder.com/120x160/667eea/white?text=📚'" 
                 loading="lazy"
                 decoding="async"
                 width="120"
                 height="180"
                 onload="trackBandwidthUsage('images', 12000)">
          </div>
          <div class="info">
            <h2>${livre.Titre}</h2>
            <div class="info-item">
              <span class="info-label">Auteur:</span>
              <span class="info-value">${livre.Auteur}</span>
            </div>
            <div class="info-item">
              <span class="info-label">Stock:</span>
              <span class="stock-badge ${getStockClass(livre.Stock)}">${getStockText(livre.Stock)}</span>
            </div>
          </div>
        </div>
      `;
      fragment.appendChild(div);
    });
    
    elements.livres.innerHTML = "";
    elements.livres.appendChild(fragment);
    
    renderPagination(totalPages, page);
  }
  
  // Helpers pour le stock
  function getStockClass(stock) {
    if (stock === undefined || stock === '' || stock === null) return 'undefined';
    return stock == 0 ? 'out-of-stock' : '';
  }
  
  function getStockText(stock) {
    if (stock === undefined || stock === '' || stock === null) return 'Non défini';
    return `${stock} ${stock != 1 ? 'exemplaires' : 'exemplaire'}`;
  }
  
  // Pagination optimisée
  function renderPagination(totalPages, currentPage) {
    if (totalPages <= 1) {
      elements.pagination.innerHTML = '';
      return;
    }
    
    let paginationHTML = '';
    
    // Bouton Précédent
    paginationHTML += `
      <button onclick="changePage(${currentPage - 1})" ${currentPage <= 1 ? 'disabled' : ''}>
        ← Précédent
      </button>
    `;
    
    // Logique optimisée des pages
    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, currentPage + 2);
    
    if (startPage > 1) {
      paginationHTML += `<button onclick="changePage(1)" ${currentPage === 1 ? 'class="active"' : ''}>1</button>`;
      if (startPage > 2) {
        paginationHTML += '<span class="page-info">...</span>';
      }
    }
    
    for (let i = startPage; i <= endPage; i++) {
      paginationHTML += `
        <button onclick="changePage(${i})" ${i === currentPage ? 'class="active"' : ''}>
          ${i}
        </button>
      `;
    }
    
    if (endPage < totalPages) {
      if (endPage < totalPages - 1) {
        paginationHTML += '<span class="page-info">...</span>';
      }
      paginationHTML += `<button onclick="changePage(${totalPages})" ${currentPage === totalPages ? 'class="active"' : ''}>${totalPages}</button>`;
    }
    
    // Bouton Suivant
    paginationHTML += `
      <button onclick="changePage(${currentPage + 1})" ${currentPage >= totalPages ? 'disabled' : ''}>
        Suivant →
      </button>
    `;
    
    elements.pagination.innerHTML = paginationHTML;
  }
  
  // Navigation optimisée
  function changePage(page) {
    if (page < 1 || page > Math.ceil(filteredBooks.length / booksPerPage)) return;
    
    currentPage = page;
    renderBooks(filteredBooks, currentPage);
    
    // Scroll fluide optimisé
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  
  // Reset optimisé
  function resetSearch() {
    elements.search.value = '';
    elements.aiSearch.value = '';
    
    filteredBooks = [...allBooks];
    currentPage = 1;
    
    renderBooks(filteredBooks, currentPage);
    console.log(`🔄 Reset: ${allBooks.length} livres`);
  }
  
  // Recherche optimisée avec cache
  function performSearch(query = '') {
    if (!query.trim()) {
      filteredBooks = [...allBooks];
    } else {
      const searchTerms = query.toLowerCase().split(' ').filter(term => term.length > 0);
      
      filteredBooks = allBooks.filter(livre => {
        const searchableText = [
          livre.Titre?.toLowerCase() || '',
          livre.Auteur?.toLowerCase() || ''
        ].join(' ');
        
        return searchTerms.every(term => searchableText.includes(term));
      });
    }
    
    currentPage = 1;
    renderBooks(filteredBooks, currentPage);
  }
  
  // Chargement optimisé
  async function loadInitialBooks() {
    elements.livres.innerHTML = '<div class="loading"><div class="spinner"></div>Chargement...</div>';
    elements.resultsInfo.innerHTML = '';
    
    try {
      const cachedBooks = getCachedBooks();
      if (cachedBooks) {
        allBooks = cachedBooks;
        filteredBooks = [...allBooks];
        renderBooks(filteredBooks, 1);
        checkForUpdatesInBackground();
      } else {
        await loadBooksFromAPI();
      }
    } catch (error) {
      console.error("Erreur chargement:", error);
      elements.livres.innerHTML = '<div class="no-results">Erreur de chargement 😞</div>';
    }
  }
  
  // Chargement API optimisé
  async function loadBooksFromAPI() {
    console.log('📡 Chargement API...');
    const response = await fetch("https://opensheet.elk.sh/1LBcmGmEKOn8LscQunZrINNY8RWlKHkxT2qb6liInYuQ/1");
    
    if (!response.ok) {
      throw new Error(`Erreur HTTP: ${response.status}`);
    }
    
    const data = await response.json();
    const estimatedSize = JSON.stringify(data).length;
    console.log(`📊 Reçu: ${data.length} livres (${Math.round(estimatedSize / 1024)}KB)`);
    
    trackBandwidthUsage('data', estimatedSize);
    
    // Traitement par batch pour gros volumes
    if (data.length > 1000) {
      allBooks = [];
      const batchSize = 200;
      
      for (let i = 0; i < data.length; i += batchSize) {
        const batch = data.slice(i, i + batchSize);
        allBooks = allBooks.concat(batch);
        
        if (i + batchSize < data.length) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      }
    } else {
      allBooks = data;
    }
    
    setCachedBooks(allBooks);
    filteredBooks = [...allBooks];
    renderBooks(filteredBooks, 1);
  }
  
  // Vérification des mises à jour optimisée
  async function checkForUpdatesInBackground() {
    try {
      await new Promise(resolve => setTimeout(resolve, 8000));
      
      const response = await fetch("https://opensheet.elk.sh/1LBcmGmEKOn8LscQunZrINNY8RWlKHkxT2qb6liInYuQ/1");
      
      if (response.ok) {
        const newData = await response.json();
        
        if (hasDataChanged(allBooks, newData)) {
          showUpdateNotification();
        }
      }
    } catch (error) {
      console.log('🔍 Vérification MàJ échouée:', error.message);
    }
  }
  
  // Détection des changements optimisée
  function hasDataChanged(oldData, newData) {
    if (oldData.length !== newData.length) return true;
    
    const oldSignature = createDataSignature(oldData);
    const newSignature = createDataSignature(newData);
    
    return oldSignature !== newSignature;
  }
  
  function createDataSignature(data) {
    const sampleSize = Math.min(20, data.length);
    const step = Math.max(1, Math.floor(data.length / sampleSize));
    
    let signature = '';
    for (let i = 0; i < data.length; i += step) {
      const book = data[i];
      if (book) {
        signature += `${book.ISBN}-${book.Stock}-${book.Titre?.length || 0}|`;
      }
    }
    
    return signature;
  }
  
  // Notification de mise à jour
  function showUpdateNotification() {
    const existingNotification = document.querySelector('.update-notification');
    if (existingNotification) {
      existingNotification.remove();
    }
    
    const notification = document.createElement('div');
    notification.className = 'update-notification';
    notification.innerHTML = `
      <div style="
        position: fixed; 
        top: 20px; 
        right: 20px; 
        background: linear-gradient(135deg, #667eea, #764ba2); 
        color: white; 
        padding: 1rem 1.5rem; 
        border-radius: 12px; 
        box-shadow: 0 4px 20px rgba(0,0,0,0.2);
        z-index: 1000;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.3s ease;
        max-width: 300px;
        font-size: 0.9rem;
        opacity: 0.9;
      " onclick="forceDataRefresh()">
        📚 Mise à jour disponible<br>
        <small>Cliquez pour actualiser</small>
      </div>
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 15000);
  }
  
  // Rafraîchissement forcé
  async function forceDataRefresh() {
    try {
      localStorage.removeItem(CACHE_KEY);
      elements.livres.innerHTML = '<div class="loading"><div class="spinner"></div>Mise à jour...</div>';
      
      const notification = document.querySelector('.update-notification');
      if (notification) notification.remove();
      
      await loadBooksFromAPI();
    } catch (error) {
      console.error('❌ Erreur MàJ:', error);
      alert('Erreur lors de la mise à jour.');
    }
  }
  
  // Recherche IA optimisée
  async function performAISearch(query) {
    if (!query.trim()) {
      alert('Veuillez entrer une description.');
      return;
    }
    
    const aiSearchInput = elements.aiSearch;
    const originalPlaceholder = aiSearchInput.placeholder;
    
    try {
      aiSearchInput.disabled = true;
      aiSearchInput.placeholder = 'Recherche IA...';
      
      // Pré-filtrage optimisé pour gros volumes
      let booksToSend;
      
      if (allBooks.length > 1000) {
        const quickSearchTerms = query.toLowerCase().split(' ')
          .filter(term => term.length > 2)
          .slice(0, 5);
        
        let preFilteredBooks = allBooks;
        
        if (quickSearchTerms.length > 0) {
          preFilteredBooks = allBooks.filter(livre => {
            const searchableText = [
              livre.Titre?.toLowerCase() || '',
              livre.Auteur?.toLowerCase() || ''
            ].join(' ');
            
            return quickSearchTerms.some(term => searchableText.includes(term));
          });
        }
        
        if (preFilteredBooks.length > 800) {
          preFilteredBooks = preFilteredBooks.slice(0, 800);
        }
        
        booksToSend = preFilteredBooks.map(book => ({
          titre: book.Titre,
          auteur: book.Auteur,
          isbn: book.ISBN
        }));
      } else {
        booksToSend = allBooks.map(book => ({
          titre: book.Titre,
          auteur: book.Auteur,
          isbn: book.ISBN
        }));
      }
      
      // Appel API optimisé
      const apiUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
        ? '/api/ai-search'
        : '/.netlify/functions/ai-search';
      
      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query,
          booksData: booksToSend
        })
      });
      
      if (!response.ok) {
        throw new Error(`Erreur API: ${response.status}`);
      }
      
      const data = await response.json();
      
      if (!data.success) {
        throw new Error(data.error || 'Erreur recherche IA');
      }
      
      const matchingISBNs = data.matchingISBNs || [];
      
      if (Array.isArray(matchingISBNs) && matchingISBNs.length > 0) {
        filteredBooks = allBooks.filter(book => 
          matchingISBNs.includes(book.ISBN)
        );
        
        // Tri par pertinence IA
        filteredBooks.sort((a, b) => {
          const indexA = matchingISBNs.indexOf(a.ISBN);
          const indexB = matchingISBNs.indexOf(b.ISBN);
          return indexA - indexB;
        });
      } else {
        filteredBooks = [];
      }
      
      currentPage = 1;
      renderBooks(filteredBooks, currentPage);
      
      if (filteredBooks.length > 0) {
        elements.search.value = '';
        console.log(`🤖 IA: ${filteredBooks.length} résultat(s)`);
      } else {
        alert(`Aucun livre trouvé pour: "${query}"`);
      }
      
    } catch (error) {
      console.error('Erreur IA:', error);
      alert('Erreur recherche IA. Réessayez.');
    } finally {
      aiSearchInput.disabled = false;
      aiSearchInput.placeholder = originalPlaceholder;
    }
  }
  
  // Event listeners optimisés
  function setupEventListeners() {
    // Recherche avec debounce optimisé
    elements.search.addEventListener("input", function() {
      const query = this.value;
      
      clearTimeout(searchTimeout);
      
      const debounceDelay = allBooks.length > 1000 ? 400 : 300;
      
      searchTimeout = setTimeout(() => {
        const cacheKey = query.toLowerCase().trim();
        if (searchCache.has(cacheKey)) {
          filteredBooks = searchCache.get(cacheKey);
          currentPage = 1;
          renderBooks(filteredBooks, currentPage);
          return;
        }
        
        performSearch(query);
        
        if (query.length > 2) {
          searchCache.set(cacheKey, [...filteredBooks]);
          
          if (searchCache.size > 50) {
            const firstKey = searchCache.keys().next().value;
            searchCache.delete(firstKey);
          }
        }
      }, debounceDelay);
    });
    
    // Recherche IA
    elements.aiSearch.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        performAISearch(this.value);
      }
    });
    
    // Reset
    elements.resetBtn.addEventListener('click', resetSearch);
  }
  
  // Initialisation principale
  function init() {
    initDOMElements();
    setupEventListeners();
    loadInitialBooks();
    
    // Exposer les fonctions globalement pour la pagination
    window.changePage = changePage;
    window.forceDataRefresh = forceDataRefresh;
    window.trackBandwidthUsage = trackBandwidthUsage;
  }
  
  // Démarrage quand le DOM est prêt
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  
})();