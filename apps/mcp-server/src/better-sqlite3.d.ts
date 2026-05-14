declare module 'better-sqlite3' {
  export type Statement = {
    all: (...args: any[]) => any[];
    get: (...args: any[]) => any;
    run: (...args: any[]) => { changes?: number };
  };

  export default class Database {
    constructor(path: string, options?: { readonly?: boolean; fileMustExist?: boolean });
    prepare(sql: string): Statement;
    pragma?(sql: string): void;
    exec(sql: string): void;
    close(): void;
  }
}
