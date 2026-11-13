// Lógica pura do monitor (scripts/watch.ts). Fica em src/ para o unit test rodar no workerd.
const MAX_AGE_MIN = 10;

export interface Delivery {
  subscriptionName: string;
  status: string;
  createdAt: string;
}

/** Entregas que pedem atenção: falhas, dead-letter e paradas na fila há mais de MAX_AGE_MIN. */
export function problems(deliveries: Delivery[], now = Date.now()): string[] {
  return deliveries.flatMap((d) => {
    const age = (now - Date.parse(d.createdAt)) / 60_000;
    const stuck = (d.status === 'pending' || d.status === 'processing') && age > MAX_AGE_MIN;
    return d.status === 'failed' || d.status === 'dead-letter' || stuck ? [`${d.subscriptionName} ${d.status} (${Math.round(age)} min)`] : [];
  });
}
