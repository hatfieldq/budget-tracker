// Payees used before, for the entry form's suggestions and category prefill.
import { useCallback, useEffect, useState } from 'react';
import type { PayeeHint } from '@ledger/shared';
import { api } from './api';

export function usePayees(): { payees: PayeeHint[]; reload: () => void } {
  const [payees, setPayees] = useState<PayeeHint[]>([]);
  const reload = useCallback(() => {
    api.payees().then(setPayees).catch(() => {
      /* suggestions are optional; entry still works without them */
    });
  }, []);
  useEffect(reload, [reload]);
  return { payees, reload };
}
