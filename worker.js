export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });

    if (request.method === "POST" && url.pathname === "/api/scan") {
      try {
        const formData = await request.formData();
        const file = formData.get("image");
        const location = formData.get("location") || "Ubicación desconocida";

        if (!file) {
          return json({ error: "No se recibió ninguna imagen." }, 400);
        }

        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);
        let binaryString = "";
        for (let i = 0; i < uint8Array.length; i += 8192) {
          binaryString += String.fromCharCode.apply(null, uint8Array.subarray(i, i + 8192));
        }
        const base64Data = btoa(binaryString);

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: `Identifica el ser vivo. Foto tomada en: ${location}. Si hay duda, la especie más probable ahí.
JSON único, sin markdown:
{"nombre":"","especie":"Género epíteto","estado":"LC|NT|VU|EN|CR|EW|EX|UNKNOWN","categoria":"Mamíferos|Aves|Reptiles|Anfibios|Peces|Insectos|Plantas|Hongos|Otro","descripcion":"2 frases","habitat":"1 frase","dieta":"dieta o nutrición (fotosíntesis si planta)","datoCurioso":"dato corto","tamano":"tamaño típico","temporada":"cuándo se ve o florece aquí","comoReconocer":"2 rasgos visuales","amenazas":"amenaza o null","interactividad":"reacción táctil/luz o null"}`,
                    },
                    {
                      inlineData: {
                        mimeType: file.type || "image/jpeg",
                        data: base64Data,
                      },
                    },
                  ],
                },
              ],
              generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.15,
                maxOutputTokens: 520,
              },
            }),
          }
        );

        if (!geminiRes.ok) {
          const errorText = await geminiRes.text();
          throw new Error(`Fallo en IA Visión (Gemini). Código ${geminiRes.status}: ${errorText}`);
        }

        const geminiRawData = await geminiRes.json();
        const extractedText = geminiRawData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!extractedText) throw new Error("Gemini no devolvió texto.");

        let geminiData;
        try {
          geminiData = JSON.parse(extractedText.replace(/```json/g, "").replace(/```/g, "").trim());
        } catch {
          throw new Error("La IA de visión no devolvió JSON válido.");
        }

        if (geminiData.estado === "UNKNOWN" || !geminiData.nombre) {
          return json({
            nombre: "Desconocido",
            especie: "No identificada",
            estado: "UNKNOWN",
            descripcion: "No identificable.",
            habitat: "?",
            dieta: "?",
            categoria: "Otro",
          });
        }

        const extras = await enrichSpecies(geminiData.especie);

        if (extras.estado && extras.estado !== "UNKNOWN") {
          geminiData.estado = extras.estado;
        }

        return json({
          ...geminiData,
          descripcion: geminiData.descripcion || extras.descripcion || "",
          descripcionLarga: extras.descripcion || null,
          foto: extras.foto || null,
          observaciones: extras.observaciones || null,
          wikipedia: extras.wikipedia || null,
        });
      } catch (error) {
        return json({ error: error.message || "Error interno." }, 500);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/nearby") {
      try {
        const body = await request.json();
        const lat = Number(body.lat);
        const lon = Number(body.lon);

        if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
          return json({ error: "Coordenadas inválidas." }, 400);
        }

        const latR = Math.round(lat * 20) / 20;
        const lonR = Math.round(lon * 20) / 20;
        const cacheUrl = new Request(`https://ecodex.cache/nearby/v2/${latR}/${lonR}`);
        const cache = caches.default;
        const cached = await cache.match(cacheUrl);
        if (cached) {
          const cachedBody = await cached.json();
          return json(cachedBody);
        }

        const [plants, animals, fungi] = await Promise.all([
          fetchINatCounts(lat, lon, "Plantae", 28),
          fetchINatCounts(lat, lon, "Aves,Mammalia,Reptilia,Amphibia,Insecta,Arachnida,Actinopterygii,Mollusca", 16),
          fetchINatCounts(lat, lon, "Fungi", 6),
        ]);

        const seen = new Set();
        const speciesList = [];
        for (const sp of [...plants, ...animals, ...fungi]) {
          const key = (sp.especie || "").toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          speciesList.push(sp);
        }

        speciesList.sort((a, b) => {
          if (a.categoria === "Plantas" && b.categoria !== "Plantas") return -1;
          if (a.categoria !== "Plantas" && b.categoria === "Plantas") return 1;
          return (b.observaciones || 0) - (a.observaciones || 0);
        });

        const payload = speciesList.slice(0, 50);
        const response = json(payload);
        if (ctx && payload.length) {
          const toCache = new Response(JSON.stringify(payload), {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=21600",
            },
          });
          ctx.waitUntil(cache.put(cacheUrl, toCache));
        }
        return response;
      } catch (error) {
        return json({ error: error.message || "Error interno al obtener especies cercanas." }, 500);
      }
    }

    return new Response("Endpoint no encontrado. Usa /api/scan o /api/nearby", {
      status: 404,
      headers: corsHeaders,
    });
  },
};

const INAT_HEADERS = {
  Accept: "application/json",
  "User-Agent": "EcoDex/1.0 (biodiversidad; contacto: ecodex.app)",
};

