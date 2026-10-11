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

// --- Stratégie de réessai sur erreur transitoire ---
//
// L'endpoint de RECHERCHE de Google Books (/volumes?q=…) est dégradé chez
// Google : il renvoie des 503 « backendFailed » par vagues, y compris pour des
// requêtes valides et déjà éprouvées. C'est un problème côté Google, documenté
// publiquement (Publisher Center, juillet 2026 : « the Google Books API will
// always return a 503 error code when the "q" URL param is used » ; Issue
// Tracker 536042535 ; StackOverflow 56579891). On a mesuré ~80 % d'échec sur
// cet endpoint, avec 4 à 7 tentatives nécessaires pour obtenir un 200.
//
// L'ancien réglage — 3 tentatives, délais fixes 1 s / 2 s / 4 s — était
// insuffisant : à 80 % d'échec, P(4 échecs d'affilée) ≈ 45 %, et le livre
// était alors perdu. D'où les « 503 tout le temps » observés.
//
// Google recommande officiellement un backoff exponentiel tronqué AVEC GIGUE
// (« truncated exponential backoff with introduced jitter ») : la gigue évite
// que tous les clients réessayent au même instant et ne s'entre-saturant.
const RETRY_ON_5XX = parseInt(process.env.GOOGLE_RETRIES || '10', 10); // tentatives après l'essai initial
const RETRY_BASE_MS = parseInt(process.env.GOOGLE_RETRY_BASE_MS || '400', 10); // premier délai
const RETRY_MAX_MS = parseInt(process.env.GOOGLE_RETRY_MAX_MS || '8000', 10); // plafond d'un délai
const RETRY_JITTER = 0.5; // part d'aléatoire : ±50 % du délai de base
const REQUEST_TIMEOUT_MS = parseInt(process.env.HTTP_TIMEOUT_MS || '30000', 10); // socket bloquée

// Délai avant la n-ième tentative (attempt 0 = premier échec) : exponentiel
// tronqué, plus une gigue aléatoire pour désynchroniser les clients.
function backoffDelay(attempt) {
  const base = Math.min(RETRY_BASE_MS * Math.pow(2, attempt), RETRY_MAX_MS);
  const jitter = base * RETRY_JITTER * (Math.random() * 2 - 1);
  // Le plafond porte sur la valeur finale : sinon la gigue ferait dépasser
  // RETRY_MAX_MS et le réglage ne serait plus un plafond.
  return Math.max(50, Math.min(RETRY_MAX_MS, Math.round(base + jitter)));
}

// --- Coupe-circuit Google Books (DÉSACTIVÉ PAR DÉFAUT) ---
//
// L'ancien réglage — 60 % d'échec sur 10 appels, pause de 10 minutes — avait
// l'effet inverse de celui recherché. Google Books étant en panne partielle
// permanente (~80 % de 503), le coupe-circuit s'ouvrait après ~6 livres et
// Google n'était plus interrogé du tout : c'est ce qui explique les 40 appels
// par jour relevés dans .quota-state.json.
//
// Le mécanisme est conservé, mais il ne se déclenche plus que sur une panne
// quasi totale, et sa pause est courte — la panne peut être finie. Le
// réactiver avec GOOGLE_BREAKER=1.
const GOOGLE_BREAKER = process.env.GOOGLE_BREAKER === '1';
const GOOGLE_WINDOW = parseInt(process.env.GOOGLE_WINDOW || '20', 10);
const GOOGLE_UNHEALTHY_RATE = parseFloat(process.env.GOOGLE_UNHEALTHY_RATE || '0.95');
const GOOGLE_COOLDOWN_MIN = parseFloat(process.env.GOOGLE_COOLDOWN_MIN || '1');
const GOOGLE_MIN_SAMPLES = 20; // en dessous, on ne conclut pas

// 1 = succès, 0 = échec. Fenêtre glissante des derniers appels Google.
const googleResults = [];

// Le budget de réessais ne dépend PLUS du taux d'échec. L'ancien comportement
// — le réduire à 1 tentative dès 30 % d'échec — garantissait de perdre les
// livres précisément pendant une panne : à 80 % d'échec, 2 tentatives laissent
// 67 % de perte, contre 0,01 % avec 11 tentatives.
const googleRetryBudget = RETRY_ON_5XX;
// Une clé refusée par Google (400) ne se répète pas à chaque livre : on ne le
// signale qu'une fois par run.
let cleApiSignalee = false;

