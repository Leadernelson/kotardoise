const https = require('https');
const { URL } = require('url');

// CAPTCHAs simples et efficaces contre les robots
const CAPTCHA_CHALLENGES = [
  { id: 'kap', question: "Quel est le nom de notre Kot ? (en un mot, minuscule)", answer: "kotardoise" },
  { id: 'math', question: "Combien font trois plus quatre ? (écrire le chiffre)", answer: "7" },
  { id: 'pays', question: "Dans quel pays se trouve Louvain-la-Neuve ? (minuscule)", answer: "belgique" }
];

// En-mémoire temporaire si Supabase n'est pas encore configuré (pour test immédiat)
let mockReviews = [
  {
    id: "mock-1",
    created_at: new Date(Date.now() - 3600000 * 2).toISOString(),
    book_slug: "l-etranger",
    book_title: "L'Étranger",
    author_name: "Jean UCL",
    rating: 5,
    comment: "Un chef d'œuvre absolu de Camus. La modale de détails du site est superbe et rend la lecture agréable !"
  },
  {
    id: "mock-2",
    created_at: new Date(Date.now() - 3600000 * 24).toISOString(),
    book_slug: "1984",
    book_title: "1984",
    author_name: "SarahL",
    rating: 4,
    comment: "Toujours aussi terrifiant et d'actualité. Emprunté au Kot en bon état."
  }
];

// Fonction fetch universelle compatible toutes versions de Node (sans npm install)
async function supabaseFetch(url, options = {}) {
  const fetchFn = typeof global.fetch === 'function' ? global.fetch : null;
  if (fetchFn) {
    return fetchFn(url, options);
  }
  
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    };
    
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          json: async () => JSON.parse(data),
          text: async () => data,
          ok: res.statusCode >= 200 && res.statusCode < 300
        });
      });
    });
    
    req.on('error', (err) => reject(err));
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

exports.handler = async (event, context) => {
  const method = event.httpMethod;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const isConfigured = SUPABASE_URL && SUPABASE_ANON_KEY;

  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (method === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    // 1. Route Challenge CAPTCHA (GET /api/reviews?challenge=true)
    if (method === 'GET' && event.queryStringParameters && event.queryStringParameters.challenge === 'true') {
      const randomIndex = Math.floor(Math.random() * CAPTCHA_CHALLENGES.length);
      const challenge = CAPTCHA_CHALLENGES[randomIndex];
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ id: challenge.id, question: challenge.question })
      };
    }

    // 2. Route Lecture (GET /api/reviews)
    if (method === 'GET') {
      const slug = event.queryStringParameters ? event.queryStringParameters.slug : null;

      if (!isConfigured) {
        // Mode Mock si Supabase n'est pas configuré
        const data = slug 
          ? mockReviews.filter(r => r.book_slug === slug)
          : mockReviews;
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ source: "mock", data })
        };
      }

      // Mode Supabase
      let url = `${SUPABASE_URL}/rest/v1/reviews?select=*&order=created_at.desc`;
      if (slug) {
        url += `&book_slug=eq.${encodeURIComponent(slug)}`;
      } else {
        url += `&limit=50`; // Limiter le flux global aux 50 dernières critiques
      }

      const response = await supabaseFetch(url, {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
        }
      });

      if (!response.ok) {
        throw new Error(`Erreur Supabase: ${response.status}`);
      }

      const data = await response.json();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ source: "supabase", data })
      };
    }

    // 3. Route Écriture (POST /api/reviews)
    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const { book_slug, book_title, author_name, rating, comment, captchaId, captchaAnswer } = body;

      // Validation de base des données
      if (!book_slug || !book_title || !author_name || !rating || !comment || !captchaId || !captchaAnswer) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Tous les champs sont requis." })
        };
      }

      if (rating < 1 || rating > 5) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "La note doit être comprise entre 1 et 5." })
        };
      }

      // Validation du CAPTCHA
      const challenge = CAPTCHA_CHALLENGES.find(c => c.id === captchaId);
      if (!challenge || captchaAnswer.trim().toLowerCase() !== challenge.answer) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: "Réponse anti-robot incorrecte." })
        };
      }

      const newReview = {
        id: Math.random().toString(36).substring(2, 11),
        created_at: new Date().toISOString(),
        book_slug,
        book_title,
        author_name: author_name.trim().substring(0, 50),
        rating: parseInt(rating),
        comment: comment.trim().substring(0, 1000)
      };

      if (!isConfigured) {
        // Enregistrer temporairement dans le mock en local memory
        mockReviews.unshift(newReview);
        return {
          statusCode: 201,
          headers,
          body: JSON.stringify({ source: "mock", data: newReview })
        };
      }

      // Mode Supabase
      const url = `${SUPABASE_URL}/rest/v1/reviews`;
      const response = await supabaseFetch(url, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify(newReview)
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Supabase error detail:", errorText);
        throw new Error(`Erreur d'insertion Supabase: ${response.status}`);
      }

      const inserted = await response.json();
      return {
        statusCode: 201,
        headers,
        body: JSON.stringify({ source: "supabase", data: inserted[0] })
      };
    }

    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "Méthode non autorisée." })
    };

  } catch (error) {
    console.error("Reviews function error:", error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message || "Erreur interne du serveur." })
    };
  }
};
