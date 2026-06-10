import type { FastifyInstance } from 'fastify';
import type { PreHandler } from '../app.js';

export interface BillingRoutesDeps {
  requireAuth: PreHandler;
}

/**
 * Subscription summary for the console (#64-adjacent). Deliberately static: the
 * product is a side-project whose paid tier just covers the server cost
 * (PRD §5 — no complex billing). A real cashbox/subscription integration would
 * replace the figures here without changing the screen.
 */
export function registerBillingRoutes(app: FastifyInstance, deps: BillingRoutesDeps): void {
  app.get('/api/admin/billing', { preHandler: deps.requireAuth }, async () => ({
    plan: {
      id: 'cloud',
      name: 'ArtelMemory Cloud',
      price: '$5 / мес',
      status: 'active',
      renews_at: null,
    },
    included: [
      'Managed-хостинг без своего сервера и сертификатов',
      'Общая память с шерингом доступа',
      'Семантический поиск (Qdrant)',
      'Подписка покрывает стоимость инфраструктуры',
    ],
    self_hosted: {
      name: 'Self-hosted',
      price: 'Бесплатно',
      note: 'Open-source: разверните у себя одним docker compose. Данные остаются в вашем контуре.',
    },
  }));
}
