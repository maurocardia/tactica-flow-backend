# Chatbot — Backend (Tactica Flow)

Documentación de lo construido para el motor de chatbot: reglas por palabra clave, agente de IA con function calling hacia Táctica ERP, API de conversaciones/mensajes con tiempo real, y persistencia en Postgres.

## 1. Qué hace hoy

- Responde mensajes automáticamente por **reglas de palabras clave** (configurables en runtime, ya no hardcodeadas).
- Si ninguna regla matchea, cae a un **agente de IA (OpenAI, function calling)** que puede consultar stock, crear tickets de soporte y crear contactos directamente en Táctica ERP.
- Expone una **API de conversaciones y mensajes** con eventos en tiempo real por Socket.io (para el inbox del frontend).
- Todo persiste en **PostgreSQL** (antes vivía en memoria y se perdía al reiniciar).
- **No** está conectado a WhatsApp real todavía (Baileys está instalado pero sin usar) — todo se prueba vía API/inbox.

## 2. Archivos relevantes

```
src/
├── server.ts                        # arranque, Socket.io, inicialización de DB
├── config/
│   └── db.ts                        # Pool de Postgres, esquema (CREATE TABLE IF NOT EXISTS), initDatabase()
├── services/
│   ├── botEngine.service.ts         # orquesta: reglas → si no matchea, IA
│   ├── openai.service.ts            # agente de IA + function calling hacia Táctica
│   ├── tacticaApi.service.ts        # cliente HTTP del API .NET de Táctica ERP
│   ├── keywordRule.service.ts       # CRUD de reglas por palabra clave (Postgres)
│   └── conversation.service.ts      # conversaciones + mensajes (Postgres)
└── routes/
    └── api.routes.ts                # todos los endpoints REST
```

## 3. Motor del bot

`BotEngineService.processIncomingMessage(texto, telefono, historial, credencialesTactica)`:

1. Busca entre las reglas **activas** (`KeywordRuleService.listActiveRules()`) si el texto contiene alguna palabra clave. Si matchea, responde con el `replyText` fijo de la regla (`source: 'KEYWORD_RULE'`).
2. Si ninguna regla matchea, llama a `OpenAiService.processMessage(...)`, que usa GPT-4o-mini con 3 funciones disponibles: `consultar_inventario`, `crear_ticket_soporte`, `crear_contacto` — todas ejecutan una llamada real a `TacticaApiService` (`source: 'AI_AGENT'`).

Nota: el campo `action` de una regla hoy solo tiene efecto real si es `STATIC_REPLY`. Los otros tres valores (`CALL_AI`, `TACTICA_STOCK_LOOKUP`, `CREATE_SUPPORT_TICKET`) existen en el esquema para integraciones futuras pero todavía no están conectados a ninguna lógica.

## 4. Reglas por palabra clave (CRUD)

Tabla `keyword_rules`. Endpoints:

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/bot/rules` | Lista todas las reglas (activas e inactivas) |
| POST | `/api/bot/rules` | Crea una regla — body: `{ name, keywords[], replyText, action?, isActive? }` |
| PUT | `/api/bot/rules/:id` | Actualiza (parcial) |
| DELETE | `/api/bot/rules/:id` | Elimina |
| POST | `/api/bot/reply` | Prueba directa del motor — body: `{ message }` → `{ replyText, source }` |

Al arrancar por primera vez (tabla vacía) se siembran las 2 reglas originales: "Saludo de bienvenida" y "Horario de atención".

## 5. Conversaciones y mensajes (API + tiempo real)

Tablas `conversations` y `messages`. Endpoints:

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/conversations` | Lista conversaciones, ordenadas por último mensaje |
| GET | `/api/conversations/:id/messages` | Mensajes de una conversación |
| POST | `/api/conversations/:id/messages` | Crea un mensaje — body: `{ text, sender?: 'agent'\|'customer' }` (default `'agent'`) |

Reglas de negocio del `POST`:
- Si `sender: 'customer'` y la conversación tiene `status: 'bot'`, se dispara automáticamente `BotEngineService` y se guarda también la respuesta del bot como mensaje. La respuesta incluye ambos mensajes.
- Cada mensaje nuevo emite por Socket.io `new_message` a la room `chat_${conversationId}`.
- Cada cambio de conversación (nuevo mensaje, `lastMsg`, `unread`) emite `conversation_updated` a todos los clientes conectados.

Al arrancar por primera vez se siembran 3 conversaciones de demo (Juan Pérez en modo `bot`, María Gómez en `active`, Carlos Rodríguez en `resolved`).

## 6. Base de datos (PostgreSQL)

Esquema **simplificado**, no el multi-tenant completo descrito originalmente en `DOCUMENTACION_TECNICA.md` (ese depende de `tenants`/`users`/`whatsapp_contacts`, que todavía no existen). Se puede migrar más adelante cuando haya auth/multi-tenant real.

```sql
keyword_rules(id TEXT PK, name, keywords TEXT[], reply_text, action, is_active, created_at)
conversations(id SERIAL PK, name, phone, last_msg, last_message_at, unread, tag, status)
messages(id SERIAL PK, conversation_id → conversations(id) ON DELETE CASCADE, sender, text, created_at)
```

Las tablas se crean solas al arrancar (`initDatabase()` en `server.ts`, `CREATE TABLE IF NOT EXISTS`). Si fallan las tablas o la conexión, el servidor **no se cae**: sigue arrancando, `/api/health` funciona, pero los endpoints de conversaciones/reglas devuelven `500` con el error real hasta que la conexión funcione.

### Variables de entorno (`.env`)

```
PG_HOST=...
PG_PORT=...
PG_USER=...
PG_PASSWORD=...
PG_DATABASE=...
PG_SSL=false        # poner en true si el proveedor exige SSL (algunos proxies de Railway sí, otros no)
```

Ya están cargadas con las credenciales de Railway que diste. **Importante**: no pude verificar la conexión en vivo desde este entorno (sin salida de red hacia hosts externos por TCP) — al validar el schema SQL sí lo probé con una instancia Postgres embebida, pero la conexión real a Railway hay que confirmarla corriendo el backend en tu máquina y revisando el log de arranque.

## 7. Cómo correrlo y probarlo

```bash
npm install
npm run dev   # tsx watch, puerto 5000 (PORT en .env)
```

Al arrancar, buscá en la consola:
- `🗄️ Esquema de PostgreSQL verificado/creado correctamente.` → DB conectada bien.
- `⚠️ No se pudo conectar/inicializar PostgreSQL...` → revisar credenciales / probar `PG_SSL=true`.

Pruebas rápidas con curl:

```bash
curl http://localhost:5000/api/health
curl http://localhost:5000/api/conversations
curl -X POST http://localhost:5000/api/bot/reply -H "Content-Type: application/json" -d '{"message":"hola"}'
curl -X POST http://localhost:5000/api/conversations/1/messages -H "Content-Type: application/json" -d '{"text":"horario?","sender":"customer"}'
```

## 8. Limitaciones conocidas / próximos pasos

- **WhatsApp no conectado**: falta un `whatsapp.service.ts` con Baileys que reciba mensajes reales y llame a este mismo motor.
- **Sin autenticación**: `jsonwebtoken`/`bcryptjs` están instalados pero no hay rutas de login/registro.
- **Sin multi-tenant**: todo corre para una sola empresa; el esquema documentado original contempla `tenants`, pero no está implementado.
- **Acciones de regla no-`STATIC_REPLY`** (`CALL_AI`, `TACTICA_STOCK_LOOKUP`, `CREATE_SUPPORT_TICKET`) son placeholders sin lógica todavía.
