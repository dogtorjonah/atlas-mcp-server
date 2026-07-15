declare module 'better-sqlite3' {
  type Params = readonly unknown[] | Record<string, unknown>;

  interface RunResult {
    changes: number;
    lastInsertRowid: number;
  }

  interface Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): RunResult;
  }

  interface Database {
    pragma(statement: string): unknown;
    loadExtension(path: string): void;
    exec(sql: string): void;
    prepare(sql: string): Statement;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: { readonly?: boolean }): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}
