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

// --- Pilotage du quota Google Books ---
// Le quota par défaut est de 1000 requêtes/jour/projet. On s'arrête volontairement
// en dessous pour garder une marge, et on mémorise la consommation du jour dans un
// fichier afin qu'un run interrompu puisse reprendre le lendemain sans recalculer.
const GOOGLE_DAILY_CAP = parseInt(process.env.GOOGLE_DAILY_CAP || '900', 10);
const QUOTA_STATE_FILE = path.join(__dirname, '../.quota-state.json');
const RETRY_ON_5XX = 3; // Nombre de tentatives sur erreur serveur transitoire (503 notamment)

// --- Surveillance de la santé de Google Books ---
// L'endpoint de recherche renvoie des 503 par vagues : on a mesuré 92 %
// d'échec, avec des séries d'échecs séparées par un succès isolé. Compter
// les échecs consécutifs ne fonctionne donc pas : un seul succès intercalé
// remet le compteur à zéro et le coupe-circuit ne s'ouvre jamais.
//
// On juge donc sur une fenêtre glissante des N derniers appels, et on
// n'abandonne pas Google définitivement : après un délai de refroidissement
// on réessaie, au cas où la panne serait terminée.
const GOOGLE_WINDOW = parseInt(process.env.GOOGLE_WINDOW || '10', 10);
const GOOGLE_UNHEALTHY_RATE = parseFloat(process.env.GOOGLE_UNHEALTHY_RATE || '0.6');
const GOOGLE_COOLDOWN_MIN = parseFloat(process.env.GOOGLE_COOLDOWN_MIN || '10');
const GOOGLE_MIN_SAMPLES = 6; // en dessous, on ne conclut pas

// 1 = succès, 0 = échec. Fenêtre glissante des derniers appels Google.
const googleResults = [];
// Budget de réessais, réduit quand Google va mal : inutile d'insister 3 fois
// quand le service est à 92 % en panne.
let googleRetryBudget = RETRY_ON_5XX;

function noteGoogleResult(ok) {
  googleResults.push(ok ? 1 : 0);
  if (googleResults.length > GOOGLE_WINDOW) googleResults.shift();
  const rate = googleFailureRate();
  googleRetryBudget = rate >= 0.3 ? 1 : RETRY_ON_5XX;
}

function googleFailureRate() {
  if (googleResults.length === 0) return 0;
  let echecs = 0;
  for (const r of googleResults) if (!r) echecs++;
  return echecs / googleResults.length;
}

function googleUnhealthy() {
  return googleResults.length >= GOOGLE_MIN_SAMPLES && googleFailureRate() >= GOOGLE_UNHEALTHY_RATE;
}


// --- Durée maximale d'un run ---
// 0 = illimité. Sinon le script s'arrête proprement entre deux livres,
// sauvegarde, et quitte avec le code 0. Il peut dépasser de quelques secondes
// le temps imparti, le temps de terminer le livre en cours.
const RUN_MAX_MINUTES = parseFloat(process.env.RUN_MAX_MINUTES || '0') || 0;
const RUN_DEADLINE = RUN_MAX_MINUTES > 0 ? Date.now() + RUN_MAX_MINUTES * 60000 : null;

