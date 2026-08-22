import axios, { AxiosRequestConfig } from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const TACTICA_API_URL = process.env.TACTICA_API_URL || 'http://localhost:3000/api';

export interface TacticaCredentials {
  usuario?: string;
  contrasena?: string;
}

export class TacticaApiService {
  private static async request<T = any>(endpoint: string, method: 'GET' | 'POST' = 'GET', data: any = {}, headers: any = {}): Promise<T> {
    try {
      const config: AxiosRequestConfig = {
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
    } catch (error: any) {
      console.error(`❌ Error en TacticaApiService (${endpoint}):`, error.response?.data || error.message);
      throw error.response?.data || error;
    }
  }

  static async getCompanies(credentials: TacticaCredentials, params: Record<string, any> = {}) {
    return this.request('/Tactica/Empresas', 'GET', { ...params, ...credentials });
  }

  static async createCompany(credentials: TacticaCredentials, companyData: Record<string, any>) {
    return this.request('/Tactica/CrearEmpresas', 'POST', { ...companyData, ...credentials });
  }

  static async getContacts(credentials: TacticaCredentials, params: Record<string, any> = {}) {
    return this.request('/Tactica/Contactos', 'GET', { ...params, ...credentials });
  }

  static async createContact(credentials: TacticaCredentials, contactData: Record<string, any>) {
    return this.request('/Tactica/CrearContactos', 'POST', { ...contactData, ...credentials });
  }

  static async getSupports(credentials: TacticaCredentials, params: Record<string, any> = {}) {
    return this.request('/Tactica/Soporte', 'POST', { ...params, ...credentials });
  }

  static async createSupport(credentials: TacticaCredentials, supportData: Record<string, any>) {
    return this.request('/Tactica/CrearSoporte', 'POST', { ...supportData, ...credentials });
  }

  static async getProducts(credentials: TacticaCredentials, params: Record<string, any> = {}) {
    return this.request('/Tactica/Productos', 'POST', { ...params, ...credentials });
  }

  static async getPresupuestos(credentials: TacticaCredentials, params: Record<string, any> = {}) {
    return this.request('/Tactica/Presupuestos', 'POST', { ...params, ...credentials });
  }

  static async createPresupuesto(credentials: TacticaCredentials, budgetData: Record<string, any>) {
    return this.request('/Tactica/CrearPresupuesto', 'POST', { ...budgetData, ...credentials });
  }

  static async createActivity(credentials: TacticaCredentials, activityData: Record<string, any>) {
    return this.request('/Tactica/CrearActividades', 'POST', { ...activityData, ...credentials });
  }
}