function noteGoogleResult(ok) {
  googleResults.push(ok ? 1 : 0);
  if (googleResults.length > GOOGLE_WINDOW) googleResults.shift();
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

// Compte les appels HTTP RÉELS vers Google Books, réessais inclus.
//
// L'ancien comptage avait lieu une fois par livre (avant l'appel à httpGet) :
// pendant une panne de 503, un livre « coûte » jusqu'à 11 requêtes HTTP mais
// n'en comptait qu'une. La consommation réelle était donc sous-estimée d'un
// facteur pouvant atteindre 7, et le quota de 1000/jour se faisait dépasser
// sans que le script s'en aperçoive. On compte donc chaque requête émise.
function countGoogleRequest(url) {
  if (typeof url === 'string' && url.indexOf('www.googleapis.com') !== -1) {
    countGoogleCall();
  }
}

function googleQuotaLeft() {
  return Math.max(0, GOOGLE_DAILY_CAP - quotaState.googleCalls);
}

// Genres autorisés dans le KotArdoise.
//
// Cette liste est la SOURCE DE VÉRITÉ UNIQUE. Elle doit refléter les boutons de
// filtre de index.html et la liste de scripts/review-cli.js, soit 11 genres.
//
// Deux défauts corrigés ici :
//   · elle n'en contenait que 10 — « Essai » manquait, alors que les deux
//     autres listes l'ont et que « Add Essai genre » est le dernier
//     changement de ce dépôt ;
//   · elle n'était JAMAIS utilisée : aucun genre écrit dans le cache n'était
//     validé. Une faute de frappe ou une valeur venue d'une API aurait fait
//     disparaître un livre des filtres du site, silencieusement.
const VALID_GENRES = [
  'Horreur', 'Romance', 'Science-fiction', 'Fantasy',
  'Thriller', 'Aventure', 'Policier', 'Historique',
  'Drame', 'Comédie', 'Essai'
];
const VALID_GENRES_SET = new Set(VALID_GENRES);

// Un genre est valide s'il fait partie des 11 du Kot. « Inconnu » est admis :
// c'est l'état « pas encore classé », pas une erreur de données.
function genreValide(g) {
  return g === 'Inconnu' || VALID_GENRES_SET.has(g);
}

// Ramène tout genre hors des 11 à « Inconnu » plutôt que de le laisser polluer
// les filtres du site. Compteur à la fin du run pour rendre le nettoyage visible.
let genresHorsListe = 0;
function normaliserGenre(g) {
  if (g === undefined || g === null || g === '' || g === 'Inconnu') return 'Inconnu';
  if (VALID_GENRES_SET.has(g)) return g;
  genresHorsListe++;
  console.error(`   ⚠️  Genre hors des 11 du Kot ignoré : "${g}" → Inconnu`);
  return 'Inconnu';
}

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

// ---------------------------------------------------------------------------
// Distinguer les deux 429 de Google
//
// Un 429 peut vouloir dire deux choses très différentes :
//   · quota JOURNALIER épuisé → inutile d'insister, on s'arrête jusqu'à demain ;
//   · limite par MINUTE → transitoire, on attend quelques secondes et on retente.
//
// L'ancien code traitait tout 429 comme un quota journalier et interrompait
// tout le run : une simple salve suffisait à abandonner les ~2000 livres
// restants. On lit donc le corps de l'erreur pour décider.
// ---------------------------------------------------------------------------
function classify429(body) {
  try {
    const j = JSON.parse(body);
    const details = (j.error && j.error.details) || [];
    for (const d of details) {
      const meta = d.metadata || {};
      const limite = String(meta.quota_limit || '');
      if (limite === 'defaultPerDayPerProject' || meta.quota_limit_value === '0') {
        return 'quota-journalier';
      }
      if (/perminute|per_minute|per-user/i.test(limite)) return 'par-minute';
    }
  } catch (e) {
    // Corps illisible : par prudence on considère la limite comme transitoire,
    // plutôt que d'abandonner un run entier sur une réponse incompréhensible.
  }
  return 'par-minute';
}

// Helper: Faire une requête HTTP GET, avec réessais sur erreur transitoire.
// Google Books renvoie régulièrement des 503 sur son endpoint de recherche :
// les retry avec backoff + gigue évitent de marquer ces livres comme
// "introuvables". Le 429 par minute est également réessayé : c'est une limite
// de débit, pas une fin de quota.
//
// Les redirections sont suivies : openlibrary.org/isbn/{isbn}.json répond 302
// pour un ISBN valide, et sans suivi on croyait le livre absent.
function httpGet(url, headers = {}, retries = RETRY_ON_5XX, redirectHops = 0, attempt = 0) {
  return new Promise((resolve, reject) => {
    // Un appel HTTP réel part : on le compte s'il va vers Google Books. Les
    // réessais de backoff sont donc comptés eux aussi, contrairement à avant
    // (redirectHops === 0 évite de recompter une chaîne de redirections).
    if (redirectHops === 0) countGoogleRequest(url);

    const req = https.get(url, {
      headers: {
        'User-Agent': 'KotArdoiseLibraryBot/2.0 (contact: info@kotardoise.be)',
        ...headers
      },
      timeout: REQUEST_TIMEOUT_MS
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
        // 5xx = erreur serveur temporaire (503 « backendFailed » de Google).
        // 429 par minute = limite de débit. Dans les deux cas on réessaie.
        const transitoire = res.statusCode >= 500
          || (res.statusCode === 429 && retries > 0 && classify429(data) !== 'quota-journalier');
        if (transitoire && retries > 0) {
          const wait = backoffDelay(attempt);
          // Pendant une panne, ces lignes se répètent à chaque tentative : elles
          // sont journalisées avec le reste du livre et jetées si le livre
          // n'apporte rien. --verbose rétablit le journal exhaustif.
          dire(`   ⚠️  HTTP ${res.statusCode} — nouvel essai dans ${wait} ms`);
          setTimeout(() => resolve(httpGet(url, headers, retries - 1, redirectHops, attempt + 1)), wait);
          return;
        }
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data
        });
      });
    });
    // Une socket qui ne répond plus ne doit pas bloquer le run entier.
    req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
    req.on('error', (err) => {
      // Erreur réseau : on réessaie aussi, puis on abandonne
      if (retries > 0) {
        const wait = backoffDelay(attempt);
        setTimeout(() => resolve(httpGet(url, headers, retries - 1, redirectHops, attempt + 1)), wait);
        return;
      }
      reject(err);
    });
  });
}

// Mappage des catégories de livres vers les genres du Kot.
//
// Réécrit comme classifyBookText, avec la MÊME normalisation : la version
// précédente comparait des chaînes brutes avec `includes()`, donc
// « Science-Fiction » (trait d'union) ne matchait pas « science fiction »
// (espace) et « Comedie » sans accent ne matchait pas « comédie ».
// Les mots-clés de catégories, séparés par des VIRGULES pour la même raison
// que GENRE_KEYWORDS : « science fiction » est une expression, pas deux mots.
// Ils sont comparés sans tirets, pour que « Science-Fiction » et
// « Science Fiction » rejoignent le même genre.
const CATEGORY_KEYWORDS = [
  ['Horreur', 'horror,horreur,vampire,ghost'],
  ['Romance', 'romance,amour,romantic,chick lit,love story,love stories'],
  ['Science-fiction', 'science fiction,sci-fi,dystop,anticipation,post-apocalyptic'],
  ['Fantasy', 'fantasy,fantastique,magic,sorcellerie,fairy tale'],
  ['Thriller', 'thriller,suspense,angoisse,psychological'],
  ['Aventure', 'adventure,aventure,action'],
  ['Policier', 'policier,detective,mystery,crime,meurtre,sherlock'],
  ['Historique', 'history,historical,historique,biography,biographie,memoir'],
  ['Drame', 'drama,drame,tragedy,melodrama'],
  ['Comédie', 'comedy,comedie,humor,funny,satire'],
  // Essai en dernier : le fourre-tout du non-fiction.
  ['Essai', 'essay,essai,non-fiction,nonfiction,philosoph,politique,politic,social science,sciences sociales,sociologie,sociolog,religion,psychologie,psycholog,economie,economics,self-help,development personnel']
];

