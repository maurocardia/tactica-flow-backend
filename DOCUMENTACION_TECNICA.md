# 📘 Tactica Flow - Especificación Técnica y Arquitectura (Backend)

Plataforma de comunicación empresarial inteligente (estilo BlueTicks para WhatsApp) integrada de forma nativa con **Táctica ERP** a través de su API .NET / Agente de WebSockets.

---

## 1. Visión y Objetivos del Proyecto

**Tactica Flow Backend** centraliza y automatiza la atención al cliente por WhatsApp (y a futuro Instagram, Messenger, Telegram, Email), combinando:
1. **Bandeja Multiescritorio / Multiagente**: Gestión centralizada de chats con etiquetas, transferencias y notas internas.
2. **Motor de Bots y Automatización**: Diagramación de flujos conversacionales interactivos y disparadores por eventos.
3. **Agentes Inteligentes de IA (OpenAI Function Calling)**: Comprensión del lenguaje natural para resolver solicitudes avanzadas (ej. consultar inventario, agendar soporte, crear cotizaciones o pedidos).
4. **Integración Directa con Táctica ERP**: Ejecución de acciones en tiempo real sobre la base de datos de Táctica mediante el Agente .NET / Backend de Táctica.

---

## 2. Stack Tecnológico

- **Backend**: Node.js (v18+ / v20+), Express, Socket.io (tiempo real).
- **Base de Datos Principal**: PostgreSQL (Gestión de usuarios, chats, mensajes, bots, logs, automatizaciones, credenciales de WhatsApp).
- **ORM / Driver DB**: `pg` / `Knex.js` o `Prisma ORM`.
- **Motor WhatsApp**: `@whiskeysockets/baileys` (o Meta Cloud API).
- **Motor IA**: OpenAI API (GPT-4o / GPT-4o-mini) con Function Calling / Structured Outputs.
- **Integración Táctica**: Proxy HTTP al API .NET de Táctica (`/Tactica/Empresas`, `/Tactica/Contactos`, `/Tactica/soporte`, `/Tactica/Productos`, `/Tactica/Presupuestos`, etc.) o WebSocket directo con Agente .NET.

---

## 3. Arquitectura General del Sistema

```
                  ┌──────────────────────────────────────────────┐
                  │                TÁCTICA ERP                   │
                  │ (Clientes, Pedidos, Soporte, Stock, Cotiz.)  │
                  └──────────────────────▲───────────────────────┘
                                         │
                        API .NET / Agente WebSocket Táctica
                                         │
─────────────────────────────────────────┼──────────────────────────────────────────
                                         │ HTTP REST / WebSocket
                  ┌──────────────────────▼───────────────────────┐
                  │            TACTICA FLOW BACKEND              │
                  │            (Node.js + Express)               │
                  └────────┬─────────────┬──────────────┬────────┘
                           │             │              │
       ┌───────────────────┴──┐   ┌──────┴───────┐  ┌───┴────────────────┐
       │ Motor de WhatsApp    │   │ Motor IA     │  │ PostgreSQL DB      │
       │ (Baileys / WebSockets)│   │ (OpenAI GPT) │  │ (Chats, Bots, Logs)│
       └──────────────────────┘   └──────────────┘  └────────────────────┘
                                         ▲
                                         │ Socket.io (Realtime Events)
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │            TACTICA FLOW FRONTEND             │
                  │               (React + Vite)                 │
                  └──────────────────────────────────────────────┘
```

---

## 4. Esquema de Base de Datos (PostgreSQL)

> **Estado actual (implementado):** esquema simplificado, sin `tenants`/`users`/`whatsapp_sessions`/`whatsapp_contacts` — la app corre hoy para una sola empresa, sin auth. Se crea solo al arrancar el servidor (`initDatabase()` en `src/config/db.ts`, `CREATE TABLE IF NOT EXISTS`).

```sql
CREATE TABLE keyword_rules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    keywords TEXT[] NOT NULL,
    reply_text TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'STATIC_REPLY', -- STATIC_REPLY | CALL_AI | TACTICA_STOCK_LOOKUP | CREATE_SUPPORT_TICKET
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE conversations (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    last_msg TEXT NOT NULL DEFAULT '',
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    unread INT NOT NULL DEFAULT 0,
    tag TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'bot', 'resolved'))
);

CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    conversation_id INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender TEXT NOT NULL CHECK (sender IN ('customer', 'agent', 'bot')),
    text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

> **Visión original / roadmap (no implementado todavía):** el diseño multi-tenant completo con `tenants`, `users` (roles y credenciales de Táctica por usuario), `whatsapp_sessions`, `whatsapp_contacts` (vínculo a RecId de Empresa/Contacto en Táctica), `bot_flows` (flujos visuales) e `integration_logs` (auditoría de acciones contra Táctica) sigue siendo el objetivo a mediano plazo, pero requiere primero autenticación y soporte multi-empresa. Ver "Limitaciones conocidas / próximos pasos" en [CHATBOT.md](CHATBOT.md).

---

## 5. Módulos Backend y Servicios

### 5.1 Servicios de Integración

- `src/services/tacticaApi.service.ts`: Comunicación con el API .NET de Táctica ERP.
- `src/services/openai.service.ts`: Agente de IA conversacional con Function Calling (`consultar_inventario`, `crear_ticket_soporte`, `crear_contacto`).
- `src/services/keywordRule.service.ts`: CRUD de reglas por palabra clave (Postgres).
- `src/services/conversation.service.ts`: Conversaciones y mensajes, con eventos en tiempo real vía Socket.io (Postgres).
- `src/services/botEngine.service.ts`: Orquesta el motor del bot — reglas por palabra clave primero, IA como fallback.
- `whatsapp.service.ts` (**pendiente**): Baileys está instalado como dependencia pero todavía no hay servicio que reciba mensajes reales de WhatsApp; hoy todo se prueba vía API/inbox.

---

## 6. Autenticación y Seguridad

- Autenticación mediante **JWT**.
- Inyección obligatoria de credenciales de usuario local de Táctica (`usuario` y `contrasena`) en el payload de peticiones POST a Táctica.
