# ⚙️ Tactica Flow - Backend (Node.js + Express + PostgreSQL)

Backend modular para la plataforma **Tactica Flow**, diseñado para gestionar sesiones de WhatsApp, chat multiagente, agentes de IA conversacional y la integración directa con **Táctica ERP**.

---

## 🛠️ Requisitos Previos

- **Node.js**: v18.0.0 o superior.
- **PostgreSQL**: v13 o superior.

---

## 🚀 Instalación y Configuración

1. Clonar o navegar a la carpeta del backend:
   ```bash
   cd backend
   ```

2. Instalar dependencias:
   ```bash
   npm install
   ```

3. Configurar variables de entorno:
   Copiar `.env.example` a `.env` y ajustar credenciales de PostgreSQL y OpenAI:
   ```bash
   cp .env.example .env
   ```

4. Iniciar en modo desarrollo:
   ```bash
   npm run dev
   ```

---

## 📂 Estructura de Directorios

```
backend/
├── src/
│   ├── config/          # Conexiones a PostgreSQL, Socket.io
│   ├── controllers/     # Controladores de la API REST
│   ├── middlewares/     # JWT y validación de tenants
│   ├── routes/          # Rutas HTTP (/api/health, /api/tactica/*, etc.)
│   ├── services/        # Lógica de negocio (TacticaApiService, OpenAiService, WhatsApp)
│   └── server.js        # Punto de entrada y servidor HTTP/Socket
├── .env.example
├── package.json
└── README.md
```
