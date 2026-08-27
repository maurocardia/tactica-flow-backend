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
    tacticaCredentials: TacticaCredentials = {},
    aiFallbackEnabled: boolean = true,
    customInstructions: string = ''
  ): Promise<{ replyText: string; source: 'KEYWORD_RULE' | 'AI_AGENT' | 'TACTICA_API'; sourceKbIds: number[] } | null> {
    const textLower = incomingText.trim().toLowerCase();

    // 1. Evaluar Reglas por Palabras Clave (Keyword Triggers)
    for (const rule of await KeywordRuleService.listActiveRules()) {
      const matched = rule.keywords.some(kw => textLower.includes(kw));
      if (matched) {
        console.log(`🤖 [BOT ENGINE] Regla activada por palabra clave: ${rule.id} (${rule.name}, acción: ${rule.action})`);

        if (rule.action === 'CALL_AI') {
          let knowledgeContext = '';
          let sourceKbIds: number[] = [];
          try {
            const active = await KnowledgeBaseService.getActiveContext(incomingText);
            knowledgeContext = active.context;
            sourceKbIds = active.baseIds;
          } catch (err) {
            console.error('⚠️ [BOT ENGINE] No se pudo obtener el contexto de KB:', err);
          }
          const customPrompt = `${customInstructions}\nInstrucción de este bloque: ${rule.replyText}`;
          const aiReply = await AIService.processMessage(incomingText, conversationHistory, tacticaCredentials, knowledgeContext, customPrompt);
          return {
            replyText: aiReply,
            source: 'AI_AGENT',
            sourceKbIds
          };
        }

        if (rule.action === 'HANDOFF') {
          return {
            replyText: rule.replyText || 'Te estamos transfiriendo con un asesor de nuestro equipo. En instantes te responderán por este chat.',
            source: 'KEYWORD_RULE',
            sourceKbIds: []
          };
        }

        if (rule.replyText) {
          return {
            replyText: rule.replyText,
            source: 'KEYWORD_RULE',
            sourceKbIds: []
          };
        }
      }
    }

    // Switch "Responder con IA": ninguna regla matcheó y el fallback está apagado -> no hay
    // respuesta automática, queda solo el chatbot manual (el mensaje del cliente ya se logueó
    // en el llamador, esto simplemente no genera una respuesta del bot).
    if (!aiFallbackEnabled) {
      console.log('🤖 [BOT ENGINE] Ninguna regla matcheó y el fallback de IA está apagado — sin respuesta automática.');
      return null;
    }

    // 2. Si no coincide ninguna palabra clave estática, invocar al Agente Inteligente de IA con Function Calling
    console.log(`🧠 [BOT ENGINE] Invocando Agente IA (${process.env.AI_PROVIDER || 'gemini'}) con integración Táctica...`);

    // Contexto de la Base de Conocimiento activa (Issue #7): si falla la consulta a la DB, no
    // tumbamos el bot — seguimos sin contexto extra en vez de romper la respuesta al cliente.
    let knowledgeContext = '';
    let sourceKbIds: number[] = [];
    try {
      const active = await KnowledgeBaseService.getActiveContext(incomingText);
      knowledgeContext = active.context;
      sourceKbIds = active.baseIds;
    } catch (err) {
      console.error('⚠️ [BOT ENGINE] No se pudo obtener el contexto de la Base de Conocimiento:', err);
    }

    const aiReply = await AIService.processMessage(incomingText, conversationHistory, tacticaCredentials, knowledgeContext, customInstructions);

    return {
      replyText: aiReply,
      source: 'AI_AGENT',
      sourceKbIds
    };
  }
}
