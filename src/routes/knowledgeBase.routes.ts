import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { KnowledgeBaseService } from '../services/knowledgeBase.service.js';

const router = Router();

// Sin autenticación por ahora: no hay login/usuarios todavía (ver Issue #6 - OAuth). Cuando
// exista, estas rutas deben protegerse con el authMiddleware, igual que el resto de rutas
// sensibles del backend.

// Sin límite de tamaño de archivo a propósito (a pedido de negocio: "documentos sin límites"),
// igual que ya se sacó el límite de caracteres del contexto (ver KnowledgeBaseService.getActiveContext).
// Nota operativa: los archivos se procesan en memoria (multer.memoryStorage()), así que un
// archivo excepcionalmente grande consume RAM del proceso — aceptable porque esta API es de uso
// interno (equipo propio subiendo catálogos/políticas), no un endpoint público.
const upload = multer({
  storage: multer.memoryStorage()
});

/**
 * multer reporta errores llamando a next(err) en vez de lanzar una excepción normal, así que un
 * try/catch alrededor del handler de la ruta no los atrapa. Este wrapper corre multer
 * manualmente y convierte esos errores en la misma forma de JSON { error: "..." } que usa el
 * resto de la API, en vez de dejar que Express devuelva su página de error genérica.
 */
function handleUpload(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Error al procesar el archivo subido';
      return res.status(400).json({ error: message });
    }
    next();
  });
}

// --- Bases de conocimiento ---------------------------------------------------------------

router.get('/', async (req: Request, res: Response) => {
  try {
    res.json(await KnowledgeBaseService.listBases());
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener las bases de conocimiento' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { title, description, isActive } = req.body;

    if (!title || typeof title !== 'string' || title.trim() === '') {
      return res.status(400).json({ error: 'El campo "title" es obligatorio y debe ser una cadena no vacía' });
    }

    const base = await KnowledgeBaseService.createBase({ title, description, isActive });
    res.status(201).json(base);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al crear la base de conocimiento' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { title, description, isActive } = req.body;

    if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
      return res.status(400).json({ error: 'El campo "title" debe ser una cadena no vacía' });
    }

    const updated = await KnowledgeBaseService.updateBase(id, { title, description, isActive });
    if (!updated) {
      return res.status(404).json({ error: 'Base de conocimiento no encontrada' });
    }

    res.json(updated);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al actualizar la base de conocimiento' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const deleted = await KnowledgeBaseService.deleteBase(id);

    if (!deleted) {
      return res.status(404).json({ error: 'Base de conocimiento no encontrada' });
    }

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al eliminar la base de conocimiento' });
  }
});

// --- Documentos (PDF / Word / Markdown / texto) -------------------------------------------

router.get('/:id/documents', async (req: Request, res: Response) => {
  try {
    const knowledgeBaseId = Number(req.params.id);
    const base = await KnowledgeBaseService.getBase(knowledgeBaseId);
    if (!base) {
      return res.status(404).json({ error: 'Base de conocimiento no encontrada' });
    }

    res.json(await KnowledgeBaseService.listDocuments(knowledgeBaseId));
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al obtener los documentos' });
  }
});

router.post('/:id/documents', handleUpload, async (req: Request, res: Response) => {
  try {
    const knowledgeBaseId = Number(req.params.id);

    if (!req.file) {
      return res.status(400).json({ error: 'Falta el archivo (campo "file" en el form-data)' });
    }

    const doc = await KnowledgeBaseService.addDocument(
      knowledgeBaseId,
      req.file.originalname,
      req.file.buffer,
      req.file.mimetype
    );

    res.status(201).json(doc);
  } catch (error: any) {
    const status = error.message === 'Base de conocimiento no encontrada' ? 404 : 400;
    res.status(status).json({ error: error.message || 'Error al subir el documento' });
  }
});

router.delete('/:id/documents/:docId', async (req: Request, res: Response) => {
  try {
    const docId = Number(req.params.docId);
    const deleted = await KnowledgeBaseService.deleteDocument(docId);

    if (!deleted) {
      return res.status(404).json({ error: 'Documento no encontrado' });
    }

    res.status(204).send();
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Error al eliminar el documento' });
  }
});

export default router;
