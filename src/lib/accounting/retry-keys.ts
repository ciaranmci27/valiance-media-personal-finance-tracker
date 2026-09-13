/** Keep an uncertain request's identity until its response is received. */
export class AccountingRetryKeys {
  private pending = new Map<string, string>();

  keyFor(command: unknown): string {
    const signature = JSON.stringify(command);
    const key = this.pending.get(signature) ?? crypto.randomUUID();
    this.pending.set(signature, key);
    return key;
  }

  complete(command: unknown): void {
    this.pending.delete(JSON.stringify(command));
  }
}
