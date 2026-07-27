const fs = require('fs');
const path = require('path');
const https = require('https');

// 1. Charger les variables d'environnement depuis le fichier .env (si présent)
try {
  const envPath = path.join(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const index = trimmed.indexOf('=');
        if (index !== -1) {
          const key = trimmed.substring(0, index).trim();
          const value = trimmed.substring(index + 1).trim();
          process.env[key] = value;
        }
      }
    });
    console.log("📝 Fichier .env chargé avec succès.");
  }
} catch (e) {
  console.log("⚠️ Impossible de lire le fichier .env :", e.message);
}

const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY || '';
if (!GOOGLE_BOOKS_API_KEY) {
  console.warn("⚠️ Attention : Aucune clé API Google Books configurée dans GOOGLE_BOOKS_API_KEY.");
  console.warn("Le script tournera sans clé publique et risque de subir des erreurs 429 rapidement.");
} else {
  console.log("✅ Clé API Google Books détectée.");
}

// Configuration
const SHEET_URL = 'https://opensheet.elk.sh/1I8a83wLjYIDC-hWWH7yFj6i7R-GAwVy2SzORD_JNhgY/1';
const METADATA_FILE = path.join(__dirname, '../books-metadata.json');
const OVERRIDES_FILE = path.join(__dirname, '../metadata-overrides.json');
const MAX_API_CALLS = 600; // Limite par run pour ne pas dépasser le quota quotidien de 1000 de Google
const REQUEST_DELAY = 100; // Délai en ms entre les requêtes pour respecter les serveurs

// Genres autorisés dans le KotArdoise
const VALID_GENRES = [
  'Horreur', 'Romance', 'Science-fiction', 'Fantasy', 
  'Thriller', 'Aventure', 'Policier', 'Historique', 
  'Drame', 'Comédie'
];

// Helper: Normaliser les chaînes de caractères pour générer le slug
function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD') // Décomposer les accents (ex: é -> e + `)
    .replace(/[\u0300-\u036f]/g, '') // Supprimer les marques d'accents
    .replace(/[^a-z0-9\s-_]/g, '') // Supprimer les caractères spéciaux
    .trim()
    .replace(/\s+/g, '-') // Remplacer les espaces par des tirets
    .replace(/-+/g, '-'); // Supprimer les tirets consécutifs
}

// Helper: Faire une requête HTTP GET
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'KotArdoiseLibraryBot/2.0 (contact: info@kotardoise.be)',
        ...headers
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

// Mappage des catégories de livres vers les genres du Kot
function mapCategoryToGenre(categories) {
  if (!categories || categories.length === 0) return 'Inconnu';
  
  const text = categories.join(' ').toLowerCase();
  
  if (text.includes('horror') || text.includes('horreur') || text.includes('vampire') || text.includes('ghost')) {
    return 'Horreur';
  }
  if (text.includes('romance') || text.includes('amour') || text.includes('romantic') || text.includes('chick lit')) {
    return 'Romance';
  }
  if (text.includes('science fiction') || text.includes('sci-fi') || text.includes('dystop') || text.includes('anticipation') || text.includes('post-apocalyptic')) {
    return 'Science-fiction';
  }
  if (text.includes('fantasy') || text.includes('fantastique') || text.includes('magic') || text.includes('sorcellerie') || text.includes('fairy tales')) {
    return 'Fantasy';
  }
  if (text.includes('thriller') || text.includes('suspense') || text.includes('angoisse') || text.includes('psychological')) {
    return 'Thriller';
  }
  if (text.includes('adventure') || text.includes('aventure') || text.includes('action')) {
    return 'Aventure';
  }
  if (text.includes('policier') || text.includes('detective') || text.includes('mystery') || text.includes('crime') || text.includes('meurtre') || text.includes('sherlock')) {
    return 'Policier';
  }
  if (text.includes('history') || text.includes('historique') || text.includes('biography') || text.includes('biographie') || text.includes('memoir')) {
    return 'Historique';
  }
  if (text.includes('drama') || text.includes('drame') || text.includes('tragedy') || text.includes('melodrama')) {
    return 'Drame';
  }
  if (text.includes('comedy') || text.includes('humor') || text.includes('comédie') || text.includes('funny') || text.includes('satire')) {
    return 'Comédie';
  }
  
  return 'Inconnu';
}

