// Minimal ambient types for Node's built-in node:sqlite (Node >=22.5).
// mcp-kanban 의 @types/node 가 아직 node:sqlite 를 포함하지 않아 보강한다(런타임엔 존재).
declare module 'node:sqlite' {
  interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean; open?: boolean });
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }
}
