export function Placeholder({ title, session }: { title: string; session: number }) {
  return (
    <div className="rounded border border-dashed border-stone-300 p-8 text-center text-stone-500">
      <h1 className="mb-1 text-lg font-semibold text-stone-700">{title}</h1>
      Planned for Session {session}.
    </div>
  );
}