// Classification hybride par analyse textuelle des descriptions pour affiner le genre
function classifyBookText(title, description, categoryText = '') {
  const text = `${title} ${description} ${categoryText}`.toLowerCase();
  
  // 1. Horreur
  if (text.match(/\b(horreur|horror|epouvante|vampire|fantome|ghost|frisson|demoni|possession|gore|epouvantable)\b/)) {
    return 'Horreur';
  }
  // 2. Science-fiction
  if (text.match(/\b(science-fiction|sci-fi|dystopi|post-apocalypt|futuriste|cyberpunk|space opera|extra-terrestre|extraterrestre|robot|anticipation|vaisseau spatial|barjavel|teleportation|dystopique)\b/)) {
    return 'Science-fiction';
  }
  // 3. Fantasy
  if (text.match(/\b(fantasy|fantastique|magie|magic|sorcier|sorciere|elfe|nain|dragon|royaume|merlin|enchant|grimoire|feerie|fees|legendaire)\b/)) {
    return 'Fantasy';
  }
  // 4. Policier
  if (text.match(/\b(policier|detective|mystery|mystere|enquête|enquete|commissaire|inspecteur|assassin|meurtre|homicide|crime|sherlock|poirot|vol|cambriolage)\b/)) {
    return 'Policier';
  }
  // 5. Thriller
  if (text.match(/\b(thriller|suspense|angoisse|tueur en serie|psychopathe|machination|complot|otages|kidnapping|kidnappe|espion|espionnage|agent secret)\b/)) {
    return 'Thriller';
  }
  // 6. Romance
  if (text.match(/\b(romance|amour|romantic|passion|sentiment|amoureuse|amoureux|coup de foudre|je t'aime|seduc|divorce|mariage|epouser)\b/)) {
    return 'Romance';
  }
  // 7. Historique
  if (text.match(/\b(historique|biographie|biography|memoire|autobiographie|siecle|moyen age|moyen-age|renaissance|antiquite|château|napoleon|louis xiv|seconde guerre|premiere guerre|guerre mondiale|1914|1939|1945|baron|prince|princesse|roi|reine|empire|monarchie|archeologie)\b/)) {
    return 'Historique';
  }
  // 8. Drame
  if (text.match(/\b(drame|tragique|tragedie|deuil|orphelin|cancer|maladie|coma|mortel|accident|suicide|guerre|exil|prison|larme|pleur|tristesse|separation)\b/)) {
    return 'Drame';
  }
  // 9. Comédie
  if (text.match(/\b(comedie|comédie|humour|drole|drôle|rigolo|amusant|rires|rire|satirique|satire|parodie|burlesque|cocasse|hilarant)\b/)) {
    return 'Comédie';
  }
  // 10. Aventure
  if (text.match(/\b(aventure|adventure|action|voyage|exploration|survie|naufrage|tresor|ile deserte|jungle|expedition|odyssee|quetes|quete)\b/)) {
    return 'Aventure';
  }
  
  return 'Inconnu';
}


// Helper: Détecter les textes en anglais
function isEnglishText(text) {
  if (!text || typeof text !== 'string') return false;
  const matches = text.match(/\b(the|and|was|with|this|from|that|for|his|her|their|about|been|which|who|have|has|had|jacket|publisher|novel|story|written)\b/gi);
  return matches && matches.length >= 3;
}

// Fonction pour interroger Google Books API
async function fetchGoogleBooks(title, author, isbn = '', googleBooksId = '') {
  let url = '';
  
  if (googleBooksId) {
    url = `https://www.googleapis.com/books/v1/volumes/${googleBooksId}?hl=fr`;
  } else if (isbn) {
    url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}&langRestrict=fr&hl=fr`;
  } else {
    // Nettoyer un peu les termes de recherche pour éviter les échecs liés aux caractères spéciaux
    const cleanTitle = title.replace(/['’"()]/g, ' ').replace(/[-\s]+/g, ' ').trim();
    const cleanAuthor = author.replace(/['’"()]/g, ' ').replace(/[-\s]+/g, ' ').trim();
    const query = encodeURIComponent(`${cleanTitle} ${cleanAuthor}`);
    url = `https://www.googleapis.com/books/v1/volumes?q=${query}&langRestrict=fr&hl=fr&maxResults=1`;
  }
  
  if (GOOGLE_BOOKS_API_KEY) {
    url += `&key=${GOOGLE_BOOKS_API_KEY}`;
  }
  
  try {
    let res = await httpGet(url);
    if (res.statusCode === 429) {
      throw new Error("RATE_LIMIT_EXCEEDED");
    }
    if (res.statusCode === 200) {
      const data = JSON.parse(res.body);
      if (googleBooksId && data.id) return data;
      if (data.items && data.items.length > 0) return data.items[0];
    }
    
    // Si la recherche restreinte en français n'a rien renvoyé, tenter avec hl=fr seul sans langRestrict
    if (!googleBooksId && !isbn) {
      const cleanTitle = title.replace(/['’"()]/g, ' ').replace(/[-\s]+/g, ' ').trim();
      const cleanAuthor = author.replace(/['’"()]/g, ' ').replace(/[-\s]+/g, ' ').trim();
      const query = encodeURIComponent(`${cleanTitle} ${cleanAuthor}`);
      let fallbackUrl = `https://www.googleapis.com/books/v1/volumes?q=${query}&hl=fr&maxResults=1`;
      if (GOOGLE_BOOKS_API_KEY) fallbackUrl += `&key=${GOOGLE_BOOKS_API_KEY}`;
      
      const fallbackRes = await httpGet(fallbackUrl);
      if (fallbackRes.statusCode === 200) {
        const fallbackData = JSON.parse(fallbackRes.body);
        if (fallbackData.items && fallbackData.items.length > 0) return fallbackData.items[0];
      }
    }
    
    return null;
  } catch (err) {
    if (err.message === "RATE_LIMIT_EXCEEDED") {
      throw err;
    }
    console.error(`❌ Erreur Google Books pour "${title}":`, err.message);
    return null;
  }
}

// Fonction pour interroger Open Library API
async function fetchOpenLibrary(title, author, isbn = '') {
  let searchUrl = '';
  if (isbn) {
    searchUrl = `https://openlibrary.org/search.json?q=isbn:${isbn}&limit=1`;
  } else {
    const cleanTitle = title.replace(/['’"()]/g, ' ').trim();
    const cleanAuthor = author.replace(/['’"()]/g, ' ').trim();
    const query = encodeURIComponent(`title:${cleanTitle} author:${cleanAuthor} language:fre`);
    searchUrl = `https://openlibrary.org/search.json?q=${query}&limit=1`;
  }
  
  try {
    let searchRes = await httpGet(searchUrl);
    if (searchRes.statusCode !== 200) return null;
    
    let searchData = JSON.parse(searchRes.body);
    // Si la recherche avec language:fre ne retourne rien, essayer sans le filtre
    if ((!searchData.docs || searchData.docs.length === 0) && !isbn) {
      const cleanTitle = title.replace(/['’"()]/g, ' ').trim();
      const cleanAuthor = author.replace(/['’"()]/g, ' ').trim();
      const query = encodeURIComponent(`title:${cleanTitle} author:${cleanAuthor}`);
      searchUrl = `https://openlibrary.org/search.json?q=${query}&limit=1`;
      searchRes = await httpGet(searchUrl);
      if (searchRes.statusCode === 200) {
        searchData = JSON.parse(searchRes.body);
      }
    }

    if (!searchData.docs || searchData.docs.length === 0) return null;
    
    const doc = searchData.docs[0];
    
    let description = '';
    if (doc.key) {
      const workUrl = `https://openlibrary.org${doc.key}.json`;
      const workRes = await httpGet(workUrl);
      if (workRes.statusCode === 200) {
        const workData = JSON.parse(workRes.body);
        if (workData.description) {
          description = typeof workData.description === 'string' 
            ? workData.description 
            : (workData.description.value || '');
        }
      }
    }
    
    return {
      title: doc.title,
      description: description,
      subjects: doc.subject || [],
      coverId: doc.cover_i,
      isbn: doc.isbn ? doc.isbn[0] : null
    };
  } catch (err) {
    console.error(`❌ Erreur Open Library pour "${title}":`, err.message);
    return null;
  }
}

// Fonction principale d'enrichissement
async function enrich() {
  console.log("🚀 Démarrage du script d'enrichissement...");
  
  // 1. Lire ou initialiser le fichier de métadonnées
  let metadata = {};
  if (fs.existsSync(METADATA_FILE)) {
    try {
      metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8'));
      console.log(`📦 Cache existant chargé : ${Object.keys(metadata).length} livres.`);
    } catch (e) {
      console.warn("⚠️ Impossible de lire books-metadata.json. Création d'un nouveau cache.");
    }
  } else {
    console.log("🆕 books-metadata.json inexistant. Création d'un nouveau cache.");
  }
  
  // 1.5. Mettre à jour les genres des livres déjà en cache à l'aide de l'analyse textuelle locale
  let localUpdates = 0;
  Object.keys(metadata).forEach(slug => {
    const book = metadata[slug];
    if (book && book.description && (!book.genre || book.genre === 'Inconnu')) {
      const resolvedGenre = classifyBookText(book.title || '', book.description, book.genre || '');
      if (resolvedGenre !== 'Inconnu') {
        book.genre = resolvedGenre;
        localUpdates++;
      }
    }
  });
  if (localUpdates > 0) {
    console.log(`✨ Analyse textuelle locale : ${localUpdates} genres de livres en cache mis à jour avec succès sans faire d'appels API !`);
    try {
      fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
    } catch (e) {
      console.error("⚠️ Impossible d'enregistrer les genres mis à jour localement :", e.message);
    }
  }
  
  // 2. Lire le fichier d'override si disponible
  let overrides = {};
  if (fs.existsSync(OVERRIDES_FILE)) {
    try {
      overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8'));
      console.log(`🛡️ Fichier d'overrides détecté : ${Object.keys(overrides).length} overrides définis.`);
    } catch (e) {
      console.error("❌ Erreur de lecture de metadata-overrides.json :", e.message);
    }
  } else {
    // Initialiser un fichier d'override vide pour simplifier la vie de l'utilisateur
    fs.writeFileSync(OVERRIDES_FILE, JSON.stringify({}, null, 2));
    console.log("🛡️ Initialisation d'un fichier d'overrides vide : metadata-overrides.json");
  }

  // 3. Télécharger les livres depuis le Google Sheet
  console.log(`📡 Téléchargement des livres depuis : ${SHEET_URL}`);
  let books = [];
  try {
    const res = await httpGet(SHEET_URL);
    if (res.statusCode !== 200) {
      throw new Error(`HTTP ${res.statusCode}`);
    }
    books = JSON.parse(res.body);
    console.log(`📚 ${books.length} livres récupérés depuis le Google Sheet.`);
  } catch (e) {
    console.error("❌ Impossible de récupérer les données du Google Sheet :", e.message);
    process.exit(1);
  }

  // Statistiques
  let apiCallsCount = 0;
  let successCount = 0;
  let failureCount = 0;
  let skipCount = 0;
  let overrideCount = 0;
  let quotaReached = false;

  // 4. Parcourir et enrichir
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    const titre = book.Titre ? book.Titre.trim() : '';
    const prenom = book.Prénom || book['Prnom'] || '';
    const famille = book.Famille || '';
    const auteur = ((prenom + ' ' + famille).trim() || book.Auteur || '').trim();
    
    if (!titre) continue;
    
    // Générer le slug unique
    const slug = slugify(`${titre} ${auteur}`);
    
    // A-t-on un override pour ce slug ?
    const hasOverride = overrides[slug];
    
    // Est-il déjà enrichi en français ?
    const alreadyEnrichedInFrench = metadata[slug] && 
                                    !isEnglishText(metadata[slug].description) &&
                                    (
                                      (metadata[slug].description && metadata[slug].description.trim() !== '') ||
                                      (metadata[slug].source && ['google_books', 'open_library', 'override'].includes(metadata[slug].source))
                                    );


    // Si on a un override, on met à jour les données du cache statique sans appeler l'API
    if (hasOverride) {
      // Mettre à jour avec l'override
      metadata[slug] = {
        title: titre,
        author: auteur,
        description: overrides[slug].description || metadata[slug]?.description || '',
        genre: overrides[slug].genre || metadata[slug]?.genre || 'Inconnu',
        coverUrl: overrides[slug].coverUrl || metadata[slug]?.coverUrl || '',
        isbn: overrides[slug].isbn || metadata[slug]?.isbn || book.ISBN || '',
        enrichedAt: new Date().toISOString(),
        source: 'override'
      };
      overrideCount++;
      continue;
    }
    
    // Si déjà enrichi et correct en français, on passe
    if (alreadyEnrichedInFrench) {
      skipCount++;
      continue;
    }
    
    // A-t-on atteint la limite d'appels API par exécution ?
    if (apiCallsCount >= MAX_API_CALLS) {
      console.log(`\n🛑 Limite de requêtes API atteinte pour ce run (${MAX_API_CALLS}). Enregistrement et arrêt...`);
      break;
    }
    
    // Attendre un court instant entre les requêtes
    if (apiCallsCount > 0) {
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
    }
    
    console.log(`\n🔍 [${i+1}/${books.length}] Enrichissement de: "${titre}" par "${auteur}"`);
    
    // Extraction des clés d'identifiants prioritaires depuis la ligne Google Sheet
    const isbn = (book.ISBN || '').toString().trim();
    const googleBooksId = (book.ID_GoogleBooks || '').toString().trim();
    
    let enrichedData = null;
    apiCallsCount++;
    
    try {
      // 1ère tentative : Google Books API
      const gbResult = await fetchGoogleBooks(titre, auteur, isbn, googleBooksId);
      
      if (gbResult) {
        const info = gbResult.volumeInfo || gbResult; // ID direct vs recherche standard
        
        // Extraire la description
        let desc = info.description || '';
        
        // Mappage des genres (hybride : catégories + description/titre)
        let genre = 'Inconnu';
        if (info.categories && info.categories.length > 0) {
          genre = mapCategoryToGenre(info.categories);
        }
        if (genre === 'Inconnu') {
          genre = classifyBookText(titre, desc);
        }
        
        // Extraire la couverture
        let cover = '';
        if (info.imageLinks) {
          cover = info.imageLinks.medium || info.imageLinks.thumbnail || '';
          if (cover.startsWith('http://')) {
            cover = cover.replace('http://', 'https://');
          }
        }
        
        // Extraire l'ISBN
        let resolvedIsbn = isbn;
        if (!resolvedIsbn && info.industryIdentifiers) {
          const isbn13 = info.industryIdentifiers.find(id => id.type === 'ISBN_13');
          const isbn10 = info.industryIdentifiers.find(id => id.type === 'ISBN_10');
          resolvedIsbn = isbn13 ? isbn13.identifier : (isbn10 ? isbn10.identifier : '');
        }
        
        enrichedData = {
          title: titre,
          author: auteur,
          description: desc,
          genre: genre,
          coverUrl: cover,
          isbn: resolvedIsbn,
          enrichedAt: new Date().toISOString(),
          source: 'google_books'
        };
      }
    } catch (err) {
      if (err.message === "RATE_LIMIT_EXCEEDED") {
        console.error("⚠️ Quota journalier Google Books dépassé (Erreur 429).");
        quotaReached = true;
        apiCallsCount--;
        break;
      }
    }
    
    // 2ème tentative en fallback : Open Library
    if (!enrichedData && !quotaReached) {
      console.log(`   -> Fallback Open Library...`);
      const olResult = await fetchOpenLibrary(titre, auteur, isbn);
      if (olResult) {
        let genre = mapCategoryToGenre(olResult.subjects);
        if (genre === 'Inconnu') {
          genre = classifyBookText(titre, olResult.description || '');
        }
        let cover = '';
        if (olResult.coverId) {
          cover = `https://covers.openlibrary.org/b/id/${olResult.coverId}-L.jpg`;
        }
        
        enrichedData = {
          title: titre,
          author: auteur,
          description: olResult.description || '',
          genre: genre,
          coverUrl: cover,
          isbn: olResult.isbn || isbn || '',
          enrichedAt: new Date().toISOString(),
          source: 'open_library'
        };
      }
    }
    
    if (enrichedData) {
      metadata[slug] = enrichedData;
      successCount++;
      console.log(`   ✅ Trouvé! Genre: ${enrichedData.genre} | Source: ${enrichedData.source}`);
    } else {
      metadata[slug] = {
        title: titre,
        author: auteur,
        description: '',
        genre: 'Inconnu',
        coverUrl: '',
        isbn: isbn || '',
        enrichedAt: new Date().toISOString(),
        source: 'not_found'
      };
      failureCount++;
      console.log(`   ❌ Aucun résultat trouvé.`);
    }

    // Sauvegarder périodiquement pour ne pas perdre la progression
    const totalProcessed = successCount + failureCount;
    if (totalProcessed > 0 && totalProcessed % 15 === 0) {
      try {
        fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
        console.log(`   💾 Progression sauvegardée périodiquement (${totalProcessed} nouveaux livres enregistrés).`);
      } catch (e) {
        console.error("   ⚠️ Erreur de sauvegarde intermédiaire :", e.message);
      }
    }
  }

  // 5. Sauvegarder les métadonnées dans books-metadata.json
  console.log("\n💾 Sauvegarde du cache dans books-metadata.json...");
  try {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
    console.log("✅ Métadonnées sauvegardées avec succès.");
  } catch (e) {
    console.error("❌ Impossible de sauvegarder les métadonnées :", e.message);
  }

  console.log("\n================ Résumé ==================");
  console.log(`Livres déjà en cache (ignorés) : ${skipCount}`);
  console.log(`Livres mis à jour via overrides: ${overrideCount}`);
  console.log(`Appels API effectués           : ${apiCallsCount}`);
  console.log(`Recherches API réussies        : ${successCount}`);
  console.log(`Recherches sans résultat       : ${failureCount}`);
  console.log(`Total livres dans le cache     : ${Object.keys(metadata).length}`);
  if (quotaReached) {
    console.log("⚠️ Quota de l'API Google Books dépassé.");
  }
  console.log("==========================================");
}

enrich();