function timeLeftMs() {
  if (!RUN_DEADLINE) return Infinity;
  return RUN_DEADLINE - Date.now();
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function loadQuotaState() {
  try {
    if (fs.existsSync(QUOTA_STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(QUOTA_STATE_FILE, 'utf-8'));
      // La consommation est remise à zéro chaque jour
      if (state.date === todayKey()) {
        return { date: state.date, googleCalls: state.googleCalls || 0 };
      }
    }
  } catch (e) {
    console.warn('⚠️ État de quota illisible, il repart de zéro :', e.message);
  }
  return { date: todayKey(), googleCalls: 0 };
}

function saveQuotaState(state) {
  try {
    fs.writeFileSync(QUOTA_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('⚠️ Impossible de sauvegarder l’état de quota :', e.message);
  }
}

const quotaState = loadQuotaState();

function countGoogleCall() {
  quotaState.googleCalls++;
  saveQuotaState(quotaState);
}

function googleQuotaLeft() {
  return Math.max(0, GOOGLE_DAILY_CAP - quotaState.googleCalls);
}

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

// Helper: Faire une requête HTTP GET, avec réessais sur erreur transitoire.
// Google Books renvoie régulièrement des 503 sur son endpoint de recherche :
// les retry avec backoff évitent de marquer ces livres comme "introuvables".
//
// Les redirections sont suivies : openlibrary.org/isbn/{isbn}.json répond 302
// pour un ISBN valide, et sans suivi on croyait le livre absent.
function httpGet(url, headers = {}, retries = RETRY_ON_5XX, redirectHops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'KotArdoiseLibraryBot/2.0 (contact: info@kotardoise.be)',
        ...headers
      }
    }, (res) => {
      const isRedirect = [301, 302, 303, 307, 308].includes(res.statusCode);
      if (isRedirect && res.headers.location && redirectHops < 5) {
        res.resume(); // on libère la socket avant de suivre
        const cible = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        httpGet(cible, headers, retries, redirectHops + 1).then(resolve, reject);
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        // 5xx = erreur serveur temporaire : on réessaie avec un délai croissant
        if (res.statusCode >= 500 && retries > 0) {
          const wait = 1000 * Math.pow(2, RETRY_ON_5XX - retries);
          console.warn(`   ⚠️  HTTP ${res.statusCode} — nouvel essai dans ${wait} ms`);
          setTimeout(() => resolve(httpGet(url, headers, retries - 1)), wait);
          return;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    }).on('error', (err) => {
      // Erreur réseau : on réessaie aussi, puis on abandonne
      if (retries > 0) {
        const wait = 1000 * Math.pow(2, RETRY_ON_5XX - retries);
        setTimeout(() => resolve(httpGet(url, headers, retries - 1)), wait);
        return;
      }
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

// ---------------------------------------------------------------------------
// Contrôle de langue des descriptions
//
// Le catalogue est francophone : une description en anglais, en néerlandais ou
// en italien est une erreur de données, pas un contenu. Or les API renvoient
// volontiers le résumé de l'édition originale : "Le flux et le reflux" (Agatha
// Christie) arrivait avec le texte de "Taken at the Flood".
//
// L'ancien isEnglishText (liste de 18 mots, seuil 3) laissait passer 8 cas sur
// 45, dont du néerlandais. On mesure ici la densité de mots fonctionnels,
// ce qui sépare les langues sans liste de mots-clés arbitraire.
// ---------------------------------------------------------------------------

const FRENCH_STOPWORDS = new Set(('le la les de des du un une et est en que qui dans pour au aux ce cette ' +
  'pas plus sur avec par son sa ses leur leurs nous vous ils elles ne se lui y comme tout tous bien aussi ' +
  'encore deja etre avoir faire ainsi donc alors même').split(' '));

const ENGLISH_STOPWORDS = new Set(('the a an and or but is are was were in on of to for with that this it as ' +
  'by from at be been has have had not which who its their his her they them we you i about into over than ' +
  'then some such only own same too very can will just should now').split(' '));

// Seuils mesurés sur le catalogue : le français valide le plus bas observé est
// à 0,154 de densité, un italien à 0,079. 0,10 les sépare proprement.
const LANG_MIN_DENSITY = 0.10;
const LANG_MIN_HITS = 4;

// Classifier une description : 'francais' | 'anglais' | 'inconnu' | 'trop-court'
function detectLanguage(text) {
  if (!text || text.length < 40) return 'trop-court';
  const mots = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((m) => m.length > 1);
  if (mots.length < 8) return 'trop-court';

  let fr = 0;
  let en = 0;
  for (const m of mots) {
    if (FRENCH_STOPWORDS.has(m)) fr++;
    if (ENGLISH_STOPWORDS.has(m)) en++;
  }
  const densFr = fr / mots.length;
  const densEn = en / mots.length;

  if (en > fr && en >= LANG_MIN_HITS) return 'anglais';
  if (densFr >= LANG_MIN_DENSITY && fr >= LANG_MIN_HITS) return 'francais';
  if (densEn > densFr && en >= LANG_MIN_HITS) return 'anglais';
  return 'inconnu';
}

// Open Library renvoie parfois une notice de catalogue brut plutôt qu'un résumé
// ("Genre/Form: Fiction Additional Physical Format: Online version: ...").
// Ce n'est pas une description et cela ne doit jamais être enregistré.
function isCatalogDumping(text) {
  if (!text) return false;
  return /^\s*Genre\s*\/\s*Form/i.test(text)
    || /Additional Physical Format/i.test(text)
    || /^\s*Topics?\s*:/i.test(text)
    || /\bOnline version:\s*[A-Z][a-z]+,\s*[A-Z][a-z]+,?\s*\d{4}/.test(text);
}

// Décider si une description entrante peut être conservée
function acceptDescription(text) {
  if (!text || !text.trim()) return { keep: false, reason: 'vide' };
  if (isCatalogDumping(text)) return { keep: false, reason: 'notice de catalogue' };
  const lang = detectLanguage(text);
  if (lang === 'francais') return { keep: true, reason: 'français' };
  if (lang === 'trop-court') return { keep: true, reason: 'trop courte pour être jugée' };
  return { keep: false, reason: 'langue ' + lang };
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

// ---------------------------------------------------------------------------
// Validation des appariements
// Sans cette étape, une recherche Google Books/Open Library renvoie le premier
// résultat, qui correspond parfois à un ouvrage complètement différent
// (ex. "Interface" de M. T. Anderson -> un manuel de chimie Elsevier).
// ---------------------------------------------------------------------------

// Seuils de confiance minimaux pour accepter un résultat d'API
const MATCH_THRESHOLD = { title: 0.7, author: 0.6 };

// Helper: normaliser un texte pour comparaison (minuscules, sans accents ni ponctuation)
function normalizeText(text) {
  if (!text) return '';
  return text
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Mots sans valeur discriminante : articles, prépositions, mentions d'édition
const STOP_WORDS = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'd', 'et', 'au', 'aux',
  'en', 'sur', 'dans', 'pour', 'par', 'tome', 'vol', 'volume', 'livre',
  'partie', 'edition', 'ed', 'the', 'a', 'an', 'of', 'and', 'or', 'to'
]);

function significantTokens(text) {
  return normalizeText(text)
    .split(' ')
    .filter(t => t.length > 1 && !STOP_WORDS.has(t) && !/^\d+$/.test(t));
}

// Deux tokens sont considérés identiques s'ils sont égaux ou préfixes l'un de l'autre
// (gère "interface"/"interfaces", "Akhmatova"/"Akhmantova")
function tokenMatch(x, y) {
  if (x === y) return true;
  return x.length >= 5 && y.length >= 5 && (x.startsWith(y) || y.startsWith(x));
}

// Score de similarité entre deux titres (0 = sans rapport, 1 = identique)
function scoreTitle(want, got) {
  const a = significantTokens(want);
  const b = significantTokens(got);
  if (a.length === 0 || b.length === 0) return 0;

  const na = normalizeText(want);
  const nb = normalizeText(got);
  if (na === nb) return 1;
  // Tolérance aux sous-titres, mais seulement si le titre recherché est assez
  // discriminant : sinon "Interface" matcherait "... Surfaces and Interfaces"
  if (a.length >= 3 && na && nb && (nb.includes(na) || na.includes(nb))) return 0.9;

  const used = new Set();
  let hits = 0;
  for (const t of a) {
    const idx = b.findIndex((u, i) => !used.has(i) && tokenMatch(t, u));
    if (idx !== -1) { used.add(idx); hits++; }
  }
  return (2 * hits) / (a.length + b.length);
}

// Correspondance approximative sur les noms d'auteur.
//
// La Sheet contient des fautes de frappe : "Lafcabio Hearb" pour
// "Lafcadio Hearn", "Particia Macdonald" pour "Patricia Macdonald".
// Sans similarité, ces livres ne sont jamais rattachés à leur notice, alors
// que le titre correspond parfaitement. On n'applique ceTolérance qu'au-delà
// de 0,84, et toujours combiné au contrôle de titre, ce qui évite de
// rapprocher deux auteurs différents ("Anne Plichota" / "Anne Plichon").
const AUTHOR_FUZZY_MIN = 0.84;

function bigrams(text) {
  const t = text.replace(/\s+/g, ' ').trim();
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  return out;
}

// Coefficient de Dice sur les bigrammes
function diceCoefficient(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.length === 0 || B.length === 0) return 0;
  const reste = new Map();
  for (const x of B) reste.set(x, (reste.get(x) || 0) + 1);
  let communs = 0;
  for (const x of A) {
    const c = reste.get(x) || 0;
    if (c > 0) { communs++; reste.set(x, c - 1); }
  }
  return (2 * communs) / (A.length + B.length);
}

// Distance de Levenshtein normalisée
function levenshteinRatio(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n === 0 ? 1 : 0;
  if (n === 0) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  return Math.max(diceCoefficient(a, b), levenshteinRatio(a, b));
}

// Score de similarité entre deux auteurs (le nom de famille prime)
function scoreAuthor(want, got) {
  const a = significantTokens(want);
  const b = significantTokens(got);
  if (a.length === 0 || b.length === 0) return 0;

  const lastA = a[a.length - 1];
  const lastB = b[b.length - 1];
  if (lastA === lastB) return 1;
  if (tokenMatch(lastA, lastB)) return 0.9;

  const used = new Set();
  let hits = 0;
  for (const t of a) {
    const idx = b.findIndex((u, i) => !used.has(i) && t.length > 1 && tokenMatch(t, u));
    if (idx !== -1) { used.add(idx); hits++; }
  }
  const partial = (2 * hits) / (a.length + b.length);
  // Nom de famille retrouvé dans une chaîne plus longue : indice réel mais partiel
  const surnameShared = (b.includes(lastA) || a.includes(lastB)) ? 0.7 : 0;
  const exact = Math.max(partial, surnameShared);
  if (exact > 0) return exact;

  // Aucune superposition de mots : on tente une correspondance approximative
  // pour rattraper les fautes de frappe de la Sheet sur les noms d'auteur.
  const similarite = nameSimilarity(normalizeText(want), normalizeText(got));
  return similarite >= AUTHOR_FUZZY_MIN ? similarite : 0;
}

// Vérifie qu'un résultat d'API correspond bien au livre demandé
function matchScore(wantTitle, wantAuthor, gotTitle, gotAuthor) {
  const titleScore = scoreTitle(wantTitle, gotTitle);
  const authorScore = wantAuthor ? scoreAuthor(wantAuthor, gotAuthor) : 1;
  return {
    ok: titleScore >= MATCH_THRESHOLD.title && authorScore >= MATCH_THRESHOLD.author,
    titleScore: Math.round(titleScore * 100) / 100,
    authorScore: Math.round(authorScore * 100) / 100
  };
}

// Couverture Open Library par ISBN : déterministe, gratuit, sans quota.
// On ne prend que l'image : les descriptions Open Library sont rarement en
// français et le contrôle de langue rejettera la plupart d'entre elles.
async function fetchOpenLibraryCoverByIsbn(isbn) {
  if (!isbn) return null;
  let res;
  try {
    res = await httpGet(`https://openlibrary.org/isbn/${isbn}.json`, {}, 2);
  } catch (e) {
    return null;
  }
  if (!res || res.statusCode !== 200) return null;
  let doc;
  try { doc = JSON.parse(res.body); } catch (e) { return null; }
  if (!doc || !Array.isArray(doc.covers) || doc.covers.length === 0) return null;

  const authors = Array.isArray(doc.authors) ? doc.authors.map((a) => a.name || '').join(' ') : (doc.by_statement || '');
  const match = matchScore('', '', doc.title || '', '');
  return {
    coverUrl: `https://covers.openlibrary.org/b/id/${doc.covers[0]}-L.jpg`,
    title: doc.title || '',
    author: authors,
    match
  };
}

// Choisir, parmi plusieurs résultats, celui qui correspond le mieux au livre demandé
function pickBestCandidate(title, author, items) {
  let best = null;
  for (const item of items) {
    const info = item.volumeInfo || item;
    if (!info) continue;
    const authors = Array.isArray(info.authors) ? info.authors.join(' ') : (info.authors || '');
    const m = matchScore(title, author, info.title || '', authors);
    if (!m.ok) continue;
    if (!best || (m.titleScore + m.authorScore) > (best.match.titleScore + best.match.authorScore)) {
      best = { item, info, match: m };
    }
  }
  return best;
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
    url = `https://www.googleapis.com/books/v1/volumes?q=${query}&langRestrict=fr&hl=fr&maxResults=5`;
  }
  
  if (GOOGLE_BOOKS_API_KEY) {
    url += `&key=${GOOGLE_BOOKS_API_KEY}`;
  }
  
  try {
    countGoogleCall();
    let res = await httpGet(url, {}, googleRetryBudget);
    if (res.statusCode === 429) {
      throw new Error("RATE_LIMIT_EXCEEDED");
    }
    if (res.statusCode >= 500) {
      // Le serveur est momentanément indisponible : ce n'est pas un "livre absent"
      throw new Error("TEMPORARY_ERROR");
    }
    if (res.statusCode === 200) {
      const data = JSON.parse(res.body);
      // ID direct : une seule réponse, à valider malgré tout
      if (googleBooksId && data.id) {
        return pickBestCandidate(title, author, [data]);
      }
      // Recherche : on parcourt tous les résultats et on ne garde que ceux qui correspondent
      if (data.items && data.items.length > 0) {
        return pickBestCandidate(title, author, data.items);
      }
    }
    
    // Si la recherche restreinte en français n'a rien renvoyé, tenter avec hl=fr seul sans langRestrict
    if (!googleBooksId && !isbn) {
      const cleanTitle = title.replace(/['’"()]/g, ' ').replace(/[-\s]+/g, ' ').trim();
      const cleanAuthor = author.replace(/['’"()]/g, ' ').replace(/[-\s]+/g, ' ').trim();
      const query = encodeURIComponent(`${cleanTitle} ${cleanAuthor}`);
      let fallbackUrl = `https://www.googleapis.com/books/v1/volumes?q=${query}&hl=fr&maxResults=5`;
      if (GOOGLE_BOOKS_API_KEY) fallbackUrl += `&key=${GOOGLE_BOOKS_API_KEY}`;
      
      const fallbackRes = await httpGet(fallbackUrl, {}, googleRetryBudget);
      if (fallbackRes.statusCode === 429) {
        throw new Error("RATE_LIMIT_EXCEEDED");
      }
      if (fallbackRes.statusCode >= 500) {
        throw new Error("TEMPORARY_ERROR");
      }
      if (fallbackRes.statusCode === 200) {
        const fallbackData = JSON.parse(fallbackRes.body);
        if (fallbackData.items && fallbackData.items.length > 0) {
          return pickBestCandidate(title, author, fallbackData.items);
        }
      }
    }
    
    // Aucun résultat suffisamment proche : on préfère ne rien associer
    // plutôt que d'enregistrer une couverture qui appartient à un autre livre
    return null;
  } catch (err) {
    // Le quota est épuisé ou le serveur est saturé : à remonter à l'appelant
    if (err.message === "RATE_LIMIT_EXCEEDED" || err.message === "TEMPORARY_ERROR") {
      throw err;
    }
    console.error(`❌ Erreur Google Books pour "${title}":`, err.message);
    return null;
  }
}

// Choisir, parmi plusieurs résultats Open Library, celui qui correspond le mieux
function pickBestDoc(title, author, docs) {
  let best = null;
  for (const doc of docs) {
    if (!doc || !doc.title) continue;
    const authors = Array.isArray(doc.author_name) ? doc.author_name.join(' ') : (doc.author_name || '');
    const m = matchScore(title, author, doc.title, authors);
    if (!m.ok) continue;
    if (!best || (m.titleScore + m.authorScore) > (best.match.titleScore + best.match.authorScore)) {
      best = { doc, match: m };
    }
  }
  return best;
}

// Fonction pour interroger Open Library API
async function fetchOpenLibrary(title, author, isbn = '') {
  let searchUrl = '';
  if (isbn) {
    searchUrl = `https://openlibrary.org/search.json?q=isbn:${isbn}&limit=5`;
  } else {
    const cleanTitle = title.replace(/['’"()]/g, ' ').trim();
    const cleanAuthor = author.replace(/['’"()]/g, ' ').trim();
    const query = encodeURIComponent(`title:${cleanTitle} author:${cleanAuthor} language:fre`);
    searchUrl = `https://openlibrary.org/search.json?q=${query}&limit=5`;
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
      searchUrl = `https://openlibrary.org/search.json?q=${query}&limit=5`;
      searchRes = await httpGet(searchUrl);
      if (searchRes.statusCode === 200) {
        searchData = JSON.parse(searchRes.body);
      }
    }

    if (!searchData.docs || searchData.docs.length === 0) return null;
    
    // Ne retenir que le document réellement correspondant au livre demandé
    const best = pickBestDoc(title, author, searchData.docs);
    if (!best) return null;
    const doc = best.doc;
    
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
      author: Array.isArray(doc.author_name) ? doc.author_name.join(' ') : (doc.author_name || ''),
      description: description,
      subjects: doc.subject || [],
      coverId: doc.cover_i,
      isbn: doc.isbn ? doc.isbn[0] : null,
      match: best.match
    };
  } catch (err) {
    console.error(`❌ Erreur Open Library pour "${title}":`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase C — la BnF comme référence francophone
//
// La Sheet ne contient aucun ISBN : toute recherche est donc approximative et
// risque d'associer la couverture d'un autre ouvrage (cf. "Interface" de
// M. T. Anderson). La BnF est le catalogue national francophone : une notice
// qui correspond au couple titre + auteur confirme que l'ouvrage existe bien
// dans sa version française, et fournit parfois l'ISBN — ce qui rend ensuite
// la recherche Google entièrement déterministe.
//
// La BnF ne sert PAS de filtre bloquant : son taux de rappel est d'environ
// 76 %, un livre absent de la BnF n'est pas forcément introuvable. Elle sert
// donc de signal : un livre non confirmé est marqué pour revue humaine.
// ---------------------------------------------------------------------------

const BNF_SRU = 'https://catalogue.bnf.fr/api/SRU?version=1.2&operation=searchRetrieve';
const BNF_MAX_RECORDS = 10;

// Décoder les entités XML
function decodeXml(text) {
  if (!text) return '';
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// Extraire tous les champs UNIMARC d'un tag donné, avec leurs sous-champs
function bnfFields(record, tag) {
  const out = [];
  const re = new RegExp('<mxc:datafield tag="' + tag + '"[^>]*>([\\s\\S]*?)</mxc:datafield>', 'g');
  let m;
  while ((m = re.exec(record)) !== null) {
    const subs = {};
    const sre = /<mxc:subfield code="([^"]+)">([\s\S]*?)<\/mxc:subfield>/g;
    let s;
    while ((s = sre.exec(m[1])) !== null) {
      const code = s[1];
      const value = decodeXml(s[2]);
      subs[code] = subs[code] ? subs[code] + ' ' + value : value;
    }
    if (Object.keys(subs).length > 0) out.push(subs);
  }
  return out;
}

// Normaliser un ISBN : la BnF le publie au format "978-2-9580761-1-5"
function normalizeIsbn(value) {
  if (!value) return '';
  const cleaned = value.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (/^\d{13}$/.test(cleaned)) return cleaned;
  if (/^\d{9}[\dX]$/.test(cleaned)) return cleaned;
  return '';
}

// Nettoyer l'éditeur : les notices BnF sont brutes, par exemple
// "Livre de poche,] (impr. Brodard et Taupin)" ou "[s.l.]" pour une publication
// sans éditeur identified.
function cleanPublisher(value) {
  if (!value) return '';
  let v = value.trim();
  // On retire d'abord ce qui est entre crochets ou parenthèses
  v = v.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ');
  v = v.replace(/[\[\],]/g, ' ').replace(/\s+/g, ' ').trim();
  // Une mention d'imprimeur ou de distribution pure n'est pas un éditeur
  v = v.replace(/^(impr\.?|éditeur|éd\.|distrib\.?|librairie)\s+/i, '').trim();
  // Mentions parasites de publication
  v = v.replace(/^\[(s\.l\.|s\.n\.)\]$/i, '').trim();
  return v;
}

// Extraire l'année : "2004" ok, "[s.d.]" ou "DL 2022" selon la forme
function extractYear(value) {
  if (!value) return '';
  const m = String(value).match(/\b(1[6-9]\d{2}|20\d{2})\b/);
  return m ? m[1] : '';
}

// L'index CQL de la BnF se comporte de façon imprévisible sur certaines
// combinaisons de mots ("petite syrène" renvoie 0 alors que "syrène" seul
// renvoie 25 notices). On construit donc une liste de requêtes de plus en
// plus larges et on s'arrête à la première qui donne des résultats.
// C'est sans danger : chaque notice renvoyée est ensuite filtrée par matchScore.
function bnfQueryVariants(title) {
  const clean = title.replace(/['’"()]/g, ' ').replace(/\s+/g, ' ').trim();
  const variants = [clean];

  const noArticle = clean.replace(/^(le|la|les|l'|un|une|des|du|de|son|sa|ses)\s+/i, '').trim();
  if (noArticle && noArticle !== clean) variants.push(noArticle);

  // Les mots les plus longs sont les plus discriminants
  const words = noArticle.split(' ').filter((w) => w.length > 2).sort((a, b) => b.length - a.length);
  if (words.length >= 2) variants.push(words.slice(0, 2).join(' '));
  if (words.length >= 1) variants.push(words[0]);

  return [...new Set(variants)].filter(Boolean);
}

// Requête BnF, avec repli progressif sur le titre puis sur l'auteur
async function bnfSearch(title, author) {
  const variants = bnfQueryVariants(title);
  const cleanAuthor = author.replace(/['’"()]/g, ' ').replace(/\s+/g, ' ').trim();

  for (let attempt = 0; attempt < variants.length; attempt++) {
    const titlePart = variants[attempt];

    // On tente d'abord avec l'auteur : la contrainte la plus forte.
    // La BnF indexe souvent les auteurs sous forme inversée ("Andersen, H. C."),
    // ce qui fait échouer une recherche sur le prénom complet.
    const attempts = [];
    if (cleanAuthor) attempts.push(`bib.title all "${titlePart}" and bib.author all "${cleanAuthor}"`);
    attempts.push(`bib.title all "${titlePart}"`);

    for (const query of attempts) {
      const url = `${BNF_SRU}&query=${encodeURIComponent(query)}&recordSchema=unimarcxchange&maximumRecords=${BNF_MAX_RECORDS}`;
      let res;
      try {
        res = await httpGet(url, {}, 2);
      } catch (e) {
        console.warn(`   ⚠️ BnF injoignable pour "${title}" : ${e.message}`);
        return null;
      }
      if (!res || res.statusCode !== 200) continue;

      const total = Number((/<srw:numberOfRecords>(\d+)<\/srw:numberOfRecords>/.exec(res.body) || [])[1] || 0);
      if (!total) continue;

      return { body: res.body, variant: titlePart, attempt };
    }
  }
  return null;
}

// Interroger la BnF et retourner la notice la plus proche du livre demandé
async function fetchBnF(title, author) {
  const found = await bnfSearch(title, author);
  if (!found) return null;

  const records = found.body.split('<srw:record>').slice(1);
  let best = null;

  for (const record of records) {
    // Titre : 200$a (titre propre) ou 225$a (titre porté par la notice)
    const f200 = bnfFields(record, '200')[0] || {};
    const f225 = bnfFields(record, '225')[0] || {};
    const notifTitle = f200.a || f225.a || '';
    if (!notifTitle) continue;

    // Auteur : 200$f (responsabilité) ou 700$a (notice d'autorité)
    let notifAuthor = f200.f || '';
    if (!notifAuthor) {
      const f700 = bnfFields(record, '700')[0];
      if (f700 && f700.a) {
        // On retire les dates de naissance/décès ("Abécassis Agnès 1972-....")
        notifAuthor = f700.a.replace(/\d{4}[-–.].*$/, '').trim();
      }
    }

    // Éditeur et date : 214 (notices récentes) ou 210 (notices anciennes)
    const f214 = bnfFields(record, '214')[0] || {};
    const f210 = bnfFields(record, '210')[0] || {};
    const publisher = cleanPublisher(f214.c || f210.c || '');
    const pubDate = extractYear(f214.d || f210.d || '');

    // ISBN : champ 010$a
    const f010 = bnfFields(record, '010')[0] || {};
    const isbn = normalizeIsbn(f010.a || '');

    const ark = (/\sid="(ark:\/12148\/[a-z0-9]+)"/i.exec(record) || [])[1] || '';

    const m = matchScore(title, author, notifTitle, notifAuthor);
    const candidate = { notifTitle, notifAuthor, publisher, pubDate, isbn, ark, match: m };
    if (!best || (m.titleScore + m.authorScore) > (best.match.titleScore + best.match.authorScore)) {
      best = candidate;
    }
  }

  if (!best) return null;
  // Même exigence de score que les autres sources : on ne retient que les notices plausibles
  const confirmed = best.match.titleScore >= MATCH_THRESHOLD.title && best.match.authorScore >= MATCH_THRESHOLD.author;
  return { ...best, confirmed, searchedOn: found.variant, relaxed: found.attempt > 0 };
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
  
  // 2. Lire le fichier d'override si disponible
  // Doit précéder l'analyse textuelle locale : un genre validé à la main
  // ne doit jamais être remplacé par une heuristique automatique.
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

  // 3. Mettre à jour les genres des livres déjà en cache à l'aide de l'analyse textuelle locale
  let localUpdates = 0;
  Object.keys(metadata).forEach(slug => {
    if (overrides[slug]) return; // décision humaine : ne pas y toucher
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
  
  // 4. Télécharger les livres depuis le Google Sheet
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
  let temporaryErrorCount = 0;
  let bnfConfirmedCount = 0;
  let needsReviewCount = 0;
  let quotaReached = false;
  let timeUp = false;
  // Coupe-circuit fondé sur le taux d'échec, pas sur une série d'échecs :
  // Google alterne des salves de 503 avec des réussites isolées, ce qui
  // réinitialiserait sans fin un compteur d'échecs consécutifs.
  let googleSkipUntil = 0;      // timestamp jusqu'auquel on saute Google
  let googleSkippedCount = 0;
  let googleRetriedCount = 0;   // ré-essais après refroidissement

  console.log(`📊 Quota Google Books du jour : ${quotaState.googleCalls}/${GOOGLE_DAILY_CAP} utilisé(s).`);

  // 5. Parcourir et enrichir
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
    
    // Faut-il retraiter ce livre ?
    //
    // L'ancien test suffisait à dire "source: google_books donc c'est fait",
    // ce qui écartait 182 livres qui n'ont toujours aucune couverture : ils
    // ne seraient jamais repris. On ne saute donc plus que ce qui est
    // réellement complet, ou ce qui relève d'une décision humaine.
    const entree = metadata[slug];
    const aUneCouverture = !!(entree && entree.coverUrl);
    const aUneDescription = !!(entree && entree.description && entree.description.trim() !== ''
      && acceptDescription(entree.description).keep);
    const dejaComplet = !!entree && (
      entree.source === 'override'      // décision humaine, on n'y touche pas
      || (aUneCouverture && aUneDescription)
      || (aUneCouverture && !!(entree.publisher || entree.publishedDate) && aUneDescription)
    );
    // Un livre pour lequel on a déjà une description française mais pas de
    // couverture est repris : la BnF et Open Library sont gratuits, et c'est
    // précisément la couverture qui manque.
    const alreadyEnrichedInFrench = dejaComplet;


    // Si on a un override, on met à jour les données du cache statique sans appeler l'API
    if (hasOverride) {
      // L'override est une décision humaine : il est prioritaire sur les données
      // du Sheet, et sa date n'est pas réécrite à chaque run.
      const o = overrides[slug];
      metadata[slug] = {
        ...metadata[slug],
        title: o.title || titre,
        author: o.author || auteur,
        description: o.description || metadata[slug]?.description || '',
        genre: o.genre || metadata[slug]?.genre || 'Inconnu',
        coverUrl: o.coverUrl || metadata[slug]?.coverUrl || '',
        isbn: o.isbn || metadata[slug]?.isbn || book.ISBN || '',
        verified: o.verified !== undefined ? o.verified : (metadata[slug]?.verified ?? true),
        enrichedAt: o.enrichedAt || metadata[slug]?.enrichedAt || new Date().toISOString(),
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

    // A-t-on consommé le quota quotidien Google Books ?
    if (googleQuotaLeft() <= 0) {
      console.log(`\n🛑 Quota quotidien Google Books atteint (${GOOGLE_DAILY_CAP}). Enregistrement et arrêt...`);
      console.log('   Relancer demain pour reprendre là où le run s’est arrêté.');
      quotaReached = true;
      break;
    }

    // Le temps imparti est-il écoulé ?
    if (timeLeftMs() <= 0) {
      const overrun = Math.round((Date.now() - RUN_DEADLINE) / 1000);
      console.log(`\n⏱️  Temps imparti atteint (${RUN_MAX_MINUTES} min). Enregistrement et arrêt...`);
      if (overrun > 5) console.log(`   Dépassement de ${overrun} s sur le dernier livre traité.`);
      timeUp = true;
      break;
    }
    
    // Attendre un court instant entre les requêtes
    if (apiCallsCount > 0) {
      await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY));
    }
    
    console.log(`\n🔍 [${i+1}/${books.length}] Enrichissement de: "${titre}" par "${auteur}"`);
    
    // Extraction des clés d'identifiants prioritaires depuis la ligne Google Sheet
    let isbn = (book.ISBN || '').toString().trim();
    const googleBooksId = (book.ID_GoogleBooks || '').toString().trim();
    const sheetIsbn = isbn;

    // La BnF a peut-être déjà répondu lors d'un run précédent : on réutilise
    // son ISBN au lieu de refaire la requête, qui est le principal coût du run.
    let bnf = null;
    if (!isbn && entree && entree.bnfRef) {
      if (entree.isbn) {
        isbn = entree.isbn;
        bnf = {
          confirmed: true,
          notifTitle: entree.resolvedTitle || entree.title || titre,
          notifAuthor: entree.resolvedAuthor || entree.author || auteur,
          publisher: entree.publisher || '',
          pubDate: entree.publishedDate || '',
          isbn: entree.isbn,
          ark: entree.bnfRef,
          match: { titleScore: 1, authorScore: 1, ok: true },
          fromCache: true
        };
      }
    }

    // La BnF est interrogée en priorité pour les livres sans ISBN.
    // Elle confirme l'existence de l'ouvrage dans sa version française et fournit
    // La BnF est interrogée en priorité pour les livres sans ISBN.
    // Elle confirme l'existence de l'ouvrage dans sa version française et fournit
    // souvent l'ISBN, ce qui rend la recherche Google ci-dessous déterministe.
    // La BnF n'a aucun quota : elle est toujours tentée en premier.
    if (!isbn) {
      bnf = await fetchBnF(titre, auteur);
      if (!bnf) {
        console.log('   📚 Aucune notice BnF — le livre sera marqué pour revue humaine');
      } else if (!bnf.confirmed) {
        console.log(`   📚 Notice BnF non confirmée (titre ${bnf.match.titleScore}, auteur ${bnf.match.authorScore}) — recherche sans ISBN BnF`);
      } else if (bnf.isbn) {
        isbn = bnf.isbn;
        console.log(`   📚 BnF confirmée : "${bnf.notifTitle}"${bnf.publisher ? ' (' + bnf.publisher + (bnf.pubDate ? ', ' + bnf.pubDate : '') + ')' : ''} — ISBN ${isbn}`);
      } else {
        console.log(`   📚 BnF confirmée : "${bnf.notifTitle}"${bnf.publisher ? ' (' + bnf.publisher + (bnf.pubDate ? ', ' + bnf.pubDate : '') + ')' : ''} — mais sans ISBN dans la notice`);
      }
    } else if (bnf && bnf.fromCache) {
      console.log(`   📚 Référence BnF réutilisée du cache (ISBN ${isbn})`);
    }

    // Ce que la BnF a permis d'établir sur ce livre, indépendamment des API
    const bnfInfo = bnf && bnf.confirmed ? {
      isbn: isbn || '',
      publisher: bnf.publisher || '',
      publishedDate: bnf.pubDate || '',
      bnfRef: bnf.ark || ''
    } : null;

    let enrichedData = null;

    // 1) Open Library par ISBN : déterministe, gratuit, sans quota.
    //    On ne récupère que la couverture : les descriptions Open Library sont
    //    rarement en français et le contrôle de langue les rejettera de toute façon.
    if (isbn && !hasOverride) {
      const olIsbn = await fetchOpenLibraryCoverByIsbn(isbn);
      if (olIsbn && olIsbn.coverUrl) {
        enrichedData = {
          title: titre,
          author: auteur,
          resolvedTitle: olIsbn.title || titre,
          resolvedAuthor: olIsbn.author || auteur,
          description: '',
          genre: 'Inconnu',
          coverUrl: olIsbn.coverUrl,
          isbn: isbn,
          verified: true,
          matchScore: olIsbn.match,
          publisher: bnfInfo ? bnfInfo.publisher : '',
          publishedDate: bnfInfo ? bnfInfo.publishedDate : '',
          bnfRef: bnfInfo ? bnfInfo.bnfRef : '',
          needsReview: false,
          enrichedAt: new Date().toISOString(),
          source: 'open_library_isbn'
        };
        console.log(`   📗 Couverture Open Library trouvée par ISBN ${isbn}`);
      }
    }

    // 2) Google Books, sauf si le coupe-circuit est ouvert.
    //    Le refroidissement est temporaire : après Google_COOLDOWN_MIN on
    //    réessaie, la panne pouvant être finie.
    const now = Date.now();
    const googleCooling = now < googleSkipUntil;
    if (now >= googleSkipUntil && googleUnhealthy()) {
      googleSkipUntil = now + GOOGLE_COOLDOWN_MIN * 60000;
      googleRetriedCount++;
      console.log(`\n🔌 Google Books est saturé (${Math.round(googleFailureRate() * 100)} % d'échecs sur les ${googleResults.length} derniers appels).`);
      console.log(`   Pause de ${GOOGLE_COOLDOWN_MIN} min : la suite se fait avec BnF et Open Library.`);
      console.log('   Google sera réessayé ensuite, la panne pouvant être finie.\n');
    }

    if (!enrichedData) {
      if (googleCooling) {
        googleSkippedCount++;
      } else {
        apiCallsCount++;
        try {
          const gbResult = await fetchGoogleBooks(titre, auteur, isbn, googleBooksId);
          noteGoogleResult(true);
          if (gbResult) {
            const info = gbResult.info; // validé par pickBestCandidate
            const match = gbResult.match;

            // Contrôle de langue : le catalogue est francophone
            const descCheck = acceptDescription(info.description || '');
            const desc = descCheck.keep ? (info.description || '') : '';
            if (info.description && !descCheck.keep) {
              console.log(`   🚫 Description écartée (${descCheck.reason})`);
            }

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
              // Titre/auteur réellement renvoyés par l'API : permet de détecter un appariement douteux
              resolvedTitle: info.title || titre,
              resolvedAuthor: Array.isArray(info.authors) ? info.authors.join(', ') : (info.authors || auteur),
              description: desc,
              genre: genre,
              coverUrl: cover,
              isbn: resolvedIsbn,
              verified: true,
              matchScore: match,
              // Données de référence ajoutées par la BnF
              publisher: bnfInfo ? bnfInfo.publisher : '',
              publishedDate: bnfInfo ? bnfInfo.publishedDate : '',
              bnfRef: bnfInfo ? bnfInfo.bnfRef : '',
              needsReview: false,
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
      if (err.message === "TEMPORARY_ERROR") {
        // Google est saturé (503). On n'inscrit pas le livre comme "absent" :
        // on conserve ce que la BnF a permis d'établir (ISBN, éditeur, année)
        // et on le laisse ouvert pour un nouvel essai.
        temporaryErrorCount++;
        apiCallsCount--;
        noteGoogleResult(false);

        if (bnfInfo && (bnfInfo.isbn || bnfInfo.publisher || bnfInfo.publishedDate)) {
          const dejaConnu = metadata[slug];
          metadata[slug] = Object.assign({}, dejaConnu || {}, {
            title: titre,
            author: auteur,
            // On ne remplace la description que si elle est absente ou non française
            description: dejaConnu && acceptDescription(dejaConnu.description).keep
              ? dejaConnu.description : '',
            genre: dejaConnu && dejaConnu.genre ? dejaConnu.genre : 'Inconnu',
            coverUrl: dejaConnu ? (dejaConnu.coverUrl || '') : '',
            isbn: bnfInfo.isbn || (dejaConnu ? dejaConnu.isbn : '') || sheetIsbn,
            publisher: bnfInfo.publisher,
            publishedDate: bnfInfo.publishedDate,
            bnfRef: bnfInfo.bnfRef,
            needsReview: true,
            source: 'bnf_only',
            enrichedAt: new Date().toISOString()
          });
          console.error('   📚 Données BnF conservées (ISBN, éditeur, année) malgré la panne.');
        } else {
          console.error('   ⚠️ Google Books indisponible et aucune donnée BnF — livre laissé intact.');
        }
        continue;
      }
    }
    }
    }   // fin du else (Google) et du if (!enrichedData)

    // 3) Dernier recours : Open Library par titre + auteur
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
        // Contrôle de langue sur la description Open Library
        const olDescCheck = acceptDescription(olResult.description || '');
        if (olResult.description && !olDescCheck.keep) {
          console.log(`   🚫 Description Open Library écartée (${olDescCheck.reason})`);
        }
        
        enrichedData = {
          title: titre,
          author: auteur,
          resolvedTitle: olResult.title || titre,
          resolvedAuthor: olResult.author || auteur,
          description: olDescCheck.keep ? (olResult.description || '') : '',
          genre: genre,
          coverUrl: cover,
          isbn: olResult.isbn || isbn || '',
          verified: true,
          matchScore: olResult.match,
          publisher: bnfInfo ? bnfInfo.publisher : '',
          publishedDate: bnfInfo ? bnfInfo.publishedDate : '',
          bnfRef: bnfInfo ? bnfInfo.bnfRef : '',
          needsReview: false,
          enrichedAt: new Date().toISOString(),
          source: 'open_library'
        };
      }
    }
    
    if (enrichedData) {
      // Point unique de fusion : la nouvelle réponse n'écrase jamais un champ
      // déjà rempli. Une source qui ne renvoie pas d'image ne doit pas faire
      // disparaître une couverture obtenue ailleurs.
      const dejaConnu = metadata[slug] || {};
      const descriptionExistante = dejaConnu.description && acceptDescription(dejaConnu.description).keep
        ? dejaConnu.description : '';
      metadata[slug] = Object.assign({}, dejaConnu, enrichedData, {
        coverUrl: enrichedData.coverUrl || dejaConnu.coverUrl || '',
        description: enrichedData.description || descriptionExistante,
        genre: (enrichedData.genre && enrichedData.genre !== 'Inconnu')
          ? enrichedData.genre : (dejaConnu.genre || 'Inconnu'),
        publisher: enrichedData.publisher || dejaConnu.publisher || '',
        publishedDate: enrichedData.publishedDate || dejaConnu.publishedDate || '',
        bnfRef: enrichedData.bnfRef || dejaConnu.bnfRef || '',
        isbn: enrichedData.isbn || dejaConnu.isbn || sheetIsbn || ''
      });
      successCount++;
      if (bnf && bnf.confirmed) bnfConfirmedCount++;
      console.log(`   ✅ Trouvé! Genre: ${metadata[slug].genre} | Source: ${metadata[slug].source}`);
    } else {
      // Rien trouvé de neuf. On ne remplace PAS l'existant : un livre qui avait
      // déjà une couverture ou une description française la garde, et on se
      // contente d'ajouter ce que la BnF a permis d'établir. Écraser ici
      // vidait les données des livres repris et a fait perdre 5 couvertures
      // et 7 descriptions lors d'un test.
      const dejaConnu = metadata[slug] || {};
      const gardeDescription = dejaConnu.description && acceptDescription(dejaConnu.description).keep
        ? dejaConnu.description : '';
      metadata[slug] = Object.assign({}, dejaConnu, {
        title: titre,
        author: auteur,
        description: gardeDescription,
        genre: dejaConnu.genre && dejaConnu.genre !== 'Inconnu' ? dejaConnu.genre : 'Inconnu',
        coverUrl: dejaConnu.coverUrl || '',
        isbn: isbn || dejaConnu.isbn || sheetIsbn || '',
        publisher: (bnf && bnf.confirmed ? bnf.publisher : '') || dejaConnu.publisher || '',
        publishedDate: (bnf && bnf.confirmed ? bnf.pubDate : '') || dejaConnu.publishedDate || '',
        bnfRef: (bnf && bnf.confirmed ? bnf.ark : '') || dejaConnu.bnfRef || '',
        // Signalé à la revue humaine : ni la BnF ni les API n'ont trouvé d'ouvrage
        needsReview: !bnf || !bnf.confirmed,
        enrichedAt: new Date().toISOString(),
        source: dejaConnu.coverUrl || gardeDescription ? dejaConnu.source || 'not_found' : 'not_found'
      });
      failureCount++;
      if (metadata[slug].needsReview) needsReviewCount++;
      console.log(`   ❌ Rien de neuf. ${metadata[slug].coverUrl ? 'Couverture conservée.' : 'Toujours sans couverture.'}${bnf && bnf.confirmed ? ' Référence BnF conservée.' : ''}`);
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

  // 6. Sauvegarder les métadonnées dans books-metadata.json
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
  console.log(`Appels Google Books effectués   : ${quotaState.googleCalls}/${GOOGLE_DAILY_CAP}`);
  console.log(`Appels API effectués            : ${apiCallsCount}`);
  console.log(`Recherches API réussies        : ${successCount}`);
  console.log(`Recherches sans résultat       : ${failureCount}`);
  console.log(`Confirmés par la BnF          : ${bnfConfirmedCount}`);
  console.log(`À vérifier manuellement       : ${needsReviewCount}`);
  console.log(`Erreurs temporaires (à retenter): ${temporaryErrorCount}`);
  console.log(`Livres sans Google (coupe-circuit): ${googleSkippedCount}`);
  console.log(`Total livres dans le cache     : ${Object.keys(metadata).length}`);
  if (googleSkippedCount > 0) {
    console.log(`🔌 Google Books ignoré pour ${googleSkippedCount} livre(s) (taux d'échec ${Math.round(googleFailureRate() * 100)} %).`);
  }
  if (temporaryErrorCount > 0) {
    console.log("ℹ️  Les livres en erreur temporaire n'ont pas été modifiés : relancez le script pour les retenter.");
  }
  if (quotaReached) {
    console.log("⚠️ Quota quotidien de l'API Google Books atteint : relancez demain pour reprendre.");
  }
  if (timeUp) {
    console.log(`⏱️  Temps imparti de ${RUN_MAX_MINUTES} min atteint : relancez pour reprendre.`);
  }
  console.log("==========================================");
}

enrich();
