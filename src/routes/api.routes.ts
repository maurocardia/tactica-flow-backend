import { Router, Request, Response } from 'express';
import { TacticaApiService } from '../services/tacticaApi.service.js';
import { OpenAiService } from '../services/openai.service.js';

const router = Router();

router.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'Tactica Flow Backend (TypeScript)', timestamp: new Date() });
});

router.post('/tactica/companies', async (req: Request, res: Response) => {
  try {
    const { usuario, contrasena, ...params } = req.body;
    const result = await TacticaApiService.getCompanies({ usuario, contrasena }, params);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener empresas de Táctica' });
  }
});

router.post('/tactica/contacts', async (req: Request, res: Response) => {
  try {
    const { usuario, contrasena, ...params } = req.body;
    const result = await TacticaApiService.getContacts({ usuario, contrasena }, params);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener contactos de Táctica' });
  }
});

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
