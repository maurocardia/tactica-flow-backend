import OpenAI from 'openai';
import dotenv from 'dotenv';
import { TacticaApiService } from './tacticaApi.service.js';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy_key'
});

// Definición de Herramientas (Function Calling) disponibles para el Agente IA de Táctica
const TACTICA_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'consultar_inventario',
      description: 'Consulta la disponibilidad de stock o productos en Táctica ERP.',
      parameters: {
        type: 'object',
        properties: {
          descripcion: { type: 'string', description: 'Nombre o descripción del producto a buscar' },
          codigo: { type: 'string', description: 'Código único de producto (opcional)' }
        },
        required: ['descripcion']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'crear_ticket_soporte',
      description: 'Crea un nuevo incidente o ticket de soporte técnico en Táctica ERP.',
      parameters: {
        type: 'object',
        properties: {
          idContacto: { type: 'string', description: 'RecID o identificador del contacto en Táctica' },
          problema: { type: 'string', description: 'Descripción detallada de la falla o solicitud del cliente' },
          prioridad: { type: 'number', description: '0 = Alta, 1 = Media, 2 = Baja' }
        },
        required: ['idContacto', 'problema']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'crear_contacto',
      description: 'Registra un nuevo contacto de cliente en Táctica ERP.',
      parameters: {
        type: 'object',
        properties: {
          idEmpresa: { type: 'string', description: 'RecID de la Empresa a la que pertenece' },
          nombre: { type: 'string', description: 'Nombre del contacto' },
          apellido: { type: 'string', description: 'Apellido del contacto' },
          correo: { type: 'string', description: 'Correo electrónico (opcional)' }
        },
        required: ['idEmpresa', 'nombre']
      }
    }
  }
];

export class OpenAiService {
  /**
   * Procesa un mensaje de usuario a través del agente conversacional de OpenAI
   */
  static async processMessage(userMessage, conversationHistory = [], tacticaCredentials = {}) {
    try {
      const messages = [
        {
          role: 'system',
          content: `Eres el Asistente Virtual Inteligente de Tactica Flow integrado con Táctica ERP.
          Tu objetivo es atender a los clientes amablemente y resolver sus consultas sobre productos, stock, tickets de soporte y pedidos.
          Utiliza las funciones disponibles cuando sea necesario consultar o crear información en el ERP.`
        },
        ...conversationHistory,
        { role: 'user', content: userMessage }
      ];

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        tools: TACTICA_TOOLS,
        tool_choice: 'auto'
      });

      const responseMessage = response.choices[0].message;

      // Si la IA decide llamar una función
      if (responseMessage.tool_calls) {
        for (const toolCall of responseMessage.tool_calls) {
          const functionName = toolCall.function.name;
          const args = JSON.parse(toolCall.function.arguments);
          let functionResult = null;

          if (functionName === 'consultar_inventario') {
            functionResult = await TacticaApiService.getProducts(tacticaCredentials, { Descripcion: args.descripcion });
          } else if (functionName === 'crear_ticket_soporte') {
            functionResult = await TacticaApiService.createSupport(tacticaCredentials, {
              IDContacto: args.idContacto,
              Problema: args.problema,
              Prioridad: args.prioridad || 1
            });
          } else if (functionName === 'crear_contacto') {
            functionResult = await TacticaApiService.createContact(tacticaCredentials, args);
          }

          // Segundollamado a la IA con el resultado de la herramienta
          messages.push(responseMessage);
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(functionResult || { success: true })
          });
        }

        const secondResponse = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages
        });

        return secondResponse.choices[0].message.content;
      }

      return responseMessage.content;
    } catch (error) {
      console.error('❌ Error en OpenAiService:', error);
      return 'Lo siento, ocurrió un error al procesar tu mensaje. Un asesor te atenderá pronto.';
    }
  }
}
