const fs = require('fs');
const path = require('path');
const https = require('https');
const readline = require('readline');

// 1. Charger les variables d'environnement (.env)
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
  }
} catch (e) {}

const GOOGLE_BOOKS_API_KEY = process.env.GOOGLE_BOOKS_API_KEY || '';
const SHEET_URL = 'https://opensheet.elk.sh/1I8a83wLjYIDC-hWWH7yFj6i7R-GAwVy2SzORD_JNhgY/1';
const METADATA_FILE = path.join(__dirname, '../books-metadata.json');
const OVERRIDES_FILE = path.join(__dirname, '../metadata-overrides.json');

// Helper Slugify
function slugify(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-_]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// Helper HTTP GET
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
        try {
          resolve({ statusCode: res.statusCode, body: data });
        } catch (e) {
          resolve({ statusCode: 500, body: '' });
        }
      });
    }).on('error', () => {
      resolve({ statusCode: 500, body: '' });
    });
  });
}

// Helper: Mappage du genre
function mapCategoryToGenre(categories) {
  if (!categories || categories.length === 0) return 'Inconnu';
  const text = categories.join(' ').toLowerCase();
  if (text.includes('horror') || text.includes('horreur')) return 'Horreur';
  if (text.includes('romance') || text.includes('amour')) return 'Romance';
  if (text.includes('science fiction') || text.includes('sci-fi') || text.includes('dystop')) return 'Science-fiction';
  if (text.includes('fantasy') || text.includes('fantastique')) return 'Fantasy';
  if (text.includes('thriller') || text.includes('suspense')) return 'Thriller';
  if (text.includes('adventure') || text.includes('aventure')) return 'Aventure';
  if (text.includes('policier') || text.includes('detective') || text.includes('mystery')) return 'Policier';
  if (text.includes('history') || text.includes('historique') || text.includes('biography')) return 'Historique';
  if (text.includes('drama') || text.includes('drame')) return 'Drame';
  if (text.includes('comedy') || text.includes('humour') || text.includes('comédie')) return 'Comédie';
  return 'Inconnu';
}

function classifyBookText(title, description, categoryText = '') {
  const text = `${title} ${description} ${categoryText}`.toLowerCase();
  if (text.match(/\b(horreur|horror|epouvante|vampire|fantome|demoni|possession)\b/)) return 'Horreur';
  if (text.match(/\b(science-fiction|sci-fi|dystopi|futuriste|cyberpunk|space opera|robot|anticipation)\b/)) return 'Science-fiction';
  if (text.match(/\b(fantasy|fantastique|magie|magic|sorcier|dragon|royaume|enchant)\b/)) return 'Fantasy';
  if (text.match(/\b(policier|detective|mystery|mystere|enquête|enquete|commissaire|inspecteur|meurtre|crime)\b/)) return 'Policier';
  if (text.match(/\b(thriller|suspense|angoisse|tueur en serie|psychopathe|machination|complot)\b/)) return 'Thriller';
  if (text.match(/\b(romance|amour|romantic|passion|sentiment|amoureuse|coup de foudre)\b/)) return 'Romance';
  if (text.match(/\b(historique|biographie|biography|memoire|siecle|moyen age|renaissance|antiquite|guerre)\b/)) return 'Historique';
  if (text.match(/\b(drame|tragique|tragedie|deuil|orphelin|maladie|accident|suicide)\b/)) return 'Drame';
  if (text.match(/\b(comedie|comédie|humour|drole|drôle|rigolo|amusant|rires)\b/)) return 'Comédie';
  if (text.match(/\b(aventure|adventure|action|voyage|exploration|survie|tresor)\b/)) return 'Aventure';
  return 'Inconnu';
}

// Menu de sélection interactif au clavier (Flèches ↑/↓ et Entrée)
function selectMenu(headerText, options) {
  return new Promise((resolve) => {
    let selectedIndex = 0;

    const render = () => {
      console.clear();
      console.log(`==================================================`);
      console.log(`📚 KOTARDOISE - ENRICHISSEMENT INTERACTIF`);
      console.log(`==================================================`);
      if (headerText) console.log(`\n${headerText}\n`);
      console.log(`💡 Utilisez ↑ / ↓ pour naviguer, [Entrée] pour valider, [Ctrl+C] pour quitter.\n`);

      options.forEach((opt, idx) => {
        if (idx === selectedIndex) {
          console.log(`\x1b[36m\x1b[1m👉 ${idx + 1}. ${opt}\x1b[0m`);
        } else {
          console.log(`   ${idx + 1}. ${opt}`);
        }
      });
      console.log(``);
    };

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    const onKeypress = (str, key) => {
      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        render();
      } else if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % options.length;
        render();
      } else if (key.name === 'return') {
        cleanup();
        resolve(selectedIndex);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        console.log('\n👋 Annulation.');
        process.exit(0);
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    };

    render();
    process.stdin.on('keypress', onKeypress);
  });
}

