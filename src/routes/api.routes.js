import { Router } from 'express';
import { TacticaApiService } from '../services/tacticaApi.service.js';
import { OpenAiService } from '../services/openai.service.js';

const router = Router();

// Endpoint de prueba de estado del backend
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Tactica Flow Backend', timestamp: new Date() });
});

// Proxy a Empresas de Táctica
router.post('/tactica/companies', async (req, res) => {
  try {
    const { usuario, contrasena, ...params } = req.body;
    const result = await TacticaApiService.getCompanies({ usuario, contrasena }, params);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error al obtener empresas de Táctica' });
  }
});

// Proxy a Contactos de Táctica
router.post('/tactica/contacts', async (req, res) => {
  try {
    const { usuario, contrasena, ...params } = req.body;
    const result = await TacticaApiService.getContacts({ usuario, contrasena }, params);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error al obtener contactos de Táctica' });
  }
});

// Endpoint para probar respuesta de IA
router.post('/ai/chat', async (req, res) => {
  try {
    const { message, history, tacticaCredentials } = req.body;
    const aiResponse = await OpenAiService.processMessage(message, history || [], tacticaCredentials || {});
    res.json({ reply: aiResponse });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Error al procesar consulta de IA' });
  }
});

export default router;
