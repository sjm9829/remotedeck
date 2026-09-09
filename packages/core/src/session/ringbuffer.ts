// Byte-bounded ring buffer to cap scrollback memory. When the byte limit is
// exceeded, the oldest bytes are evicted.
export class RingBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  constructor(private readonly maxBytes: number) {}

  push(data: string | Buffer): void {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this.chunks.push(buf);
    this.bytes += buf.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
    }
    if (this.bytes > this.maxBytes) {
      // single chunk larger than limit: keep only the tail
      this.chunks = [this.chunks[0].subarray(this.bytes - this.maxBytes)];
      this.bytes = this.maxBytes;
    }
  }

  toString(): string { return Buffer.concat(this.chunks).toString('utf8'); }
  get byteLength(): number { return this.bytes; }
  clear(): void { this.chunks = []; this.bytes = 0; }
}
