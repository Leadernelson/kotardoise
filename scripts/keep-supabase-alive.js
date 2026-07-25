/**
 * Script de Maintien d'Activité Supabase (Keep-Alive)
 * Prévient la mise en pause automatique de Supabase après 7 jours d'inactivité.
 */

const https = require('https');
const { URL } = require('url');

function makeRequest(urlStr, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(urlStr);
      const reqOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: headers
      };

      const req = https.request(reqOptions, (res) => {
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
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function run() {
  console.log("--------------------------------------------------");
  console.log("  Supabase Keep-Alive Ping - KotArdoise");
  console.log("--------------------------------------------------");

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const siteUrl = process.env.SITE_URL;

  let pinged = false;

  if (supabaseUrl && supabaseKey) {
    const targetUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/reviews?select=id&limit=1`;
    console.log(`📡 Ping de l'API Supabase direct: ${supabaseUrl}`);
    try {
      const res = await makeRequest(targetUrl, {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`
      });
      if (res.ok) {
        console.log(`✅ Succès Supabase Direct (Code HTTP ${res.statusCode})`);
        pinged = true;
      } else {
        console.error(`⚠️ Erreur Supabase Direct (Code HTTP ${res.statusCode}): ${res.body}`);
      }
    } catch (err) {
      console.error(`❌ Échec de la requête Supabase Direct: ${err.message}`);
    }
  }

  if (siteUrl) {
    const cleanSiteUrl = siteUrl.replace(/\/$/, '');
    const targetUrl = cleanSiteUrl.includes('.netlify/functions') 
      ? cleanSiteUrl 
      : `${cleanSiteUrl}/.netlify/functions/reviews`;
      
    console.log(`📡 Ping de l'API du site Netlify: ${targetUrl}`);
    try {
      const res = await makeRequest(targetUrl);
      if (res.ok) {
        console.log(`✅ Succès API Netlify (Code HTTP ${res.statusCode})`);
        pinged = true;
      } else {
        console.error(`⚠️ Erreur API Netlify (Code HTTP ${res.statusCode}): ${res.body}`);
      }
    } catch (err) {
      console.error(`❌ Échec de la requête API Netlify: ${err.message}`);
    }
  }

  if (!supabaseUrl && !siteUrl) {
    console.warn("⚠️ Aucune variable SUPABASE_URL ni SITE_URL configurée.");
    console.warn("Veuillez ajouter SUPABASE_URL et SUPABASE_ANON_KEY (ou SITE_URL) dans les GitHub Repository Secrets.");
    process.exit(1);
  }

  if (pinged) {
    console.log("🎉 Supabase a enregistré l'activité. La base de données reste active!");
    process.exit(0);
  } else {
    console.error("❌ Échec du ping. Vérifiez vos identifiants ou l'URL.");
    process.exit(1);
  }
}

run();
