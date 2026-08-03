import { Router, Request, Response } from 'express';
import { TacticaApiService } from '../services/tacticaApi.service.js';
import { OpenAiService } from '../services/openai.service.js';
import { BotEngineService } from '../services/botEngine.service.js';

const router = Router();

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'Tactica Flow Backend (TypeScript)', timestamp: new Date() });
});

// Endpoint principal del Motor del Bot Auto-Responder
router.post('/bot/reply', async (req: Request, res: Response) => {
  try {
    const { message, phone, history, tacticaCredentials } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'El campo "message" es obligatorio' });
    }

    const result = await BotEngineService.processIncomingMessage(
      message,
      phone || '5491100000000',
      history || [],
      tacticaCredentials || {}
    );

    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error en el motor del Bot Auto-Responder' });
  }
});

// Proxy a Empresas de Táctica
router.post('/tactica/companies', async (req: Request, res: Response) => {
  try {
    const { usuario, contrasena, ...params } = req.body;
    const result = await TacticaApiService.getCompanies({ usuario, contrasena }, params);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener empresas de Táctica' });
  }
});

// Proxy a Contactos de Táctica
router.post('/tactica/contacts', async (req: Request, res: Response) => {
  try {
    const { usuario, contrasena, ...params } = req.body;
    const result = await TacticaApiService.getContacts({ usuario, contrasena }, params);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener contactos de Táctica' });
  }
});

// Endpoint para probar respuesta de IA
router.post('/ai/chat', async (req: Request, res: Response) => {
  try {
    const { message, history, tacticaCredentials } = req.body;
    const aiResponse = await OpenAiService.processMessage(message, history || [], tacticaCredentials || {});
    res.json({ reply: aiResponse });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al procesar consulta de IA' });
  }
});

export default router;