// Les mots-clés de catégories sont comparés sans tirets, pour que
// « Science-Fiction » et « Science Fiction » rejoignent le même genre.
const CATEGORY_PATTERNS = CATEGORY_KEYWORDS.map(([genre, mots]) => {
  const termes = mots.split(',')
    .map((m) => normaliserPourClassification(m).replace(/-/g, ' ').trim())
    .filter(Boolean);
  return { genre, pattern: new RegExp('\\b(' + termes.map(echapperRegex).join('|') + ')\\b') };
});

function mapCategoryToGenre(categories) {
  if (!categories || categories.length === 0) return 'Inconnu';

  const text = normaliserPourClassification(categories.join(' ')).replace(/-/g, ' ');

  for (const { genre, pattern } of CATEGORY_PATTERNS) {
    if (pattern.test(text)) return genre;
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

// ---------------------------------------------------------------------------
// FUITES DE LANGUE
//
// La porte française laissait passer l'espagnol. FRENCH_STOPWORDS contient
// « de », « un », « que », « en », « no », « son », « mais », « comme »… soit
// une bonne partie du lexique fonctionnel espagnol. Un texte espagnol atteint
// donc facilement la densité française et était enregistré comme français.
// Ce n'est pas théorique : « La maison aux esprits » est en cache avec une
// description espagnole (« Primera novela de Isabel Allende… »).
//
// On ajoute donc un détecteur espagnol fondé sur des mots qui n'existent pas
// en français. L'italien, lui, était déjà rejeté correctement.
// ---------------------------------------------------------------------------
const SPANISH_MARKERS = new Set(('los las del por para pero muy este esta esto eso esos esas fue ya tambien ' +
  'cuando donde quien cual todo toda todos todas nada mucho muchos porque aunque hasta desde hay aqui alli ' +
  'ahora siempre nunca estaban estaba eran tiene tienen hace hacer otro otra otros otras cada mismo misma ' +
  'asi sino entonces pues casi tan tanto anos senor gran mis sus uno una').split(' '));

// Seuils mesurés sur le catalogue : le français valide le plus bas observé est
// à 0,154 de densité, un italien à 0,079. 0,10 les sépare proprement.
const LANG_MIN_DENSITY = 0.10;
const LANG_MIN_HITS = 4;
// Un texte français peut contenir un mot espagnol isolé (titre d'ouvrage,
// citation) : on n'exige donc que quelques marqueurs, mais une densité
// suffisante pour que ce ne soit pas un hapax.
const LANG_ES_MIN_HITS = 3;
const LANG_ES_MIN_DENSITY = 0.05;

// Classifier une description : 'francais' | 'anglais' | 'espagnol' | 'inconnu' | 'trop-court'
function detectLanguage(text) {
  if (!text || text.length < 40) return 'trop-court';
  const mots = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((m) => m.length > 1);
  if (mots.length < 8) return 'trop-court';

  let fr = 0;
  let en = 0;
  let es = 0;
  for (const m of mots) {
    if (FRENCH_STOPWORDS.has(m)) fr++;
    if (ENGLISH_STOPWORDS.has(m)) en++;
    if (SPANISH_MARKERS.has(m)) es++;
  }
  const densFr = fr / mots.length;
  const densEn = en / mots.length;
  const densEs = es / mots.length;

  // L'espagnol est testé AVANT le français : un texte espagnol marque aussi
  // des points sur la liste française (voir plus haut), l'ordre est décisif.
  if (es >= LANG_ES_MIN_HITS && densEs >= LANG_ES_MIN_DENSITY) return 'espagnol';
  if (en > fr && en >= LANG_MIN_HITS) return 'anglais';
  if (densFr >= LANG_MIN_DENSITY && fr >= LANG_MIN_HITS) return 'francais';
  if (densEn > densFr && en >= LANG_MIN_HITS) return 'anglais';
  return 'inconnu';
}

// Open Library renvoie parfois une notice de catalogue brut plutôt qu'un résumé
// ("Genre/Form: Fiction Additional Physical Format: Online version: ...").
// Ce n'est pas une description et cela ne doit jamais être enregistré.
//
// Élargi après constat : « L'art de se gâcher la vie » était en cache avec
// « La liste exhaustive des ouvrages disponibles publiés en langue française
// dans le monde. La liste des éditeurs et la liste des collections… », qui est
// le mode d'emploi d'un distributeur, pas un résumé du livre. Les formes
// ci-dessous viennent des bases Electre / Ambre, qui renvoient ce contenu à la
// place d'une quatrième de couverture.
function isCatalogDumping(text) {
  if (!text) return false;
  return /^\s*Genre\s*\/\s*Form/i.test(text)
    || /Additional Physical Format/i.test(text)
    || /^\s*Topics?\s*:/i.test(text)
    || /\bOnline version:\s*[A-Z][a-z]+,\s*[A-Z][a-z]+,?\s*\d{4}/.test(text)
    || /\bLa liste exhaustive\b/i.test(text)
    || /\bliste des (?:éditeurs|editeurs|collections)\b/i.test(text)
    || /\bouvrages disponibles publiés\b/i.test(text)
    || /\basin d['’]édition|base de données des|référencement\b/i.test(text)
    || /\b(?:publié|publiée|publiés|publiées) en langue française dans le monde\b/i.test(text);
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

// ---------------------------------------------------------------------------
// Classification par mots-clés — normalisation du texte
//
// Deux défauts systématiques rendaient « Inconnu » des livres parfaitement
// classables :
//
//  1. LES PLURIELS. Les listes sont écrites au singulier (« robot, vampire,
//     meurtre ») et testées avec `\b…\b`, donc « Un défilé de robots », « Les
//     vampires de Manhattan », « Des meurtres étranges » ne matchaient rien.
//  2. LES ACCENTS. Les listes sont écrites sans accent (« fantome, theatre »)
//     alors que les titres en portent : « Histoires de fantômes », « Le
//     théâtre de… » ne matchaient rien non plus.
//
// On normalise donc le texte — minuscules, accents retirés, pluriel ramené au
// singulier — et on applique EXACTEMENT la même normalisation aux mots-clés.
// Traiter les deux côtés de la même façon garantit que ce qui est ajouté d'un
// côté reste trouvable de l'autre.
//
// Les chiffres sont conservés : « 1914 », « 1939 » sont des marqueurs
// historiques à part entière.
// ---------------------------------------------------------------------------
function normaliserPourClassification(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // é -> e, è -> e, ï -> i…
    .replace(/[^a-z0-9\s-]+/g, ' ')                   // ponctuation, apostrophes
    .split(/\s+/)
    // Pluriel simple : « robots » -> « robot ». On ne touche pas aux mots
    // courts (« les », « pas ») dont la troncature n'apporte rien.
    // Pluriel anglais en -ies : « stories » -> « story », sans quoi la
    // catégorie « Love stories » ne rejoindrait jamais « love story ».
    .map((w) => {
      if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
      return (w.length > 3 && w.endsWith('s')) ? w.slice(0, -1) : w;
    })
    .filter(Boolean)
    .join(' ');
}

// Échapper une chaîne pour l'insérer telle quelle dans une RegExp.
function echapperRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Les 11 genres du Kot, dans l'ORDRE DE PRIORITÉ : le premier qui matche
// gagne. Cet ordre est fonctionnel, pas cosmétique — le Théâtre est placé
// après la Comédie parce que « pièce » décrirait aussi bien une comédie de
// Molière, et l'Essai est dernier car c'est le fourre-tout du non-fiction.
//
// Les mots-clés sont SÉPARÉS PAR DES VIRGULES, pas par des espaces : « vaisseau
// spatial », « coup de foudre », « moyen age » sont des expressions, et les
// découper en mots isolés ferait matcher n'importe quel texte contenant
// « spatial », « foudre » ou « age ». Séparer par des virgules les garde
// entières. Mots écrits au singulier et sans accent : la normalisation fait
// le reste.
const GENRE_KEYWORDS = [
  ['Horreur', 'horreur,horror,epouvante,vampire,fantome,ghost,frisson,demoni,possession,gore,epouvantable'],
  ['Science-fiction', 'science-fiction,sci-fi,dystopi,post-apocalypt,futuriste,cyberpunk,space opera,extra-terrestre,extraterrestre,robot,anticipation,vaisseau spatial,barjavel,teleportation,dystopique'],
  // NOTE sur les mots-clés volontairement absents :
  // « legendaire » était dans Fantasy et « passion »/« sentiment » dans Romance.
  // Ils ne « marchaient » pas auparavant par accident : écrits sans accent, ils
  // ne matchaient jamais un texte français accentué. Une fois l'accent corrigé
  // (plus haut), ils sont devenus vivants et se sont mis à matcher la prose
  // ordinaire — « l'époque légendaire des Mousquetaires » classait « Le Vicomte
  // de Bragelonne » en Fantasy, « ses passions » classait une biographie de
  // Balzac en Romance. Retirés, faute d'être discriminants.
  ['Fantasy', 'fantasy,fantastique,magie,magic,sorcier,sorciere,elfe,nain,dragon,royaume,merlin,enchant,grimoire,feerie,fee'],
  ['Policier', 'policier,detective,mystery,mystere,enquete,commissaire,inspecteur,assassin,meurtre,homicide,crime,sherlock,poirot,vol,cambriolage'],
  ['Thriller', 'thriller,suspense,angoisse,tueur en serie,psychopathe,machination,complot,otage,kidnapping,kidnappe,espion,espionnage,agent secret'],
  ['Romance', 'romance,amour,romantic,amoureuse,amoureux,coup de foudre,je t aime,seduc,divorce,mariage,epouser'],
  ['Historique', 'historique,biographie,biography,memoire,autobiographie,siecle,moyen age,moyen-age,renaissance,antiquite,chateau,napoleon,louis xiv,seconde guerre,premiere guerre,guerre mondiale,1914,1939,1945,baron,prince,princesse,roi,reine,empire,monarchie,archeologie'],
  ['Drame', 'drame,tragique,tragedie,deuil,orphelin,cancer,maladie,coma,mortel,accident,suicide,guerre,exil,prison,larme,pleur,tristesse,separation'],
  ['Comédie', 'comedie,humour,drole,rigolo,amusant,rire,satirique,satire,parodie,burlesque,cocasse,hilarant'],
  // Théâtre — après la Comédie, volontairement (voir plus haut).
  ['Drame', 'theatre,piece de theatre,mythe,antigone,oedipe,sophocle,anouilh,corneille,shakespeare,hamlet,macbeth'],
  ['Aventure', 'aventure,adventure,action,voyage,exploration,survie,naufrage,tresor,ile deserte,jungle,expedition,odyssee,quete'],
  // Essai en dernier. Les marqueurs politiques ont été ajoutés après constat :
  // « Le problème du sud » (Gramsci) restait Inconnu alors que son texte ne
  // parle que de question méridionale et de comités ouvriers.
  ['Essai', 'essai,essay,non-fiction,nonfiction,philosophie,philosophe,politique,sociologie,religion,psychologie,developpement personnel,reflexion,marxisme,marxiste,socialisme,communisme,capitalisme,ideologie,gramsci,lenine,trotsky,mouvement ouvrier,comites ouvrier,manifeste']
  // « economie » est absent lui aussi : il apparaît dans la prose ordinaire
  // (« l'économie de la ville ») et faisait classer « Les dents de la mer » en
  // Essai. En catégorie, en revanche, « Economics » est une affirmation.
];

// Expressions compilées une fois pour toutes : un run en évalue des milliers.
const GENRE_PATTERNS = GENRE_KEYWORDS.map(([genre, mots]) => {
  const termes = mots.split(',').filter(Boolean).map(normaliserPourClassification).filter(Boolean);
  return { genre, pattern: new RegExp('\\b(' + termes.map(echapperRegex).join('|') + ')\\b') };
});

// Classification hybride par analyse textuelle des descriptions pour affiner le genre
function classifyBookText(title, description, categoryText = '') {
  const text = normaliserPourClassification([title, description, categoryText].join(' '));
  for (const { genre, pattern } of GENRE_PATTERNS) {
    if (pattern.test(text)) return genre;
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

// ---------------------------------------------------------------------------
// Interrogation de Google Books
//
// Google dégrade actuellement l'endpoint de RECHERCHE (/volumes?q=…) : il
// renvoie des 503 « backendFailed » par vagues, y compris pour des requêtes
// valides et déjà éprouvées (Publisher Center juil. 2026, Issue Tracker
// 536042535, StackOverflow 56579891 — « the problem appears to be related only
// to search operations using the q URL param »). L'endpoint VOLUME UNIQUE
// (/volumes/{id}) fonctionne, lui, normalement.
//
// La stratégie découle de ce constat :
//   1. si l'identifiant de volume est connu (colonne ID_GoogleBooks de la Sheet
//      ou cache d'un run précédent), on lit /volumes/{id} — déterministe ;
//   2. sinon, et seulement sinon, on passe par la recherche, entourée d'un
//      backoff exponentiel avec gigue (voir httpGet).
// Chaque identifiant résolu est mémorisé dans books-metadata.json afin que les
// runs suivants n'aient plus jamais à chercher.
//
// Notes sur les paramètres :
//   · `langRestrict=fr` a été retiré. Il doublonne inutilement le contrôle de
//     langue des descriptions (acceptDescription) et surtout il réduit le
//     rappel : combiné aux résultats vides géo-dépendants de Google, il
//     faisait passer des livres français existants pour absents.
//   · `printType=books` évite de récupérer des magazines.
//   · il n'existe PAS de paramètre `country` sur cet endpoint : la restriction
//     géographique dépend de l'IP d'appel, pas d'un paramètre.
// ---------------------------------------------------------------------------
async function fetchGoogleBooks(title, author, isbn = '', googleBooksId = '') {
  const keyParam = GOOGLE_BOOKS_API_KEY ? `&key=${GOOGLE_BOOKS_API_KEY}` : '';

  // Signale une fois par run une clé refusée par Google (400), plutôt que de
  // croire, livre après livre, que le livre est absent.
  const signalerSiCleInvalide = (res) => {
    if (res.statusCode !== 400 || cleApiSignalee) return;
    try {
      const j = JSON.parse(res.body);
      if (j.error && j.error.code === 400) {
        cleApiSignalee = true;
        const reasons = ((j.error.errors || []).map((e) => e.reason).filter(Boolean)).join(', ');
        console.error(`   🔑 Google Books a rejeté la requête : ${j.error.message}${reasons ? ' (' + reasons + ')' : ''}`);
        console.error('      Vérifiez que la Books API est activée et que GOOGLE_BOOKS_API_KEY est correcte.');
      }
    } catch (e) { /* corps illisible : sans importance */ }
  };

  // Traduit une réponse Google en erreur métier, ou null si elle est exploitable.
  const erreurGoogle = (res) => {
    if (res.statusCode === 200) return null;
    if (res.statusCode === 429) {
      return classify429(res.body) === 'quota-journalier' ? "DAILY_QUOTA_EXCEEDED" : "TEMPORARY_ERROR";
    }
    if (res.statusCode >= 500) return "TEMPORARY_ERROR";
    return null; // 404/400 : la réponse est définitive, ce n'est pas une panne
  };

  try {
    // 1) Lecture directe par identifiant de volume : l'endpoint qui fonctionne.
    //    Le comptage de quota est fait par httpGet, sur chaque requête réelle.
    if (googleBooksId) {
      const byId = await httpGet(
        `https://www.googleapis.com/books/v1/volumes/${encodeURIComponent(googleBooksId)}?hl=fr${keyParam}`,
        {},
        googleRetryBudget
      );
      const errId = erreurGoogle(byId);
      signalerSiCleInvalide(byId);
      if (!errId && byId.statusCode === 200) {
        const data = JSON.parse(byId.body);
        if (data && data.id) {
          const best = pickBestCandidate(title, author, [data]);
          if (best) return best;
        }
      } else if (errId) {
        throw new Error(errId);
      }
      // 404 ou appariement trop faible : l'identifiant est obsolète, on tente
      // la recherche classique plutôt que d'abandonner le livre.
    }

    // 2) Recherche. Aveugle, donc en dernier recours — mais on n'abandonne PAS
    //    après l'ISBN.
    //
    //    Constat : « Haute pression » (Nicolas Ancion) et « Ma reine »
    //    (Jean-Baptiste Andrea) renvoient `totalItems: 0` par ISBN alors que la
    //    recherche par titre + auteur les trouve, avec description pour l'un et
    //    couverture + description pour l'autre. Un ISBN absent de Google ne veut
    //    donc PAS dire que le livre en est absent : l'ISBN de la BnF désigne
    //    souvent une édition que Google n'a pas indexée sous cette clé.
    //    L'ISBN reste tenté en premier car c'est la requête la plus précise.
    const cleanTitle = title.replace(/['’"()]/g, ' ').replace(/[-\s]+/g, ' ').trim();
    const cleanAuthor = author.replace(/['’"()]/g, ' ').replace(/[-\s]+/g, ' ').trim();
    const requetes = [];
    if (isbn) requetes.push(`isbn:${isbn}`);
    if (cleanTitle) requetes.push(`${cleanTitle} ${cleanAuthor}`.trim());

    for (const q of requetes) {
      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&printType=books&hl=fr&maxResults=5${keyParam}`;
      const res = await httpGet(url, {}, googleRetryBudget);
      const err = erreurGoogle(res);
      signalerSiCleInvalide(res);
      if (err) throw new Error(err);

      if (res.statusCode === 200) {
        const data = JSON.parse(res.body);
        if (data.items && data.items.length > 0) {
          // On parcourt tous les résultats et on ne garde que ceux qui
          // correspondent. Si aucun ne convient, on tente la requête suivante.
          const best = pickBestCandidate(title, author, data.items);
          if (best) return best;
        }
      }
    }

    // Aucun résultat suffisamment proche : on préfère ne rien associer
    // plutôt que d'enregistrer une couverture qui appartient à un autre livre
    return null;
  } catch (err) {
    // Le quota est épuisé ou le serveur est saturé : à remonter à l'appelant
    if (err.message === "DAILY_QUOTA_EXCEEDED" || err.message === "TEMPORARY_ERROR") {
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
    // Les « subjects » de l'oeuvre sont un signal de genre gratuit : on télécharge
    // déjà cette fiche pour la description, autant lire aussi les sujets. Ils
    // manquent souvent, mais quand ils sont là ils sont explicites — la fiche
    // d'« Antigone » porte « Drama », « French drama ».
    let workSubjects = [];
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
        if (Array.isArray(workData.subjects)) {
          workSubjects = workData.subjects.filter((s) => typeof s === 'string');
        }
      }
    }

    // On fusionne les sujets de la recherche et ceux de la fiche d'oeuvre : les
    // deux sont partiels et ne se recouvrent pas.
    const subjects = [...new Set([...(doc.subject || []), ...workSubjects])];

    return {
      title: doc.title,
      author: Array.isArray(doc.author_name) ? doc.author_name.join(' ') : (doc.author_name || ''),
      description: description,
      subjects: subjects,
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

// Journal par livre.
//
// Un run passe en revue 2 181 lignes ;ahn dont la grande majorité ne gagne
// rien. Écrire trois lignes pour chaque livre produit un log de plusieurs
// centaines de lignes où le résultat réel passe inaperçu. On met donc le
// journal de chaque livre en tampon, et on ne l'affiche que si le livre a
// réellement changé — c'est-à-dire s'il a été trouvé, ou si la BnF a ajouté
// une référence. --verbose rétablit le journal exhaustif.
const VERBOSE = process.argv.includes('--verbose');
let journalCourant = [];
// Nombre de livres ayant réellement rapporté quelque chose depuis la dernière
// sauvegarde : sans cela, « Progression sauvegardée » s'affiche une centaine
// de fois sur un run complet.
let gainsDepuisSauvegarde = 0;

function dire(ligne) {
  if (VERBOSE) {
    console.log(ligne);
    return;
  }
  journalCourant.push(ligne);
}

function viderJournal(garder) {
  if (journalCourant.length) {
    if (garder) {
      for (const l of journalCourant) console.log(l);
      gainsDepuisSauvegarde++;
    }
    journalCourant = [];
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

  // 3a. Contrôle des genres déjà en cache contre les 11 du Kot, et des
  //     descriptions déjà en cache contre la porte française.
  //
  //     Deux contrôles, parce que deux valeurs n'ont jamais été validées :
  //     · un genre hors liste fait disparaître un livre des filtres du site
  //       sans le moindre message ;
  //     · une description en espagnol ou une notice de catalogue était
  //       conservée telle quelle et faisait croire le livre renseigné — donc
  //       complet — alors qu'elle ne vaut rien.
  //     Le nettoyage ne touche pas les décisions humaines (overrides).
  let genresNettoyes = 0;
  let descriptionsNettoyees = 0;
  for (const slug of Object.keys(metadata)) {
    const entree = metadata[slug];
    if (!entree) continue;

    const g = entree.genre;
    if (g !== undefined && g !== null && g !== '' && !genreValide(g)) {
      if (genresNettoyes < 10) {
        console.error(`   ⚠️  Genre hors des 11 du Kot dans le cache : "${g}" → Inconnu (${slug})`);
      }
      entree.genre = 'Inconnu';
      genresNettoyes++;
    }

    // Une description non conforme est retirée du cache : elle sera remplacée
    // par une vraie au prochain passage, ou laissée vide. Laisser une
    // description espagnole en place la faisait passer pour un livre complet.
    if (overrides[slug]) continue;
    if (entree.description && !acceptDescription(entree.description).keep) {
      if (descriptionsNettoyees < 10) {
        const r = acceptDescription(entree.description);
        console.error(`   ⚠️  Description non conforme retiree (${r.reason}) : ${slug}`);
      }
      entree.description = '';
      descriptionsNettoyees++;
    }
  }
  if (genresNettoyes > 0) {
    console.log(`🧹 Genres hors des 11 du Kot ramenés à « Inconnu » : ${genresNettoyes}`);
  }
  if (descriptionsNettoyees > 0) {
    console.log(`🧹 Descriptions non françaises ou notices de catalogue retirees du cache : ${descriptionsNettoyees}`);
  }

  // 3b. Mettre à jour les genres des livres déjà en cache à l'aide de l'analyse textuelle locale
  let localUpdates = 0;
  Object.keys(metadata).forEach(slug => {
    if (overrides[slug]) return; // décision humaine : ne pas y toucher
    const book = metadata[slug];
    if (book && book.description && (!book.genre || book.genre === 'Inconnu')) {
      // Les sujets Open Library éventuellement mis en cache sont joints au
      // texte : ils portent souvent le genre (« Drama », « Detective ») là où
      // la description, elle, n'a aucun mot-clé.
      const sujets = Array.isArray(book.subjects) ? book.subjects.join(' ') : '';
      const resolvedGenre = classifyBookText(book.title || '', book.description, sujets);
      if (resolvedGenre !== 'Inconnu') {
        book.genre = normaliserGenre(resolvedGenre);
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
  // Le nettoyage des genres et des descriptions modifie lui aussi le cache :
  // il doit être enregistré, sinon il serait perdu au prochain run.
  if ((genresNettoyes > 0 || descriptionsNettoyees > 0) && localUpdates === 0) {
    try {
      fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
    } catch (e) {
      console.error("⚠️ Impossible d'enregistrer le nettoyage du cache :", e.message);
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
        genre: normaliserGenre(o.genre || metadata[slug]?.genre || 'Inconnu'),
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
    
    dire(`\n🔍 [${i+1}/${books.length}] Enrichissement de: "${titre}" par "${auteur}"`);
    
    // Extraction des clés d'identifiants prioritaires depuis la ligne Google Sheet
    let isbn = (book.ISBN || '').toString().trim();
    let googleBooksId = (book.ID_GoogleBooks || '').toString().trim();
    const sheetIsbn = isbn;

    // L'identifiant de volume Google Books déjà résolu lors d'un run précédent
    // est réutilisé : il permet de lire /volumes/{id}, endpoint qui fonctionne,
    // au lieu de /volumes?q=, renvoyant des 503 par vagues. Chaque livre n'a
    // donc besoin de passer par la recherche qu'une seule fois, après quoi il
    // est servi par une lecture fiable et économique.
    if (!googleBooksId && entree && entree.googleBooksId) {
      googleBooksId = entree.googleBooksId;
      dire(`   🔖 Identifiant Google Books réutilisé du cache (${googleBooksId})`);
    }

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
        dire('   📚 Aucune notice BnF — le livre sera marqué pour revue humaine');
      } else if (!bnf.confirmed) {
        dire(`   📚 Notice BnF non confirmée (titre ${bnf.match.titleScore}, auteur ${bnf.match.authorScore}) — recherche sans ISBN BnF`);
      } else if (bnf.isbn) {
        isbn = bnf.isbn;
        dire(`   📚 BnF confirmée : "${bnf.notifTitle}"${bnf.publisher ? ' (' + bnf.publisher + (bnf.pubDate ? ', ' + bnf.pubDate : '') + ')' : ''} — ISBN ${isbn}`);
      } else {
        dire(`   📚 BnF confirmée : "${bnf.notifTitle}"${bnf.publisher ? ' (' + bnf.publisher + (bnf.pubDate ? ', ' + bnf.pubDate : '') + ')' : ''} — mais sans ISBN dans la notice`);
      }
    } else if (bnf && bnf.fromCache) {
      dire(`   📚 Référence BnF réutilisée du cache (ISBN ${isbn})`);
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
    //    rarement en français et le contrôle de langue les rejettera de toute
    //    façon.
    //
    //    On ne renseigne PLUS enrichedData ici. Le faire déclenchait le
    //    « if (!enrichedData) » de l'étape Google et court-circuitait la
    //    recherche : ces livres n'obtenaient alors jamais de description ni de
    //    genre (12 des 13 concernés sont toujours « Inconnu »). La couverture
    //    est donc mise de côté et fusionnée plus loin.
    let couvertureOl = '';
    if (isbn && !hasOverride) {
      const olIsbn = await fetchOpenLibraryCoverByIsbn(isbn);
      if (olIsbn && olIsbn.coverUrl) {
        couvertureOl = olIsbn.coverUrl;
        dire(`   📗 Couverture Open Library trouvée par ISBN ${isbn}`);
      }
    }

    // 2) Google Books, sauf si le coupe-circuit est ouvert.
    //    Le refroidissement est temporaire : après Google_COOLDOWN_MIN on
    //    réessaie, la panne pouvant être finie. Le coupe-circuit est désactivé
    //    par défaut (GOOGLE_BREAKER=1 pour l'activer) : face à une panne
    //    partielle permanente il coupait Google du run entier.
    const now = Date.now();
    const googleCooling = now < googleSkipUntil;
    if (GOOGLE_BREAKER && now >= googleSkipUntil && googleUnhealthy()) {
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
              dire(`   🚫 Description écartée (${descCheck.reason})`);
            }

            // Mappage des genres (hybride : catégories + description/titre).
            // Les catégories servent AUSSI de matière au classifieur textuel
            // quand le mapping par mots-clés échoue : elles étaient auparavant
            // jetées, alors qu'elles sont souvent le meilleur indice disponible.
            const categoriesTexte = (info.categories || []).join(' ');
            let genre = mapCategoryToGenre(info.categories);
            if (genre === 'Inconnu') {
              genre = classifyBookText(titre, desc, categoriesTexte);
            }
            // Filet de sécurité : quoi qu'il arrive, le genre écrit est l'un
            // des 11 du Kot (ou « Inconnu »).
            genre = normaliserGenre(genre);

            // Extraire la couverture. La couverture Open Library obtenue par
            // ISBN fait office de repli : une réponse Google sans image ne doit
            // pas la faire disparaître (le point de fusion plus bas privilégie
            // enrichedData.coverUrl).
            let cover = couvertureOl;
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
              // Identifiant de volume Google Books : une fois connu, les runs
              // suivants lisent /volumes/{id} (endpoint fiable) au lieu de
              // passer par la recherche (endpoint dégradé, ~80 % de 503).
              // Fait partie de la réponse de pickBestCandidate, pas de volumeInfo.
              googleBooksId: (gbResult.item && gbResult.item.id) || googleBooksId || '',
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
          // La panne est enregistrée dans la fenêtre de santé de Google, que
          // l'erreur soit transitoire ou un épuisement de quota.
          noteGoogleResult(false);
          apiCallsCount--;

          if (err.message === "DAILY_QUOTA_EXCEEDED") {
            console.error("🛑 Quota journalier Google Books épuisé (429, quota journalier).");
            console.error('   Le reste du catalogue sera traité au prochain run ; relancez demain.');
            quotaReached = true;
            viderJournal(false);
            break;
          }
          if (err.message === "TEMPORARY_ERROR") {
            // Google est saturé (503/429 par minute). On n'inscrit pas le livre
            // comme "absent" : on conserve ce que la BnF a permis d'établir
            // (ISBN, éditeur, année) et on le laisse ouvert pour un nouvel essai.
            temporaryErrorCount++;

            if (bnfInfo && (bnfInfo.isbn || bnfInfo.publisher || bnfInfo.publishedDate)) {
              const dejaConnu = metadata[slug];
              metadata[slug] = Object.assign({}, dejaConnu || {}, {
                title: titre,
                author: auteur,
                // On ne remplace la description que si elle est absente ou non française
                description: dejaConnu && acceptDescription(dejaConnu.description).keep
                  ? dejaConnu.description : '',
                genre: dejaConnu && dejaConnu.genre ? normaliserGenre(dejaConnu.genre) : 'Inconnu',
                coverUrl: (dejaConnu ? (dejaConnu.coverUrl || '') : '') || couvertureOl,
                isbn: bnfInfo.isbn || (dejaConnu ? dejaConnu.isbn : '') || sheetIsbn,
                publisher: bnfInfo.publisher,
                publishedDate: bnfInfo.publishedDate,
                bnfRef: bnfInfo.bnfRef,
                needsReview: true,
                source: 'bnf_only',
                enrichedAt: new Date().toISOString()
              });
              dire('   📚 Données BnF conservées (ISBN, éditeur, année) malgré la panne.');
            } else {
              dire('   ⚠️ Google Books indisponible et aucune donnée BnF — livre laissé intact.');
            }
            // Pendant une panne, ces lignes se répètent sur des dizaines de
            // livres : le message de synthèse l'explique déjà.
            viderJournal(false);
            continue;
          }
      }
    }
    }   // fin du else (Google) et du if (!enrichedData)

    // 3) Dernier recours : Open Library par titre + auteur
    if (!enrichedData && !quotaReached) {
      dire(`   -> Fallback Open Library...`);
      const olResult = await fetchOpenLibrary(titre, auteur, isbn);
      if (olResult) {
        // Idem : les sujets alimentent aussi le classifieur textuel quand le
        // mapping par mots-clés échoue.
        const sujetsTexte = (olResult.subjects || []).join(' ');
        let genre = mapCategoryToGenre(olResult.subjects);
        if (genre === 'Inconnu') {
          genre = classifyBookText(titre, olResult.description || '', sujetsTexte);
        }
        genre = normaliserGenre(genre);
        let cover = '';
        if (olResult.coverId) {
          cover = `https://covers.openlibrary.org/b/id/${olResult.coverId}-L.jpg`;
        }
        // La couverture obtenue par ISBN fait toujours office de repli.
        if (!cover) cover = couvertureOl;
        // Contrôle de langue sur la description Open Library
        const olDescCheck = acceptDescription(olResult.description || '');
        if (olResult.description && !olDescCheck.keep) {
          dire(`   🚫 Description Open Library écartée (${olDescCheck.reason})`);
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
          // Sujets Open Library conservés (nombre borné) : ils permettent de
          // reclasser le livre plus tard sans nouvel appel réseau, exactement
          // comme googleBooksId le fait pour la recherche.
          subjects: (olResult.subjects || []).slice(0, 25),
          publisher: bnfInfo ? bnfInfo.publisher : '',
          publishedDate: bnfInfo ? bnfInfo.publishedDate : '',
          bnfRef: bnfInfo ? bnfInfo.bnfRef : '',
          needsReview: false,
          enrichedAt: new Date().toISOString(),
          source: 'open_library'
        };
      }
    }

    // 4) Faute de mieux, la couverture obtenue par ISBN est au moins
    //    enregistrée. C'est l'ancien comportement de l'étape 1, devenu
    //    dernier recours au lieu d'écraser Google.
    if (!enrichedData && couvertureOl) {
      enrichedData = {
        title: titre,
        author: auteur,
        resolvedTitle: titre,
        resolvedAuthor: auteur,
        description: '',
        genre: 'Inconnu',
        coverUrl: couvertureOl,
        isbn: isbn,
        verified: true,
        matchScore: { ok: true, titleScore: 1, authorScore: 1 },
        publisher: bnfInfo ? bnfInfo.publisher : '',
        publishedDate: bnfInfo ? bnfInfo.publishedDate : '',
        bnfRef: bnfInfo ? bnfInfo.bnfRef : '',
        needsReview: false,
        enrichedAt: new Date().toISOString(),
        source: 'open_library_isbn'
      };
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
        // Dernier passage par les 11 genres du Kot : quoi que la source ait
        // renvoyé, la valeur écrite fait partie de la liste du site.
        genre: normaliserGenre((enrichedData.genre && enrichedData.genre !== 'Inconnu')
          ? enrichedData.genre : (dejaConnu.genre || 'Inconnu')),
        publisher: enrichedData.publisher || dejaConnu.publisher || '',
        publishedDate: enrichedData.publishedDate || dejaConnu.publishedDate || '',
        bnfRef: enrichedData.bnfRef || dejaConnu.bnfRef || '',
        isbn: enrichedData.isbn || dejaConnu.isbn || sheetIsbn || ''
      });
      successCount++;
      if (bnf && bnf.confirmed) bnfConfirmedCount++;
      dire(`   ✅ Trouvé! Genre: ${metadata[slug].genre} | Source: ${metadata[slug].source}`);
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
        genre: normaliserGenre(dejaConnu.genre && dejaConnu.genre !== 'Inconnu' ? dejaConnu.genre : 'Inconnu'),
        coverUrl: dejaConnu.coverUrl || couvertureOl || '',
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
      dire(`   ❌ Rien de neuf. ${metadata[slug].coverUrl ? 'Couverture conservée.' : 'Toujours sans couverture.'}${bnf && bnf.confirmed ? ' Référence BnF conservée.' : ''}`);
    }

    // Ce livre a-t-il réellement rapporté quelque chose ? Si oui on montre son
    // journal, sinon on le jette : c'est ce qui transforme un log de mille
    // lignes en une dizaine.
    viderJournal(!!enrichedData || !!(bnf && bnf.confirmed));

    // Sauvegarder périodiquement pour ne pas perdre la progression. Le fichier
    // est réécrit dans tous les cas : c'est une garantie de ne rien perdre si
    // le run s'interrompt. Seule la ligne de journal est conditionnelle, pour
    // ne pas annoncer une sauvegarde qui n'a rien changé.
    const totalProcessed = successCount + failureCount;
    if (totalProcessed > 0 && totalProcessed % 15 === 0) {
      try {
        fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2), 'utf-8');
        if (VERBOSE || gainsDepuisSauvegarde > 0) {
          console.log(`   💾 Progression sauvegardée périodiquement (${totalProcessed} nouveaux livres enregistrés).`);
        }
        gainsDepuisSauvegarde = 0;
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
  if (genresNettoyes > 0) {
    console.log(`🧹 Genres hors des 11 du Kot corrigés dans le cache : ${genresNettoyes}`);
  }
  if (genresHorsListe > 0) {
    console.log(`⚠️  Genres hors des 11 du Kot ignorés pendant ce run : ${genresHorsListe}`);
  }
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

// Le script s'auto-exécute lorsqu'on le lance directement, mais reste
// importable : review-cli.js réutilise ces fonctions plutôt que de les
// recopier, pour n'avoir qu'une seule implémentation du scoring, du
// contrôle de langue et du nettoyage des données BnF.
if (require.main === module) {
  enrich();
}

module.exports = {
  enrich,
  fetchBnF,
  fetchOpenLibrary,
  fetchOpenLibraryCoverByIsbn,
  fetchGoogleBooks,
  httpGet,
  backoffDelay,
  classify429,
  detectLanguage,
  acceptDescription,
  isCatalogDumping,
  classifyBookText,
  mapCategoryToGenre,
  genreValide,
  normaliserGenre,
  normaliserPourClassification,
  GENRE_KEYWORDS,
  CATEGORY_KEYWORDS,
  VALID_GENRES,
  matchScore,
  scoreTitle,
  scoreAuthor,
  cleanPublisher,
  extractYear,
  normalizeIsbn,
  slugify,
  googleUnhealthy,
  SHEET_URL,
  // Réexportés pour rendre les seuils observables depuis les tests.
  config: {
    RETRY_ON_5XX,
    RETRY_BASE_MS,
    RETRY_MAX_MS,
    GOOGLE_DAILY_CAP,
    GOOGLE_BREAKER,
    GOOGLE_WINDOW,
    GOOGLE_UNHEALTHY_RATE,
    GOOGLE_MIN_SAMPLES,
    VALID_GENRES,
    LANG_MIN_DENSITY,
    LANG_MIN_HITS,
    LANG_ES_MIN_HITS,
    LANG_ES_MIN_DENSITY
  }
};
