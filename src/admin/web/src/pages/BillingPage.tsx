import { CheckCircle, CreditCard, CloudCheck, Cube, Receipt } from '@phosphor-icons/react';
import { Badge, Loading, useToast } from '@/components/ui-kit';
import { useBilling } from '@/hooks/use-data';
import { formatDate } from '@/lib/format';

export function BillingPage() {
  const billing = useBilling();
  const toast = useToast();
  if (billing.isPending) return <Loading />;
  const d = billing.data;
  if (!d) return <p className="muted">Нет данных.</p>;

  const demo = () => toast('Демо: приём платежей пока не подключён');

  return (
    <>
      <div className="page-head">
        <div className="pt">
          <h2>Подписка</h2>
          <p>Символическая цена ниже себестоимости — проект некоммерческий. Self-hosted бесплатен навсегда.</p>
        </div>
      </div>

      <div className="grid-2">
        <div className="card card-pad" style={{ borderColor: 'var(--accent)' }}>
          <div className="row between">
            <span className="row" style={{ gap: 10 }}>
              <CloudCheck size={22} color="var(--accent)" />
              <h3 style={{ fontSize: 18 }}>{d.plan.name}</h3>
            </span>
            <Badge tone="ok">активна</Badge>
          </div>
          <div style={{ fontFamily: 'var(--font-head)', fontSize: 34, fontWeight: 800, marginTop: 16 }}>
            {d.plan.price} <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--fg-3)' }}>/ {d.plan.period ?? 'мес'}</span>
          </div>
          {d.plan.renews_at && <p className="muted" style={{ marginTop: 4 }}>Следующее списание: {formatDate(d.plan.renews_at)}</p>}

          {d.payment_method && (
            <div className="row" style={{ gap: 10, marginTop: 16, padding: '12px 14px', borderRadius: 'var(--r-md)', background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
              <CreditCard size={20} color="var(--fg-3)" />
              <span>{d.payment_method.brand} •••• {d.payment_method.last4}</span>
              <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={demo}>
                Изменить
              </button>
            </div>
          )}

          <div className="row" style={{ gap: 10, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={demo}>
              Оплатить сейчас
            </button>
            <button className="btn btn-secondary" onClick={demo}>
              Управление подпиской
            </button>
          </div>

          <div className="divider" />
          <div className="section-title">Что входит</div>
          {d.included.map((f) => (
            <div className="row" style={{ gap: 9, padding: '6px 0' }} key={f}>
              <CheckCircle size={17} weight="fill" color="var(--accent)" />
              {f}
            </div>
          ))}
        </div>

        <div className="card card-pad">
          <span className="row" style={{ gap: 10 }}>
            <Cube size={22} />
            <h3 style={{ fontSize: 18 }}>{d.self_hosted.name}</h3>
          </span>
          <div style={{ fontFamily: 'var(--font-head)', fontSize: 34, fontWeight: 800, marginTop: 16 }}>
            {d.self_hosted.price}
          </div>
          <p className="muted" style={{ marginTop: 12, lineHeight: 1.6 }}>{d.self_hosted.note}</p>
        </div>
      </div>

      {d.history && d.history.length > 0 && (
        <>
          <div className="divider" />
          <div className="section-title">
            <Receipt size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            История списаний
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Период</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {d.history.map((h) => (
                  <tr key={h.id} style={{ cursor: 'default' }}>
                    <td>{h.date}</td>
                    <td className="muted">{h.period}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{h.amount}</td>
                    <td>{h.status === 'paid' ? <Badge tone="ok">оплачено</Badge> : <Badge tone="warn">{h.status}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
