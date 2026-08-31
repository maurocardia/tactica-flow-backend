import { db } from '../config/db.js';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';

export interface KnowledgeBase {
  id: number;
  title: string;
  description: string;
  isActive: boolean;
  createdAt: string;
}

export interface KnowledgeDocument {
  id: number;
  knowledgeBaseId: number;
  filename: string;
  mimeType: string;
  charCount: number;
  preview: string;
  createdAt: string;
}



const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'txt', 'md'];

// --- Seguridad: detección de intentos de "prompt injection" en documentos subidos -----------
// Defensa best-effort (heurística por patrones, no infalible) contra archivos que intenten
// darle instrucciones a la IA (ej. "ignorá tus instrucciones anteriores") o pedirle que
// revele configuración interna del sistema (variables de entorno, API keys, contraseñas de
// la base, etc.). La defensa "real" — que no depende de adivinar cada frase posible — está en
// el system prompt de AIService (ver ai.service.ts): ahí se le indica al modelo que el
// contenido de la Base de Conocimiento es solo información de referencia, nunca instrucciones,
// y que nunca debe revelar secretos del sistema sin importar qué le pidan. Esto es una capa
// adicional para frenar los casos más obvios antes de que el texto llegue siquiera a la IA.
const INJECTION_PATTERNS: RegExp[] = [
  /ignor[ae]\s+(todas?\s+)?(las?\s+)?instruccion/i,
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /olvid[ae]\s+(tus?\s+)?instruccion/i,
  /forget\s+(your\s+)?(previous\s+)?instructions/i,
  /nuevas?\s+instruccion(es)?\s*:/i,
  /new\s+instructions?\s*:/i,
  /system\s*prompt/i,
  /prompt\s+de\s+sistema/i,
  /revela(r)?\s+(tu|el|las?)\s+(system\s*prompt|prompt|configuraci[oó]n|instruccion)/i,
  /reveal\s+your\s+(system\s*prompt|instructions|configuration)/i,
  /variables?\s+de\s+entorno/i,
  /environment\s+variables?/i,
  /\bprocess\.env\b/i,
  /\b[A-Z_]{3,}_(API_KEY|SECRET|PASSWORD|TOKEN)\b/, // ej. GEMINI_API_KEY, PG_PASSWORD, JWT_SECRET
  /modo\s+desarrollador/i,
  /developer\s+mode/i,
  /\bjailbreak\b/i,
  /act\s+as\s+(if\s+you\s+have\s+no|an?\s+ai\s+with\s+no)\s+restrictions/i,
  /act[uú]a\s+como\s+(si\s+no\s+tuvieras|un[a]?\s+ia\s+sin)\s+(l[ií]mites|restricciones)/i,
];

/**
 * Busca patrones de "prompt injection" en un texto ya extraído. Devuelve el patrón que
 * coincidió (para loguear), o null si no encontró nada sospechoso.
 */
function detectInjectionAttempt(text: string): string | null {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return pattern.source;
    }
  }
  return null;
}

