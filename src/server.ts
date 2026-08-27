import express, { Request, Response } from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import apiRoutes from './routes/api.routes.js';
import knowledgeBaseRoutes from './routes/knowledgeBase.routes.js';
import authRoutes from './routes/auth.routes.js';
import whatsappRoutes from './routes/whatsapp.routes.js';
import scheduledJobRoutes from './routes/scheduledJob.routes.js';
import { initDatabase } from './config/db.js';
import { ConversationService } from './services/conversation.service.js';
import { KeywordRuleService } from './services/keywordRule.service.js';
import { SchedulerWorker } from './services/scheduler.worker.js';
import { WhatsappService } from './services/whatsapp.service.js';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// Middlewares
app.use(cors());
app.use(express.json());

// Routes
app.use('/api', apiRoutes);
app.use('/api/knowledge-bases', knowledgeBaseRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/scheduled-jobs', scheduledJobRoutes);

// Socket.io Connection
io.on('connection', (socket: Socket) => {
  console.log(`🔌 Cliente conectado a Socket.io: ${socket.id}`);

  socket.on('join_chat', (chatId: string) => {
    socket.join(`chat_${chatId}`);
    console.log(`👤 Usuario se unió al chat: chat_${chatId}`);
  });

  socket.on('disconnect', () => {
    console.log(`❌ Cliente desconectado: ${socket.id}`);
  });
});

export { io };

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await initDatabase();
    await Promise.all([ConversationService.seedIfEmpty(), KeywordRuleService.seedIfEmpty()]);
    // Iniciar worker de mensajes programados
    SchedulerWorker.start(30000);
    // Reconectar automáticamente sesiones activas de WhatsApp guardadas en PostgreSQL
    WhatsappService.reconnectAllActiveSessions();
  } catch (err) {
    console.error('⚠️  No se pudo conectar/inicializar PostgreSQL. El servidor sigue arrancando,');
    console.error('    pero los endpoints de conversaciones y reglas de bot van a fallar hasta que');
    console.error('    la conexión a la base funcione. Revisá PG_HOST/PG_PORT/PG_USER/PG_PASSWORD/PG_DATABASE');
    console.error('    (y probá PG_SSL=true si el proveedor exige SSL). Error:', err);
  }

  server.listen(PORT, () => {
    console.log(`🚀 Tactica Flow Backend (TypeScript) corriendo en puerto ${PORT}`);
  });
}

start();
