// Minimal structural database interface used by the HTTP routes.
// better-sqlite3's Database.Database satisfies this shape; tests can inject a stub.
export interface PreparedStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}

export interface Db {
  prepare(sql: string): PreparedStatement;
}
