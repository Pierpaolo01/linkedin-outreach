import { Home } from "./Home";

/** The dashboard shell: the app header and the Home screen. More screens arrive in milestone 3. */
export function App() {
  return (
    <div className="min-h-screen bg-base-200">
      <header className="navbar bg-base-100 shadow-sm px-4">
        <span className="text-lg font-semibold">LinkedIn outreach</span>
      </header>
      <main className="mx-auto max-w-3xl p-4 sm:p-8">
        <Home />
      </main>
    </div>
  );
}
