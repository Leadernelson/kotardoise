exports.handler = async (event, context) => {
  // Gérer les CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Gérer les requêtes OPTIONS (preflight)
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers,
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { query, booksData } = JSON.parse(event.body);

    if (!query || !booksData) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Query and booksData are required' })
      };
    }

    // Votre clé API Gemini (gardée secrète côté serveur)
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    
    if (!GEMINI_API_KEY) {
      console.error('❌ GEMINI_API_KEY non configurée');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'API key not configured. Please set GEMINI_API_KEY in Netlify environment variables.' })
      };
    }

    console.log('✅ GEMINI_API_KEY trouvée');

    // Compress the dataset into a token-efficient form but still include ALL books.
    // We use short keys and truncate long free-text fields. This preserves the
    // full catalogue while drastically reducing token usage so the LLM can
    // consume the entire dataset in one request.

    function compactBooks(books) {
      return books.map(b => {
        // Normalize common keys and fallbacks - support both French and English field names
        const isbn = (b.isbn || b.ISBN || b.code || b.id || '') + '';
        const id = b.id || b.index || ''; // ID unique pour les livres sans ISBN
        const title = (b.title || b.titre || b.name || '').replace(/\s+/g, ' ').trim();
        const author = (b.author || b.auteur || b.authors || b.writer || '').toString().replace(/\s+/g, ' ').trim();
        const desc = (b.description || b.desc || b.summary || b.notes || '').replace(/\s+/g, ' ').trim();
        const chars = (Array.isArray(b.characters) ? b.characters.join(', ') : (b.characters || b.people || '')).toString().replace(/\s+/g, ' ').trim();
        const tags = (b.tags || b.genres || b.categories || b.genre || []).slice(0,6);

        return {
          i: id || isbn || '',     // i = id (primary) or isbn (fallback)
          t: title.slice(0, 140), // t = title (truncate)
          a: author.slice(0, 80), // a = author (truncate)
          d: desc.slice(0, 300), // d = description (truncate)
          c: chars.slice(0, 200), // c = characters (truncate)
          g: tags // g = genres/tags (small array)
        };
      });
    }

    const compacted = compactBooks(booksData);

    // Limiter le nombre de livres si le dataset est trop volumineux pour l'IA
    let finalCompacted = compacted;
    let datasetNote = '';
    
    if (compacted.length > 2000) {
      // Pour les très gros volumes, prendre un échantillon intelligent
      console.log(`📊 Dataset trop volumineux (${compacted.length} livres), création d'échantillon représentatif...`);
      
      // Prendre les premiers 1500 livres + un échantillon des derniers pour diversité
      finalCompacted = compacted.slice(0, 1500);
      if (compacted.length > 1500) {
        const remaining = compacted.length - 1500;
        const sampleSize = Math.min(500, remaining);
        const step = Math.max(1, Math.floor(remaining / sampleSize));
        
        for (let i = 1500; i < compacted.length; i += step) {
          finalCompacted.push(compacted[i]);
        }
      }
      
      datasetNote = ` (échantillon de ${finalCompacted.length} livres sur ${compacted.length} total)`;
    }

    // Minimal JSON string (no spacing) to reduce token count further
    const compactJson = JSON.stringify(finalCompacted);

    const prompt = `You are an expert librarian AI assistant specializing in book recommendations. Your task is to find books that match the user's query from the provided book catalog.

USER QUERY: "${query}"

BOOK CATALOG FORMAT:
Each book has these fields:
- i: Unique ID (can be ISBN or numeric index for books without ISBN)
- t: Title 
- a: Author
- d: Description/summary
- c: Characters (if available)
- g: Genres/categories

INSTRUCTIONS:
1. Analyze the entire book catalog below
2. Find ALL books that are relevant to the user's query
3. Consider semantic meaning, not just exact keyword matches
4. Include books that are thematically related or have similar content
5. Return results ordered by relevance (most relevant first)

OUTPUT FORMAT:
Return ONLY a JSON array of unique IDs, like: ["9781234567890", "42", "9780987654321", "15"]
- Use the "i" field value from each matching book
- Use double quotes around each ID
- No extra text, comments, or formatting
- If no matches found, return: []

BOOK CATALOG${datasetNote}:
${compactJson}
`;

    console.log(`🤖 Recherche IA EXHAUSTIVE pour "${query}" sur ${booksData.length} livres`);
    console.log(`📊 Données compactées: ${compacted.length} livres, taille: ${JSON.stringify(compacted).length} caractères`);
    if (datasetNote) console.log(`📊 Utilisation d'échantillon: ${finalCompacted.length} livres${datasetNote}`);

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{
            text: prompt
          }]
        }],
        generationConfig: {
          // Balanced configuration for semantic search
          temperature: 0.1,
          topK: 40,
          topP: 0.8,
          maxOutputTokens: 2048,
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Gemini API error: ${response.status} - ${errorText}`);
      
      // Si l'erreur est liée à la taille, essayer avec un dataset réduit
      if (response.status === 413 || errorText.includes('too large') || errorText.includes('limit')) {
        console.log('🔄 Dataset trop volumineux, tentative avec échantillon réduit...');
        
        // Créer un échantillon plus petit pour le retry
        const retryCompacted = compacted.slice(0, 800);
        const retryCompactJson = JSON.stringify(retryCompacted);
        const retryPrompt = prompt.replace(compactJson, retryCompactJson).replace(datasetNote, ` (échantillon réduit de ${retryCompacted.length} livres)`);
        
        const retryResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.0-pro:generateContent?key=${GEMINI_API_KEY}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: retryPrompt }] }],
            generationConfig: {
              temperature: 0.3,
              topK: 40,
              topP: 0.9,
              maxOutputTokens: 2048,
            }
          })
        });
        
        if (!retryResponse.ok) {
          throw new Error(`Retry failed: ${retryResponse.status}`);
        }
        
        // Remplacer la réponse par celle du retry
        const retryData = await retryResponse.json();
        console.log('✅ Recherche réussie avec échantillon réduit');
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            success: true, 
            matchingISBNs: extractIDs(retryData.candidates[0].content.parts[0].text),
            note: `Recherche effectuée sur un échantillon de ${retryCompacted.length} livres`
          })
        };
      }
      
      throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const aiResponse = data.candidates[0].content.parts[0].text;
    
    console.log(`🤖 Réponse IA brute: ${aiResponse.substring(0, 200)}...`);
    
    // Extraire les IDs avec fonction helper
    const matchingISBNs = extractIDs(aiResponse);
    
    // Si l'IA n'a trouvé aucun résultat, faire une recherche de fallback côté serveur
    if (!matchingISBNs || matchingISBNs.length === 0) {
      console.log('🔍 Aucune correspondance IA trouvée, tentative de recherche de fallback...');
      const fallbackISBNs = performFallbackSearch(query, booksData);
      if (fallbackISBNs.length > 0) {
        console.log(`✅ Fallback trouvé ${fallbackISBNs.length} résultats`);
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ 
            success: true, 
            matchingISBNs: fallbackISBNs,
            note: 'Résultats trouvés via recherche de fallback'
          })
        };
      }
    }
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ 
        success: true, 
        matchingISBNs: matchingISBNs || [] 
      })
    };

  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: error.message 
      })
    };
  }
};

// Fonction de recherche de fallback côté serveur
function performFallbackSearch(query, booksData) {
  const searchTerms = query.toLowerCase().split(' ').filter(term => term.length > 2);
  const matches = [];
  
  // Fonction pour normaliser les IDs
  const normalizeID = (id) => (id || '').toString().replace(/[-\s]/g, '').trim();
  
  for (let index = 0; index < booksData.length; index++) {
    const book = booksData[index];
    const searchableText = [
      book.titre || book.title || '',
      book.auteur || book.author || '',
      book.genre || '',
      book.description || '',
      book.serie || ''
    ].join(' ').toLowerCase();
    
    let score = 0;
    let matchedTerms = 0;
    
    for (const term of searchTerms) {
      if (searchableText.includes(term)) {
        matchedTerms++;
        // Bonus pour les correspondances exactes
        if (searchableText.split(' ').includes(term)) {
          score += 2;
        } else {
          score += 1;
        }
      }
    }
    
    // Au moins 50% des termes doivent correspondre
    if (matchedTerms >= Math.ceil(searchTerms.length * 0.5)) {
      matches.push({
        id: normalizeID(book.id || book.isbn || book.ISBN) || index.toString(),
        score: score
      });
    }
  }
  
  // Trier par score décroissant et retourner max 20 résultats
  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(match => match.id)
    .filter(id => id && id.trim().length > 0);
}

// Fonction helper pour extraire les IDs de la réponse IA
function extractIDs(aiResponse) {
  let matchingIDs;
  try {
    // Nettoyer la réponse avant le parsing
    let cleanResponse = aiResponse.trim();
    
    // Chercher différents formats de tableau JSON
    const patterns = [
      /\[(.*?)\]/s,  // Format standard
      /```json\s*(\[.*?\])\s*```/s,  // Format avec markdown
      /```\s*(\[.*?\])\s*```/s,  // Format avec markdown sans json
      /"?(\[.*?\])"?/s  // Format avec guillemets
    ];
    
    let extracted = null;
    for (const pattern of patterns) {
      const match = cleanResponse.match(pattern);
      if (match) {
        extracted = match[1];
        break;
      }
    }
    
    if (extracted) {
      // Nettoyer l'extraction
      extracted = extracted.replace(/```json|```/g, '').trim();
      matchingIDs = JSON.parse(`[${extracted.replace(/^\[|\]$/g, '')}]`);
    } else {
      // Tentative de parsing direct
      matchingIDs = JSON.parse(cleanResponse);
    }
    
    // Validation et normalisation des IDs
    if (Array.isArray(matchingIDs)) {
      matchingIDs = matchingIDs
        .map(id => (id || '').toString().replace(/[-\s]/g, '').trim())
        .filter(id => id.length > 0);
      console.log(`🤖 ${matchingIDs.length} ID(s) extrait(s) avec succès`);
    } else {
      matchingIDs = [];
    }
    
  } catch (parseError) {
    console.error('JSON parsing error:', parseError);
    console.error('Réponse problématique:', aiResponse);
    
    // Tentative de récupération : extraire les IDs manuellement
    const idPattern = /["']?([A-Za-z0-9\-]+)["']?/g;
    matchingIDs = [];
    let match;
    while ((match = idPattern.exec(aiResponse)) !== null) {
      const id = match[1].replace(/[-\s]/g, '').trim();
      if (id.length > 0) {
        matchingIDs.push(id);
      }
    }
    
    console.log(`🔧 Récupération: ${matchingIDs.length} ID(s) trouvé(s) par pattern matching`);
  }
  
  return matchingIDs || [];
}
