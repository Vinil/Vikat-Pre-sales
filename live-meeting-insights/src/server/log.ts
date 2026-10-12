/** Structured logs: one JSON object per line on stdout. */
export function log(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n');
}
