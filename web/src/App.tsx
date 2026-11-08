// App shell: header with the "Viewing as" switcher, tab navigation, and the
// current page. Navigation is the URL hash (#/accounts), so refresh keeps your place.
import { ScopeSwitcher } from './components/ScopeSwitcher';
import { AccountsPage } from './pages/AccountsPage';
import { CategoriesPage } from './pages/CategoriesPage';
import { PeoplePage } from './pages/PeoplePage';
import { Placeholder } from './pages/Placeholder';
import { TransactionsPage } from './pages/TransactionsPage';
import { useRoute } from './router';

const PAGES = [
  { path: 'today', label: 'Today' },
  { path: 'transactions', label: 'Transactions' },
  { path: 'accounts', label: 'Accounts' },
  { path: 'overview', label: 'Overview' },
  { path: 'categories', label: 'Categories' },
  { path: 'people', label: 'People' },
] as const;

export function App() {
  const route = useRoute();
  const path = PAGES.find((p) => p.path === route.path)?.path ?? 'accounts';

  return (
    <div className="mx-auto max-w-6xl px-4 pb-16">
      <header className="flex flex-wrap items-center justify-between gap-3 py-4">
        <nav className="flex flex-wrap gap-1">
          {PAGES.map((p) => (
            <a
              key={p.path}
              href={`#/${p.path}`}
              className={`rounded px-3 py-1.5 text-sm font-medium ${
                p.path === path ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-200'
              }`}
            >
              {p.label}
            </a>
          ))}
        </nav>
        <ScopeSwitcher />
      </header>

      <main>
        {path === 'accounts' && <AccountsPage />}
        {path === 'transactions' && <TransactionsPage key={route.params.toString()} params={route.params} />}
        {path === 'categories' && <CategoriesPage />}
        {path === 'people' && <PeoplePage />}
        {path === 'today' && <Placeholder title="Today" session={5} />}
        {path === 'overview' && <Placeholder title="Overview" session={4} />}
      </main>
    </div>
  );
}