async function fetchWithTimeout(url, options = {}, ms = 1600) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function mapIucnStatus(raw) {
  if (!raw) return "UNKNOWN";
  const s = String(raw).toLowerCase().replace(/[_\s-]+/g, "");
  const map = {
    lc: "LC",
    leastconcern: "LC",
    nt: "NT",
    nearthreatened: "NT",
    vu: "VU",
    vulnerable: "VU",
    en: "EN",
    endangered: "EN",
    cr: "CR",
    criticallyendangered: "CR",
    ew: "EW",
    extinctinthewild: "EW",
    ex: "EX",
    extinct: "EX",
  };
  return map[s] || "UNKNOWN";
}

function mapCategoria(iconic) {
  const map = {
    Mammalia: "Mamíferos",
    Aves: "Aves",
    Reptilia: "Reptiles",
    Amphibia: "Anfibios",
    Actinopterygii: "Peces",
    Insecta: "Insectos",
    Arachnida: "Insectos",
    Mollusca: "Otro",
    Plantae: "Plantas",
    Fungi: "Hongos",
  };
  return map[iconic] || "Otro";
}

function rarityFromCount(count) {
  if (count >= 80) return "muy común";
  if (count >= 25) return "común";
  if (count >= 8) return "frecuente";
  if (count >= 3) return "ocasional";
  return "rara en tu zona";
}

function parseBinomial(scientific) {
  const parts = String(scientific || "").trim().split(/\s+/);
  return { genus: parts[0] || "", species: parts[1] || "" };
}

async function fetchINatCounts(lat, lon, iconic, perPage) {
  const params = new URLSearchParams({
    lat: String(lat),
    lng: String(lon),
    radius: "12",
    per_page: String(perPage),
    locale: "es",
    verifiable: "true",
    hrank: "species",
    lrank: "species",
    iconic_taxa: iconic,
  });

  const res = await fetchWithTimeout(
    `https://api.inaturalist.org/v1/observations/species_counts?${params}`,
    { headers: INAT_HEADERS },
    5000
  );
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map((row) => {
    const taxon = row.taxon || {};
    const count = row.count || 0;
    const statusRaw = taxon.conservation_status?.status || taxon.conservation_status?.status_name;
    return {
      nombre: taxon.preferred_common_name || taxon.english_common_name || taxon.name,
      especie: taxon.name,
      estado: taxon.threatened && mapIucnStatus(statusRaw) === "UNKNOWN" ? "VU" : mapIucnStatus(statusRaw),
      categoria: mapCategoria(taxon.iconic_taxon_name),
      observaciones: count,
      foto: taxon.default_photo?.medium_url || taxon.default_photo?.square_url || null,
      rareza: rarityFromCount(count),
      taxonId: taxon.id,
      threatened: !!taxon.threatened,
    };
  });
}

async function fetchINatTaxon(scientificName) {
  const params = new URLSearchParams({
    q: scientificName,
    is_active: "true",
    locale: "es",
    per_page: "5",
  });
  const res = await fetchWithTimeout(
    `https://api.inaturalist.org/v1/taxa?${params}`,
    { headers: INAT_HEADERS },
    2500
  );
  if (!res.ok) return null;
  const data = await res.json();
  const exact = (data.results || []).find(
    (t) => (t.name || "").toLowerCase() === scientificName.toLowerCase()
  );
  return exact || data.results?.[0] || null;
}

async function fetchIucnStatus(scientificName) {
  const { genus, species } = parseBinomial(scientificName);
  if (!genus || !species) return null;
  try {
    const res = await fetchWithTimeout(
      `https://api.iucnredlist.org/api/v4/taxa/scientific_name?genus_name=${encodeURIComponent(genus)}&species_name=${encodeURIComponent(species)}`,
      {
        headers: {
          accept: "application/json",
          Authorization: "redacted",
        },
      },
      2200
    );
    if (!res.ok) return null;
    const iucnData = await res.json();
    if (!iucnData?.assessments?.length) return null;
    let bestAss = iucnData.assessments.find((a) => a.latest === true) || iucnData.assessments[0];
    const globalAss = iucnData.assessments.filter((a) => a.scopes?.some((s) => s.code === "1"));
    if (globalAss.length) bestAss = globalAss[0];
    return bestAss?.red_list_category_code || null;
  } catch {
    return null;
  }
}

async function enrichSpecies(scientificName) {
  const extras = {
    estado: null,
    descripcion: "",
    foto: null,
    observaciones: null,
    wikipedia: null,
  };
  if (!scientificName) return extras;

  const results = await Promise.allSettled([
    fetchIucnStatus(scientificName),
    fetchINatTaxon(scientificName),
  ]);

  const iucnStatus = results[0].status === "fulfilled" ? results[0].value : null;
  const taxon = results[1].status === "fulfilled" ? results[1].value : null;

  if (iucnStatus) extras.estado = iucnStatus;
  else if (taxon?.conservation_status) {
    extras.estado = mapIucnStatus(
      taxon.conservation_status.status || taxon.conservation_status.status_name
    );
  }

  extras.descripcion = taxon?.wikipedia_summary || "";
  extras.foto = taxon?.default_photo?.medium_url || null;
  extras.observaciones = taxon?.observations_count || null;
  extras.wikipedia = taxon?.wikipedia_url || null;

  return extras;
}
