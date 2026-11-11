// The sticky entry date (D26), shared by Transactions and Today: kept in
// sessionStorage so it survives tab switches and resets when the browser closes.
import { useState } from 'react';
import { today } from './components/TxnForm';

const DATE_KEY = 'ledger.entryDate';

function load(): string {
  try {
    return sessionStorage.getItem(DATE_KEY) ?? today();
  } catch {
    return today();
  }
}

export function useEntryDate(): [string, (d: string) => void] {
  const [date, setDate] = useState(load);
  const remember = (d: string) => {
    setDate(d);
    try {
      sessionStorage.setItem(DATE_KEY, d);
    } catch {
      /* storage unavailable: keep it in memory only */
    }
  };
  return [date, remember];
}
