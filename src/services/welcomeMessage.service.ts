import type { ConversationMessage } from './conversation.service.js';

/** Texto que se manda si la cuenta prendió el mensaje de bienvenida pero dejó el campo vacío. */
export const DEFAULT_WELCOME_MESSAGE =
  '¡Hola, {nombre}! 👋 Te damos la bienvenida.\n\n' +
  'Soy el asistente virtual y estoy para ayudarte con tus consultas. Si hay algo que no pueda ' +
  'resolver, te paso con una persona de nuestro equipo.\n\n' +
  '¿En qué te puedo ayudar?';

/** Minutos sin mensajes (de ningún lado) para que el próximo mensaje del cliente cuente como un
 * chat nuevo — el panel lo puede mostrar en minutos u horas, pero acá siempre son minutos. */
export const DEFAULT_WELCOME_INACTIVITY_MINUTES = 720; // 12 horas
export const WELCOME_INACTIVITY_MINUTES_MIN = 1;
export const WELCOME_INACTIVITY_MINUTES_MAX = 43200; // 30 días
export const WELCOME_MESSAGE_MAX_LEN = 1500;

// Palabras que, solas, son "solo un saludo" — con esto el mensaje de bienvenida alcanza como
// respuesta y no hace falta que además conteste la IA (que repetiría "¿en qué te ayudo?").
const GREETING_WORDS = new Set([
  'hola', 'holaa', 'holis', 'ola', 'buenas', 'buen', 'buenos', 'buena', 'dia', 'dias', 'tarde', 'tardes',
  'noche', 'noches', 'que', 'tal', 'como', 'estas', 'esta', 'andas', 'va', 'todo', 'bien', 'hey', 'saludos',
  'hi', 'hello', 'gente', 'chicos'
]);

export class WelcomeMessageService {
  /**
   * ¿Este mensaje "activa" el chat? Sí si la conversación no tenía mensajes previos, o si el último
   * (del cliente, del bot o del asesor) es de hace más de `inactivityHours`. `priorMessages` es el
   * historial ANTES de guardar el mensaje entrante.
   */
  static startsNewChat(priorMessages: ConversationMessage[], inactivityMinutes: number, now = new Date()): boolean {
    const last = priorMessages[priorMessages.length - 1];
    if (!last) return true;
    const elapsedMs = now.getTime() - new Date(last.createdAt).getTime();
    return elapsedMs >= inactivityMinutes * 60 * 1000;
  }

  /**
   * Igual que startsNewChat, pero para un GRUPO entero en vez de la conversación de un participante
   * puntual: en un grupo cada participante tiene su propia fila de `conversations` (ver
   * WhatsappService.handleIncomingMessage), así que no hay un solo "último mensaje" que sirva —
   * se usa en cambio bot_contacts.last_activity del GRUPO (ver BotContactService.getLastActivity,
   * que hay que llamar ANTES del upsert() de este mensaje para que no esté ya pisado a "ahora").
   * Esto hace que la bienvenida se mande UNA sola vez por reactivación del grupo entero, sin
   * importar quién sea el primero en volver a escribir.
   */
  static startsNewGroupChat(lastActivity: Date | null, inactivityMinutes: number, now = new Date()): boolean {
    if (!lastActivity) return true;
    const elapsedMs = now.getTime() - lastActivity.getTime();
    return elapsedMs >= inactivityMinutes * 60 * 1000;
  }

  /** Texto final a mandar: el de la cuenta (o el default) con {nombre} reemplazado. */
  static render(template: string, contactName: string): string {
    const text = template.trim() || DEFAULT_WELCOME_MESSAGE;
    // Sin nombre guardado el "nombre" es el número de teléfono — mejor un "¡Hola!" a secas.
    const name = /^[\d\s+-]*$/.test(contactName) ? '' : contactName.trim();
    return text
      .replace(/,?\s*\{nombre\}/gi, (match) => (name ? match.replace(/\{nombre\}/i, name) : ''))
      .trim();
  }

  /** "hola", "buenas tardes", "hola qué tal 👋" — sin ninguna consulta adentro. */
  static isGreetingOnly(text: string): boolean {
    const words = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    return words.length > 0 && words.length <= 6 && words.every((w) => GREETING_WORDS.has(w));
  }
}
