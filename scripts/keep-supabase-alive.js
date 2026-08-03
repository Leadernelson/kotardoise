/**
 * Script de Maintien d'Activité Supabase (Keep-Alive)
 * Prévient la mise en pause automatique de Supabase après 7 jours d'inactivité.
 *
 * Utilise des requêtes multi-stratégies (GET no-cache, POST GraphQL, Schema PostgREST)
 * avec parametres d'invalidation de cache (?_t=timestamp) et en-têtes strictes
 * pour forcer l'exécution de requêtes réelles dans la base de données PostgreSQL.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Effectue une requête HTTP/HTTPS générique
 */
function makeRequest(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(urlStr);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
          ...(options.headers || {})
        }
      };

      const req = client.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            body: data
          });
        });
      });

      req.on('error', (err) => reject(err));
      
      if (options.body) {
        req.write(options.body);
      }
      
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function run() {
  console.log("==================================================");
  console.log("  Supabase Keep-Alive Ping - KotArdoise");
  console.log("==================================================");

  // Supabase URL avec valeur par défaut sur l'ID de projet indiqué (avtiilzkumsivkmofjaf)
  const defaultProjectUrl = 'https://avtiilzkumsivkmofjaf.supabase.co';
  const supabaseUrl = (process.env.SUPABASE_URL || defaultProjectUrl).trim().replace(/\/$/, '');
  const rawKey = process.env.SUPABASE_ANON_KEY || process.argv[2] || '';
  const supabaseKey = rawKey.trim();
  const siteUrl = (process.env.SITE_URL || '').trim();

  console.log(`📌 Target Supabase Project: ${supabaseUrl}`);

  if (!supabaseKey) {
    console.warn("⚠️ SUPABASE_ANON_KEY n'est pas définie dans l'environnement !");
    console.warn("   Pour un ping complet avec authentification, veuillez configurer la clé anon dans les GitHub Secrets.");
  }

  let successCount = 0;
  let totalAttempts = 0;

  const authHeaders = supabaseKey ? {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`
  } : {};

  // ----------------------------------------------------
  // Stratégie 1: Request REST API Table avec Invalidation Cache & Count
  // ----------------------------------------------------
  totalAttempts++;
  const timestamp = Date.now();
  const restUrl = `${supabaseUrl}/rest/v1/reviews?select=id&limit=1&_t=${timestamp}`;
  console.log(`\n📡 [1/4] Ping REST API Supabase (PostgREST DB Query)...`);
  try {
    const res = await makeRequest(restUrl, {
      method: 'GET',
      headers: {
        ...authHeaders,
        'Prefer': 'count=exact'
      }
    });
    if (res.ok) {
      console.log(`   ✅ REST API Réussie (HTTP ${res.statusCode})`);
      successCount++;
    } else {
      console.error(`   ⚠️ REST API Réponse HTTP ${res.statusCode}: ${res.body.substring(0, 200)}`);
    }
  } catch (err) {
    console.error(`   ❌ REST API Erreur: ${err.message}`);
  }

  // ----------------------------------------------------
  // Stratégie 2: Requête POST GraphQL (Bypasse 100% le cache CDN)
  // ----------------------------------------------------
  totalAttempts++;
  const graphqlUrl = `${supabaseUrl}/graphql/v1?_t=${timestamp}`;
  console.log(`\n📡 [2/4] Ping GraphQL API Supabase (Requête POST Directe DB)...`);
  try {
    const res = await makeRequest(graphqlUrl, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query: 'query { reviewsCollection(first: 1) { edges { node { id } } } }' })
    });
    if (res.ok) {
      console.log(`   ✅ GraphQL API Réussie (HTTP ${res.statusCode})`);
      successCount++;
    } else {
      console.error(`   ⚠️ GraphQL API Réponse HTTP ${res.statusCode}: ${res.body.substring(0, 200)}`);
    }
  } catch (err) {
    console.error(`   ❌ GraphQL API Erreur: ${err.message}`);
  }

  // ----------------------------------------------------
  // Stratégie 3: Inspection OpenAPI / Schema Supabase REST Root
  // ----------------------------------------------------
  totalAttempts++;
  const schemaUrl = `${supabaseUrl}/rest/v1/?_t=${timestamp}`;
  console.log(`\n📡 [3/4] Ping Schema Root PostgREST...`);
  try {
    const res = await makeRequest(schemaUrl, {
      method: 'GET',
      headers: authHeaders
    });
    if (res.ok) {
      console.log(`   ✅ Schema Root Réussi (HTTP ${res.statusCode})`);
      successCount++;
    } else {
      console.error(`   ⚠️ Schema Root Réponse HTTP ${res.statusCode}: ${res.body.substring(0, 200)}`);
    }
  } catch (err) {
    console.error(`   ❌ Schema Root Erreur: ${err.message}`);
  }

  // ----------------------------------------------------
  // Stratégie 4: Health Check Service Auth / GoTrue
  // ----------------------------------------------------
  totalAttempts++;
  const authHealthUrl = `${supabaseUrl}/auth/v1/health?_t=${timestamp}`;
  console.log(`\n📡 [4/4] Ping Service Auth (Health Check)...`);
  try {
    const res = await makeRequest(authHealthUrl, {
      method: 'GET',
      headers: authHeaders
    });
    if (res.ok) {
      console.log(`   ✅ Auth Health Check Réussi (HTTP ${res.statusCode})`);
      successCount++;
    } else {
      console.error(`   ⚠️ Auth Health Check HTTP ${res.statusCode}: ${res.body.substring(0, 200)}`);
    }
  } catch (err) {
    console.error(`   ❌ Auth Health Check Erreur: ${err.message}`);
  }

  // ----------------------------------------------------
  // Stratégie Optionnelle: Site Netlify
  // ----------------------------------------------------
  if (siteUrl) {
    const cleanSiteUrl = siteUrl.replace(/\/$/, '');
    const netlifyUrl = cleanSiteUrl.includes('.netlify/functions') 
      ? `${cleanSiteUrl}?_t=${timestamp}`
      : `${cleanSiteUrl}/.netlify/functions/reviews?_t=${timestamp}`;
      
    console.log(`\n📡 Ping API Netlify: ${netlifyUrl}`);
    try {
      const res = await makeRequest(netlifyUrl);
      if (res.ok) {
        console.log(`   ✅ API Netlify Réussie (HTTP ${res.statusCode})`);
        successCount++;
      } else {
        console.error(`   ⚠️ API Netlify HTTP ${res.statusCode}: ${res.body.substring(0, 200)}`);
      }
    } catch (err) {
      console.error(`   ❌ API Netlify Erreur: ${err.message}`);
    }
  }

  console.log("\n==================================================");
  console.log(`  Résultats Ping: ${successCount} succès sur ${totalAttempts} requêtes`);
  console.log("==================================================");

  if (successCount > 0) {
    console.log("🎉 Activité Supabase enregistrée avec succès ! La base de données reste active.");
    process.exit(0);
  } else {
    console.error("❌ Échec de toutes les pings. Vérifiez l'URL de votre projet ou les identifiants Supabase dans GitHub Secrets.");
    process.exit(1);
  }
}

run();

