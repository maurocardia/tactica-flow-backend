import { OpenAiService } from './openai.service.js';
import { TacticaApiService, TacticaCredentials } from './tacticaApi.service.js';

export interface KeywordRule {
  id: string;
  keywords: string[];
  replyText?: string;
  action?: 'STATIC_REPLY' | 'CALL_AI' | 'TACTICA_STOCK_LOOKUP' | 'CREATE_SUPPORT_TICKET';
}

// Reglas por defecto configuradas para el Bot de Tactica Flow
const DEFAULT_KEYWORD_RULES: KeywordRule[] = [
  {
    id: 'rule_greeting',
    keywords: ['hola', 'buenas', 'buenos dias', 'buenas tardes', 'buenas noches', 'saludos'],
    replyText: '¡Hola! 👋 Bienvenido a la atención automatizada de Tactica Flow. ¿En qué te podemos ayudar hoy?\n\n1. Consultar Stock o Catálogo 📦\n2. Consultar Estado de Pedido 📋\n3. Soporte Técnico / Incidente 🛠️',
    action: 'STATIC_REPLY'
  },
  {
    id: 'rule_hours',
    keywords: ['horario', 'horarios', 'atencion', 'abierto', 'direccion'],
    replyText: '🕒 Nuestro horario de atención comercial es de Lunes a Viernes de 9:00 a 18:00 hs.',
    action: 'STATIC_REPLY'
  }
];

export class BotEngineService {
  /**
   * Procesador principal del Bot Auto-Responder para mensajes entrantes de WhatsApp
   */
  static async processIncomingMessage(
    incomingText: string,
    customerPhoneNumber: string,
    conversationHistory: any[] = [],
    tacticaCredentials: TacticaCredentials = {}
  ): Promise<{ replyText: string; source: 'KEYWORD_RULE' | 'AI_AGENT' | 'TACTICA_API' }> {
    const textLower = incomingText.trim().toLowerCase();

    // 1. Evaluar Reglas por Palabras Clave (Keyword Triggers)
    for (const rule of DEFAULT_KEYWORD_RULES) {
      const matched = rule.keywords.some(kw => textLower.includes(kw));
      if (matched && rule.replyText) {
        console.log(`🤖 [BOT ENGINE] Regla activada por palabra clave: ${rule.id}`);
        return {
          replyText: rule.replyText,
          source: 'KEYWORD_RULE'
        };
      }
    }

    // 2. Si no coincide ninguna palabra clave estática, invocar al Agente Inteligente de IA con Function Calling
    console.log(`🧠 [BOT ENGINE] Invocando Agente IA de OpenAI con integración Táctica...`);
    const aiReply = await OpenAiService.processMessage(incomingText, conversationHistory, tacticaCredentials);

    return {
      replyText: aiReply,
      source: 'AI_AGENT'
    };
  }
}
