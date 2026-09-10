interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean }>;
  run(): Promise<{ meta: { changes: number; last_row_id: number }; success: boolean }>;
}
export const env: {
  DB: { prepare(sql: string): Statement };
  BUCKET: {
    get(key: string): Promise<{ text(): Promise<string> } | null>;
    put(key: string, value: string, metadata?: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
  HIKMAH_OWNER_EMAIL: string;
};
