import type { FastifyInstance } from 'fastify';
import type { PreHandler } from '../app.js';

export interface BillingRoutesDeps {
  requireAuth: PreHandler;
}

/**
 * Subscription summary for the console. Deliberately static/demo: the paid tier
 * just covers the server cost (PRD §5 — no real billing). The charge history and
 * payment method are placeholders a real cashbox integration would replace.
 */
export function registerBillingRoutes(app: FastifyInstance, deps: BillingRoutesDeps): void {
  app.get('/api/admin/billing', { preHandler: deps.requireAuth }, async () => ({
    plan: {
      id: 'cloud',
      name: 'ArtelMemory Cloud',
      price: '300 ₽',
      period: 'мес',
      status: 'active',
      renews_at: '2026-07-01T20:31:00.000Z',
    },
    included: [
      'Managed-хостинг без своего сервера и сертификатов',
      'Общая память с шерингом доступа',
      'Семантический поиск (Qdrant)',
      'Символическая цена ниже себестоимости — проект некоммерческий, open-source',
    ],
    self_hosted: {
      name: 'Self-hosted',
      price: 'Бесплатно',
      note: 'Open-source: разверните у себя одним docker compose. Данные остаются в вашем контуре.',
    },
    payment_method: { brand: 'Visa', last4: '4242' },
    history: [
      { id: 'inv_2026_06', date: '1 июня 2026, 20:31', amount: '300 ₽', status: 'paid', period: 'Июнь 2026' },
      { id: 'inv_2026_05', date: '1 мая 2026, 20:31', amount: '300 ₽', status: 'paid', period: 'Май 2026' },
      { id: 'inv_2026_04', date: '1 апреля 2026, 20:31', amount: '300 ₽', status: 'paid', period: 'Апрель 2026' },
    ],
  }));
}
