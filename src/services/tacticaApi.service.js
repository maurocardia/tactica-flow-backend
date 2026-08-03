import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const TACTICA_API_URL = process.env.TACTICA_API_URL || 'http://localhost:3000/api';

/**
 * Servicio proxy para conectar Tactica Flow con la API .NET / Backend de Táctica ERP
 */
export class TacticaApiService {
  /**
   * Helper base para realizar peticiones HTTP a Táctica
   */
  static async request(endpoint, method = 'GET', data = {}, headers = {}) {
    try {
      const config = {
        method,
        url: `${TACTICA_API_URL}${endpoint}`,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        ...(method === 'GET' ? { params: data } : { data })
      };

      const response = await axios(config);
      return response.data;
    } catch (error) {
      console.error(`❌ Error en TacticaApiService (${endpoint}):`, error.response?.data || error.message);
      throw error.response?.data || error;
    }
  }

  // --- MÓDULO EMPRESAS ---
  static async getCompanies(credentials, params = {}) {
    return this.request('/Tactica/Empresas', 'GET', { ...params, ...credentials });
  }

  static async createCompany(credentials, companyData) {
    return this.request('/Tactica/CrearEmpresas', 'POST', { ...companyData, ...credentials });
  }

  // --- MÓDULO CONTACTOS ---
  static async getContacts(credentials, params = {}) {
    return this.request('/Tactica/Contactos', 'GET', { ...params, ...credentials });
  }

  static async createContact(credentials, contactData) {
    return this.request('/Tactica/CrearContactos', 'POST', { ...contactData, ...credentials });
  }

  // --- MÓDULO SOPORTE ---
  static async getSupports(credentials, params = {}) {
    return this.request('/Tactica/Soporte', 'POST', { ...params, ...credentials });
  }

  static async createSupport(credentials, supportData) {
    return this.request('/Tactica/CrearSoporte', 'POST', { ...supportData, ...credentials });
  }

  // --- MÓDULO PRODUCTOS / STOCK ---
  static async getProducts(credentials, params = {}) {
    return this.request('/Tactica/Productos', 'POST', { ...params, ...credentials });
  }

  // --- MÓDULO PRESUPUESTOS ---
  static async getPresupuestos(credentials, params = {}) {
    return this.request('/Tactica/Presupuestos', 'POST', { ...params, ...credentials });
  }

  static async createPresupuesto(credentials, budgetData) {
    return this.request('/Tactica/CrearPresupuesto', 'POST', { ...budgetData, ...credentials });
  }

  // --- MÓDULO ACTIVIDADES ---
  static async createActivity(credentials, activityData) {
    return this.request('/Tactica/CrearActividades', 'POST', { ...activityData, ...credentials });
  }
}
