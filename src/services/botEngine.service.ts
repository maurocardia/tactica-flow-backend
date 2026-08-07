import { OpenAiService } from './openai.service.js';
import { TacticaApiService, TacticaCredentials } from './tacticaApi.service.js';
import { KeywordRuleService } from './keywordRule.service.js';

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
    console.log(`🧠 [BOT ENGINE] Invocando Agente IA de OpenAI con integración Táctica...`);
    const aiReply = await OpenAiService.processMessage(incomingText, conversationHistory, tacticaCredentials);

    return {
      replyText: aiReply,
      source: 'AI_AGENT'
    };
  }
}
