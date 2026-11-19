export async function first<T>(stmt: D1PreparedStatement): Promise<T | null> {
  return (await stmt.first<T>()) ?? null;
}

export async function all<T>(stmt: D1PreparedStatement): Promise<T[]> {
  const res = await stmt.all<T>();
  return res.results ?? [];
}

export async function run(stmt: D1PreparedStatement): Promise<D1Result> {
  return stmt.run();
}

/** Atomic multi-statement write (D1 executes a batch as one transaction). */
export async function batch(db: D1Database, stmts: D1PreparedStatement[]): Promise<D1Result[]> {
  if (stmts.length === 0) return [];
  return db.batch(stmts);
}

export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

export function isUniqueViolation(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg);
}

/** Escapes % _ \ for use in LIKE ... ESCAPE '\' */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}
