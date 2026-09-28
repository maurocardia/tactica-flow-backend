// Detección de "el cliente pide hablar con una persona", sin depender de la IA.
//
// Antes la derivación dependía de que la IA decidiera llamar a la tool handoff_to_advisor, y el
// modelo lo hacía de forma inconsistente: con instrucciones de venta que piden calificar al
// cliente antes de avanzar, "necesito un asesor" se leía a veces como "necesito asesoramiento" y
// la IA seguía preguntando (confirmado en producción: un cliente tuvo que pedirlo tres veces).
//
// Ahora el código clasifica el mensaje ANTES de llamar a la IA:
// - explícito ("hablar con una persona", "un humano"...)  → se deriva directo.
// - ambiguo ("asesor", "asesoría"...)                      → se le pregunta si quiere una persona.
// - nada                                                  → la IA responde como siempre.
// Las listas y el texto de la pregunta son configurables por cuenta (panel "Asesores humanos").

export type HandoffIntent = 'explicit' | 'ambiguous' | 'none';
export type ClarifyAnswer = 'human' | 'continue' | 'unknown';

export const DEFAULT_EXPLICIT_PHRASES = [
  'hablar con una persona',
  'hablar con alguien',
  'hablar con un humano',
  'hablar con un vendedor',
  'hablar con un especialista',
  'hablar con un agente',
  'pasame con alguien',
  'pasame con una persona',
  'comunicame con alguien',
  'comunicame con una persona',
  'una persona real',
  'atencion humana',
  'un humano',
  'quiero una llamada',
  'que me llamen'
].join(',');

export const DEFAULT_AMBIGUOUS_WORDS = ['asesor', 'asesora', 'asesores', 'asesoria', 'asesoramiento'].join(',');

export const DEFAULT_CLARIFY_QUESTION =
  '¿Querés que te comunique con una persona de nuestro equipo, o preferís que te oriente yo con tu consulta?\n\n1. Hablar con una persona\n2. Seguir con mi consulta';

/** Cuánto vale una pregunta sin respuesta: pasado esto, la próxima respuesta ya no se interpreta
 * como "1/2" sino como un mensaje normal. */
export const CLARIFY_PENDING_MINUTES = 30;
/** Si el cliente eligió "seguir con mi consulta", cuánto tiempo no se le vuelve a preguntar
 * aunque vuelva a aparecer una palabra ambigua (un pedido explícito sí deriva igual). */
export const CLARIFY_COOLDOWN_MINUTES = 30;

const NEGATIONS = new Set(['no', 'ni', 'sin', 'nunca', 'tampoco', 'nada']);
/** Cuántas palabras antes de la coincidencia se busca una negación ("no necesito un asesor"). */
const NEGATION_WINDOW = 3;

/** Minúsculas, sin tildes ni signos, espacios simples — así "Asesoría!" y "asesoria" son lo mismo. */
export function normalizeIntentText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lista separada por comas (tal cual se guarda en la base) → frases normalizadas, sin vacías. */
export function parseList(raw: string | null | undefined, fallback: string): string[] {
  const source = raw && raw.trim() ? raw : fallback;
  return source
    .split(',')
    .map((item) => normalizeIntentText(item))
    .filter((item) => item.length > 0);
}

/** true si `phrase` (una o más palabras) aparece como palabras completas en `words`, sin una
 * negación en las NEGATION_WINDOW palabras anteriores. */
function containsUnnegated(words: string[], phrase: string): boolean {
  const target = phrase.split(' ');
  for (let i = 0; i + target.length <= words.length; i++) {
    let match = true;
    for (let j = 0; j < target.length; j++) {
      if (words[i + j] !== target[j]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const before = words.slice(Math.max(0, i - NEGATION_WINDOW), i);
    if (!before.some((w) => NEGATIONS.has(w))) return true;
  }
  return false;
}

export function classifyHandoffIntent(text: string, explicitPhrases: string[], ambiguousWords: string[]): HandoffIntent {
  const words = normalizeIntentText(text).split(' ').filter(Boolean);
  if (words.length === 0) return 'none';
  if (explicitPhrases.some((p) => containsUnnegated(words, p))) return 'explicit';
  if (ambiguousWords.some((w) => containsUnnegated(words, w))) return 'ambiguous';
  return 'none';
}

const HUMAN_ANSWERS = new Set(['1', 'uno', 'si', 'dale', 'ok', 'okey', 'oka', 'bueno', 'claro', 'por favor', 'porfa', 'la 1', 'opcion 1', 'la uno']);
const CONTINUE_ANSWERS = new Set(['2', 'dos', 'no', 'no gracias', 'la 2', 'opcion 2', 'la dos', 'seguir', 'sigo', 'segui']);
const HUMAN_WORDS = ['persona', 'humano', 'asesor', 'asesora', 'alguien', 'especialista', 'vendedor', 'agente'];
const CONTINUE_WORDS = ['seguir', 'consulta', 'plataforma', 'orientame', 'orienta', 'vos', 'bot'];

/** Interpreta la respuesta del cliente a la pregunta de aclaración. */
export function parseClarifyAnswer(text: string, explicitPhrases: string[]): ClarifyAnswer {
  const normalized = normalizeIntentText(text);
  if (!normalized) return 'unknown';
  if (HUMAN_ANSWERS.has(normalized)) return 'human';
  if (CONTINUE_ANSWERS.has(normalized)) return 'continue';

  const words = normalized.split(' ');
  if (explicitPhrases.some((p) => containsUnnegated(words, p))) return 'human';
  // Frases cortas del tipo "con una persona", "la persona", "prefiero seguir yo".
  if (words.length <= 6) {
    const human = HUMAN_WORDS.some((w) => containsUnnegated(words, w));
    const cont = CONTINUE_WORDS.some((w) => words.includes(w));
    if (human && !cont) return 'human';
    if (cont && !human) return 'continue';
  }
  return 'unknown';
}
