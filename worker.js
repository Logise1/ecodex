export default {
  async fetch(request, env) {
    // =========================================================
    // CONFIG CORS
    // =========================================================
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // =========================================================
    // ENDPOINT
    // =========================================================
    if (request.method === "POST" && url.pathname === "/api/scan") {
      try {
        const formData = await request.formData();
        const file = formData.get("image");
        const location = formData.get("location") || "Ubicación desconocida";

        if (!file) {
          return new Response(
            JSON.stringify({
              error: "No se recibió ninguna imagen.",
            }),
            {
              status: 400,
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
              },
            }
          );
        }

        // =========================================================
        // CONVERTIR IMAGEN A BASE64
        // =========================================================
        const arrayBuffer = await file.arrayBuffer();
        const uint8Array = new Uint8Array(arrayBuffer);

        let binaryString = "";

        for (let i = 0; i < uint8Array.length; i += 8192) {
          binaryString += String.fromCharCode.apply(
            null,
            uint8Array.subarray(i, i + 8192)
          );
        }

        const base64Data = btoa(binaryString);

        // =========================================================
        // FASE 1 - GEMINI VISION
        // =========================================================
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: `Identifica el ser vivo. La foto fue tomada en: ${location}. Si tienes dudas sobre la especie exacta, proporciona la más probable basada en esta ubicación.
Devuelve SOLO JSON válido.
Sin markdown.
Sin explicaciones.

Formato:
{"nombre":"","especie":"","estado":"LC|NT|VU|EN|CR|EW|EX|UNKNOWN"}`,
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
                temperature: 0.2,
              },
            }),
          }
        );

        // =========================================================
        // ERROR GEMINI
        // =========================================================
        if (!geminiRes.ok) {
          const errorText = await geminiRes.text();

          throw new Error(
            `Fallo en IA Visión (Gemini). Código ${geminiRes.status}: ${errorText}`
          );
        }

        const geminiRawData = await geminiRes.json();

        let geminiData;

        try {
          const extractedText =
            geminiRawData.candidates?.[0]?.content?.parts?.[0]?.text;

          if (!extractedText) {
            throw new Error("Gemini no devolvió texto.");
          }

          geminiData = JSON.parse(
            extractedText
              .replace(/```json/g, "")
              .replace(/```/g, "")
              .trim()
          );
        } catch (parseError) {
          throw new Error(
            "La IA de visión no devolvió JSON válido."
          );
        }

        // =========================================================
        // FASE 1.5 - IUCN RED LIST API PARA ESTADO DE CONSERVACIÓN
        // =========================================================
        if (geminiData && geminiData.especie && geminiData.especie !== "No identificada" && geminiData.especie.trim() !== "") {
          const parts = geminiData.especie.trim().split(' ');
          const genus = parts[0];
          const species = parts.slice(1).join(' ');

          if (genus && species) {
            try {
              const iucnRes = await fetch(`https://api.iucnredlist.org/api/v4/taxa/scientific_name?genus_name=${genus}&species_name=${species}`, {
                method: 'GET',
                headers: {
                  'accept': 'application/json',
                  'Authorization': 'redacted'
                }
              });

              if (iucnRes.ok) {
                const iucnData = await iucnRes.json();
                if (iucnData && iucnData.assessments && iucnData.assessments.length > 0) {
                  let bestAss = iucnData.assessments[0];
                  // Intentamos buscar el más reciente global si es posible
                  const latest = iucnData.assessments.find(a => a.latest === true);
                  if (latest) {
                    bestAss = latest;
                  } else {
                    const globalAss = iucnData.assessments.filter(a => a.scopes?.some(s => s.code === "1"));
                    if (globalAss.length > 0) bestAss = globalAss[0];
                  }

                  if (bestAss && bestAss.red_list_category_code) {
                    geminiData.estado = bestAss.red_list_category_code;
                  }
                }
              }
            } catch (e) {
              console.error("Error consultando IUCN API", e);
            }
          }
        }

        // =========================================================
        // SI NO IDENTIFICA NADA
        // =========================================================
        if (
          geminiData.estado === "UNKNOWN" ||
          !geminiData.nombre
        ) {
          return new Response(
            JSON.stringify({
              nombre: "Desconocido",
              especie: "No identificada",
              estado: "UNKNOWN",
              descripcion: "No identificable.",
              habitat: "?",
              dieta: "?",
              categoria: "Otro",
            }),
            {
              headers: {
                ...corsHeaders,
                "Content-Type": "application/json",
              },
            }
          );
        }

        // =========================================================
        // FASE 2 - MISTRAL
        // =========================================================
        const mistralRes = await fetch(
          "https://api.mistral.ai/v1/chat/completions",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${env.MISTRAL_API_KEY}`,
            },

            body: JSON.stringify({
              model: "mistral-small-latest",

              messages: [
                {
                  role: "user",
                  content: `Actúa como biólogo.

Especie:
${geminiData.nombre} (${geminiData.especie})

Devuelve SOLO JSON válido:

{
  "descripcion":"Breve info",
  "habitat":"Dónde vive",
  "dieta":"Qué come",
  "categoria":"Mamíferos|Aves|Reptiles|Anfibios|Peces|Insectos|Plantas|Hongos|Otro",
  "interactividad":"Descripción de comportamiento interactivo o curioso si existe (ej: si se toca se cierra, si se pisa brilla, etc). Si no tiene nada especial, devolver null."
}`,
                },
              ],

              response_format: {
                type: "json_object",
              },

              temperature: 0.3,
            }),
          }
        );

        // =========================================================
        // ERROR MISTRAL
        // =========================================================
        if (!mistralRes.ok) {
          const errorText = await mistralRes.text();

          throw new Error(
            `Fallo en IA Conocimiento (Mistral). Código ${mistralRes.status}: ${errorText}`
          );
        }

        const mistralRawData = await mistralRes.json();

        let mistralData;

        try {
          const extractedText =
            mistralRawData.choices?.[0]?.message?.content;

          if (!extractedText) {
            throw new Error("Mistral no devolvió texto.");
          }

          mistralData = JSON.parse(
            extractedText
              .replace(/```json/g, "")
              .replace(/```/g, "")
              .trim()
          );
        } catch (parseError) {
          throw new Error(
            "La IA de conocimiento no devolvió JSON válido."
          );
        }

        // =========================================================
        // RESPUESTA FINAL
        // =========================================================
        return new Response(
          JSON.stringify({
            ...geminiData,
            ...mistralData,
          }),
          {
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: error.message || "Error interno.",
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }
    }

    if (request.method === "POST" && url.pathname === "/api/nearby") {
      try {
        const body = await request.json();
        const lat = body.lat;
        const lon = body.lon;
        const location = body.location || "Ubicación desconocida";

        const prompt = `Dame una lista de exactamente 35 especies de seres vivos (animales, plantas u hongos) que se puedan encontrar cerca de la ubicación con coordenadas latitud ${lat}, longitud ${lon} (${location}).
La lista debe incluir especies de diferentes categorías y con diferentes estados de conservación de la lista roja de la UICN (LC, NT, VU, EN, CR, EW, EX).
Devuelve SOLO un array JSON válido, sin formato markdown y sin explicaciones.
Formato de respuesta:
[
  {
    "nombre": "Nombre común en español",
    "especie": "Nombre científico (Género especie)",
    "estado": "LC|NT|VU|EN|CR|EW|EX",
    "categoria": "Mamíferos|Aves|Reptiles|Anfibios|Peces|Insectos|Plantas|Hongos"
  }
]`;

        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent?key=${env.GEMINI_API_KEY}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: prompt,
                    },
                  ],
                },
              ],
              generationConfig: {
                responseMimeType: "application/json",
                temperature: 0.5,
              },
            }),
          }
        );

        if (!geminiRes.ok) {
          const errorText = await geminiRes.text();
          throw new Error(`Fallo en Gemini: ${geminiRes.status} ${errorText}`);
        }

        const geminiRawData = await geminiRes.json();
        const extractedText = geminiRawData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!extractedText) {
          throw new Error("Gemini no devolvió texto.");
        }

        const speciesList = JSON.parse(
          extractedText
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim()
        );

        return new Response(JSON.stringify(speciesList), {
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        });
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: error.message || "Error interno al obtener especies cercanas.",
          }),
          {
            status: 500,
            headers: {
              ...corsHeaders,
              "Content-Type": "application/json",
            },
          }
        );
      }
    }

    // =========================================================
    // 404
    // =========================================================
    return new Response(
      "Endpoint no encontrado. Usa /api/scan o /api/nearby",
      {
        status: 404,
        headers: corsHeaders,
      }
    );
  },
};