import { CheckCircle, CloudCheck, Cube } from '@phosphor-icons/react';
import { Badge, Loading } from '@/components/ui-kit';
import { useBilling } from '@/hooks/use-data';
import { formatDate } from '@/lib/format';

export function BillingPage() {
  const billing = useBilling();
  if (billing.isPending) return <Loading />;
  const d = billing.data;
  if (!d) return <p className="muted">Нет данных.</p>;

  return (
    <>
      <div className="page-head">
        <div className="pt">
          <h2>Подписка</h2>
          <p>Подписка покрывает стоимость инфраструктуры. Self-hosted — бесплатно навсегда.</p>
        </div>
      </div>

      <div className="grid-2">
        <div className="card card-pad" style={{ borderColor: 'var(--accent)' }}>
          <div className="row between">
            <span className="row" style={{ gap: 10 }}>
              <CloudCheck size={22} color="var(--accent)" />
              <h3 style={{ fontSize: 18 }}>{d.plan.name}</h3>
            </span>
            <Badge tone="ok">{d.plan.status}</Badge>
          </div>
          <div style={{ fontFamily: 'var(--font-head)', fontSize: 34, fontWeight: 800, marginTop: 16 }}>
            {d.plan.price}
          </div>
          {d.plan.renews_at && <p className="muted" style={{ marginTop: 4 }}>Продление: {formatDate(d.plan.renews_at)}</p>}
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
    </>
  );
}
