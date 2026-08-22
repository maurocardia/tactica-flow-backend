import { AIService } from './ai.service.js';
import { TacticaCredentials } from './tacticaApi.service.js';
import { KeywordRuleService } from './keywordRule.service.js';
import { KnowledgeBaseService } from './knowledgeBase.service.js';

export type { KeywordRule } from './keywordRule.service.js';

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
    for (const rule of await KeywordRuleService.listActiveRules()) {
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
    console.log(`🧠 [BOT ENGINE] Invocando Agente IA (${process.env.AI_PROVIDER || 'gemini'}) con integración Táctica...`);

    // Contexto de la Base de Conocimiento activa (Issue #7): si falla la consulta a la DB, no
    // tumbamos el bot — seguimos sin contexto extra en vez de romper la respuesta al cliente.
    let knowledgeContext = '';
    try {
      knowledgeContext = await KnowledgeBaseService.getActiveContext();
    } catch (err) {
      console.error('⚠️ [BOT ENGINE] No se pudo obtener el contexto de la Base de Conocimiento:', err);
    }

    const aiReply = await AIService.processMessage(incomingText, conversationHistory, tacticaCredentials, knowledgeContext);

    return {
      replyText: aiReply,
      source: 'AI_AGENT'
    };
  }
}