// Prompt texte simple pour saisir une recherche
function askInput(questionText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise((resolve) => {
    rl.question(questionText, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Recherche multi-sources ultra robuste (Google Books + Open Library + Fallbacks par titre)
async function searchMultiProviders(title, author) {
  const results = [];
  const addResult = (item) => {
    if (!item.title) return;
    const lowerTitle = item.title.toLowerCase().trim();
    if (results.some(r => r.title.toLowerCase().trim() === lowerTitle)) return;
    results.push(item);
  };

  const cleanTitle = title.replace(/['’"()]/g, ' ').replace(/[-\s]+/g, ' ').trim();
  const cleanAuthor = author.replace(/['’"()]/g, ' ').replace(/[-\s]+/g, ' ').trim();

  // 1. Google Books (Titre + Auteur, FR)
  let gbUrl1 = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(cleanTitle + ' ' + cleanAuthor)}&hl=fr&maxResults=5`;
  if (GOOGLE_BOOKS_API_KEY) gbUrl1 += `&key=${GOOGLE_BOOKS_API_KEY}`;
  const res1 = await httpGet(gbUrl1);
  if (res1.statusCode === 200) {
    try {
      const data = JSON.parse(res1.body);
      (data.items || []).forEach(vol => {
        const info = vol.volumeInfo || {};
        let cover = info.imageLinks?.medium || info.imageLinks?.thumbnail || '';
        if (cover.startsWith('http://')) cover = cover.replace('http://', 'https://');
        let resolvedIsbn = '';
        if (info.industryIdentifiers) {
          const isbn13 = info.industryIdentifiers.find(id => id.type === 'ISBN_13');
          const isbn10 = info.industryIdentifiers.find(id => id.type === 'ISBN_10');
          resolvedIsbn = isbn13 ? isbn13.identifier : (isbn10 ? isbn10.identifier : '');
        }
        addResult({
          title: info.title || title,
          author: (info.authors ? info.authors.join(', ') : author),
          description: info.description || '',
          genre: mapCategoryToGenre(info.categories) || classifyBookText(info.title || title, info.description || ''),
          coverUrl: cover,
          isbn: resolvedIsbn,
          publisher: info.publisher || '',
          publishedDate: info.publishedDate ? info.publishedDate.substring(0, 4) : '',
          source: 'google_books'
        });
      });
    } catch (e) {}
  }

  // 2. Open Library (Titre + Auteur) si moins de 5 résultats
  if (results.length < 5) {
    const olUrl1 = `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanTitle + ' ' + cleanAuthor)}&limit=5`;
    const resOl1 = await httpGet(olUrl1);
    if (resOl1.statusCode === 200) {
      try {
        const data = JSON.parse(resOl1.body);
        (data.docs || []).forEach(doc => {
          let cover = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '';
          addResult({
            title: doc.title || title,
            author: (doc.author_name ? doc.author_name.join(', ') : author),
            description: '',
            genre: mapCategoryToGenre(doc.subject) || classifyBookText(doc.title || title, ''),
            coverUrl: cover,
            isbn: doc.isbn ? doc.isbn[0] : '',
            publisher: doc.publisher ? doc.publisher[0] : '',
            publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : '',
            workKey: doc.key,
            source: 'open_library'
          });
        });
      } catch (e) {}
    }
  }

  // 3. Google Books (Titre seul) si moins de 5 résultats
  if (results.length < 5) {
    let gbUrl2 = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(cleanTitle)}&hl=fr&maxResults=5`;
    if (GOOGLE_BOOKS_API_KEY) gbUrl2 += `&key=${GOOGLE_BOOKS_API_KEY}`;
    const res2 = await httpGet(gbUrl2);
    if (res2.statusCode === 200) {
      try {
        const data = JSON.parse(res2.body);
        (data.items || []).forEach(vol => {
          const info = vol.volumeInfo || {};
          let cover = info.imageLinks?.medium || info.imageLinks?.thumbnail || '';
          if (cover.startsWith('http://')) cover = cover.replace('http://', 'https://');
          let resolvedIsbn = '';
          if (info.industryIdentifiers) {
            const isbn13 = info.industryIdentifiers.find(id => id.type === 'ISBN_13');
            const isbn10 = info.industryIdentifiers.find(id => id.type === 'ISBN_10');
            resolvedIsbn = isbn13 ? isbn13.identifier : (isbn10 ? isbn10.identifier : '');
          }
          addResult({
            title: info.title || title,
            author: (info.authors ? info.authors.join(', ') : author),
            description: info.description || '',
            genre: mapCategoryToGenre(info.categories) || classifyBookText(info.title || title, info.description || ''),
            coverUrl: cover,
            isbn: resolvedIsbn,
            publisher: info.publisher || '',
            publishedDate: info.publishedDate ? info.publishedDate.substring(0, 4) : '',
            source: 'google_books'
          });
        });
      } catch (e) {}
    }
  }

  // 4. Open Library (Titre seul) si toujours moins de 5 résultats
  if (results.length < 5) {
    const olUrl2 = `https://openlibrary.org/search.json?q=${encodeURIComponent(cleanTitle)}&limit=5`;
    const resOl2 = await httpGet(olUrl2);
    if (resOl2.statusCode === 200) {
      try {
        const data = JSON.parse(resOl2.body);
        (data.docs || []).forEach(doc => {
          let cover = doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-L.jpg` : '';
          addResult({
            title: doc.title || title,
            author: (doc.author_name ? doc.author_name.join(', ') : author),
            description: '',
            genre: mapCategoryToGenre(doc.subject) || classifyBookText(doc.title || title, ''),
            coverUrl: cover,
            isbn: doc.isbn ? doc.isbn[0] : '',
            publisher: doc.publisher ? doc.publisher[0] : '',
            publishedDate: doc.first_publish_year ? String(doc.first_publish_year) : '',
            workKey: doc.key,
            source: 'open_library'
          });
        });
      } catch (e) {}
    }
  }

  return results.slice(0, 5);
}

// Si Open Library est sélectionné, récupérer sa description si manquante
async function fetchOpenLibraryDescription(workKey) {
  if (!workKey) return '';
  try {
    const res = await httpGet(`https://openlibrary.org${workKey}.json`);
    if (res.statusCode === 200) {
      const data = JSON.parse(res.body);
      if (data.description) {
        return typeof data.description === 'string' ? data.description : (data.description.value || '');
      }
    }
  } catch (e) {}
  return '';
}

async function startInteractiveMode() {
  console.log("🚀 Chargement des fichiers de métadonnées...");

  let metadata = {};
  if (fs.existsSync(METADATA_FILE)) {
    try { metadata = JSON.parse(fs.readFileSync(METADATA_FILE, 'utf-8')); } catch (e) {}
  }

  let overrides = {};
  if (fs.existsSync(OVERRIDES_FILE)) {
    try { overrides = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf-8')); } catch (e) {}
  }

  console.log("📡 Récupération de la liste des livres depuis le Google Sheet...");
  let books = [];
  try {
    const res = await httpGet(SHEET_URL);
    if (res.statusCode === 200) {
      books = JSON.parse(res.body);
    }
  } catch (e) {
    console.error("❌ Erreur lors de la récupération du Google Sheet :", e.message);
    process.exit(1);
  }

  // Menu 1 : Sélection du mode
  const modeChoice = await selectMenu(
    "Choisissez le mode de travail :",
    [
      "🔍 Mode 1 : Livres introuvables / non résolus uniquement",
      "📚 Mode 2 : Tous les livres de la bibliothèque"
    ]
  );

  let targetBooks = [];
  if (modeChoice === 0) {
    targetBooks = books.filter(b => {
      const titre = (b.Titre || '').trim();
      const prenom = b.Prénom || b['Prnom'] || '';
      const famille = b.Famille || '';
      const auteur = ((prenom + ' ' + famille).trim() || b.Auteur || '').trim();
      if (!titre) return false;
      const slug = slugify(`${titre} ${auteur}`);
      
      // Si le livre est déjà présent dans les overrides (validé manuellement) -> RÉSOLU !
      if (overrides[slug]) return false;

      const entry = metadata[slug];
      // Si déjà présent avec source override -> RÉSOLU !
      if (entry && entry.source === 'override') return false;

      // Sinon, il est à traiter si pas de description ou introuvable
      return !entry || !entry.description || entry.source === 'not_found';
    });
  } else {
    targetBooks = books;
  }

  console.clear();
  console.log(`\n📋 ${targetBooks.length} livre(s) restants à traiter.\n`);
  await new Promise(r => setTimeout(r, 800));

  let processedCount = 0;
  let overrideAddedCount = 0;

  for (let i = 0; i < targetBooks.length; i++) {
    const b = targetBooks[i];
    const titre = (b.Titre || '').trim();
    const prenom = b.Prénom || b['Prnom'] || '';
    const famille = b.Famille || '';
    const auteur = ((prenom + ' ' + famille).trim() || b.Auteur || '').trim();
    if (!titre) continue;

    const slug = slugify(`${titre} ${auteur}`);
    let searchTitle = titre;
    let searchAuthor = auteur;

    let resolved = false;

    while (!resolved) {
      const items = await searchMultiProviders(searchTitle, searchAuthor);

      const menuOptions = [];
      items.forEach((item, idx) => {
        const dateStr = item.publishedDate ? ` (${item.publishedDate})` : '';
        const editeurStr = item.publisher ? ` [${item.publisher}]` : '';
        menuOptions.push(`📖 ${item.title} — ${item.author}${dateStr}${editeurStr}`);
      });

      menuOptions.push(`✏️  Modifier la recherche (si faute de frappe)`);
      menuOptions.push(`⏩  Passer / Pas ici (Skip / Not here)`);

      const header = `Livre [${i + 1}/${targetBooks.length}] : "${titre}" par "${auteur}"\nRésultats trouvés : ${items.length} proposition(s)`;
      
      const choiceIdx = await selectMenu(header, menuOptions);

      if (choiceIdx < items.length) {
        // Choix d'un livre (0 à items.length - 1)
        const selected = items[choiceIdx];

        if (!selected.description && selected.workKey) {
          selected.description = await fetchOpenLibraryDescription(selected.workKey);
        }

        const finalEntry = {
          title: selected.title,
          author: selected.author,
          description: selected.description || '',
          genre: selected.genre || classifyBookText(selected.title, selected.description || ''),
          coverUrl: selected.coverUrl || '',
          isbn: selected.isbn || b.ISBN || '',
          enrichedAt: new Date().toISOString(),
          source: 'override'
        };

        // Sauvegarder dans overrides et metadata
        overrides[slug] = finalEntry;
        metadata[slug] = finalEntry;

        fs.writeFileSync(OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf-8');
        fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');

        overrideAddedCount++;
        console.clear();
        console.log(`\n✅ ENREGISTRÉ ET VALIDÉ !`);
        console.log(`   Titre  : ${finalEntry.title}`);
        console.log(`   Auteur : ${finalEntry.author}`);
        console.log(`   Genre  : ${finalEntry.genre}\n`);
        await new Promise(r => setTimeout(r, 1000));
        resolved = true;
      } else if (choiceIdx === menuOptions.length - 2) {
        // Modifier la recherche
        console.clear();
        console.log(`\n✏️ Modifier les termes de recherche pour "${titre}" :`);
        const inputTitre = await askInput(`Nouveau titre (ou appuyer sur Entrée pour garder "${searchTitle}") : `);
        const inputAuteur = await askInput(`Nouveau nom d'auteur (ou appuyer sur Entrée pour garder "${searchAuthor}") : `);
        if (inputTitre) searchTitle = inputTitre;
        if (inputAuteur) searchAuthor = inputAuteur;
      } else {
        // Passer (Skip)
        console.clear();
        console.log(`\n⏩ Livre passé.`);
        await new Promise(r => setTimeout(r, 400));
        resolved = true;
      }
    }

    processedCount++;
  }

  console.clear();
  console.log(`\n==================================================`);
  console.log(`🎉 TRAITEMENT INTERACTIF TERMINÉ !`);
  console.log(`Livres traités                  : ${processedCount}`);
  console.log(`Livres mis à jour via overrides : ${overrideAddedCount}`);
  console.log(`==================================================\n`);
  process.exit(0);
}

startInteractiveMode();