function mapBaseRow(row: any): KnowledgeBase {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    isActive: row.is_active,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function mapDocRow(row: any): KnowledgeDocument {
  const content: string = row.content || '';
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    filename: row.filename,
    mimeType: row.mime_type,
    charCount: row.char_count,
    preview: content.slice(0, 200),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export class KnowledgeBaseService {
  // --- Bases de conocimiento ---------------------------------------------------------------

  static async listBases(): Promise<KnowledgeBase[]> {
    const { rows } = await db.query('SELECT * FROM knowledge_bases ORDER BY created_at DESC');
    return rows.map(mapBaseRow);
  }

  static async getBase(id: number): Promise<KnowledgeBase | null> {
    const { rows } = await db.query('SELECT * FROM knowledge_bases WHERE id = $1', [id]);
    if (rows.length === 0) return null;
    return mapBaseRow(rows[0]);
  }

  static async createBase(data: { title: string; description?: string; isActive?: boolean }): Promise<KnowledgeBase> {
    const title = data.title.trim();
    const description = (data.description || '').trim();
    const isActive = data.isActive !== undefined ? (data.isActive === true || data.isActive === 'true' as any) : true;

    const { rows } = await db.query(
      `INSERT INTO knowledge_bases (title, description, is_active) VALUES ($1, $2, $3) RETURNING *`,
      [title, description, isActive]
    );
    return mapBaseRow(rows[0]);
  }

  static async updateBase(
    id: number,
    data: Partial<{ title: string; description: string; isActive: boolean }>
  ): Promise<KnowledgeBase | null> {
    const existing = await this.getBase(id);
    if (!existing) return null;

    const title = data.title !== undefined ? data.title.trim() : existing.title;
    const description = data.description !== undefined ? data.description.trim() : existing.description;
    const isActive = data.isActive !== undefined ? (data.isActive === true || data.isActive === 'true' as any) : existing.isActive;

    const { rows } = await db.query(
      `UPDATE knowledge_bases SET title = $1, description = $2, is_active = $3 WHERE id = $4 RETURNING *`,
      [title, description, isActive, id]
    );
    console.log(`📚 [KnowledgeBaseService] Base ${id} actualizada. is_active=${isActive}`);
    return mapBaseRow(rows[0]);
  }

  static async deleteBase(id: number): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM knowledge_bases WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  // --- Documentos ----------------------------------------------------------------------------

  static async listDocuments(knowledgeBaseId: number): Promise<KnowledgeDocument[]> {
    const { rows } = await db.query(
      'SELECT * FROM knowledge_documents WHERE knowledge_base_id = $1 ORDER BY created_at DESC',
      [knowledgeBaseId]
    );
    return rows.map(mapDocRow);
  }

  static async deleteDocument(id: number): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM knowledge_documents WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }

  /**
   * Extrae el texto plano de un archivo subido según su extensión. PDF y DOCX no son texto
   * plano: hay que parsearlos de verdad (no alcanza con buffer.toString('utf-8'), eso solo
   * sirve para .txt/.md).
   */
  static async extractText(filename: string, buffer: Buffer): Promise<string> {
    const ext = (filename.toLowerCase().split('.').pop() || '').trim();

    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Tipo de archivo no soportado: .${ext || '?'}. Usá PDF, Word (.docx), .txt o .md.`);
    }

    if (ext === 'pdf') {
      const parser = new PDFParse({ data: buffer });
      try {
        const result = await parser.getText();
        // pdf-parse agrega separadores tipo "-- 1 of 2 --" entre páginas; los sacamos.
        return result.text.replace(/^-- \d+ of \d+ --$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
      } finally {
        await parser.destroy();
      }
    }

    if (ext === 'docx') {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim();
    }

    // txt / md
    return buffer.toString('utf-8').trim();
  }

  static async addDocument(knowledgeBaseId: number, filename: string, buffer: Buffer, mimeType: string): Promise<KnowledgeDocument> {
    const base = await this.getBase(knowledgeBaseId);
    if (!base) throw new Error('Base de conocimiento no encontrada');

    const content = await this.extractText(filename, buffer);
    if (!content) {
      throw new Error('No se pudo extraer texto del archivo (¿está vacío o es un PDF escaneado sin texto/OCR?)');
    }

    const injectionMatch = detectInjectionAttempt(content);
    if (injectionMatch) {
      console.warn(`⚠️ [KnowledgeBaseService] Documento "${filename}" rechazado por contenido sospechoso (patrón: ${injectionMatch})`);
      throw new Error(
        'El documento fue rechazado: contiene texto que parece un intento de darle instrucciones a la IA o de pedirle que revele configuración interna del sistema (ej. "ignorá tus instrucciones", variables de entorno, API keys, contraseñas). Si es un falso positivo, revisá el archivo y quitá esa frase antes de volver a subirlo.'
      );
    }

    const { rows } = await db.query(
      `INSERT INTO knowledge_documents (knowledge_base_id, filename, content, mime_type, char_count)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [knowledgeBaseId, filename, content, mimeType, content.length]
    );
    return mapDocRow(rows[0]);
  }

  /**
   * IDs de las bases activas ahora mismo — versión liviana de getActiveContext() para cuando
   * solo hace falta filtrar (ver ConversationService.toAiHistory), sin traer el contenido de
   * los documentos.
   */
  static async getActiveBaseIds(): Promise<number[]> {
    const { rows } = await db.query('SELECT id FROM knowledge_bases WHERE is_active = true');
    return rows.map((r) => r.id);
  }

  /**
   * Obtiene el contexto de las bases de conocimiento ACTIVAS de forma optimizada.
   *
   * - Para KBs pequeñas (< 14.000 chars): envía todo el contenido a la IA sin chunking.
   * - Para KBs grandes: aplica RAG ligero, seleccionando los fragmentos más relevantes.
   *
   * `isRelevant = true` SOLO si alguna keyword de la consulta aparece en la KB.
   * Si no hay coincidencias, la IA puede usar el contexto para responder (grounding)
   * pero NO se muestra el badge "respaldado por la Base de Conocimiento".
   */
  static async getActiveContext(
    currentText?: string,
    historyText?: string
  ): Promise<{ context: string; baseIds: number[]; isRelevant: boolean }> {
    const query = `${historyText || ''} ${currentText || ''}`.trim();
    const { rows } = await db.query(
      `SELECT kb.id AS base_id, kb.title AS base_title, d.filename, d.content
       FROM knowledge_documents d
       JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
       WHERE kb.is_active = true
       ORDER BY kb.created_at ASC, d.created_at ASC`
    );

    if (rows.length === 0) return { context: '', baseIds: [], isRelevant: false };

    const baseIds = new Set<number>();
    const baseTitles = new Set<string>();
    rows.forEach((r) => {
      baseIds.add(r.base_id);
      baseTitles.add(`"${r.base_title}" (ID: ${r.base_id})`);
    });

    console.log(`📚 [KnowledgeBaseService] Bases de conocimiento activas (${rows.length} docs): ${[...baseTitles].join(', ')}`);

    let totalLength = 0;
    rows.forEach((r) => (totalLength += (r.content || '').length));

    // Si no hay query, enviamos todo directo y marcamos como no relevante (no hay pregunta que comparar)
    if (!query || !query.trim()) {
      let context = '';
      for (const row of rows) {
        context += `=== Base: ${row.base_title} — Documento: ${row.filename} ===\n${row.content}\n\n`;
      }
      return { context: context.trim(), baseIds: [...baseIds], isRelevant: false };
    }

    // --- Siempre calculamos relevancia por keywords, independiente del tamaño ---
    const STOPWORDS = new Set([
      'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'a', 'al', 'en', 'para', 'por', 'con',
      'sin', 'sobre', 'que', 'como', 'cuando', 'donde', 'quien', 'cual', 'cuanto', 'este', 'esta', 'estos', 'estas',
      'hola', 'buenas', 'dias', 'tardes', 'noches', 'favor', 'gracias', 'porfa', 'podrias', 'puedes', 'tienen',
      'hay', 'ser', 'estar', 'hacer', 'mi', 'tu', 'su', 'nos', 'me', 'te', 'se', 'le', 'les', 'lo', 'y', 'o', 'pero',
      'venden', 'vende', 'vender', 'tienes', 'tiene', 'consigo', 'conseguir', 'ustedes', 'nosotros', 'quiero', 'quiere',
      // Palabras conversacionales, interjecciones y términos web/sociales
      'jaja', 'jajaja', 'jajajaja', 'jeje', 'mami', 'papi', 'hijo', 'hija', 'amigo', 'chau', 'bien', 'bueno', 'malo',
      'susto', 'video', 'link', 'http', 'https', 'www', 'com', 'facebook', 'instagram', 'tiktok', 'reel', 'share',
      'reproducciones', 'likes', 'esperando', 'esperar', 'abajo', 'arriba', 'ahi', 'aqui', 'alla', 'ya', 'muy', 'mas',
      'menos', 'algo', 'nada', 'todo', 'tambien', 'tampoco', 'si', 'no', 'casi', 'aviso', 'avisame', 'minutos'
    ]);

    // Limpiar URLs y caracteres extraños antes de extraer palabras clave
    const extractKeywords = (text: string): string[] =>
      text
        .replace(/https?:\/\/\S+/gi, ' ')
        .toLowerCase()
        .replace(/[^\w\sáéíóúüñ]/gi, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
        .map((w) => (w.endsWith('s') ? w.slice(0, -1) : w));

    // El mensaje ACTUAL pesa más que el historial: si el cliente cambia de tema de golpe,
    // sus propias palabras clave dominan el puntaje y el chunk relevante al tema nuevo gana,
    // en vez de que el historial viejo siga "empujando" hacia el tema anterior. Esto evita
    // necesitar un clasificador explícito de "cambio de tema": el retrieval se auto-ajusta.
    const currentKeywords = [...new Set(extractKeywords(currentText || ''))];
    const currentKeywordSet = new Set(currentKeywords);
    // Tope duro de 40 palabras: si el historial trae una respuesta larga del bot (ej. un
    // procedimiento de varios pasos), no queremos que aporte decenas de palabras genéricas del
    // manual que, sumadas, terminen pesando más que las 2-3 palabras específicas del mensaje
    // nuevo. Con esto el historial sigue ayudando en preguntas de seguimiento cortas sin poder
    // "tapar" un cambio de tema por pura acumulación de volumen.
    const historyKeywords = [...new Set(extractKeywords(historyText || '').filter((w) => !currentKeywordSet.has(w)))].slice(0, 40);

    interface Chunk {
      baseTitle: string;
      filename: string;
      text: string;
      textLower: string;
      score: number;
    }

    const chunks: Chunk[] = [];

    for (const row of rows) {
      const content = row.content || '';
      const rawParagraphs = content.split(/\n\s*\n/);
      const docChunks: string[] = [];

      // 1200 en vez de 700: chunks más chicos partían procedimientos numerados a la mitad
      // (ej. "1. ..." en un chunk y "2. ..." en el siguiente), así que si la pregunta matcheaba
      // keywords del paso 1 pero el paso 2 quedaba en otro chunk, ese paso 2 se perdía.
      let current = '';
      for (const p of rawParagraphs) {
        if ((current + '\n' + p).length > 1200) {
          if (current.trim()) docChunks.push(current.trim());
          current = p;
        } else {
          current = current ? `${current}\n${p}` : p;
        }
      }
      if (current.trim()) docChunks.push(current.trim());

      for (const chunkText of docChunks) {
        chunks.push({ baseTitle: row.base_title, filename: row.filename, text: chunkText, textLower: chunkText.toLowerCase(), score: 0 });
      }
    }

    // --- Peso por rareza (estilo IDF) para las palabras del mensaje actual ----------------------
    // En una KB grande armada a partir de un solo documento largo (ej. un manual de 700k+
    // caracteres que cubre muchos temas), palabras genéricas como "correo"/"servidor"/"puerto"
    // aparecen en decenas de chunks de temas distintos (Gmail, Outlook, Office 365, casos
    // genéricos...) y "tapan" con volumen a la palabra que realmente distingue de qué tema se
    // trata (ej. "office"/"365"/"exchange"). Sin este ajuste, una pregunta específica sobre
    // Office 365 puede terminar trayendo el ejemplo genérico de Gmail en vez del correcto,
    // porque ambos comparten las mismas palabras comunes. Acá bajamos el peso de las palabras
    // que aparecen en muchos chunks y subimos el de las que aparecen en pocos.
    const totalChunks = chunks.length;
    const currentKeywordIdf = new Map<string, number>();
    for (const kw of currentKeywords) {
      if (currentKeywordIdf.has(kw)) continue;
      const docFreq = chunks.reduce((n, c) => n + (c.textLower.includes(kw) ? 1 : 0), 0);
      currentKeywordIdf.set(kw, Math.log((totalChunks + 1) / (docFreq + 1)) + 1);
    }

    for (const c of chunks) {
      let score = 0;

      // Palabras del mensaje actual: peso completo (ajustado por rareza). Palabras que solo
      // aparecen en el historial reciente: peso reducido (contexto de apoyo, no debe tapar un
      // tema nuevo).
      for (const kw of currentKeywords) {
        const idf = currentKeywordIdf.get(kw) || 1;
        const exactMatches = (c.textLower.match(new RegExp(`\\b${kw}s?\\b`, 'g')) || []).length;
        if (exactMatches > 0) {
          // Tope a 3 repeticiones: un párrafo genérico que solo "explica" un término común
          // (ej. "el servidor de correo entrante es un servidor que...") lo repite varias veces
          // y, sin este tope, terminaba ganándole por volumen a un chunk específico (ej. el que
          // realmente tiene el dato de Office 365) que menciona cada palabra una sola vez.
          score += Math.min(exactMatches, 3) * 15 * idf;
        } else if (c.textLower.includes(kw)) {
          // Fallback sin límite de palabra: cubre casos como "office365.com" o "imap.gmail.com",
          // donde la keyword ("office", "365", "gmail") queda pegada dentro de un dominio/URL sin
          // separador y \b nunca matchea, pero la palabra sigue siendo relevante para el tema.
          score += 6 * idf;
        }
      }
      for (const kw of historyKeywords) {
        const exactMatches = (c.textLower.match(new RegExp(`\\b${kw}s?\\b`, 'g')) || []).length;
        if (exactMatches > 0) {
          score += Math.min(exactMatches, 3) * 2;
        } else if (c.textLower.includes(kw)) {
          score += 0.5;
        }
      }

      c.score = score;
    }

    chunks.sort((a, b) => b.score - a.score);

    // isRelevant = true SOLO si hay coincidencias reales y significativas (umbral >= 15)
    const maxScore = chunks.length > 0 ? chunks[0].score : 0;
    const isRelevant = maxScore >= 15;

    // Para KBs pequeñas: enviamos todo el contenido (sin chunking) para no perder contexto,
    // pero igualmente usamos el isRelevant calculado arriba
    if (totalLength <= 14000) {
      let context = '';
      for (const row of rows) {
        context += `=== Base: ${row.base_title} — Documento: ${row.filename} ===\n${row.content}\n\n`;
      }
      console.log(`⚡ [KnowledgeBaseService] KB pequeña: maxScore=${maxScore}, isRelevant=${isRelevant}, ${totalLength} chars totales.`);
      return { context: context.trim(), baseIds: [...baseIds], isRelevant };
    }

    // Para KBs grandes: RAG optimizado, seleccionamos los chunks más relevantes.
    // El matching por palabra clave es literal, no semántico, y a veces ni la rareza (IDF) ni el
    // tope de repetición alcanzan: ej. "soporte" puede referirse al caso de soporte técnico que
    // pregunta el cliente, o al nombre de un ROL de permisos de usuario en TACTICA ("rol
    // SOPORTE") — dos significados distintos con la misma palabra, indistinguibles para un
    // matcher literal. Mandar bastantes más chunks (antes 16000 chars/~13 chunks, luego
    // 80000/~50) le da a la IA varios candidatos para leer y elegir el que realmente responde la
    // pregunta, en vez de depender de que el ranking por palabras clave acierte a la primera. Con
    // 80000 seguían quedando afuera por poco casos reales (ej. el fragmento de las solapas
    // "Enlace"/"Contactos" de Correos Programados rankeaba #62 de 470, y con ~50 chunks
    // seleccionados no entraba) — subimos a 120000/~75 para darles margen.
    let selectedLength = 0;
    const selectedChunks: Chunk[] = [];
    const MAX_FILTERED_CHARS = 120000;
    const MIN_CHUNKS_REGARDLESS_OF_SCORE = 18;

    for (const c of chunks) {
      if (c.score === 0 && selectedChunks.length >= MIN_CHUNKS_REGARDLESS_OF_SCORE) break;
      if (selectedLength + c.text.length > MAX_FILTERED_CHARS) break;
      selectedChunks.push(c);
      selectedLength += c.text.length;
    }

    if (selectedChunks.length === 0 && chunks.length > 0) {
      selectedChunks.push(...chunks.slice(0, 3));
    }

    let context = '';
    for (const sc of selectedChunks) {
      context += `=== Base: ${sc.baseTitle} — Documento: ${sc.filename} ===\n${sc.text}\n\n`;
    }

    console.log(
      `⚡ [KnowledgeBaseService] KB grande RAG: maxScore=${maxScore}, isRelevant=${isRelevant}, ${selectedLength}/${totalLength} chars.`
    );

    return { context: context.trim(), baseIds: [...baseIds], isRelevant };
  }
}
