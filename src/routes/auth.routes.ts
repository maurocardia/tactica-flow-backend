import { Router, Request, Response } from 'express';
import { AuthService } from '../services/auth.service.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

const router = Router();

// Endpoint público para que la extensión obtenga el Client ID dinámicamente desde el .env del backend
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  });
});

router.post('/google', async (req: Request, res: Response) => {
  try {
    const { idToken } = req.body;

    if (!idToken || typeof idToken !== 'string') {
      return res.status(400).json({ error: 'El campo "idToken" es obligatorio' });
    }

    const payload = await AuthService.verifyGoogleToken(idToken);
    const user = await AuthService.findOrCreateUser(payload);
    const token = AuthService.generateJwt(user);

    res.json({ token, user });
  } catch (error: any) {
    res.status(401).json({ error: error.message || 'No se pudo verificar el token de Google' });
  }
});

router.get('/me', authMiddleware, async (req: Request, res: Response) => {
  try {
    const user = await AuthService.getUserById(req.user!.id);

    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    res.json(user);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener el usuario autenticado' });
  }
});

export default router;
